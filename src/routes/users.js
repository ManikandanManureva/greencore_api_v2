const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

/**
 * User Management — super_admin only. Create/edit/deactivate/delete dashboard logins and
 * assign one of the fixed roles below; each role's module access is whatever that role already
 * sees (DashboardLayout.tsx menu `roles` arrays + each backend route's own ALLOWED_ROLES) — this
 * module doesn't introduce a separate per-user permission system, just manages who has which role.
 */
const ROLES = ['super_admin', 'admin', 'ppic', 'qc', 'pet', 'spare_parts_admin', 'qc_lab'];

function requireSuperAdmin(req, res, next) {
  const role = String(req.user && req.user.role ? req.user.role : '').toLowerCase();
  if (role !== 'super_admin') {
    return res.status(403).json({ success: false, message: 'Only Super Admin can manage users' });
  }
  next();
}

router.use(authenticateToken, requireSuperAdmin);

// ─── Meta — roles + material types, for the Create/Edit User form's dropdowns ─
router.get('/meta', async (req, res) => {
  try {
    const mt = await pool.query('SELECT id, name FROM material_types ORDER BY name');
    res.json({ success: true, roles: ROLES, materialTypes: mt.rows });
  } catch (err) {
    console.error('User meta error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load form options' });
  }
});

// ─── List ───────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { search, role } = req.query;
    const where = [];
    const params = [];
    if (role && role !== 'all' && ROLES.includes(role)) {
      params.push(role);
      where.push(`u.role = $${params.length}`);
    }
    if (search && String(search).trim()) {
      params.push(`%${String(search).trim()}%`);
      where.push(`(u.employee_id ILIKE $${params.length} OR u.name ILIKE $${params.length} OR u.email ILIKE $${params.length})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const r = await pool.query(
      `SELECT u.id, u.employee_id, u.name, u.email, u.role, u.is_active, u.material_type_id,
              mt.name AS material_type, u.can_correct_production, u.last_login_at, u.created_at
       FROM users u
       LEFT JOIN material_types mt ON mt.id = u.material_type_id
       ${whereSql}
       ORDER BY u.created_at DESC`,
      params,
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error('Users list error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load users' });
  }
});

// ─── Create ─────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { employeeId, password, name, email, role, materialTypeId, canCorrectProduction } = req.body || {};
    if (!employeeId || !String(employeeId).trim()) {
      return res.status(400).json({ success: false, message: 'Employee ID is required' });
    }
    if (!password || String(password).length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    }
    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, message: 'Name is required' });
    }
    if (!role || !ROLES.includes(role)) {
      return res.status(400).json({ success: false, message: `role must be one of ${ROLES.join(', ')}` });
    }

    const normalizedId = String(employeeId).trim().toUpperCase();
    const existing = await pool.query('SELECT id FROM users WHERE employee_id = $1', [normalizedId]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ success: false, message: `Employee ID "${normalizedId}" is already in use` });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const r = await pool.query(
      `INSERT INTO users (employee_id, password, name, email, role, material_type_id, can_correct_production, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)
       RETURNING id, employee_id, name, email, role, is_active, material_type_id, can_correct_production, created_at`,
      [normalizedId, hashedPassword, String(name).trim(), email || null, role, materialTypeId || null, canCorrectProduction === true],
    );
    res.status(201).json({ success: true, data: r.rows[0] });
  } catch (err) {
    console.error('User create error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create user' });
  }
});

// ─── Update (profile/role/status; password only if provided) ──────────────────
router.put('/:id', async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const { name, email, role, materialTypeId, canCorrectProduction, isActive, password } = req.body || {};

    if (role && !ROLES.includes(role)) {
      return res.status(400).json({ success: false, message: `role must be one of ${ROLES.join(', ')}` });
    }
    if (targetId === req.user.id && role && role !== 'super_admin') {
      return res.status(400).json({ success: false, message: 'You cannot remove your own Super Admin role' });
    }
    if (targetId === req.user.id && isActive === false) {
      return res.status(400).json({ success: false, message: 'You cannot deactivate your own account' });
    }

    const existing = await pool.query('SELECT * FROM users WHERE id = $1', [targetId]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    const current = existing.rows[0];

    let passwordClause = '';
    const params = [
      name != null ? String(name).trim() : current.name,
      email != null ? email : current.email,
      role || current.role,
      materialTypeId !== undefined ? materialTypeId : current.material_type_id,
      canCorrectProduction != null ? canCorrectProduction === true : current.can_correct_production,
      isActive != null ? isActive === true : current.is_active,
    ];
    if (password) {
      if (String(password).length < 6) {
        return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
      }
      params.push(await bcrypt.hash(password, 10));
      passwordClause = `, password = $${params.length}`;
    }
    params.push(targetId);

    const r = await pool.query(
      `UPDATE users SET name = $1, email = $2, role = $3, material_type_id = $4,
         can_correct_production = $5, is_active = $6, updated_at = NOW() ${passwordClause}
       WHERE id = $${params.length}
       RETURNING id, employee_id, name, email, role, is_active, material_type_id, can_correct_production, last_login_at, created_at`,
      params,
    );
    res.json({ success: true, data: r.rows[0] });
  } catch (err) {
    console.error('User update error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update user' });
  }
});

// ─── Delete ─────────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    if (targetId === req.user.id) {
      return res.status(400).json({ success: false, message: 'You cannot delete your own account' });
    }
    const r = await pool.query('DELETE FROM users WHERE id = $1 RETURNING id', [targetId]);
    if (r.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    res.json({ success: true, message: 'User deleted' });
  } catch (err) {
    console.error('User delete error:', err.message);
    // FK constraints (e.g. production logs created by this user) can block a hard delete —
    // deactivating instead (PUT isActive:false) is the safe fallback for a user with history.
    res.status(500).json({ success: false, message: 'Could not delete user — they may have linked records. Try deactivating instead.' });
  }
});

module.exports = router;
