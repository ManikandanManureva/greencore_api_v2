/**
 * One-time historical migration — already run on this database; kept for reference only.
 * Carried the original starlinger_spare_parts(+log) and mec_spare_parts(+log) data into the
 * unified spare_parts_items / spare_parts_log tables (see create-spareparts-v2.js), back when
 * the catalog registry still had a separate 'mec' entry. MEC was later folded into the combined
 * PC/PE catalog (see merge-pcpe-spareparts.js), so a FRESH environment's registry has no 'mec'
 * row and this script's mec branch would not apply — re-running it is a no-op either way, since
 * it skips entirely once spare_parts_items has any rows.
 * The old starlinger_spare_parts(+log) / mec_spare_parts(+log) tables are left in place,
 * untouched — this only reads from them.
 *
 * Usage (historical):
 *   node src/scripts/create-spareparts-v2.js   (first, if not already run)
 *   node src/scripts/migrate-spareparts-v2.js
 */
require('dotenv').config();
const pool = require('../config/database');

async function run() {
  const client = await pool.connect();
  try {
    const existing = await client.query('SELECT COUNT(*)::int AS n FROM spare_parts_items');
    if (existing.rows[0].n > 0) {
      console.log(`⏭️  spare_parts_items already has ${existing.rows[0].n} rows — skipping migration.`);
      return;
    }

    await client.query('BEGIN');

    const catRes = await client.query('SELECT id, key FROM spare_parts_catalogs');
    const catalogIdByKey = Object.fromEntries(catRes.rows.map((r) => [r.key, r.id]));
    const starlingerCatalogId = catalogIdByKey['pet-starlinger'];
    const mecCatalogId = catalogIdByKey['mec'];
    if (!starlingerCatalogId || !mecCatalogId) {
      throw new Error('Catalog registry is missing pet-starlinger or mec — run create-spareparts-v2.js first.');
    }

    // ---- Starlinger items + log ----
    const starlingerItems = await client.query('SELECT * FROM starlinger_spare_parts ORDER BY id');
    const starlingerIdMap = new Map(); // old id -> new id
    for (const p of starlingerItems.rows) {
      const r = await client.query(
        `INSERT INTO spare_parts_items
           (catalog_id, part_no, description, category, shelf, floor, location, base_stock, current_qty,
            min_stock, max_stock, unit, machine, supplier, notes, "createdBy", "updatedBy", "createdAt", "updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         RETURNING id`,
        [
          starlingerCatalogId, p.part_no, p.description, p.category, p.shelf, p.floor, p.location,
          p.base_stock, p.current_qty, p.min_stock, p.max_stock, p.unit, p.machine, p.supplier, p.notes,
          p.createdBy, p.updatedBy, p.createdAt, p.updatedAt,
        ],
      );
      starlingerIdMap.set(p.id, r.rows[0].id);
    }
    console.log(`✅ Migrated ${starlingerItems.rows.length} Starlinger items.`);

    const starlingerLog = await client.query('SELECT * FROM starlinger_spare_parts_log ORDER BY id');
    let starlingerLogCount = 0;
    for (const l of starlingerLog.rows) {
      const newItemId = starlingerIdMap.get(l.part_id);
      if (!newItemId) continue;
      await client.query(
        `INSERT INTO spare_parts_log (item_id, log_date, transaction_type, qty, description, technician, remark, "createdBy", "createdAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [newItemId, l.log_date, l.transaction_type, l.qty, l.description, l.technician, l.remark, l.createdBy, l.createdAt],
      );
      starlingerLogCount++;
    }
    console.log(`✅ Migrated ${starlingerLogCount} Starlinger log entries.`);

    // ---- MEC items + log ----
    const mecItems = await client.query('SELECT * FROM mec_spare_parts ORDER BY id');
    const mecIdMap = new Map();
    for (const p of mecItems.rows) {
      const r = await client.query(
        `INSERT INTO spare_parts_items
           (catalog_id, part_no, description, base_stock, current_qty, min_stock, unit,
            "createdBy", "updatedBy", "createdAt", "updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id`,
        [
          mecCatalogId, p.part_code, p.name, p.opening_stock, p.current_qty, p.reorder_threshold, p.unit,
          p.createdBy, p.updatedBy, p.createdAt, p.updatedAt,
        ],
      );
      mecIdMap.set(p.id, r.rows[0].id);
    }
    console.log(`✅ Migrated ${mecItems.rows.length} MEC items.`);

    const mecLog = await client.query('SELECT * FROM mec_spare_parts_log ORDER BY id');
    let mecLogCount = 0;
    for (const l of mecLog.rows) {
      const newItemId = mecIdMap.get(l.part_id);
      if (!newItemId) continue;
      await client.query(
        `INSERT INTO spare_parts_log (item_id, log_date, transaction_type, qty, description, technician, remark, "createdBy", "createdAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [newItemId, l.log_date, l.transaction_type, l.qty, l.description, l.technician, l.remark, l.createdBy, l.createdAt],
      );
      mecLogCount++;
    }
    console.log(`✅ Migrated ${mecLogCount} MEC log entries.`);

    await client.query('COMMIT');
    console.log('Done. (Old starlinger_spare_parts* / mec_spare_parts* tables are untouched and can be dropped later.)');
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
