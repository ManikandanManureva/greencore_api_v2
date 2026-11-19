// LPB: vehicle number of the delivery (plate), requested by Warehouse. Idempotent.
require('dotenv').config();
const pool = require('../config/database');

async function run() {
  await pool.query(`ALTER TABLE proc_receipts ADD COLUMN IF NOT EXISTS vehicle_no VARCHAR(40);`);
  console.log('proc_receipts.vehicle_no ready.');
  await pool.end();
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
