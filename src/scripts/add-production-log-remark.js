/**
 * Migration: Add "remark" column to production_logs.
 * Idempotent — safe to re-run.
 *
 * Usage:
 *   node src/scripts/add-production-log-remark.js
 */
require('dotenv').config();
const pool = require('../config/database');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      ALTER TABLE production_logs
      ADD COLUMN IF NOT EXISTS remark TEXT
    `);
    console.log('✅ remark column ensured on production_logs');

    await client.query('COMMIT');
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
