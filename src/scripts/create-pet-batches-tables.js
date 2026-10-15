/**
 * Migration: PET raw-material Batch traceability (delivery notes → batch number), threaded
 * through the PET line. Originally region + 4 stations (Crushing, Washing, Flakes Sorting,
 * Extrusion); now ~8 Delivery Notes per batch (GPET/YYMMDD/NN, no region) across Hot Washing →
 * Dry Sorter → Pelletizer. Old batches/sessions keep their values.
 *
 * A Batch is created once at Crushing (region + one or more Delivery Notes, which already
 * exist in raw_material.deliveryNote — no change to that table's data). Each of the 4 stations
 * then starts/ends its own session against that same batch, giving a start time + running
 * timer per station and a full start/end timeline per batch.
 *
 * This wraps the EXISTING jumbo-bag QR/weight workflow — production_logs gets one new
 * nullable column (pet_batch_no) so each bag can be tagged with whichever batch was active
 * when it was produced. No existing table's data is altered.
 * Idempotent — safe to re-run.
 *
 * Usage:
 *   node src/scripts/create-pet-batches-tables.js
 */
require('dotenv').config();
const pool = require('../config/database');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS pet_batches (
        id              SERIAL PRIMARY KEY,
        batch_no        VARCHAR(60) UNIQUE NOT NULL,
        region          VARCHAR(40) NOT NULL,
        region_code     VARCHAR(10) NOT NULL,
        batch_date      DATE NOT NULL,
        running_number  INTEGER NOT NULL,
        "createdBy"     VARCHAR(120),
        "createdAt"     TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pet_batches_date_region ON pet_batches (batch_date, region_code)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS pet_batch_delivery_notes (
        id             SERIAL PRIMARY KEY,
        batch_id       INTEGER NOT NULL REFERENCES pet_batches(id),
        delivery_note  VARCHAR(100) NOT NULL,
        "createdAt"    TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pet_batch_dn_batch ON pet_batch_delivery_notes (batch_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pet_batch_dn_note ON pet_batch_delivery_notes (delivery_note)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS pet_batch_station_sessions (
        id            SERIAL PRIMARY KEY,
        batch_id      INTEGER NOT NULL REFERENCES pet_batches(id),
        station_key   VARCHAR(20) NOT NULL,
        started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "startedBy"   VARCHAR(120),
        ended_at      TIMESTAMPTZ,
        "endedBy"     VARCHAR(120)
      )
    `);
    // Station keys: the original 4 (kept so old sessions stay valid) + the finalized line
    // Hot Washing → Dry Sorter → Pelletizer. Dropped and re-added so re-runs stay idempotent.
    await client.query(`ALTER TABLE pet_batch_station_sessions DROP CONSTRAINT IF EXISTS pet_batch_station_sessions_station_key_check`);
    await client.query(`
      ALTER TABLE pet_batch_station_sessions ADD CONSTRAINT pet_batch_station_sessions_station_key_check
      CHECK (station_key IN ('crushing','washing','flakes_sorting','extrusion','hot_washing','dry_sorter','pelletizer'))
    `);
    // Batches now group ~8 Delivery Notes with no region (GPET/YYMMDD/NN); older batches keep theirs.
    await client.query(`ALTER TABLE pet_batches ALTER COLUMN region DROP NOT NULL`);
    await client.query(`ALTER TABLE pet_batches ALTER COLUMN region_code DROP NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pet_sessions_batch ON pet_batch_station_sessions (batch_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pet_sessions_station ON pet_batch_station_sessions (station_key, ended_at)`);

    // Additive only — existing production_logs rows are untouched; new bags can tag their batch.
    await client.query(`ALTER TABLE production_logs ADD COLUMN IF NOT EXISTS pet_batch_no VARCHAR(60)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_production_logs_pet_batch ON production_logs (pet_batch_no)`);
    // Downstream lookups (which bags consumed this one) for trace views and the PPIC export.
    await client.query(`CREATE INDEX IF NOT EXISTS idx_production_logs_input_qr ON production_logs (input_bag_qr)`);

    await client.query('COMMIT');
    console.log('✅ PET Batch traceability tables ensured.');
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
