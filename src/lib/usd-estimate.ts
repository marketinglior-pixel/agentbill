import { microsFromListPrice } from './task-ceiling.js'

// What preflight reserves on a job whose ceiling is in dollars (T3,
// 2026-09-25), when the caller does not say.
//
// The order, and why:
//   1. The caller's own estimate, when it passes one in dollars
//      (estimated_usd, or estimated_units with unit "usd", in micro-dollars).
//      Nobody knows the next call better than the code about to make it.
//   2. The job's recent median: percentile_disc(0.5) over the list price of
//      its last USD_HISTORY_CALLS priced calls, read from events.task_ref
//      (migration 017, indexed by 018). The median, not the mean, so one
//      outlier call does not set the reservation for every call after it.
//   3. USD_DEFAULT_ESTIMATE_MICROS, $0.10, before the job has one priced call.
//      Conservative on purpose: a single call to a frontier model with a long
//      prompt can cost several cents, and a reservation that is too big only
//      holds headroom until the record settles it to the actual, while one
//      that is too small lets calls running at the same moment take the job
//      past its ceiling by their difference. A job whose whole ceiling is
//      under $0.10 therefore needs the caller's estimate to run at all, and
//      the refusal says what was asked for.
//
// It is an estimate, not a bound. Record charges the actual list price of the
// tokens the provider reported, so a call bigger than the estimate can land
// past the ceiling by at most that difference, for each call in flight at the
// same moment, and the next preflight is refused. The reservation itself is
// exact: used + reserved + estimate <= ceiling in one conditional UPDATE, the
// same statement every other unit uses.

/** Before a dollar job has a priced call: $0.10 in micro-dollars. */
export const USD_DEFAULT_ESTIMATE_MICROS = 100_000
/** How many of the job's most recent priced calls the median reads. */
export const USD_HISTORY_CALLS = 20

export type EstimateSource = 'caller' | 'job_median' | 'default'

type Tx = { (strings: TemplateStringsArray, ...values: unknown[]): Promise<any[]> } | any

/** The job's own estimate: its recent median, or the default. At least one micro-dollar. */
export async function usdEstimate(tx: Tx, accountId: string, taskRef: string): Promise<{ micros: number; source: EstimateSource }> {
  const [row] = await tx`
    SELECT (percentile_disc(0.5) WITHIN GROUP (ORDER BY list_price_usd))::text AS p50, count(*)::int AS n
    FROM (
      SELECT list_price_usd FROM events
      WHERE account_id = ${accountId} AND task_ref = ${taskRef} AND list_price_usd IS NOT NULL
      ORDER BY created_at DESC, id DESC
      LIMIT ${USD_HISTORY_CALLS}
    ) h
  `
  if (row && Number(row.n) > 0 && row.p50 != null) {
    return { micros: Math.max(1, microsFromListPrice(String(row.p50))), source: 'job_median' }
  }
  return { micros: USD_DEFAULT_ESTIMATE_MICROS, source: 'default' }
}
