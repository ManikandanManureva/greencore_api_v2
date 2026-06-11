/**
 * Create/ensure the QC dashboard user (role 'qc').
 *
 * The QC user can sign into the web dashboard, see ONLY the gate-entry (Receipts)
 * list, and update only the Status + Notes (comments) on a gate entry.
 *
 * Idempotent — safe to re-run (resets the password to the default below).
 *
 * Usage:
 *   node src/scripts/add-qc-user.js
 */
require('dotenv').config();
const pool = require('../config/database');
const bcrypt = require('bcrypt');

const EMPLOYEE_ID = 'QC';
const PASSWORD = 'qc12345';
const NAME = 'QC Inspector';

async function run() {
  const client = await pool.connect();
  try {
    const hashed = await bcrypt.hash(PASSWORD, 10);
    const result = await client.query(
      `INSERT INTO users (employee_id, password, name, role, material_type_id, is_active)
       VALUES ($1, $2, $3, 'qc', NULL, true)
       ON CONFLICT (employee_id) DO UPDATE
         SET password = EXCLUDED.password,
             name     = EXCLUDED.name,
             role     = 'qc',
             is_active = true
       RETURNING id`,
      [EMPLOYEE_ID, hashed, NAME],
    );
    console.log(`✅ QC user ready (id ${result.rows[0].id})`);
    console.log(`   Employee ID: ${EMPLOYEE_ID}`);
    console.log(`   Password:    ${PASSWORD}`);
    console.log('   Role:        qc  (dashboard: gate-entry list only)');
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
