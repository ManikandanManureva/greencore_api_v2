/**
 * One-off migration: upload existing local production photos to S3 and repoint
 * production_logs.photo_url at the uploaded object's key (the bucket is private, so a
 * fresh signed URL is generated on every read — see resolvePhotoUrl in routes/production.js).
 * Local files are left in place (not deleted) so they remain as a backup.
 *
 * Run from repo root: node src/scripts/migrate-photos-to-s3.js [--dry-run]
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../config/database');
const { isS3Configured, uploadBuffer } = require('../config/s3');

const PHOTO_UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads', 'production');
const DRY_RUN = process.argv.includes('--dry-run');

const CONTENT_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

// Matches old local URLs like http://host:3000/uploads/production/<filename>.jpg
function extractLocalFilename(url) {
  const m = String(url || '').match(/\/uploads\/production\/([^/?#]+)$/);
  return m ? m[1] : null;
}

async function migrateOneUrl(url) {
  const filename = extractLocalFilename(url);
  if (!filename) return url; // not a local-upload URL (e.g. already on S3) — leave as-is

  const localPath = path.join(PHOTO_UPLOAD_DIR, filename);
  if (!fs.existsSync(localPath)) {
    console.warn(`  ! local file missing, skipping: ${filename}`);
    return url;
  }

  if (DRY_RUN) {
    console.log(`  would upload: ${filename}`);
    return url;
  }

  const buffer = fs.readFileSync(localPath);
  const ext = path.extname(filename).toLowerCase();
  const key = `production/${filename}`;
  await uploadBuffer(buffer, key, CONTENT_TYPES[ext] || 'application/octet-stream');
  console.log(`  uploaded: ${filename} -> ${key}`);
  return key;
}

async function run() {
  if (!isS3Configured()) {
    console.error('S3 is not configured — set AWS_REGION and AWS_S3_BUCKET (and credentials) in .env first.');
    process.exit(1);
  }
  if (DRY_RUN) console.log('--- DRY RUN: no uploads or DB writes will happen ---');

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, photo_url FROM production_logs WHERE photo_url ILIKE '%/uploads/production/%'`
    );
    console.log(`Found ${rows.length} row(s) with local photo URLs.`);

    let migrated = 0;
    for (const row of rows) {
      console.log(`Row ${row.id}: ${row.photo_url}`);
      const parts = String(row.photo_url).split(',').map((s) => s.trim()).filter(Boolean);
      const newParts = [];
      for (const part of parts) {
        newParts.push(await migrateOneUrl(part));
      }
      const newPhotoUrl = newParts.join(',');

      if (!DRY_RUN && newPhotoUrl !== row.photo_url) {
        await client.query('UPDATE production_logs SET photo_url = $1 WHERE id = $2', [newPhotoUrl, row.id]);
        migrated++;
      }
    }

    console.log(DRY_RUN ? 'Dry run complete.' : `Done. Updated ${migrated} row(s). Local files were kept as backup.`);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
