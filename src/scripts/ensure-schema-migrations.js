/**
 * Run on the server to add any missing columns to the existing database.
 * Safe to run multiple times (uses IF NOT EXISTS).
 *
 * On EC2: cd /home/greencore_api_v2 && node src/scripts/ensure-schema-migrations.js
 */
require('dotenv').config();
const pool = require('../config/database');

const MIGRATIONS = [
  {
    name: 'refresh_tokens table',
    sql: `CREATE TABLE IF NOT EXISTS refresh_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      token VARCHAR(500) UNIQUE NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      is_revoked BOOLEAN DEFAULT false
    )`,
  },
  { name: 'refresh_tokens.is_revoked', sql: 'ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS is_revoked BOOLEAN DEFAULT false' },
  { name: 'operator_shifts.end_remark', sql: 'ALTER TABLE operator_shifts ADD COLUMN IF NOT EXISTS end_remark TEXT' },
  { name: 'by_product_logs.category', sql: 'ALTER TABLE by_product_logs ADD COLUMN IF NOT EXISTS category VARCHAR(100)' },
  { name: 'users.last_login_at', sql: 'ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP' },
  { name: 'users.material_type_id', sql: 'ALTER TABLE users ADD COLUMN IF NOT EXISTS material_type_id INTEGER' },
  { name: 'stations.code', sql: 'ALTER TABLE stations ADD COLUMN IF NOT EXISTS code VARCHAR(10)' },
  { name: 'production_logs.material_type_id', sql: 'ALTER TABLE production_logs ADD COLUMN IF NOT EXISTS material_type_id INTEGER' },
  { name: 'production_logs.sub_line', sql: 'ALTER TABLE production_logs ADD COLUMN IF NOT EXISTS sub_line VARCHAR(50)' },
  { name: 'production_logs.used_line', sql: 'ALTER TABLE production_logs ADD COLUMN IF NOT EXISTS used_line VARCHAR(50)' },
  { name: 'production_logs.remark', sql: 'ALTER TABLE production_logs ADD COLUMN IF NOT EXISTS remark TEXT' },
];

async function run() {
  const client = await pool.connect();
  try {
    console.log('Running schema migrations (add missing columns)...');
    for (const m of MIGRATIONS) {
      try {
        await client.query(m.sql);
        console.log('  ✅', m.name);
      } catch (err) {
        if (err.code === '42P01') {
          console.log('  ⏭️', m.name, '(table does not exist yet, skip)');
        } else {
          throw err;
        }
      }
    }
    console.log('Done.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
