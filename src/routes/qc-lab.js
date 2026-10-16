const express = require('express');
const router = express.Router();
const multer = require('multer');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

/**
 * QC Lab — Pellet Finish Good sampling. Mirrors "QC LAB - PELLETS REPORT.xlsx" column-for-column
 * (see create-qc-lab.js for the full field list and the three server-computed fields: grade,
 * density, blue). QC_LAB is a dedicated login scoped to only this module; PPIC/Admin can also
 * use it for oversight/correction.
 */
const ALLOWED_ROLES = ['qc_lab', 'ppic', 'super_admin', 'admin'];

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
  'notes',
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
    res.json({
      success: true, data: rowsRes.rows, page: parseInt(page), limit: parseInt(limit),
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
    res.json({ success: true, data: r.rows[0] });
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
    res.status(201).json({ success: true, data: r.rows[0] });
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
    res.json({ success: true, data: r.rows[0] });
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
// OpenAI vision, mirroring production.js's /ocr-weight route exactly (same model, same
// in-memory-only handling — the image is never written to disk or S3).
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
      res.json({ success: true, iv, raw });
    } catch (ocrErr) {
      console.error('IV OCR failed:', ocrErr);
      res.status(500).json({ success: false, message: 'Failed to read IV from photo' });
    }
  });
});

module.exports = router;
