/**
 * Migration: Spare Parts module (PET login only) — two separate catalogs mirroring the two
 * source spreadsheets:
 *   - Starlinger Spare Parts: branded part numbers (e.g. AENK-01015), per-part Min/Max Stock.
 *   - MEC Spare Parts: generic codes (SP-MEC-xxx), flat low-stock threshold (default 5 units),
 *     reorder qty = MAX(10, ceil(avg daily usage * 15 - current qty)), matching the workbook's
 *     own formulas (`Stok & Mutasi Harian`!BS/BT, `Rekap Pengambilan`!L).
 * Each catalog has its own transaction log (Received/Used) that drives current_qty — operators
 * (PET role) log transactions; PPIC edits master fields (min/max, location, etc.).
 * Idempotent — safe to re-run.
 *
 * Usage:
 *   node src/scripts/create-spareparts-tables.js
 */
require('dotenv').config();
const pool = require('../config/database');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS starlinger_spare_parts (
        id            SERIAL PRIMARY KEY,
        part_no       VARCHAR(60),
        description   TEXT NOT NULL,
        category      VARCHAR(150),
        shelf         VARCHAR(20),
        floor         VARCHAR(20),
        location      VARCHAR(40),
        base_stock    NUMERIC(14,2) NOT NULL DEFAULT 0,
        current_qty   NUMERIC(14,2) NOT NULL DEFAULT 0,
        min_stock     NUMERIC(14,2),
        max_stock     NUMERIC(14,2),
        unit          VARCHAR(20),
        machine       VARCHAR(60),
        supplier      VARCHAR(150),
        notes         TEXT,
        "createdBy"   VARCHAR(120),
        "updatedBy"   VARCHAR(120),
        "createdAt"   TIMESTAMPTZ DEFAULT NOW(),
        "updatedAt"   TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_starlinger_parts_partno ON starlinger_spare_parts (part_no)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_starlinger_parts_category ON starlinger_spare_parts (category)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS starlinger_spare_parts_log (
        id                SERIAL PRIMARY KEY,
        part_id           INTEGER NOT NULL REFERENCES starlinger_spare_parts(id),
        log_date          DATE NOT NULL DEFAULT CURRENT_DATE,
        transaction_type  VARCHAR(10) NOT NULL CHECK (transaction_type IN ('Received','Used')),
        qty               NUMERIC(14,2) NOT NULL,
        description       TEXT,
        technician        VARCHAR(120),
        remark            TEXT,
        "createdBy"       VARCHAR(120),
        "createdAt"       TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_starlinger_log_part ON starlinger_spare_parts_log (part_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_starlinger_log_date ON starlinger_spare_parts_log (log_date)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS mec_spare_parts (
        id                 SERIAL PRIMARY KEY,
        part_code          VARCHAR(60) UNIQUE NOT NULL,
        name               TEXT NOT NULL,
        unit               VARCHAR(20),
        opening_stock      NUMERIC(14,2) NOT NULL DEFAULT 0,
        current_qty        NUMERIC(14,2) NOT NULL DEFAULT 0,
        reorder_threshold  NUMERIC(14,2) NOT NULL DEFAULT 5,
        "createdBy"        VARCHAR(120),
        "updatedBy"        VARCHAR(120),
        "createdAt"        TIMESTAMPTZ DEFAULT NOW(),
        "updatedAt"        TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_mec_parts_code ON mec_spare_parts (part_code)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS mec_spare_parts_log (
        id                SERIAL PRIMARY KEY,
        part_id           INTEGER NOT NULL REFERENCES mec_spare_parts(id),
        log_date          DATE NOT NULL DEFAULT CURRENT_DATE,
        transaction_type  VARCHAR(10) NOT NULL CHECK (transaction_type IN ('Received','Used')),
        qty               NUMERIC(14,2) NOT NULL,
        description       TEXT,
        technician        VARCHAR(120),
        remark            TEXT,
        "createdBy"       VARCHAR(120),
        "createdAt"       TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_mec_log_part ON mec_spare_parts_log (part_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_mec_log_date ON mec_spare_parts_log (log_date)`);

    await client.query('COMMIT');
    console.log('✅ Spare Parts tables ensured.');
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
