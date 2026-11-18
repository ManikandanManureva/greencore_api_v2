/**
 * Clean-up for the Google Form PB import (18 Nov 2026): the form had ONE sample photo per PB, but
 * the client's upload format repeated that link on item lines, so the same URL ended up both in
 * the request's "Attachments:" note and in each line's specification. Keep it once, at request
 * level, and drop it from the lines. Only touches imported requests (source_doc = 'GFORM').
 * Idempotent.
 */
require('dotenv').config();
const pool = require('../config/database');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rows = await client.query(
      `SELECT i.id, i.specification, r.notes FROM proc_request_items i JOIN proc_requests r ON r.id = i.request_id
       WHERE r.source_doc = 'GFORM' AND i.specification LIKE '%Sample: http%'`);
    let cleaned = 0;
    for (const x of rows.rows) {
      const m = x.specification.match(/\n?Sample: (https?:\/\/\S+)\s*$/);
      if (!m) continue;
      const url = m[1];
      const notes = x.notes || '';
      // make sure the request keeps the link once
      const newNotes = notes.includes(url) ? notes : `${notes}${notes ? '\n' : ''}Attachments: ${url}`;
      const spec = x.specification.replace(m[0], '').trim() || null;
      await client.query('UPDATE proc_request_items SET specification = $2 WHERE id = $1', [x.id, spec]);
      if (newNotes !== notes) await client.query('UPDATE proc_requests SET notes = $2 WHERE id = (SELECT request_id FROM proc_request_items WHERE id = $1)', [x.id, newNotes]);
      cleaned += 1;
    }
    await client.query('COMMIT');
    console.log(`✓ imported sample links tidied on ${cleaned} line(s)`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('✗ fix-imported-sample-links failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
