/**
 * 1. Refreshes the Starlinger catalog from an updated source workbook
 *    ("1. Starlinger Spare Parts - Tracking(1).xlsx"): 413 parts, 25 usage-log entries
 *    (vs. the 413/19 originally imported) — replaces the existing Starlinger items + log
 *    wholesale with this newer export. Safe only because every existing row's createdBy is
 *    still 'seed' (verified before writing this script) — no real dashboard-entered
 *    transactions exist yet to lose.
 * 2. Loads the Boretech catalog's master data for the first time (15 parts, no transactions —
 *    none exist yet) from "3. Boretech Spare Parts - Tracking.xlsx".
 * Idempotent per-section: each section checks its own state before acting.
 *
 * Usage:
 *   node src/scripts/refresh-starlinger-and-boretech.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../config/database');

const starlingerItems = JSON.parse(fs.readFileSync(path.join(__dirname, 'starlinger-refresh-items.json'), 'utf-8'));
const starlingerLog = JSON.parse(fs.readFileSync(path.join(__dirname, 'starlinger-refresh-log.json'), 'utf-8'));
const boretechItems = JSON.parse(fs.readFileSync(path.join(__dirname, 'boretech-items.json'), 'utf-8'));

function toIsoDate(s) {
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  return null;
}

async function importItemsAndLog(client, catalogId, items, log, markerPartNo) {
  const idByPartNo = new Map();
  for (const p of items) {
    const baseStock = Number(p.base_stock) || 0;
    const r = await client.query(
      `INSERT INTO spare_parts_items
         (catalog_id, part_no, description, category, shelf, floor, location, base_stock, current_qty,
          min_stock, max_stock, unit, supplier, "createdBy", "updatedBy")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11,$12,'seed','seed')
       RETURNING id`,
      [catalogId, p.part_no, p.description, p.category || null, p.shelf || null, p.floor || null,
        p.location || null, baseStock, p.min_stock ?? null, p.max_stock ?? null, p.unit || null, p.supplier || null],
    );
    if (p.part_no && !idByPartNo.has(p.part_no)) idByPartNo.set(p.part_no, r.rows[0].id);
  }
  console.log(`✅ Imported ${items.length} items.`);

  let logged = 0, skipped = 0;
  for (const l of log) {
    const itemId = idByPartNo.get(l.part_no);
    if (!itemId) { skipped++; continue; }
    const logDate = toIsoDate(l.date);
    const signedQty = l.transaction_type === 'Used' ? -Math.abs(l.qty) : Math.abs(l.qty);
    await client.query(
      `INSERT INTO spare_parts_log (item_id, log_date, transaction_type, qty, description, technician, "createdBy")
       VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3, $4, $5, $6, 'seed')`,
      [itemId, logDate, l.transaction_type, signedQty, l.description || null, l.technician || null],
    );
    await client.query(`UPDATE spare_parts_items SET current_qty = current_qty + $2 WHERE id = $1`, [itemId, signedQty]);
    logged++;
  }
  console.log(`✅ Imported ${logged} log entries (${skipped} skipped — part not in master).`);
}

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const catRes = await client.query('SELECT id, key FROM spare_parts_catalogs');
    const catalogIdByKey = Object.fromEntries(catRes.rows.map((r) => [r.key, r.id]));
    const starlingerId = catalogIdByKey['pet-starlinger'];
    const boretechId = catalogIdByKey['pet-boretech'];
    if (!starlingerId || !boretechId) throw new Error('Catalog registry is missing pet-starlinger or pet-boretech.');

    // ---- 1. Starlinger: replace wholesale with the refreshed export ----
    const nonSeed = await client.query(
      `SELECT COUNT(*)::int AS n FROM spare_parts_log l JOIN spare_parts_items i ON i.id = l.item_id
       WHERE i.catalog_id = $1 AND l."createdBy" IS DISTINCT FROM 'seed'`,
      [starlingerId],
    );
    if (nonSeed.rows[0].n > 0) {
      console.log(`⏭️  Starlinger has ${nonSeed.rows[0].n} non-seed log entries — refusing to wipe, skipping Starlinger refresh.`);
    } else {
      await client.query(
        `DELETE FROM spare_parts_log WHERE item_id IN (SELECT id FROM spare_parts_items WHERE catalog_id = $1)`,
        [starlingerId],
      );
      const del = await client.query('DELETE FROM spare_parts_items WHERE catalog_id = $1', [starlingerId]);
      console.log(`🗑️  Cleared ${del.rowCount} existing Starlinger items (and their log entries).`);
      await importItemsAndLog(client, starlingerId, starlingerItems, starlingerLog);
    }

    // ---- 2. Boretech: first-time master load (no transactions yet) ----
    const boretechCount = await client.query('SELECT COUNT(*)::int AS n FROM spare_parts_items WHERE catalog_id = $1', [boretechId]);
    if (boretechCount.rows[0].n > 0) {
      console.log(`⏭️  Boretech already has ${boretechCount.rows[0].n} items — skipping.`);
    } else {
      await importItemsAndLog(client, boretechId, boretechItems, []);
    }

    await client.query('COMMIT');
    console.log('Done.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
