/**
 * CLI for the Google Form PB register migration — see src/services/pbHistoryImport.js for the rules.
 *
 *   node src/scripts/import-pb-history.js <PB_Upload_Format.xlsx> <PB (Responses).xlsx>            dry run
 *   node src/scripts/import-pb-history.js <PB_Upload_Format.xlsx> <PB (Responses).xlsx> --commit   write
 *
 * The same import can be run from the portal: Procurement → Approval Settings → Import PB history
 * (admin only), which is the way to go when the server is only reachable through the AWS console.
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const pool = require('../config/database');
const { importPbHistory, reportCsv } = require('../services/pbHistoryImport');

const [, , fmtPath, respPath, ...flags] = process.argv;
const COMMIT = flags.includes('--commit');
if (!fmtPath || !respPath) {
  console.error('usage: node src/scripts/import-pb-history.js <PB_Upload_Format.xlsx> <PB (Responses).xlsx> [--commit]');
  process.exit(1);
}

(async () => {
  try {
    const { summary, report } = await importPbHistory({ format: fmtPath, responses: respPath, commit: COMMIT });
    console.log(`\nPBs in upload format: ${summary.pbs}  · lines: ${summary.lines}  · form register rows: ${summary.register_rows}`);
    console.log('status after import:', summary.by_status);
    console.log('category:', summary.by_category);
    console.log('department:', summary.by_department);
    console.log('date range:', summary.date_from, '→', summary.date_to);
    if (summary.warnings) console.log(`warnings: ${summary.warnings} (see report)`);
    console.log(COMMIT
      ? `\nCOMMITTED: ${summary.inserted} PBs inserted, ${summary.skipped} skipped (already present).`
      : `\nDRY RUN (nothing written): ${summary.inserted} PBs would be inserted, ${summary.skipped} skipped (already present).`);
    if (summary.departments_created.length) console.log('departments ' + (COMMIT ? 'created' : 'to create') + ':', summary.departments_created.join(' · '));
    const out = path.join(path.dirname(fmtPath), `pb-import-report${COMMIT ? '' : '-dryrun'}.csv`);
    fs.writeFileSync(out, reportCsv(report), 'utf8');
    console.log('report:', out);
  } catch (err) {
    console.error('✗ import failed, nothing written:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
