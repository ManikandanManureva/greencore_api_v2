/**
 * Migration: Replace from_date/to_date with single stock_date on opening_stock.
 * Idempotent — safe to re-run.
 *
 * Usage:
 *   node src/scripts/migrate-opening-stock-date.js
 */
require('dotenv').config();
const pool = require('../config/database');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Add stock_date if missing (backfill from from_date if it still exists)
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='opening_stock' AND column_name='stock_date') THEN
          ALTER TABLE opening_stock ADD COLUMN stock_date DATE;
          -- Backfill from from_date if it exists
          IF EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='opening_stock' AND column_name='from_date') THEN
            UPDATE opening_stock SET stock_date = from_date WHERE stock_date IS NULL;
          END IF;
          -- Default any remaining nulls to today
          UPDATE opening_stock SET stock_date = CURRENT_DATE WHERE stock_date IS NULL;
          ALTER TABLE opening_stock ALTER COLUMN stock_date SET NOT NULL;
        END IF;
      END $$
    `);
    console.log('✅ stock_date column ensured');

    // Drop from_date / to_date if they still exist
    await client.query(`
      ALTER TABLE opening_stock DROP COLUMN IF EXISTS from_date;
    `);
    console.log('✅ from_date dropped (if existed)');

    await client.query(`
      ALTER TABLE opening_stock DROP COLUMN IF EXISTS to_date;
    `);
    console.log('✅ to_date dropped (if existed)');

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_opening_stock_date ON opening_stock(stock_date DESC)
    `);
    console.log('✅ idx_opening_stock_date index ensured');

    await client.query('COMMIT');
    console.log('\n✅ opening_stock date column migration complete.');
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
