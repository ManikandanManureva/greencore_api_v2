/**
 * Spare Parts v2 — unified schema.
 * Replaces the per-catalog tables (starlinger_spare_parts / mec_spare_parts, and their _log
 * tables) with one catalog registry + one items table + one log table, so adding a new PET
 * machine (or any future catalog) is a registry row, not a new table and route block.
 *
 *   spare_parts_catalogs — the menu: PC, PE, PET·Starlinger, PET·Boretech, MEC/General, ...
 *   spare_parts_items    — one row per part, tagged to a catalog
 *   spare_parts_log      — Received/Used transactions against an item
 *
 * Idempotent — safe to re-run. Run migrate-spareparts-v2.js afterwards to carry over the
 * existing Starlinger/MEC data (that script is also idempotent / skips if already migrated).
 *
 * Usage:
 *   node src/scripts/create-spareparts-v2.js
 */
require('dotenv').config();
const pool = require('../config/database');

const CATALOGS = [
  { key: 'pc',             label: 'PC Spare Parts',  material_type: 'PC',  machine: null,         sort_order: 10 },
  { key: 'pe',             label: 'PE Spare Parts',  material_type: 'PE',  machine: null,         sort_order: 20 },
  { key: 'pet-starlinger', label: 'Starlinger',      material_type: 'PET', machine: 'Starlinger', sort_order: 30 },
  { key: 'pet-boretech',   label: 'Boretech',        material_type: 'PET', machine: 'Boretech',   sort_order: 31 },
  { key: 'mec',            label: 'MEC / General',   material_type: null,  machine: null,         sort_order: 90 },
];

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS spare_parts_catalogs (
        id             SERIAL PRIMARY KEY,
        key            VARCHAR(40) UNIQUE NOT NULL,
        label          VARCHAR(100) NOT NULL,
        material_type  VARCHAR(10),
        machine        VARCHAR(60),
        sort_order     INTEGER NOT NULL DEFAULT 0,
        created_at     TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS spare_parts_items (
        id            SERIAL PRIMARY KEY,
        catalog_id    INTEGER NOT NULL REFERENCES spare_parts_catalogs(id),
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
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sp_items_catalog ON spare_parts_items (catalog_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sp_items_partno ON spare_parts_items (part_no)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sp_items_category ON spare_parts_items (category)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS spare_parts_log (
        id                SERIAL PRIMARY KEY,
        item_id           INTEGER NOT NULL REFERENCES spare_parts_items(id),
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
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sp_log_item ON spare_parts_log (item_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sp_log_date ON spare_parts_log (log_date)`);

    for (const c of CATALOGS) {
      await client.query(
        `INSERT INTO spare_parts_catalogs (key, label, material_type, machine, sort_order)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order`,
        [c.key, c.label, c.material_type, c.machine, c.sort_order],
      );
    }

    await client.query('COMMIT');
    console.log('✅ Spare Parts v2 tables + catalog registry ensured.');
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
