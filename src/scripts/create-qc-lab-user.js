/**
 * Create the QC Lab login — scoped to only the QC Lab module (full rights there: enter, edit,
 * delete pellet samples; nothing else in the portal).
 * Uses .env for DB connection.
 *
 * Usage: node src/scripts/create-qc-lab-user.js
 *        node src/scripts/create-qc-lab-user.js [employeeId] [password]
 *
 * Default: employee_id=QC_LAB, password=qc@123
 */
require('dotenv').config();
const bcrypt = require('bcrypt');
const pool = require('../config/database');

const DEFAULT_EMPLOYEE_ID = 'QC_LAB';
const DEFAULT_PASSWORD = 'qc@123';

async function run() {
  const employeeId = (process.argv[2] || DEFAULT_EMPLOYEE_ID).toUpperCase();
  const password = process.argv[3] || DEFAULT_PASSWORD;

  const client = await pool.connect();
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    await client.query(
      `INSERT INTO users (employee_id, password, name, role, material_type_id, is_active)
       VALUES ($1, $2, $3, $4, NULL, true)
       ON CONFLICT (employee_id) DO UPDATE
       SET password = EXCLUDED.password, name = EXCLUDED.name, role = EXCLUDED.role`,
      [employeeId, hashedPassword, 'QC Lab', 'qc_lab'],
    );
    console.log('✅ QC Lab user created/updated');
    console.log('   Employee ID:', employeeId);
    console.log('   Password:  ', password);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
