const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

// 1. Get all active production lines
router.get('/lines', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM production_lines WHERE is_active = true ORDER BY id'
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Error fetching production lines:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

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

// 4. Get all active stations
router.get('/stations', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM stations WHERE is_active = true ORDER BY order_index'
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Error fetching stations:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// 5. Start a shift session
router.post('/start-shift', authenticateToken, async (req, res) => {
  const { lineId, shiftTypeId, materialTypeId } = req.body;
  const userId = req.user.userId;

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
      `INSERT INTO operator_shifts (user_id, line_id, shift_type_id, material_type_id, is_active)
       VALUES ($1, $2, $3, $4, true)
       RETURNING *`,
      [userId, lineId, shiftTypeId, materialTypeId]
    );

    res.json({ success: true, message: 'Shift started successfully', data: result.rows[0] });
  } catch (error) {
    console.error('Error starting shift:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// 6. Check shift status
router.get('/shift-status/:shiftId', authenticateToken, async (req, res) => {
  const { shiftId } = req.params;
  const userId = req.user.userId;

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
  const userId = req.user.userId;

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

    // Now end the shift
    const result = await pool.query(
      `UPDATE operator_shifts 
       SET is_active = false, end_time = CURRENT_TIMESTAMP 
       WHERE id = $1 AND user_id = $2 AND is_active = true
       RETURNING *`,
      [shiftId, userId]
    );

    if (result.rows.length === 0) {
      console.log(`Failed to end shift ${shiftId} - no rows updated`);
      return res.status(404).json({ success: false, message: 'Active shift not found' });
    }

    res.json({ success: true, message: 'Shift ended successfully', data: result.rows[0] });
  } catch (error) {
    console.error('Error ending shift:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// 7. Log production data
router.post('/log', authenticateToken, async (req, res) => {
  const { shiftId, stationId, inputBagQr, outputBagQr, weight, photoUrl, status } = req.body;

  try {
    let finalOutputBagQr = outputBagQr;

    // If outputBagQr is not provided, generate it based on Shift, Line and Station
    if (!finalOutputBagQr) {
      // Get shift details (Line, Shift Type, Date)
      const shiftInfo = await pool.query(
        `SELECT os.line_id, pl.name as line_name, st.name as shift_name, os.start_time
         FROM operator_shifts os
         JOIN production_lines pl ON os.line_id = pl.id
         JOIN shift_types st ON os.shift_type_id = st.id
         WHERE os.id = $1`,
        [shiftId]
      );

      if (shiftInfo.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Shift not found' });
      }

      const { line_name, shift_name, start_time } = shiftInfo.rows[0];
      const shiftDate = new Date(start_time);
      const year = shiftDate.getFullYear();
      const month = String(shiftDate.getMonth() + 1).padStart(2, '0');
      const date = String(shiftDate.getDate()).padStart(2, '0');

      // Map Shift name to number (Shift 1 -> 1, Shift 2 -> 2, Shift 3 -> 3)
      const shiftMap = { 'Shift 1': '1', 'Shift 2': '2', 'Shift 3': '3' };
      const shiftNum = shiftMap[shift_name] || '1';
      const lineNum = line_name.replace('Line ', '') || '1';

      // Get Station Code
      const stationResult = await pool.query('SELECT name FROM stations WHERE id = $1', [stationId]);
      const stationName = stationResult.rows[0]?.name || 'Unknown';
      const stationCodeMap = {
        'Label Removal': 'LBL',
        'Crusher': 'CRS',
        'Washing': 'WSH',
        'Extrusion': 'EXT',
        'Final Packaging': 'PKG'
      };
      const stationCode = stationCodeMap[stationName] || 'UNK';

      // Calculate Increment: Count logs for this Line, Shift Type, Station on this Date
      // We look for all logs that belong to any shift session started on this same date for this line and shift type
      const countResult = await pool.query(
        `SELECT COUNT(*) as count 
         FROM production_logs pl
         JOIN operator_shifts os ON pl.shift_id = os.id
         WHERE os.line_id = (SELECT line_id FROM operator_shifts WHERE id = $1)
           AND os.shift_type_id = (SELECT shift_type_id FROM operator_shifts WHERE id = $1)
           AND pl.station_id = $2
           AND os.start_time::date = $3::date`,
        [shiftId, stationId, start_time]
      );

      const increment = String(parseInt(countResult.rows[0].count) + 1).padStart(2, '0');
      finalOutputBagQr = `${year} ${month} ${date} S ${shiftNum} ${lineNum} ${stationCode} ${increment}`;
    }

    const result = await pool.query(
      `INSERT INTO production_logs (shift_id, station_id, input_bag_qr, output_bag_qr, weight, photo_url, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [shiftId, stationId, inputBagQr, finalOutputBagQr, weight, photoUrl, status || 'Completed']
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
    // Check if shift session exists
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
        `INSERT INTO by_product_logs (shift_id, station_id, name, weight)
         VALUES ($1, $2, $3, $4)`,
        [shiftId, item.stationId, item.name, item.weight]
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

// 9. Search logs by output QR (for autocomplete)
router.get('/search-logs', authenticateToken, async (req, res) => {
  const { query, stationId, currentStationId } = req.query;
  try {
    let sql = `SELECT * FROM production_logs WHERE output_bag_qr ILIKE $1`;
    const params = [`%${query}%` || ''];
    let paramIndex = 1;
    
    // Filter by the source station (where the bags came from)
    if (stationId) {
      paramIndex++;
      sql += ` AND station_id = $${paramIndex}`;
      params.push(stationId);
    }
    
    // Exclude bags that are already processing at the current station
    if (currentStationId) {
      paramIndex++;
      sql += ` AND output_bag_qr NOT IN (
        SELECT input_bag_qr FROM production_logs 
        WHERE station_id = $${paramIndex} 
        AND status = 'Processing' 
        AND input_bag_qr IS NOT NULL
      )`;
      params.push(currentStationId);
    }
    
    // Only show completed bags (not processing ones)
    sql += ` AND status = 'Completed'`;
    sql += ` ORDER BY created_at DESC LIMIT 10`;
    
    const result = await pool.query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Error searching logs:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;
