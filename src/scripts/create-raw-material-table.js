/**
 * Migration: Create raw_material (gate-entry) table.
 * Idempotent — safe to re-run.
 *
 * Usage:
 *   node src/scripts/create-raw-material-table.js
 */
require('dotenv').config();
const pool = require('../config/database');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS raw_material (
        id                    SERIAL PRIMARY KEY,
        "refId"               VARCHAR(60),
        entrydate             DATE,
        entrytime             VARCHAR(10),
        exitdate              DATE,
        exittime              VARCHAR(10),
        "truckId"             VARCHAR(60),
        supplier              VARCHAR(200),
        plant                 VARCHAR(100),
        "materialType"        VARCHAR(20),
        "materialDescription" TEXT,
        "entryWeight"         NUMERIC(14,2),
        "exitWeight"          NUMERIC(14,2),
        "netWeight"           NUMERIC(14,2),
        "deliveryNote"        VARCHAR(100),
        notes                 TEXT,
        quantity              NUMERIC(14,2),
        status                VARCHAR(20) DEFAULT 'Pending',
        returnentrydate       DATE,
        returnentrytime       VARCHAR(10),
        "returnExitDate"      DATE,
        "returnExitTime"      VARCHAR(10),
        "returnEntryWeight"   NUMERIC(14,2),
        "returnExitWeight"    NUMERIC(14,2),
        "returnNetWeight"     NUMERIC(14,2),
        "recordNoWBS"         VARCHAR(100),
        "createdBy"           VARCHAR(120),
        "updatedBy"           VARCHAR(120),
        "createdAt"           TIMESTAMPTZ DEFAULT NOW(),
        "updatedAt"           TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_raw_material_exitdate   ON raw_material (exitdate)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_raw_material_status      ON raw_material (status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_raw_material_materialtype ON raw_material ("materialType")`);

    await client.query('COMMIT');
    console.log('✅ raw_material table and indexes ensured.');
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
