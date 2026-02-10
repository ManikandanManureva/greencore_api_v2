const { Pool } = require('pg');
require('dotenv').config();

const dbHost = process.env.DB_HOST || '127.0.0.1';
const dbPort = process.env.DB_PORT || 5432;

const pool = new Pool({
  host: dbHost,
  port: Number(dbPort) || 5432,
  database: process.env.DB_NAME || 'greencorev2',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'password',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 60000, // 60s – avoid timeout when Postgres is slow to accept (e.g. Docker)
});

// Log so EC2 logs show what DB we're connecting to (no password)
console.log('DB config:', { host: dbHost, port: dbPort, database: process.env.DB_NAME || 'greencorev2' });

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

module.exports = pool;
