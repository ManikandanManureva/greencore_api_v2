const pool = require('../config/database');

async function updateShiftNames() {
  const client = await pool.connect();
  try {
    console.log('🔄 Updating shift names from A, B, C to Shift 1, Shift 2, Shift 3...');

    // Check if there are any shifts with old naming convention
    const checkResult = await client.query(`
      SELECT id, name FROM shift_types 
      WHERE name IN ('A', 'B', 'C')
      ORDER BY id;
    `);

    if (checkResult.rows.length === 0) {
      console.log('✅ No shifts with old naming convention found. Shifts are already properly named.');
      
      // Verify current shift names
      const currentShifts = await client.query(`
        SELECT id, name, start_time, end_time FROM shift_types 
        ORDER BY id;
      `);
      
      console.log('📋 Current shifts in database:');
      currentShifts.rows.forEach(shift => {
        console.log(`   - ${shift.name}: ${shift.start_time} - ${shift.end_time}`);
      });
      
      return;
    }

    console.log(`📋 Found ${checkResult.rows.length} shifts with old naming convention:`);
    checkResult.rows.forEach(shift => {
      console.log(`   - ID ${shift.id}: ${shift.name}`);
    });

    // Update shift names
    await client.query('BEGIN');

    // Update A to Shift 1
    const updateA = await client.query(`
      UPDATE shift_types 
      SET name = 'Shift 1' 
      WHERE name = 'A'
      RETURNING id, name;
    `);

    // Update B to Shift 2
    const updateB = await client.query(`
      UPDATE shift_types 
      SET name = 'Shift 2' 
      WHERE name = 'B'
      RETURNING id, name;
    `);

    // Update C to Shift 3
    const updateC = await client.query(`
      UPDATE shift_types 
      SET name = 'Shift 3' 
      WHERE name = 'C'
      RETURNING id, name;
    `);

    await client.query('COMMIT');

    console.log('✅ Successfully updated shift names:');
    [...updateA.rows, ...updateB.rows, ...updateC.rows].forEach(shift => {
      console.log(`   - ID ${shift.id}: ${shift.name}`);
    });

    // Verify final state
    const finalShifts = await client.query(`
      SELECT id, name, start_time, end_time FROM shift_types 
      ORDER BY id;
    `);
    
    console.log('📋 Final shifts in database:');
    finalShifts.rows.forEach(shift => {
      console.log(`   - ${shift.name}: ${shift.start_time} - ${shift.end_time}`);
    });

    console.log('🎉 Shift name migration completed successfully!');

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Error updating shift names:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Run the migration
if (require.main === module) {
  updateShiftNames()
    .then(() => {
      console.log('✨ Migration script completed successfully!');
      process.exit(0);
    })
    .catch(error => {
      console.error('💥 Migration script failed:', error);
      process.exit(1);
    });
}

module.exports = updateShiftNames;