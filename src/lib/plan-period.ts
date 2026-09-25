import { sql } from '../db/index.js'

// A canceled plan runs to the end of the period that was paid for (security
// batch C, S24, migration 029, 2026-09-25).
//
// subscription.canceled no longer downgrades. It schedules the end, in
// accounts.plan_ends_at, from what Polar sends: ends_at, or else
// current_period_end (both documented on Polar's Subscription object). Two
// things then make the end real, and they cannot disagree because both ask
// the database's clock:
//
//   at read time  every read that decides what a plan allows reads the plan
//                 through the same CASE (EFFECTIVE_PLAN_SQL below, written out
//                 in each query): once plan_ends_at has passed it is 'free'.
//                 Preflight's quota, the records allowance and the console
//                 all read it this way, so there is no window in which a
//                 lapsed plan still buys calls.
//   the sweeper   sweepEndedPlans() writes the downgrade, the way
//                 subscription.revoked always has (plan free, counters zeroed
//                 into a new period), on the reservation sweeper's tick.
//
// subscription.revoked still downgrades at once: Polar sends it when access
// ends. subscription.uncanceled clears the scheduled end.

/**
 * The plan column as every enforcing read reads it. Not interpolated (a
 * fragment would make each query's text depend on this string at runtime);
 * each query writes it out and names this constant in a comment, and the
 * harness gates the behaviour, not the spelling.
 */
export const EFFECTIVE_PLAN_SQL =
  "CASE WHEN plan_ends_at IS NOT NULL AND plan_ends_at <= NOW() THEN 'free' ELSE plan END"

/**
 * Polar's end of a canceled subscription, or null when the payload names none
 * this server can read. ends_at is "when the subscription will end";
 * current_period_end is the end of the period being paid for, and is what a
 * cancel at period end runs to. ended_at, when a cancel was immediate.
 */
export function periodEndOf(data: Record<string, unknown>): Date | null {
  for (const k of ['ended_at', 'ends_at', 'current_period_end', 'endedAt', 'endsAt', 'currentPeriodEnd']) {
    const v = data[k]
    if (typeof v !== 'string' || v.length > 64) continue
    const t = Date.parse(v)
    if (Number.isFinite(t)) return new Date(t)
  }
  return null
}

const BATCH = 500

/** Write the downgrade for every plan whose scheduled end has passed. Returns the count. */
export async function sweepEndedPlans(): Promise<number> {
  const rows = await sql`
    UPDATE accounts
    SET plan                  = 'free',
        polar_customer_id     = NULL,
        polar_subscription_id = NULL,
        plan_ends_at          = NULL,
        monthly_calls         = 0,
        monthly_events        = 0,
        billing_period_start  = date_trunc('month', CURRENT_DATE)::DATE
    WHERE id IN (
      SELECT id FROM accounts
      WHERE plan_ends_at IS NOT NULL AND plan_ends_at <= NOW()
      ORDER BY plan_ends_at
      LIMIT ${BATCH}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `
  return rows.length
}
