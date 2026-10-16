/**
 * Spare Parts restructure, per request:
 *   1. MEC / General catalog is retired — its items move under PC (now the combined catalog).
 *   2. PC and PE are combined into one catalog (PE had no items to carry over).
 *   3. Loads "1. PC PE Spare Parts Mechanic - Tracking.xlsx" (Spare Parts Inventory = master,
 *      Usage Log = transactions) into that combined catalog — 375 parts, 92 log entries,
 *      extracted to pcpe-spareparts-items.json / pcpe-spareparts-log.json.
 *
 * Result: one catalog, key 'pc', label "PC / PE Spare Parts", holding:
 *   - the 373 parts previously under 'mec' (unchanged, just re-homed)
 *   - the 375 new parts + their usage history from this workbook
 * The 'pe' and 'mec' catalog registry rows are removed. Idempotent — safe to re-run.
 *
 * Usage:
 *   node src/scripts/merge-pcpe-spareparts.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../config/database');

const items = JSON.parse(fs.readFileSync(path.join(__dirname, 'pcpe-spareparts-items.json'), 'utf-8'));
const log = JSON.parse(fs.readFileSync(path.join(__dirname, 'pcpe-spareparts-log.json'), 'utf-8'));

function toIsoDate(s) {
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  return null;
}

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const catRes = await client.query('SELECT id, key FROM spare_parts_catalogs');
    const catalogIdByKey = Object.fromEntries(catRes.rows.map((r) => [r.key, r.id]));
    const pcId = catalogIdByKey['pc'];
    const peId = catalogIdByKey['pe'];
    const mecId = catalogIdByKey['mec'];
    if (!pcId) throw new Error('Catalog registry is missing "pc" — run create-spareparts-v2.js first.');

    // 1. Relabel PC as the combined catalog.
    await client.query(
      `UPDATE spare_parts_catalogs SET label = 'PC / PE Spare Parts', material_type = NULL, machine = NULL WHERE id = $1`,
      [pcId],
    );

    // 2. Move MEC's items under PC, then retire the MEC and PE catalog rows.
    if (mecId) {
      const moved = await client.query('UPDATE spare_parts_items SET catalog_id = $1 WHERE catalog_id = $2', [pcId, mecId]);
      console.log(`✅ Moved ${moved.rowCount} MEC items under PC.`);
      await client.query('DELETE FROM spare_parts_catalogs WHERE id = $1', [mecId]);
      console.log('✅ Removed the MEC catalog entry.');
    }
    if (peId) {
      const peItemCount = await client.query('SELECT COUNT(*)::int AS n FROM spare_parts_items WHERE catalog_id = $1', [peId]);
      if (peItemCount.rows[0].n > 0) {
        await client.query('UPDATE spare_parts_items SET catalog_id = $1 WHERE catalog_id = $2', [pcId, peId]);
        console.log(`✅ Moved ${peItemCount.rows[0].n} PE items under PC.`);
      }
      await client.query('DELETE FROM spare_parts_catalogs WHERE id = $1', [peId]);
      console.log('✅ Removed the PE catalog entry.');
    }

    // 3. Load the new workbook's master + usage log, skipping if already imported (idempotent).
    const already = await client.query(
      `SELECT COUNT(*)::int AS n FROM spare_parts_items WHERE catalog_id = $1 AND part_no = $2`,
      [pcId, items[0]?.part_no || '__none__'],
    );
    if (already.rows[0].n > 0) {
      console.log('⏭️  PC/PE workbook data already imported — skipping.');
    } else {
      const idByPartNo = new Map();
      for (const p of items) {
        const baseStock = Number(p.base_stock) || 0;
        const r = await client.query(
          `INSERT INTO spare_parts_items
             (catalog_id, part_no, description, category, shelf, floor, location, base_stock, current_qty,
              min_stock, max_stock, unit, "createdBy", "updatedBy")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11,'seed','seed')
           RETURNING id`,
          [pcId, p.part_no, p.description, p.category || null, p.shelf || null, p.floor || null,
            p.location || null, baseStock, p.min_stock ?? null, p.max_stock ?? null, p.unit || null],
        );
        idByPartNo.set(p.part_no, r.rows[0].id);
      }
      console.log(`✅ Imported ${items.length} PC/PE parts.`);

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
      console.log(`✅ Imported ${logged} PC/PE usage-log entries (${skipped} skipped).`);
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
