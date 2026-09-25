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
export type UsageGroup = {
  eventType: string; units: number; events: number
  /** The list-price estimate of this group's priced calls, or null when none is priced. Never 0 for "unpriced". */
  usd: number | null
  pricedEvents: number
  /** Tokens the provider reported, from the metadata wrap() writes. 0 when no record carried any. */
  tokens: number
}

/** The token total of one event, from the metadata wrap() writes (the same
 *  five buckets the SDKs' _total adds up; reasoning is inside output). A value
 *  that is not a whole number of at most 15 digits reads as 0, so one
 *  malformed record cannot turn a page into a 500. Shared with the console. */
export const EVENT_TOKENS_SQL = ['input', 'cache_read', 'cache_write', 'cache_write_1h', 'output']
  .map((f) => `coalesce(CASE WHEN metadata->'tokens'->>'${f}' ~ '^[0-9]{1,15}$' THEN (metadata->'tokens'->>'${f}')::bigint END, 0)`)
  .join(' + ')

export type EventTypeUsage = {
  /** The window's first day, YYYY-MM-DD. */
  since: string
  totalUnits: number
  totalEvents: number
  /** The window's list-price estimate over priced calls, or null when none is priced. */
  totalUsd: number | null
  totalPriced: number
  /** Distinct event_types in the window; groups holds at most `limit` of them. */
  groupCount: number
  /** Heaviest first; ties by name, so a page is stable. */
  groups: UsageGroup[]
}

/**
 * order: 'units' (the API's order, unchanged) or 'usd', the console's order
 * when the window has priced calls: the dearest first, unpriced groups after.
 */
export async function usageByEventType(accountId: string, days: number, limit: number, order: 'units' | 'usd' = 'units'): Promise<EventTypeUsage> {
  const rows = await sql`
    SELECT event_type, units, events, usd, priced, tokens,
           sum(units)  OVER () AS total_units,
           sum(events) OVER () AS total_events,
           sum(usd)    OVER () AS total_usd,
           sum(priced) OVER () AS total_priced,
           count(*)    OVER () AS group_count
    FROM (
      SELECT event_type, sum(units) AS units, count(*) AS events,
             sum(list_price_usd) AS usd, count(list_price_usd) AS priced,
             sum(${sql.unsafe(EVENT_TOKENS_SQL)}) AS tokens
      FROM events
      WHERE account_id = ${accountId} AND created_at >= current_date - ${days - 1}::int
      GROUP BY event_type
    ) g
    ORDER BY ${order === 'usd' ? sql`usd DESC NULLS LAST, units DESC, event_type` : sql`units DESC, event_type`}
    LIMIT ${limit}
  `
  const [w] = await sql`SELECT to_char(current_date - ${days - 1}::int, 'YYYY-MM-DD') AS since`
  const first = rows[0]
  return {
    since: String(w?.since ?? ''),
    totalUnits: Number(first?.totalUnits ?? 0),
    totalEvents: Number(first?.totalEvents ?? 0),
    totalUsd: Number(first?.totalPriced ?? 0) > 0 ? Number(first.totalUsd) : null,
    totalPriced: Number(first?.totalPriced ?? 0),
    groupCount: Number(first?.groupCount ?? 0),
    groups: rows.map((r) => ({
      eventType: String(r.eventType), units: Number(r.units), events: Number(r.events),
      usd: Number(r.priced) > 0 ? Number(r.usd) : null, pricedEvents: Number(r.priced), tokens: Number(r.tokens ?? 0),
    })),
  }
}
