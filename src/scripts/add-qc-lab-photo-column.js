/**
 * Adds iv_photo_url to qc_lab_samples for an install that already ran create-qc-lab.js before
 * this column existed. Stores a bare S3 object key (or a local-disk URL when S3 isn't
 * configured) for the IV reading photo, same storage convention as production_logs.photo_url.
 * Idempotent — safe to re-run.
 *
 * Usage: node src/scripts/add-qc-lab-photo-column.js
 */
require('dotenv').config();
const pool = require('../config/database');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('ALTER TABLE qc_lab_samples ADD COLUMN IF NOT EXISTS iv_photo_url TEXT');
    console.log('✅ qc_lab_samples.iv_photo_url ensured.');
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
