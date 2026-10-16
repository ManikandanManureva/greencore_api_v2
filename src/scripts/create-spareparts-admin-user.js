/**
 * Create a Spare Parts Admin login — scoped to only the Spare Parts module (full rights there:
 * view, log Stock In/Outgoing, and edit master data — same as PPIC's rights within that module,
 * but sees no other menu).
 * Uses .env for DB connection.
 *
 * Usage: node src/scripts/create-spareparts-admin-user.js
 *        node src/scripts/create-spareparts-admin-user.js [employeeId] [password]
 *
 * Default: employee_id=SPAREPARTS, password=password123
 */
require('dotenv').config();
const bcrypt = require('bcrypt');
const pool = require('../config/database');

const DEFAULT_EMPLOYEE_ID = 'SPAREPARTS';
const DEFAULT_PASSWORD = 'password123';

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
      [employeeId, hashedPassword, 'Spare Parts Admin', 'spare_parts_admin'],
    );
    console.log('✅ Spare Parts Admin user created/updated');
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
