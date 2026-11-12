const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const { requireModule } = require('../middleware/permissions');
const { isS3Configured, uploadBuffer, getSignedUrlForKey } = require('../config/s3');

/**
 * Procurement — Permintaan Barang (PB) → approvals → Purchasing (PO) → Laporan Penerimaan
 * Barang (LPB). Quantities and specifications only; no prices anywhere.
 *
 * Status machine
 *   draft ──submit──▶ pending_spv (Maintenance dept) | pending_om (everyone else)
 *   pending_spv ──approve──▶ pending_om
 *   pending_om ──approve──▶ pending_director (Packaging category or Production dept) | approved
 *   pending_director ──approve──▶ approved
 *   approved ──purchase (PO + supplier)──▶ purchasing
 *   purchasing / partially_received ──LPB──▶ partially_received | completed
 *   any pending_* ──reject──▶ rejected ──submit──▶ (back to the first stage)
 *   draft / pending_* / approved ──cancel──▶ cancelled
 *
 * Who may act at each stage is decided by the user's role key (see STAGE_ROLES). Admin,
 * Super Admin and anyone with Delete on this module ("procurement admin") may act anywhere.
 */

const DEPARTMENTS = ['Production', 'Maintenance', 'Electrical', 'Utility', 'QC Lab', 'Warehouse', 'General'];
const CATEGORIES = ['Sparepart', 'Packaging', 'General'];
const STATUSES = ['draft', 'pending_spv', 'pending_om', 'pending_director', 'approved', 'purchasing', 'partially_received', 'completed', 'rejected', 'cancelled'];
const PENDING = ['pending_spv', 'pending_om', 'pending_director'];

const STAGE_ROLES = {
  pending_spv: ['spv_maintenance'],
  pending_om: ['operational_manager'],
  pending_director: ['director'],
  approved: ['purchasing'],
  purchasing: ['warehouse'],
  partially_received: ['warehouse'],
};
const STAGE_LABELS = {
  pending_spv: 'SPV Maintenance approval',
  pending_om: 'Operational Manager approval',
  pending_director: 'Director approval',
  approved: 'Purchasing (issue PO)',
  purchasing: 'Warehouse (goods receipt)',
  partially_received: 'Warehouse (remaining goods)',
};

router.use(authenticateToken, requireModule('procurement', 'Procurement'));

// ─── helpers ────────────────────────────────────────────────────────────────
function actorName(req) {
  return (req.user && (req.user.name || req.user.employeeId)) || null;
}
function roleKey(req) {
  return String((req.user && req.user.roleKey) || '').toLowerCase();
}
function isProcAdmin(req) {
  const k = roleKey(req);
  if (k === 'super_admin' || k === 'admin') return true;
  const p = req.user && req.user.permissions && req.user.permissions.procurement;
  return !!(p && p.delete);
}
function canActAt(req, status) {
  if (isProcAdmin(req)) return true;
  const roles = STAGE_ROLES[status] || [];
  return roles.includes(roleKey(req));
}
function stagesFor(req) {
  if (isProcAdmin(req)) return Object.keys(STAGE_ROLES);
  const k = roleKey(req);
  return Object.keys(STAGE_ROLES).filter((s) => STAGE_ROLES[s].includes(k));
}
function isOwner(req, row) {
  return row.requested_by_id != null && Number(row.requested_by_id) === Number(req.user.id);
}
function firstStage(row) {
  return row.department === 'Maintenance' ? 'pending_spv' : 'pending_om';
}
function afterOm(row) {
  return row.category === 'Packaging' || row.department === 'Production' ? 'pending_director' : 'approved';
}
function nextStatus(row) {
  switch (row.status) {
    case 'pending_spv': return 'pending_om';
    case 'pending_om': return afterOm(row);
    case 'pending_director': return 'approved';
    default: return null;
  }
}
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
function docNumber(kind, seq, date) {
  const d = date ? new Date(date) : new Date();
  const roman = ROMAN[d.getMonth()];
  const yy = String(d.getFullYear()).slice(-2);
  const n = String(seq).padStart(3, '0');
  return kind === 'PR' ? `PR ${n}/PB/NB/GRI/${roman}/${yy}` : `LPB ${n}/GRI/${roman}/${yy}`;
}
async function nextSeq(client, table, dateCol, date) {
  const r = await client.query(
    `SELECT COUNT(*)::int AS n FROM ${table} WHERE date_trunc('year', ${dateCol}) = date_trunc('year', $1::date)`,
    [date],
  );
  return r.rows[0].n + 1;
}
function parseDate(v) {
  if (!v) return null;
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
async function logHistory(client, { requestId, action, from, to, note, req }) {
  await client.query(
    `INSERT INTO proc_request_history (request_id, action, from_status, to_status, note, actor, actor_role)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [requestId, action, from || null, to || null, note || null, actorName(req), (req.user && req.user.roleName) || roleKey(req) || null],
  );
}

// Item sample images: S3 key when configured, else a local-disk URL (same convention as QC Lab).
const IMAGE_DIR = path.join(__dirname, '..', '..', 'uploads', 'procurement');
fs.mkdirSync(IMAGE_DIR, { recursive: true });
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype || '')),
});
async function resolveImageUrl(value) {
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (isS3Configured()) {
    try { return await getSignedUrlForKey(value); } catch (err) { console.error('Procurement image sign failed', value, err.message); }
  }
  return value;
}

const REQUEST_COLS = `r.*, s.name AS supplier_master_name,
  (SELECT COUNT(*)::int FROM proc_request_items i WHERE i.request_id = r.id) AS item_count,
  (SELECT COALESCE(SUM(i.qty), 0) FROM proc_request_items i WHERE i.request_id = r.id) AS total_qty,
  (SELECT COALESCE(SUM(i.received_qty), 0) FROM proc_request_items i WHERE i.request_id = r.id) AS total_received,
  (SELECT i.description FROM proc_request_items i WHERE i.request_id = r.id ORDER BY i.line_no LIMIT 1) AS first_item,
  (SELECT COUNT(*)::int FROM proc_receipts g WHERE g.request_id = r.id) AS receipt_count`;

async function loadRequest(client, id) {
  const r = await client.query(
    `SELECT ${REQUEST_COLS} FROM proc_requests r LEFT JOIN proc_suppliers s ON s.id = r.supplier_id WHERE r.id = $1`,
    [id],
  );
  return r.rows[0] || null;
}

function decorate(req, row) {
  const owner = isOwner(req, row);
  const admin = isProcAdmin(req);
  const actStage = canActAt(req, row.status);
  return {
    ...row,
    total_qty: Number(row.total_qty || 0),
    total_received: Number(row.total_received || 0),
    stage_label: STAGE_LABELS[row.status] || null,
    can: {
      edit: (row.status === 'draft' || row.status === 'rejected') && (owner || admin),
      submit: (row.status === 'draft' || row.status === 'rejected') && (owner || admin),
      approve: PENDING.includes(row.status) && actStage,
      reject: PENDING.includes(row.status) && actStage,
      purchase: row.status === 'approved' && actStage,
      receive: ['purchasing', 'partially_received'].includes(row.status) && actStage,
      cancel: ['draft', ...PENDING, 'approved'].includes(row.status) && (owner || admin),
      remind: PENDING.includes(row.status) || row.status === 'approved',
      delete: row.status === 'draft' ? (owner || admin) : admin,
    },
  };
}

// ─── who am I in this module ────────────────────────────────────────────────
router.get('/me', (req, res) => {
  const stages = stagesFor(req);
  res.json({
    success: true,
    data: {
      role: roleKey(req),
      role_name: req.user.roleName || null,
      is_admin: isProcAdmin(req),
      stages,
      stage_labels: STAGE_LABELS,
      departments: DEPARTMENTS,
      categories: CATEGORIES,
      statuses: STATUSES,
    },
  });
});

// Users who can act at a stage — for reminders (name + phone for a WhatsApp link).
router.get('/approvers', async (req, res) => {
  try {
    const stage = String(req.query.stage || '');
    const roles = STAGE_ROLES[stage];
    if (!roles) return res.status(400).json({ success: false, message: 'Unknown stage' });
    const r = await pool.query(
      `SELECT u.id, u.name, u.phone, u.email, r.name AS role_name
       FROM users u JOIN roles r ON r.id = u.role_id
       WHERE r.key = ANY($1) AND u.is_active = true AND u.deleted_at IS NULL
       ORDER BY u.name`,
      [roles],
    );
    res.json({ success: true, data: r.rows, stage, stage_label: STAGE_LABELS[stage] });
  } catch (err) {
    console.error('Procurement approvers error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load approvers' });
  }
});

// ─── item master: spare parts + packaging parts already in the system ───────
router.get('/items', async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    const source = String(req.query.source || 'all');
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 60, 1), 500);
    const like = `%${search}%`;
    const out = [];
    if (source === 'all' || source === 'spare_part') {
      const r = await pool.query(
        `SELECT i.id, i.part_no AS code, i.description, i.category AS group_name, i.unit, i.current_qty AS stock,
                i.min_stock, i.supplier, c.label AS catalog, c.key AS catalog_key, i.machine, i.location
         FROM spare_parts_items i JOIN spare_parts_catalogs c ON c.id = i.catalog_id
         WHERE ($1 = '' OR i.part_no ILIKE $2 OR i.description ILIKE $2 OR i.category ILIKE $2 OR i.machine ILIKE $2)
         ORDER BY (i.min_stock IS NOT NULL AND i.current_qty <= i.min_stock) DESC, i.description
         LIMIT $3`,
        [search, like, limit],
      );
      for (const x of r.rows) {
        out.push({
          source: 'spare_part', source_id: x.id, code: x.code, description: x.description, unit: x.unit || 'Pcs',
          stock: Number(x.stock || 0), min_stock: x.min_stock == null ? null : Number(x.min_stock),
          group: x.group_name, catalog: x.catalog, catalog_key: x.catalog_key, machine: x.machine, location: x.location,
          supplier: x.supplier, category: 'Sparepart',
          low: x.min_stock != null && Number(x.stock || 0) <= Number(x.min_stock),
        });
      }
    }
    if (source === 'all' || source === 'part') {
      const r = await pool.query(
        `SELECT p.id, p.code, p.description, p.category AS group_name, p.uom AS unit, p.size_spec, p.variant, p.supplier, p.reorder_level,
                COALESCE((SELECT SUM(quantity_received) FROM parts_stock_in WHERE part_id = p.id), 0)
              + COALESCE((SELECT SUM(variance) FROM parts_stock_correction WHERE part_id = p.id AND status = 'approved'), 0)
              - COALESCE((SELECT SUM(quantity_sent) FROM parts_outgoing WHERE part_id = p.id AND status IN ('issued','received')), 0)
              - COALESCE((SELECT SUM(quantity_affected) FROM parts_damage_waste WHERE part_id = p.id AND status = 'approved'), 0) AS stock
         FROM pm_item p
         WHERE p.is_active = true
           AND ($1 = '' OR p.code ILIKE $2 OR p.description ILIKE $2 OR p.category ILIKE $2 OR p.variant ILIKE $2)
         ORDER BY p.category, p.code
         LIMIT $3`,
        [search, like, limit],
      );
      for (const x of r.rows) {
        const stock = Number(x.stock || 0);
        const min = x.reorder_level == null ? null : Number(x.reorder_level);
        out.push({
          source: 'part', source_id: x.id, code: x.code, description: x.description, unit: x.unit || 'Pcs',
          stock, min_stock: min, group: x.group_name, catalog: 'Parts Inventory', catalog_key: null,
          specification: [x.size_spec, x.variant].filter(Boolean).join(' · ') || null, supplier: x.supplier, category: 'Packaging',
          low: min != null && min > 0 && stock <= min,
        });
      }
    }
    res.json({ success: true, data: out });
  } catch (err) {
    console.error('Procurement items error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load items' });
  }
});

// ─── suppliers ──────────────────────────────────────────────────────────────
router.get('/suppliers', async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    const status = String(req.query.status || 'all');
    const where = [];
    const params = [];
    if (search) { params.push(`%${search}%`); where.push(`(s.name ILIKE $${params.length} OR s.code ILIKE $${params.length} OR s.contact_person ILIKE $${params.length} OR s.email ILIKE $${params.length})`); }
    if (status === 'active' || status === 'inactive') { params.push(status); where.push(`s.status = $${params.length}`); }
    const r = await pool.query(
      `SELECT s.*,
              (SELECT COUNT(*)::int FROM proc_requests r WHERE r.supplier_id = s.id) AS po_count,
              (SELECT MAX(r.po_at) FROM proc_requests r WHERE r.supplier_id = s.id) AS last_po_at
       FROM proc_suppliers s ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY s.status, s.name`,
      params,
    );
    // Names typed on existing spare parts / packaging parts that are not in the master yet.
    const sugg = await pool.query(
      `SELECT name, SUM(n)::int AS n FROM (
         SELECT TRIM(supplier) AS name, COUNT(*) AS n FROM spare_parts_items WHERE supplier IS NOT NULL AND TRIM(supplier) <> '' GROUP BY 1
         UNION ALL
         SELECT TRIM(supplier) AS name, COUNT(*) AS n FROM pm_item WHERE supplier IS NOT NULL AND TRIM(supplier) <> '' GROUP BY 1
       ) x
       WHERE LOWER(name) NOT IN (SELECT LOWER(name) FROM proc_suppliers)
       GROUP BY name ORDER BY n DESC, name LIMIT 50`,
    );
    res.json({ success: true, data: r.rows, suggestions: sugg.rows });
  } catch (err) {
    console.error('Procurement suppliers error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load suppliers' });
  }
});

async function nextSupplierCode(client) {
  const r = await client.query(`SELECT COUNT(*)::int AS n FROM proc_suppliers`);
  let n = r.rows[0].n + 1;
  for (let tries = 0; tries < 50; tries += 1, n += 1) {
    const code = `SUP-${String(n).padStart(3, '0')}`;
    const dup = await client.query('SELECT 1 FROM proc_suppliers WHERE code = $1', [code]);
    if (dup.rows.length === 0) return code;
  }
  return `SUP-${Date.now()}`;
}

function supplierBody(body) {
  const b = body || {};
  const cats = Array.isArray(b.categories) ? b.categories.filter((c) => CATEGORIES.includes(c)) : [];
  return {
    name: String(b.name || '').trim(), contact_person: b.contact_person || null, phone: b.phone || null, email: b.email || null,
    address: b.address || null, categories: cats, status: b.status === 'inactive' ? 'inactive' : 'active', notes: b.notes || null,
  };
}

router.post('/suppliers', async (req, res) => {
  const client = await pool.connect();
  try {
    const b = supplierBody(req.body);
    if (!b.name) return res.status(400).json({ success: false, message: 'Supplier name is required' });
    const dup = await client.query('SELECT id FROM proc_suppliers WHERE LOWER(name) = LOWER($1)', [b.name]);
    if (dup.rows.length) return res.status(409).json({ success: false, message: `"${b.name}" is already in the supplier master.` });
    const code = String(req.body.code || '').trim() || await nextSupplierCode(client);
    const r = await client.query(
      `INSERT INTO proc_suppliers (code, name, contact_person, phone, email, address, categories, status, notes, "createdBy", "updatedBy")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING *`,
      [code, b.name, b.contact_person, b.phone, b.email, b.address, b.categories, b.status, b.notes, actorName(req)],
    );
    res.status(201).json({ success: true, data: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, message: 'That supplier code is already used.' });
    console.error('Supplier create error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create supplier' });
  } finally { client.release(); }
});

// Bring supplier names already typed on parts into the master in one go.
router.post('/suppliers/import', async (req, res) => {
  const client = await pool.connect();
  try {
    const names = Array.isArray(req.body && req.body.names) ? req.body.names.map((n) => String(n).trim()).filter(Boolean) : [];
    if (!names.length) return res.status(400).json({ success: false, message: 'names[] is required' });
    await client.query('BEGIN');
    let created = 0;
    for (const name of names) {
      const dup = await client.query('SELECT id FROM proc_suppliers WHERE LOWER(name) = LOWER($1)', [name]);
      if (dup.rows.length) continue;
      const cats = [];
      const sp = await client.query('SELECT 1 FROM spare_parts_items WHERE LOWER(TRIM(supplier)) = LOWER($1) LIMIT 1', [name]);
      if (sp.rows.length) cats.push('Sparepart');
      const pm = await client.query('SELECT 1 FROM pm_item WHERE LOWER(TRIM(supplier)) = LOWER($1) LIMIT 1', [name]);
      if (pm.rows.length) cats.push('Packaging');
      const code = await nextSupplierCode(client);
      await client.query(
        `INSERT INTO proc_suppliers (code, name, categories, notes, "createdBy", "updatedBy") VALUES ($1,$2,$3,$4,$5,$5)`,
        [code, name, cats, 'Imported from existing part records', actorName(req)],
      );
      created += 1;
    }
    await client.query('COMMIT');
    res.json({ success: true, created });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Supplier import error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to import suppliers' });
  } finally { client.release(); }
});

router.put('/suppliers/:id', async (req, res) => {
  try {
    const b = supplierBody(req.body);
    if (!b.name) return res.status(400).json({ success: false, message: 'Supplier name is required' });
    const dup = await pool.query('SELECT id FROM proc_suppliers WHERE LOWER(name) = LOWER($1) AND id <> $2', [b.name, req.params.id]);
    if (dup.rows.length) return res.status(409).json({ success: false, message: `"${b.name}" is already in the supplier master.` });
    const r = await pool.query(
      `UPDATE proc_suppliers SET name=$2, contact_person=$3, phone=$4, email=$5, address=$6, categories=$7, status=$8, notes=$9, "updatedBy"=$10, "updatedAt"=NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.id, b.name, b.contact_person, b.phone, b.email, b.address, b.categories, b.status, b.notes, actorName(req)],
    );
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Supplier not found' });
    res.json({ success: true, data: r.rows[0] });
  } catch (err) {
    console.error('Supplier update error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update supplier' });
  }
});

router.delete('/suppliers/:id', async (req, res) => {
  try {
    const used = await pool.query('SELECT COUNT(*)::int AS n FROM proc_requests WHERE supplier_id = $1', [req.params.id]);
    if (used.rows[0].n > 0) {
      return res.status(409).json({ success: false, message: `This supplier is on ${used.rows[0].n} purchase order(s). Mark it inactive instead of deleting it.` });
    }
    const r = await pool.query('DELETE FROM proc_suppliers WHERE id = $1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Supplier not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Supplier delete error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete supplier' });
  }
});

// ─── image upload for a request line ────────────────────────────────────────
router.post('/uploads', imageUpload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'Attach an image file (jpg, png, webp).' });
    const ext = path.extname(req.file.originalname || '').toLowerCase() || '.jpg';
    const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
    if (isS3Configured()) {
      const key = `procurement/${filename}`;
      const url = await uploadBuffer(req.file.buffer, key, req.file.mimetype);
      return res.json({ success: true, data: { key, url, name: req.file.originalname } });
    }
    fs.writeFileSync(path.join(IMAGE_DIR, filename), req.file.buffer);
    const url = `${req.protocol}://${req.get('host')}/uploads/procurement/${filename}`;
    res.json({ success: true, data: { key: url, url, name: req.file.originalname } });
  } catch (err) {
    console.error('Procurement upload error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to upload image' });
  }
});

// ─── requests (PB) ──────────────────────────────────────────────────────────
function validateItems(items) {
  if (!Array.isArray(items) || items.length === 0) return { error: 'Add at least one item.' };
  const out = [];
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i] || {};
    const desc = String(it.description || '').trim();
    if (!desc) return { error: `Line ${i + 1}: description is required.` };
    const qty = Number(it.qty);
    if (!Number.isFinite(qty) || qty <= 0) return { error: `Line ${i + 1} (${desc}): quantity must be greater than 0.` };
    const source = ['spare_part', 'part', 'custom'].includes(it.source) ? it.source : 'custom';
    out.push({
      source, source_id: source === 'custom' ? null : (Number(it.source_id) || null),
      item_code: it.item_code ? String(it.item_code).trim() : null, description: desc,
      specification: it.specification ? String(it.specification).trim() : null,
      qty, unit: String(it.unit || 'Pcs').trim() || 'Pcs',
      min_stock: it.min_stock === '' || it.min_stock == null ? null : Number(it.min_stock),
      stock_at_request: it.stock_at_request == null || it.stock_at_request === '' ? null : Number(it.stock_at_request),
      image_key: it.image_key || null, image_name: it.image_name || null,
    });
  }
  return { items: out };
}

function requestBody(body) {
  const b = body || {};
  const department = DEPARTMENTS.includes(b.department) ? b.department : null;
  const category = CATEGORIES.includes(b.category) ? b.category : null;
  const priority = b.priority === 'Urgent' ? 'Urgent' : 'Normal';
  const budget = b.budget_type === 'CAPEX' ? 'CAPEX' : 'OPEX';
  return {
    department, category, priority, budget_type: budget,
    urgent_reason: priority === 'Urgent' ? String(b.urgent_reason || '').trim() : null,
    required_date: parseDate(b.required_date), notes: b.notes ? String(b.notes).trim() : null,
    pr_date: parseDate(b.pr_date),
  };
}

async function writeItems(client, requestId, items) {
  await client.query('DELETE FROM proc_request_items WHERE request_id = $1', [requestId]);
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    await client.query(
      `INSERT INTO proc_request_items (request_id, line_no, source, source_id, item_code, description, specification, qty, unit, min_stock, stock_at_request, image_key, image_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [requestId, i + 1, it.source, it.source_id, it.item_code, it.description, it.specification, it.qty, it.unit, it.min_stock, it.stock_at_request, it.image_key, it.image_name],
    );
  }
}

router.get('/requests', async (req, res) => {
  try {
    const { search, status, category, priority, department, from, to, mine, queue, budget_type } = req.query;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 500);
    const where = [];
    const params = [];
    if (search && String(search).trim()) {
      params.push(`%${String(search).trim()}%`);
      where.push(`(r.pr_no ILIKE $${params.length} OR r.requested_by ILIKE $${params.length} OR r.po_no ILIKE $${params.length} OR r.supplier_name ILIKE $${params.length}
        OR EXISTS (SELECT 1 FROM proc_request_items i WHERE i.request_id = r.id AND (i.description ILIKE $${params.length} OR i.item_code ILIKE $${params.length})))`);
    }
    if (status && status !== 'all') {
      if (status === 'pending') where.push(`r.status = ANY('{pending_spv,pending_om,pending_director}')`);
      else if (status === 'open') where.push(`r.status NOT IN ('completed','rejected','cancelled')`);
      else if (status === 'in_purchase') where.push(`r.status IN ('approved','purchasing','partially_received')`);
      else if (STATUSES.includes(status)) { params.push(status); where.push(`r.status = $${params.length}`); }
    }
    if (category && category !== 'all') { params.push(category); where.push(`r.category = $${params.length}`); }
    if (priority && priority !== 'all') { params.push(priority); where.push(`r.priority = $${params.length}`); }
    if (budget_type && budget_type !== 'all') { params.push(budget_type); where.push(`r.budget_type = $${params.length}`); }
    if (department && department !== 'all') { params.push(department); where.push(`r.department = $${params.length}`); }
    if (parseDate(from)) { params.push(parseDate(from)); where.push(`r.pr_date >= $${params.length}`); }
    if (parseDate(to)) { params.push(parseDate(to)); where.push(`r.pr_date <= $${params.length}`); }
    if (mine === '1') { params.push(req.user.id); where.push(`r.requested_by_id = $${params.length}`); }
    if (queue === '1') {
      const stages = stagesFor(req);
      if (!stages.length) where.push('false');
      else { params.push(stages); where.push(`r.status = ANY($${params.length})`); }
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const count = await pool.query(`SELECT COUNT(*)::int AS n FROM proc_requests r ${whereSql}`, params);
    params.push(limit, (page - 1) * limit);
    const r = await pool.query(
      `SELECT ${REQUEST_COLS} FROM proc_requests r LEFT JOIN proc_suppliers s ON s.id = r.supplier_id
       ${whereSql}
       ORDER BY (r.priority = 'Urgent' AND r.status NOT IN ('completed','rejected','cancelled')) DESC, r.pr_date DESC, r.id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json({ success: true, data: r.rows.map((row) => decorate(req, row)), total: count.rows[0].n, page, limit });
  } catch (err) {
    console.error('Procurement requests list error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load requests' });
  }
});

router.get('/requests/:id', async (req, res) => {
  try {
    const row = await loadRequest(pool, req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Request not found' });
    const items = await pool.query('SELECT * FROM proc_request_items WHERE request_id = $1 ORDER BY line_no', [row.id]);
    const receipts = await pool.query(
      `SELECT g.*, (SELECT COALESCE(SUM(qty), 0) FROM proc_receipt_items x WHERE x.receipt_id = g.id) AS total_qty
       FROM proc_receipts g WHERE g.request_id = $1 ORDER BY g.receipt_date DESC, g.id DESC`, [row.id]);
    const history = await pool.query('SELECT * FROM proc_request_history WHERE request_id = $1 ORDER BY "createdAt" DESC, id DESC', [row.id]);
    const withImages = await Promise.all(items.rows.map(async (it) => ({
      ...it, qty: Number(it.qty), received_qty: Number(it.received_qty), min_stock: it.min_stock == null ? null : Number(it.min_stock),
      stock_at_request: it.stock_at_request == null ? null : Number(it.stock_at_request),
      image_url: await resolveImageUrl(it.image_key),
    })));
    let approvers = [];
    if (STAGE_ROLES[row.status]) {
      const a = await pool.query(
        `SELECT u.id, u.name, u.phone, r.name AS role_name FROM users u JOIN roles r ON r.id = u.role_id
         WHERE r.key = ANY($1) AND u.is_active = true AND u.deleted_at IS NULL ORDER BY u.name`,
        [STAGE_ROLES[row.status]],
      );
      approvers = a.rows;
    }
    res.json({
      success: true,
      data: { ...decorate(req, row), items: withImages, receipts: receipts.rows.map((g) => ({ ...g, total_qty: Number(g.total_qty) })), history: history.rows, approvers },
    });
  } catch (err) {
    console.error('Procurement request detail error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load request' });
  }
});

router.post('/requests', async (req, res) => {
  const client = await pool.connect();
  try {
    const b = requestBody(req.body);
    if (!b.department) return res.status(400).json({ success: false, message: `department must be one of ${DEPARTMENTS.join(', ')}` });
    if (!b.category) return res.status(400).json({ success: false, message: `category must be one of ${CATEGORIES.join(', ')}` });
    const submit = req.body && req.body.submit === true;
    if (submit && b.priority === 'Urgent' && !b.urgent_reason) {
      return res.status(400).json({ success: false, message: 'An Urgent request needs a reason — say what stops or is at risk without it.' });
    }
    const v = validateItems(req.body.items);
    if (v.error) return res.status(400).json({ success: false, message: v.error });
    const prDate = b.pr_date || new Date().toISOString().slice(0, 10);
    const requestedBy = String((req.body && req.body.requested_by) || actorName(req) || 'User').trim();

    await client.query('BEGIN');
    await client.query('LOCK TABLE proc_requests IN SHARE ROW EXCLUSIVE MODE');
    let seq = await nextSeq(client, 'proc_requests', 'pr_date', prDate);
    let prNo = docNumber('PR', seq, prDate);
    for (let tries = 0; tries < 100; tries += 1) {
      const dup = await client.query('SELECT 1 FROM proc_requests WHERE pr_no = $1', [prNo]);
      if (!dup.rows.length) break;
      seq += 1; prNo = docNumber('PR', seq, prDate);
    }
    const r = await client.query(
      `INSERT INTO proc_requests (pr_no, pr_date, department, category, requested_by_id, requested_by, priority, urgent_reason, budget_type, required_date, notes, status, "createdBy", "updatedBy")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'draft',$12,$12) RETURNING *`,
      [prNo, prDate, b.department, b.category, req.user.id, requestedBy, b.priority, b.urgent_reason, b.budget_type, b.required_date, b.notes, actorName(req)],
    );
    const row = r.rows[0];
    await writeItems(client, row.id, v.items);
    await logHistory(client, { requestId: row.id, action: 'created', to: 'draft', note: `${b.category} · ${b.priority}${b.urgent_reason ? ` — ${b.urgent_reason}` : ''} · ${v.items.length} item(s)`, req });
    if (submit) {
      const to = firstStage(row);
      await client.query(`UPDATE proc_requests SET status = $2, submitted_at = NOW(), "updatedAt" = NOW() WHERE id = $1`, [row.id, to]);
      await logHistory(client, { requestId: row.id, action: 'submitted', from: 'draft', to, note: `Sent for ${STAGE_LABELS[to]}`, req });
    }
    await client.query('COMMIT');
    const full = await loadRequest(pool, row.id);
    res.status(201).json({ success: true, data: decorate(req, full) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Procurement request create error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create request' });
  } finally { client.release(); }
});

router.put('/requests/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const row = await loadRequest(client, req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Request not found' });
    if (!decorate(req, row).can.edit) return res.status(403).json({ success: false, message: 'Only a draft or rejected request can be edited, by its requester or an admin.' });
    const b = requestBody(req.body);
    if (!b.department || !b.category) return res.status(400).json({ success: false, message: 'department and category are required' });
    const v = validateItems(req.body.items);
    if (v.error) return res.status(400).json({ success: false, message: v.error });
    await client.query('BEGIN');
    await client.query(
      `UPDATE proc_requests SET department=$2, category=$3, priority=$4, urgent_reason=$5, budget_type=$6, required_date=$7, notes=$8, requested_by=$9, "updatedBy"=$10, "updatedAt"=NOW()
       WHERE id = $1`,
      [row.id, b.department, b.category, b.priority, b.urgent_reason, b.budget_type, b.required_date, b.notes, String((req.body && req.body.requested_by) || row.requested_by).trim(), actorName(req)],
    );
    await writeItems(client, row.id, v.items);
    await logHistory(client, { requestId: row.id, action: 'edited', from: row.status, to: row.status, note: `${v.items.length} item(s)`, req });
    await client.query('COMMIT');
    const full = await loadRequest(pool, row.id);
    res.json({ success: true, data: decorate(req, full) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Procurement request update error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update request' });
  } finally { client.release(); }
});

router.delete('/requests/:id', async (req, res) => {
  try {
    const row = await loadRequest(pool, req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Request not found' });
    if (!decorate(req, row).can.delete) return res.status(403).json({ success: false, message: 'Only drafts can be deleted (or an admin can delete any request).' });
    if (Number(row.receipt_count) > 0) return res.status(409).json({ success: false, message: 'This request already has goods receipts. Cancel it instead.' });
    await pool.query('DELETE FROM proc_requests WHERE id = $1', [row.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Procurement request delete error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete request' });
  }
});

// Shared shape for every status transition.
async function transition(req, res, { allowed, check, apply, action, noteFrom }) {
  const client = await pool.connect();
  try {
    const row = await loadRequest(client, req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Request not found' });
    const d = decorate(req, row);
    if (!d.can[allowed]) return res.status(403).json({ success: false, message: `You cannot ${allowed} ${row.pr_no} at its current stage (${row.status.replace('_', ' ')}).` });
    if (check) { const msg = check(row); if (msg) return res.status(400).json({ success: false, message: msg }); }
    await client.query('BEGIN');
    const { to, note, extraSql = '', extraParams = [] } = apply(row);
    await client.query(
      `UPDATE proc_requests SET status = $2, "updatedBy" = $3, "updatedAt" = NOW() ${extraSql} WHERE id = $1`,
      [row.id, to, actorName(req), ...extraParams],
    );
    await logHistory(client, { requestId: row.id, action, from: row.status, to, note: note || (noteFrom ? noteFrom(row) : null), req });
    await client.query('COMMIT');
    const full = await loadRequest(pool, row.id);
    res.json({ success: true, data: decorate(req, full) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`Procurement ${action} error:`, err.message);
    res.status(500).json({ success: false, message: `Failed to ${action}` });
  } finally { client.release(); }
}

router.post('/requests/:id/submit', (req, res) => transition(req, res, {
  allowed: 'submit', action: 'submitted',
  check: (row) => (row.priority === 'Urgent' && !row.urgent_reason ? 'An Urgent request needs a reason before it can be submitted.' : null),
  apply: (row) => {
    const to = firstStage(row);
    return { to, note: `${row.status === 'rejected' ? 'Re-submitted' : 'Submitted'} for ${STAGE_LABELS[to]}`, extraSql: ', submitted_at = NOW(), reject_reason = NULL' };
  },
}));

router.post('/requests/:id/approve', (req, res) => transition(req, res, {
  allowed: 'approve', action: 'approved',
  apply: (row) => {
    const to = nextStatus(row);
    const note = String((req.body && req.body.note) || '').trim();
    const what = to === 'approved' ? 'Final approval — ready for Purchasing' : `Approved → ${STAGE_LABELS[to]}`;
    return { to, note: note ? `${what}. ${note}` : what, extraSql: to === 'approved' ? ', approved_at = NOW()' : '' };
  },
}));

router.post('/requests/:id/reject', (req, res) => transition(req, res, {
  allowed: 'reject', action: 'rejected',
  check: () => (String((req.body && req.body.reason) || '').trim() ? null : 'Give the requester a reason so they can revise the request.'),
  apply: () => {
    const reason = String(req.body.reason).trim();
    return { to: 'rejected', note: reason, extraSql: ', reject_reason = $4', extraParams: [reason] };
  },
}));

router.post('/requests/:id/cancel', (req, res) => transition(req, res, {
  allowed: 'cancel', action: 'cancelled',
  apply: () => ({ to: 'cancelled', note: String((req.body && req.body.reason) || '').trim() || 'Cancelled by requester' }),
}));

router.post('/requests/:id/purchase', (req, res) => transition(req, res, {
  allowed: 'purchase', action: 'po_issued',
  check: () => (String((req.body && req.body.po_no) || '').trim() ? null : 'Enter the PO number issued to the supplier.'),
  apply: () => {
    const b = req.body || {};
    const poNo = String(b.po_no).trim();
    const supplierId = Number(b.supplier_id) || null;
    const supplierName = String(b.supplier_name || '').trim() || null;
    const notes = String(b.purchase_notes || '').trim() || null;
    return {
      to: 'purchasing', note: `PO ${poNo}${supplierName ? ` · ${supplierName}` : ''}${notes ? ` — ${notes}` : ''}`,
      extraSql: ', po_no = $4, supplier_id = $5, supplier_name = COALESCE((SELECT name FROM proc_suppliers WHERE id = $5), $6), purchase_notes = $7, po_at = NOW()',
      extraParams: [poNo, supplierId, supplierName, notes],
    };
  },
}));

router.post('/requests/:id/note', async (req, res) => {
  try {
    const note = String((req.body && req.body.note) || '').trim();
    if (!note) return res.status(400).json({ success: false, message: 'Write a note first.' });
    const row = await loadRequest(pool, req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Request not found' });
    await logHistory(pool, { requestId: row.id, action: 'note', from: row.status, to: row.status, note, req });
    res.json({ success: true });
  } catch (err) {
    console.error('Procurement note error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to add note' });
  }
});

// A reminder is logged on the request; the dashboard opens WhatsApp / email to the approvers.
router.post('/requests/:id/remind', async (req, res) => {
  try {
    const row = await loadRequest(pool, req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Request not found' });
    if (!decorate(req, row).can.remind) return res.status(400).json({ success: false, message: 'This request is not waiting on anyone.' });
    const channel = String((req.body && req.body.channel) || 'WhatsApp');
    const to = String((req.body && req.body.to) || '').trim();
    await logHistory(pool, { requestId: row.id, action: 'reminder', from: row.status, to: row.status, note: `${channel} reminder sent${to ? ` to ${to}` : ''} for ${STAGE_LABELS[row.status] || row.status}`, req });
    res.json({ success: true });
  } catch (err) {
    console.error('Procurement remind error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to log reminder' });
  }
});

// ─── goods receipts (LPB) ───────────────────────────────────────────────────
router.get('/receipts', async (req, res) => {
  try {
    const { search, from, to, request_id } = req.query;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 500);
    const where = [];
    const params = [];
    if (search && String(search).trim()) {
      params.push(`%${String(search).trim()}%`);
      where.push(`(g.grn_no ILIKE $${params.length} OR r.pr_no ILIKE $${params.length} OR r.po_no ILIKE $${params.length} OR g.supplier_name ILIKE $${params.length} OR g.delivery_note ILIKE $${params.length}
        OR EXISTS (SELECT 1 FROM proc_receipt_items x JOIN proc_request_items i ON i.id = x.request_item_id WHERE x.receipt_id = g.id AND i.description ILIKE $${params.length}))`);
    }
    if (parseDate(from)) { params.push(parseDate(from)); where.push(`g.receipt_date >= $${params.length}`); }
    if (parseDate(to)) { params.push(parseDate(to)); where.push(`g.receipt_date <= $${params.length}`); }
    if (request_id) { params.push(Number(request_id)); where.push(`g.request_id = $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const count = await pool.query(`SELECT COUNT(*)::int AS n FROM proc_receipts g JOIN proc_requests r ON r.id = g.request_id ${whereSql}`, params);
    params.push(limit, (page - 1) * limit);
    const r = await pool.query(
      `SELECT g.*, r.pr_no, r.po_no, r.category, r.department, r.status AS request_status,
              (SELECT COALESCE(SUM(qty), 0) FROM proc_receipt_items x WHERE x.receipt_id = g.id) AS total_qty,
              (SELECT COUNT(*)::int FROM proc_receipt_items x WHERE x.receipt_id = g.id) AS line_count,
              (SELECT i.description FROM proc_receipt_items x JOIN proc_request_items i ON i.id = x.request_item_id WHERE x.receipt_id = g.id ORDER BY i.line_no LIMIT 1) AS first_item
       FROM proc_receipts g JOIN proc_requests r ON r.id = g.request_id
       ${whereSql} ORDER BY g.receipt_date DESC, g.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json({ success: true, data: r.rows.map((x) => ({ ...x, total_qty: Number(x.total_qty) })), total: count.rows[0].n, page, limit });
  } catch (err) {
    console.error('Procurement receipts list error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load receipts' });
  }
});

router.get('/receipts/:id', async (req, res) => {
  try {
    const g = await pool.query(
      `SELECT g.*, r.pr_no, r.po_no, r.category, r.department, r.requested_by, r.pr_date, r.status AS request_status, r.priority, r.budget_type
       FROM proc_receipts g JOIN proc_requests r ON r.id = g.request_id WHERE g.id = $1`, [req.params.id]);
    if (!g.rows.length) return res.status(404).json({ success: false, message: 'Receipt not found' });
    const items = await pool.query(
      `SELECT x.*, i.line_no, i.item_code, i.description, i.specification, i.unit, i.qty AS ordered_qty, i.received_qty AS received_total, i.source
       FROM proc_receipt_items x JOIN proc_request_items i ON i.id = x.request_item_id WHERE x.receipt_id = $1 ORDER BY i.line_no`, [g.rows[0].id]);
    res.json({ success: true, data: { ...g.rows[0], items: items.rows.map((i) => ({ ...i, qty: Number(i.qty), ordered_qty: Number(i.ordered_qty), received_total: Number(i.received_total) })) } });
  } catch (err) {
    console.error('Procurement receipt detail error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load receipt' });
  }
});

// Posts a received line into the inventory it came from, so stock goes up without re-typing.
async function postToStock(client, req, { item, qty, receipt, row }) {
  const by = receipt.received_by || actorName(req) || 'Warehouse';
  if (item.source === 'spare_part' && item.source_id) {
    const part = await client.query('SELECT id FROM spare_parts_items WHERE id = $1 FOR UPDATE', [item.source_id]);
    if (!part.rows.length) return null;
    await client.query(
      `INSERT INTO spare_parts_log (item_id, log_date, transaction_type, qty, description, technician, remark, "createdBy")
       VALUES ($1, $2, 'Received', $3, $4, $5, $6, $7)`,
      [item.source_id, receipt.receipt_date, qty, `${receipt.grn_no} · PO ${row.po_no || '-'}`, by, receipt.delivery_note ? `SJ ${receipt.delivery_note}` : null, actorName(req)],
    );
    await client.query(`UPDATE spare_parts_items SET current_qty = current_qty + $2, "updatedAt" = NOW() WHERE id = $1`, [item.source_id, qty]);
    return `SP:${receipt.grn_no}`;
  }
  if (item.source === 'part' && item.source_id) {
    const part = await client.query('SELECT id, code, description, uom FROM pm_item WHERE id = $1', [item.source_id]);
    if (!part.rows.length) return null;
    const p = part.rows[0];
    const ins = await client.query(
      `INSERT INTO parts_stock_in (purchase_order_id, entry_date, supplier_name, part_id, part_code, part_description, uom, quantity_received, received_by, notes, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'verified') RETURNING id`,
      [row.po_no || receipt.grn_no, receipt.receipt_date, receipt.supplier_name || row.supplier_name || 'Procurement', p.id, p.code, p.description, p.uom, qty, by, `${receipt.grn_no}${receipt.delivery_note ? ` · SJ ${receipt.delivery_note}` : ''}`],
    );
    const bal = await client.query(
      `SELECT COALESCE((SELECT SUM(quantity_received) FROM parts_stock_in WHERE part_id=$1),0)
            + COALESCE((SELECT SUM(variance) FROM parts_stock_correction WHERE part_id=$1 AND status='approved'),0)
            - COALESCE((SELECT SUM(quantity_sent) FROM parts_outgoing WHERE part_id=$1 AND status IN ('issued','received')),0)
            - COALESCE((SELECT SUM(quantity_affected) FROM parts_damage_waste WHERE part_id=$1 AND status='approved'),0) AS qty`,
      [p.id],
    );
    const refId = `SI-${String(ins.rows[0].id).padStart(4, '0')}`;
    await client.query(
      `INSERT INTO parts_stock_ledger (transaction_date, transaction_type, reference_id, part_id, part_code, part_description, quantity_in, quantity_out, balance_after, performed_by, notes)
       VALUES ($1,'stock_in',$2,$3,$4,$5,$6,NULL,$7,$8,$9)`,
      [receipt.receipt_date, refId, p.id, p.code, p.description, qty, parseFloat(bal.rows[0].qty) || 0, by, receipt.grn_no],
    );
    return refId;
  }
  return null;
}

router.post('/receipts', async (req, res) => {
  const client = await pool.connect();
  try {
    const b = req.body || {};
    const row = await loadRequest(client, Number(b.request_id));
    if (!row) return res.status(404).json({ success: false, message: 'Request not found' });
    if (!decorate(req, row).can.receive) return res.status(403).json({ success: false, message: `${row.pr_no} is not ready for goods receipt (status: ${row.status.replace('_', ' ')}).` });
    const lines = Array.isArray(b.items) ? b.items.map((x) => ({ request_item_id: Number(x.request_item_id), qty: Number(x.qty), condition: ['good', 'partial_damage', 'damaged'].includes(x.condition) ? x.condition : 'good' })).filter((x) => x.qty > 0) : [];
    if (!lines.length) return res.status(400).json({ success: false, message: 'Enter the quantity received for at least one line.' });
    const receiptDate = parseDate(b.receipt_date) || new Date().toISOString().slice(0, 10);
    const postToStockFlag = b.post_to_stock !== false;

    await client.query('BEGIN');
    await client.query('LOCK TABLE proc_receipts IN SHARE ROW EXCLUSIVE MODE');
    const items = await client.query('SELECT * FROM proc_request_items WHERE request_id = $1 FOR UPDATE', [row.id]);
    const byId = Object.fromEntries(items.rows.map((i) => [i.id, i]));
    for (const l of lines) {
      const it = byId[l.request_item_id];
      if (!it) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, message: 'A received line does not belong to this request.' }); }
      const remaining = Number(it.qty) - Number(it.received_qty);
      if (l.qty > remaining + 1e-9) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: `${it.description}: only ${remaining} ${it.unit} outstanding, cannot receive ${l.qty}.` });
      }
    }
    let seq = await nextSeq(client, 'proc_receipts', 'receipt_date', receiptDate);
    let grnNo = docNumber('LPB', seq, receiptDate);
    for (let tries = 0; tries < 100; tries += 1) {
      const dup = await client.query('SELECT 1 FROM proc_receipts WHERE grn_no = $1', [grnNo]);
      if (!dup.rows.length) break;
      seq += 1; grnNo = docNumber('LPB', seq, receiptDate);
    }
    const supplierId = Number(b.supplier_id) || row.supplier_id || null;
    const supplierName = String(b.supplier_name || '').trim() || row.supplier_name || null;
    const receivedBy = String(b.received_by || '').trim() || actorName(req) || 'Warehouse';
    const condition = ['good', 'partial_damage', 'damaged'].includes(b.condition) ? b.condition : 'good';
    const g = await client.query(
      `INSERT INTO proc_receipts (grn_no, request_id, receipt_date, supplier_id, supplier_name, delivery_note, received_by, condition, notes, posted_to_stock, "createdBy")
       VALUES ($1,$2,$3,$4,COALESCE((SELECT name FROM proc_suppliers WHERE id = $4), $5),$6,$7,$8,$9,$10,$11) RETURNING *`,
      [grnNo, row.id, receiptDate, supplierId, supplierName, String(b.delivery_note || '').trim() || null, receivedBy, condition, String(b.notes || '').trim() || null, postToStockFlag, actorName(req)],
    );
    const receipt = g.rows[0];
    let posted = 0;
    for (const l of lines) {
      const it = byId[l.request_item_id];
      let stockRef = null;
      if (postToStockFlag && l.condition !== 'damaged') {
        stockRef = await postToStock(client, req, { item: it, qty: l.qty, receipt, row });
        if (stockRef) posted += 1;
      }
      await client.query(
        `INSERT INTO proc_receipt_items (receipt_id, request_item_id, qty, condition, stock_ref) VALUES ($1,$2,$3,$4,$5)`,
        [receipt.id, it.id, l.qty, l.condition, stockRef],
      );
      await client.query('UPDATE proc_request_items SET received_qty = received_qty + $2 WHERE id = $1', [it.id, l.qty]);
    }
    const after = await client.query('SELECT SUM(qty) AS q, SUM(received_qty) AS r FROM proc_request_items WHERE request_id = $1', [row.id]);
    const complete = Number(after.rows[0].r) >= Number(after.rows[0].q) - 1e-9;
    const to = complete ? 'completed' : 'partially_received';
    await client.query(
      `UPDATE proc_requests SET status = $2::text, completed_at = CASE WHEN $2::text = 'completed' THEN NOW() ELSE completed_at END, "updatedBy" = $3, "updatedAt" = NOW() WHERE id = $1`,
      [row.id, to, actorName(req)],
    );
    await logHistory(client, {
      requestId: row.id, action: 'goods_received', from: row.status, to,
      note: `${grnNo}${receipt.delivery_note ? ` · SJ ${receipt.delivery_note}` : ''} · ${lines.length} line(s)${posted ? ` · ${posted} posted to stock` : ''}${complete ? ' · fully received' : ''}`,
      req,
    });
    await client.query('COMMIT');
    res.status(201).json({ success: true, data: { ...receipt, request_status: to, posted } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Procurement receipt create error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to record goods receipt' });
  } finally { client.release(); }
});

// ─── summary for the dashboard and reports ──────────────────────────────────
router.get('/summary', async (req, res) => {
  try {
    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to);
    const params = [];
    const where = [];
    if (from) { params.push(from); where.push(`r.pr_date >= $${params.length}`); }
    if (to) { params.push(to); where.push(`r.pr_date <= $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [byStatus, byCategory, byDept, byPriority, byBudget, monthly, lead, overdue, aging, topItems, recent, queue] = await Promise.all([
      pool.query(`SELECT status, COUNT(*)::int AS n FROM proc_requests r ${whereSql} GROUP BY status`, params),
      pool.query(`SELECT category, COUNT(*)::int AS n FROM proc_requests r ${whereSql} GROUP BY category ORDER BY n DESC`, params),
      pool.query(`SELECT department, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE priority = 'Urgent')::int AS urgent FROM proc_requests r ${whereSql} GROUP BY department ORDER BY n DESC`, params),
      pool.query(`SELECT priority, COUNT(*)::int AS n FROM proc_requests r ${whereSql} GROUP BY priority`, params),
      pool.query(`SELECT budget_type, COUNT(*)::int AS n FROM proc_requests r ${whereSql} GROUP BY budget_type`, params),
      pool.query(
        `SELECT to_char(date_trunc('month', r.pr_date), 'YYYY-MM') AS month, COUNT(*)::int AS n,
                COUNT(*) FILTER (WHERE category = 'Sparepart')::int AS sparepart,
                COUNT(*) FILTER (WHERE category = 'Packaging')::int AS packaging,
                COUNT(*) FILTER (WHERE category = 'General')::int AS general
         FROM proc_requests r ${whereSql || "WHERE r.pr_date >= date_trunc('month', CURRENT_DATE) - INTERVAL '5 months'"}
         GROUP BY 1 ORDER BY 1`, params),
      pool.query(
        `SELECT ROUND(AVG(EXTRACT(EPOCH FROM (approved_at - submitted_at)) / 86400)::numeric, 1) AS approve_days,
                ROUND(AVG(EXTRACT(EPOCH FROM (po_at - approved_at)) / 86400)::numeric, 1) AS po_days,
                ROUND(AVG(EXTRACT(EPOCH FROM (completed_at - po_at)) / 86400)::numeric, 1) AS delivery_days,
                ROUND(AVG(EXTRACT(EPOCH FROM (completed_at - submitted_at)) / 86400)::numeric, 1) AS total_days
         FROM proc_requests r ${whereSql}`, params),
      pool.query(
        `SELECT COUNT(*)::int AS n FROM proc_requests r
         WHERE r.required_date < CURRENT_DATE AND r.status NOT IN ('completed','rejected','cancelled','draft') ${where.length ? `AND ${where.join(' AND ')}` : ''}`, params),
      pool.query(
        `SELECT status, COUNT(*)::int AS n, ROUND(AVG(EXTRACT(EPOCH FROM (NOW() - "updatedAt")) / 86400)::numeric, 1) AS avg_days, MAX(EXTRACT(EPOCH FROM (NOW() - "updatedAt")) / 86400)::int AS max_days
         FROM proc_requests r WHERE status IN ('pending_spv','pending_om','pending_director','approved','purchasing','partially_received') GROUP BY status`),
      pool.query(
        `SELECT i.description, i.item_code, i.unit, COUNT(DISTINCT r.id)::int AS requests, SUM(i.qty) AS qty
         FROM proc_request_items i JOIN proc_requests r ON r.id = i.request_id ${whereSql}
         GROUP BY i.description, i.item_code, i.unit ORDER BY requests DESC, qty DESC LIMIT 8`, params),
      pool.query(
        `SELECT h.*, r.pr_no, r.category, r.priority FROM proc_request_history h JOIN proc_requests r ON r.id = h.request_id
         ORDER BY h."createdAt" DESC LIMIT 12`),
      (() => {
        const stages = stagesFor(req);
        if (!stages.length) return Promise.resolve({ rows: [] });
        return pool.query(
          `SELECT ${REQUEST_COLS} FROM proc_requests r LEFT JOIN proc_suppliers s ON s.id = r.supplier_id
           WHERE r.status = ANY($1) ORDER BY (r.priority = 'Urgent') DESC, r."updatedAt" ASC LIMIT 8`, [stages]);
      })(),
    ]);
    const statusMap = Object.fromEntries(byStatus.rows.map((x) => [x.status, x.n]));
    const total = byStatus.rows.reduce((a, x) => a + x.n, 0);
    res.json({
      success: true,
      data: {
        total,
        by_status: statusMap,
        pending: PENDING.reduce((a, s) => a + (statusMap[s] || 0), 0),
        in_purchase: (statusMap.approved || 0) + (statusMap.purchasing || 0) + (statusMap.partially_received || 0),
        completed: statusMap.completed || 0,
        rejected: statusMap.rejected || 0,
        overdue: overdue.rows[0].n,
        by_category: byCategory.rows,
        by_department: byDept.rows,
        by_priority: Object.fromEntries(byPriority.rows.map((x) => [x.priority, x.n])),
        by_budget: Object.fromEntries(byBudget.rows.map((x) => [x.budget_type, x.n])),
        monthly: monthly.rows,
        lead_time: lead.rows[0],
        aging: aging.rows.map((x) => ({ ...x, label: STAGE_LABELS[x.status] || x.status })),
        top_items: topItems.rows.map((x) => ({ ...x, qty: Number(x.qty) })),
        recent: recent.rows,
        my_queue: queue.rows.map((row) => decorate(req, row)),
      },
    });
  } catch (err) {
    console.error('Procurement summary error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load summary' });
  }
});

module.exports = router;
