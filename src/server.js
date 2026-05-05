const express = require('express');
const cors = require('cors');
require('dotenv').config();

if (!process.env.JWT_SECRET || String(process.env.JWT_SECRET).trim() === '') {
  console.error('FATAL: JWT_SECRET is not set in .env');
  process.exit(1);
}

const authRoutes = require('./routes/auth');
const productionRoutes = require('./routes/production');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware — expose headers so browser JS can read filename / row count on cross-origin export
app.use(
  cors({
    exposedHeaders: [
      'Content-Disposition',
      'X-Export-Row-Count',
      'X-Export-Truncated',
    ],
  }),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Greencore API V2 is running',
    timestamp: new Date().toISOString()
  });
});

// Database health check (for debugging 500 on login)
app.get('/health/db', async (req, res) => {
  try {
    const pool = require('./config/database');
    await pool.query('SELECT 1');
    res.json({ success: true, message: 'Database connection OK' });
  } catch (err) {
    console.error('Health DB error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Database connection failed',
      error: process.env.NODE_ENV === 'production' ? undefined : err.message
    });
  }
});

// API Routes (mount both so /auth and /api/auth work – app uses /auth on EC2, /api/auth on localhost)
app.use('/api/auth', authRoutes);
app.use('/auth', authRoutes);
app.use('/api/production', productionRoutes);
app.use('/production', productionRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found'
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    success: false,
    message: 'Internal server error'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Greencore API V2 server running on http://localhost:${PORT}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
