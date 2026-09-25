import { sql } from '../db/index.js'

// Data retention (security batch C, S22, 2026-09-25). OFF by default.
//
// Until this, nothing that the service stores was ever removed: network
// addresses, refusal snapshots, revoked keys, spent sign-in and recovery
// tokens, page events. (Expired OAuth codes and tokens were the exception:
// pruneOAuth has removed them since the remote MCP shipped.) This is the job that
// removes each category once its period has passed, built the way the
// reservation sweeper is: a timer on every machine, bounded batches, FOR
// UPDATE SKIP LOCKED so two machines never fight over a row, and the
// database's clock for every "older than".
//
// RETENTION_MODE:
//   off      (the default, and what any other value means) nothing runs.
//   report   counts, per category, what enforce WOULD remove, logs one line,
//            and changes nothing.
//   enforce  removes exactly the rows past their period, in batches.
// Turning enforce on in production is Lior's decision, after reading the
// report's numbers: `node dist/retention-report.js` (src/retention-report.ts).
//
// The periods, and what each category holds, are the table below. The
// privacy page (/privacy) renders its retention section from this same
// table, so the page cannot promise a period the job does not have.
//
// NEVER removed here, on purpose (the full list, with the reason for each):
//   polar_webhook_deliveries   Polar data: which payment events arrived, the
//                              record behind a disputed or missing upgrade.
//   accounts.plan, polar_customer_id, polar_subscription_id, plan_ends_at,
//   billing_period_start       the plan and its history with the payment
//                              provider: invoices and disputes.
//   account_quota_alerts       the record of each quota mail sent in a billing
//                              period (the count that crossed it): billing
//                              history, and the claim that stops a resend.
//   customer_usage_alerts      the once-per-customer claim behind the usage
//                              mail: removing it sends the mail again.
//   oauth_grants               the record of what access was consented to,
//                              and of its revocation.
//   oauth_requests, oauth_codes, oauth_tokens
//                              not here because they are already removed,
//                              always, by pruneOAuth (src/lib/mcp-oauth.ts,
//                              hourly): OAUTH_PRUNE_AFTER_EXPIRY below is the
//                              period, and /privacy renders it from there.
//   oauth_clients              client metadata (a name, redirect URIs), no
//                              person's data.
//   users, user_identities, accounts, customers, task_budgets, and a live
//   key's row                  the account itself, kept while it exists and
//                              deleted with it on request (/privacy says how).
//   live keys' network records (api_key_ip_origins while its key lives)
//                              the new-network alert needs them: a network
//                              forgotten is a network alerted on again. They
//                              go with the key (ON DELETE CASCADE).
//   in-memory limiter state    never written to the database: per-process
//                              maps, windows of one minute to one hour,
//                              bounded in size, gone on restart.
//   server logs (admin login lines included)
//                              stdout, kept by the host's log stream, not in
//                              this database; nothing here can reach them.

export type RetentionMode = 'off' | 'report' | 'enforce'

export function retentionMode(env: NodeJS.ProcessEnv = process.env): RetentionMode {
  const v = (env.RETENTION_MODE ?? '').trim().toLowerCase()
  return v === 'report' || v === 'enforce' ? v : 'off'
}

type Tx = any

export interface RetentionCategory {
  key: string
  /** What is stored, as /privacy says it. */
  what: string
  /** The period, in days, counted from `from`. */
  days: number
  /** What the period is counted from, as /privacy says it. */
  from: string
  /** What happens at the end of it. */
  action: 'deleted' | 'cleared'
  /** Rows past their period, now. */
  count: (tx: Tx) => Promise<number>
  /** Remove up to `limit` of them; the number removed. */
  apply: (tx: Tx, limit: number) => Promise<number>
}

const n = (rows: { n: number }[]) => Number(rows[0]?.n ?? 0)

// Each category's count and apply carry the same predicate, written side by
// side; the [retention] gates plant rows on both sides of every period and
// check that report's count is exactly what enforce then removes.
export const RETENTION: RetentionCategory[] = [
  {
    key: 'revoked_expired_keys',
    what: 'An API key that was revoked or expired, with its label, the last address it was used from and the networks it was seen from',
    days: 90, from: 'the day it was revoked or expired', action: 'deleted',
    count: async (tx) => n(await tx`
      SELECT count(*)::int AS n FROM developer_api_keys
      WHERE (revoked_at IS NOT NULL AND revoked_at < NOW() - INTERVAL '90 days')
         OR (expires_at IS NOT NULL AND expires_at < NOW() - INTERVAL '90 days')`),
    apply: async (tx, limit) => (await tx`
      DELETE FROM developer_api_keys WHERE id IN (
        SELECT id FROM developer_api_keys
        WHERE (revoked_at IS NOT NULL AND revoked_at < NOW() - INTERVAL '90 days')
           OR (expires_at IS NOT NULL AND expires_at < NOW() - INTERVAL '90 days')
        LIMIT ${limit} FOR UPDATE SKIP LOCKED)
      RETURNING id`).length,
  },
  {
    key: 'key_network_first_address',
    what: 'The full address a key was first seen from on a new network (the network itself is kept while the key lives, for the new-network alert)',
    days: 90, from: 'the day the network was first seen', action: 'cleared',
    // Not the networks of a key that is itself past its period: those go
    // with the key (the category above, ON DELETE CASCADE), and counting them
    // here too made report promise more than enforce does (caught by the
    // [retention] gates on the first run).
    count: async (tx) => n(await tx`
      SELECT count(*)::int AS n FROM api_key_ip_origins o
      WHERE o.last_ip IS NOT NULL AND o.first_seen_at < NOW() - INTERVAL '90 days'
        AND NOT EXISTS (SELECT 1 FROM developer_api_keys k WHERE k.id = o.api_key_id
          AND ((k.revoked_at IS NOT NULL AND k.revoked_at < NOW() - INTERVAL '90 days')
            OR (k.expires_at IS NOT NULL AND k.expires_at < NOW() - INTERVAL '90 days')))`),
    apply: async (tx, limit) => (await tx`
      UPDATE api_key_ip_origins SET last_ip = NULL WHERE id IN (
        SELECT o.id FROM api_key_ip_origins o
        WHERE o.last_ip IS NOT NULL AND o.first_seen_at < NOW() - INTERVAL '90 days'
          AND NOT EXISTS (SELECT 1 FROM developer_api_keys k WHERE k.id = o.api_key_id
            AND ((k.revoked_at IS NOT NULL AND k.revoked_at < NOW() - INTERVAL '90 days')
              OR (k.expires_at IS NOT NULL AND k.expires_at < NOW() - INTERVAL '90 days')))
        LIMIT ${limit} FOR UPDATE OF o SKIP LOCKED)
      RETURNING id`).length,
  },
  {
    key: 'decision_snapshots',
    what: 'A preflight refusal and its snapshot: the answer your agent got, with the agent, customer and job ids in it',
    days: 180, from: 'the refusal', action: 'deleted',
    count: async (tx) => n(await tx`
      SELECT count(*)::int AS n FROM preflight_decisions WHERE created_at < NOW() - INTERVAL '180 days'`),
    apply: async (tx, limit) => (await tx`
      DELETE FROM preflight_decisions WHERE id IN (
        SELECT id FROM preflight_decisions WHERE created_at < NOW() - INTERVAL '180 days'
        LIMIT ${limit} FOR UPDATE SKIP LOCKED)
      RETURNING id`).length,
  },
  {
    key: 'preflight_replays',
    what: 'The stored answer to a preflight sent with an idempotency_key, kept so a retry gets the same answer',
    days: 30, from: 'the preflight', action: 'deleted',
    count: async (tx) => n(await tx`
      SELECT count(*)::int AS n FROM preflight_requests WHERE created_at < NOW() - INTERVAL '30 days'`),
    apply: async (tx, limit) => (await tx`
      DELETE FROM preflight_requests WHERE id IN (
        SELECT id FROM preflight_requests WHERE created_at < NOW() - INTERVAL '30 days'
        LIMIT ${limit} FOR UPDATE SKIP LOCKED)
      RETURNING id`).length,
  },
  {
    key: 'closed_reservations',
    what: 'A reservation that was settled, released or reclaimed (the open ones are the live budget and are never touched)',
    days: 30, from: 'the day it closed', action: 'deleted',
    count: async (tx) => n(await tx`
      SELECT count(*)::int AS n FROM reservations WHERE released_at IS NOT NULL AND released_at < NOW() - INTERVAL '30 days'`),
    apply: async (tx, limit) => (await tx`
      DELETE FROM reservations WHERE id IN (
        SELECT id FROM reservations WHERE released_at IS NOT NULL AND released_at < NOW() - INTERVAL '30 days'
        LIMIT ${limit} FOR UPDATE SKIP LOCKED)
      RETURNING id`).length,
  },
  {
    key: 'event_metadata',
    what: 'The metadata of a usage record (for wrap(): provider, model, token counts, duration, step); the record itself, its units and its list-price figure are kept',
    days: 400, from: 'the record', action: 'cleared',
    count: async (tx) => n(await tx`
      SELECT count(*)::int AS n FROM events WHERE metadata IS NOT NULL AND created_at < NOW() - INTERVAL '400 days'`),
    apply: async (tx, limit) => (await tx`
      UPDATE events SET metadata = NULL WHERE id IN (
        SELECT id FROM events WHERE metadata IS NOT NULL AND created_at < NOW() - INTERVAL '400 days'
        LIMIT ${limit} FOR UPDATE SKIP LOCKED)
      RETURNING id`).length,
  },
  {
    key: 'step_records',
    what: 'A step recorded with POST /step (agent, step name, units), which the anomaly baseline reads the last 30 of',
    days: 400, from: 'the step', action: 'deleted',
    count: async (tx) => n(await tx`
      SELECT count(*)::int AS n FROM step_costs WHERE created_at < NOW() - INTERVAL '400 days'`),
    apply: async (tx, limit) => (await tx`
      DELETE FROM step_costs WHERE id IN (
        SELECT id FROM step_costs WHERE created_at < NOW() - INTERVAL '400 days'
        LIMIT ${limit} FOR UPDATE SKIP LOCKED)
      RETURNING id`).length,
  },
  {
    key: 'recovery_tokens',
    what: 'A recovery link (stored as a hash) and when it was used',
    days: 30, from: 'its expiry', action: 'deleted',
    count: async (tx) => n(await tx`
      SELECT count(*)::int AS n FROM account_recovery_tokens WHERE expires_at < NOW() - INTERVAL '30 days'`),
    apply: async (tx, limit) => (await tx`
      DELETE FROM account_recovery_tokens WHERE id IN (
        SELECT id FROM account_recovery_tokens WHERE expires_at < NOW() - INTERVAL '30 days'
        LIMIT ${limit} FOR UPDATE SKIP LOCKED)
      RETURNING id`).length,
  },
  {
    key: 'sign_in_links',
    what: 'An email sign-in link (stored as a hash) and the address it was sent to',
    days: 30, from: 'its expiry', action: 'deleted',
    count: async (tx) => n(await tx`
      SELECT count(*)::int AS n FROM email_sign_in_tokens WHERE expires_at < NOW() - INTERVAL '30 days'`),
    apply: async (tx, limit) => (await tx`
      DELETE FROM email_sign_in_tokens WHERE id IN (
        SELECT id FROM email_sign_in_tokens WHERE expires_at < NOW() - INTERVAL '30 days'
        LIMIT ${limit} FOR UPDATE SKIP LOCKED)
      RETURNING id`).length,
  },
  {
    key: 'page_events',
    what: 'A first-party page event on the marketing pages (which event, a per-view id, the demo ceiling, a source label)',
    days: 180, from: 'the event', action: 'deleted',
    count: async (tx) => n(await tx`
      SELECT count(*)::int AS n FROM site_pulse WHERE created_at < NOW() - INTERVAL '180 days'`),
    apply: async (tx, limit) => (await tx`
      DELETE FROM site_pulse WHERE id IN (
        SELECT id FROM site_pulse WHERE created_at < NOW() - INTERVAL '180 days'
        LIMIT ${limit} FOR UPDATE SKIP LOCKED)
      RETURNING id`).length,
  },
]

/** Per category, the rows past their period now. Reads only. */
export async function retentionCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const c of RETENTION) out[c.key] = await c.count(sql)
  return out
}

const BATCH = 1_000
const MAX_BATCHES_PER_CATEGORY = 50

/**
 * One pass. report: the counts, nothing written. enforce: each category in
 * batches of BATCH, each batch its own transaction, until a batch comes back
 * short or MAX_BATCHES_PER_CATEGORY (50,000 rows) is reached; the rest waits
 * for the next pass. off: nothing, and says so.
 */
export async function runRetention(mode: RetentionMode): Promise<{ mode: RetentionMode; counts: Record<string, number> }> {
  if (mode === 'off') return { mode, counts: {} }
  if (mode === 'report') return { mode, counts: await retentionCounts() }
  const counts: Record<string, number> = {}
  for (const c of RETENTION) {
    let total = 0
    for (let i = 0; i < MAX_BATCHES_PER_CATEGORY; i++) {
      const done = await sql.begin((tx) => c.apply(tx, BATCH))
      total += done
      if (done < BATCH) break
    }
    counts[c.key] = total
  }
  return { mode, counts }
}

const DAY_MS = 24 * 60 * 60_000

/**
 * Start the job on this machine, per RETENTION_MODE. Off (the default) starts
 * nothing. The first pass waits RETENTION_FIRST_RUN_MS (default ten minutes),
 * so a deploy's restarts are not a burst of passes; then one a day.
 */
export function startRetention(env: NodeJS.ProcessEnv = process.env): RetentionMode {
  const mode = retentionMode(env)
  if (mode === 'off') return mode
  const first = Math.max(0, Number(env.RETENTION_FIRST_RUN_MS ?? 10 * 60_000) || 0)
  const tick = async () => {
    try {
      const r = await runRetention(mode)
      console.log(`[retention] ${mode === 'report' ? 'report (nothing deleted): would remove' : 'enforce: removed'} ${JSON.stringify(r.counts)}`)
    } catch (err) {
      console.error(`[retention] ${mode} pass failed:`, (err as Error).message)
    }
  }
  console.log(`[retention] RETENTION_MODE=${mode}: first pass in ${Math.round(first / 1000)} s, then daily`)
  const t1 = setTimeout(() => {
    void tick()
    const t2 = setInterval(() => { void tick() }, DAY_MS)
    t2.unref()
  }, first)
  t1.unref()
  return mode
}
