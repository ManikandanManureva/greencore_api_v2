const express = require('express');
const router = express.Router();
const { poolBalanceSql } = require('../services/stockPools');

// A 500 whose real cause is "relation proc_requests does not exist" means the API was restarted
// without running scripts/deploy.sh (which runs src/scripts/create-procurement.js) — say so,
// instead of making someone dig through pm2 logs for it.
function fail(res, err, message) {
  if (err && err.code === '42P01') {
    return res.status(500).json({ success: false, message: `${message}: the procurement tables are missing — run "node src/scripts/create-procurement.js" (part of scripts/deploy.sh) on the server.` });
  }
  res.status(500).json({ success: false, message });
}
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { requireModule, hasPermission } = require('../middleware/permissions');
const { isS3Configured, uploadBuffer, getSignedUrlForKey } = require('../config/s3');
const procMail = require('../services/procMail');
const { mailEnabled, sendMail, mailConfig } = require('../services/mailer');

/**
 * Procurement — Permintaan Barang (PB) → approvals → Purchasing (PO) → Laporan Penerimaan
 * Barang (LPB). Quantities and specifications only; no prices anywhere.
 *
 * Status machine
 *   draft ──submit──▶ pending_spv (Maintenance dept) | pending_om (everyone else)
 *   pending_spv ──approve──▶ pending_om
 *   pending_om ──approve──▶ pending_director (Packaging category or Production dept) | approved
 *   pending_director ──approve──▶ approved
 *   approved ──purchase (PO + supplier)──▶ purchasing
 *   purchasing / partially_received ──LPB──▶ partially_received | completed
 *   any pending_* ──reject──▶ rejected ──submit──▶ (back to the first stage)
 *   draft / pending_* / approved ──cancel──▶ cancelled
 *
 * Approval stages per category live in proc_approval_stages (role per stage); afterwards
 * Purchasing and Warehouse act by role (POST_APPROVAL_ROLES). Admin,
 * Super Admin and anyone with Delete on this module ("procurement admin") may act anywhere.
 */

const CATEGORIES = ['Sparepart', 'Packaging', 'General'];
// Standard units of measure offered on PB / LPB lines and the general item master. Free text is
// still accepted ("Other…") so an unusual unit never blocks a request.
const UNITS = ['Pcs', 'Unit', 'Set', 'Pair', 'Box', 'Pack', 'Roll', 'Meter', 'Kg', 'Liter', 'Lot', 'Rim', 'Lembar', 'Dus', 'Lonjor', 'Batang', 'Galon', 'Botol', 'Kaleng', 'Sak', 'Drum', 'Tube', 'Bag', 'Jerigen', 'Service'];
function canWriteProc(req) {
  if (isProcAdmin(req)) return true;
  const p = req.user && req.user.permissions && req.user.permissions.procurement;
  return !!(p && p.write);
}
const CATEGORY_LABELS = { Sparepart: 'Sparepart', Packaging: 'Packaging', General: 'General & IT' };
const STATUSES = ['draft', 'pending', 'approved', 'purchasing', 'partially_received', 'completed', 'rejected', 'cancelled'];
const PENDING = ['pending'];

// After the configurable approval stages, who acts is still fixed by role.
const POST_APPROVAL_ROLES = {
  approved: ['purchasing'],
  purchasing: ['warehouse'],
  partially_received: ['warehouse'],
};
const STAGE_LABELS = {
  approved: 'Purchasing (issue PO)',
  purchasing: 'Warehouse (goods receipt)',
  partially_received: 'Warehouse (remaining goods)',
};

// Approval chain per category comes from proc_approval_stages (editable in Procurement →
// Approval Settings). Cached briefly; PUT /settings/approvals refreshes it.
// Two kinds of chain live in proc_approval_stages:
//   group_code = ''      the per-category chain (fallback for departments without a group)
//   group_code = 'SCM'…  the per-department-group chain (client's approval matrix)
// A stage is satisfied by a role (role_key) and/or named approvers (approver_user_ids).
let stageCache = { at: 0, data: null };
async function approvalStages(force = false) {
  if (!force && stageCache.data && Date.now() - stageCache.at < 30000) return stageCache.data;
  const r = await pool.query('SELECT category, group_code, stage_no, role_key, label, approver_user_ids, approver_hint FROM proc_approval_stages ORDER BY category, group_code, stage_no');
  const byCat = {}; const byGroup = {};
  for (const row of r.rows) {
    const st = { ...row, stage_no: Number(row.stage_no), approver_user_ids: (row.approver_user_ids || []).map(Number) };
    if (row.group_code) (byGroup[row.group_code] = byGroup[row.group_code] || []).push(st);
    else (byCat[row.category] = byCat[row.category] || []).push(st);
  }
  const g = await pool.query('SELECT code, name, sort_no FROM proc_approval_groups ORDER BY sort_no, name');
  const d = await pool.query('SELECT name, group_code FROM proc_departments');
  const deptGroup = {};
  for (const x of d.rows) if (x.group_code) deptGroup[x.name] = x.group_code;
  const data = { byCat, byGroup, groups: g.rows, deptGroup };
  stageCache = { at: Date.now(), data };
  return data;
}
/** The chain a request follows: its department's group chain when one is configured, else its category chain. */
function chainFor(req, row) {
  const all = req.procAll || {};
  const g = all.deptGroup && row && all.deptGroup[row.department];
  const gl = g && all.byGroup && all.byGroup[g];
  if (gl && gl.length) return gl;
  return (all.byCat && row && all.byCat[row.category]) || [];
}
function groupName(req, code) {
  const g = ((req.procAll && req.procAll.groups) || []).find((x) => x.code === code);
  return g ? g.name : code;
}
function stageOf(req, row) {
  return chainFor(req, row).find((x) => x.stage_no === Number(row.stage_no)) || null;
}
/** Who may act on a row: roles and/or named users. */
function actorsFor(req, row) {
  if (row.status === 'pending') {
    const st = stageOf(req, row);
    return st ? { roles: st.role_key ? [st.role_key] : [], users: st.approver_user_ids || [] } : { roles: [], users: [] };
  }
  return { roles: POST_APPROVAL_ROLES[row.status] || [], users: [] };
}
function rolesFor(req, row) { return actorsFor(req, row).roles; }
function stageLabelFor(req, row) {
  if (row.status === 'pending') { const st = stageOf(req, row); return st ? `${st.label} approval` : 'Approval'; }
  return STAGE_LABELS[row.status] || null;
}
async function actorUsers(client, { roles, users }) {
  if (!roles.length && !users.length) return [];
  const r = await client.query(
    `SELECT u.id, u.name, u.phone, u.email, COALESCE(r.name, u.role) AS role_name
     FROM users u LEFT JOIN roles r ON r.id = u.role_id
     WHERE u.is_active = true AND u.deleted_at IS NULL AND (r.key = ANY($1::text[]) OR u.id = ANY($2::int[]))
     ORDER BY u.name`,
    [roles, users]);
  return r.rows;
}
/** What the email module needs from this router, bound to the caller's stage config. */
function mailHelpers(req) {
  return {
    actors: (row) => actorUsers(pool, actorsFor(req, row)),
    stageLabel: (row) => stageLabelFor(req, row),
    chain: (row) => chainFor(req, row),
    purchasing: () => actorUsers(pool, { roles: POST_APPROVAL_ROLES.approved, users: [] }),
  };
}
async function activeDepartments() {
  const r = await pool.query('SELECT id, code, name, head_pic, cost_center, default_category, group_code FROM proc_departments WHERE is_active = true ORDER BY name');
  return r.rows;
}

// Full module access, or the "Approvals only" module which opens just the approval screens.
const APPROVER_ONLY_ROUTES = [
  ['GET', /^\/me$/], ['GET', /^\/requests$/], ['GET', /^\/requests\/\d+$/], ['POST', /^\/requests\/\d+\/(approve|reject|note|remind)$/],
  ['GET', /^\/approvers$/], ['GET', /^\/reminders$/], ['GET', /^\/uploads\//], ['GET', /^\/departments$/],
];
router.use(authenticateToken, (req, res, next) => {
  if (hasPermission(req.user, 'procurement', 'read')) return requireModule('procurement', 'Procurement')(req, res, next);
  if (hasPermission(req.user, 'proc_approvals', 'read')) {
    const p = req.path.replace(/\/+$/, '') || '/';
    if (APPROVER_ONLY_ROUTES.some(([m, re]) => m === req.method && re.test(p))) { req.approverOnly = true; return next(); }
    return res.status(403).json({ success: false, message: 'Your role can only approve or reject purchase requests.' });
  }
  return res.status(403).json({ success: false, message: 'Your role is not allowed to view Procurement.' });
});
router.use(async (req, res, next) => {
  try { req.procAll = await approvalStages(); req.procStages = req.procAll.byCat; next(); } catch (err) { next(err); }
});

// ─── helpers ────────────────────────────────────────────────────────────────
function actorName(req) {
  return (req.user && (req.user.name || req.user.employeeId)) || null;
}
function roleKey(req) {
  return String((req.user && req.user.roleKey) || '').toLowerCase();
}
function isProcAdmin(req) {
  const k = roleKey(req);
  if (k === 'super_admin' || k === 'admin') return true;
  const p = req.user && req.user.permissions && req.user.permissions.procurement;
  return !!(p && p.delete);
}
function canActAt(req, row) {
  if (isProcAdmin(req)) return true;
  const a = actorsFor(req, row);
  return a.roles.includes(roleKey(req)) || a.users.includes(Number(req.user.id));
}
// The user's approval steps, as { category, stage_no, label } for pending stages plus the
// post-approval statuses their role owns — drives the "waiting for me" queue and /me.
function myStages(req) {
  const k = roleKey(req);
  const uid = Number(req.user.id);
  const admin = isProcAdmin(req);
  const all = req.procAll || { byCat: {}, byGroup: {} };
  const matches = (st) => admin || (st.role_key && st.role_key === k) || (st.approver_user_ids || []).includes(uid);
  const out = [];
  for (const [code, list] of Object.entries(all.byGroup || {})) {
    for (const st of list) if (matches(st)) out.push({ status: 'pending', group_code: code, stage_no: st.stage_no, label: `${st.label} approval (${groupName(req, code)})` });
  }
  for (const [category, list] of Object.entries(all.byCat || {})) {
    for (const st of list) if (matches(st)) out.push({ status: 'pending', category, stage_no: st.stage_no, label: `${st.label} approval (${CATEGORY_LABELS[category] || category})` });
  }
  if (!req.approverOnly) for (const [status, roles] of Object.entries(POST_APPROVAL_ROLES)) if (admin || roles.includes(k)) out.push({ status, label: STAGE_LABELS[status] });
  return out;
}
/** Department names that follow a group chain (so the category chain no longer applies to them). */
function groupedDepartments(req, code) {
  const all = req.procAll || { deptGroup: {}, byGroup: {} };
  return Object.entries(all.deptGroup || {}).filter(([, g]) => (code ? g === code : true) && (all.byGroup[g] || []).length).map(([name]) => name);
}
// SQL fragment selecting the requests waiting on this user; pushes params as needed.
function queueCondition(req, params) {
  if (isProcAdmin(req) && !req.approverOnly) return `r.status IN ('pending','approved','purchasing','partially_received')`;
  const parts = [];
  const grouped = groupedDepartments(req);
  for (const st of myStages(req)) {
    if (st.status === 'pending' && st.group_code) {
      params.push(st.stage_no, groupedDepartments(req, st.group_code));
      parts.push(`(r.status = 'pending' AND r.stage_no = $${params.length - 1} AND r.department = ANY($${params.length}::text[]))`);
    } else if (st.status === 'pending') {
      params.push(st.category, st.stage_no, grouped);
      parts.push(`(r.status = 'pending' AND r.category = $${params.length - 2} AND r.stage_no = $${params.length - 1} AND NOT (r.department = ANY($${params.length}::text[])))`);
    } else { params.push(st.status); parts.push(`r.status = $${params.length}`); }
  }
  return parts.length ? `(${parts.join(' OR ')})` : 'false';
}
function isOwner(req, row) {
  return row.requested_by_id != null && Number(row.requested_by_id) === Number(req.user.id);
}
// First / next step of the configured chain. A category with no stages goes straight to Purchasing.
function firstStep(req, row) {
  const list = chainFor(req, row);
  return list.length ? { status: 'pending', stage_no: list[0].stage_no } : { status: 'approved', stage_no: null };
}
function nextStep(req, row) {
  const list = chainFor(req, row);
  const idx = list.findIndex((x) => x.stage_no === Number(row.stage_no));
  const nxt = idx >= 0 ? list[idx + 1] : null;
  return nxt ? { status: 'pending', stage_no: nxt.stage_no } : { status: 'approved', stage_no: null };
}
function stepLabel(req, row, step) {
  return stageLabelFor(req, { ...row, status: step.status, stage_no: step.stage_no });
}
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
function docNumber(kind, seq, date) {
  const d = date ? new Date(date) : new Date();
  const roman = ROMAN[d.getMonth()];
  const yy = String(d.getFullYear()).slice(-2);
  const n = String(seq).padStart(3, '0');
  // PB numbers follow the client's register: 001/PB/NB/GRI/<month>/<yy>, restarting every month
  // (the imported history uses the same form, so the sequence continues seamlessly).
  return kind === 'PR' ? `${n}/PB/NB/GRI/${roman}/${yy}` : `LPB ${n}/GRI/${roman}/${yy}`;
}
async function nextSeq(client, table, dateCol, date) {
  const r = await client.query(
    `SELECT COUNT(*)::int AS n FROM ${table} WHERE date_trunc('year', ${dateCol}) = date_trunc('year', $1::date)`,
    [date],
  );
  return r.rows[0].n + 1;
}
// Next PB sequence for the month of `date`: highest number already used in that month + 1.
async function nextPrSeq(client, date) {
  const d = new Date(date);
  const r = await client.query(
    `SELECT COALESCE(MAX((regexp_match(pr_no, '(\\d{3})/PB/NB/GRI/'))[1]::int), 0) AS n FROM proc_requests WHERE pr_no LIKE $1`,
    [`%/PB/NB/GRI/${ROMAN[d.getMonth()]}/${String(d.getFullYear()).slice(-2)}%`],
  );
  return r.rows[0].n + 1;
}
function parseDate(v) {
  if (!v) return null;
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
async function logHistory(client, { requestId, action, from, to, note, req }) {
  await client.query(
    `INSERT INTO proc_request_history (request_id, action, from_status, to_status, note, actor, actor_role)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [requestId, action, from || null, to || null, note || null, actorName(req), (req.user && req.user.roleName) || roleKey(req) || null],
  );
}

// Item sample images: S3 key when configured, else a local-disk URL (same convention as QC Lab).
const IMAGE_DIR = path.join(__dirname, '..', '..', 'uploads', 'procurement');
fs.mkdirSync(IMAGE_DIR, { recursive: true });
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype || '')),
});
async function resolveImageUrl(value) {
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (isS3Configured()) {
    try { return await getSignedUrlForKey(value); } catch (err) { console.error('Procurement image sign failed', value, err.message); }
  }
  return value;
}

const REQUEST_COLS = `r.*, s.name AS supplier_master_name,
  (SELECT COUNT(*)::int FROM proc_request_items i WHERE i.request_id = r.id) AS item_count,
  (SELECT COALESCE(SUM(i.qty), 0) FROM proc_request_items i WHERE i.request_id = r.id) AS total_qty,
  (SELECT COALESCE(SUM(i.received_qty), 0) FROM proc_request_items i WHERE i.request_id = r.id) AS total_received,
  (SELECT i.description FROM proc_request_items i WHERE i.request_id = r.id ORDER BY i.line_no LIMIT 1) AS first_item,
  (SELECT COUNT(*)::int FROM proc_receipts g WHERE g.request_id = r.id) AS receipt_count`;

async function loadRequest(client, id) {
  const r = await client.query(
    `SELECT ${REQUEST_COLS} FROM proc_requests r LEFT JOIN proc_suppliers s ON s.id = r.supplier_id WHERE r.id = $1`,
    [id],
  );
  return r.rows[0] || null;
}

function decorate(req, row) {
  const owner = isOwner(req, row);
  const admin = isProcAdmin(req);
  const actStage = canActAt(req, row);
  const stage = row.status === 'pending' ? stageOf(req, row) : null;
  return {
    ...row,
    total_qty: Number(row.total_qty || 0),
    total_received: Number(row.total_received || 0),
    stage_label: stageLabelFor(req, row),
    stage_short: stage ? stage.label : null,
    category_label: CATEGORY_LABELS[row.category] || row.category,
    can: {
      // Requester only while it is theirs to fix; once approved, only Purchasing (or an admin) may correct it, and only until a PO is recorded.
      edit: ((row.status === 'draft' || row.status === 'rejected') && (owner || admin)) || (row.status === 'approved' && (admin || POST_APPROVAL_ROLES.approved.includes(roleKey(req)))),
      submit: (row.status === 'draft' || row.status === 'rejected') && (owner || admin),
      approve: PENDING.includes(row.status) && actStage,
      reject: PENDING.includes(row.status) && actStage,
      purchase: row.status === 'approved' && actStage,
      receive: ['purchasing', 'partially_received'].includes(row.status) && actStage,
      // Purchasing records or corrects the PO number while goods are still on the way
      set_po: ['purchasing', 'partially_received'].includes(row.status) && (admin || POST_APPROVAL_ROLES.approved.includes(roleKey(req))),
      cancel: ['draft', ...PENDING, 'approved'].includes(row.status) && (owner || admin),
      remind: PENDING.includes(row.status) || row.status === 'approved',
      delete: row.status === 'draft' ? (owner || admin) : admin,
    },
  };
}

// ─── who am I in this module ────────────────────────────────────────────────
router.get('/me', async (req, res) => {
  try {
    const departments = await activeDepartments();
    const mine = myStages(req);
    res.json({
      success: true,
      data: {
        role: roleKey(req),
        role_name: req.user.roleName || null,
        is_admin: isProcAdmin(req),
        stages: mine.map((x) => x.label),
        my_stages: mine,
        approval_stages: req.procStages,
        approval_groups: req.procAll.groups,
        group_stages: req.procAll.byGroup,
        approver_only: !!req.approverOnly,
        mail_enabled: mailEnabled(),
        stage_labels: STAGE_LABELS,
        departments,
        department_names: departments.map((d) => d.name),
        categories: CATEGORIES,
        category_labels: CATEGORY_LABELS,
        statuses: STATUSES,
        units: UNITS,
      },
    });
  } catch (err) {
    console.error('Procurement me error:', err.message);
    fail(res, err, 'Failed to load procurement profile');
  }
});

// ─── approval settings, departments, machines, roles ────────────────────────
function requireProcAdmin(req, res) {
  if (isProcAdmin(req)) return true;
  res.status(403).json({ success: false, message: 'Only a procurement admin can change this.' });
  return false;
}

router.get('/settings/approvals', async (req, res) => {
  try {
    const roles = await pool.query('SELECT key, name FROM roles ORDER BY name');
    const all = await approvalStages(true);
    const depts = await pool.query('SELECT name, group_code FROM proc_departments WHERE is_active = true ORDER BY name');
    const users = await pool.query(`SELECT u.id, u.name, COALESCE(r.name, u.role) AS role_name FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.is_active = true AND u.deleted_at IS NULL ORDER BY u.name`);
    const groups = all.groups.map((g) => ({ ...g, departments: depts.rows.filter((d) => d.group_code === g.code).map((d) => d.name), stages: all.byGroup[g.code] || [] }));
    res.json({ success: true, data: { stages: all.byCat, groups, ungrouped_departments: depts.rows.filter((d) => !d.group_code).map((d) => d.name), users: users.rows, categories: CATEGORIES, category_labels: CATEGORY_LABELS, roles: roles.rows, post_approval: Object.entries(POST_APPROVAL_ROLES).map(([status, r]) => ({ status, role_keys: r, label: STAGE_LABELS[status] })) } });
  } catch (err) {
    console.error('Procurement approval settings error:', err.message);
    fail(res, err, 'Failed to load approval settings');
  }
});

// Email notifications: configured from the server environment; this only reports and tests it.
router.get('/settings/mail', async (req, res) => {
  try {
    const c = mailConfig();
    const all = await approvalStages();
    const ids = new Set(); const roles = new Set();
    for (const list of [...Object.values(all.byCat), ...Object.values(all.byGroup)]) for (const st of list) { (st.approver_user_ids || []).forEach((i) => ids.add(Number(i))); if (st.role_key) roles.add(st.role_key); }
    const users = await actorUsers(pool, { roles: [...roles, ...POST_APPROVAL_ROLES.approved], users: [...ids] });
    res.json({ success: true, data: { enabled: mailEnabled(), from: c.from || null, app_url: c.appUrl || null, my_email: req.user.email || null,
      approvers_without_email: users.filter((u) => !u.email).map((u) => u.name) } });
  } catch (err) { fail(res, err, 'Failed to load mail settings'); }
});
router.post('/settings/mail/test', async (req, res) => {
  try {
    if (!mailEnabled()) return res.status(400).json({ success: false, message: 'Email is not configured on this server (SMTP_HOST, MAIL_FROM, APP_URL).' });
    if (!req.user.email) return res.status(400).json({ success: false, message: 'Your account has no email address. Add one under User Management first.' });
    const c = mailConfig();
    const r = await sendMail({ to: req.user.email, subject: 'Greencore Procurement — test email',
      html: procMail.page({ appUrl: c.appUrl, lang: 'en', title: 'Email works', eyebrow: 'Test message', chip: { text: 'OK', bg: procMail.C.okBg, fg: procMail.C.ok }, inner: procMail.resultBody('Approval emails will arrive like this.', `Sent to ${procMail.esc(req.user.email)} from ${procMail.esc(c.from)}.`) }).html,
      text: `Greencore Procurement test email. Sent to ${req.user.email}.` });
    if (!r.ok) return res.status(502).json({ success: false, message: r.reason || 'Send failed' });
    res.json({ success: true });
  } catch (err) { fail(res, err, 'Failed to send test email'); }
});

// Body: { stages: { Sparepart: [{ role_key, label }, ...], Packaging: [...], General: [...] } }
// Stage order is the array order. Requests already waiting at a stage keep their stage number.
router.put('/settings/approvals', async (req, res) => {
  if (!requireProcAdmin(req, res)) return;
  const client = await pool.connect();
  try {
    const body = (req.body && req.body.stages) || null;
    const groupsBody = (req.body && req.body.groups) || null;
    const roles = await client.query('SELECT key FROM roles');
    const roleKeys = new Set(roles.rows.map((r) => r.key));
    const users = await client.query('SELECT id FROM users WHERE is_active = true AND deleted_at IS NULL');
    const userIds = new Set(users.rows.map((u) => Number(u.id)));
    const groupRows = await client.query('SELECT code FROM proc_approval_groups');
    const groupCodes = new Set(groupRows.rows.map((g) => g.code));
    const clean = (list, who) => {
      if (list.length > 6) throw Object.assign(new Error(`${who}: at most 6 approval stages.`), { status: 400 });
      return list.map((st) => {
        const label = String(st.label || '').trim().slice(0, 80);
        const roleK = st.role_key ? String(st.role_key) : null;
        const ids = [...new Set((Array.isArray(st.approver_user_ids) ? st.approver_user_ids : []).map(Number).filter((n) => userIds.has(n)))];
        if (!label) throw Object.assign(new Error(`${who}: every stage needs a label.`), { status: 400 });
        if (roleK && !roleKeys.has(roleK)) throw Object.assign(new Error(`${who}: role "${roleK}" does not exist.`), { status: 400 });
        if (!roleK && !ids.length) throw Object.assign(new Error(`${who}: pick at least one approver (a user or a role) for "${label}".`), { status: 400 });
        return { label, role_key: roleK, ids, hint: String(st.approver_hint || '').trim().slice(0, 160) || null };
      });
    };
    const catLists = body ? Object.fromEntries(CATEGORIES.map((cat) => [cat, clean(Array.isArray(body[cat]) ? body[cat] : [], CATEGORY_LABELS[cat])])) : null;
    const groupLists = groupsBody ? Object.fromEntries(Object.entries(groupsBody).filter(([code]) => groupCodes.has(code)).map(([code, list]) => [code, clean(Array.isArray(list) ? list : [], code)])) : null;
    await client.query('BEGIN');
    if (catLists) {
      await client.query(`DELETE FROM proc_approval_stages WHERE group_code = ''`);
      for (const cat of CATEGORIES) {
        const list = catLists[cat];
        for (let i = 0; i < list.length; i += 1) {
          await client.query(
            `INSERT INTO proc_approval_stages (category, group_code, stage_no, role_key, label, approver_user_ids, approver_hint, "updatedBy") VALUES ($1, '', $2, $3, $4, $5::int[], $6, $7)`,
            [cat, i + 1, list[i].role_key, list[i].label, list[i].ids, list[i].hint, actorName(req)]);
        }
      }
    }
    if (groupLists) {
      for (const [code, list] of Object.entries(groupLists)) {
        await client.query('DELETE FROM proc_approval_stages WHERE group_code = $1', [code]);
        for (let i = 0; i < list.length; i += 1) {
          await client.query(
            `INSERT INTO proc_approval_stages (category, group_code, stage_no, role_key, label, approver_user_ids, approver_hint, "updatedBy") VALUES ('*', $1, $2, $3, $4, $5::int[], $6, $7)`,
            [code, i + 1, list[i].role_key, list[i].label, list[i].ids, list[i].hint, actorName(req)]);
        }
      }
    }
    await client.query('COMMIT');
    const all = await approvalStages(true);
    res.json({ success: true, data: { stages: all.byCat, group_stages: all.byGroup } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.status) return res.status(err.status).json({ success: false, message: err.message });
    console.error('Procurement approval settings save error:', err.message);
    fail(res, err, 'Failed to save approval settings');
  } finally { client.release(); }
});

router.get('/roles', async (req, res) => {
  try {
    const r = await pool.query('SELECT id, key, name FROM roles ORDER BY name');
    res.json({ success: true, data: r.rows });
  } catch (err) { fail(res, err, 'Failed to load roles'); }
});

router.get('/departments', async (req, res) => {
  try {
    const all = req.query.all === '1';
    const r = await pool.query(
      `SELECT d.*, g.name AS group_name, (SELECT COUNT(*)::int FROM proc_requests r WHERE r.department = d.name) AS request_count
       FROM proc_departments d LEFT JOIN proc_approval_groups g ON g.code = d.group_code ${all ? '' : 'WHERE d.is_active = true'} ORDER BY d.name`);
    res.json({ success: true, data: r.rows });
  } catch (err) { fail(res, err, 'Failed to load departments'); }
});
function departmentBody(b) {
  return {
    code: String((b && b.code) || '').trim().toUpperCase().slice(0, 30),
    name: String((b && b.name) || '').trim().slice(0, 80),
    head_pic: String((b && b.head_pic) || '').trim().slice(0, 120) || null,
    cost_center: String((b && b.cost_center) || '').trim().toUpperCase().slice(0, 40) || null,
    default_category: CATEGORIES.includes(b && b.default_category) ? b.default_category : 'General',
    group_code: String((b && b.group_code) || '').trim().toUpperCase().slice(0, 20) || null,
    is_active: b && b.is_active === false ? false : true,
  };
}
async function validGroup(code) {
  if (!code) return true;
  const r = await pool.query('SELECT 1 FROM proc_approval_groups WHERE code = $1', [code]);
  return r.rows.length > 0;
}
router.post('/departments', async (req, res) => {
  if (!requireProcAdmin(req, res)) return;
  try {
    const d = departmentBody(req.body);
    if (!d.code || !d.name) return res.status(400).json({ success: false, message: 'Code and name are required.' });
    if (!(await validGroup(d.group_code))) return res.status(400).json({ success: false, message: 'Unknown approval group.' });
    const r = await pool.query(
      `INSERT INTO proc_departments (code, name, head_pic, cost_center, default_category, is_active, group_code, "createdBy", "updatedBy")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`,
      [d.code, d.name, d.head_pic, d.cost_center, d.default_category, d.is_active, d.group_code, actorName(req)]);
    stageCache = { at: 0, data: null };
    res.status(201).json({ success: true, data: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, message: 'A department with that code or name already exists.' });
    fail(res, err, 'Failed to create department');
  }
});
router.put('/departments/:id', async (req, res) => {
  if (!requireProcAdmin(req, res)) return;
  try {
    const d = departmentBody(req.body);
    if (!d.code || !d.name) return res.status(400).json({ success: false, message: 'Code and name are required.' });
    if (!(await validGroup(d.group_code))) return res.status(400).json({ success: false, message: 'Unknown approval group.' });
    const r = await pool.query(
      `UPDATE proc_departments SET code = $2, name = $3, head_pic = $4, cost_center = $5, default_category = $6, is_active = $7, group_code = $9, "updatedBy" = $8, "updatedAt" = NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.id, d.code, d.name, d.head_pic, d.cost_center, d.default_category, d.is_active, actorName(req), d.group_code]);
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Department not found' });
    stageCache = { at: 0, data: null };
    res.json({ success: true, data: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, message: 'A department with that code or name already exists.' });
    fail(res, err, 'Failed to update department');
  }
});

router.get('/machines', async (req, res) => {
  try {
    const all = req.query.all === '1';
    const r = await pool.query(`SELECT * FROM proc_machines ${all ? '' : 'WHERE is_active = true'} ORDER BY name`);
    res.json({ success: true, data: r.rows });
  } catch (err) { fail(res, err, 'Failed to load machines'); }
});
function machineBody(b) {
  return {
    code: String((b && b.code) || '').trim().toUpperCase().slice(0, 30),
    name: String((b && b.name) || '').trim().slice(0, 120),
    area: String((b && b.area) || '').trim().slice(0, 120) || null,
    department: String((b && b.department) || '').trim().slice(0, 80) || null,
    is_active: b && b.is_active === false ? false : true,
  };
}
router.post('/machines', async (req, res) => {
  if (!requireProcAdmin(req, res)) return;
  try {
    const m = machineBody(req.body);
    if (!m.code || !m.name) return res.status(400).json({ success: false, message: 'Code and name are required.' });
    const r = await pool.query(
      `INSERT INTO proc_machines (code, name, area, department, is_active, "createdBy", "updatedBy") VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING *`,
      [m.code, m.name, m.area, m.department, m.is_active, actorName(req)]);
    res.status(201).json({ success: true, data: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, message: 'A machine with that code already exists.' });
    fail(res, err, 'Failed to create machine');
  }
});
router.put('/machines/:id', async (req, res) => {
  if (!requireProcAdmin(req, res)) return;
  try {
    const m = machineBody(req.body);
    if (!m.code || !m.name) return res.status(400).json({ success: false, message: 'Code and name are required.' });
    const r = await pool.query(
      `UPDATE proc_machines SET code = $2, name = $3, area = $4, department = $5, is_active = $6, "updatedBy" = $7, "updatedAt" = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id, m.code, m.name, m.area, m.department, m.is_active, actorName(req)]);
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Machine not found' });
    res.json({ success: true, data: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, message: 'A machine with that code already exists.' });
    fail(res, err, 'Failed to update machine');
  }
});

// Users who can act at a stage — for reminders (name + phone for a WhatsApp link).
router.get('/approvers', async (req, res) => {
  try {
    const stage = String(req.query.stage || '');
    let probe;
    if (req.query.request_id) {
      probe = await loadRequest(pool, Number(req.query.request_id));
      if (!probe) return res.status(404).json({ success: false, message: 'Request not found' });
    } else {
      probe = stage === 'pending'
        ? { status: 'pending', category: String(req.query.category || ''), department: String(req.query.department || ''), stage_no: Number(req.query.stage_no) || 0 }
        : { status: stage };
    }
    const who = actorsFor(req, probe);
    if (!who.roles.length && !who.users.length) return res.status(400).json({ success: false, message: 'Unknown stage' });
    res.json({ success: true, data: await actorUsers(pool, who), stage: probe.status, stage_label: stageLabelFor(req, probe) });
  } catch (err) {
    console.error('Procurement approvers error:', err.message);
    fail(res, err, 'Failed to load approvers');
  }
});

// ─── item master: spare parts + packaging parts already in the system ───────
router.get('/items', async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    const source = String(req.query.source || 'all');
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 60, 1), 500);
    const sourceId = Number(req.query.source_id) || null; // one exact item (deep links from reminders)
    const like = `%${search}%`;
    const out = [];
    if (source === 'all' || source === 'spare_part') {
      const r = await pool.query(
        `SELECT i.id, i.part_no AS code, i.description, i.category AS group_name, i.unit, i.current_qty AS stock,
                i.min_stock, i.supplier, c.label AS catalog, c.key AS catalog_key, i.machine, i.location
         FROM spare_parts_items i JOIN spare_parts_catalogs c ON c.id = i.catalog_id
         WHERE ($1 = '' OR i.part_no ILIKE $2 OR i.description ILIKE $2 OR i.category ILIKE $2 OR i.machine ILIKE $2)
           AND ($4::int IS NULL OR i.id = $4)
         ORDER BY (i.min_stock IS NOT NULL AND i.current_qty <= i.min_stock) DESC, i.description
         LIMIT $3`,
        [search, like, limit, sourceId],
      );
      for (const x of r.rows) {
        out.push({
          source: 'spare_part', source_id: x.id, code: x.code, description: x.description, unit: x.unit || 'Pcs',
          stock: Number(x.stock || 0), min_stock: x.min_stock == null ? null : Number(x.min_stock),
          group: x.group_name, catalog: x.catalog, catalog_key: x.catalog_key, machine: x.machine, location: x.location,
          supplier: x.supplier, category: 'Sparepart',
          low: x.min_stock != null && Number(x.stock || 0) <= Number(x.min_stock),
        });
      }
    }
    if (source === 'all' || source === 'part') {
      const r = await pool.query(
        `SELECT p.id, p.code, p.description, p.category AS group_name, p.uom AS unit, p.size_spec, p.variant, p.supplier, p.reorder_level,
                ${poolBalanceSql('SALES', 'p.id')} AS stock,
                ${poolBalanceSql('MOVING', 'p.id')} AS moving_stock
         FROM pm_item p
         WHERE p.is_active = true
           AND ($1 = '' OR p.code ILIKE $2 OR p.description ILIKE $2 OR p.category ILIKE $2 OR p.variant ILIKE $2)
           AND ($4::int IS NULL OR p.id = $4)
         ORDER BY p.category, p.code
         LIMIT $3`,
        [search, like, limit, sourceId],
      );
      for (const x of r.rows) {
        const stock = Number(x.stock || 0);
        const min = x.reorder_level == null ? null : Number(x.reorder_level);
        out.push({
          source: 'part', source_id: x.id, code: x.code, description: x.description, unit: x.unit || 'Pcs',
          stock, moving_stock: Number(x.moving_stock || 0), min_stock: min, group: x.group_name, catalog: 'Parts Inventory', catalog_key: null,
          specification: [x.size_spec, x.variant].filter(Boolean).join(' · ') || null, supplier: x.supplier, category: 'Packaging',
          low: min != null && min > 0 && stock <= min,
        });
      }
    }
    if (source === 'all' || source === 'general') {
      const r = await pool.query(
        `SELECT g.* FROM proc_general_items g
         WHERE g.is_active = true
           AND ($1 = '' OR g.code ILIKE $2 OR g.description ILIKE $2 OR g.group_name ILIKE $2 OR g.specification ILIKE $2)
           AND ($4::int IS NULL OR g.id = $4)
         ORDER BY g.description
         LIMIT $3`,
        [search, like, limit, sourceId],
      );
      for (const x of r.rows) {
        out.push({
          source: 'general', source_id: x.id, code: x.code, description: x.description, unit: x.uom || 'Pcs',
          stock: null, min_stock: x.min_stock == null ? null : Number(x.min_stock), group: x.group_name, catalog: 'General & IT items', catalog_key: null,
          specification: x.specification, supplier: x.supplier, location: x.location, category: 'General', low: false,
        });
      }
    }
    res.json({ success: true, data: out });
  } catch (err) {
    console.error('Procurement items error:', err.message);
    fail(res, err, 'Failed to load items');
  }
});

// ─── general & IT item master ────────────────────────────────────────────────
// Items that are neither spare parts nor packaging. No stock is tracked; the master gives a PB a
// stable code, description and unit. Any procurement user may add one (a requester typing a new
// item), admins and Purchasing maintain them.
function readGeneralItem(b) {
  return {
    code: String(b.code || '').trim().toUpperCase().slice(0, 40) || null,
    description: String(b.description || '').trim().slice(0, 300),
    specification: String(b.specification || '').trim() || null,
    uom: String(b.uom || b.unit || 'Pcs').trim().slice(0, 30) || 'Pcs',
    min_stock: b.min_stock === '' || b.min_stock == null ? null : Number(b.min_stock),
    location: String(b.location || '').trim().slice(0, 80) || null,
    supplier: String(b.supplier || '').trim().slice(0, 160) || null,
    group_name: String(b.group_name || b.group || '').trim().slice(0, 80) || null,
  };
}
async function nextGeneralCode(client) {
  const r = await client.query(`SELECT COALESCE(MAX((regexp_match(code, '^GEN-(\\d+)$'))[1]::int), 0) AS n FROM proc_general_items`);
  return `GEN-${String(r.rows[0].n + 1).padStart(4, '0')}`;
}
router.get('/general-items', async (req, res) => {
  try {
    const all = req.query.all === '1';
    const r = await pool.query(`SELECT g.*, (SELECT COUNT(*)::int FROM proc_request_items i WHERE i.source = 'general' AND i.source_id = g.id) AS request_count
                                FROM proc_general_items g ${all ? '' : 'WHERE g.is_active = true'} ORDER BY g.description`);
    res.json({ success: true, data: r.rows });
  } catch (err) { console.error('General items error:', err.message); fail(res, err, 'Failed to load general items'); }
});
router.post('/general-items', async (req, res) => {
  if (!canWriteProc(req)) return res.status(403).json({ success: false, message: 'Your role cannot add items to the master.' });
  const client = await pool.connect();
  try {
    const g = readGeneralItem(req.body);
    if (!g.description) return res.status(400).json({ success: false, message: 'Description is required.' });
    await client.query('BEGIN');
    await client.query('LOCK TABLE proc_general_items IN SHARE ROW EXCLUSIVE MODE');
    if (!g.code) g.code = await nextGeneralCode(client);
    const dup = await client.query('SELECT id, code, description FROM proc_general_items WHERE UPPER(code) = $1 OR LOWER(description) = LOWER($2)', [g.code, g.description]);
    if (dup.rows.length) { await client.query('ROLLBACK'); return res.status(409).json({ success: false, message: `Already in the master as ${dup.rows[0].code} — ${dup.rows[0].description}`, existing: dup.rows[0] }); }
    const ins = await client.query(
      `INSERT INTO proc_general_items (code, description, specification, uom, min_stock, location, supplier, group_name, "createdBy", "updatedBy")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`,
      [g.code, g.description, g.specification, g.uom, g.min_stock, g.location, g.supplier, g.group_name, actorName(req)]);
    await client.query('COMMIT');
    const x = ins.rows[0];
    res.status(201).json({ success: true, data: x, item: { source: 'general', source_id: x.id, code: x.code, description: x.description, unit: x.uom, stock: null, min_stock: x.min_stock == null ? null : Number(x.min_stock), group: x.group_name, catalog: 'General & IT items', catalog_key: null, specification: x.specification, supplier: x.supplier, location: x.location, category: 'General', low: false } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('General item create error:', err.message); fail(res, err, 'Failed to add the item');
  } finally { client.release(); }
});
router.put('/general-items/:id', async (req, res) => {
  if (!(isProcAdmin(req) || POST_APPROVAL_ROLES.approved.includes(roleKey(req)))) return res.status(403).json({ success: false, message: 'Only Purchasing or an admin can change the item master.' });
  try {
    const id = Number(req.params.id);
    const cur = await pool.query('SELECT * FROM proc_general_items WHERE id = $1', [id]);
    if (!cur.rows.length) return res.status(404).json({ success: false, message: 'Item not found' });
    const g = readGeneralItem({ ...cur.rows[0], ...req.body, uom: req.body.uom || req.body.unit || cur.rows[0].uom, group_name: req.body.group_name ?? cur.rows[0].group_name });
    if (!g.description) return res.status(400).json({ success: false, message: 'Description is required.' });
    const isActive = req.body.is_active == null ? cur.rows[0].is_active : !!req.body.is_active;
    const r = await pool.query(
      `UPDATE proc_general_items SET code = $2, description = $3, specification = $4, uom = $5, min_stock = $6, location = $7, supplier = $8, group_name = $9, is_active = $10, "updatedBy" = $11, "updatedAt" = NOW()
       WHERE id = $1 RETURNING *`,
      [id, g.code || cur.rows[0].code, g.description, g.specification, g.uom, g.min_stock, g.location, g.supplier, g.group_name, isActive, actorName(req)]);
    res.json({ success: true, data: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, message: 'That code is already used by another item.' });
    console.error('General item update error:', err.message); fail(res, err, 'Failed to update the item');
  }
});

// ─── suppliers ──────────────────────────────────────────────────────────────
router.get('/suppliers', async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    const status = String(req.query.status || 'all');
    const where = [];
    const params = [];
    if (search) { params.push(`%${search}%`); where.push(`(s.name ILIKE $${params.length} OR s.code ILIKE $${params.length} OR s.contact_person ILIKE $${params.length} OR s.email ILIKE $${params.length})`); }
    if (status === 'active' || status === 'inactive') { params.push(status); where.push(`s.status = $${params.length}`); }
    const r = await pool.query(
      `SELECT s.*,
              (SELECT COUNT(*)::int FROM proc_requests r WHERE r.supplier_id = s.id) AS po_count,
              (SELECT MAX(r.po_at) FROM proc_requests r WHERE r.supplier_id = s.id) AS last_po_at
       FROM proc_suppliers s ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY s.status, s.name`,
      params,
    );
    // Names typed on existing spare parts / packaging parts that are not in the master yet.
    const sugg = await pool.query(
      `SELECT name, SUM(n)::int AS n FROM (
         SELECT TRIM(supplier) AS name, COUNT(*) AS n FROM spare_parts_items WHERE supplier IS NOT NULL AND TRIM(supplier) <> '' GROUP BY 1
         UNION ALL
         SELECT TRIM(supplier) AS name, COUNT(*) AS n FROM pm_item WHERE supplier IS NOT NULL AND TRIM(supplier) <> '' GROUP BY 1
       ) x
       WHERE LOWER(name) NOT IN (SELECT LOWER(name) FROM proc_suppliers)
       GROUP BY name ORDER BY n DESC, name LIMIT 50`,
    );
    res.json({ success: true, data: r.rows, suggestions: sugg.rows });
  } catch (err) {
    console.error('Procurement suppliers error:', err.message);
    fail(res, err, 'Failed to load suppliers');
  }
});

async function nextSupplierCode(client) {
  const r = await client.query(`SELECT COUNT(*)::int AS n FROM proc_suppliers`);
  let n = r.rows[0].n + 1;
  for (let tries = 0; tries < 50; tries += 1, n += 1) {
    const code = `SUP-${String(n).padStart(3, '0')}`;
    const dup = await client.query('SELECT 1 FROM proc_suppliers WHERE code = $1', [code]);
    if (dup.rows.length === 0) return code;
  }
  return `SUP-${Date.now()}`;
}

function supplierBody(body) {
  const b = body || {};
  const cats = Array.isArray(b.categories) ? b.categories.filter((c) => CATEGORIES.includes(c)) : [];
  return {
    name: String(b.name || '').trim(), contact_person: b.contact_person || null, phone: b.phone || null, email: b.email || null,
    address: b.address || null, categories: cats, status: b.status === 'inactive' ? 'inactive' : 'active', notes: b.notes || null,
  };
}

router.post('/suppliers', async (req, res) => {
  const client = await pool.connect();
  try {
    const b = supplierBody(req.body);
    if (!b.name) return res.status(400).json({ success: false, message: 'Supplier name is required' });
    const dup = await client.query('SELECT id FROM proc_suppliers WHERE LOWER(name) = LOWER($1)', [b.name]);
    if (dup.rows.length) return res.status(409).json({ success: false, message: `"${b.name}" is already in the supplier master.` });
    const code = String(req.body.code || '').trim() || await nextSupplierCode(client);
    const r = await client.query(
      `INSERT INTO proc_suppliers (code, name, contact_person, phone, email, address, categories, status, notes, "createdBy", "updatedBy")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING *`,
      [code, b.name, b.contact_person, b.phone, b.email, b.address, b.categories, b.status, b.notes, actorName(req)],
    );
    res.status(201).json({ success: true, data: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, message: 'That supplier code is already used.' });
    console.error('Supplier create error:', err.message);
    fail(res, err, 'Failed to create supplier');
  } finally { client.release(); }
});

// Bring supplier names already typed on parts into the master in one go.
router.post('/suppliers/import', async (req, res) => {
  const client = await pool.connect();
  try {
    const names = Array.isArray(req.body && req.body.names) ? req.body.names.map((n) => String(n).trim()).filter(Boolean) : [];
    if (!names.length) return res.status(400).json({ success: false, message: 'names[] is required' });
    await client.query('BEGIN');
    let created = 0;
    for (const name of names) {
      const dup = await client.query('SELECT id FROM proc_suppliers WHERE LOWER(name) = LOWER($1)', [name]);
      if (dup.rows.length) continue;
      const cats = [];
      const sp = await client.query('SELECT 1 FROM spare_parts_items WHERE LOWER(TRIM(supplier)) = LOWER($1) LIMIT 1', [name]);
      if (sp.rows.length) cats.push('Sparepart');
      const pm = await client.query('SELECT 1 FROM pm_item WHERE LOWER(TRIM(supplier)) = LOWER($1) LIMIT 1', [name]);
      if (pm.rows.length) cats.push('Packaging');
      const code = await nextSupplierCode(client);
      await client.query(
        `INSERT INTO proc_suppliers (code, name, categories, notes, "createdBy", "updatedBy") VALUES ($1,$2,$3,$4,$5,$5)`,
        [code, name, cats, 'Imported from existing part records', actorName(req)],
      );
      created += 1;
    }
    await client.query('COMMIT');
    res.json({ success: true, created });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Supplier import error:', err.message);
    fail(res, err, 'Failed to import suppliers');
  } finally { client.release(); }
});

router.put('/suppliers/:id', async (req, res) => {
  try {
    const b = supplierBody(req.body);
    if (!b.name) return res.status(400).json({ success: false, message: 'Supplier name is required' });
    const dup = await pool.query('SELECT id FROM proc_suppliers WHERE LOWER(name) = LOWER($1) AND id <> $2', [b.name, req.params.id]);
    if (dup.rows.length) return res.status(409).json({ success: false, message: `"${b.name}" is already in the supplier master.` });
    const r = await pool.query(
      `UPDATE proc_suppliers SET name=$2, contact_person=$3, phone=$4, email=$5, address=$6, categories=$7, status=$8, notes=$9, "updatedBy"=$10, "updatedAt"=NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.id, b.name, b.contact_person, b.phone, b.email, b.address, b.categories, b.status, b.notes, actorName(req)],
    );
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Supplier not found' });
    res.json({ success: true, data: r.rows[0] });
  } catch (err) {
    console.error('Supplier update error:', err.message);
    fail(res, err, 'Failed to update supplier');
  }
});

router.delete('/suppliers/:id', async (req, res) => {
  try {
    const used = await pool.query('SELECT COUNT(*)::int AS n FROM proc_requests WHERE supplier_id = $1', [req.params.id]);
    if (used.rows[0].n > 0) {
      return res.status(409).json({ success: false, message: `This supplier is on ${used.rows[0].n} purchase order(s). Mark it inactive instead of deleting it.` });
    }
    const r = await pool.query('DELETE FROM proc_suppliers WHERE id = $1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Supplier not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Supplier delete error:', err.message);
    fail(res, err, 'Failed to delete supplier');
  }
});

// ─── image upload for a request line ────────────────────────────────────────
router.post('/uploads', imageUpload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'Attach an image file (jpg, png, webp).' });
    const ext = path.extname(req.file.originalname || '').toLowerCase() || '.jpg';
    const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
    if (isS3Configured()) {
      const key = `procurement/${filename}`;
      const url = await uploadBuffer(req.file.buffer, key, req.file.mimetype);
      return res.json({ success: true, data: { key, url, name: req.file.originalname } });
    }
    fs.writeFileSync(path.join(IMAGE_DIR, filename), req.file.buffer);
    const url = `${req.protocol}://${req.get('host')}/uploads/procurement/${filename}`;
    res.json({ success: true, data: { key: url, url, name: req.file.originalname } });
  } catch (err) {
    console.error('Procurement upload error:', err.message);
    fail(res, err, 'Failed to upload image');
  }
});

// ─── requests (PB) ──────────────────────────────────────────────────────────
function validateItems(items) {
  if (!Array.isArray(items) || items.length === 0) return { error: 'Add at least one item.' };
  const out = [];
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i] || {};
    const desc = String(it.description || '').trim();
    if (!desc) return { error: `Line ${i + 1}: description is required.` };
    const qty = Number(it.qty);
    if (!Number.isFinite(qty) || qty <= 0) return { error: `Line ${i + 1} (${desc}): quantity must be greater than 0.` };
    const source = ['spare_part', 'part', 'general', 'custom'].includes(it.source) ? it.source : 'custom';
    out.push({
      source, source_id: source === 'custom' ? null : (Number(it.source_id) || null),
      item_code: it.item_code ? String(it.item_code).trim() : null, description: desc,
      specification: it.specification ? String(it.specification).trim() : null,
      qty, unit: String(it.unit || 'Pcs').trim() || 'Pcs',
      min_stock: it.min_stock === '' || it.min_stock == null ? null : Number(it.min_stock),
      stock_at_request: it.stock_at_request == null || it.stock_at_request === '' ? null : Number(it.stock_at_request),
      image_key: it.image_key || null, image_name: it.image_name || null,
    });
  }
  return { items: out };
}

function requestBody(body, departmentNames) {
  const b = body || {};
  const department = departmentNames.includes(b.department) ? b.department : null;
  const category = CATEGORIES.includes(b.category) ? b.category : null;
  const priority = b.priority === 'Urgent' ? 'Urgent' : 'Normal';
  const budget = b.budget_type === 'CAPEX' ? 'CAPEX' : 'OPEX';
  return {
    department, category, priority, budget_type: budget,
    urgent_reason: priority === 'Urgent' ? String(b.urgent_reason || '').trim() : null,
    required_date: parseDate(b.required_date), notes: b.notes ? String(b.notes).trim() : null,
    pr_date: parseDate(b.pr_date),
  };
}

async function writeItems(client, requestId, items) {
  await client.query('DELETE FROM proc_request_items WHERE request_id = $1', [requestId]);
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    await client.query(
      `INSERT INTO proc_request_items (request_id, line_no, source, source_id, item_code, description, specification, qty, unit, min_stock, stock_at_request, image_key, image_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [requestId, i + 1, it.source, it.source_id, it.item_code, it.description, it.specification, it.qty, it.unit, it.min_stock, it.stock_at_request, it.image_key, it.image_name],
    );
  }
}

router.get('/requests', async (req, res) => {
  try {
    const { search, status, category, priority, department, from, to, mine, queue, budget_type } = req.query;
    // Column sort from the list headers; default keeps urgent open requests on top, newest first.
    const SORTS = { pr_no: 'r.pr_no', pr_date: 'r.pr_date', department: 'r.department', requested_by: 'r.requested_by', category: 'r.category',
      status: 'r.status', priority: 'r.priority', required_date: 'r.required_date', updated_at: 'r."updatedAt"', budget_type: 'r.budget_type' };
    const sortCol = SORTS[String(req.query.sort || '')];
    const sortDir = String(req.query.order || '').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 500);
    const where = [];
    const params = [];
    if (search && String(search).trim()) {
      params.push(`%${String(search).trim()}%`);
      where.push(`(r.pr_no ILIKE $${params.length} OR r.requested_by ILIKE $${params.length} OR r.po_no ILIKE $${params.length} OR r.supplier_name ILIKE $${params.length}
        OR EXISTS (SELECT 1 FROM proc_request_items i WHERE i.request_id = r.id AND (i.description ILIKE $${params.length} OR i.item_code ILIKE $${params.length})))`);
    }
    if (status && status !== 'all') {
      if (status === 'pending') where.push(`r.status = 'pending'`);
      else if (status === 'open') where.push(`r.status NOT IN ('completed','rejected','cancelled')`);
      else if (status === 'in_purchase') where.push(`r.status IN ('approved','purchasing','partially_received')`);
      else if (STATUSES.includes(status)) { params.push(status); where.push(`r.status = $${params.length}`); }
    }
    if (category && category !== 'all') { params.push(category); where.push(`r.category = $${params.length}`); }
    if (priority && priority !== 'all') { params.push(priority); where.push(`r.priority = $${params.length}`); }
    if (budget_type && budget_type !== 'all') { params.push(budget_type); where.push(`r.budget_type = $${params.length}`); }
    if (department && department !== 'all') { params.push(department); where.push(`r.department = $${params.length}`); }
    if (parseDate(from)) { params.push(parseDate(from)); where.push(`r.pr_date >= $${params.length}`); }
    if (parseDate(to)) { params.push(parseDate(to)); where.push(`r.pr_date <= $${params.length}`); }
    if (mine === '1') { params.push(req.user.id); where.push(`r.requested_by_id = $${params.length}`); }
    if (queue === '1') where.push(queueCondition(req, params));
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const count = await pool.query(`SELECT COUNT(*)::int AS n FROM proc_requests r ${whereSql}`, params);
    params.push(limit, (page - 1) * limit);
    const r = await pool.query(
      `SELECT ${REQUEST_COLS} FROM proc_requests r LEFT JOIN proc_suppliers s ON s.id = r.supplier_id
       ${whereSql}
       ORDER BY ${sortCol ? `${sortCol} ${sortDir} NULLS LAST, r.id ${sortDir}` : `(r.priority = 'Urgent' AND r.status NOT IN ('completed','rejected','cancelled')) DESC, r.pr_date DESC, r.id DESC`}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json({ success: true, data: r.rows.map((row) => decorate(req, row)), total: count.rows[0].n, page, limit });
  } catch (err) {
    console.error('Procurement requests list error:', err.message);
    fail(res, err, 'Failed to load requests');
  }
});

router.get('/requests/:id', async (req, res) => {
  try {
    const row = await loadRequest(pool, req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Request not found' });
    const items = await pool.query(
      `SELECT i.*, p.po_no, p.supplier_name AS po_supplier FROM proc_request_items i LEFT JOIN proc_request_pos p ON p.id = i.po_id
       WHERE i.request_id = $1 ORDER BY i.line_no`, [row.id]);
    const pos = await pool.query(
      `SELECT p.*, (SELECT COUNT(*)::int FROM proc_request_items i WHERE i.po_id = p.id) AS line_count
       FROM proc_request_pos p WHERE p.request_id = $1 ORDER BY p.po_at, p.id`, [row.id]);
    const receipts = await pool.query(
      `SELECT g.*, (SELECT COALESCE(SUM(qty), 0) FROM proc_receipt_items x WHERE x.receipt_id = g.id) AS total_qty
       FROM proc_receipts g WHERE g.request_id = $1 ORDER BY g.receipt_date DESC, g.id DESC`, [row.id]);
    const history = await pool.query('SELECT * FROM proc_request_history WHERE request_id = $1 ORDER BY "createdAt" DESC, id DESC', [row.id]);
    const withImages = await Promise.all(items.rows.map(async (it) => ({
      ...it, qty: Number(it.qty), received_qty: Number(it.received_qty), min_stock: it.min_stock == null ? null : Number(it.min_stock),
      stock_at_request: it.stock_at_request == null ? null : Number(it.stock_at_request),
      image_url: await resolveImageUrl(it.image_key),
    })));
    const approvers = await actorUsers(pool, actorsFor(req, row));
    res.json({
      success: true,
      data: { ...decorate(req, row), items: withImages, pos: pos.rows, receipts: receipts.rows.map((g) => ({ ...g, total_qty: Number(g.total_qty) })), history: history.rows, approvers },
    });
  } catch (err) {
    console.error('Procurement request detail error:', err.message);
    fail(res, err, 'Failed to load request');
  }
});

router.post('/requests', async (req, res) => {
  const client = await pool.connect();
  try {
    const departmentNames = (await activeDepartments()).map((d) => d.name);
    const b = requestBody(req.body, departmentNames);
    if (!b.department) return res.status(400).json({ success: false, message: `department must be one of ${departmentNames.join(', ')}` });
    if (!b.category) return res.status(400).json({ success: false, message: `category must be one of ${CATEGORIES.join(', ')}` });
    const submit = req.body && req.body.submit === true;
    if (submit && b.priority === 'Urgent' && !b.urgent_reason) {
      return res.status(400).json({ success: false, message: 'An Urgent request needs a reason — say what stops or is at risk without it.' });
    }
    const v = validateItems(req.body.items);
    if (v.error) return res.status(400).json({ success: false, message: v.error });
    const prDate = b.pr_date || new Date().toISOString().slice(0, 10);
    const requestedBy = String((req.body && req.body.requested_by) || actorName(req) || 'User').trim();

    await client.query('BEGIN');
    await client.query('LOCK TABLE proc_requests IN SHARE ROW EXCLUSIVE MODE');
    let seq = await nextPrSeq(client, prDate);
    let prNo = docNumber('PR', seq, prDate);
    for (let tries = 0; tries < 100; tries += 1) {
      const dup = await client.query('SELECT 1 FROM proc_requests WHERE pr_no = $1', [prNo]);
      if (!dup.rows.length) break;
      seq += 1; prNo = docNumber('PR', seq, prDate);
    }
    const r = await client.query(
      `INSERT INTO proc_requests (pr_no, pr_date, department, category, requested_by_id, requested_by, priority, urgent_reason, budget_type, required_date, notes, status, "createdBy", "updatedBy")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'draft',$12,$12) RETURNING *`,
      [prNo, prDate, b.department, b.category, req.user.id, requestedBy, b.priority, b.urgent_reason, b.budget_type, b.required_date, b.notes, actorName(req)],
    );
    const row = r.rows[0];
    await writeItems(client, row.id, v.items);
    await logHistory(client, { requestId: row.id, action: 'created', to: 'draft', note: `${b.category} · ${b.priority}${b.urgent_reason ? ` — ${b.urgent_reason}` : ''} · ${v.items.length} item(s)`, req });
    if (submit) {
      const step = firstStep(req, row);
      await client.query(`UPDATE proc_requests SET status = $2, stage_no = $3, submitted_at = NOW(), "updatedAt" = NOW() WHERE id = $1`, [row.id, step.status, step.stage_no]);
      await logHistory(client, { requestId: row.id, action: 'submitted', from: 'draft', to: step.status, note: `Sent for ${stepLabel(req, row, step)}`, req });
    }
    await client.query('COMMIT');
    const full = await loadRequest(pool, row.id);
    res.status(201).json({ success: true, data: decorate(req, full) });
    if (submit) procMail.afterTransition({ action: 'submitted', row: full, helpers: mailHelpers(req), actorName: actorName(req) }).catch(() => {});
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Procurement request create error:', err.message);
    fail(res, err, 'Failed to create request');
  } finally { client.release(); }
});

router.put('/requests/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const row = await loadRequest(client, req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Request not found' });
    if (!decorate(req, row).can.edit) return res.status(403).json({ success: false, message: 'A draft or rejected request can be edited by its requester or an admin; an approved request only by Purchasing, until a PO is recorded.' });
    const departmentNames = (await activeDepartments()).map((d) => d.name);
    const b = requestBody(req.body, departmentNames);
    if (!b.department || !b.category) return res.status(400).json({ success: false, message: 'department and category are required' });
    const v = validateItems(req.body.items);
    if (v.error) return res.status(400).json({ success: false, message: v.error });
    await client.query('BEGIN');
    await client.query(
      `UPDATE proc_requests SET department=$2, category=$3, priority=$4, urgent_reason=$5, budget_type=$6, required_date=$7, notes=$8, requested_by=$9, "updatedBy"=$10, "updatedAt"=NOW()
       WHERE id = $1`,
      [row.id, b.department, b.category, b.priority, b.urgent_reason, b.budget_type, b.required_date, b.notes, String((req.body && req.body.requested_by) || row.requested_by).trim(), actorName(req)],
    );
    await writeItems(client, row.id, v.items);
    await logHistory(client, { requestId: row.id, action: 'edited', from: row.status, to: row.status, note: `${v.items.length} item(s)`, req });
    await client.query('COMMIT');
    const full = await loadRequest(pool, row.id);
    res.json({ success: true, data: decorate(req, full) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Procurement request update error:', err.message);
    fail(res, err, 'Failed to update request');
  } finally { client.release(); }
});

router.delete('/requests/:id', async (req, res) => {
  try {
    const row = await loadRequest(pool, req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Request not found' });
    if (!decorate(req, row).can.delete) return res.status(403).json({ success: false, message: 'Only drafts can be deleted (or an admin can delete any request).' });
    if (Number(row.receipt_count) > 0) return res.status(409).json({ success: false, message: 'This request already has goods receipts. Cancel it instead.' });
    await pool.query('DELETE FROM proc_requests WHERE id = $1', [row.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Procurement request delete error:', err.message);
    fail(res, err, 'Failed to delete request');
  }
});

// Shared shape for every status transition.
async function transition(req, res, { allowed, check, apply, action, noteFrom }) {
  const client = await pool.connect();
  try {
    const row = await loadRequest(client, req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Request not found' });
    const d = decorate(req, row);
    if (!d.can[allowed]) return res.status(403).json({ success: false, message: `You cannot ${allowed} ${row.pr_no} at its current stage (${d.stage_label || row.status.replace('_', ' ')}).` });
    if (check) { const msg = check(row); if (msg) return res.status(400).json({ success: false, message: msg }); }
    await client.query('BEGIN');
    const { to, stageNo, note, extraSql = '', extraParams = [] } = apply(row);
    await client.query(
      `UPDATE proc_requests SET status = $2, "updatedBy" = $3, "updatedAt" = NOW() ${extraSql} WHERE id = $1`,
      [row.id, to, actorName(req), ...extraParams],
    );
    if (stageNo !== undefined) await client.query('UPDATE proc_requests SET stage_no = $2 WHERE id = $1', [row.id, stageNo]);
    await logHistory(client, { requestId: row.id, action, from: row.status, to, note: note || (noteFrom ? noteFrom(row) : null), req });
    await client.query('COMMIT');
    const full = await loadRequest(pool, row.id);
    res.json({ success: true, data: decorate(req, full) });
    // Email the next approvers / the requester once the change is committed. Never blocks the response.
    procMail.afterTransition({ action, row: full, helpers: mailHelpers(req), actorName: actorName(req) }).catch(() => {});
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`Procurement ${action} error:`, err.message);
    res.status(500).json({ success: false, message: `Failed to ${action}` });
  } finally { client.release(); }
}

router.post('/requests/:id/submit', (req, res) => transition(req, res, {
  allowed: 'submit', action: 'submitted',
  check: (row) => (row.priority === 'Urgent' && !row.urgent_reason ? 'An Urgent request needs a reason before it can be submitted.' : null),
  apply: (row) => {
    const step = firstStep(req, row);
    return { to: step.status, stageNo: step.stage_no, note: `${row.status === 'rejected' ? 'Re-submitted' : 'Submitted'} for ${stepLabel(req, row, step)}`, extraSql: ', submitted_at = NOW(), reject_reason = NULL' };
  },
}));

const approveSpec = (req) => ({
  allowed: 'approve', action: 'approved',
  apply: (row) => {
    const step = nextStep(req, row);
    const note = String((req.body && req.body.note) || '').trim();
    const here = stageLabelFor(req, row);
    const what = step.status === 'approved' ? `${here} — final approval, ready for Purchasing` : `${here} → ${stepLabel(req, row, step)}`;
    return { to: step.status, stageNo: step.stage_no, note: note ? `${what}. ${note}` : what, extraSql: step.status === 'approved' ? ', approved_at = NOW()' : '' };
  },
});
router.post('/requests/:id/approve', (req, res) => transition(req, res, approveSpec(req)));

const rejectSpec = (req) => ({
  allowed: 'reject', action: 'rejected',
  check: () => (String((req.body && req.body.reason) || '').trim() ? null : 'Give the requester a reason so they can revise the request.'),
  apply: () => {
    const reason = String(req.body.reason).trim();
    return { to: 'rejected', stageNo: null, note: reason, extraSql: ', reject_reason = $4', extraParams: [reason] };
  },
});
router.post('/requests/:id/reject', (req, res) => transition(req, res, rejectSpec(req)));

router.post('/requests/:id/cancel', (req, res) => transition(req, res, {
  allowed: 'cancel', action: 'cancelled',
  apply: () => ({ to: 'cancelled', stageNo: null, note: String((req.body && req.body.reason) || '').trim() || 'Cancelled by requester' }),
}));

// ─── POs: one PB can be split over several vendors ───────────────────────────
// Each PO covers a chosen set of lines. proc_requests.po_no / supplier_* hold a summary of all POs
// so lists, search, LPB matching and old reports keep working.
async function syncPoSummary(client, requestId) {
  const r = await client.query(
    `SELECT string_agg(DISTINCT po_no, ', ' ORDER BY po_no) AS po_no, string_agg(DISTINCT supplier_name, ', ' ORDER BY supplier_name) AS supplier_name,
            MIN(po_at) AS po_at, COUNT(*)::int AS n, MIN(supplier_id) AS one_supplier, COUNT(DISTINCT supplier_id)::int AS n_suppliers,
            string_agg(notes, ' | ' ORDER BY id) FILTER (WHERE notes IS NOT NULL AND notes <> '') AS notes
     FROM proc_request_pos WHERE request_id = $1`, [requestId]);
  const x = r.rows[0];
  await client.query(
    `UPDATE proc_requests SET po_no = $2, supplier_name = $3, supplier_id = $4, po_at = $5, purchase_notes = $6 WHERE id = $1`,
    [requestId, x.n ? x.po_no : null, x.n ? x.supplier_name : null, x.n_suppliers === 1 ? x.one_supplier : null, x.n ? x.po_at : null, x.n ? x.notes : null]);
}
function readPo(b) {
  return {
    po_no: String((b && b.po_no) || '').trim().slice(0, 60),
    supplier_id: Number(b && b.supplier_id) || null,
    supplier_name: String((b && b.supplier_name) || '').trim().slice(0, 160) || null,
    notes: String((b && b.purchase_notes) || (b && b.notes) || '').trim() || null,
    po_id: Number(b && b.po_id) || null,
    item_ids: Array.isArray(b && b.item_ids) ? b.item_ids.map(Number).filter(Boolean) : null,
  };
}
// Create or update a PO on a request and assign its lines. Shared by /purchase (first PO: moves
// approved → purchasing) and /po (further POs or corrections while already in process).
async function savePo(client, req, row, po) {
  const lines = (await client.query('SELECT id, po_id, description, received_qty FROM proc_request_items WHERE request_id = $1 ORDER BY line_no', [row.id])).rows;
  let wanted = po.item_ids ? lines.filter((l) => po.item_ids.includes(l.id)) : lines.filter((l) => !l.po_id || l.po_id === po.po_id);
  if (!po.item_ids && !po.po_id) wanted = lines.filter((l) => !l.po_id);
  if (!wanted.length) throw Object.assign(new Error('Tick at least one line for this PO.'), { status: 400 });
  const taken = wanted.find((l) => l.po_id && l.po_id !== po.po_id);
  if (taken) throw Object.assign(new Error(`"${taken.description}" is already on another PO — edit that PO instead.`), { status: 400 });
  // A line that already has goods received against this PO stays on it.
  const stuck = po.po_id ? lines.find((l) => l.po_id === po.po_id && Number(l.received_qty) > 0 && !wanted.some((w) => w.id === l.id)) : null;
  if (stuck) throw Object.assign(new Error(`"${stuck.description}" already has goods received on this PO and cannot be removed from it.`), { status: 400 });
  let poId = po.po_id;
  if (poId) {
    const cur = await client.query('SELECT id FROM proc_request_pos WHERE id = $1 AND request_id = $2', [poId, row.id]);
    if (!cur.rows.length) throw Object.assign(new Error('PO not found on this request'), { status: 404 });
    await client.query(
      `UPDATE proc_request_pos SET po_no = $2, supplier_id = $3, supplier_name = COALESCE((SELECT name FROM proc_suppliers WHERE id = $3), $4), notes = $5, "updatedBy" = $6, "updatedAt" = NOW() WHERE id = $1`,
      [poId, po.po_no, po.supplier_id, po.supplier_name, po.notes, actorName(req)]);
    await client.query('UPDATE proc_request_items SET po_id = NULL WHERE request_id = $1 AND po_id = $2', [row.id, poId]);
  } else {
    const ins = await client.query(
      `INSERT INTO proc_request_pos (request_id, po_no, supplier_id, supplier_name, notes, "createdBy", "updatedBy")
       VALUES ($1,$2,$3,COALESCE((SELECT name FROM proc_suppliers WHERE id = $3), $4),$5,$6,$6) RETURNING id`,
      [row.id, po.po_no, po.supplier_id, po.supplier_name, po.notes, actorName(req)]);
    poId = ins.rows[0].id;
  }
  await client.query('UPDATE proc_request_items SET po_id = $2 WHERE id = ANY($1::int[])', [wanted.map((l) => l.id), poId]);
  await syncPoSummary(client, row.id);
  const sup = (await client.query('SELECT supplier_name FROM proc_request_pos WHERE id = $1', [poId])).rows[0];
  const left = (await client.query('SELECT COUNT(*)::int AS n FROM proc_request_items WHERE request_id = $1 AND po_id IS NULL', [row.id])).rows[0].n;
  return { poId, lineCount: wanted.length, supplierName: sup && sup.supplier_name, left };
}

router.post('/requests/:id/purchase', async (req, res) => {
  const client = await pool.connect();
  try {
    const row = await loadRequest(client, req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Request not found' });
    const d = decorate(req, row);
    if (!d.can.purchase && !d.can.set_po) return res.status(403).json({ success: false, message: `You cannot process ${row.pr_no} to purchase at its current stage (${d.stage_label || row.status}).` });
    const po = readPo(req.body);
    if (!po.po_no) return res.status(400).json({ success: false, message: 'Enter the PO number issued to the supplier.' });
    await client.query('BEGIN');
    const out = await savePo(client, req, row, po);
    const to = row.status === 'approved' ? 'purchasing' : row.status;
    if (to !== row.status) await client.query(`UPDATE proc_requests SET status = $2, stage_no = NULL, "updatedBy" = $3, "updatedAt" = NOW() WHERE id = $1`, [row.id, to, actorName(req)]);
    else await client.query(`UPDATE proc_requests SET "updatedBy" = $2, "updatedAt" = NOW() WHERE id = $1`, [row.id, actorName(req)]);
    await logHistory(client, { requestId: row.id, action: 'po_issued', from: row.status, to,
      note: `PO ${po.po_no}${out.supplierName ? ` · ${out.supplierName}` : ''} · ${out.lineCount} line(s)${out.left ? ` · ${out.left} line(s) still without PO` : ''}${po.notes ? ` — ${po.notes}` : ''}`, req });
    await client.query('COMMIT');
    const full = await loadRequest(pool, row.id);
    res.json({ success: true, data: decorate(req, full), po_id: out.poId });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.status) return res.status(err.status).json({ success: false, message: err.message });
    console.error('Procurement purchase error:', err.message);
    fail(res, err, 'Failed to record the PO');
  } finally { client.release(); }
});

// Further PO on a request already in process, or a correction of an existing one (po_id).
router.post('/requests/:id/po', async (req, res) => {
  const client = await pool.connect();
  try {
    const row = await loadRequest(client, req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Request not found' });
    const d = decorate(req, row);
    if (!d.can.set_po) return res.status(403).json({ success: false, message: 'Only Purchasing can set the PO number on a request that is on PO.' });
    const po = readPo(req.body);
    if (!po.po_no) return res.status(400).json({ success: false, message: 'Enter the PO number issued to the supplier.' });
    const before = po.po_id ? (await client.query('SELECT po_no FROM proc_request_pos WHERE id = $1', [po.po_id])).rows[0] : null;
    await client.query('BEGIN');
    const out = await savePo(client, req, row, po);
    await client.query(`UPDATE proc_requests SET "updatedBy" = $2, "updatedAt" = NOW() WHERE id = $1`, [row.id, actorName(req)]);
    await logHistory(client, { requestId: row.id, action: po.po_id ? 'po_updated' : 'po_issued', from: row.status, to: row.status,
      note: `${before && before.po_no !== po.po_no ? `PO ${before.po_no} → ${po.po_no}` : `PO ${po.po_no}`}${out.supplierName ? ` · ${out.supplierName}` : ''} · ${out.lineCount} line(s)${out.left ? ` · ${out.left} line(s) still without PO` : ''}${po.notes ? ` — ${po.notes}` : ''}`, req });
    await client.query('COMMIT');
    const fresh = await loadRequest(pool, row.id);
    res.json({ success: true, data: decorate(req, fresh), po_id: out.poId });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.status) return res.status(err.status).json({ success: false, message: err.message });
    console.error('Procurement set PO error:', err.message);
    fail(res, err, 'Failed to update the PO number');
  } finally { client.release(); }
});

// Remove a PO entered by mistake. Its lines go back to "not on any PO"; when it was the only PO
// the request returns to Approved so Purchasing can enter the right one.
router.delete('/requests/:id/po/:poId', async (req, res) => {
  const client = await pool.connect();
  try {
    const row = await loadRequest(client, req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Request not found' });
    const d = decorate(req, row);
    if (!d.can.set_po) return res.status(403).json({ success: false, message: 'Only Purchasing can remove a PO from a request.' });
    const po = (await client.query('SELECT * FROM proc_request_pos WHERE id = $1 AND request_id = $2', [Number(req.params.poId), row.id])).rows[0];
    if (!po) return res.status(404).json({ success: false, message: 'PO not found on this request' });
    const lines = (await client.query('SELECT id, description, received_qty FROM proc_request_items WHERE request_id = $1 AND po_id = $2', [row.id, po.id])).rows;
    const received = lines.find((l) => Number(l.received_qty) > 0);
    if (received) return res.status(400).json({ success: false, message: `PO ${po.po_no} already has goods received against it ("${received.description}") — void the LPB first.` });
    await client.query('BEGIN');
    await client.query('UPDATE proc_request_items SET po_id = NULL WHERE request_id = $1 AND po_id = $2', [row.id, po.id]);
    await client.query('DELETE FROM proc_request_pos WHERE id = $1', [po.id]);
    await syncPoSummary(client, row.id);
    const remaining = (await client.query('SELECT COUNT(*)::int AS n FROM proc_request_pos WHERE request_id = $1', [row.id])).rows[0].n;
    const to = remaining === 0 && row.status === 'purchasing' ? 'approved' : row.status;
    await client.query(`UPDATE proc_requests SET status = $2, "updatedBy" = $3, "updatedAt" = NOW() WHERE id = $1`, [row.id, to, actorName(req)]);
    await logHistory(client, { requestId: row.id, action: 'po_removed', from: row.status, to,
      note: `PO ${po.po_no} removed · ${lines.length} line(s) released${remaining === 0 ? ' · back to Approved, awaiting PO' : ''}`, req });
    await client.query('COMMIT');
    const fresh = await loadRequest(pool, row.id);
    res.json({ success: true, data: decorate(req, fresh) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Procurement remove PO error:', err.message);
    fail(res, err, 'Failed to remove the PO');
  } finally { client.release(); }
});

router.post('/requests/:id/note', async (req, res) => {
  try {
    const note = String((req.body && req.body.note) || '').trim();
    if (!note) return res.status(400).json({ success: false, message: 'Write a note first.' });
    const row = await loadRequest(pool, req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Request not found' });
    await logHistory(pool, { requestId: row.id, action: 'note', from: row.status, to: row.status, note, req });
    res.json({ success: true });
  } catch (err) {
    console.error('Procurement note error:', err.message);
    fail(res, err, 'Failed to add note');
  }
});

// A reminder is logged on the request; the dashboard opens WhatsApp / email to the approvers.
router.post('/requests/:id/remind', async (req, res) => {
  try {
    const row = await loadRequest(pool, req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Request not found' });
    if (!decorate(req, row).can.remind) return res.status(400).json({ success: false, message: 'This request is not waiting on anyone.' });
    const channel = String((req.body && req.body.channel) || 'WhatsApp');
    let to = String((req.body && req.body.to) || '').trim();
    if (channel === 'SystemEmail') {
      // Re-send the approval email (fresh personal link) to one approver, or to everyone at the stage.
      if (!mailEnabled()) return res.status(400).json({ success: false, message: 'Email is not configured on this server.' });
      const r = await procMail.notifyStage(row, mailHelpers(req), { reminder: true, onlyUserId: req.body && req.body.user_id ? Number(req.body.user_id) : null });
      if (!r.sent.length) return res.status(400).json({ success: false, message: r.skipped.length ? `No email address on file for ${r.skipped.join(', ')}.` : 'Nobody to email at this stage.' });
      to = r.sent.join(', ');
    }
    await logHistory(pool, { requestId: row.id, action: 'reminder', from: row.status, to: row.status, note: `${channel === 'SystemEmail' ? 'Email' : channel} reminder sent${to ? ` to ${to}` : ''} for ${stageLabelFor(req, row) || row.status}`, req });
    res.json({ success: true, data: { to } });
  } catch (err) {
    console.error('Procurement remind error:', err.message);
    fail(res, err, 'Failed to log reminder');
  }
});

// ─── goods receipts (LPB) ───────────────────────────────────────────────────
// ─── goods receipts (LPB) ────────────────────────────────────────────────────
// A receipt line is split into OK / reject / hold. Only OK posts to stock and counts against the
// PB; hold waits in quarantine until the checker releases or rejects it; reject never moves stock
// and leaves the PB line open. A receipt can reference a system PB ('pb'), a typed PB number that
// may not exist yet ('manual' — flagged unmatched until Purchasing reconciles it) or no PB at all
// ('direct' supplier delivery). Voiding reverses the stock and re-opens the PB; nothing is deleted.
const RECEIPT_KINDS = ['pb', 'manual', 'direct'];
const RECEIPT_COLS = `g.*, r.pr_no, r.po_no, r.category, r.department, r.status AS request_status,
  (SELECT COALESCE(SUM(x.qty_ok), 0) FROM proc_receipt_items x WHERE x.receipt_id = g.id) AS total_ok,
  (SELECT COALESCE(SUM(x.qty_reject), 0) FROM proc_receipt_items x WHERE x.receipt_id = g.id) AS total_reject,
  (SELECT COALESCE(SUM(x.qty_hold), 0) FROM proc_receipt_items x WHERE x.receipt_id = g.id) AS total_hold,
  (SELECT COUNT(*)::int FROM proc_receipt_items x WHERE x.receipt_id = g.id) AS line_count,
  (SELECT x.description FROM proc_receipt_items x WHERE x.receipt_id = g.id ORDER BY x.id LIMIT 1) AS first_item`;
/** DATE columns come back from pg as local-midnight Date objects; JSON would shift them to UTC (a day early in WIB). */
function dayStr(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  return String(v).slice(0, 10);
}
function numReceipt(x) {
  return { ...x, receipt_date: dayStr(x.receipt_date), sj_date: dayStr(x.sj_date), total_ok: Number(x.total_ok || 0), total_reject: Number(x.total_reject || 0), total_hold: Number(x.total_hold || 0), total_qty: Number(x.total_ok || 0) };
}
async function logReceipt(client, receiptId, action, note, req) {
  await client.query(
    'INSERT INTO proc_receipt_events (receipt_id, action, note, actor, actor_role) VALUES ($1, $2, $3, $4, $5)',
    [receiptId, action, note || null, actorName(req), (req.user && req.user.roleName) || roleKey(req) || null],
  );
}
// Warehouse (or a procurement admin) may record and correct receipts that are not tied to a PB.
function canHandleReceipts(req) {
  return isProcAdmin(req) || POST_APPROVAL_ROLES.purchasing.includes(roleKey(req));
}
function parseQty(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0; }
function parseLine(x) {
  return {
    request_item_id: Number(x.request_item_id) || null,
    source: ['spare_part', 'part', 'general', 'custom'].includes(x.source) ? x.source : null,
    source_id: Number(x.source_id) || null,
    item_code: String(x.item_code || '').trim().slice(0, 60) || null,
    description: String(x.description || '').trim() || null,
    unit: String(x.unit || '').trim().slice(0, 20) || null,
    qty_ok: parseQty(x.qty_ok != null ? x.qty_ok : x.qty),
    qty_reject: parseQty(x.qty_reject),
    qty_hold: parseQty(x.qty_hold),
    qc_note: String(x.qc_note || '').trim() || null,
    image_key: String(x.image_key || '').trim() || null,
    image_name: String(x.image_name || '').trim().slice(0, 200) || null,
    pool: String(x.pool || '').toUpperCase() === 'MOVING' ? 'MOVING' : 'SALES',
  };
}
// Outstanding on a PB line = ordered − received OK − hold still in quarantine.
async function pendingHoldByItem(client, requestId) {
  const r = await client.query(
    `SELECT x.request_item_id, COALESCE(SUM(x.qty_hold), 0) AS h FROM proc_receipt_items x JOIN proc_receipts g ON g.id = x.receipt_id
     WHERE g.request_id = $1 AND g.voided = false AND x.hold_resolved IS NULL AND x.request_item_id IS NOT NULL GROUP BY x.request_item_id`, [requestId]);
  return Object.fromEntries(r.rows.map((x) => [x.request_item_id, Number(x.h)]));
}
async function refreshRequestStatus(client, req, requestId, { onVoid = false } = {}) {
  const after = await client.query('SELECT SUM(qty) AS q, SUM(received_qty) AS r, MAX(received_qty) AS mx FROM proc_request_items WHERE request_id = $1', [requestId]);
  const total = Number(after.rows[0].q || 0); const got = Number(after.rows[0].r || 0);
  const to = got >= total - 1e-9 && total > 0 ? 'completed' : got > 0 ? 'partially_received' : 'purchasing';
  await client.query(
    `UPDATE proc_requests SET status = $2::text, completed_at = CASE WHEN $2::text = 'completed' THEN COALESCE(completed_at, NOW()) ELSE NULL END, "updatedBy" = $3, "updatedAt" = NOW() WHERE id = $1`,
    [requestId, to, actorName(req)],
  );
  return to;
}
// Reverse a posted OK quantity: spare parts get a 'Used' log line, packaging parts an approved
// negative correction, so every module's own ledger stays balanced and nothing is deleted.
async function reverseStock(client, req, { line, qty, receipt, reason }) {
  const by = actorName(req) || 'Warehouse';
  const today = new Date().toISOString().slice(0, 10);
  if (line.source === 'spare_part' && line.source_id) {
    await client.query(
      `INSERT INTO spare_parts_log (item_id, log_date, transaction_type, qty, description, technician, remark, "createdBy") VALUES ($1, $2, 'Used', $3, $4, $5, $6, $7)`,
      [line.source_id, today, -qty, `VOID ${receipt.grn_no}`, by, reason, by]);
    await client.query(`UPDATE spare_parts_items SET current_qty = GREATEST(current_qty - $2, 0), "updatedAt" = NOW() WHERE id = $1`, [line.source_id, qty]);
    return true;
  }
  if (line.source === 'part' && line.source_id) {
    const part = await client.query('SELECT id, code, description, uom FROM pm_item WHERE id = $1', [line.source_id]);
    if (!part.rows.length) return false;
    const p = part.rows[0];
    const siRef = String(line.stock_ref || line.hold_stock_ref || '');
    const siId = /^SI-(\d+)$/.test(siRef) ? Number(siRef.slice(3)) : null;
    const poolRow = siId ? await client.query('SELECT pool FROM parts_stock_in WHERE id = $1', [siId]) : { rows: [] };
    const pool_ = poolRow.rows.length && poolRow.rows[0].pool === 'MOVING' ? 'MOVING' : 'SALES';
    const bal = await client.query(`SELECT ${poolBalanceSql(pool_)} AS qty`, [p.id]);
    const current = parseFloat(bal.rows[0].qty) || 0;
    const ins = await client.query(
      `INSERT INTO parts_stock_correction (correction_date, part_id, part_code, part_description, uom, current_stock, counted_stock, variance, reason, corrected_by, status, notes, pool)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'approved',$11,$12) RETURNING id`,
      [today, p.id, p.code, p.description, p.uom, current, current - qty, -qty, `VOID ${receipt.grn_no}`, by, reason, pool_]);
    await client.query(
      `INSERT INTO parts_stock_ledger (transaction_date, transaction_type, reference_id, part_id, part_code, part_description, quantity_in, quantity_out, balance_after, performed_by, notes)
       VALUES ($1,'correction',$2,$3,$4,$5,NULL,$6,$7,$8,$9)`,
      [today, `SC-${String(ins.rows[0].id).padStart(4, '0')}`, p.id, p.code, p.description, qty, current - qty, by, `VOID ${receipt.grn_no}`]);
    return true;
  }
  return false;
}

router.get('/receipts', async (req, res) => {
  try {
    const { search, from, to, request_id, kind, qc, domain, source } = req.query;
    const SORTS = { grn_no: 'g.grn_no', receipt_date: 'g.receipt_date', supplier_name: 'g.supplier_name', delivery_note: 'g.delivery_note',
      checked_by: 'g.checked_by', pr_no: 'r.pr_no', po_no: 'r.po_no', kind: 'g.kind', received_by: 'g.received_by' };
    const sortCol = SORTS[String(req.query.sort || '')];
    const sortDir = String(req.query.order || '').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 500);
    const where = [];
    const params = [];
    if (search && String(search).trim()) {
      params.push(`%${String(search).trim()}%`);
      where.push(`(g.grn_no ILIKE $${params.length} OR r.pr_no ILIKE $${params.length} OR r.po_no ILIKE $${params.length} OR g.supplier_name ILIKE $${params.length} OR g.delivery_note ILIKE $${params.length} OR g.vehicle_no ILIKE $${params.length} OR g.manual_pb_no ILIKE $${params.length} OR g.checked_by ILIKE $${params.length}
        OR EXISTS (SELECT 1 FROM proc_receipt_items x WHERE x.receipt_id = g.id AND (x.description ILIKE $${params.length} OR x.item_code ILIKE $${params.length})))`);
    }
    if (parseDate(from)) { params.push(parseDate(from)); where.push(`g.receipt_date >= $${params.length}`); }
    if (parseDate(to)) { params.push(parseDate(to)); where.push(`g.receipt_date <= $${params.length}`); }
    if (request_id) { params.push(Number(request_id)); where.push(`g.request_id = $${params.length}`); }
    if (kind && RECEIPT_KINDS.includes(kind)) { params.push(kind); where.push(`g.kind = $${params.length}`); }
    if (req.query.unmatched === '1') where.push('g.unmatched = true AND g.voided = false');
    if (req.query.include_voided !== '1' && req.query.voided !== '1') where.push('g.voided = false');
    if (req.query.voided === '1') where.push('g.voided = true');
    if (qc === 'issue') where.push(`EXISTS (SELECT 1 FROM proc_receipt_items x WHERE x.receipt_id = g.id AND (x.qty_reject > 0 OR x.qty_hold > 0))`);
    if (qc === 'hold') where.push(`EXISTS (SELECT 1 FROM proc_receipt_items x WHERE x.receipt_id = g.id AND x.qty_hold > 0)`);
    const dom = source || domain;
    if (dom && ['spare_part', 'part'].includes(dom)) { params.push(dom); where.push(`EXISTS (SELECT 1 FROM proc_receipt_items x WHERE x.receipt_id = g.id AND x.source = $${params.length})`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const count = await pool.query(`SELECT COUNT(*)::int AS n FROM proc_receipts g LEFT JOIN proc_requests r ON r.id = g.request_id ${whereSql}`, params);
    params.push(limit, (page - 1) * limit);
    const r = await pool.query(
      `SELECT ${RECEIPT_COLS} FROM proc_receipts g LEFT JOIN proc_requests r ON r.id = g.request_id
       ${whereSql} ORDER BY ${sortCol ? `${sortCol} ${sortDir} NULLS LAST, g.id ${sortDir}` : 'g.receipt_date DESC, g.id DESC'} LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json({ success: true, data: r.rows.map(numReceipt), total: count.rows[0].n, page, limit });
  } catch (err) {
    console.error('Procurement receipts list error:', err.message);
    fail(res, err, 'Failed to load receipts');
  }
});

// PBs that still have something to receive, with their open lines — feeds the Stock In pages'
// "receive against PB" picker. ?source=part|spare_part narrows to lines of that inventory.
router.get('/receipts/open-requests', async (req, res) => {
  try {
    const source = ['spare_part', 'part'].includes(req.query.source) ? req.query.source : null;
    const params = [];
    let srcSql = '';
    if (source) { params.push(source); srcSql = `AND i.source = $${params.length}`; }
    const r = await pool.query(
      `SELECT r.id, r.pr_no, r.po_no, r.supplier_id, r.supplier_name, r.category, r.department, r.status, r.requested_by, r.po_at
       FROM proc_requests r
       WHERE r.status IN ('purchasing','partially_received')
         AND EXISTS (SELECT 1 FROM proc_request_items i WHERE i.request_id = r.id AND i.qty > i.received_qty ${srcSql})
       ORDER BY r.po_at DESC NULLS LAST, r.id DESC`, params);
    const out = [];
    for (const row of r.rows) {
      const holds = await pendingHoldByItem(pool, row.id);
      const lines = await pool.query(`SELECT i.id, i.line_no, i.source, i.source_id, i.item_code, i.description, i.specification, i.qty, i.unit, i.received_qty, i.po_id, p.po_no, p.supplier_name AS po_supplier
                                       FROM proc_request_items i LEFT JOIN proc_request_pos p ON p.id = i.po_id WHERE i.request_id = $1 ${source ? 'AND i.source = $2' : ''} ORDER BY i.line_no`, source ? [row.id, source] : [row.id]);
      out.push({
        ...row,
        lines: lines.rows.map((l) => {
          const hold = holds[l.id] || 0;
          return { ...l, qty: Number(l.qty), received_qty: Number(l.received_qty), hold_pending: hold, outstanding: Math.max(0, Number(l.qty) - Number(l.received_qty) - hold) };
        }),
      });
    }
    res.json({ success: true, data: out });
  } catch (err) {
    console.error('Procurement open requests error:', err.message);
    fail(res, err, 'Failed to load open purchase requests');
  }
});

async function loadReceipt(client, id) {
  const g = await client.query(
    `SELECT ${RECEIPT_COLS}, r.requested_by, r.pr_date, r.priority, r.budget_type
     FROM proc_receipts g LEFT JOIN proc_requests r ON r.id = g.request_id WHERE g.id = $1`, [id]);
  if (!g.rows.length) return null;
  const items = await client.query(
    `SELECT x.*, i.line_no, i.specification, i.qty AS ordered_qty, i.received_qty AS received_total
     FROM proc_receipt_items x LEFT JOIN proc_request_items i ON i.id = x.request_item_id WHERE x.receipt_id = $1 ORDER BY i.line_no NULLS LAST, x.id`, [id]);
  const events = await client.query('SELECT * FROM proc_receipt_events WHERE receipt_id = $1 ORDER BY "createdAt" DESC, id DESC', [id]);
  const withImages = await Promise.all(items.rows.map(async (i) => ({
    ...i, qty: Number(i.qty), qty_ok: Number(i.qty_ok), qty_reject: Number(i.qty_reject), qty_hold: Number(i.qty_hold),
    ordered_qty: i.ordered_qty == null ? null : Number(i.ordered_qty), received_total: i.received_total == null ? null : Number(i.received_total),
    image_url: await resolveImageUrl(i.image_key),
  })));
  const holds = g.rows[0].request_id ? await pendingHoldByItem(client, g.rows[0].request_id) : {};
  for (const i of withImages) i.pb_hold_pending = i.request_item_id ? Number(holds[i.request_item_id] || 0) : 0;
  return { ...numReceipt(g.rows[0]), items: withImages, events: events.rows };
}

router.get('/receipts/:id', async (req, res) => {
  try {
    const data = await loadReceipt(pool, req.params.id);
    if (!data) return res.status(404).json({ success: false, message: 'Receipt not found' });
    res.json({ success: true, data });
  } catch (err) {
    console.error('Procurement receipt detail error:', err.message);
    fail(res, err, 'Failed to load receipt');
  }
});

// Posts a received line into the inventory it came from, so stock goes up without re-typing.
async function postToStock(client, req, { item, qty, receipt, row }) {
  const by = receipt.received_by || actorName(req) || 'Warehouse';
  const poNo = row && row.po_no;
  if (item.source === 'spare_part' && item.source_id) {
    const part = await client.query('SELECT id FROM spare_parts_items WHERE id = $1 FOR UPDATE', [item.source_id]);
    if (!part.rows.length) return null;
    await client.query(
      `INSERT INTO spare_parts_log (item_id, log_date, transaction_type, qty, description, technician, remark, "createdBy")
       VALUES ($1, $2, 'Received', $3, $4, $5, $6, $7)`,
      [item.source_id, receipt.receipt_date, qty, `${receipt.grn_no} · PO ${poNo || '-'}`, by, receipt.delivery_note ? `SJ ${receipt.delivery_note}` : null, actorName(req)],
    );
    await client.query(`UPDATE spare_parts_items SET current_qty = current_qty + $2, "updatedAt" = NOW() WHERE id = $1`, [item.source_id, qty]);
    return `SP:${receipt.grn_no}`;
  }
  if (item.source === 'part' && item.source_id) {
    const part = await client.query('SELECT id, code, description, uom FROM pm_item WHERE id = $1', [item.source_id]);
    if (!part.rows.length) return null;
    const p = part.rows[0];
    const ins = await client.query(
      `INSERT INTO parts_stock_in (purchase_order_id, entry_date, supplier_name, part_id, part_code, part_description, uom, quantity_received, received_by, notes, status, pool)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'verified',$11) RETURNING id`,
      [poNo || receipt.grn_no, receipt.receipt_date, receipt.supplier_name || (row && row.supplier_name) || 'Procurement', p.id, p.code, p.description, p.uom, qty, by, `${receipt.grn_no}${receipt.delivery_note ? ` · SJ ${receipt.delivery_note}` : ''}`, item.pool === 'MOVING' ? 'MOVING' : 'SALES'],
    );
    const pool_ = item.pool === 'MOVING' ? 'MOVING' : 'SALES';
    const bal = await client.query(`SELECT ${poolBalanceSql(pool_)} AS qty`, [p.id]);
    const refId = `SI-${String(ins.rows[0].id).padStart(4, '0')}`;
    await client.query(
      `INSERT INTO parts_stock_ledger (transaction_date, transaction_type, reference_id, part_id, part_code, part_description, quantity_in, quantity_out, balance_after, performed_by, notes)
       VALUES ($1,'stock_in',$2,$3,$4,$5,$6,NULL,$7,$8,$9)`,
      [receipt.receipt_date, refId, p.id, p.code, p.description, qty, parseFloat(bal.rows[0].qty) || 0, by, `${receipt.grn_no}${pool_ === 'MOVING' ? ' (moving pool)' : ''}`],
    );
    return refId;
  }
  return null;
}

// Body: { kind: 'pb'|'manual'|'direct', request_id?, manual_pb_no?, receipt_date, delivery_note, sj_date,
//         checked_by, received_by, supplier_id?, supplier_name?, notes?, post_to_stock?,
//         items: [{ request_item_id?, source?, source_id?, item_code?, description?, unit?, qty_ok, qty_reject, qty_hold, qc_note?, image_key?, image_name? }] }
function httpErr(status, message) { return Object.assign(new Error(message), { status }); }

/**
 * Record one goods receipt inside the caller's transaction. Used by POST /receipts and by the
 * quantity correction in PUT /receipts/:id (void + re-create under the same LPB number).
 * Throws { status, message } for validation problems.
 */
async function createReceipt(client, req, b, opts = {}) {
  {
    const kind = RECEIPT_KINDS.includes(b.kind) ? b.kind : 'pb';
    const lines = (Array.isArray(b.items) ? b.items.map(parseLine) : []).filter((l) => l.qty_ok + l.qty_reject + l.qty_hold > 0);
    if (!lines.length) throw httpErr(400, 'Enter a quantity (OK, reject or hold) for at least one line.');
    const noNote = lines.find((l) => (l.qty_reject > 0 || l.qty_hold > 0) && !l.qc_note);
    if (noNote) throw httpErr(400, `${noNote.description || noNote.item_code || 'A line'} has reject or hold quantity — write the QC note (what was wrong).`);
    const receiptDate = parseDate(b.receipt_date) || new Date().toISOString().slice(0, 10);
    const postToStockFlag = b.post_to_stock !== false;

    // Resolve the PB this receipt is against (none for direct / unmatched manual).
    let row = null; let unmatched = false; let manualNo = null;
    if (kind === 'pb') {
      row = await loadRequest(client, Number(b.request_id));
      if (!row) throw httpErr(404, 'Request not found');
      if (!decorate(req, row).can.receive) throw httpErr(403, `${row.pr_no} is not ready for goods receipt (${decorate(req, row).stage_label || row.status}).`);
    } else {
      if (!canHandleReceipts(req)) throw httpErr(403, 'Only Warehouse or a procurement admin can record a receipt without a system PB.');
      if (kind === 'manual') {
        manualNo = String(b.manual_pb_no || '').trim().slice(0, 60);
        if (!manualNo) throw httpErr(400, 'Type the PB number written on the delivery.');
        const m = await client.query('SELECT id FROM proc_requests WHERE LOWER(pr_no) = LOWER($1) LIMIT 1', [manualNo]);
        if (m.rows.length) {
          const cand = await loadRequest(client, m.rows[0].id);
          if (['purchasing', 'partially_received'].includes(cand.status)) row = cand;
          else throw httpErr(400, `${cand.pr_no} exists but is not open for receipt (${cand.status.replace('_', ' ')}).`);
        } else unmatched = true;
      }
    }

    await client.query('LOCK TABLE proc_receipts IN SHARE ROW EXCLUSIVE MODE');
    let byId = {}; let holds = {};
    if (row) {
      const items = await client.query('SELECT * FROM proc_request_items WHERE request_id = $1 ORDER BY line_no FOR UPDATE', [row.id]);
      byId = Object.fromEntries(items.rows.map((i) => [i.id, i]));
      holds = await pendingHoldByItem(client, row.id);
      // Manual receipts may name lines by code instead of id — map them onto the PB lines.
      for (const l of lines) {
        if (!l.request_item_id) {
          const hit = items.rows.find((i) => (l.source && l.source_id && i.source === l.source && Number(i.source_id) === l.source_id) || (l.item_code && i.item_code && i.item_code.toLowerCase() === l.item_code.toLowerCase()));
          if (hit) l.request_item_id = hit.id;
        }
        const it = l.request_item_id ? byId[l.request_item_id] : null;
        if (l.request_item_id && !it) throw httpErr(400, 'A received line does not belong to this request.');
        if (it) {
          l.source = it.source; l.source_id = it.source_id; l.item_code = it.item_code; l.description = it.description; l.unit = it.unit;
          const outstanding = Number(it.qty) - Number(it.received_qty) - (holds[it.id] || 0);
          if (l.qty_ok + l.qty_hold > outstanding + 1e-9) {
            throw httpErr(400, `${it.description}: only ${outstanding} ${it.unit} outstanding, cannot receive ${l.qty_ok + l.qty_hold} (OK + hold).`);
          }
        } else if (kind === 'pb') {
          throw httpErr(400, 'Every line of a PB receipt must reference a PB line.');
        }
      }
    }
    for (const l of lines) if (!l.description) { throw httpErr(400, 'Every received line needs a description.'); }

    let grnNo = opts.grnNo || null;
    if (!grnNo) {
      let seq = await nextSeq(client, 'proc_receipts', 'receipt_date', receiptDate);
      grnNo = docNumber('LPB', seq, receiptDate);
      for (let tries = 0; tries < 100; tries += 1) {
        const dup = await client.query('SELECT 1 FROM proc_receipts WHERE grn_no = $1', [grnNo]);
        if (!dup.rows.length) break;
        seq += 1; grnNo = docNumber('LPB', seq, receiptDate);
      }
    }
    const supplierId = Number(b.supplier_id) || (row && row.supplier_id) || null;
    const supplierName = String(b.supplier_name || '').trim() || (row && row.supplier_name) || null;
    const receivedBy = String(b.received_by || '').trim() || actorName(req) || 'Warehouse';
    const checkedBy = String(b.checked_by || '').trim() || receivedBy;
    const sources = new Set(lines.map((l) => l.source).filter(Boolean));
    const domain = sources.size === 1 ? [...sources][0] : sources.size ? 'mixed' : null;
    const totalReject = lines.reduce((a, l) => a + l.qty_reject, 0); const totalHold = lines.reduce((a, l) => a + l.qty_hold, 0);
    const condition = totalHold + totalReject === 0 ? 'good' : lines.every((l) => l.qty_ok === 0) ? 'damaged' : 'partial_damage';
    const g = await client.query(
      `INSERT INTO proc_receipts (grn_no, request_id, kind, manual_pb_no, unmatched, receipt_date, sj_date, checked_by, domain, supplier_id, supplier_name, delivery_note, received_by, condition, notes, posted_to_stock, "createdBy", vehicle_no)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE((SELECT name FROM proc_suppliers WHERE id = $10), $11),$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [grnNo, row ? row.id : null, kind, manualNo, unmatched, receiptDate, parseDate(b.sj_date), checkedBy, domain, supplierId, supplierName, String(b.delivery_note || '').trim() || null, receivedBy, condition, String(b.notes || '').trim() || null, postToStockFlag, actorName(req), String(b.vehicle_no || '').trim().slice(0, 40) || null],
    );
    const receipt = g.rows[0];
    let posted = 0;
    for (const l of lines) {
      let stockRef = null;
      if (postToStockFlag && l.qty_ok > 0 && ['spare_part', 'part'].includes(l.source) && l.source_id) {
        stockRef = await postToStock(client, req, { item: l, qty: l.qty_ok, receipt, row });
        if (stockRef) posted += 1;
      }
      await client.query(
        `INSERT INTO proc_receipt_items (receipt_id, request_item_id, qty, condition, stock_ref, qty_ok, qty_reject, qty_hold, qc_note, image_key, image_name, source, source_id, item_code, description, unit, pool)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [receipt.id, l.request_item_id, l.qty_ok, l.qty_hold > 0 ? 'partial_damage' : l.qty_reject > 0 && l.qty_ok === 0 ? 'damaged' : l.qty_reject > 0 ? 'partial_damage' : 'good', stockRef,
          l.qty_ok, l.qty_reject, l.qty_hold, l.qc_note, l.image_key, l.image_name, l.source, l.source_id, l.item_code, l.description, l.unit, l.source === 'part' ? l.pool : null],
      );
      if (l.request_item_id && l.qty_ok > 0) await client.query('UPDATE proc_request_items SET received_qty = received_qty + $2 WHERE id = $1', [l.request_item_id, l.qty_ok]);
    }
    const summary = `${lines.length} line(s) · OK ${lines.reduce((a, l) => a + l.qty_ok, 0)}${totalReject ? ` · reject ${totalReject}` : ''}${totalHold ? ` · hold ${totalHold}` : ''}${posted ? ` · ${posted} posted to stock` : ''}`;
    await logReceipt(client, receipt.id, opts.action || 'created', `${opts.notePrefix || ''}${kind === 'direct' ? 'Direct supplier receipt' : kind === 'manual' ? `Manual PB ${manualNo}${unmatched ? ' (not found in system)' : ''}` : `Against ${row.pr_no}`} · checker ${checkedBy} · ${summary}`, req);
    let to = null;
    if (row) {
      to = await refreshRequestStatus(client, req, row.id);
      await logHistory(client, { requestId: row.id, action: 'goods_received', from: row.status, to, note: `${opts.notePrefix || ''}${grnNo}${receipt.delivery_note ? ` · SJ ${receipt.delivery_note}` : ''} · ${summary}${to === 'completed' ? ' · fully received' : ''}`, req });
    }
    return { data: { ...numReceipt({ ...receipt, total_ok: lines.reduce((a, l) => a + l.qty_ok, 0), total_reject: totalReject, total_hold: totalHold, line_count: lines.length }), request_status: to, posted, unmatched }, receipt, lines };
  }
}

router.post('/receipts', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await createReceipt(client, req, req.body || {});
    await client.query('COMMIT');
    res.status(201).json({ success: true, data: out.data });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.status) return res.status(err.status).json({ success: false, message: err.message });
    console.error('Procurement receipt create error:', err.message);
    fail(res, err, 'Failed to record goods receipt');
  } finally { client.release(); }
});

// Quarantine decision for the hold quantities of a receipt: release (post to stock, counts
// against the PB) or reject (stays off stock, PB line stays open). { action, note, line_ids? }
router.post('/receipts/:id/hold', async (req, res) => {
  const client = await pool.connect();
  try {
    if (!canHandleReceipts(req)) return res.status(403).json({ success: false, message: 'Only Warehouse or a procurement admin can resolve a QC hold.' });
    const action = req.body && req.body.action === 'reject' ? 'reject' : req.body && req.body.action === 'release' ? 'release' : null;
    if (!action) return res.status(400).json({ success: false, message: 'action must be release or reject' });
    const note = String((req.body && req.body.note) || '').trim();
    if (action === 'reject' && !note) return res.status(400).json({ success: false, message: 'Say why the held quantity is rejected.' });
    const ids = Array.isArray(req.body.line_ids) ? req.body.line_ids.map(Number).filter(Boolean) : null;
    await client.query('BEGIN');
    const g = await client.query('SELECT * FROM proc_receipts WHERE id = $1 FOR UPDATE', [req.params.id]);
    const receipt = g.rows[0];
    if (!receipt) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, message: 'Receipt not found' }); }
    if (receipt.voided) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, message: `${receipt.grn_no} is voided.` }); }
    const lines = await client.query(`SELECT * FROM proc_receipt_items WHERE receipt_id = $1 AND qty_hold > 0 AND hold_resolved IS NULL ${ids ? 'AND id = ANY($2)' : ''} FOR UPDATE`, ids ? [receipt.id, ids] : [receipt.id]);
    if (!lines.rows.length) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, message: 'Nothing is on hold for this receipt.' }); }
    const row = receipt.request_id ? await loadRequest(client, receipt.request_id) : null;
    let moved = 0;
    for (const l of lines.rows) {
      const h = Number(l.qty_hold);
      if (action === 'release') {
        let ref = null;
        if (receipt.posted_to_stock && ['spare_part', 'part'].includes(l.source) && l.source_id) ref = await postToStock(client, req, { item: l, qty: h, receipt, row });
        await client.query(`UPDATE proc_receipt_items SET qty_ok = qty_ok + $2, qty = qty + $2, qty_hold = 0, hold_resolved = 'ok', hold_stock_ref = $3, qc_note = CASE WHEN $4 <> '' THEN COALESCE(qc_note, '') || ' · released: ' || $4 ELSE qc_note END WHERE id = $1`, [l.id, h, ref, note]);
        if (l.request_item_id) await client.query('UPDATE proc_request_items SET received_qty = received_qty + $2 WHERE id = $1', [l.request_item_id, h]);
      } else {
        await client.query(`UPDATE proc_receipt_items SET qty_reject = qty_reject + $2, qty_hold = 0, hold_resolved = 'reject', qc_note = COALESCE(qc_note, '') || ' · rejected: ' || $3 WHERE id = $1`, [l.id, h, note]);
      }
      moved += h;
    }
    await logReceipt(client, receipt.id, action === 'release' ? 'hold_released' : 'hold_rejected', `${moved} ${action === 'release' ? 'released to stock' : 'rejected from quarantine'}${note ? ` — ${note}` : ''}`, req);
    let to = null;
    if (row) {
      to = await refreshRequestStatus(client, req, row.id);
      await logHistory(client, { requestId: row.id, action: 'goods_received', from: row.status, to, note: `${receipt.grn_no}: QC hold ${action === 'release' ? 'released' : 'rejected'} (${moved})${note ? ` — ${note}` : ''}`, req });
    }
    await client.query('COMMIT');
    res.json({ success: true, data: await loadReceipt(pool, receipt.id), request_status: to });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Procurement hold resolve error:', err.message);
    fail(res, err, 'Failed to resolve the QC hold');
  } finally { client.release(); }
});

// Void a receipt: the OK stock it posted is reversed in the source inventory, the PB lines are
// re-opened and the document is kept, struck through, with the reason. { reason }
/** Reverse a receipt inside the caller's transaction: stock postings, PB received_qty, open holds. */
async function voidReceiptTx(client, req, receipt, reason, { note } = {}) {
  const lines = await client.query('SELECT * FROM proc_receipt_items WHERE receipt_id = $1 FOR UPDATE', [receipt.id]);
  let reversed = 0; let reopened = 0;
  for (const l of lines.rows) {
    const ok = Number(l.qty_ok);
    if (ok > 0 && (l.stock_ref || l.hold_stock_ref)) { if (await reverseStock(client, req, { line: l, qty: ok, receipt, reason })) reversed += 1; }
    if (ok > 0 && l.request_item_id) { await client.query('UPDATE proc_request_items SET received_qty = GREATEST(received_qty - $2, 0) WHERE id = $1', [l.request_item_id, ok]); reopened += ok; }
    if (Number(l.qty_hold) > 0 && !l.hold_resolved) await client.query(`UPDATE proc_receipt_items SET hold_resolved = 'void' WHERE id = $1`, [l.id]);
  }
  await client.query(`UPDATE proc_receipts SET voided = true, void_reason = $2, voided_at = NOW(), voided_by = $3 WHERE id = $1`, [receipt.id, reason, actorName(req)]);
  await logReceipt(client, receipt.id, 'voided', `${note || reason}${reversed ? ` · ${reversed} stock posting(s) reversed` : ''}${reopened ? ` · ${reopened} re-opened on the PB` : ''}`, req);
  let to = null;
  if (receipt.request_id) {
    const row = await loadRequest(client, receipt.request_id);
    to = await refreshRequestStatus(client, req, receipt.request_id, { onVoid: true });
    await logHistory(client, { requestId: receipt.request_id, action: 'receipt_voided', from: row.status, to, note: `${receipt.grn_no} voided — ${note || reason}`, req });
  }
  return { reversed, reopened, to };
}

router.post('/receipts/:id/void', async (req, res) => {
  const client = await pool.connect();
  try {
    if (!canHandleReceipts(req)) return res.status(403).json({ success: false, message: 'Only Warehouse or a procurement admin can void a receipt.' });
    const reason = String((req.body && req.body.reason) || '').trim();
    if (!reason) return res.status(400).json({ success: false, message: 'Give the reason for voiding this LPB — it goes on the audit trail.' });
    await client.query('BEGIN');
    const g = await client.query('SELECT * FROM proc_receipts WHERE id = $1 FOR UPDATE', [req.params.id]);
    const receipt = g.rows[0];
    if (!receipt) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, message: 'Receipt not found' }); }
    if (receipt.voided) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, message: `${receipt.grn_no} is already voided.` }); }
    const out = await voidReceiptTx(client, req, receipt, reason);
    await client.query('COMMIT');
    res.json({ success: true, data: await loadReceipt(pool, receipt.id), request_status: out.to, reversed: out.reversed });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Procurement receipt void error:', err.message);
    fail(res, err, 'Failed to void the receipt');
  } finally { client.release(); }
});

// Edit an LPB. Header-only changes (date, SJ, checker, receiver, supplier, notes) are updated
// in place. When `items` is sent the quantities are corrected: the current version is voided
// (stock reversed, PB lines re-opened) and re-recorded under the SAME LPB number; the old
// version stays in the trail renamed "<no>~1".
const EDITABLE = ['receipt_date', 'sj_date', 'delivery_note', 'vehicle_no', 'checked_by', 'received_by', 'supplier_id', 'supplier_name', 'notes'];
router.put('/receipts/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    if (!canHandleReceipts(req)) return res.status(403).json({ success: false, message: 'Only Warehouse or a procurement admin can edit a receipt.' });
    const b = req.body || {};
    await client.query('BEGIN');
    const g = await client.query('SELECT * FROM proc_receipts WHERE id = $1 FOR UPDATE', [req.params.id]);
    const receipt = g.rows[0];
    if (!receipt) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, message: 'Receipt not found' }); }
    if (receipt.voided) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, message: `${receipt.grn_no} is voided and cannot be edited.` }); }
    const reason = String(b.reason || '').trim();

    if (Array.isArray(b.items)) {
      if (!reason) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, message: 'Say why the quantities are being corrected — it goes on the audit trail.' }); }
      const n = (await client.query('SELECT COUNT(*)::int AS n FROM proc_receipts WHERE grn_no LIKE $1', [`${receipt.grn_no}~%`])).rows[0].n + 1;
      const oldNo = `${receipt.grn_no}~${n}`;
      await voidReceiptTx(client, req, receipt, `Corrected — ${reason}`, { note: `Superseded by corrected ${receipt.grn_no} — ${reason}` });
      await client.query('UPDATE proc_receipts SET grn_no = $2 WHERE id = $1', [receipt.id, oldNo]);
      const payload = { ...b, kind: receipt.kind, request_id: receipt.request_id, manual_pb_no: receipt.manual_pb_no };
      const out = await createReceipt(client, req, payload, { grnNo: receipt.grn_no, action: 'corrected', notePrefix: `Correction of ${oldNo} (${reason}) · ` });
      await client.query('COMMIT');
      return res.json({ success: true, data: await loadReceipt(pool, out.receipt.id), replaced_id: receipt.id, request_status: out.data.request_status });
    }

    const next = {
      receipt_date: parseDate(b.receipt_date) || receipt.receipt_date,
      sj_date: b.sj_date === undefined ? receipt.sj_date : parseDate(b.sj_date),
      delivery_note: b.delivery_note === undefined ? receipt.delivery_note : (String(b.delivery_note || '').trim() || null),
      checked_by: b.checked_by === undefined ? receipt.checked_by : (String(b.checked_by || '').trim() || receipt.checked_by),
      received_by: b.received_by === undefined ? receipt.received_by : (String(b.received_by || '').trim() || receipt.received_by),
      supplier_id: b.supplier_id === undefined ? receipt.supplier_id : (Number(b.supplier_id) || null),
      supplier_name: b.supplier_name === undefined ? receipt.supplier_name : (String(b.supplier_name || '').trim() || null),
      notes: b.notes === undefined ? receipt.notes : (String(b.notes || '').trim() || null),
      vehicle_no: b.vehicle_no === undefined ? receipt.vehicle_no : (String(b.vehicle_no || '').trim().slice(0, 40) || null),
    };
    if (next.supplier_id) {
      const sup = await client.query('SELECT name FROM proc_suppliers WHERE id = $1', [next.supplier_id]);
      if (sup.rows.length) next.supplier_name = sup.rows[0].name;
    }
    const fmt = (v) => (v == null || v === '' ? '—' : v instanceof Date ? dayStr(v) : String(v));
    const changes = EDITABLE.filter((k) => fmt(next[k]) !== fmt(receipt[k])).map((k) => `${k.replace('_', ' ')}: ${fmt(receipt[k])} → ${fmt(next[k])}`);
    if (!changes.length) { await client.query('ROLLBACK'); return res.json({ success: true, data: await loadReceipt(pool, receipt.id), unchanged: true }); }
    await client.query(
      `UPDATE proc_receipts SET receipt_date = $2, sj_date = $3, delivery_note = $4, checked_by = $5, received_by = $6, supplier_id = $7, supplier_name = $8, notes = $9, vehicle_no = $10 WHERE id = $1`,
      [receipt.id, next.receipt_date, next.sj_date, next.delivery_note, next.checked_by, next.received_by, next.supplier_id, next.supplier_name, next.notes, next.vehicle_no]);
    await logReceipt(client, receipt.id, 'edited', `${changes.join(' · ')}${reason ? ` — ${reason}` : ''}`, req);
    await client.query('COMMIT');
    res.json({ success: true, data: await loadReceipt(pool, receipt.id) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.status) return res.status(err.status).json({ success: false, message: err.message });
    console.error('Procurement receipt edit error:', err.message);
    fail(res, err, 'Failed to edit the receipt');
  } finally { client.release(); }
});

// ─── summary for the dashboard and reports ──────────────────────────────────
// ─── Reminders (bell) ─────────────────────────────────────────────────────────
// What needs this user's attention right now, grouped. Each group carries a link into the page
// that resolves it. Nothing is stored — it is recomputed on every call, so there is no "mark as
// read"; an item disappears when the work is done.
function daysAgo(ts) { return ts ? Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 86400000)) : 0; }
router.get('/reminders', async (req, res) => {
  try {
    const admin = isProcAdmin(req);
    const k = roleKey(req);
    const isPurchasing = admin || POST_APPROVAL_ROLES.approved.includes(k);
    const isWarehouse = admin || POST_APPROVAL_ROLES.purchasing.includes(k);
    const groups = [];
    const reqRow = (r) => ({
      id: r.id, title: r.pr_no, subtitle: `${r.department} · ${CATEGORY_LABELS[r.category] || r.category}${r.priority === 'Urgent' ? ' · URGENT' : ''}`,
      link: req.approverOnly ? `/procurement/approvals/${r.id}` : `/procurement/requests/${r.id}`, age_days: daysAgo(r.updatedAt), urgent: r.priority === 'Urgent',
    });

    // 1. Approvals waiting for me
    const qp = [];
    const cond = queueCondition(req, qp);
    const mine = await pool.query(`SELECT r.* FROM proc_requests r WHERE r.status = 'pending' AND ${cond} ORDER BY (r.priority = 'Urgent') DESC, r."updatedAt" LIMIT 20`, qp);
    if (mine.rows.length) groups.push({ key: 'approvals', label: 'Waiting for your approval', count: mine.rows.length, link: '/procurement/approvals', tone: 'warning', items: mine.rows.map(reqRow) });
    // Approvals-only users see nothing beyond their own approvals.
    if (req.approverOnly) return res.json({ success: true, data: { total: groups.reduce((x, g) => x + g.count, 0), groups, generated_at: new Date().toISOString() } });

    // 2. Approved, no PO yet (Purchasing)
    if (isPurchasing) {
      const r = await pool.query(`SELECT r.* FROM proc_requests r WHERE r.status = 'approved' ORDER BY (r.priority = 'Urgent') DESC, r."updatedAt" LIMIT 20`);
      if (r.rows.length) groups.push({ key: 'po', label: 'Approved — PO not issued', count: r.rows.length, link: '/procurement/approvals?status=approved', tone: 'info', items: r.rows.map(reqRow) });
    }

    // 3. PO issued, goods not fully received (Warehouse)
    if (isWarehouse) {
      const r = await pool.query(`SELECT r.* FROM proc_requests r WHERE r.status IN ('purchasing','partially_received') ORDER BY r."updatedAt" LIMIT 20`);
      if (r.rows.length) groups.push({ key: 'lpb', label: 'On PO — awaiting goods receipt', count: r.rows.length, link: '/procurement/approvals?status=purchasing', tone: 'info',
        items: r.rows.map((x) => ({ ...reqRow(x), subtitle: `${x.po_no ? `PO ${x.po_no}` : 'PO'}${x.supplier_name ? ` · ${x.supplier_name}` : ''}${x.status === 'partially_received' ? ' · partial' : ''}` })) });
      // 4. QC hold not resolved
      const h = await pool.query(
        `SELECT g.id, g.grn_no, g.receipt_date, g.supplier_name, SUM(x.qty_hold) AS hold FROM proc_receipts g JOIN proc_receipt_items x ON x.receipt_id = g.id
         WHERE g.voided = false AND x.qty_hold > 0 GROUP BY g.id ORDER BY g.receipt_date LIMIT 20`);
      if (h.rows.length) groups.push({ key: 'hold', label: 'QC hold waiting for a decision', count: h.rows.length, link: '/procurement/receipts?quick=hold', tone: 'warning',
        items: h.rows.map((x) => ({ id: x.id, title: x.grn_no, subtitle: `${Number(x.hold)} on hold${x.supplier_name ? ` · ${x.supplier_name}` : ''}`, link: `/procurement/receipts?open=${x.id}`, age_days: daysAgo(x.receipt_date), urgent: false })) });
    }

    // 5. Unmatched manual PB (Purchasing reconciles)
    if (isPurchasing) {
      const u = await pool.query(`SELECT g.id, g.grn_no, g.manual_pb_no, g.receipt_date, g.supplier_name FROM proc_receipts g WHERE g.unmatched = true AND g.voided = false ORDER BY g.receipt_date LIMIT 20`);
      if (u.rows.length) groups.push({ key: 'unmatched', label: 'Unmatched PB on a receipt', count: u.rows.length, link: '/procurement/receipts?quick=unmatched', tone: 'critical',
        items: u.rows.map((x) => ({ id: x.id, title: x.grn_no, subtitle: `PB ${x.manual_pb_no || '-'}${x.supplier_name ? ` · ${x.supplier_name}` : ''}`, link: `/procurement/receipts?open=${x.id}`, age_days: daysAgo(x.receipt_date), urgent: false })) });
      // 6. Overdue: required date passed, still open
      const o = await pool.query(`SELECT r.* FROM proc_requests r WHERE r.required_date < CURRENT_DATE AND r.status NOT IN ('completed','rejected','cancelled','draft') ORDER BY r.required_date LIMIT 20`);
      if (o.rows.length) groups.push({ key: 'overdue', label: 'Past the required date', count: o.rows.length, link: '/procurement/requests?status=open', tone: 'critical',
        items: o.rows.map((x) => ({ ...reqRow(x), subtitle: `${x.department} · needed ${new Date(x.required_date).toISOString().slice(0, 10)} · ${STAGE_LABELS[x.status] || stageLabelFor(req, x) || x.status}` })) });
    }

    // 7. Auto-drafted PBs waiting to be reviewed (mine, or all for admin)
    const dp = []; let dcond = "r.is_auto = true AND r.status = 'draft'";
    if (!admin) { dp.push(req.user.id); dcond += ' AND r.requested_by_id = $1'; }
    const d = await pool.query(`SELECT r.* FROM proc_requests r WHERE ${dcond} ORDER BY r."createdAt" DESC LIMIT 20`, dp);
    if (d.rows.length) groups.push({ key: 'auto', label: 'Auto-drafted PB to review', count: d.rows.length, link: '/procurement/requests?status=draft', tone: 'info',
      items: d.rows.map((x) => ({ ...reqRow(x), subtitle: `${x.source_doc ? `from ${x.source_doc} · ` : ''}${x.department}`, link: `/procurement/requests/${x.id}/edit` })) });

    // 8. Low stock without an open PB (anyone who can raise a PB)
    const low = await pool.query(`
      WITH open_items AS (
        SELECT i.source, i.source_id FROM proc_request_items i JOIN proc_requests r ON r.id = i.request_id
        WHERE r.status NOT IN ('completed','rejected','cancelled')
      ), sp AS (
        SELECT 'spare_part' AS source, i.id AS source_id, i.part_no AS code, i.description, i.unit, i.current_qty AS stock, i.min_stock AS min
        FROM spare_parts_items i WHERE i.min_stock IS NOT NULL AND i.min_stock > 0 AND i.current_qty <= i.min_stock
      ), pm AS (
        SELECT 'part' AS source, p.id AS source_id, p.code, p.description, p.uom AS unit, ${poolBalanceSql('SALES', 'p.id')} AS stock, p.reorder_level AS min
        FROM pm_item p WHERE p.is_active = true AND p.reorder_level IS NOT NULL AND p.reorder_level > 0
      )
      SELECT * FROM (SELECT * FROM sp UNION ALL SELECT * FROM pm WHERE pm.stock <= pm.min) u
      WHERE NOT EXISTS (SELECT 1 FROM open_items o WHERE o.source = u.source AND o.source_id = u.source_id)
      ORDER BY (u.stock / NULLIF(u.min, 0)) LIMIT 30`);
    if (low.rows.length) groups.push({ key: 'low', label: 'Low stock with no open PB', count: low.rows.length, link: '/procurement/requests/new', tone: 'critical',
      items: low.rows.map((x) => ({ id: x.source_id, title: x.code || x.description, subtitle: `${x.description} · ${Number(x.stock)} / min ${Number(x.min)} ${x.unit || ''}`, link: `/procurement/requests/new?source=${x.source}&source_id=${x.source_id}`, age_days: 0, urgent: Number(x.stock) <= 0, source: x.source, source_id: x.source_id })) });

    res.json({ success: true, data: { total: groups.reduce((a, g) => a + g.count, 0), groups, generated_at: new Date().toISOString() } });
  } catch (err) {
    console.error('Procurement reminders error:', err.message);
    fail(res, err, 'Failed to load reminders');
  }
});

// ─── One-off migration: Google Form PB register upload (admin) ───────────────
// Two workbooks in one multipart request: field "format" (PB_Upload_Format.xlsx) and field
// "responses" (PB (Responses).xlsx). ?commit=1 writes; otherwise a dry run. Super admin / admin only.
const { importPbHistory, reportCsv } = require('../services/pbHistoryImport');
const historyUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024 } });
router.post('/import/pb-history', historyUpload.fields([{ name: 'format', maxCount: 1 }, { name: 'responses', maxCount: 1 }]), async (req, res) => {
  const k = roleKey(req);
  if (k !== 'super_admin' && k !== 'admin') return res.status(403).json({ success: false, message: 'Only an administrator can import the PB history' });
  const f = req.files && req.files.format && req.files.format[0];
  const r = req.files && req.files.responses && req.files.responses[0];
  if (!f || !r) return res.status(400).json({ success: false, message: 'Upload both workbooks: the upload format and the form responses' });
  const commit = req.query.commit === '1' || req.body.commit === '1' || req.body.commit === 'true';
  try {
    const out = await importPbHistory({ format: f.buffer, responses: r.buffer, commit });
    console.log(`PB history import by ${actorName(req)}: ${commit ? 'COMMIT' : 'dry run'} — ${out.summary.inserted} inserted, ${out.summary.skipped} skipped`);
    res.json({ success: true, data: { ...out.summary, report_csv: reportCsv(out.report), sample: out.report.slice(0, 50) } });
  } catch (err) {
    console.error('PB history import error:', err.message);
    res.status(400).json({ success: false, message: `Import failed, nothing written: ${err.message}` });
  }
});

router.get('/summary', async (req, res) => {
  try {
    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to);
    const params = [];
    const where = [];
    if (from) { params.push(from); where.push(`r.pr_date >= $${params.length}`); }
    if (to) { params.push(to); where.push(`r.pr_date <= $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [byStatus, byCategory, byDept, byPriority, byBudget, monthly, lead, overdue, aging, topItems, recent, queue, byStage] = await Promise.all([
      pool.query(`SELECT status, COUNT(*)::int AS n FROM proc_requests r ${whereSql} GROUP BY status`, params),
      pool.query(`SELECT category, COUNT(*)::int AS n FROM proc_requests r ${whereSql} GROUP BY category ORDER BY n DESC`, params),
      pool.query(`SELECT department, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE priority = 'Urgent')::int AS urgent FROM proc_requests r ${whereSql} GROUP BY department ORDER BY n DESC`, params),
      pool.query(`SELECT priority, COUNT(*)::int AS n FROM proc_requests r ${whereSql} GROUP BY priority`, params),
      pool.query(`SELECT budget_type, COUNT(*)::int AS n FROM proc_requests r ${whereSql} GROUP BY budget_type`, params),
      pool.query(
        `SELECT to_char(date_trunc('month', r.pr_date), 'YYYY-MM') AS month, COUNT(*)::int AS n,
                COUNT(*) FILTER (WHERE category = 'Sparepart')::int AS sparepart,
                COUNT(*) FILTER (WHERE category = 'Packaging')::int AS packaging,
                COUNT(*) FILTER (WHERE category = 'General')::int AS general
         FROM proc_requests r ${whereSql || "WHERE r.pr_date >= date_trunc('month', CURRENT_DATE) - INTERVAL '5 months'"}
         GROUP BY 1 ORDER BY 1`, params),
      pool.query(
        `SELECT ROUND(AVG(EXTRACT(EPOCH FROM (approved_at - submitted_at)) / 86400)::numeric, 1) AS approve_days,
                ROUND(AVG(EXTRACT(EPOCH FROM (po_at - approved_at)) / 86400)::numeric, 1) AS po_days,
                ROUND(AVG(EXTRACT(EPOCH FROM (completed_at - po_at)) / 86400)::numeric, 1) AS delivery_days,
                ROUND(AVG(EXTRACT(EPOCH FROM (completed_at - submitted_at)) / 86400)::numeric, 1) AS total_days
         FROM proc_requests r ${whereSql}`, params),
      pool.query(
        `SELECT COUNT(*)::int AS n FROM proc_requests r
         WHERE r.required_date < CURRENT_DATE AND r.status NOT IN ('completed','rejected','cancelled','draft') ${where.length ? `AND ${where.join(' AND ')}` : ''}`, params),
      pool.query(
        `SELECT status, CASE WHEN status = 'pending' THEN category END AS category, CASE WHEN status = 'pending' THEN stage_no END AS stage_no,
                COUNT(*)::int AS n, ROUND(AVG(EXTRACT(EPOCH FROM (NOW() - "updatedAt")) / 86400)::numeric, 1) AS avg_days, MAX(EXTRACT(EPOCH FROM (NOW() - "updatedAt")) / 86400)::int AS max_days
         FROM proc_requests r WHERE status IN ('pending','approved','purchasing','partially_received') GROUP BY 1, 2, 3`),
      pool.query(
        `SELECT i.description, i.item_code, i.unit, COUNT(DISTINCT r.id)::int AS requests, SUM(i.qty) AS qty
         FROM proc_request_items i JOIN proc_requests r ON r.id = i.request_id ${whereSql}
         GROUP BY i.description, i.item_code, i.unit ORDER BY requests DESC, qty DESC LIMIT 8`, params),
      pool.query(
        `SELECT h.*, r.pr_no, r.category, r.priority FROM proc_request_history h JOIN proc_requests r ON r.id = h.request_id
         ORDER BY h."createdAt" DESC LIMIT 12`),
      (() => {
        const qp = [];
        const cond = queueCondition(req, qp);
        if (cond === 'false') return Promise.resolve({ rows: [] });
        return pool.query(
          `SELECT ${REQUEST_COLS} FROM proc_requests r LEFT JOIN proc_suppliers s ON s.id = r.supplier_id
           WHERE ${cond} ORDER BY (r.priority = 'Urgent') DESC, r."updatedAt" ASC LIMIT 8`, qp);
      })(),
      pool.query(`SELECT category, stage_no, COUNT(*)::int AS n FROM proc_requests r WHERE status = 'pending' GROUP BY 1, 2 ORDER BY 1, 2`),
    ]);
    const statusMap = Object.fromEntries(byStatus.rows.map((x) => [x.status, x.n]));
    const total = byStatus.rows.reduce((a, x) => a + x.n, 0);
    res.json({
      success: true,
      data: {
        total,
        by_status: statusMap,
        pending: PENDING.reduce((a, s) => a + (statusMap[s] || 0), 0),
        in_purchase: (statusMap.approved || 0) + (statusMap.purchasing || 0) + (statusMap.partially_received || 0),
        completed: statusMap.completed || 0,
        rejected: statusMap.rejected || 0,
        overdue: overdue.rows[0].n,
        by_category: byCategory.rows,
        by_department: byDept.rows,
        by_priority: Object.fromEntries(byPriority.rows.map((x) => [x.priority, x.n])),
        by_budget: Object.fromEntries(byBudget.rows.map((x) => [x.budget_type, x.n])),
        monthly: monthly.rows,
        lead_time: lead.rows[0],
        aging: aging.rows.map((x) => ({ ...x, label: x.status === 'pending' ? `${stageLabelFor(req, x)} · ${CATEGORY_LABELS[x.category] || x.category}` : (STAGE_LABELS[x.status] || x.status) })),
        pending_by_stage: byStage.rows.map((x) => { const st = stageOf(req, x); return { category: x.category, category_label: CATEGORY_LABELS[x.category] || x.category, stage_no: Number(x.stage_no), label: st ? st.label : `Stage ${x.stage_no}`, n: x.n }; }),
        top_items: topItems.rows.map((x) => ({ ...x, qty: Number(x.qty) })),
        recent: recent.rows,
        my_queue: queue.rows.map((row) => decorate(req, row)),
      },
    });
  } catch (err) {
    console.error('Procurement summary error:', err.message);
    fail(res, err, 'Failed to load summary');
  }
});

module.exports = router;
// Used by routes/procurement-mail.js (approve / send back from the email link).
router._internal = { transition, approveSpec, rejectSpec, approvalStages, loadRequest, decorate, chainFor, stageLabelFor };
