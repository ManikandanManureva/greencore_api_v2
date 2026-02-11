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
  const { shiftTypeId } = req.body;
  const userId = req.user.id;
  const materialTypeId = req.user.materialTypeId;

  if (!materialTypeId) {
    return res.status(400).json({
      success: false,
      message: 'User does not have an assigned material role (PC, PE, PET). Please contact administrator.'
    });
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
      [userId, shiftTypeId, materialTypeId]
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
    const { stationId, shiftId, subLine } = req.query; // subLine: '3E' or 'Rapid'

    if (!stationId || !shiftId) {
      return res.status(400).json({ success: false, message: 'stationId and shiftId are required' });
    }

    // Get shift details
    const shiftInfo = await pool.query(
      `SELECT st.name as shift_name, os.start_time, mt.name as material_name
       FROM operator_shifts os
       LEFT JOIN shift_types st ON os.shift_type_id = st.id
       LEFT JOIN material_types mt ON os.material_type_id = mt.id
       WHERE os.id = $1`,
      [shiftId]
    );

    if (shiftInfo.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'Shift not found.' });
    }

    const { shift_name, start_time, material_name } = shiftInfo.rows[0];
    const shiftDate = new Date(start_time);
    const year = shiftDate.getFullYear();
    const month = String(shiftDate.getMonth() + 1).padStart(2, '0');
    const date = String(shiftDate.getDate()).padStart(2, '0');

    const shiftMap = { 'Shift 1': '1', 'Shift 2': '2', 'Shift 3': '3' };
    const shiftNum = shiftMap[shift_name] || '1';

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
    } else if ((stationCode === 'EXT' || stationCode === 'EXTR') && subLine) {
      // Handle Extrusion sub-lines
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
    const increment = String(parseInt(countResult.rows[0].count) + 1).padStart(3, '0');
    const materialCode = material_name || 'XX';

    const nextQr = `${year}${month}${date}-${materialCode}-S${shiftNum}-${finalStationCode}-${increment}`;

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
  const { shiftId, stationId, inputBagQr, outputBagQr, weight, photoUrl, status, subLine, remark } = req.body;
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
        `SELECT st.name as shift_name, os.start_time, mt.name as material_name
         FROM operator_shifts os
         LEFT JOIN shift_types st ON os.shift_type_id = st.id
         LEFT JOIN material_types mt ON os.material_type_id = mt.id
         WHERE os.id = $1`,
        [shiftId]
      );

      if (shiftInfo.rows.length === 0) {
        return res.status(400).json({ success: false, message: 'Shift data incomplete.' });
      }

      const { shift_name, start_time, material_name } = shiftInfo.rows[0];
      const shiftDate = new Date(start_time);
      const year = shiftDate.getFullYear();
      const month = String(shiftDate.getMonth() + 1).padStart(2, '0');
      const date = String(shiftDate.getDate()).padStart(2, '0');

      const shiftMap = { 'Shift 1': '1', 'Shift 2': '2', 'Shift 3': '3' };
      const shiftNum = shiftMap[shift_name] || '1';

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
      } else if ((stationCode === 'EXT' || stationCode === 'EXTR') && subLine) {
        // Handle Extrusion sub-lines
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
router.get('/closed-shifts', authenticateToken, async (req, res) => {
  const { limit = 30 } = req.query;
  try {
    const stationIds = await getStationIdsByCode();
    const result = await pool.query(
      `SELECT os.id, os.start_time, os.end_time, st.name AS shift_name, u.name AS operator_name
       FROM operator_shifts os
       LEFT JOIN shift_types st ON st.id = os.shift_type_id
       LEFT JOIN users u ON u.id = os.user_id
       WHERE os.is_active = false
       ORDER BY os.end_time DESC NULLS LAST, os.start_time DESC
       LIMIT $1`,
      [Math.min(parseInt(limit, 10) || 30, 100)]
    );
    const list = await Promise.all(result.rows.map(async (row) => {
      const byStation = { crusher: { outputs: 0, weight: '0.0' }, washing: { outputs: 0, weight: '0.0' }, extrusion: { outputs: 0, weight: '0.0' } };
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
      const dateStr = row.start_time ? new Date(row.start_time).toLocaleDateString() : '';
      return {
        shiftId: row.id,
        shiftName: (row.shift_name && String(row.shift_name).trim()) ? String(row.shift_name).trim() : 'Shift',
        operatorName: row.operator_name || 'N/A',
        date: dateStr,
        totalOutputs,
        totalWeight,
        byStation,
      };
    }));
    res.json({ success: true, data: list });
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

module.exports = router;
