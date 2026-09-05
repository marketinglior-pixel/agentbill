import type { FastifyInstance } from 'fastify'
import { createHmac, timingSafeEqual } from 'crypto'
import { getAccountsWithSignals, conversionScore, isHot, FREE_TIER_LIMIT } from '../lib/conversion.js'
import type { AccountSignals } from '../lib/conversion.js'
import { getPlaygroundPulse } from '../lib/pulse.js'
import type { PlaygroundPulse } from '../lib/pulse.js'
import { publicRoute } from '../middleware/auth.js'
import { head, BP } from '../ui/theme.js'
import { mark, MARK_CSS } from '../ui/mark.js'

const WARN_AT = 800
const SESSION_COOKIE = 'agentbill_admin'
const SESSION_MAX_AGE = 7 * 24 * 3_600 // seconds

export async function adminRoute(app: FastifyInstance) {

  // JSON, curl -H "Authorization: Bearer <ADMIN_SECRET>" /admin/accounts
  app.get('/admin/accounts', publicRoute(), async (request, reply) => {
    if (!checkAuth(request)) {
      return reply.code(401).send({ error: 'unauthorized' })
    }
    const rows = await getAccountsWithSignals()
    return reply.send(rows.map(a => ({ ...a, conversionScore: conversionScore(a), hot: isHot(a) })))
  })

  // Visual dashboard, session cookie set by POST /admin/login
  app.get('/admin', publicRoute(), async (request, reply) => {
    if (!checkAuth(request)) {
      reply.type('text/html').header('Cache-Control', 'no-store').header('X-Robots-Tag', 'noindex, nofollow')
      return reply.send(loginPage())
    }
    const accounts = await getAccountsWithSignals()
    const pulse = await getPlaygroundPulse()
    reply.type('text/html').header('Cache-Control', 'no-store').header('X-Robots-Tag', 'noindex, nofollow')
    return reply.send(adminPage(accounts, pulse))
  })

  // POST /admin/login, form submits secret, sets HttpOnly session cookie.
  // The secret never appears in a URL (query params leak into logs and browser history).
  app.post('/admin/login', publicRoute(), async (request, reply) => {
    const body = request.body as Record<string, unknown>
    const secret = typeof body?.secret === 'string' ? body.secret : ''
    const expected = process.env.ADMIN_SECRET ?? ''
    if (!expected || !safeEqual(secret, expected)) {
      reply.type('text/html').header('Cache-Control', 'no-store').header('X-Robots-Tag', 'noindex, nofollow')
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

// ---------------------------------------------------------------------------
// HTML
//
// This page used to import nothing from src/ui: it carried its own reset, its
// own 38-line stylesheet with 41 raw hexes, Tailwind's default greys, and a
// violet accent in three shades that encoded no state at all, plus mono as the
// BODY face, the codebase's only two emoji, its only !important, four inline
// styles including a negative margin, no viewport meta and not one media query.
// (The hex values are deliberately not quoted here: a raw hex in a comment is
// still a raw hex to the drift ratchet, and this file is meant to reach zero.)
// It was the last surface not on the design system.
//
// It is App family now, which means the console's colour law applies: one
// token, one job. --flow is ordinary traffic, --near is approaching a limit,
// --fail needs a human. There is no "purple" semantic because there was never
// anything for it to mean.
// ---------------------------------------------------------------------------

const CSS = `${MARK_CSS}
  nav.top { height: var(--banner-height); border-bottom: 1px solid var(--border);
            display: flex; align-items: center; justify-content: space-between;
            padding-inline: var(--gutter); gap: var(--s4); }
  nav.top .logo { display: flex; align-items: center; gap: 9px; font-family: var(--mono);
                  font-weight: 700; font-size: 16px; color: var(--text); text-decoration: none; }
  nav.top .who { font-family: var(--mono); font-size: var(--fs-micro); color: var(--dim); }

  .wrap { max-width: 1400px; margin: 0 auto; padding-inline: var(--gutter);
          padding-block: var(--s6) var(--s8); }
  h1 { font-size: var(--fs-h1-app); color: var(--white); margin-bottom: var(--s1); }
  h2 { font-size: var(--fs-h3); color: var(--white); margin: var(--s7) 0 var(--s3); }
  .sub { font-size: var(--fs-small); color: var(--muted); max-width: 78ch; line-height: 1.6; }
  .sub + .stats { margin-top: var(--s5); }

  /* auto-fit, because a flex row of five fixed cards is why this page needed a
     horizontal scrollbar on anything narrower than a laptop. */
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(168px, 1fr));
           gap: var(--s3); margin-block: var(--s3) var(--s5); }
  .stat { background: var(--surface); border: 1px solid var(--border);
          border-radius: var(--r-frame); padding: var(--s4) var(--s5);
          box-shadow: var(--edge), var(--lift); }
  .stat-label { font-family: var(--mono); font-size: var(--fs-chip); color: var(--dim);
                text-transform: uppercase; letter-spacing: .1em; margin-bottom: 6px;
                line-height: 1.4; }
  .stat-value { font-family: var(--display); font-size: 26px; font-weight: 700;
                color: var(--text); letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
  .stat-value.held { color: var(--green); }
  .stat-value.near { color: var(--amber); }

  /* Scroll the table, never hide columns. Hiding data on a dashboard so the
     layout looks tidy is the page lying to its only reader. Recipe copied from
     .tw in app.ts. */
  .tw { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--r-frame);
        background: var(--surface); }
  table { width: 100%; border-collapse: collapse; font-size: var(--fs-small);
          font-variant-numeric: tabular-nums; }
  th { text-align: left; padding: 11px 14px; color: var(--dim); font-weight: 500;
       font-family: var(--mono); border-bottom: 1px solid var(--border);
       text-transform: uppercase; letter-spacing: .08em; font-size: var(--fs-chip);
       white-space: nowrap; }
  td { padding: 12px 14px; border-bottom: 1px solid var(--border-soft);
       vertical-align: middle; color: var(--muted); white-space: nowrap; }
  tbody tr:last-child td { border-bottom: 0; }
  /* Ordered after the row background so it wins on equal specificity. The old
     rule needed !important only because it came first. */
  tbody tr:hover td { background: var(--surface2); }
  tbody tr.near-row td { background: var(--near-bg); }

  .chip { display: inline-block; font-family: var(--mono); font-size: var(--fs-chip);
          letter-spacing: .08em; text-transform: uppercase; padding: 3px 9px;
          border-radius: var(--r-chip); border: 1px solid; }
  .chip.flow { color: var(--muted); border-color: var(--border2); background: var(--surface3); }
  .chip.held { color: var(--green); border-color: var(--held-line); background: var(--held-bg); }
  .chip.near { color: var(--amber); border-color: var(--near-line); background: var(--near-bg); }

  .track { display: inline-block; vertical-align: middle; width: 84px; height: 6px;
           background: var(--surface3); border-radius: var(--r-pill); overflow: hidden;
           margin-right: var(--s2); }
  .track i { display: block; height: 100%; background: var(--flow); }
  .track i.near { background: var(--amber); }
  .track i.fail { background: var(--red); }

  .mono { font-family: var(--mono); color: var(--text); }
  .muted { color: var(--dim); }
  .none { color: var(--dim); font-style: italic; }
  a { color: var(--green); }

  .login { max-width: 380px; margin: 72px auto; background: var(--surface);
           border: 1px solid var(--border); border-radius: var(--r-frame);
           padding: var(--s6); box-shadow: var(--edge), var(--lift); }
  .login label { display: block; font-family: var(--mono); font-size: var(--fs-chip);
                 letter-spacing: .12em; text-transform: uppercase; color: var(--dim);
                 margin-bottom: var(--s2); }
  .login input { width: 100%; min-height: 44px; background: var(--bg);
                 border: 1px solid var(--border-strong); border-radius: var(--r-control);
                 padding: 11px 13px; color: var(--text); font-family: var(--mono);
                 font-size: var(--fs-body); margin-bottom: var(--s4);
                 outline: 2px solid transparent; outline-offset: 2px; }
  .login input:focus-visible { outline-color: var(--green); border-color: var(--border-strong); }
  .login button { width: 100%; min-height: 44px; background: var(--green);
                  color: var(--green-ink); border: 0; border-radius: var(--r-control);
                  font-family: var(--sans); font-size: var(--fs-small); font-weight: 700;
                  cursor: pointer; }
  .login button:hover { filter: brightness(1.06); }
  .login button:active { transform: translateY(1px); }
  .err { color: var(--red); font-size: var(--fs-small); margin-bottom: var(--s3); }

  @media (max-width: ${'${BP.md}'}px) {
    .wrap { padding-block: var(--s5) var(--s7); }
    nav.top { padding-inline: var(--s4); }
  }
`

const SHELL = (title: string) => head({
  // Through head() now, which is where the viewport meta, the icons, the fonts
  // and the tokens come from. This page had none of them: it rendered at
  // desktop width and zoomed out on a phone, and loaded no webfont at all.
  title: `${title} · AgentBill`,
  path: '/admin',
  css: CSS,
})

const topBar = (who = '') => `  <nav class="top">
    <a class="logo" href="/">${mark(18)}AgentBill</a>
    <span class="who">${who}</span>
  </nav>`

function loginPage(error = '') {
  return `${SHELL('Admin')}
<body>
${topBar('admin')}
  <div class="login">
    <h1>Admin</h1>
    <p class="sub">Owner access only.</p>
    ${error ? `<p class="err">${error}</p>` : ''}
    <form method="POST" action="/admin/login">
      <label for="admin-secret">Admin secret</label>
      <input id="admin-secret" type="password" name="secret" autocomplete="current-password" autofocus />
      <button type="submit">Sign in</button>
    </form>
  </div>
</body>
</html>`
}

function adminPage(accounts: AccountSignals[], pulse: PlaygroundPulse) {
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
    const barClass = isFull ? 'fail' : isWarn ? 'near' : ''
    const callBadge = isWarn
      ? `<span class="chip near">${calls} / ${FREE_TIER_LIMIT}</span>`
      : `${calls}`

    return `<tr class="${hotRow ? 'near-row' : ''}" title="${a.name ?? ''}">
      <td>${hotRow ? `<span class="chip near">${score}</span>` : `<span class="muted">${score}</span>`}</td>
      <td class="mono">${a.email ?? '<span class="none">no email</span>'}</td>
      <td><span class="chip ${a.plan === 'free' ? 'flow' : 'held'}">${a.plan}</span></td>
      <td>
        <span class="track"><i class="${barClass}" style="width:${pct}%"></i></span>
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

  return `${SHELL('Admin')}
<body>
${topBar('signed in')}
  <div class="wrap">
  <h1>Admin</h1>
  <p class="sub">Conversion radar: hot accounts first, sorted by likelihood to pay. Refresh to update.</p>

  <h2>Playground, last 30 days</h2>
  <div class="stats">
    <div class="stat">
      <div class="stat-label">Playground: page views that ran it (30d)</div>
      <div class="stat-value ${pulse.views > 0 ? 'held' : ''}">${pulse.views}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Runs, including repeats</div>
      <div class="stat-value">${pulse.runs}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Reached the block</div>
      <div class="stat-value ${pulse.blocked > 0 ? 'near' : ''}">${pulse.blocked}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Moved the ceiling slider</div>
      <div class="stat-value">${pulse.movedSlider}</div>
    </div>
  </div>
  <p class="sub">
    A view is one page load, not one person: the token is minted per load and never stored, so
    the same visitor returning counts twice. It is not a signup and it is not attributable to a
    channel; no source column exists yet.
    ${pulse.since
      ? `First row ${new Date(pulse.since).toISOString().slice(0, 16).replace('T', ' ')} UTC.`
      : 'No rows yet. Either nobody has run it, or it has not been deployed since the event shipped.'}
  </p>

  <h2>Accounts</h2>
  <div class="stats">
    <div class="stat">
      <div class="stat-label">Total accounts</div>
      <div class="stat-value">${total}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Paid</div>
      <div class="stat-value held">${paid}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Hot (likely to pay)</div>
      <div class="stat-value near">${hot}</div>
    </div>
    <div class="stat">
      <div class="stat-label">New (7 days)</div>
      <div class="stat-value">${new7d}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Total calls this month</div>
      <div class="stat-value">${totalCalls.toLocaleString()}</div>
    </div>
  </div>

  <div class="tw">
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
      ${rows || '<tr><td colspan="10" class="none">No accounts yet.</td></tr>'}
    </tbody>
  </table>
  </div>
  </div>
</body>
</html>`
}
