/**
 * Migration: Ensure Extrusion (EXT) is in the PE material flow
 *
 * PE line: Crusher → Washing → Extrusion → Final Packaging.
 * Older seeds mapped only CRS, WSH, PKG for PE; this adds EXT idempotently.
 * Does not remove Washing (WSH).
 *
 * Usage:
 *   node src/scripts/add-pe-extrusion.js
 */
require('dotenv').config();
const pool = require('../config/database');

async function run() {
  const client = await pool.connect();
  try {
    const peMt = await client.query("SELECT id FROM material_types WHERE name = 'PE'");
    if (peMt.rows.length === 0) throw new Error("PE material type not found. Run init-production-schema.js first.");
    const peMtId = peMt.rows[0].id;

    const extSt = await client.query("SELECT id FROM stations WHERE code = 'EXT' OR code = 'EXTR' LIMIT 1");
    if (extSt.rows.length === 0) throw new Error("EXT/EXTR station not found. Run init-production-schema.js first.");
    const extStationId = extSt.rows[0].id;

    await client.query('BEGIN');

    await client.query(
      `INSERT INTO material_flow_stations (material_type_id, station_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [peMtId, extStationId]
    );
    console.log('✅ Ensured Extrusion station is in PE flow (ON CONFLICT skipped if already mapped)');

    await client.query('COMMIT');

    const flow = await client.query(
      `SELECT s.name, s.code
       FROM material_flow_stations mfs
       JOIN stations s ON mfs.station_id = s.id
       WHERE mfs.material_type_id = $1
       ORDER BY s.order_index NULLS LAST, s.id`,
      [peMtId]
    );
    console.log('\nCurrent PE station flow:');
    flow.rows.forEach(r => console.log(`  • ${r.name} (${r.code})`));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { });
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
