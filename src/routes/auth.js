const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
console.log("inside auth 8 ");

// Login endpoint
router.post('/login', async (req, res) => {
  try {
    console.log("inside auth 9 ");
    const { employeeId, password } = req.body;

    // Validate input
    if (!employeeId || !password) {
      return res.status(400).json({
        success: false,
        message: 'Employee ID and password are required'
      });
    }

    // Find user by employee ID
    const result = await pool.query(
      'SELECT id, employee_id, password, name, email, role, material_type_id, is_active FROM users WHERE employee_id = $1',
      [employeeId.toUpperCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid employee ID or password'
      });
    }

    const user = result.rows[0];

    // Update last login
    await pool.query('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);

    // Check if user is active
    if (!user.is_active) {
      return res.status(401).json({
        success: false,
        message: 'Account is inactive. Please contact administrator.'
      });
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({
        success: false,
        message: 'Invalid employee ID or password'
      });
    }

    // Generate JWT access token (short-lived)
    const accessToken = jwt.sign(
      { userId: user.id, employeeId: user.employee_id, materialTypeId: user.material_type_id, type: 'access' },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
    );

    // Generate refresh token (long-lived)
    const refreshToken = crypto.randomBytes(64).toString('hex');
    const refreshTokenExpiry = new Date();
    refreshTokenExpiry.setDate(refreshTokenExpiry.getDate() + 30); // 30 days

    // Store refresh token in database (with error handling)
    try {
      await pool.query(
        'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
        [user.id, refreshToken, refreshTokenExpiry]
      );
    } catch (dbError) {
      // If refresh_tokens table doesn't exist, log warning but continue
      console.warn('Could not store refresh token (table may not exist):', dbError.message);
      // Continue with login even if refresh token storage fails
    }

    // Return success response
    res.json({
      success: true,
      message: 'Login successful',
      token: accessToken,
      refreshToken: refreshToken,
      expiresIn: 900, // 15 minutes in seconds
      user: {
        id: user.id,
        employeeId: user.employee_id,
        name: user.name,
        email: user.email,
        role: user.role,
        materialTypeId: user.material_type_id
      }
    });
  } catch (error) {
    console.error('Login error:', error.message);
    console.error('Login error stack:', error.stack);
    res.status(500).json({
      success: false,
      message: process.env.NODE_ENV === 'production' ? 'Internal server error' : (error.message || 'Internal server error')
    });
  }
});

// Refresh token endpoint
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({
        success: false,
        message: 'Refresh token is required'
      });
    }

    // Verify refresh token exists and is valid
    const tokenResult = await pool.query(
      `SELECT rt.*, u.id, u.employee_id, u.name, u.email, u.role, u.material_type_id, u.is_active 
       FROM refresh_tokens rt
       JOIN users u ON rt.user_id = u.id
       WHERE rt.token = $1 AND rt.is_revoked = false AND rt.expires_at > NOW()`,
      [refreshToken]
    );

    if (tokenResult.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired refresh token'
      });
    }

    const tokenData = tokenResult.rows[0];

    if (!tokenData.is_active) {
      return res.status(401).json({
        success: false,
        message: 'User account is inactive'
      });
    }

    // Generate new access token
    const accessToken = jwt.sign(
      { userId: tokenData.id, employeeId: tokenData.employee_id, materialTypeId: tokenData.material_type_id, type: 'access' },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
    );

    res.json({
      success: true,
      token: accessToken,
      expiresIn: 900, // 15 minutes in seconds
      user: {
        id: tokenData.id,
        employeeId: tokenData.employee_id,
        name: tokenData.name,
        email: tokenData.email,
        role: tokenData.role,
        materialTypeId: tokenData.material_type_id
      }
    });
  } catch (error) {
    console.error('Refresh token error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Verify token endpoint
router.get('/verify', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT last_login_at, material_type_id FROM users WHERE id = $1', [req.user.id]);
    res.json({
      success: true,
      user: {
        id: req.user.id,
        employeeId: req.user.employeeId,
        name: req.user.name,
        email: req.user.email,
        role: req.user.role,
        materialTypeId: result.rows[0]?.material_type_id,
        lastLoginAt: result.rows[0]?.last_login_at
      }
    });
  } catch (error) {
    console.error('Verify token error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Logout endpoint (revoke refresh token)
router.post('/logout', authenticateToken, async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (refreshToken) {
      try {
        await pool.query(
          'UPDATE refresh_tokens SET is_revoked = true WHERE token = $1',
          [refreshToken]
        );
      } catch (dbErr) {
        // Table/column may not exist on server; log but still succeed logout
        console.warn('Logout: could not revoke refresh token (table may be missing):', dbErr.message);
      }
    }

    res.json({
      success: true,
      message: 'Logout successful'
    });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

module.exports = router;
