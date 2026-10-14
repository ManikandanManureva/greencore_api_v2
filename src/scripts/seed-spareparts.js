/**
 * Seeds the Spare Parts module with real starting data extracted from:
 *   - "1. Starlinger Spare Parts - Tracking.xlsx" (Spare Parts Inventory + Usage Log sheets)
 *   - "10. [MEC] Penerimaan dan Pengambilan Sparepart_Oktober 2026.xlsx" (Stok & Mutasi Harian)
 * Run create-spareparts-tables.js first. Safe to re-run — skips tables that already have rows,
 * so it won't duplicate data on a second run.
 *
 * Usage:
 *   node src/scripts/seed-spareparts.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../config/database');

const seed = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'spareparts-seed-data.json'), 'utf-8'),
);

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ---- Starlinger Spare Parts master ----
    const existingStarlinger = await client.query('SELECT COUNT(*)::int AS n FROM starlinger_spare_parts');
    if (existingStarlinger.rows[0].n > 0) {
      console.log(`⏭️  starlinger_spare_parts already has ${existingStarlinger.rows[0].n} rows — skipping master seed.`);
    } else {
      const partIdByNo = new Map(); // first id seen per part_no, for log linking below
      for (const p of seed.starlinger_parts) {
        const baseStock = Number(p.base_stock) || 0;
        const r = await client.query(
          `INSERT INTO starlinger_spare_parts
             (part_no, description, category, shelf, floor, location, base_stock, current_qty,
              min_stock, max_stock, unit, machine, supplier, notes, "createdBy", "updatedBy")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11,$12,$13,'seed','seed')
           RETURNING id`,
          [
            p.part_no, p.description, p.category || null, p.shelf || null, p.floor || null,
            p.location || null, baseStock, p.min_stock ?? null, p.max_stock ?? null,
            p.unit || null, p.machine || null, p.supplier || null, p.notes || null,
          ],
        );
        if (p.part_no && !partIdByNo.has(p.part_no)) partIdByNo.set(p.part_no, r.rows[0].id);
      }
      console.log(`✅ Seeded ${seed.starlinger_parts.length} Starlinger spare parts.`);

      // Sample Usage Log transactions from the workbook, applied against the matching part
      // (first match by part_no) so current_qty reflects real history, not just opening stock.
      let logged = 0, skipped = 0;
      for (const l of seed.starlinger_log) {
        const partId = partIdByNo.get(l.part_no);
        if (!partId) { skipped++; continue; }
        const qty = Number(l.qty) || 0;
        let logDate = l.date;
        const isoMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(logDate);
        const dmyMatch = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(logDate);
        if (isoMatch) logDate = `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
        else if (dmyMatch) logDate = `${dmyMatch[3]}-${dmyMatch[2]}-${dmyMatch[1]}`;
        else logDate = null;
        await client.query(
          `INSERT INTO starlinger_spare_parts_log
             (part_id, log_date, transaction_type, qty, description, technician, "createdBy")
           VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3, $4, $5, $6, 'seed')`,
          [partId, logDate, l.transaction_type, qty, l.description || null, l.technician || null],
        );
        await client.query(
          `UPDATE starlinger_spare_parts SET current_qty = current_qty + $2 WHERE id = $1`,
          [partId, qty],
        );
        logged++;
      }
      console.log(`✅ Seeded ${logged} Starlinger usage-log transactions (${skipped} skipped — part not found).`);
    }

    // ---- MEC Spare Parts master ----
    const existingMec = await client.query('SELECT COUNT(*)::int AS n FROM mec_spare_parts');
    if (existingMec.rows[0].n > 0) {
      console.log(`⏭️  mec_spare_parts already has ${existingMec.rows[0].n} rows — skipping seed.`);
    } else {
      for (const p of seed.mec_parts) {
        const opening = Number(p.opening_stock) || 0;
        const current = p.current_qty != null ? Number(p.current_qty) : opening;
        await client.query(
          `INSERT INTO mec_spare_parts
             (part_code, name, unit, opening_stock, current_qty, "createdBy", "updatedBy")
           VALUES ($1,$2,$3,$4,$5,'seed','seed')
           ON CONFLICT (part_code) DO NOTHING`,
          [p.part_code, p.name, p.unit || null, opening, current],
        );
      }
      console.log(`✅ Seeded ${seed.mec_parts.length} MEC spare parts.`);
    }

    await client.query('COMMIT');
    console.log('Done.');
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
