/**
 * Migration: Add 19 item-level columns to opening_stock.
 * pc_kg / pe_kg / pet_kg / total_kg remain and are now computed on insert.
 * Idempotent — safe to re-run.
 *
 * Usage:
 *   node src/scripts/add-opening-stock-items.js
 */
require('dotenv').config();
const pool = require('../config/database');

const COLUMNS = [
  // PC
  'pc_gallon_kg', 'pc_crusher_kg', 'pc_washing_kg', 'pc_pellet_kg',
  // PE
  'pe_super_kg', 'pe_1_kg', 'eva_super_kg', 'eva_1_kg',
  'flakes_pe_super_kg', 'flakes_pe_1_kg', 'flakes_eva_super_kg', 'flakes_eva_1_kg',
  'pellet_pe_super_kg', 'pellet_pe_1_kg',
  // PET
  'pet_gallon_kg', 'pet_crusher_kg', 'pet_washing_kg', 'pet_boretech_kg', 'pet_pellet_kg',
];

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const col of COLUMNS) {
      await client.query(`ALTER TABLE opening_stock ADD COLUMN IF NOT EXISTS ${col} NUMERIC(12,2) NOT NULL DEFAULT 0`);
      console.log(`✅ ${col}`);
    }
    await client.query('COMMIT');
    console.log('\n✅ All 19 item columns ensured on opening_stock.');
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
