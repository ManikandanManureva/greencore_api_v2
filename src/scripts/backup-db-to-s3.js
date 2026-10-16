/**
 * Daily database backup to S3, keeping the last 7 days.
 *
 *  1. pg_dump the database in custom format (compressed; restore with pg_restore).
 *  2. Upload it to s3://$AWS_S3_BUCKET/db-backups/<db>_<YYYY-MM-DD_HHmm>.dump (server-side encrypted).
 *  3. Only after a successful upload: delete backups in that folder older than 7 days, so a
 *     failed night never removes the copies you still have.
 *
 * Uses the same .env as the API (DB_* and AWS_*). Scheduled nightly by scripts/install-db-backup-cron.sh.
 *
 * Usage:
 *   node src/scripts/backup-db-to-s3.js            # back up now
 *   node src/scripts/backup-db-to-s3.js --dry-run  # make the dump only; no upload, no deletes
 *
 * Restore (example):
 *   aws s3 cp s3://<bucket>/db-backups/<file>.dump /tmp/restore.dump
 *   pg_restore -h <host> -U <user> -d <database> --clean --if-exists /tmp/restore.dump
 */
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} = require('@aws-sdk/client-s3');

const PREFIX = 'db-backups/';
const KEEP_DAYS = 7;
const dryRun = process.argv.includes('--dry-run');

function stamp() {
  // Plant time (WIB) in the file name: greencorev2_2026-10-16_2355.dump
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Jakarta',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}_${parts.hour}${parts.minute}`;
}

function dump(file) {
  return new Promise((resolve, reject) => {
    const pgDump = process.env.PG_DUMP_PATH || 'pg_dump';
    const args = [
      '-h', process.env.DB_HOST || '127.0.0.1',
      '-p', String(process.env.DB_PORT || 5432),
      '-U', process.env.DB_USER || 'postgres',
      '-d', process.env.DB_NAME || 'greencorev2',
      '-Fc',
      '-f', file,
    ];
    const child = spawn(pgDump, args, { env: { ...process.env, PGPASSWORD: process.env.DB_PASSWORD || '' } });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => reject(new Error(`Could not run pg_dump (${err.message}). Set PG_DUMP_PATH if it is not on PATH.`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`pg_dump exited with ${code}: ${stderr.trim()}`))));
  });
}

async function run() {
  const dbName = process.env.DB_NAME || 'greencorev2';
  const name = `${dbName}_${stamp()}.dump`;
  const file = path.join(os.tmpdir(), name);
  const started = Date.now();
  try {
    await dump(file);
    const size = fs.statSync(file).size;
    if (size === 0) throw new Error('pg_dump produced an empty file');
    console.log(`✅ Dump ${name} (${(size / 1024 / 1024).toFixed(1)} MB) in ${Math.round((Date.now() - started) / 1000)}s`);

    if (dryRun) {
      console.log(`Dry run: kept ${file}; nothing uploaded or deleted.`);
      return;
    }

    const bucket = process.env.AWS_S3_BUCKET;
    const region = process.env.AWS_REGION;
    if (!bucket || !region) throw new Error('AWS_S3_BUCKET and AWS_REGION must be set in .env');
    const s3 = new S3Client({ region });

    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: PREFIX + name,
      Body: fs.createReadStream(file),
      ContentLength: size,
      ContentType: 'application/octet-stream',
      ServerSideEncryption: 'AES256',
    }));
    console.log(`✅ Uploaded s3://${bucket}/${PREFIX}${name}`);

    // Retention: remove backups older than KEEP_DAYS (only now that today's copy is safe).
    try {
      const cutoff = Date.now() - KEEP_DAYS * 24 * 3600 * 1000;
      const old = [];
      let token;
      do {
        const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: PREFIX, ContinuationToken: token }));
        for (const o of page.Contents || []) {
          if (o.Key !== PREFIX + name && o.LastModified && o.LastModified.getTime() < cutoff) old.push({ Key: o.Key });
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      if (old.length) {
        await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: old, Quiet: true } }));
      }
      console.log(`✅ Retention: removed ${old.length} backup(s) older than ${KEEP_DAYS} days`);
    } catch (err) {
      // Today's backup is uploaded; only the clean-up failed (e.g. no s3:ListBucket / s3:DeleteObject).
      console.error(`⚠ Retention clean-up failed: ${err.message}`);
    }
  } finally {
    if (!dryRun && fs.existsSync(file)) fs.unlinkSync(file);
  }
}

run().catch((err) => {
  console.error(`❌ Backup failed: ${err.message}`);
  process.exit(1);
});
