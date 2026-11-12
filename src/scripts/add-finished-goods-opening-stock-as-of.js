// The Opening Stock balance is a closing figure "as of" a day from the client's stock movement
// record, which is rarely the day it gets typed into the dashboard. Without this date the
// "produced since" cutoff was the save timestamp, so production between the as-of day and the
// save day was either missed or double counted. Stored as a DATE; production is counted from the
// day after it. NULL keeps the old behaviour (cutoff = first save). Idempotent.
require('dotenv').config();
const pool = require('../config/database');

async function run() {
  await pool.query(`ALTER TABLE finished_goods_opening_stock ADD COLUMN IF NOT EXISTS as_of_date DATE;`);
  console.log('finished_goods_opening_stock.as_of_date ready.');
  await pool.end();
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
