/**
 * Migration: production corrections by a supervisor (e.g. Yoga).
 *  - users.can_correct_production: lets a PPIC user delete a wrong bag, correct its line/output
 *    type or weight, and reopen a shift that was closed early by mistake.
 *  - production_corrections: audit trail of every such change (who, when, old and new values).
 *  - Ensures the YOGA login (role PPIC + the flag). The password is only set when the user is
 *    first created, so re-running never resets a changed password.
 * Additive and idempotent — safe to re-run; no existing rows are changed apart from the flag.
 *
 * Usage:
 *   node src/scripts/add-production-corrections.js
 */
require('dotenv').config();
const bcrypt = require('bcrypt');
const pool = require('../config/database');

const YOGA_EMPLOYEE_ID = 'YOGA';
const YOGA_NAME = 'Yoga';
const YOGA_INITIAL_PASSWORD = 'password123';

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS can_correct_production BOOLEAN NOT NULL DEFAULT false`,
    );
    await client.query(`
      CREATE TABLE IF NOT EXISTS production_corrections (
        id              SERIAL PRIMARY KEY,
        action          VARCHAR(20) NOT NULL,
        log_id          INTEGER,
        shift_id        INTEGER,
        bag_qr          VARCHAR(100),
        old_values      JSONB,
        new_values      JSONB,
        "correctedBy"   VARCHAR(120),
        corrected_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_production_corrections_log ON production_corrections (log_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_production_corrections_shift ON production_corrections (shift_id)`);

    const hashed = await bcrypt.hash(YOGA_INITIAL_PASSWORD, 10);
    const r = await client.query(
      `INSERT INTO users (employee_id, password, name, role, material_type_id, is_active, can_correct_production)
       VALUES ($1, $2, $3, 'PPIC', NULL, true, true)
       ON CONFLICT (employee_id) DO UPDATE SET can_correct_production = true
       RETURNING (xmax = 0) AS created`,
      [YOGA_EMPLOYEE_ID, hashed, YOGA_NAME],
    );
    await client.query('COMMIT');
    console.log('✅ users.can_correct_production + production_corrections ensured.');
    console.log(
      r.rows[0].created
        ? `✅ Login created — Employee ID: ${YOGA_EMPLOYEE_ID}, password: ${YOGA_INITIAL_PASSWORD}`
        : `✅ Login ${YOGA_EMPLOYEE_ID} already exists — correction access ensured (password unchanged).`,
    );
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
