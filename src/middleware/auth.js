const jwt = require('jsonwebtoken');
const pool = require('../config/database');
const { loadPermissions } = require('./permissions');

const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Access token is required'
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Verify user still exists and is active. SELECT * so optional columns (e.g.
    // can_correct_production, added by a later migration) never break authentication.
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [decoded.userId]);

    if (result.rows.length === 0 || !result.rows[0].is_active) {
      return res.status(401).json({
        success: false,
        message: 'Invalid or inactive user'
      });
    }

    const access = await loadPermissions(pool, result.rows[0]);
    req.user = {
      id: result.rows[0].id,
      roleKey: access.roleKey,
      roleName: access.roleName,
      permissions: access.permissions,
      phone: result.rows[0].phone || null,
      employeeId: result.rows[0].employee_id,
      name: result.rows[0].name,
      email: result.rows[0].email,
      role: result.rows[0].role,
      materialTypeId: result.rows[0].material_type_id,
      // Supervisor corrections (delete / correct bags, reopen shifts) — see add-production-corrections.js
      canCorrectProduction: result.rows[0].can_correct_production === true
    };

    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Invalid token'
      });
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token expired'
      });
    }
    return res.status(500).json({
      success: false,
      message: 'Authentication error'
    });
  }
};

module.exports = { authenticateToken };
