const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

/**
 * PET raw-material Batch traceability. A Batch (region + delivery notes) is created once at
 * Crushing, then each of the 4 PET stations starts/ends its own session against it. Wraps the
 * existing jumbo-bag QR/weight workflow — doesn't replace it.
 */
const ALLOWED_ROLES = ['pet', 'ppic', 'super_admin', 'admin'];
const STATION_KEYS = ['crushing', 'washing', 'flakes_sorting', 'extrusion'];

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

// Create a new Batch (Crushing start): region + delivery note(s) → GPET/YYMMDD/REGIONCODE/##
// Running number resets daily, per region.
router.post('/', async (req, res) => {
  const client = await pool.connect();
  try {
    const { region, delivery_notes } = req.body;
    const regionCode = REGION_CODES[region];
    if (!regionCode) {
      return res.status(400).json({ success: false, message: 'Invalid region' });
    }
    const notes = Array.isArray(delivery_notes)
      ? [...new Set(delivery_notes.map((n) => String(n).trim()).filter(Boolean))]
      : [];
    if (notes.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one Delivery Note is required' });
    }

    await client.query('BEGIN');

    const dateStr = todayDate();
    const yymmdd = dateStr.slice(2).replace(/-/g, '');
    // Serialize batch creation per day+region so two operators starting at the same moment
    // can't both read the same max and collide on the running number.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`pet_batch:${dateStr}:${regionCode}`]);
    const maxRes = await client.query(
      `SELECT COALESCE(MAX(running_number), 0)::int AS n FROM pet_batches WHERE batch_date = $1::date AND region_code = $2`,
      [dateStr, regionCode],
    );
    const runningNumber = maxRes.rows[0].n + 1;
    const batchNo = `GPET/${yymmdd}/${regionCode}/${String(runningNumber).padStart(2, '0')}`;

    const batchRes = await client.query(
      `INSERT INTO pet_batches (batch_no, region, region_code, batch_date, running_number, "createdBy")
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [batchNo, region, regionCode, dateStr, runningNumber, actorName(req)],
    );
    const batch = batchRes.rows[0];

    for (const dn of notes) {
      await client.query(
        `INSERT INTO pet_batch_delivery_notes (batch_id, delivery_note) VALUES ($1,$2)`,
        [batch.id, dn],
      );
    }

    // Auto-start the Crushing session — this is the entry point for a new batch.
    const sessionRes = await client.query(
      `INSERT INTO pet_batch_station_sessions (batch_id, station_key, "startedBy")
       VALUES ($1,'crushing',$2) RETURNING *`,
      [batch.id, actorName(req)],
    );

    await client.query('COMMIT');
    res.status(201).json({
      success: true,
      data: { ...batch, delivery_notes: notes, session: sessionRes.rows[0] },
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

// Batches eligible to start at a given station — i.e. no ENDED session there yet
// (includes ones never started at this station, and ones with a currently-running session there).
router.get('/selectable', async (req, res) => {
  try {
    const station = String(req.query.station || '');
    if (!STATION_KEYS.includes(station)) {
      return res.status(400).json({ success: false, message: 'Invalid station' });
    }
    const r = await pool.query(
      `SELECT b.*
       FROM pet_batches b
       WHERE NOT EXISTS (
         SELECT 1 FROM pet_batch_station_sessions s
         WHERE s.batch_id = b.id AND s.station_key = $1 AND s.ended_at IS NOT NULL
       )
       ORDER BY b."createdAt" DESC
       LIMIT 50`,
      [station],
    );
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error('PET batch selectable error:', err.message);
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
      `SELECT s.*, b.batch_no, b.region, b.region_code
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
          : 'This bag was produced before batch tracking started (or outside an active batch), so it has no batch/region.',
      },
    });
  } catch (err) {
    console.error('PET trace error:', err.message);
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
