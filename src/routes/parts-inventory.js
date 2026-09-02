'use strict';
const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

const ALLOWED_ROLES = ['ppic', 'super_admin', 'admin'];

function requireRole(req, res, next) {
  const role = String(req.user && req.user.role ? req.user.role : '').toLowerCase();
  if (!ALLOWED_ROLES.includes(role))
    return res.status(403).json({ success: false, message: 'Not authorized to access Parts Inventory' });
  next();
}

router.use(authenticateToken, requireRole);

function paginate(query) {
  const page = Math.max(1, parseInt(query.page) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(query.limit) || 20));
  return { limit, offset: (page - 1) * limit };
}

// Accept DD-MM-YYYY (from frontend display format) or YYYY-MM-DD (ISO); always return YYYY-MM-DD for DB.
function parseDate(val) {
  if (!val) return null;
  const s = String(val).trim();
  if (/^\d{2}-\d{2}-\d{4}$/.test(s)) {
    const [dd, mm, yyyy] = s.split('-');
    return `${yyyy}-${mm}-${dd}`;
  }
  return s; // already YYYY-MM-DD or ISO
}

async function availableQty(client, partId) {
  const r = await client.query(`
    SELECT
      COALESCE((SELECT SUM(quantity_received) FROM parts_stock_in        WHERE part_id=$1),0)
    + COALESCE((SELECT SUM(variance)           FROM parts_stock_correction WHERE part_id=$1 AND status='approved'),0)
    - COALESCE((SELECT SUM(quantity_sent)       FROM parts_outgoing         WHERE part_id=$1 AND status IN ('issued','received')),0)
    - COALESCE((SELECT SUM(quantity_affected)   FROM parts_damage_waste     WHERE part_id=$1 AND status='approved'),0)
    AS qty
  `, [partId]);
  return parseFloat(r.rows[0].qty) || 0;
}

async function writeLedger(client, { date, type, refId, partId, partCode, partDesc, qtyIn, qtyOut, balance, by, notes }) {
  await client.query(`
    INSERT INTO parts_stock_ledger
      (transaction_date, transaction_type, reference_id, part_id, part_code, part_description,
       quantity_in, quantity_out, balance_after, performed_by, notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
  `, [date, type, refId, partId, partCode, partDesc,
      qtyIn != null ? qtyIn : null,
      qtyOut != null ? qtyOut : null,
      balance, by, notes ?? null]);
}

async function partInfo(client, partId) {
  const r = await client.query('SELECT code, description, uom FROM pm_item WHERE id=$1', [partId]);
  if (!r.rows.length) {
    const err = new Error('Part not found');
    err.status = 404;
    throw err;
  }
  return r.rows[0];
}

// ─── 1. Available Stock ────────────────────────────────────────────────────────
router.get('/available-stock', async (req, res) => {
  try {
    const { search, status, sort, order } = req.query;
    const SORT_MAP = {
      available_quantity: 'available_quantity',
      reserved_quantity: 'reserved_quantity',
      damaged_quantity: 'damaged_quantity',
    };
    const sortCol = SORT_MAP[sort] || 'part_code';
    const sortDir = order === 'desc' ? 'DESC' : 'ASC';

    const params = [];
    let searchCond = '';
    if (search && String(search).trim()) {
      params.push(`%${String(search).trim()}%`);
      searchCond = `AND (p.code ILIKE $${params.length} OR p.description ILIKE $${params.length})`;
    }

    let statusCond = '';
    if (status && ['normal', 'low', 'out_of_stock', 'overstock'].includes(status)) {
      params.push(status);
      statusCond = `WHERE status = $${params.length}`;
    }

    const sql = `
      WITH si AS (
        SELECT part_id, SUM(quantity_received) AS total_in
        FROM parts_stock_in GROUP BY part_id
      ), co AS (
        SELECT part_id, SUM(variance) AS total_correction
        FROM parts_stock_correction WHERE status = 'approved' GROUP BY part_id
      ), og AS (
        SELECT part_id, SUM(quantity_sent) AS total_out
        FROM parts_outgoing WHERE status IN ('issued','received') GROUP BY part_id
      ), rs AS (
        SELECT part_id, SUM(quantity_sent) AS total_reserved
        FROM parts_outgoing WHERE status = 'issued' GROUP BY part_id
      ), dw AS (
        SELECT part_id,
          SUM(CASE WHEN incident_type = 'damaged' THEN quantity_affected ELSE 0 END) AS total_damaged,
          SUM(CASE WHEN incident_type IN ('wasted','lost') THEN quantity_affected ELSE 0 END) AS total_wasted,
          SUM(quantity_affected) AS total_damage
        FROM parts_damage_waste WHERE status = 'approved' GROUP BY part_id
      ), lc AS (
        SELECT part_id, MAX(correction_date) AS last_counted_date
        FROM parts_stock_correction GROUP BY part_id
      ), base AS (
        SELECT
          p.id AS part_id, p.code AS part_code, p.description AS part_description,
          p.category, p.uom, p.reorder_level,
          (COALESCE(si.total_in,0) + COALESCE(co.total_correction,0)
           - COALESCE(og.total_out,0) - COALESCE(dw.total_damage,0)) AS available_quantity,
          COALESCE(rs.total_reserved,0) AS reserved_quantity,
          COALESCE(dw.total_damaged,0) AS damaged_quantity,
          COALESCE(dw.total_wasted,0) AS wasted_quantity,
          lc.last_counted_date
        FROM pm_item p
        LEFT JOIN si ON si.part_id = p.id
        LEFT JOIN co ON co.part_id = p.id
        LEFT JOIN og ON og.part_id = p.id
        LEFT JOIN rs ON rs.part_id = p.id
        LEFT JOIN dw ON dw.part_id = p.id
        LEFT JOIN lc ON lc.part_id = p.id
        WHERE p.is_active = true ${searchCond}
      ), with_status AS (
        SELECT
          part_id AS id, part_id, part_code, part_description, category, uom,
          available_quantity, reserved_quantity, damaged_quantity, wasted_quantity,
          reorder_level, last_counted_date,
          CASE
            WHEN available_quantity <= 0 THEN 'out_of_stock'
            WHEN available_quantity <= reorder_level THEN 'low'
            WHEN reorder_level > 0 AND available_quantity > 5 * reorder_level THEN 'overstock'
            ELSE 'normal'
          END AS status
        FROM base
      )
      SELECT * FROM with_status
      ${statusCond}
      ORDER BY ${sortCol} ${sortDir}
    `;

    const result = await pool.query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('Available stock error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load available stock' });
  }
});

// ─── 2. Stock IN ──────────────────────────────────────────────────────────────
router.get('/stock-in', async (req, res) => {
  try {
    const { search, status } = req.query;
    const { limit, offset } = paginate(req.query);
    const params = [];
    const conds = [];
    if (search && String(search).trim()) {
      params.push(`%${String(search).trim()}%`);
      conds.push(`(part_code ILIKE $${params.length} OR part_description ILIKE $${params.length} OR supplier_name ILIKE $${params.length})`);
    }
    if (status && ['pending', 'verified', 'rejected'].includes(status)) {
      params.push(status);
      conds.push(`status = $${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const countRes = await pool.query(`SELECT COUNT(*) FROM parts_stock_in ${where}`, params);
    const total = parseInt(countRes.rows[0].count);
    params.push(limit); params.push(offset);
    const result = await pool.query(
      `SELECT *,
              TO_CHAR(entry_date, 'DD-MM-YYYY') AS entry_date,
              COALESCE(quantity_received * unit_price, 0) AS total_price
       FROM parts_stock_in ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json({ success: true, data: result.rows, total });
  } catch (err) {
    console.error('Stock-in list error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load stock-in records' });
  }
});

router.post('/stock-in', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { purchase_order_id, supplier_name, part_id, quantity_received, unit_price, notes } = req.body || {};
    const entry_date = parseDate(req.body.entry_date);
    const received_by = req.body.received_by || (req.user && req.user.name) || 'system';
    if (!entry_date || !supplier_name || !part_id || !quantity_received)
      return res.status(400).json({ success: false, message: 'entry_date, supplier_name, part_id, quantity_received are required' });
    const qty = parseFloat(quantity_received);
    if (isNaN(qty) || qty <= 0)
      return res.status(400).json({ success: false, message: 'quantity_received must be a positive number' });
    const part = await partInfo(client, part_id);
    const r = await client.query(`
      INSERT INTO parts_stock_in
        (purchase_order_id, entry_date, supplier_name, part_id, part_code, part_description, uom,
         quantity_received, unit_price, received_by, notes, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'verified')
      RETURNING *
    `, [purchase_order_id || null, entry_date, supplier_name, part_id, part.code, part.description,
        part.uom, qty, unit_price || null, received_by, notes || null]);
    const inserted = r.rows[0];
    const bal = await availableQty(client, part_id);
    await writeLedger(client, {
      date: entry_date, type: 'stock_in',
      refId: `SI-${String(inserted.id).padStart(4, '0')}`,
      partId: part_id, partCode: part.code, partDesc: part.description,
      qtyIn: qty, qtyOut: null,
      balance: bal, by: received_by, notes: notes || null,
    });
    await client.query('COMMIT');
    res.json({ success: true, data: inserted });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.status === 404) return res.status(404).json({ success: false, message: err.message });
    console.error('Stock-in create error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create stock-in record' });
  } finally { client.release(); }
});

router.put('/stock-in/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = parseInt(req.params.id);
    const existing = await client.query('SELECT * FROM parts_stock_in WHERE id=$1', [id]);
    if (!existing.rows.length)
      return res.status(404).json({ success: false, message: 'Record not found' });
    const prev = existing.rows[0];
    const body = req.body || {};
    const sets = []; const vals = [];
    for (const f of ['purchase_order_id', 'entry_date', 'supplier_name', 'quantity_received', 'unit_price', 'received_by', 'notes', 'status']) {
      if (body[f] !== undefined) { vals.push(body[f] === '' ? null : body[f]); sets.push(`${f}=$${vals.length}`); }
    }
    if (!sets.length) return res.status(400).json({ success: false, message: 'No fields to update' });
    sets.push('updated_at=NOW()'); vals.push(id);
    const r = await client.query(
      `UPDATE parts_stock_in SET ${sets.join(',')} WHERE id=$${vals.length} RETURNING *`, vals,
    );
    const updated = r.rows[0];
    await client.query('COMMIT');
    res.json({ success: true, data: updated });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Stock-in update error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update stock-in record' });
  } finally { client.release(); }
});

// ─── 3. Stock Correction ──────────────────────────────────────────────────────
router.get('/stock-correction', async (req, res) => {
  try {
    const { search, status } = req.query;
    const { limit, offset } = paginate(req.query);
    const params = [];
    const conds = [];
    if (search && String(search).trim()) {
      params.push(`%${String(search).trim()}%`);
      conds.push(`(part_code ILIKE $${params.length} OR part_description ILIKE $${params.length})`);
    }
    if (status && ['pending', 'approved', 'rejected'].includes(status)) {
      params.push(status); conds.push(`status=$${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const countRes = await pool.query(`SELECT COUNT(*) FROM parts_stock_correction ${where}`, params);
    const total = parseInt(countRes.rows[0].count);
    params.push(limit); params.push(offset);
    const result = await pool.query(
      `SELECT * FROM parts_stock_correction ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json({ success: true, data: result.rows, total });
  } catch (err) {
    console.error('Stock-correction list error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load stock correction records' });
  }
});

router.post('/stock-correction', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { part_id, current_stock, counted_stock, reason, notes } = req.body || {};
    const correction_date = parseDate(req.body.correction_date);
    const corrected_by = req.body.corrected_by || (req.user && req.user.name) || 'system';
    if (!correction_date || part_id == null || current_stock == null || counted_stock == null || !reason)
      return res.status(400).json({ success: false, message: 'correction_date, part_id, current_stock, counted_stock, reason are required' });
    const part = await partInfo(client, part_id);
    const curr = parseFloat(current_stock);
    const counted = parseFloat(counted_stock);
    const variance = counted - curr;
    const r = await client.query(`
      INSERT INTO parts_stock_correction
        (correction_date, part_id, part_code, part_description, uom,
         current_stock, counted_stock, variance, reason, corrected_by, notes, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending')
      RETURNING *
    `, [correction_date, part_id, part.code, part.description, part.uom,
        curr, counted, variance, reason, corrected_by, notes || null]);
    await client.query('COMMIT');
    res.json({ success: true, data: r.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.status === 404) return res.status(404).json({ success: false, message: err.message });
    console.error('Stock-correction create error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create stock correction' });
  } finally { client.release(); }
});

router.put('/stock-correction/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = parseInt(req.params.id);
    const existing = await client.query('SELECT * FROM parts_stock_correction WHERE id=$1', [id]);
    if (!existing.rows.length)
      return res.status(404).json({ success: false, message: 'Record not found' });
    const prev = existing.rows[0];
    const body = req.body || {};
    if (body.correction_date) body.correction_date = parseDate(body.correction_date);
    const sets = []; const vals = [];
    for (const f of ['correction_date', 'current_stock', 'counted_stock', 'reason', 'corrected_by', 'notes', 'status']) {
      if (body[f] !== undefined) { vals.push(body[f] === '' ? null : body[f]); sets.push(`${f}=$${vals.length}`); }
    }
    // Recalculate variance whenever either stock value changes
    if (body.current_stock !== undefined || body.counted_stock !== undefined) {
      const newCurr = body.current_stock !== undefined ? parseFloat(body.current_stock) : parseFloat(prev.current_stock);
      const newCounted = body.counted_stock !== undefined ? parseFloat(body.counted_stock) : parseFloat(prev.counted_stock);
      vals.push(newCounted - newCurr); sets.push(`variance=$${vals.length}`);
    }
    if (!sets.length) return res.status(400).json({ success: false, message: 'No fields to update' });
    sets.push('updated_at=NOW()'); vals.push(id);
    const r = await client.query(
      `UPDATE parts_stock_correction SET ${sets.join(',')} WHERE id=$${vals.length} RETURNING *`, vals,
    );
    const updated = r.rows[0];
    if (prev.status !== 'approved' && updated.status === 'approved') {
      const variance = parseFloat(updated.variance);
      const bal = await availableQty(client, updated.part_id);
      await writeLedger(client, {
        date: updated.correction_date, type: 'correction',
        refId: `COR-${String(id).padStart(4, '0')}`,
        partId: updated.part_id, partCode: updated.part_code, partDesc: updated.part_description,
        qtyIn: variance > 0 ? variance : null,
        qtyOut: variance < 0 ? Math.abs(variance) : null,
        balance: bal, by: updated.corrected_by, notes: updated.notes,
      });
    }
    await client.query('COMMIT');
    res.json({ success: true, data: updated });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Stock-correction update error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update stock correction' });
  } finally { client.release(); }
});

// ─── 4. Outgoing ──────────────────────────────────────────────────────────────
router.get('/outgoing', async (req, res) => {
  try {
    const { search, status, purpose } = req.query;
    const { limit, offset } = paginate(req.query);
    const params = [];
    const conds = [];
    if (search && String(search).trim()) {
      params.push(`%${String(search).trim()}%`);
      conds.push(`(part_code ILIKE $${params.length} OR part_description ILIKE $${params.length} OR reference_id ILIKE $${params.length} OR destination ILIKE $${params.length})`);
    }
    if (status && ['issued', 'received', 'cancelled'].includes(status)) {
      params.push(status); conds.push(`status=$${params.length}`);
    }
    if (purpose && ['production', 'sale', 'sample', 'return', 'other'].includes(purpose)) {
      params.push(purpose); conds.push(`purpose=$${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const countRes = await pool.query(`SELECT COUNT(*) FROM parts_outgoing ${where}`, params);
    const total = parseInt(countRes.rows[0].count);
    params.push(limit); params.push(offset);
    const result = await pool.query(
      `SELECT * FROM parts_outgoing ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json({ success: true, data: result.rows, total });
  } catch (err) {
    console.error('Outgoing list error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load outgoing records' });
  }
});

router.post('/outgoing', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { reference_id, part_id, quantity_sent, destination, purpose, received_by, notes } = req.body || {};
    const outgoing_date = parseDate(req.body.outgoing_date);
    const issued_by = req.body.issued_by || (req.user && req.user.name) || 'system';
    if (!outgoing_date || !part_id || !quantity_sent || !purpose)
      return res.status(400).json({ success: false, message: 'outgoing_date, part_id, quantity_sent, purpose are required' });
    if (!['production', 'sale', 'sample', 'return', 'other'].includes(purpose))
      return res.status(400).json({ success: false, message: 'purpose must be one of: production, sale, sample, return, other' });
    const qty = parseFloat(quantity_sent);
    if (isNaN(qty) || qty <= 0)
      return res.status(400).json({ success: false, message: 'quantity_sent must be a positive number' });
    const part = await partInfo(client, part_id);
    const currentQty = await availableQty(client, part_id);
    if (qty > currentQty)
      return res.status(400).json({ success: false, message: `Insufficient stock. Available: ${currentQty}, Requested: ${qty}` });
    const r = await client.query(`
      INSERT INTO parts_outgoing
        (outgoing_date, reference_id, part_id, part_code, part_description, uom,
         quantity_sent, destination, purpose, issued_by, received_by, notes, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'issued')
      RETURNING *
    `, [outgoing_date, reference_id || null, part_id, part.code, part.description, part.uom,
        qty, destination || null, purpose, issued_by, received_by || null, notes || null]);
    const inserted = r.rows[0];
    const bal = await availableQty(client, part_id);
    await writeLedger(client, {
      date: outgoing_date, type: 'outgoing',
      refId: `OUT-${String(inserted.id).padStart(4, '0')}`,
      partId: part_id, partCode: part.code, partDesc: part.description,
      qtyIn: null, qtyOut: qty,
      balance: bal, by: issued_by, notes: notes || null,
    });
    await client.query('COMMIT');
    res.json({ success: true, data: inserted });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.status === 404) return res.status(404).json({ success: false, message: err.message });
    console.error('Outgoing create error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create outgoing record' });
  } finally { client.release(); }
});

router.put('/outgoing/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = parseInt(req.params.id);
    const existing = await client.query('SELECT * FROM parts_outgoing WHERE id=$1', [id]);
    if (!existing.rows.length)
      return res.status(404).json({ success: false, message: 'Record not found' });
    const prev = existing.rows[0];
    const body = req.body || {};
    if (body.outgoing_date) body.outgoing_date = parseDate(body.outgoing_date);
    const sets = []; const vals = [];
    for (const f of ['outgoing_date', 'reference_id', 'quantity_sent', 'destination', 'purpose', 'issued_by', 'received_by', 'notes', 'status']) {
      if (body[f] !== undefined) { vals.push(body[f] === '' ? null : body[f]); sets.push(`${f}=$${vals.length}`); }
    }
    if (!sets.length) return res.status(400).json({ success: false, message: 'No fields to update' });
    sets.push('updated_at=NOW()'); vals.push(id);
    const r = await client.query(
      `UPDATE parts_outgoing SET ${sets.join(',')} WHERE id=$${vals.length} RETURNING *`, vals,
    );
    const updated = r.rows[0];
    // Cancelled: restore quantity
    if (prev.status !== 'cancelled' && updated.status === 'cancelled') {
      const qty = parseFloat(prev.quantity_sent);
      const bal = await availableQty(client, updated.part_id);
      await writeLedger(client, {
        date: updated.outgoing_date, type: 'outgoing',
        refId: `OUT-${String(id).padStart(4, '0')}-VOID`,
        partId: updated.part_id, partCode: updated.part_code, partDesc: updated.part_description,
        qtyIn: qty, qtyOut: null,
        balance: bal, by: updated.issued_by, notes: 'Cancellation — stock restored',
      });
    }
    await client.query('COMMIT');
    res.json({ success: true, data: updated });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Outgoing update error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update outgoing record' });
  } finally { client.release(); }
});

// ─── 5. Damage & Waste ────────────────────────────────────────────────────────
router.get('/damage-waste', async (req, res) => {
  try {
    const { search, status, incident_type } = req.query;
    const { limit, offset } = paginate(req.query);
    const params = [];
    const conds = [];
    if (search && String(search).trim()) {
      params.push(`%${String(search).trim()}%`);
      conds.push(`(part_code ILIKE $${params.length} OR part_description ILIKE $${params.length} OR location ILIKE $${params.length})`);
    }
    if (status && ['reported', 'approved', 'rejected'].includes(status)) {
      params.push(status); conds.push(`status=$${params.length}`);
    }
    if (incident_type && ['damaged', 'wasted', 'lost'].includes(incident_type)) {
      params.push(incident_type); conds.push(`incident_type=$${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const countRes = await pool.query(`SELECT COUNT(*) FROM parts_damage_waste ${where}`, params);
    const total = parseInt(countRes.rows[0].count);
    params.push(limit); params.push(offset);
    const result = await pool.query(
      `SELECT * FROM parts_damage_waste ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json({ success: true, data: result.rows, total });
  } catch (err) {
    console.error('Damage-waste list error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load damage/waste records' });
  }
});

router.post('/damage-waste', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { part_id, quantity_affected, incident_type, root_cause, location, approver, notes } = req.body || {};
    const incident_date = parseDate(req.body.incident_date);
    const reported_by = req.body.reported_by || (req.user && req.user.name) || 'system';
    if (!incident_date || !part_id || !quantity_affected || !incident_type || !root_cause || !location)
      return res.status(400).json({ success: false, message: 'incident_date, part_id, quantity_affected, incident_type, root_cause, location are required' });
    if (!['damaged', 'wasted', 'lost'].includes(incident_type))
      return res.status(400).json({ success: false, message: 'incident_type must be damaged, wasted, or lost' });
    const qty = parseFloat(quantity_affected);
    if (isNaN(qty) || qty <= 0)
      return res.status(400).json({ success: false, message: 'quantity_affected must be a positive number' });
    const part = await partInfo(client, part_id);
    const r = await client.query(`
      INSERT INTO parts_damage_waste
        (incident_date, part_id, part_code, part_description, uom,
         quantity_affected, incident_type, root_cause, location, reported_by, approver, notes, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'reported')
      RETURNING *
    `, [incident_date, part_id, part.code, part.description, part.uom,
        qty, incident_type, root_cause, location, reported_by, approver || null, notes || null]);
    await client.query('COMMIT');
    res.json({ success: true, data: r.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.status === 404) return res.status(404).json({ success: false, message: err.message });
    console.error('Damage-waste create error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create damage/waste record' });
  } finally { client.release(); }
});

router.put('/damage-waste/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = parseInt(req.params.id);
    const existing = await client.query('SELECT * FROM parts_damage_waste WHERE id=$1', [id]);
    if (!existing.rows.length)
      return res.status(404).json({ success: false, message: 'Record not found' });
    const prev = existing.rows[0];
    const body = req.body || {};
    if (body.incident_date) body.incident_date = parseDate(body.incident_date);
    const sets = []; const vals = [];
    for (const f of ['incident_date', 'quantity_affected', 'incident_type', 'root_cause', 'location', 'reported_by', 'approver', 'notes', 'status']) {
      if (body[f] !== undefined) { vals.push(body[f] === '' ? null : body[f]); sets.push(`${f}=$${vals.length}`); }
    }
    if (!sets.length) return res.status(400).json({ success: false, message: 'No fields to update' });
    sets.push('updated_at=NOW()'); vals.push(id);
    const r = await client.query(
      `UPDATE parts_damage_waste SET ${sets.join(',')} WHERE id=$${vals.length} RETURNING *`, vals,
    );
    const updated = r.rows[0];
    if (prev.status !== 'approved' && updated.status === 'approved') {
      const qty = parseFloat(updated.quantity_affected);
      const bal = await availableQty(client, updated.part_id);
      await writeLedger(client, {
        date: updated.incident_date, type: 'damage_waste',
        refId: `DW-${String(id).padStart(4, '0')}`,
        partId: updated.part_id, partCode: updated.part_code, partDesc: updated.part_description,
        qtyIn: null, qtyOut: qty,
        balance: bal, by: updated.reported_by,
        notes: `${updated.incident_type}: ${updated.root_cause}`,
      });
    }
    await client.query('COMMIT');
    res.json({ success: true, data: updated });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Damage-waste update error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update damage/waste record' });
  } finally { client.release(); }
});

// ─── 6. Stock Ledger ──────────────────────────────────────────────────────────
router.get('/stock-ledger', async (req, res) => {
  try {
    const { part_id, search, transaction_type, date_from, date_to } = req.query;
    const { limit, offset } = paginate(req.query);
    const params = [];
    const conds = [];
    if (part_id) { params.push(parseInt(part_id)); conds.push(`part_id=$${params.length}`); }
    if (search && String(search).trim()) {
      params.push(`%${String(search).trim()}%`);
      conds.push(`(part_code ILIKE $${params.length} OR part_description ILIKE $${params.length} OR reference_id ILIKE $${params.length})`);
    }
    if (transaction_type && ['stock_in', 'correction', 'outgoing', 'damage_waste'].includes(transaction_type)) {
      params.push(transaction_type); conds.push(`transaction_type=$${params.length}`);
    }
    if (date_from) { params.push(date_from); conds.push(`transaction_date >= $${params.length}`); }
    if (date_to) { params.push(date_to); conds.push(`transaction_date <= $${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const countRes = await pool.query(`SELECT COUNT(*) FROM parts_stock_ledger ${where}`, params);
    const total = parseInt(countRes.rows[0].count);
    params.push(limit); params.push(offset);
    const result = await pool.query(
      `SELECT * FROM parts_stock_ledger ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json({ success: true, data: result.rows, total });
  } catch (err) {
    console.error('Stock ledger error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load stock ledger' });
  }
});

// ─── 7. Module Counts (for hub page badges) ───────────────────────────────────
router.get('/counts', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM parts_stock_in)::int                                    AS stock_in_total,
        (SELECT COUNT(*) FROM parts_stock_in    WHERE status = 'pending')::int        AS stock_in_pending,
        (SELECT COUNT(*) FROM parts_stock_correction)::int                            AS correction_total,
        (SELECT COUNT(*) FROM parts_stock_correction WHERE status = 'pending')::int   AS correction_pending,
        (SELECT COUNT(*) FROM parts_outgoing)::int                                    AS outgoing_total,
        (SELECT COUNT(*) FROM parts_outgoing    WHERE status = 'issued')::int         AS outgoing_issued,
        (SELECT COUNT(*) FROM parts_damage_waste)::int                                AS damage_waste_total,
        (SELECT COUNT(*) FROM parts_damage_waste WHERE status = 'reported')::int      AS damage_waste_reported
    `);
    const r = result.rows[0];
    res.json({
      success: true,
      data: {
        stock_in:       { total: r.stock_in_total,      pending:  r.stock_in_pending },
        stock_correction: { total: r.correction_total,  pending:  r.correction_pending },
        outgoing:       { total: r.outgoing_total,      issued:   r.outgoing_issued },
        damage_waste:   { total: r.damage_waste_total,  reported: r.damage_waste_reported },
      },
    });
  } catch (err) {
    console.error('Parts counts error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load counts' });
  }
});

module.exports = router;
