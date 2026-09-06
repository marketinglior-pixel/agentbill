import type { FastifyInstance, FastifyRequest } from 'fastify'
import { createHmac, timingSafeEqual } from 'crypto'
import { sql } from '../db/index.js'
import { PLAN_LIMITS } from '../integrations/polar.js'
import { clientIp } from '../lib/client-ip.js'
import { head } from '../ui/theme.js'
import { publicRoute } from '../middleware/auth.js'
import { mark, MARK_CSS } from '../ui/mark.js'
import { KEY_CTA } from '../ui/chrome.js'

// /app is the console: the only browser surface a registered user has. It
// shows live task budgets burning down, every call AgentBill refused with the
// literal response the agent received, per-customer balances and key health.
// Its first job is still the empty state, because almost every account that
// reaches it has never made a call: a one-line curl that gets refused before
// anything runs, and ?demo=1 to see the same page with sample data.
//
// Auth is a pasted API key exchanged for an HttpOnly cookie bound to the key's
// id (not the key), signed with a secret derived from ADMIN_SECRET. Revoking
// or expiring the key kills the session on the next request. Nothing here
// updates last_seen_ip, so opening the receipt never trips the IP alert.
// This page loads no third-party scripts: a live key is rendered into it.

const COOKIE = 'agentbill_app'
const MAX_AGE = 7 * 24 * 3_600
const LOGIN_LIMIT = 20
const LOGIN_WINDOW_MS = 15 * 60_000
const loginHits = new Map<string, number[]>()

type Viewer = {
  keyId: string
  apiKey: string
  keyLabel: string | null
  accountId: string
  email: string | null
  plan: string
  monthlyCalls: number
}

export async function appRoute(app: FastifyInstance) {
  app.get('/app', publicRoute(), async (request, reply) => {
    // same-origin, not no-referrer: under no-referrer, browsers send `Origin: null`
    // on the page's own form POSTs (Fetch, "append a request Origin header"),
    // which is what made every real-browser login 403 while curl passed.
    // Nothing secret is ever in this page's URL, and same-origin still sends no
    // referrer to anyone else.
    // X-Robots-Tag as well as the meta, so the directive survives a response
    // that is not HTML. robots.txt no longer Disallows this path: a Disallowed
    // URL is one the crawler cannot fetch, and therefore one whose noindex it
    // never reads.
    reply.type('text/html').header('Cache-Control', 'no-store').header('Referrer-Policy', 'same-origin')
      .header('X-Robots-Tag', 'noindex')
      .header('X-Content-Type-Options', 'nosniff')
      // img-src and manifest-src are here because head() emits the favicon and
      // manifest links on every page, and this is the one page with a real CSP:
      // under default-src 'none' the browser blocked all four and logged a
      // violation for each on every load. 'self' only, plus data: for the one
      // inline SVG the site uses as a select arrow.
      .header('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; manifest-src 'self'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
    const q = request.query as Record<string, unknown>
    const demo = q?.demo === '1'
    const range = typeof q?.range === 'string' && Object.hasOwn(RANGES, q.range) ? q.range : DEFAULT_RANGE
    const viewer = await loadSession(request)

    // The sample console is the only place a prospect can see what the product
    // actually produces, so it is public. Without a session it renders against
    // a stand-in viewer and swaps the account chrome for a signup CTA. This
    // check must stay ABOVE the login return: it used to sit below it, which
    // made ?demo=1 reachable only to people who had already signed up.
    if (!viewer) {
      if (demo) return reply.send(consolePage(DEMO_VIEWER, demoConsole(), true, range, true))
      return reply.send(loginPage(typeof q?.err === 'string' ? q.err : ''))
    }

    const data = demo ? demoConsole() : await loadConsole(viewer.accountId, RANGES[range].days)
    return reply.send(consolePage(viewer, data, demo, range))
  })

  // The canonical-host redirect preserves a trailing slash; without this the
  // 404 handler's Bearer hook would answer /app/ with a JSON 401.
  app.get('/app/', publicRoute(), async (_request, reply) => reply.redirect('/app' + (_request.url.includes('?') ? _request.url.slice(_request.url.indexOf('?')) : ''), 301))

  app.post('/app/session', publicRoute(), async (request, reply) => {
    if (!sameOrigin(request)) return reply.code(403).send({ error: 'forbidden' })
    if (!allowLogin(clientIp(request))) return reply.redirect('/app?err=rate', 303)
    const secret = sessionSecret()
    if (!secret) return reply.redirect('/app?err=unavailable', 303)

    const body = request.body as Record<string, unknown>
    const key = typeof body?.api_key === 'string' ? body.api_key.trim() : ''
    if (!/^[A-Za-z0-9_-]{8,200}$/.test(key)) return reply.redirect('/app?err=key', 303)

    // Decided in SQL, same reason as the API middleware: revoked_at is written
    // by the database clock, so an app-side comparison turns clock skew into a
    // window where a revoked key can still open the console.
    const [row] = await sql`
      SELECT id,
             (revoked_at IS NOT NULL AND revoked_at <= NOW()) AS is_revoked,
             (expires_at IS NOT NULL AND expires_at <= NOW()) AS is_expired
      FROM developer_api_keys
      WHERE api_key = ${key}
      LIMIT 1
    `
    if (!row) return reply.redirect('/app?err=key', 303)
    if (row.isRevoked) return reply.redirect('/app?err=revoked', 303)
    if (row.isExpired) return reply.redirect('/app?err=expired', 303)

    reply.header(
      'Set-Cookie',
      `${COOKIE}=${mintToken(row.id as string, secret)}; HttpOnly; Secure; SameSite=Lax; Path=/app; Max-Age=${MAX_AGE}`,
    )
    return reply.redirect('/app', 303)
  })

  app.post('/app/logout', publicRoute(), async (request, reply) => {
    if (!sameOrigin(request)) return reply.code(403).send({ error: 'forbidden' })
    reply.header('Set-Cookie', `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/app; Max-Age=0`)
    return reply.redirect('/app', 303)
  })
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

function sessionSecret(): string {
  const explicit = process.env.APP_SESSION_SECRET
  if (explicit) return explicit
  const admin = process.env.ADMIN_SECRET
  if (!admin) return ''
  // Derived, so no new secret to provision; rotating ADMIN_SECRET logs everyone out.
  return createHmac('sha256', admin).update('agentbill-app-session-v1').digest('hex')
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex')
}

function safeEqual(a: string, b: string): boolean {
  const A = Buffer.from(a)
  const B = Buffer.from(b)
  return A.length === B.length && timingSafeEqual(A, B)
}

function mintToken(keyId: string, secret: string): string {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE
  const payload = `${keyId}.${exp}`
  return `${payload}.${sign(payload, secret)}`
}

function verifyToken(token: string, secret: string): string | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [keyId, expStr, mac] = parts
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(keyId)) return null
  const exp = Number(expStr)
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return null
  if (!/^[0-9a-f]{64}$/.test(mac) || !safeEqual(mac, sign(`${keyId}.${exp}`, secret))) return null
  return keyId
}

function readCookie(header: string, name: string): string {
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return ''
}

async function loadSession(request: FastifyRequest): Promise<Viewer | null> {
  const secret = sessionSecret()
  if (!secret) return null
  const token = readCookie(request.headers.cookie ?? '', COOKIE)
  if (!token) return null
  const keyId = verifyToken(token, secret)
  if (!keyId) return null

  const [row] = await sql`
    SELECT k.id AS key_id, k.api_key, k.label,
           (k.revoked_at IS NOT NULL AND k.revoked_at <= NOW()) AS is_revoked,
           (k.expires_at IS NOT NULL AND k.expires_at <= NOW()) AS is_expired,
           a.id AS account_id, a.email, a.plan, a.monthly_calls
    FROM developer_api_keys k
    JOIN accounts a ON a.id = k.account_id
    WHERE k.id = ${keyId}
    LIMIT 1
  `
  if (!row) return null
  // Same clock rule as the API middleware: an existing session dies the moment
  // its key is revoked, not one clock-skew later.
  if (row.isRevoked) return null
  if (row.isExpired) return null
  return {
    keyId: row.keyId as string,
    apiKey: row.apiKey as string,
    keyLabel: (row.label as string | null) ?? null,
    accountId: row.accountId as string,
    email: (row.email as string | null) ?? null,
    plan: (row.plan as string) ?? 'free',
    monthlyCalls: Number(row.monthlyCalls ?? 0),
  }
}

// Login CSRF guard: a form POST from another site must not be able to log a
// victim into the attacker's account. Modern browsers send Sec-Fetch-Site;
// older ones send Origin on POST. Absent both, allow (curl, old clients).
// CSRF guard for the two form POSTs. Sec-Fetch-Site is set by the browser
// and cannot be forged by a page, so when it is present it decides: only
// same-origin passes. Without it (old browsers, curl) fall back to the Origin
// host. A literal `Origin: null` is what a browser sends for a POST under a
// no-referrer policy, so it counts only when Sec-Fetch-Site already vouched.
function sameOrigin(request: FastifyRequest): boolean {
  const sfs = request.headers['sec-fetch-site']
  if (typeof sfs === 'string') return sfs === 'same-origin'
  const origin = request.headers.origin
  if (typeof origin === 'string') {
    try { return new URL(origin).host === request.hostname } catch { return false }
  }
  return true
}

function allowLogin(ip: string): boolean {
  const now = Date.now()
  const hits = (loginHits.get(ip) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS)
  if (hits.length >= LOGIN_LIMIT) { loginHits.set(ip, hits); return false }
  hits.push(now)
  loginHits.set(ip, hits)
  if (loginHits.size > 10_000) {
    // Drop expired buckets first, then the oldest keys; never wipe live ones.
    for (const [k, v] of loginHits) if (now - v[v.length - 1] >= LOGIN_WINDOW_MS) loginHits.delete(k)
    let i = 0
    const cut = Math.max(0, loginHits.size - 5_000)
    for (const k of loginHits.keys()) { if (i++ >= cut) break; loginHits.delete(k) }
  }
  return true
}


// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

type Series = { day: string; blocks: number; units: number }
type TaskRow = { taskRef: string; agentId: string; ceilingUnits: number; usedUnits: number; reservedUnits: number; updatedAt: Date }
type CustomerRow = { customerRef: string; limitUnits: number | null; usedUnits: number; reservedUnits: number }
type KeyRow = { apiKey: string; label: string | null; createdAt: Date; revokedAt: Date | null; expiresAt: Date | null; lastSeenIp: string | null }
type DecisionRow = { agentId: string | null; taskRef: string | null; reason: string; blocked: boolean; estimatedUnits: number | null; ceilingUnits: number | null; usedUnits: number | null; snapshot: string; createdAt: Date }

type Console = {
  blocked: number
  overruns: number
  refusedUnits: number
  lastBlock: Date | null
  meteredUnits: number
  prevBlocked: number
  series: Series[]
  tasks: TaskRow[]
  customers: CustomerRow[]
  keys: KeyRow[]
  decisions: DecisionRow[]
  truncated: boolean
}

const RANGES: Record<string, { days: number; label: string }> = {
  '7d':  { days: 7,  label: '7 days' },
  '30d': { days: 30, label: '30 days' },
  '90d': { days: 90, label: '90 days' },
}
const DEFAULT_RANGE = '30d'
const DAYS = 30

async function loadConsole(accountId: string, days: number): Promise<Console> {
  const [totals] = await sql`
    SELECT count(*) FILTER (WHERE blocked)                          AS blocked,
           count(*) FILTER (WHERE NOT blocked)                      AS overruns,
           coalesce(sum(estimated_units) FILTER (WHERE blocked), 0) AS refused_units,
           max(created_at) FILTER (WHERE blocked)                   AS last_block
    FROM preflight_decisions
    WHERE account_id = ${accountId}
  `
  const [metered] = await sql`
    SELECT coalesce(sum(units), 0) AS units
    FROM events
    WHERE account_id = ${accountId} AND created_at >= date_trunc('month', now())
  `
  // Same length of window, immediately before this one. A tile with no
  // direction is a number; with one it is a signal.
  const [prev] = await sql`
    SELECT count(*) FILTER (WHERE blocked) AS blocks,
           coalesce(sum(estimated_units) FILTER (WHERE blocked), 0) AS units
    FROM preflight_decisions
    WHERE account_id = ${accountId}
      AND created_at >= current_date - ${days * 2 - 1}::int
      AND created_at <  current_date - ${days - 1}::int
  `
  const series = await sql`
    SELECT to_char(d, 'YYYY-MM-DD') AS day,
           coalesce(b.blocks, 0)    AS blocks,
           coalesce(e.units, 0)     AS units
    FROM generate_series(current_date - ${days - 1}::int, current_date, interval '1 day') d
    LEFT JOIN (
      SELECT created_at::date AS day, count(*) AS blocks
      FROM preflight_decisions
      WHERE account_id = ${accountId} AND blocked AND created_at >= current_date - ${days - 1}::int
      GROUP BY 1
    ) b ON b.day = d::date
    LEFT JOIN (
      SELECT created_at::date AS day, sum(units) AS units
      FROM events
      WHERE account_id = ${accountId} AND created_at >= current_date - ${days - 1}::int
      GROUP BY 1
    ) e ON e.day = d::date
    ORDER BY d
  `
  const tasks = await sql`
    SELECT task_ref, agent_id, ceiling_units, used_units, reserved_units, updated_at
    FROM task_budgets
    WHERE account_id = ${accountId}
    ORDER BY updated_at DESC
    LIMIT 20
  `
  const customers = await sql`
    SELECT customer_ref, limit_units, used_units, reserved_units
    FROM customers
    WHERE account_id = ${accountId}
    ORDER BY used_units DESC, created_at DESC
    LIMIT 20
  `
  const keys = await sql`
    SELECT api_key, label, created_at, revoked_at, expires_at, last_seen_ip
    FROM developer_api_keys
    WHERE account_id = ${accountId}
    ORDER BY created_at ASC
  `
  const decisions = await sql`
    SELECT agent_id, task_ref, reason, blocked, estimated_units, ceiling_units,
           used_units, snapshot::text AS snapshot, created_at
    FROM preflight_decisions
    WHERE account_id = ${accountId}
    ORDER BY created_at DESC, id DESC
    LIMIT 100
  `
  return {
    blocked: Number(totals?.blocked ?? 0),
    overruns: Number(totals?.overruns ?? 0),
    refusedUnits: Number(totals?.refusedUnits ?? 0),
    lastBlock: (totals?.lastBlock as Date | null) ?? null,
    meteredUnits: Number(metered?.units ?? 0),
    prevBlocked: Number(prev?.blocks ?? 0),
    series: series as unknown as Series[],
    tasks: tasks as unknown as TaskRow[],
    customers: customers as unknown as CustomerRow[],
    keys: keys as unknown as KeyRow[],
    decisions: decisions as unknown as DecisionRow[],
    truncated: decisions.length === 100,
  }
}

// Placeholder key strings for ?demo=1. Neither is a real key: both are the
// literal word "demo" followed by a repeated digit, they authenticate nothing,
// and they exist only to fill the key column of the sample table. They live up
// here because the viewer below and the keys table in demoConsole() have to
// agree: the row labelled "production" is meant to be the viewer's own key,
// and when the two were written out separately nothing said so.
// Built rather than written out so the shape is the documentation: a prefix,
// forty identical filler characters, a two-char tail to make the pair visibly
// distinct in the table. Written as opaque 50-character literals they read as
// real credentials to a person skimming the file and to a secret scanner, and
// a scan that always reports the same false positive is a scan people stop
// reading. Same bytes either way.
const demoKey = (fill: string, tail: string) => `agb_demo${fill.repeat(40)}${tail}`
const DEMO_KEY = demoKey('0', 'ab')
const DEMO_KEY_CI = demoKey('1', 'cd')
const DEMO_KEY_LABEL = 'production'

// The viewer behind an anonymous ?demo=1. Calls-this-month sits well under the
// Builder limit so the quota bar reads as a healthy account rather than one
// that is out of room.
const DEMO_VIEWER: Viewer = {
  keyId: 'demo',
  apiKey: DEMO_KEY,
  keyLabel: DEMO_KEY_LABEL,
  accountId: 'demo',
  email: null,
  plan: 'builder',
  monthlyCalls: 12480,
}

// Sample data for ?demo=1. Every surface that renders it is labelled, so a
// screenshot of this page carries the label with it. It is never mixed with
// real rows: demo mode replaces the account's data wholesale, it does not
// pad it.
// Exported so the homepage can render the same task and refusal rows this
// console shows under ?demo=1. Two pages that describe one sample account must
// read one source, or the numbers drift apart the first time either is edited.
export function demoConsole(): Console {
  const day = (back: number) => new Date(Date.now() - back * 86_400_000)
  const iso = (back: number) => day(back).toISOString().slice(0, 10)
  const shape = [0,0,3,1,0,6,4,2,9,5,3,12,7,4,18,11,6,9,14,8,21,13,7,16,24,12,9,19,15,11]
  const series: Series[] = shape.map((n, i) => ({
    day: iso(shape.length - 1 - i),
    // ~13% of calls refused. High enough to be worth paying for, low enough
    // to be a real account rather than a broken one.
    blocks: n < 4 ? 0 : Math.round(n * 0.13),
    units: n * 40,
  }))
  const blockedTotal = series.reduce((a, x) => a + x.blocks, 0)
  const meteredTotal = series.reduce((a, x) => a + x.units, 0)
  const mk = (back: number, mins: number, agent: string, task: string | null, reason: string,
              blocked: boolean, est: number | null, ceil: number | null, used: number | null,
              snapshot: object): DecisionRow => ({
    agentId: agent, taskRef: task, reason, blocked,
    estimatedUnits: est, ceilingUnits: ceil, usedUnits: used,
    snapshot: JSON.stringify(snapshot),
    createdAt: new Date(Date.now() - back * 86_400_000 - mins * 60_000),
  })
  return {
    blocked: blockedTotal,
    overruns: 2,
    // Average ask on a refused call, times the number refused.
    refusedUnits: blockedTotal * 173,
    lastBlock: new Date(Date.now() - 22 * 60_000),
    meteredUnits: meteredTotal,
    // The equivalent window immediately before this one.
    prevBlocked: Math.round(blockedTotal * 0.78),
    series,
    tasks: [
      { taskRef: 'job-8871', agentId: 'researcher',  ceilingUnits: 500,  usedUnits: 492, reservedUnits: 0,  updatedAt: new Date(Date.now() - 22 * 60_000) },
      { taskRef: 'job-8870', agentId: 'summarizer',  ceilingUnits: 200,  usedUnits: 96,  reservedUnits: 12, updatedAt: new Date(Date.now() - 3 * 3_600_000) },
      { taskRef: 'nightly-crawl', agentId: 'crawler', ceilingUnits: 2000, usedUnits: 1840, reservedUnits: 60, updatedAt: new Date(Date.now() - 5 * 3_600_000) },
      { taskRef: 'job-8864', agentId: 'researcher',  ceilingUnits: 500,  usedUnits: 118, reservedUnits: 0,  updatedAt: day(1) },
      { taskRef: 'batch-2211', agentId: 'enricher',  ceilingUnits: 1000, usedUnits: 1000, reservedUnits: 0, updatedAt: day(2) },
    ],
    customers: [
      { customerRef: 'cust_acme',     limitUnits: 5000, usedUnits: 4820, reservedUnits: 0 },
      { customerRef: 'cust_globex',   limitUnits: 5000, usedUnits: 2140, reservedUnits: 30 },
      { customerRef: 'cust_initech',  limitUnits: 1000, usedUnits: 1000, reservedUnits: 0 },
      { customerRef: 'cust_umbrella', limitUnits: null, usedUnits: 9310, reservedUnits: 0 },
    ],
    keys: [
      { apiKey: DEMO_KEY, label: DEMO_KEY_LABEL, createdAt: day(38), revokedAt: null, expiresAt: null, lastSeenIp: '203.0.113.42' },
      { apiKey: DEMO_KEY_CI, label: 'ci', createdAt: day(12), revokedAt: null, expiresAt: day(-9), lastSeenIp: '198.51.100.7' },
    ],
    decisions: [
      mk(0, 22, 'researcher', 'job-8871', 'task_ceiling_exceeded', true, 40, 500, 492,
        { approved: false, reason: 'task_ceiling_exceeded', message: "Task 'job-8871' blocked: 492/500 units used, 8 remaining is not enough for this call.", task_ref: 'job-8871', task_remaining_units: 8 }),
      mk(0, 74, 'crawler', 'nightly-crawl', 'task_ceiling_exceeded', true, 200, 2000, 1840,
        { approved: false, reason: 'task_ceiling_exceeded', message: "Task 'nightly-crawl' blocked: 1840/2000 units used, 160 remaining is not enough for this call.", task_ref: 'nightly-crawl', task_remaining_units: 160 }),
      mk(0, 190, 'enricher', 'batch-2211', 'task_ceiling_exceeded', true, 25, 1000, 1000,
        { approved: false, reason: 'task_ceiling_exceeded', message: "Task 'batch-2211' blocked: 1000/1000 units used, 0 remaining is not enough for this call.", task_ref: 'batch-2211', task_remaining_units: 0 }),
      mk(1, 30, 'summarizer', null, 'ceiling_exceeded', true, 120, 50, null,
        { approved: false, reason: 'ceiling_exceeded', message: 'Estimated 120 units exceeds the per-request ceiling of 50.' }),
      mk(1, 410, 'researcher', 'job-8864', 'budget_exhausted', true, 60, null, 1000,
        { approved: false, reason: 'budget_exhausted', message: 'Customer cust_initech has 0 units remaining.' }),
      mk(2, 95, 'crawler', 'nightly-crawl', 'task_overrun_recorded', false, 310, 2000, 2150,
        { recorded: true, task_ref: 'nightly-crawl', task_used_units: 2150, task_remaining_units: 0, note: 'recorded past the ceiling: preflight was skipped for this call' }),
    ],
    truncated: false,
  }
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

function rel(iso: string | Date | null): string {
  if (!iso) return '<span class="none">never</span>'
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  if (mins < 0) return 'in ' + relFuture(-mins)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 2880) return `${Math.round(mins / 60)}h ago`
  return `${Math.round(mins / 1440)}d ago`
}

function relFuture(mins: number): string {
  if (mins < 60) return `${mins}m`
  if (mins < 2880) return `${Math.round(mins / 60)}h`
  return `${Math.round(mins / 1440)}d`
}

function num(n: number): string {
  return n.toLocaleString('en-US')
}

const REASON_LABEL: Record<string, string> = {
  ceiling_exceeded: 'ceiling',
  task_ceiling_exceeded: 'task ceiling',
  budget_exhausted: 'budget',
  free_tier_exceeded: 'free tier',
  plan_limit_exceeded: 'plan limit',
  task_overrun_recorded: 'got through',
}

// The console keeps its own nav: it is an authenticated surface with an account
// bar, not a marketing page, so it takes neither siteNav nor siteFooter. It does
// take the shared tokens, which is what the fragmentation finding was about.
const CSS = `
  /* Colour semantics for this page, and why they had to be written down.
     Red used to mark a blocked call in the chart, a task that hit its ceiling
     and a customer at their limit, all three of which are the product doing
     exactly its job, and also a plan bar at 100%, which is a real problem.
     Green was simultaneously the brand, "metered", "OK", "RUNNING" and
     "ACTIVE". A colour that means two things means nothing, so each gets one
     job and nothing else is allowed to borrow it:

       --flow  ordinary traffic. Metered units, a running task, a live key.
               Nothing happened. Not an achievement and not a warning, so it
               stays out of the way and lets the other three be visible.
       --held  AgentBill stopped something. A blocked call, a ceiling that
               held, a customer limit that bit. This is what the product is
               for, so it carries the accent instead of an alarm.
       --near  approaching a limit. Worth a glance; nothing is wrong yet.
       --fail  needs a human. Spend that got past a ceiling, or an account
               about to stop working. Nothing else on this page is red. */
  :root {
    --shell: 1080px;
    --held: var(--green); --near: var(--amber); --fail: var(--red);
  }

  body { font-size: 15px; line-height: 1.55; }
  /* Scoped to .top on purpose. This was a bare \`nav\` type selector, and the
     jump rail below is also a <nav>, so it inherited height:60px and its
     second row overflowed the fixed box and printed on top of the plan
     block. Same collision as the two dead rules on the homepage: a type
     selector reaching a class it was never meant to touch. */
  nav.top { height: 60px; border-bottom: 1px solid var(--border); display: flex; align-items: center;
        justify-content: space-between; padding: 0 24px; gap: 16px; }
  .logo { display: flex; align-items: center; gap: 9px; font-family: var(--mono);
          font-weight: 700; font-size: 16px; color: var(--text); text-decoration: none; }
${MARK_CSS}
  .who { display: flex; align-items: center; gap: 14px; font-family: var(--mono);
         font-size: 12px; color: var(--dim); white-space: nowrap; }
  .who b { color: var(--muted); font-weight: 500; }
  .btn-out { background: none; border: 1px solid var(--border-strong); color: var(--muted); border-radius: 8px;
             padding: 0 12px; font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap;
             min-height: 44px; display: inline-flex; align-items: center; }
  .btn-out:hover { color: var(--text); border-color: var(--dim); }
  /* The signed-out sample console's only CTA. Filled, not ghosted: this is the
     one action a prospect on this page is meant to take. */
  .btn-key { display: inline-flex; align-items: center; background: var(--green); color: var(--green-ink);
             border-radius: 8px; padding: 0 14px; font-size: 12px; font-weight: 700;
             text-decoration: none; white-space: nowrap; min-height: 44px; }
  .btn-key:hover { color: var(--green-ink); filter: brightness(1.08); }
  .wrap { max-width: var(--shell); margin: 0 auto; padding: 32px 24px 80px; }
  h1 { font-family: var(--display); font-size: 28px; font-weight: 700;
       letter-spacing: -.022em; margin-bottom: 6px; }
  .sub { color: var(--muted); max-width: 70ch; margin-bottom: 20px; }

  /* A contents rail, not tabs. These were styled as tabs with "Activity"
     carrying a selected underline, which promised a filter the page never
     applied: every section renders regardless, so clicking one only scrolls.
     A selected state the UI does not honour is a lie, and on a phone the tab
     row wrapped into two ragged lines. Now it reads as the jump list it is. */
  .jump { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 18px;
          margin: 0 0 26px; padding-bottom: 10px; border-bottom: 1px solid var(--border); }
  .jump b { font-family: var(--mono); font-size: 10.5px; font-weight: 500;
            letter-spacing: .12em; text-transform: uppercase; color: var(--dim); }
  .jump a { font-family: var(--mono); font-size: 12.5px; color: var(--muted);
            text-decoration: none; padding: 11px 0; white-space: nowrap; }
  .jump a:hover { color: var(--text); text-decoration: underline; text-underline-offset: 3px; }
  .jump .spacer { flex: 1 1 auto; }

  .rangebar { display: flex; align-items: center; justify-content: space-between; gap: 14px;
              flex-wrap: wrap; margin: 14px 0 12px; }
  .rangenote { font-family: var(--mono); font-size: 12px; color: var(--dim); }

  /* segmented range control */
  .seg { display: inline-flex; border: 1px solid var(--border-strong); border-radius: 7px;
         overflow: hidden; background: var(--surface); }
  .seg a { font-family: var(--mono); font-size: 11.5px; color: var(--dim);
           text-decoration: none; padding: 6px 12px; border-right: 1px solid var(--border);
           white-space: nowrap; }
  .seg a:last-child { border-right: none; }
  .seg a:hover { color: var(--text); background: var(--surface2); }
  .seg a.on { color: var(--green-ink); background: var(--green); font-weight: 700; }

  /* delta */
  .dl { font-family: var(--mono); font-size: 11px; margin-top: 5px;
        line-height: 1.45; }
  .dl.up { color: var(--green); } .dl.down { color: var(--amber); } .dl.flat { color: var(--dim); }

  /* status dot */
  .dotm { width: 7px; height: 7px; border-radius: 50%; display: inline-block;
          margin-right: 7px; vertical-align: 1px; }

  /* quota */
  .quota { background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
           padding: 16px 18px; margin-bottom: 14px; }
  .quota-top { display: flex; align-items: baseline; justify-content: space-between; gap: 14px;
               flex-wrap: wrap; font-family: var(--mono); font-size: 12.5px;
               color: var(--dim); font-variant-numeric: tabular-nums; }
  .quota-top b { color: var(--text); font-weight: 700; text-transform: uppercase; letter-spacing: .08em; }
  /* The one bar on this page that is about the account rather than the
     product. Running out of plan means calls stop being metered, which needs
     a human, so this is where --fail legitimately lives. */
  .meter { height: 8px; background: var(--surface3); border-radius: 999px; margin-top: 12px; overflow: hidden; }
  .meter i { display: block; height: 100%; border-radius: 999px; background: var(--flow); }
  .meter i.near { background: var(--near); } .meter i.fail { background: var(--fail); }

  /* tiles */
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(168px, 1fr)); gap: 12px;
           margin-bottom: 10px; }
  .tile { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 15px 17px; }
  .tl { font-family: var(--mono); font-size: 10.5px; letter-spacing: .12em;
        text-transform: uppercase; color: var(--dim); }
  .tv { font-family: var(--mono); font-size: 26px; font-weight: 700; margin-top: 6px;
        font-variant-numeric: tabular-nums; line-height: 1.15; }
  .tv.held { color: var(--held); }
  .tv.dim { color: var(--muted); font-size: 17px; margin-top: 13px; }
  .tf { font-family: var(--mono); font-size: 11px; color: var(--dim); margin-top: 4px; }
  .honest { font-size: 12.5px; color: var(--dim); margin-bottom: 8px; max-width: 86ch; line-height: 1.6; }

  /* Leaked spend is not a peer of the four tiles above it. It is the only
     number here whose good value is zero, and it used to sit in the grid
     styled exactly like the four where bigger is better, needing three lines
     of grey prose underneath to explain that. Its own row, with the
     explanation attached to it instead of to the whole tile block. */
  .leaked { display: flex; align-items: flex-start; gap: 16px; margin: 12px 0 8px;
            background: var(--surface); border: 1px solid var(--border);
            border-radius: 12px; padding: 14px 18px; }
  .leaked-n { font-family: var(--mono); font-size: 26px; font-weight: 700;
              line-height: 1.15; font-variant-numeric: tabular-nums; color: var(--flow-ink); }
  .leaked-t b { display: block; font-family: var(--mono); font-size: 10.5px;
                letter-spacing: .12em; text-transform: uppercase; color: var(--dim); font-weight: 500; }
  .leaked-t p { font-size: 12.5px; color: var(--dim); margin: 5px 0 0; max-width: 78ch; line-height: 1.6; }
  .leaked.bad { border-color: var(--fail-line); }
  .leaked.bad .leaked-n { color: var(--fail); }
  .leaked.bad .leaked-t b { color: var(--fail); }

  h2 { font-family: var(--mono); font-size: 12px; font-weight: 700; letter-spacing: .1em;
       text-transform: uppercase; color: var(--muted); margin: 40px 0 6px; padding-bottom: 8px;
       border-bottom: 1px solid var(--border); display: flex; justify-content: space-between;
       align-items: baseline; gap: 12px; }
  h2 span { color: var(--dim); font-weight: 400; letter-spacing: .04em; text-transform: none; font-size: 11.5px; }
  .lede { font-size: 13px; color: var(--dim); margin: 10px 0 14px; max-width: 82ch; line-height: 1.6; }

  /* chart */
  .chart { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 18px; }
  .plot { position: relative; padding-left: 46px; }
  .grid { position: absolute; inset: 0 0 0 46px; display: flex; flex-direction: column;
          justify-content: space-between; pointer-events: none; }
  .grid span { border-top: 1px dashed var(--border-soft); height: 0; }
  .ylab, .blab { position: absolute; left: 0; top: -7px; width: 40px; text-align: right;
          font-family: var(--mono); font-size: 10px; color: var(--dim);
          font-variant-numeric: tabular-nums; }
  .ylab.mid { top: calc(50% - 7px); } .ylab.low { top: auto; bottom: -7px; }
  .bars { display: flex; align-items: flex-end; gap: 3px; height: 148px; position: relative; }
  .col { flex: 1 1 0; display: flex; flex-direction: column; justify-content: flex-end;
         height: 100%; min-width: 0; border-radius: 3px 3px 0 0; overflow: hidden; }
  /* Metered units are the ground here, not the story: they are just traffic.
     The blocks are what the customer is paying for, so they are the segment
     that gets the accent. Red on this chart used to mean "the product
     worked", which is the exact inversion this page was making everywhere. */
  .col i { display: block; width: 100%; }
  .col i.met { background: var(--flow); }
  .col i.held { background: var(--held); }
  .col i.zero { background: var(--surface3); height: 2px; }
  .xaxis { display: flex; justify-content: space-between; margin: 9px 0 0 46px;
           font-family: var(--mono); font-size: 10.5px; color: var(--dim); }
  /* Blocks on their own strip, same left offset and same gap as the plot above
     so a column still lines up with its day. Its own maximum is labelled at the
     left, because this strip does not obey the axis above it. */
  .bstrip { position: relative; padding-left: 46px; margin-top: 10px;
            border-top: 1px solid var(--border-soft); padding-top: 8px; }
  .blab { top: calc(50% - 1px); }
  .bbars { display: flex; align-items: flex-end; gap: 3px; height: 26px; }
  .legend { display: flex; gap: 16px; margin-top: 12px; font-family: var(--mono);
            font-size: 11px; color: var(--dim); flex-wrap: wrap; }
  .legend span { display: flex; align-items: center; gap: 6px; }
  .sw { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }
  .sw.met { background: var(--flow); } .sw.held { background: var(--held); }

  /* burn-down rows */
  .burn { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; }
  .brow { padding: 14px 18px; border-bottom: 1px solid var(--border); }
  .brow:last-child { border-bottom: none; }
  .bhead { display: flex; justify-content: space-between; align-items: baseline; gap: 12px;
           flex-wrap: wrap; margin-bottom: 9px; }
  .btask { font-family: var(--mono); font-size: 13.5px; color: var(--text);
           overflow: hidden; text-overflow: ellipsis; }
  .bagent { color: var(--dim); font-size: 12px; }
  .bnum { font-family: var(--mono); font-size: 12.5px; color: var(--muted);
          font-variant-numeric: tabular-nums; white-space: nowrap; }
  .bnum b { color: var(--text); font-weight: 700; }
  .track { height: 10px; background: var(--surface3); border-radius: 999px; overflow: hidden; display: flex; }
  .track i { display: block; height: 100%; }
  .track i.used { background: var(--flow); }
  .track i.used.near { background: var(--near); }
  .track i.used.held { background: var(--held); }
  .track i.res { background: var(--res); }
  .bfoot { margin-top: 7px; font-family: var(--mono); font-size: 11px; color: var(--dim);
           display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }

  /* tables */
  .tw { overflow-x: auto; border: 1px solid var(--border); border-radius: 12px; background: var(--surface);
        -webkit-overflow-scrolling: touch; }
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th { text-align: left; padding: 10px 14px; color: var(--dim); font-weight: 500; font-size: 11px;
       text-transform: uppercase; letter-spacing: .08em; border-bottom: 1px solid var(--border);
       white-space: nowrap; font-family: var(--mono); }
  td { padding: 11px 14px; border-bottom: 1px solid var(--border); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  td.num { font-family: var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.id { font-family: var(--mono); font-size: 12.5px; white-space: nowrap; max-width: 260px;
          overflow: hidden; text-overflow: ellipsis; }
  .chip { display: inline-block; font-family: var(--mono); font-size: 10.5px; font-weight: 700;
          letter-spacing: .06em; text-transform: uppercase; padding: 3px 8px; border-radius: 4px; white-space: nowrap; }
  .chip.held { background: var(--held-bg); color: var(--green); border: 1px solid var(--held-line); }
  .chip.near { background: var(--near-bg); color: var(--amber); border: 1px solid var(--near-line); }
  .chip.fail { background: var(--fail-bg); color: var(--fail-ink); border: 1px solid var(--fail-line); }
  .chip.flow { background: var(--surface3); color: var(--flow-ink); border: 1px solid var(--border2); }
  .chip.dead { background: var(--surface3); color: var(--dim); border: 1px solid var(--border2); }
  .minibar { height: 6px; width: 92px; background: var(--surface3); border-radius: 999px; overflow: hidden;
             display: inline-block; vertical-align: middle; margin-right: 9px; }
  .minibar i { display: block; height: 100%; background: var(--flow); }
  .minibar i.near { background: var(--near); } .minibar i.held { background: var(--held); }
  .muted { color: var(--muted); } .dim { color: var(--dim); } .none { color: var(--dim); font-style: italic; }
  details summary { cursor: pointer; color: var(--green); font-family: var(--mono);
                    font-size: 12px; list-style: none; padding: 4px 0; }
  details summary::-webkit-details-marker { display: none; }
  details summary::before { content: '\\25B8  '; } details[open] summary::before { content: '\\25BE  '; }
  pre { background: var(--bg-deep); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px;
        font-family: var(--mono); font-size: 12.5px; line-height: 1.55; overflow-x: auto;
        color: var(--code-ink); margin-top: 10px; }

  /* empty + banners */
  .empty { background: var(--surface); border: 1px dashed var(--border2); border-radius: 12px; padding: 26px; margin-top: 16px; }
  .empty h3 { font-family: var(--mono); font-size: 16px; margin-bottom: 8px; }
  .empty p { color: var(--muted); margin-bottom: 14px; max-width: 70ch; }
  .empty pre { margin: 0 0 14px; white-space: pre-wrap; word-break: break-all; }
  .empty details { margin-top: 6px; }
  .banner { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
            background: var(--near-bg); border: 1px solid var(--near-line); border-radius: 12px;
            padding: 12px 16px; margin-bottom: 18px; }
  .banner b { font-family: var(--mono); font-size: 11px; letter-spacing: .1em;
              text-transform: uppercase; color: var(--amber); }
  .banner p { font-size: 13px; color: var(--near-ink); margin: 0; }
  .banner a { color: var(--amber); }
  .nothing { padding: 22px 18px; color: var(--dim); font-size: 13.5px; }
  .foot { margin-top: 44px; padding-top: 18px; border-top: 1px solid var(--border); color: var(--dim);
          font-size: 13px; line-height: 1.7; }
  .foot code { font-family: var(--mono); font-size: 12px; color: var(--muted); }

  /* login */
  .login { max-width: 460px; margin: 80px auto; background: var(--surface); border: 1px solid var(--border);
           border-radius: 12px; padding: 32px; }
  .login h1 { font-size: 22px; }
  .login p { color: var(--muted); font-size: 14px; margin-bottom: 18px; }
  label { display: block; font-family: var(--mono); font-size: 11px; letter-spacing: .1em;
          text-transform: uppercase; color: var(--dim); margin-bottom: 8px; }
  input { width: 100%; background: var(--bg); border: 1px solid var(--border-strong); border-radius: 8px;
          padding: 12px; color: var(--text); font-family: var(--mono); font-size: 14px;
          margin-bottom: 14px; outline: 2px solid transparent; outline-offset: 2px; min-height: 46px; }
  .btn { width: 100%; background: var(--green); color: var(--green-ink); border: none; border-radius: 8px;
         padding: 13px; font: inherit; font-size: 15px; font-weight: 700; cursor: pointer; min-height: 46px; }
  .btn:hover { filter: brightness(1.08); }
  .err { color: var(--red); font-size: 13px; margin-bottom: 12px; }
  .fine { font-size: 12.5px; color: var(--dim); margin-top: 16px; }
  a:focus-visible, button:focus-visible, input:focus-visible, summary:focus-visible {
    outline: 2px solid var(--green); outline-offset: 2px; }

  @media (max-width: 720px) {
    nav.top { padding: 0 16px; } .wrap { padding: 22px 16px 60px; }
    /* Both of these are said better a few pixels lower: the email is not
       needed to use the page, and the SAMPLE DATA banner announces the mode
       far louder than a grey label next to the wordmark. Dropping them is
       what keeps the CTA from being pushed off the right edge. */
    /* .who is nowrap now, so anything that does not fit has to be dropped
       rather than left to wrap. The key tail stays: it is the one thing that
       says which key this console is showing. */
    .who span.email, .who span.mode, .who span.lbl { display: none; }
    .bars { height: 112px; }
    /* One scrolling row beats three wrapped ones for a rail this long. */
    .jump { flex-wrap: nowrap; overflow-x: auto; gap: 0 16px;
            -webkit-overflow-scrolling: touch; scrollbar-width: none; }
    .jump::-webkit-scrollbar { display: none; }
    .jump b { flex: none; }
  }
`

const HEAD = (title: string) => head({
  title: `${esc(title)} · AgentBill`,
  description: 'Your AgentBill console: refusals, task budgets, keys and usage for one API key.',
  // noindex comes from the registry (index: false), which is the same entry
  // robots.txt reads, so the two cannot disagree about this page.
  path: '/app',
  css: CSS,
})

const ERRORS: Record<string, string> = {
  key: 'That key was not found. It starts with agb_ and comes from /register.',
  revoked: 'That key has been revoked. Generate a new one with POST /keys/generate.',
  expired: 'That key has expired. Generate a new one with POST /keys/generate.',
  rate: 'Too many attempts from this address. Try again in 15 minutes.',
  unavailable: 'Sign-in is not configured on this server.',
}

function loginPage(err: string): string {
  return `${HEAD('Console')}
<body>
  <nav class="top" aria-label="Account"><a class="logo" href="/">${mark(18)}AgentBill</a></nav>
  <div class="login">
    <h1>Your console</h1>
    <p>Live task budgets, every call AgentBill refused on your behalf, and the exact response your agent got. Paste the API key from <a href="/register">/register</a>.</p>
    ${Object.hasOwn(ERRORS, err) ? `<p class="err">${esc(ERRORS[err])}</p>` : ''}
    <form method="POST" action="/app/session" autocomplete="off">
      <label for="api_key">API key</label>
      <input id="api_key" name="api_key" type="password" placeholder="agb_..." autofocus required />
      <button class="btn" type="submit">Open console &rarr;</button>
    </form>
    <p class="fine">The key is exchanged for an HttpOnly cookie that lasts 7 days and dies with the key. This page loads no third-party scripts.</p>
  </div>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Fragments
// ---------------------------------------------------------------------------

// A count with no direction is trivia. Against the same window immediately
// before it, it is a signal. "New" is the honest word when there is no prior
// period to compare against, rather than a fake +100%.
function delta(now: number, prev: number, label: string): string {
  const short = label.replace(' days', 'd').replace(' day', 'd')
  if (now === 0 && prev === 0) return `<div class="tf">none in ${esc(short)}</div>`
  if (prev === 0) return `<div class="dl up" title="No blocks in the previous ${esc(label)}">&uarr; first ${esc(short)} with blocks</div>`
  const pct = Math.round(((now - prev) / prev) * 100)
  if (pct === 0) return `<div class="dl flat" title="Same as the previous ${esc(label)}">&rarr; flat vs prior ${esc(short)}</div>`
  const cls = pct > 0 ? 'up' : 'down'
  const arrow = pct > 0 ? '&uarr;' : '&darr;'
  return `<div class="dl ${cls}" title="Against the ${esc(label)} immediately before this window">${arrow} ${Math.abs(pct)}% vs prior ${esc(short)}</div>`
}

function quotaBlock(v: Viewer): string {
  const limit = v.plan === 'paid' ? null : PLAN_LIMITS[v.plan] ?? PLAN_LIMITS.free
  if (limit === null) {
    return `<div class="quota"><div class="quota-top"><span><b>${esc(v.plan)}</b></span>
      <span>${num(v.monthlyCalls)} calls this month · metered, no included cap</span></div></div>`
  }
  const pct = Math.min(100, Math.round((v.monthlyCalls / limit) * 100))
  const cls = pct >= 90 ? 'fail' : pct >= 75 ? 'near' : ''
  const upsell = pct >= 75
    ? ` · <a href="/pricing?account_id=${encodeURIComponent(v.accountId)}">raise the ceiling</a>`
    : ''
  return `<div class="quota">
    <div class="quota-top">
      <span><b>${esc(v.plan)}</b> plan</span>
      <span>${num(v.monthlyCalls)} / ${num(limit)} calls this month · ${pct}%${upsell}</span>
    </div>
    <div class="meter"><i class="${cls}" style="width:${pct}%"></i></div>
  </div>`
}

// 30-day column chart. Approved metered units and blocks stack in one column
// so the two sit on the same axis: the green is what ran, the red is what did
// not. Pure CSS, no script, because this page renders a live API key and runs
// under default-src 'none'.
function chartBlock(series: Series[]): string {
  const unitMax = Math.max(1, ...series.map((s) => Number(s.units)))
  const blockMax = Math.max(1, ...series.map((s) => Number(s.blocks)))
  // Blocks are rarer than units by orders of magnitude, so the two cannot share
  // one axis. They used to be stacked in the same column on two different
  // scales, while the units segment was capped at 55% of a plot whose top
  // gridline was labelled unitMax: reading any bar against the axis gave a
  // number roughly half the truth. Units now use the full plot, so the labelled
  // axis is true for exactly one series, and blocks get their own strip below
  // the x-axis carrying its own maximum.
  const cols = series.map((s) => {
    const units = Number(s.units)
    const uh = units > 0 ? Math.max(2, Math.round((units / unitMax) * 100)) : 0
    const label = `${s.day}: ${num(units)} units metered`
    const inner = uh === 0 ? '<i class="zero"></i>' : `<i class="met" style="height:${uh}%"></i>`
    return `<div class="col" title="${esc(label)}">${inner}</div>`
  }).join('')
  const bcols = series.map((s) => {
    const blocks = Number(s.blocks)
    const bh = blocks > 0 ? Math.max(3, Math.round((blocks / blockMax) * 100)) : 0
    const label = `${s.day}: ${num(blocks)} blocked before they ran`
    const inner = bh === 0 ? '<i class="zero"></i>' : `<i class="held" style="height:${bh}%"></i>`
    return `<div class="col" title="${esc(label)}">${inner}</div>`
  }).join('')
  const first = series[0]?.day ?? ''
  const last = series[series.length - 1]?.day ?? ''
  const mid = series[Math.floor(series.length / 2)]?.day ?? ''
  return `<div class="chart">
    <div class="plot">
      <div class="grid"><span></span><span></span><span></span></div>
      <div class="ylab">${num(unitMax)}</div>
      <div class="ylab mid">${num(Math.round(unitMax / 2))}</div>
      <div class="ylab low">0</div>
      <div class="bars">${cols}</div>
    </div>
    <div class="xaxis"><span>${esc(first)}</span><span>${esc(mid)}</span><span>${esc(last)}</span></div>
    <div class="bstrip">
      <div class="blab">${num(blockMax)}</div>
      <div class="bbars">${bcols}</div>
    </div>
    <div class="legend">
      <span><i class="sw met"></i> units metered, against the axis above</span>
      <span><i class="sw held"></i> blocked before they ran, own strip, peak ${num(blockMax)}</span>
      <span class="dim">hover a column for that day</span>
    </div>
  </div>`
}

function tasksBlock(tasks: TaskRow[]): string {
  if (tasks.length === 0) {
    return `<div class="burn"><p class="nothing">No task budgets yet. Pass <code class="mono">task_ref</code> and <code class="mono">task_ceiling</code> on a preflight call and the job shows up here, burning down live.</p></div>`
  }
  const rows = tasks.map((t) => {
    const ceiling = Number(t.ceilingUnits)
    const used = Number(t.usedUnits)
    const reserved = Number(t.reservedUnits)
    const remaining = Math.max(0, ceiling - used - reserved)
    const usedPct = Math.min(100, (used / ceiling) * 100)
    const resPct = Math.min(100 - usedPct, (reserved / ceiling) * 100)
    const ratio = (used + reserved) / ceiling
    const cls = ratio >= 1 ? 'held' : ratio >= 0.8 ? 'near' : ''
    const state = used >= ceiling
      ? '<span class="chip held">ceiling hit</span>'
      : ratio >= 0.8 ? '<span class="chip near">close</span>' : '<span class="chip flow">running</span>'
    return `<div class="brow">
      <div class="bhead">
        <div class="btask">${esc(t.taskRef)} <span class="bagent">· ${esc(t.agentId)}</span></div>
        <div class="bnum"><b>${num(used)}</b> / ${num(ceiling)} units ${state}</div>
      </div>
      <div class="track">
        <i class="used ${cls}" style="width:${usedPct.toFixed(1)}%"></i>
        <i class="res" style="width:${resPct.toFixed(1)}%"></i>
      </div>
      <div class="bfoot">
        <span>${num(remaining)} left${reserved > 0 ? ` · ${num(reserved)} reserved in flight` : ''}</span>
        <span>${rel(t.updatedAt)}</span>
      </div>
    </div>`
  }).join('')
  return `<div class="burn">${rows}</div>`
}

function customersBlock(rows: CustomerRow[]): string {
  if (rows.length === 0) {
    return `<div class="tw"><p class="nothing">No customers yet. Pass <code class="mono">customer_id</code> on a preflight or record call and each of your end users gets an independent balance here.</p></div>`
  }
  const body = rows.map((c) => {
    const used = Number(c.usedUnits)
    const limit = c.limitUnits == null ? null : Number(c.limitUnits)
    const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0
    const cls = pct >= 100 ? 'held' : pct >= 80 ? 'near' : ''
    const bar = limit
      ? `<span class="minibar"><i class="${cls}" style="width:${pct}%"></i></span>${pct}%`
      : '<span class="dim">unlimited</span>'
    // A customer at their limit is a limit that held, not an incident.
    const status = limit && used >= limit
      ? '<span class="chip held">blocked</span>'
      : '<span class="chip flow">ok</span>'
    return `<tr>
      <td class="id" title="${esc(c.customerRef)}">${esc(c.customerRef)}</td>
      <td class="num">${bar}</td>
      <td class="num">${num(used)}</td>
      <td class="num">${limit == null ? '<span class="dim">&infin;</span>' : num(limit)}</td>
      <td class="num">${limit == null ? '<span class="dim">&infin;</span>' : num(Math.max(0, limit - used))}</td>
      <td>${status}</td>
    </tr>`
  }).join('')
  return `<div class="tw"><table>
    <thead><tr><th>Customer</th><th>Usage</th><th>Used</th><th>Limit</th><th>Remaining</th><th>Status</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>`
}

function keysBlock(rows: KeyRow[]): string {
  if (rows.length === 0) return `<div class="tw"><p class="nothing">No keys on this account.</p></div>`
  const now = Date.now()
  const body = rows.map((k) => {
    const mask = k.apiKey.slice(0, 8) + '…' + k.apiKey.slice(-4)
    const revoked = k.revokedAt ? new Date(k.revokedAt).getTime() : null
    const expires = k.expiresAt ? new Date(k.expiresAt).getTime() : null
    // A working key is not an achievement, so it stays neutral. Green here
    // would be a third meaning for the accent.
    let chip = '<span class="chip flow">active</span>'
    if (revoked !== null && revoked <= now) chip = '<span class="chip dead">revoked</span>'
    else if (revoked !== null) chip = '<span class="chip near">rotating</span>'
    else if (expires !== null && expires <= now) chip = '<span class="chip dead">expired</span>'
    else if (expires !== null && expires - now < 86_400_000) chip = '<span class="chip near">expiring</span>'
    return `<tr>
      <td class="id">${esc(mask)}</td>
      <td>${k.label ? esc(k.label) : '<span class="none">no label</span>'}</td>
      <td>${chip}</td>
      <td class="num dim">${rel(k.createdAt)}</td>
      <td class="num dim">${k.expiresAt ? rel(k.expiresAt) : '<span class="none">never</span>'}</td>
      <td class="num dim">${k.lastSeenIp ? esc(k.lastSeenIp) : '<span class="none">unused</span>'}</td>
    </tr>`
  }).join('')
  return `<div class="tw"><table>
    <thead><tr><th>Key</th><th>Label</th><th>Status</th><th>Created</th><th>Expires</th><th>Last seen from</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>`
}

function decisionsBlock(rows: DecisionRow[], truncated: boolean): string {
  if (rows.length === 0) {
    return `<div class="tw"><p class="nothing">Nothing refused yet. Every block AgentBill makes lands here with the literal JSON your agent received.</p></div>`
  }
  const body = rows.map((r) => {
    const leak = r.blocked === false
    const label = REASON_LABEL[r.reason] ?? r.reason
    let pretty = r.snapshot
    try { pretty = JSON.stringify(JSON.parse(r.snapshot), null, 2) } catch { /* leave verbatim */ }
    const when = new Date(r.createdAt)
    return `<tr>
      <td class="num dim" title="${esc(when.toISOString())}">${rel(when)}</td>
      <td><span class="chip ${leak ? 'fail' : 'held'}" title="${esc(r.reason)}">${esc(label)}</span></td>
      <td class="id" title="${esc(r.agentId ?? '')}">${r.agentId ? esc(r.agentId) : '<span class="none">none</span>'}</td>
      <td class="id" title="${esc(r.taskRef ?? '')}">${r.taskRef ? esc(r.taskRef) : '<span class="none">none</span>'}</td>
      <td class="num">${r.estimatedUnits == null ? '<span class="dim">-</span>' : num(Number(r.estimatedUnits))}
        <span class="dim">/</span> ${r.ceilingUnits == null ? '<span class="dim">-</span>' : num(Number(r.ceilingUnits))}
        <span class="dim">/</span> ${r.usedUnits == null ? '<span class="dim">-</span>' : num(Number(r.usedUnits))}</td>
      <td><details><summary>response</summary><pre>${esc(pretty)}</pre></details></td>
    </tr>`
  }).join('')
  return `<div class="tw"><table>
    <thead><tr><th>When</th><th>Why</th><th>Agent</th><th>Task</th><th>Asked / ceiling / used</th><th>What the agent got</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>
  ${truncated ? '<p class="honest" style="margin-top:8px">Showing the latest 100. The full list is on <code class="mono">GET /decisions</code>.</p>' : ''}`
}

// ---------------------------------------------------------------------------
// Console page
// ---------------------------------------------------------------------------

function consolePage(v: Viewer, d: Console, demo: boolean, range: string, anon = false): string {
  const keyTail = v.apiKey.slice(0, 8) + '…' + v.apiKey.slice(-4)
  const rangeLabel = RANGES[range]?.label ?? RANGES[DEFAULT_RANGE].label
  const blockedInRange = d.series.reduce((a, x) => a + Number(x.blocks), 0)
  const activeTasks = d.tasks.filter((t) => Number(t.usedUnits) < Number(t.ceilingUnits)).length
  const virgin = !demo && d.decisions.length === 0 && d.tasks.length === 0 &&
                 d.customers.length === 0 && d.meteredUnits === 0

  const curlBlock = `curl -s -X POST https://agentbill.dev/preflight -H "Authorization: Bearer ${v.apiKey}" -H "Content-Type: application/json" -d '{"agent_id":"first-run","estimated_units":5,"ceiling":1}'`
  const curlTask1 = `curl -s -X POST https://agentbill.dev/preflight -H "Authorization: Bearer ${v.apiKey}" -H "Content-Type: application/json" -d '{"agent_id":"researcher","task_ref":"job-1","task_ceiling":5,"estimated_units":3}'`
  const curlTask2 = `curl -s -X POST https://agentbill.dev/preflight -H "Authorization: Bearer ${v.apiKey}" -H "Content-Type: application/json" -d '{"agent_id":"researcher","task_ref":"job-1","estimated_units":3}'`

  const banner = demo
    ? `<div class="banner">
        <b>Sample data</b>
        <p>${anon
            ? 'Every number here is invented. This is what the console looks like once your agents are calling preflight. <a href="/register">Get an API key</a> and it fills with your own runs.'
            : 'Nothing on this page is from your account. It shows what the console looks like once your agents are calling preflight. <a href="/app">Back to your real console</a>.'}</p>
      </div>`
    : ''

  const onboarding = virgin ? `
    <div class="empty">
      <h3>Nothing here yet, and that is the honest state.</h3>
      <p>A block only happens when a call is checked first. This one asks for 5 units against a ceiling of 1, so it is refused before anything runs. Paste it in a terminal, then reload this page.</p>
      <pre>${esc(curlBlock)}</pre>
      <p>You should get back <span class="mono" style="color:var(--code)">{"approved":false,"reason":"ceiling_exceeded",…}</span> and a first line below.</p>
      <details>
        <summary>A real one: a job that dies at 5 units across calls</summary>
        <p style="margin-top:10px">The first call opens the task with its ceiling and reserves 3. The second asks for 3 more, 3 + 3 &gt; 5, and is refused. The ceiling holds across every call and tool that shares the task_ref.</p>
        <pre>${esc(curlTask1)}</pre>
        <pre>${esc(curlTask2)}</pre>
      </details>
      <p style="margin:16px 0 0"><a href="/app?demo=1">Show me the console with sample data &rarr;</a></p>
    </div>` : ''

  return `${HEAD('Console')}
<body>
  <nav class="top" aria-label="Account">
    <a class="logo" href="/">${mark(18)}AgentBill</a>
    <div class="who">${anon
      ? `<span class="dim mode">Sample console</span>
      <a class="btn-key" href="/register">${KEY_CTA}</a>`
      : `<span class="email">${esc(v.email ?? 'no email')}</span>
      <span>key <b>${esc(keyTail)}</b>${v.keyLabel ? ` <span class="dim lbl">(${esc(v.keyLabel)})</span>` : ''}</span>
      <form method="POST" action="/app/logout"><button class="btn-out" type="submit">Sign out</button></form>`}
    </div>
  </nav>
  <div class="wrap">
    <h1>Console</h1>
    <p class="sub">What your agents spent, what they were stopped from spending, and the exact response each blocked call got back.</p>
    ${banner}
    <nav class="jump" aria-label="Sections on this page">
      <b>Jump to</b>
      <a href="#activity">Activity</a>
      <a href="#tasks">Task budgets</a>
      <a href="#refusals">Refusals</a>
      <a href="#customers">Customers</a>
      <a href="#keys">API keys</a>
      <span class="spacer"></span>
      ${demo
        ? (anon ? '<a href="/register">Get your API key &rarr;</a>' : '<a href="/app">Your data</a>')
        : '<a href="/app?demo=1">Sample data</a>'}
    </nav>

    ${quotaBlock(v)}

    <div class="tiles">
      <div class="tile"><div class="tl">Blocked</div><div class="tv held">${num(blockedInRange)}</div>${delta(blockedInRange, d.prevBlocked, rangeLabel)}</div>
      <div class="tile"><div class="tl">Units refused</div><div class="tv">${num(d.refusedUnits)}</div><div class="tf">all time · units asked for, not dollars</div></div>
      <div class="tile"><div class="tl">Metered</div><div class="tv">${num(d.meteredUnits)}</div><div class="tf">units this month</div></div>
      <div class="tile"><div class="tl">Live tasks</div><div class="tv dim">${num(activeTasks)}</div><div class="tf">under a ceiling now</div></div>
    </div>
    <div class="leaked${d.overruns > 0 ? ' bad' : ''}">
      <div class="leaked-n">${num(d.overruns)}</div>
      <div class="leaked-t">
        <b>Leaked past a ceiling</b>
        <p>${d.overruns > 0
            ? 'Calls that ran after their task was already at its limit, because preflight was skipped or the estimate came in low. All time. This is the one number here that should be zero.'
            : 'Nothing has run past a ceiling. All time. This is the one number here that should stay at zero, and it has.'}</p>
      </div>
    </div>

    ${onboarding}

    <h2 id="activity">Activity <span>units metered against calls blocked</span></h2>
    <div class="rangebar">
      <span class="rangenote">Last ${esc(rangeLabel)}</span>
      <span class="seg">${Object.entries(RANGES).map(([k, r]) =>
        `<a class="${k === range ? 'on' : ''}" href="/app?${demo ? 'demo=1&amp;' : ''}range=${k}#activity">${esc(r.label)}</a>`).join('')}</span>
    </div>
    ${chartBlock(d.series)}

    <h2 id="tasks">Task budgets <span>one job, many calls, one ceiling</span></h2>
    <p class="lede">Each bar is a live job burning down its ceiling across every call and tool that shares its <code class="mono">task_ref</code>. Slate is spent, grey is reserved by a call in flight, amber means it is close. A bar that turns green is a ceiling that held: the next call was refused before it ran.</p>
    ${tasksBlock(d.tasks)}

    <h2 id="refusals">Refusals <span>newest first, with the literal response</span></h2>
    ${decisionsBlock(d.decisions, d.truncated)}

    <h2 id="customers">Customers <span>independent balance per end user</span></h2>
    ${customersBlock(d.customers)}

    <h2 id="keys">API keys <span>status, expiry, last address seen</span></h2>
    ${keysBlock(d.keys)}

    <div class="foot">
      Every number on this page is on the API too.
      <code>curl https://agentbill.dev/decisions -H "Authorization: Bearer &lt;your key&gt;"</code>
      for refusals, <code>/tasks</code> for budgets, <code>/customers</code> for balances, <code>/keys</code> for keys.
    </div>
  </div>
</body>
</html>`
}
