import { sql } from '../db/index.js'

// The office's data (M3, 2026-09-26): the account's agents as staff.
//
//   salary     what the agent cost this UTC month at list price over priced
//              calls (events.list_price_usd), null when none was priced
//   working    it recorded a call in the last WORKING_MINUTES: it sits at a desk
//   sent home  a ceiling refused it in the last 24 hours: it leaves with a box
//   new hire   its first call ever was in the last 24 hours: it walks in and waves
//   panic      a spend spike was claimed for it today (spend_spike_alerts)
//   idle       none of those
//
// One state per agent, in that order of precedence: panic, sent, new,
// working, idle. An agent is events.event_type; its refusals are
// preflight_decisions.agent_id. Staff is every agent with a call this month or
// a refusal in the last day, dearest first, at most OFFICE_MAX in the room.

export const WORKING_MINUTES = 10
export const OFFICE_MAX = 12
const SENT_REASONS = ['task_ceiling_exceeded', 'ceiling_exceeded', 'budget_exhausted']

export type OfficeState = 'panic' | 'sent' | 'new' | 'working' | 'idle'
export type OfficeAgent = { name: string; sal: number | null; calls: number; state: OfficeState; working: boolean }
export type Office = {
  month: string
  agents: OfficeAgent[]
  /** Everyone on staff, beyond the room's OFFICE_MAX too. */
  staff: number
  payroll: number | null
  atDesk: number
  sentHome: number
  topEarner: { name: string; sal: number } | null
}

const n = (v: unknown) => Number(v ?? 0) || 0

export async function loadOffice(accountId: string, now = new Date()): Promise<Office> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
  const day = new Date(now); day.setUTCHours(0, 0, 0, 0)
  const rows = await sql`
    WITH m AS (
      SELECT event_type AS name, count(*) AS calls, sum(list_price_usd) AS usd, count(list_price_usd) AS priced, max(created_at) AS last
      FROM events WHERE account_id = ${accountId} AND created_at >= ${monthStart}::timestamptz GROUP BY 1),
    r AS (
      SELECT agent_id AS name, count(*) AS refused FROM preflight_decisions
      WHERE account_id = ${accountId} AND blocked AND agent_id IS NOT NULL AND reason = ANY(${SENT_REASONS})
        AND created_at >= now() - interval '24 hours' GROUP BY 1),
    names AS (SELECT name FROM m UNION SELECT name FROM r),
    f AS (
      SELECT event_type AS name, min(created_at) AS first FROM events
      WHERE account_id = ${accountId} AND event_type IN (SELECT name FROM names) GROUP BY 1),
    s AS (
      SELECT subject AS name FROM spend_spike_alerts
      WHERE account_id = ${accountId} AND scope = 'agent' AND day = ${day.toISOString().slice(0, 10)}::date)
    SELECT names.name, coalesce(m.calls, 0) AS calls, m.usd, coalesce(m.priced, 0) AS priced,
           m.last >= now() - make_interval(mins => ${WORKING_MINUTES}) AS working,
           coalesce(r.refused, 0) > 0 AS sent,
           f.first >= now() - interval '24 hours' AS is_new,
           s.name IS NOT NULL AS panic
    FROM names LEFT JOIN m USING (name) LEFT JOIN r USING (name) LEFT JOIN f USING (name) LEFT JOIN s USING (name)
    ORDER BY m.usd DESC NULLS LAST, coalesce(m.calls, 0) DESC, names.name
  `
  const all: OfficeAgent[] = rows.map((r) => {
    const working = r.working === true
    const state: OfficeState = r.panic ? 'panic' : r.sent ? 'sent' : r.isNew ? 'new' : working ? 'working' : 'idle'
    return { name: String(r.name), sal: n(r.priced) > 0 ? Number(r.usd) : null, calls: n(r.calls), state, working }
  })
  const priced = all.filter((a) => a.sal != null)
  const top = priced.length ? priced.reduce((a, b) => ((b.sal ?? 0) > (a.sal ?? 0) ? b : a)) : null
  return {
    month: monthStart.slice(0, 7),
    agents: all.slice(0, OFFICE_MAX),
    staff: all.length,
    payroll: priced.length ? priced.reduce((s, a) => s + (a.sal ?? 0), 0) : null,
    atDesk: all.filter((a) => a.working && a.state !== 'sent').length,
    sentHome: all.filter((a) => a.state === 'sent').length,
    topEarner: top ? { name: top.name, sal: top.sal ?? 0 } : null,
  }
}

/** The sample office, for /app?demo=1&view=office: invented, and labelled so. */
export function demoOffice(now = new Date()): Office {
  const list: [string, number, number, OfficeState, boolean][] = [
    ['support-triage', 412.6, 11200, 'working', true], ['lead-enricher', 288.4, 7066, 'working', true],
    ['invoice-reader', 196.2, 4921, 'idle', false], ['research-bot', 171.9, 3631, 'panic', true],
    ['sdr-writer', 132.5, 2453, 'working', true], ['crm-sync', 88.1, 1980, 'idle', false],
    ['seo-writer', 64.3, 1402, 'sent', false], ['call-summarizer', 41.7, 990, 'working', true],
    ['churn-watcher', 12.4, 310, 'new', true],
  ]
  const agents = list.map(([name, sal, calls, state, working]) => ({ name, sal, calls, state, working }))
  return {
    month: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`,
    agents, staff: agents.length, payroll: agents.reduce((s, a) => s + (a.sal ?? 0), 0),
    atDesk: agents.filter((a) => a.working && a.state !== 'sent').length, sentHome: agents.filter((a) => a.state === 'sent').length,
    topEarner: { name: 'support-triage', sal: 412.6 },
  }
}

/** The data block's JSON, safe inside a <script type="application/json">: no "<" survives. */
export function officeJson(o: Office, sample: boolean): string {
  // The summary is what the payroll card prints: the same figures as the
  // cards above the room, so the card and the page cannot disagree.
  const topIdx = o.topEarner ? o.agents.findIndex((a) => a.name === o.topEarner!.name) : -1
  return JSON.stringify({ sample, agents: o.agents.map((a) => ({ name: a.name, sal: a.sal, state: a.state, working: a.working })),
    summary: { month: o.month, payroll: o.payroll == null ? null : Math.round(o.payroll * 100) / 100, staff: o.staff, atDesk: o.atDesk, sentHome: o.sentHome,
      top: o.topEarner ? { name: o.topEarner.name, sal: Math.round(o.topEarner.sal * 100) / 100, idx: topIdx < 0 ? 0 : topIdx } : null } })
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}
