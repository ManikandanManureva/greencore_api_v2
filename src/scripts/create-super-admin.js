/**
 * Create or update the Super Admin user for the backoffice dashboard.
 * Uses .env for DB connection.
 *
 * Usage: node src/scripts/create-super-admin.js
 *        node src/scripts/create-super-admin.js [employeeId] [password]
 *
 * Default: employee_id=SUPERADMIN, password=GreencoreAdmin!
 */
require('dotenv').config();
const bcrypt = require('bcrypt');
const pool = require('../config/database');

const DEFAULT_EMPLOYEE_ID = 'SUPERADMIN';
const DEFAULT_PASSWORD = 'GreencoreAdmin!';

async function run() {
  const employeeId = (process.argv[2] || DEFAULT_EMPLOYEE_ID).toUpperCase();
  const password = process.argv[3] || DEFAULT_PASSWORD;

  const client = await pool.connect();
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    await client.query(
      `INSERT INTO users (employee_id, password, name, email, role, material_type_id, is_active)
       VALUES ($1, $2, $3, $4, $5, NULL, true)
       ON CONFLICT (employee_id) DO UPDATE
       SET password = EXCLUDED.password, name = EXCLUDED.name, role = EXCLUDED.role, is_active = true`,
      [employeeId, hashedPassword, 'Super Admin', 'superadmin@greencore.com', 'super_admin']
    );
    console.log('✅ Super Admin user created/updated');
    console.log('   Employee ID:', employeeId);
    console.log('   Password:   ', password);
    console.log('   Use these credentials to log in to the admin dashboard.');
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
