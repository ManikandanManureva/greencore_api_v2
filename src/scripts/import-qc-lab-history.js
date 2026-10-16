/**
 * Backfills the 668 historical rows from "QC LAB - PELLETS REPORT.xlsx" (sheet
 * "Pellet Finish Good") into qc_lab_samples.
 *
 * Imports grade/density/blue AS STORED in the sheet, not recomputed — 44 historical rows have
 * a blank IV but a manually-overridden "Out Spec" grade (the lab judged those samples out of
 * spec on other grounds without a valid IV reading); recomputing from the standard formula
 * would have silently blanked those out. New samples entered going forward through the app
 * still get grade/density/blue computed automatically as designed — this is historical-import
 * fidelity only.
 *
 * Idempotent — skips if qc_lab_samples already has rows.
 * Usage: node src/scripts/import-qc-lab-history.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../config/database');

const rows = JSON.parse(fs.readFileSync(path.join(__dirname, 'qc-lab-samples.json'), 'utf-8'));

function toDate(v) {
  if (!v) return null;
  return String(v).slice(0, 10);
}

// A handful of historical rows have "N/A" (text) in numeric cells instead of being left blank.
function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function run() {
  const client = await pool.connect();
  try {
    const existing = await client.query('SELECT COUNT(*)::int AS n FROM qc_lab_samples');
    if (existing.rows[0].n > 0) {
      console.log(`⏭️  qc_lab_samples already has ${existing.rows[0].n} rows — skipping import.`);
      return;
    }

    await client.query('BEGIN');
    let count = 0;
    for (const r of rows) {
      await client.query(
        `INSERT INTO qc_lab_samples
           (batch_no, bag_no, sampling_date, sampling_time, sampling_point, colour, qty_kg, pic,
            iv, grade, pellet_size, bulk_density, moisture, color_l, color_a, color_b,
            foreign_material, filaments_angel_hair, melting_point, density, fines, black_specs,
            black_spot_gt_1mm, black_spot_0_5_1mm, black_spot_0_1_0_5mm,
            miscut, duplet, triplet, undersize, oversize, tail, aglomerat, white, blue,
            "createdBy", "updatedBy")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
                 $23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,'import','import')`,
        [
          r.batch_no, r.bag_no, toDate(r.sampling_date), r.sampling_time, r.sampling_point, r.colour,
          toNum(r.qty_kg), r.pic, toNum(r.iv), r.grade || null, toNum(r.pellet_size), toNum(r.bulk_density), toNum(r.moisture),
          toNum(r.color_l), toNum(r.color_a), toNum(r.color_b), toNum(r.foreign_material), toNum(r.filaments_angel_hair), toNum(r.melting_point),
          toNum(r.density), toNum(r.fines), toNum(r.black_specs), toNum(r.black_spot_gt_1mm), toNum(r.black_spot_0_5_1mm), toNum(r.black_spot_0_1_0_5mm),
          toNum(r.miscut), toNum(r.duplet), toNum(r.triplet), toNum(r.undersize), toNum(r.oversize), toNum(r.tail), toNum(r.aglomerat), toNum(r.white), toNum(r.blue),
        ],
      );
      count++;
    }
    await client.query('COMMIT');
    console.log(`✅ Imported ${count} historical QC Lab samples.`);
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
