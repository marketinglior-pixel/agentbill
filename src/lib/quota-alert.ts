import type { FastifyBaseLogger } from 'fastify'
import { mailUser, mailerReady } from './mail.js'
import { sql } from '../db/index.js'
import { ORIGIN } from '../ui/site.js'

// A customer approaching, and then reaching, the monthly plan quota is told.
//
// The quota refusal is deliberately quiet on the wire: preflight answers
// approved: false with free_tier_exceeded or plan_limit_exceeded and an
// upgrade_url, and does not raise, because our billing state must not be able
// to crash someone's agent. The cost of that design is that the first sign of
// "you are out of calls" reaches a log line. Until 2026-09-09 nothing reached
// a person: the only threshold alert in the codebase went to the owner, and
// the console shows a "raise the ceiling" link only on a view the customer has
// to open on purpose.
//
// Three thresholds. 75 and 90 fire on the call that crosses them, on the way
// up; 100 fires on the first refusal. The last one is the one the whole
// feature exists for: the moment an agent starts being refused is the moment
// the developer needs to know, not a log they read later.
//
// Once per threshold per billing period, and that is enforced by the database,
// not by this process. There are two machines and they restart. A claim is an
// INSERT ... ON CONFLICT DO NOTHING against a UNIQUE index, so exactly one
// machine wins exactly once a month, whatever retries or restarts happen. The
// in-memory cooldown below is only a cheap gate in front of that write, so an
// agent hammering past its limit does not turn every refusal into an INSERT.
//
// Nothing here is awaited by the caller. A slow mailer on the preflight path
// would be a latency regression on the one route where latency is the product.


export type QuotaThreshold = 75 | 90 | 100

/** The two thresholds crossed on the way up. 100 is the refusal path. */
const RISING: readonly (75 | 90)[] = [75, 90]

/**
 * Which rising threshold this call crossed, if any. Exact match on the count,
 * because the quota UPDATE is one locked statement that adds exactly one, so
 * every integer is seen by exactly one call and no two calls can both believe
 * they crossed. A call that lands on 751 crossed nothing.
 */
export function thresholdCrossed(monthlyCalls: number, limit: number): 75 | 90 | null {
  for (const t of RISING) if (monthlyCalls === Math.ceil((limit * t) / 100)) return t
  return null
}

const attempts = new Map<string, number>()
const ATTEMPT_COOLDOWN_MS = 60 * 60_000
const MAX_ENTRIES = 10_000

function prune(): void {
  if (attempts.size <= MAX_ENTRIES) return
  let i = 0
  const cut = Math.floor(attempts.size / 2)
  for (const k of attempts.keys()) {
    attempts.delete(k)
    if (++i >= cut) break
  }
}

const num = (n: number) => n.toLocaleString('en-US')
const title = (s: string) => s[0].toUpperCase() + s.slice(1)

export interface QuotaAlert {
  accountId: string
  plan: string
  limit: number
  threshold: QuotaThreshold
  monthlyCalls: number
}

/**
 * Never throws and returns nothing the caller waits on. Called with `void`.
 */
export function alertQuota(log: FastifyBaseLogger, a: QuotaAlert): void {
  const key = `${a.accountId}:${a.threshold}`
  const now = Date.now()
  if (now - (attempts.get(key) ?? 0) < ATTEMPT_COOLDOWN_MS) return
  attempts.set(key, now)
  prune()

  void deliver(log, a).catch((err: unknown) =>
    log.error({ err, accountId: a.accountId, threshold: a.threshold }, 'quota alert failed'),
  )
}

async function deliver(log: FastifyBaseLogger, a: QuotaAlert): Promise<void> {
  // The claim. billing_period_start is read from the row in the same
  // statement, so the claim is keyed on whatever period the quota UPDATE just
  // committed, and a refusal can only happen inside a current period (an old
  // one would have rolled and passed instead).
  const [claim] = await sql`
    INSERT INTO account_quota_alerts (account_id, threshold, billing_period_start, monthly_calls)
    SELECT id, ${a.threshold}, billing_period_start, ${a.monthlyCalls}
    FROM accounts WHERE id = ${a.accountId}
    ON CONFLICT (account_id, threshold, billing_period_start) DO NOTHING
    RETURNING id
  `
  if (!claim) return

  // Audible whether or not a mailer exists. The absence of this line is how the
  // webhook bug hid for months.
  log.warn(
    { accountId: a.accountId, plan: a.plan, threshold: a.threshold, monthlyCalls: a.monthlyCalls, limit: a.limit },
    a.threshold === 100 ? 'plan quota reached, customer being refused' : 'plan quota threshold crossed',
  )

  const [acc] = await sql`
    SELECT email, to_char(billing_period_start + INTERVAL '1 month', 'FMDD FMMonth YYYY') AS resets_on
    FROM accounts WHERE id = ${a.accountId}
  `
  if (!acc?.email) {
    log.warn({ accountId: a.accountId }, 'quota alert: account has no email')
    return
  }
  if (!mailerReady()) {
    log.warn({ accountId: a.accountId }, 'quota alert: no mailer configured')
    return
  }

  // reason 'account': the recipient is the customer's own address and reaching
  // this mail at all takes real usage to 75% of a plan quota, so it is counted
  // and never refused. It is also the only warning a developer gets before
  // their agent starts being refused.
  const sent = await mailUser(log, 'account', acc.email as string, compose(a, acc.resetsOn as string))
  if (!sent) {
    log.error({ accountId: a.accountId, threshold: a.threshold }, 'quota alert: the send did not go out')
    return
  }
  await sql`UPDATE account_quota_alerts SET emailed = true WHERE id = ${claim.id}`
}

/**
 * The copy states what the code does and nothing more. The refusal does not
 * stop, kill, or block anything: preflight returns a result and the caller's
 * own code decides. A mail that says "we stopped your agent" would be false,
 * and it is also the sentence this product has been taking out of its copy
 * since September.
 */
function compose(a: QuotaAlert, resetsOn: string): { subject: string; html: string } {
  const reason = a.plan === 'free' ? 'free_tier_exceeded' : 'plan_limit_exceeded'
  const plan = title(a.plan)
  const raise = `${ORIGIN}/pricing?account_id=${encodeURIComponent(a.accountId)}`
  const refuses = `
    <p>preflight answers <code>approved: false</code> with reason <code>${reason}</code> and an
       <code>upgrade_url</code>. It does not raise: your code gets a result and decides what
       happens next. The count resets on ${resetsOn}.</p>`

  if (a.threshold === 100) {
    return {
      subject: `AgentBill: your ${num(a.limit)} preflight calls for this month are used`,
      html: `
        <p>Your account has reached the <b>${num(a.limit)}</b> preflight calls the ${plan} plan
           includes this month. From now until ${resetsOn}, every new</p>
        ${refuses}
        <p><a href="${raise}">Raise the ceiling</a> to keep going this month, or
           <a href="${ORIGIN}/app?view=refusals">see what has been refused</a>.</p>
        <p>No other part of the account changes. Reservations already held, per-customer balances
           and per-task ceilings are untouched.</p>
      `,
    }
  }

  return {
    subject: `AgentBill: ${num(a.monthlyCalls)} of ${num(a.limit)} preflight calls used this month`,
    html: `
      <p>Your account has made <b>${num(a.monthlyCalls)}</b> of the <b>${num(a.limit)}</b> preflight
         calls the ${plan} plan includes this month. That is ${a.threshold}%.</p>
      <p>At ${num(a.limit)},</p>
      ${refuses}
      <p><a href="${raise}">Raise the ceiling</a> before that, or
         <a href="${ORIGIN}/app?view=limits">see the month so far</a>.
         If ${num(a.limit)} is enough, nothing needs doing.</p>
    `,
  }
}

/** Test seam: the cooldown is module state, and a harness must be able to clear it. */
export function resetQuotaAlerts(): void {
  attempts.clear()
}
