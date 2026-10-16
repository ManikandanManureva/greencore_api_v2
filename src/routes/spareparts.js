const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

/**
 * Spare Parts module — unified schema (v2). One catalog registry (spare_parts_catalogs) plus
 * one items table and one log table shared by every catalog: PC, PE, PET machines (Starlinger,
 * Boretech, ...), and MEC/General. Adding a new PET machine is a new catalog row, not a new
 * table or route block — every endpoint below is parameterized by :catalogKey.
 * Day-to-day Stock In (purchase/receipt) and Outgoing (usage) entries can be logged by any
 * view role; only PPIC (and admin/super_admin) can edit master fields (min/max, location,
 * category, etc.).
 */
const MASTER_EDIT_ROLES = ['ppic', 'super_admin', 'admin', 'spare_parts_admin'];
const VIEW_ROLES = ['ppic', 'super_admin', 'admin', 'pet', 'spare_parts_admin'];

function requireView(req, res, next) {
  const role = String(req.user?.role || '').toLowerCase();
  if (VIEW_ROLES.includes(role)) return next();
  return res.status(403).json({ success: false, message: 'Not authorized for Spare Parts' });
}

function requireMasterEdit(req, res, next) {
  const role = String(req.user?.role || '').toLowerCase();
  if (MASTER_EDIT_ROLES.includes(role)) return next();
  return res.status(403).json({ success: false, message: 'Only PPIC can edit spare parts master data' });
}

router.use(authenticateToken, requireView);

function actorName(req) {
  return (req.user && (req.user.name || req.user.employeeId)) || null;
}

async function resolveCatalog(key) {
  const r = await pool.query('SELECT * FROM spare_parts_catalogs WHERE key = $1', [key]);
  return r.rows[0] || null;
}

// Every /:catalogKey route below resolves the catalog first and 404s cleanly if unknown.
async function withCatalog(req, res, next) {
  const catalog = await resolveCatalog(req.params.catalogKey);
  if (!catalog) return res.status(404).json({ success: false, message: `Unknown spare parts catalog "${req.params.catalogKey}"` });
  req.catalog = catalog;
  next();
}

// ════════════════════════════════════════════════════════════════
// Catalog registry — drives the menu / hub page.
// ════════════════════════════════════════════════════════════════
router.get('/catalogs', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM spare_parts_catalogs ORDER BY sort_order, label');
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error('Spare parts catalogs error:', err.message);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

router.use('/:catalogKey', withCatalog);

// ════════════════════════════════════════════════════════════════
// Parts master
// ════════════════════════════════════════════════════════════════

router.get('/:catalogKey/parts', async (req, res) => {
  try {
    const { search, category, status, page = 1, limit = 20 } = req.query;
    const where = ['catalog_id = $1'];
    const params = [req.catalog.id];

    if (search && String(search).trim()) {
      params.push(`%${String(search).trim()}%`);
      where.push(`(part_no ILIKE $${params.length} OR description ILIKE $${params.length} OR category ILIKE $${params.length})`);
    }
    if (category && category !== 'all') {
      params.push(category);
      where.push(`category = $${params.length}`);
    }
    if (status === 'low') {
      where.push(`min_stock IS NOT NULL AND current_qty <= min_stock`);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const countRes = await pool.query(`SELECT COUNT(*)::int AS total FROM spare_parts_items ${whereSql}`, params);
    const listParams = [...params, parseInt(limit), offset];
    const rowsRes = await pool.query(
      `SELECT * FROM spare_parts_items ${whereSql} ORDER BY description ASC LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams,
    );

    const total = countRes.rows[0].total;
    res.json({
      success: true,
      data: rowsRes.rows,
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      totalPages: Math.max(1, Math.ceil(total / parseInt(limit))),
    });
  } catch (err) {
    console.error('Spare parts list error:', err.message);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

router.get('/:catalogKey/categories', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT DISTINCT category FROM spare_parts_items WHERE catalog_id = $1 AND category IS NOT NULL ORDER BY category',
      [req.catalog.id],
    );
    res.json({ success: true, data: r.rows.map((row) => row.category) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Reorder list — current qty at or below min stock. suggest_order falls back to min*2, then
// a flat +10, when no max stock is set (e.g. MEC parts carried over without one).
router.get('/:catalogKey/reorder', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT *,
         GREATEST(COALESCE(max_stock, min_stock * 2, current_qty + 10) - current_qty, 0) AS suggest_order,
         CASE WHEN current_qty <= 0 THEN 'OUT_OF_STOCK' ELSE 'LOW_STOCK' END AS status
       FROM spare_parts_items
       WHERE catalog_id = $1 AND min_stock IS NOT NULL AND current_qty <= min_stock
       ORDER BY current_qty ASC, description ASC`,
      [req.catalog.id],
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error('Spare parts reorder error:', err.message);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

router.get('/:catalogKey/parts/:id', async (req, res) => {
  try {
    const part = await pool.query('SELECT * FROM spare_parts_items WHERE id = $1 AND catalog_id = $2', [req.params.id, req.catalog.id]);
    if (part.rows.length === 0) return res.status(404).json({ success: false, message: 'Part not found' });
    const log = await pool.query(
      'SELECT * FROM spare_parts_log WHERE item_id = $1 ORDER BY log_date DESC, id DESC LIMIT 100',
      [req.params.id],
    );
    res.json({ success: true, data: { ...part.rows[0], log: log.rows } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

router.post('/:catalogKey/parts', requireMasterEdit, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.description || !String(b.description).trim()) {
      return res.status(400).json({ success: false, message: 'Description is required' });
    }
    const baseStock = Number(b.base_stock) || 0;
    const r = await pool.query(
      `INSERT INTO spare_parts_items
         (catalog_id, part_no, description, category, shelf, floor, location, base_stock, current_qty,
          min_stock, max_stock, unit, machine, supplier, notes, "createdBy", "updatedBy")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11,$12,$13,$14,$15,$15)
       RETURNING *`,
      [
        req.catalog.id, b.part_no || null, String(b.description).trim(), b.category || null, b.shelf || null,
        b.floor || null, b.location || null, baseStock, b.min_stock ?? null, b.max_stock ?? null,
        b.unit || null, b.machine || req.catalog.machine || null, b.supplier || null, b.notes || null, actorName(req),
      ],
    );
    res.status(201).json({ success: true, data: r.rows[0] });
  } catch (err) {
    console.error('Spare parts create error:', err.message);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Edit master fields — PPIC only. current_qty may also be corrected here (e.g. after a
// physical count) — doing so writes a log entry for the difference, same as any other
// stock movement, so the change still shows up in the ledger instead of silently vanishing.
router.put('/:catalogKey/parts/:id', requireMasterEdit, async (req, res) => {
  const client = await pool.connect();
  try {
    const FIELDS = ['part_no', 'description', 'category', 'shelf', 'floor', 'location',
      'min_stock', 'max_stock', 'unit', 'machine', 'supplier', 'notes'];
    const sets = [];
    const params = [];
    for (const f of FIELDS) {
      if (req.body[f] !== undefined) {
        params.push(req.body[f] === '' ? null : req.body[f]);
        sets.push(`${f} = $${params.length}`);
      }
    }

    const hasQtyEdit = req.body.current_qty !== undefined && req.body.current_qty !== '';
    const newQty = hasQtyEdit ? Number(req.body.current_qty) : null;
    if (hasQtyEdit && !Number.isFinite(newQty)) {
      return res.status(400).json({ success: false, message: 'current_qty must be a number' });
    }

    if (sets.length === 0 && !hasQtyEdit) {
      return res.status(400).json({ success: false, message: 'No fields to update' });
    }

    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT * FROM spare_parts_items WHERE id = $1 AND catalog_id = $2 FOR UPDATE',
      [req.params.id, req.catalog.id],
    );
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Part not found' });
    }

    if (hasQtyEdit) {
      params.push(newQty);
      sets.push(`current_qty = $${params.length}`);
    }
    params.push(actorName(req));
    sets.push(`"updatedBy" = $${params.length}`);
    sets.push(`"updatedAt" = NOW()`);
    params.push(req.params.id, req.catalog.id);
    const r = await client.query(
      `UPDATE spare_parts_items SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND catalog_id = $${params.length} RETURNING *`,
      params,
    );

    if (hasQtyEdit) {
      const delta = newQty - Number(existing.rows[0].current_qty);
      if (delta !== 0) {
        await client.query(
          `INSERT INTO spare_parts_log (item_id, log_date, transaction_type, qty, description, technician, "createdBy")
           VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6)`,
          [req.params.id, delta > 0 ? 'Received' : 'Used', delta,
            'Manual stock correction (master edit)', actorName(req), actorName(req)],
        );
      }
    }

    await client.query('COMMIT');
    res.json({ success: true, data: r.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Spare parts update error:', err.message);
    res.status(500).json({ success: false, message: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ════════════════════════════════════════════════════════════════
// Transactions — log one against a specific part, or flat Stock In / Outgoing / Ledger views
// (pick any part from a dropdown, mirroring the Parts Inventory module's pattern).
// ════════════════════════════════════════════════════════════════

async function logTransaction(req, res, itemId, fixedType) {
  const client = await pool.connect();
  try {
    const { transaction_type, qty, description, technician, remark, log_date } = req.body || {};
    const type = fixedType || transaction_type;
    if (!['Received', 'Used'].includes(type)) {
      return res.status(400).json({ success: false, message: "transaction_type must be 'Received' or 'Used'" });
    }
    const qtyNum = Number(qty);
    if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
      return res.status(400).json({ success: false, message: 'qty must be a positive number' });
    }
    const signedQty = type === 'Used' ? -qtyNum : qtyNum;

    await client.query('BEGIN');
    const partRes = await client.query(
      'SELECT id, current_qty FROM spare_parts_items WHERE id = $1 AND catalog_id = $2 FOR UPDATE',
      [itemId, req.catalog.id],
    );
    if (partRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Part not found' });
    }
    if (type === 'Used' && qtyNum > Number(partRes.rows[0].current_qty)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: `Insufficient stock. Available: ${partRes.rows[0].current_qty}, Requested: ${qtyNum}` });
    }
    const logRes = await client.query(
      `INSERT INTO spare_parts_log (item_id, log_date, transaction_type, qty, description, technician, remark, "createdBy")
       VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3, $4, $5, $6, $7, $8) RETURNING *`,
      [itemId, log_date || null, type, signedQty, description || null, technician || null, remark || null, actorName(req)],
    );
    const updateRes = await client.query(
      `UPDATE spare_parts_items SET current_qty = current_qty + $2, "updatedAt" = NOW() WHERE id = $1 RETURNING *`,
      [itemId, signedQty],
    );
    await client.query('COMMIT');
    res.status(201).json({ success: true, data: { log: logRes.rows[0], part: updateRes.rows[0] } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Spare parts log error:', err.message);
    res.status(500).json({ success: false, message: 'Internal server error' });
  } finally {
    client.release();
  }
}

router.post('/:catalogKey/parts/:id/log', (req, res) => logTransaction(req, res, req.params.id, null));
router.post('/:catalogKey/stock-in', (req, res) => logTransaction(req, res, req.body?.part_id, 'Received'));
router.post('/:catalogKey/outgoing', (req, res) => logTransaction(req, res, req.body?.part_id, 'Used'));

// Edit or delete a logged transaction — e.g. to fix an input error. Open to the same roles
// that can log one in the first place (requireView, applied globally above), since the person
// who made the mistake is usually the one who needs to fix it. Both reverse the entry's old
// effect on current_qty and (for edit) reapply the corrected one, atomically.
router.put('/:catalogKey/log/:logId', async (req, res) => {
  const client = await pool.connect();
  try {
    const { transaction_type, qty, description, technician, remark, log_date } = req.body || {};
    if (!['Received', 'Used'].includes(transaction_type)) {
      return res.status(400).json({ success: false, message: "transaction_type must be 'Received' or 'Used'" });
    }
    const qtyNum = Number(qty);
    if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
      return res.status(400).json({ success: false, message: 'qty must be a positive number' });
    }
    const newSignedQty = transaction_type === 'Used' ? -qtyNum : qtyNum;

    await client.query('BEGIN');
    const logRes = await client.query(
      `SELECT l.* FROM spare_parts_log l JOIN spare_parts_items p ON p.id = l.item_id
       WHERE l.id = $1 AND p.catalog_id = $2`,
      [req.params.logId, req.catalog.id],
    );
    if (logRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Log entry not found' });
    }
    const old = logRes.rows[0];
    const partRes = await client.query('SELECT current_qty FROM spare_parts_items WHERE id = $1 FOR UPDATE', [old.item_id]);
    const qtyAfterReversal = Number(partRes.rows[0].current_qty) - Number(old.qty);
    if (transaction_type === 'Used' && qtyNum > qtyAfterReversal) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: `Insufficient stock for this correction. Available (excluding this entry): ${qtyAfterReversal}, Requested: ${qtyNum}` });
    }

    const updateRes = await client.query(
      `UPDATE spare_parts_log
       SET log_date = COALESCE($2::date, log_date), transaction_type = $3, qty = $4,
           description = $5, technician = $6, remark = $7
       WHERE id = $1 RETURNING *`,
      [req.params.logId, log_date || null, transaction_type, newSignedQty, description || null, technician || null, remark || null],
    );
    const newQtyOnHand = qtyAfterReversal + newSignedQty;
    await client.query('UPDATE spare_parts_items SET current_qty = $2, "updatedAt" = NOW() WHERE id = $1', [old.item_id, newQtyOnHand]);
    await client.query('COMMIT');
    res.json({ success: true, data: updateRes.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Spare parts log edit error:', err.message);
    res.status(500).json({ success: false, message: 'Internal server error' });
  } finally {
    client.release();
  }
});

router.delete('/:catalogKey/log/:logId', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const logRes = await client.query(
      `SELECT l.* FROM spare_parts_log l JOIN spare_parts_items p ON p.id = l.item_id
       WHERE l.id = $1 AND p.catalog_id = $2`,
      [req.params.logId, req.catalog.id],
    );
    if (logRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Log entry not found' });
    }
    const old = logRes.rows[0];
    await client.query('DELETE FROM spare_parts_log WHERE id = $1', [req.params.logId]);
    await client.query(
      'UPDATE spare_parts_items SET current_qty = current_qty - $2, "updatedAt" = NOW() WHERE id = $1',
      [old.item_id, old.qty],
    );
    await client.query('COMMIT');
    res.json({ success: true, message: 'Log entry deleted' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Spare parts log delete error:', err.message);
    res.status(500).json({ success: false, message: 'Internal server error' });
  } finally {
    client.release();
  }
});

async function listTransactions(req, res, fixedType) {
  try {
    const { search, date_from, date_to, page = 1, limit = 20 } = req.query;
    const where = ['p.catalog_id = $1'];
    const params = [req.catalog.id];
    if (fixedType) { params.push(fixedType); where.push(`l.transaction_type = $${params.length}`); }
    if (search && String(search).trim()) {
      params.push(`%${String(search).trim()}%`);
      where.push(`(p.part_no ILIKE $${params.length} OR p.description ILIKE $${params.length} OR l.technician ILIKE $${params.length} OR l.description ILIKE $${params.length})`);
    }
    if (date_from) { params.push(date_from); where.push(`l.log_date >= $${params.length}`); }
    if (date_to) { params.push(date_to); where.push(`l.log_date <= $${params.length}`); }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS total FROM spare_parts_log l JOIN spare_parts_items p ON p.id = l.item_id ${whereSql}`,
      params,
    );
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const listParams = [...params, parseInt(limit), offset];
    const rowsRes = await pool.query(
      `SELECT l.*, p.part_no AS part_code, p.description AS part_name, p.unit AS unit
       FROM spare_parts_log l JOIN spare_parts_items p ON p.id = l.item_id
       ${whereSql}
       ORDER BY l.log_date DESC, l.id DESC
       LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams,
    );
    const total = countRes.rows[0].total;
    res.json({
      success: true, data: rowsRes.rows, page: parseInt(page), limit: parseInt(limit),
      total, totalPages: Math.max(1, Math.ceil(total / parseInt(limit))),
    });
  } catch (err) {
    console.error(`Spare parts ${fixedType || 'ledger'} list error:`, err.message);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

router.get('/:catalogKey/stock-in', (req, res) => listTransactions(req, res, 'Received'));
router.get('/:catalogKey/outgoing', (req, res) => listTransactions(req, res, 'Used'));
router.get('/:catalogKey/ledger', (req, res) => listTransactions(req, res, null));

// Outgoing summary — total usage grouped by day, week or month.
router.get('/:catalogKey/outgoing/summary', async (req, res) => {
  try {
    const { group = 'day', date_from, date_to, search } = req.query;
    const trunc = ['day', 'week', 'month'].includes(group) ? group : 'day';
    const where = ["p.catalog_id = $1", "l.transaction_type = 'Used'"];
    const params = [req.catalog.id];
    if (search && String(search).trim()) {
      params.push(`%${String(search).trim()}%`);
      where.push(`(p.part_no ILIKE $${params.length} OR p.description ILIKE $${params.length} OR l.technician ILIKE $${params.length})`);
    }
    if (date_from) { params.push(date_from); where.push(`l.log_date >= $${params.length}`); }
    if (date_to) { params.push(date_to); where.push(`l.log_date <= $${params.length}`); }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const r = await pool.query(
      `SELECT date_trunc('${trunc}', l.log_date)::date AS period,
              COALESCE(SUM(ABS(l.qty)), 0)::numeric AS total_qty,
              COUNT(*)::int AS transaction_count,
              COUNT(DISTINCT l.item_id)::int AS part_count
       FROM spare_parts_log l JOIN spare_parts_items p ON p.id = l.item_id
       ${whereSql}
       GROUP BY period
       ORDER BY period DESC`,
      params,
    );
    res.json({ success: true, data: r.rows, group: trunc });
  } catch (err) {
    console.error('Spare parts outgoing summary error:', err.message);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;
