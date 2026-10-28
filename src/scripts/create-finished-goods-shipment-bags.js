/**
 * Jumbo bag tracking for Finished Goods shipments. A single Finished Goods shipment (e.g.
 * 20,000 kg) is physically made up of many individual jumbo bags (~30 of them) — each one a
 * row already recorded in production_logs (output_bag_qr, Completed, at the material's
 * finishing station). Instead of just typing a total weight, the user picks/scans the exact
 * bags that went into this shipment; the shipment's weight is the sum of its bags' weights.
 *
 * bag_qr is globally unique — a physical bag can only ever be linked to one shipment. No FK to
 * production_logs (bag identity is the QR string itself, matched at save time), so this table
 * stays simple and the production_logs row can't block a shipment edit/delete.
 *
 * Idempotent — safe to re-run.
 * Usage: node src/scripts/create-finished-goods-shipment-bags.js
 */
require('dotenv').config();
const pool = require('../config/database');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS finished_goods_shipment_bags (
        id                 SERIAL PRIMARY KEY,
        shipment_id        INTEGER NOT NULL REFERENCES finished_goods_shipments(id) ON DELETE CASCADE,
        bag_qr             VARCHAR(120) NOT NULL UNIQUE,
        weight_kg          NUMERIC(10,2) NOT NULL,
        production_log_id  INTEGER,
        "createdAt"        TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_fg_ship_bags_shipment ON finished_goods_shipment_bags (shipment_id)`);
    await client.query('COMMIT');
    console.log('✅ finished_goods_shipment_bags table ensured.');
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
