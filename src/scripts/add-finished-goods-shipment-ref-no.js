// Adds the parent REF / invoice number to shipments. One REF (e.g. "2026346") can cover several
// delivery notes (DN numbers), so it is stored on each shipment and used as "No. Invoice" in the
// traceability export. Idempotent.
require('dotenv').config();
const pool = require('../config/database');

async function run() {
  await pool.query(`ALTER TABLE finished_goods_shipments ADD COLUMN IF NOT EXISTS ref_no VARCHAR(80);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_fg_shipments_ref_no ON finished_goods_shipments (ref_no);`);
  console.log('finished_goods_shipments.ref_no ready.');
  await pool.end();
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
