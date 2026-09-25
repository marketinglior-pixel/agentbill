import type { FastifyBaseLogger } from 'fastify'
import { sql } from '../db/index.js'
import { mailUser, mailerReady } from './mail.js'
import { deliverWebhook, webhookSecretFor } from './webhook-target.js'
import { usdAmount } from './task-ceiling.js'
import { ORIGIN } from '../ui/site.js'

// Spend spikes (M2, 2026-09-26): an agent or a customer that has spent, so far
// this UTC day, three times what it spends on an average day. The owner gets
// one mail per pass listing every new spike, and the account's webhook (if it
// has one) gets one signed spend.spike event per spike.
//
// The rule, all of it:
//   baseline  the seven UTC days before today, averaged over seven (a quiet
//             day counts as zero), and only for a subject that was active on
//             at least three of them: a two-day-old agent has no "usual"
//   metric    dollars at list price when both today and the baseline have
//             priced calls; calls otherwise
//   spike     today >= 3 x the daily average, and today >= $1.00 (or 100
//             calls), so a subject going from 2 cents to 7 is not news
//   once      per subject per day, by the claim row (migration 033)
//
// Today is partial, so the comparison is today-so-far against a whole average
// day: it can only fire late, never early. Nothing is stopped: this is a
// notice, and the copy says so.
//
// Off unless SPIKE_ALERTS=on. Hourly, on every machine; the claim makes two
// machines one.

export const SPIKE_MULTIPLE = 3
export const SPIKE_MIN_USD = 1
export const SPIKE_MIN_CALLS = 100
export const SPIKE_MIN_ACTIVE_DAYS = 3
/** Spike mails one account can get in one UTC day; past it the spikes are recorded, not mailed. */
export const SPIKE_MAILS_PER_DAY = 10

export type Spike = { accountId: string; scope: 'agent' | 'customer'; subject: string; metric: 'usd' | 'calls'; today: number; dailyAvg: number }

const n = (v: unknown) => Number(v ?? 0) || 0

export function utcDayStart(now = new Date()): Date {
  const t = new Date(now)
  t.setUTCHours(0, 0, 0, 0)
  return t
}

/** Every subject over the line right now, across all accounts. Pure read. */
export async function findSpikes(now = new Date()): Promise<Spike[]> {
  const today = utcDayStart(now).toISOString()
  const rows = await sql.unsafe(`
    WITH ev AS (
      SELECT e.account_id, e.event_type AS agent, c.customer_ref AS customer, e.list_price_usd AS usd,
             e.created_at >= $1::timestamptz AS is_today,
             date_trunc('day', e.created_at AT TIME ZONE 'UTC') AS d
      FROM events e LEFT JOIN customers c ON c.id = e.customer_id
      WHERE e.created_at >= $1::timestamptz - interval '7 days'),
    subj AS (
      SELECT account_id, 'agent' AS scope, agent AS subject, is_today, d, usd FROM ev
      UNION ALL
      SELECT account_id, 'customer', customer, is_today, d, usd FROM ev WHERE customer IS NOT NULL)
    SELECT account_id, scope, subject,
           count(*) FILTER (WHERE is_today) AS t_calls,
           coalesce(sum(usd) FILTER (WHERE is_today), 0) AS t_usd,
           count(usd) FILTER (WHERE is_today) AS t_priced,
           count(*) FILTER (WHERE NOT is_today) AS b_calls,
           coalesce(sum(usd) FILTER (WHERE NOT is_today), 0) AS b_usd,
           count(usd) FILTER (WHERE NOT is_today) AS b_priced,
           count(DISTINCT d) FILTER (WHERE NOT is_today) AS b_days
    FROM subj GROUP BY 1, 2, 3
    HAVING count(*) FILTER (WHERE is_today) > 0 AND count(DISTINCT d) FILTER (WHERE NOT is_today) >= ${SPIKE_MIN_ACTIVE_DAYS}`,
  [today]) as Record<string, unknown>[]
  const out: Spike[] = []
  for (const r of rows) {
    const usd = n(r.tPriced) > 0 && n(r.bPriced) > 0
    const today = usd ? Number(r.tUsd) : n(r.tCalls)
    const dailyAvg = (usd ? Number(r.bUsd) : n(r.bCalls)) / 7
    if (dailyAvg <= 0) continue
    if (today < SPIKE_MULTIPLE * dailyAvg) continue
    if (today < (usd ? SPIKE_MIN_USD : SPIKE_MIN_CALLS)) continue
    out.push({ accountId: String(r.accountId), scope: r.scope as Spike['scope'], subject: String(r.subject).slice(0, 200),
      metric: usd ? 'usd' : 'calls', today, dailyAvg })
  }
  return out
}

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
const amount = (s: Spike, v: number) => (s.metric === 'usd' ? usdAmount(Math.round(v * 1e6) / 1e6) : `${Math.round(v).toLocaleString('en-US')} calls`)
const times = (s: Spike) => `${(s.today / s.dailyAvg).toFixed(1)}×`

export function spikeMail(spikes: Spike[], day: string): { subject: string; html: string } {
  const one = spikes.length === 1 ? spikes[0] : null
  const subject = one
    ? `AgentBill: ${one.scope} ${one.subject.slice(0, 60)} is at ${times(one)} its usual day`
    : `AgentBill: ${spikes.length} agents and customers are at ${SPIKE_MULTIPLE}× or more their usual day`
  const items = spikes.map((s) => `<li><b>${s.scope === 'agent' ? 'Agent' : 'Customer'} <code>${esc(s.subject)}</code></b>:
      ${amount(s, s.today)} so far today, against ${amount(s, s.dailyAvg)} on an average day over the last seven (${times(s)}).</li>`).join('\n')
  return {
    subject,
    html: `
      <p>So far on ${esc(day)} (UTC), ${spikes.length === 1 ? 'one of your' : 'some of your'} ${spikes.length === 1 ? (one!.scope === 'agent' ? 'agents has' : 'customers has') : 'agents or customers have'}
         spent at least ${SPIKE_MULTIPLE} times what ${spikes.length === 1 ? 'it spends' : 'they spend'} on an average day:</p>
      <ul>${items}</ul>
      <p>Nothing was stopped: this is a notice. Dollar figures are estimates at public list price, over priced calls.
         To bound a job, give it a ceiling in <a href="${ORIGIN}/app?view=tasks">Task budgets</a>.</p>
      <p><a href="${ORIGIN}/app?view=${one?.scope === 'customer' ? 'customers' : 'agents'}&amp;range=24h">See today in the console</a></p>
      <p>You get this once per agent or customer per day, when it crosses ${SPIKE_MULTIPLE}× and at least
         ${usdAmount(SPIKE_MIN_USD)} (or ${SPIKE_MIN_CALLS} calls). Questions: hello@agentbill.dev</p>`,
  }
}

export function spikePayload(s: Spike, day: string): string {
  return JSON.stringify({
    event: 'spend.spike', scope: s.scope, subject: s.subject, day, metric: s.metric,
    today: s.metric === 'usd' ? Math.round(s.today * 1e6) / 1e6 : s.today,
    daily_average: s.metric === 'usd' ? Math.round(s.dailyAvg * 1e6) / 1e6 : Math.round(s.dailyAvg * 100) / 100,
    multiple: Math.round((s.today / s.dailyAvg) * 10) / 10,
    estimate: s.metric === 'usd' ? 'list price over priced calls' : null,
    timestamp: new Date().toISOString(),
  })
}

/** One pass: find, claim, mail, deliver. Returns what it did. Never throws for one account's failure. */
export async function runSpikes(log: FastifyBaseLogger, now = new Date()): Promise<{ found: number; claimed: number; mailed: number }> {
  const day = utcDayStart(now).toISOString().slice(0, 10)
  const spikes = await findSpikes(now)
  const claimed: Spike[] = []
  for (const s of spikes) {
    const [c] = await sql`
      INSERT INTO spend_spike_alerts (account_id, scope, subject, day, metric, today_value, daily_avg)
      VALUES (${s.accountId}, ${s.scope}, ${s.subject}, ${day}, ${s.metric}, ${s.today}, ${s.dailyAvg})
      ON CONFLICT DO NOTHING RETURNING account_id`
    if (c) claimed.push(s)
  }
  let mailed = 0
  const byAccount = new Map<string, Spike[]>()
  for (const s of claimed) byAccount.set(s.accountId, [...(byAccount.get(s.accountId) ?? []), s])
  for (const [accountId, list] of byAccount) {
    try {
      const [acc] = await sql`
        SELECT COALESCE(a.email, (SELECT u.email FROM users u WHERE u.id = a.owner_user_id)) AS email, a.webhook_url, a.webhook_secret_nonce,
               (SELECT count(*)::int FROM spend_spike_alerts x WHERE x.account_id = a.id AND x.day = ${day} AND x.emailed) AS mailed_today
        FROM accounts a WHERE a.id = ${accountId}`
      if (acc?.webhookUrl) {
        const secret = acc.webhookSecretNonce ? webhookSecretFor(acc.webhookSecretNonce as string) : null
        for (const s of list) {
          const r = await deliverWebhook(acc.webhookUrl as string, spikePayload(s, day), { 'X-AgentBill-Account-Id': accountId }, secret)
            .catch((err: unknown) => ({ delivered: false, reason: err instanceof Error ? err.message : 'threw', status: undefined }))
          const note = r.delivered ? 'delivered' : `not delivered: ${String((r as { reason?: string }).reason ?? 'unknown').slice(0, 120)}`
          await sql`UPDATE spend_spike_alerts SET webhook = ${note} WHERE account_id = ${accountId} AND scope = ${s.scope} AND subject = ${s.subject} AND day = ${day}`
        }
      }
      if (!acc?.email) { log.warn({ accountId }, 'spend spike: account has no email'); continue }
      if (!mailerReady()) { log.warn({ accountId }, 'spend spike: no mailer configured'); continue }
      if (n(acc.mailedToday) >= SPIKE_MAILS_PER_DAY) { log.warn({ accountId, spikes: list.length }, 'spend spike: past the daily mail cap, recorded only'); continue }
      const sent = await mailUser(log, 'account', acc.email as string, spikeMail(list, day))
      if (!sent) { log.error({ accountId }, 'spend spike: the send did not go out'); continue }
      mailed++
      for (const s of list) {
        await sql`UPDATE spend_spike_alerts SET emailed = true WHERE account_id = ${accountId} AND scope = ${s.scope} AND subject = ${s.subject} AND day = ${day}`
      }
      log.info({ accountId, spikes: list.map((s) => `${s.scope}:${s.subject}`) }, 'spend spike mailed')
    } catch (err) {
      log.error({ accountId, err }, 'spend spike: this account failed')
    }
  }
  return { found: spikes.length, claimed: claimed.length, mailed }
}

export const spikesOn = (env: NodeJS.ProcessEnv = process.env) => (env.SPIKE_ALERTS ?? '').trim().toLowerCase() === 'on'

/** Hourly on this machine when SPIKE_ALERTS=on; the first pass after SPIKE_FIRST_RUN_MS (default 15 minutes). */
export function startSpikes(log: FastifyBaseLogger, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!spikesOn(env)) return false
  const first = Math.max(0, Number(env.SPIKE_FIRST_RUN_MS ?? 15 * 60_000) || 0)
  const every = Math.max(1000, Number(env.SPIKE_EVERY_MS ?? 60 * 60_000) || 60 * 60_000)
  const tick = async () => {
    try {
      const r = await runSpikes(log)
      if (r.found) log.info(r, '[spikes] pass')
    } catch (err) {
      log.error({ err }, '[spikes] pass failed')
    }
  }
  log.info({ first, every }, '[spikes] SPIKE_ALERTS=on')
  const t1 = setTimeout(() => {
    void tick()
    setInterval(() => { void tick() }, every).unref()
  }, first)
  t1.unref()
  return true
}
