/**
 * Approval chains per department group (client's matrix, Nov 2026):
 *
 *   Group   Departments                                   Stage 1   Final
 *   FAT     Finance, Accounting & Tax · Purchasing          —        Bangkit
 *   HRGA    HSE · HR & GA · IT · Office · Security          —        Pak Ariendraputra
 *   QA      Lab PC · Lab PET · QC                           Aulia    Arif
 *   SCM     Exim · Production · Umum · Warehouse            Eldo     Pak Heri
 *   TEKNIK  Elektrik · Fork Lift · Mekanik                  Jalu     Pak Heri
 *
 *  - proc_approval_groups: the groups.
 *  - proc_departments.group_code: which group a department belongs to (editable in Department Master).
 *  - proc_approval_stages gains group_code ('' = the old per-category chain, kept as the fallback for
 *    departments without a group), approver_user_ids (named approvers) and approver_hint (the name
 *    from the matrix, shown until the stage is linked to a user). role_key becomes optional.
 *  Approvers are linked to user accounts by name when exactly one active user matches; the rest
 *  stay as hints to be picked in Approval Settings. Idempotent.
 */
require('dotenv').config();
const pool = require('../config/database');

const GROUPS = [
  { code: 'FAT', name: 'Finance, Accounting & Tax', sort_no: 1 },
  { code: 'HRGA', name: 'HR & General Affair', sort_no: 2 },
  { code: 'QA', name: 'Quality Assurance', sort_no: 3 },
  { code: 'SCM', name: 'Supply Chain', sort_no: 4 },
  { code: 'TEKNIK', name: 'Teknik (Engineering)', sort_no: 5 },
];
// Departments in the matrix, plus how the departments that already exist map onto the groups.
const DEPARTMENTS = [
  ['Finance, Accounting & Tax', 'FAT'], ['Purchasing', 'FAT'],
  ['HSE', 'HRGA'], ['Human Resources & General Affair', 'HRGA'], ['IT', 'HRGA'], ['Office', 'HRGA'], ['Security', 'HRGA'],
  ['Lab PC', 'QA'], ['Lab PET', 'QA'], ['QC', 'QA'],
  ['Exim', 'SCM'], ['Production', 'SCM'], ['Umum', 'SCM'], ['Warehouse', 'SCM'],
  ['Elektrik', 'TEKNIK'], ['Fork Lift', 'TEKNIK'], ['Mekanik', 'TEKNIK'],
];
const EXISTING_MAP = { 'QC Lab': 'QA', General: 'SCM', Electrical: 'TEKNIK', Mechanical: 'TEKNIK', Maintenance: 'TEKNIK', Utility: 'TEKNIK' };
const CHAINS = {
  FAT: [{ label: 'Bangkit', hint: 'Bangkit' }],
  HRGA: [{ label: 'Pak Ariendraputra', hint: 'Ariendraputra' }],
  QA: [{ label: 'Aulia', hint: 'Aulia' }, { label: 'Arif', hint: 'Arif' }],
  SCM: [{ label: 'Eldo', hint: 'Eldo' }, { label: 'Pak Heri', hint: 'Heri' }],
  TEKNIK: [{ label: 'Jalu', hint: 'Jalu' }, { label: 'Pak Heri', hint: 'Heri' }],
};

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS proc_approval_groups (
        code    VARCHAR(20) PRIMARY KEY,
        name    VARCHAR(80) NOT NULL,
        sort_no INTEGER NOT NULL DEFAULT 0
      )`);
    for (const g of GROUPS) {
      await client.query('INSERT INTO proc_approval_groups (code, name, sort_no) VALUES ($1, $2, $3) ON CONFLICT (code) DO NOTHING', [g.code, g.name, g.sort_no]);
    }
    await client.query(`ALTER TABLE proc_departments ADD COLUMN IF NOT EXISTS group_code VARCHAR(20)`);
    await client.query(`ALTER TABLE proc_approval_stages ADD COLUMN IF NOT EXISTS group_code VARCHAR(20) NOT NULL DEFAULT ''`);
    await client.query(`ALTER TABLE proc_approval_stages ADD COLUMN IF NOT EXISTS approver_user_ids INTEGER[] NOT NULL DEFAULT '{}'`);
    await client.query(`ALTER TABLE proc_approval_stages ADD COLUMN IF NOT EXISTS approver_hint VARCHAR(160)`);
    await client.query(`ALTER TABLE proc_approval_stages ALTER COLUMN role_key DROP NOT NULL`);
    // The old UNIQUE (category, stage_no) must go whatever it was named on this database.
    const olds = await client.query(`SELECT conname FROM pg_constraint WHERE conrelid = 'proc_approval_stages'::regclass AND contype = 'u'`);
    for (const c of olds.rows) await client.query(`ALTER TABLE proc_approval_stages DROP CONSTRAINT IF EXISTS "${c.conname}"`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_proc_approval_stage ON proc_approval_stages (category, group_code, stage_no)`);

    // Departments: create the ones from the matrix that do not exist yet, then assign groups.
    const next = await client.query(`SELECT COALESCE(MAX(NULLIF(regexp_replace(code, '\\D', '', 'g'), '')::int), 0) AS n FROM proc_departments WHERE code ~ '^DEPT-\\d+$'`);
    let seq = Number(next.rows[0].n) || 0;
    let created = 0;
    for (const [name, group] of DEPARTMENTS) {
      const hit = await client.query('SELECT id FROM proc_departments WHERE LOWER(name) = LOWER($1)', [name]);
      if (hit.rows.length) continue;
      seq += 1;
      await client.query(
        `INSERT INTO proc_departments (code, name, default_category, group_code, "createdBy") VALUES ($1, $2, 'General', $3, 'Migration')`,
        [`DEPT-${String(seq).padStart(3, '0')}`, name, group]);
      created += 1;
    }
    let grouped = 0;
    for (const [name, group] of [...DEPARTMENTS, ...Object.entries(EXISTING_MAP)]) {
      const r = await client.query('UPDATE proc_departments SET group_code = $2 WHERE LOWER(name) = LOWER($1) AND group_code IS NULL', [name, group]);
      grouped += r.rowCount;
    }

    // Group chains: seed once, linking approvers to users by name where unambiguous.
    const have = await client.query(`SELECT COUNT(*)::int AS n FROM proc_approval_stages WHERE group_code <> ''`);
    const linked = []; const unlinked = [];
    if (have.rows[0].n === 0) {
      for (const [code, stages] of Object.entries(CHAINS)) {
        for (let i = 0; i < stages.length; i += 1) {
          const st = stages[i];
          const u = await client.query(`SELECT id, name FROM users WHERE is_active = true AND name ILIKE '%' || $1 || '%'`, [st.hint]);
          const ids = u.rows.length === 1 ? [u.rows[0].id] : [];
          (ids.length ? linked : unlinked).push(`${code} stage ${i + 1} ${st.hint}${ids.length ? ` → ${u.rows[0].name}` : u.rows.length ? ` (${u.rows.length} users match)` : ' (no user)'}`);
          await client.query(
            `INSERT INTO proc_approval_stages (category, group_code, stage_no, role_key, label, approver_user_ids, approver_hint, "updatedBy")
             VALUES ('*', $1, $2, NULL, $3, $4::int[], $5, 'Migration')`,
            [code, i + 1, st.label, ids, st.hint]);
        }
      }
    }
    await client.query('COMMIT');
    console.log(`Approval groups ready. Departments created: ${created}, grouped: ${grouped}.`);
    if (linked.length) console.log('Approvers linked to users:\n  ' + linked.join('\n  '));
    if (unlinked.length) console.log('Approvers still to pick in Approval Settings:\n  ' + unlinked.join('\n  '));
    if (!linked.length && !unlinked.length) console.log('Group chains already seeded — untouched.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}
run();
