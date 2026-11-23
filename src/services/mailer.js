/**
 * Outbound email. Configured entirely from the environment so the same build runs with or
 * without a mail account:
 *
 *   SMTP_HOST      e.g. email-smtp.ap-southeast-1.amazonaws.com or smtp.gmail.com
 *   SMTP_PORT      587 (STARTTLS, default) or 465 (SMTP_SECURE=true)
 *   SMTP_SECURE    "true" for port 465
 *   SMTP_USER / SMTP_PASS
 *   MAIL_FROM      "Greencore Procurement <noreply@greencoreresources.com>"
 *   APP_URL        public dashboard origin, e.g. https://dashboard.greencoreresources.com
 *   MAIL_PREVIEW_DIR  (dev) also write every message as .html into this folder
 *
 * Nothing here throws into request handlers: a failed send is logged and reported as false.
 */
const fs = require('fs');
const path = require('path');
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (err) { /* dependency missing → mail disabled */ }

let transport = null;

function config() {
  return {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || '',
    appUrl: String(process.env.APP_URL || '').replace(/\/+$/, ''),
    previewDir: process.env.MAIL_PREVIEW_DIR || '',
  };
}

function mailEnabled() {
  const c = config();
  return !!(nodemailer && c.host && c.from && c.appUrl);
}

function getTransport() {
  if (transport) return transport;
  const c = config();
  if (c.host === 'json') { transport = nodemailer.createTransport({ jsonTransport: true }); return transport; }
  transport = nodemailer.createTransport({
    host: c.host, port: c.port, secure: c.secure,
    auth: c.user ? { user: c.user, pass: c.pass } : undefined,
    pool: true, maxConnections: 2,
  });
  return transport;
}

async function sendMail({ to, subject, html, text }) {
  const c = config();
  if (c.previewDir) {
    try {
      fs.mkdirSync(c.previewDir, { recursive: true });
      const name = `${Date.now()}-${String(subject).replace(/[^a-z0-9]+/gi, '_').slice(0, 60)}.html`;
      fs.writeFileSync(path.join(c.previewDir, name), `<!-- to: ${to} -->\n${html}`);
    } catch (err) { console.error('Mail preview write failed:', err.message); }
  }
  if (!mailEnabled()) return { ok: false, reason: 'Mail is not configured on this server.' };
  try {
    await getTransport().sendMail({ from: c.from, to, subject, html, text });
    return { ok: true };
  } catch (err) {
    console.error(`Mail to ${to} failed:`, err.message);
    return { ok: false, reason: err.message };
  }
}

module.exports = { mailEnabled, sendMail, mailConfig: config };
