'use strict';
/**
 * Packaging (pm_item) stock lives in two independent pools:
 *   SALES  — actual stock that can be dispatched to a customer. Fed by stock-in (pool SALES),
 *            corrections, the warehouse cut-off opening and "Return to warehouse" issues;
 *            reduced by Sales / Dispatch, legacy outgoing (before pools) and SALES damage.
 *   MOVING — production circulation. Fed by stock-in (pool MOVING), corrections and the opening;
 *            reduced by Daily moving, Special case OUT and MOVING damage.
 * Low-stock alerts and the auto-draft PB look at the SALES pool only, which is exactly why the
 * client wanted the split: daily production use must not trigger false reorder alarms.
 */
const POOLS = ['SALES', 'MOVING'];
const MOVEMENT_TYPES = ['SALES_DISPATCH', 'DAILY_MOVING', 'SPECIAL_CASE', 'RETURN', 'LEGACY'];
const SALES_OUT = ['SALES_DISPATCH', 'LEGACY'];
const MOVING_OUT = ['DAILY_MOVING', 'SPECIAL_CASE'];

/** Which pool an outgoing movement draws from (RETURN adds to SALES instead). */
function poolForMovement(movementType) {
  if (MOVING_OUT.includes(movementType)) return 'MOVING';
  return 'SALES';
}

/** SQL expression (part id bound as $<n>) for one pool's balance. */
function poolBalanceSql(pool, p = '$1') {
  const outTypes = pool === 'SALES' ? SALES_OUT : MOVING_OUT;
  const outList = outTypes.map((t) => `'${t}'`).join(',');
  return `(
      COALESCE((SELECT SUM(qty) FROM parts_pool_opening WHERE part_id=${p} AND pool='${pool}'),0)
    + COALESCE((SELECT SUM(quantity_received) FROM parts_stock_in WHERE part_id=${p} AND pool='${pool}'),0)
    + COALESCE((SELECT SUM(variance) FROM parts_stock_correction WHERE part_id=${p} AND status='approved' AND pool='${pool}'),0)
    - COALESCE((SELECT SUM(quantity_sent) FROM parts_outgoing WHERE part_id=${p} AND status IN ('issued','received') AND movement_type IN (${outList})),0)
    ${pool === 'SALES' ? `+ COALESCE((SELECT SUM(quantity_sent) FROM parts_outgoing WHERE part_id=${p} AND status IN ('issued','received') AND movement_type = 'RETURN'),0)` : ''}
    - COALESCE((SELECT SUM(quantity_affected) FROM parts_damage_waste WHERE part_id=${p} AND status='approved' AND pool='${pool}'),0)
  )`;
}

async function poolQty(client, partId, pool = 'SALES') {
  const r = await client.query(`SELECT ${poolBalanceSql(pool)} AS qty`, [partId]);
  return parseFloat(r.rows[0].qty) || 0;
}

async function bothPools(client, partId) {
  const r = await client.query(`SELECT ${poolBalanceSql('SALES')} AS sales, ${poolBalanceSql('MOVING')} AS moving`, [partId]);
  return { sales: parseFloat(r.rows[0].sales) || 0, moving: parseFloat(r.rows[0].moving) || 0 };
}

module.exports = { POOLS, MOVEMENT_TYPES, SALES_OUT, MOVING_OUT, poolForMovement, poolBalanceSql, poolQty, bothPools };
