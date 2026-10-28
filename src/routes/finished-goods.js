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
const PET_TYPES = ['Bottle', 'Gallon'];

// PET is sold as two distinct types (Bottle-sourced vs Gallon-sourced) that the sales team
// tracks separately — PC and PE don't have this distinction, so they use the sentinel 'NA'.
// Every row in the summary/opening-stock/shipments flow is keyed by (material, pet_type); for
// PC/PE that's always ('PC'|'PE', 'NA'), for PET it's ('PET', 'Bottle') or ('PET', 'Gallon').
const SUMMARY_ROWS = [
  { material: 'PC', petType: 'NA' },
  { material: 'PE', petType: 'NA' },
  { material: 'PET', petType: 'Bottle' },
  { material: 'PET', petType: 'Gallon' },
];

function rowKey(material, petType) {
  return `${material}|${petType}`;
}

// material -> pet_type the client sent, validated. PC/PE are always forced to 'NA'; PET must
// pick one of PET_TYPES. Returns null if a PET row didn't supply a valid type.
function normalizePetType(material, value) {
  if (material !== 'PET') return 'NA';
  return PET_TYPES.includes(value) ? value : null;
}

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
    `SELECT mt.name AS material, o.pet_type, o.weight_kg::numeric AS weight_kg, o."createdAt" AS created_at
     FROM finished_goods_opening_stock o
     JOIN material_types mt ON mt.id = o.material_type_id
     WHERE o.category = $1`,
    [category],
  );
  return Object.fromEntries(r.rows.map((row) => [rowKey(row.material, row.pet_type), { weight: Number(row.weight_kg), createdAt: row.created_at }]));
}

// Only PC/PE get a cutoff — production doesn't distinguish PET's Bottle/Gallon types, so those
// never get a live "produced" figure regardless of opening stock (see producedByMaterial).
function cutoffMapFrom(opening) {
  const map = {};
  for (const material of ['PC', 'PE']) {
    const o = opening[rowKey(material, 'NA')];
    if (o) map[material] = o.createdAt;
  }
  return map;
}

function fmtKg(n) {
  return `${Number(n).toLocaleString()} kg`;
}

async function logShipmentHistory(client, { shipmentId, category, materialTypeId, petType, action, details, actor }) {
  await client.query(
    `INSERT INTO finished_goods_shipment_history (shipment_id, category, material_type_id, pet_type, action, details, "createdBy")
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [shipmentId, category, materialTypeId, petType || 'NA', action, details, actor],
  );
}

async function logOpeningStockHistory(client, { category, materialTypeId, petType, weightKg, action, details, actor }) {
  await client.query(
    `INSERT INTO finished_goods_opening_stock_history (category, material_type_id, pet_type, weight_kg, action, details, "createdBy")
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [category, materialTypeId, petType || 'NA', weightKg, action, details, actor],
  );
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
    const byKey = Object.fromEntries(r.rows.map((row) => [rowKey(row.material, row.pet_type), row]));
    const data = SUMMARY_ROWS.map(({ material, petType }) => {
      const row = byKey[rowKey(material, petType)];
      return {
        material, pet_type: material === 'PET' ? petType : null,
        weight_kg: Number(row?.weight_kg || 0),
        notes: row?.notes || null,
        updatedAt: row?.updatedAt || null,
        updatedBy: row?.updatedBy || null,
      };
    });
    res.json({ success: true, data });
  } catch (err) {
    console.error('Opening stock list error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load opening stock' });
  }
});

router.put('/opening-stock', async (req, res) => {
  const client = await pool.connect();
  try {
    const category = parseCategory(req.body.category);
    const { material, notes } = req.body || {};
    if (!material || !MATERIALS.includes(material)) {
      return res.status(400).json({ success: false, message: 'material must be one of PC, PE, PET' });
    }
    const petType = normalizePetType(material, req.body.pet_type);
    if (petType === null) {
      return res.status(400).json({ success: false, message: 'pet_type must be "Bottle" or "Gallon" for PET' });
    }
    const weightNum = Number(req.body.weight_kg);
    if (!Number.isFinite(weightNum) || weightNum < 0) {
      return res.status(400).json({ success: false, message: 'weight_kg must be a non-negative number' });
    }
    const mtRes = await client.query('SELECT id FROM material_types WHERE name = $1', [material]);
    if (mtRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Unknown material type' });
    }
    const materialTypeId = mtRes.rows[0].id;
    const actor = actorName(req);
    const label = material === 'PET' ? `PET (${petType})` : material;

    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT weight_kg FROM finished_goods_opening_stock WHERE category = $1 AND material_type_id = $2 AND pet_type = $3',
      [category, materialTypeId, petType],
    );
    const r = await client.query(
      `INSERT INTO finished_goods_opening_stock (category, material_type_id, pet_type, weight_kg, notes, "createdBy", "updatedBy")
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT (category, material_type_id, pet_type)
       DO UPDATE SET weight_kg = $4, notes = $5, "updatedBy" = $6, "updatedAt" = NOW()
       RETURNING *`,
      [category, materialTypeId, petType, weightNum, notes || null, actor],
    );
    const isNew = existing.rows.length === 0;
    const details = isNew
      ? `Opening stock set to ${fmtKg(weightNum)} for ${label}.`
      : `Opening stock corrected from ${fmtKg(existing.rows[0].weight_kg)} to ${fmtKg(weightNum)} for ${label}.`;
    await logOpeningStockHistory(client, {
      category, materialTypeId, petType, weightKg: weightNum, action: isNew ? 'created' : 'amended', details, actor,
    });
    await client.query('COMMIT');

    res.json({ success: true, data: { ...r.rows[0], material } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Opening stock save error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to save opening stock' });
  } finally {
    client.release();
  }
});

router.get('/opening-stock/history', async (req, res) => {
  try {
    const category = parseCategory(req.query.category);
    const { material } = req.query;
    const where = ['h.category = $1'];
    const params = [category];
    if (material && MATERIALS.includes(material)) {
      params.push(material);
      where.push(`mt.name = $${params.length}`);
    }
    if (req.query.pet_type && PET_TYPES.includes(req.query.pet_type)) {
      params.push(req.query.pet_type);
      where.push(`h.pet_type = $${params.length}`);
    }
    const r = await pool.query(
      `SELECT h.*, mt.name AS material
       FROM finished_goods_opening_stock_history h
       JOIN material_types mt ON mt.id = h.material_type_id
       WHERE ${where.join(' AND ')}
       ORDER BY h."createdAt" DESC`,
      params,
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error('Opening stock history error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load opening stock history' });
  }
});

// ─── Summary — Produced / Shipped / Available per material, for one category ──
router.get('/summary', async (req, res) => {
  try {
    const category = parseCategory(req.query.category);
    const opening = await openingStockByMaterial(pool, category);
    const produced = await producedByMaterial(pool, category, cutoffMapFrom(opening));
    const shipped = await pool.query(
      `SELECT mt.name AS material, s.pet_type, COALESCE(SUM(s.weight_kg), 0)::numeric AS shipped_weight
       FROM finished_goods_shipments s
       JOIN material_types mt ON mt.id = s.material_type_id
       WHERE s.category = $1
       GROUP BY mt.name, s.pet_type`,
      [category],
    );
    const producedMap = Object.fromEntries(produced.map((r) => [r.material, r]));
    const shippedMap = Object.fromEntries(shipped.rows.map((r) => [rowKey(r.material, r.pet_type), Number(r.shipped_weight)]));

    // PET's two types have no live "produced" figure — production doesn't distinguish
    // Bottle-sourced from Gallon-sourced output, so their available stock is opening - shipped
    // only (trackedLive: false tells the frontend to hide the Produced line for those rows).
    const data = SUMMARY_ROWS.map(({ material, petType }) => {
      const trackedLive = material !== 'PET';
      const key = rowKey(material, petType);
      const producedWeight = trackedLive ? Number(producedMap[material]?.produced_weight || 0) : 0;
      const openingWeight = Number(opening[key]?.weight || 0);
      const shippedWeight = shippedMap[key] || 0;
      return {
        material, pet_type: material === 'PET' ? petType : null,
        produced_weight: producedWeight,
        opening_weight: openingWeight,
        bag_count: trackedLive ? Number(producedMap[material]?.bag_count || 0) : 0,
        shipped_weight: shippedWeight,
        available_weight: Math.max(producedWeight + openingWeight - shippedWeight, 0),
        tracked_live: trackedLive,
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
  "pet_type": "Bottle" | "Gallon" | null,  // ONLY when material is "PET": which PET grade this is, if the document says so (e.g. "PET Bottle Grade" / "PET Gallon Grade"); otherwise null and the user will pick it
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
    if (extracted.pet_type && !PET_TYPES.includes(extracted.pet_type)) extracted.pet_type = null;

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
    if (req.query.pet_type && PET_TYPES.includes(req.query.pet_type)) {
      params.push(req.query.pet_type);
      where.push(`s.pet_type = $${params.length}`);
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
    const petType = normalizePetType(material, req.body.pet_type);
    if (petType === null) {
      return res.status(400).json({ success: false, message: 'pet_type must be "Bottle" or "Gallon" for PET' });
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
    const producedWeight = material === 'PET' ? 0 : Number(produced.find((r) => r.material === material)?.produced_weight || 0);
    const openingWeight = Number(opening[rowKey(material, petType)]?.weight || 0);
    const shippedRes = await client.query(
      'SELECT COALESCE(SUM(weight_kg), 0)::numeric AS n FROM finished_goods_shipments WHERE material_type_id = $1 AND category = $2 AND pet_type = $3',
      [materialTypeId, category, petType],
    );
    const availableWeight = producedWeight + openingWeight - Number(shippedRes.rows[0].n);
    if (weightNum > availableWeight) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: `Insufficient stock. Available: ${availableWeight.toFixed(2)} kg, Requested: ${weightNum} kg` });
    }

    const actor = actorName(req);
    const label = material === 'PET' ? `PET (${petType})` : material;
    const r = await client.query(
      `INSERT INTO finished_goods_shipments
         (shipment_date, material_type_id, pet_type, weight_kg, customer, destination, vehicle_no, dn_no, notes, packing_list_url, category, "createdBy")
       VALUES (COALESCE($1::date, CURRENT_DATE), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [shipment_date, materialTypeId, petType, weightNum, customer || null, destination || null, vehicle_no || null, dn_no || null, notes || null, normalizePackingListForStorage(packing_list_url) || null, category, actor],
    );
    const row = r.rows[0];
    await logShipmentHistory(client, {
      shipmentId: row.id, category, materialTypeId, petType, action: 'created', actor,
      details: `${fmtKg(weightNum)} ${label} recorded${customer ? ` for ${customer}` : ''}${dn_no ? ` (DN ${dn_no})` : ''}.`,
    });
    await client.query('COMMIT');
    const resolvedUrl = await resolvePackingListUrl(row.packing_list_url);
    res.status(201).json({ success: true, data: { ...row, material, packing_list_url: resolvedUrl } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Outgoing/Sales shipment create error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to record shipment' });
  } finally {
    client.release();
  }
});

router.put('/shipments/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const existingRes = await client.query(
      `SELECT s.*, mt.name AS material FROM finished_goods_shipments s
       JOIN material_types mt ON mt.id = s.material_type_id WHERE s.id = $1`,
      [req.params.id],
    );
    if (existingRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Shipment not found' });
    }
    const existing = existingRes.rows[0];
    const category = existing.category;

    const { material, weight_kg, customer, destination, vehicle_no, dn_no, notes, packing_list_url } = req.body || {};
    const shipment_date = req.body.shipment_date || existing.shipment_date;
    if (!material || !MATERIALS.includes(material)) {
      return res.status(400).json({ success: false, message: 'material must be one of PC, PE, PET' });
    }
    const petType = normalizePetType(material, req.body.pet_type);
    if (petType === null) {
      return res.status(400).json({ success: false, message: 'pet_type must be "Bottle" or "Gallon" for PET' });
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

    // Available stock as if this shipment hadn't been shipped yet, so amending it (even to a
    // larger weight for the same material) is checked against the true remaining balance.
    const opening = await openingStockByMaterial(client, category);
    const produced = await producedByMaterial(client, category, cutoffMapFrom(opening));
    const producedWeight = material === 'PET' ? 0 : Number(produced.find((r) => r.material === material)?.produced_weight || 0);
    const openingWeight = Number(opening[rowKey(material, petType)]?.weight || 0);
    const shippedRes = await client.query(
      'SELECT COALESCE(SUM(weight_kg), 0)::numeric AS n FROM finished_goods_shipments WHERE material_type_id = $1 AND category = $2 AND pet_type = $3 AND id <> $4',
      [materialTypeId, category, petType, existing.id],
    );
    const availableWeight = producedWeight + openingWeight - Number(shippedRes.rows[0].n);
    if (weightNum > availableWeight) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: `Insufficient stock. Available: ${availableWeight.toFixed(2)} kg, Requested: ${weightNum} kg` });
    }

    const actor = actorName(req);
    const r = await client.query(
      `UPDATE finished_goods_shipments SET
         shipment_date = COALESCE($1::date, shipment_date), material_type_id = $2, pet_type = $3, weight_kg = $4,
         customer = $5, destination = $6, vehicle_no = $7, dn_no = $8, notes = $9, packing_list_url = $10
       WHERE id = $11
       RETURNING *`,
      [shipment_date, materialTypeId, petType, weightNum, customer || null, destination || null, vehicle_no || null, dn_no || null, notes || null,
        normalizePackingListForStorage(packing_list_url) || existing.packing_list_url, existing.id],
    );
    const row = r.rows[0];

    const existingLabel = existing.material === 'PET' ? `PET (${existing.pet_type})` : existing.material;
    const newLabel = material === 'PET' ? `PET (${petType})` : material;
    const changes = [];
    if (Number(existing.weight_kg) !== weightNum) changes.push(`weight ${fmtKg(existing.weight_kg)} → ${fmtKg(weightNum)}`);
    if (existingLabel !== newLabel) changes.push(`material ${existingLabel} → ${newLabel}`);
    if ((existing.customer || '') !== (customer || '')) changes.push(`customer "${existing.customer || '—'}" → "${customer || '—'}"`);
    if ((existing.destination || '') !== (destination || '')) changes.push(`destination "${existing.destination || '—'}" → "${destination || '—'}"`);
    if ((existing.dn_no || '') !== (dn_no || '')) changes.push(`DN no. "${existing.dn_no || '—'}" → "${dn_no || '—'}"`);
    if ((existing.vehicle_no || '') !== (vehicle_no || '')) changes.push(`vehicle "${existing.vehicle_no || '—'}" → "${vehicle_no || '—'}"`);
    const details = changes.length ? `Amended: ${changes.join('; ')}.` : 'Amended (no field changes detected).';
    await logShipmentHistory(client, { shipmentId: existing.id, category, materialTypeId, petType, action: 'amended', details, actor });

    await client.query('COMMIT');
    const resolvedUrl = await resolvePackingListUrl(row.packing_list_url);
    res.json({ success: true, data: { ...row, material, packing_list_url: resolvedUrl } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Outgoing/Sales shipment amend error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to amend shipment' });
  } finally {
    client.release();
  }
});

router.get('/shipments/:id/history', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT h.* FROM finished_goods_shipment_history h WHERE h.shipment_id = $1 ORDER BY h."createdAt" DESC`,
      [req.params.id],
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error('Shipment history error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load shipment history' });
  }
});

router.post('/shipments/:id/notes', async (req, res) => {
  try {
    const { note } = req.body || {};
    if (!note || !String(note).trim()) {
      return res.status(400).json({ success: false, message: 'Note text is required' });
    }
    const existing = await pool.query('SELECT category, material_type_id FROM finished_goods_shipments WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Shipment not found' });
    }
    const actor = actorName(req);
    await logShipmentHistory(pool, {
      shipmentId: req.params.id, category: existing.rows[0].category, materialTypeId: existing.rows[0].material_type_id,
      action: 'note', details: String(note).trim(), actor,
    });
    res.status(201).json({ success: true, message: 'Note added' });
  } catch (err) {
    console.error('Shipment note error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to add note' });
  }
});

router.delete('/shipments/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const existingRes = await client.query(
      `SELECT s.*, mt.name AS material FROM finished_goods_shipments s
       JOIN material_types mt ON mt.id = s.material_type_id WHERE s.id = $1`,
      [req.params.id],
    );
    if (existingRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Shipment not found' });
    }
    const existing = existingRes.rows[0];
    const actor = actorName(req);

    const label = existing.material === 'PET' ? `PET (${existing.pet_type})` : existing.material;
    await client.query('BEGIN');
    await logShipmentHistory(client, {
      shipmentId: existing.id, category: existing.category, materialTypeId: existing.material_type_id, petType: existing.pet_type, action: 'deleted', actor,
      details: `${fmtKg(existing.weight_kg)} ${label} shipment${existing.customer ? ` to ${existing.customer}` : ''} deleted — stock restored.`,
    });
    await client.query('DELETE FROM finished_goods_shipments WHERE id = $1', [existing.id]);
    await client.query('COMMIT');
    res.json({ success: true, message: 'Shipment deleted' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Outgoing/Sales shipment delete error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete shipment' });
  } finally {
    client.release();
  }
});

module.exports = router;
