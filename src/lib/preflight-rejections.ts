import type { FastifyBaseLogger } from 'fastify'
import { sql } from '../db/index.js'

// The preflights answered 422, counted (2026-09-27, migration 036).
//
// A 422 is a call the server could not decide: a new job with no ceiling
// (task_ceiling_required), a unit that is not the job's (task_unit_mismatch),
// a body that does not parse (validation_error). Nothing was reserved and no
// quota was burned, so until now nothing recorded it, and "why do accounts
// with a key never record a call?" had no data on this suspect. The count is
// per account, per reason, per UTC day; nothing of the request is stored.
//
// Counting must never change the answer: a failure here is logged and the
// caller still gets its 422.

/** The reason a 422 body names, or "unknown" when it names none we can store. */
export function rejectionReason(body: unknown): string {
  const e = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined
  return typeof e === 'string' && /^[a-z_]{1,40}$/.test(e) ? e : 'unknown'
}

export async function noteRejection(accountId: string, reason: string, log: FastifyBaseLogger): Promise<void> {
  try {
    await sql`
      INSERT INTO preflight_rejections (account_id, reason, day)
      VALUES (${accountId}, ${reason}, (now() AT TIME ZONE 'UTC')::date)
      ON CONFLICT (account_id, reason, day)
      DO UPDATE SET n = preflight_rejections.n + 1, last_at = now()`
  } catch (err) {
    log.warn({ err, reason }, 'preflight 422 not counted')
  }
}

export type RejectionRow = {
  reason: string
  /** Accounts that got it in the window. */
  accounts: number
  /** Times it was answered in the window. */
  times: number
  /** Of those accounts, how many have never recorded a call at all. */
  neverCalled: number
  /** Of those accounts, how many recorded a call after their first one of these. */
  calledAfter: number
  last: string
}

/** Per reason over the last `days` days, dearest first. */
export async function loadRejections(days = 30): Promise<RejectionRow[]> {
  const rows = await sql`
    WITH r AS (
      SELECT account_id, reason, sum(n)::int AS times, min(first_at) AS first_at, max(last_at) AS last_at
      FROM preflight_rejections WHERE day >= (now() AT TIME ZONE 'UTC')::date - ${days}::int
      GROUP BY account_id, reason)
    SELECT r.reason,
           count(*)::int AS accounts,
           sum(r.times)::int AS times,
           count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.account_id = r.account_id))::int AS never_called,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM events e WHERE e.account_id = r.account_id AND e.created_at > r.first_at))::int AS called_after,
           max(r.last_at) AS last
    FROM r GROUP BY r.reason ORDER BY sum(r.times) DESC, r.reason`
  return rows.map((x) => ({ reason: x.reason, accounts: x.accounts, times: x.times, neverCalled: x.neverCalled, calledAfter: x.calledAfter,
    last: new Date(x.last).toISOString() }))
}
