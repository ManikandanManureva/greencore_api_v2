const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const pdfParse = require('pdf-parse');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { isS3Configured, uploadBuffer, getSignedUrlForKey, keyFromS3Url } = require('../config/s3');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const PACKING_LIST_UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads', 'finished-goods');
fs.mkdirSync(PACKING_LIST_UPLOAD_DIR, { recursive: true });

function makeUploadFilename(originalname) {
  const ext = path.extname(originalname || '').toLowerCase() || '.pdf';
  return `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
}

function normalizePackingListForStorage(value) {
  if (!value) return value;
  const key = keyFromS3Url(value);
  return key || value;
}

async function resolvePackingListUrl(value) {
  if (!value) return value;
  if (/^https?:\/\//i.test(value) && !keyFromS3Url(value)) return value;
  if (isS3Configured()) {
    const key = keyFromS3Url(value) || value;
    try { return await getSignedUrlForKey(key); }
    catch (err) { console.error('Failed to sign packing list URL for key', key, err); return value; }
  }
  return value;
}

async function persistPackingList(req, buffer, mimetype, originalname) {
  const filename = makeUploadFilename(originalname);
  if (isS3Configured()) {
    const key = `finished-goods/${filename}`;
    const url = await uploadBuffer(buffer, key, mimetype);
    return { stored: key, url };
  }
  fs.writeFileSync(path.join(PACKING_LIST_UPLOAD_DIR, filename), buffer);
  const url = `${req.protocol}://${req.get('host')}/uploads/finished-goods/${filename}`;
  return { stored: url, url };
}

/**
 * Outgoing / Sales — three categories sharing one shipments table (finished_goods_shipments.category):
 *   finished_goods — finished pellets. Produced = Completed, unconsumed output at the material's
 *                     finishing station(s) (Extrusion and/or Packing — see CATEGORY_STATIONS).
 *   flakes         — Produced = Completed, unconsumed output at the Washing station.
 *   by_products    — Produced = SUM(weight) already logged per shift in by_product_logs (the
 *                     per-station by-products collection that already exists) — no lineage
 *                     exclusion, since by-products aren't re-processed as input to another step.
 * Quantities only — no pricing.
 */
const ALLOWED_ROLES = ['ppic', 'super_admin', 'admin'];
const CATEGORIES = ['finished_goods', 'flakes', 'by_products'];
const MATERIALS = ['PC', 'PE', 'PET'];

function requireRole(req, res, next) {
  const role = String(req.user && req.user.role ? req.user.role : '').toLowerCase();
  if (!ALLOWED_ROLES.includes(role)) {
    return res.status(403).json({ success: false, message: 'Not authorized to access Outgoing / Sales' });
  }
  next();
}

router.use(authenticateToken, requireRole);

function parseCategory(value) {
  return CATEGORIES.includes(value) ? value : 'finished_goods';
}

function actorName(req) {
  return (req.user && (req.user.name || req.user.employeeId)) || null;
}

// Material -> station codes whose Completed, unconsumed output counts as produced stock,
// per category. by_products has no entry here — it's computed from by_product_logs instead.
const CATEGORY_STATIONS = {
  finished_goods: { PC: ['EXT', 'PKG'], PE: ['EXT'], PET: ['EXT', 'PKG'] },
  flakes: { PC: ['WSH'], PE: ['WSH'], PET: ['WSH'] },
};

// Each material clause optionally gets "AND pl.created_at >= cutoff" when an opening stock
// balance has been set for that material — so produced is counted only from the point the
// opening balance was taken, instead of double-counting production already folded into it.
// A material with no opening stock yet keeps the old all-time behaviour (no cutoff).
function stationsSql(stationMap, cutoffMap, paramsOffset) {
  const clauses = [];
  const params = [];
  let i = paramsOffset;
  for (const [material, codes] of Object.entries(stationMap)) {
    params.push(material, codes);
    let clause = `(mt.name = $${i + 1} AND s.code = ANY($${i + 2})`;
    i += 2;
    const cutoff = cutoffMap[material];
    if (cutoff) {
      params.push(cutoff);
      i += 1;
      clause += ` AND pl.created_at >= $${i}`;
    }
    clauses.push(`${clause})`);
  }
  return { sql: clauses.join(' OR '), params };
}

async function producedByStation(client, stationMap, cutoffMap) {
  const { sql, params } = stationsSql(stationMap, cutoffMap, 0);
  const r = await client.query(
    `SELECT mt.name AS material, COALESCE(SUM(pl.weight), 0)::numeric AS produced_weight, COUNT(*)::int AS bag_count
     FROM production_logs pl
     JOIN stations s ON s.id = pl.station_id
     JOIN material_types mt ON mt.id = pl.material_type_id
     WHERE pl.status = 'Completed'
       AND (${sql})
       AND NOT EXISTS (
         SELECT 1 FROM production_logs px
         WHERE px.input_bag_qr = pl.output_bag_qr AND px.input_bag_qr IS NOT NULL AND px.input_bag_qr <> ''
       )
     GROUP BY mt.name`,
    params,
  );
  return r.rows;
}

function byProductSql(cutoffMap, paramsOffset) {
  const clauses = [];
  const params = [];
  let i = paramsOffset;
  for (const material of MATERIALS) {
    params.push(material);
    let clause = `(mt.name = $${i + 1}`;
    i += 1;
    const cutoff = cutoffMap[material];
    if (cutoff) {
      params.push(cutoff);
      i += 1;
      clause += ` AND b.created_at >= $${i}`;
    }
    clauses.push(`${clause})`);
  }
  return { sql: clauses.join(' OR '), params };
}

async function producedByProduct(client, cutoffMap) {
  const { sql, params } = byProductSql(cutoffMap, 0);
  const r = await client.query(
    `SELECT mt.name AS material, COALESCE(SUM(b.weight), 0)::numeric AS produced_weight, COUNT(*)::int AS bag_count
     FROM by_product_logs b
     JOIN operator_shifts os ON os.id = b.shift_id
     JOIN material_types mt ON mt.id = os.material_type_id
     WHERE (${sql})
     GROUP BY mt.name`,
    params,
  );
  return r.rows;
}

async function producedByMaterial(client, category, cutoffMap = {}) {
  if (category === 'by_products') return producedByProduct(client, cutoffMap);
  return producedByStation(client, CATEGORY_STATIONS[category], cutoffMap);
}

async function openingStockByMaterial(client, category) {
  const r = await client.query(
    `SELECT mt.name AS material, o.weight_kg::numeric AS weight_kg, o."createdAt" AS created_at
     FROM finished_goods_opening_stock o
     JOIN material_types mt ON mt.id = o.material_type_id
     WHERE o.category = $1`,
    [category],
  );
  return Object.fromEntries(r.rows.map((row) => [row.material, { weight: Number(row.weight_kg), createdAt: row.created_at }]));
}

function cutoffMapFrom(opening) {
  return Object.fromEntries(Object.entries(opening).map(([material, o]) => [material, o.createdAt]));
}

// ─── Opening Stock — one-time go-live balance per category + material ─────────
router.get('/opening-stock', async (req, res) => {
  try {
    const category = parseCategory(req.query.category);
    const r = await pool.query(
      `SELECT o.*, mt.name AS material
       FROM finished_goods_opening_stock o
       JOIN material_types mt ON mt.id = o.material_type_id
       WHERE o.category = $1`,
      [category],
    );
    const byMaterial = Object.fromEntries(r.rows.map((row) => [row.material, row]));
    const data = MATERIALS.map((material) => ({
      material,
      weight_kg: Number(byMaterial[material]?.weight_kg || 0),
      notes: byMaterial[material]?.notes || null,
      updatedAt: byMaterial[material]?.updatedAt || null,
      updatedBy: byMaterial[material]?.updatedBy || null,
    }));
    res.json({ success: true, data });
  } catch (err) {
    console.error('Opening stock list error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load opening stock' });
  }
});

router.put('/opening-stock', async (req, res) => {
  try {
    const category = parseCategory(req.body.category);
    const { material, notes } = req.body || {};
    if (!material || !MATERIALS.includes(material)) {
      return res.status(400).json({ success: false, message: 'material must be one of PC, PE, PET' });
    }
    const weightNum = Number(req.body.weight_kg);
    if (!Number.isFinite(weightNum) || weightNum < 0) {
      return res.status(400).json({ success: false, message: 'weight_kg must be a non-negative number' });
    }
    const mtRes = await pool.query('SELECT id FROM material_types WHERE name = $1', [material]);
    if (mtRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Unknown material type' });
    }
    const materialTypeId = mtRes.rows[0].id;
    const actor = actorName(req);
    const r = await pool.query(
      `INSERT INTO finished_goods_opening_stock (category, material_type_id, weight_kg, notes, "createdBy", "updatedBy")
       VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT (category, material_type_id)
       DO UPDATE SET weight_kg = $3, notes = $4, "updatedBy" = $5, "updatedAt" = NOW()
       RETURNING *`,
      [category, materialTypeId, weightNum, notes || null, actor],
    );
    res.json({ success: true, data: { ...r.rows[0], material } });
  } catch (err) {
    console.error('Opening stock save error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to save opening stock' });
  }
});

// ─── Summary — Produced / Shipped / Available per material, for one category ──
router.get('/summary', async (req, res) => {
  try {
    const category = parseCategory(req.query.category);
    const opening = await openingStockByMaterial(pool, category);
    const produced = await producedByMaterial(pool, category, cutoffMapFrom(opening));
    const shipped = await pool.query(
      `SELECT mt.name AS material, COALESCE(SUM(s.weight_kg), 0)::numeric AS shipped_weight
       FROM finished_goods_shipments s
       JOIN material_types mt ON mt.id = s.material_type_id
       WHERE s.category = $1
       GROUP BY mt.name`,
      [category],
    );
    const producedMap = Object.fromEntries(produced.map((r) => [r.material, r]));
    const shippedMap = Object.fromEntries(shipped.rows.map((r) => [r.material, Number(r.shipped_weight)]));

    const data = MATERIALS.map((material) => {
      const producedWeight = Number(producedMap[material]?.produced_weight || 0);
      const openingWeight = Number(opening[material]?.weight || 0);
      const shippedWeight = shippedMap[material] || 0;
      return {
        material,
        produced_weight: producedWeight,
        opening_weight: openingWeight,
        bag_count: Number(producedMap[material]?.bag_count || 0),
        shipped_weight: shippedWeight,
        available_weight: Math.max(producedWeight + openingWeight - shippedWeight, 0),
      };
    });
    res.json({ success: true, data });
  } catch (err) {
    console.error('Outgoing/Sales summary error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load summary' });
  }
});

// ─── Packing list extraction (upload PDF, OpenAI reads it, pre-fills the Record Shipment form) ─
const MATERIAL_HINTS = `
  Use these phrases (seen on real packing lists) to identify the material in the "Description" line:
    - "PC Recycled Pellets", "Grade A - PC Recycled Pellets", "100% Post-Consumer Recycled Pellets",
      "Polycarbonate Recycled Pellets", "PC WATER BOTTLE GRADE PELLET" -> material is "PC"
    - "LOW-DENSITY POLYETHYLENE", "LDPE", "PE Recycled Pellets" -> material is "PE"
    - "PET", "Polyethylene Terephthalate", "rPET" -> material is "PET"
`.trim();

router.post('/extract-packing-list', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    if (req.file.mimetype !== 'application/pdf' && !req.file.originalname.toLowerCase().endsWith('.pdf')) {
      return res.status(400).json({ success: false, message: 'Please upload a PDF packing list / invoice' });
    }

    const parsed = await pdfParse(req.file.buffer).catch(() => null);
    const text = (parsed?.text || '').trim();
    if (!text) {
      return res.status(422).json({ success: false, message: 'Could not read text from that PDF' });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ success: false, message: 'OCR is not configured (missing OPENAI_API_KEY)' });
    }

    const prompt = `You are reading a packing list / shipping invoice from a plastic recycling exporter.
Extract shipment details as JSON only (no prose, no markdown fences). Fields:
{
  "material": "PC" | "PE" | "PET" | null,
  "weight_kg": number | null,       // the Net Weight in kg
  "customer": string | null,        // the company name under "Invoicing and shipping address"
  "destination": string | null,     // the city/country from that same address block
  "dn_no": string | null,           // the Packing List No. / Invoice No.
  "shipment_date": "YYYY-MM-DD" | null,  // the Date field on the document
  "vehicle_no": string | null,      // container number(s) if present, else null
  "notes": string | null            // short summary of extra shipping details (vessel, pallets, package count, gross weight) if present, else null
}
${MATERIAL_HINTS}
If a field isn't present in the document, use null. Respond with JSON only.

DOCUMENT TEXT:
"""
${text.slice(0, 12000)}
"""`;

    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 500,
        temperature: 0,
      }),
    });
    if (!aiRes.ok) {
      const errText = await aiRes.text().catch(() => '');
      console.error('Packing list OCR OpenAI error:', aiRes.status, errText);
      return res.status(502).json({ success: false, message: 'Could not read the packing list right now' });
    }
    const aiJson = await aiRes.json();
    const raw = aiJson?.choices?.[0]?.message?.content || '';
    let extracted = {};
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      extracted = match ? JSON.parse(match[0]) : {};
    } catch {
      extracted = {};
    }
    if (extracted.material && !MATERIALS.includes(extracted.material)) extracted.material = null;

    const { stored, url } = await persistPackingList(req, req.file.buffer, req.file.mimetype, req.file.originalname);

    res.json({ success: true, data: extracted, stored, packing_list_url: url });
  } catch (err) {
    console.error('Packing list extraction error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to extract packing list' });
  }
});

// ─── Shipments (Outgoing / Sales) ──────────────────────────────────────────────
router.get('/shipments', async (req, res) => {
  try {
    const category = parseCategory(req.query.category);
    const { search, material, date_from, date_to } = req.query;
    const { page = 1, limit = 20 } = req.query;
    const where = [`s.category = $1`];
    const params = [category];

    if (material && material !== 'all') {
      params.push(material);
      where.push(`mt.name = $${params.length}`);
    }
    if (search && String(search).trim()) {
      params.push(`%${String(search).trim()}%`);
      where.push(`(s.customer ILIKE $${params.length} OR s.destination ILIKE $${params.length} OR s.dn_no ILIKE $${params.length} OR s.vehicle_no ILIKE $${params.length})`);
    }
    if (date_from) { params.push(date_from); where.push(`s.shipment_date >= $${params.length}`); }
    if (date_to) { params.push(date_to); where.push(`s.shipment_date <= $${params.length}`); }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS total FROM finished_goods_shipments s JOIN material_types mt ON mt.id = s.material_type_id ${whereSql}`,
      params,
    );
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const listParams = [...params, parseInt(limit), offset];
    const rowsRes = await pool.query(
      `SELECT s.*, mt.name AS material
       FROM finished_goods_shipments s JOIN material_types mt ON mt.id = s.material_type_id
       ${whereSql}
       ORDER BY s.shipment_date DESC, s.id DESC
       LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams,
    );
    const total = countRes.rows[0].total;
    const data = await Promise.all(rowsRes.rows.map(async (row) => ({
      ...row, packing_list_url: await resolvePackingListUrl(row.packing_list_url),
    })));
    res.json({
      success: true, data, page: parseInt(page), limit: parseInt(limit),
      total, totalPages: Math.max(1, Math.ceil(total / parseInt(limit))),
    });
  } catch (err) {
    console.error('Outgoing/Sales shipments list error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load shipments' });
  }
});

router.post('/shipments', async (req, res) => {
  const client = await pool.connect();
  try {
    const { material, weight_kg, customer, destination, vehicle_no, dn_no, notes, packing_list_url } = req.body || {};
    const category = parseCategory(req.body.category);
    const shipment_date = req.body.shipment_date || null;
    if (!material || !MATERIALS.includes(material)) {
      return res.status(400).json({ success: false, message: 'material must be one of PC, PE, PET' });
    }
    const weightNum = Number(weight_kg);
    if (!Number.isFinite(weightNum) || weightNum <= 0) {
      return res.status(400).json({ success: false, message: 'weight_kg must be a positive number' });
    }

    await client.query('BEGIN');

    const mtRes = await client.query('SELECT id FROM material_types WHERE name = $1', [material]);
    if (mtRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Unknown material type' });
    }
    const materialTypeId = mtRes.rows[0].id;

    const opening = await openingStockByMaterial(client, category);
    const produced = await producedByMaterial(client, category, cutoffMapFrom(opening));
    const producedWeight = Number(produced.find((r) => r.material === material)?.produced_weight || 0);
    const openingWeight = Number(opening[material]?.weight || 0);
    const shippedRes = await client.query(
      'SELECT COALESCE(SUM(weight_kg), 0)::numeric AS n FROM finished_goods_shipments WHERE material_type_id = $1 AND category = $2',
      [materialTypeId, category],
    );
    const availableWeight = producedWeight + openingWeight - Number(shippedRes.rows[0].n);
    if (weightNum > availableWeight) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: `Insufficient stock. Available: ${availableWeight.toFixed(2)} kg, Requested: ${weightNum} kg` });
    }

    const r = await client.query(
      `INSERT INTO finished_goods_shipments
         (shipment_date, material_type_id, weight_kg, customer, destination, vehicle_no, dn_no, notes, packing_list_url, category, "createdBy")
       VALUES (COALESCE($1::date, CURRENT_DATE), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [shipment_date, materialTypeId, weightNum, customer || null, destination || null, vehicle_no || null, dn_no || null, notes || null, normalizePackingListForStorage(packing_list_url) || null, category, actorName(req)],
    );
    await client.query('COMMIT');
    const resolvedUrl = await resolvePackingListUrl(r.rows[0].packing_list_url);
    res.status(201).json({ success: true, data: { ...r.rows[0], material, packing_list_url: resolvedUrl } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Outgoing/Sales shipment create error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to record shipment' });
  } finally {
    client.release();
  }
});

router.delete('/shipments/:id', async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM finished_goods_shipments WHERE id = $1 RETURNING id', [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ success: false, message: 'Shipment not found' });
    res.json({ success: true, message: 'Shipment deleted' });
  } catch (err) {
    console.error('Outgoing/Sales shipment delete error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete shipment' });
  }
});

module.exports = router;
