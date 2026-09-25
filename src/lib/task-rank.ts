// How jobs in different units are ranked against each other (2026-09-25).
//
// A job counts units, tokens or micro-dollars (task_budgets.unit), so its
// used_units alone cannot rank it against another job: $0.50 is 500,000
// micro-dollars and would outrank a $2.00 job that used 400,000 tokens, and a
// 400,000-token job would outrank a $0.30 job purely by magnitude. The rule,
// shared by GET /tasks?sort=used, the MCP top_jobs tool and the console's
// Most used order, so the three can never rank one account differently:
//
//   1. Jobs with a dollar figure first, dearest first. A job in dollars counts
//      its own ledger (used_units / 1,000,000: its calls at list price, an
//      unpriced call at the estimate it was charged); a job in tokens or units
//      counts the list price the server stored on its priced calls
//      (events.list_price_usd), which is null when none was priced.
//   2. Then the jobs with no dollar figure, tokens before units, each group by
//      its own used_units, most first. Numbers are only ever compared inside
//      one unit.
//   3. Ties, newest first.
//
// An account whose jobs are all in units and have no priced call gets exactly
// the order it always had: used_units DESC, created_at DESC.

/** The dollar figure a job is ranked by, as SQL over the task_budgets row `t`. NULL when it has none. */
export const rankUsdSql = (t: string) => `(CASE WHEN ${t}.unit = 'usd' THEN ${t}.used_units::numeric / 1000000
  ELSE (SELECT sum(r.list_price_usd) FROM events r WHERE r.account_id = ${t}.account_id AND r.task_ref = ${t}.task_ref) END)`

/** The ORDER BY list for "most used first", over the task_budgets row `t`. */
export const rankOrderSql = (t: string) =>
  `${rankUsdSql(t)} DESC NULLS LAST, CASE ${t}.unit WHEN 'token' THEN 0 WHEN 'unit' THEN 1 ELSE 2 END, ${t}.used_units DESC, ${t}.created_at DESC`

/** The one sentence that says so, for the answers that carry a ranking. */
export const RANK_RULE =
  'Ranked by the estimated dollar cost at public list price where a job has one (a job in dollars by its own ledger, any other job by its priced calls), dearest first; ' +
  'then the jobs with no dollar figure, tokens before units, each by its own count. Numbers in different units are never compared.'
