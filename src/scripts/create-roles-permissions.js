/**
 * Migration: configurable roles with per-module read / write / delete access.
 *
 *   roles            — one row per role (seeded from the roles that existed as plain strings)
 *   role_permissions — module_key × role with can_read / can_write / can_delete
 *   users.role_id    — link to roles (users.role string is kept in sync for legacy checks)
 *   users.phone      — contact number shown in User Management
 *
 * Idempotent: re-running never changes a role that already exists (admins may have edited it).
 */
require('dotenv').config();
const pool = require('../config/database');
const { LEGACY_ROLES, MODULE_KEYS, normalizePermissions } = require('../middleware/permissions');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS roles (
        id          SERIAL PRIMARY KEY,
        key         VARCHAR(50) UNIQUE NOT NULL,
        name        VARCHAR(100) NOT NULL,
        description TEXT,
        is_system   BOOLEAN NOT NULL DEFAULT false,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS role_permissions (
        role_id    INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        module_key VARCHAR(50) NOT NULL,
        can_read   BOOLEAN NOT NULL DEFAULT false,
        can_write  BOOLEAN NOT NULL DEFAULT false,
        can_delete BOOLEAN NOT NULL DEFAULT false,
        PRIMARY KEY (role_id, module_key)
      )`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role_id INTEGER REFERENCES roles(id) ON DELETE SET NULL`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(40)`);

    for (const role of LEGACY_ROLES) {
      const ins = await client.query(
        `INSERT INTO roles (key, name, description, is_system) VALUES ($1, $2, $3, $4)
         ON CONFLICT (key) DO NOTHING RETURNING id`,
        [role.key, role.name, role.description || null, role.is_system === true],
      );
      if (ins.rows.length === 0) continue; // existed already — leave its permissions alone
      const perms = normalizePermissions(role.permissions);
      for (const k of MODULE_KEYS) {
        await client.query(
          `INSERT INTO role_permissions (role_id, module_key, can_read, can_write, can_delete) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT DO NOTHING`,
          [ins.rows[0].id, k, perms[k].read, perms[k].write, perms[k].delete],
        );
      }
    }

    // Link every user whose legacy role string matches a role key.
    const linked = await client.query(
      `UPDATE users u SET role_id = r.id FROM roles r
       WHERE u.role_id IS NULL AND LOWER(u.role) = r.key RETURNING u.id`,
    );
    await client.query('COMMIT');
    console.log(`roles / role_permissions ready; ${linked.rowCount} user(s) linked to a role.`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
