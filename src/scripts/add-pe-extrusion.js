/**
 * Migration: Update PE material flow
 *
 * Changes:
 *   1. Add Extrusion (EXT) station to PE flow  — PE now has Crusher-Washing → Extruder → Packaging
 *   2. Remove Washing (WSH) station from PE flow — Crusher+Washing is one combined process for PE;
 *      all PE flakes are logged against the CRS station; no separate Washing card shown.
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

    const extSt = await client.query("SELECT id FROM stations WHERE code = 'EXT'");
    if (extSt.rows.length === 0) throw new Error("EXT station not found. Run init-production-schema.js first.");
    const extStationId = extSt.rows[0].id;

    const wshSt = await client.query("SELECT id FROM stations WHERE code = 'WSH'");
    const wshStationId = wshSt.rows[0]?.id;

    await client.query('BEGIN');

    // 1. Add EXT to PE flow (idempotent)
    await client.query(
      `INSERT INTO material_flow_stations (material_type_id, station_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [peMtId, extStationId]
    );
    console.log('✅ Added Extrusion (EXT) to PE flow');

    // 2. Remove WSH from PE flow (Crusher-Washing is one combined process for PE)
    if (wshStationId) {
      const del = await client.query(
        `DELETE FROM material_flow_stations
         WHERE material_type_id = $1 AND station_id = $2`,
        [peMtId, wshStationId]
      );
      if (del.rowCount > 0) {
        console.log('✅ Removed Washing (WSH) from PE flow (Crusher+Washing is combined for PE)');
      } else {
        console.log('ℹ️  Washing (WSH) was not in PE flow — nothing to remove');
      }
    }

    await client.query('COMMIT');

    // Print current PE flow
    const flow = await client.query(
      `SELECT s.name, s.code
       FROM material_flow_stations mfs
       JOIN stations s ON mfs.station_id = s.id
       WHERE mfs.material_type_id = $1
       ORDER BY s.id`,
      [peMtId]
    );
    console.log('\nCurrent PE station flow:');
    flow.rows.forEach(r => console.log(`  • ${r.name} (${r.code})`));
    console.log('\nPE flow: Crusher-Washing → Extruder → Packaging');
    console.log('QR codes: FPS, FP1, FES, FE1 (flakes) | PPS, PES (pellets)');
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
