/**
 * Procurement phase 2 — goods receipt (LPB) with per-item QC:
 *  - every receipt line is split into qty_ok / qty_reject / qty_hold with a QC note and photo;
 *    only OK posts to stock, hold waits in quarantine until released or rejected, reject keeps
 *    the PB line open.
 *  - a receipt may reference a system PB (kind 'pb'), a typed PB number that may not exist in
 *    the system yet (kind 'manual', unmatched = true), or no PB at all (kind 'direct').
 *  - header gets the supplier delivery-note date and the physical checker; a receipt can be
 *    voided (stock reversed, PB re-opened) but never deleted.
 *  - proc_receipt_events is the receipt's own audit trail.
 * Idempotent.
 */
require('dotenv').config();
const pool = require('../config/database');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`ALTER TABLE proc_receipts ALTER COLUMN request_id DROP NOT NULL`);
    await client.query(`ALTER TABLE proc_receipts
      ADD COLUMN IF NOT EXISTS kind          VARCHAR(12) NOT NULL DEFAULT 'pb',
      ADD COLUMN IF NOT EXISTS manual_pb_no  VARCHAR(60),
      ADD COLUMN IF NOT EXISTS unmatched     BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS sj_date       DATE,
      ADD COLUMN IF NOT EXISTS checked_by    VARCHAR(120),
      ADD COLUMN IF NOT EXISTS domain        VARCHAR(12),
      ADD COLUMN IF NOT EXISTS voided        BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS void_reason   TEXT,
      ADD COLUMN IF NOT EXISTS voided_at     TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS voided_by     VARCHAR(120)`);

    await client.query(`ALTER TABLE proc_receipt_items ALTER COLUMN request_item_id DROP NOT NULL`);
    await client.query(`ALTER TABLE proc_receipt_items
      ADD COLUMN IF NOT EXISTS qty_ok        NUMERIC(14,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS qty_reject    NUMERIC(14,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS qty_hold      NUMERIC(14,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS hold_resolved VARCHAR(10),
      ADD COLUMN IF NOT EXISTS qc_note       TEXT,
      ADD COLUMN IF NOT EXISTS image_key     TEXT,
      ADD COLUMN IF NOT EXISTS image_name    VARCHAR(200),
      ADD COLUMN IF NOT EXISTS source        VARCHAR(12),
      ADD COLUMN IF NOT EXISTS source_id     INTEGER,
      ADD COLUMN IF NOT EXISTS item_code     VARCHAR(60),
      ADD COLUMN IF NOT EXISTS description   TEXT,
      ADD COLUMN IF NOT EXISTS unit          VARCHAR(20),
      ADD COLUMN IF NOT EXISTS hold_stock_ref VARCHAR(80)`);

    // Backfill lines written before the QC split: condition 'damaged' was never posted, so it
    // becomes reject; everything else was good stock.
    await client.query(`UPDATE proc_receipt_items SET qty_ok = qty WHERE qty_ok = 0 AND qty_reject = 0 AND qty_hold = 0 AND condition <> 'damaged'`);
    await client.query(`UPDATE proc_receipt_items SET qty_reject = qty WHERE qty_ok = 0 AND qty_reject = 0 AND qty_hold = 0 AND condition = 'damaged'`);
    await client.query(`UPDATE proc_receipt_items x SET source = i.source, source_id = i.source_id, item_code = i.item_code, description = i.description, unit = i.unit
       FROM proc_request_items i WHERE i.id = x.request_item_id AND x.description IS NULL`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS proc_receipt_events (
        id          SERIAL PRIMARY KEY,
        receipt_id  INTEGER NOT NULL REFERENCES proc_receipts(id) ON DELETE CASCADE,
        action      VARCHAR(30) NOT NULL,
        note        TEXT,
        actor       VARCHAR(120),
        actor_role  VARCHAR(60),
        "createdAt" TIMESTAMPTZ DEFAULT NOW()
      )`);
    await client.query('CREATE INDEX IF NOT EXISTS idx_proc_receipt_events_receipt ON proc_receipt_events (receipt_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_proc_receipts_kind ON proc_receipts (kind, unmatched, voided)');

    await client.query('COMMIT');
    console.log('✓ procurement receipt QC columns ready');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('✗ add-procurement-receipt-qc failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
