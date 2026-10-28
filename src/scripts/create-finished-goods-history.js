/**
 * Audit history for Outgoing / Sales — "History & Notes" per shipment (created / amended /
 * deleted / note), and per opening-stock balance (created / amended), so corrections are
 * traceable instead of silently overwriting data. No FK on shipment_id so a shipment's history
 * survives the shipment itself being deleted.
 *
 * Idempotent — safe to re-run.
 * Usage: node src/scripts/create-finished-goods-history.js
 */
require('dotenv').config();
const pool = require('../config/database');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS finished_goods_shipment_history (
        id                 SERIAL PRIMARY KEY,
        shipment_id        INTEGER,
        category           VARCHAR(20) NOT NULL,
        material_type_id   INTEGER REFERENCES material_types(id),
        pet_type           VARCHAR(10) DEFAULT 'NA',
        action             VARCHAR(20) NOT NULL, -- created | amended | deleted | note
        details            TEXT NOT NULL,
        "createdBy"        VARCHAR(120),
        "createdAt"        TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_fg_ship_hist_shipment ON finished_goods_shipment_history (shipment_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS finished_goods_opening_stock_history (
        id                 SERIAL PRIMARY KEY,
        category           VARCHAR(20) NOT NULL,
        material_type_id   INTEGER NOT NULL REFERENCES material_types(id),
        pet_type           VARCHAR(10) DEFAULT 'NA',
        weight_kg          NUMERIC(14,2) NOT NULL,
        action             VARCHAR(20) NOT NULL, -- created | amended
        details            TEXT NOT NULL,
        "createdBy"        VARCHAR(120),
        "createdAt"        TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_fg_open_hist_lookup ON finished_goods_opening_stock_history (category, material_type_id)`);

    await client.query('COMMIT');
    console.log('✅ Finished Goods history tables ensured.');
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
