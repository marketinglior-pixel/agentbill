import type { FastifyInstance } from 'fastify'
import { createHmac, timingSafeEqual } from 'crypto'
import { getAccountsWithSignals, conversionScore, isHot, FREE_TIER_LIMIT } from '../lib/conversion.js'
import type { AccountSignals } from '../lib/conversion.js'
import { getSitePulse } from '../lib/pulse.js'
import type { SitePulse } from '../lib/pulse.js'
import { publicRoute } from '../middleware/auth.js'
import { head, BP } from '../ui/theme.js'
import { mark, MARK_CSS } from '../ui/mark.js'
import { KIT_CSS, tag } from '../ui/kit.js'
import { sameOrigin } from './app.js'
import { limiterKey } from '../lib/client-ip.js'
import { createLimiter } from '../lib/rate-limiter.js'

const WARN_AT = 800
const SESSION_COOKIE = 'agentbill_admin'
// Twelve hours, and carried inside the signed token, not only in the cookie's
// Max-Age: a copied cookie stops working when the token says so, whatever the
// browser that holds it does. It was seven days, and the token was a constant.
const SESSION_MAX_AGE = 12 * 3_600 // seconds

// Attempts per network on /admin/login, the same shape as the console's
// allowLogin (src/routes/app.ts): counted per limiterKey (the IPv4 address or
// the IPv6 /64), before the secret is compared. There was no limit at all, so
// the secret could be guessed as fast as the server answered.
const adminLogins = createLimiter({ max: 10, windowMs: 15 * 60_000, maxEntries: 10_000 })

export async function adminRoute(app: FastifyInstance) {

  // JSON, for the signed-in owner. Same session as the dashboard: sign in at
  // /admin, then this is readable in that browser. It used to also accept
  // Authorization: Bearer <ADMIN_SECRET>, the raw secret on every request;
  // nothing in this repository called it that way, so that door is closed.
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
    const pulse = await getSitePulse()
    reply.type('text/html').header('Cache-Control', 'no-store').header('X-Robots-Tag', 'noindex, nofollow')
    return reply.send(adminPage(accounts, pulse))
  })

  // POST /admin/login, form submits secret, sets HttpOnly session cookie.
  // The secret never appears in a URL (query params leak into logs and browser history).
  app.post('/admin/login', publicRoute(), async (request, reply) => {
    reply.type('text/html').header('Cache-Control', 'no-store').header('X-Robots-Tag', 'noindex, nofollow')
    if (!sameOrigin(request)) return reply.code(403).send(loginPage('Sign in from this page.'))
    const network = limiterKey(request)
    if (!adminLogins.hit(network).allowed) {
      request.log.warn({ network }, 'admin login refused: too many attempts from this network')
      return reply.code(429).send(loginPage('Too many attempts. Try again in fifteen minutes.'))
    }
    const body = request.body as Record<string, unknown>
    const secret = typeof body?.secret === 'string' ? body.secret : ''
    const expected = process.env.ADMIN_SECRET ?? ''
    if (!expected || !safeEqual(secret, expected)) {
      // Never the value typed: a wrong secret is often the right one with a typo.
      request.log.warn({ network, configured: Boolean(expected) }, 'admin login failed')
      return reply.code(401).send(loginPage('Wrong secret.'))
    }
    request.log.info({ network }, 'admin login')
    reply.header(
      'Set-Cookie',
      `${SESSION_COOKIE}=${mintAdminToken(expected)}; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=${SESSION_MAX_AGE}`
    )
    return reply.redirect('/admin', 303)
  })

  // Clears this browser's session. The token is stateless, so a copy of it
  // taken elsewhere still works until its expiry (twelve hours at most);
  // rotating ADMIN_SECRET ends every session at once.
  app.post('/admin/logout', publicRoute(), async (request, reply) => {
    if (!sameOrigin(request)) return reply.code(403).send({ error: 'forbidden' })
    reply.header('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=0`)
    return reply.redirect('/admin', 303)
  })
}

// ---------------------------------------------------------------------------
// Auth: the session cookie, and nothing else.
//
// The cookie was HMAC(ADMIN_SECRET, a constant): the same value on every login,
// forever, so one copied cookie was the dashboard until the secret rotated. It
// is now <issued>.<expires>.<mac>, the mac over both times and a version
// label, keyed by ADMIN_SECRET, and every request checks the mac and the
// expiry. Rotating the secret still invalidates every session.
// ---------------------------------------------------------------------------

const ADMIN_TOKEN_LABEL = 'agentbill-admin-session-v2'

function adminMac(secret: string, iat: number, exp: number): string {
  return createHmac('sha256', secret).update(`${ADMIN_TOKEN_LABEL}.${iat}.${exp}`).digest('hex')
}

function mintAdminToken(secret: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000)
  const exp = iat + SESSION_MAX_AGE
  return `${iat}.${exp}.${adminMac(secret, iat, exp)}`
}

/** True for a token this secret minted that has not expired. */
export function verifyAdminToken(token: string, secret: string, now = Date.now()): boolean {
  const m = /^(\d{10})\.(\d{10})\.([0-9a-f]{64})$/.exec(token)
  if (!m || !secret) return false
  const iat = Number(m[1]), exp = Number(m[2]), t = Math.floor(now / 1000)
  if (exp - iat !== SESSION_MAX_AGE) return false
  if (iat > t + 60 || exp <= t) return false
  return safeEqual(m[3], adminMac(secret, iat, exp))
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

function checkAuth(request: { headers: { cookie?: string } }): boolean {
  const expected = process.env.ADMIN_SECRET ?? ''
  if (!expected) return false
  const cookie = readCookie(request.headers.cookie ?? '', SESSION_COOKIE)
  return cookie !== '' && verifyAdminToken(cookie, expected)
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

// Canvas since 2026-09-23, with the console: the kit's frame, tiles, table,
// tags and chips, and the same colour law re-cast. A figure that is merely
// non-zero is not a colour (it used to be the green --held, which is the ink
// on canvas); a hot account and the playground's refusal count are the amber
// "approaching" state; a free account out of calls is the signal. A paid plan
// is a plain state, so it is a tag.
const CSS = `${KIT_CSS}${MARK_CSS}
  nav.top { position: sticky; top: 0; z-index: 10; height: 60px; background: var(--nav-bg); backdrop-filter: blur(14px);
            border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between;
            padding-inline: var(--gutter); gap: var(--s4); }
  nav.top .logo { display: flex; align-items: center; gap: 9px; font-family: var(--mono);
                  font-weight: 700; font-size: var(--fs-body); color: var(--text); text-decoration: none; }
  nav.top form.out { margin: 0 0 0 auto; }
  nav.top .who { font-family: var(--mono); font-size: var(--fs-chip); letter-spacing: var(--track-chip); text-transform: uppercase;
                 color: var(--muted); border: 1px solid var(--chip-line); border-radius: var(--r-pill); padding: 3px 10px; }

  .wrap { max-width: 1400px; margin: 0 auto; padding-inline: var(--gutter);
          padding-block: var(--s7) var(--s8); }
  h1 { font-size: var(--fs-h1-app); letter-spacing: -0.02em; line-height: 1.15; margin-bottom: var(--s2); }
  h2 { font-size: var(--fs-h3); letter-spacing: -0.01em; line-height: 1.3; margin: var(--s7) 0 var(--s3); }
  .sub { font-size: var(--fs-small); color: var(--muted); max-width: 86ch; line-height: 1.6; }
  .sub + .stats { margin-top: var(--s5); }
  .sub code, td code { font-family: var(--mono); font-size: .92em; color: var(--text); }

  /* The tiles: white cards on the panel's grey, panel in panel. auto-fit,
     because a flex row of five fixed cards is why this page needed a
     horizontal scrollbar on anything narrower than a laptop. */
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(176px, 1fr)); gap: var(--s3);
           margin-block: var(--s3) var(--s5); background: var(--panel-bg); border-radius: var(--r-card); padding: var(--s4); }
  /* Label, figure, week: three rows, the label's taking the slack, so every
     figure in a row of tiles sits on one line however its label wraps, and a
     tile with no week line keeps that line's height. */
  .stat { background: var(--card-bg); border: 1px solid var(--card-line); border-radius: var(--r-inner);
          padding: var(--s4) 20px; display: grid; grid-template-rows: 1fr auto minmax(1.45em, auto); gap: 6px; }
  .stat-label { font-family: var(--mono); font-size: var(--fs-chip); color: var(--dim);
                text-transform: uppercase; letter-spacing: var(--track-label); line-height: 1.45; }
  .stat-value { font-family: var(--display); font-size: var(--fs-figure); font-weight: 500; line-height: 1.1;
                color: var(--text); letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
  .stat-value.near { color: var(--near-ink); }

  /* The frame for a table. Scroll the table, never hide columns: hiding data
     on a dashboard so the layout looks tidy is the page lying to its only
     reader. */
  .cv-panel { margin-bottom: var(--s3); }
  .cv-table td { color: var(--muted); white-space: nowrap; }
  .cv-table td.mono { font-family: var(--mono); color: var(--text); }
  tbody tr.near-row td { background: var(--near-bg); }

  /* The calls bar: the free tier's calls against its limit. */
  .track { display: inline-block; vertical-align: middle; width: 84px; height: 6px;
           background: var(--meter-track); border-radius: var(--r-pill); overflow: hidden;
           margin-right: var(--s2); }
  .track i { display: block; height: 100%; background: var(--meter-fill); border-radius: var(--r-pill); }
  .track i.near { background: var(--amber); }
  .track i.fail { background: var(--signal); }

  .mono { font-family: var(--mono); color: var(--text); }
  .muted { color: var(--dim); }
  .none { color: var(--dim); }
  a { color: var(--text); }

  .login { max-width: 440px; margin: var(--s8) auto; }
  .login .cv-card { padding: var(--s6); display: grid; gap: var(--s3); }
  .login form { display: grid; gap: var(--s2); margin-top: var(--s2); }
  .login form .btn { width: 100%; margin-top: var(--s3); }
  .err { margin: 0; }

  @media (max-width: ${BP.md}px) {
    .wrap { padding-block: var(--s5) var(--s7); }
    .stats { padding: var(--s3); border-radius: var(--r-card-sm); }
    .login { margin: var(--s6) var(--gutter); }
    .login .cv-card { padding: var(--s5) var(--s4); }
  }
`

// Anything a visitor typed into /register is escaped before it lands in this
// page. name, use_case and stack were interpolated raw into an attribute and two
// cells, on the one page that lists every customer, with no CSP to blunt it.
const esc = (v: unknown) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const SHELL = (title: string) => head({
  // Through head() now, which is where the viewport meta, the icons, the fonts
  // and the tokens come from. This page had none of them: it rendered at
  // desktop width and zoomed out on a phone, and loaded no webfont at all.
  title: `${title} · AgentBill`,
  path: '/admin',
  // No inline scripts here, so script-src 'none'.
  scriptHashes: [],
  css: CSS,
})

const topBar = (who = '', signedIn = false) => `  <nav class="top" aria-label="Account">
    <a class="logo" href="/">${mark(18)}AgentBill</a>
    <span class="who">${who}</span>
    ${signedIn ? `<form class="out" method="post" action="/admin/logout"><button class="btn" type="submit">Sign out</button></form>` : ''}
  </nav>`

function loginPage(error = '') {
  return `${SHELL('Admin')}
<body>
${topBar('admin')}
  <div class="login cv-panel"><div class="cv-card">
    <h1>Admin</h1>
    <p class="sub">Owner access only.</p>
    ${error ? `<p class="err cv-err">${error}</p>` : ''}
    <form method="POST" action="/admin/login">
      <label class="cv-flabel" for="admin-secret">Admin secret</label>
      <input id="admin-secret" class="cv-field m" type="password" name="secret" autocomplete="current-password" autofocus />
      <button class="btn btn-lg" type="submit">Sign in</button>
    </form>
  </div></div>
</body>
</html>`
}

function adminPage(accounts: AccountSignals[], pulse: SitePulse) {
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
      ? `<span class="chip-near">${calls} / ${FREE_TIER_LIMIT}</span>`
      : `${calls}`

    return `<tr class="${hotRow ? 'near-row' : ''}" title="${esc(a.name)}">
      <td>${hotRow ? `<span class="chip-near">${score}</span>` : `<span class="muted">${score}</span>`}</td>
      <td class="mono">${a.email ? esc(a.email) : '<span class="none">no email</span>'}</td>
      <td>${tag(esc(a.plan))}</td>
      <td>
        <span class="track"><i class="${barClass}" style="width:${pct}%"></i></span>
        ${callBadge}
      </td>
      <td class="muted">${a.taskCount}</td>
      <td class="muted">${rel(a.lastActivityAt)}</td>
      <td class="muted">${a.customerCount}</td>
      <td>${a.stack ? esc(a.stack) : '<span class="muted">-</span>'}</td>
      <td>${a.useCase ? esc(a.useCase) : '<span class="muted">-</span>'}</td>
      <td class="muted">${new Date(a.createdAt).toLocaleDateString('en-GB', {day:'2-digit',month:'short',year:'2-digit'})}</td>
    </tr>`
  }).join('')

  return `${SHELL('Admin')}
<body>
${topBar('signed in', true)}
  <div class="wrap">
  <h1>Admin</h1>
  <p class="sub">Conversion radar: hot accounts first, sorted by likelihood to pay. Refresh to update.</p>

  <h2>Site pulse, last 30 days, with the last 7 under each</h2>
  <div class="stats">
    <div class="stat">
      <div class="stat-label">Homepage: page loads</div>
      <div class="stat-value ${pulse.pageViews > 0 ? 'held' : ''}">${pulse.pageViews}</div>
      <div class="stat-label">Last 7 days: ${pulse.week.pageViews}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Homepage: page views that clicked through to /register</div>
      <div class="stat-value ${pulse.ctaClicks > 0 ? 'held' : ''}">${pulse.ctaClicks}</div>
      <div class="stat-label">Last 7 days: ${pulse.week.ctaClicks}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Homepage: page views that pressed Estimate a run</div>
      <div class="stat-value ${pulse.estimateClicks > 0 ? 'held' : ''}">${pulse.estimateClicks}</div>
      <div class="stat-label">Last 7 days: ${pulse.week.estimateClicks}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Estimator: page views that typed into it</div>
      <div class="stat-value ${pulse.estimateUses > 0 ? 'held' : ''}">${pulse.estimateUses}</div>
      <div class="stat-label">Last 7 days: ${pulse.week.estimateUses}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Homepage: page views that clicked Try it (link retired 2026-09-23)</div>
      <div class="stat-value">${pulse.tryClicks}</div>
      <div class="stat-label">Last 7 days: ${pulse.week.tryClicks}</div>
    </div>
    <div class="stat">
      <div class="stat-label">/register: page loads</div>
      <div class="stat-value ${pulse.registerViews > 0 ? 'held' : ''}">${pulse.registerViews}</div>
      <div class="stat-label">Last 7 days: ${pulse.week.registerViews}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Playground: page views that ran it (30d)</div>
      <div class="stat-value ${pulse.views > 0 ? 'held' : ''}">${pulse.views}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Runs, including repeats</div>
      <div class="stat-value">${pulse.runs}</div>
      <div class="stat-label">Last 7 days: ${pulse.week.runs}</div>
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
    the same visitor returning counts twice. It is not a signup. A row carries a channel only when
    the link we published put one there (see the table below); organic traffic and the paid campaign
    both arrive untagged, so the totals above are every source at once. The funnel tiles are
    first-party rows as well, so a page load or a
    click through that no pixel saw still counts here, and a /register load with no account row
    after it is the form losing someone. The page-load tile starts on 2026-09-22 and is empty
    before that; it is not a pixel PageView and will not match one, since the pixel is a script
    desktop browsers block. Read Estimate a run beside the click-through: if it runs well
    ahead, visitors want the arithmetic before the key; if neither moves, the fold is the
    problem, not the depth. The estimator tile counts that someone typed, never what they typed.
    Try it was the hero's link to the demo until 2026-09-23 and only holds history now.
    ${pulse.since
      ? `First row ${new Date(pulse.since).toISOString().slice(0, 16).replace('T', ' ')} UTC.`
      : 'No rows yet. Either nobody has run it, or it has not been deployed since the event shipped.'}
  </p>

  <h2>Tagged surfaces, last 30 days</h2>
  ${pulse.sources.length === 0
    ? `<p class="sub">No tagged rows. Nothing has been published with a <code>?src=</code> link yet, or
       nothing published has been opened. This is the expected reading before the first directory
       listing goes out, and it is <b>not</b> the same as no traffic: an untagged visit is counted in
       the tiles above and simply cannot say where it came from.</p>`
    : `<div class="cv-panel"><div class="cv-card cv-scroll"><table class="cv-table is-ruled">
    <thead>
      <tr>
        <th>Source</th>
        <th>Page loads (30d / 7d)</th>
        <th>Clicked through (30d / 7d)</th>
        <th>Try it</th>
        <th>Estimate a run</th>
        <th>/register loads (30d / 7d)</th>
        <th>Playground runs</th>
        <th>First</th>
        <th>Last</th>
      </tr>
    </thead>
    <tbody>
      ${pulse.sources.map((row) => `<tr>
        <td><code>${esc(row.source)}</code></td>
        <td class="${row.pageViews > 0 ? 'held' : ''}">${row.pageViews} <span class="muted">/ ${row.pageViews7}</span></td>
        <td class="${row.ctaClicks > 0 ? 'held' : ''}">${row.ctaClicks} <span class="muted">/ ${row.ctaClicks7}</span></td>
        <td>${row.tryClicks}</td>
        <td>${row.estimateClicks}</td>
        <td class="${row.registerViews > 0 ? 'held' : ''}">${row.registerViews} <span class="muted">/ ${row.registerViews7}</span></td>
        <td>${row.runs}</td>
        <td>${row.first.slice(0, 16).replace('T', ' ')}</td>
        <td>${row.last.slice(0, 16).replace('T', ' ')}</td>
      </tr>`).join('')}
    </tbody>
  </table></div></div>
  <p class="sub">
    These rows do not sum to the tiles above and are not meant to. Only a visit that arrived on a
    link carrying <code>?src=</code> is counted here; a visitor who strips the parameter is recorded
    with no source, which is the honest answer rather than a gap to be filled by sniffing a referrer.
    A source with clicks and zero /register loads is the link, not the page: check that the surface
    points at <code>/</code> or <code>/register</code> and not somewhere the parameter is dropped.
  </p>`}

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

  <div class="cv-panel"><div class="cv-card cv-scroll">
  <table class="cv-table is-ruled">
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
  </div></div>
  </div>
</body>
</html>`
}
