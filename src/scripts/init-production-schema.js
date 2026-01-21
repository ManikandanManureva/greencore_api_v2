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
      DROP TABLE IF EXISTS production_lines CASCADE;
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

    // Ensure code column exists for existing stations table
    await client.query(`
      ALTER TABLE stations ADD COLUMN IF NOT EXISTS code VARCHAR(10);
    `);
    
    // Add unique constraint only if it doesn't exist
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stations_code_key') THEN
          ALTER TABLE stations ADD CONSTRAINT stations_code_key UNIQUE (code);
        END IF;
      END
      $$;
    `);
    console.log('✅ stations table updated with code and constraint');

    // 4b. Material Flow Stations (Mapping which stations belong to which material)
    await client.query(`
      CREATE TABLE IF NOT EXISTS material_flow_stations (
        material_type_id INTEGER REFERENCES material_types(id) ON DELETE CASCADE,
        station_id INTEGER REFERENCES stations(id) ON DELETE CASCADE,
        PRIMARY KEY (material_type_id, station_id)
      );
    `);
    console.log('✅ material_flow_stations mapping table created');

    // 5. Operator Shifts (Sessions)
    await client.query(`
      CREATE TABLE IF NOT EXISTS operator_shifts (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        shift_type_id INTEGER REFERENCES shift_types(id),
        material_type_id INTEGER REFERENCES material_types(id),
        start_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        end_time TIMESTAMP,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      -- Index for finding active shifts quickly
      CREATE INDEX IF NOT EXISTS idx_operator_shifts_active ON operator_shifts(user_id, is_active) WHERE is_active = true;
    `);
    console.log('✅ operator_shifts table created with performance index');

    // 6. Production Logs
    await client.query(`
      CREATE TABLE IF NOT EXISTS production_logs (
        id SERIAL PRIMARY KEY,
        shift_id INTEGER REFERENCES operator_shifts(id) ON DELETE CASCADE,
        station_id INTEGER REFERENCES stations(id),
        input_bag_qr VARCHAR(100),
        output_bag_qr VARCHAR(100),
        weight DECIMAL(10, 2),
        photo_url TEXT,
        status VARCHAR(50), 
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Ensure material_type_id exists for existing production_logs table
    await client.query(`
      ALTER TABLE production_logs ADD COLUMN IF NOT EXISTS material_type_id INTEGER REFERENCES material_types(id);
    `);

    // Ensure sub_line exists for existing production_logs table
    await client.query(`
      ALTER TABLE production_logs ADD COLUMN IF NOT EXISTS sub_line VARCHAR(50);
    `);

    // Remove main_line column if it exists
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'production_logs' AND column_name = 'main_line') THEN
          ALTER TABLE production_logs DROP COLUMN main_line;
        END IF;
      END
      $$;
    `);

    // Rename washing_line to used_line if washing_line exists
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'production_logs' AND column_name = 'washing_line') THEN
          ALTER TABLE production_logs RENAME COLUMN washing_line TO used_line;
        END IF;
      END
      $$;
    `);

    // Add used_line column if it doesn't exist (for new installations)
    await client.query(`
      ALTER TABLE production_logs ADD COLUMN IF NOT EXISTS used_line VARCHAR(50);
    `);

    // Drop main_line index if it exists
    await client.query(`
      DROP INDEX IF EXISTS idx_production_logs_main_line;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_production_logs_material ON production_logs(material_type_id);
      CREATE INDEX IF NOT EXISTS idx_production_logs_qr ON production_logs(output_bag_qr);
      CREATE INDEX IF NOT EXISTS idx_production_logs_used_line ON production_logs(used_line);
    `);
    console.log('✅ production_logs table updated with material tracking and used_line');

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
    console.log('🧹 Cleaning up old stations and mappings...');
    // Delete mappings first (no foreign key constraints)
    await client.query('DELETE FROM material_flow_stations');
    // For stations, check if there are production_logs referencing them
    // If yes, update existing stations instead of deleting
    const hasProductionLogs = await client.query('SELECT COUNT(*) as count FROM production_logs WHERE station_id IS NOT NULL');
    if (parseInt(hasProductionLogs.rows[0].count) > 0) {
      console.log('⚠️  Production logs exist - updating stations instead of deleting');
      // Stations will be updated/inserted below using ON CONFLICT
    } else {
      // Safe to delete if no production logs reference them
      await client.query('DELETE FROM stations');
    }

    const stations = [
      ['Label Removal', 'LBL', 'Initial cleaning and label stripping', 1],
      ['Crusher', 'CRS', 'Bottle crushing into flakes', 2],
      ['Washing', 'WSH', 'Intensive flake washing', 3],
      ['Extrusion', 'EXT', 'Melting and forming pellets', 4],
      ['Final Packaging', 'PKG', 'Bagging and weighing', 5]
    ];
    for (const [name, code, desc, order] of stations) {
      await client.query(`
        INSERT INTO stations (name, code, description, order_index)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, order_index = EXCLUDED.order_index;
      `, [name, code, desc, order]);
    }

    // Seed Material Flow Mappings (Which stations each flow uses)
    const matPC = await client.query("SELECT id FROM material_types WHERE name = 'PC'");
    const matPE = await client.query("SELECT id FROM material_types WHERE name = 'PE'");
    const matPET = await client.query("SELECT id FROM material_types WHERE name = 'PET'");
    
    // Fetch newly created station IDs by their codes
    const stationMap = {};
    const stationsResult = await client.query("SELECT id, code FROM stations");
    stationsResult.rows.forEach(row => {
      stationMap[roleMapCode(row.code)] = row.id;
      stationMap[row.code] = row.id;
    });

    function roleMapCode(code) { return code; } // Helper if needed

    // Helper to insert mapping
    async function addMapping(matId, stationCode) {
      const sId = stationMap[stationCode];
      if (matId && sId) {
        await client.query(
          "INSERT INTO material_flow_stations (material_type_id, station_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [matId, sId]
        );
      }
    }

    // PC Flow: All stations
    if (matPC.rows[0]) {
      const pcId = matPC.rows[0].id;
      for (const code of ['LBL', 'CRS', 'WSH', 'EXT', 'PKG']) {
        await addMapping(pcId, code);
      }
    }

    // PE Flow: Crusher, Washing, Packaging
    if (matPE.rows[0]) {
      const peId = matPE.rows[0].id;
      for (const code of ['CRS', 'WSH', 'PKG']) {
        await addMapping(peId, code);
      }
    }

    // PET Flow: All stations
    if (matPET.rows[0]) {
      const petId = matPET.rows[0].id;
      for (const code of ['LBL', 'CRS', 'WSH', 'EXT', 'PKG']) {
        await addMapping(petId, code);
      }
    }

    console.log('✨ PC/PE/PET Production schema and flow data initialized successfully!');

    // --- SEED USERS FOR ROLES ---
    const bcrypt = require('bcrypt');
    const hashedPass = await bcrypt.hash('password123', 10);

    const rolesResult = await client.query('SELECT id, name FROM material_types');
    const roles = rolesResult.rows;

    for (const role of roles) {
      const empId = `OP-${role.name}`;
      await client.query(`
        INSERT INTO users (employee_id, password, name, role, material_type_id, is_active)
        VALUES ($1, $2, $3, $4, $5, true)
        ON CONFLICT (employee_id) DO UPDATE 
        SET material_type_id = EXCLUDED.material_type_id, role = EXCLUDED.role;
      `, [empId, hashedPass, `${role.name} Operator`, role.name, role.id]);
      console.log(`👤 Seeded user: ${empId} with role ${role.name}`);
    }

    // Also update existing OP001 to PC role if it exists
    const pcRole = roles.find(r => r.name === 'PC');
    if (pcRole) {
      await client.query('UPDATE users SET material_type_id = $1, role = $2 WHERE employee_id = $3', [pcRole.id, 'PC', 'OP001']);
      console.log('👤 Updated OP001 to PC role');
    }

  } catch (error) {
    console.error('❌ Error initializing schema:', error);
  } finally {
    client.release();
    process.exit();
  }
}

initProductionSchema();
