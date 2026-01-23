const { Client } = require('pg');
const bcrypt = require('bcrypt');
require('dotenv').config();

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'mysql',
  password: process.env.DB_PASSWORD || 'password',
  database: 'mysql' // Connect to default mysql database first
};

async function setupDatabase() {
  const client = new Client(dbConfig);
  
  try {
    await client.connect();
    console.log('✅ Connected to mysqlQL');

    // Create database if it doesn't exist
    const dbName = process.env.DB_NAME || 'greencorev2';
    const dbCheck = await client.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [dbName]
    );

    if (dbCheck.rows.length === 0) {
      await client.query(`CREATE DATABASE ${dbName}`);
      console.log(`✅ Database '${dbName}' created`);
    } else {
      console.log(`✅ Database '${dbName}' already exists`);
    }

    await client.end();

    // Connect to the new database
    const dbClient = new Client({
      ...dbConfig,
      database: dbName
    });

    await dbClient.connect();
    console.log(`✅ Connected to database '${dbName}'`);

    // Create users table
    await dbClient.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        employee_id VARCHAR(50) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        role VARCHAR(50) DEFAULT 'employee',
        material_type_id INTEGER,
        is_active BOOLEAN DEFAULT true,
        last_login_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Ensure last_login_at and material_type_id exist for existing tables
    try {
      await dbClient.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP');
      await dbClient.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS material_type_id INTEGER');
    } catch (e) {
      console.warn('Could not update users table columns (might already exist)');
    }
    
    console.log('✅ Users table created/verified');

    // Create refresh_tokens table
    try {
      // Check if table exists first
      const tableCheck = await dbClient.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'refresh_tokens'
        );
      `);

      if (!tableCheck.rows[0].exists) {
        await dbClient.query(`
          CREATE TABLE refresh_tokens (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            token VARCHAR(500) UNIQUE NOT NULL,
            expires_at TIMESTAMP NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            is_revoked BOOLEAN DEFAULT false
          )
        `);
        console.log('✅ Refresh tokens table created');
      } else {
        console.log('✅ Refresh tokens table already exists');
      }
    } catch (error) {
      console.error('⚠️  Error creating refresh_tokens table:', error.message);
      // Try to create without foreign key constraint if users table doesn't exist yet
      try {
        await dbClient.query(`
          CREATE TABLE IF NOT EXISTS refresh_tokens (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL,
            token VARCHAR(500) UNIQUE NOT NULL,
            expires_at TIMESTAMP NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            is_revoked BOOLEAN DEFAULT false
          )
        `);
        console.log('✅ Refresh tokens table created (without foreign key constraint)');
      } catch (err) {
        console.error('❌ Failed to create refresh_tokens table:', err.message);
        throw err;
      }
    }

    // Create function to update updated_at timestamp
    await dbClient.query(`
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
      END;
      $$ language 'plpgsql';
    `);

    // Create trigger for updated_at
    await dbClient.query(`
      DROP TRIGGER IF EXISTS update_users_updated_at ON users;
      CREATE TRIGGER update_users_updated_at
      BEFORE UPDATE ON users
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
    `);
    console.log('✅ Triggers created/verified');

    // Check if default admin user exists
    const userCheck = await dbClient.query(
      'SELECT id FROM users WHERE employee_id = $1',
      ['OP001']
    );

    if (userCheck.rows.length === 0) {
      // Create default admin user
      const hashedPassword = await bcrypt.hash('password123', 10);
      await dbClient.query(
        `INSERT INTO users (employee_id, password, name, email, role, is_active)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['OP001', hashedPassword, 'Admin User', 'admin@greencore.com', 'admin', true]
      );
      console.log('✅ Default admin user created (Employee ID: OP001, Password: password123)');
    } else {
      console.log('✅ Default admin user already exists');
    }

    await dbClient.end();
    console.log('\n🎉 Database setup completed successfully!');
    console.log('\n📝 Default credentials:');
    console.log('   Employee ID: OP001');
    console.log('   Password: password123');
    console.log('\n⚠️  Please change the default password after first login!');

  } catch (error) {
    console.error('❌ Database setup error:', error.message);
    process.exit(1);
  }
}

setupDatabase();
