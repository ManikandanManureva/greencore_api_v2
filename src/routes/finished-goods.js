const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

/**
 * Finished Goods — Outgoing / Sales. Quantities only, no pricing.
 *
 * Available stock is computed live from production_logs, not stored:
 *   produced  = Completed bags at the material's finishing station(s) (see FINISHING_STATIONS),
 *               excluding any bag later consumed as input to a further production step so a
 *               re-processed bag (e.g. Extrusion -> Packing) is only counted once.
 *   shipped   = SUM(weight_kg) from finished_goods_shipments for that material.
 *   available = produced - shipped.
 */
const ALLOWED_ROLES = ['ppic', 'super_admin', 'admin'];

function requireRole(req, res, next) {
  const role = String(req.user && req.user.role ? req.user.role : '').toLowerCase();
  if (!ALLOWED_ROLES.includes(role)) {
    return res.status(403).json({ success: false, message: 'Not authorized to access Finished Goods' });
  }
  next();
}

router.use(authenticateToken, requireRole);

// Material -> station codes whose Completed, unconsumed output counts as finished goods.
const FINISHING_STATIONS = {
  PC: ['EXT', 'PKG'],
  PE: ['EXT'],
  PET: ['EXT', 'PKG'],
};

function actorName(req) {
  return (req.user && (req.user.name || req.user.employeeId)) || null;
}

function finishingStationsSql(paramsOffset) {
  // Builds "(mt.name = $n AND s.code = ANY($n+1)) OR ..." across every material in FINISHING_STATIONS,
  // so the whole rule lives in one place (the map above) instead of being duplicated per query.
  const clauses = [];
  const params = [];
  let i = paramsOffset;
  for (const [material, codes] of Object.entries(FINISHING_STATIONS)) {
    params.push(material, codes);
    clauses.push(`(mt.name = $${i + 1} AND s.code = ANY($${i + 2}))`);
    i += 2;
  }
  return { sql: clauses.join(' OR '), params };
}

async function producedByMaterial(client) {
  const { sql, params } = finishingStationsSql(0);
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

// ─── Summary — Produced / Shipped / Available per material ────────────────────
router.get('/summary', async (req, res) => {
  try {
    const produced = await producedByMaterial(pool);
    const shipped = await pool.query(
      `SELECT mt.name AS material, COALESCE(SUM(s.weight_kg), 0)::numeric AS shipped_weight
       FROM finished_goods_shipments s
       JOIN material_types mt ON mt.id = s.material_type_id
       GROUP BY mt.name`,
    );
    const producedMap = Object.fromEntries(produced.map((r) => [r.material, r]));
    const shippedMap = Object.fromEntries(shipped.rows.map((r) => [r.material, Number(r.shipped_weight)]));

    const data = Object.keys(FINISHING_STATIONS).map((material) => {
      const producedWeight = Number(producedMap[material]?.produced_weight || 0);
      const shippedWeight = shippedMap[material] || 0;
      return {
        material,
        produced_weight: producedWeight,
        bag_count: Number(producedMap[material]?.bag_count || 0),
        shipped_weight: shippedWeight,
        available_weight: Math.max(producedWeight - shippedWeight, 0),
      };
    });
    res.json({ success: true, data });
  } catch (err) {
    console.error('Finished goods summary error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load finished goods summary' });
  }
});

// ─── Shipments (Outgoing / Sales) ──────────────────────────────────────────────
router.get('/shipments', async (req, res) => {
  try {
    const { search, material, date_from, date_to } = req.query;
    const { page = 1, limit = 20 } = req.query;
    const where = [];
    const params = [];

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
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

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
    res.json({
      success: true, data: rowsRes.rows, page: parseInt(page), limit: parseInt(limit),
      total, totalPages: Math.max(1, Math.ceil(total / parseInt(limit))),
    });
  } catch (err) {
    console.error('Finished goods shipments list error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load shipments' });
  }
});

router.post('/shipments', async (req, res) => {
  const client = await pool.connect();
  try {
    const { material, weight_kg, customer, destination, vehicle_no, dn_no, notes } = req.body || {};
    const shipment_date = req.body.shipment_date || null;
    if (!material || !FINISHING_STATIONS[material]) {
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

    const produced = await producedByMaterial(client);
    const producedWeight = Number(produced.find((r) => r.material === material)?.produced_weight || 0);
    const shippedRes = await client.query(
      'SELECT COALESCE(SUM(weight_kg), 0)::numeric AS n FROM finished_goods_shipments WHERE material_type_id = $1',
      [materialTypeId],
    );
    const availableWeight = producedWeight - Number(shippedRes.rows[0].n);
    if (weightNum > availableWeight) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: `Insufficient finished stock. Available: ${availableWeight.toFixed(2)} kg, Requested: ${weightNum} kg` });
    }

    const r = await client.query(
      `INSERT INTO finished_goods_shipments
         (shipment_date, material_type_id, weight_kg, customer, destination, vehicle_no, dn_no, notes, "createdBy")
       VALUES (COALESCE($1::date, CURRENT_DATE), $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [shipment_date, materialTypeId, weightNum, customer || null, destination || null, vehicle_no || null, dn_no || null, notes || null, actorName(req)],
    );
    await client.query('COMMIT');
    res.status(201).json({ success: true, data: { ...r.rows[0], material } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Finished goods shipment create error:', err.message);
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
    console.error('Finished goods shipment delete error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete shipment' });
  }
});

module.exports = router;
