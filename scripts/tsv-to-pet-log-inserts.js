#!/usr/bin/env node
/**
 * Convert tab-separated PET production_logs export to SQL INSERT batches.
 * Usage: node scripts/tsv-to-pet-log-inserts.js ./pet_production_logs.tsv > pet_logs.sql
 */
const fs = require('fs');
const path = process.argv[2];

if (!path || !fs.existsSync(path)) {
  console.error('Usage: node scripts/tsv-to-pet-log-inserts.js <file.tsv>');
  process.exit(1);
}

const raw = fs.readFileSync(path, 'utf8');
const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
const header = lines[0].split('\t').map((h) => h.trim());

const cols = [
  'shift_id',
  'station_id',
  'input_bag_qr',
  'output_bag_qr',
  'weight',
  'photo_url',
  'status',
  'created_at',
  'material_type_id',
  'sub_line',
  'used_line',
  'remark',
];

function sqlStr(v) {
  if (v === undefined || v === null) return 'NULL';
  const t = String(v).trim();
  if (t === '' || t.toUpperCase() === 'NULL') return 'NULL';
  return `'${t.replace(/'/g, "''")}'`;
}

function sqlNum(v) {
  if (v === undefined || v === null) return 'NULL';
  const t = String(v).trim();
  if (t === '' || t.toUpperCase() === 'NULL') return 'NULL';
  return t;
}

const rows = [];
for (let i = 1; i < lines.length; i++) {
  const parts = lines[i].split('\t');
  if (parts.length < header.length) continue;
  const row = {};
  header.forEach((h, idx) => {
    row[h] = parts[idx] !== undefined ? parts[idx] : '';
  });
  rows.push(row);
}

console.log('-- PET production_logs import');
console.log('-- Rows:', rows.length);
console.log('BEGIN;');
console.log(`
DELETE FROM production_logs pl
USING operator_shifts os
WHERE pl.shift_id = os.id AND os.material_type_id = 3;
`);

const BATCH = 25;
for (let b = 0; b < rows.length; b += BATCH) {
  const chunk = rows.slice(b, b + BATCH);
  const values = chunk
    .map((r) => {
      return `(${cols.map((c) => {
        if (c === 'weight') return sqlNum(r[c]);
        if (c === 'shift_id' || c === 'station_id' || c === 'material_type_id') return sqlNum(r[c]);
        return sqlStr(r[c]);
      }).join(', ')})`;
    })
    .join(',\n  ');
  console.log(`INSERT INTO production_logs (${cols.join(', ')}) VALUES\n  ${values};\n`);
}

console.log(`
SELECT setval(
  pg_get_serial_sequence('production_logs', 'id'),
  COALESCE((SELECT MAX(id) FROM production_logs), 1)
);
COMMIT;
`);
