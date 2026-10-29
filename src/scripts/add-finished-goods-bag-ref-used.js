// Marks a REF bag list as "used" once a shipment is actually recorded from it, so it stays
// visible in search/history but can no longer be picked again (its bags are already shipped).
require('dotenv').config();
const pool = require('../config/database');

async function run() {
  await pool.query(`ALTER TABLE finished_goods_bag_refs ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE finished_goods_bag_refs ADD COLUMN IF NOT EXISTS shipment_id INTEGER REFERENCES finished_goods_shipments(id) ON DELETE SET NULL;`);
  console.log('finished_goods_bag_refs.used_at / shipment_id ready.');
  await pool.end();
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
