/**
 * Procurement phase 2 (client confirmation 15 Nov 2026):
 *  - approval chain is configurable per category: proc_approval_stages (category, stage_no → role)
 *    seeded with the two-stage flow — Sparepart: SPV Mekanik → Pak Heri, Packaging: SCM → Pak Heri,
 *    General & IT: GA / IT → Pak Heri. Purchasing / Warehouse stay role-based after approval.
 *  - requests carry a single 'pending' status plus stage_no instead of pending_spv/om/director.
 *  - department master (proc_departments) replaces the hard-coded list; machine / area line master
 *    (proc_machines) is shared with the spare parts and packaging issue screens.
 * Idempotent; safe to re-run on every deploy.
 */
require('dotenv').config();
const pool = require('../config/database');

const STAGES = {
  Sparepart: [{ stage_no: 1, role_key: 'spv_mekanik', label: 'SPV Mekanik' }, { stage_no: 2, role_key: 'final_approver', label: 'Pak Heri' }],
  Packaging: [{ stage_no: 1, role_key: 'scm', label: 'SCM' }, { stage_no: 2, role_key: 'final_approver', label: 'Pak Heri' }],
  General:   [{ stage_no: 1, role_key: 'ga_it', label: 'GA / IT' }, { stage_no: 2, role_key: 'final_approver', label: 'Pak Heri' }],
};
const ROLES = [
  { key: 'spv_mekanik',    name: 'SPV Mekanik',                 description: 'First approval for spare part requests.' },
  { key: 'scm',            name: 'SCM',                         description: 'First approval for packaging requests.' },
  { key: 'ga_it',          name: 'GA / IT',                     description: 'First approval for General & IT requests.' },
  { key: 'final_approver', name: 'Final Approver (Pak Heri)',   description: 'Second and final approval for every purchase request.' },
];
const DEPARTMENTS = [
  { code: 'DEPT-001', name: 'Production',  default_category: 'Packaging' },
  { code: 'DEPT-002', name: 'Maintenance', default_category: 'Sparepart' },
  { code: 'DEPT-003', name: 'Electrical',  default_category: 'Sparepart' },
  { code: 'DEPT-004', name: 'Utility',     default_category: 'Sparepart' },
  { code: 'DEPT-005', name: 'QC Lab',      default_category: 'General' },
  { code: 'DEPT-006', name: 'Warehouse',   default_category: 'Packaging' },
  { code: 'DEPT-007', name: 'General',     default_category: 'General' },
];

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS proc_approval_stages (
        id          SERIAL PRIMARY KEY,
        category    VARCHAR(20) NOT NULL,
        stage_no    INTEGER NOT NULL CHECK (stage_no > 0),
        role_key    VARCHAR(60) NOT NULL,
        label       VARCHAR(80) NOT NULL,
        "updatedBy" VARCHAR(120),
        "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (category, stage_no)
      )`);
    const existing = await client.query('SELECT COUNT(*)::int AS n FROM proc_approval_stages');
    if (existing.rows[0].n === 0) {
      for (const [category, stages] of Object.entries(STAGES)) {
        for (const s of stages) {
          await client.query(
            'INSERT INTO proc_approval_stages (category, stage_no, role_key, label) VALUES ($1, $2, $3, $4)',
            [category, s.stage_no, s.role_key, s.label],
          );
        }
      }
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS proc_departments (
        id               SERIAL PRIMARY KEY,
        code             VARCHAR(30) UNIQUE NOT NULL,
        name             VARCHAR(80) UNIQUE NOT NULL,
        head_pic         VARCHAR(120),
        cost_center      VARCHAR(40),
        default_category VARCHAR(20) NOT NULL DEFAULT 'General',
        is_active        BOOLEAN NOT NULL DEFAULT TRUE,
        "createdBy"      VARCHAR(120),
        "updatedBy"      VARCHAR(120),
        "createdAt"      TIMESTAMPTZ DEFAULT NOW(),
        "updatedAt"      TIMESTAMPTZ DEFAULT NOW()
      )`);
    for (const d of DEPARTMENTS) {
      await client.query(
        // Seed only when neither the code nor the name exists: the PB history import renames
        // DEPT-002 "Maintenance" to "Mechanical", and the seed must not recreate it.
        `INSERT INTO proc_departments (code, name, default_category)
         SELECT $1::varchar, $2::varchar, $3::varchar WHERE NOT EXISTS (SELECT 1 FROM proc_departments WHERE code = $1::varchar OR name = $2::varchar)`,
        [d.code, d.name, d.default_category],
      );
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS proc_machines (
        id          SERIAL PRIMARY KEY,
        code        VARCHAR(30) UNIQUE NOT NULL,
        name        VARCHAR(120) NOT NULL,
        area        VARCHAR(120),
        department  VARCHAR(80),
        is_active   BOOLEAN NOT NULL DEFAULT TRUE,
        "createdBy" VARCHAR(120),
        "updatedBy" VARCHAR(120),
        "createdAt" TIMESTAMPTZ DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ DEFAULT NOW()
      )`);

    await client.query('ALTER TABLE proc_requests ADD COLUMN IF NOT EXISTS stage_no INTEGER');
    // Old three-tier statuses → single 'pending' + stage number (OM was the first stage for
    // non-Maintenance requests, so it maps to stage 1; Director was always the last).
    await client.query(`UPDATE proc_requests SET status = 'pending', stage_no = 1 WHERE status IN ('pending_spv', 'pending_om')`);
    await client.query(`UPDATE proc_requests SET status = 'pending', stage_no = 2 WHERE status = 'pending_director'`);
    await client.query('CREATE INDEX IF NOT EXISTS idx_proc_requests_status_stage ON proc_requests (status, category, stage_no)');

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
    }

    await client.query('COMMIT');
    console.log('✓ procurement approval config, departments and machines ready');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('✗ add-procurement-approval-config failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
