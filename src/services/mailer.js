/**
 * Outbound email. Same Gmail account and variable names as the slot-booking backend, so the
 * credentials can simply be copied across:
 *
 *   EMAIL_USRNAME  Gmail address used to send (SMTP user)
 *   EMAIL_PWD      its Gmail App Password
 *   EMAIL_FROM     optional display name (default "Greencore Procurement"); the address is EMAIL_USRNAME
 *
 * Optional overrides for another provider: SMTP_HOST (default smtp.gmail.com), SMTP_PORT (587),
 * SMTP_SECURE ("true" for 465), SMTP_USER / SMTP_PASS, MAIL_FROM (full "Name <addr>").
 * APP_URL is the public dashboard origin (default https://dashboard.greencoreresources.com).
 * MAIL_PREVIEW_DIR (dev) also writes every message as .html; SMTP_HOST=json sends nothing.
 *
 * Nothing here throws into request handlers: a failed send is logged and reported as false.
 */
const fs = require('fs');
const path = require('path');
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (err) { /* dependency missing → mail disabled */ }

const DEFAULT_APP_URL = 'https://dashboard.greencoreresources.com';
let transport = null;

function config() {
  const user = process.env.SMTP_USER || process.env.EMAIL_USRNAME || '';
  const pass = process.env.SMTP_PASS || process.env.EMAIL_PWD || '';
  const fromName = process.env.EMAIL_FROM && !/[<@]/.test(process.env.EMAIL_FROM) ? process.env.EMAIL_FROM : 'Greencore Procurement';
  const from = process.env.MAIL_FROM || (process.env.EMAIL_FROM && /[<@]/.test(process.env.EMAIL_FROM) ? process.env.EMAIL_FROM : (user ? `"${fromName}" <${user}>` : ''));
  return {
    host: process.env.SMTP_HOST || (user ? 'smtp.gmail.com' : ''),
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
    user, pass, from,
    appUrl: String(process.env.APP_URL || DEFAULT_APP_URL).replace(/\/+$/, ''),
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
    tls: { rejectUnauthorized: false },
    // Bounded like the slot-booking transporter so a flaky Gmail connection fails fast.
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
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
