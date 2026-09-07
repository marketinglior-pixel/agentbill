import type { FastifyInstance, FastifyRequest } from 'fastify'
import { createHmac, timingSafeEqual } from 'crypto'
import { sql } from '../db/index.js'
import { PLAN_LIMITS } from '../integrations/polar.js'
import { clientIp } from '../lib/client-ip.js'
import { head, BP } from '../ui/theme.js'
import { publicRoute } from '../middleware/auth.js'
import { mark, MARK_CSS } from '../ui/mark.js'
import { KEY_CTA, KEY_CTA_SHORT } from '../ui/chrome.js'
import { isId } from '../lib/ids.js'
import { KEY_COMMANDS } from '../ui/panels.js'

// /app is the console: the only browser surface a registered user has. It is
// a workbench with a side rail and seven server-rendered views (overview,
// activity, task budgets, refusals, customers, keys, limits), each selected by
// ?view= so the rail's current item is a fact about the page and not a
// promise. Every number a view shows is derived from the data it loads; the
// period control scopes every figure that carries a window, and a figure that
// carries none says so in its own label.
//
// Its first job is still the empty state, because almost every account that
// reaches it has never made a call: a one-line curl that gets refused before
// anything runs, and ?demo=1 to see the same page with sample data.
//
// Auth is a pasted API key exchanged for an HttpOnly cookie bound to the key's
// id (not the key), signed with a secret derived from ADMIN_SECRET. Revoking
// or expiring the key kills the session on the next request. Nothing here
// updates last_seen_ip, so opening the console never trips the IP alert.
// This page loads no script at all: a live key is rendered into it, and the
// CSP below has no script-src. The chart's hover layer is CSS.

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
  /** The balance every new customer of this account is born with. NULL = no limit. */
  defaultBudgetUnits: number | null
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
    const view = typeof q?.view === 'string' && Object.hasOwn(VIEWS, q.view) ? (q.view as ViewKey) : DEFAULT_VIEW
    const filter = readFilter(q)
    const viewer = await loadSession(request)

    // The sample console is the only place a prospect can see what the product
    // actually produces, so it is public. Without a session it renders against
    // a stand-in viewer and swaps the account chrome for a signup CTA. This
    // check must stay ABOVE the login return: it used to sit below it, which
    // made ?demo=1 reachable only to people who had already signed up.
    if (!viewer) {
      if (demo) return reply.send(consolePage({ v: DEMO_VIEWER, d: demoConsole(filter, RANGES[range].days), demo: true, anon: true, range, view, filter }))
      return reply.send(loginPage(typeof q?.err === 'string' ? q.err : ''))
    }

    const data = demo ? demoConsole(filter, RANGES[range].days) : await loadConsole(viewer.accountId, RANGES[range].days, filter)
    return reply.send(consolePage({ v: viewer, d: data, demo, anon: false, range, view, filter }))
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
           a.id AS account_id, a.email, a.plan, a.monthly_calls, a.default_budget_units
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
    defaultBudgetUnits: row.defaultBudgetUnits == null ? null : Number(row.defaultBudgetUnits),
  }
}

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
    // request.host, not request.hostname. Fastify 5 split host into host,
    // hostname and port, and hostname now drops the port; v4's hostname kept
    // it. URL.host keeps a non-default port, so comparing it to the new
    // hostname can only match when the Origin carries no port, and every
    // non-443 origin started answering 403. Measured on this server: with
    // Origin: http://localhost:3603 and no Sec-Fetch-Site, hostname gave 403
    // and host gives 303. Production never showed it, because Host there is
    // agentbill.dev with no port. That is exactly why it had to be caught here
    // rather than after a deploy.
    try { return new URL(origin).host === request.host } catch { return false }
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
// Views, ranges, filters
// ---------------------------------------------------------------------------

const VIEWS = {
  overview:  { title: 'Overview',     lede: 'What ran, what was refused, and the one number that should be zero.' },
  activity:  { title: 'Activity',     lede: 'Units metered and calls refused, day by day.' },
  tasks:     { title: 'Task budgets', lede: 'One job, many calls, one ceiling. Every row is a task_ref burning down.' },
  refusals:  { title: 'Refusals',     lede: 'Every call refused on your behalf, and every one that ran past a ceiling, newest first, with the literal body the agent got.' },
  customers: { title: 'Customers',    lede: 'One balance per customer_id. Balances are lifetime, not a period.' },
  keys:      { title: 'API keys',     lede: 'Every key on this account, its state, and where it was last used from.' },
  limits:    { title: 'Limits',       lede: 'What refuses a call on this account, in the order preflight checks it.' },
} as const
type ViewKey = keyof typeof VIEWS
const DEFAULT_VIEW: ViewKey = 'overview'
/** The views whose figures carry a window, and therefore show the period control. */
const RANGED: ReadonlySet<ViewKey> = new Set<ViewKey>(['overview', 'activity', 'limits'])

const RANGES: Record<string, { days: number; label: string }> = {
  '7d':  { days: 7,  label: '7 days' },
  '30d': { days: 30, label: '30 days' },
  '90d': { days: 90, label: '90 days' },
}
const DEFAULT_RANGE = '30d'

/** Narrowing the refusals view. Both ids are opaque strings the caller chose. */
type Filter = { task?: string; agent?: string; only?: 'leaks' }

function readFilter(q: Record<string, unknown>): Filter {
  const f: Filter = {}
  // Postgres rejects a NUL in a text parameter, so a control character in an
  // id would turn a filtered view into a 500. Ids are opaque, not binary.
  // One predicate, in src/lib/ids.ts, shared with every route that takes an id.
  const id = (v: unknown) => (isId(v) ? v : undefined)
  const task = id(q?.task)
  const agent = id(q?.agent)
  if (task) f.task = task
  if (agent) f.agent = agent
  if (q?.only === 'leaks') f.only = 'leaks'
  return f
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

type Series = { day: string; blocks: number; units: number; refused: number }
type TaskRow = { taskRef: string; agentId: string; ceilingUnits: number; usedUnits: number; reservedUnits: number; updatedAt: Date }
type CustomerRow = { customerRef: string; limitUnits: number | null; usedUnits: number; reservedUnits: number }
type KeyRow = { apiKey: string; label: string | null; createdAt: Date; revokedAt: Date | null; expiresAt: Date | null; lastSeenIp: string | null }
type DecisionRow = { agentId: string | null; taskRef: string | null; reason: string; blocked: boolean; estimatedUnits: number | null; ceilingUnits: number | null; usedUnits: number | null; snapshot: string; createdAt: Date }

// Everything a page shows is here or derived from here. The in-period counts
// (blocked, units metered, units refused) are sums over `series`, so a tile and
// the chart beside it cannot disagree. `byReason` is the same window split by
// rule. `overruns` is all time, because a leak does not stop mattering when
// the window moves.
type Console = {
  /** Every decision on the account, unfiltered, so a filter on the refusals
   *  view narrows the table without narrowing the rail's count. */
  decisionTotal: number
  overruns: number
  lastBlock: Date | null
  prevBlocked: number
  series: Series[]
  byReason: Record<string, number>
  tasks: TaskRow[]
  /** Whole-account counts. The row arrays above are pages of 20; a number a
   *  page shows as a total has to come from here, never from an array length. */
  taskCount: number
  taskLive: number
  taskNear: number
  customers: CustomerRow[]
  customerCount: number
  customerWithLimit: number
  customerTotal: number
  keys: KeyRow[]
  decisions: DecisionRow[]
  /** Rows matching the current filter, across the whole account. */
  decisionMatched: number
  truncated: boolean
}

async function loadConsole(accountId: string, days: number, f: Filter): Promise<Console> {
  const [totals] = await sql`
    SELECT count(*)                                AS total,
           count(*) FILTER (WHERE NOT blocked)     AS overruns,
           max(created_at) FILTER (WHERE blocked)  AS last_block
    FROM preflight_decisions
    WHERE account_id = ${accountId}
  `
  // Same length of window, immediately before this one. A tile with no
  // direction is a number; with one it is a signal.
  const [prev] = await sql`
    SELECT count(*) FILTER (WHERE blocked) AS blocks
    FROM preflight_decisions
    WHERE account_id = ${accountId}
      AND created_at >= current_date - ${days * 2 - 1}::int
      AND created_at <  current_date - ${days - 1}::int
  `
  const series = await sql`
    SELECT to_char(d, 'YYYY-MM-DD') AS day,
           coalesce(b.blocks, 0)    AS blocks,
           coalesce(b.refused, 0)   AS refused,
           coalesce(e.units, 0)     AS units
    FROM generate_series(current_date - ${days - 1}::int, current_date, interval '1 day') d
    LEFT JOIN (
      SELECT created_at::date AS day, count(*) AS blocks, coalesce(sum(estimated_units), 0) AS refused
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
  const reasons = await sql`
    SELECT reason, count(*) AS n
    FROM preflight_decisions
    WHERE account_id = ${accountId} AND blocked AND created_at >= current_date - ${days - 1}::int
    GROUP BY reason
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
  const [ctotal] = await sql`
    SELECT count(*)                                         AS n,
           count(*) FILTER (WHERE limit_units IS NOT NULL)  AS with_limit,
           coalesce(sum(used_units), 0)                     AS total
    FROM customers WHERE account_id = ${accountId}
  `
  // near = live and at four fifths of the ceiling or more, settled plus in
  // flight: the same test taskRow() applies, in integers so it is exact, and
  // in bigint because the API accepts any positive int4 ceiling and int4 * 4
  // overflows above 536,870,911, which would turn this page into a 500.
  const [ttotal] = await sql`
    SELECT count(*)                                                        AS n,
           count(*) FILTER (WHERE used_units < ceiling_units)             AS live,
           count(*) FILTER (WHERE used_units < ceiling_units
                              AND (used_units + reserved_units)::bigint * 5 >= ceiling_units::bigint * 4) AS near
    FROM task_budgets WHERE account_id = ${accountId}
  `
  const [matched] = await sql`
    SELECT count(*) AS n
    FROM preflight_decisions
    WHERE account_id = ${accountId}
      ${f.task ? sql`AND task_ref = ${f.task}` : sql``}
      ${f.agent ? sql`AND agent_id = ${f.agent}` : sql``}
      ${f.only === 'leaks' ? sql`AND NOT blocked` : sql``}
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
      ${f.task ? sql`AND task_ref = ${f.task}` : sql``}
      ${f.agent ? sql`AND agent_id = ${f.agent}` : sql``}
      ${f.only === 'leaks' ? sql`AND NOT blocked` : sql``}
    ORDER BY created_at DESC, id DESC
    LIMIT 100
  `
  const byReason: Record<string, number> = {}
  for (const r of reasons) byReason[String(r.reason)] = Number(r.n)
  return {
    decisionTotal: Number(totals?.total ?? 0),
    overruns: Number(totals?.overruns ?? 0),
    lastBlock: (totals?.lastBlock as Date | null) ?? null,
    prevBlocked: Number(prev?.blocks ?? 0),
    series: (series as unknown as Series[]).map((s) => ({ day: s.day, blocks: Number(s.blocks), units: Number(s.units), refused: Number(s.refused) })),
    byReason,
    tasks: tasks as unknown as TaskRow[],
    taskCount: Number(ttotal?.n ?? 0),
    taskLive: Number(ttotal?.live ?? 0),
    taskNear: Number(ttotal?.near ?? 0),
    customers: customers as unknown as CustomerRow[],
    customerCount: Number(ctotal?.n ?? 0),
    customerWithLimit: Number(ctotal?.withLimit ?? 0),
    customerTotal: Number(ctotal?.total ?? 0),
    keys: keys as unknown as KeyRow[],
    decisions: decisions as unknown as DecisionRow[],
    decisionMatched: Number(matched?.n ?? 0),
    // From the count, not the page length: exactly 100 matching rows is a
    // complete list, and the page length alone called it "100 of 100".
    truncated: Number(matched?.n ?? 0) > decisions.length,
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
// that is out of room. The default balance matches the two sample customers
// that were born with it.
const DEMO_VIEWER: Viewer = {
  keyId: 'demo',
  apiKey: DEMO_KEY,
  keyLabel: DEMO_KEY_LABEL,
  accountId: 'demo',
  email: null,
  plan: 'builder',
  monthlyCalls: 12480,
  defaultBudgetUnits: 5000,
}

// The average ask on a refused sample call. One factor, applied per day, so the
// refused-units tile is the sum of the strip it sits beside.
const DEMO_AVG_ASK = 173

// Sample data for ?demo=1. Every surface that renders it is labelled, so a
// screenshot of this page carries the label with it. It is never mixed with
// real rows: demo mode replaces the account's data wholesale, it does not
// pad it.
// Exported so the homepage can render the same task and refusal rows this
// console shows under ?demo=1. Two pages that describe one sample account must
// read one source, or the numbers drift apart the first time either is edited.
export function demoConsole(f: Filter = {}, days = 30): Console {
  const day = (back: number) => new Date(Date.now() - back * 86_400_000)
  const iso = (back: number) => day(back).toISOString().slice(0, 10)
  const shape30 = [0,0,3,1,0,6,4,2,9,5,3,12,7,4,18,11,6,9,14,8,21,13,7,16,24,12,9,19,15,11]
  // The period control has to mean the same thing under sample data as it
  // does on a real account. Seven days is the tail of the thirty; ninety is
  // the thirty repeated, so the most recent day is identical in every window
  // and the tiles agree with the chart whichever one is chosen.
  const shape = days <= shape30.length
    ? shape30.slice(shape30.length - days)
    : Array.from({ length: days }, (_, i) => shape30[i % shape30.length])
  const series: Series[] = shape.map((n, i) => {
    // ~13% of calls refused. High enough to be worth paying for, low enough
    // to be a real account rather than a broken one.
    const blocks = n < 4 ? 0 : Math.round(n * 0.13)
    return { day: iso(shape.length - 1 - i), blocks, units: n * 40, refused: blocks * DEMO_AVG_ASK }
  })
  const blockedTotal = series.reduce((a, x) => a + x.blocks, 0)
  // The window's refusals split by rule. Derived from the same total the
  // tiles show, so the ladder on the limits view sums to the blocked tile.
  const byTask = Math.round(blockedTotal * 0.68)
  const byBudget = Math.round(blockedTotal * 0.2)
  const byReason = {
    task_ceiling_exceeded: byTask,
    budget_exhausted: byBudget,
    ceiling_exceeded: blockedTotal - byTask - byBudget,
  }
  const mk = (back: number, mins: number, agent: string, task: string | null, reason: string,
              blocked: boolean, est: number | null, ceil: number | null, used: number | null,
              snapshot: object): DecisionRow => ({
    agentId: agent, taskRef: task, reason, blocked,
    estimatedUnits: est, ceilingUnits: ceil, usedUnits: used,
    snapshot: JSON.stringify(snapshot),
    createdAt: new Date(Date.now() - back * 86_400_000 - mins * 60_000),
  })
  const all = [
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
  ]
  // The one leak: a record that landed on batch-2211 an hour ago with no
  // preflight, after the ceiling had refused it two hours earlier. Inserted
  // in time order so the list stays newest first, and the task row below
  // carries the same 1,025, so the overview, the task and the row agree.
  all.splice(1, 0, mk(0, 60, 'enricher', 'batch-2211', 'task_overrun_recorded', false, 25, 1000, 1025,
    { recorded: true, task_ref: 'batch-2211', task_used_units: 1025, task_remaining_units: 0, task_exceeded: true, note: 'recorded past the ceiling: preflight was skipped for this call' }))
  const decisions = all.filter((d) => (!f.task || d.taskRef === f.task) && (!f.agent || d.agentId === f.agent) && (f.only !== 'leaks' || !d.blocked))
  const customers: CustomerRow[] = [
    { customerRef: 'cust_acme',     limitUnits: 5000, usedUnits: 4820, reservedUnits: 0 },
    { customerRef: 'cust_globex',   limitUnits: 5000, usedUnits: 2140, reservedUnits: 30 },
    { customerRef: 'cust_initech',  limitUnits: 1000, usedUnits: 1000, reservedUnits: 0 },
    { customerRef: 'cust_umbrella', limitUnits: null, usedUnits: 9310, reservedUnits: 0 },
  ]
  const tasks: TaskRow[] = [
      { taskRef: 'job-8871', agentId: 'researcher',  ceilingUnits: 500,  usedUnits: 492, reservedUnits: 0,  updatedAt: new Date(Date.now() - 22 * 60_000) },
      { taskRef: 'job-8870', agentId: 'summarizer',  ceilingUnits: 200,  usedUnits: 96,  reservedUnits: 12, updatedAt: new Date(Date.now() - 3 * 3_600_000) },
      { taskRef: 'nightly-crawl', agentId: 'crawler', ceilingUnits: 2000, usedUnits: 1840, reservedUnits: 60, updatedAt: new Date(Date.now() - 5 * 3_600_000) },
      { taskRef: 'job-8864', agentId: 'researcher',  ceilingUnits: 500,  usedUnits: 118, reservedUnits: 0,  updatedAt: day(1) },
      { taskRef: 'batch-2211', agentId: 'enricher',  ceilingUnits: 1000, usedUnits: 1025, reservedUnits: 0, updatedAt: new Date(Date.now() - 60 * 60_000) },
  ]
  return {
    decisionTotal: all.length,
    overruns: all.filter((d) => !d.blocked).length,
    lastBlock: new Date(Date.now() - 22 * 60_000),
    // The equivalent window immediately before this one.
    prevBlocked: Math.round(blockedTotal * 0.78),
    series,
    byReason,
    tasks,
    taskCount: tasks.length,
    taskLive: tasks.filter((t) => t.usedUnits < t.ceilingUnits).length,
    taskNear: tasks.filter((t) => t.usedUnits < t.ceilingUnits && (t.usedUnits + t.reservedUnits) * 5 >= t.ceilingUnits * 4).length,
    customers,
    customerCount: customers.length,
    customerWithLimit: customers.filter((c) => c.limitUnits != null).length,
    customerTotal: customers.reduce((a, c) => a + c.usedUnits, 0),
    keys: [
      { apiKey: DEMO_KEY, label: DEMO_KEY_LABEL, createdAt: day(38), revokedAt: null, expiresAt: null, lastSeenIp: '203.0.113.42' },
      { apiKey: DEMO_KEY_CI, label: 'ci', createdAt: day(12), revokedAt: null, expiresAt: day(-9), lastSeenIp: '198.51.100.7' },
    ],
    decisions,
    decisionMatched: decisions.length,
    truncated: false,
  }
}


// ---------------------------------------------------------------------------
// HTML helpers
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

/** "Aug 8" from an ISO day. The chart's x-axis used to print 2026-08-08. */
function fmtDay(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/** The axis maximum rounded up to 1, 2, 4, 5 or 10 times a power of ten, so the
 *  half tick is a clean number too. 960 reads as 1,000 / 500 / 0. */
function niceMax(max: number): number {
  if (max <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(max))
  const f = max / p
  const n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 4 ? 4 : f <= 5 ? 5 : 10
  return n * p
}

const REASON_LABEL: Record<string, string> = {
  ceiling_exceeded: 'request ceiling',
  task_ceiling_exceeded: 'task ceiling',
  budget_exhausted: 'customer balance',
  free_tier_exceeded: 'plan quota',
  plan_limit_exceeded: 'plan quota',
  task_overrun_recorded: 'leaked',
}

/** One sentence a person can read without opening the body. The body stays
 *  verbatim in the details below it; this is composed from the columns the
 *  row already carries, so it cannot say something the row does not. */
function decisionLine(r: DecisionRow): string {
  let body: Record<string, unknown> = {}
  try { body = JSON.parse(r.snapshot) as Record<string, unknown> } catch { /* verbatim below */ }
  if (typeof body.message === 'string') return body.message
  const asked = r.estimatedUnits == null ? null : num(Number(r.estimatedUnits))
  const ceil = r.ceilingUnits == null ? null : num(Number(r.ceilingUnits))
  const used = r.usedUnits == null ? null : num(Number(r.usedUnits))
  switch (r.reason) {
    case 'ceiling_exceeded': return `Asked ${asked ?? '?'} units against a per-request ceiling of ${ceil ?? '?'}.`
    case 'task_ceiling_exceeded': return `Asked ${asked ?? '?'} units with the task at ${used ?? '?'} of ${ceil ?? '?'}.`
    case 'budget_exhausted': return `Asked ${asked ?? '?'} units; the customer had ${typeof body.remaining_units === 'number' ? num(body.remaining_units) : '0'} remaining.`
    case 'free_tier_exceeded':
    case 'plan_limit_exceeded': return `${used ?? '?'} of ${ceil ?? '?'} preflight calls this month; the plan quota is spent.`
    case 'task_overrun_recorded': return `Recorded ${asked ?? '?'} units after the call ran; the task stands at ${used ?? '?'} of ${ceil ?? '?'}.`
    default: return r.reason
  }
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

// The console keeps its own chrome: it is an authenticated surface with a rail,
// not a marketing page, so it takes neither siteNav nor siteFooter. It does
// take the shared tokens, which is what the fragmentation finding was about.
const CSS = `
  /* Hallmark · genre: modern-minimal · macrostructure: Workbench (app shell: side rail + server-rendered views)
     · nav: N3 side rail, folds to a top bar and a view strip under 960px · footer: none (in-page API note)
     · design-system: design.md · designed-as-app · pre-emit critique: P5 H5 E4 S5 R5 V4 */

  /* Colour semantics for this page, and why they had to be written down.
     Red used to mark a blocked call in the chart, a task that hit its ceiling
     and a customer at their limit, all three of which are the product doing
     exactly its job, and also a plan bar at 100%, which is a real problem.
     A colour that means two things means nothing, so each gets one job and
     nothing else is allowed to borrow it:

       --flow  ordinary traffic. Metered units, a running task, a live key.
       --held  AgentBill stopped something. This is what the product is for,
               so it carries the accent instead of an alarm.
       --near  approaching a limit. Worth a glance; nothing is wrong yet.
       --fail  needs a human. Spend that got past a ceiling, or an account
               about to stop working. Nothing else on this page is red. */
  :root {
    --shell: 1080px;
    --rail: 240px;
    --held: var(--green); --near: var(--amber); --fail: var(--red);
  }

  body { font-size: var(--fs-small); line-height: 1.5; }
  a { text-decoration: none; }
  a:hover { text-decoration: underline; text-underline-offset: 3px; }

  /* The shell: a rail and a main column. The rail is sticky for the height of
     the viewport, so the views and the account are in reach from any scroll
     position. Under --lg the same markup becomes a top bar and a strip. */
  .shell { display: grid; grid-template-columns: var(--rail) minmax(0, 1fr); min-height: 100vh; }
  .rail { position: sticky; top: 0; height: 100vh; overflow-y: auto; display: flex; flex-direction: column;
          gap: var(--s4); padding: var(--s4) var(--s3); border-right: 1px solid var(--border); background: var(--bg); }
  .logo { display: flex; align-items: center; gap: 9px; padding: var(--s1) var(--s2); font-family: var(--mono);
          font-weight: 700; font-size: var(--fs-body); color: var(--text); white-space: nowrap; }
  .logo:hover { text-decoration: none; }
${MARK_CSS}

  /* The account card. The one bar on this page that is about the account
     rather than the product: running out of plan means calls stop being
     metered, which needs a human, so this is where --fail legitimately lives. */
  .acct { background: var(--surface); border: 1px solid var(--border); border-top-color: var(--border2);
          border-radius: var(--r-frame); box-shadow: var(--edge), var(--lift); padding: var(--s3) var(--s3) var(--s3); }
  .acct-who { font-size: var(--fs-small); color: var(--text); font-weight: 600; overflow: hidden;
              text-overflow: ellipsis; white-space: nowrap; }
  .acct-row { display: flex; align-items: center; justify-content: space-between; gap: var(--s2);
              margin-top: 6px; font-family: var(--mono); font-size: var(--fs-chip); color: var(--dim); white-space: nowrap; }
  .acct-q { margin-top: var(--s2); font-family: var(--mono); font-size: var(--fs-chip); color: var(--dim);
            font-variant-numeric: tabular-nums; line-height: 1.5; }
  .acct-q b { color: var(--muted); font-weight: 500; }
  .meter { height: 4px; background: var(--surface3); border-radius: var(--r-pill); margin-top: var(--s2); overflow: hidden; }
  .meter i { display: block; height: 100%; border-radius: var(--r-pill); background: var(--flow); }
  .meter i.near { background: var(--near); } .meter i.fail { background: var(--fail); }
  .acct a { color: var(--green); }

  /* The views. The current one is a fact the server decided, so it may wear
     a current state; the old jump rail could not, because every section
     rendered regardless of which link was pressed. */
  .views { display: flex; flex-direction: column; gap: 2px; }
  .views a { display: flex; align-items: center; justify-content: space-between; gap: var(--s2);
             min-height: 40px; padding: 0 var(--s2) 0 var(--s3); border-radius: var(--r-control);
             color: var(--muted); font-weight: 500; white-space: nowrap; position: relative; }
  .views a:hover { color: var(--text); background: var(--surface2); text-decoration: none; }
  .views a[aria-current="page"] { color: var(--text); background: var(--surface2); }
  .views a[aria-current="page"]::before { content: ''; position: absolute; left: 0; top: 10px; bottom: 10px;
                                          width: 2px; border-radius: 1px; background: var(--green); }
  .views a b { font-family: var(--mono); font-size: var(--fs-chip); font-weight: 500; color: var(--dim);
               font-variant-numeric: tabular-nums; }
  .views a[aria-current="page"] b { color: var(--muted); }
  .views .mode { margin-top: var(--s3); padding-top: var(--s3); border-top: 1px solid var(--border);
                 border-radius: 0; }
  .views .mode span::before { content: '\\2194  '; color: var(--dim); }
  .vmenu { display: none; }
  .rail-foot { margin-top: auto; display: flex; flex-direction: column; gap: var(--s2); }
  .rail-foot .docs { display: flex; align-items: center; min-height: 40px; padding: 0 var(--s3);
                     border-radius: var(--r-control); color: var(--muted); font-weight: 500; }
  .rail-foot .docs:hover { color: var(--text); background: var(--surface2); text-decoration: none; }
  .rail-foot form { display: contents; }
  .btn-out { background: none; border: 1px solid var(--border-strong); color: var(--muted); border-radius: var(--r-control);
             padding: 0 var(--s3); font: inherit; font-weight: 600; cursor: pointer; white-space: nowrap;
             min-height: 44px; display: inline-flex; align-items: center; justify-content: center; width: 100%; }
  .btn-out:hover { color: var(--text); border-color: var(--dim); }
  /* The signed-out sample console's only CTA. Filled, not ghosted: this is the
     one action a prospect on this page is meant to take. */
  .btn-key { display: inline-flex; align-items: center; justify-content: center; background: var(--green);
             color: var(--green-ink); border-radius: var(--r-control); padding: 0 var(--s4); font-weight: 700;
             white-space: nowrap; min-height: 44px; width: 100%; }
  .btn-key:hover { color: var(--green-ink); filter: brightness(1.06); text-decoration: none; }
  .btn-key .short { display: none; }

  /* The main column. Centred inside what the rail leaves, on the shell width. */
  .main { min-width: 0; }
  .wrap { max-width: var(--shell); margin: 0 auto; padding: var(--s6) var(--s6) var(--s8); }
  .vh { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--s4); flex-wrap: wrap;
        margin-bottom: var(--s5); }
  h1 { font-family: var(--display); font-size: var(--fs-h1-app); font-weight: 700; letter-spacing: -.022em;
       line-height: 1.1; }
  .sub { color: var(--muted); font-size: var(--fs-body); margin-top: 6px; max-width: 64ch; }
  .sub code, .lede code, .note code, td code { font-family: var(--mono); font-size: var(--fs-micro); color: var(--muted); }

  /* The period control. Segmented, 44px, and it scopes every figure on the
     view that carries a window. It lives in the view header, not under the
     chart, because it is not the chart's control. */
  .seg { display: inline-flex; border: 1px solid var(--border-strong); border-radius: var(--r-control);
         overflow: hidden; background: var(--surface); }
  .seg a { font-family: var(--mono); font-size: var(--fs-micro); color: var(--dim); display: inline-flex;
           align-items: center; min-height: 44px; padding: 0 var(--s4); border-right: 1px solid var(--border);
           white-space: nowrap; }
  .seg a:last-child { border-right: none; }
  .seg a:hover { color: var(--text); background: var(--surface2); text-decoration: none; }
  .seg a.on { color: var(--green-ink); background: var(--green); font-weight: 700; }

  /* Neutral, not amber. This was the largest amber object on the page and it
     meant "this data is invented", while every other amber here means
     "approaching a limit", so the page's loudest colour signal was the one that
     is not a signal. The frame and the label stay, so design.md's rule that
     sample data says so inside its own frame still holds. */
  .banner { display: flex; align-items: baseline; gap: var(--s3); flex-wrap: wrap;
            background: var(--surface2); border: 1px solid var(--border-strong); border-radius: var(--r-frame);
            padding: var(--s3) var(--s4); margin-bottom: var(--s5); }
  .banner b { font-family: var(--mono); font-size: var(--fs-chip); letter-spacing: .1em;
              text-transform: uppercase; color: var(--dim); }
  .banner p { color: var(--muted); margin: 0; }
  .banner a { color: var(--green); }

  /* One frame recipe for everything that holds content. */
  .frame { background: var(--surface); border: 1px solid var(--border); border-top-color: var(--border2);
           border-radius: var(--r-frame); box-shadow: var(--edge), var(--lift); min-width: 0; }
  .lbl { font-family: var(--mono); font-size: var(--fs-label); letter-spacing: .1em; text-transform: uppercase;
         color: var(--dim); font-weight: 500; }
  h2 { font-family: var(--display); font-size: var(--fs-h3); font-weight: 600; letter-spacing: -.01em;
       display: flex; align-items: baseline; justify-content: space-between; gap: var(--s3);
       margin: var(--s7) 0 var(--s3); }
  h2 a { font-family: var(--sans); font-size: var(--fs-small); font-weight: 500; color: var(--green); white-space: nowrap; }
  h2 span { font-family: var(--mono); font-size: var(--fs-micro); font-weight: 400; color: var(--dim); }
  .lede { color: var(--dim); margin: -4px 0 var(--s3); max-width: 78ch; }

  /* Tiles. Four peers, each saying its own window in its own label. */
  .kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--s3); }
  .tile { padding: var(--s4) var(--s4) var(--s3); display: flex; flex-direction: column; gap: 6px; }
  .tv { font-family: var(--mono); font-size: var(--fs-figure); font-weight: 700; line-height: 1.1;
        letter-spacing: -.02em; color: var(--text); overflow-wrap: anywhere; }
  .tv.held { color: var(--held); }
  /* margin-top: auto, so the four footers share one baseline whether or not
     the tile above them carries a sparkline. */
  .tf { font-family: var(--mono); font-size: var(--fs-chip); color: var(--dim); font-variant-numeric: tabular-nums; margin-top: auto; }
  .tf.now { color: var(--muted); }
  .spark { display: flex; align-items: flex-end; gap: 2px; height: 26px; margin-top: 4px; }
  .spark i { flex: 1 1 0; min-width: 0; background: var(--flow); border-radius: 1px 1px 0 0; }
  .spark i.held { background: var(--held); }
  .spark i.zero { background: var(--surface2); height: 1px; }

  /* Leaked spend is not a peer of the four tiles above it. It is the only
     number here whose good value is zero, so it has its own row with its
     explanation attached, and it is the only red on the page. */
  .leak { display: flex; align-items: center; gap: var(--s4); margin-top: var(--s3); padding: var(--s3) var(--s4); }
  .leak-n { font-family: var(--mono); font-size: var(--fs-figure); font-weight: 700; line-height: 1.1;
            letter-spacing: -.02em; color: var(--flow-ink); min-width: 2ch; text-align: right; }
  .leak-t { flex: 1 1 auto; min-width: 0; }
  .leak-t b { display: block; font-family: var(--mono); font-size: var(--fs-label); letter-spacing: .1em;
              text-transform: uppercase; color: var(--dim); font-weight: 500; }
  .leak-t p { color: var(--dim); margin: 3px 0 0; max-width: 78ch; }
  .leak a { color: var(--green); white-space: nowrap; }
  .leak.bad { border-color: var(--fail-line); }
  .leak.bad .leak-n, .leak.bad .leak-t b { color: var(--fail); }

  /* The chart. Two rows, one series each, one scale each, one x-axis. Blocks
     are rarer than units by orders of magnitude, so they cannot share a scale;
     they used to be stacked into the same column on two different scales and
     reading any bar against the axis gave a number roughly half the truth. */
  .chart { padding: var(--s4) var(--s4) var(--s3); }
  .crow { display: grid; grid-template-columns: 128px minmax(0, 1fr); gap: var(--s4); align-items: stretch; }
  .crow + .crow { margin-top: var(--s3); }
  .clab { display: flex; flex-direction: column; justify-content: flex-start; gap: 2px; padding-top: 2px; }
  .clab b { font-weight: 600; color: var(--text); display: flex; align-items: center; gap: 7px; }
  .clab b::before { content: ''; width: 8px; height: 8px; border-radius: 2px; background: var(--flow); flex: none; }
  .clab.held b::before { background: var(--held); }
  .clab span { font-family: var(--mono); font-size: var(--fs-chip); color: var(--dim); font-variant-numeric: tabular-nums; }
  /* A 44px gutter on the left of the plot carries the y ticks, so a tick never
     sits on a bar. The x-axis row pads by the same amount to stay in step. */
  .cplot { position: relative; padding-left: 44px; }
  .cgrid { position: absolute; inset: 0 0 0 44px; display: flex; flex-direction: column; justify-content: space-between;
           pointer-events: none; }
  .cgrid span { border-top: 1px solid var(--border-soft); height: 0; position: relative; }
  .cgrid span::after { content: attr(data-y); position: absolute; right: calc(100% + 8px); top: -8px;
                       font-family: var(--mono); font-size: var(--fs-chip); color: var(--dim);
                       font-variant-numeric: tabular-nums; white-space: nowrap; }
  .cbars { display: flex; align-items: flex-end; gap: 3px; height: 180px; position: relative; }
  /* Ninety columns at a 3px gap spent 267px on gaps, which is more than a
     phone's whole plot; the bars measured 0px. Dense windows use 1px. */
  .cbars.dense, .cx div.dense { gap: 1px; }
  .cbars.strip { height: 40px; }
  .col { flex: 1 1 0; min-width: 0; height: 100%; display: flex; align-items: flex-end; justify-content: center;
         position: relative; }
  .col i { display: block; width: 100%; max-width: 28px; border-radius: 3px 3px 0 0; background: var(--flow); }
  .col i.held { background: var(--held); }
  .col i.zero { display: none; }
  /* The one direct label: the peak. Everything else is on the axis, the hover
     or the day-by-day table on the activity view. */
  .strip .col.peak::before { display: none; }
  .col.peak::before { content: attr(data-v); position: absolute; left: 50%; transform: translateX(-50%);
                      top: -18px; font-family: var(--mono); font-size: var(--fs-chip); color: var(--muted);
                      font-variant-numeric: tabular-nums; white-space: nowrap; }
  /* The hover layer, in CSS: one readout per day with every series at that x.
     The column is the hit target, not the bar, so a two-pixel day is as easy
     to hit as the peak. Values are also in the table on the activity view. */
  .col::after { content: attr(data-t); display: none; position: absolute; bottom: calc(100% + 6px); left: 50%;
                transform: translateX(-50%); z-index: 2; background: var(--surface3); color: var(--text);
                border: 1px solid var(--border2); border-radius: var(--r-chip); padding: 5px 9px;
                font-family: var(--mono); font-size: var(--fs-chip); white-space: nowrap; box-shadow: var(--lift); }
  .col:hover::after { display: block; }
  /* On the tallest bars the readout above the column pokes past the frame's
     top edge; those anchor it just inside the plot instead. */
  .col.tall::after { bottom: auto; top: 6px; }
  .col:hover i { filter: brightness(1.25); }
  .col.l::after { left: 0; transform: none; } .col.r::after { left: auto; right: 0; transform: none; }
  .cx { display: grid; grid-template-columns: 128px minmax(0, 1fr); gap: var(--s4); margin-top: 6px; }
  .cx div { display: flex; gap: 3px; padding-left: 44px; }
  /* Each label is centred on its column, and may overflow its slot on both
     sides equally, which is what a flex container with justify-content:
     center does with a child wider than itself. The last label of a dense
     axis ends flush with its column instead, so it never leaves the frame. */
  .cx span { flex: 1 1 0; min-width: 0; font-family: var(--mono); font-size: var(--fs-chip); color: var(--dim);
             white-space: nowrap; overflow: visible; display: flex; justify-content: center; }
  .cx div:not(.x1) span:last-child { justify-content: flex-end; }

  /* Burn-down rows. */
  .brow { padding: var(--s3) var(--s4); border-bottom: 1px solid var(--border); }
  .brow:last-child { border-bottom: none; }
  .bhead { display: flex; justify-content: space-between; align-items: baseline; gap: var(--s3); flex-wrap: wrap;
           margin-bottom: 8px; }
  .btask { font-family: var(--mono); color: var(--text); overflow: hidden; text-overflow: ellipsis; }
  .btask a { color: var(--text); }
  .bagent { color: var(--dim); font-family: var(--sans); }
  .bnum { font-family: var(--mono); font-size: var(--fs-micro); color: var(--muted); font-variant-numeric: tabular-nums;
          white-space: nowrap; display: flex; align-items: center; gap: var(--s2); }
  .bnum b { color: var(--text); font-weight: 700; }
  .track { height: 8px; background: var(--surface3); border-radius: var(--r-pill); overflow: hidden; display: flex; }
  .track i { display: block; height: 100%; }
  .track i.used { background: var(--flow); }
  .track i.used.near { background: var(--near); }
  .track i.used.held { background: var(--held); }
  .track i.used.fail { background: var(--fail); }
  .track i.res { background: var(--res); }
  .bfoot { margin-top: 6px; font-family: var(--mono); font-size: var(--fs-chip); color: var(--dim);
           display: flex; justify-content: space-between; gap: var(--s3); flex-wrap: wrap; }
  .key { display: flex; gap: var(--s4); flex-wrap: wrap; font-family: var(--mono); font-size: var(--fs-chip);
         color: var(--dim); margin: var(--s3) 0 0; }
  .key span { display: flex; align-items: center; gap: 6px; }
  .key i { width: 9px; height: 9px; border-radius: 2px; display: inline-block; background: var(--flow); }
  .key i.res { background: var(--res); } .key i.near { background: var(--near); } .key i.held { background: var(--held); }
  .key i.fail { background: var(--fail); }

  /* Tables. */
  .tw { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; padding: 10px var(--s4); color: var(--dim); font-weight: 500; font-size: var(--fs-chip);
       text-transform: uppercase; letter-spacing: .08em; border-bottom: 1px solid var(--border);
       white-space: nowrap; font-family: var(--mono); }
  td { padding: 11px var(--s4); border-bottom: 1px solid var(--border); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  td.num, th.num { font-family: var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap; text-align: right; }
  td.id { font-family: var(--mono); font-size: var(--fs-micro); white-space: nowrap; max-width: 220px;
          overflow: hidden; text-overflow: ellipsis; }
  td.id a { color: var(--text); }
  td.msg { color: var(--muted); min-width: 26ch; }
  td.when { color: var(--dim); font-family: var(--mono); font-size: var(--fs-micro); white-space: nowrap; }
  tr.zero td { color: var(--dim); }
  .chip { display: inline-block; font-family: var(--mono); font-size: var(--fs-chip); font-weight: 700;
          letter-spacing: .06em; text-transform: uppercase; padding: 3px 8px; border-radius: var(--r-chip); white-space: nowrap; }
  .chip.held { background: var(--held-bg); color: var(--green); border: 1px solid var(--held-line); }
  .chip.near { background: var(--near-bg); color: var(--amber); border: 1px solid var(--near-line); }
  .chip.fail { background: var(--fail-bg); color: var(--fail-ink); border: 1px solid var(--fail-line); }
  .chip.flow { background: var(--surface3); color: var(--flow-ink); border: 1px solid var(--border2); }
  .chip.dead { background: var(--surface3); color: var(--dim); border: 1px solid var(--border2); }
  /* Share of spend: one hue for one series, the bar scaled to the heaviest
     customer, the percentage of every customer's lifetime spend beside it. */
  .share { display: flex; align-items: center; gap: var(--s2); }
  .share .sbar { display: block; width: 110px; height: 8px; background: var(--surface3); border-radius: var(--r-pill);
                 overflow: hidden; flex: none; }
  .share i { display: block; height: 100%; border-radius: var(--r-pill); background: var(--flow); }
  .share i.held { background: var(--held); } .share i.near { background: var(--near); }
  .share > span:last-child { font-family: var(--mono); font-size: var(--fs-micro); color: var(--muted);
                             font-variant-numeric: tabular-nums; }
  .muted { color: var(--muted); } .dim { color: var(--dim); } .none { color: var(--dim); font-style: italic; }
  details summary { cursor: pointer; color: var(--green); font-family: var(--mono); font-size: var(--fs-micro);
                    list-style: none; padding: 2px 0; }
  td details summary { white-space: nowrap; }
  details summary::-webkit-details-marker { display: none; }
  details summary::before { content: '\\25B8  '; } details[open] summary::before { content: '\\25BE  '; }
  pre { background: var(--bg-deep); border: 1px solid var(--border); border-radius: var(--r-control); padding: var(--s3) var(--s4);
        font-family: var(--mono); font-size: var(--fs-micro); line-height: 1.55; overflow-x: auto;
        color: var(--code-ink); margin-top: var(--s2); }

  /* Compact refusal rows on the overview: the time in a gutter, then two
     lines that may each be cut with an ellipsis but never grow the row. A
     first draft put the chip in a 1fr track, which stretched it to the frame,
     and let a nowrap sentence size an auto track past the frame's edge. */
  .rrow { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: var(--s3); align-items: baseline;
          padding: 11px var(--s4); border-bottom: 1px solid var(--border); }
  .rrow:last-child { border-bottom: none; }
  .rrow .when { font-family: var(--mono); font-size: var(--fs-micro); color: var(--dim); white-space: nowrap; }
  .rmain { min-width: 0; }
  .rtop { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
  .rrow .who { font-family: var(--mono); font-size: var(--fs-micro); color: var(--text); white-space: nowrap;
               overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .rrow .who a { color: var(--text); }
  .rrow .who .dim { color: var(--dim); }
  .rrow .chip { flex: none; }
  /* Two lines, then an ellipsis. One line cut the leaked row's own number. */
  .rrow .what { color: var(--muted); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
                margin-top: 3px; }
  /* .bad, not .leak: the exception row above owns .leak, and a modifier that
     shares its name inherited display: flex and 12px of padding, which is a
     box text-overflow cannot ellipsise. Same reach as the .kick span bug. */
  .rrow .what.bad { color: var(--fail-ink); }

  /* Two frames side by side on the overview; the row closes itself. */
  .duo { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--s4); align-items: start; }
  .duo h2 { margin-top: 0; }
  .duo > div { min-width: 0; }

  /* The filter row on the refusals view. A filter is a fact about the list,
     so it says what it is and how to clear it. */
  .filters { display: flex; align-items: center; gap: var(--s2); flex-wrap: wrap; margin: -8px 0 var(--s3);
             font-family: var(--mono); font-size: var(--fs-micro); color: var(--dim); }
  .filters .chip-f { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--border-strong);
                     border-radius: var(--r-control); padding: 0 10px; min-height: 32px; color: var(--muted);
                     max-width: 100%; min-width: 0; }
  .filters .chip-f b { color: var(--text); font-weight: 500; min-width: 0; overflow: hidden; text-overflow: ellipsis;
                       white-space: nowrap; }
  .filters a { color: var(--green); }

  /* The limits ladder. Four rules in evaluation order. Named .lim, not .rule:
     the refusals table has a td.rule and a shared name gave that cell a grid. */
  .lim { display: grid; grid-template-columns: 34px minmax(0, 1.1fr) minmax(0, 1fr); gap: var(--s4) var(--s6); padding: var(--s4);
         border-bottom: 1px solid var(--border); }
  .lim:last-child { border-bottom: none; }
  .lim .n { font-family: var(--mono); font-size: var(--fs-micro); color: var(--dim); padding-top: 3px; }
  .lim h3 { font-family: var(--display); font-size: var(--fs-body); font-weight: 600; letter-spacing: -.01em; color: var(--text);
            margin-bottom: 2px; }
  .lim .param { font-family: var(--mono); font-size: var(--fs-micro); color: var(--muted); margin-bottom: 6px; }
  .lim p { color: var(--dim); max-width: 60ch; }
  .lim .live { display: flex; flex-direction: column; gap: 6px; font-family: var(--mono); font-size: var(--fs-micro);
               color: var(--muted); font-variant-numeric: tabular-nums; }
  .lim .live b { color: var(--text); font-weight: 700; }
  .lim .live .held { color: var(--held); } .lim .live .fail { color: var(--fail); }
  .lim .live a { color: var(--green); }
  .note { margin-top: var(--s3); color: var(--dim); max-width: 78ch; }

  /* Commands, as display, not as a code sample: a div, never a pre, because
     scripts/snippets harvests every pre on every route and executes it. */
  .cmds { padding: var(--s2) 0; }
  .cmd { display: grid; grid-template-columns: minmax(0, 220px) minmax(0, 1fr); gap: var(--s4); padding: 9px var(--s4);
         border-bottom: 1px solid var(--border); font-family: var(--mono); font-size: var(--fs-micro); }
  .cmd:last-child { border-bottom: none; }
  .cmd b { color: var(--code-ink); font-weight: 500; white-space: nowrap; }
  .cmd span { color: var(--dim); font-family: var(--sans); font-size: var(--fs-small); }

  /* Empty state and the in-page note. */
  .empty { padding: var(--s5); border-style: dashed; border-color: var(--border2); box-shadow: none; }
  .empty h2 { margin: 0 0 var(--s2); }
  .empty p { color: var(--muted); margin-bottom: var(--s3); max-width: 70ch; }
  .empty ol { margin: 0 0 var(--s3) 1.2em; color: var(--muted); }
  .empty ol li { margin-bottom: 6px; }
  .empty pre { margin: var(--s2) 0 var(--s3); white-space: pre-wrap; word-break: break-all; }
  .empty details { margin-top: var(--s2); }
  .empty .out { font-family: var(--mono); font-size: var(--fs-micro); color: var(--code); overflow-wrap: anywhere; }
  .nothing { padding: var(--s5) var(--s4); color: var(--dim); }
  .foot { margin-top: var(--s7); padding-top: var(--s4); border-top: 1px solid var(--border); color: var(--dim);
          line-height: 1.7; }
  .foot code { font-family: var(--mono); font-size: var(--fs-micro); color: var(--muted); }

  /* Login. */
  .login { max-width: 460px; margin: var(--s9) auto; padding: var(--s6); }
  .login h1 { font-size: var(--fs-h3); }
  .login p { color: var(--muted); font-size: var(--fs-body); margin-bottom: var(--s4); }
  label { display: block; font-family: var(--mono); font-size: var(--fs-chip); letter-spacing: .1em;
          text-transform: uppercase; color: var(--dim); margin-bottom: var(--s2); }
  input { width: 100%; background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--r-control);
          padding: var(--s3); color: var(--text); font-family: var(--mono); font-size: var(--fs-small);
          margin-bottom: var(--s3); outline: 2px solid transparent; outline-offset: 2px; min-height: 46px; }
  .btn { width: 100%; background: var(--green); color: var(--green-ink); border: none; border-radius: var(--r-control);
         padding: var(--s3); font: inherit; font-size: var(--fs-body); font-weight: 700; cursor: pointer; min-height: 46px; }
  .btn:hover { filter: brightness(1.06); }
  .err { color: var(--red); margin-bottom: var(--s3); }
  .fine { color: var(--dim); margin-top: var(--s4); }
  /* Outranks .login p, which is what kept the card bottom-heavy. */
  .login .fine { margin-bottom: 0; }
  nav.top { height: 60px; border-bottom: 1px solid var(--border); display: flex; align-items: center; padding: 0 var(--s5); }
  a:focus-visible, button:focus-visible, input:focus-visible, summary:focus-visible {
    outline: 2px solid var(--green); outline-offset: 2px; }

  @media (max-width: ${BP.lg}px) {
    /* The rail becomes a bar and a strip. Same markup, three areas: the
       identity row, the views scrolling in one line, nothing else. */
    .shell { display: block; }
    .rail { position: sticky; height: auto; overflow: visible; z-index: 10; display: grid;
            grid-template-columns: auto minmax(0, 1fr) auto; grid-template-areas: "logo acct foot" "views views views";
            align-items: center; gap: var(--s2) var(--s3); padding: var(--s2) var(--s3) 0;
            border-right: none; border-bottom: 1px solid var(--border); }
    .logo { grid-area: logo; padding: 0; }
    .acct { grid-area: acct; background: none; border: none; box-shadow: none; padding: 0; min-width: 0;
            display: flex; align-items: center; justify-content: flex-end; gap: var(--s3); overflow: hidden; }
    .acct-who, .acct-q, .meter { display: none; }
    .acct-row { margin: 0; }
    .rail-foot { grid-area: foot; margin: 0; flex-direction: row; }
    .rail-foot .docs { display: none; }
    .btn-out, .btn-key { width: auto; }
    .views { display: none; }
    .vmenu { display: block; grid-area: views; position: relative; margin: 0 calc(-1 * var(--s3)); }
    .vmenu summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: var(--s2);
                     min-height: 44px; padding: 0 var(--s4); color: var(--text); font-weight: 600; }
    .vmenu summary::-webkit-details-marker { display: none; }
    .vmenu summary::before, .vmenu[open] summary::before { content: none; }
    .vmenu summary .lbl { font-size: var(--fs-chip); }
    .vmenu summary i { margin-left: auto; width: 8px; height: 8px; border-right: 1.5px solid var(--dim);
                       border-bottom: 1.5px solid var(--dim); transform: translateY(-2px) rotate(45deg); }
    .vmenu[open] summary i { transform: translateY(2px) rotate(-135deg); }
    .vlist { position: absolute; left: var(--s3); right: var(--s3); top: 100%; z-index: 11; display: flex; flex-direction: column;
             gap: 2px; padding: 6px; background: var(--surface); border: 1px solid var(--border2); border-radius: var(--r-frame);
             box-shadow: var(--edge), var(--lift); }
    .vlist a { display: flex; align-items: center; justify-content: space-between; gap: var(--s2); min-height: 44px;
               padding: 0 var(--s3); border-radius: var(--r-control); color: var(--muted); font-weight: 500; white-space: nowrap; }
    .vlist a:hover { color: var(--text); background: var(--surface2); text-decoration: none; }
    .vlist a[aria-current="page"] { color: var(--text); background: var(--surface2); }
    .vlist a b { font-family: var(--mono); font-size: var(--fs-chip); font-weight: 500; color: var(--dim); }
    .vlist .mode { margin-top: 4px; border-top: 1px solid var(--border); border-radius: 0; padding-top: 4px; }
    .vlist .mode span::before { content: '\\2194  '; color: var(--dim); }
    .vlist .more { margin-top: 4px; border-top: 1px solid var(--border); border-radius: 0; padding-top: 4px; }
    .vlist .mode + .more { margin-top: 0; border-top: none; padding-top: 0; }
    .wrap { padding: var(--s5) var(--s4) var(--s7); }
    .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .duo { grid-template-columns: minmax(0, 1fr); }
    .crow, .cx { grid-template-columns: minmax(0, 1fr); gap: var(--s2); }
    .clab { flex-direction: row; align-items: baseline; gap: var(--s3); }
    /* The row title sits above the plot here, where the peak's direct label
       used to land on it; the title already names the peak. */
    .col.peak::before { display: none; }
    h2 { flex-wrap: wrap; }
    .cbars { height: 140px; }
    .lim { grid-template-columns: 28px minmax(0, 1fr); }
    .lim .live { grid-column: 2; }
  }
  @media (max-width: ${BP.sm}px) {
    /* The leak row: the link takes its own line instead of squeezing the
       sentence into an 84px column beside it. */
    .leak { flex-wrap: wrap; }
    .leak-t { flex: 1 1 160px; }
    .leak a { flex-basis: 100%; }
    /* The hover readout is wider than a phone's plot and there is no hover on
       a phone; the day-by-day table on the activity view carries the values. */
    .col:hover::after { display: none; }
    /* Seven daily labels, or six ninety-day ones, overlap at 320px; every
       other one steps back. */
    .cx div.x1 .alt, .cx div.dense .alt { visibility: hidden; }
    /* The refusals table on a phone: the same rows, laid out as cards. Six
       columns in a sideways scroller hid the sentence that explains the row
       behind two swipes. One DOM, no second copy for the small screen. */
    .refusals thead { display: none; }
    .refusals tr { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 4px var(--s3);
                   padding: var(--s3) var(--s4); border-bottom: 1px solid var(--border); }
    .refusals tr:last-child { border-bottom: none; }
    .refusals td { display: block; padding: 0; border: none; }
    .refusals td.rule { text-align: right; }
    .refusals td.id { max-width: none; }
    .refusals td.id::before { content: attr(data-l) ' '; color: var(--dim); }
    .refusals td.msg, .refusals td.body { grid-column: 1 / -1; }
    .refusals td.msg { margin-top: 2px; }
    /* Customers and keys as cards too: the identifier and its state on the
       first line, the wide cell (share bar, label) on the second, then the
       numbers as label-value pairs. No column is hidden off the edge. */
    .cards thead { display: none; }
    .cards tr { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px var(--s3);
                padding: var(--s3) var(--s4); border-bottom: 1px solid var(--border); align-items: center; }
    .cards tr:last-child { border-bottom: none; }
    .cards td { display: block; padding: 0; border: none; }
    .cards td.lead { max-width: none; }
    .cards td.state { grid-column: 2; grid-row: 1; justify-self: end; }
    .cards td.wide { grid-column: 1 / -1; }
    .cards td.num, .cards td.when { grid-column: 1 / -1; text-align: left; font-size: var(--fs-micro); white-space: normal; }
    .cards td[data-l]::before { content: attr(data-l) '  '; color: var(--dim); font-family: var(--mono); font-size: var(--fs-chip);
                                text-transform: uppercase; letter-spacing: .06em; }
    .cards .share .sbar { flex: 1 1 60px; width: auto; }
    .cards .share > span:last-child { flex: none; white-space: nowrap; }
    th, td { padding-inline: 10px; }
    /* The day-by-day table at 375px: the weekday steps back, the heads may
       wrap, and the cells tighten, so four columns fit a 341px card. */
    .days th { white-space: normal; }
    .days th, .days td { padding-inline: 8px; }
    .days td.when .dim { display: none; }
    /* The JSON body wraps instead of scrolling inside a 322px card. */
    td pre { white-space: pre-wrap; word-break: break-word; }
    /* The login card keeps a gutter like every other card on a phone. */
    .login { margin: var(--s6) var(--s4); }
    /* The key tail and the wordmark wanted the same 80px at 375px; the tail is
       the one that can go, the banner and the rail say which mode this is. */
    .acct-row span:last-child { display: none; }
    .kpis { gap: var(--s2); }
    .tile { padding: var(--s3); }
    .tile .lbl { font-size: var(--fs-chip); letter-spacing: .06em; }
    .rrow { grid-template-columns: 56px minmax(0, 1fr); }
    /* The chip wraps under the ids instead of squeezing them to fragments,
       and the sentence gets two lines instead of one. */
    .rtop { flex-wrap: wrap; gap: 4px 10px; }
    .rrow .who { flex: 1 1 100%; }
    .bhead { flex-direction: column; align-items: flex-start; gap: 4px; }
    .cmd { grid-template-columns: minmax(0, 1fr); gap: 4px; }
  }
  @media (max-width: ${BP.xs}px) {
    /* A seven-digit figure needs 140px of the 116px a half-width tile has at
       320px; one column keeps the number inside its frame. */
    .kpis { grid-template-columns: minmax(0, 1fr); }
    .btn-key { padding: 0 var(--s3); }
    .btn-key .long { display: none; }
    .btn-key .short { display: inline; }
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
  <div class="login frame">
    <h1>Your console</h1>
    <p>Live task budgets, every call refused on your behalf, and the exact response your agent got. Paste the API key from <a href="/register">/register</a>.</p>
    ${Object.hasOwn(ERRORS, err) ? `<p class="err">${esc(ERRORS[err])}</p>` : ''}
    <form method="POST" action="/app/session" autocomplete="off">
      <label for="api_key">API key</label>
      <input id="api_key" name="api_key" type="password" placeholder="agb_..." autofocus required />
      <button class="btn" type="submit">Open console &rarr;</button>
    </form>
    <p class="fine">The key is exchanged for an HttpOnly cookie that lasts 7 days and dies with the key. This page loads no script. <a href="/app?demo=1">See it with sample data</a> first.</p>
  </div>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Page state and links
// ---------------------------------------------------------------------------

type Page = { v: Viewer; d: Console; demo: boolean; anon: boolean; range: string; view: ViewKey; filter: Filter }

/** Every link on the page is built here, so demo=1 and the period survive a
 *  change of view. A prospect on the sample console who clicked a rail item
 *  and landed on the login page would never come back. */
function href(p: Page, view: ViewKey, extra: Partial<{ range: string; task: string; agent: string; only: string; demo: boolean }> = {}): string {
  const q: string[] = []
  const demo = extra.demo ?? p.demo
  if (demo) q.push('demo=1')
  if (view !== DEFAULT_VIEW) q.push(`view=${view}`)
  const range = extra.range ?? p.range
  if (range !== DEFAULT_RANGE) q.push(`range=${encodeURIComponent(range)}`)
  if (extra.task) q.push(`task=${encodeURIComponent(extra.task)}`)
  if (extra.agent) q.push(`agent=${encodeURIComponent(extra.agent)}`)
  if (extra.only) q.push(`only=${encodeURIComponent(extra.only)}`)
  return q.length ? `/app?${q.join('&amp;')}` : '/app'
}

// ---------------------------------------------------------------------------
// Fragments
// ---------------------------------------------------------------------------

// A count with no direction is trivia. Against the same window immediately
// before it, it is a signal. Neutral ink on purpose: more refusals can mean
// the product saved more or the agents misbehaved more, and a colour would
// decide that for the reader.
function delta(now: number, prev: number, label: string): string {
  const short = label.replace(' days', 'd')
  if (now === 0 && prev === 0) return `<div class="tf">none in the last ${esc(short)}</div>`
  if (prev === 0) return `<div class="tf" title="No refusals in the previous ${esc(label)}">first ${esc(short)} with refusals</div>`
  const pct = Math.round(((now - prev) / prev) * 100)
  if (pct === 0) return `<div class="tf" title="Same as the previous ${esc(label)}">flat vs the prior ${esc(short)}</div>`
  return `<div class="tf" title="Against the ${esc(label)} immediately before this window">${pct > 0 ? '&uarr;' : '&darr;'} ${Math.abs(pct)}% vs the prior ${esc(short)}</div>`
}

function planOf(v: Viewer): { limit: number | null; pct: number; cls: string } {
  const limit = v.plan === 'paid' ? null : PLAN_LIMITS[v.plan] ?? PLAN_LIMITS.free
  const pct = limit === null ? 0 : Math.min(100, Math.round((v.monthlyCalls / limit) * 100))
  const cls = pct >= 90 ? 'fail' : pct >= 75 ? 'near' : ''
  return { limit, pct, cls }
}

/** The account card in the rail. Identity is the viewer's; the plan figures
 *  are sample under demo, because a real quota above invented tiles was the
 *  one number on the sample page that the banner's promise did not cover. */
function accountCard(p: Page): string {
  const who = p.anon ? 'Sample console' : (p.v.email ?? 'no email')
  const plan = p.demo ? DEMO_VIEWER : p.v
  const { limit, pct, cls } = planOf(plan)
  const keyTail = p.v.apiKey.slice(0, 8) + '…' + p.v.apiKey.slice(-4)
  const quota = limit === null
    ? `<b>${num(plan.monthlyCalls)}</b> calls this month · metered, no cap`
    : `<b>${num(plan.monthlyCalls)}</b> / ${num(limit)} calls · this billing month${pct >= 75
        ? ` · <a href="/pricing?account_id=${encodeURIComponent(p.v.accountId)}">raise the ceiling</a>` : ''}`
  return `<div class="acct">
        <div class="acct-who" title="${esc(who)}">${esc(who)}</div>
        <div class="acct-row"><span class="chip flow">${esc(plan.plan)}</span><span title="${p.v.keyLabel ? esc(p.v.keyLabel) : 'key'}">${esc(keyTail)}</span></div>
        ${limit === null ? '' : `<div class="meter"><i class="${cls}" style="width:${pct}%"></i></div>`}
        <div class="acct-q">${quota}</div>
      </div>`
}

function rail(p: Page): string {
  const d = p.d
  const activeKeys = d.keys.filter((k) => !(k.revokedAt && new Date(k.revokedAt).getTime() <= Date.now()) && !(k.expiresAt && new Date(k.expiresAt).getTime() <= Date.now())).length
  const counts: Partial<Record<ViewKey, string>> = {
    tasks: d.taskCount ? num(d.taskCount) : '',
    refusals: d.decisionTotal ? num(d.decisionTotal) : '',
    customers: d.customerCount ? num(d.customerCount) : '',
    keys: activeKeys ? num(activeKeys) : '',
  }
  const items = (Object.keys(VIEWS) as ViewKey[]).map((k) =>
    `<a href="${href(p, k)}"${k === p.view ? ' aria-current="page"' : ''}><span>${VIEWS[k].title}</span>${counts[k] ? `<b>${counts[k]}</b>` : ''}</a>`).join('\n        ')
  // The phone's copy of the same list, inside a native disclosure whose
  // summary names the current view. A horizontal strip put the current item
  // off screen on the last three views, with no highlight and no hint that
  // it scrolled; a summary that reads "Limits" cannot hide which page this is.
  const menu = `<details class="vmenu">
        <summary><span class="lbl">View</span><b>${VIEWS[p.view].title}</b><i aria-hidden="true"></i></summary>
        <div class="vlist">
        ${items}
        ${p.anon ? '' : p.demo
          ? `<a class="mode" href="${href(p, p.view, { demo: false })}"><span>Your data</span></a>`
          : `<a class="mode" href="${href(p, p.view, { demo: true })}"><span>Sample data</span></a>`}
        <a class="more" href="/docs"><span>Docs</span></a>
        </div>
      </details>`
  const mode = p.anon
    ? ''
    : p.demo
      ? `<a class="mode" href="${href(p, p.view, { demo: false })}"><span>Your data</span></a>`
      : `<a class="mode" href="${href(p, p.view, { demo: true })}"><span>Sample data</span></a>`
  const action = p.anon
    ? `<a class="btn-key" href="/register"><span class="long">${KEY_CTA}</span><span class="short">${KEY_CTA_SHORT}</span></a>`
    : `<form method="POST" action="/app/logout"><button class="btn-out" type="submit">Sign out</button></form>`
  return `<aside class="rail">
      <a class="logo" href="/">${mark(18)}AgentBill</a>
      ${accountCard(p)}
      <nav class="views" aria-label="Console views">
        ${items}
        ${mode}
      </nav>
      ${menu}
      <div class="rail-foot">
        <a class="docs" href="/docs">Docs</a>
        ${action}
      </div>
    </aside>`
}

function periodControl(p: Page): string {
  return `<span class="seg" aria-label="Period">${Object.entries(RANGES).map(([k, r]) =>
    `<a class="${k === p.range ? 'on' : ''}" href="${href(p, p.view, { range: k })}"${k === p.range ? ' aria-current="true"' : ''}>${esc(r.label)}</a>`).join('')}</span>`
}

function sparkline(series: Series[], key: 'units' | 'blocks' | 'refused', cls: string): string {
  const max = Math.max(1, ...series.map((s) => s[key]))
  return `<div class="spark" aria-hidden="true">${series.map((s) => {
    const v = s[key]
    return v > 0 ? `<i class="${cls}" style="height:${Math.max(6, Math.round((v / max) * 100))}%"></i>` : '<i class="zero"></i>'
  }).join('')}</div>`
}

function kpis(p: Page, rangeLabel: string): string {
  const d = p.d
  const blocked = d.series.reduce((a, x) => a + x.blocks, 0)
  const refused = d.series.reduce((a, x) => a + x.refused, 0)
  const metered = d.series.reduce((a, x) => a + x.units, 0)
  const live = d.taskLive
  const near = d.taskNear
  const avgAsk = blocked ? Math.round(refused / blocked) : 0
  // "30d", not "last 30 days": the long form wrapped every label at 1440px and
  // the tiles stopped lining up. The period control in the header says the rest.
  const win = rangeLabel.replace(' days', 'd')
  return `<div class="kpis">
      <div class="tile frame">
        <div class="lbl">Refused · ${esc(win)}</div>
        <div class="tv held">${num(blocked)}</div>
        ${sparkline(d.series, 'blocks', 'held')}
        ${delta(blocked, d.prevBlocked, rangeLabel)}
      </div>
      <div class="tile frame">
        <div class="lbl">Units refused · ${esc(win)}</div>
        <div class="tv">${num(refused)}</div>
        ${sparkline(d.series, 'refused', '')}
        <div class="tf">${blocked ? `${num(avgAsk)} units per refused call` : 'units asked for and not run'}</div>
      </div>
      <div class="tile frame">
        <div class="lbl">Units metered · ${esc(win)}</div>
        <div class="tv">${num(metered)}</div>
        ${sparkline(d.series, 'units', '')}
        <div class="tf">${d.lastBlock ? `last refusal ${rel(d.lastBlock)}` : 'no refusal yet'}</div>
      </div>
      <div class="tile frame">
        <div class="lbl">Live tasks · now</div>
        <div class="tv">${num(live)}</div>
        <div class="tf now">${live === 0 ? 'none under a ceiling' : near ? `${num(near)} within a fifth of the ceiling` : 'all comfortably under their ceilings'}</div>
      </div>
    </div>`
}

function leakRow(p: Page): string {
  const n = p.d.overruns
  return `<div class="leak frame${n > 0 ? ' bad' : ''}">
      <div class="leak-n">${num(n)}</div>
      <div class="leak-t">
        <b>Leaked past a ceiling · all time</b>
        <p>${n > 0
          ? 'Calls that ran after their task was already at its limit, because preflight was skipped or the estimate came in low. The one number here that should be zero.'
          : 'Nothing has run past a ceiling. The one number here that should stay at zero, and it has.'}</p>
      </div>
      ${n > 0 ? `<a href="${href(p, 'refusals', { only: 'leaks' })}">See the ${n === 1 ? 'call' : 'calls'} &rarr;</a>` : ''}
    </div>`
}

// Two rows, one series each, one scale each, one x-axis. The label column is
// the legend: each row is single-series and named, so no swatch box is needed.
function chartBlock(series: Series[]): string {
  const n = series.length
  const unitMax = Math.max(...series.map((s) => s.units), 0)
  const blockMax = Math.max(...series.map((s) => s.blocks), 0)
  const top = niceMax(unitMax)
  const peakI = unitMax > 0 ? series.findIndex((s) => s.units === unitMax) : -1
  const peakB = blockMax > 0 ? series.findIndex((s) => s.blocks === blockMax) : -1
  const edge = (i: number) => (i < 3 ? ' l' : i >= n - 3 ? ' r' : '')
  const tip = (s: Series) => `${fmtDay(s.day)} · ${num(s.units)} units metered · ${num(s.blocks)} refused`
  const dense = n > 31 ? ' dense' : ''
  const cols = series.map((s, i) => {
    const h = s.units > 0 ? Math.max(2, Math.round((s.units / top) * 100)) : 0
    return `<div class="col${edge(i)}${i === peakI ? ' peak' : ''}${h >= 80 ? ' tall' : ''}" data-t="${esc(tip(s))}" data-v="${num(s.units)}">${h ? `<i style="height:${h}%"></i>` : '<i class="zero"></i>'}</div>`
  }).join('')
  const bcols = series.map((s, i) => {
    const h = s.blocks > 0 ? Math.max(4, Math.round((s.blocks / Math.max(1, blockMax)) * 100)) : 0
    return `<div class="col${edge(i)}${i === peakB ? ' peak' : ''}" data-t="${esc(tip(s))}" data-v="${num(s.blocks)}">${h ? `<i class="held" style="height:${h}%"></i>` : '<i class="zero"></i>'}</div>`
  }).join('')
  // The last day is always labelled and the rest step back from it.
  const stride = n <= 7 ? 1 : n <= 31 ? 7 : 15
  let nth = 0
  const xs = series.map((s, i) => {
    const on = (n - 1 - i) % stride === 0
    // Every other labelled column is .alt, so a phone can hide half the labels
    // of a daily or ninety-day axis without hiding two neighbours.
    const alt = on && nth++ % 2 === 1 ? ' class="alt"' : ''
    return `<span${alt}>${on ? esc(fmtDay(s.day)) : ''}</span>`
  }).join('')
  return `<div class="chart frame">
      <div class="crow">
        <div class="clab"><b>Units metered</b><span>${unitMax > 0 ? `peak ${num(unitMax)} on ${esc(fmtDay(series[peakI].day))}` : 'nothing metered yet'}</span></div>
        <div class="cplot">
          <div class="cgrid"><span data-y="${num(top)}"></span>${Number.isInteger(top / 2) ? `<span data-y="${num(top / 2)}"></span>` : ''}<span data-y="0"></span></div>
          <div class="cbars${dense}">${cols}</div>
        </div>
      </div>
      <div class="crow">
        <div class="clab held"><b>Refused</b><span>${blockMax > 0 ? `peak ${num(blockMax)} a day` : 'none in this window'}</span></div>
        <div class="cplot"><div class="cbars strip${dense}">${bcols}</div></div>
      </div>
      <div class="cx"><span></span><div class="${dense.trim()}${stride === 1 ? ' x1' : ''}">${xs}</div></div>
    </div>`
}

function activityTable(series: Series[]): string {
  const rows = [...series].reverse().map((s) => `<tr${s.units === 0 && s.blocks === 0 ? ' class="zero"' : ''}>
      <td class="when">${esc(fmtDay(s.day))} <span class="dim">${esc(new Date(`${s.day}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }))}</span></td>
      <td class="num">${num(s.units)}</td>
      <td class="num">${num(s.blocks)}</td>
      <td class="num">${num(s.refused)}</td>
    </tr>`).join('')
  return `<div class="frame tw days"><table>
    <thead><tr><th>Day</th><th class="num">Metered</th><th class="num">Refused</th><th class="num">Refused units</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`
}

function taskRow(p: Page, t: TaskRow): string {
  const ceiling = Number(t.ceilingUnits)
  const used = Number(t.usedUnits)
  const reserved = Number(t.reservedUnits)
  const remaining = Math.max(0, ceiling - used - reserved)
  const usedPct = Math.min(100, (used / ceiling) * 100)
  const resPct = Math.min(100 - usedPct, (reserved / ceiling) * 100)
  // Same two tests the homepage panel applies: the chip reads the settled
  // number, the bar colour reads settled plus in-flight. Keep them identical.
  const ratio = (used + reserved) / ceiling
  // Above the ceiling is not the ceiling holding. tasks.ts derives exceeded
  // as used > ceiling, and a record can land past the ceiling when preflight
  // was skipped; that is the leak the overview counts, so it is red here too.
  const leaked = used > ceiling
  const cls = leaked ? 'fail' : ratio >= 1 ? 'held' : ratio >= 0.8 ? 'near' : ''
  const state = leaked
    ? '<span class="chip fail">leaked</span>'
    : used >= ceiling
      ? '<span class="chip held">ceiling hit</span>'
      : ratio >= 0.8 ? '<span class="chip near">close</span>' : '<span class="chip flow">running</span>'
  return `<div class="brow">
      <div class="bhead">
        <div class="btask"><a href="${href(p, 'refusals', { task: t.taskRef })}" title="Refusals for this task">${esc(t.taskRef)}</a> <span class="bagent">· ${esc(t.agentId)}</span></div>
        <div class="bnum"><span><b>${num(used)}</b> / ${num(ceiling)}</span>${state}</div>
      </div>
      <div class="track" aria-hidden="true">
        <i class="used ${cls}" style="width:${usedPct.toFixed(1)}%"></i>
        <i class="res" style="width:${resPct.toFixed(1)}%"></i>
      </div>
      <div class="bfoot">
        <span>${leaked ? `${num(used - ceiling)} past the ceiling` : `${num(remaining)} left`}${reserved > 0 ? ` · ${num(reserved)} reserved in flight` : ''}</span>
        <span>${rel(t.updatedAt)}</span>
      </div>
    </div>`
}

function tasksBlock(p: Page, tasks: TaskRow[]): string {
  if (tasks.length === 0) {
    return `<div class="frame"><p class="nothing">No task budgets yet. Pass <code>task_ref</code> and <code>task_ceiling</code> on a preflight call and the job shows up here, burning down live.</p></div>`
  }
  return `<div class="frame">${tasks.map((t) => taskRow(p, t)).join('')}</div>`
}

const TASK_KEY = `<div class="key"><span><i></i> spent</span><span><i class="res"></i> reserved by a call in flight</span><span><i class="near"></i> within a fifth of the ceiling</span><span><i class="held"></i> ceiling held: the next call was refused</span><span><i class="fail"></i> leaked past the ceiling</span></div>`

function refusalRows(p: Page, rows: DecisionRow[]): string {
  return rows.map((r) => {
    const leak = r.blocked === false
    const who = `${r.agentId ? `<a href="${href(p, 'refusals', { agent: r.agentId })}">${esc(r.agentId)}</a>` : '<span class="dim">no agent</span>'}${r.taskRef ? ` <span class="dim">&rarr;</span> <a href="${href(p, 'refusals', { task: r.taskRef })}">${esc(r.taskRef)}</a>` : ''}`
    return `<div class="rrow">
      <span class="when" title="${esc(new Date(r.createdAt).toISOString())}">${rel(r.createdAt)}</span>
      <div class="rmain">
        <div class="rtop"><span class="who">${who}</span><span class="chip ${leak ? 'fail' : 'held'}" title="${esc(r.reason)}">${esc(REASON_LABEL[r.reason] ?? r.reason)}</span></div>
        <div class="what${leak ? ' bad' : ''}" title="${esc(decisionLine(r))}">${esc(decisionLine(r))}</div>
      </div>
    </div>`
  }).join('')
}

function decisionsTable(p: Page, rows: DecisionRow[], truncated: boolean): string {
  if (rows.length === 0) {
    const filtered = p.filter.task || p.filter.agent || p.filter.only
    return `<div class="frame"><p class="nothing">${filtered
      ? 'Nothing on this account matches this filter.'
      : 'Nothing refused yet. Every call AgentBill refuses lands here with the literal JSON your agent received.'}</p></div>`
  }
  const body = rows.map((r) => {
    const leak = r.blocked === false
    let pretty = r.snapshot
    try { pretty = JSON.stringify(JSON.parse(r.snapshot), null, 2) } catch { /* leave verbatim */ }
    const when = new Date(r.createdAt)
    return `<tr>
      <td class="when" title="${esc(when.toISOString())}">${rel(when)}</td>
      <td class="rule"><span class="chip ${leak ? 'fail' : 'held'}" title="${esc(r.reason)}">${esc(REASON_LABEL[r.reason] ?? r.reason)}</span></td>
      <td class="id" data-l="agent" title="${esc(r.agentId ?? '')}">${r.agentId ? `<a href="${href(p, 'refusals', { agent: r.agentId })}">${esc(r.agentId)}</a>` : '<span class="none">none</span>'}</td>
      <td class="id" data-l="task" title="${esc(r.taskRef ?? '')}">${r.taskRef ? `<a href="${href(p, 'refusals', { task: r.taskRef })}">${esc(r.taskRef)}</a>` : '<span class="none">none</span>'}</td>
      <td class="msg">${esc(decisionLine(r))}</td>
      <td class="body"><details><summary>body</summary><pre>${esc(pretty)}</pre></details></td>
    </tr>`
  }).join('')
  return `<div class="frame tw refusals"><table>
    <thead><tr><th>When</th><th>Rule</th><th>Agent</th><th>Task</th><th>What happened</th><th>What the agent got</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>
  ${truncated ? `<p class="note">The latest 100 of ${num(p.d.decisionMatched)}${p.filter.task || p.filter.agent || p.filter.only ? ' that match' : ''}. The full list is on <code>GET /decisions</code>.</p>` : ''}`
}

function customersTable(p: Page, rows: CustomerRow[], total: number, compact = false): string {
  if (rows.length === 0) {
    return `<div class="frame"><p class="nothing">No customers yet. Pass <code>customer_id</code> on a preflight or record call and each of your end users gets an independent balance here.</p></div>`
  }
  const maxUsed = Math.max(1, ...rows.map((c) => Number(c.usedUnits)))
  const body = rows.map((c) => {
    const used = Number(c.usedUnits)
    const limit = c.limitUnits == null ? null : Number(c.limitUnits)
    const share = total > 0 ? Math.round((used / total) * 100) : 0
    const fill = Math.round((used / maxUsed) * 100)
    const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0
    const cls = limit && used >= limit ? 'held' : pct >= 80 ? 'near' : ''
    // A customer at their limit is a limit that held, not an incident.
    const status = limit && used >= limit
      ? '<span class="chip held">at limit</span>'
      : '<span class="chip flow">ok</span>'
    return `<tr>
      <td class="id lead" title="${esc(c.customerRef)}">${esc(c.customerRef)}</td>
      <td class="wide"><div class="share"><span class="sbar"><i class="${cls}" style="width:${Math.max(2, fill)}%"></i></span><span>${share}% of spend</span></div></td>
      <td class="num" data-l="used">${num(used)}</td>
      <td class="num" data-l="limit">${limit == null ? '<span class="dim">no limit</span>' : num(limit)}</td>
      <td class="num" data-l="left">${limit == null ? '<span class="dim">no limit</span>' : num(Math.max(0, limit - used))}</td>
      <td class="state">${status}</td>
    </tr>`
  }).join('')
  return `<div class="frame tw cards"><table>
    <thead><tr><th>Customer</th><th>Share of spend${compact ? '' : ' · all customers'}</th><th class="num">Used</th><th class="num">Limit</th><th class="num">Left</th><th>State</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>`
}

function keysTable(rows: KeyRow[], viewerKey: string): string {
  if (rows.length === 0) return `<div class="frame"><p class="nothing">No keys on this account.</p></div>`
  const now = Date.now()
  const body = rows.map((k) => {
    const mine = k.apiKey === viewerKey
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
      <td class="id lead">${esc(mask)}</td>
      <td class="wide">${k.label ? esc(k.label) : '<span class="none">no label</span>'}${mine ? ' <span class="chip flow" title="The key that opened this console">this session</span>' : ''}</td>
      <td class="state">${chip}</td>
      <td class="when" data-l="created">${rel(k.createdAt)}</td>
      <td class="when" data-l="expires">${k.expiresAt ? rel(k.expiresAt) : '<span class="none">never</span>'}</td>
      <td class="when" data-l="last seen from">${k.lastSeenIp ? esc(k.lastSeenIp) : '<span class="none">unused</span>'}</td>
    </tr>`
  }).join('')
  return `<div class="frame tw cards"><table>
    <thead><tr><th>Key</th><th>Label</th><th>State</th><th>Created</th><th>Expires</th><th>Last seen from</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>`
}

// The four rules, in the order src/routes/preflight.ts evaluates them. Every
// sentence here was read against that file; if the two ever disagree,
// preflight.ts is right and this is the bug.
function limitsBlock(p: Page, rangeLabel: string): string {
  const v = p.demo ? { ...DEMO_VIEWER, accountId: p.v.accountId } : p.v
  const d = p.d
  const { limit, pct } = planOf(v)
  const by = (k: string) => d.byReason[k] ?? 0
  const planRefused = by('free_tier_exceeded') + by('plan_limit_exceeded')
  const withLimit = d.customerWithLimit
  const unlimited = d.customerCount - withLimit
  const live = d.taskLive
  const inWin = ` · last ${esc(rangeLabel)}`
  const refusedLine = (n: number) => `<span><b class="${n ? 'held' : ''}">${num(n)}</b> refused${inWin}</span>`
  const born = v.defaultBudgetUnits == null
    ? 'with no limit, because this account has no default balance set'
    : `with <b>${num(v.defaultBudgetUnits)} units</b>, the account default`
  return `<div class="frame">
      <div class="lim">
        <div class="n">01</div>
        <div>
          <h3>Per request</h3>
          <div class="param">ceiling · on any preflight</div>
          <p>Checked first, with no database read. A call whose <code>estimated_units</code> exceed its <code>ceiling</code> is refused with <code>ceiling_exceeded</code> and reserves nothing.</p>
        </div>
        <div class="live">${refusedLine(by('ceiling_exceeded'))}</div>
      </div>
      <div class="lim">
        <div class="n">02</div>
        <div>
          <h3>Plan quota</h3>
          <div class="param">${esc(v.plan)} plan · preflight calls per calendar month</div>
          <p>${limit === null
            ? 'No monthly cap on this plan. Every call is metered instead.'
            : `<b>${num(limit)}</b> preflight calls a month, counted and rolled inside the same transaction that reserves, so concurrent calls at the line cannot all pass. Past it the call is refused with <code>${v.plan === 'free' ? 'free_tier_exceeded' : 'plan_limit_exceeded'}</code> and an <code>upgrade_url</code>.`}</p>
        </div>
        <div class="live">
          ${limit === null ? `<span><b>${num(v.monthlyCalls)}</b> calls this month</span>` : `<span><b class="${pct >= 90 ? 'fail' : ''}">${num(v.monthlyCalls)}</b> of ${num(limit)} this month · ${pct}%</span>`}
          ${refusedLine(planRefused)}
          ${limit !== null && pct >= 75 ? `<a href="/pricing?account_id=${encodeURIComponent(v.accountId)}">Raise the ceiling &rarr;</a>` : ''}
        </div>
      </div>
      <div class="lim">
        <div class="n">03</div>
        <div>
          <h3>Per customer</h3>
          <div class="param">customer_id · one balance each</div>
          <p>A customer is created the first time its id is seen, ${born}, and its limit does not change after that. Calls without a <code>customer_id</code> share the customer named <code>default</code>. The reservation is atomic: used, reserved and the estimate must fit under the limit together, or the call is refused with <code>budget_exhausted</code>.</p>
        </div>
        <div class="live">
          <span><b>${num(withLimit)}</b> ${withLimit === 1 ? 'customer' : 'customers'} with a limit${unlimited ? ` · <b>${num(unlimited)}</b> without` : ''}</span>
          ${refusedLine(by('budget_exhausted'))}
          ${d.customerCount ? `<a href="${href(p, 'customers')}">Balances &rarr;</a>` : ''}
        </div>
      </div>
      <div class="lim">
        <div class="n">04</div>
        <div>
          <h3>Per task</h3>
          <div class="param">task_ref + task_ceiling · one ceiling for one job</div>
          <p>Every call and tool that shares a <code>task_ref</code> is checked against one ceiling, fixed by the first preflight of that task; later <code>task_ceiling</code> values are ignored. A task preflight has never seen must carry a ceiling or the call is rejected with <code>task_ceiling_required</code>. Refused with <code>task_ceiling_exceeded</code>. A record that lands past the ceiling after the call ran is kept as a leak, not hidden.</p>
        </div>
        <div class="live">
          <span><b>${num(live)}</b> ${live === 1 ? 'task' : 'tasks'} under a ceiling now</span>
          ${refusedLine(by('task_ceiling_exceeded'))}
          <span><b class="${d.overruns ? 'fail' : ''}">${num(d.overruns)}</b> leaked · all time</span>
          ${d.taskCount ? `<a href="${href(p, 'tasks')}">Burn-down &rarr;</a>` : ''}
        </div>
      </div>
    </div>
    <p class="note">Every ceiling above is set by the calling code, per request, and read here. Nothing on this page edits one. <code>GET /budget?customer_id=</code> returns a customer's balance and creates it if it is new.</p>`
}

function onboarding(p: Page): string {
  const key = p.v.apiKey
  const curlBlock = `curl -s -X POST https://agentbill.dev/preflight -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" -d '{"agent_id":"first-run","estimated_units":5,"ceiling":1}'`
  const curlTask1 = `curl -s -X POST https://agentbill.dev/preflight -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" -d '{"agent_id":"researcher","task_ref":"job-1","task_ceiling":5,"estimated_units":3}'`
  const curlTask2 = `curl -s -X POST https://agentbill.dev/preflight -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" -d '{"agent_id":"researcher","task_ref":"job-1","estimated_units":3}'`
  return `<div class="empty frame">
      <h2>Nothing here yet, and that is the honest state.</h2>
      <p>A refusal only happens when a call is checked first. This one asks for 5 units against a ceiling of 1, so it is refused before anything runs.</p>
      <ol>
        <li>Paste it in a terminal. It carries your key.</li>
        <li>Reload this page. The refusal is the first row.</li>
      </ol>
      <pre>${esc(curlBlock)}</pre>
      <p>You get back <span class="out">{"approved":false,"reason":"ceiling_exceeded",…}</span> and the overview fills in.</p>
      <details>
        <summary>A real one: a job that dies at 5 units across calls</summary>
        <p style="margin-top:10px">The first call opens the task with its ceiling and reserves 3. The second asks for 3 more, 3 + 3 &gt; 5, and is refused. The ceiling holds across every call and tool that shares the task_ref.</p>
        <pre>${esc(curlTask1)}</pre>
        <pre>${esc(curlTask2)}</pre>
      </details>
      <p style="margin:16px 0 0"><a href="${href(p, 'overview', { demo: true })}">Show me the console with sample data &rarr;</a></p>
    </div>`
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function overviewView(p: Page, rangeLabel: string): string {
  const d = p.d
  const virgin = !p.demo && d.customers.length === 0 && d.tasks.length === 0 && d.overruns === 0 &&
                 Object.keys(d.byReason).length === 0 && d.series.every((s) => s.units === 0 && s.blocks === 0) &&
                 d.decisions.length === 0 && !p.filter.task && !p.filter.agent
  if (virgin) {
    return `${onboarding(p)}
    <h2 id="limits">What refuses a call on this account, today <span>in the order preflight checks it</span></h2>
    ${limitsBlock(p, rangeLabel)}`
  }
  const latest = d.decisions.slice(0, 5)
  const topCustomers = d.customers.slice(0, 5)
  return `${kpis(p, rangeLabel)}
    ${leakRow(p)}

    <h2>Activity <a href="${href(p, 'activity')}">Day by day &rarr;</a></h2>
    ${chartBlock(d.series)}

    <div class="duo" style="margin-top:var(--s7)">
      <div>
        <h2>Recent tasks <a href="${href(p, 'tasks')}">All ${d.taskCount ? num(d.taskCount) + ' ' : ''}&rarr;</a></h2>
        ${tasksBlock(p, d.tasks.slice(0, 4))}
      </div>
      <div>
        <h2>Latest refusals <a href="${href(p, 'refusals')}">All ${d.decisionTotal ? num(d.decisionTotal) + ' ' : ''}&rarr;</a></h2>
        <div class="frame">${latest.length ? refusalRows(p, latest) : '<p class="nothing">Nothing refused yet.</p>'}</div>
      </div>
    </div>

    <h2>Customers by spend <a href="${href(p, 'customers')}">All ${d.customerCount ? num(d.customerCount) + ' ' : ''}&rarr;</a></h2>
    ${customersTable(p, topCustomers, d.customerTotal, true)}`
}

function activityView(p: Page, rangeLabel: string): string {
  return `${chartBlock(p.d.series)}
    <h2>Day by day <span>the last ${esc(rangeLabel)}, newest first</span></h2>
    ${activityTable(p.d.series)}`
}

function tasksView(p: Page): string {
  return `${tasksBlock(p, p.d.tasks)}
    ${p.d.tasks.length ? TASK_KEY : ''}
    <p class="note">${p.d.taskCount > p.d.tasks.length ? `The ${num(p.d.tasks.length)} most recently touched of ${num(p.d.taskCount)} tasks.` : `${num(p.d.taskCount)} ${p.d.taskCount === 1 ? 'task' : 'tasks'}, most recently touched first.`} The full attribution is on <code>GET /tasks</code> and <code>GET /tasks/:task_ref</code>.</p>`
}

function refusalsView(p: Page): string {
  const f = p.filter
  const chips: string[] = []
  if (f.task) chips.push(`<span class="chip-f">task <b>${esc(f.task)}</b></span>`)
  if (f.agent) chips.push(`<span class="chip-f">agent <b>${esc(f.agent)}</b></span>`)
  if (f.only === 'leaks') chips.push(`<span class="chip-f"><b>leaks only</b></span>`)
  const filters = chips.length
    ? `<div class="filters">Showing ${chips.join(' ')} <a href="${href(p, 'refusals')}">Clear</a></div>`
    : ''
  return `${filters}
    ${decisionsTable(p, p.d.decisions, p.d.truncated)}`
}

function customersView(p: Page): string {
  return `${customersTable(p, p.d.customers, p.d.customerTotal)}
    <p class="note">${p.d.customerCount > p.d.customers.length ? `The ${num(p.d.customers.length)} heaviest of ${num(p.d.customerCount)} customers.` : `${num(p.d.customerCount)} ${p.d.customerCount === 1 ? 'customer' : 'customers'}, heaviest first.`} Share is of every customer's lifetime spend on this account, including any not listed. The full list is on <code>GET /customers</code>.</p>`
}

function keysView(p: Page): string {
  return `${keysTable(p.d.keys, p.v.apiKey)}
    <h2>Manage keys <span>from the API, with any active key</span></h2>
    <div class="frame cmds">
      ${KEY_COMMANDS.map(([ep, what]) =>
        `<div class="cmd"><b>${ep}</b><span>${what}${ep.endsWith('/revoke') ? ' A revoked key ends this session on its next request.' : ''}</span></div>`).join('\n      ')}
    </div>
    <p class="note">${p.anon ? 'Sample keys: neither authenticates anything.' : 'Oldest first. The key that opened this console is marked.'}</p>`
}

// ---------------------------------------------------------------------------
// Console page
// ---------------------------------------------------------------------------

function consolePage(p: Page): string {
  const rangeLabel = RANGES[p.range]?.label ?? RANGES[DEFAULT_RANGE].label
  const meta = VIEWS[p.view]

  const banner = p.demo
    ? `<div class="banner">
        <b>Sample data</b>
        <p>${p.anon
            ? 'Every number on this page is invented. This is what the console looks like once your agents are calling preflight. <a href="/register">Get an API key</a> and it fills with your own runs.'
            : `Nothing on this page is from your account. It shows what the console looks like once your agents are calling preflight. <a href="${href(p, p.view, { demo: false })}">Back to your real console</a>.`}</p>
      </div>`
    : ''

  const body = p.view === 'overview' ? overviewView(p, rangeLabel)
    : p.view === 'activity' ? activityView(p, rangeLabel)
    : p.view === 'tasks' ? tasksView(p)
    : p.view === 'refusals' ? refusalsView(p)
    : p.view === 'customers' ? customersView(p)
    : p.view === 'keys' ? keysView(p)
    : limitsBlock(p, rangeLabel)

  return `${HEAD(meta.title)}
<body>
  <div class="shell">
    ${rail(p)}
    <main class="main">
      <div class="wrap">
        <header class="vh">
          <div><h1>${meta.title}</h1><p class="sub">${meta.lede}</p></div>
          ${RANGED.has(p.view) ? periodControl(p) : ''}
        </header>
        ${banner}
        ${body}
        <div class="foot">
          Every number on this page is on the API too:
          <code>GET /decisions</code> for refusals, <code>/tasks</code> for budgets, <code>/customers</code> for balances, <code>/keys</code> for keys, each with <code>Authorization: Bearer &lt;your key&gt;</code>.
        </div>
      </div>
    </main>
  </div>
</body>
</html>`
}
