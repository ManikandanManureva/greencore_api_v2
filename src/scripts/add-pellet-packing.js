/**
 * Migration: Add "Pellet Packing" station (PLT) after Final Packaging.
 *
 * Flow: ... → Extrusion (EXT) → Final Packaging (PKG) → Pellet Packing (PLT).
 * Pellet Packing inputs = outputs of Final Packaging (Completed) and Extrusion (pending).
 * Mapped to all material flows (PC, PE, PET). Idempotent — safe to re-run.
 *
 * Usage:
 *   node src/scripts/add-pellet-packing.js
 */
require('dotenv').config();
const pool = require('../config/database');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Station row (after Final Packaging order_index 5)
    const st = await client.query(
      `INSERT INTO stations (name, code, description, order_index, is_active)
       VALUES ('Pellet Packing', 'PLT', 'Packing of pellets from Final Packaging and Extrusion outputs', 6, true)
       ON CONFLICT (code) DO UPDATE
         SET name = EXCLUDED.name, order_index = EXCLUDED.order_index, is_active = true
       RETURNING id`
    );
    const pltId = st.rows[0].id;
    console.log(`✅ Pellet Packing station ensured (id ${pltId})`);

    // 2. Map to all material flows
    const mats = await client.query("SELECT id, name FROM material_types WHERE name IN ('PC','PE','PET')");
    for (const m of mats.rows) {
      await client.query(
        `INSERT INTO material_flow_stations (material_type_id, station_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [m.id, pltId]
      );
      console.log(`✅ Mapped Pellet Packing to ${m.name} flow`);
    }

    await client.query('COMMIT');

    const flows = await client.query(
      `SELECT mt.name AS material, s.name, s.code, s.order_index
       FROM material_flow_stations mfs
       JOIN material_types mt ON mt.id = mfs.material_type_id
       JOIN stations s ON s.id = mfs.station_id
       ORDER BY mt.name, s.order_index NULLS LAST, s.id`
    );
    let cur = '';
    flows.rows.forEach((r) => {
      if (r.material !== cur) { cur = r.material; console.log(`\n${cur} flow:`); }
      console.log(`  • ${r.name} (${r.code})`);
    });
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
