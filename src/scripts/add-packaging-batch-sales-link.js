/**
 * Packaging outgoing, client feedback 17 Nov 2026:
 *  - several packaging items can be issued under one reference in one go (batch_no groups them);
 *  - a Sales / Dispatch issue links to the Finished Goods / Flakes shipment reference (DO) so the
 *    customer and destination follow the shipment instead of being typed again;
 *  - parts_packaging_refs remembers which shipment references have had all their packaging
 *    issued, so the picker only offers references that still need something.
 * Idempotent.
 */
require('dotenv').config();
const pool = require('../config/database');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`ALTER TABLE parts_outgoing
      ADD COLUMN IF NOT EXISTS batch_no VARCHAR(30),
      ADD COLUMN IF NOT EXISTS shipment_ref VARCHAR(80),
      ADD COLUMN IF NOT EXISTS customer VARCHAR(160)`);
    await client.query('CREATE INDEX IF NOT EXISTS idx_parts_outgoing_shipment_ref ON parts_outgoing (shipment_ref)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_parts_outgoing_batch ON parts_outgoing (batch_no)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS parts_packaging_refs (
        ref_no        VARCHAR(80) PRIMARY KEY,
        status        VARCHAR(12) NOT NULL DEFAULT 'open',
        notes         TEXT,
        completed_by  VARCHAR(120),
        completed_at  TIMESTAMPTZ,
        "updatedAt"   TIMESTAMPTZ DEFAULT NOW()
      )`);
    await client.query('COMMIT');
    console.log('✓ packaging batch / sales link columns ready');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('✗ add-packaging-batch-sales-link failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
