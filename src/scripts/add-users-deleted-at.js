// Lets Super Admin delete a login that already has production history (operator shifts reference
// users.id, so the row can't be removed without destroying traceability): such users are retired
// instead — deleted_at set, login disabled, employee ID freed — and hidden from User Management.
// Idempotent.
require('dotenv').config();
const pool = require('../config/database');

async function run() {
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;`);
  console.log('users.deleted_at ready.');
  await pool.end();
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
