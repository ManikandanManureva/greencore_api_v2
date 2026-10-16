/**
 * One-time Opening Stock for Outgoing / Sales (Finished Goods / Flakes / By Products).
 * Go-live day: historical production/shipment data for the current stock on hand isn't in the
 * system yet, so this lets each category+material start from a manually entered balance instead
 * of 0. One row per (category, material) — editable (upsert), not append-only like Material
 * Inventory's opening_stock, since this is meant to be set once before go-live and corrected if
 * mistyped, not re-opened every period.
 *
 * available_weight = produced_weight (computed) + opening_weight (this table) - shipped_weight
 *
 * Idempotent — safe to re-run.
 * Usage: node src/scripts/create-finished-goods-opening-stock.js
 */
require('dotenv').config();
const pool = require('../config/database');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS finished_goods_opening_stock (
        id                 SERIAL PRIMARY KEY,
        category           VARCHAR(20) NOT NULL
                             CHECK (category IN ('finished_goods', 'flakes', 'by_products')),
        material_type_id   INTEGER NOT NULL REFERENCES material_types(id),
        weight_kg          NUMERIC(14,2) NOT NULL DEFAULT 0,
        notes              TEXT,
        "createdBy"        VARCHAR(120),
        "updatedBy"        VARCHAR(120),
        "createdAt"        TIMESTAMPTZ DEFAULT NOW(),
        "updatedAt"        TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (category, material_type_id)
      )
    `);
    await client.query('COMMIT');
    console.log('✅ finished_goods_opening_stock table ensured.');
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
