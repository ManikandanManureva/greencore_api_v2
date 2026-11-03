const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { MODULES, MODULE_KEYS, normalizePermissions, requireModule } = require('../middleware/permissions');

/**
 * User Management — users, roles and per-module menu access (read / write / delete).
 * Gated by the `users` module, which only Super Admin has by default. A role's key is also
 * written to users.role so the mobile app and legacy checks keep working unchanged.
 */
router.use(authenticateToken, requireModule('users'));

const USER_COLS = `u.id, u.employee_id, u.name, u.email, u.phone, u.role, u.role_id, u.is_active, u.material_type_id,
                   u.can_correct_production, u.last_login_at, u.created_at`;

function slugify(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50);
}

async function roleById(client, id) {
  const r = await client.query('SELECT id, key, name, is_system FROM roles WHERE id = $1', [id]);
  return r.rows[0] || null;
}

async function revokeSessions(client, userId) {
  await client.query('UPDATE refresh_tokens SET is_revoked = true WHERE user_id = $1', [userId]).catch(() => {});
}

// ─── Meta — roles, modules and material types for the forms ───────────────────
router.get('/meta', async (req, res) => {
  try {
    const [mt, roles] = await Promise.all([
      pool.query('SELECT id, name FROM material_types ORDER BY name'),
      pool.query(`SELECT r.id, r.key, r.name, r.is_system, (SELECT COUNT(*)::int FROM users u WHERE u.role_id = r.id) AS user_count
                  FROM roles r ORDER BY r.is_system DESC, r.name`),
    ]);
    res.json({ success: true, roles: roles.rows, modules: MODULES, materialTypes: mt.rows });
  } catch (err) {
    console.error('User meta error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load form options' });
  }
});

// ─── Roles ────────────────────────────────────────────────────────────────────
async function listRoles() {
  const r = await pool.query(
    `SELECT r.id, r.key, r.name, r.description, r.is_system, r.created_at, r.updated_at,
            (SELECT COUNT(*)::int FROM users u WHERE u.role_id = r.id AND u.deleted_at IS NULL) AS user_count,
            COALESCE(json_object_agg(rp.module_key, json_build_object('read', rp.can_read, 'write', rp.can_write, 'delete', rp.can_delete))
                     FILTER (WHERE rp.module_key IS NOT NULL), '{}'::json) AS permissions
     FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
     GROUP BY r.id ORDER BY r.is_system DESC, r.name`,
  );
  return r.rows.map((row) => ({ ...row, permissions: normalizePermissions(row.permissions) }));
}

router.get('/roles', async (req, res) => {
  try {
    res.json({ success: true, data: await listRoles(), modules: MODULES });
  } catch (err) {
    console.error('Roles list error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load roles' });
  }
});

async function savePermissions(client, roleId, permissions) {
  const perms = normalizePermissions(permissions);
  for (const k of MODULE_KEYS) {
    await client.query(
      `INSERT INTO role_permissions (role_id, module_key, can_read, can_write, can_delete) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (role_id, module_key) DO UPDATE SET can_read = EXCLUDED.can_read, can_write = EXCLUDED.can_write, can_delete = EXCLUDED.can_delete`,
      [roleId, k, perms[k].read, perms[k].write, perms[k].delete],
    );
  }
}

router.post('/roles', async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, description, permissions } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ success: false, message: 'Role name is required' });
    const key = slugify(req.body.key || name);
    if (!key) return res.status(400).json({ success: false, message: 'Role name must contain letters or numbers' });
    const dup = await client.query('SELECT id FROM roles WHERE key = $1 OR LOWER(name) = LOWER($2)', [key, String(name).trim()]);
    if (dup.rows.length) return res.status(409).json({ success: false, message: 'A role with that name already exists' });
    await client.query('BEGIN');
    const r = await client.query(
      `INSERT INTO roles (key, name, description) VALUES ($1, $2, $3) RETURNING id`,
      [key, String(name).trim(), description ? String(description).trim() : null],
    );
    await savePermissions(client, r.rows[0].id, permissions);
    await client.query('COMMIT');
    const roles = await listRoles();
    res.status(201).json({ success: true, data: roles.find((x) => x.id === r.rows[0].id) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Role create error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create role' });
  } finally {
    client.release();
  }
});

router.put('/roles/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const role = await roleById(client, Number(req.params.id));
    if (!role) return res.status(404).json({ success: false, message: 'Role not found' });
    if (role.key === 'super_admin') return res.status(400).json({ success: false, message: 'Super Admin always has full access and cannot be edited' });
    const { name, description, permissions } = req.body || {};
    if (name != null && !String(name).trim()) return res.status(400).json({ success: false, message: 'Role name cannot be empty' });
    if (name != null) {
      const dup = await client.query('SELECT id FROM roles WHERE LOWER(name) = LOWER($1) AND id <> $2', [String(name).trim(), role.id]);
      if (dup.rows.length) return res.status(409).json({ success: false, message: 'A role with that name already exists' });
    }
    await client.query('BEGIN');
    await client.query(
      `UPDATE roles SET name = COALESCE($1, name), description = COALESCE($2, description), updated_at = NOW() WHERE id = $3`,
      [name != null ? String(name).trim() : null, description != null ? String(description).trim() : null, role.id],
    );
    if (permissions) await savePermissions(client, role.id, permissions);
    await client.query('COMMIT');
    const roles = await listRoles();
    res.json({ success: true, data: roles.find((x) => x.id === role.id) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Role update error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update role' });
  } finally {
    client.release();
  }
});

router.delete('/roles/:id', async (req, res) => {
  try {
    const role = await roleById(pool, Number(req.params.id));
    if (!role) return res.status(404).json({ success: false, message: 'Role not found' });
    if (role.is_system) return res.status(400).json({ success: false, message: 'Built-in roles cannot be deleted' });
    const inUse = await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE role_id = $1 AND deleted_at IS NULL', [role.id]);
    const n = inUse.rows[0].n;
    // Users still on the role are moved first: to another dashboard role (?reassign_to=<id>) or
    // to no dashboard role at all (?reassign_to=none — operator-app logins keep their PC/PE/PET
    // role string and just stop appearing as a dashboard role).
    const reassign = String(req.query.reassign_to || '').trim();
    if (n > 0 && !reassign) {
      return res.status(400).json({ success: false, message: `${n} user(s) still have this role — choose where to move them first` });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (n > 0) {
        if (reassign === 'none') {
          await client.query('UPDATE users SET role_id = NULL WHERE role_id = $1', [role.id]);
        } else {
          const target = await roleById(client, Number(reassign));
          if (!target || target.id === role.id) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'Choose a valid role to move the users to' });
          }
          await client.query('UPDATE users SET role_id = $1, role = $2 WHERE role_id = $3', [target.id, target.key, role.id]);
        }
        // Moved users pick up their new access on the next request (permissions are loaded per request).
      }
      await client.query('DELETE FROM roles WHERE id = $1', [role.id]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    res.json({ success: true, message: n > 0 ? `Role deleted; ${n} user(s) moved` : 'Role deleted' });
  } catch (err) {
    console.error('Role delete error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete role' });
  }
});

// ─── Users ────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { search, role, status } = req.query;
    const where = ['u.deleted_at IS NULL'];
    const params = [];
    if (role && role !== 'all') {
      params.push(String(role));
      where.push(`(r.key = $${params.length} OR (r.id IS NULL AND LOWER(u.role) = $${params.length}))`);
    }
    if (status === 'active') where.push('u.is_active = true');
    if (status === 'inactive') where.push('u.is_active = false');
    if (search && String(search).trim()) {
      params.push(`%${String(search).trim()}%`);
      where.push(`(u.employee_id ILIKE $${params.length} OR u.name ILIKE $${params.length} OR u.email ILIKE $${params.length} OR u.phone ILIKE $${params.length})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const r = await pool.query(
      `SELECT ${USER_COLS}, mt.name AS material_type, COALESCE(r.key, LOWER(u.role)) AS role_key, COALESCE(r.name, u.role) AS role_name
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       LEFT JOIN material_types mt ON mt.id = u.material_type_id
       ${whereSql}
       ORDER BY u.is_active DESC, u.name ASC`,
      params,
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error('Users list error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load users' });
  }
});

function validEmail(v) { return !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v)); }

router.post('/', async (req, res) => {
  try {
    const { employeeId, password, name, email, phone, roleId, materialTypeId, canCorrectProduction } = req.body || {};
    if (!employeeId || !String(employeeId).trim()) return res.status(400).json({ success: false, message: 'Employee ID is required' });
    if (!password || String(password).length < 6) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    if (!name || !String(name).trim()) return res.status(400).json({ success: false, message: 'Name is required' });
    if (!validEmail(email)) return res.status(400).json({ success: false, message: 'Email address looks invalid' });
    const role = roleId ? await roleById(pool, Number(roleId)) : null;
    if (!role) return res.status(400).json({ success: false, message: 'Choose a role' });

    const normalizedId = String(employeeId).trim().toUpperCase();
    const existing = await pool.query('SELECT id FROM users WHERE employee_id = $1', [normalizedId]);
    if (existing.rows.length > 0) return res.status(409).json({ success: false, message: `Employee ID "${normalizedId}" is already in use` });

    const hashedPassword = await bcrypt.hash(password, 10);
    const r = await pool.query(
      `INSERT INTO users (employee_id, password, name, email, phone, role, role_id, material_type_id, can_correct_production, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)
       RETURNING id`,
      [normalizedId, hashedPassword, String(name).trim(), email || null, phone ? String(phone).trim() : null, role.key, role.id,
        materialTypeId || null, canCorrectProduction === true],
    );
    const row = await pool.query(`SELECT ${USER_COLS}, r.key AS role_key, r.name AS role_name FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [r.rows[0].id]);
    res.status(201).json({ success: true, data: row.rows[0] });
  } catch (err) {
    console.error('User create error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create user' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const { name, email, phone, roleId, materialTypeId, canCorrectProduction, isActive } = req.body || {};
    const existing = await pool.query('SELECT * FROM users WHERE id = $1', [targetId]);
    if (existing.rows.length === 0) return res.status(404).json({ success: false, message: 'User not found' });
    const current = existing.rows[0];
    if (email !== undefined && !validEmail(email)) return res.status(400).json({ success: false, message: 'Email address looks invalid' });

    let role = null;
    if (roleId !== undefined && roleId !== null) {
      role = await roleById(pool, Number(roleId));
      if (!role) return res.status(400).json({ success: false, message: 'Unknown role' });
      if (targetId === req.user.id && role.key !== 'super_admin') {
        return res.status(400).json({ success: false, message: 'You cannot remove your own Super Admin role' });
      }
    }
    if (targetId === req.user.id && isActive === false) {
      return res.status(400).json({ success: false, message: 'You cannot deactivate your own account' });
    }

    await pool.query(
      `UPDATE users SET name = $1, email = $2, phone = $3, role = $4, role_id = $5, material_type_id = $6,
         can_correct_production = $7, is_active = $8, updated_at = NOW()
       WHERE id = $9`,
      [
        name != null ? String(name).trim() : current.name,
        email !== undefined ? (email || null) : current.email,
        phone !== undefined ? (phone ? String(phone).trim() : null) : current.phone,
        role ? role.key : current.role,
        role ? role.id : current.role_id,
        materialTypeId !== undefined ? (materialTypeId || null) : current.material_type_id,
        canCorrectProduction != null ? canCorrectProduction === true : current.can_correct_production,
        isActive != null ? isActive === true : current.is_active,
        targetId,
      ],
    );
    if (isActive === false) await revokeSessions(pool, targetId);
    const row = await pool.query(`SELECT ${USER_COLS}, r.key AS role_key, r.name AS role_name FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [targetId]);
    res.json({ success: true, data: row.rows[0] });
  } catch (err) {
    console.error('User update error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update user' });
  }
});

// Set a new password (or generate a temporary one when none is supplied). Signs the user out
// of every device by revoking their refresh tokens.
router.post('/:id/reset-password', async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const existing = await pool.query('SELECT id, employee_id FROM users WHERE id = $1', [targetId]);
    if (existing.rows.length === 0) return res.status(404).json({ success: false, message: 'User not found' });
    let password = req.body && req.body.password ? String(req.body.password) : '';
    let generated = false;
    if (!password) {
      // 10 chars from an unambiguous alphabet, e.g. "K7MP4XR2HQ"
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      password = Array.from(crypto.randomBytes(10)).map((b) => alphabet[b % alphabet.length]).join('');
      generated = true;
    } else if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    }
    const hashed = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET password = $1, updated_at = NOW() WHERE id = $2', [hashed, targetId]);
    await revokeSessions(pool, targetId);
    res.json({ success: true, message: 'Password reset', data: { employee_id: existing.rows[0].employee_id, password: generated ? password : null } });
  } catch (err) {
    console.error('Password reset error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to reset password' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    if (targetId === req.user.id) return res.status(400).json({ success: false, message: 'You cannot delete your own account' });
    const existing = await pool.query('SELECT id, employee_id FROM users WHERE id = $1 AND deleted_at IS NULL', [targetId]);
    if (existing.rows.length === 0) return res.status(404).json({ success: false, message: 'User not found' });
    await pool.query('DELETE FROM refresh_tokens WHERE user_id = $1', [targetId]).catch(() => {});
    try {
      await pool.query('DELETE FROM users WHERE id = $1', [targetId]);
      return res.json({ success: true, message: 'User deleted' });
    } catch (err) {
      if (err.code !== '23503') throw err; // anything but "still referenced" is a real failure
    }
    // The login has production history (operator shifts point at it), which must stay intact for
    // traceability. Retire the record instead: no login, hidden from the list, employee ID freed
    // so it can be given to someone else, and dropped from its dashboard role.
    await pool.query(
      `UPDATE users SET is_active = false, deleted_at = NOW(), role_id = NULL,
              employee_id = employee_id || '~deleted-' || id
       WHERE id = $1`,
      [targetId],
    );
    res.json({ success: true, message: 'User deleted — their past shifts and bags are kept for traceability', data: { retained_history: true } });
  } catch (err) {
    console.error('User delete error:', err.message);
    res.status(500).json({ success: false, message: 'Could not delete user' });
  }
});

module.exports = router;
