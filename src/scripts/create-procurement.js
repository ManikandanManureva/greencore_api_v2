/**
 * Procurement — Permintaan Barang (PB) → approval chain → purchasing (PO) → Laporan Penerimaan
 * Barang (LPB). Quantities and specifications only: no pricing anywhere in this module.
 *
 *   proc_suppliers        — supplier master
 *   proc_requests         — one PB per row, with its status, PO reference and chosen supplier
 *   proc_request_items    — the lines of a PB; each may point at an existing spare part
 *                           (spare_parts_items) or packaging part (pm_item), or be a custom item
 *   proc_receipts         — one LPB per delivery against a PB
 *   proc_receipt_items    — the lines received on that LPB
 *   proc_request_history  — every status change, reminder and note (the audit trail)
 *
 * Also seeds the roles the approval chain is built on (each sees only the Procurement module):
 *   requester, spv_maintenance, operational_manager, director, purchasing, warehouse
 * and grants admin / super_admin full access to the new module. Idempotent — safe to re-run.
 */
require('dotenv').config();
const pool = require('../config/database');

const ROLES = [
  { key: 'requester',           name: 'Requester (PB)',        description: 'Raises Permintaan Barang for their department and follows it to delivery.' },
  { key: 'spv_maintenance',     name: 'SPV Maintenance',       description: 'First approval for Maintenance department requests.' },
  { key: 'operational_manager', name: 'Operational Manager',   description: 'Approves every request; final approval for spare parts.' },
  { key: 'director',            name: 'Director (Direksi)',    description: 'Final approval for Packaging and Production requests.' },
  { key: 'purchasing',          name: 'Purchasing',            description: 'Turns approved requests into purchase orders with a supplier.' },
  { key: 'warehouse',           name: 'Warehouse (LPB)',       description: 'Records goods received against purchase orders.' },
];

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS proc_suppliers (
        id              SERIAL PRIMARY KEY,
        code            VARCHAR(30) UNIQUE NOT NULL,
        name            VARCHAR(160) NOT NULL,
        contact_person  VARCHAR(120),
        phone           VARCHAR(40),
        email           VARCHAR(160),
        address         TEXT,
        categories      TEXT[] NOT NULL DEFAULT '{}',
        status          VARCHAR(12) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
        notes           TEXT,
        "createdBy"     VARCHAR(120),
        "updatedBy"     VARCHAR(120),
        "createdAt"     TIMESTAMPTZ DEFAULT NOW(),
        "updatedAt"     TIMESTAMPTZ DEFAULT NOW()
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS proc_requests (
        id                SERIAL PRIMARY KEY,
        pr_no             VARCHAR(60) UNIQUE NOT NULL,
        pr_date           DATE NOT NULL DEFAULT CURRENT_DATE,
        department        VARCHAR(40) NOT NULL,
        category          VARCHAR(20) NOT NULL CHECK (category IN ('Sparepart', 'Packaging', 'General')),
        requested_by_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        requested_by      VARCHAR(120) NOT NULL,
        priority          VARCHAR(10) NOT NULL DEFAULT 'Normal' CHECK (priority IN ('Normal', 'Urgent')),
        urgent_reason     TEXT,
        budget_type       VARCHAR(10) NOT NULL DEFAULT 'OPEX' CHECK (budget_type IN ('OPEX', 'CAPEX')),
        required_date     DATE,
        notes             TEXT,
        status            VARCHAR(24) NOT NULL DEFAULT 'draft',
        reject_reason     TEXT,
        po_no             VARCHAR(60),
        supplier_id       INTEGER REFERENCES proc_suppliers(id) ON DELETE SET NULL,
        supplier_name     VARCHAR(160),
        purchase_notes    TEXT,
        submitted_at      TIMESTAMPTZ,
        approved_at       TIMESTAMPTZ,
        po_at             TIMESTAMPTZ,
        completed_at      TIMESTAMPTZ,
        "createdBy"       VARCHAR(120),
        "updatedBy"       VARCHAR(120),
        "createdAt"       TIMESTAMPTZ DEFAULT NOW(),
        "updatedAt"       TIMESTAMPTZ DEFAULT NOW()
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_proc_requests_status ON proc_requests (status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_proc_requests_date ON proc_requests (pr_date)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS proc_request_items (
        id              SERIAL PRIMARY KEY,
        request_id      INTEGER NOT NULL REFERENCES proc_requests(id) ON DELETE CASCADE,
        line_no         INTEGER NOT NULL DEFAULT 1,
        source          VARCHAR(12) NOT NULL DEFAULT 'custom' CHECK (source IN ('spare_part', 'part', 'custom')),
        source_id       INTEGER,
        item_code       VARCHAR(60),
        description     TEXT NOT NULL,
        specification   TEXT,
        qty             NUMERIC(14,2) NOT NULL CHECK (qty > 0),
        unit            VARCHAR(20) NOT NULL DEFAULT 'Pcs',
        min_stock       NUMERIC(14,2),
        stock_at_request NUMERIC(14,2),
        received_qty    NUMERIC(14,2) NOT NULL DEFAULT 0,
        image_key       TEXT,
        image_name      VARCHAR(200)
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_proc_request_items_req ON proc_request_items (request_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS proc_receipts (
        id              SERIAL PRIMARY KEY,
        grn_no          VARCHAR(60) UNIQUE NOT NULL,
        request_id      INTEGER NOT NULL REFERENCES proc_requests(id) ON DELETE RESTRICT,
        receipt_date    DATE NOT NULL DEFAULT CURRENT_DATE,
        supplier_id     INTEGER REFERENCES proc_suppliers(id) ON DELETE SET NULL,
        supplier_name   VARCHAR(160),
        delivery_note   VARCHAR(80),
        received_by     VARCHAR(120),
        condition       VARCHAR(20) NOT NULL DEFAULT 'good' CHECK (condition IN ('good', 'partial_damage', 'damaged')),
        notes           TEXT,
        posted_to_stock BOOLEAN NOT NULL DEFAULT false,
        "createdBy"     VARCHAR(120),
        "createdAt"     TIMESTAMPTZ DEFAULT NOW()
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_proc_receipts_req ON proc_receipts (request_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS proc_receipt_items (
        id                SERIAL PRIMARY KEY,
        receipt_id        INTEGER NOT NULL REFERENCES proc_receipts(id) ON DELETE CASCADE,
        request_item_id   INTEGER NOT NULL REFERENCES proc_request_items(id) ON DELETE CASCADE,
        qty               NUMERIC(14,2) NOT NULL CHECK (qty > 0),
        condition         VARCHAR(20) NOT NULL DEFAULT 'good',
        stock_ref         VARCHAR(60)
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS proc_request_history (
        id            SERIAL PRIMARY KEY,
        request_id    INTEGER NOT NULL REFERENCES proc_requests(id) ON DELETE CASCADE,
        action        VARCHAR(30) NOT NULL,
        from_status   VARCHAR(24),
        to_status     VARCHAR(24),
        note          TEXT,
        actor         VARCHAR(120),
        actor_role    VARCHAR(60),
        "createdAt"   TIMESTAMPTZ DEFAULT NOW()
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_proc_history_req ON proc_request_history (request_id)`);

    // Roles for the approval chain — only created when missing so admins' edits survive re-runs.
    const rolesTable = await client.query(`SELECT to_regclass('public.roles') AS t`);
    if (rolesTable.rows[0].t) {
      for (const r of ROLES) {
        const ins = await client.query(
          `INSERT INTO roles (key, name, description, is_system) VALUES ($1, $2, $3, false)
           ON CONFLICT (key) DO NOTHING RETURNING id`,
          [r.key, r.name, r.description],
        );
        if (ins.rows.length === 0) continue;
        await client.query(
          `INSERT INTO role_permissions (role_id, module_key, can_read, can_write, can_delete) VALUES ($1, 'procurement', true, true, false)
           ON CONFLICT DO NOTHING`,
          [ins.rows[0].id],
        );
      }
      // Admin and Super Admin get the new module in full, like every other module.
      await client.query(
        `INSERT INTO role_permissions (role_id, module_key, can_read, can_write, can_delete)
         SELECT id, 'procurement', true, true, true FROM roles WHERE key IN ('super_admin', 'admin')
         ON CONFLICT DO NOTHING`,
      );
    }

    await client.query('COMMIT');
    console.log('✅ Procurement tables and roles ready.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
