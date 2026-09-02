/**
 * Migration: Create Parts Inventory transaction tables.
 * Idempotent — safe to re-run.
 *
 * Usage:
 *   node src/scripts/add-parts-inventory-tables.js
 */
require('dotenv').config();
const pool = require('../config/database');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS parts_stock_in (
        id                  SERIAL PRIMARY KEY,
        purchase_order_id   VARCHAR(100),
        entry_date          DATE NOT NULL,
        supplier_name       VARCHAR(200) NOT NULL,
        part_id             INTEGER NOT NULL REFERENCES pm_item(id),
        part_code           VARCHAR(40),
        part_description    TEXT,
        uom                 VARCHAR(10),
        quantity_received   NUMERIC(14,2) NOT NULL,
        unit_price          NUMERIC(14,2),
        received_by         VARCHAR(120) NOT NULL,
        status              VARCHAR(20) NOT NULL DEFAULT 'pending',
        notes               TEXT,
        created_at          TIMESTAMPTZ DEFAULT NOW(),
        updated_at          TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ parts_stock_in table ensured');

    await client.query(`
      CREATE TABLE IF NOT EXISTS parts_stock_correction (
        id                SERIAL PRIMARY KEY,
        correction_date   DATE NOT NULL,
        part_id           INTEGER NOT NULL REFERENCES pm_item(id),
        part_code         VARCHAR(40),
        part_description  TEXT,
        uom               VARCHAR(10),
        current_stock     NUMERIC(14,2) NOT NULL,
        counted_stock     NUMERIC(14,2) NOT NULL,
        variance          NUMERIC(14,2) NOT NULL,
        reason            TEXT NOT NULL,
        corrected_by      VARCHAR(120) NOT NULL,
        status            VARCHAR(20) NOT NULL DEFAULT 'pending',
        notes             TEXT,
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        updated_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ parts_stock_correction table ensured');

    await client.query(`
      CREATE TABLE IF NOT EXISTS parts_outgoing (
        id                SERIAL PRIMARY KEY,
        outgoing_date     DATE NOT NULL,
        reference_id      VARCHAR(100),
        part_id           INTEGER NOT NULL REFERENCES pm_item(id),
        part_code         VARCHAR(40),
        part_description  TEXT,
        uom               VARCHAR(10),
        quantity_sent     NUMERIC(14,2) NOT NULL,
        destination       VARCHAR(200),
        purpose           VARCHAR(20) NOT NULL,
        issued_by         VARCHAR(120) NOT NULL,
        received_by       VARCHAR(120),
        status            VARCHAR(20) NOT NULL DEFAULT 'issued',
        notes             TEXT,
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        updated_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Migration: reference_id & destination are now optional on existing installs
    await client.query(`ALTER TABLE parts_outgoing ALTER COLUMN reference_id DROP NOT NULL`);
    await client.query(`ALTER TABLE parts_outgoing ALTER COLUMN destination DROP NOT NULL`);
    console.log('✅ parts_outgoing table ensured');

    await client.query(`
      CREATE TABLE IF NOT EXISTS parts_damage_waste (
        id                 SERIAL PRIMARY KEY,
        incident_date      DATE NOT NULL,
        part_id            INTEGER NOT NULL REFERENCES pm_item(id),
        part_code          VARCHAR(40),
        part_description   TEXT,
        uom                VARCHAR(10),
        quantity_affected  NUMERIC(14,2) NOT NULL,
        incident_type      VARCHAR(20) NOT NULL,
        root_cause         TEXT NOT NULL,
        location           VARCHAR(200) NOT NULL,
        reported_by        VARCHAR(120) NOT NULL,
        approver           VARCHAR(120),
        status             VARCHAR(20) NOT NULL DEFAULT 'reported',
        notes              TEXT,
        created_at         TIMESTAMPTZ DEFAULT NOW(),
        updated_at         TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ parts_damage_waste table ensured');

    await client.query(`
      CREATE TABLE IF NOT EXISTS parts_stock_ledger (
        id                SERIAL PRIMARY KEY,
        transaction_date  DATE NOT NULL,
        transaction_type  VARCHAR(20) NOT NULL,
        reference_id      VARCHAR(100),
        part_id           INTEGER NOT NULL REFERENCES pm_item(id),
        part_code         VARCHAR(40),
        part_description  TEXT,
        quantity_in       NUMERIC(14,2),
        quantity_out      NUMERIC(14,2),
        balance_after     NUMERIC(14,2) NOT NULL,
        performed_by      VARCHAR(120),
        notes             TEXT,
        created_at        TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ parts_stock_ledger table ensured');

    await client.query('COMMIT');
    console.log('\n✅ All parts inventory tables ready.');
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
