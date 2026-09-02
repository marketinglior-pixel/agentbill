import type { FastifyInstance, FastifyRequest } from 'fastify'
import { createHmac, timingSafeEqual } from 'crypto'
import { sql } from '../db/index.js'
import { PLAN_LIMITS } from '../integrations/polar.js'
import { clientIp } from '../lib/client-ip.js'

// /app is the receipt: every call AgentBill refused on this account's behalf,
// with the literal response the agent received. It is the only browser
// surface a registered user has, and its first job is the empty state: a
// one-line curl that gets refused before anything runs.
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
  app.get('/app', async (request, reply) => {
    reply.type('text/html').header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
    const viewer = await loadSession(request)
    if (!viewer) {
      const q = request.query as Record<string, unknown>
      return reply.send(loginPage(typeof q?.err === 'string' ? q.err : ''))
    }
    return reply.send(await receiptPage(viewer))
  })

  // The canonical-host redirect preserves a trailing slash; without this the
  // 404 handler's Bearer hook would answer /app/ with a JSON 401.
  app.get('/app/', async (_request, reply) => reply.redirect('/app', 301))

  app.post('/app/session', async (request, reply) => {
    if (!sameOrigin(request)) return reply.code(403).send({ error: 'forbidden' })
    if (!allowLogin(clientIp(request))) return reply.redirect('/app?err=rate', 303)
    const secret = sessionSecret()
    if (!secret) return reply.redirect('/app?err=unavailable', 303)

    const body = request.body as Record<string, unknown>
    const key = typeof body?.api_key === 'string' ? body.api_key.trim() : ''
    if (!/^[A-Za-z0-9_-]{8,200}$/.test(key)) return reply.redirect('/app?err=key', 303)

    const [row] = await sql`
      SELECT id, revoked_at, expires_at
      FROM developer_api_keys
      WHERE api_key = ${key}
      LIMIT 1
    `
    const now = new Date()
    if (!row) return reply.redirect('/app?err=key', 303)
    if (row.revokedAt && new Date(row.revokedAt) <= now) return reply.redirect('/app?err=revoked', 303)
    if (row.expiresAt && new Date(row.expiresAt) <= now) return reply.redirect('/app?err=expired', 303)

    reply.header(
      'Set-Cookie',
      `${COOKIE}=${mintToken(row.id as string, secret)}; HttpOnly; Secure; SameSite=Lax; Path=/app; Max-Age=${MAX_AGE}`,
    )
    return reply.redirect('/app', 303)
  })

  app.post('/app/logout', async (request, reply) => {
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
    SELECT k.id AS key_id, k.api_key, k.label, k.revoked_at, k.expires_at,
           a.id AS account_id, a.email, a.plan, a.monthly_calls
    FROM developer_api_keys k
    JOIN accounts a ON a.id = k.account_id
    WHERE k.id = ${keyId}
    LIMIT 1
  `
  if (!row) return null
  const now = new Date()
  if (row.revokedAt && new Date(row.revokedAt) <= now) return null
  if (row.expiresAt && new Date(row.expiresAt) <= now) return null
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
function sameOrigin(request: FastifyRequest): boolean {
  const sfs = request.headers['sec-fetch-site']
  if (typeof sfs === 'string' && sfs !== 'same-origin' && sfs !== 'none') return false
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
// HTML
// ---------------------------------------------------------------------------

function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

function rel(iso: string | Date | null): string {
  if (!iso) return '<span class="none">never</span>'
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 2880) return `${Math.round(mins / 60)}h ago`
  return `${Math.round(mins / 1440)}d ago`
}

const REASON_LABEL: Record<string, string> = {
  ceiling_exceeded: 'ceiling',
  task_ceiling_exceeded: 'task ceiling',
  budget_exhausted: 'budget',
  free_tier_exceeded: 'free tier',
  plan_limit_exceeded: 'plan limit',
  task_overrun_recorded: 'got through',
}

const CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root { --bg: #0a0a0a; --surface: #111111; --surface2: #161616; --border: #232323;
          --text: #e8ebe9; --muted: #a0a8a3; --dim: #6b736e; --green: #22d3a0;
          --code: #a8ff78; --red: #ff5757; --amber: #f5b942; }
  body { background: var(--bg); color: var(--text); font-family: 'Inter', system-ui, sans-serif;
         font-size: 15px; line-height: 1.55; -webkit-font-smoothing: antialiased; }
  .mono { font-family: 'JetBrains Mono', 'Courier New', monospace; }
  a { color: var(--green); }
  nav { height: 60px; border-bottom: 1px solid var(--border); display: flex; align-items: center;
        justify-content: space-between; padding: 0 24px; }
  .logo { display: flex; align-items: center; gap: 9px; font-family: 'JetBrains Mono', monospace;
          font-weight: 700; font-size: 16px; color: var(--text); text-decoration: none; }
  .dot { width: 8px; height: 8px; background: var(--green); border-radius: 50%; }
  .who { display: flex; align-items: center; gap: 14px; font-family: 'JetBrains Mono', monospace;
         font-size: 12px; color: var(--dim); }
  .who b { color: var(--muted); font-weight: 500; }
  .btn-out { background: none; border: 1px solid var(--border); color: var(--muted); border-radius: 6px;
             padding: 6px 11px; font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; }
  .btn-out:hover { color: var(--text); border-color: var(--dim); }
  .wrap { max-width: 1040px; margin: 0 auto; padding: 36px 24px 80px; }
  h1 { font-family: 'JetBrains Mono', monospace; font-size: 26px; font-weight: 700;
       letter-spacing: -.02em; margin-bottom: 6px; }
  .sub { color: var(--muted); max-width: 66ch; margin-bottom: 8px; }
  .quota { font-family: 'JetBrains Mono', monospace; font-size: 12.5px; color: var(--dim);
           margin-bottom: 28px; font-variant-numeric: tabular-nums; }
  .quota b { color: var(--muted); font-weight: 500; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px;
           margin-bottom: 10px; }
  .tile { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px 18px; }
  .tl { font-family: 'JetBrains Mono', monospace; font-size: 10.5px; letter-spacing: .12em;
        text-transform: uppercase; color: var(--dim); }
  .tv { font-family: 'JetBrains Mono', monospace; font-size: 26px; font-weight: 700; margin-top: 6px;
        font-variant-numeric: tabular-nums; }
  .tv.green { color: var(--green); } .tv.amber { color: var(--amber); } .tv.dim { color: var(--muted); font-size: 18px; margin-top: 12px; }
  .honest { font-size: 12.5px; color: var(--dim); margin-bottom: 8px; max-width: 80ch; }
  h2 { font-family: 'JetBrains Mono', monospace; font-size: 12px; font-weight: 700; letter-spacing: .1em;
       text-transform: uppercase; color: var(--dim); margin: 36px 0 12px; padding-bottom: 8px;
       border-bottom: 1px solid var(--border); }
  .tw { overflow-x: auto; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); }
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th { text-align: left; padding: 10px 14px; color: var(--dim); font-weight: 500; font-size: 11px;
       text-transform: uppercase; letter-spacing: .08em; border-bottom: 1px solid var(--border);
       white-space: nowrap; font-family: 'JetBrains Mono', monospace; }
  td { padding: 11px 14px; border-bottom: 1px solid var(--border); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  td.num { font-family: 'JetBrains Mono', monospace; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.id { font-family: 'JetBrains Mono', monospace; font-size: 12.5px; white-space: nowrap; max-width: 280px;
          overflow: hidden; text-overflow: ellipsis; }
  .chip { display: inline-block; font-family: 'JetBrains Mono', monospace; font-size: 10.5px; font-weight: 700;
          letter-spacing: .06em; text-transform: uppercase; padding: 3px 8px; border-radius: 4px; white-space: nowrap; }
  .chip.block { background: #2a1212; color: #ff8a80; border: 1px solid #4a1d1d; }
  .chip.leak  { background: #2b220e; color: var(--amber); border: 1px solid #4a3a12; }
  .muted { color: var(--muted); } .dim { color: var(--dim); } .none { color: var(--dim); font-style: italic; }
  details summary { cursor: pointer; color: var(--green); font-family: 'JetBrains Mono', monospace;
                    font-size: 12px; list-style: none; }
  details summary::-webkit-details-marker { display: none; }
  details summary::before { content: '▸ '; } details[open] summary::before { content: '▾ '; }
  pre { background: #0d0d0d; border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px;
        font-family: 'JetBrains Mono', monospace; font-size: 12.5px; line-height: 1.55; overflow-x: auto;
        color: var(--code); margin-top: 10px; }
  .empty { background: var(--surface); border: 1px dashed #333; border-radius: 12px; padding: 28px; margin-top: 18px; }
  .empty h3 { font-family: 'JetBrains Mono', monospace; font-size: 16px; margin-bottom: 8px; }
  .empty p { color: var(--muted); margin-bottom: 14px; max-width: 66ch; }
  .empty pre { margin: 0 0 14px; white-space: pre-wrap; word-break: break-all; }
  .empty details { margin-top: 6px; }
  .foot { margin-top: 44px; padding-top: 18px; border-top: 1px solid var(--border); color: var(--dim); font-size: 13px; }
  .foot code { font-family: 'JetBrains Mono', monospace; font-size: 12px; color: var(--muted); }
  .login { max-width: 460px; margin: 80px auto; background: var(--surface); border: 1px solid var(--border);
           border-radius: 12px; padding: 32px; }
  .login p { color: var(--muted); font-size: 14px; margin-bottom: 18px; }
  label { display: block; font-family: 'JetBrains Mono', monospace; font-size: 11px; letter-spacing: .1em;
          text-transform: uppercase; color: var(--dim); margin-bottom: 8px; }
  input { width: 100%; background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
          padding: 11px 12px; color: var(--text); font-family: 'JetBrains Mono', monospace; font-size: 14px;
          margin-bottom: 14px; outline: none; }
  input:focus { border-color: var(--green); }
  .btn { width: 100%; background: var(--green); color: #05130e; border: none; border-radius: 6px;
         padding: 12px; font: inherit; font-size: 15px; font-weight: 700; cursor: pointer; }
  .btn:hover { filter: brightness(1.08); }
  .err { color: var(--red); font-size: 13px; margin-bottom: 12px; }
  .fine { font-size: 12.5px; color: var(--dim); margin-top: 16px; }
  @media (max-width: 640px) { nav { padding: 0 16px; } .wrap { padding: 24px 16px 60px; } .who span.email, .who .dim { display: none; } }
`

const HEAD = (title: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="robots" content="noindex" />
  <title>${esc(title)} · AgentBill</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet" />
  <style>${CSS}</style>
</head>`

const ERRORS: Record<string, string> = {
  key: 'That key was not found. It starts with agb_ and comes from /register.',
  revoked: 'That key has been revoked. Generate a new one with POST /keys/generate.',
  expired: 'That key has expired. Generate a new one with POST /keys/generate.',
  rate: 'Too many attempts from this address. Try again in 15 minutes.',
  unavailable: 'Sign-in is not configured on this server.',
}

function loginPage(err: string): string {
  return `${HEAD('Your receipt')}
<body>
  <nav><a class="logo" href="/"><span class="dot"></span>AgentBill</a></nav>
  <div class="login">
    <h1 style="font-size:22px">Your receipt</h1>
    <p>Every call AgentBill refused on your behalf, with the exact response your agent got. Paste the API key from <a href="/register">/register</a>.</p>
    ${Object.hasOwn(ERRORS, err) ? `<p class="err">${esc(ERRORS[err])}</p>` : ''}
    <form method="POST" action="/app/session" autocomplete="off">
      <label for="api_key">API key</label>
      <input id="api_key" name="api_key" type="password" placeholder="agb_..." autofocus required />
      <button class="btn" type="submit">Open receipt &rarr;</button>
    </form>
    <p class="fine">The key is exchanged for an HttpOnly cookie that lasts 7 days and dies with the key. This page loads no third-party scripts.</p>
  </div>
</body>
</html>`
}

async function receiptPage(v: Viewer): Promise<string> {
  const [t] = await sql`
    SELECT count(*) FILTER (WHERE blocked)                             AS blocked,
           count(*) FILTER (WHERE NOT blocked)                         AS overruns,
           coalesce(sum(estimated_units) FILTER (WHERE blocked), 0)    AS refused_units,
           max(created_at) FILTER (WHERE blocked)                      AS last_block,
           count(DISTINCT agent_id)                                    AS agents
    FROM preflight_decisions
    WHERE account_id = ${v.accountId}
  `
  const rows = await sql`
    SELECT agent_id, customer_ref, task_ref, reason, source, blocked,
           estimated_units, ceiling_units, used_units, snapshot::text AS snapshot, created_at
    FROM preflight_decisions
    WHERE account_id = ${v.accountId}
    ORDER BY created_at DESC, id DESC
    LIMIT 100
  `
  const agents = await sql`
    SELECT coalesce(agent_id, '') AS agent_id,
           count(*) FILTER (WHERE blocked)     AS blocked,
           count(*) FILTER (WHERE NOT blocked) AS overruns,
           max(created_at)                     AS last_seen
    FROM preflight_decisions
    WHERE account_id = ${v.accountId}
    GROUP BY 1
    ORDER BY 2 DESC, 4 DESC
    LIMIT 50
  `

  const blocked = Number(t?.blocked ?? 0)
  const overruns = Number(t?.overruns ?? 0)
  const refused = Number(t?.refusedUnits ?? 0)
  const limit = v.plan === 'paid' ? null : PLAN_LIMITS[v.plan] ?? PLAN_LIMITS.free
  const quota = limit === null
    ? `<b>${esc(v.plan)}</b> · ${v.monthlyCalls.toLocaleString()} calls this month · unlimited`
    : `<b>${esc(v.plan)}</b> · ${v.monthlyCalls.toLocaleString()} / ${limit.toLocaleString()} calls this month`
  const keyTail = v.apiKey.slice(0, 8) + '…' + v.apiKey.slice(-4)

  const empty = rows.length === 0
  const curlBlock = `curl -s -X POST https://agentbill.dev/preflight -H "Authorization: Bearer ${v.apiKey}" -H "Content-Type: application/json" -d '{"agent_id":"first-run","estimated_units":5,"ceiling":1}'`
  const curlTask1 = `curl -s -X POST https://agentbill.dev/preflight -H "Authorization: Bearer ${v.apiKey}" -H "Content-Type: application/json" -d '{"agent_id":"researcher","task_ref":"job-1","task_ceiling":5,"estimated_units":3}'`
  const curlTask2 = `curl -s -X POST https://agentbill.dev/preflight -H "Authorization: Bearer ${v.apiKey}" -H "Content-Type: application/json" -d '{"agent_id":"researcher","task_ref":"job-1","estimated_units":3}'`

  const decisionRows = rows.map((r: any) => {
    const leak = r.blocked === false
    const label = REASON_LABEL[r.reason as string] ?? (r.reason as string)
    let pretty = r.snapshot as string
    try { pretty = JSON.stringify(JSON.parse(r.snapshot), null, 2) } catch { /* leave verbatim */ }
    const when = new Date(r.createdAt)
    return `<tr>
      <td class="num dim" title="${esc(when.toISOString())}">${rel(when)}</td>
      <td><span class="chip ${leak ? 'leak' : 'block'}" title="${esc(r.reason)}">${esc(label)}</span></td>
      <td class="id" title="${esc(r.agentId ?? '')}">${r.agentId ? esc(r.agentId) : '<span class="none">none</span>'}</td>
      <td class="id" title="${esc(r.taskRef ?? '')}">${r.taskRef ? esc(r.taskRef) : '<span class="none">none</span>'}</td>
      <td class="num">${r.estimatedUnits == null ? '<span class="dim">-</span>' : Number(r.estimatedUnits).toLocaleString()}
        <span class="dim">/</span> ${r.ceilingUnits == null ? '<span class="dim">-</span>' : Number(r.ceilingUnits).toLocaleString()}
        <span class="dim">/</span> ${r.usedUnits == null ? '<span class="dim">-</span>' : Number(r.usedUnits).toLocaleString()}</td>
      <td><details><summary>response</summary><pre>${esc(pretty)}</pre></details></td>
    </tr>`
  }).join('')

  const agentRows = agents.map((a: any) => `<tr>
      <td class="id" title="${esc(a.agentId ?? '')}">${a.agentId ? esc(a.agentId) : '<span class="none">none</span>'}</td>
      <td class="num">${Number(a.blocked).toLocaleString()}</td>
      <td class="num ${Number(a.overruns) > 0 ? '' : 'dim'}">${Number(a.overruns).toLocaleString()}</td>
      <td class="num dim">${rel(a.lastSeen)}</td>
    </tr>`).join('')

  return `${HEAD('Your receipt')}
<body>
  <nav>
    <a class="logo" href="/"><span class="dot"></span>AgentBill</a>
    <div class="who">
      <span class="email">${esc(v.email ?? 'no email')}</span>
      <span>key <b>${esc(keyTail)}</b>${v.keyLabel ? ` <span class="dim">(${esc(v.keyLabel)})</span>` : ''}</span>
      <form method="POST" action="/app/logout"><button class="btn-out" type="submit">Sign out</button></form>
    </div>
  </nav>
  <div class="wrap">
    <h1>Your receipt</h1>
    <p class="sub">Every call AgentBill refused on your behalf, newest first, with the exact response your agent got back.</p>
    <p class="quota">${quota}</p>

    <div class="tiles">
      <div class="tile"><div class="tl">Blocked</div><div class="tv green">${blocked.toLocaleString()}</div></div>
      <div class="tile"><div class="tl">Units refused</div><div class="tv">${refused.toLocaleString()}</div></div>
      <div class="tile"><div class="tl">Got through</div><div class="tv ${overruns > 0 ? 'amber' : ''}">${overruns.toLocaleString()}</div></div>
      <div class="tile"><div class="tl">Last block</div><div class="tv dim">${rel(t?.lastBlock ?? null)}</div></div>
    </div>
    <p class="honest">Units refused is what was asked for and denied. It is not a dollar figure: AgentBill cannot know what a run it stopped would have gone on to cost. "Got through" is spend that landed past a task ceiling anyway, because preflight was skipped or the estimate was low. That number should be zero.</p>

    ${empty ? `
    <div class="empty">
      <h3>Nothing on the receipt yet.</h3>
      <p>A block only happens when a call is checked first. This one asks for 5 units against a ceiling of 1, so it is refused before anything runs. Paste it in a terminal, then refresh this page.</p>
      <pre>${esc(curlBlock)}</pre>
      <p>You should get back <span class="mono" style="color:var(--code)">{"approved":false,"reason":"ceiling_exceeded",…}</span> and a first line here.</p>
      <details>
        <summary>A real one: a job that dies at 5 units across calls</summary>
        <p style="margin-top:10px">The first call opens the task with its ceiling and reserves 3. The second asks for 3 more, 3 + 3 &gt; 5, and is refused. The ceiling holds across every call and tool that shares the task_ref.</p>
        <pre>${esc(curlTask1)}</pre>
        <pre>${esc(curlTask2)}</pre>
      </details>
    </div>` : `
    <h2>Refusals</h2>
    <div class="tw"><table>
      <thead><tr><th>When</th><th>Why</th><th>Agent</th><th>Task</th><th>Asked / ceiling / used</th><th>What the agent got</th></tr></thead>
      <tbody>${decisionRows}</tbody>
    </table></div>
    ${rows.length === 100 ? '<p class="honest" style="margin-top:8px">Showing the latest 100. The full list is on <code class="mono">GET /decisions</code>.</p>' : ''}

    <h2>By agent</h2>
    <div class="tw"><table>
      <thead><tr><th>Agent</th><th>Blocked</th><th>Got through</th><th>Last seen</th></tr></thead>
      <tbody>${agentRows}</tbody>
    </table></div>`}

    <div class="foot">
      Machine-readable, same data: <code>curl https://agentbill.dev/decisions -H "Authorization: Bearer &lt;your key&gt;"</code>
    </div>
  </div>
</body>
</html>`
}
