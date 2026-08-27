import type { FastifyInstance } from 'fastify'
import { createHmac, timingSafeEqual } from 'crypto'
import { getAccountsWithSignals, conversionScore, isHot, FREE_TIER_LIMIT } from '../lib/conversion.js'
import type { AccountSignals } from '../lib/conversion.js'

const WARN_AT = 800
const SESSION_COOKIE = 'agentbill_admin'
const SESSION_MAX_AGE = 7 * 24 * 3_600 // seconds

export async function adminRoute(app: FastifyInstance) {

  // JSON, curl -H "Authorization: Bearer <ADMIN_SECRET>" /admin/accounts
  app.get('/admin/accounts', async (request, reply) => {
    if (!checkAuth(request)) {
      return reply.code(401).send({ error: 'unauthorized' })
    }
    const rows = await getAccountsWithSignals()
    return reply.send(rows.map(a => ({ ...a, conversionScore: conversionScore(a), hot: isHot(a) })))
  })

  // Visual dashboard, session cookie set by POST /admin/login
  app.get('/admin', async (request, reply) => {
    if (!checkAuth(request)) {
      reply.type('text/html')
      return reply.send(loginPage())
    }
    const accounts = await getAccountsWithSignals()
    reply.type('text/html')
    return reply.send(adminPage(accounts))
  })

  // POST /admin/login, form submits secret, sets HttpOnly session cookie.
  // The secret never appears in a URL (query params leak into logs and browser history).
  app.post('/admin/login', async (request, reply) => {
    const body = request.body as Record<string, unknown>
    const secret = typeof body?.secret === 'string' ? body.secret : ''
    const expected = process.env.ADMIN_SECRET ?? ''
    if (!expected || !safeEqual(secret, expected)) {
      reply.type('text/html')
      return reply.send(loginPage('Wrong secret.'))
    }
    reply.header(
      'Set-Cookie',
      `${SESSION_COOKIE}=${sessionToken(expected)}; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=${SESSION_MAX_AGE}`
    )
    return reply.redirect('/admin')
  })
}

// ---------------------------------------------------------------------------
// Auth, accepts Bearer header (curl) OR the session cookie (browser).
// The cookie holds an HMAC derived from ADMIN_SECRET, not the secret itself,
// so rotating the secret invalidates all sessions.
// ---------------------------------------------------------------------------

function sessionToken(secret: string): string {
  return createHmac('sha256', secret).update('agentbill-admin-session').digest('hex')
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB)
}

function readCookie(header: string, name: string): string {
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return ''
}

function checkAuth(request: { headers: { authorization?: string; cookie?: string } }): boolean {
  const expected = process.env.ADMIN_SECRET ?? ''
  if (!expected) return false

  const bearer = (request.headers.authorization ?? '').replace(/^Bearer /, '')
  if (bearer && safeEqual(bearer, expected)) return true

  const cookie = readCookie(request.headers.cookie ?? '', SESSION_COOKIE)
  return cookie !== '' && safeEqual(cookie, sessionToken(expected))
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

const CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0a0a0f; color: #e8e8f0; font-family: 'SF Mono', 'Fira Code', monospace;
         font-size: 14px; padding: 40px 24px; }
  h1 { font-size: 18px; font-weight: 700; color: #a78bfa; margin-bottom: 4px; }
  .sub { font-size: 12px; color: #4b5563; margin-bottom: 32px; }
  .stats { display: flex; gap: 20px; margin-bottom: 32px; flex-wrap: wrap; }
  .stat { background: #111118; border: 1px solid #1f2937; border-radius: 8px;
          padding: 16px 20px; min-width: 130px; }
  .stat-label { font-size: 11px; color: #4b5563; text-transform: uppercase;
                letter-spacing: .08em; margin-bottom: 6px; }
  .stat-value { font-size: 22px; font-weight: 700; color: #e8e8f0; }
  .stat-value.purple { color: #a78bfa; }
  .stat-value.green { color: #22d3a0; }
  .stat-value.yellow { color: #fbbf24; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 10px 12px; color: #4b5563; font-weight: 500;
       border-bottom: 1px solid #1f2937; text-transform: uppercase;
       letter-spacing: .06em; font-size: 11px; }
  td { padding: 11px 12px; border-bottom: 1px solid #111827; vertical-align: middle; }
  tr:hover td { background: #111118; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px;
           font-size: 11px; font-weight: 700; }
  .badge.free { background: #1f2937; color: #9ca3af; }
  .badge.paid { background: #052e16; color: #4ade80; }
  .badge.warn { background: #422006; color: #fbbf24; }
  .bar-wrap { background: #1f2937; border-radius: 3px; height: 5px;
              width: 80px; display: inline-block; vertical-align: middle;
              margin-right: 6px; overflow: hidden; }
  .bar { height: 100%; border-radius: 3px; background: #6c63ff; }
  .bar.warn { background: #fbbf24; }
  .bar.full { background: #ef4444; }
  .mono { color: #a78bfa; }
  .muted { color: #4b5563; }
  .none { color: #374151; font-style: italic; }
  a { color: #6c63ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .warn-row td { background: #1c1408 !important; }
`

function loginPage(error = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>AgentBill Admin</title>
  <style>
    ${CSS}
    .login { max-width: 360px; margin: 80px auto; background: #111118;
             border: 1px solid #1f2937; border-radius: 10px; padding: 32px; }
    input { width: 100%; background: #0a0a0f; border: 1px solid #1f2937; border-radius: 6px;
            padding: 10px 12px; color: #e8e8f0; font-family: inherit; font-size: 14px;
            margin: 12px 0 16px; outline: none; }
    input:focus { border-color: #6c63ff; }
    button { width: 100%; background: #6c63ff; color: #fff; border: none; border-radius: 6px;
             padding: 11px; font-size: 14px; font-weight: 700; cursor: pointer; font-family: inherit; }
    button:hover { background: #8b5cf6; }
    .err { color: #ef4444; font-size: 12px; margin-bottom: 12px; }
  </style>
</head>
<body>
  <div class="login">
    <h1>AgentBill Admin</h1>
    <p class="sub" style="margin-bottom:20px">Owner access only.</p>
    ${error ? `<p class="err">${error}</p>` : ''}
    <form method="POST" action="/admin/login">
      <label style="font-size:12px;color:#4b5563">ADMIN SECRET</label>
      <input type="password" name="secret" placeholder="••••••••" autofocus />
      <button type="submit">Sign in →</button>
    </form>
  </div>
</body>
</html>`
}

function adminPage(accounts: AccountSignals[]) {
  const total = accounts.length
  const paid = accounts.filter(a => a.plan !== 'free').length
  const hot = accounts.filter(isHot).length
  const weekAgo = Date.now() - 7 * 24 * 3_600_000
  const new7d = accounts.filter(a => new Date(a.createdAt).getTime() > weekAgo).length
  const totalCalls = accounts.reduce((s, a) => s + (a.monthlyCalls ?? 0), 0)

  // Hot accounts first, then by score, then newest. The table IS the call list.
  const sorted = [...accounts].sort((a, b) =>
    (Number(isHot(b)) - Number(isHot(a))) ||
    (conversionScore(b) - conversionScore(a)) ||
    (new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()))

  const rel = (iso: string | null) => {
    if (!iso) return '<span class="none">never</span>'
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
    if (mins < 60) return `${mins}m ago`
    if (mins < 2880) return `${Math.round(mins / 60)}h ago`
    return `${Math.round(mins / 1440)}d ago`
  }

  const rows = sorted.map(a => {
    const calls = a.monthlyCalls ?? 0
    const score = conversionScore(a)
    const hotRow = isHot(a)
    const pct = Math.min(100, Math.round(calls / FREE_TIER_LIMIT * 100))
    const isWarn = calls >= WARN_AT && a.plan === 'free'
    const isFull = calls >= FREE_TIER_LIMIT && a.plan === 'free'
    const barClass = isFull ? 'full' : isWarn ? 'warn' : ''
    const callBadge = isWarn
      ? `<span class="badge warn">${calls} / ${FREE_TIER_LIMIT}</span>`
      : `${calls}`

    return `<tr class="${hotRow ? 'warn-row' : ''}" title="${a.name ?? ''}">
      <td>${hotRow ? `<span class="badge warn">&#128293; ${score}</span>` : `<span class="muted">${score}</span>`}</td>
      <td class="mono">${a.email ?? '<span class="none">no email</span>'}</td>
      <td><span class="badge ${a.plan === 'free' ? 'free' : 'paid'}">${a.plan}</span></td>
      <td>
        <span class="bar-wrap"><span class="bar ${barClass}" style="width:${pct}%"></span></span>
        ${callBadge}
      </td>
      <td class="muted">${a.taskCount}</td>
      <td class="muted">${rel(a.lastActivityAt)}</td>
      <td class="muted">${a.customerCount}</td>
      <td>${a.stack ?? '<span class="muted">-</span>'}</td>
      <td>${a.useCase ?? '<span class="muted">-</span>'}</td>
      <td class="muted">${new Date(a.createdAt).toLocaleDateString('en-GB', {day:'2-digit',month:'short',year:'2-digit'})}</td>
    </tr>`
  }).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>AgentBill Admin</title>
  <style>${CSS}</style>
</head>
<body>
  <h1>AgentBill Admin</h1>
  <p class="sub">Conversion radar: hot accounts first, sorted by likelihood to pay. Refresh to update.</p>

  <div class="stats">
    <div class="stat">
      <div class="stat-label">Total accounts</div>
      <div class="stat-value purple">${total}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Paid</div>
      <div class="stat-value green">${paid}</div>
    </div>
    <div class="stat">
      <div class="stat-label">&#128293; Hot (likely to pay)</div>
      <div class="stat-value yellow">${hot}</div>
    </div>
    <div class="stat">
      <div class="stat-label">New (7 days)</div>
      <div class="stat-value purple">${new7d}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Total calls this month</div>
      <div class="stat-value">${totalCalls.toLocaleString()}</div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Score</th>
        <th>Email</th>
        <th>Plan</th>
        <th>Monthly calls</th>
        <th>Tasks</th>
        <th>Last active</th>
        <th>Customers</th>
        <th>Stack</th>
        <th>Use case</th>
        <th>Registered</th>
      </tr>
    </thead>
    <tbody>
      ${rows || '<tr><td colspan="10" class="none" style="padding:24px">No accounts yet.</td></tr>'}
    </tbody>
  </table>
</body>
</html>`
}
