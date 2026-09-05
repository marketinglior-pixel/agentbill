import type { FastifyInstance } from 'fastify'
import { publicRoute } from '../middleware/auth.js'
import { docsShell } from '../ui/docs.js'
import { probeDb } from '../lib/db-watchdog.js'

// A status page that measures rather than asserts.
//
// The footer wanted a trust link and /health returns JSON, which is the
// opposite of a trust signal to a human. This is the page that can honestly
// carry one.
//
// What it will NOT do: show a 90-day uptime bar or a "99.9%" figure. Nothing in
// this system records historical availability. The GitHub Actions cron probes
// /health/db every thirty minutes and emails on failure, and it keeps no
// series. A page that drew a green bar for the last quarter would be drawing a
// number nobody measured, on the one page whose entire job is to be believed.
// So it says what it checked, when, how long it took, and what it does not know.

export type Check = {
  name: string
  ok: boolean
  detail: string
  /** null when the check is not timed. */
  ms: number | null
}

/**
 * Exported so the degraded rendering can be tested without breaking a database.
 * A status page that has never rendered its own failure state is a status page
 * that says "operational" and nothing else.
 */
export function statusBody(checks: readonly Check[], checkedAt: string): string {
  const allOk = checks.every((c) => c.ok)
  return `
  <h1>Status</h1>
  <p class="lede">Checked when you loaded this page, not on a schedule. Nothing
     below is cached.</p>

  <div class="st-head ${allOk ? 'ok' : 'down'}">
    <span class="st-dot"></span>
    <span>${allOk ? 'All checks passing' : 'Something is down'}</span>
  </div>

  <div class="st-list">
${checks.map((c) => `    <div class="st-row ${c.ok ? 'ok' : 'down'}">
      <span class="st-name">${c.name}</span>
      <span class="st-detail">${c.detail}</span>
      <span class="st-ms">${c.ms === null ? '' : `${c.ms} ms`}</span>
    </div>`).join('\n')}
  </div>
  <p class="st-when">Checked ${checkedAt} UTC.</p>

  <h2>What this page does not know</h2>
  <p>It has no history. Nothing here records past availability, so there is no
     uptime percentage and no ninety-day bar, because either would be a number
     nobody measured on the one page whose job is to be believed. What you see
     is the result of two checks run while this page was rendering.</p>
  <p>An outage while nobody is looking is caught elsewhere: a scheduled job
     probes the database endpoint every thirty minutes from outside this server
     and raises an alert when it fails, and the server itself emails the owner
     after a sustained failure and again on recovery.</p>

  <h2>For machines</h2>
  <p><code class="inline">GET /health</code> answers whether the process is up
     and never touches the database. <code class="inline">GET /health/db</code>
     runs the same query this page runs and returns 503 when it fails, which is
     the one to point a monitor at. The distinction matters: this service was
     unreachable for weeks in 2026 while a database-free health check reported
     ok.</p>

  <h2>If something is wrong</h2>
  <p>A refusal is not an outage. If preflight is returning
     <code class="inline">approved: false</code>, the ceiling did its job and
     <a href="/faq">the questions page</a> covers the reasons. If this page says
     something is down, it is ours: mail
     <a href="mailto:marketinglior@gmail.com">marketinglior@gmail.com</a>.</p>
`
}

const STATUS_CSS = `
    .st-head { display: flex; align-items: center; gap: var(--s3); margin-block: var(--s5) var(--s4);
               font-family: var(--display); font-size: var(--fs-h3); font-weight: 600; }
    .st-head.ok { color: var(--green); }
    .st-head.down { color: var(--red); }
    .st-dot { width: 10px; height: 10px; border-radius: 50%; background: currentColor; flex: none; }
    .st-list { border: 1px solid var(--border); border-radius: var(--r-frame);
               background: var(--surface); box-shadow: var(--edge), var(--lift); }
    .st-row { display: grid; grid-template-columns: 1fr auto 84px; gap: var(--s4);
              align-items: baseline; padding: 14px 18px;
              border-bottom: 1px solid var(--border-soft); }
    .st-row:last-child { border-bottom: 0; }
    .st-name { font-family: var(--mono); font-size: var(--fs-small); color: var(--text); }
    .st-detail { font-family: var(--mono); font-size: var(--fs-micro); }
    .st-row.ok .st-detail { color: var(--green); }
    .st-row.down .st-detail { color: var(--red); }
    .st-ms { font-family: var(--mono); font-size: var(--fs-micro); color: var(--dim);
             text-align: right; font-variant-numeric: tabular-nums; }
    .st-when { font-family: var(--mono); font-size: var(--fs-micro); color: var(--dim);
               margin-top: var(--s3); }
    @media (max-width: 640px) {
      .st-row { grid-template-columns: 1fr auto; }
      .st-ms { grid-column: 2; }
    }
`

export async function statusRoute(app: FastifyInstance) {
  app.get('/status', publicRoute(), async (_, reply) => {
    const probe = await probeDb()
    const checks: Check[] = [
      // If this page rendered at all, the process answered. Saying so is not a
      // measurement; saying it IS the measurement would be the fake part.
      { name: 'API', ok: true, detail: 'responding', ms: null },
      {
        name: 'Database',
        ok: probe.ok,
        detail: probe.ok ? 'reachable' : 'unreachable',
        ms: Math.round(probe.latencyMs),
      },
    ]
    const checkedAt = new Date().toISOString().slice(0, 19).replace('T', ' ')

    return reply
      // Never cached. A cached status page is a status page that can tell you
      // everything is fine ten minutes after it stopped being fine.
      .header('Cache-Control', 'no-store')
      .type('text/html')
      // 200 even when degraded: this is a page for a person, and a 503 here
      // would stop browsers and crawlers rendering the explanation. Machines
      // read /health/db, which does return 503.
      .send(docsShell({
        path: '/status',
        title: 'Status · AgentBill',
        description: 'Live check of the AgentBill API and database, run when the page loads. No cached figures and no uptime history, because none is recorded.',
        current: '',
        rail: false,
        css: STATUS_CSS,
        body: statusBody(checks, checkedAt),
      }))
  })
}
