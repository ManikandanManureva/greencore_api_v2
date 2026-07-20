const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

/**
 * PET bag QR segment codes by process (not raw DB station code).
 * Boretech = sieving/sorting flakes (BRT). Starlinger = extrusion/pelletizing (EXT).
 */
function resolveQrStationCodes(stationCode, stationName, subLine) {
  let finalStationCode = stationCode || 'UNK';
  let stationDisplayName = stationName || '';

  if (subLine === 'Flakes PET') {
    return { finalStationCode: 'BRT', stationDisplayName: 'Boretech' };
  }
  if (subLine === 'Pellet PET') {
    return { finalStationCode: 'EXT', stationDisplayName: 'Starlinger' };
  }
  if (subLine === 'Final PET') {
    return {
      finalStationCode: 'FPK',
      stationDisplayName: stationName || 'Final Packing',
    };
  }

  const code = String(stationCode || '').toUpperCase();
  const nameLower = String(stationName || '').toLowerCase();

  if (code === 'CRS' && subLine) {
    if (subLine === '3E') {
      finalStationCode = 'C3E';
      stationDisplayName = `${stationName}-3E`;
    } else if (subLine === 'Rapid') {
      finalStationCode = 'CRP';
      stationDisplayName = `${stationName}-Rapid`;
    } else if (subLine === 'Betty') {
      finalStationCode = 'CBT';
      stationDisplayName = `${stationName}-Betty`;
    } else if (subLine === 'FPS') {
      finalStationCode = 'FPS';
      stationDisplayName = 'Crusher-Washing-Flakes PE Super';
    } else if (subLine === 'FP1') {
      finalStationCode = 'FP1';
      stationDisplayName = 'Crusher-Washing-Flakes PE 1';
    } else if (subLine === 'FES') {
      finalStationCode = 'FES';
      stationDisplayName = 'Crusher-Washing-Flakes EVA Super';
    } else if (subLine === 'FE1') {
      finalStationCode = 'FE1';
      stationDisplayName = 'Crusher-Washing-Flakes EVA 1';
    } else {
      finalStationCode = 'CRP';
      stationDisplayName = `${stationName}-${subLine}`;
    }
  } else if (code === 'WSH' && subLine) {
    if (subLine === 'Washing 1') {
      finalStationCode = 'W1';
      stationDisplayName = `${stationName}-W1`;
    } else if (subLine === 'Washing 2') {
      finalStationCode = 'W2';
      stationDisplayName = `${stationName}-W2`;
    } else if (subLine === 'Washing 3') {
      finalStationCode = 'W3';
      stationDisplayName = `${stationName}-W3`;
    }
  } else if (
    (code === 'EXT' ||
      code === 'EXTR' ||
      nameLower.includes('extrusion') ||
      nameLower.includes('boretech')) &&
    subLine
  ) {
    if (subLine === 'Extrusion 1') {
      finalStationCode = 'E1';
      stationDisplayName = `${stationName}-E1`;
    } else if (subLine === 'Extrusion 2') {
      finalStationCode = 'E2';
      stationDisplayName = `${stationName}-E2`;
    } else if (subLine === 'Extrusion 3') {
      finalStationCode = 'E3';
      stationDisplayName = `${stationName}-E3`;
    } else if (subLine === 'Mixture') {
      finalStationCode = 'MIX';
      stationDisplayName = `${stationName}-MIX`;
    } else if (subLine === 'PPS') {
      finalStationCode = 'PPS';
      stationDisplayName = 'Extruder-Pellet PE Super';
    } else if (subLine === 'PP1') {
      finalStationCode = 'PP1';
      stationDisplayName = 'Extruder-Pellet PE 1';
    } else if (subLine === 'PES') {
      finalStationCode = 'PES';
      stationDisplayName = 'Extruder-Pellet EVA Super';
    } else if (subLine === 'PV1') {
      finalStationCode = 'PV1';
      stationDisplayName = 'Extruder-Pellet EVA 1';
    }
  } else if (code === 'PKG' && subLine) {
    if (subLine === 'Pellet PET') {
      finalStationCode = 'EXT';
      stationDisplayName = 'Starlinger';
    } else if (subLine === 'Final PET') {
      finalStationCode = 'FPK';
      stationDisplayName = stationName || 'Final Packing';
    }
  } else if (nameLower.includes('starlinger') && subLine === 'Pellet PET') {
    finalStationCode = 'EXT';
    stationDisplayName = 'Starlinger';
  }

  return { finalStationCode, stationDisplayName };
}

/** Append sub_line filter for PET when counting bag numbers (independent sequences per process). */
function appendPetSubLineCountFilter(countSql, countParams, subLine) {
  if (subLine === 'Pellet PET' || subLine === 'Final PET' || subLine === 'Flakes PET') {
    countParams.push(subLine);
    return `${countSql} AND sub_line = $${countParams.length}`;
  }
  return countSql;
}

/** Station buckets for dashboard / closed-shift reports (includes PET line). */
function createEmptyByStation() {
  return {
    crusher: { outputs: 0, weight: '0.0' },
    washing: { outputs: 0, weight: '0.0' },
    extrusion: { outputs: 0, weight: '0.0' },
    boretech: { outputs: 0, weight: '0.0' },
    starlinger: { outputs: 0, weight: '0.0' },
    final_packing: { outputs: 0, weight: '0.0' },
    pellet_packing: { outputs: 0, weight: '0.0' },
  };
}

function sumByStationTotals(byStation) {
  let totalOutputs = 0;
  let totalWeight = 0;
  for (const st of Object.values(byStation)) {
    totalOutputs += st.outputs;
    totalWeight += Number(st.weight) || 0;
  }
  return { totalOutputs, totalWeight: totalWeight.toFixed(1) };
}

/**
 * Map a production log row to a dashboard station key.
 * PET: Boretech (BRT), Starlinger (EXT), Final Packing — not lumped into generic extrusion.
 */
function classifyDashboardStation(stationName, stationCode, subLine, materialTypeName) {
  const n = (stationName || '').toLowerCase();
  const c = (stationCode || '').toUpperCase();
  const mat = String(materialTypeName || '').trim().toUpperCase();
  const sl = String(subLine || '').trim();

  if (c === 'PLT' || n.includes('pellet pack')) return 'pellet_packing';

  if (sl === 'Flakes PET') return 'boretech';
  if (sl === 'Pellet PET') return 'starlinger';
  if (sl === 'Final PET') return 'final_packing';

  if (n.includes('boretech')) return 'boretech';
  if (n.includes('starlinger') || (n.includes('re-pack') && mat === 'PET')) return 'starlinger';
  if (n.includes('final') && (n.includes('pack') || n.includes('packaging'))) return 'final_packing';
  if (c === 'STL') return 'starlinger';

  if (c === 'CRS' || n.includes('crusher')) return 'crusher';
  if (c === 'WSH' || n.includes('washing')) return 'washing';

  if (c === 'EXT' || c === 'EXTR' || n.includes('extrusion')) {
    if (mat === 'PET' && (n.includes('packaging') || n.includes('boretech'))) return 'boretech';
    return 'extrusion';
  }

  if (c === 'PKG') return 'final_packing';

  return null;
}

function applyAggRowsToByStation(byStation, aggRows, materialTypeName) {
  for (const sr of aggRows) {
    const key = classifyDashboardStation(sr.name, sr.code, sr.sub_line, materialTypeName);
    if (!key || !byStation[key]) continue;
    byStation[key].outputs += parseInt(sr.cnt, 10) || 0;
    byStation[key].weight = String(
      (Number(byStation[key].weight) + Number(sr.tot || 0)).toFixed(1),
    );
  }
}

// 2. Get all shift types
router.get('/shifts', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM shift_types ORDER BY id');
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Error fetching shifts:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// 3. Get all material types
router.get('/materials', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM material_types WHERE is_active = true ORDER BY id');
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Error fetching material types:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// 4. Get all active stations for the user's material flow (Role)
router.get('/stations', authenticateToken, async (req, res) => {
  const isPpic = (req.user.role || '').toLowerCase() === 'ppic';
  // PPIC must see every line (PC, PE, PET) when viewing reports / overview
  const materialTypeId = isPpic ? null : req.user.materialTypeId;

  try {
    let rows;
    if (materialTypeId) {
      // Get stations mapped to this user's material flow
      const result = await pool.query(
        `SELECT s.* FROM stations s
         JOIN material_flow_stations mfs ON s.id = mfs.station_id
         WHERE mfs.material_type_id = $1 AND s.is_active = true
         ORDER BY s.order_index`,
        [materialTypeId]
      );
      rows = result.rows;

      // Legacy DBs: PE flow was seeded without EXT — append Extrusion so operators see the full line
      const mt = await pool.query('SELECT name FROM material_types WHERE id = $1', [materialTypeId]);
      if (mt.rows[0]?.name === 'PE') {
        const hasExtrusion = rows.some((s) => {
          const c = String(s.code || '').toUpperCase();
          const n = (s.name || '').toLowerCase();
          return (
            c === 'EXT' ||
            c === 'EXTR' ||
            n.includes('extrusion') ||
            n.includes('extruder') ||
            n.includes('boretech')
          );
        });
        if (!hasExtrusion) {
          const extRes = await pool.query(
            `SELECT * FROM stations WHERE is_active = true
             AND (
               UPPER(COALESCE(code, '')) IN ('EXT', 'EXTR')
               OR LOWER(COALESCE(name, '')) LIKE '%extrusion%'
               OR LOWER(COALESCE(name, '')) LIKE '%extruder%'
             )
             ORDER BY order_index NULLS LAST, id
             LIMIT 1`
          );
          const extRow = extRes.rows[0];
          if (extRow && !rows.some((r) => r.id === extRow.id)) {
            rows = [...rows, extRow].sort(
              (a, b) => (a.order_index ?? 0) - (b.order_index ?? 0) || a.id - b.id
            );
          }
        }
      }
    } else {
      // Fallback to all active stations
      const result = await pool.query(
        'SELECT * FROM stations WHERE is_active = true ORDER BY order_index'
      );
      rows = result.rows;
    }
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('Error fetching stations:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// 5. Start a shift session
router.post('/start-shift', authenticateToken, async (req, res) => {
  // Support both { shiftTypeId } and { lineId } (frontend may send selectedShift.id as lineId only)
  const shiftTypeId = req.body.shiftTypeId ?? req.body.lineId;
  const userId = req.user.id;
  const materialTypeId = req.user.materialTypeId;

  if (!materialTypeId) {
    return res.status(400).json({
      success: false,
      message: 'User does not have an assigned material role (PC, PE, PET). Please contact administrator.'
    });
  }

  if (shiftTypeId == null || shiftTypeId === '') {
    return res.status(400).json({ success: false, message: 'shiftTypeId or lineId is required' });
  }

  try {
    // Check if there's already an active shift for this user
    const activeShift = await pool.query(
      'SELECT id FROM operator_shifts WHERE user_id = $1 AND is_active = true',
      [userId]
    );

    if (activeShift.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'You already have an active shift session',
        shiftId: activeShift.rows[0].id
      });
    }

    const result = await pool.query(
      `INSERT INTO operator_shifts (user_id, shift_type_id, material_type_id, is_active)
       VALUES ($1, $2, $3, true)
       RETURNING *`,
      [userId, Number(shiftTypeId), materialTypeId]
    );

    res.json({ success: true, message: 'Shift started successfully', data: result.rows[0] });
  } catch (error) {
    console.error('Error starting shift:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// 6. Get active shift for a user/shift combo
router.get('/active-shift', authenticateToken, async (req, res) => {
  const { shiftTypeId } = req.query;
  const userId = req.user.id;

  try {
    let query = `SELECT os.*, st.name AS shift_type_name
      FROM operator_shifts os
      LEFT JOIN shift_types st ON st.id = os.shift_type_id
      WHERE os.user_id = $1 AND os.is_active = true`;
    const params = [userId];

    if (shiftTypeId) {
      params.push(Number(shiftTypeId));
      query += ` AND os.shift_type_id = $${params.length}`;
    }

    query += ' ORDER BY os.start_time DESC LIMIT 1';

    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      return res.json({ success: true, data: null });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error fetching active shift:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// 7a. Get the most recent shift (active or closed) for the logged-in user — today only
router.get('/latest-shift', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const result = await pool.query(
      `SELECT id, is_active, start_time, end_time, shift_type_id, user_id
       FROM operator_shifts
       WHERE user_id = $1
         AND start_time::date = CURRENT_DATE
       ORDER BY start_time DESC
       LIMIT 1`,
      [userId]
    );
    if (result.rows.length === 0) {
      return res.json({ success: true, data: null });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error fetching latest shift:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// 7. Check shift status
router.get('/shift-status/:shiftId', authenticateToken, async (req, res) => {
  const { shiftId } = req.params;

  try {
    const result = await pool.query(
      `SELECT id, is_active, start_time, end_time, user_id 
       FROM operator_shifts 
       WHERE id = $1`,
      [shiftId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Shift not found' });
    }

    const shift = result.rows[0];
    res.json({
      success: true,
      data: {
        ...shift,
        status: shift.is_active ? 'active' : 'ended'
      }
    });
  } catch (error) {
    console.error('Error checking shift status:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// 7. End a shift session
router.post('/end-shift/:shiftId', authenticateToken, async (req, res) => {
  const { shiftId } = req.params;
  const { remark } = req.body || {};
  const userId = req.user.id;

  console.log(`Attempting to end shift ${shiftId} for user ${userId}`);

  try {
    // First check if the shift exists and is active
    const checkResult = await pool.query(
      `SELECT id, is_active, user_id FROM operator_shifts 
       WHERE id = $1 AND user_id = $2`,
      [shiftId, userId]
    );

    if (checkResult.rows.length === 0) {
      console.log(`Shift ${shiftId} not found for user ${userId}`);
      return res.status(404).json({ success: false, message: 'Shift not found' });
    }

    const shift = checkResult.rows[0];
    if (!shift.is_active) {
      const ended = await pool.query(
        `SELECT * FROM operator_shifts WHERE id = $1 AND user_id = $2`,
        [shiftId, userId]
      );
      console.log(`Shift ${shiftId} already ended — idempotent OK`);
      return res.json({
        success: true,
        message: 'Shift already ended',
        alreadyEnded: true,
        data: ended.rows[0] || shift,
      });
    }

    const remarkVal =
      remark && String(remark).trim() ? String(remark).trim() : null;

    // Now end the shift (save optional end_remark)
    const result = await pool.query(
      `UPDATE operator_shifts 
       SET is_active = false, end_time = CURRENT_TIMESTAMP, end_remark = COALESCE($1, end_remark)
       WHERE id = $2 AND user_id = $3 AND is_active = true
       RETURNING *`,
      [remarkVal, shiftId, userId]
    );

    if (result.rows.length === 0) {
      const recheck = await pool.query(
        `SELECT id, is_active FROM operator_shifts WHERE id = $1 AND user_id = $2`,
        [shiftId, userId]
      );
      if (recheck.rows[0] && !recheck.rows[0].is_active) {
        const ended = await pool.query(
          `SELECT * FROM operator_shifts WHERE id = $1`,
          [shiftId]
        );
        return res.json({
          success: true,
          message: 'Shift already ended',
          alreadyEnded: true,
          data: ended.rows[0],
        });
      }
      console.log(`Failed to end shift ${shiftId} - no rows updated`);
      return res.status(404).json({ success: false, message: 'Active shift not found' });
    }

    res.json({ success: true, message: 'Shift ended successfully', data: result.rows[0] });
  } catch (error) {
    console.error('Error ending shift:', error);
    const isProd = process.env.NODE_ENV === 'production';
    res.status(500).json({
      success: false,
      message: isProd ? 'Internal server error' : (error.message || 'Internal server error'),
      ...(isProd ? {} : { error: error.message })
    });
  }
});

// 6.5 GET next available QR code (for preview before saving)
router.get('/next-qr', authenticateToken, async (req, res) => {
  try {
    const { stationId, shiftId, subLine, shiftTypeId: shiftTypeIdParam } = req.query; // shiftTypeId from frontend when DB has null

    if (!stationId || !shiftId) {
      return res.status(400).json({ success: false, message: 'stationId and shiftId are required' });
    }

    // Get shift details (use shift_type_id for correct S1/S2/S3 in QR)
    const shiftInfo = await pool.query(
      `SELECT os.shift_type_id, st.name as shift_name, os.start_time, mt.name as material_name
       FROM operator_shifts os
       LEFT JOIN shift_types st ON os.shift_type_id = st.id
       LEFT JOIN material_types mt ON os.material_type_id = mt.id
       WHERE os.id = $1`,
      [shiftId]
    );

    if (shiftInfo.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'Shift not found.' });
    }

    const row = shiftInfo.rows[0];
    const shift_type_id = row.shift_type_id != null ? Number(row.shift_type_id) : null;
    const shift_name = row.shift_name;
    const start_time = row.start_time;
    const material_name = row.material_name;

    const shiftDate = new Date(start_time);
    const year = shiftDate.getFullYear();
    const month = String(shiftDate.getMonth() + 1).padStart(2, '0');
    const date = String(shiftDate.getDate()).padStart(2, '0');

    // S1/S2/S3: prefer DB shift_type_id, then frontend shiftTypeId (for old sessions with null), then shift name map
    console.log('DEBUG next-qr: shift_type_id from DB:', shift_type_id, 'shiftTypeIdParam from frontend:', shiftTypeIdParam, 'shift_name:', shift_name);
    const shiftMap = { 'Shift 1': '1', 'Shift 2': '2', 'Shift 3': '3' };
    let shiftNum = '1';
    if (shift_type_id >= 1 && shift_type_id <= 3) {
      shiftNum = String(shift_type_id);
      console.log('DEBUG: Using DB shift_type_id:', shift_type_id, '-> shiftNum:', shiftNum);
    } else if (shiftTypeIdParam != null && shiftTypeIdParam !== '') {
      const t = Number(shiftTypeIdParam);
      if (t >= 1 && t <= 3) {
        shiftNum = String(t);
        console.log('DEBUG: Using frontend shiftTypeIdParam:', shiftTypeIdParam, '-> shiftNum:', shiftNum);
      } else {
        shiftNum = shiftMap[String(shift_name || '').trim()] || '1';
        console.log('DEBUG: Using shift_name fallback:', shift_name, '-> shiftNum:', shiftNum);
      }
    } else {
      shiftNum = shiftMap[String(shift_name || '').trim()] || '1';
      console.log('DEBUG: Using shift_name fallback (no param):', shift_name, '-> shiftNum:', shiftNum);
    }

    const stationResult = await pool.query('SELECT code, name FROM stations WHERE id = $1', [stationId]);
    const stationCode = stationResult.rows[0]?.code || 'UNK';
    const stationName = stationResult.rows[0]?.name || '';

    const { finalStationCode, stationDisplayName } = resolveQrStationCodes(
      stationCode,
      stationName,
      subLine
    );

    let countSql = `SELECT COUNT(*) as count 
       FROM production_logs 
       WHERE station_id = $1 AND created_at >= CURRENT_DATE`;
    const countParams = [stationId];
    countSql = appendPetSubLineCountFilter(countSql, countParams, subLine);
    const countResult = await pool.query(countSql, countParams);
    const increment = String(parseInt(countResult.rows[0].count, 10) + 1).padStart(3, '0');
    const materialCode = (material_name && String(material_name).trim()) || 'PC';
    const safeStationCode = (finalStationCode && String(finalStationCode).trim()) || stationCode || 'UNK';

    const nextQr = `${year}${month}${date}-${materialCode}-S${shiftNum}-${safeStationCode}-${increment}`;

    res.json({
      success: true,
      data: {
        qrCode: nextQr,
        details: {
          materialCode,
          shiftNum,
          stationCode: finalStationCode,
          stationName: stationDisplayName,
          increment
        }
      }
    });
  } catch (error) {
    console.error('Error generating next QR:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// 7. Log production data
router.post('/log', authenticateToken, async (req, res) => {
  const { shiftId, stationId, inputBagQr, outputBagQr, weight, photoUrl, subLine, remark, shiftTypeId: shiftTypeIdBody, dnNo } = req.body;
  // Read status explicitly (client sends "Completed" or "pending"); accept any casing
  const status = req.body.status != null ? String(req.body.status).trim() : null;
  const materialTypeId = req.user.materialTypeId;

  const weightNum = Number(weight);
  if (weight === undefined || weight === null || weight === '' || !Number.isFinite(weightNum) || weightNum <= 0) {
    return res.status(400).json({
      success: false,
      message: 'Valid positive weight (kg) is required',
    });
  }

  try {
    let finalOutputBagQr = outputBagQr;
    let stationCode = null; // Will be used for status determination

    // Get shift details (Line, Shift Type, Date)
    const shiftExists = await pool.query('SELECT * FROM operator_shifts WHERE id = $1', [shiftId]);

    if (shiftExists.rows.length === 0) {
      return res.status(404).json({ success: false, message: `Shift session ${shiftId} not found` });
    }

    // Get Station Code from DB (needed for both QR generation and status determination)
    const stationResult = await pool.query('SELECT code, name FROM stations WHERE id = $1', [stationId]);
    stationCode = stationResult.rows[0]?.code || 'UNK';
    const stationName = stationResult.rows[0]?.name || '';

    // If outputBagQr is not provided, generate it
    if (!finalOutputBagQr) {
      const shiftInfo = await pool.query(
        `SELECT os.shift_type_id, st.name as shift_name, os.start_time, mt.name as material_name
         FROM operator_shifts os
         LEFT JOIN shift_types st ON os.shift_type_id = st.id
         LEFT JOIN material_types mt ON os.material_type_id = mt.id
         WHERE os.id = $1`,
        [shiftId]
      );

      if (shiftInfo.rows.length === 0) {
        return res.status(400).json({ success: false, message: 'Shift data incomplete.' });
      }

      const row = shiftInfo.rows[0];
      const shift_type_id = row.shift_type_id != null ? Number(row.shift_type_id) : null;
      const shift_name = row.shift_name;
      const start_time = row.start_time;
      const material_name = row.material_name;
      const shiftDate = new Date(start_time);
      const year = shiftDate.getFullYear();
      const month = String(shiftDate.getMonth() + 1).padStart(2, '0');
      const date = String(shiftDate.getDate()).padStart(2, '0');

      const shiftMap = { 'Shift 1': '1', 'Shift 2': '2', 'Shift 3': '3' };
      let shiftNum = '1';
      if (shift_type_id >= 1 && shift_type_id <= 3) {
        shiftNum = String(shift_type_id);
      } else if (shiftTypeIdBody != null && shiftTypeIdBody !== '') {
        const t = Number(shiftTypeIdBody);
        shiftNum = (t >= 1 && t <= 3) ? String(t) : (shiftMap[String(shift_name || '').trim()] || '1');
      } else {
        shiftNum = shiftMap[String(shift_name || '').trim()] || '1';
      }

      const { finalStationCode } = resolveQrStationCodes(stationCode, stationName, subLine);

      let countSql = `SELECT COUNT(*) as count 
         FROM production_logs pl
         JOIN operator_shifts os ON pl.shift_id = os.id
         WHERE os.shift_type_id = (SELECT shift_type_id FROM operator_shifts WHERE id = $1)
           AND pl.station_id = $2
           AND os.start_time::date = $3::date`;
      const countParams = [shiftId, stationId, start_time];
      countSql = appendPetSubLineCountFilter(countSql, countParams, subLine);
      const countResult = await pool.query(countSql, countParams);

      const increment = String(parseInt(countResult.rows[0].count) + 1).padStart(3, '0');

      // Proper QR format including Material Code, without line
      const materialCode = material_name || 'PC';
      finalOutputBagQr = `${year}${month}${date}-${materialCode}-S${shiftNum}-${finalStationCode}-${increment}`;
    }

    // Worker chooses status by jumbo bag type: temporary → pending, final → Completed
    // Always respect client-sent status when provided (e.g. "Final (Completed)" in label preview).
    let finalStatus;
    const hasStatusFromClient = status != null && String(status).trim() !== '';
    const rawStatus = hasStatusFromClient ? String(status).trim() : null;
    const isCrusher = stationCode === 'CRS' || (stationName && String(stationName).toLowerCase().includes('crusher'));
    const isWashing = stationCode === 'WSH' || (stationName && String(stationName).toLowerCase().includes('washing'));
    const isExtrusion = stationCode === 'EXT' || stationCode === 'EXTR' || (stationName && String(stationName).toLowerCase().includes('extrusion'));
    const isRepackaging = stationName && String(stationName).toLowerCase().includes('re-packaging');
    if (rawStatus !== null) {
      // Normalize to DB convention: Completed, pending, Cancelled (match existing queries in codebase)
      const lower = rawStatus.toLowerCase();
      if (lower === 'completed') finalStatus = 'Completed';
      else if (lower === 'cancelled') finalStatus = 'Cancelled';
      // Re-packaging is the final PC product: treat pending as Completed (operators expect finished goods, not WIP)
      else if (isRepackaging && lower === 'pending') finalStatus = 'Completed';
      else finalStatus = lower; // e.g. pending, Pending -> pending
    } else if ((isCrusher || isWashing || isExtrusion) && !isRepackaging) {
      // Default: crusher/washing/extrusion outputs are pending until consumed by the next stage
      finalStatus = 'pending';
    } else {
      finalStatus = 'Completed';
    }

    const result = await pool.query(
      `INSERT INTO production_logs (shift_id, station_id, material_type_id, input_bag_qr, output_bag_qr, weight, photo_url, status, sub_line, remark, dn_no)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [shiftId, stationId, materialTypeId, inputBagQr, finalOutputBagQr, weightNum, photoUrl, finalStatus, subLine, remark || null, dnNo ?? null]
    );

    const row = result.rows[0];
    if (row && row.status !== finalStatus) {
      row.status = finalStatus;
    }
    res.json({ success: true, message: 'Log recorded successfully', data: row });
  } catch (error) {
    console.error('Error recording log:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// 8. Log by-products
router.post('/by-products', authenticateToken, async (req, res) => {
  const { shiftId, byProducts } = req.body;

  if (!shiftId || !Array.isArray(byProducts)) {
    return res.status(400).json({ success: false, message: 'Invalid data provided' });
  }

  const client = await pool.connect();
  try {
    const shiftResult = await client.query(
      'SELECT id FROM operator_shifts WHERE id = $1',
      [shiftId]
    );

    if (shiftResult.rows.length === 0) {
      client.release();
      return res.status(404).json({ success: false, message: `Shift session with ID ${shiftId} not found` });
    }

    await client.query('BEGIN');

    // Delete existing rows first so repeated calls (e.g. after printer failure) never duplicate
    await client.query('DELETE FROM by_product_logs WHERE shift_id = $1', [shiftId]);

    for (const item of byProducts) {
      await client.query(
        `INSERT INTO by_product_logs (shift_id, station_id, name, weight, category)
         VALUES ($1, $2, $3, $4, $5)`,
        [shiftId, item.stationId, item.name, item.weight, item.category || null]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, message: 'By-products recorded successfully' });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Error recording by-products:', error);
    res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  } finally {
    client.release();
  }
});

// 8.1 Get by-products for a shift
router.get('/shift/:shiftId/by-products', authenticateToken, async (req, res) => {
  const { shiftId } = req.params;
  try {
    const result = await pool.query(
      `SELECT b.id, b.shift_id, b.station_id, s.name AS station_name, b.name, b.category, b.weight
       FROM by_product_logs b
       LEFT JOIN stations s ON s.id = b.station_id
       WHERE b.shift_id = $1
       ORDER BY b.id`,
      [shiftId]
    );
    const rows = result.rows.map((r) => ({
      id: r.id,
      shiftId: r.shift_id,
      stationId: r.station_id,
      stationName: r.station_name || '',
      name: r.name,
      category: r.category || '',
      weight: Number(r.weight) || 0,
    }));
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('Error fetching by-products:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ── Shared helper: fetch by-product flat rows for a date range ───────────────
async function fetchByProductRows(date_start, date_end, material_type) {
  const params = [date_start, date_end];
  let materialFilter = '';
  if (material_type && material_type !== 'all') {
    params.push(String(material_type));
    materialFilter = `AND mt.name = $${params.length}`;
  }
  const result = await pool.query(
    `SELECT b.id, b.name, b.category, b.weight,
            s.name  AS station_name,
            mt.name AS material_type_name,
            st.name AS shift_name,
            st.id   AS shift_type_id,
            u.name  AS operator_name,
            os.start_time
     FROM by_product_logs b
     LEFT JOIN stations        s  ON s.id  = b.station_id
     LEFT JOIN operator_shifts os ON os.id = b.shift_id
     LEFT JOIN shift_types     st ON st.id = os.shift_type_id
     LEFT JOIN users           u  ON u.id  = os.user_id
     LEFT JOIN material_types  mt ON mt.id = os.material_type_id
     WHERE os.start_time::date >= $1::date
       AND os.start_time::date <= $2::date
       ${materialFilter}
     ORDER BY os.start_time::date ASC, st.id ASC, b.id ASC`,
    params
  );
  return result.rows;
}

// ── Group flat rows into day → shift → items + daily total ───────────────────
function groupByProductRows(rows) {
  // days map: date string → { date, shifts: { shiftName → { shiftName, items[], shiftTotal } }, dayTotal }
  const daysMap = {};
  for (const r of rows) {
    const date   = r.start_time ? new Date(r.start_time).toISOString().slice(0, 10) : 'Unknown';
    const shift  = r.shift_name || 'Unknown';
    const weight = Number(r.weight) || 0;

    if (!daysMap[date]) daysMap[date] = { date, shifts: {}, dayTotal: 0 };
    if (!daysMap[date].shifts[shift]) daysMap[date].shifts[shift] = { shiftName: shift, items: [], shiftTotal: 0 };

    daysMap[date].shifts[shift].items.push({
      id:          r.id,
      name:        r.name,
      category:    r.category || '',
      weight,
      stationName: r.station_name || '',
      materialType: r.material_type_name || '',
      operator:    r.operator_name || '',
    });
    daysMap[date].shifts[shift].shiftTotal += weight;
    daysMap[date].dayTotal += weight;
  }

  // Convert to array, sort descending by date
  return Object.values(daysMap)
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .map(d => ({
      date:     d.date,
      dayTotal: Math.round(d.dayTotal * 100) / 100,
      shifts:   Object.values(d.shifts).map(s => ({
        shiftName:  s.shiftName,
        shiftTotal: Math.round(s.shiftTotal * 100) / 100,
        items:      s.items,
      })),
    }));
}

// 8.15 Get by-products across a date range — grouped by day → shift
router.get('/by-products/range', authenticateToken, async (req, res) => {
  const { date_start, date_end, material_type } = req.query;
  if (!date_start || !date_end) {
    return res.status(400).json({ success: false, message: 'date_start and date_end are required' });
  }
  try {
    const rows = await fetchByProductRows(date_start, date_end, material_type);
    const grouped = groupByProductRows(rows);
    res.json({ success: true, data: grouped, total: rows.length });
  } catch (error) {
    console.error('Error fetching by-products range:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// 8.16 Export by-products as Excel (.xlsx) — same structure as range view
router.get('/by-products/range/export', authenticateToken, async (req, res) => {
  const { date_start, date_end, material_type } = req.query;
  if (!date_start || !date_end) {
    return res.status(400).json({ success: false, message: 'date_start and date_end are required' });
  }
  try {
    const ExcelJS = require('exceljs');
    const rows    = await fetchByProductRows(date_start, date_end, material_type);
    const grouped = groupByProductRows(rows);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Greencore API';
    const ws = wb.addWorksheet('By-Products Report');

    // ── Column widths ──
    ws.columns = [
      { key: 'date',     width: 14 },
      { key: 'shift',    width: 14 },
      { key: 'name',     width: 28 },
      { key: 'category', width: 18 },
      { key: 'station',  width: 20 },
      { key: 'operator', width: 22 },
      { key: 'weight',   width: 14 },
    ];

    // ── Header row ──
    const headerRow = ws.addRow(['Date', 'Shift', 'By-Product Name', 'Category', 'Station', 'Operator', 'Weight (kg)']);
    headerRow.eachCell(cell => {
      cell.font      = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F5C2E' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.border    = { bottom: { style: 'thin' } };
    });
    ws.getRow(1).height = 20;

    const LIGHT_GREEN  = 'FFE8F5E9';
    const SHIFT_BLUE   = 'FFE3F2FD';
    const DAY_YELLOW   = 'FFFFF9C4';

    for (const day of grouped) {
      // ── Day header row ──
      const dayRow = ws.addRow([day.date, '', '', '', '', 'Day Total', day.dayTotal]);
      dayRow.eachCell(cell => {
        cell.font = { bold: true };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: DAY_YELLOW } };
      });
      dayRow.getCell(7).numFmt = '0.00';

      for (const shift of day.shifts) {
        // ── Shift sub-header ──
        const shiftRow = ws.addRow(['', shift.shiftName, '', '', '', 'Shift Total', shift.shiftTotal]);
        shiftRow.eachCell(cell => {
          cell.font = { bold: true, italic: true };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SHIFT_BLUE } };
        });
        shiftRow.getCell(7).numFmt = '0.00';

        // ── Item rows ──
        for (const item of shift.items) {
          const itemRow = ws.addRow(['', '', item.name, item.category, item.stationName, item.operator, item.weight]);
          itemRow.eachCell(cell => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT_GREEN } };
          });
          itemRow.getCell(7).numFmt = '0.00';
        }
      }
    }

    // ── Grand total row ──
    const grandTotal = grouped.reduce((s, d) => s + d.dayTotal, 0);
    const totalRow = ws.addRow(['Grand Total', '', '', '', '', '', Math.round(grandTotal * 100) / 100]);
    totalRow.eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F5C2E' } };
    });
    totalRow.getCell(7).numFmt = '0.00';

    // ── Stream response ──
    const filename = `by-products_${date_start}_to_${date_end}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Error exporting by-products:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// 8.2 Update by-products for a shift (replace all)
router.put('/shift/:shiftId/by-products', authenticateToken, async (req, res) => {
  const { shiftId } = req.params;
  const { byProducts } = req.body;

  if (!Array.isArray(byProducts)) {
    return res.status(400).json({ success: false, message: 'byProducts array required' });
  }

  const client = await pool.connect();
  try {
    const shiftResult = await client.query(
      'SELECT id FROM operator_shifts WHERE id = $1',
      [shiftId]
    );
    if (shiftResult.rows.length === 0) {
      client.release();
      return res.status(404).json({ success: false, message: 'Shift not found' });
    }

    await client.query('BEGIN');
    await client.query('DELETE FROM by_product_logs WHERE shift_id = $1', [shiftId]);

    for (const item of byProducts) {
      await client.query(
        `INSERT INTO by_product_logs (shift_id, station_id, name, weight, category)
         VALUES ($1, $2, $3, $4, $5)`,
        [shiftId, item.stationId, item.name, item.weight, item.category || null]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, message: 'By-products updated successfully' });
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    console.error('Error updating by-products:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Helper: get Crusher, Washing, Extrusion station IDs
async function getStationIdsByCode() {
  const r = await pool.query(
    "SELECT id, code, name FROM stations WHERE code IN ('CRS','WSH','EXT','EXTR') OR name ILIKE '%crusher%' OR name ILIKE '%washing%' OR name ILIKE '%extrusion%'"
  );
  const byCode = { crusher: null, washing: null, extrusion: null };
  for (const row of r.rows) {
    const code = (row.code || '').toUpperCase();
    const name = (row.name || '').toLowerCase();
    if (code === 'CRS' || name.includes('crusher')) byCode.crusher = row.id;
    else if (code === 'WSH' || name.includes('washing')) byCode.washing = row.id;
    else if ((code === 'EXT' || code === 'EXTR') || name.includes('extrusion')) byCode.extrusion = row.id;
  }
  return byCode;
}

// 8.3 List closed shifts (for PPIC: edit & print saved reports)
// Query params: limit (default 30), date (YYYY-MM-DD), shiftTypeId (1, 2, 3)
router.get('/closed-shifts', authenticateToken, async (req, res) => {
  // Legacy single-date param kept for backward compat; new params take precedence
  const {
    limit = 10, page = 1,
    date: dateFilterLegacy,
    date_start, date_end,
    shift_type, material_type, operator,
    include_active,
  } = req.query;
  // Legacy shiftTypeId filter (mobile app)
  const shiftTypeIdFilter = req.query.shiftTypeId ?? req.query.shifttypeid;
  try {
    const stationIds = await getStationIdsByCode();
    const params = [];
    const conds = [];

    const showActive =
      include_active === 'true' ||
      include_active === '1' ||
      include_active === true;
    if (!showActive) {
      conds.push('os.is_active = false');
    }

    const ds =
      date_start && /^\d{4}-\d{2}-\d{2}$/.test(String(date_start).trim())
        ? String(date_start).trim()
        : null;
    const de =
      date_end && /^\d{4}-\d{2}-\d{2}$/.test(String(date_end).trim())
        ? String(date_end).trim()
        : null;
    const legacyDate =
      !ds && dateFilterLegacy && /^\d{4}-\d{2}-\d{2}$/.test(String(dateFilterLegacy).trim())
        ? String(dateFilterLegacy).trim()
        : null;

    // Match Production Logs: shift start date OR any log recorded on that date
    if (ds && de) {
      params.push(ds, de);
      conds.push(`(
        (os.start_time::date >= $${params.length - 1}::date AND os.start_time::date <= $${params.length}::date)
        OR EXISTS (
          SELECT 1 FROM production_logs pl
          WHERE pl.shift_id = os.id
            AND pl.created_at::date >= $${params.length - 1}::date
            AND pl.created_at::date <= $${params.length}::date
        )
      )`);
    } else if (ds) {
      params.push(ds);
      conds.push(`(
        os.start_time::date >= $${params.length}::date
        OR EXISTS (
          SELECT 1 FROM production_logs pl
          WHERE pl.shift_id = os.id AND pl.created_at::date >= $${params.length}::date
        )
      )`);
    } else if (de) {
      params.push(de);
      conds.push(`(
        os.start_time::date <= $${params.length}::date
        OR EXISTS (
          SELECT 1 FROM production_logs pl
          WHERE pl.shift_id = os.id AND pl.created_at::date <= $${params.length}::date
        )
      )`);
    } else if (legacyDate) {
      params.push(legacyDate);
      conds.push(`(
        os.start_time::date = $${params.length}::date
        OR EXISTS (
          SELECT 1 FROM production_logs pl
          WHERE pl.shift_id = os.id AND pl.created_at::date = $${params.length}::date
        )
      )`);
    }
    // Shift type by name (new) or by ID (legacy)
    if (shift_type && shift_type !== 'all') {
      params.push(String(shift_type).trim());
      conds.push(`st.name = $${params.length}`);
    } else {
      const shiftTypeNum = shiftTypeIdFilter != null && shiftTypeIdFilter !== '' ? Number(shiftTypeIdFilter) : NaN;
      if (!Number.isNaN(shiftTypeNum) && [1, 2, 3].includes(shiftTypeNum)) {
        params.push(shiftTypeNum);
        conds.push(`os.shift_type_id = $${params.length}`);
      }
    }
    // Material type by name
    if (material_type && material_type !== 'all') {
      params.push(String(material_type).trim());
      conds.push(`mt.name = $${params.length}`);
    }
    // Operator name search
    if (operator && String(operator).trim().length > 0) {
      params.push(`%${String(operator).trim()}%`);
      conds.push(`u.name ILIKE $${params.length}`);
    }
    // Hide shifts with zero production logs
    const { hide_empty } = req.query;
    if (hide_empty === 'true' || hide_empty === '1') {
      conds.push(`EXISTS (SELECT 1 FROM production_logs pl WHERE pl.shift_id = os.id)`);
    }

    const where = conds.length ? conds.join(' AND ') : '1=1';

    // Count query for pagination
    const countSql = `SELECT COUNT(*) AS total
      FROM operator_shifts os
      LEFT JOIN shift_types st ON st.id = os.shift_type_id
      LEFT JOIN users u ON u.id = os.user_id
      LEFT JOIN material_types mt ON os.material_type_id = mt.id
      WHERE ${where}`;
    const countResult = await pool.query(countSql, params);
    const total = parseInt(countResult.rows[0]?.total || 0, 10);

    // Data query with pagination
    const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
    const limitNum = Math.min(Math.max(1, parseInt(String(limit), 10) || 10), 100);
    const offset = (pageNum - 1) * limitNum;
    params.push(limitNum, offset);

    const sql = `SELECT os.id, os.start_time, os.end_time, os.end_remark, os.is_active,
       st.name AS shift_name, u.name AS operator_name, mt.name AS material_type_name
       FROM operator_shifts os
       LEFT JOIN shift_types st ON st.id = os.shift_type_id
       LEFT JOIN users u ON u.id = os.user_id
       LEFT JOIN material_types mt ON os.material_type_id = mt.id
       WHERE ${where}
       ORDER BY os.end_time DESC NULLS LAST, os.start_time DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const result = await pool.query(sql, params);
    const list = await Promise.all(result.rows.map(async (row) => {
      const materialTypeName = row.material_type_name || null;
      const byStation = createEmptyByStation();
      const aggRows = await pool.query(
        `SELECT s.code, s.name, pl.sub_line,
                COUNT(pl.id) AS cnt,
                COALESCE(SUM(pl.weight), 0) AS tot
         FROM production_logs pl
         JOIN stations s ON s.id = pl.station_id
         WHERE pl.shift_id = $1 AND pl.status != 'Cancelled'
         GROUP BY s.code, s.name, pl.sub_line`,
        [row.id]
      );
      applyAggRowsToByStation(byStation, aggRows.rows, materialTypeName);
      const { totalOutputs, totalWeight } = sumByStationTotals(byStation);
      return {
        shiftId: row.id,
        shiftName: (row.shift_name && String(row.shift_name).trim()) ? String(row.shift_name).trim() : 'Shift',
        operatorName: row.operator_name || 'N/A',
        materialTypeName: (materialTypeName && String(materialTypeName).trim()) ? String(materialTypeName).trim() : null,
        startTime: row.start_time,
        endTime: row.end_time,
        endRemark: row.end_remark || '',
        isActive: row.is_active === true,
        date: row.start_time ? new Date(row.start_time).toLocaleDateString('en-CA') : '',
        totalOutputs,
        totalWeight,
        byStation,
      };
    }));
    res.json({
      success: true, data: list,
      pagination: { total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) },
    });
  } catch (error) {
    console.error('Error listing closed shifts:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// 8.4 Get closed shift summary (for PPIC: load report to edit/print)
router.get('/closed-shift/:shiftId/summary', authenticateToken, async (req, res) => {
  const { shiftId } = req.params;
  try {
    const shiftRow = await pool.query(
      `SELECT os.id, os.start_time, st.name AS shift_name, u.name AS operator_name, os.end_remark,
              mt.name AS material_type_name
       FROM operator_shifts os
       LEFT JOIN shift_types st ON st.id = os.shift_type_id
       LEFT JOIN users u ON u.id = os.user_id
       LEFT JOIN material_types mt ON mt.id = os.material_type_id
       WHERE os.id = $1 AND os.is_active = false`,
      [shiftId]
    );
    if (shiftRow.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Closed shift not found' });
    }
    const shift = shiftRow.rows[0];
    // Aggregate per station in one query; exclude Cancelled so counts match actual production
    const aggResult = await pool.query(
      `SELECT s.id, s.code, s.name, pl.sub_line,
              COUNT(pl.id) AS cnt,
              COALESCE(SUM(pl.weight), 0) AS tot
       FROM production_logs pl
       JOIN stations s ON s.id = pl.station_id
       WHERE pl.shift_id = $1
         AND pl.status != 'Cancelled'
       GROUP BY s.id, s.code, s.name, pl.sub_line`,
      [shiftId]
    );
    const byStation = createEmptyByStation();
    applyAggRowsToByStation(byStation, aggResult.rows, shift.material_type_name);
    const { totalOutputs, totalWeight } = sumByStationTotals(byStation);
    const byProductsRes = await pool.query(
      `SELECT b.id, b.shift_id, b.station_id, s.name AS station_name, b.name, b.category, b.weight
       FROM by_product_logs b
       LEFT JOIN stations s ON s.id = b.station_id
       WHERE b.shift_id = $1 ORDER BY b.id`,
      [shiftId]
    );
    const byProducts = byProductsRes.rows.map((r) => ({
      id: r.id,
      shiftId: r.shift_id,
      stationId: r.station_id,
      stationName: r.station_name || '',
      name: r.name,
      category: r.category || '',
      weight: Number(r.weight) || 0,
    }));
    res.json({
      success: true,
      data: {
        shift: shift.shift_name || 'N/A',
        operator: shift.operator_name || 'N/A',
        date: shift.start_time ? new Date(shift.start_time).toLocaleDateString('en-CA') : '',
        totalOutputs,
        totalWeight,
        byStation,
        remark: shift.end_remark || '',
        byProducts,
        materialTypeName: shift.material_type_name || null,
      },
    });
  } catch (error) {
    console.error('Error fetching closed shift summary:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// 8.3 Universal shift summary — works for both active and closed shifts (used by PPIC)
router.get('/shift/:shiftId/summary', authenticateToken, async (req, res) => {
  const { shiftId } = req.params;
  try {
    const shiftRow = await pool.query(
      `SELECT os.id, os.start_time, os.is_active, st.name AS shift_name, u.name AS operator_name, os.end_remark,
              mt.name AS material_type_name
       FROM operator_shifts os
       LEFT JOIN shift_types st ON st.id = os.shift_type_id
       LEFT JOIN users u ON u.id = os.user_id
       LEFT JOIN material_types mt ON mt.id = os.material_type_id
       WHERE os.id = $1`,
      [shiftId]
    );
    if (shiftRow.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Shift not found' });
    }
    const row = shiftRow.rows[0];
    const aggResult = await pool.query(
      `SELECT s.id, s.code, s.name, pl.sub_line,
              COUNT(pl.id) AS cnt,
              COALESCE(SUM(pl.weight), 0) AS tot
       FROM production_logs pl
       JOIN stations s ON s.id = pl.station_id
       WHERE pl.shift_id = $1
         AND pl.status != 'Cancelled'
       GROUP BY s.id, s.code, s.name, pl.sub_line`,
      [shiftId]
    );
    const byStation = createEmptyByStation();
    applyAggRowsToByStation(byStation, aggResult.rows, row.material_type_name);
    const { totalOutputs, totalWeight } = sumByStationTotals(byStation);
    const byProductsRes = await pool.query(
      `SELECT b.id, b.shift_id, b.station_id, s.name AS station_name, b.name, b.category, b.weight
       FROM by_product_logs b
       LEFT JOIN stations s ON s.id = b.station_id
       WHERE b.shift_id = $1 ORDER BY b.id`,
      [shiftId]
    );
    const byProducts = byProductsRes.rows.map((r) => ({
      id: r.id,
      shiftId: r.shift_id,
      stationId: r.station_id,
      stationName: r.station_name || '',
      name: r.name,
      category: r.category || '',
      weight: Number(r.weight) || 0,
    }));
    res.json({
      success: true,
      data: {
        shift: row.shift_name || 'N/A',
        operator: row.operator_name || 'N/A',
        date: row.start_time ? new Date(row.start_time).toLocaleDateString('en-CA') : '',
        isActive: row.is_active,
        totalOutputs,
        totalWeight,
        byStation,
        remark: row.end_remark || '',
        byProducts,
        materialTypeName: row.material_type_name || null,
      },
    });
  } catch (error) {
    console.error('Error fetching shift summary:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// 8.5 PPIC: Update closed shift remark (edit any data from PC production)
router.put('/closed-shift/:shiftId/remark', authenticateToken, async (req, res) => {
  const { shiftId } = req.params;
  const { remark } = req.body || {};
  try {
    const check = await pool.query(
      'SELECT id FROM operator_shifts WHERE id = $1 AND is_active = false',
      [shiftId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Closed shift not found' });
    }
    await pool.query(
      'UPDATE operator_shifts SET end_remark = $1 WHERE id = $2 AND is_active = false',
      [typeof remark === 'string' ? remark : '', shiftId]
    );
    res.json({ success: true, message: 'Remark updated' });
  } catch (error) {
    console.error('Error updating closed shift remark:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// 9. Get all logs for a shift
router.get('/logs/:shiftId', authenticateToken, async (req, res) => {
  const { shiftId } = req.params;
  try {
    const result = await pool.query(
      'SELECT * FROM production_logs WHERE shift_id = $1 ORDER BY created_at DESC',
      [shiftId]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Error fetching shift logs:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// 10. Search logs by output QR (for autocomplete)
router.get('/search-logs', authenticateToken, async (req, res) => {
  // source_sub_lines: comma-separated list to restrict which sub-lines can appear as inputs
  // Used by Betty crusher so it only sees 3E/Rapid bags, not its own Betty bags.
  const { query, stationId, targetStationId: targetStationIdParam, currentStationId, status, source_sub_lines, shift_id, for_input } = req.query;
  const materialTypeId = req.user.materialTypeId;
  // When for_input=1 (scan/search input from previous station), allow batches from any shift and optionally any material type so S1 bags work in S2
  const isForInput = for_input === '1' || for_input === 'true';

  try {
    let targetStationId = targetStationIdParam || stationId;
    let targetStatus = status;
    let isPelletPacking = false;

    // PE Extrusion input comes from CRS (Crusher-Washing); PC/PET from WSH. Resolve material type name.
    let materialTypeName = null;
    if (materialTypeId) {
      const mtRes = await pool.query('SELECT name FROM material_types WHERE id = $1', [materialTypeId]);
      if (mtRes.rows.length > 0) materialTypeName = (mtRes.rows[0].name || '').toUpperCase();
    }

    if (currentStationId) {
      const currentStationResult = await pool.query(
        "SELECT code FROM stations WHERE id = $1 LIMIT 1",
        [currentStationId]
      );

      if (currentStationResult.rows.length > 0) {
        const currentStationCode = currentStationResult.rows[0].code;

        // Washing: input from Crusher (CRS)
        if (currentStationCode === 'WSH') {
          const crusherStationResult = await pool.query("SELECT id FROM stations WHERE code = 'CRS' LIMIT 1");
          if (crusherStationResult.rows.length > 0) {
            targetStationId = crusherStationResult.rows[0].id;
            targetStatus = targetStatus || 'pending';
          }
        }

        // Extrusion: PE → CRS (Crusher-Washing) bags; PC → WSH; PET Boretech → client passes CRS or WSH (dual-source), else default WSH
        if (currentStationCode === 'EXT' || currentStationCode === 'EXTR') {
          if (materialTypeName === 'PE') {
            const crusherStationResult = await pool.query("SELECT id FROM stations WHERE code = 'CRS' LIMIT 1");
            if (crusherStationResult.rows.length > 0) {
              targetStationId = crusherStationResult.rows[0].id;
              targetStatus = targetStatus || 'pending';
            }
          } else if (materialTypeName === 'PET') {
            targetStatus = targetStatus || 'pending';
            const explicitTarget = targetStationIdParam || stationId;
            if (!explicitTarget) {
              const washingStationResult = await pool.query("SELECT id FROM stations WHERE code = 'WSH' LIMIT 1");
              if (washingStationResult.rows.length > 0) {
                targetStationId = washingStationResult.rows[0].id;
              }
            }
          } else {
            const washingStationResult = await pool.query("SELECT id FROM stations WHERE code = 'WSH' LIMIT 1");
            if (washingStationResult.rows.length > 0) {
              targetStationId = washingStationResult.rows[0].id;
              targetStatus = targetStatus || 'pending';
            }
          }
        }

        // Pellet Packing (PLT): inputs = Final Packaging outputs (Completed) + Extrusion outputs (pending).
        // Client makes one call per source with explicit targetStationId + status and merges client-side.
        // Default (no explicit target): Final Packaging Completed bags.
        if (currentStationCode === 'PLT') {
          isPelletPacking = true;
          if (!targetStationIdParam && !stationId) {
            const pkgStationResult = await pool.query("SELECT id FROM stations WHERE code = 'PKG' LIMIT 1");
            if (pkgStationResult.rows.length > 0) {
              targetStationId = pkgStationResult.rows[0].id;
              targetStatus = targetStatus || 'Completed';
            }
          }
        }
      }
    }

    // If status='pending' is explicitly requested and target station is 2 or not provided, get Crusher station
    // But only if we haven't already set targetStationId from the currentStationId check above
    if (status === 'pending' && (!targetStationId || String(targetStationId) === '2') && String(targetStationId) !== '3') {
      const crusherStationResult = await pool.query("SELECT id FROM stations WHERE code = 'CRS' LIMIT 1");
      if (crusherStationResult.rows.length > 0) {
        targetStationId = crusherStationResult.rows[0].id;
      }
    }

    let sql = `SELECT pl.* FROM production_logs pl
               JOIN operator_shifts os ON pl.shift_id = os.id
               WHERE 1=1`;
    const params = [];
    let paramIndex = 0;

    // Add search filter only if query is provided and not empty
    // Use trimmed query; when for_input=1 also allow exact match so full scanned batch IDs (e.g. S1-W3 in S3-EXT) match reliably
    const q = (query && String(query).trim()) || '';
    if (q.length > 0) {
      paramIndex++;
      sql += ` AND (pl.output_bag_qr ILIKE $${paramIndex}`;
      params.push(`%${q}%`);
      if (isForInput) {
        paramIndex++;
        sql += ` OR pl.output_bag_qr = $${paramIndex}`;
        params.push(q);
      }
      sql += ')';
    }

    // Filter by material type: PC login → only PC QR/batches, PE login → only PE (all inputs and lists).
    if (materialTypeId) {
      paramIndex++;
      sql += ` AND COALESCE(pl.material_type_id, os.material_type_id) = $${paramIndex}`;
      params.push(materialTypeId);
    }

    // Filter by the source station (where the bags came from)
    // For washing, this should be Crusher station (CRS)
    if (targetStationId) {
      paramIndex++;
      sql += ` AND pl.station_id = $${paramIndex}`;
      params.push(targetStationId);
    }

    // Restrict to specific source sub-lines (e.g. Betty only sees 3E/Rapid bags)
    // Case-insensitive + trim so "Rapid", "RAPID", "CRP" (if stored as sub_line) all match crusher-logs behavior
    if (source_sub_lines) {
      const allowed = String(source_sub_lines).split(',').map(s => s.trim()).filter(Boolean);
      if (allowed.length > 0) {
        const allowedLower = allowed.map((a) => String(a).toLowerCase().trim());
        paramIndex++;
        sql += ` AND LOWER(TRIM(COALESCE(pl.sub_line, ''))) = ANY($${paramIndex}::text[])`;
        params.push(allowedLower);
      }
    }

    // Optional: scope to a specific shift. When omitted, returns pending batches from any shift/day (status-based consumption).
    if (shift_id) {
      paramIndex++;
      sql += ` AND pl.shift_id = $${paramIndex}`;
      params.push(parseInt(shift_id));
    }

    // Exclude bags that are already processing at the current station.
    // Use NOT EXISTS instead of NOT IN to avoid NULL edge cases.
    // Pellet Packing: source bags (Final Packaging) stay 'Completed' after consumption,
    // so also exclude bags already consumed (Completed rows at PLT), not just Processing.
    if (currentStationId) {
      paramIndex++;
      const consumedStatuses = isPelletPacking ? `IN ('Processing', 'Completed')` : `= 'Processing'`;
      sql += ` AND NOT EXISTS (
        SELECT 1 FROM production_logs px
        WHERE px.station_id = $${paramIndex}
          AND px.status ${consumedStatuses}
          AND px.input_bag_qr IS NOT NULL
          AND px.input_bag_qr = pl.output_bag_qr
      )`;
      params.push(currentStationId);
    }

    // Filter by status (e.g., 'pending' for washing to show only pending crusher batches)
    // If status is provided, use it; otherwise default to 'Completed' for other stations
    if (targetStatus) {
      paramIndex++;
      sql += ` AND pl.status = $${paramIndex}`;
      params.push(targetStatus);
    } else {
      // Default to 'Completed' for stations other than washing
      sql += ` AND pl.status = 'Completed'`;
    }
    // When for_input=1 (input search/scan): any shift, any date — use larger limit and oldest-first so yesterday's pending shows
    if (isForInput) {
      sql += ` ORDER BY pl.created_at ASC LIMIT 200`;
    } else {
      sql += ` ORDER BY pl.created_at DESC LIMIT 20`;
    }

    if (req.query.debug === '1') {
      console.log('[search-logs] query params:', { query, targetStationId, currentStationId, status });
      console.log('[search-logs] materialTypeId:', materialTypeId);
      console.log('[search-logs] sql:', sql);
      console.log('[search-logs] params:', params);
    }

    const result = await pool.query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Error searching logs:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// 10.5. Update production log status (e.g., mark crusher batch as completed when washing starts processing, or washing when extrusion starts)
router.put('/update-log-status', authenticateToken, async (req, res) => {
  const { outputBagQr, status, usedLine, washingLine, extrusionLine } = req.body;

  if (!outputBagQr || !status) {
    return res.status(400).json({ success: false, message: 'outputBagQr and status are required' });
  }

  try {
    // Build update query dynamically based on provided fields
    let updateFields = ['status = $1'];
    let params = [status];
    let paramIndex = 2;

    // Add used_line if provided (prefer usedLine over washingLine for backward compatibility)
    const finalUsedLine = usedLine || washingLine || extrusionLine;
    if (finalUsedLine) {
      updateFields.push(`used_line = $${paramIndex}`);
      params.push(finalUsedLine);
      paramIndex++;
      updateFields.push(`used_datetime = $${paramIndex}`);
      params.push(new Date());
      paramIndex++;
    }

    params.push(outputBagQr); // outputBagQr is always the last parameter for WHERE clause

    const result = await pool.query(
      `UPDATE production_logs 
       SET ${updateFields.join(', ')}
       WHERE output_bag_qr = $${paramIndex}
       RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Production log not found' });
    }

    res.json({ success: true, message: 'Status updated successfully', data: result.rows[0] });
  } catch (error) {
    console.error('Error updating log status:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// 10.6. Update production log weight
router.put('/update-log-weight', authenticateToken, async (req, res) => {
  const { logId, weight } = req.body;

  if (!logId || weight === undefined || weight === null) {
    return res.status(400).json({ success: false, message: 'logId and weight are required' });
  }

  const w = Number(weight);
  if (!Number.isFinite(w) || w <= 0) {
    return res.status(400).json({ success: false, message: 'Weight must be a valid positive number' });
  }

  try {
    const result = await pool.query(
      `UPDATE production_logs 
       SET weight = $1
       WHERE id = $2
       RETURNING *`,
      [w, logId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Production log not found' });
    }

    res.json({ success: true, message: 'Weight updated successfully', data: result.rows[0] });
  } catch (error) {
    console.error('Error updating log weight:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// 10.7. Backoffice: update any editable fields on a production log by ID
router.put('/logs-update/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  if (!id || isNaN(Number(id))) {
    return res.status(400).json({ success: false, message: 'Valid log id is required' });
  }
  const { weight, status, sub_line, remark } = req.body;
  const sets = [];
  const params = [];

  if (weight !== undefined && weight !== null && !isNaN(Number(weight)) && Number(weight) >= 0) {
    params.push(Number(weight)); sets.push(`weight = $${params.length}`);
  }
  if (status && typeof status === 'string') {
    params.push(status.trim()); sets.push(`status = $${params.length}`);
  }
  if (sub_line !== undefined) {
    params.push(sub_line === '' ? null : String(sub_line).trim()); sets.push(`sub_line = $${params.length}`);
  }
  if (remark !== undefined) {
    params.push(remark === '' ? null : String(remark).trim()); sets.push(`remark = $${params.length}`);
  }
  if (sets.length === 0) {
    return res.status(400).json({ success: false, message: 'No valid fields to update' });
  }
  params.push(Number(id));
  try {
    const result = await pool.query(
      `UPDATE production_logs SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Log not found' });
    }
    res.json({ success: true, message: 'Log updated', data: result.rows[0] });
  } catch (error) {
    console.error('[logs-update] ERROR:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 11. Get crusher line logs with date filter, search, and pagination
router.get('/crusher-logs', authenticateToken, async (req, res) => {
  const { subLine, date, search, status, shift_id, page = 1, limit = 10 } = req.query;
  const isPpic = (req.user.role || '').toLowerCase() === 'ppic';
  // PPIC can see all crusher logs and filter by machine (sub_line); operators scope by material type
  const materialTypeId = isPpic ? null : req.user.materialTypeId;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  try {
    const stationResult = await pool.query("SELECT id FROM stations WHERE code = 'CRS' LIMIT 1");
    if (stationResult.rows.length === 0) {
      return res.json({ success: true, data: [], pagination: { total: 0, page: 1, limit: 10, totalPages: 0 } });
    }
    const crusherStationId = stationResult.rows[0].id;

    let sql = `SELECT pl.*, os.start_time, st.name as shift_name, mt.name as material_name
               FROM production_logs pl
               JOIN operator_shifts os ON pl.shift_id = os.id
               LEFT JOIN shift_types st ON os.shift_type_id = st.id
               LEFT JOIN material_types mt ON os.material_type_id = mt.id
               WHERE pl.station_id = $1`;
    const params = [crusherStationId];
    let paramIndex = 1;

    if (materialTypeId) {
      paramIndex++;
      sql += ` AND os.material_type_id = $${paramIndex}`;
      params.push(materialTypeId);
    }

    if (subLine) {
      paramIndex++;
      sql += ` AND LOWER(TRIM(COALESCE(pl.sub_line, ''))) = LOWER(TRIM($${paramIndex}))`;
      params.push(String(subLine).trim());
    }

    if (status) {
      paramIndex++;
      sql += ` AND pl.status = $${paramIndex}`;
      params.push(status);
    }

    // Always apply date filter (selected date or today); optionally narrow by shift_id for "today"
    const targetDate = date || new Date().toISOString().split('T')[0];
    paramIndex++;
    sql += ` AND DATE(pl.created_at) = $${paramIndex}`;
    params.push(targetDate);
    if (shift_id) {
      paramIndex++;
      sql += ` AND pl.shift_id = $${paramIndex}`;
      params.push(parseInt(shift_id));
    }

    if (search) {
      paramIndex++;
      sql += ` AND pl.output_bag_qr ILIKE $${paramIndex}`;
      params.push(`%${search}%`);
    }

    let countSql = `SELECT COUNT(*) as total
                    FROM production_logs pl
                    JOIN operator_shifts os ON pl.shift_id = os.id
                    WHERE pl.station_id = $1`;
    const countParams = [crusherStationId];
    let countParamIndex = 1;

    if (materialTypeId) {
      countParamIndex++;
      countSql += ` AND os.material_type_id = $${countParamIndex}`;
      countParams.push(materialTypeId);
    }

    if (subLine) {
      countParamIndex++;
      countSql += ` AND LOWER(TRIM(COALESCE(pl.sub_line, ''))) = LOWER(TRIM($${countParamIndex}))`;
      countParams.push(String(subLine).trim());
    }

    if (status) {
      countParamIndex++;
      countSql += ` AND pl.status = $${countParamIndex}`;
      countParams.push(status);
    }

    countParamIndex++;
    countSql += ` AND DATE(pl.created_at) = $${countParamIndex}`;
    countParams.push(targetDate);
    if (shift_id) {
      countParamIndex++;
      countSql += ` AND pl.shift_id = $${countParamIndex}`;
      countParams.push(parseInt(shift_id));
    }

    if (search) {
      countParamIndex++;
      countSql += ` AND pl.output_bag_qr ILIKE $${countParamIndex}`;
      countParams.push(`%${search}%`);
    }

    const countResult = await pool.query(countSql, countParams);
    const total = parseInt(countResult.rows[0].total);

    // Add ordering and pagination to main query
    sql += ` ORDER BY pl.created_at DESC LIMIT $${paramIndex + 1} OFFSET $${paramIndex + 2}`;
    params.push(parseInt(limit), offset);

    const result = await pool.query(sql, params);

    res.json({
      success: true,
      data: result.rows,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Error fetching crusher logs:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// 11.5 Get active DN number for current PET crusher shift
router.get('/crusher-active-dn', authenticateToken, async (req, res) => {
  const { shift_id } = req.query;
  if (!shift_id) return res.status(400).json({ success: false, message: 'shift_id is required' });
  try {
    const stationResult = await pool.query("SELECT id FROM stations WHERE code = 'CRS' LIMIT 1");
    if (stationResult.rows.length === 0) return res.json({ success: true, data: { dn_no: null } });
    const crusherStationId = stationResult.rows[0].id;

    const result = await pool.query(
      `SELECT pl.dn_no
       FROM production_logs pl
       JOIN operator_shifts os ON pl.shift_id = os.id
       JOIN material_types mt ON os.material_type_id = mt.id
       WHERE pl.station_id = $1
         AND pl.shift_id = $2
         AND pl.dn_no IS NOT NULL
         AND UPPER(mt.name) = 'PET'
       ORDER BY pl.created_at DESC
       LIMIT 1`,
      [crusherStationId, parseInt(shift_id)]
    );
    res.json({ success: true, data: { dn_no: result.rows[0]?.dn_no ?? null } });
  } catch (error) {
    console.error('Error fetching active DN:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// 12. Get washing line logs with date filter, search, and pagination
router.get('/washing-logs', authenticateToken, async (req, res) => {
  const { subLine, date, search, status, shift_id, page = 1, limit = 10 } = req.query;
  const isPpic = (req.user.role || '').toLowerCase() === 'ppic';
  const materialTypeId = isPpic ? null : req.user.materialTypeId;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  try {
    const stationResult = await pool.query("SELECT id FROM stations WHERE code = 'WSH' LIMIT 1");
    if (stationResult.rows.length === 0) {
      return res.json({ success: true, data: [], pagination: { total: 0, page: 1, limit: 10, totalPages: 0 } });
    }
    const washingStationId = stationResult.rows[0].id;

    let sql = `SELECT pl.*, os.start_time, st.name as shift_name, mt.name as material_name
               FROM production_logs pl
               JOIN operator_shifts os ON pl.shift_id = os.id
               LEFT JOIN shift_types st ON os.shift_type_id = st.id
               LEFT JOIN material_types mt ON os.material_type_id = mt.id
               WHERE pl.station_id = $1`;
    const params = [washingStationId];
    let paramIndex = 1;

    if (materialTypeId) {
      paramIndex++;
      sql += ` AND os.material_type_id = $${paramIndex}`;
      params.push(materialTypeId);
    }

    if (subLine) {
      paramIndex++;
      sql += ` AND pl.sub_line = $${paramIndex}`;
      params.push(subLine);
    }

    if (status) {
      paramIndex++;
      sql += ` AND pl.status = $${paramIndex}`;
      params.push(status);
    }

    // Always apply date filter; optionally narrow by shift_id for "today"
    const washingTargetDate = date || new Date().toISOString().split('T')[0];
    paramIndex++;
    sql += ` AND DATE(pl.created_at) = $${paramIndex}`;
    params.push(washingTargetDate);
    if (shift_id) {
      paramIndex++;
      sql += ` AND pl.shift_id = $${paramIndex}`;
      params.push(parseInt(shift_id));
    }

    if (search) {
      paramIndex++;
      sql += ` AND pl.output_bag_qr ILIKE $${paramIndex}`;
      params.push(`%${search}%`);
    }

    let countSql = `SELECT COUNT(*) as total
                    FROM production_logs pl
                    JOIN operator_shifts os ON pl.shift_id = os.id
                    WHERE pl.station_id = $1`;
    const countParams = [washingStationId];
    let countParamIndex = 1;

    if (materialTypeId) {
      countParamIndex++;
      countSql += ` AND os.material_type_id = $${countParamIndex}`;
      countParams.push(materialTypeId);
    }

    if (subLine) {
      countParamIndex++;
      countSql += ` AND pl.sub_line = $${countParamIndex}`;
      countParams.push(subLine);
    }

    if (status) {
      countParamIndex++;
      countSql += ` AND pl.status = $${countParamIndex}`;
      countParams.push(status);
    }

    countParamIndex++;
    countSql += ` AND DATE(pl.created_at) = $${countParamIndex}`;
    countParams.push(washingTargetDate);
    if (shift_id) {
      countParamIndex++;
      countSql += ` AND pl.shift_id = $${countParamIndex}`;
      countParams.push(parseInt(shift_id));
    }

    if (search) {
      countParamIndex++;
      countSql += ` AND pl.output_bag_qr ILIKE $${countParamIndex}`;
      countParams.push(`%${search}%`);
    }

    const countResult = await pool.query(countSql, countParams);
    const total = parseInt(countResult.rows[0].total);

    // Add ordering and pagination to main query
    sql += ` ORDER BY pl.created_at DESC LIMIT $${paramIndex + 1} OFFSET $${paramIndex + 2}`;
    params.push(parseInt(limit), offset);

    const result = await pool.query(sql, params);

    res.json({
      success: true,
      data: result.rows,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Error fetching washing logs:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// 13. Get extrusion line logs with date filter, search, and pagination
router.get('/extrusion-logs', authenticateToken, async (req, res) => {
  const { subLine, date, search, status, shift_id, page = 1, limit = 10 } = req.query;
  const isPpic = (req.user.role || '').toLowerCase() === 'ppic';
  const materialTypeId = isPpic ? null : req.user.materialTypeId;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  try {
    const stationResult = await pool.query("SELECT id FROM stations WHERE code = 'EXT' OR code = 'EXTR' OR name ILIKE '%extrusion%' LIMIT 1");
    if (stationResult.rows.length === 0) {
      return res.json({ success: true, data: [], pagination: { total: 0, page: 1, limit: 10, totalPages: 0 } });
    }
    const extrusionStationId = stationResult.rows[0].id;

    let sql = `SELECT pl.*, os.start_time, st.name as shift_name, mt.name as material_name
               FROM production_logs pl
               JOIN operator_shifts os ON pl.shift_id = os.id
               LEFT JOIN shift_types st ON os.shift_type_id = st.id
               LEFT JOIN material_types mt ON os.material_type_id = mt.id
               WHERE pl.station_id = $1`;
    const params = [extrusionStationId];
    let paramIndex = 1;

    if (materialTypeId) {
      paramIndex++;
      sql += ` AND os.material_type_id = $${paramIndex}`;
      params.push(materialTypeId);
    }

    if (subLine) {
      paramIndex++;
      sql += ` AND pl.sub_line = $${paramIndex}`;
      params.push(subLine);
    }

    if (status) {
      paramIndex++;
      sql += ` AND pl.status = $${paramIndex}`;
      params.push(status);
    }

    // Always apply date filter; optionally narrow by shift_id for "today"
    const extrusionTargetDate = date || new Date().toISOString().split('T')[0];
    paramIndex++;
    sql += ` AND DATE(pl.created_at) = $${paramIndex}`;
    params.push(extrusionTargetDate);
    if (shift_id) {
      paramIndex++;
      sql += ` AND pl.shift_id = $${paramIndex}`;
      params.push(parseInt(shift_id));
    }

    if (search) {
      paramIndex++;
      sql += ` AND pl.output_bag_qr ILIKE $${paramIndex}`;
      params.push(`%${search}%`);
    }

    let countSql = `SELECT COUNT(*) as total
                    FROM production_logs pl
                    JOIN operator_shifts os ON pl.shift_id = os.id
                    WHERE pl.station_id = $1`;
    const countParams = [extrusionStationId];
    let countParamIndex = 1;

    if (materialTypeId) {
      countParamIndex++;
      countSql += ` AND os.material_type_id = $${countParamIndex}`;
      countParams.push(materialTypeId);
    }

    if (subLine) {
      countParamIndex++;
      countSql += ` AND pl.sub_line = $${countParamIndex}`;
      countParams.push(subLine);
    }

    if (status) {
      countParamIndex++;
      countSql += ` AND pl.status = $${countParamIndex}`;
      countParams.push(status);
    }

    countParamIndex++;
    countSql += ` AND DATE(pl.created_at) = $${countParamIndex}`;
    countParams.push(extrusionTargetDate);
    if (shift_id) {
      countParamIndex++;
      countSql += ` AND pl.shift_id = $${countParamIndex}`;
      countParams.push(parseInt(shift_id));
    }

    if (search) {
      countParamIndex++;
      countSql += ` AND pl.output_bag_qr ILIKE $${countParamIndex}`;
      countParams.push(`%${search}%`);
    }

    const countResult = await pool.query(countSql, countParams);
    const total = parseInt(countResult.rows[0].total);

    // Add ordering and pagination to main query
    sql += ` ORDER BY pl.created_at DESC LIMIT $${paramIndex + 1} OFFSET $${paramIndex + 2}`;
    params.push(parseInt(limit), offset);

    const result = await pool.query(sql, params);

    res.json({
      success: true,
      data: result.rows,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Error fetching extrusion logs:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// 10.9 Final Packing logs
router.get('/final-packing-logs', authenticateToken, async (req, res) => {
  const { date, search, status, shift_id, station_id, page = 1, limit = 10 } = req.query;
  const isPpic = (req.user.role || '').toLowerCase() === 'ppic';
  const materialTypeId = isPpic ? null : req.user.materialTypeId;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  try {
    let stationId;
    const sid = station_id != null && String(station_id).trim() !== '' ? parseInt(String(station_id), 10) : NaN;
    if (!Number.isNaN(sid) && sid > 0) {
      const check = await pool.query('SELECT id FROM stations WHERE id = $1 AND is_active = true', [sid]);
      if (check.rows.length > 0) stationId = sid;
    }
    if (stationId == null) {
      const stationResult = await pool.query(
        `SELECT id FROM stations WHERE is_active = true
         AND (UPPER(TRIM(code)) = 'PKG' OR name ILIKE '%final%' OR name ILIKE '%re-packaging%')
         ORDER BY CASE WHEN UPPER(TRIM(code)) = 'PKG' THEN 0 ELSE 1 END, id ASC
         LIMIT 1`
      );
      if (stationResult.rows.length === 0) {
        return res.json({ success: true, data: [], pagination: { total: 0, page: 1, limit: 10, totalPages: 0 } });
      }
      stationId = stationResult.rows[0].id;
    }

    let sql = `SELECT pl.*, os.start_time, st.name as shift_name, mt.name as material_name
               FROM production_logs pl
               JOIN operator_shifts os ON pl.shift_id = os.id
               LEFT JOIN shift_types st ON os.shift_type_id = st.id
               LEFT JOIN material_types mt ON os.material_type_id = mt.id
               WHERE pl.station_id = $1`;
    const params = [stationId];
    let paramIndex = 1;

    if (materialTypeId) {
      paramIndex++;
      sql += ` AND os.material_type_id = $${paramIndex}`;
      params.push(materialTypeId);
    }

    if (status) {
      paramIndex++;
      sql += ` AND pl.status = $${paramIndex}`;
      params.push(status);
    }

    // Optional shift scope (current shift) + calendar day from date picker.
    // If we only filter by shift_id, multi-day shifts show yesterday's rows while the UI date is "today".
    const packingTargetDate =
      date && String(date).trim() !== ''
        ? String(date).trim().split('T')[0]
        : new Date().toISOString().split('T')[0];
    if (shift_id) {
      paramIndex++;
      sql += ` AND pl.shift_id = $${paramIndex}`;
      params.push(parseInt(shift_id, 10));
    }
    if (date && String(date).trim() !== '') {
      paramIndex++;
      sql += ` AND DATE(pl.created_at) = $${paramIndex}::date`;
      params.push(packingTargetDate);
    } else if (!shift_id) {
      paramIndex++;
      sql += ` AND DATE(pl.created_at) = $${paramIndex}::date`;
      params.push(packingTargetDate);
    }

    if (search) {
      paramIndex++;
      sql += ` AND pl.output_bag_qr ILIKE $${paramIndex}`;
      params.push(`%${search}%`);
    }

    let countSql = `SELECT COUNT(*) as total FROM production_logs pl
                    JOIN operator_shifts os ON pl.shift_id = os.id
                    WHERE pl.station_id = $1`;
    const countParams = [stationId];
    let countParamIndex = 1;

    if (materialTypeId) {
      countParamIndex++;
      countSql += ` AND os.material_type_id = $${countParamIndex}`;
      countParams.push(materialTypeId);
    }
    if (status) {
      countParamIndex++;
      countSql += ` AND pl.status = $${countParamIndex}`;
      countParams.push(status);
    }
    if (shift_id) {
      countParamIndex++;
      countSql += ` AND pl.shift_id = $${countParamIndex}`;
      countParams.push(parseInt(shift_id, 10));
    }
    if (date && String(date).trim() !== '') {
      countParamIndex++;
      countSql += ` AND DATE(pl.created_at) = $${countParamIndex}::date`;
      countParams.push(packingTargetDate);
    } else if (!shift_id) {
      countParamIndex++;
      countSql += ` AND DATE(pl.created_at) = $${countParamIndex}::date`;
      countParams.push(packingTargetDate);
    }
    if (search) {
      countParamIndex++;
      countSql += ` AND pl.output_bag_qr ILIKE $${countParamIndex}`;
      countParams.push(`%${search}%`);
    }

    const countResult = await pool.query(countSql, countParams);
    const total = parseInt(countResult.rows[0].total);

    sql += ` ORDER BY pl.created_at DESC LIMIT $${paramIndex + 1} OFFSET $${paramIndex + 2}`;
    params.push(parseInt(limit), offset);

    const result = await pool.query(sql, params);
    res.json({
      success: true,
      data: result.rows,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), totalPages: Math.ceil(total / parseInt(limit)) }
    });
  } catch (error) {
    console.error('Error fetching final packing logs:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// 10.10 PPIC Station Overview — all stations, per-station logs, grouped
router.get('/ppic-station-overview', authenticateToken, async (req, res) => {
  const { date, shift_type_id, material_type } = req.query;
  const isPpic = (req.user.role || '').toLowerCase() === 'ppic';
  const materialTypeId = isPpic ? null : req.user.materialTypeId;
  const targetDate = date || new Date().toISOString().split('T')[0];

  try {
    let sql = `
      SELECT pl.id, pl.output_bag_qr, pl.weight, pl.status, pl.sub_line, pl.remark, pl.created_at,
             s.id as station_id, s.name as station_name, s.code as station_code,
             st.name as shift_name, u.name as operator_name,
             mt.name as material_type_name
      FROM production_logs pl
      JOIN stations s ON pl.station_id = s.id
      JOIN operator_shifts os ON pl.shift_id = os.id
      LEFT JOIN shift_types st ON os.shift_type_id = st.id
      LEFT JOIN users u ON os.user_id = u.id
      LEFT JOIN material_types mt ON os.material_type_id = mt.id
      WHERE DATE(pl.created_at) = $1
    `;
    const params = [targetDate];
    let paramIndex = 1;

    if (material_type && String(material_type).trim() && String(material_type).trim() !== 'all') {
      paramIndex++;
      sql += ` AND mt.name = $${paramIndex}`;
      params.push(String(material_type).trim());
    } else if (materialTypeId) {
      paramIndex++;
      sql += ` AND os.material_type_id = $${paramIndex}`;
      params.push(materialTypeId);
    }

    if (shift_type_id) {
      paramIndex++;
      sql += ` AND os.shift_type_id = $${paramIndex}`;
      params.push(parseInt(shift_type_id));
    }

    sql += ` ORDER BY s.id ASC, pl.created_at DESC`;

    const result = await pool.query(sql, params);

    // Group by station
    const grouped = {};
    for (const row of result.rows) {
      const key = row.station_id;
      if (!grouped[key]) {
        grouped[key] = {
          station_id: row.station_id,
          station_name: row.station_name,
          station_code: row.station_code,
          logs: [],
          total_bags: 0,
          total_weight: 0,
        };
      }
      grouped[key].logs.push({
        id: row.id,
        output_bag_qr: row.output_bag_qr,
        weight: row.weight,
        status: row.status,
        sub_line: row.sub_line,
        remark: row.remark ?? null,
        created_at: row.created_at,
        shift_name: row.shift_name,
        operator_name: row.operator_name,
        material_type_name: row.material_type_name ?? null,
      });
      grouped[key].total_bags += 1;
      grouped[key].total_weight += parseFloat(row.weight || 0);
    }

    const stations = Object.values(grouped).map((g) => ({
      ...g,
      total_weight: parseFloat(g.total_weight.toFixed(2)),
    }));

    res.json({ success: true, data: stations, date: targetDate });
  } catch (error) {
    console.error('Error fetching PPIC station overview:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

/**
 * Shared flat rows for /logs-all (JSON) and /logs-all-export (CSV download).
 * Query params: date_start, date_end, station_code, sub_line, material_type, shift_type, limit
 */
async function fetchLogsAllFlatRows(query) {
  const { date_start, date_end, station_code, sub_line, material_type, shift_type, operator_id, limit = 500 } = query;
  const params = [];
  const conds = [];

  if (date_start && /^\d{4}-\d{2}-\d{2}$/.test(String(date_start).trim())) {
    params.push(String(date_start).trim());
    conds.push(`pl.created_at::date >= $${params.length}`);
  }
  if (date_end && /^\d{4}-\d{2}-\d{2}$/.test(String(date_end).trim())) {
    params.push(String(date_end).trim());
    conds.push(`pl.created_at::date <= $${params.length}`);
  }
  if (station_code && station_code !== 'all') {
    params.push(String(station_code).toUpperCase().trim());
    conds.push(`s.code = $${params.length}`);
  }
  if (sub_line && sub_line !== 'all') {
    params.push(String(sub_line).trim());
    conds.push(`COALESCE(NULLIF(TRIM(COALESCE(pl.sub_line,'')), ''), 'General') = $${params.length}`);
  }
  if (material_type && material_type !== 'all') {
    params.push(String(material_type).trim());
    conds.push(`mt.name = $${params.length}`);
  }
  if (shift_type && shift_type !== 'all') {
    params.push(String(shift_type).trim());
    conds.push(`sht.name = $${params.length}`);
  }
  if (operator_id && String(operator_id) !== 'all' && /^\d+$/.test(String(operator_id).trim())) {
    params.push(parseInt(String(operator_id).trim(), 10));
    conds.push(`os.user_id = $${params.length}`);
  }

  const where = conds.length ? 'AND ' + conds.join(' AND ') : '';
  params.push(Math.min(parseInt(String(limit), 10) || 500, 25000));
  const limitParam = `$${params.length}`;

  const sql = `
      SELECT
        pl.id,
        pl.created_at,
        COALESCE(NULLIF(TRIM(COALESCE(pl.sub_line,'')), ''), 'General') AS sub_line,
        pl.weight,
        pl.status,
        pl.input_bag_qr,
        pl.output_bag_qr,
        pl.remark,
        pl.used_line,
        pl.used_datetime,
        u.name                          AS operator_name,
        s.name                          AS station_name,
        s.code                          AS station_code,
        COALESCE(mt.name, 'Unknown')    AS material_type,
        COALESCE(sht.name, 'Unknown')   AS shift_type,
        os.start_time                   AS shift_start,
        os.id                           AS shift_id
      FROM production_logs pl
      JOIN operator_shifts os  ON pl.shift_id = os.id
      JOIN users u             ON os.user_id = u.id
      JOIN stations s          ON pl.station_id = s.id
      LEFT JOIN material_types mt  ON os.material_type_id = mt.id
      LEFT JOIN shift_types sht    ON os.shift_type_id = sht.id
      WHERE 1=1
        ${where}
      ORDER BY pl.created_at DESC
      LIMIT ${limitParam}
    `;

  const result = await pool.query(sql, params);
  return result.rows;
}

function csvEscape(val) {
  if (val == null || val === '') return '';
  const s = String(val);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// CSV file download (same filters as logs-all; reliable in browser via Content-Disposition)
router.get('/logs-all-export', authenticateToken, async (req, res) => {
  try {
    const rows = await fetchLogsAllFlatRows(req.query);
    const headers = [
      'ID',
      'Recorded at',
      'Station code',
      'Station',
      'Sub-line',
      'Material type',
      'Shift',
      'Shift ID',
      'Operator',
      'Weight (kg)',
      'Status',
      'Input QR',
      'Output QR',
      'Remark',
    ];
    const lines = [headers.join(',')];
    for (const row of rows) {
      lines.push([
        csvEscape(row.id),
        csvEscape(row.created_at),
        csvEscape(row.station_code),
        csvEscape(row.station_name),
        csvEscape(row.sub_line),
        csvEscape(row.material_type),
        csvEscape(row.shift_type),
        csvEscape(row.shift_id),
        csvEscape(row.operator_name),
        csvEscape(row.weight),
        csvEscape(row.status),
        csvEscape(row.input_bag_qr),
        csvEscape(row.output_bag_qr),
        csvEscape(row.remark),
      ].join(','));
    }
    const csv = '\uFEFF' + lines.join('\r\n');
    const ds = String(req.query.date_start || '').trim().replace(/[^\d-]/g, '') || 'start';
    const de = String(req.query.date_end || '').trim().replace(/[^\d-]/g, '') || 'end';
    const filename = `production-transactions_${ds}_${de}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Export-Row-Count', String(rows.length));
    if (rows.length >= 25000) res.setHeader('X-Export-Truncated', '1');
    res.send(csv);
  } catch (error) {
    console.error('[logs-all-export] ERROR:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 13a. All production logs with filters (for backoffice production-logs page)
// Query params: date_start, date_end, station_code (CRS|WSH|EXT), sub_line, material_type, shift_type, limit
router.get('/logs-all', authenticateToken, async (req, res) => {
  try {
    const rows = await fetchLogsAllFlatRows(req.query);

    // Group by station → sub_line for the response
    const grouped = {};
    for (const row of rows) {
      const stKey = row.station_code || 'OTHER';
      const slKey = row.sub_line || 'General';
      if (!grouped[stKey]) grouped[stKey] = { stationName: row.station_name, stationCode: stKey, subLines: {} };
      if (!grouped[stKey].subLines[slKey]) {
        grouped[stKey].subLines[slKey] = {
          subLine: slKey, logs: [],
          totalWeight: 0, totalOutputs: 0, totalInputs: 0,
        };
      }
      const sl = grouped[stKey].subLines[slKey];
      sl.logs.push({
        id: row.id,
        createdAt: row.created_at,
        weight: Number(row.weight) || 0,
        status: row.status,
        inputBagQr: row.input_bag_qr,
        outputBagQr: row.output_bag_qr,
        remark: row.remark,
        operatorName: row.operator_name,
        materialType: row.material_type,
        shiftType: row.shift_type,
        shiftId: row.shift_id,
        used_line: row.used_line,
        used_datetime: row.used_datetime,
      });
      sl.totalWeight += Number(row.weight) || 0;
      sl.totalOutputs += 1;
      if (row.input_bag_qr) sl.totalInputs += 1;
    }

    // Round weights
    for (const st of Object.values(grouped)) {
      for (const sl of Object.values(st.subLines)) {
        sl.totalWeight = Math.round(sl.totalWeight * 10) / 10;
      }
    }

    res.json({ success: true, data: grouped, total: rows.length });
  } catch (error) {
    console.error('[logs-all] ERROR:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 12c. Production operators — all active line operators (PC/PE/PET), for the export filter.
// Listed regardless of whether they have logs yet, so every line is always selectable.
router.get('/operators', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.name, COALESCE(mt.name, '') AS material_type
      FROM users u
      LEFT JOIN material_types mt ON u.material_type_id = mt.id
      WHERE u.is_active = true
        AND LOWER(COALESCE(u.role, '')) IN ('pc', 'pe', 'pet')
      ORDER BY mt.name NULLS LAST, u.name
    `);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('[operators] ERROR:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 13b. Live active shifts — all currently running operator sessions
router.get('/active-shifts', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        os.id                                            AS shift_id,
        u.id                                             AS operator_id,
        u.name                                           AS operator_name,
        COALESCE(sht.name, 'Unknown')                   AS shift_type,
        COALESCE(mt.name, 'Unknown')                    AS material_type,
        os.start_time,
        COUNT(pl.id)::int                               AS outputs_so_far,
        COALESCE(SUM(pl.weight), 0)::numeric            AS weight_so_far,
        COUNT(CASE WHEN pl.input_bag_qr IS NOT NULL
                        AND pl.input_bag_qr <> '' THEN 1 END)::int AS inputs_so_far,
        COALESCE(
          json_agg(
            DISTINCT jsonb_build_object(
              'station', s.name,
              'station_code', s.code,
              'sub_line', COALESCE(NULLIF(TRIM(COALESCE(pl.sub_line,'')), ''), 'General')
            )
          ) FILTER (WHERE s.id IS NOT NULL),
          '[]'
        ) AS stations_active
      FROM operator_shifts os
      JOIN users u          ON os.user_id = u.id
      LEFT JOIN shift_types sht ON sht.id = os.shift_type_id
      LEFT JOIN material_types mt ON os.material_type_id = mt.id
      LEFT JOIN production_logs pl ON pl.shift_id = os.id
      LEFT JOIN stations s ON pl.station_id = s.id
      WHERE os.is_active = true
      GROUP BY os.id, u.id, u.name, sht.name, mt.name, os.start_time
      ORDER BY os.start_time ASC
    `);

    const shifts = result.rows.map((r) => ({
      shiftId: r.shift_id,
      operatorId: r.operator_id,
      operatorName: r.operator_name,
      shiftType: r.shift_type,
      materialType: r.material_type,
      startTime: r.start_time,
      outputsSoFar: r.outputs_so_far,
      inputsSoFar: r.inputs_so_far,
      weightSoFar: Math.round(Number(r.weight_so_far) * 10) / 10,
      stationsActive: r.stations_active || [],
    }));

    res.json({ success: true, data: shifts, count: shifts.length });
  } catch (error) {
    console.error('[active-shifts] ERROR:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 14. Dashboard summary: station sub-line breakdown + operator performance
// Query params: date_start, date_end, material_type (name), shift_name ("Shift 1"|"Shift 2"|"Shift 3")
router.get('/dashboard-summary', authenticateToken, async (req, res) => {
  const { date_start, date_end, material_type, shift_name } = req.query;
  try {
    // ── Step 1: Build WHERE conditions (no pre-fetch of station IDs needed)
    const params = [];
    const conds = [];

    const push = (val, sql) => { params.push(val); conds.push(sql.replace('$?', `$${params.length}`)); };

    if (date_start && /^\d{4}-\d{2}-\d{2}$/.test(String(date_start).trim()))
      push(String(date_start).trim(), 'os.start_time::date >= $?');
    if (date_end && /^\d{4}-\d{2}-\d{2}$/.test(String(date_end).trim()))
      push(String(date_end).trim(), 'os.start_time::date <= $?');
    if (material_type && material_type !== 'all')
      push(String(material_type).trim(), 'mt.name = $?');
    if (shift_name && shift_name !== 'all') {
      const m = String(shift_name).match(/(\d)$/);
      if (m) push(Number(m[1]), 'os.shift_type_id = $?');
    }

    const whereClause = conds.length ? 'AND ' + conds.join(' AND ') : '';

    // ── Step 2: Station query — direct JOIN on stations, classify by name/code
    //    Works regardless of what codes are stored in the DB
    const stationSql = `
      SELECT
        s.id                                                      AS station_id,
        s.name                                                    AS station_name,
        LOWER(s.name)                                             AS station_key_raw,
        s.code                                                    AS station_code,
        COALESCE(NULLIF(TRIM(pl.sub_line::text), ''), 'General') AS sub_line,
        COALESCE(sht.name, 'Unknown')                            AS shift_name,
        MAX(mt.name)                                             AS material_type_name,
        COUNT(*)::int                                            AS outputs,
        COUNT(CASE WHEN pl.input_bag_qr IS NOT NULL
                        AND pl.input_bag_qr <> '' THEN 1 END)::int AS inputs,
        COALESCE(SUM(pl.weight), 0)::numeric                    AS weight
      FROM production_logs pl
      JOIN stations s         ON s.id = pl.station_id
      JOIN operator_shifts os ON pl.shift_id = os.id
      LEFT JOIN shift_types sht ON sht.id = os.shift_type_id
      LEFT JOIN material_types mt ON os.material_type_id = mt.id
      WHERE 1=1
        ${whereClause}
        -- Pellet Packing: only count finished (Completed) bags; all other stations count every status
        AND (
          NOT (UPPER(COALESCE(s.code, '')) = 'PLT' OR LOWER(COALESCE(s.name, '')) LIKE '%pellet pack%')
          OR pl.status = 'Completed'
        )
      GROUP BY s.id, s.name, s.code, sub_line, sht.name
      ORDER BY s.name, weight DESC
    `;

    // ── Step 3: Operator performance query
    const operatorSql = `
      SELECT
        u.id                             AS operator_id,
        u.name                           AS operator_name,
        COUNT(DISTINCT os.id)::int       AS shift_count,
        COALESCE(SUM(pl.weight), 0)::numeric AS total_weight,
        MAX(os.start_time)               AS last_shift
      FROM operator_shifts os
      JOIN users u ON os.user_id = u.id
      LEFT JOIN production_logs pl ON pl.shift_id = os.id
      LEFT JOIN material_types mt  ON os.material_type_id = mt.id
      WHERE 1=1
        ${whereClause}
      GROUP BY u.id, u.name
      ORDER BY total_weight DESC
      LIMIT 30
    `;

    const [stationResult, operatorResult] = await Promise.all([
      pool.query(stationSql, params),
      pool.query(operatorSql, params),
    ]);

    const stationMap = {};
    for (const row of stationResult.rows) {
      const stKey =
        classifyDashboardStation(
          row.station_name,
          row.station_code,
          row.sub_line,
          row.material_type_name || material_type,
        ) ||
        (row.station_name || '')
          .toLowerCase()
          .replace(/\s+/g, '_')
          .replace(/[^a-z0-9_]/g, '') ||
        'other';

      if (!stationMap[stKey]) {
        stationMap[stKey] = {
          stationName: row.station_name,  // use actual DB name
          totalOutputs: 0,
          totalInputs: 0,
          totalWeight: 0,
          byShift: {},
          subLines: {},
        };
      }

      const subLine = String(row.sub_line);
      const shiftName = String(row.shift_name);
      const outputs = parseInt(row.outputs, 10) || 0;
      const inputs = parseInt(row.inputs, 10) || 0;
      const weight = Number(row.weight) || 0;

      stationMap[stKey].totalOutputs += outputs;
      stationMap[stKey].totalInputs += inputs;
      stationMap[stKey].totalWeight += weight;

      // Sub-lines
      if (!stationMap[stKey].subLines[subLine]) {
        stationMap[stKey].subLines[subLine] = { outputs: 0, inputs: 0, weight: 0 };
      }
      stationMap[stKey].subLines[subLine].outputs += outputs;
      stationMap[stKey].subLines[subLine].inputs += inputs;
      stationMap[stKey].subLines[subLine].weight += weight;

      // By shift
      if (!stationMap[stKey].byShift[shiftName]) {
        stationMap[stKey].byShift[shiftName] = { outputs: 0, inputs: 0, weight: 0 };
      }
      stationMap[stKey].byShift[shiftName].outputs += outputs;
      stationMap[stKey].byShift[shiftName].inputs += inputs;
      stationMap[stKey].byShift[shiftName].weight += weight;
    }

    // ── Step 5: Round weights
    for (const st of Object.values(stationMap)) {
      st.totalWeight = Number(st.totalWeight.toFixed(1));
      for (const sl of Object.values(st.subLines)) sl.weight = Number(sl.weight.toFixed(1));
      for (const sh of Object.values(st.byShift)) sh.weight = Number(sh.weight.toFixed(1));
    }

    // ── Step 6: Operators
    const operators = operatorResult.rows.map((r) => ({
      id: r.operator_id,
      name: r.operator_name,
      shiftCount: parseInt(r.shift_count, 10) || 0,
      totalWeight: Number(Number(r.total_weight).toFixed(1)),
      avgPerShift: parseInt(r.shift_count, 10) > 0
        ? Number((Number(r.total_weight) / parseInt(r.shift_count, 10)).toFixed(1))
        : 0,
      lastShift: r.last_shift ? new Date(r.last_shift).toLocaleDateString('en-CA') : null,
    }));

    res.json({ success: true, data: { stations: stationMap, operators } });
  } catch (error) {
    console.error('Error fetching dashboard summary:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;
