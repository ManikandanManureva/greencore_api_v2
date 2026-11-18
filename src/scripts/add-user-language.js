// Per-user UI language (en / id / fr). Saved from the dashboard language switcher so the
// preference follows the user to any browser or device, instead of living in localStorage only.
require('dotenv').config();
const pool = require('../config/database');

async function run() {
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS language VARCHAR(5);`);
  console.log('users.language ready.');
  await pool.end();
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
