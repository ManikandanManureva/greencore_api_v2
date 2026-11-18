/**
 * General & IT item master for procurement (client question 18 Nov 2026): items that are neither
 * spare parts nor packaging (ATK, cleaning, PPE, IT equipment, services…) get their own master so a
 * PB can pick them with a consistent code and unit instead of free text. No stock is tracked for
 * them — an LPB on a general item never posts to any inventory. Idempotent.
 */
require('dotenv').config();
const pool = require('../config/database');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS proc_general_items (
        id           SERIAL PRIMARY KEY,
        code         VARCHAR(40) UNIQUE NOT NULL,
        description  VARCHAR(300) NOT NULL,
        specification TEXT,
        uom          VARCHAR(30) NOT NULL DEFAULT 'Pcs',
        min_stock    NUMERIC(14,2),
        location     VARCHAR(80),
        supplier     VARCHAR(160),
        group_name   VARCHAR(80),
        is_active    BOOLEAN NOT NULL DEFAULT TRUE,
        "createdBy"  VARCHAR(120),
        "updatedBy"  VARCHAR(120),
        "createdAt"  TIMESTAMPTZ DEFAULT NOW(),
        "updatedAt"  TIMESTAMPTZ DEFAULT NOW()
      )`);
    await client.query('CREATE INDEX IF NOT EXISTS idx_proc_general_items_desc ON proc_general_items (LOWER(description))');
    await client.query('COMMIT');
    console.log('✓ procurement general item master ready');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('✗ add-procurement-general-items failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
