import { sql } from '../db/index.js'
import { EVENT_TOKENS_SQL } from './usage.js'
import { DASH_RANGES, windowStart, type DashRange } from './dashboard.js'

// The console's Agents view and the monthly customer report (M2, 2026-09-26).
//
// Agents: one row per agent that recorded a call in the window. An agent is
// events.event_type, what record() sends as agent_id; its refusals are
// preflight_decisions.agent_id. "First seen" is all time, so a new hire reads
// as new.
//
// The report: one calendar month (UTC) per customer_id, the figure an agency
// bills its client from, with each customer's lines by agent and model. The
// dollars are the list-price estimate the API stores (events.list_price_usd),
// never an invoice: every surface that prints them says so.

const MD = 'agentbill_event_md(metadata)'
const TOK = EVENT_TOKENS_SQL.replaceAll('metadata', MD)
const IN_TOK = ['input', 'cache_read', 'cache_write', 'cache_write_1h']
  .map((f) => `coalesce(CASE WHEN ${MD}->'tokens'->>'${f}' ~ '^[0-9]{1,15}$' THEN (${MD}->'tokens'->>'${f}')::bigint END, 0)`).join(' + ')
const OUT_TOK = `coalesce(CASE WHEN ${MD}->'tokens'->>'output' ~ '^[0-9]{1,15}$' THEN (${MD}->'tokens'->>'output')::bigint END, 0)`
const LAT_OK = `${MD}->>'duration_ms' ~ '^[0-9]{1,9}(\\.[0-9]{1,6})?$'`

const n = (v: unknown) => Number(v ?? 0) || 0
const money = (v: unknown, priced: unknown) => (n(priced) > 0 ? Number(v ?? 0) : null)
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null)

export type AgentRow = {
  agent: string; calls: number; usd: number | null; priced: number; tokens: number
  latMs: number | null; refused: number; firstSeen: string | null; lastSeen: string | null
}

export async function agentRows(accountId: string, range: DashRange, now = new Date()): Promise<AgentRow[]> {
  const S = windowStart(range, now).toISOString()
  const rows = await sql.unsafe(`
    SELECT event_type AS agent, count(*) AS calls, sum(list_price_usd) AS usd, count(list_price_usd) AS priced,
           sum(${TOK}) AS tokens,
           sum(CASE WHEN ${LAT_OK} THEN (${MD}->>'duration_ms')::numeric END) AS lat_sum,
           count(*) FILTER (WHERE ${LAT_OK}) AS lat_n, max(created_at) AS last_seen
    FROM events WHERE account_id = $1 AND created_at >= $2::timestamptz
    GROUP BY 1 ORDER BY sum(list_price_usd) DESC NULLS LAST, count(*) DESC, 1 LIMIT 100`, [accountId, S]) as Record<string, unknown>[]
  if (!rows.length) return []
  const names = rows.map((r) => String(r.agent))
  const first = await sql`SELECT event_type AS agent, min(created_at) AS first_seen FROM events
                          WHERE account_id = ${accountId} AND event_type = ANY(${names}) GROUP BY 1`
  const refused = await sql`SELECT agent_id AS agent, count(*) AS n FROM preflight_decisions
                            WHERE account_id = ${accountId} AND blocked AND created_at >= ${S}::timestamptz AND agent_id = ANY(${names}) GROUP BY 1`
  const firstBy = new Map(first.map((r) => [String(r.agent), iso(r.firstSeen)]))
  const refusedBy = new Map(refused.map((r) => [String(r.agent), n(r.n)]))
  return rows.map((r) => ({
    agent: String(r.agent), calls: n(r.calls), usd: money(r.usd, r.priced), priced: n(r.priced), tokens: n(r.tokens),
    latMs: n(r.latN) > 0 ? Number(r.latSum) / n(r.latN) : null, refused: refusedBy.get(String(r.agent)) ?? 0,
    firstSeen: firstBy.get(String(r.agent)) ?? null, lastSeen: iso(r.lastSeen),
  }))
}

// ---------------------------------------------------------------------------
// The monthly report
// ---------------------------------------------------------------------------

export type ReportLine = { agent: string; model: string | null; calls: number; priced: number; usd: number | null; tokensIn: number; tokensOut: number }
export type ReportCustomer = { customer: string; calls: number; priced: number; usd: number | null; tokensIn: number; tokensOut: number; lines: ReportLine[] }
export type Report = { month: string; start: string; end: string; customers: ReportCustomer[]; totals: { calls: number; priced: number; usd: number | null } }

/** YYYY-MM, or null. Months before 2026 and after next month are refused: there is nothing to show. */
export function asMonth(v: unknown, now = new Date()): string | null {
  if (typeof v !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) return null
  const [y, m] = v.split('-').map(Number)
  const t = Date.UTC(y, m - 1, 1)
  if (y < 2026 || t > Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) return null
  return v
}
export const thisMonth = (now = new Date()) => `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
/** The month and the five before it, newest first: what the month control offers. */
export function recentMonths(now = new Date(), count = 6): string[] {
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`)
  }
  return out
}
export function monthBounds(month: string): { start: string; end: string } {
  const [y, m] = month.split('-').map(Number)
  return { start: new Date(Date.UTC(y, m - 1, 1)).toISOString(), end: new Date(Date.UTC(y, m, 1)).toISOString() }
}

export async function monthlyReport(accountId: string, month: string): Promise<Report> {
  const { start, end } = monthBounds(month)
  const lines = await sql.unsafe(`
    SELECT c.customer_ref AS customer, e.event_type AS agent, nullif(${MD.replace('metadata', 'e.metadata')}->>'model', '') AS model,
           count(*) AS calls, count(e.list_price_usd) AS priced, sum(e.list_price_usd) AS usd,
           coalesce(sum(${IN_TOK.replaceAll('agentbill_event_md(metadata)', 'agentbill_event_md(e.metadata)')}), 0) AS tin,
           coalesce(sum(${OUT_TOK.replaceAll('agentbill_event_md(metadata)', 'agentbill_event_md(e.metadata)')}), 0) AS tout
    FROM events e JOIN customers c ON c.id = e.customer_id
    WHERE e.account_id = $1 AND e.created_at >= $2::timestamptz AND e.created_at < $3::timestamptz
    GROUP BY 1, 2, 3
    ORDER BY 1, sum(e.list_price_usd) DESC NULLS LAST, count(*) DESC, 2, 3
    LIMIT 5000`, [accountId, start, end]) as Record<string, unknown>[]
  const by = new Map<string, ReportCustomer>()
  for (const l of lines) {
    const key = String(l.customer)
    const c = by.get(key) ?? { customer: key, calls: 0, priced: 0, usd: null, tokensIn: 0, tokensOut: 0, lines: [] }
    const line: ReportLine = { agent: String(l.agent), model: (l.model as string | null) ?? null, calls: n(l.calls), priced: n(l.priced),
      usd: money(l.usd, l.priced), tokensIn: n(l.tin), tokensOut: n(l.tout) }
    c.lines.push(line)
    c.calls += line.calls; c.priced += line.priced; c.tokensIn += line.tokensIn; c.tokensOut += line.tokensOut
    if (line.usd != null) c.usd = (c.usd ?? 0) + line.usd
    by.set(key, c)
  }
  // Customers dearest first; one with nothing priced after every priced one.
  const customers = [...by.values()].sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || b.calls - a.calls || a.customer.localeCompare(b.customer))
  const priced = customers.reduce((a, c) => a + c.priced, 0)
  return {
    month, start, end, customers,
    totals: { calls: customers.reduce((a, c) => a + c.calls, 0), priced, usd: priced > 0 ? customers.reduce((a, c) => a + (c.usd ?? 0), 0) : null },
  }
}

/** A CSV cell: quoted, and never read as a formula by a spreadsheet (CWE-1236). */
export function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return `"${s.replace(/"/g, '""')}"`
}

/** One line per customer, agent and model, then one total per customer. */
export function reportCsv(r: Report): string {
  const head = ['month', 'customer_id', 'agent', 'model', 'calls', 'priced_calls', 'unpriced_calls', 'tokens_in', 'tokens_out', 'list_price_usd_estimate']
  const fix = (x: number | null) => (x == null ? '' : x.toFixed(6))
  const rows: unknown[][] = []
  for (const c of r.customers) {
    for (const l of c.lines) rows.push([r.month, c.customer, l.agent, l.model ?? '', l.calls, l.priced, l.calls - l.priced, l.tokensIn, l.tokensOut, fix(l.usd)])
    rows.push([r.month, c.customer, '(customer total)', '', c.calls, c.priced, c.calls - c.priced, c.tokensIn, c.tokensOut, fix(c.usd)])
  }
  return [head, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

// ---------------------------------------------------------------------------
// Sample data for /app?demo=1, labelled SAMPLE by the renderer
// ---------------------------------------------------------------------------

export function demoAgentRows(range: DashRange, now = new Date()): AgentRow[] {
  const f = DASH_RANGES[range].buckets / 30 * (DASH_RANGES[range].step === 'hour' ? 1 / 24 : 1)
  const base: [string, number, number, number, number, number][] = [
    ['support-triage', 11200, 51.42, 1180, 4, 60], ['lead-enricher', 7066, 36.3, 2240, 11, 45], ['invoice-reader', 4921, 27.22, 950, 0, 30],
    ['research-bot', 3631, 21.17, 3100, 7, 3], ['sdr-writer', 2453, 15.12, 1420, 2, 12],
  ]
  return base.map(([agent, calls, usd, lat, refused, firstDays], i) => ({
    agent, calls: Math.max(1, Math.round(calls * f)), usd: Math.round(usd * f * 100) / 100, priced: Math.max(1, Math.round(calls * f)),
    tokens: Math.round(calls * f * 2100), latMs: lat, refused: Math.round(refused * Math.min(1, f * 1.5)),
    firstSeen: new Date(now.getTime() - firstDays * 86_400_000).toISOString(),
    lastSeen: new Date(now.getTime() - [3, 40, 7, 190, 25][i] * 60_000).toISOString(),
  }))
}

export function demoReport(month: string): Report {
  const { start, end } = monthBounds(month)
  const mk = (customer: string, parts: [string, string, number, number][]): ReportCustomer => {
    const lines = parts.map(([agent, model, calls, usd]) => ({ agent, model, calls, priced: calls, usd, tokensIn: calls * 1650, tokensOut: calls * 450 }))
    return { customer, lines, calls: lines.reduce((a, l) => a + l.calls, 0), priced: lines.reduce((a, l) => a + l.priced, 0),
      usd: Math.round(lines.reduce((a, l) => a + (l.usd ?? 0), 0) * 100) / 100,
      tokensIn: lines.reduce((a, l) => a + l.tokensIn, 0), tokensOut: lines.reduce((a, l) => a + l.tokensOut, 0) }
  }
  const customers = [
    mk('acme-corp', [['support-triage', 'claude-sonnet-4-5', 4100, 31.2], ['invoice-reader', 'gpt-4.1-mini', 2200, 12.4], ['support-triage', 'gpt-4.1-mini', 900, 3.1]]),
    mk('globex', [['lead-enricher', 'gemini-2.5-flash', 3900, 18.7], ['sdr-writer', 'claude-sonnet-4-5', 800, 9.9]]),
    mk('initech', [['research-bot', 'claude-sonnet-4-5', 1700, 21.2], ['lead-enricher', 'gpt-4.1-mini', 1300, 6.8]]),
    mk('umbrella', [['sdr-writer', 'gpt-4.1', 600, 5.2], ['invoice-reader', 'gpt-4.1-mini', 400, 2.1]]),
  ]
  const calls = customers.reduce((a, c) => a + c.calls, 0)
  return { month, start, end, customers, totals: { calls, priced: calls, usd: Math.round(customers.reduce((a, c) => a + (c.usd ?? 0), 0) * 100) / 100 } }
}
