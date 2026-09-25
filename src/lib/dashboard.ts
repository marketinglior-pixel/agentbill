import { sql } from '../db/index.js'
import { EVENT_TOKENS_SQL } from './usage.js'

// The console's dashboard (M2, 2026-09-26): one window, cut five ways, the
// Helicone-style first screen. Everything here is read from the tables the
// API already writes; nothing new is recorded.
//
//   events               cost (list_price_usd), calls, tokens, latency
//                        (metadata.duration_ms), model, customer, agent
//   preflight_decisions  refusals, by reason and by agent_id
//
// "Agent" is events.event_type, which is what record() sends as agent_id
// (sdk/python/agentbill/client.py) and what the console has always split
// usage by; refusals carry agent_id in its own column. metadata is read
// through agentbill_event_md() (migration 032), so records stored before
// 2026-09-23 as a JSON string count too.
//
// Windows are UTC: hourly buckets for 24h, daily for the rest, always ending
// with the bucket that contains now, so the last bar is the one filling up.

export const DASH_RANGES = {
  '24h': { label: '24 hours', short: '24H', buckets: 24, step: 'hour' },
  '7d':  { label: '7 days',   short: '7D',  buckets: 7,  step: 'day' },
  '30d': { label: '30 days',  short: '1M',  buckets: 30, step: 'day' },
  '90d': { label: '90 days',  short: '3M',  buckets: 90, step: 'day' },
} as const
export type DashRange = keyof typeof DASH_RANGES

export type Bucket = { t: string; usd: number; priced: number; calls: number; refused: number; tokens: number; latMs: number | null }
export type Ranked = { name: string | null; sub?: string | null; usd: number | null; calls: number; tokens: number; refused?: number; last?: string | null }
export type Dash = {
  range: DashRange
  buckets: Bucket[]
  totals: { usd: number | null; priced: number; calls: number; refused: number; leaks: number; tokensIn: number; tokensOut: number; latMs: number | null; latCalls: number }
  prev: { usd: number | null; calls: number; refused: number }
  models: Ranked[]
  agents: Ranked[]
  customers: Ranked[]
  reasons: { reason: string; n: number }[]
}

/** The first bucket's start, as an ISO instant, for a window ending now. */
export function windowStart(range: DashRange, now = new Date()): Date {
  const r = DASH_RANGES[range]
  const t = new Date(now)
  if (r.step === 'hour') {
    t.setUTCMinutes(0, 0, 0)
    t.setUTCHours(t.getUTCHours() - (r.buckets - 1))
  } else {
    t.setUTCHours(0, 0, 0, 0)
    t.setUTCDate(t.getUTCDate() - (r.buckets - 1))
  }
  return t
}

const TOK = EVENT_TOKENS_SQL.replaceAll('metadata', 'md')
const IN_TOK = ['input', 'cache_read', 'cache_write', 'cache_write_1h']
  .map((f) => `coalesce(CASE WHEN md->'tokens'->>'${f}' ~ '^[0-9]{1,15}$' THEN (md->'tokens'->>'${f}')::bigint END, 0)`).join(' + ')
const OUT_TOK = `coalesce(CASE WHEN md->'tokens'->>'output' ~ '^[0-9]{1,15}$' THEN (md->'tokens'->>'output')::bigint END, 0)`
// A duration a caller could send: a number of milliseconds under ~11 days.
const LAT_OK = `md->>'duration_ms' ~ '^[0-9]{1,9}(\\.[0-9]{1,6})?$'`

const n = (v: unknown) => Number(v ?? 0) || 0
const money = (v: unknown, priced: unknown) => (n(priced) > 0 ? Number(v ?? 0) : null)

export async function loadDashboard(accountId: string, range: DashRange, now = new Date()): Promise<Dash> {
  const r = DASH_RANGES[range]
  const start = windowStart(range, now)
  const step = r.step === 'hour' ? '1 hour' : '1 day'
  const last = new Date(start)
  if (r.step === 'hour') last.setUTCHours(last.getUTCHours() + r.buckets - 1)
  else last.setUTCDate(last.getUTCDate() + r.buckets - 1)
  const span = r.step === 'hour' ? r.buckets * 3_600_000 : r.buckets * 86_400_000
  const prevStart = new Date(start.getTime() - span)
  const S = start.toISOString(), L = last.toISOString(), P = prevStart.toISOString()

  const EV = `SELECT created_at, event_type, customer_id, list_price_usd, agentbill_event_md(metadata) AS md
              FROM events WHERE account_id = $1 AND created_at >= $2::timestamptz`

  const series = await sql.unsafe(`
    WITH ev AS (${EV}),
    b AS (SELECT generate_series($2::timestamptz, $3::timestamptz, $4::interval) AS t),
    es AS (
      SELECT date_bin($4::interval, created_at, $2::timestamptz) AS t,
             count(*) AS calls, sum(list_price_usd) AS usd, count(list_price_usd) AS priced,
             sum(${TOK}) AS tokens,
             sum(CASE WHEN ${LAT_OK} THEN (md->>'duration_ms')::numeric END) AS lat_sum,
             count(*) FILTER (WHERE ${LAT_OK}) AS lat_n
      FROM ev GROUP BY 1),
    ds AS (
      SELECT date_bin($4::interval, created_at, $2::timestamptz) AS t, count(*) AS refused
      FROM preflight_decisions WHERE account_id = $1 AND blocked AND created_at >= $2::timestamptz GROUP BY 1)
    SELECT b.t, coalesce(es.calls, 0) AS calls, coalesce(es.usd, 0) AS usd, coalesce(es.priced, 0) AS priced,
           coalesce(es.tokens, 0) AS tokens, es.lat_sum, coalesce(es.lat_n, 0) AS lat_n, coalesce(ds.refused, 0) AS refused
    FROM b LEFT JOIN es USING (t) LEFT JOIN ds USING (t) ORDER BY b.t`, [accountId, S, L, step]) as Record<string, unknown>[]

  const [tot] = await sql.unsafe(`
    WITH ev AS (${EV})
    SELECT count(*) AS calls, sum(list_price_usd) AS usd, count(list_price_usd) AS priced,
           coalesce(sum(${IN_TOK}), 0) AS tin, coalesce(sum(${OUT_TOK}), 0) AS tout,
           sum(CASE WHEN ${LAT_OK} THEN (md->>'duration_ms')::numeric END) AS lat_sum,
           count(*) FILTER (WHERE ${LAT_OK}) AS lat_n
    FROM ev`, [accountId, S]) as Record<string, unknown>[]

  const [dec] = await sql.unsafe(`
    SELECT count(*) FILTER (WHERE blocked) AS refused, count(*) FILTER (WHERE NOT blocked) AS leaks
    FROM preflight_decisions WHERE account_id = $1 AND created_at >= $2::timestamptz`, [accountId, S]) as Record<string, unknown>[]

  const [prev] = await sql.unsafe(`
    SELECT (SELECT count(*) FROM events WHERE account_id = $1 AND created_at >= $2::timestamptz AND created_at < $3::timestamptz) AS calls,
           (SELECT sum(list_price_usd) FROM events WHERE account_id = $1 AND created_at >= $2::timestamptz AND created_at < $3::timestamptz) AS usd,
           (SELECT count(list_price_usd) FROM events WHERE account_id = $1 AND created_at >= $2::timestamptz AND created_at < $3::timestamptz) AS priced,
           (SELECT count(*) FROM preflight_decisions WHERE account_id = $1 AND blocked AND created_at >= $2::timestamptz AND created_at < $3::timestamptz) AS refused`,
  [accountId, P, S]) as Record<string, unknown>[]

  const models = await sql.unsafe(`
    WITH ev AS (${EV})
    SELECT nullif(md->>'model', '') AS name, nullif(md->>'provider', '') AS sub,
           count(*) AS calls, sum(list_price_usd) AS usd, count(list_price_usd) AS priced, sum(${TOK}) AS tokens
    FROM ev GROUP BY 1, 2
    ORDER BY sum(list_price_usd) DESC NULLS LAST, count(*) DESC, 1 NULLS LAST LIMIT 6`, [accountId, S]) as Record<string, unknown>[]

  const agents = await sql.unsafe(`
    WITH ev AS (${EV})
    SELECT event_type AS name, count(*) AS calls, sum(list_price_usd) AS usd, count(list_price_usd) AS priced,
           sum(${TOK}) AS tokens, max(created_at) AS last
    FROM ev GROUP BY 1
    ORDER BY sum(list_price_usd) DESC NULLS LAST, count(*) DESC, 1 LIMIT 6`, [accountId, S]) as Record<string, unknown>[]
  const agentRefusals = await sql.unsafe(`
    SELECT agent_id AS name, count(*) AS n FROM preflight_decisions
    WHERE account_id = $1 AND blocked AND created_at >= $2::timestamptz AND agent_id IS NOT NULL GROUP BY 1`, [accountId, S]) as Record<string, unknown>[]
  const refusedBy = new Map(agentRefusals.map((x) => [String(x.name), n(x.n)]))

  const customers = await sql.unsafe(`
    SELECT c.customer_ref AS name, count(*) AS calls, sum(e.list_price_usd) AS usd, count(e.list_price_usd) AS priced,
           sum(${TOK.replaceAll('md', 'agentbill_event_md(e.metadata)')}) AS tokens
    FROM events e JOIN customers c ON c.id = e.customer_id
    WHERE e.account_id = $1 AND e.created_at >= $2::timestamptz
    GROUP BY 1 ORDER BY sum(e.list_price_usd) DESC NULLS LAST, count(*) DESC, 1 LIMIT 6`, [accountId, S]) as Record<string, unknown>[]

  const reasons = await sql.unsafe(`
    SELECT reason, count(*) AS n FROM preflight_decisions
    WHERE account_id = $1 AND blocked AND created_at >= $2::timestamptz GROUP BY 1 ORDER BY 2 DESC, 1`, [accountId, S]) as Record<string, unknown>[]

  const ranked = (x: Record<string, unknown>): Ranked => ({
    name: (x.name as string | null) ?? null, sub: (x.sub as string | null) ?? null,
    usd: money(x.usd, x.priced), calls: n(x.calls), tokens: n(x.tokens),
    ...(x.last ? { last: new Date(x.last as string).toISOString() } : {}),
  })
  const latN = n(tot?.latN)
  return {
    range,
    buckets: series.map((x) => ({
      t: new Date(x.t as string).toISOString(), calls: n(x.calls), usd: Number(x.usd ?? 0), priced: n(x.priced),
      tokens: n(x.tokens), refused: n(x.refused), latMs: n(x.latN) > 0 ? Number(x.latSum) / n(x.latN) : null,
    })),
    totals: {
      usd: money(tot?.usd, tot?.priced), priced: n(tot?.priced), calls: n(tot?.calls), refused: n(dec?.refused), leaks: n(dec?.leaks),
      tokensIn: n(tot?.tin), tokensOut: n(tot?.tout), latMs: latN > 0 ? Number(tot?.latSum) / latN : null, latCalls: latN,
    },
    prev: { usd: money(prev?.usd, prev?.priced), calls: n(prev?.calls), refused: n(prev?.refused) },
    models: models.map(ranked),
    agents: agents.map((x) => ({ ...ranked(x), refused: refusedBy.get(String(x.name)) ?? 0 })),
    customers: customers.map(ranked),
    reasons: reasons.map((x) => ({ reason: String(x.reason), n: n(x.n) })),
  }
}

// ---------------------------------------------------------------------------
// Sample data, for /app?demo=1: invented, deterministic, and labelled SAMPLE
// on every card by the renderer. Priced, so the sample shows the cost chart a
// wrapped client gets, which the old sample never did.
// ---------------------------------------------------------------------------

export function demoDashboard(range: DashRange, now = new Date()): Dash {
  const r = DASH_RANGES[range]
  const start = windowStart(range, now)
  // A fixed pseudo-random walk, so a screenshot is the same every time.
  let seed = 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const buckets: Bucket[] = []
  for (let i = 0; i < r.buckets; i++) {
    const t = new Date(start)
    if (r.step === 'hour') t.setUTCHours(t.getUTCHours() + i)
    else t.setUTCDate(t.getUTCDate() + i)
    const hour = t.getUTCHours()
    const weekday = t.getUTCDay() % 6 !== 0
    const base = r.step === 'hour' ? (hour >= 6 && hour <= 20 ? 60 : 18) : weekday ? 1300 : 520
    const calls = Math.round(base * (0.7 + rnd() * 0.6) * (i === r.buckets - 1 ? 0.55 : 1))
    const spike = r.step === 'day' && i === r.buckets - 4 ? 2.6 : 1
    const usd = Math.round(calls * 0.0042 * spike * (0.8 + rnd() * 0.4) * 1e6) / 1e6
    buckets.push({ t: t.toISOString(), calls, usd, priced: calls, refused: Math.round(calls * 0.018 * (0.5 + rnd())),
      tokens: calls * 2100, latMs: 900 + rnd() * 700 })
  }
  const calls = buckets.reduce((a, b) => a + b.calls, 0)
  const usd = buckets.reduce((a, b) => a + b.usd, 0)
  const refused = buckets.reduce((a, b) => a + b.refused, 0)
  const split = (shares: [string, string | null, number][]): Ranked[] => shares.map(([name, sub, s]) =>
    ({ name, sub, usd: Math.round(usd * s * 1e6) / 1e6, calls: Math.round(calls * s * (0.6 + s)), tokens: Math.round(calls * s * 2100) }))
  const agents = split([['support-triage', null, 0.34], ['lead-enricher', null, 0.24], ['invoice-reader', null, 0.18],
    ['research-bot', null, 0.14], ['sdr-writer', null, 0.1]])
    .map((a, i) => ({ ...a, refused: [4, 11, 0, 7, 2][i] ?? 0, last: new Date(now.getTime() - [3, 40, 7, 190, 25][i] * 60_000).toISOString() }))
  return {
    range, buckets,
    totals: { usd, priced: calls, calls, refused, leaks: 1, tokensIn: Math.round(calls * 1650), tokensOut: Math.round(calls * 450), latMs: 1240, latCalls: calls },
    prev: { usd: usd * 0.82, calls: Math.round(calls * 0.9), refused: Math.round(refused * 1.3) },
    models: split([['claude-sonnet-4-5', 'anthropic', 0.46], ['gpt-4.1-mini', 'openai', 0.27], ['gemini-2.5-flash', 'gemini', 0.15],
      ['gpt-4.1', 'openai', 0.08], ['claude-haiku-4-5', 'anthropic', 0.04]]),
    agents,
    customers: split([['acme-corp', null, 0.38], ['globex', null, 0.26], ['initech', null, 0.19], ['umbrella', null, 0.11], ['hooli', null, 0.06]]),
    reasons: [{ reason: 'task_ceiling_exceeded', n: Math.round(refused * 0.55) }, { reason: 'ceiling_exceeded', n: Math.round(refused * 0.3) },
      { reason: 'budget_exhausted', n: Math.round(refused * 0.15) }],
  }
}
