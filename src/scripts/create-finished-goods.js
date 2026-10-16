/**
 * Finished Goods — Outgoing / Sales.
 * Finished stock is NOT a stored table — it's computed live from production_logs:
 *   produced = Completed bags at the material's finishing station(s), excluding any bag that
 *              was later consumed as input to a further production step (so a bag re-processed
 *              from Extrusion into Packing is only counted once, at its final stage).
 *   available = produced - shipped (shipped comes from finished_goods_shipments below).
 * Finishing stations per material (confirmed with the user):
 *   PE  -> Extrusion only
 *   PC  -> Extrusion or Packing/Re-packing
 *   PET -> Extrusion or Packing/Re-packing
 * This module intentionally carries no pricing — quantities (kg) only.
 *
 * Usage:
 *   node src/scripts/create-finished-goods.js
 */
require('dotenv').config();
const pool = require('../config/database');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS finished_goods_shipments (
        id                 SERIAL PRIMARY KEY,
        shipment_date      DATE NOT NULL DEFAULT CURRENT_DATE,
        material_type_id   INTEGER NOT NULL REFERENCES material_types(id),
        weight_kg          NUMERIC(14,2) NOT NULL,
        customer           VARCHAR(150),
        destination        VARCHAR(200),
        vehicle_no         VARCHAR(60),
        dn_no              VARCHAR(60),
        notes              TEXT,
        packing_list_url   TEXT,
        "createdBy"        VARCHAR(120),
        "createdAt"        TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_fg_shipments_material ON finished_goods_shipments (material_type_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_fg_shipments_date ON finished_goods_shipments (shipment_date)`);

    await client.query('COMMIT');
    console.log('✅ Finished Goods tables ensured.');
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
