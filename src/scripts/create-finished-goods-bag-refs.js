// Lets a user build a jumbo-bag list ONCE under a REF/DN number (e.g. "2026255"), then reuse
// that REF when recording or amending a shipment instead of re-pasting the same bag codes.
require('dotenv').config();
const pool = require('../config/database');

async function run() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS finished_goods_bag_refs (
      id SERIAL PRIMARY KEY,
      material_type_id INTEGER NOT NULL REFERENCES material_types(id),
      ref_no VARCHAR(80) NOT NULL,
      bags JSONB NOT NULL DEFAULT '[]',
      bag_count INTEGER NOT NULL DEFAULT 0,
      weight_kg NUMERIC NOT NULL DEFAULT 0,
      "createdBy" VARCHAR(120),
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (material_type_id, ref_no)
    );
  `);
  console.log('finished_goods_bag_refs table ready.');
  await pool.end();
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
