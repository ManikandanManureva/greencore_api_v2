/**
 * Migration: Add region column to raw_material (gate-entry) table.
 * Used for PET incoming material — fixed set of Indonesian regions (Jawa Barat, Jawa Timur,
 * Jawa Tengah, Sumatra, Sulawesi, Bali), editable by PPIC.
 * Idempotent — safe to re-run.
 *
 * Usage:
 *   node src/scripts/add-raw-material-region.js
 */
require('dotenv').config();
const pool = require('../config/database');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`ALTER TABLE raw_material ADD COLUMN IF NOT EXISTS region VARCHAR(40)`);
    await client.query('COMMIT');
    console.log('✅ raw_material.region column ensured.');
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
