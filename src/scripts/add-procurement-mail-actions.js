// Personal, single-use links for approving / sending back a PB from an email. Idempotent.
require('dotenv').config();
const pool = require('../config/database');
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS proc_mail_actions (
        id          SERIAL PRIMARY KEY,
        token_hash  CHAR(64) UNIQUE NOT NULL,
        request_id  INTEGER NOT NULL REFERENCES proc_requests(id) ON DELETE CASCADE,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        stage_no    INTEGER,
        expires_at  TIMESTAMPTZ NOT NULL,
        used_at     TIMESTAMPTZ,
        used_action VARCHAR(20),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await pool.query('CREATE INDEX IF NOT EXISTS ix_proc_mail_actions_request ON proc_mail_actions (request_id)');
    console.log('proc_mail_actions ready.');
  } catch (err) { console.error('Migration failed:', err); process.exit(1); } finally { await pool.end(); }
})();
