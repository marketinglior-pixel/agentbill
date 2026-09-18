import { sql } from '../db/index.js'

export type SitePulse = {
  ctaClicks: number
  tryClicks: number
  registerViews: number
  views: number
  runs: number
  blocked: number
  movedSlider: number
  since: string | null
}

// The public pages, from our own rows. Every figure here is derived in SQL
// from site_pulse; nothing is a counter maintained beside another counter.
//
// Every "views" figure counts distinct view_id, which is one page view and not
// one person: the token is minted per page load and never persisted, so the
// same visitor coming back twice is two views. That is the honest bound and it
// is stated under the tiles, not in a comment nobody reads.
//
// ctaClicks and registerViews were added 2026-09-18, the first day of paid
// traffic, and tryClicks the same day. Read them as a funnel with the accounts
// table: homepage views that clicked through, /register loads, account rows.
// Where the numbers fall off is where the visit ended. tryClicks sits beside
// ctaClicks: well ahead of it, the demo has earned a higher place; neither
// moving, the fold is the problem and not the depth.
export async function getSitePulse(): Promise<SitePulse> {
  try {
    const [row] = await sql`
      SELECT
        count(DISTINCT view_id) FILTER (WHERE event = 'cta_click')                       AS cta_clicks,
        count(DISTINCT view_id) FILTER (WHERE event = 'try_click')                       AS try_clicks,
        count(DISTINCT view_id) FILTER (WHERE event = 'register_view')                   AS register_views,
        count(DISTINCT view_id) FILTER (WHERE event = 'playground_run')                  AS views,
        count(*)                FILTER (WHERE event = 'playground_run')                  AS runs,
        count(*)                FILTER (WHERE event = 'playground_blocked')              AS blocked,
        count(DISTINCT view_id) FILTER (WHERE event = 'playground_run' AND ceiling <> 500) AS moved_slider,
        min(created_at)                                                                  AS since
      FROM site_pulse
      WHERE created_at > now() - interval '30 days'
    `
    return {
      ctaClicks: Number(row?.ctaClicks ?? 0),
      tryClicks: Number(row?.tryClicks ?? 0),
      registerViews: Number(row?.registerViews ?? 0),
      views: Number(row?.views ?? 0),
      runs: Number(row?.runs ?? 0),
      blocked: Number(row?.blocked ?? 0),
      movedSlider: Number(row?.movedSlider ?? 0),
      since: row?.since ? new Date(row.since).toISOString() : null,
    }
  } catch {
    // The table is additive and the page predates it. A missing table must not
    // take down the account list, which is what admin is actually for.
    return { ctaClicks: 0, tryClicks: 0, registerViews: 0, views: 0, runs: 0, blocked: 0, movedSlider: 0, since: null }
  }
}
