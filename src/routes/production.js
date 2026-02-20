const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

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
  const materialTypeId = req.user.materialTypeId;

  try {
    let result;
    if (materialTypeId) {
      // Get stations mapped to this user's material flow
      result = await pool.query(
        `SELECT s.* FROM stations s
         JOIN material_flow_stations mfs ON s.id = mfs.station_id
         WHERE mfs.material_type_id = $1 AND s.is_active = true
         ORDER BY s.order_index`,
        [materialTypeId]
      );
    } else {
      // Fallback to all active stations
      result = await pool.query(
        'SELECT * FROM stations WHERE is_active = true ORDER BY order_index'
      );
    }
    res.json({ success: true, data: result.rows });
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
    let query = 'SELECT * FROM operator_shifts WHERE user_id = $1 AND is_active = true';
    const params = [userId];

    if (shiftTypeId) {
      params.push(shiftTypeId);
      query += ` AND shift_type_id = $${params.length}`;
    }

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

// 7. Check shift status
router.get('/shift-status/:shiftId', authenticateToken, async (req, res) => {
  const { shiftId } = req.params;
  const userId = req.user.id;

  try {
    const result = await pool.query(
      `SELECT id, is_active, start_time, end_time, user_id 
       FROM operator_shifts 
       WHERE id = $1 AND user_id = $2`,
      [shiftId, userId]
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
      console.log(`Shift ${shiftId} is already ended`);
      return res.status(400).json({ success: false, message: 'Shift is already ended' });
    }

    // Now end the shift (save optional end_remark)
    const result = await pool.query(
      `UPDATE operator_shifts 
       SET is_active = false, end_time = CURRENT_TIMESTAMP, end_remark = $1
       WHERE id = $2 AND user_id = $3 AND is_active = true
       RETURNING *`,
      [remark && String(remark).trim() ? String(remark).trim() : null, shiftId, userId]
    );

    if (result.rows.length === 0) {
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

    // Get Station Code and Name from DB
    const stationResult = await pool.query('SELECT code, name FROM stations WHERE id = $1', [stationId]);
    const stationCode = stationResult.rows[0]?.code || 'UNK';
    const stationName = stationResult.rows[0]?.name || '';

    // Handle Sub-line for Crusher and Washing
    let finalStationCode = stationCode;
    let stationDisplayName = stationName;
    if (stationCode === 'CRS' && subLine) {
      if (subLine === '3E') {
        finalStationCode = 'C3E';
      } else if (subLine === 'Rapid') {
        finalStationCode = 'CRP';
      } else if (subLine === 'Betty') {
        finalStationCode = 'CBT';
      } else {
        finalStationCode = 'CRP'; // Default fallback
      }
      stationDisplayName = `${stationName}-${subLine}`;
    } else if (stationCode === 'WSH' && subLine) {
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
    } else if ((stationCode === 'EXT' || stationCode === 'EXTR' || (stationName && String(stationName).toLowerCase().includes('extrusion'))) && subLine) {
      // Handle Extrusion sub-lines (by code or by station name)
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
      }
    }

    // Count for increment
    const countResult = await pool.query(
      `SELECT COUNT(*) as count 
       FROM production_logs 
       WHERE station_id = $1 AND created_at >= CURRENT_DATE`,
      [stationId]
    );
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
  const { shiftId, stationId, inputBagQr, outputBagQr, weight, photoUrl, status, subLine, remark, shiftTypeId: shiftTypeIdBody } = req.body;
  const materialTypeId = req.user.materialTypeId;

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

      // Handle Sub-line for Crusher, Washing, and Extrusion
      let finalStationCode = stationCode;
      if (stationCode === 'CRS' && subLine) {
        if (subLine === '3E') {
          finalStationCode = 'C3E';
        } else if (subLine === 'Rapid') {
          finalStationCode = 'CRP';
        } else if (subLine === 'Betty') {
          finalStationCode = 'CBT';
        } else {
          finalStationCode = 'CRP'; // Default fallback
        }
      } else if (stationCode === 'WSH' && subLine) {
        if (subLine === 'Washing 1') finalStationCode = 'W1';
        else if (subLine === 'Washing 2') finalStationCode = 'W2';
        else if (subLine === 'Washing 3') finalStationCode = 'W3';
      } else if ((stationCode === 'EXT' || stationCode === 'EXTR' || (stationName && String(stationName).toLowerCase().includes('extrusion'))) && subLine) {
        if (subLine === 'Extrusion 1') finalStationCode = 'E1';
        else if (subLine === 'Extrusion 2') finalStationCode = 'E2';
        else if (subLine === 'Extrusion 3') finalStationCode = 'E3';
        else if (subLine === 'Mixture') finalStationCode = 'MIX';
      }

      // Count for increment
      const countResult = await pool.query(
        `SELECT COUNT(*) as count 
         FROM production_logs pl
         JOIN operator_shifts os ON pl.shift_id = os.id
         WHERE os.shift_type_id = (SELECT shift_type_id FROM operator_shifts WHERE id = $1)
           AND pl.station_id = $2
           AND os.start_time::date = $3::date`,
        [shiftId, stationId, start_time]
      );

      const increment = String(parseInt(countResult.rows[0].count) + 1).padStart(3, '0');

      // Proper QR format including Material Code, without line
      const materialCode = material_name || 'PC';
      finalOutputBagQr = `${year}${month}${date}-${materialCode}-S${shiftNum}-${finalStationCode}-${increment}`;
    }

    // Worker chooses status by jumbo bag type: temporary → pending, final → Completed
    let finalStatus;
    const isCrusher = stationCode === 'CRS' || stationName.toLowerCase().includes('crusher');
    const isWashing = stationCode === 'WSH' || stationName.toLowerCase().includes('washing');
    const isExtrusion = stationCode === 'EXT' || stationCode === 'EXTR' || stationName.toLowerCase().includes('extrusion');
    if (isCrusher || isWashing || isExtrusion) {
      // Use worker-selected status (pending = temporary jumbo bag, Completed = final jumbo bag) or default pending
      finalStatus = (status === 'Completed' || status === 'completed') ? 'Completed' : 'pending';
    } else {
      finalStatus = status || 'Completed';
    }

    const result = await pool.query(
      `INSERT INTO production_logs (shift_id, station_id, material_type_id, input_bag_qr, output_bag_qr, weight, photo_url, status, sub_line, remark)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [shiftId, stationId, materialTypeId, inputBagQr, finalOutputBagQr, weight, photoUrl, finalStatus, subLine, remark || null]
    );

    res.json({ success: true, message: 'Log recorded successfully', data: result.rows[0] });
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
  } = req.query;
  // Legacy shiftTypeId filter (mobile app)
  const shiftTypeIdFilter = req.query.shiftTypeId ?? req.query.shifttypeid;
  try {
    const stationIds = await getStationIdsByCode();
    const params = [];
    const conds = ['os.is_active = false'];

    // Date range (new API)
    if (date_start && /^\d{4}-\d{2}-\d{2}$/.test(String(date_start).trim())) {
      params.push(String(date_start).trim());
      conds.push(`os.start_time::date >= $${params.length}::date`);
    } else if (dateFilterLegacy && /^\d{4}-\d{2}-\d{2}$/.test(String(dateFilterLegacy).trim())) {
      params.push(String(dateFilterLegacy).trim());
      conds.push(`os.start_time::date = $${params.length}::date`);
    }
    if (date_end && /^\d{4}-\d{2}-\d{2}$/.test(String(date_end).trim())) {
      params.push(String(date_end).trim());
      conds.push(`os.start_time::date <= $${params.length}::date`);
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

    const where = conds.join(' AND ');

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

    const sql = `SELECT os.id, os.start_time, os.end_time, os.end_remark,
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
      const byStation = {
        crusher: { outputs: 0, weight: '0.0' },
        washing: { outputs: 0, weight: '0.0' },
        extrusion: { outputs: 0, weight: '0.0' },
      };
      for (const [key, stationId] of Object.entries(stationIds)) {
        if (!stationId) continue;
        const logs = await pool.query(
          'SELECT COUNT(*) AS cnt, COALESCE(SUM(weight), 0) AS tot FROM production_logs WHERE shift_id = $1 AND station_id = $2',
          [row.id, stationId]
        );
        byStation[key].outputs = parseInt(logs.rows[0]?.cnt || 0, 10);
        byStation[key].weight = String(Number(logs.rows[0]?.tot || 0).toFixed(1));
      }
      const totalOutputs = byStation.crusher.outputs + byStation.washing.outputs + byStation.extrusion.outputs;
      const totalWeight = (Number(byStation.crusher.weight) + Number(byStation.washing.weight) + Number(byStation.extrusion.weight)).toFixed(1);
      return {
        shiftId: row.id,
        shiftName: (row.shift_name && String(row.shift_name).trim()) ? String(row.shift_name).trim() : 'Shift',
        operatorName: row.operator_name || 'N/A',
        materialTypeName: (row.material_type_name && String(row.material_type_name).trim()) ? String(row.material_type_name).trim() : null,
        startTime: row.start_time,
        endTime: row.end_time,
        endRemark: row.end_remark || '',
        date: row.start_time ? new Date(row.start_time).toLocaleDateString() : '',
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
      `SELECT os.id, os.start_time, st.name AS shift_name, u.name AS operator_name, os.end_remark
       FROM operator_shifts os
       LEFT JOIN shift_types st ON st.id = os.shift_type_id
       LEFT JOIN users u ON u.id = os.user_id
       WHERE os.id = $1 AND os.is_active = false`,
      [shiftId]
    );
    if (shiftRow.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Closed shift not found' });
    }
    const row = shiftRow.rows[0];
    const stationIds = await getStationIdsByCode();
    const byStation = { crusher: { outputs: 0, weight: '0.0' }, washing: { outputs: 0, weight: '0.0' }, extrusion: { outputs: 0, weight: '0.0' } };
    for (const [key, stationId] of Object.entries(stationIds)) {
      if (!stationId) continue;
      const logs = await pool.query(
        'SELECT COUNT(*) AS cnt, COALESCE(SUM(weight), 0) AS tot FROM production_logs WHERE shift_id = $1 AND station_id = $2',
        [shiftId, stationId]
      );
      byStation[key].outputs = parseInt(logs.rows[0]?.cnt || 0, 10);
      byStation[key].weight = String(Number(logs.rows[0]?.tot || 0).toFixed(1));
    }
    const totalOutputs = byStation.crusher.outputs + byStation.washing.outputs + byStation.extrusion.outputs;
    const totalWeight = (Number(byStation.crusher.weight) + Number(byStation.washing.weight) + Number(byStation.extrusion.weight)).toFixed(1);
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
        date: row.start_time ? new Date(row.start_time).toLocaleDateString() : '',
        totalOutputs,
        totalWeight,
        byStation,
        remark: row.end_remark || '',
        byProducts,
      },
    });
  } catch (error) {
    console.error('Error fetching closed shift summary:', error);
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
  const { query, stationId, targetStationId: targetStationIdParam, currentStationId, status } = req.query;
  const materialTypeId = req.user.materialTypeId;

  try {
    // Support both targetStationId (frontend) and stationId (legacy). E.g. extrusion uses
    // targetStationId=3&currentStationId=49&status=pending; final packing uses only
    // query&currentStationId=50 (no targetStationId → "all station batch").
    let targetStationId = targetStationIdParam || stationId;
    let targetStatus = status;

    // Always check currentStationId first to determine if we're searching from Washing or Extrusion station
    if (currentStationId) {
      const currentStationResult = await pool.query(
        "SELECT code FROM stations WHERE id = $1 LIMIT 1",
        [currentStationId]
      );

      if (currentStationResult.rows.length > 0) {
        const currentStationCode = currentStationResult.rows[0].code;

        // If current station is Washing, search for Crusher batches with pending status
        if (currentStationCode === 'WSH') {
          const crusherStationResult = await pool.query("SELECT id FROM stations WHERE code = 'CRS' LIMIT 1");
          if (crusherStationResult.rows.length > 0) {
            targetStationId = crusherStationResult.rows[0].id; // Override with Crusher station ID
            targetStatus = targetStatus || 'pending'; // Default to 'pending' if not explicitly specified
          }
        }

        // If current station is Extrusion, search for Washing batches with pending status
        if (currentStationCode === 'EXT' || currentStationCode === 'EXTR') {
          const washingStationResult = await pool.query("SELECT id FROM stations WHERE code = 'WSH' LIMIT 1");
          if (washingStationResult.rows.length > 0) {
            targetStationId = washingStationResult.rows[0].id; // Override with Washing station ID
            targetStatus = targetStatus || 'pending'; // Default to 'pending' if not explicitly specified
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
    if (query && query.trim().length > 0) {
      paramIndex++;
      sql += ` AND pl.output_bag_qr ILIKE $${paramIndex}`;
      params.push(`%${query}%`);
    }

    // Filter by material type (Role). Use COALESCE so logs with pl.material_type_id
    // (or NULL) match when shift material type matches user.
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

    // Exclude bags that are already processing at the current station.
    // Use NOT EXISTS instead of NOT IN to avoid NULL edge cases.
    if (currentStationId) {
      paramIndex++;
      sql += ` AND NOT EXISTS (
        SELECT 1 FROM production_logs px
        WHERE px.station_id = $${paramIndex}
          AND px.status = 'Processing'
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
    sql += ` ORDER BY pl.created_at DESC LIMIT 20`;

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

  if (isNaN(weight) || weight < 0) {
    return res.status(400).json({ success: false, message: 'Weight must be a valid positive number' });
  }

  try {
    const result = await pool.query(
      `UPDATE production_logs 
       SET weight = $1
       WHERE id = $2
       RETURNING *`,
      [weight, logId]
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
  const { subLine, date, search, status, page = 1, limit = 10 } = req.query;
  const materialTypeId = req.user.materialTypeId;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  try {
    // Get Crusher station ID (assuming ID 2)
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

    // Filter by material type (Role)
    if (materialTypeId) {
      paramIndex++;
      sql += ` AND os.material_type_id = $${paramIndex}`;
      params.push(materialTypeId);
    }

    // Filter by sub-line (3E or Rapid)
    if (subLine) {
      paramIndex++;
      sql += ` AND pl.sub_line = $${paramIndex}`;
      params.push(subLine);
    }

    // Filter by status (pending, processing, Completed)
    if (status) {
      paramIndex++;
      sql += ` AND pl.status = $${paramIndex}`;
      params.push(status);
    }

    // Filter by date (default to current date if not provided)
    const targetDate = date || new Date().toISOString().split('T')[0];
    paramIndex++;
    sql += ` AND DATE(pl.created_at) = $${paramIndex}`;
    params.push(targetDate);

    // Search filter (by QR code)
    if (search) {
      paramIndex++;
      sql += ` AND pl.output_bag_qr ILIKE $${paramIndex}`;
      params.push(`%${search}%`);
    }

    // Get total count for pagination (build count query separately)
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
      countSql += ` AND pl.sub_line = $${countParamIndex}`;
      countParams.push(subLine);
    }

    if (status) {
      countParamIndex++;
      countSql += ` AND pl.status = $${countParamIndex}`;
      countParams.push(status);
    }

    // Use the targetDate already declared above
    countParamIndex++;
    countSql += ` AND DATE(pl.created_at) = $${countParamIndex}`;
    countParams.push(targetDate);

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

// 12. Get washing line logs with date filter, search, and pagination
router.get('/washing-logs', authenticateToken, async (req, res) => {
  const { subLine, date, search, status, page = 1, limit = 10 } = req.query;
  const materialTypeId = req.user.materialTypeId;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  try {
    // Get Washing station ID from database by code
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

    // Filter by material type (Role)
    if (materialTypeId) {
      paramIndex++;
      sql += ` AND os.material_type_id = $${paramIndex}`;
      params.push(materialTypeId);
    }

    // Filter by sub-line (Washing 1, Washing 2, Washing 3)
    if (subLine) {
      paramIndex++;
      sql += ` AND pl.sub_line = $${paramIndex}`;
      params.push(subLine);
    }

    // Filter by status (pending, processing, Completed)
    if (status) {
      paramIndex++;
      sql += ` AND pl.status = $${paramIndex}`;
      params.push(status);
    }

    // Filter by date (default to current date if not provided)
    const targetDate = date || new Date().toISOString().split('T')[0];
    paramIndex++;
    sql += ` AND DATE(pl.created_at) = $${paramIndex}`;
    params.push(targetDate);

    // Search filter (by QR code)
    if (search) {
      paramIndex++;
      sql += ` AND pl.output_bag_qr ILIKE $${paramIndex}`;
      params.push(`%${search}%`);
    }

    // Get total count for pagination (build count query separately)
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

    // Use the targetDate already declared above
    countParamIndex++;
    countSql += ` AND DATE(pl.created_at) = $${countParamIndex}`;
    countParams.push(targetDate);

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
  const { subLine, date, search, status, page = 1, limit = 10 } = req.query;
  const materialTypeId = req.user.materialTypeId;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  try {
    // Get Extrusion station ID from database by code (try common codes)
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

    // Filter by material type (Role)
    if (materialTypeId) {
      paramIndex++;
      sql += ` AND os.material_type_id = $${paramIndex}`;
      params.push(materialTypeId);
    }

    // Filter by sub-line (Extrusion 1, Extrusion 2, Extrusion 3)
    if (subLine) {
      paramIndex++;
      sql += ` AND pl.sub_line = $${paramIndex}`;
      params.push(subLine);
    }

    // Filter by status (pending, processing, Completed)
    if (status) {
      paramIndex++;
      sql += ` AND pl.status = $${paramIndex}`;
      params.push(status);
    }

    // Filter by date (default to current date if not provided)
    const targetDate = date || new Date().toISOString().split('T')[0];
    paramIndex++;
    sql += ` AND DATE(pl.created_at) = $${paramIndex}`;
    params.push(targetDate);

    // Search filter (by QR code)
    if (search) {
      paramIndex++;
      sql += ` AND pl.output_bag_qr ILIKE $${paramIndex}`;
      params.push(`%${search}%`);
    }

    // Get total count for pagination (build count query separately)
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

    // Use the targetDate already declared above
    countParamIndex++;
    countSql += ` AND DATE(pl.created_at) = $${countParamIndex}`;
    countParams.push(targetDate);

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

// 13a. All production logs with filters (for backoffice production-logs page)
// Query params: date_start, date_end, station_code (CRS|WSH|EXT), sub_line, material_type, shift_type, limit
router.get('/logs-all', authenticateToken, async (req, res) => {
  const { date_start, date_end, station_code, sub_line, material_type, shift_type, limit = 500 } = req.query;
  try {
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

    const where = conds.length ? 'AND ' + conds.join(' AND ') : '';
    params.push(Math.min(parseInt(String(limit), 10) || 500, 1000));
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

    // Group by station → sub_line for the response
    const grouped = {};
    for (const row of result.rows) {
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

    res.json({ success: true, data: grouped, total: result.rows.length });
  } catch (error) {
    console.error('[logs-all] ERROR:', error.message);
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
    // ── Step 1: Get actual station IDs (same reliable helper used by closed-shifts)
    const stIds = await getStationIdsByCode();
    const allStationIds = Object.values(stIds).filter(Boolean);

    // ── Step 2: Build filter params (shared between station & operator queries)
    //    filterParams are positioned at offset +1 for station query ($1 = station array)
    //    and at offset 0 for operator query ($1 = first filter)
    const filterParams = [];
    const stationConds = [];  // with $2, $3, ...
    const opConds = [];       // with $1, $2, ...

    const addFilter = (value, sql) => {
      filterParams.push(value);
      const idx = filterParams.length;
      stationConds.push(sql.replace('$?', `$${idx + 1}`));
      opConds.push(sql.replace('$?', `$${idx}`));
    };

    if (date_start && /^\d{4}-\d{2}-\d{2}$/.test(String(date_start).trim())) {
      addFilter(String(date_start).trim(), 'os.start_time::date >= $?');
    }
    if (date_end && /^\d{4}-\d{2}-\d{2}$/.test(String(date_end).trim())) {
      addFilter(String(date_end).trim(), 'os.start_time::date <= $?');
    }
    if (material_type && material_type !== 'all') {
      addFilter(String(material_type).trim(), 'mt.name = $?');
    }
    if (shift_name && shift_name !== 'all') {
      const m = String(shift_name).match(/(\d)$/);
      if (m) addFilter(Number(m[1]), 'os.shift_type_id = $?');
    }

    const stationWhereExtra = stationConds.length ? 'AND ' + stationConds.join(' AND ') : '';
    const opWhereExtra = opConds.length ? 'AND ' + opConds.join(' AND ') : '';
    const stationParams = [allStationIds, ...filterParams];
    const opParams = [...filterParams];

    // ── Step 3: Station sub-line + shift query (uses station IDs for reliability)
    const stationSql = allStationIds.length > 0 ? `
      SELECT
        pl.station_id,
        COALESCE(NULLIF(TRIM(pl.sub_line::text), ''), 'General') AS sub_line,
        COALESCE(sht.name, 'Unknown')                            AS shift_name,
        COUNT(*)::int                                            AS outputs,
        COUNT(CASE WHEN pl.input_bag_qr IS NOT NULL
                        AND pl.input_bag_qr <> '' THEN 1 END)::int AS inputs,
        COALESCE(SUM(pl.weight), 0)::numeric                    AS weight
      FROM production_logs pl
      JOIN operator_shifts os  ON pl.shift_id = os.id
      LEFT JOIN shift_types sht ON sht.id = os.shift_type_id
      LEFT JOIN material_types mt ON os.material_type_id = mt.id
      WHERE pl.station_id = ANY($1::int[])
        ${stationWhereExtra}
      GROUP BY pl.station_id, sub_line, sht.name
      ORDER BY pl.station_id, weight DESC
    ` : null;

    // ── Step 4: Operator performance query
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
        ${opWhereExtra}
      GROUP BY u.id, u.name
      ORDER BY total_weight DESC
      LIMIT 30
    `;

    const [stationResult, operatorResult] = await Promise.all([
      stationSql ? pool.query(stationSql, stationParams) : Promise.resolve({ rows: [] }),
      pool.query(operatorSql, opParams),
    ]);

    // ── Step 5: Build station map using ID → key reverse lookup
    const idToKey = {};
    for (const [key, id] of Object.entries(stIds)) {
      if (id != null) idToKey[id] = key;
    }

    const stationMap = {};
    for (const row of stationResult.rows) {
      const stKey = idToKey[row.station_id];
      if (!stKey) continue;

      if (!stationMap[stKey]) {
        stationMap[stKey] = {
          stationName: stKey.charAt(0).toUpperCase() + stKey.slice(1),
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

    // ── Step 6: Round weights
    for (const st of Object.values(stationMap)) {
      st.totalWeight = Number(st.totalWeight.toFixed(1));
      for (const sl of Object.values(st.subLines)) sl.weight = Number(sl.weight.toFixed(1));
      for (const sh of Object.values(st.byShift)) sh.weight = Number(sh.weight.toFixed(1));
    }

    // ── Step 7: Operators
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
