/**
 * Splits finished_goods_shipments into three categories (Outgoing / Sales menu restructure):
 * Finished Goods, Flakes, By Products — all sharing this one table via a new `category` column.
 * Existing rows (all previously "Finished Goods") default to 'finished_goods'.
 * Idempotent — safe to re-run.
 *
 * Usage: node src/scripts/add-finished-goods-category-column.js
 */
require('dotenv').config();
const pool = require('../config/database');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      ALTER TABLE finished_goods_shipments
        ADD COLUMN IF NOT EXISTS category VARCHAR(20) NOT NULL DEFAULT 'finished_goods'
    `);
    await client.query(`
      ALTER TABLE finished_goods_shipments DROP CONSTRAINT IF EXISTS finished_goods_shipments_category_check
    `);
    await client.query(`
      ALTER TABLE finished_goods_shipments
        ADD CONSTRAINT finished_goods_shipments_category_check
        CHECK (category IN ('finished_goods', 'flakes', 'by_products'))
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_fg_shipments_category ON finished_goods_shipments (category)`);
    await client.query('COMMIT');
    console.log('✅ finished_goods_shipments.category ensured.');
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
