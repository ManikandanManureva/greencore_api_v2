/**
 * Removes the old "SP-MEC-xxx" parts from the PC/PE catalog.
 * They came from the original MEC/General import ("10. [MEC] Penerimaan dan Pengambilan
 * Sparepart...xlsx") and were superseded by the newer "MEC-xxx" parts loaded from
 * "1. PC PE Spare Parts Mechanic - Tracking.xlsx" (merge-pcpe-spareparts.js) — the same
 * physical parts under two different code schemes (e.g. SP-MEC-097 and MEC-002 are both "A28").
 * Verified before writing this: all 373 SP-MEC-xxx rows have zero log entries, so removing them
 * loses no transaction history.
 * Idempotent — skips if none are left.
 *
 * Usage:
 *   node src/scripts/remove-duplicate-sp-mec-items.js
 */
require('dotenv').config();
const pool = require('../config/database');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const pcRes = await client.query(`SELECT id FROM spare_parts_catalogs WHERE key = 'pc'`);
    if (pcRes.rows.length === 0) throw new Error('PC/PE catalog not found.');
    const pcId = pcRes.rows[0].id;

    const dupes = await client.query(
      `SELECT id FROM spare_parts_items WHERE catalog_id = $1 AND part_no LIKE 'SP-MEC-%'`,
      [pcId],
    );
    if (dupes.rows.length === 0) {
      console.log('⏭️  No SP-MEC-xxx items found — nothing to remove.');
      await client.query('ROLLBACK');
      return;
    }

    const nonSeedLog = await client.query(
      `SELECT COUNT(*)::int AS n FROM spare_parts_log
       WHERE item_id = ANY($1) AND "createdBy" IS DISTINCT FROM 'seed'`,
      [dupes.rows.map((r) => r.id)],
    );
    if (nonSeedLog.rows[0].n > 0) {
      throw new Error(`${nonSeedLog.rows[0].n} SP-MEC-xxx items have real (non-seed) log entries — refusing to delete. Review manually.`);
    }

    await client.query(`DELETE FROM spare_parts_log WHERE item_id = ANY($1)`, [dupes.rows.map((r) => r.id)]);
    const del = await client.query(`DELETE FROM spare_parts_items WHERE id = ANY($1)`, [dupes.rows.map((r) => r.id)]);
    console.log(`🗑️  Removed ${del.rowCount} duplicate SP-MEC-xxx items (superseded by MEC-xxx).`);

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
