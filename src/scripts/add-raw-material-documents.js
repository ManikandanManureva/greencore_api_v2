/**
 * Migration: Add scanned document columns to raw_material (gate-entry) table.
 * Stores the public path (e.g. /uploads/raw-material/wbs-....jpg) of the delivery note
 * and WBS images captured during Scan Document, so PPIC can view them later.
 * Idempotent — safe to re-run.
 *
 * Usage:
 *   node src/scripts/add-raw-material-documents.js
 */
require('dotenv').config();
const pool = require('../config/database');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`ALTER TABLE raw_material ADD COLUMN IF NOT EXISTS "deliveryNoteFile" VARCHAR(255)`);
    await client.query(`ALTER TABLE raw_material ADD COLUMN IF NOT EXISTS "wbsFile" VARCHAR(255)`);
    await client.query('COMMIT');
    console.log('✅ raw_material.deliveryNoteFile / wbsFile columns ensured.');
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
