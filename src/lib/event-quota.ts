import { PLAN_LIMITS, upgradeUrlFor } from '../integrations/polar.js'

// The monthly allowance of records and steps (security batch C, S7, 2026-09-25).
//
// Until this, POST /events and POST /step counted against nothing: the plan's
// quota was preflight calls only, so a free account could store as many
// events as it could send. The decision, and why it is this one:
//
//   A record that settles the open reservation its own preflight made (it
//   names it with reservation_id) is paid for by that preflight's call: it
//   is never refused and uses none of the allowance. That is the record
//   wrap() makes after every approved call.
//
//   Everything else that stores a row, a record with no live reservation to
//   settle and every step, uses a monthly allowance of
//   EVENTS_PER_PREFLIGHT_CALL per preflight call the plan includes: free
//   3,000, Builder 150,000, Team 1,500,000, Scale 6,000,000. The legacy
//   'paid' plan stays uncapped, as its preflight calls are.
//
//   Not "an event costs a call". A measured call through wrap() is one
//   preflight and one record, so counting records against monthly_calls
//   would halve every plan the day this shipped, and the plans are sold as
//   preflight calls (/pricing, src/ui/tiers.ts). Pricing is not this change's
//   to move. And a record that settles a reservation must not be refusable:
//   its spend already happened, and a refused settle leaves it off the job
//   while the sweeper frees what was held, a ceiling looser than the truth.
//   What the allowance bounds is the thing S7 found: rows stored with no cap.
//
// What counts: a record that STORES an event (POST /events with success true,
// its idempotency key not seen before) without settling an open reservation
// it names, and every POST /step. What does not: a record that settles its
// own open reservation, a release (success false stores nothing and frees
// budget, so it is never refused either), a duplicate (the first one was
// decided), and a record refused for any other reason.
//
// The one residual: a record refused here has no reservation of its own to
// settle (that is what made it countable), so its units are not on the job.
// Such a record was made without a preflight, which is the path on which no
// ceiling is checked in the first place.
//
// Concurrency: the check and the increment are one conditional UPDATE, so of
// N records at the edge of the allowance exactly the ones with room pass, and
// none is refused while there was room. The records route takes the account
// row first (lockAccountForEvents), in the order preflight takes it (account,
// then customer), so a record and a preflight on one account cannot deadlock.
// Both are gated in scripts/preflight/batchc-gates.mjs with 40 in parallel.

export const EVENTS_PER_PREFLIGHT_CALL = 3

/** The monthly records-and-steps allowance of a plan, or null for no cap. */
export function eventLimitFor(plan: string): number | null {
  if (plan === 'paid') return null
  return (PLAN_LIMITS[plan] ?? PLAN_LIMITS.free) * EVENTS_PER_PREFLIGHT_CALL
}

type Tx = any

/**
 * Take the account row for this transaction and read its plan. FOR NO KEY
 * UPDATE, the lock an UPDATE of a non-key column takes, so it queues behind
 * a preflight holding the row exactly as the UPDATE would, but does not block
 * the foreign-key checks of inserts elsewhere (FOR UPDATE would).
 */
export async function lockAccountForEvents(tx: Tx, accountId: string): Promise<{ plan: string } | null> {
  const [row] = await tx`SELECT plan FROM accounts WHERE id = ${accountId} FOR NO KEY UPDATE`
  return row ? { plan: (row.plan as string) ?? 'free' } : null
}

export type EventClaim = { ok: true; monthlyEvents: number } | { ok: false; monthlyEvents: number }

/**
 * Claim one record or step of this month's allowance. One statement: the
 * check, the increment and the period roll. Rolling the period zeroes
 * monthly_calls too, as preflight's roll zeroes monthly_events, so the two
 * counters always describe the same billing month.
 */
export async function claimEvent(tx: Tx, accountId: string, limit: number | null): Promise<EventClaim> {
  const [row] = await tx`
    UPDATE accounts
    SET monthly_events = CASE
          WHEN billing_period_start < date_trunc('month', CURRENT_DATE)::DATE THEN 1
          ELSE monthly_events + 1
        END,
        monthly_calls = CASE
          WHEN billing_period_start < date_trunc('month', CURRENT_DATE)::DATE THEN 0
          ELSE monthly_calls
        END,
        billing_period_start = CASE
          WHEN billing_period_start < date_trunc('month', CURRENT_DATE)::DATE
          THEN date_trunc('month', CURRENT_DATE)::DATE
          ELSE billing_period_start
        END
    WHERE id = ${accountId}
      AND (
        ${limit}::int IS NULL
        OR billing_period_start < date_trunc('month', CURRENT_DATE)::DATE
        OR monthly_events < ${limit}
      )
    RETURNING monthly_events
  `
  if (row) return { ok: true, monthlyEvents: Number(row.monthlyEvents) }
  const [cur] = await tx`SELECT monthly_events FROM accounts WHERE id = ${accountId}`
  return { ok: false, monthlyEvents: Number(cur?.monthlyEvents ?? limit ?? 0) }
}

/** HTTP 402: a refusal a client must not read as a stored record. */
export const EVENT_QUOTA_STATUS = 402

/**
 * The refusal, in preflight's quota shape: approved false, the same reason
 * names (free_tier_exceeded, plan_limit_exceeded), the plan and the same
 * upgrade_url, with this counter's numbers beside them.
 *
 * Its status is 402, not the 200 preflight answers with, on purpose: a
 * preflight refusal is a decision the SDK reads, and a record refused with a
 * 200 would be taken for a stored record by both SDKs' wrap(), which only
 * look at the body for a duplicate. On a 402 both raise inside wrap()'s
 * settle, which catches it and warns (RuntimeWarning in Python,
 * AgentBillWarning in Node): the provider's answer is still returned, and the
 * run goes on. gated in batchc-gates.mjs with both SDKs' real wrap().
 */
export function eventQuotaRefusal(accountId: string, plan: string, monthlyEvents: number, limit: number) {
  const reason = plan === 'free' ? 'free_tier_exceeded' : 'plan_limit_exceeded'
  return {
    approved: false,
    recorded: false,
    error: reason,
    reason,
    quota: 'events',
    plan,
    monthly_events: monthlyEvents,
    events_limit: limit,
    upgrade_url: upgradeUrlFor(accountId),
    message: `This account has stored its ${limit.toLocaleString('en-US')} records and steps for this billing month, so this one was not stored. It resets on the 1st, or upgrade: ${upgradeUrlFor(accountId)}`,
  }
}
