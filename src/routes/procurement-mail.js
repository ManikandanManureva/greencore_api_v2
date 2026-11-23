/**
 * Approve / send back a purchase request from the email link — no login, the personal token in the
 * URL identifies the approver. Mounted at /api/procurement/mail BEFORE the authenticated
 * procurement router.
 *
 *   GET  /a/:token   review page (shows the PB; never changes anything)
 *   POST /a/:token   action=approve [note] | action=reject reason=…
 *
 * The action runs through the very same transition() as the dashboard, as that user, so
 * permissions, history and the next-stage emails are identical.
 */
const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { loadPermissions } = require('../middleware/permissions');
const { mailConfig } = require('../services/mailer');
const M = require('../services/procMail');

function internals() { return require('./procurement')._internal; }

const STATUS_WORDS = { draft: 'Draft', pending: 'Waiting for approval', approved: 'Approved — awaiting PO', purchasing: 'PO issued', partially_received: 'Partially received', completed: 'Completed', rejected: 'Sent back for revision', cancelled: 'Cancelled' };

/** Resolve the token to { tok, row, user, req } or { error: 'invalid' | 'gone', row? }. */
async function resolve(raw) {
  const P = internals();
  const tok = await M.findToken(raw);
  if (!tok || new Date(tok.expires_at) < new Date()) return { error: 'invalid' };
  const row = await P.loadRequest(pool, tok.request_id);
  if (!row) return { error: 'invalid' };
  const userRow = (await pool.query('SELECT * FROM users WHERE id = $1 AND is_active = true AND deleted_at IS NULL', [tok.user_id])).rows[0];
  if (!userRow) return { error: 'invalid' };
  // A link that was already used shows what happened instead of a dead end.
  if (tok.used_at) return { error: 'gone', row, user: userRow };
  if (row.status !== 'pending' || Number(row.stage_no) !== Number(tok.stage_no)) return { error: 'gone', row, user: userRow };
  const access = await loadPermissions(pool, userRow);
  const procAll = await P.approvalStages();
  const req = {
    user: { id: userRow.id, roleKey: access.roleKey, roleName: access.roleName, permissions: access.permissions, name: userRow.name, email: userRow.email, employeeId: userRow.employee_id },
    procAll, procStages: procAll.byCat, params: { id: String(row.id) }, body: {}, viaMail: true,
  };
  if (!P.decorate(req, row).can.approve) return { error: 'gone', row, user: userRow };
  return { tok, row, user: userRow, req };
}

function stageInfo(P, req, row) {
  const chain = P.chainFor(req, row);
  const idx = chain.findIndex((s) => s.stage_no === Number(row.stage_no));
  return { n: idx >= 0 ? idx + 1 : 1, total: chain.length || 1, label: (chain[idx] && chain[idx].label) || P.stageLabelFor(req, row) || 'Approval' };
}

function send(res, out) { res.status(out.status).type('html').send(out.html); }

function errorPage(res, kind, lang, row) {
  const appUrl = mailConfig().appUrl;
  if (kind === 'gone') {
    return send(res, M.page({ appUrl, lang, title: row.pr_no, eyebrow: M.tr(lang, 'reviewTitle'), chip: null, status: 410,
      inner: M.resultBody(M.esc(M.tr(lang, 'gone')), M.esc(M.tr(lang, 'goneDetail', { status: STATUS_WORDS[row.status] || row.status })), `<a class="link" href="${appUrl}/procurement/approvals/${row.id}">${M.esc(M.tr(lang, 'open'))} →</a>`) }));
  }
  return send(res, M.page({ appUrl, lang, title: M.tr(lang, 'reviewTitle'), eyebrow: 'Greencore Procurement', chip: null, status: 404,
    inner: M.resultBody(M.esc(M.tr(lang, 'invalid')), M.esc(M.tr(lang, 'invalidDetail')), `<a class="link" href="${appUrl}/procurement/approvals">${M.esc(M.tr(lang, 'open'))} →</a>`) }));
}

router.get('/a/:token', async (req, res) => {
  try {
    const P = internals();
    const r = await resolve(req.params.token);
    const lang = M.langOf(r.user);
    if (r.error) return errorPage(res, r.error, lang, r.row);
    const items = await M.loadItems(r.row.id);
    const appUrl = mailConfig().appUrl;
    send(res, M.page({ appUrl, lang, title: r.row.pr_no, eyebrow: M.tr(lang, 'reviewTitle'), chip: r.row.priority === 'Urgent' ? { text: 'Urgent', bg: M.C.warnBg, fg: M.C.warn } : null,
      inner: M.reviewBody(lang, r.row, items, stageInfo(P, r.req, r.row), r.user) }));
  } catch (err) {
    console.error('Mail review page error:', err.message);
    res.status(500).type('html').send('<p style="font-family:sans-serif;padding:24px">Something went wrong. Please open the dashboard instead.</p>');
  }
});

router.post('/a/:token', async (req, res) => {
  try {
    const P = internals();
    const r = await resolve(req.params.token);
    const lang = M.langOf(r.user);
    if (r.error) return errorPage(res, r.error, lang, r.row);
    const appUrl = mailConfig().appUrl;
    const action = String((req.body && req.body.action) || '');
    const note = String((req.body && req.body.note) || '').trim().slice(0, 300);
    const reason = String((req.body && req.body.reason) || '').trim().slice(0, 500);
    if (action === 'reject' && !reason) {
      const items = await M.loadItems(r.row.id);
      return send(res, M.page({ appUrl, lang, title: r.row.pr_no, eyebrow: M.tr(lang, 'reviewTitle'), chip: null, status: 400, inner: M.reviewBody(lang, r.row, items, stageInfo(P, r.req, r.row), r.user, M.tr(lang, 'needReason')) }));
    }
    if (action !== 'approve' && action !== 'reject') return res.status(400).type('html').send('Bad request');
    r.req.body = action === 'approve' ? { note: note ? `${note} (via email)` : 'via email' } : { reason };
    // Capture the JSON the normal route would have sent.
    const shim = { code: 200, body: null, status(c) { this.code = c; return this; }, json(o) { this.body = o; } };
    await P.transition(r.req, shim, action === 'approve' ? P.approveSpec(r.req) : P.rejectSpec(r.req));
    if (shim.code !== 200 || !shim.body || !shim.body.success) {
      const items = await M.loadItems(r.row.id);
      return send(res, M.page({ appUrl, lang, title: r.row.pr_no, eyebrow: M.tr(lang, 'reviewTitle'), chip: null, status: 409, inner: M.reviewBody(lang, r.row, items, stageInfo(P, r.req, r.row), r.user, (shim.body && shim.body.message) || 'Could not record the decision.') }));
    }
    await M.markUsed(r.tok.id, action);
    const after = shim.body.data;
    const link = `<a class="link" href="${appUrl}/procurement/approvals/${r.row.id}">${M.esc(M.tr(lang, 'open'))} →</a>`;
    if (action === 'approve') {
      const sub = after.status === 'approved' ? M.tr(lang, 'doneFinal') : M.tr(lang, 'doneNext', { stage: after.stage_label || '' });
      return send(res, M.page({ appUrl, lang, title: r.row.pr_no, eyebrow: M.tr(lang, 'reviewTitle'), chip: { text: 'Approved', bg: M.C.okBg, fg: M.C.ok }, inner: M.resultBody(`✓ ${M.esc(M.tr(lang, 'doneApproved'))}`, M.esc(sub), link) }));
    }
    return send(res, M.page({ appUrl, lang, title: r.row.pr_no, eyebrow: M.tr(lang, 'reviewTitle'), chip: { text: 'Revise', bg: M.C.warnBg, fg: M.C.warn }, inner: M.resultBody(`↩ ${M.esc(M.tr(lang, 'doneRejected', { requester: r.row.requested_by }))}`, M.esc(reason), link) }));
  } catch (err) {
    console.error('Mail action error:', err.message);
    res.status(500).type('html').send('<p style="font-family:sans-serif;padding:24px">Something went wrong. Please open the dashboard instead.</p>');
  }
});

module.exports = router;
