require('dotenv').config();
const pool = require('../config/database');

async function run() {
  const client = await pool.connect();
  try {
    await client.query(`ALTER TABLE production_logs ADD COLUMN IF NOT EXISTS dn_no VARCHAR(100) NULL`);
    console.log('✅ dn_no column ensured on production_logs');
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
