import { sql } from '../db/index.js'

export type PlaygroundPulse = {
  views: number
  runs: number
  blocked: number
  movedSlider: number
  since: string | null
}

// The homepage playground, from our own rows. Every figure here is derived in
// SQL from site_pulse; nothing is a counter maintained beside another counter.
//
// `views` counts distinct view_id, which is one page view and not one person:
// the token is minted per page load and never persisted, so the same visitor
// coming back twice is two views. That is the honest bound and it is stated
// under the tiles, not in a comment nobody reads.
export async function getPlaygroundPulse(): Promise<PlaygroundPulse> {
  try {
    const [row] = await sql`
      SELECT
        count(DISTINCT view_id) FILTER (WHERE event = 'playground_run')                  AS views,
        count(*)                FILTER (WHERE event = 'playground_run')                  AS runs,
        count(*)                FILTER (WHERE event = 'playground_blocked')              AS blocked,
        count(DISTINCT view_id) FILTER (WHERE event = 'playground_run' AND ceiling <> 500) AS moved_slider,
        min(created_at)                                                                  AS since
      FROM site_pulse
      WHERE created_at > now() - interval '30 days'
    `
    return {
      views: Number(row?.views ?? 0),
      runs: Number(row?.runs ?? 0),
      blocked: Number(row?.blocked ?? 0),
      movedSlider: Number(row?.movedSlider ?? 0),
      since: row?.since ? new Date(row.since).toISOString() : null,
    }
  } catch {
    // The table is additive and the page predates it. A missing table must not
    // take down the account list, which is what admin is actually for.
    return { views: 0, runs: 0, blocked: 0, movedSlider: 0, since: null }
  }
}
