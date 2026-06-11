/**
 * Parts / Packaging-Material (PM) inventory — create the pm_item master table
 * and seed the cleaned catalog (15 distinct items).
 *
 * Idempotent: table is created IF NOT EXISTS; seed rows use ON CONFLICT (code) DO NOTHING
 * so re-running never overwrites edits made in the dashboard.
 *
 * Usage:
 *   node src/scripts/add-parts-inventory.js
 */
require('dotenv').config();
const pool = require('../config/database');

const ITEMS = [
  ['PM-JMB-001', 'Jumbo Bag 95x95x115 with Inner + Pocket - Production',        'Jumbo Bag', 'PCS', '95x95x115',     '',            'Production',  40000],
  ['PM-JMB-002', 'Jumbo Bag 95x95x115 with Inner + Pocket - Stuffing',          'Jumbo Bag', 'PCS', '95x95x115',     'Cream Strap', 'Stuffing',    143000],
  ['PM-JMB-003', 'Jumbo Bag 95x95x115 with Inner + Pocket - Stuffing',          'Jumbo Bag', 'PCS', '95x95x115',     'Blue Strap',  'Stuffing',    143000],
  ['PM-JMB-004', 'Jumbo Bag 95x95x115 No Inner + Top Rope for Rapid PET',       'Jumbo Bag', 'PCS', '95x95x115',     'White Strap', 'Rapid PET',   115000],
  ['PM-JMB-005', 'Jumbo Bag 92.5x92.5x110 with Inner + Pocket - Stuffing',      'Jumbo Bag', 'PCS', '92.5x92.5x110', 'White Strap', 'Stuffing',    146000],
  ['PM-JMB-006', 'Jumbo Bag 95x95x115 No Inner + Top Rope for Washing PET',     'Jumbo Bag', 'PCS', '95x95x115',     'Black Strap', 'Washing PET', 115000],
  ['PM-STR-BLK', 'PET Strapping Band 15 x 0.75 - 1,570 M',                      'Strapping', 'ROL', '15 x 0.75 mm, 1,570 m/roll', 'Black',  '', 395000],
  ['PM-STR-SLV', 'PET Strapping Band 15 x 0.75 - 1,570 M',                      'Strapping', 'ROL', '15 x 0.75 mm, 1,570 m/roll', 'Silver', '', 395000],
  ['PM-STR-GRN', 'PET Strapping Band 15 x 0.75 - 1,570 M',                      'Strapping', 'ROL', '15 x 0.75 mm, 1,570 m/roll', 'Green',  '', 395000],
  ['PM-STR-BLU', 'PET Strapping Band 15 x 0.75 - 1,570 M',                      'Strapping', 'ROL', '15 x 0.75 mm, 1,570 m/roll', 'Blue',   '', 395000],
  ['PM-PPR-BRN', 'Paper Bag - Brown',                                          'Paper Bag', 'LBR', '', 'Brown', '', 4875],
  ['PM-PPR-WHT', 'Paper Bag - White',                                          'Paper Bag', 'LBR', '', 'White', '', 3306],
  ['PM-CLM-001', 'Clam Micho',                                                 'Consumable', 'PCS', '', '', '', 300],
  ['PM-PAL-001', 'Pallet Kayu 110x110x14',                                     'Pallet',    'PCS', '110x110x14', '', '', 130000],
  ['PM-WRP-001', 'Wrapping Plastic',                                           'Wrapping',  'ROL', '', '', '', 385000],
];

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS pm_item (
        id            SERIAL PRIMARY KEY,
        code          VARCHAR(40) UNIQUE NOT NULL,
        description   TEXT NOT NULL,
        category      VARCHAR(40),
        uom           VARCHAR(10),
        size_spec     TEXT,
        variant       VARCHAR(40),
        use_stage     VARCHAR(40),
        unit_price    NUMERIC(14,2) DEFAULT 0,
        supplier      VARCHAR(120),
        reorder_level NUMERIC(14,2) DEFAULT 0,
        is_active     BOOLEAN DEFAULT TRUE,
        created_by    VARCHAR(120),
        updated_by    VARCHAR(120),
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('✅ pm_item table ready');

    let seeded = 0;
    for (const [code, description, category, uom, size_spec, variant, use_stage, unit_price] of ITEMS) {
      const r = await client.query(
        `INSERT INTO pm_item (code, description, category, uom, size_spec, variant, use_stage, unit_price, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'seed')
         ON CONFLICT (code) DO NOTHING`,
        [code, description, category, uom, size_spec, variant, use_stage, unit_price],
      );
      seeded += r.rowCount;
    }
    await client.query('COMMIT');
    console.log(`✅ Seeded ${seeded} new parts (existing rows left untouched). Total items: ${ITEMS.length}`);
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
