import type { FastifyInstance } from 'fastify'
import { publicRoute } from '../middleware/auth.js'
import { docsShell } from '../ui/docs.js'
import { probeDb } from '../lib/db-watchdog.js'
import { COMMIT } from '../lib/version.js'
import { chip } from '../ui/kit.js'

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

  <div class="cv-panel st-panel">
    <div class="cv-card">
      <div class="cv-bar">
        <span class="st-head ${allOk ? 'ok' : 'down'}"><span class="st-dot"></span><span>${allOk ? 'All checks passing' : 'Something is down'}</span></span>
      </div>
      <div class="st-list">
${checks.map((c) => `        <div class="st-row ${c.ok ? 'ok' : 'down'}">
          <span class="st-name">${c.name}</span>
          <span class="st-detail">${chip(c.ok ? 'ok' : 'fail', c.detail)}</span>
          <span class="st-ms">${c.ms === null ? '' : `${c.ms} ms`}</span>
        </div>`).join('\n')}
      </div>
      <div class="st-foot">
        <p class="st-when">Checked ${checkedAt} UTC. Latency is one round trip from this server, including
           connection setup when the pool is cold.</p>
        <p class="st-when">Serving commit <code>${COMMIT}</code>. ${COMMIT === 'unknown'
    ? 'Unknown means this image was built without its GIT_SHA build argument, not that anything is wrong with it.'
    : 'That is the commit this image was built from, so what is deployed can be checked against the repository from outside.'}</p>
      </div>
    </div>
  </div>

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
     <a href="mailto:hello@agentbill.dev">hello@agentbill.dev</a>.</p>
`
}

const STATUS_CSS = `
    /* One token, one chip. \`GET /health/db\` was breaking across a line and
       rendering as two pills, so the page showed two endpoints where it has one.
       Scoped here rather than to .inline in docs.ts, where a longer token on a
       guide could then overflow the mobile column. */
    .inline { white-space: nowrap; }
    /* The checks in the frame, 2026-09-23: a white card on the warm-grey
       panel, the verdict in its bar, one row per check in the frame's log
       voice (mono name, the answer as a chip, the latency right-aligned), and
       when and what was checked on the side ground under them. No SAMPLE tag:
       these numbers are this request's own. A passing check is .chip-ok,
       neutral, because a pass is not a colour; a failing one is .chip-fail,
       the one filled signal, because it needs a human. */
    .st-panel { max-width: 720px; margin-block: var(--s5) var(--s4); }
    .st-head { display: flex; align-items: center; gap: 10px; min-width: 0; font-size: var(--fs-body);
               font-weight: 500; color: var(--text); }
    .st-head.down { color: var(--red); }
    .st-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; flex: none; }
    .st-list { padding: var(--s3) 20px; }
    .st-row { display: grid; grid-template-columns: minmax(0, 1fr) auto 72px; gap: var(--s4);
              align-items: center; padding: 9px 10px; }
    .st-name { font-family: var(--mono); font-size: var(--fs-small); color: var(--text); }
    .st-row.down .st-name { color: var(--red); }
    .st-ms { font-family: var(--mono); font-size: var(--fs-small); color: var(--muted);
             text-align: right; font-variant-numeric: tabular-nums; }
    .st-foot { background: var(--side-bg); border-top: 1px solid var(--card-line); padding: var(--s4) 20px;
               display: grid; gap: var(--s2); }
    .container .st-when { font-family: var(--mono); font-size: var(--fs-micro); color: var(--dim);
                          line-height: 1.6; margin: 0; max-width: 72ch; }
    .st-when code { font-family: var(--mono); color: var(--text); }
    @media (max-width: 640px) {
      .st-list { padding: var(--s2) var(--s2) 10px; }
      .st-row { grid-template-columns: minmax(0, 1fr) auto auto; gap: 4px var(--s2); padding-inline: 6px; }
      .st-ms { min-width: 5ch; }
      .st-foot { padding: 14px var(--s3); }
    }
    /* Under 380 the latency moves under its chip: a failing row carries the
       widest chip and the widest number at once, and at 320 the three need
       about 250px of a 234px row. 390 holds all three with room. */
    @media (max-width: 380px) {
      .st-row { grid-template-columns: minmax(0, 1fr) auto; }
      .st-ms { grid-column: 2; min-width: 0; }
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
        // No sticky signup bar on a phone. A status page is read by someone
        // checking whether the thing they already run is up, and it is a
        // utility page like /terms, which drops the bar the same way.
        sticky: false,
        css: STATUS_CSS,
        body: statusBody(checks, checkedAt),
      }))
  })
}
