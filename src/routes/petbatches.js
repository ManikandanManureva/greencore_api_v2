const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

/**
 * PET raw-material Batch traceability. A Batch groups ~8 Delivery Notes (GPET/YYMMDD/NN) and is
 * created by the Hot Washing operator or by PPIC; each station of the line (Hot Washing → Dry
 * Sorter → Pelletizer) then starts/stops its own sessions against it, and every output bag is
 * tagged with the batch running at its station. Wraps the existing jumbo-bag QR/weight workflow.
 */
const ALLOWED_ROLES = ['pet', 'ppic', 'super_admin', 'admin'];
// Current line + the original 4 keys, still accepted so older sessions/app versions keep working.
const LINE_STATION_KEYS = ['hot_washing', 'dry_sorter', 'pelletizer'];
const STATION_KEYS = [...LINE_STATION_KEYS, 'crushing', 'washing', 'flakes_sorting', 'extrusion'];

const REGION_CODES = {
  'Jawa Barat': 'JB',
  'Jawa Timur': 'JT',
  'Jawa Tengah': 'JTG',
  Sumatra: 'SUM',
  Sulawesi: 'SUL',
  Bali: 'BALI',
};

function requireRole(req, res, next) {
  const role = String(req.user?.role || '').toLowerCase();
  if (ALLOWED_ROLES.includes(role)) return next();
  return res.status(403).json({ success: false, message: 'Not authorized for PET Batch tracking' });
}

router.use(authenticateToken, requireRole);

function actorName(req) {
  return (req.user && (req.user.name || req.user.employeeId)) || null;
}

// Plant-local date (the server may run in UTC — a batch started at 06:30 WIB must still carry
// today's date in its number, not yesterday's).
function todayDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());
}

// Create a Batch from its Delivery Notes (usually ~8) → GPET/YYMMDD/NN, running number resetting
// daily. The Hot Washing operator passes start_station: 'hot_washing' so their session starts
// right away; PPIC creates batches without a session and the station picks them up later.
router.post('/', async (req, res) => {
  const client = await pool.connect();
  try {
    const { delivery_notes, start_station } = req.body;
    const notes = Array.isArray(delivery_notes)
      ? [...new Set(delivery_notes.map((n) => String(n).trim()).filter(Boolean))]
      : [];
    if (notes.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one Delivery Note is required' });
    }
    if (start_station && !STATION_KEYS.includes(start_station)) {
      return res.status(400).json({ success: false, message: 'Invalid station' });
    }

    await client.query('BEGIN');

    const dateStr = todayDate();
    const yymmdd = dateStr.slice(2).replace(/-/g, '');
    // Serialize creation per day so two people creating at the same moment can't both read the
    // same max and collide on the running number. Old region batches (region_code set) number
    // separately and never share a batch_no with these.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`pet_batch:${dateStr}`]);
    const maxRes = await client.query(
      `SELECT COALESCE(MAX(running_number), 0)::int AS n
       FROM pet_batches WHERE batch_date = $1::date AND region_code IS NULL`,
      [dateStr],
    );
    const runningNumber = maxRes.rows[0].n + 1;
    const batchNo = `GPET/${yymmdd}/${String(runningNumber).padStart(2, '0')}`;

    const batchRes = await client.query(
      `INSERT INTO pet_batches (batch_no, region, region_code, batch_date, running_number, "createdBy")
       VALUES ($1, NULL, NULL, $2, $3, $4) RETURNING *`,
      [batchNo, dateStr, runningNumber, actorName(req)],
    );
    const batch = batchRes.rows[0];

    for (const dn of notes) {
      await client.query(
        `INSERT INTO pet_batch_delivery_notes (batch_id, delivery_note) VALUES ($1,$2)`,
        [batch.id, dn],
      );
    }

    let session = null;
    if (start_station) {
      const sessionRes = await client.query(
        `INSERT INTO pet_batch_station_sessions (batch_id, station_key, "startedBy")
         VALUES ($1,$2,$3) RETURNING *`,
        [batch.id, start_station, actorName(req)],
      );
      session = sessionRes.rows[0];
    }

    await client.query('COMMIT');
    res.status(201).json({
      success: true,
      data: { ...batch, delivery_notes: notes, dn_count: notes.length, session },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') {
      return res.status(409).json({ success: false, message: 'Batch number collision — try again' });
    }
    console.error('PET batch create error:', err.message);
    res.status(500).json({ success: false, message: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Batches to pick at a station, newest first. Stopped batches stay in the list — a batch is often
// processed in parts, so starting it again simply opens a new session. Each row carries its state
// at this station: running (by whom, since when), last stop time, and how many sessions it has had.
router.get('/selectable', async (req, res) => {
  try {
    const station = String(req.query.station || '');
    if (!STATION_KEYS.includes(station)) {
      return res.status(400).json({ success: false, message: 'Invalid station' });
    }
    const search = String(req.query.search || '').trim();
    const params = [station];
    let where = '';
    if (search) {
      params.push(`%${search}%`);
      where = `WHERE b.batch_no ILIKE $2 OR b.region ILIKE $2
               OR EXISTS (SELECT 1 FROM pet_batch_delivery_notes d WHERE d.batch_id = b.id AND d.delivery_note ILIKE $2)`;
    }
    const r = await pool.query(
      `SELECT b.*, run."startedBy" AS running_by, run.started_at AS running_since,
              hist.last_stopped_at, hist.session_count,
              (SELECT COUNT(*)::int FROM pet_batch_delivery_notes d WHERE d.batch_id = b.id) AS dn_count
       FROM pet_batches b
       LEFT JOIN LATERAL (
         SELECT s."startedBy", s.started_at FROM pet_batch_station_sessions s
         WHERE s.batch_id = b.id AND s.station_key = $1 AND s.ended_at IS NULL
         ORDER BY s.started_at DESC LIMIT 1
       ) run ON TRUE
       CROSS JOIN LATERAL (
         SELECT MAX(s.ended_at) AS last_stopped_at, COUNT(*)::int AS session_count
         FROM pet_batch_station_sessions s
         WHERE s.batch_id = b.id AND s.station_key = $1
       ) hist
       ${where}
       ORDER BY b."createdAt" DESC, b.id DESC
       LIMIT 100`,
      params,
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error('PET batch selectable error:', err.message);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Recent batches for PPIC, newest first: their Delivery Notes and which stations run them now.
// Search matches the batch number or any of its Delivery Notes.
router.get('/recent', async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    const params = [];
    let where = '';
    if (search) {
      params.push(`%${search}%`);
      where = `WHERE b.batch_no ILIKE $1
               OR EXISTS (SELECT 1 FROM pet_batch_delivery_notes d WHERE d.batch_id = b.id AND d.delivery_note ILIKE $1)`;
    }
    const r = await pool.query(
      `SELECT b.id, b.batch_no, b.region, to_char(b.batch_date, 'YYYY-MM-DD') AS batch_date,
              b."createdBy", b."createdAt",
              COALESCE((SELECT array_agg(d.delivery_note ORDER BY d.id)
                          FROM pet_batch_delivery_notes d WHERE d.batch_id = b.id), '{}') AS delivery_notes,
              COALESCE((SELECT array_agg(DISTINCT s.station_key)
                          FROM pet_batch_station_sessions s
                         WHERE s.batch_id = b.id AND s.ended_at IS NULL), '{}') AS running_stations
       FROM pet_batches b
       ${where}
       ORDER BY b."createdAt" DESC, b.id DESC
       LIMIT 50`,
      params,
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error('PET batch recent error:', err.message);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// The current user's running (started, not ended) session at a station — lets the UI restore
// the "currently running" banner + timer after an app reload without losing track of it.
router.get('/mine/running', async (req, res) => {
  try {
    const station = String(req.query.station || '');
    if (!STATION_KEYS.includes(station)) {
      return res.status(400).json({ success: false, message: 'Invalid station' });
    }
    const r = await pool.query(
      `SELECT s.*, b.batch_no, b.region, b.region_code,
              (SELECT COUNT(*)::int FROM pet_batch_delivery_notes d WHERE d.batch_id = b.id) AS dn_count
       FROM pet_batch_station_sessions s
       JOIN pet_batches b ON b.id = s.batch_id
       WHERE s.station_key = $1 AND s.ended_at IS NULL AND s."startedBy" = $2
       ORDER BY s.started_at DESC
       LIMIT 1`,
      [station, actorName(req)],
    );
    res.json({ success: true, data: r.rows[0] || null });
  } catch (err) {
    console.error('PET batch running error:', err.message);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Start a session at a station for an existing batch (Washing / Flakes Sorting / Extrusion).
router.post('/:id/start', async (req, res) => {
  try {
    const station = String(req.body.station || '');
    if (!STATION_KEYS.includes(station)) {
      return res.status(400).json({ success: false, message: 'Invalid station' });
    }
    const batch = await pool.query('SELECT id, batch_no FROM pet_batches WHERE id = $1', [req.params.id]);
    if (batch.rows.length === 0) return res.status(404).json({ success: false, message: 'Batch not found' });

    const existing = await pool.query(
      `SELECT * FROM pet_batch_station_sessions WHERE batch_id = $1 AND station_key = $2 AND ended_at IS NULL`,
      [req.params.id, station],
    );
    if (existing.rows.length > 0) {
      return res.json({ success: true, data: existing.rows[0] }); // already running — resume
    }
    const r = await pool.query(
      `INSERT INTO pet_batch_station_sessions (batch_id, station_key, "startedBy")
       VALUES ($1,$2,$3) RETURNING *`,
      [req.params.id, station, actorName(req)],
    );
    res.status(201).json({ success: true, data: r.rows[0] });
  } catch (err) {
    console.error('PET batch start error:', err.message);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// End the current station's session for a batch.
router.post('/:id/end', async (req, res) => {
  try {
    const station = String(req.body.station || '');
    if (!STATION_KEYS.includes(station)) {
      return res.status(400).json({ success: false, message: 'Invalid station' });
    }
    const r = await pool.query(
      `UPDATE pet_batch_station_sessions
       SET ended_at = NOW(), "endedBy" = $3
       WHERE batch_id = $1 AND station_key = $2 AND ended_at IS NULL
       RETURNING *`,
      [req.params.id, station, actorName(req)],
    );
    if (r.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'No running session found for this station' });
    }
    res.json({ success: true, data: r.rows[0] });
  } catch (err) {
    console.error('PET batch end error:', err.message);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Bag rows for traceability views — station/material/operator names resolved for display.
const BAG_SELECT = `
  SELECT pl.id, pl.output_bag_qr, pl.input_bag_qr, pl.weight, pl.status, pl.sub_line,
         pl.used_line, pl.used_datetime, pl.pet_batch_no, pl.remark, pl.created_at,
         s.name AS station_name, mt.name AS material_type_name, u.name AS operator_name
  FROM production_logs pl
  LEFT JOIN stations s ON s.id = pl.station_id
  LEFT JOIN operator_shifts os ON os.id = pl.shift_id
  LEFT JOIN users u ON u.id = os.user_id
  LEFT JOIN material_types mt ON mt.id = COALESCE(pl.material_type_id, os.material_type_id)
`;

// Shared by /:id and /trace — sessions timeline, delivery notes, and the raw_material rows they
// trace back to (joined by delivery note number — raw_material itself is never modified), plus
// every bag logged under this batch.
async function fetchBatchDetail(batchId) {
  const batch = await pool.query('SELECT * FROM pet_batches WHERE id = $1', [batchId]);
  if (batch.rows.length === 0) return null;

  const dns = await pool.query(
    'SELECT delivery_note FROM pet_batch_delivery_notes WHERE batch_id = $1 ORDER BY id',
    [batchId],
  );
  const sessions = await pool.query(
    'SELECT * FROM pet_batch_station_sessions WHERE batch_id = $1 ORDER BY started_at ASC',
    [batchId],
  );
  const deliveryNotes = dns.rows.map((r) => r.delivery_note);
  let rawMaterial = [];
  if (deliveryNotes.length > 0) {
    const rm = await pool.query(
      `SELECT * FROM raw_material WHERE "deliveryNote" = ANY($1::text[])`,
      [deliveryNotes],
    );
    rawMaterial = rm.rows;
  }
  const bagsRes = await pool.query(
    `${BAG_SELECT} WHERE pl.pet_batch_no = $1 ORDER BY pl.created_at ASC`,
    [batch.rows[0].batch_no],
  );

  return {
    ...batch.rows[0],
    delivery_notes: deliveryNotes,
    sessions: sessions.rows,
    raw_material: rawMaterial,
    bags: bagsRes.rows,
  };
}

// Delivery-note picker for starting a batch — read-only search of PET gate entries in
// raw_material. `used_in_batches` flags DNs already linked to a batch (a truckload can span
// batches, so it's a hint, not a block).
router.get('/delivery-notes', async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    const params = [];
    let where = `WHERE rm."deliveryNote" IS NOT NULL AND TRIM(rm."deliveryNote") <> ''
                   AND UPPER(TRIM(rm."materialType")) = 'PET'`;
    if (search) {
      params.push(`%${search}%`);
      where += ` AND rm."deliveryNote" ILIKE $${params.length}`;
    }
    const r = await pool.query(
      `SELECT rm.id, rm."deliveryNote", rm."netWeight", rm.supplier, rm."truckId", rm.entrydate,
              rm.region, rm.quantity,
              (SELECT string_agg(b.batch_no, ', ' ORDER BY b.id)
                 FROM pet_batch_delivery_notes d JOIN pet_batches b ON b.id = d.batch_id
                WHERE d.delivery_note = rm."deliveryNote") AS used_in_batches
       FROM raw_material rm
       ${where}
       ORDER BY rm.entrydate DESC NULLS LAST, rm.id DESC
       LIMIT 30`,
      params,
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error('PET delivery-notes search error:', err.message);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Traceability for a scanned code — either a batch number (GPET/...) or a jumbo-bag QR.
// For a bag: walks input_bag_qr upstream (e.g. Extrusion ← Flakes Sorting ← Washing ← Crushing),
// lists bags that consumed it downstream (its current state), and resolves the batch from the
// bag itself or its nearest tagged ancestor — so bags from stations without a batch session
// (e.g. Final Packing) still trace back to their region and raw material.
router.get('/trace', async (req, res) => {
  try {
    const code = String(req.query.code || '').trim();
    if (!code) return res.status(400).json({ success: false, message: 'code is required' });

    if (/^GPET\//i.test(code)) {
      const b = await pool.query('SELECT id FROM pet_batches WHERE UPPER(batch_no) = UPPER($1)', [code]);
      if (b.rows.length === 0) return res.status(404).json({ success: false, message: 'Batch not found' });
      const batch = await fetchBatchDetail(b.rows[0].id);
      return res.json({ success: true, data: { type: 'batch', code, bag: null, lineage: [], downstream: [], batch } });
    }

    const bagRes = await pool.query(`${BAG_SELECT} WHERE pl.output_bag_qr = $1 ORDER BY pl.id DESC LIMIT 1`, [code]);
    if (bagRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'No bag found for this QR code' });
    }
    const bag = bagRes.rows[0];

    const lineage = [];
    const seen = new Set([bag.output_bag_qr]);
    let parentQr = bag.input_bag_qr;
    while (parentQr && lineage.length < 10 && !seen.has(parentQr)) {
      seen.add(parentQr);
      const p = await pool.query(`${BAG_SELECT} WHERE pl.output_bag_qr = $1 ORDER BY pl.id DESC LIMIT 1`, [parentQr]);
      if (p.rows.length === 0) break;
      lineage.push(p.rows[0]);
      parentQr = p.rows[0].input_bag_qr;
    }

    const down = await pool.query(
      `${BAG_SELECT} WHERE pl.input_bag_qr = $1 ORDER BY pl.created_at ASC`,
      [bag.output_bag_qr],
    );

    const batchNo = [bag, ...lineage].map((x) => x.pet_batch_no).find(Boolean) || null;
    let batch = null;
    if (batchNo) {
      const b = await pool.query('SELECT id FROM pet_batches WHERE batch_no = $1', [batchNo]);
      if (b.rows.length > 0) batch = await fetchBatchDetail(b.rows[0].id);
    }

    res.json({
      success: true,
      data: {
        type: 'bag',
        code,
        bag,
        lineage,
        downstream: down.rows,
        batch,
        message: batch
          ? undefined
          : 'This bag was produced before batch tracking started (or outside an active batch), so it has no batch.',
      },
    });
  } catch (err) {
    console.error('PET trace error:', err.message);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// PPIC traceability export (read-only): batches whose batch date falls in the range (optionally one
// region) with their delivery notes, the raw_material rows behind them, every station session, and
// every bag in the trace — bags tagged with the batch plus untagged downstream bags (e.g. Final
// Packing) that consumed them, each with its input bag's own batch so mismatches can be flagged.
const EXPORT_ROLES = ['ppic', 'super_admin', 'admin'];
const EXPORT_MAX_BATCHES = 1000;

router.get('/export', async (req, res) => {
  if (!EXPORT_ROLES.includes(String(req.user?.role || '').toLowerCase())) {
    return res.status(403).json({ success: false, message: 'Only PPIC can export traceability' });
  }
  const dateStart = String(req.query.date_start || '');
  const dateEnd = String(req.query.date_end || '');
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!isDate(dateStart) || !isDate(dateEnd) || dateStart > dateEnd) {
    return res.status(400).json({ success: false, message: 'Valid date_start and date_end (YYYY-MM-DD) are required' });
  }
  const region = String(req.query.region || '').trim();
  if (region && !REGION_CODES[region]) {
    return res.status(400).json({ success: false, message: 'Invalid region' });
  }
  try {
    const params = [dateStart, dateEnd];
    if (region) params.push(region);
    const batchRes = await pool.query(
      `SELECT b.id, b.batch_no, b.region, b.region_code, to_char(b.batch_date, 'YYYY-MM-DD') AS batch_date,
              b.running_number, b."createdBy", b."createdAt"
       FROM pet_batches b
       WHERE b.batch_date BETWEEN $1::date AND $2::date ${region ? 'AND b.region = $3' : ''}
       ORDER BY b."createdAt" DESC, b.id DESC
       LIMIT ${EXPORT_MAX_BATCHES + 1}`,
      params,
    );
    const truncated = batchRes.rows.length > EXPORT_MAX_BATCHES;
    const batches = batchRes.rows.slice(0, EXPORT_MAX_BATCHES);
    if (batches.length === 0) {
      return res.json({
        success: true,
        data: { batches: [], delivery_notes: [], raw_material: [], sessions: [], bags: [], truncated: false },
      });
    }
    const ids = batches.map((b) => b.id);

    const dnRes = await pool.query(
      `SELECT d.batch_id, d.delivery_note,
              (SELECT string_agg(b2.batch_no, ', ' ORDER BY b2.id)
                 FROM pet_batch_delivery_notes d2 JOIN pet_batches b2 ON b2.id = d2.batch_id
                WHERE d2.delivery_note = d.delivery_note AND d2.batch_id <> d.batch_id) AS other_batches
       FROM pet_batch_delivery_notes d
       WHERE d.batch_id = ANY($1::int[])
       ORDER BY d.batch_id, d.id`,
      [ids],
    );
    const dnList = [...new Set(dnRes.rows.map((r) => r.delivery_note))];
    const rmRes = dnList.length
      ? await pool.query(
          `SELECT id, "deliveryNote", "truckId", supplier, plant, "materialType", region,
                  to_char(entrydate, 'YYYY-MM-DD') AS entrydate, entrytime, "netWeight"
           FROM raw_material
           WHERE "deliveryNote" = ANY($1::text[])
           ORDER BY entrydate, id`,
          [dnList],
        )
      : { rows: [] };

    const sessRes = await pool.query(
      `SELECT batch_id, station_key, started_at, "startedBy", ended_at, "endedBy"
       FROM pet_batch_station_sessions
       WHERE batch_id = ANY($1::int[])
       ORDER BY batch_id, started_at`,
      [ids],
    );

    // Tagged bags (depth 0), then untagged bags that consumed them, level by level. A tagged child
    // isn't followed — it belongs to its own batch. Depth/path guards stop cycles in bad data.
    const bagsRes = await pool.query(
      `WITH RECURSIVE tree AS (
         SELECT pl.id, pl.output_bag_qr, pl.pet_batch_no AS trace_batch_no, FALSE AS inherited, 0 AS depth,
                ARRAY[pl.output_bag_qr::text] AS path
         FROM production_logs pl
         WHERE pl.pet_batch_no = ANY($1::text[])
         UNION ALL
         SELECT c.id, c.output_bag_qr, t.trace_batch_no, TRUE, t.depth + 1, t.path || c.output_bag_qr::text
         FROM tree t
         JOIN production_logs c ON c.input_bag_qr = t.output_bag_qr
         WHERE c.pet_batch_no IS NULL AND t.depth < 10
           AND c.output_bag_qr IS NOT NULL AND NOT (c.output_bag_qr = ANY(t.path))
       )
       SELECT DISTINCT ON (pl.id)
              pl.id, tree.trace_batch_no, tree.inherited, pl.output_bag_qr, pl.input_bag_qr, pl.weight,
              pl.status, pl.sub_line, pl.used_line, pl.used_datetime, pl.pet_batch_no, pl.remark,
              pl.created_at, s.name AS station_name, s.code AS station_code, st.name AS shift_name,
              u.name AS operator_name, ib.found AS input_bag_found, ib.pet_batch_no AS input_bag_batch_no
       FROM tree
       JOIN production_logs pl ON pl.id = tree.id
       LEFT JOIN stations s ON s.id = pl.station_id
       LEFT JOIN operator_shifts os ON os.id = pl.shift_id
       LEFT JOIN shift_types st ON st.id = os.shift_type_id
       LEFT JOIN users u ON u.id = os.user_id
       LEFT JOIN LATERAL (
         SELECT TRUE AS found, p.pet_batch_no FROM production_logs p
         WHERE p.output_bag_qr = pl.input_bag_qr
         ORDER BY p.id DESC LIMIT 1
       ) ib ON TRUE
       ORDER BY pl.id, tree.depth`,
      [batches.map((b) => b.batch_no)],
    );

    res.json({
      success: true,
      data: {
        batches,
        delivery_notes: dnRes.rows,
        raw_material: rmRes.rows,
        sessions: sessRes.rows,
        bags: bagsRes.rows,
        truncated,
      },
    });
  } catch (err) {
    console.error('PET trace export error:', err.message);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Full batch detail. Numeric guard keeps stray paths from being parsed as an id.
router.get('/:id', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) {
    return res.status(404).json({ success: false, message: 'Route not found' });
  }
  try {
    const data = await fetchBatchDetail(req.params.id);
    if (!data) return res.status(404).json({ success: false, message: 'Batch not found' });
    res.json({ success: true, data });
  } catch (err) {
    console.error('PET batch detail error:', err.message);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;
