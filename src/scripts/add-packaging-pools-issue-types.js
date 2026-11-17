/**
 * Procurement phase 3 (client confirmation 15 Nov 2026):
 *  - Packaging (pm_item) stock is split into two independent pools: SALES (actual, what can be
 *    dispatched to customers) and MOVING (production circulation). Stock-in, corrections and
 *    damage carry a pool; outgoing carries a movement_type that decides which pool it draws from.
 *    Everything recorded before this migration stays on the SALES pool so today's balances do not
 *    change; the warehouse team's cut-off sheet seeds the MOVING pool through parts_pool_opening.
 *  - Spare part issues get an issue_type (PM / BREAKDOWN / PPE / RETURN / OTHER) and the machine.
 *  - Packaging issues and damage can name the machine / area line too.
 *  - Purchase requests created automatically when stock hits the minimum are flagged is_auto with
 *    the triggering document.
 * Idempotent.
 */
require('dotenv').config();
const pool = require('../config/database');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`ALTER TABLE parts_stock_in ADD COLUMN IF NOT EXISTS pool VARCHAR(10) NOT NULL DEFAULT 'SALES'`);
    await client.query(`ALTER TABLE parts_stock_correction ADD COLUMN IF NOT EXISTS pool VARCHAR(10) NOT NULL DEFAULT 'SALES'`);
    await client.query(`ALTER TABLE parts_damage_waste
      ADD COLUMN IF NOT EXISTS pool VARCHAR(10) NOT NULL DEFAULT 'SALES',
      ADD COLUMN IF NOT EXISTS machine_id INTEGER,
      ADD COLUMN IF NOT EXISTS machine_name VARCHAR(120)`);
    await client.query(`ALTER TABLE parts_outgoing
      ADD COLUMN IF NOT EXISTS movement_type VARCHAR(20) NOT NULL DEFAULT 'LEGACY',
      ADD COLUMN IF NOT EXISTS machine_id INTEGER,
      ADD COLUMN IF NOT EXISTS machine_name VARCHAR(120),
      ADD COLUMN IF NOT EXISTS auto_pb_no VARCHAR(60)`);
    // Rows written before pools existed: sales keep their meaning, everything else stays a
    // legacy deduction from the SALES pool (balances unchanged).
    await client.query(`UPDATE parts_outgoing SET movement_type = 'SALES_DISPATCH' WHERE movement_type = 'LEGACY' AND purpose = 'sale'`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS parts_pool_opening (
        id          SERIAL PRIMARY KEY,
        part_id     INTEGER NOT NULL REFERENCES pm_item(id),
        pool        VARCHAR(10) NOT NULL,
        qty         NUMERIC(14,2) NOT NULL,
        as_of_date  DATE NOT NULL,
        notes       TEXT,
        "createdBy" VARCHAR(120),
        "createdAt" TIMESTAMPTZ DEFAULT NOW()
      )`);
    await client.query('CREATE INDEX IF NOT EXISTS idx_parts_pool_opening_part ON parts_pool_opening (part_id, pool)');

    await client.query(`ALTER TABLE spare_parts_log
      ADD COLUMN IF NOT EXISTS issue_type VARCHAR(12),
      ADD COLUMN IF NOT EXISTS machine_id INTEGER,
      ADD COLUMN IF NOT EXISTS machine_name VARCHAR(120),
      ADD COLUMN IF NOT EXISTS auto_pb_no VARCHAR(60)`);

    await client.query(`ALTER TABLE proc_receipt_items ADD COLUMN IF NOT EXISTS pool VARCHAR(10)`);

    await client.query(`ALTER TABLE proc_requests
      ADD COLUMN IF NOT EXISTS is_auto BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS source_doc VARCHAR(80)`);

    await client.query('COMMIT');
    console.log('✓ packaging pools, issue types and auto-PB columns ready');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('✗ add-packaging-pools-issue-types failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
