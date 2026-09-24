import { sql } from '../db/index.js'

/**
 * Units recorded over a window, split by the event_type each record carried.
 * Both readers use it: GET /usage?by=event_type and the console's activity
 * view. One function, so the API and the page cannot disagree.
 *
 * Ticket 2026-09-23, from a builder's interview: "which process is the most
 * expensive", without doing the arithmetic himself. The console could only
 * rank customers; this is the split by what the code reported.
 *
 * What event_type holds is the caller's, and it is worth saying plainly
 * because it decides what this split means. record() in both SDKs sends its
 * agent_id as the event_type, so for SDK calls this is a split by agent label.
 * meter() in both SDKs and a raw POST /events carry the event name the caller
 * passed. Nothing here names or classifies an action; the label is the one
 * the code sent, and the units are the units the code reported.
 *
 * The window is the console's: today and the days - 1 before it, on the
 * database's calendar, the same predicate loadConsole's series uses, so the
 * total here and the units-metered tile over the same window are one number.
 * The totals come from window functions over every group before the LIMIT,
 * so a page of groups still reports the whole window's total and its share.
 */
export type UsageGroup = { eventType: string; units: number; events: number }

export type EventTypeUsage = {
  /** The window's first day, YYYY-MM-DD. */
  since: string
  totalUnits: number
  totalEvents: number
  /** Distinct event_types in the window; groups holds at most `limit` of them. */
  groupCount: number
  /** Heaviest first; ties by name, so a page is stable. */
  groups: UsageGroup[]
}

export async function usageByEventType(accountId: string, days: number, limit: number): Promise<EventTypeUsage> {
  const rows = await sql`
    SELECT event_type, units, events,
           sum(units)  OVER () AS total_units,
           sum(events) OVER () AS total_events,
           count(*)    OVER () AS group_count
    FROM (
      SELECT event_type, sum(units) AS units, count(*) AS events
      FROM events
      WHERE account_id = ${accountId} AND created_at >= current_date - ${days - 1}::int
      GROUP BY event_type
    ) g
    ORDER BY units DESC, event_type
    LIMIT ${limit}
  `
  const [w] = await sql`SELECT to_char(current_date - ${days - 1}::int, 'YYYY-MM-DD') AS since`
  const first = rows[0]
  return {
    since: String(w?.since ?? ''),
    totalUnits: Number(first?.totalUnits ?? 0),
    totalEvents: Number(first?.totalEvents ?? 0),
    groupCount: Number(first?.groupCount ?? 0),
    groups: rows.map((r) => ({ eventType: String(r.eventType), units: Number(r.units), events: Number(r.events) })),
  }
}
