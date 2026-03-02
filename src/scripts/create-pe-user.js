/**
 * Create a PE (Polyethylene) operator user.
 * PE flow: Crusher → Washing → Packaging (no Label Removal, no Extrusion)
 * QR codes will carry the "PE" prefix automatically.
 *
 * Usage:
 *   node src/scripts/create-pe-user.js
 *   node src/scripts/create-pe-user.js [employeeId] [password] [name]
 *
 * Default: employee_id=OP-PE01, password=password123, name=PE Operator
 */
require('dotenv').config();
const bcrypt = require('bcrypt');
const pool = require('../config/database');

const DEFAULT_EMPLOYEE_ID = 'OP-PE01';
const DEFAULT_PASSWORD = 'password123';
const DEFAULT_NAME = 'PE Operator';

async function run() {
  const employeeId = (process.argv[2] || DEFAULT_EMPLOYEE_ID).toUpperCase();
  const password = process.argv[3] || DEFAULT_PASSWORD;
  const name = process.argv[4] || DEFAULT_NAME;

  const client = await pool.connect();
  try {
    // Get PE material_type_id
    const matRes = await client.query("SELECT id FROM material_types WHERE name = 'PE'");
    if (matRes.rows.length === 0) {
      throw new Error("PE material type not found. Please run init-production-schema.js first.");
    }
    const peMaterialTypeId = matRes.rows[0].id;

    const hashedPassword = await bcrypt.hash(password, 10);
    await client.query(
      `INSERT INTO users (employee_id, password, name, role, material_type_id, is_active)
       VALUES ($1, $2, $3, 'PE', $4, true)
       ON CONFLICT (employee_id) DO UPDATE
       SET password = EXCLUDED.password,
           name     = EXCLUDED.name,
           role     = EXCLUDED.role,
           material_type_id = EXCLUDED.material_type_id`,
      [employeeId, hashedPassword, name, peMaterialTypeId]
    );
    console.log('✅ PE user created/updated');
    console.log('   Employee ID    :', employeeId);
    console.log('   Name           :', name);
    console.log('   Password       :', password);
    console.log('   material_type  : PE (id=' + peMaterialTypeId + ')');
    console.log('   Stations shown : Crusher → Washing → Packaging');
    console.log('   QR prefix      : PE  (e.g. 20260216-PE-S1-C3E-001)');
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
