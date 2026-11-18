/**
 * One PB, several POs (client request 18 Nov 2026): Purchasing does not always buy every line of a
 * request from the same vendor. A request now carries a list of POs, each covering a chosen set
 * of lines. proc_requests.po_no / supplier_* are kept as a summary (all PO numbers joined) so lists,
 * search and old reports keep working. Existing single-PO requests are backfilled into one PO row
 * that covers all their lines. Idempotent.
 */
require('dotenv').config();
const pool = require('../config/database');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS proc_request_pos (
        id             SERIAL PRIMARY KEY,
        request_id     INTEGER NOT NULL REFERENCES proc_requests(id) ON DELETE CASCADE,
        po_no          VARCHAR(60) NOT NULL,
        supplier_id    INTEGER,
        supplier_name  VARCHAR(160),
        notes          TEXT,
        po_at          TIMESTAMPTZ DEFAULT NOW(),
        "createdBy"    VARCHAR(120),
        "updatedBy"    VARCHAR(120),
        "createdAt"    TIMESTAMPTZ DEFAULT NOW(),
        "updatedAt"    TIMESTAMPTZ DEFAULT NOW()
      )`);
    await client.query('CREATE INDEX IF NOT EXISTS idx_proc_request_pos_request ON proc_request_pos (request_id)');
    await client.query('ALTER TABLE proc_request_items ADD COLUMN IF NOT EXISTS po_id INTEGER REFERENCES proc_request_pos(id) ON DELETE SET NULL');
    await client.query('CREATE INDEX IF NOT EXISTS idx_proc_request_items_po ON proc_request_items (po_id)');

    // Backfill: a request that already has a PO number gets one PO row covering every line.
    const todo = await client.query(`
      SELECT r.id, r.po_no, r.supplier_id, r.supplier_name, r.purchase_notes, r.po_at, r."updatedBy"
      FROM proc_requests r
      WHERE r.po_no IS NOT NULL AND r.po_no <> '' AND NOT EXISTS (SELECT 1 FROM proc_request_pos p WHERE p.request_id = r.id)`);
    for (const r of todo.rows) {
      const ins = await client.query(
        `INSERT INTO proc_request_pos (request_id, po_no, supplier_id, supplier_name, notes, po_at, "createdBy", "updatedBy") VALUES ($1,$2,$3,$4,$5,COALESCE($6, NOW()),$7,$7) RETURNING id`,
        [r.id, r.po_no, r.supplier_id, r.supplier_name, r.purchase_notes, r.po_at, r.updatedBy || 'migration']);
      await client.query('UPDATE proc_request_items SET po_id = $2 WHERE request_id = $1 AND po_id IS NULL', [r.id, ins.rows[0].id]);
    }
    await client.query('COMMIT');
    console.log(`✓ procurement multi-PO ready (${todo.rowCount} existing PO(s) backfilled)`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('✗ add-procurement-multi-po failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
