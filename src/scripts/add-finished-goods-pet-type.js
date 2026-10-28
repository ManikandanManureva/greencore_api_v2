/**
 * Splits PET into two sellable types across Outgoing / Sales: "Bottle" and "Gallon" (the two
 * PET product grades the sales team tracks separately). PC and PE are untouched — they get the
 * sentinel pet_type 'NA' so the (category, material_type_id, pet_type) uniqueness still works
 * for opening stock the same way it did before this column existed. PET opening stock and
 * shipments must pick 'Bottle' or 'Gallon'; there is no more plain, combined "PET" row.
 *
 * Production records don't distinguish Bottle-sourced from Gallon-sourced PET output, so unlike
 * the other categories there is deliberately no "live produced" figure for either PET type —
 * their available stock is Opening Stock minus Shipped only (see GET /summary's `tracked_live`
 * flag on each row).
 *
 * Idempotent — safe to re-run.
 * Usage: node src/scripts/add-finished-goods-pet-type.js
 */
require('dotenv').config();
const pool = require('../config/database');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // --- finished_goods_opening_stock ---
    await client.query(`ALTER TABLE finished_goods_opening_stock ADD COLUMN IF NOT EXISTS pet_type VARCHAR(10) NOT NULL DEFAULT 'NA'`);
    await client.query(`ALTER TABLE finished_goods_opening_stock DROP CONSTRAINT IF EXISTS finished_goods_opening_stock_pet_type_check`);
    await client.query(`ALTER TABLE finished_goods_opening_stock ADD CONSTRAINT finished_goods_opening_stock_pet_type_check CHECK (pet_type IN ('NA', 'Bottle', 'Gallon'))`);
    await client.query(`ALTER TABLE finished_goods_opening_stock DROP CONSTRAINT IF EXISTS finished_goods_opening_stock_category_material_type_id_key`);
    await client.query(`ALTER TABLE finished_goods_opening_stock DROP CONSTRAINT IF EXISTS finished_goods_opening_stock_category_material_type_id_pet_type_key`);
    await client.query(`ALTER TABLE finished_goods_opening_stock ADD CONSTRAINT finished_goods_opening_stock_category_material_type_id_pet_type_key UNIQUE (category, material_type_id, pet_type)`);

    // --- finished_goods_shipments ---
    await client.query(`ALTER TABLE finished_goods_shipments ADD COLUMN IF NOT EXISTS pet_type VARCHAR(10) NOT NULL DEFAULT 'NA'`);
    await client.query(`ALTER TABLE finished_goods_shipments DROP CONSTRAINT IF EXISTS finished_goods_shipments_pet_type_check`);
    await client.query(`ALTER TABLE finished_goods_shipments ADD CONSTRAINT finished_goods_shipments_pet_type_check CHECK (pet_type IN ('NA', 'Bottle', 'Gallon'))`);

    // --- history tables (context only, no constraints needed) ---
    await client.query(`ALTER TABLE finished_goods_shipment_history ADD COLUMN IF NOT EXISTS pet_type VARCHAR(10) DEFAULT 'NA'`);
    await client.query(`ALTER TABLE finished_goods_opening_stock_history ADD COLUMN IF NOT EXISTS pet_type VARCHAR(10) DEFAULT 'NA'`);

    await client.query('COMMIT');
    console.log('✅ PET Bottle/Gallon type columns ensured across Outgoing / Sales tables.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
