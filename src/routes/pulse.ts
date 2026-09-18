import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { plain } from '../lib/ids.js'
import { sql } from '../db/index.js'
import { limiterKey } from '../lib/client-ip.js'
import { publicRoute } from '../middleware/auth.js'

// POST /pulse. One public, unauthenticated, fire-and-forget write, so the
// marketing pages can answer "did anyone actually use this" out of our own
// database instead of an ad platform's.
//
// Why it exists at all. The homepage playground shipped 2026-09-04 and for a
// day nothing recorded whether a single visitor pressed Run. The obvious sink
// was the pixel, and the pixel is not there: META_PIXEL_ID has never been set,
// so fbq is undefined on every page, and the one live pixel is Reddit's, for a
// channel killed on 2026-09-03. Even with one configured, the ICP is developers
// and developers block ad pixels, so it would systematically under-count the
// exact people it is meant to count.
//
// The surface this adds, stated plainly. An unauthenticated endpoint that
// writes rows to the billing database. It is narrowed to almost nothing: the
// event name must be one of a fixed allowlist, `ceiling` is a bounded integer,
// `view_id` is truncated, everything else in the body is dropped, and one
// network gets 40 playground writes and 10 funnel writes an hour. Every path
// this handler takes replies 204 with no
// body, including rejection, so a prober learns nothing about what was
// accepted. The one exception is not ours: a body that is not JSON at all is
// refused by Fastify's content-type parser with a 400 before the handler runs.

const PulseBody = z.object({
  // An allowlist, not a free string. A row this endpoint accepts is a row
  // somebody can create a million of, so the vocabulary is closed.
  event: z.enum([
    'playground_run', 'playground_blocked', 'playground_completed',
    // 2026-09-18, the first day of paid traffic: 40 landing page views, 0 new
    // accounts, and nothing recorded between those two numbers, so a page
    // nobody engaged and a form everybody abandoned read identically. cta_click
    // is any homepage link to /register; register_view is /register loading.
    // With the accounts table they cut the gap in three: no click (the fold),
    // a click with no view (the link), a view with no account (the form).
    'cta_click', 'register_view',
  ]),
  // The random per-page-view token from the page. Never a cookie, never
  // localStorage, gone when the tab closes. It exists to separate ten visitors
  // running once from one visitor running ten times.
  view_id: plain(z.string().min(8).max(40)).optional(),
  // The ceiling the visitor chose. Bounded to the slider's own range so the
  // column cannot be used as free storage.
  ceiling: z.number().int().min(0).max(100_000).optional(),
})

// Same tradeoff as the /register guard: in-memory, per-machine, damage control
// rather than perfect distribution. Two buckets per network, not one, because
// the two kinds of event share nothing in volume. A playground run is two
// writes (playground_run, then blocked or completed) and runs are unbounded:
// the button relabels itself "Run again" and the slider invites another. The
// funnel events are one click and one page load per visit. With one shared
// bucket, the visitor who played hardest and THEN pressed Get API key had the
// click and the /register load dropped, and read back as "ran it twenty times,
// never clicked", which is the exact misread the funnel events exist to remove.
// Found in review on 2026-09-18, before this shipped.
const PLAYGROUND_LIMIT = 40
const FUNNEL_LIMIT = 10
const IP_WINDOW_MS = 60 * 60 * 1000
const MAX_ENTRIES = 10_000
const ipHits = new Map<string, number[]>()

function allowPulse(bucket: string, limit: number): boolean {
  const now = Date.now()
  const hits = (ipHits.get(bucket) ?? []).filter((t) => now - t < IP_WINDOW_MS)
  if (hits.length >= limit) {
    ipHits.set(bucket, hits)
    return false
  }
  hits.push(now)
  ipHits.set(bucket, hits)
  if (ipHits.size > MAX_ENTRIES) {
    let i = 0
    const cut = Math.floor(ipHits.size / 2)
    for (const key of ipHits.keys()) {
      ipHits.delete(key)
      if (++i >= cut) break
    }
  }
  return true
}

export async function pulseRoute(app: FastifyInstance) {
  app.post('/pulse', publicRoute(), async (request, reply) => {
    // 204 on every path this handler reaches, including rejection. A visitor's
    // browser has nothing to do with the answer. Failures are the server's
    // problem, never the page's.
    const done = () => reply.code(204).send()

    // Parse first, then meter, so a bucket counts writes and not noise: a name
    // outside the allowlist never reaches the table and should not spend a
    // real visitor's budget on its way to the same 204.
    const parsed = PulseBody.safeParse(request.body ?? {})
    if (!parsed.success) return done()

    const { event, view_id, ceiling } = parsed.data
    const playground = event.startsWith('playground_')
    if (!allowPulse(`${limiterKey(request)}|${playground ? 'pg' : 'funnel'}`,
                    playground ? PLAYGROUND_LIMIT : FUNNEL_LIMIT)) return done()
    try {
      await sql`
        INSERT INTO site_pulse (event, view_id, ceiling)
        VALUES (${event}, ${view_id ?? null}, ${ceiling ?? null})
      `
    } catch (err) {
      // An analytics write must never surface as a failure on a marketing page.
      request.log.warn({ err, event }, 'pulse write failed')
    }
    return done()
  })
}
