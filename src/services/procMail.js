/**
 * Procurement email: approval requests that can be acted on from the inbox, plus outcome notices.
 *
 * Flow: a PB reaches an approval stage → every approver of that stage with an email address gets a
 * message with a personal link. The link opens a small mobile-friendly page (no login) that shows
 * the request and offers Approve / Send back. The page — never the email link itself — performs the
 * action, so link pre-fetchers in mail clients cannot approve anything. Links are single-use,
 * expire after 7 days and stop working as soon as the request leaves that stage.
 *
 * Tokens: proc_mail_actions keeps the SHA-256 of the token; the raw token lives only in the email.
 */
const crypto = require('crypto');
const pool = require('../config/database');
const { mailEnabled, sendMail, mailConfig } = require('./mailer');

const TOKEN_DAYS = 7;
const MAX_ITEMS_IN_MAIL = 12;
const C = { bg: '#eef2f7', card: '#ffffff', text: '#0f172a', muted: '#64748b', line: '#e2e8f0', primary: '#2a78d6', primaryDark: '#1c5cab', ok: '#15803d', okBg: '#ecfdf3', warn: '#b42318', warnBg: '#fef3f2', chip: '#f1f5f9' };

// ─── copy (en / id; fr falls back to en) ─────────────────────────────────────
const T = {
  en: {
    eyebrow: 'Purchase request · approval needed', subject: 'Approval needed: {pr} — {what}', hi: 'Hi {name},',
    intro: '{requester} ({department}) submitted a purchase request that is waiting for your approval as <b>{stage}</b>.',
    stageOf: 'Stage {n} of {total}', department: 'Department', requester: 'Requester', category: 'Category', priority: 'Priority', budget: 'Budget', required: 'Required by', purpose: 'Purpose',
    items: 'Items ({n})', no: 'No', description: 'Description', qty: 'Qty', unit: 'Unit', more: 'and {n} more item(s) — see the full list on the review page',
    cta: 'Review & approve', open: 'Open in dashboard',
    footer: 'This link is personal to you and valid for {days} days. Approvals made from it are recorded in the audit trail exactly like approvals made in the dashboard.',
    reminder: 'Reminder', reminderIntro: 'A friendly reminder: this request is still waiting for your approval as <b>{stage}</b>.',
    approvedSubject: 'Approved: {pr}', approvedEyebrow: 'Purchase request · approved', approvedIntro: 'Your purchase request <b>{pr}</b> has received final approval and is now with Purchasing.',
    purchasingSubject: 'Ready for PO: {pr}', purchasingEyebrow: 'Purchase request · ready for PO', purchasingIntro: '<b>{pr}</b> from {requester} ({department}) is fully approved and ready for a purchase order.',
    rejectedSubject: 'Sent back for revision: {pr}', rejectedEyebrow: 'Purchase request · sent back', rejectedIntro: '{actor} sent <b>{pr}</b> back to you for revision.', reason: 'Reason',
    // review page
    reviewTitle: 'Review purchase request', asUser: 'Signed in by link as {name}', approve: 'Approve', approveHint: 'Note for the record (optional)', sendBack: 'Send back for revision', sendBackHint: 'Reason for the requester (required)',
    confirmApprove: 'Approve {pr}?', confirmReject: 'Send {pr} back to the requester?',
    doneApproved: 'Approved — thank you.', doneNext: 'Next: {stage}.', doneFinal: 'That was the final approval — the request is now with Purchasing.', doneRejected: 'Sent back to {requester} with your reason.',
    gone: 'This request has already been handled.', goneDetail: 'Current status: {status}.', invalid: 'This link has expired or is no longer valid.', invalidDetail: 'Ask for a new reminder from the dashboard, or sign in to act on the request.',
    needReason: 'Please give the requester a reason.', generatedBy: 'Greencore Procurement · PT Greencore Resources Indonesia',
  },
  id: {
    eyebrow: 'Permintaan barang · perlu persetujuan', subject: 'Perlu persetujuan: {pr} — {what}', hi: 'Halo {name},',
    intro: '{requester} ({department}) mengajukan permintaan barang yang menunggu persetujuan Anda sebagai <b>{stage}</b>.',
    stageOf: 'Tahap {n} dari {total}', department: 'Departemen', requester: 'Pemohon', category: 'Kategori', priority: 'Prioritas', budget: 'Anggaran', required: 'Dibutuhkan', purpose: 'Keperluan',
    items: 'Barang ({n})', no: 'No', description: 'Deskripsi', qty: 'Jml', unit: 'Satuan', more: 'dan {n} barang lainnya — daftar lengkap ada di halaman tinjauan',
    cta: 'Tinjau & setujui', open: 'Buka di dashboard',
    footer: 'Tautan ini khusus untuk Anda dan berlaku {days} hari. Persetujuan lewat tautan ini tercatat di jejak audit sama seperti persetujuan dari dashboard.',
    reminder: 'Pengingat', reminderIntro: 'Sekadar mengingatkan: permintaan ini masih menunggu persetujuan Anda sebagai <b>{stage}</b>.',
    approvedSubject: 'Disetujui: {pr}', approvedEyebrow: 'Permintaan barang · disetujui', approvedIntro: 'Permintaan barang <b>{pr}</b> Anda telah mendapat persetujuan akhir dan kini ditangani Purchasing.',
    purchasingSubject: 'Siap PO: {pr}', purchasingEyebrow: 'Permintaan barang · siap PO', purchasingIntro: '<b>{pr}</b> dari {requester} ({department}) sudah disetujui penuh dan siap dibuatkan PO.',
    rejectedSubject: 'Dikembalikan untuk revisi: {pr}', rejectedEyebrow: 'Permintaan barang · dikembalikan', rejectedIntro: '{actor} mengembalikan <b>{pr}</b> kepada Anda untuk direvisi.', reason: 'Alasan',
    reviewTitle: 'Tinjau permintaan barang', asUser: 'Masuk lewat tautan sebagai {name}', approve: 'Setujui', approveHint: 'Catatan (opsional)', sendBack: 'Kembalikan untuk revisi', sendBackHint: 'Alasan untuk pemohon (wajib)',
    confirmApprove: 'Setujui {pr}?', confirmReject: 'Kembalikan {pr} ke pemohon?',
    doneApproved: 'Disetujui — terima kasih.', doneNext: 'Selanjutnya: {stage}.', doneFinal: 'Ini persetujuan akhir — permintaan kini ditangani Purchasing.', doneRejected: 'Dikembalikan ke {requester} dengan alasan Anda.',
    gone: 'Permintaan ini sudah diproses.', goneDetail: 'Status saat ini: {status}.', invalid: 'Tautan ini sudah kedaluwarsa atau tidak berlaku lagi.', invalidDetail: 'Minta pengingat baru dari dashboard, atau masuk ke aplikasi untuk memproses permintaan.',
    needReason: 'Mohon tulis alasan untuk pemohon.', generatedBy: 'Greencore Procurement · PT Greencore Resources Indonesia',
  },
};
function tr(lang, key, vars = {}) {
  const dict = T[lang] || T.en;
  const s = dict[key] || T.en[key] || key;
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k])));
}
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const fmtDate = (v) => { if (!v) return '-'; const d = new Date(v); return Number.isNaN(d.getTime()) ? String(v).slice(0, 10) : `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`; };
const fmtQty = (n) => { const x = Number(n); return Number.isInteger(x) ? String(x) : x.toLocaleString('en-US', { maximumFractionDigits: 2 }); };
const langOf = (user) => (user && ['en', 'id'].includes(String(user.language || '').toLowerCase()) ? String(user.language).toLowerCase() : 'en');
const CATEGORY_LABELS = { Sparepart: 'Sparepart', Packaging: 'Packaging', General: 'General & IT' };

// ─── data ────────────────────────────────────────────────────────────────────
async function loadItems(requestId) {
  const r = await pool.query('SELECT line_no, item_code, description, specification, qty, unit FROM proc_request_items WHERE request_id = $1 ORDER BY line_no', [requestId]);
  return r.rows;
}
async function userById(id) {
  if (id == null) return null;
  const r = await pool.query('SELECT id, name, email, language FROM users WHERE id = $1 AND is_active = true AND deleted_at IS NULL', [id]);
  return r.rows[0] || null;
}
async function createToken({ requestId, userId, stageNo }) {
  const raw = crypto.randomBytes(24).toString('base64url');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  await pool.query(
    `INSERT INTO proc_mail_actions (token_hash, request_id, user_id, stage_no, expires_at) VALUES ($1, $2, $3, $4, NOW() + ($5 || ' days')::interval)`,
    [hash, requestId, userId, stageNo, String(TOKEN_DAYS)]);
  return raw;
}
async function findToken(raw) {
  if (!raw || !/^[A-Za-z0-9_-]{20,64}$/.test(raw)) return null;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const r = await pool.query('SELECT * FROM proc_mail_actions WHERE token_hash = $1', [hash]);
  return r.rows[0] || null;
}
async function markUsed(id, action) {
  await pool.query('UPDATE proc_mail_actions SET used_at = NOW(), used_action = $2 WHERE id = $1', [id, action]);
}

// ─── html building blocks ────────────────────────────────────────────────────
const font = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";
function shell({ appUrl, eyebrow, title, chip, bodyHtml, cta, lang, footerNote }) {
  const logo = `${appUrl}/brand-mark.png`;
  const chipHtml = chip ? `<span style="display:inline-block;margin-left:8px;padding:3px 9px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;background:${chip.bg};color:${chip.fg};vertical-align:middle">${esc(chip.text)}</span>` : '';
  const ctaHtml = cta ? `
      <tr><td style="padding:6px 28px 26px">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"><tr>
          <td align="center" style="border-radius:12px;background:${C.primary}"><a href="${cta.href}" style="display:block;padding:15px 20px;${font}font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:12px">${esc(cta.label)} →</a></td>
        </tr></table>
        ${cta.secondary ? `<p style="margin:12px 0 0;text-align:center;${font}font-size:13px"><a href="${cta.secondary.href}" style="color:${C.primary};text-decoration:none">${esc(cta.secondary.label)}</a></p>` : ''}
      </td></tr>` : '';
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:${C.bg};${font}color:${C.text}">
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:${C.bg}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width:600px">
  <tr><td style="padding:0 6px 14px">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
      <td style="padding-right:10px"><img src="${logo}" width="34" height="29" alt="" style="display:block;border:0"></td>
      <td style="${font}font-size:15px;font-weight:800;color:${C.text};letter-spacing:-.01em">Greencore <span style="font-weight:500;color:${C.muted}">Procurement</span></td>
    </tr></table>
  </td></tr>
  <tr><td style="background:${C.card};border:1px solid ${C.line};border-radius:18px;overflow:hidden">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
      <tr><td style="height:6px;background:linear-gradient(90deg,${C.primary},${C.primaryDark});font-size:0;line-height:0">&nbsp;</td></tr>
      <tr><td style="padding:24px 28px 6px">
        <div style="${font}font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:${C.muted}">${esc(eyebrow)}</div>
        <div style="${font}font-size:24px;font-weight:800;letter-spacing:-.02em;margin-top:6px;color:${C.text}">${esc(title)}${chipHtml}</div>
      </td></tr>
      ${bodyHtml}
      ${ctaHtml}
    </table>
  </td></tr>
  <tr><td style="padding:16px 10px 0;${font}font-size:12px;line-height:18px;color:${C.muted};text-align:center">${footerNote ? `${footerNote}<br>` : ''}${esc(tr(lang, 'generatedBy'))}</td></tr>
</table></td></tr></table></body></html>`;
}
function paragraph(html) { return `<tr><td style="padding:10px 28px 0;${font}font-size:15px;line-height:23px;color:${C.text}">${html}</td></tr>`; }
function facts(lang, row) {
  const cells = [
    [tr(lang, 'department'), row.department], [tr(lang, 'requester'), row.requested_by],
    [tr(lang, 'category'), CATEGORY_LABELS[row.category] || row.category], [tr(lang, 'priority'), row.priority === 'Urgent' ? `<span style="color:${C.warn};font-weight:700">Urgent</span>${row.urgent_reason ? ` · ${esc(row.urgent_reason)}` : ''}` : esc(row.priority || 'Normal')],
    [tr(lang, 'budget'), row.budget_type], [tr(lang, 'required'), fmtDate(row.required_date)],
  ];
  const rows = [];
  for (let i = 0; i < cells.length; i += 2) {
    rows.push(`<tr>${[cells[i], cells[i + 1]].map(([k, v]) => `<td width="50%" style="padding:9px 12px;vertical-align:top;${font}"><div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${C.muted}">${esc(k)}</div><div style="font-size:14px;font-weight:600;color:${C.text};margin-top:2px">${i % 2 === 1 || k === tr(lang, 'priority') ? v : esc(v || '-')}</div></td>`).join('')}</tr>`);
  }
  const purpose = row.notes ? `<tr><td colspan="2" style="padding:9px 12px;border-top:1px solid ${C.line};${font}"><div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${C.muted}">${esc(tr(lang, 'purpose'))}</div><div style="font-size:14px;color:${C.text};margin-top:2px">${esc(row.notes)}</div></td></tr>` : '';
  return `<tr><td style="padding:18px 28px 0"><table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:${C.chip};border-radius:14px">${rows.join('')}${purpose}</table></td></tr>`;
}
function itemsTable(lang, items, limit) {
  const shown = limit ? items.slice(0, limit) : items;
  const trs = shown.map((it, i) => `<tr style="background:${i % 2 ? '#fafbfd' : '#fff'}">
      <td style="padding:9px 10px;border-top:1px solid ${C.line};${font}font-size:13px;color:${C.muted};vertical-align:top;width:28px">${it.line_no || i + 1}</td>
      <td style="padding:9px 10px;border-top:1px solid ${C.line};${font}font-size:14px;color:${C.text};vertical-align:top"><div style="font-weight:600">${esc(it.description)}</div>${it.specification ? `<div style="font-size:12.5px;color:${C.muted};margin-top:2px">${esc(it.specification)}</div>` : ''}${it.item_code ? `<div style="font-size:11.5px;color:${C.muted};margin-top:2px;font-family:ui-monospace,Menlo,Consolas,monospace">${esc(it.item_code)}</div>` : ''}</td>
      <td align="right" style="padding:9px 10px;border-top:1px solid ${C.line};${font}font-size:14px;font-weight:700;color:${C.text};vertical-align:top;white-space:nowrap">${fmtQty(it.qty)} <span style="font-weight:500;color:${C.muted}">${esc(it.unit)}</span></td>
    </tr>`).join('');
  const more = items.length > shown.length ? `<tr><td colspan="3" style="padding:10px;border-top:1px solid ${C.line};${font}font-size:13px;color:${C.muted};font-style:italic">${esc(tr(lang, 'more', { n: items.length - shown.length }))}</td></tr>` : '';
  return `<tr><td style="padding:20px 28px 0">
      <div style="${font}font-size:12px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:${C.muted};margin-bottom:8px">${esc(tr(lang, 'items', { n: items.length }))}</div>
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="border:1px solid ${C.line};border-radius:12px;border-collapse:separate;overflow:hidden">
        <tr><th align="left" style="padding:8px 10px;${font}font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:${C.muted};background:${C.chip}">${esc(tr(lang, 'no'))}</th><th align="left" style="padding:8px 10px;${font}font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:${C.muted};background:${C.chip}">${esc(tr(lang, 'description'))}</th><th align="right" style="padding:8px 10px;${font}font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:${C.muted};background:${C.chip}">${esc(tr(lang, 'qty'))}</th></tr>
        ${trs}${more}
      </table></td></tr>`;
}
function stageLine(lang, stage) {
  if (!stage) return '';
  return `<tr><td style="padding:16px 28px 0"><div style="display:inline-block;padding:6px 12px;border-radius:999px;background:#e8f1fc;color:${C.primaryDark};${font}font-size:12.5px;font-weight:700">${esc(tr(lang, 'stageOf', { n: stage.n, total: stage.total }))} · ${esc(stage.label)}</div></td></tr>`;
}

// ─── messages ────────────────────────────────────────────────────────────────
function textFallback(lines) { return lines.filter(Boolean).join('\n'); }

async function sendApprovalRequest({ row, items, user, stage, appUrl, reminder }) {
  const lang = langOf(user);
  const token = await createToken({ requestId: row.id, userId: user.id, stageNo: row.stage_no });
  const link = `${appUrl}/api/procurement/mail/a/${token}`;
  const dash = `${appUrl}/procurement/approvals/${row.id}`;
  const html = shell({
    appUrl, lang, eyebrow: reminder ? `${tr(lang, 'reminder')} · ${tr(lang, 'eyebrow')}` : tr(lang, 'eyebrow'), title: row.pr_no,
    chip: row.priority === 'Urgent' ? { text: 'Urgent', bg: C.warnBg, fg: C.warn } : null,
    bodyHtml: paragraph(`${esc(tr(lang, 'hi', { name: user.name }))}<br>${reminder ? tr(lang, 'reminderIntro', { stage: esc(stage.label) }) : tr(lang, 'intro', { requester: esc(row.requested_by), department: esc(row.department), stage: esc(stage.label) })}`)
      + stageLine(lang, stage) + facts(lang, row) + itemsTable(lang, items, MAX_ITEMS_IN_MAIL) + '<tr><td style="height:22px"></td></tr>',
    cta: { href: link, label: tr(lang, 'cta'), secondary: { href: dash, label: tr(lang, 'open') } },
    footerNote: esc(tr(lang, 'footer', { days: TOKEN_DAYS })),
  });
  const text = textFallback([`${row.pr_no} — ${tr(lang, 'eyebrow')}`, '', tr(lang, 'intro', { requester: row.requested_by, department: row.department, stage: stage.label }).replace(/<\/?b>/g, ''), '', ...items.slice(0, MAX_ITEMS_IN_MAIL).map((it) => `- ${it.description} ${fmtQty(it.qty)} ${it.unit}`), '', `${tr(lang, 'cta')}: ${link}`, `${tr(lang, 'open')}: ${dash}`]);
  const subject = tr(lang, 'subject', { pr: row.pr_no, what: items[0] ? items[0].description : row.department });
  return sendMail({ to: user.email, subject: reminder ? `${tr(lang, 'reminder')} — ${subject}` : subject, html, text });
}

async function sendOutcome({ kind, row, items, user, appUrl, actor, reason }) {
  const lang = langOf(user);
  const dash = `${appUrl}/procurement/requests/${row.id}`;
  const map = {
    approved: { eyebrow: 'approvedEyebrow', subject: 'approvedSubject', intro: 'approvedIntro', chip: { text: 'Approved', bg: C.okBg, fg: C.ok } },
    purchasing: { eyebrow: 'purchasingEyebrow', subject: 'purchasingSubject', intro: 'purchasingIntro', chip: { text: 'Approved', bg: C.okBg, fg: C.ok } },
    rejected: { eyebrow: 'rejectedEyebrow', subject: 'rejectedSubject', intro: 'rejectedIntro', chip: { text: 'Revise', bg: C.warnBg, fg: C.warn } },
  }[kind];
  const vars = { pr: row.pr_no, requester: esc(row.requested_by), department: esc(row.department), actor: esc(actor || '') };
  const reasonHtml = kind === 'rejected' && reason ? `<tr><td style="padding:14px 28px 0"><div style="padding:12px 14px;border-radius:12px;background:${C.warnBg};border:1px solid #fecdca;${font}"><div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${C.warn}">${esc(tr(lang, 'reason'))}</div><div style="font-size:14px;color:${C.text};margin-top:3px">${esc(reason)}</div></div></td></tr>` : '';
  const html = shell({
    appUrl, lang, eyebrow: tr(lang, map.eyebrow), title: row.pr_no, chip: map.chip,
    bodyHtml: paragraph(`${esc(tr(lang, 'hi', { name: user.name }))}<br>${tr(lang, map.intro, vars)}`) + reasonHtml + facts(lang, row) + itemsTable(lang, items, MAX_ITEMS_IN_MAIL) + '<tr><td style="height:22px"></td></tr>',
    cta: { href: dash, label: tr(lang, 'open') },
  });
  const text = textFallback([`${row.pr_no} — ${tr(lang, map.eyebrow)}`, '', tr(lang, map.intro, { ...vars }).replace(/<\/?b>/g, ''), reason ? `${tr(lang, 'reason')}: ${reason}` : '', '', `${tr(lang, 'open')}: ${dash}`]);
  return sendMail({ to: user.email, subject: tr(lang, map.subject, { pr: row.pr_no }), html, text });
}

// ─── triggers ────────────────────────────────────────────────────────────────
/**
 * helpers: { actors(row) → users at the row's current stage, stageLabel(row), chain(row) → stage list }
 * Returns { sent, skipped } for logging; never throws.
 */
async function notifyStage(row, helpers, { reminder = false, onlyUserId = null } = {}) {
  const out = { sent: [], skipped: [] };
  if (!mailEnabled() || row.status !== 'pending') return out;
  try {
    const appUrl = mailConfig().appUrl;
    const chain = helpers.chain(row);
    const idx = chain.findIndex((s) => s.stage_no === Number(row.stage_no));
    const stage = { n: idx >= 0 ? idx + 1 : Number(row.stage_no) || 1, total: chain.length || 1, label: (chain[idx] && chain[idx].label) || helpers.stageLabel(row) || 'Approval' };
    const items = await loadItems(row.id);
    const users = (await helpers.actors(row)).filter((u) => !onlyUserId || Number(u.id) === Number(onlyUserId));
    for (const u of users) {
      const full = await userById(u.id);
      if (!full || !full.email) { out.skipped.push(u.name); continue; }
      const r = await sendApprovalRequest({ row, items, user: full, stage, appUrl, reminder });
      (r.ok ? out.sent : out.skipped).push(u.name);
    }
  } catch (err) { console.error('Procurement mail (stage) failed:', err.message); }
  return out;
}

async function afterTransition({ action, row, helpers, actorName }) {
  if (!mailEnabled()) return;
  try {
    if (row.status === 'pending' && (action === 'submitted' || action === 'approved')) { await notifyStage(row, helpers); return; }
    const appUrl = mailConfig().appUrl;
    const items = await loadItems(row.id);
    if (action === 'approved' && row.status === 'approved') {
      const requester = await userById(row.requested_by_id);
      if (requester && requester.email) await sendOutcome({ kind: 'approved', row, items, user: requester, appUrl });
      for (const u of await helpers.purchasing()) {
        const full = await userById(u.id);
        if (full && full.email && (!requester || full.id !== requester.id)) await sendOutcome({ kind: 'purchasing', row, items, user: full, appUrl });
      }
    }
    if (action === 'rejected') {
      const requester = await userById(row.requested_by_id);
      if (requester && requester.email) await sendOutcome({ kind: 'rejected', row, items, user: requester, appUrl, actor: actorName, reason: row.reject_reason });
    }
  } catch (err) { console.error('Procurement mail (outcome) failed:', err.message); }
}

// ─── review page (served without login, by token) ───────────────────────────
function page({ appUrl, lang, title, eyebrow, chip, inner, status = 200 }) {
  const logo = `${appUrl}/brand-mark.png`;
  const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>
  :root{color-scheme:light}
  body{margin:0;background:${C.bg};${font}color:${C.text};-webkit-font-smoothing:antialiased}
  .wrap{max-width:640px;margin:0 auto;padding:20px 12px 40px}
  .brand{display:flex;align-items:center;gap:10px;padding:2px 6px 14px;font-weight:800;font-size:15px}.brand span{font-weight:500;color:${C.muted}}
  .card{background:#fff;border:1px solid ${C.line};border-radius:18px;overflow:hidden;box-shadow:0 10px 30px rgba(15,23,42,.06)}
  .bar{height:6px;background:linear-gradient(90deg,${C.primary},${C.primaryDark})}
  .pad{padding:22px 22px 0}.eyebrow{font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:${C.muted}}
  h1{margin:6px 0 0;font-size:24px;letter-spacing:-.02em;font-weight:800}
  .chip{display:inline-block;margin-left:8px;padding:3px 9px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;vertical-align:middle}
  p{font-size:15px;line-height:23px;margin:10px 0 0}
  table{width:100%;border-collapse:separate;border-spacing:0}
  .facts{background:${C.chip};border-radius:14px;margin-top:16px}.facts td{padding:9px 12px;vertical-align:top;width:50%}.facts .k{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${C.muted}}.facts .v{font-size:14px;font-weight:600;margin-top:2px}
  .items{border:1px solid ${C.line};border-radius:12px;overflow:hidden;margin-top:8px}.items th{text-align:left;padding:8px 10px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:${C.muted};background:${C.chip}}.items td{padding:9px 10px;border-top:1px solid ${C.line};font-size:14px;vertical-align:top}.items .q{text-align:right;white-space:nowrap;font-weight:700}.items .s{font-size:12.5px;color:${C.muted};margin-top:2px}
  .sec{font-size:12px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:${C.muted};margin:20px 0 0}
  .stage{display:inline-block;margin-top:14px;padding:6px 12px;border-radius:999px;background:#e8f1fc;color:${C.primaryDark};font-size:12.5px;font-weight:700}
  .actions{padding:22px;display:grid;gap:14px;margin-top:8px;border-top:1px solid ${C.line};background:#fafbfd}
  form{margin:0;display:grid;gap:8px}label{font-size:12px;font-weight:700;color:${C.muted}}
  textarea,input{width:100%;box-sizing:border-box;border:1px solid ${C.line};border-radius:10px;padding:10px 12px;font:inherit;font-size:14px;background:#fff}
  button{appearance:none;border:0;border-radius:12px;padding:15px 18px;font:inherit;font-size:16px;font-weight:700;cursor:pointer;width:100%}
  .ok{background:${C.ok};color:#fff}.back{background:#fff;color:${C.warn};border:1.5px solid #fecdca}
  .result{padding:26px 22px;text-align:center}.result .big{font-size:22px;font-weight:800;letter-spacing:-.01em}.result .sub{margin-top:8px;color:${C.muted};font-size:14px}
  .foot{margin-top:16px;text-align:center;font-size:12px;line-height:18px;color:${C.muted}}.muted{color:${C.muted}}
  .err{margin:0 22px;padding:10px 12px;border-radius:10px;background:${C.warnBg};color:${C.warn};font-size:13.5px;font-weight:600}
  a.link{color:${C.primary};text-decoration:none;font-weight:600}
</style></head><body><div class="wrap">
  <div class="brand"><img src="${logo}" width="34" height="29" alt="">Greencore&nbsp;<span>Procurement</span></div>
  <div class="card"><div class="bar"></div>
    <div class="pad"><div class="eyebrow">${esc(eyebrow)}</div><h1>${esc(title)}${chip ? `<span class="chip" style="background:${chip.bg};color:${chip.fg}">${esc(chip.text)}</span>` : ''}</h1></div>
    ${inner}
  </div>
  <div class="foot">${esc(tr(lang, 'generatedBy'))}</div>
</div></body></html>`;
  return { status, html };
}
function reviewBody(lang, row, items, stage, user, errorMsg) {
  const factRows = [[tr(lang, 'department'), esc(row.department)], [tr(lang, 'requester'), esc(row.requested_by)], [tr(lang, 'category'), esc(CATEGORY_LABELS[row.category] || row.category)], [tr(lang, 'priority'), row.priority === 'Urgent' ? `<span style="color:${C.warn}">Urgent</span>${row.urgent_reason ? ` · ${esc(row.urgent_reason)}` : ''}` : esc(row.priority || 'Normal')], [tr(lang, 'budget'), esc(row.budget_type)], [tr(lang, 'required'), fmtDate(row.required_date)]];
  let facts = '';
  for (let i = 0; i < factRows.length; i += 2) facts += `<tr><td><div class="k">${esc(factRows[i][0])}</div><div class="v">${factRows[i][1] || '-'}</div></td><td><div class="k">${esc(factRows[i + 1][0])}</div><div class="v">${factRows[i + 1][1] || '-'}</div></td></tr>`;
  if (row.notes) facts += `<tr><td colspan="2" style="border-top:1px solid ${C.line}"><div class="k">${esc(tr(lang, 'purpose'))}</div><div class="v" style="font-weight:500">${esc(row.notes)}</div></td></tr>`;
  const trs = items.map((it, i) => `<tr><td class="muted" style="width:28px">${it.line_no || i + 1}</td><td><div style="font-weight:600">${esc(it.description)}</div>${it.specification ? `<div class="s">${esc(it.specification)}</div>` : ''}</td><td class="q">${fmtQty(it.qty)} <span class="muted" style="font-weight:500">${esc(it.unit)}</span></td></tr>`).join('');
  return `
    <div class="pad">
      <p>${tr(lang, 'intro', { requester: esc(row.requested_by), department: esc(row.department), stage: esc(stage.label) })}</p>
      <div class="stage">${esc(tr(lang, 'stageOf', { n: stage.n, total: stage.total }))} · ${esc(stage.label)}</div>
      <table class="facts">${facts}</table>
      <div class="sec">${esc(tr(lang, 'items', { n: items.length }))}</div>
      <table class="items"><tr><th>${esc(tr(lang, 'no'))}</th><th>${esc(tr(lang, 'description'))}</th><th style="text-align:right">${esc(tr(lang, 'qty'))}</th></tr>${trs}</table>
      <p class="muted" style="font-size:12.5px;margin:14px 0 18px">${esc(tr(lang, 'asUser', { name: user.name }))}</p>
    </div>
    ${errorMsg ? `<div class="err">${esc(errorMsg)}</div>` : ''}
    <div class="actions">
      <form method="post" onsubmit="return confirm(${JSON.stringify(tr(lang, 'confirmApprove', { pr: row.pr_no }))})">
        <input type="hidden" name="action" value="approve">
        <label>${esc(tr(lang, 'approveHint'))}</label><input name="note" maxlength="300" autocomplete="off">
        <button class="ok" type="submit">✓ ${esc(tr(lang, 'approve'))}</button>
      </form>
      <form method="post" onsubmit="return confirm(${JSON.stringify(tr(lang, 'confirmReject', { pr: row.pr_no }))})">
        <input type="hidden" name="action" value="reject">
        <label>${esc(tr(lang, 'sendBackHint'))}</label><textarea name="reason" rows="2" maxlength="500" required></textarea>
        <button class="back" type="submit">↩ ${esc(tr(lang, 'sendBack'))}</button>
      </form>
    </div>`;
}
function resultBody(big, sub, extra) {
  return `<div class="result"><div class="big">${big}</div>${sub ? `<div class="sub">${sub}</div>` : ''}${extra ? `<div class="sub" style="margin-top:14px">${extra}</div>` : ''}</div>`;
}

module.exports = { tr, langOf, loadItems, userById, findToken, markUsed, notifyStage, afterTransition, page, reviewBody, resultBody, esc, CATEGORY_LABELS, C };
