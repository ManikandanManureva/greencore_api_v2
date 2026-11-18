'use strict';
/**
 * Auto-draft purchase request: when an issue or write-off takes an item to or below its minimum
 * stock and no open PB already covers it, a Draft PB is created for the department that owns the
 * category. Nobody is forced to buy — the requester reviews, edits and submits the draft, or
 * deletes it. Callers pass auto_pb: false on the transaction body to opt out.
 */
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
function prNumber(seq, date) {
  const d = date ? new Date(date) : new Date();
  return `${String(seq).padStart(3, '0')}/PB/NB/GRI/${ROMAN[d.getMonth()]}/${String(d.getFullYear()).slice(-2)}`;
}

/**
 * @param client pg client inside the caller's transaction
 * @param req    express request (actor)
 * @param item   { source: 'part'|'spare_part', source_id, code, description, unit, stock, min, category? }
 * @param sourceDoc short reference of the transaction that triggered the check, e.g. 'OUT-0012'
 * @returns {Promise<{id:number, pr_no:string}|null>} the created draft, or null when nothing was needed
 */
async function maybeAutoDraftPb(client, req, item, sourceDoc) {
  const min = Number(item.min);
  const stock = Number(item.stock);
  if (!(min > 0) || !(stock <= min)) return null;
  const tables = await client.query(`SELECT to_regclass('public.proc_requests') AS t`);
  if (!tables.rows[0].t) return null;

  // An open PB (anything not finished) that already asks for this item → no second draft.
  const open = await client.query(
    `SELECT r.pr_no FROM proc_requests r JOIN proc_request_items i ON i.request_id = r.id
     WHERE r.status NOT IN ('completed','rejected','cancelled') AND i.source = $1 AND i.source_id = $2 LIMIT 1`,
    [item.source, item.source_id],
  );
  if (open.rows.length) return null;

  const category = item.category || (item.source === 'spare_part' ? 'Sparepart' : 'Packaging');
  const dept = await client.query(
    `SELECT name FROM proc_departments WHERE is_active = true ORDER BY (default_category = $1) DESC, id LIMIT 1`, [category]);
  const department = dept.rows.length ? dept.rows[0].name : 'General';
  const today = new Date().toISOString().slice(0, 10);
  const actor = (req.user && (req.user.name || req.user.employeeId)) || 'System';

  await client.query('LOCK TABLE proc_requests IN SHARE ROW EXCLUSIVE MODE');
  const d = new Date(today);
  const cnt = await client.query(
    `SELECT COALESCE(MAX((regexp_match(pr_no, '(\\d{3})/PB/NB/GRI/'))[1]::int), 0) AS n FROM proc_requests WHERE pr_no LIKE $1`,
    [`%/PB/NB/GRI/${ROMAN[d.getMonth()]}/${String(d.getFullYear()).slice(-2)}%`]);
  let seq = cnt.rows[0].n + 1;
  let prNo = prNumber(seq, today);
  for (let tries = 0; tries < 100; tries += 1) {
    const dup = await client.query('SELECT 1 FROM proc_requests WHERE pr_no = $1', [prNo]);
    if (!dup.rows.length) break;
    seq += 1; prNo = prNumber(seq, today);
  }
  const suggested = Math.max(min * 2 - stock, 1);
  const reason = `Stock ${stock} ${item.unit || ''} at or below minimum ${min} after ${sourceDoc}`.trim();
  const r = await client.query(
    `INSERT INTO proc_requests (pr_no, pr_date, department, category, requested_by_id, requested_by, priority, urgent_reason, budget_type, notes, status, is_auto, source_doc, "createdBy", "updatedBy")
     VALUES ($1,$2,$3,$4,$5,$6,'Urgent',$7,'OPEX',$8,'draft',true,$9,$10,$10) RETURNING id, pr_no`,
    [prNo, today, department, category, (req.user && req.user.id) || null, 'Auto low-stock trigger', reason, `Auto-draft from ${sourceDoc}. Review the quantity, then submit.`, sourceDoc, actor],
  );
  const row = r.rows[0];
  await client.query(
    `INSERT INTO proc_request_items (request_id, line_no, source, source_id, item_code, description, qty, unit, min_stock, stock_at_request)
     VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [row.id, item.source, item.source_id, item.code || null, item.description || item.code || 'Item', suggested, item.unit || 'Pcs', min, stock],
  );
  await client.query(
    `INSERT INTO proc_request_history (request_id, action, from_status, to_status, note, actor, actor_role)
     VALUES ($1, 'created', NULL, 'draft', $2, $3, 'System')`,
    [row.id, `Auto-draft — ${reason}`, actor],
  );
  return row;
}

module.exports = { maybeAutoDraftPb };
