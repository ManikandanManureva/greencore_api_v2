/**
 * One-off migration: add category column to by_product_logs if missing.
 * Run from repo root: node src/scripts/add-by-product-category.js
 */
require('dotenv').config();
const pool = require('../config/database');

async function run() {
  const client = await pool.connect();
  try {
    await client.query(`
      ALTER TABLE by_product_logs ADD COLUMN IF NOT EXISTS category VARCHAR(100);
    `);
    console.log('✅ by_product_logs.category added (or already exists)');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
