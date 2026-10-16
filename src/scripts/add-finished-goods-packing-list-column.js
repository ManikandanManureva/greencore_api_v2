/**
 * Adds packing_list_url to finished_goods_shipments for an install that already ran
 * create-finished-goods.js before this column existed. Stores a bare S3 object key (or a
 * local-disk URL when S3 isn't configured) for the uploaded packing list / invoice PDF, same
 * storage convention as production_logs.photo_url and qc_lab_samples.iv_photo_url.
 * Idempotent — safe to re-run.
 *
 * Usage: node src/scripts/add-finished-goods-packing-list-column.js
 */
require('dotenv').config();
const pool = require('../config/database');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('ALTER TABLE finished_goods_shipments ADD COLUMN IF NOT EXISTS packing_list_url TEXT');
    console.log('✅ finished_goods_shipments.packing_list_url ensured.');
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
