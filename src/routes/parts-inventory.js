'use strict';
const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { requireModule } = require('../middleware/permissions');
const { POOLS, MOVEMENT_TYPES, poolForMovement, poolBalanceSql, poolQty, bothPools } = require('../services/stockPools');
const { maybeAutoDraftPb } = require('../services/autoDraftPb');

router.use(authenticateToken, requireModule('parts', 'Parts Inventory'));

function parsePool(v, fallback = 'SALES') { return POOLS.includes(String(v || '').toUpperCase()) ? String(v).toUpperCase() : fallback; }
// Movement type decides the pool an issue draws from; old clients still send only `purpose`.
function parseMovement(v, purpose) {
  const m = String(v || '').toUpperCase();
  if (MOVEMENT_TYPES.includes(m) && m !== 'LEGACY') return m;
  if (purpose === 'sale') return 'SALES_DISPATCH';
  if (purpose === 'return') return 'RETURN';
  if (purpose === 'production') return 'DAILY_MOVING';
  return 'SALES_DISPATCH';
}
async function resolveMachine(client, body) {
  const id = Number(body && body.machine_id) || null;
  if (id) {
    const r = await client.query('SELECT id, name FROM proc_machines WHERE id = $1', [id]);
    if (r.rows.length) return { machine_id: r.rows[0].id, machine_name: r.rows[0].name };
  }
  const name = String((body && body.machine_name) || '').trim().slice(0, 120) || null;
  return { machine_id: null, machine_name: name };
}
// After a SALES-pool deduction: draft a PB when the part sits at or below its reorder level.
async function autoPbForPart(client, req, partId, sourceDoc, optOut) {
  if (optOut === false) return null;
  const p = await client.query('SELECT id, code, description, uom, reorder_level FROM pm_item WHERE id = $1', [partId]);
  if (!p.rows.length) return null;
  const part = p.rows[0];
  const stock = await poolQty(client, partId, 'SALES');
  return maybeAutoDraftPb(client, req, { source: 'part', source_id: part.id, code: part.code, description: part.description, unit: part.uom, stock, min: Number(part.reorder_level) || 0, category: 'Packaging' }, sourceDoc);
}

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

// Balance of one pool (SALES = actual stock by default). See services/stockPools.js.
async function availableQty(client, partId, pool = 'SALES') {
  return poolQty(client, partId, pool);
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
        FROM parts_outgoing WHERE status = 'issued' AND movement_type <> 'RETURN' GROUP BY part_id
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
          ${poolBalanceSql('SALES', 'p.id')} AS available_quantity,
          ${poolBalanceSql('MOVING', 'p.id')} AS moving_quantity,
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
          available_quantity, moving_quantity, (available_quantity + moving_quantity) AS total_quantity,
          reserved_quantity, damaged_quantity, wasted_quantity,
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
    const pool_ = parsePool(req.body.pool);
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
         quantity_received, unit_price, received_by, notes, status, pool)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'verified',$12)
      RETURNING *
    `, [purchase_order_id || null, entry_date, supplier_name, part_id, part.code, part.description,
        part.uom, qty, unit_price || null, received_by, notes || null, pool_]);
    const inserted = r.rows[0];
    const bal = await availableQty(client, part_id, pool_);
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

router.delete('/stock-in/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM parts_stock_in WHERE id=$1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'Record not found' });
    res.json({ success: true, message: 'Record deleted' });
  } catch (err) {
    console.error('Stock-in delete error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete stock-in record' });
  }
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
    const pool_ = parsePool(req.body.pool);
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
         current_stock, counted_stock, variance, reason, corrected_by, notes, status, pool)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12)
      RETURNING *
    `, [correction_date, part_id, part.code, part.description, part.uom,
        curr, counted, variance, reason, corrected_by, notes || null, pool_]);
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

router.delete('/stock-correction/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM parts_stock_correction WHERE id=$1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'Record not found' });
    res.json({ success: true, message: 'Record deleted' });
  } catch (err) {
    console.error('Stock-correction delete error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete stock correction' });
  }
});

// ─── 4. Outgoing ──────────────────────────────────────────────────────────────
router.get('/outgoing', async (req, res) => {
  try {
    const { search, status, purpose, date_from, date_to } = req.query;
    const { limit, offset } = paginate(req.query);
    const params = [];
    const conds = [];
    if (search && String(search).trim()) {
      params.push(`%${String(search).trim()}%`);
      conds.push(`(part_code ILIKE $${params.length} OR part_description ILIKE $${params.length} OR reference_id ILIKE $${params.length} OR destination ILIKE $${params.length} OR batch_no ILIKE $${params.length} OR shipment_ref ILIKE $${params.length} OR customer ILIKE $${params.length})`);
    }
    if (req.query.batch_no) { params.push(String(req.query.batch_no)); conds.push(`batch_no=$${params.length}`); }
    if (req.query.shipment_ref) { params.push(String(req.query.shipment_ref)); conds.push(`shipment_ref=$${params.length}`);
    }
    if (status && ['issued', 'received', 'cancelled'].includes(status)) {
      params.push(status); conds.push(`status=$${params.length}`);
    }
    if (purpose && ['production', 'sale', 'sample', 'return', 'other'].includes(purpose)) {
      params.push(purpose); conds.push(`purpose=$${params.length}`);
    }
    if (req.query.movement_type && ['SALES_DISPATCH','DAILY_MOVING','SPECIAL_CASE','RETURN','LEGACY'].includes(req.query.movement_type)) { params.push(req.query.movement_type); conds.push(`movement_type=$${params.length}`); }
    if (date_from) { params.push(parseDate(date_from)); conds.push(`outgoing_date >= $${params.length}`); }
    if (date_to) { params.push(parseDate(date_to)); conds.push(`outgoing_date <= $${params.length}`); }
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

// One issue line, shared by the single-row and the batch endpoint. Runs inside the caller's
// transaction; throws { status, message } on validation problems.
async function issueLine(client, req, header, line) {
  const qty = parseFloat(line.quantity_sent);
  if (isNaN(qty) || qty <= 0) throw Object.assign(new Error('quantity_sent must be a positive number'), { status: 400 });
  const purpose = line.purpose || header.purpose || 'other';
  const movement = parseMovement(line.movement_type || header.movement_type, purpose);
  const pool_ = poolForMovement(movement);
  const machine = await resolveMachine(client, line.machine_id || line.machine_name ? line : header);
  const part = await partInfo(client, line.part_id);
  if (movement !== 'RETURN') {
    const currentQty = await availableQty(client, line.part_id, pool_);
    if (qty > currentQty) throw Object.assign(new Error(`${part.code}: insufficient ${pool_ === 'MOVING' ? 'moving pool' : 'sales'} stock. Available: ${currentQty}, requested: ${qty}`), { status: 400 });
  }
  const notes = line.notes || header.notes || null;
  const r = await client.query(`
    INSERT INTO parts_outgoing
      (outgoing_date, reference_id, part_id, part_code, part_description, uom,
       quantity_sent, destination, purpose, issued_by, received_by, notes, status, movement_type, machine_id, machine_name, batch_no, shipment_ref, customer)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'issued',$13,$14,$15,$16,$17,$18)
    RETURNING *
  `, [header.outgoing_date, header.reference_id || null, line.part_id, part.code, part.description, part.uom,
      qty, header.destination || null, purpose, header.issued_by, header.received_by || null, notes,
      movement, movement === 'SALES_DISPATCH' ? null : machine.machine_id, movement === 'SALES_DISPATCH' ? null : machine.machine_name,
      header.batch_no || null, movement === 'SALES_DISPATCH' ? header.shipment_ref || null : null, header.customer || null]);
  let inserted = r.rows[0];
  const refId = `OUT-${String(inserted.id).padStart(4, '0')}`;
  const bal = await availableQty(client, line.part_id, pool_);
  await writeLedger(client, {
    date: header.outgoing_date, type: movement === 'RETURN' ? 'return' : 'outgoing',
    refId,
    partId: line.part_id, partCode: part.code, partDesc: part.description,
    qtyIn: movement === 'RETURN' ? qty : null, qtyOut: movement === 'RETURN' ? null : qty,
    balance: bal, by: header.issued_by,
    notes: `${movement}${pool_ === 'MOVING' ? ' (moving pool)' : ''}${header.shipment_ref && movement === 'SALES_DISPATCH' ? ` · DO ${header.shipment_ref}` : ''}${movement !== 'SALES_DISPATCH' && machine.machine_name ? ` · ${machine.machine_name}` : ''}${notes ? ` · ${notes}` : ''}`,
  });
  let autoPb = null;
  if (pool_ === 'SALES' && movement !== 'RETURN') {
    autoPb = await autoPbForPart(client, req, line.part_id, refId, header.auto_pb);
    if (autoPb) { await client.query('UPDATE parts_outgoing SET auto_pb_no = $2 WHERE id = $1', [inserted.id, autoPb.pr_no]); inserted = { ...inserted, auto_pb_no: autoPb.pr_no }; }
  }
  return { row: inserted, auto_pb: autoPb, pool: pool_, balance_after: bal };
}

function readHeader(req) {
  const b = req.body || {};
  return {
    outgoing_date: parseDate(b.outgoing_date),
    reference_id: String(b.reference_id || '').trim().slice(0, 100) || null,
    shipment_ref: String(b.shipment_ref || '').trim().slice(0, 80) || null,
    customer: String(b.customer || '').trim().slice(0, 160) || null,
    destination: String(b.destination || '').trim().slice(0, 200) || null,
    purpose: b.purpose, movement_type: b.movement_type, machine_id: b.machine_id, machine_name: b.machine_name,
    issued_by: b.issued_by || (req.user && req.user.name) || 'system',
    received_by: b.received_by || null, notes: b.notes || null, auto_pb: b.auto_pb,
  };
}

router.post('/outgoing', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const header = readHeader(req);
    const { part_id, quantity_sent, purpose } = req.body || {};
    if (!header.outgoing_date || !part_id || !quantity_sent || !purpose)
      return res.status(400).json({ success: false, message: 'outgoing_date, part_id, quantity_sent, purpose are required' });
    if (!['production', 'sale', 'sample', 'return', 'other'].includes(purpose))
      return res.status(400).json({ success: false, message: 'purpose must be one of: production, sale, sample, return, other' });
    const out = await issueLine(client, req, header, { part_id, quantity_sent, purpose, movement_type: req.body.movement_type, notes: req.body.notes });
    await client.query('COMMIT');
    res.json({ success: true, data: out.row, auto_pb: out.auto_pb, pool: out.pool, balance_after: out.balance_after });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.status) return res.status(err.status).json({ success: false, message: err.message });
    console.error('Outgoing create error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create outgoing record' });
  } finally { client.release(); }
});

// Several packaging items under one reference in one go (one DO can need jumbo bags, inner
// bags, liners, strapping…). Each line carries its own quantity and movement type; the header
// carries the date, reference, customer (from the shipment when linked) and machine. All or
// nothing: if any line fails its stock check, nothing is written.
// Body: { outgoing_date, reference_id?, shipment_ref?, customer?, destination?, movement_type (default),
//         machine_id|machine_name, received_by?, notes?, auto_pb?, mark_complete?,
//         lines: [{ part_id, quantity_sent, movement_type?, machine_id?, machine_name?, notes? }] }
router.post('/outgoing/batch', async (req, res) => {
  const client = await pool.connect();
  try {
    const header = readHeader(req);
    const lines = Array.isArray(req.body && req.body.lines) ? req.body.lines : [];
    if (!header.outgoing_date) return res.status(400).json({ success: false, message: 'outgoing_date is required' });
    if (!lines.length) return res.status(400).json({ success: false, message: 'Add at least one line' });
    if (lines.some((l) => !l || !Number(l.part_id))) return res.status(400).json({ success: false, message: 'Every line needs a part' });
    await client.query('BEGIN');
    await client.query('LOCK TABLE parts_outgoing IN SHARE ROW EXCLUSIVE MODE');
    const seq = await client.query(`SELECT COUNT(DISTINCT batch_no)::int AS n FROM parts_outgoing WHERE batch_no IS NOT NULL`);
    header.batch_no = `PKG-${String(seq.rows[0].n + 1).padStart(5, '0')}`;
    // purpose is a legacy column: derive it from the movement so old reports stay meaningful
    const purposeFor = (m) => (m === 'SALES_DISPATCH' ? 'sale' : m === 'RETURN' ? 'return' : 'production');
    const results = [];
    for (const l of lines) {
      const mv = parseMovement(l.movement_type || header.movement_type, 'other');
      results.push(await issueLine(client, req, header, { ...l, purpose: purposeFor(mv), movement_type: mv }));
    }
    let refStatus = null;
    if (header.shipment_ref) {
      const complete = req.body.mark_complete === true;
      await client.query(
        `INSERT INTO parts_packaging_refs (ref_no, status, completed_by, completed_at, "updatedAt")
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (ref_no) DO UPDATE SET status = EXCLUDED.status, completed_by = EXCLUDED.completed_by, completed_at = EXCLUDED.completed_at, "updatedAt" = NOW()`,
        [header.shipment_ref, complete ? 'complete' : 'open', complete ? header.issued_by : null, complete ? new Date() : null]);
      refStatus = complete ? 'complete' : 'open';
    }
    await client.query('COMMIT');
    res.status(201).json({
      success: true,
      data: { batch_no: header.batch_no, rows: results.map((x) => x.row), shipment_ref: header.shipment_ref, ref_status: refStatus },
      auto_pbs: results.map((x) => x.auto_pb).filter(Boolean),
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.status) return res.status(err.status).json({ success: false, message: err.message });
    console.error('Outgoing batch error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to save the packaging movement' });
  } finally { client.release(); }
});

// Shipment references (Finished Goods / Flakes / By-products DO) that still need packaging.
// A reference stays here until someone ticks "all packaging issued" — the system has no bill of
// materials per shipment, so completeness is a human decision. ?all=1 lists completed ones too.
router.get('/outgoing/sales-refs', async (req, res) => {
  try {
    const all = req.query.all === '1';
    const search = String(req.query.search || '').trim();
    const params = [];
    const conds = [];
    if (!all) conds.push(`COALESCE(p.status, 'open') = 'open'`);
    if (search) { params.push(`%${search}%`); conds.push(`(g.ref_no ILIKE $${params.length} OR g.customer ILIKE $${params.length} OR g.destination ILIKE $${params.length} OR g.dn_nos ILIKE $${params.length})`); }
    if (!search && !all) conds.push(`g.shipment_date >= CURRENT_DATE - INTERVAL '120 days'`);
    const r = await pool.query(`
      WITH g AS (
        SELECT COALESCE(NULLIF(s.ref_no, ''), '#' || s.id) AS key, MAX(s.ref_no) AS ref_no, MIN(s.shipment_date) AS shipment_date,
               MAX(s.customer) AS customer, MAX(s.destination) AS destination, MAX(s.category) AS category,
               string_agg(DISTINCT mt.name, ', ') AS materials, string_agg(DISTINCT NULLIF(s.dn_no, ''), ', ') AS dn_nos,
               COUNT(*)::int AS containers, SUM(s.weight_kg) AS weight_kg,
               SUM((SELECT COUNT(*) FROM finished_goods_shipment_bags b WHERE b.shipment_id = s.id))::int AS bags
        FROM finished_goods_shipments s JOIN material_types mt ON mt.id = s.material_type_id
        GROUP BY 1
      )
      SELECT g.*, COALESCE(p.status, 'open') AS pkg_status, p.completed_at, p.completed_by, p.notes AS pkg_notes,
             (SELECT COALESCE(json_agg(json_build_object('part_code', o.part_code, 'description', o.part_description, 'qty', o.quantity_sent, 'uom', o.uom, 'date', o.outgoing_date, 'batch_no', o.batch_no) ORDER BY o.id), '[]'::json)
                FROM parts_outgoing o WHERE o.shipment_ref = g.key AND o.status <> 'cancelled') AS issued
      FROM g LEFT JOIN parts_packaging_refs p ON p.ref_no = g.key
      ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''}
      ORDER BY g.shipment_date DESC, g.key DESC
      LIMIT 150`, params);
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error('Sales refs error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load shipment references' });
  }
});

// Mark a reference's packaging complete (leaves the picker) or re-open it.
router.put('/outgoing/sales-refs/:ref', async (req, res) => {
  try {
    const ref = String(req.params.ref || '').trim().slice(0, 80);
    const status = req.body && req.body.status === 'complete' ? 'complete' : 'open';
    const by = (req.user && (req.user.name || req.user.employeeId)) || 'system';
    const r = await pool.query(
      `INSERT INTO parts_packaging_refs (ref_no, status, notes, completed_by, completed_at, "updatedAt")
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (ref_no) DO UPDATE SET status = EXCLUDED.status, notes = COALESCE(EXCLUDED.notes, parts_packaging_refs.notes), completed_by = EXCLUDED.completed_by, completed_at = EXCLUDED.completed_at, "updatedAt" = NOW()
       RETURNING *`,
      [ref, status, String((req.body && req.body.notes) || '').trim() || null, status === 'complete' ? by : null, status === 'complete' ? new Date() : null]);
    res.json({ success: true, data: r.rows[0] });
  } catch (err) {
    console.error('Sales ref status error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update the reference' });
  }
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

router.delete('/outgoing/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM parts_outgoing WHERE id=$1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'Record not found' });
    res.json({ success: true, message: 'Record deleted' });
  } catch (err) {
    console.error('Outgoing delete error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete outgoing record' });
  }
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
    const pool_ = parsePool(req.body.pool);
    const machine = await resolveMachine(client, req.body);
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
         quantity_affected, incident_type, root_cause, location, reported_by, approver, notes, status, pool, machine_id, machine_name)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'reported',$13,$14,$15)
      RETURNING *
    `, [incident_date, part_id, part.code, part.description, part.uom,
        qty, incident_type, root_cause, location, reported_by, approver || null, notes || null, pool_, machine.machine_id, machine.machine_name]);
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
    let autoPb = null;
    if (prev.status !== 'approved' && updated.status === 'approved') {
      const qty = parseFloat(updated.quantity_affected);
      const bal = await availableQty(client, updated.part_id, updated.pool || 'SALES');
      await writeLedger(client, {
        date: updated.incident_date, type: 'damage_waste',
        refId: `DW-${String(id).padStart(4, '0')}`,
        partId: updated.part_id, partCode: updated.part_code, partDesc: updated.part_description,
        qtyIn: null, qtyOut: qty,
        balance: bal, by: updated.reported_by,
        notes: `${updated.incident_type}: ${updated.root_cause}${updated.pool === 'MOVING' ? ' (moving pool)' : ''}`,
      });
      if ((updated.pool || 'SALES') === 'SALES') autoPb = await autoPbForPart(client, req, updated.part_id, `DW-${String(id).padStart(4, '0')}`, body.auto_pb);
    }
    await client.query('COMMIT');
    res.json({ success: true, data: updated, auto_pb: autoPb });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Damage-waste update error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update damage/waste record' });
  } finally { client.release(); }
});

router.delete('/damage-waste/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM parts_damage_waste WHERE id=$1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'Record not found' });
    res.json({ success: true, message: 'Record deleted' });
  } catch (err) {
    console.error('Damage-waste delete error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete damage/waste record' });
  }
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
    if (transaction_type && ['stock_in', 'correction', 'outgoing', 'return', 'damage_waste'].includes(transaction_type)) {
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

// ─── 6b. Pool opening balances (warehouse cut-off sheet) ──────────────────────
// The MOVING pool starts from the warehouse cut-off sheet; SALES can be seeded too when the
// counted actual differs from the system balance at cut-off. One row per part+pool is kept —
// re-importing a part replaces its previous opening for that pool.
router.get('/pool-opening', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT o.*, p.code AS part_code, p.description AS part_description, p.uom
      FROM parts_pool_opening o JOIN pm_item p ON p.id = o.part_id
      ORDER BY p.code, o.pool`);
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error('Pool opening list error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load opening balances' });
  }
});

// Body: { as_of_date, notes?, rows: [{ code | part_id, sales?, moving? }] }  (either pool may be omitted)
router.post('/pool-opening/import', async (req, res) => {
  const { hasPermission } = require('../middleware/permissions');
  if (!hasPermission(req.user, 'parts', 'delete'))
    return res.status(403).json({ success: false, message: 'Only a Parts Inventory admin can import opening balances' });
  const client = await pool.connect();
  try {
    const as_of_date = parseDate(req.body && req.body.as_of_date);
    const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
    if (!as_of_date || !rows.length)
      return res.status(400).json({ success: false, message: 'as_of_date and at least one row are required' });
    const notes = String((req.body && req.body.notes) || '').trim().slice(0, 500) || null;
    const by = (req.user && (req.user.name || req.user.employeeId)) || 'system';
    const results = []; const errors = [];
    await client.query('BEGIN');
    for (let i = 0; i < rows.length; i += 1) {
      const x = rows[i] || {};
      const code = String(x.code || '').trim();
      const found = x.part_id
        ? await client.query('SELECT id, code FROM pm_item WHERE id = $1', [Number(x.part_id)])
        : await client.query('SELECT id, code FROM pm_item WHERE UPPER(code) = UPPER($1)', [code]);
      if (!found.rows.length) { errors.push({ row: i + 1, code: code || x.part_id, message: 'Item code not found' }); continue; }
      const part = found.rows[0];
      for (const p of POOLS) {
        const key = p.toLowerCase();
        if (x[key] === undefined || x[key] === null || x[key] === '') continue;
        const qty = parseFloat(x[key]);
        if (isNaN(qty) || qty < 0) { errors.push({ row: i + 1, code: part.code, message: `${key} must be a number ≥ 0` }); continue; }
        await client.query('DELETE FROM parts_pool_opening WHERE part_id = $1 AND pool = $2', [part.id, p]);
        await client.query(
          `INSERT INTO parts_pool_opening (part_id, pool, qty, as_of_date, notes, "createdBy") VALUES ($1,$2,$3,$4,$5,$6)`,
          [part.id, p, qty, as_of_date, notes, by]);
        results.push({ code: part.code, pool: p, qty });
      }
    }
    if (errors.length && !(req.body && req.body.partial)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: `${errors.length} row(s) could not be imported — nothing was saved`, errors });
    }
    await client.query('COMMIT');
    res.json({ success: true, data: { imported: results.length, rows: results, errors } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Pool opening import error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to import opening balances' });
  } finally { client.release(); }
});

router.delete('/pool-opening/:id', async (req, res) => {
  const { hasPermission } = require('../middleware/permissions');
  if (!hasPermission(req.user, 'parts', 'delete'))
    return res.status(403).json({ success: false, message: 'Only a Parts Inventory admin can remove opening balances' });
  try {
    const r = await pool.query('DELETE FROM parts_pool_opening WHERE id = $1 RETURNING id', [parseInt(req.params.id)]);
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Record not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to delete opening balance' });
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
