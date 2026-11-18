'use strict';
/**
 * Migration of the purchase request (PB) history kept in Google Forms into the Procurement module.
 * Used by the CLI (src/scripts/import-pb-history.js) and by POST /procurement/import/pb-history
 * (admin upload from the portal, for servers that can only be reached through the AWS console).
 *
 * Inputs
 *   format     PB_Upload_Format.xlsx, sheet "Upload PB": one row per item line, curated by the client
 *              (PB Ref, Department, Category, Requested by, Required by, Priority, Budget, Purpose / notes,
 *              Item, Specification / notes, Qty, Unit, Min. stock, Sample image). Mixed-budget PBs were
 *              split by the client into "…-CAPEX" / "…-OPEX" refs.
 *   responses  PB (Responses).xlsx, sheet "Form responses 1": the raw form register. Only used for the
 *              fields the upload format lacks: request date, status, approvals, dates, attachments.
 *
 * Rules
 *   - Only PBs in the upload format are imported (the client left test rows and cancelled PBs out).
 *   - pr_no is kept exactly as written (their numbering restarts every month; new PBs continue it).
 *   - Status: Selesai → completed · Cancel → cancelled · Proses → purchasing · Hold / Belum Proses → approved ·
 *     blank → approved when both approvers signed, otherwise pending at the stage that is still waiting.
 *   - Departments missing from the master are created (default category = most used category in the data).
 *   - Every imported request carries source_doc = 'GFORM' and createdBy = 'Import (Google Form)', so the
 *     whole load can be reviewed or removed:  DELETE FROM proc_requests WHERE source_doc = 'GFORM'
 *   - Re-running skips pr_no values that already exist (idempotent).
 */
const ExcelJS = require('exceljs');
const pool = require('../config/database');

const ACTOR = 'Import (Google Form)';
const SOURCE = 'GFORM';
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
const CATEGORIES = ['Sparepart', 'Packaging', 'General'];
const DEPT_ALIAS = { Umum: 'General', Mekanik: 'Mechanical', Elektrik: 'Electrical' };

const s = (v) => (v == null ? '' : String(v).trim());
// exceljs returns objects for hyperlinks ({ text, hyperlink }), rich text and formulas — flatten them.
const cell = (row, i) => {
  const v = row.getCell(i).value;
  if (v == null || typeof v !== 'object' || v instanceof Date) return v;
  if (typeof v.text === 'string') return v.text;
  if (v.text && v.text.richText) return v.text.richText.map((x) => x.text).join('');
  if (v.hyperlink) return v.hyperlink;
  if (v.richText) return v.richText.map((x) => x.text).join('');
  if (v.result != null) return v.result;
  return null; // formula without a cached result = blank cell
};
const asDate = (v) => {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v) ? null : v;
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`);
  const d = new Date(v); return isNaN(d) ? null : d;
};
const iso = (d) => (d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : null);
const baseRef = (ref) => ref.replace(/-(CAPEX|OPEX|\d+)$/i, '');
const refDate = (ref) => {
  const m = ref.match(/\/([IVX]+)\/(\d{2})(?:-|$)/); if (!m) return null;
  const mi = ROMAN.indexOf(m[1]); if (mi < 0) return null;
  return new Date(2000 + Number(m[2]), mi, 1);
};
const approved = (v) => /disetujui/i.test(s(v));
const count = (arr, f) => arr.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});

async function readSheet(input, sheetName, headerRow) {
  const wb = new ExcelJS.Workbook();
  if (Buffer.isBuffer(input)) await wb.xlsx.load(input); else await wb.xlsx.readFile(input);
  const ws = wb.getWorksheet(sheetName) || wb.worksheets[0];
  if (!ws) throw new Error(`Workbook has no sheet "${sheetName}"`);
  const headers = [];
  ws.getRow(headerRow).eachCell({ includeEmpty: true }, (c, i) => { headers[i] = s(cell(ws.getRow(headerRow), i)); });
  const idx = {}; headers.forEach((h, i) => { if (h && idx[h] == null) idx[h] = i; });
  const rows = [];
  ws.eachRow((row, n) => {
    if (n <= headerRow || row.cellCount === 0) return;
    rows.push({ n, get: (name) => (idx[name] ? cell(row, idx[name]) : undefined) });
  });
  return { rows, idx, headers };
}

/**
 * @param {{ format: string|Buffer, responses: string|Buffer, commit: boolean }} opts
 * @returns {Promise<object>} summary, per-PB plan rows, warnings, counts
 */
async function importPbHistory({ format, responses, commit }) {
  const warnings = [];
  const warn = (ref, msg) => warnings.push({ ref, msg });

  // ── 1. upload format ────────────────────────────────────────────────────────
  const fmt = await readSheet(format, 'Upload PB', 1);
  for (const h of ['PB Ref', 'Department', 'Category', 'Requested by', 'Priority', 'Budget', 'Item', 'Qty']) {
    if (fmt.idx[h] == null) throw new Error(`Upload format: column "${h}" not found. Headers: ${fmt.headers.filter(Boolean).join(' | ')}`);
  }
  const pbs = new Map();
  for (const r of fmt.rows) {
    const ref = s(r.get('PB Ref'));
    if (!ref) continue;
    const item = s(r.get('Item'));
    if (!item) { warn(ref, `row ${r.n}: empty item skipped`); continue; }
    let pb = pbs.get(ref);
    if (!pb) {
      pb = {
        ref, base: baseRef(ref), rowNo: r.n,
        department: s(r.get('Department')), category: s(r.get('Category')), requested_by: s(r.get('Requested by')) || 'Unknown',
        required_date: asDate(r.get('Required by')), priority: /urgent|emergency/i.test(s(r.get('Priority'))) ? 'Urgent' : 'Normal',
        budget: /capex/i.test(s(r.get('Budget'))) ? 'CAPEX' : 'OPEX', notes: s(r.get('Purpose / notes')), lines: [],
      };
      if (!CATEGORIES.includes(pb.category)) { warn(ref, `category "${pb.category}" unknown → General`); pb.category = 'General'; }
      pbs.set(ref, pb);
    }
    let qty = parseFloat(String(r.get('Qty') ?? '').replace(',', '.'));
    if (!(qty > 0)) { warn(ref, `row ${r.n}: qty "${s(r.get('Qty'))}" not a number → 1`); qty = 1; }
    // The form had one sample photo per PB; it is kept once in the request notes (Attachments), not per line.
    const image = s(r.get('Sample image'));
    if (image) pb.images = [...new Set([...(pb.images || []), image])];
    const spec = s(r.get('Specification / notes'));
    const minStock = parseFloat(String(r.get('Min. stock') ?? ''));
    pb.lines.push({ description: item, specification: spec || null, qty, unit: s(r.get('Unit')) || 'Pcs', min_stock: Number.isFinite(minStock) ? minStock : null });
  }
  if (!pbs.size) throw new Error('Upload format has no PB rows');

  // ── 2. form register ────────────────────────────────────────────────────────
  const resp = await readSheet(responses, 'Form responses 1', 2);
  if (resp.idx['NO PB'] == null || resp.idx['Status PB'] == null) throw new Error(`Form register: expected columns "NO PB" and "Status PB" on row 2. Headers: ${resp.headers.filter(Boolean).slice(0, 12).join(' | ')}…`);
  const reg = new Map();
  for (const r of resp.rows) { const ref = s(r.get('NO PB')); if (ref) reg.set(ref, r); }
  const statusFor = (r) => {
    const st = r ? s(r.get('Status PB')) : '';
    const jalu = r ? r.get('Acc Pak Jalu') : null; const heri = r ? r.get('Acc Pak Heri') : null;
    const both = approved(jalu) && approved(heri);
    if (/^selesai/i.test(st)) return { status: 'completed', why: 'Selesai' };
    if (/^cancel/i.test(st)) return { status: 'cancelled', why: 'Cancel' };
    if (/^proses/i.test(st) && both) return { status: 'purchasing', why: 'Proses' };
    if (/^proses/i.test(st)) return { status: 'pending', stage: approved(jalu) ? 2 : 1, why: 'Proses but approval still waiting' };
    if (/^hold/i.test(st)) return { status: 'approved', why: 'Hold → approved, waiting for Purchasing' };
    if (/belum/i.test(st)) return { status: 'approved', why: 'Belum Proses' };
    if (!r) return { status: 'approved', why: 'not found in form register' };
    if (both) return { status: 'approved', why: 'blank status, both approvals signed' };
    return { status: 'pending', stage: approved(jalu) ? 2 : 1, why: `blank status, waiting: ${s(jalu) || '-'} / ${s(heri) || '-'}` };
  };

  const plan = [];
  for (const pb of pbs.values()) {
    const r = reg.get(pb.base) || null;
    if (!r) warn(pb.ref, 'not in the form register — date taken from the PB number, status approved');
    const prDate = (r && asDate(r.get('Tanggal Permintaan'))) || (r && asDate(r.get('Timestamp'))) || refDate(pb.ref) || new Date();
    const approvedAt = r ? asDate(r.get('Tanggal Approval')) : null;
    const reviewAt = r ? asDate(r.get('Tanggal Review')) : null;
    const st = statusFor(r);
    const attachments = [...new Set([...(r ? ['Lampiran 1', 'Lampiran 2', 'Lampiran 3', 'Upload Contoh Barang'].map((k) => s(r.get(k))).filter(Boolean) : []), ...(pb.images || [])])];
    const ket = r ? s(r.get('Keterangan')) : '';
    const area = r ? s(r.get('Area Pembelian')) : '';
    const extra = [];
    if (ket) extra.push(`Keterangan: ${ket}`);
    if (area && !/domestik/i.test(area)) extra.push(`Area pembelian: ${area}`);
    if (attachments.length) extra.push(`Attachments: ${attachments.join(' , ')}`);
    const notes = [pb.notes, ...extra].filter(Boolean).join('\n') || null;
    plan.push({
      ...pb, prDate, approvedAt, reviewAt, status: st.status, stage: st.stage || null, why: st.why, notes,
      email: r ? s(r.get('Email address')) : '', jalu: r ? approved(r.get('Acc Pak Jalu')) : false, heri: r ? approved(r.get('Acc Pak Heri')) : false,
    });
  }
  plan.sort((a, b) => a.prDate - b.prDate || a.ref.localeCompare(b.ref));

  // ── 3. write ────────────────────────────────────────────────────────────────
  const client = await pool.connect();
  let inserted = 0, skipped = 0; const deptCreated = [];
  try {
    await client.query('BEGIN');
    const existing = new Set((await client.query('SELECT pr_no FROM proc_requests')).rows.map((x) => x.pr_no));
    const stages = {};
    for (const x of (await client.query('SELECT category, stage_no, role_key, label FROM proc_approval_stages ORDER BY category, stage_no')).rows) (stages[x.category] = stages[x.category] || []).push(x);

    const deptRows = (await client.query('SELECT id, code, name FROM proc_departments')).rows;
    const deptByName = new Map(deptRows.map((d) => [d.name.toLowerCase(), d]));
    const wanted = count(plan, (p) => DEPT_ALIAS[p.department] || p.department);
    if (wanted.Mechanical && !deptByName.has('mechanical') && deptByName.has('maintenance')) {
      const used = await client.query(`SELECT COUNT(*)::int n FROM proc_requests WHERE department = 'Maintenance'`);
      if (used.rows[0].n === 0) { await client.query(`UPDATE proc_departments SET name = 'Mechanical' WHERE id = $1`, [deptByName.get('maintenance').id]); deptByName.set('mechanical', deptByName.get('maintenance')); deptCreated.push('Maintenance → renamed Mechanical'); }
    }
    let nextCode = deptRows.length + 1;
    for (const name of Object.keys(wanted)) {
      if (deptByName.has(name.toLowerCase())) continue;
      const cats = count(plan.filter((p) => (DEPT_ALIAS[p.department] || p.department) === name), (p) => p.category);
      const defaultCat = Object.entries(cats).sort((a, b) => b[1] - a[1])[0][0];
      let code; do { code = `DEPT-${String(nextCode++).padStart(3, '0')}`; } while (deptRows.some((d) => d.code === code));
      const ins = await client.query(`INSERT INTO proc_departments (code, name, default_category, is_active, "createdBy") VALUES ($1,$2,$3,true,$4) RETURNING id, code, name`, [code, name, defaultCat, ACTOR]);
      deptByName.set(name.toLowerCase(), ins.rows[0]); deptCreated.push(`${name} (${defaultCat})`);
    }

    const later = (a, b) => (a && b ? (a > b ? a : b) : a || b);
    for (const p of plan) {
      if (existing.has(p.ref)) { skipped += 1; p.result = 'skipped (exists)'; continue; }
      const department = DEPT_ALIAS[p.department] || p.department;
      const stageNo = p.status === 'pending' ? Math.min(p.stage || 1, (stages[p.category] || []).length || 1) : null;
      const ts = { submitted_at: p.prDate, approved_at: null, po_at: null, completed_at: null };
      if (['approved', 'purchasing', 'partially_received', 'completed'].includes(p.status)) ts.approved_at = later(p.approvedAt, p.prDate);
      if (['purchasing', 'completed'].includes(p.status)) ts.po_at = ts.approved_at;
      if (p.status === 'completed') ts.completed_at = later(p.reviewAt, ts.approved_at);
      const purchaseNotes = p.status === 'approved' && /hold/i.test(p.why) ? 'On hold (imported from the PB register)' : null;
      const ins = await client.query(
        `INSERT INTO proc_requests (pr_no, pr_date, department, category, requested_by, priority, urgent_reason, budget_type, required_date, notes, status, stage_no,
                                    purchase_notes, submitted_at, approved_at, po_at, completed_at, source_doc, "createdBy", "updatedBy", "createdAt", "updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19,$20,$21) RETURNING id`,
        [p.ref, iso(p.prDate), department, p.category, p.requested_by, p.priority, p.priority === 'Urgent' ? (p.notes || 'Urgent (imported)').split('\n')[0].slice(0, 500) : null,
         p.budget, iso(p.required_date), p.notes, p.status, stageNo, purchaseNotes, ts.submitted_at, ts.approved_at, ts.po_at, ts.completed_at, SOURCE, ACTOR,
         p.prDate, ts.completed_at || ts.po_at || ts.approved_at || p.prDate]);
      const id = ins.rows[0].id;
      let n = 0;
      for (const l of p.lines) {
        n += 1;
        await client.query(
          `INSERT INTO proc_request_items (request_id, line_no, source, source_id, item_code, description, qty, unit, specification, min_stock, stock_at_request)
           VALUES ($1,$2,'custom',NULL,NULL,$3,$4,$5,$6,$7,NULL)`,
          [id, n, l.description.slice(0, 500), l.qty, l.unit.slice(0, 30), l.specification, l.min_stock]);
      }
      const hist = (action, from, to, note, actor, role, at) => client.query(
        `INSERT INTO proc_request_history (request_id, action, from_status, to_status, note, actor, actor_role, "createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, action, from, to, note, actor, role, at]);
      const s1 = (stages[p.category] || [])[0]; const s2 = (stages[p.category] || [])[1];
      await hist('created', null, 'draft', `Imported from the Google Form PB register${p.email ? ` (${p.email})` : ''}`, p.requested_by, 'Requester', p.prDate);
      await hist('submitted', 'draft', 'pending', 'Submitted (imported)', p.requested_by, 'Requester', p.prDate);
      if (p.status !== 'cancelled') {
        const done = ['approved', 'purchasing', 'completed'].includes(p.status);
        if (p.jalu || done) await hist('approved', 'pending', s2 ? 'pending' : 'approved', 'Acc Pak Jalu (imported)', 'Pak Jalu', s1 ? s1.label : 'Stage 1', p.approvedAt || p.prDate);
        if (p.heri || done) await hist('approved', 'pending', 'approved', 'Acc Pak Heri (imported)', 'Pak Heri', s2 ? s2.label : 'Final approver', p.approvedAt || p.prDate);
        if (['purchasing', 'completed'].includes(p.status)) await hist('po_issued', 'approved', 'purchasing', 'In process at Purchasing (imported; PO number not in the register)', 'Purchasing', 'Purchasing', ts.po_at);
        if (p.status === 'completed') await hist('goods_received', 'purchasing', 'completed', 'Selesai in the PB register (imported)', 'Warehouse', 'Warehouse', ts.completed_at);
      } else {
        await hist('cancelled', 'pending', 'cancelled', 'Cancel in the PB register (imported)', p.requested_by, 'Requester', p.reviewAt || p.prDate);
      }
      inserted += 1; p.result = 'inserted';
    }
    if (commit) await client.query('COMMIT'); else await client.query('ROLLBACK');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const summary = {
    committed: !!commit, pbs: plan.length, lines: plan.reduce((a, p) => a + p.lines.length, 0), register_rows: reg.size,
    inserted, skipped, by_status: count(plan, (p) => p.status + (p.stage ? ` (stage ${p.stage})` : '')),
    by_category: count(plan, (p) => p.category), by_department: count(plan, (p) => DEPT_ALIAS[p.department] || p.department),
    date_from: iso(plan[0].prDate), date_to: iso(plan[plan.length - 1].prDate), departments_created: deptCreated, warnings: warnings.length,
  };
  const report = plan.map((p) => ({
    pr_no: p.ref, pr_date: iso(p.prDate), department: DEPT_ALIAS[p.department] || p.department, category: p.category, requested_by: p.requested_by,
    priority: p.priority, budget: p.budget, lines: p.lines.length, status: p.status, stage: p.stage || '', reason: p.why, result: p.result || '',
    warnings: warnings.filter((x) => x.ref === p.ref).map((x) => x.msg).join(' | '),
  }));
  return { summary, report, warnings };
}

function reportCsv(report) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
  const cols = ['pr_no', 'pr_date', 'department', 'category', 'requested_by', 'priority', 'budget', 'lines', 'status', 'stage', 'reason', 'result', 'warnings'];
  return '﻿' + [cols.join(','), ...report.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}

module.exports = { importPbHistory, reportCsv, SOURCE, ACTOR };
