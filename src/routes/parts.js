const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

/**
 * Parts / Packaging-Material (PM) inventory — master catalog (pm_item).
 * Restricted to admin / super_admin / ppic (not qc).
 */
const ALLOWED_ROLES = ['ppic', 'super_admin', 'admin'];

function requirePartsRole(req, res, next) {
  const role = String(req.user && req.user.role ? req.user.role : '').toLowerCase();
  if (!ALLOWED_ROLES.includes(role)) {
    return res.status(403).json({ success: false, message: 'You are not authorized to access the Parts module' });
  }
  next();
}

router.use(authenticateToken, requirePartsRole);

// Editable fields → column names
const FIELDS = {
  code: 'code',
  description: 'description',
  category: 'category',
  uom: 'uom',
  size_spec: 'size_spec',
  variant: 'variant',
  use_stage: 'use_stage',
  unit_price: 'unit_price',
  supplier: 'supplier',
  reorder_level: 'reorder_level',
  is_active: 'is_active',
};

function actorName(req) {
  return (req.user && (req.user.name || req.user.employee_id)) || 'system';
}

// GET /parts — list with optional search / category / active filters
router.get('/', async (req, res) => {
  try {
    const { search, category, active } = req.query;
    const conds = [];
    const params = [];
    if (search && String(search).trim()) {
      params.push(`%${String(search).trim()}%`);
      conds.push(`(code ILIKE $${params.length} OR description ILIKE $${params.length} OR variant ILIKE $${params.length})`);
    }
    if (category && category !== 'all') {
      params.push(String(category).trim());
      conds.push(`category = $${params.length}`);
    }
    if (active === 'true' || active === 'false') {
      params.push(active === 'true');
      conds.push(`is_active = $${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const result = await pool.query(`SELECT * FROM pm_item ${where} ORDER BY category, code`, params);
    const cats = await pool.query(`SELECT DISTINCT category FROM pm_item WHERE category IS NOT NULL AND category <> '' ORDER BY category`);
    res.json({ success: true, data: result.rows, categories: cats.rows.map((r) => r.category) });
  } catch (err) {
    console.error('Parts list error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load parts' });
  }
});

// GET /parts/:id
router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM pm_item WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Part not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to load part' });
  }
});

// POST /parts — create
router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.code || !String(body.code).trim() || !body.description || !String(body.description).trim()) {
      return res.status(400).json({ success: false, message: 'Code and description are required' });
    }
    const cols = [];
    const vals = [];
    for (const f of Object.keys(FIELDS)) {
      if (body[f] !== undefined) {
        vals.push(body[f] === '' ? null : body[f]);
        cols.push(FIELDS[f]);
      }
    }
    vals.push(actorName(req)); cols.push('created_by');
    const placeholders = vals.map((_, i) => `$${i + 1}`);
    const result = await pool.query(
      `INSERT INTO pm_item (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
      vals,
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, message: 'A part with this code already exists' });
    console.error('Parts create error:', err.message);
    res.status(500).json({ success: false, message: err.message || 'Failed to create part' });
  }
});

// PUT /parts/:id — update
router.put('/:id', async (req, res) => {
  try {
    const body = req.body || {};
    const sets = [];
    const vals = [];
    for (const f of Object.keys(FIELDS)) {
      if (body[f] !== undefined) {
        vals.push(body[f] === '' ? null : body[f]);
        sets.push(`${FIELDS[f]} = $${vals.length}`);
      }
    }
    if (sets.length === 0) return res.status(400).json({ success: false, message: 'No fields to update' });
    vals.push(actorName(req)); sets.push(`updated_by = $${vals.length}`);
    sets.push('updated_at = NOW()');
    vals.push(req.params.id);
    const result = await pool.query(
      `UPDATE pm_item SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`,
      vals,
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Part not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, message: 'A part with this code already exists' });
    console.error('Parts update error:', err.message);
    res.status(500).json({ success: false, message: err.message || 'Failed to update part' });
  }
});

module.exports = router;
