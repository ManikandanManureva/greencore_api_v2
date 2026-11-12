/**
 * Role-based access for the dashboard.
 *
 * A role is a named set of per-module permissions (read / write / delete). Modules are the
 * top-level menus of the dashboard. `users.role` (the legacy string the mobile app and older
 * checks rely on) is kept in sync with the role's key, so nothing outside this file needs to
 * know about role ids.
 *
 * Permissions are resolved once per request in authenticateToken (req.user.permissions) and
 * enforced per route file with requireModule(moduleKey): GET → read, DELETE → delete,
 * everything else → write. super_admin always passes.
 */
const MODULES = [
  { key: 'overview',    label: 'Overview',           description: 'Plant-wide KPIs, trends and the live production-line view.' },
  { key: 'production',  label: 'Production Data',    description: 'Every jumbo bag scanned at every station, and shifts.' },
  { key: 'inventory',   label: 'Material Inventory', description: 'Gate entry, opening stock, consumption, outgoing and the stock ledger.' },
  { key: 'parts',       label: 'Parts Inventory',    description: 'Packaging / parts master and its stock movements.' },
  { key: 'spare_parts', label: 'Spare Parts',        description: 'Machine spare parts for PC/PE and PET lines.' },
  { key: 'outgoing',    label: 'Outgoing / Sales',   description: 'Finished goods, flakes and by-product shipments, bag REF lists.' },
  { key: 'qc_lab',      label: 'QC Lab',             description: 'Pellet sampling and lab results.' },
  { key: 'procurement', label: 'Procurement',        description: 'Permintaan Barang, approvals, purchase orders and goods receipts (LPB).' },
  { key: 'users',       label: 'User Management',    description: 'Users, roles and menu access.' },
];
const MODULE_KEYS = MODULES.map((m) => m.key);

const full = { read: true, write: true, delete: true };
const rw = { read: true, write: true, delete: false };
const all = (p) => Object.fromEntries(MODULE_KEYS.map((k) => [k, { ...p }]));

/** What each pre-existing role could do before roles became configurable — used to seed the
 * roles table and as the fallback when the tables are not migrated yet. */
const LEGACY_ROLES = [
  { key: 'super_admin',       name: 'Super Admin',       description: 'Full access to everything, including users and roles.', is_system: true, permissions: all(full) },
  { key: 'admin',             name: 'Admin',             description: 'Every module except user management.', permissions: { ...all(full), users: { read: false, write: false, delete: false } } },
  { key: 'ppic',              name: 'PPIC',              description: 'Production planning: production, inventory, parts, spare parts, outgoing and QC lab.', permissions: { production: full, inventory: full, parts: full, spare_parts: full, outgoing: full, qc_lab: full } },
  { key: 'qc',                name: 'QC (Gate Entry)',   description: 'Reviews gate-entry receipts and updates their status / notes.', permissions: { inventory: rw } },
  { key: 'pet',               name: 'PET Maintenance',   description: 'Logs spare-part receipts and usage for the PET lines.', permissions: { spare_parts: rw } },
  { key: 'spare_parts_admin', name: 'Spare Parts Admin', description: 'Full control of the Spare Parts module only.', permissions: { spare_parts: full } },
  { key: 'qc_lab',            name: 'QC Lab',            description: 'Pellet sampling and lab results only.', permissions: { qc_lab: full } },
];

function emptyPermissions() {
  return Object.fromEntries(MODULE_KEYS.map((k) => [k, { read: false, write: false, delete: false }]));
}

function normalizePermissions(perms) {
  const out = emptyPermissions();
  for (const k of MODULE_KEYS) {
    const p = (perms && perms[k]) || {};
    const del = p.delete === true;
    const write = p.write === true || del;
    const read = p.read === true || write;
    out[k] = { read, write, delete: del };
  }
  return out;
}

function legacyPermissionsFor(roleKey) {
  const r = LEGACY_ROLES.find((x) => x.key === String(roleKey || '').toLowerCase());
  return normalizePermissions(r ? r.permissions : {});
}

/**
 * Resolve { roleKey, roleName, permissions } for a user row. Prefers users.role_id; falls back
 * to matching the legacy role string; falls back to the static legacy table if the roles
 * tables don't exist yet (API deployed before the migration ran).
 */
async function loadPermissions(pool, userRow) {
  const legacyKey = String(userRow.role || '').toLowerCase();
  if (legacyKey === 'super_admin') {
    return { roleKey: 'super_admin', roleName: 'Super Admin', permissions: normalizePermissions(all(full)) };
  }
  try {
    const r = await pool.query(
      `SELECT r.id, r.key, r.name, rp.module_key, rp.can_read, rp.can_write, rp.can_delete
       FROM roles r
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       WHERE r.id = COALESCE($1::int, (SELECT id FROM roles WHERE key = $2 LIMIT 1))`,
      [userRow.role_id || null, legacyKey],
    );
    if (r.rows.length === 0) {
      return { roleKey: legacyKey, roleName: legacyKey, permissions: legacyPermissionsFor(legacyKey) };
    }
    const perms = {};
    for (const row of r.rows) {
      if (row.module_key) perms[row.module_key] = { read: row.can_read, write: row.can_write, delete: row.can_delete };
    }
    const key = r.rows[0].key;
    if (key === 'super_admin') return { roleKey: key, roleName: r.rows[0].name, permissions: normalizePermissions(all(full)) };
    return { roleKey: key, roleName: r.rows[0].name, permissions: normalizePermissions(perms) };
  } catch (err) {
    // 42P01 = undefined_table: roles not migrated yet.
    if (err.code !== '42P01') console.warn('[permissions] falling back to legacy roles:', err.message);
    return { roleKey: legacyKey, roleName: legacyKey, permissions: legacyPermissionsFor(legacyKey) };
  }
}

function actionForMethod(method) {
  const m = String(method || 'GET').toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return 'read';
  if (m === 'DELETE') return 'delete';
  return 'write';
}

function hasPermission(user, moduleKey, action) {
  if (!user) return false;
  if (String(user.role || '').toLowerCase() === 'super_admin') return true;
  const p = user.permissions && user.permissions[moduleKey];
  return !!(p && p[action]);
}

/** Express middleware: the request's HTTP method must be allowed on `moduleKey` for this user. */
function requireModule(moduleKey, label) {
  const name = label || (MODULES.find((m) => m.key === moduleKey) || {}).label || moduleKey;
  return (req, res, next) => {
    const action = actionForMethod(req.method);
    if (hasPermission(req.user, moduleKey, action)) return next();
    const verb = action === 'read' ? 'view' : action === 'delete' ? 'delete in' : 'make changes in';
    return res.status(403).json({ success: false, message: `Your role is not allowed to ${verb} ${name}.` });
  };
}

module.exports = {
  MODULES, MODULE_KEYS, LEGACY_ROLES,
  emptyPermissions, normalizePermissions, legacyPermissionsFor, loadPermissions,
  actionForMethod, hasPermission, requireModule,
};
