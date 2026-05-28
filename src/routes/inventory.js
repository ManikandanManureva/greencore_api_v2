const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

/**
 * Inventory module — gate-entry (raw_material) records.
 * Restricted to PPIC and Super Admin roles.
 */
const ALLOWED_ROLES = ['ppic', 'super_admin', 'admin'];

function requireInventoryRole(req, res, next) {
  const role = String(req.user && req.user.role ? req.user.role : '').toLowerCase();
  if (!ALLOWED_ROLES.includes(role)) {
    return res.status(403).json({
      success: false,
      message: 'You are not authorized to access the Inventory module',
    });
  }
  next();
}

// Every inventory route requires a valid token AND an allowed role.
router.use(authenticateToken, requireInventoryRole);

// Editable API field -> DB column (quoted where the column is camelCase).
const FIELDS = {
  refId: '"refId"',
  entrydate: 'entrydate',
  entrytime: 'entrytime',
  exitdate: 'exitdate',
  exittime: 'exittime',
  truckId: '"truckId"',
  supplier: 'supplier',
  materialType: '"materialType"',
  entryWeight: '"entryWeight"',
  exitWeight: '"exitWeight"',
  netWeight: '"netWeight"',
  deliveryNote: '"deliveryNote"',
  notes: 'notes',
  quantity: 'quantity',
  status: 'status',
  materialDescription: '"materialDescription"',
  returnentrydate: 'returnentrydate',
  returnentrytime: 'returnentrytime',
  returnExitDate: '"returnExitDate"',
  returnExitTime: '"returnExitTime"',
  returnEntryWeight: '"returnEntryWeight"',
  returnExitWeight: '"returnExitWeight"',
  returnNetWeight: '"returnNetWeight"',
  recordNoWBS: '"recordNoWBS"',
  plant: 'plant',
};

const NUMERIC_FIELDS = new Set([
  'entryWeight',
  'exitWeight',
  'netWeight',
  'quantity',
  'returnEntryWeight',
  'returnExitWeight',
  'returnNetWeight',
]);

const VALID_STATUS = ['Pending', 'Accepted', 'Rejected'];
const VALID_STATIONS = ['PC', 'PE', 'PET'];

// Normalise an incoming value: '' -> null, numeric strings -> Number.
function cleanValue(field, value) {
  if (value === undefined || value === null || value === '') return null;
  if (NUMERIC_FIELDS.has(field)) {
    const n = Number(value);
    return Number.isNaN(n) ? null : n;
  }
  return value;
}

function actorName(req) {
  return (req.user && (req.user.name || req.user.employeeId)) || null;
}

function buildListFilters(query) {
  const where = [];
  const params = [];

  const search = String(query.search || '').trim();
  if (search) {
    params.push(`%${search}%`);
    const i = params.length;
    where.push(
      `("refId" ILIKE $${i} OR supplier ILIKE $${i} OR "truckId" ILIKE $${i} ` +
        `OR "materialType" ILIKE $${i} OR "deliveryNote" ILIKE $${i} ` +
        `OR "createdBy" ILIKE $${i} OR id::text ILIKE $${i})`,
    );
  }

  const status = String(query.status || '').trim();
  if (status && VALID_STATUS.includes(status)) {
    params.push(status);
    where.push(`status = $${params.length}`);
  }

  const operator = String(query.operator || query.createdBy || '').trim();
  if (operator === '__unassigned__') {
    where.push(`("createdBy" IS NULL OR TRIM("createdBy") = '')`);
  } else if (operator) {
    params.push(operator);
    where.push(`"createdBy" = $${params.length}`);
  }

  const date = String(query.date || '').trim();
  if (date) {
    params.push(date);
    where.push(`exitdate::text = $${params.length}`);
  }

  // Date-range filter (used by the dashboard's period filter).
  const dateStart = String(query.date_start || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStart)) {
    params.push(dateStart);
    where.push(`exitdate::date >= $${params.length}::date`);
  }
  const dateEnd = String(query.date_end || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateEnd)) {
    params.push(dateEnd);
    where.push(`exitdate::date <= $${params.length}::date`);
  }

  const station = String(query.station || query.materialType || '').trim().toUpperCase();
  if (VALID_STATIONS.includes(station)) {
    params.push(station);
    where.push(`UPPER(TRIM("materialType")) = $${params.length}`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return { whereSql, params };
}

function stationDateClause(query, params) {
  const parts = [];
  const date = String(query.date || '').trim();
  if (date) {
    params.push(date);
    parts.push(`exitdate::text = $${params.length}`);
  }
  // Date-range filter (used by the Material Balance section)
  const dateStart = String(query.date_start || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStart)) {
    params.push(dateStart);
    parts.push(`exitdate::date >= $${params.length}::date`);
  }
  const dateEnd = String(query.date_end || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateEnd)) {
    params.push(dateEnd);
    parts.push(`exitdate::date <= $${params.length}::date`);
  }
  const station = String(query.station || query.materialType || '').trim().toUpperCase();
  if (VALID_STATIONS.includes(station)) {
    params.push(station);
    parts.push(`UPPER(TRIM("materialType")) = $${params.length}`);
  }
  return parts.length ? `WHERE ${parts.join(' AND ')}` : '';
}

/**
 * GET /inventory/summary
 * Counts by status + total net weight (for the dashboard summary cards).
 */
router.get('/summary', async (req, res) => {
  try {
    const { whereSql, params } = buildListFilters(req.query);
    const result = await pool.query(`
      SELECT
        COUNT(*)::int                                          AS total,
        COUNT(*) FILTER (WHERE status = 'Pending')::int        AS pending,
        COUNT(*) FILTER (WHERE status = 'Accepted')::int       AS accepted,
        COUNT(*) FILTER (WHERE status = 'Rejected')::int       AS rejected,
        COALESCE(SUM("netWeight"), 0)::float                   AS total_net_weight
      FROM raw_material
      ${whereSql}
    `, params);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('Inventory summary error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load inventory summary' });
  }
});

/**
 * GET /inventory/stations
 * Gate-entry stats by material line: PC / PE / PET.
 */
router.get('/stations', async (req, res) => {
  try {
    const params = [];
    const extraWhere = stationDateClause(req.query, params);

    const result = await pool.query(
      `SELECT
        UPPER(TRIM("materialType")) AS station,
        COUNT(*)::int AS entries,
        COUNT(*) FILTER (WHERE status = 'Pending')::int AS pending,
        COUNT(*) FILTER (WHERE status = 'Accepted')::int AS accepted,
        COUNT(*) FILTER (WHERE status = 'Rejected')::int AS rejected,
        COALESCE(SUM("netWeight"), 0)::float AS total_net_weight,
        MAX(exitdate) AS last_exit_date
      FROM raw_material
      ${extraWhere ? `${extraWhere} AND` : 'WHERE'}
        UPPER(TRIM("materialType")) IN ('PC', 'PE', 'PET')
      GROUP BY 1
      ORDER BY entries DESC`,
      params,
    );

    const byStation = new Map(result.rows.map((row) => [row.station, row]));
    const data = VALID_STATIONS.map((code) => {
      const row = byStation.get(code);
      return {
        station: code,
        label: code === 'PC' ? 'PC Line' : code === 'PE' ? 'PE Line' : 'PET Line',
        entries: row ? row.entries : 0,
        pending: row ? row.pending : 0,
        accepted: row ? row.accepted : 0,
        rejected: row ? row.rejected : 0,
        totalNetWeight: row ? row.total_net_weight : 0,
        lastExitDate: row ? row.last_exit_date : null,
      };
    });

    const totalRow = await pool.query(
      `SELECT COUNT(*)::int AS entries, COALESCE(SUM("netWeight"), 0)::float AS total_net_weight
       FROM raw_material
       ${extraWhere ? `${extraWhere} AND` : 'WHERE'}
         UPPER(TRIM("materialType")) IN ('PC', 'PE', 'PET')`,
      params,
    );

    res.json({
      success: true,
      data,
      total: {
        entries: totalRow.rows[0].entries,
        totalNetWeight: totalRow.rows[0].total_net_weight,
      },
    });
  } catch (err) {
    console.error('Inventory stations error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load stations' });
  }
});

/**
 * GET /inventory/operators
 * Gate-entry operators with entry counts (same DB as greencode_api mobile).
 */
router.get('/operators', async (req, res) => {
  try {
    const params = [];
    const whereClause = stationDateClause(req.query, params);
    const whereSql = whereClause || 'WHERE 1=1';

    const [statsResult, usersResult] = await Promise.all([
      pool.query(
        `SELECT
          COALESCE(NULLIF(TRIM("createdBy"), ''), '__unassigned__') AS operator,
          COUNT(*)::int AS entries,
          COALESCE(SUM("netWeight"), 0)::float AS total_net_weight,
          MAX(exitdate) AS last_exit_date
        FROM raw_material
        ${whereSql}
        GROUP BY 1
        ORDER BY entries DESC`,
        params,
      ),
      pool.query(
        `SELECT
          "userName" AS operator,
          TRIM(COALESCE("firstName", '') || ' ' || COALESCE("lastName", '')) AS display_name
        FROM "user"
        WHERE UPPER(COALESCE(role, '')) IN ('BASIC', 'BASIC MODULE')
          AND COALESCE("isActive", 1) = 1
        ORDER BY "userName" ASC`,
      ),
    ]);

    const byOperator = new Map();
    for (const row of statsResult.rows) {
      byOperator.set(row.operator, {
        operator: row.operator,
        displayName:
          row.operator === '__unassigned__' ? 'Unassigned (legacy)' : row.operator,
        entries: row.entries,
        totalNetWeight: row.total_net_weight,
        lastExitDate: row.last_exit_date,
      });
    }

    for (const row of usersResult.rows) {
      const existing = byOperator.get(row.operator);
      const display =
        row.display_name && row.display_name.trim() !== ''
          ? row.display_name.trim()
          : row.operator;
      if (existing) {
        existing.displayName = display;
      } else {
        byOperator.set(row.operator, {
          operator: row.operator,
          displayName: display,
          entries: 0,
          totalNetWeight: 0,
          lastExitDate: null,
        });
      }
    }

    const data = Array.from(byOperator.values()).sort((a, b) => {
      if (a.operator === '__unassigned__') return 1;
      if (b.operator === '__unassigned__') return -1;
      return b.entries - a.entries;
    });

    res.json({ success: true, data });
  } catch (err) {
    console.error('Inventory operators error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load operators' });
  }
});

/**
 * GET /inventory/raw-materials
 * Paginated list with optional search + status filter.
 */
router.get('/raw-materials', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = (page - 1) * limit;

    const { whereSql, params } = buildListFilters(req.query);

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM raw_material ${whereSql}`,
      params,
    );
    const total = countResult.rows[0].total;

    const listParams = params.slice();
    listParams.push(limit);
    listParams.push(offset);
    const listResult = await pool.query(
      `SELECT * FROM raw_material ${whereSql} ` +
        `ORDER BY id DESC LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams,
    );

    res.json({
      success: true,
      data: listResult.rows,
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    console.error('Inventory list error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load inventory' });
  }
});

/**
 * GET /inventory/raw-materials/:id
 */
router.get('/raw-materials/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM raw_material WHERE id = $1', [
      req.params.id,
    ]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Record not found' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('Inventory get error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load record' });
  }
});

/**
 * POST /inventory/raw-materials  — create a gate-entry record.
 */
router.post('/raw-materials', async (req, res) => {
  try {
    const body = req.body || {};
    if (body.status === '') delete body.status;
    if (body.status && !VALID_STATUS.includes(body.status)) {
      return res.status(400).json({ success: false, message: 'Invalid status value' });
    }

    const columns = [];
    const placeholders = [];
    const values = [];

    for (const field of Object.keys(FIELDS)) {
      if (body[field] !== undefined) {
        columns.push(FIELDS[field]);
        values.push(cleanValue(field, body[field]));
        placeholders.push(`$${values.length}`);
      }
    }

    columns.push('"createdBy"');
    values.push(actorName(req));
    placeholders.push(`$${values.length}`);

    columns.push('"updatedBy"');
    values.push(actorName(req));
    placeholders.push(`$${values.length}`);

    columns.push('"createdAt"');
    placeholders.push('NOW()');
    columns.push('"updatedAt"');
    placeholders.push('NOW()');

    const sql =
      `INSERT INTO raw_material (${columns.join(', ')}) ` +
      `VALUES (${placeholders.join(', ')}) RETURNING *`;
    const result = await pool.query(sql, values);
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('Inventory create error:', err.message);
    res.status(500).json({
      success: false,
      message: err.message || 'Failed to create record',
    });
  }
});

/**
 * PUT /inventory/raw-materials/:id  — update a gate-entry record.
 */
router.put('/raw-materials/:id', async (req, res) => {
  try {
    const body = req.body || {};
    if (body.status === '') delete body.status;
    if (body.status && !VALID_STATUS.includes(body.status)) {
      return res.status(400).json({ success: false, message: 'Invalid status value' });
    }

    const sets = [];
    const values = [];

    for (const field of Object.keys(FIELDS)) {
      if (body[field] !== undefined) {
        values.push(cleanValue(field, body[field]));
        sets.push(`${FIELDS[field]} = $${values.length}`);
      }
    }

    if (sets.length === 0) {
      return res.status(400).json({ success: false, message: 'No fields to update' });
    }

    values.push(actorName(req));
    sets.push(`"updatedBy" = $${values.length}`);
    sets.push('"updatedAt" = NOW()');

    values.push(req.params.id);
    const sql =
      `UPDATE raw_material SET ${sets.join(', ')} ` +
      `WHERE id = $${values.length} RETURNING *`;
    const result = await pool.query(sql, values);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Record not found' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('Inventory update error:', err.message);
    res.status(500).json({
      success: false,
      message: err.message || 'Failed to update record',
    });
  }
});

/* ════════════════════════════════════════════════════════════════
 * Opening Stock — append-only versioned record (see opening_stock table).
 * ════════════════════════════════════════════════════════════════ */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * POST /inventory/opening-stock
 * Body: { from_date, to_date, pc_kg, pe_kg, pet_kg, notes? }
 * Always INSERTS a new row — never updates — so every change is preserved.
 */
router.post('/opening-stock', async (req, res) => {
  try {
    const body = req.body || {};

    const fromDate = String(body.from_date || '').trim();
    const toDate = String(body.to_date || '').trim();
    if (!ISO_DATE_RE.test(fromDate) || !ISO_DATE_RE.test(toDate)) {
      return res.status(400).json({
        success: false,
        message: 'from_date and to_date must be YYYY-MM-DD',
      });
    }
    if (toDate < fromDate) {
      return res.status(400).json({
        success: false,
        message: 'to_date cannot be earlier than from_date',
      });
    }

    const numField = (v) => {
      if (v === undefined || v === null || v === '') return 0;
      const n = Number(v);
      if (Number.isNaN(n) || n < 0) return null;
      return n;
    };
    const pc = numField(body.pc_kg);
    const pe = numField(body.pe_kg);
    const pet = numField(body.pet_kg);
    if (pc === null || pe === null || pet === null) {
      return res.status(400).json({
        success: false,
        message: 'pc_kg / pe_kg / pet_kg must be zero or a positive number',
      });
    }

    const result = await pool.query(
      `INSERT INTO opening_stock
         (from_date, to_date, pc_kg, pe_kg, pet_kg, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, from_date, to_date, pc_kg, pe_kg, pet_kg, total_kg, notes,
                 created_by, created_at`,
      [fromDate, toDate, pc, pe, pet, body.notes || null, actorName(req)],
    );

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('Opening stock create error:', err.message);
    res.status(500).json({
      success: false,
      message: err.message || 'Failed to save opening stock',
    });
  }
});

/**
 * GET /inventory/opening-stock
 * Paginated history (newest first). Optional ?from_date / ?to_date filter
 * the result set to entries whose period overlaps the requested range.
 */
router.get('/opening-stock', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const offset = (page - 1) * limit;

    const conds = [];
    const params = [];
    const from = String(req.query.from_date || '').trim();
    if (ISO_DATE_RE.test(from)) {
      params.push(from);
      conds.push(`to_date >= $${params.length}`);
    }
    const to = String(req.query.to_date || '').trim();
    if (ISO_DATE_RE.test(to)) {
      params.push(to);
      conds.push(`from_date <= $${params.length}`);
    }
    const search = String(req.query.search || '').trim();
    if (search) {
      params.push(`%${search}%`);
      const i = params.length;
      conds.push(`(created_by ILIKE $${i} OR notes ILIKE $${i} OR id::text ILIKE $${i})`);
    }
    const whereSql = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM opening_stock ${whereSql}`,
      params,
    );
    const total = countResult.rows[0].total;

    const dataParams = params.slice();
    dataParams.push(limit, offset);
    const listResult = await pool.query(
      `SELECT id, from_date, to_date, pc_kg, pe_kg, pet_kg, total_kg, notes,
              created_by, created_at
         FROM opening_stock ${whereSql}
         ORDER BY created_at DESC
         LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams,
    );

    res.json({
      success: true,
      data: listResult.rows,
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    console.error('Opening stock list error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load opening stock history' });
  }
});

/**
 * GET /inventory/opening-stock/latest
 * Most recent saved opening-stock entry (regardless of period). Useful for
 * pre-filling the form on page load.
 */
router.get('/opening-stock/latest', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, from_date, to_date, pc_kg, pe_kg, pet_kg, total_kg, notes,
              created_by, created_at
         FROM opening_stock
         ORDER BY created_at DESC
         LIMIT 1`,
    );
    res.json({ success: true, data: result.rows[0] || null });
  } catch (err) {
    console.error('Opening stock latest error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load latest opening stock' });
  }
});

/* ════════════════════════════════════════════════════════════════
 * Outgoing & Adjustments — see outgoing_entries table.
 * ════════════════════════════════════════════════════════════════ */

const VALID_OUT_REASONS = ['dispatch', 'reject', 'transfer', 'adjustment'];
const VALID_OUT_MATERIALS = ['PC', 'PE', 'PET'];

router.post('/outgoing', async (req, res) => {
  try {
    const body = req.body || {};
    const reason = String(body.reason || '').trim().toLowerCase();
    if (!VALID_OUT_REASONS.includes(reason)) {
      return res.status(400).json({ success: false, message: 'reason must be one of ' + VALID_OUT_REASONS.join(', ') });
    }
    const material = String(body.material || '').trim().toUpperCase();
    if (!VALID_OUT_MATERIALS.includes(material)) {
      return res.status(400).json({ success: false, message: 'material must be one of ' + VALID_OUT_MATERIALS.join(', ') });
    }
    const qty = Number(body.quantity_kg);
    if (!Number.isFinite(qty) || qty === 0) {
      return res.status(400).json({ success: false, message: 'quantity_kg must be a non-zero number' });
    }
    // Allow signed for adjustment; force positive for dispatch/reject/transfer.
    const signed = reason === 'adjustment' ? qty : Math.abs(qty);

    const occurred = body.occurred_at && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(body.occurred_at)
      ? body.occurred_at
      : null;

    const result = await pool.query(
      `INSERT INTO outgoing_entries
         (occurred_at, reason, material, quantity_kg, reference, notes, created_by)
       VALUES (COALESCE($1::timestamptz, NOW()), $2, $3, $4, $5, $6, $7)
       RETURNING id, ref, occurred_at, reason, material, quantity_kg, reference, notes,
                 created_by, created_at`,
      [occurred, reason, material, signed, body.reference || null, body.notes || null, actorName(req)],
    );
    // The AFTER INSERT trigger fills `ref` if it was null; refetch the final row.
    const row = result.rows[0];
    if (!row.ref) {
      const refetched = await pool.query('SELECT * FROM outgoing_entries WHERE id = $1', [row.id]);
      res.status(201).json({ success: true, data: refetched.rows[0] });
    } else {
      res.status(201).json({ success: true, data: row });
    }
  } catch (err) {
    console.error('Outgoing create error:', err.message);
    res.status(500).json({ success: false, message: err.message || 'Failed to record outgoing entry' });
  }
});

router.get('/outgoing', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const offset = (page - 1) * limit;

    const conds = [];
    const params = [];
    const ds = String(req.query.date_start || '').trim();
    if (ISO_DATE_RE.test(ds)) {
      params.push(ds);
      conds.push(`occurred_at::date >= $${params.length}::date`);
    }
    const de = String(req.query.date_end || '').trim();
    if (ISO_DATE_RE.test(de)) {
      params.push(de);
      conds.push(`occurred_at::date <= $${params.length}::date`);
    }
    const material = String(req.query.material || '').trim().toUpperCase();
    if (VALID_OUT_MATERIALS.includes(material)) {
      params.push(material);
      conds.push(`material = $${params.length}`);
    }
    const reason = String(req.query.reason || '').trim().toLowerCase();
    if (VALID_OUT_REASONS.includes(reason)) {
      params.push(reason);
      conds.push(`reason = $${params.length}`);
    }
    const search = String(req.query.search || '').trim();
    if (search) {
      params.push(`%${search}%`);
      const i = params.length;
      conds.push(`(ref ILIKE $${i} OR reference ILIKE $${i} OR notes ILIKE $${i} OR created_by ILIKE $${i})`);
    }
    const whereSql = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COALESCE(SUM(ABS(quantity_kg)), 0)::float AS total_kg
         FROM outgoing_entries ${whereSql}`,
      params,
    );
    const summary = countResult.rows[0];

    const listParams = params.slice();
    listParams.push(limit, offset);
    const list = await pool.query(
      `SELECT id, ref, occurred_at, reason, material, quantity_kg, reference, notes,
              created_by, created_at
         FROM outgoing_entries ${whereSql}
         ORDER BY occurred_at DESC, id DESC
         LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams,
    );

    res.json({
      success: true,
      data: list.rows,
      page,
      limit,
      total: summary.total,
      total_kg: summary.total_kg,
      totalPages: Math.max(1, Math.ceil(summary.total / limit)),
    });
  } catch (err) {
    console.error('Outgoing list error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load outgoing entries' });
  }
});

/* ════════════════════════════════════════════════════════════════
 * Stock Ledger — unified chronological view of every movement
 * (opening, receipts, consumption-at-crusher, outgoing) with
 * per-material running balance.
 * ════════════════════════════════════════════════════════════════ */

router.get('/ledger', async (req, res) => {
  try {
    const fromDate = String(req.query.from_date || '').trim();
    const toDate = String(req.query.to_date || '').trim();
    const hasFrom = ISO_DATE_RE.test(fromDate);
    const hasTo = ISO_DATE_RE.test(toDate);

    const matFilter = String(req.query.material || '').trim().toUpperCase();
    const useMatFilter = VALID_OUT_MATERIALS.includes(matFilter);

    const typeFilter = String(req.query.type || '').trim().toLowerCase();
    const validTypes = ['opening', 'receipt', 'consumption', 'outgoing'];
    const useTypeFilter = validTypes.includes(typeFilter);

    const search = String(req.query.search || '').trim().toLowerCase();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 25));

    // ── 1. OPENING events (one row per material per opening_stock record) ──
    const openingsRaw = await pool.query(
      `SELECT id, from_date AS occurred_date, pc_kg, pe_kg, pet_kg, notes,
              created_by, created_at
         FROM opening_stock
         ${hasFrom || hasTo ? 'WHERE 1=1' : ''}
         ${hasFrom ? 'AND from_date >= $1' : ''}
         ${hasFrom && hasTo ? 'AND from_date <= $2' : (hasTo ? 'AND from_date <= $1' : '')}
         ORDER BY from_date ASC, created_at ASC`,
      hasFrom && hasTo ? [fromDate, toDate] : hasFrom ? [fromDate] : hasTo ? [toDate] : [],
    );
    const openings = [];
    for (const r of openingsRaw.rows) {
      const baseDt = new Date(r.created_at);
      for (const [mat, qty] of [['PC', r.pc_kg], ['PE', r.pe_kg], ['PET', r.pet_kg]]) {
        const q = Number(qty) || 0;
        if (q === 0) continue;
        openings.push({
          source: 'opening',
          src_id: r.id,
          ts: baseDt.getTime(),
          occurred_at: r.created_at,
          material: mat,
          type: 'Opening',
          reference: 'Day open' + (r.notes ? ` · ${r.notes}` : ''),
          qty: q,
          created_by: r.created_by,
        });
      }
    }

    // ── 2. RECEIPTS (gate entries) ──
    const recParams = [];
    const recConds = [];
    if (hasFrom) { recParams.push(fromDate); recConds.push(`exitdate::date >= $${recParams.length}::date`); }
    if (hasTo)   { recParams.push(toDate);   recConds.push(`exitdate::date <= $${recParams.length}::date`); }
    if (useMatFilter) { recParams.push(matFilter); recConds.push(`UPPER(TRIM("materialType")) = $${recParams.length}`); }
    const recWhere = recConds.length ? `WHERE ${recConds.join(' AND ')}` : '';
    const receiptsRaw = await pool.query(
      `SELECT id, exitdate, exittime, "materialType" AS material, "netWeight" AS qty,
              COALESCE(NULLIF("refId",''), 'GE-' || id::text) AS ref_code,
              supplier, "deliveryNote", "createdBy"
         FROM raw_material
         ${recWhere}
         ORDER BY exitdate ASC NULLS LAST, exittime ASC NULLS LAST`,
      recParams,
    );
    const receipts = receiptsRaw.rows.map((r) => {
      const dt = r.exitdate
        ? `${String(r.exitdate).slice(0, 10)}T${(r.exittime || '00:00:00')}`
        : null;
      const refParts = [r.ref_code];
      if (r.supplier) refParts.push(r.supplier);
      return {
        source: 'receipt',
        src_id: r.id,
        ts: dt ? new Date(dt).getTime() : 0,
        occurred_at: dt,
        material: String(r.material || '').toUpperCase(),
        type: 'Receipt',
        reference: refParts.filter(Boolean).join(' / '),
        qty: Number(r.qty) || 0,
        created_by: r.createdBy,
      };
    });

    // ── 3. CONSUMPTION (production_logs at the CRUSHER stage = raw consumed) ──
    const consParams = [];
    const consConds = ["pl.status != 'Cancelled'", "(s.code = 'CRS' OR LOWER(s.name) LIKE '%crusher%')"];
    if (hasFrom) { consParams.push(fromDate); consConds.push(`pl.created_at::date >= $${consParams.length}::date`); }
    if (hasTo)   { consParams.push(toDate);   consConds.push(`pl.created_at::date <= $${consParams.length}::date`); }
    if (useMatFilter) { consParams.push(matFilter); consConds.push(`UPPER(TRIM(mt.name)) = $${consParams.length}`); }
    const consumptionRaw = await pool.query(
      `SELECT pl.id, pl.created_at, pl.weight, pl.sub_line,
              mt.name AS material, s.name AS station_name, s.code AS station_code
         FROM production_logs pl
         JOIN stations s ON s.id = pl.station_id
         JOIN operator_shifts os ON pl.shift_id = os.id
         LEFT JOIN material_types mt ON os.material_type_id = mt.id
         WHERE ${consConds.join(' AND ')}
         ORDER BY pl.created_at ASC`,
      consParams,
    );
    const consumption = consumptionRaw.rows.map((r) => {
      const line = (r.sub_line && r.sub_line !== 'General')
        ? r.sub_line
        : `${r.station_code || 'CRS'}`;
      return {
        source: 'consumption',
        src_id: r.id,
        ts: new Date(r.created_at).getTime(),
        occurred_at: r.created_at,
        material: String(r.material || '').toUpperCase(),
        type: 'Consumption',
        reference: `${line} — Shredding`,
        qty: -(Number(r.weight) || 0),
        created_by: null,
      };
    });

    // ── 4. OUTGOING ──
    const outParams = [];
    const outConds = [];
    if (hasFrom) { outParams.push(fromDate); outConds.push(`occurred_at::date >= $${outParams.length}::date`); }
    if (hasTo)   { outParams.push(toDate);   outConds.push(`occurred_at::date <= $${outParams.length}::date`); }
    if (useMatFilter) { outParams.push(matFilter); outConds.push(`material = $${outParams.length}`); }
    const outWhere = outConds.length ? `WHERE ${outConds.join(' AND ')}` : '';
    const outgoingRaw = await pool.query(
      `SELECT id, ref, occurred_at, material, quantity_kg, reason, reference, notes, created_by
         FROM outgoing_entries
         ${outWhere}
         ORDER BY occurred_at ASC`,
      outParams,
    );
    const reasonShort = { dispatch: 'Dispatch', reject: 'Reject', transfer: 'Transfer', adjustment: 'Adjustment' };
    const outgoing = outgoingRaw.rows.map((r) => {
      const refParts = [reasonShort[r.reason] || r.reason];
      if (r.reference) refParts.push(r.reference);
      const qty = Number(r.quantity_kg) || 0;
      return {
        source: 'outgoing',
        src_id: r.id,
        ts: new Date(r.occurred_at).getTime(),
        occurred_at: r.occurred_at,
        material: String(r.material || '').toUpperCase(),
        type: 'Outgoing',
        reference: refParts.join(' — '),
        qty: r.reason === 'adjustment' ? qty : -Math.abs(qty),
        created_by: r.created_by,
      };
    });

    // ── Combine + chronological sort (oldest first) ──
    const allEvents = [...openings, ...receipts, ...consumption, ...outgoing]
      .filter((e) => !useMatFilter || e.material === matFilter)
      .sort((a, b) => a.ts - b.ts);

    // ── Walk forward computing per-material running balance ──
    const balances = { PC: 0, PE: 0, PET: 0 };
    const summary = {
      PC:  { opening: 0, in_kg: 0, out_kg: 0, closing: 0 },
      PE:  { opening: 0, in_kg: 0, out_kg: 0, closing: 0 },
      PET: { opening: 0, in_kg: 0, out_kg: 0, closing: 0 },
    };
    let seq = 0;
    const enriched = allEvents.map((e) => {
      seq += 1;
      const m = ['PC', 'PE', 'PET'].includes(e.material) ? e.material : null;
      if (m) {
        balances[m] += e.qty;
        if (e.source === 'opening')  summary[m].opening += e.qty;
        if (e.qty >= 0 && e.source !== 'opening') summary[m].in_kg  += e.qty;
        if (e.qty < 0)               summary[m].out_kg += Math.abs(e.qty);
      }
      return {
        entry: `L-${String(seq).padStart(3, '0')}`,
        occurred_at: e.occurred_at,
        material: e.material,
        type: e.type,
        reference: e.reference,
        qty: e.qty,
        balance: m ? balances[m] : 0,
        source: e.source,
        src_id: e.src_id,
        created_by: e.created_by,
      };
    });
    for (const m of ['PC', 'PE', 'PET']) {
      summary[m].closing = summary[m].opening + summary[m].in_kg - summary[m].out_kg;
    }

    // ── Apply type & search filters AFTER running balance is computed ──
    let filtered = enriched;
    if (useTypeFilter) {
      const wanted = typeFilter.charAt(0).toUpperCase() + typeFilter.slice(1);
      filtered = filtered.filter((e) => e.type === wanted);
    }
    if (search) {
      filtered = filtered.filter((e) =>
        e.entry.toLowerCase().includes(search) ||
        String(e.reference || '').toLowerCase().includes(search) ||
        String(e.material || '').toLowerCase().includes(search) ||
        String(e.type || '').toLowerCase().includes(search)
      );
    }

    // ── Reverse for display (newest first) ──
    filtered.reverse();

    const total = filtered.length;
    const offset = (page - 1) * limit;
    const slice = filtered.slice(offset, offset + limit);

    res.json({
      success: true,
      data: slice,
      summary,
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    console.error('Ledger error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load ledger' });
  }
});

module.exports = router;
