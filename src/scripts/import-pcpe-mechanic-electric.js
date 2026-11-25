/**
 * PC / PE spare parts split into Mechanic and Electric, loaded from the maintenance team's two
 * tracking workbooks (MEKANIK.xlsx → pcpe-mechanic-data.json, ELEKTRIK.xlsx → pcpe-electric-data.json;
 * each has the "Spare Parts Inventory" master and the "Usage Log" transactions).
 *
 *   catalog 'pc'          relabelled "PC / PE — Mechanic"   (keeps its key so existing links work)
 *   catalog 'pc-electric' new        "PC / PE — Electric"
 *
 * Per part (matched on part_no inside the catalog):
 *   - new part            → inserted with the sheet's opening balance + its usage-log rows
 *   - existing part, only seed-imported history → master fields refreshed, seed history replaced
 *                           by the sheet's log, stock recomputed (opening + log)
 *   - existing part with dashboard-entered transactions → master fields refreshed only; stock and
 *                           history are left exactly as they are (the dashboard is the newer truth)
 * Parts that exist in the catalog but not in the sheet are left untouched. Idempotent — re-running
 * just re-syncs the seed data.
 *
 * Usage:  node src/scripts/import-pcpe-mechanic-electric.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../config/database');

const SETS = [
  { key: 'pc', label: 'PC / PE — Mechanic', sort_order: 10, file: 'pcpe-mechanic-data.json' },
  { key: 'pc-electric', label: 'PC / PE — Electric', sort_order: 11, file: 'pcpe-electric-data.json' },
];

const signedQty = (l) => (l.transaction_type === 'Used' ? -Math.abs(l.qty) : Math.abs(l.qty));

async function ensureCatalog(client, set) {
  const r = await client.query('SELECT id FROM spare_parts_catalogs WHERE key = $1', [set.key]);
  if (r.rows[0]) {
    await client.query('UPDATE spare_parts_catalogs SET label = $2, material_type = NULL, machine = NULL, sort_order = $3 WHERE id = $1', [r.rows[0].id, set.label, set.sort_order]);
    return r.rows[0].id;
  }
  const ins = await client.query('INSERT INTO spare_parts_catalogs (key, label, material_type, machine, sort_order) VALUES ($1, $2, NULL, NULL, $3) RETURNING id', [set.key, set.label, set.sort_order]);
  return ins.rows[0].id;
}

async function insertLog(client, itemId, rows) {
  for (const l of rows) {
    await client.query(
      `INSERT INTO spare_parts_log (item_id, log_date, transaction_type, qty, description, technician, remark, "createdBy")
       VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3, $4, $5, $6, $7, 'seed')`,
      [itemId, l.date || null, l.transaction_type, signedQty(l), l.description || null, l.technician || null, l.remark || null],
    );
  }
}

async function loadSet(client, set) {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, set.file), 'utf-8'));
  const catalogId = await ensureCatalog(client, set);
  const logByPart = new Map();
  for (const l of data.log) { if (!logByPart.has(l.part_no)) logByPart.set(l.part_no, []); logByPart.get(l.part_no).push(l); }

  const existing = await client.query('SELECT id, part_no FROM spare_parts_items WHERE catalog_id = $1 AND part_no IS NOT NULL', [catalogId]);
  const idByPartNo = new Map(existing.rows.map((r) => [r.part_no, r.id]));
  const stats = { inserted: 0, refreshed: 0, kept: 0, log: 0 };
  const keptParts = [];

  for (const p of data.items) {
    const rows = logByPart.get(p.part_no) || [];
    const base = Number(p.base_stock) || 0;
    const current = base + rows.reduce((s, l) => s + signedQty(l), 0);
    const id = idByPartNo.get(p.part_no);
    if (!id) {
      const r = await client.query(
        `INSERT INTO spare_parts_items (catalog_id, part_no, description, category, shelf, floor, location, base_stock, current_qty, min_stock, max_stock, unit, "createdBy", "updatedBy")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'seed','seed') RETURNING id`,
        [catalogId, p.part_no, p.description, p.category || null, p.shelf || null, p.floor || null, p.location || null, base, current, p.min_stock ?? null, p.max_stock ?? null, p.unit || null],
      );
      await insertLog(client, r.rows[0].id, rows);
      stats.inserted++; stats.log += rows.length;
      continue;
    }
    // Master fields always follow the sheet (description / unit / min-max / location).
    await client.query(
      `UPDATE spare_parts_items SET description = $2, unit = COALESCE($3, unit), category = COALESCE($4, category), shelf = COALESCE($5, shelf), floor = COALESCE($6, floor),
         location = COALESCE($7, location), min_stock = COALESCE($8, min_stock), max_stock = COALESCE($9, max_stock), "updatedBy" = 'seed', "updatedAt" = NOW() WHERE id = $1`,
      [id, p.description, p.unit || null, p.category || null, p.shelf || null, p.floor || null, p.location || null, p.min_stock ?? null, p.max_stock ?? null],
    );
    const manual = await client.query(`SELECT COUNT(*)::int AS n FROM spare_parts_log WHERE item_id = $1 AND "createdBy" <> 'seed'`, [id]);
    if (manual.rows[0].n > 0) { stats.kept++; keptParts.push(p.part_no); continue; }
    await client.query(`DELETE FROM spare_parts_log WHERE item_id = $1 AND "createdBy" = 'seed'`, [id]);
    await insertLog(client, id, rows);
    await client.query('UPDATE spare_parts_items SET base_stock = $2, current_qty = $3 WHERE id = $1', [id, base, current]);
    stats.refreshed++; stats.log += rows.length;
  }
  const sheetParts = new Set(data.items.map((p) => p.part_no));
  const notInSheet = existing.rows.filter((r) => !sheetParts.has(r.part_no)).length;
  console.log(`✅ ${set.label}: ${stats.inserted} new, ${stats.refreshed} refreshed from sheet, ${stats.kept} kept (have dashboard transactions), ${stats.log} log rows loaded, ${notInSheet} catalog parts not in sheet (untouched).`);
  if (keptParts.length) console.log(`   kept as-is: ${keptParts.join(', ')}`);
}

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const set of SETS) await loadSet(client, set);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Import failed, nothing changed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}
run();
