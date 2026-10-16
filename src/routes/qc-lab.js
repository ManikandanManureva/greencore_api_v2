const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { isS3Configured, uploadBuffer, getSignedUrlForKey, keyFromS3Url } = require('../config/s3');

/**
 * QC Lab — Pellet Finish Good sampling. Mirrors "QC LAB - PELLETS REPORT.xlsx" column-for-column
 * (see create-qc-lab.js for the full field list and the three server-computed fields: grade,
 * density, blue). QC_LAB is a dedicated login scoped to only this module; PPIC/Admin can also
 * use it for oversight/correction.
 */
const ALLOWED_ROLES = ['qc_lab', 'ppic', 'super_admin', 'admin'];

const PHOTO_UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads', 'qc-lab');
fs.mkdirSync(PHOTO_UPLOAD_DIR, { recursive: true });

function makePhotoFilename(originalname) {
  const ext = path.extname(originalname || '').toLowerCase() || '.jpg';
  return `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
}

// The IV photo is stored as a bare S3 object key (URLs expire, keys don't) — same convention
// as production_logs.photo_url. A value is only treated as a key when it isn't itself a usable
// URL (the local-disk fallback stores a full http(s) URL instead).
function normalizePhotoForStorage(value) {
  if (!value) return value;
  const key = keyFromS3Url(value);
  return key || value;
}

// Turn whatever is stored back into something a client can load right now: local-disk URLs
// pass through unchanged; bare S3 keys get a freshly-signed GET URL.
async function resolvePhotoUrl(value) {
  if (!value) return value;
  if (/^https?:\/\//i.test(value)) return value;
  if (isS3Configured()) {
    try {
      return await getSignedUrlForKey(value);
    } catch (err) {
      console.error('Failed to sign QC Lab photo URL for key', value, err);
      return value;
    }
  }
  return value;
}

// Uploads an IV-reading photo buffer to S3 (preferred) or local disk, returning the value to
// store (S3: bare key; local disk: full URL) and a URL usable immediately.
async function persistIvPhoto(req, buffer, mimetype, originalname) {
  const filename = makePhotoFilename(originalname);
  if (isS3Configured()) {
    const key = `qc-lab/${filename}`;
    const url = await uploadBuffer(buffer, key, mimetype);
    return { stored: key, url };
  }
  fs.writeFileSync(path.join(PHOTO_UPLOAD_DIR, filename), buffer);
  const url = `${req.protocol}://${req.get('host')}/uploads/qc-lab/${filename}`;
  return { stored: url, url };
}

function requireRole(req, res, next) {
  const role = String(req.user && req.user.role ? req.user.role : '').toLowerCase();
  if (!ALLOWED_ROLES.includes(role)) {
    return res.status(403).json({ success: false, message: 'Not authorized to access QC Lab' });
  }
  next();
}

router.use(authenticateToken, requireRole);

function actorName(req) {
  return (req.user && (req.user.name || req.user.employeeId)) || null;
}

// Replicates the workbook's Grade formula exactly:
// =IFERROR(IF(AND(IV>=0.77,IV<=0.833),"SPS",IF(AND(IV>=0.84,IV<=0.86),"Jugs","Out Spec")),"")
function computeGrade(iv) {
  if (iv == null || iv === '' || !Number.isFinite(Number(iv))) return '';
  const v = Number(iv);
  if (v >= 0.77 && v <= 0.833) return 'SPS';
  if (v >= 0.84 && v <= 0.86) return 'Jugs';
  return 'Out Spec';
}

const INPUT_FIELDS = [
  'batch_no', 'bag_no', 'sampling_date', 'sampling_time', 'sampling_point', 'colour', 'qty_kg', 'pic',
  'iv', 'pellet_size', 'bulk_density', 'moisture', 'melting_point',
  'color_l', 'color_a', 'color_b',
  'foreign_material', 'filaments_angel_hair', 'fines', 'black_specs',
  'black_spot_gt_1mm', 'black_spot_0_5_1mm', 'black_spot_0_1_0_5mm',
  'miscut', 'duplet', 'triplet', 'undersize', 'oversize', 'tail', 'aglomerat', 'white',
  'notes', 'iv_photo_url',
];
const NUMERIC_FIELDS = [
  'qty_kg', 'iv', 'pellet_size', 'bulk_density', 'moisture', 'melting_point',
  'color_l', 'color_a', 'color_b', 'foreign_material', 'filaments_angel_hair', 'fines', 'black_specs',
  'black_spot_gt_1mm', 'black_spot_0_5_1mm', 'black_spot_0_1_0_5mm',
  'miscut', 'duplet', 'triplet', 'undersize', 'oversize', 'tail', 'aglomerat', 'white',
];

function cleanValue(field, value) {
  if (value === '' || value === undefined) return null;
  if (NUMERIC_FIELDS.includes(field)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (field === 'iv_photo_url') return normalizePhotoForStorage(value);
  return value;
}

// ─── List ───────────────────────────────────────────────────────────────────────
router.get('/samples', async (req, res) => {
  try {
    const { search, batch_no, sampling_point, colour, grade, date_from, date_to, page = 1, limit = 20 } = req.query;
    const where = [];
    const params = [];

    if (search && String(search).trim()) {
      params.push(`%${String(search).trim()}%`);
      where.push(`(batch_no ILIKE $${params.length} OR bag_no ILIKE $${params.length} OR pic ILIKE $${params.length})`);
    }
    if (batch_no && batch_no !== 'all') { params.push(batch_no); where.push(`batch_no = $${params.length}`); }
    if (sampling_point && sampling_point !== 'all') { params.push(sampling_point); where.push(`sampling_point = $${params.length}`); }
    if (colour && colour !== 'all') { params.push(colour); where.push(`colour = $${params.length}`); }
    if (grade && grade !== 'all') { params.push(grade); where.push(`grade = $${params.length}`); }
    if (date_from) { params.push(date_from); where.push(`sampling_date >= $${params.length}`); }
    if (date_to) { params.push(date_to); where.push(`sampling_date <= $${params.length}`); }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const countRes = await pool.query(`SELECT COUNT(*)::int AS total FROM qc_lab_samples ${whereSql}`, params);
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const listParams = [...params, parseInt(limit), offset];
    const rowsRes = await pool.query(
      `SELECT * FROM qc_lab_samples ${whereSql}
       ORDER BY sampling_date DESC, id DESC
       LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams,
    );
    const total = countRes.rows[0].total;
    const data = await Promise.all(rowsRes.rows.map(async (row) => ({
      ...row, iv_photo_url: await resolvePhotoUrl(row.iv_photo_url),
    })));
    res.json({
      success: true, data, page: parseInt(page), limit: parseInt(limit),
      total, totalPages: Math.max(1, Math.ceil(total / parseInt(limit))),
    });
  } catch (err) {
    console.error('QC Lab list error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load samples' });
  }
});

router.get('/batches', async (req, res) => {
  try {
    const r = await pool.query('SELECT DISTINCT batch_no FROM qc_lab_samples ORDER BY batch_no DESC');
    res.json({ success: true, data: r.rows.map((x) => x.batch_no) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to load batches' });
  }
});

// Grade distribution + key averages — for a small summary strip above the table.
router.get('/summary', async (req, res) => {
  try {
    const { date_from, date_to } = req.query;
    const where = [];
    const params = [];
    if (date_from) { params.push(date_from); where.push(`sampling_date >= $${params.length}`); }
    if (date_to) { params.push(date_to); where.push(`sampling_date <= $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const r = await pool.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE grade = 'SPS')::int AS sps_count,
         COUNT(*) FILTER (WHERE grade = 'Jugs')::int AS jugs_count,
         COUNT(*) FILTER (WHERE grade = 'Out Spec')::int AS out_spec_count,
         ROUND(AVG(iv)::numeric, 3) AS avg_iv,
         ROUND(AVG(bulk_density)::numeric, 2) AS avg_bulk_density,
         ROUND(AVG(moisture)::numeric, 3) AS avg_moisture
       FROM qc_lab_samples ${whereSql}`,
      params,
    );
    res.json({ success: true, data: r.rows[0] });
  } catch (err) {
    console.error('QC Lab summary error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load summary' });
  }
});

router.get('/samples/:id', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM qc_lab_samples WHERE id = $1', [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ success: false, message: 'Sample not found' });
    const row = r.rows[0];
    row.iv_photo_url = await resolvePhotoUrl(row.iv_photo_url);
    res.json({ success: true, data: row });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to load sample' });
  }
});

// ─── Create ─────────────────────────────────────────────────────────────────────
router.post('/samples', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.batch_no || !String(b.batch_no).trim()) {
      return res.status(400).json({ success: false, message: 'Batch No is required' });
    }
    if (!b.sampling_date) {
      return res.status(400).json({ success: false, message: 'Sampling Date is required' });
    }

    const cols = ['grade', 'density', 'blue', '"createdBy"', '"updatedBy"'];
    const grade = computeGrade(b.iv);
    const density = b.bulk_density != null && b.bulk_density !== '' ? Number(b.bulk_density) / 1000 : null;
    const white = b.white != null && b.white !== '' ? Number(b.white) : null;
    const blue = white != null ? 100 - white : null;
    const actor = actorName(req);
    const vals = [grade, density, blue, actor, actor];

    for (const f of INPUT_FIELDS) {
      if (b[f] !== undefined) {
        cols.push(f);
        vals.push(cleanValue(f, b[f]));
      }
    }
    const placeholders = vals.map((_, i) => `$${i + 1}`);
    const r = await pool.query(
      `INSERT INTO qc_lab_samples (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
      vals,
    );
    const row = r.rows[0];
    row.iv_photo_url = await resolvePhotoUrl(row.iv_photo_url);
    res.status(201).json({ success: true, data: row });
  } catch (err) {
    console.error('QC Lab create error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create sample' });
  }
});

// ─── Update ─────────────────────────────────────────────────────────────────────
router.put('/samples/:id', async (req, res) => {
  try {
    const existing = await pool.query('SELECT * FROM qc_lab_samples WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ success: false, message: 'Sample not found' });
    const prev = existing.rows[0];
    const b = req.body || {};

    const sets = [];
    const vals = [];
    for (const f of INPUT_FIELDS) {
      if (b[f] !== undefined) {
        vals.push(cleanValue(f, b[f]));
        sets.push(`${f} = $${vals.length}`);
      }
    }

    // Recompute the three derived fields whenever their inputs change.
    const newIv = b.iv !== undefined ? cleanValue('iv', b.iv) : prev.iv;
    vals.push(computeGrade(newIv)); sets.push(`grade = $${vals.length}`);

    const newBulkDensity = b.bulk_density !== undefined ? cleanValue('bulk_density', b.bulk_density) : prev.bulk_density;
    vals.push(newBulkDensity != null ? Number(newBulkDensity) / 1000 : null); sets.push(`density = $${vals.length}`);

    const newWhite = b.white !== undefined ? cleanValue('white', b.white) : prev.white;
    vals.push(newWhite != null ? 100 - Number(newWhite) : null); sets.push(`blue = $${vals.length}`);

    vals.push(actorName(req)); sets.push(`"updatedBy" = $${vals.length}`);
    sets.push(`"updatedAt" = NOW()`);
    vals.push(req.params.id);

    const r = await pool.query(
      `UPDATE qc_lab_samples SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`,
      vals,
    );
    const row = r.rows[0];
    row.iv_photo_url = await resolvePhotoUrl(row.iv_photo_url);
    res.json({ success: true, data: row });
  } catch (err) {
    console.error('QC Lab update error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update sample' });
  }
});

router.delete('/samples/:id', async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM qc_lab_samples WHERE id = $1 RETURNING id', [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ success: false, message: 'Sample not found' });
    res.json({ success: true, message: 'Sample deleted' });
  } catch (err) {
    console.error('QC Lab delete error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete sample' });
  }
});

// ─── IV OCR ─────────────────────────────────────────────────────────────────────
// Reads the Intrinsic Viscosity value off a lab instrument's display/printout photo via
// OpenAI vision (same model/prompt style as production.js's /ocr-weight), and — unlike that
// route — also persists the photo (S3 when configured, else local disk) so it can be reviewed
// later from the sample record. Returns `stored` (what the client should submit back as
// iv_photo_url when saving the sample) and `photo_url` (a URL usable immediately for preview).
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed'));
    }
    cb(null, true);
  },
});

router.post('/ocr-iv', (req, res) => {
  photoUpload.single('image')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ success: false, message: err.message || 'Upload failed' });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No image provided' });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ success: false, message: 'OCR is not configured on the server' });
    }
    try {
      const base64 = req.file.buffer.toString('base64');
      const mime = req.file.mimetype || 'image/jpeg';
      const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text:
                    'This photo shows a lab instrument\'s display or printout for an Intrinsic Viscosity (IV) ' +
                    'measurement of PET pellets, in dl/g. Typical readings are between 0.6 and 0.9. Read the IV ' +
                    'value shown. Respond with ONLY the number (e.g. "0.798"), no units, no other words. If no ' +
                    'readable IV value is visible, respond with exactly "NONE".',
                },
                { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
              ],
            },
          ],
          max_tokens: 20,
          temperature: 0,
        }),
      });
      if (!aiRes.ok) {
        const errText = await aiRes.text();
        console.error('OpenAI OCR error:', aiRes.status, errText);
        return res.status(502).json({ success: false, message: 'OCR service error' });
      }
      const aiJson = await aiRes.json();
      const raw = (aiJson?.choices?.[0]?.message?.content || '').trim();
      const match = raw.match(/-?\d+(\.\d+)?/);
      const iv = match ? parseFloat(match[0]) : null;

      let stored = null;
      let photoUrl = null;
      try {
        const persisted = await persistIvPhoto(req, req.file.buffer, mime, req.file.originalname);
        stored = persisted.stored;
        photoUrl = persisted.url;
      } catch (storeErr) {
        // Don't fail the whole OCR read just because the photo couldn't be saved —
        // the IV value is still usable without it.
        console.error('Failed to store IV photo:', storeErr);
      }

      res.json({ success: true, iv, raw, stored, photo_url: photoUrl });
    } catch (ocrErr) {
      console.error('IV OCR failed:', ocrErr);
      res.status(500).json({ success: false, message: 'Failed to read IV from photo' });
    }
  });
});

module.exports = router;
