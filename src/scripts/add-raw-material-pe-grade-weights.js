/**
 * Migration: Add per-grade weight columns to raw_material for PE incoming material.
 * One PE gate-entry record can contain all 4 grades together (PE SUPER, PE 1, EVA SUPER,
 * EVA 1), each weighed separately — netWeight is the sum of these four.
 * Idempotent — safe to re-run.
 *
 * Usage:
 *   node src/scripts/add-raw-material-pe-grade-weights.js
 */
require('dotenv').config();
const pool = require('../config/database');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`ALTER TABLE raw_material ADD COLUMN IF NOT EXISTS "peSuperWeight" NUMERIC(14,2)`);
    await client.query(`ALTER TABLE raw_material ADD COLUMN IF NOT EXISTS "pe1Weight" NUMERIC(14,2)`);
    await client.query(`ALTER TABLE raw_material ADD COLUMN IF NOT EXISTS "evaSuperWeight" NUMERIC(14,2)`);
    await client.query(`ALTER TABLE raw_material ADD COLUMN IF NOT EXISTS "eva1Weight" NUMERIC(14,2)`);
    await client.query('COMMIT');
    console.log('✅ raw_material PE grade-weight columns ensured.');
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
