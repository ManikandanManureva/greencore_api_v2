const pool = require('../config/database');

async function initProductionSchema() {
  const client = await pool.connect();
  try {
    console.log('🚀 Initializing Production Database Schema for PC...');

    // 1. Production Lines
    await client.query(`
      CREATE TABLE IF NOT EXISTS production_lines (
        id SERIAL PRIMARY KEY,
        name VARCHAR(50) NOT NULL UNIQUE,
        description TEXT,
        color VARCHAR(20),
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ production_lines table created');

    // 2. Material Types
    await client.query(`
      CREATE TABLE IF NOT EXISTS material_types (
        id SERIAL PRIMARY KEY,
        name VARCHAR(20) NOT NULL UNIQUE, -- PC, PE, PET
        description TEXT,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ material_types table created');

    // 3. Shift Types
    await client.query(`
      CREATE TABLE IF NOT EXISTS shift_types (
        id SERIAL PRIMARY KEY,
        name VARCHAR(10) NOT NULL UNIQUE, -- A, B, C
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ shift_types table created');

    // 4. Stations
    await client.query(`
      CREATE TABLE IF NOT EXISTS stations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        order_index INTEGER,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ stations table created');

    // 5. Operator Shifts (Sessions)
    await client.query(`
      CREATE TABLE IF NOT EXISTS operator_shifts (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        line_id INTEGER REFERENCES production_lines(id),
        shift_type_id INTEGER REFERENCES shift_types(id),
        material_type_id INTEGER REFERENCES material_types(id),
        start_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        end_time TIMESTAMP,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ operator_shifts table created');

    // 6. Production Logs (for all stations)
    await client.query(`
      CREATE TABLE IF NOT EXISTS production_logs (
        id SERIAL PRIMARY KEY,
        shift_id INTEGER REFERENCES operator_shifts(id) ON DELETE CASCADE,
        station_id INTEGER REFERENCES stations(id),
        input_bag_qr VARCHAR(100),
        output_bag_qr VARCHAR(100),
        weight DECIMAL(10, 2),
        photo_url TEXT,
        status VARCHAR(50), -- Completed, In Progress, etc.
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ production_logs table created');

    // 7. By-product Logs
    await client.query(`
      CREATE TABLE IF NOT EXISTS by_product_logs (
        id SERIAL PRIMARY KEY,
        shift_id INTEGER REFERENCES operator_shifts(id) ON DELETE CASCADE,
        station_id INTEGER REFERENCES stations(id),
        name VARCHAR(100) NOT NULL,
        weight DECIMAL(10, 2),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ by_product_logs table created');

    // --- SEED DATA ---
    console.log('🌱 Seeding initial data for PC...');

    // Seed Production Lines
    await client.query(`
      INSERT INTO production_lines (name, description, color)
      VALUES 
        ('Line 1', 'Full Process Line', '#22c55e'),
        ('Line 2', 'Fast Track Line', '#f59e0b'),
        ('Line 3', 'High Capacity Line', '#3b82f6')
      ON CONFLICT (name) DO NOTHING;
    `);

    // Seed Material Types
    await client.query(`
      INSERT INTO material_types (name, description)
      VALUES 
        ('PC', 'Polycarbonate Bottles'),
        ('PE', 'Polyethylene Bottles'),
        ('PET', 'Polyethylene Terephthalate Bottles')
      ON CONFLICT (name) DO NOTHING;
    `);

    // Seed Shift Types
    await client.query(`
      INSERT INTO shift_types (name, start_time, end_time)
      VALUES 
        ('Shift 1', '06:00:00', '14:00:00'),
        ('Shift 2', '14:00:00', '22:00:00'),
        ('Shift 3', '22:00:00', '06:00:00')
      ON CONFLICT (name) DO NOTHING;
    `);

    // Seed Stations
    const stations = [
      ['Label Removal', 'Initial cleaning and label stripping', 1],
      ['Crusher', 'Bottle crushing into flakes', 2],
      ['Washing', 'Intensive flake washing', 3],
      ['Extrusion', 'Melting and forming pellets', 4],
      ['Final Packaging', 'Bagging and weighing', 5]
    ];
    for (const [name, desc, order] of stations) {
      await client.query(`
        INSERT INTO stations (name, description, order_index)
        VALUES ($1, $2, $3)
        ON CONFLICT DO NOTHING;
      `, [name, desc, order]);
    }

    console.log('✨ PC Production schema and seed data initialized successfully!');

  } catch (error) {
    console.error('❌ Error initializing schema:', error);
  } finally {
    client.release();
    process.exit();
  }
}

initProductionSchema();
