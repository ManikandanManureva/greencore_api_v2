// By-products are not always sold: when a lot truly has no value it is simply discarded. Each
// Outgoing / Sales row records which it was, so stock still goes down but the list, history and
// summary can tell "sold" from "discarded". Existing rows default to 'sold'. Idempotent.
require('dotenv').config();
const pool = require('../config/database');

async function run() {
  await pool.query(`ALTER TABLE finished_goods_shipments ADD COLUMN IF NOT EXISTS disposition VARCHAR(20) NOT NULL DEFAULT 'sold';`);
  console.log('finished_goods_shipments.disposition ready.');
  await pool.end();
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
