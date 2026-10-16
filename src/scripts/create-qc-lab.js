/**
 * QC Lab — Pellet Finish Good samples. Mirrors "QC LAB - PELLETS REPORT.xlsx" (sheet
 * "Pellet Finish Good") column-for-column, so entry, storage and export all match the lab's
 * existing spreadsheet.
 *
 * Three fields are SERVER-COMPUTED, replicating the workbook's own formulas exactly — never
 * accepted directly from the client:
 *   grade    = IV in [0.77,0.833] -> 'SPS' | IV in [0.84,0.86] -> 'Jugs' | else 'Out Spec'
 *              (blank if IV is null, same as the sheet's IFERROR(...,""))
 *   density  = bulk_density / 1000
 *   blue     = 100 - white
 *
 * Idempotent — safe to re-run.
 * Usage: node src/scripts/create-qc-lab.js
 */
require('dotenv').config();
const pool = require('../config/database');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS qc_lab_samples (
        id                     SERIAL PRIMARY KEY,
        batch_no               VARCHAR(60) NOT NULL,
        bag_no                 VARCHAR(60),
        sampling_date          DATE NOT NULL,
        sampling_time          TIME,
        sampling_point         VARCHAR(20),
        colour                 VARCHAR(20),
        qty_kg                 NUMERIC(10,2),
        pic                    VARCHAR(120),

        iv                     NUMERIC(6,3),
        grade                  VARCHAR(20),

        pellet_size            NUMERIC(6,2),
        bulk_density           NUMERIC(8,3),
        moisture               NUMERIC(6,3),
        melting_point          NUMERIC(8,2),
        density                NUMERIC(8,5),

        color_l                NUMERIC(8,3),
        color_a                NUMERIC(8,3),
        color_b                NUMERIC(8,3),

        foreign_material       NUMERIC(8,3),
        filaments_angel_hair   NUMERIC(8,3),
        fines                  NUMERIC(8,3),
        black_specs            NUMERIC(8,3),
        black_spot_gt_1mm      NUMERIC(10,3),
        black_spot_0_5_1mm     NUMERIC(10,3),
        black_spot_0_1_0_5mm   NUMERIC(10,3),

        miscut                 NUMERIC(8,3),
        duplet                 NUMERIC(8,3),
        triplet                NUMERIC(8,3),
        undersize              NUMERIC(8,3),
        oversize               NUMERIC(8,3),
        tail                   NUMERIC(8,3),
        aglomerat              NUMERIC(8,3),
        white                  NUMERIC(8,3),
        blue                   NUMERIC(8,3),

        notes                  TEXT,
        "createdBy"            VARCHAR(120),
        "updatedBy"            VARCHAR(120),
        "createdAt"            TIMESTAMPTZ DEFAULT NOW(),
        "updatedAt"            TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_qclab_batch ON qc_lab_samples (batch_no)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_qclab_date ON qc_lab_samples (sampling_date)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_qclab_grade ON qc_lab_samples (grade)`);

    await client.query('COMMIT');
    console.log('✅ QC Lab table ensured.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
