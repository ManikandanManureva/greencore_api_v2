/**
 * One-off migration: add end_remark column to operator_shifts if missing.
 * Run from repo root: node src/scripts/add-operator-shift-end-remark.js
 */
require('dotenv').config();
const pool = require('../config/database');

async function run() {
  const client = await pool.connect();
  try {
    await client.query(`
      ALTER TABLE operator_shifts ADD COLUMN IF NOT EXISTS end_remark TEXT;
    `);
    console.log('✅ operator_shifts.end_remark added (or already exists)');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
