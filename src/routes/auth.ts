import type { FastifyInstance, FastifyReply, FastifyRequest, FastifyBaseLogger } from 'fastify'
import { z } from 'zod'
import { createHash, randomBytes } from 'crypto'
import { sql } from '../db/index.js'
import { publicRoute } from '../middleware/auth.js'
import { head, BP } from '../ui/theme.js'
import { siteNav, siteFooter, CHROME_CSS } from '../ui/chrome.js'
import { ORIGIN } from '../ui/site.js'
import { signinPanel, signinFonts, SIGNIN_CSS, type SigninFrom } from '../ui/signin.js'
import { sameOrigin, safeNext, CLEAR_KEY_COOKIE, hasSession } from './app.js'
import { sendNotFoundPage } from './not-found.js'
import { limiterKey } from '../lib/client-ip.js'
import { createLimiter } from '../lib/rate-limiter.js'
import { mailUser } from '../lib/mail.js'
import { alertNewSignup } from '../lib/signup-alert.js'
import { userSessionCookie } from '../lib/user-session.js'
import { signIn, linkIdentity, type SignedIn } from '../lib/users.js'
import { reportRegistration } from '../lib/capi.js'
import {
  providerConfig, configuredProviders, isProvider, newFlow, flowCookie, readFlow, stateMatches,
  authorizeUrl, verifiedIdentity, CLEAR_FLOW_COOKIE, type Provider, type Refusal,
} from '../lib/oauth.js'

// Sign-in, 2026-09-25: Google, GitHub, and a one-time link by email.
//
//   GET  /login                          the sign-in page
//   GET  /auth/:provider                 start a sign-in (a link, changes nothing)
//   GET  /auth/:provider/callback        finish one; only the browser that started it can
//   POST /auth/email                     mail a sign-in link; the same answer for any address
//   GET  /auth/email/:token              a confirm page; does NOT spend the link
//   POST /auth/email/:token              spend it and sign in
//
// Every sign-in ends in the same place: a person (users), the one account they
// own (created on their first sign-in, with no key), and a user session cookie
// carrying their session epoch. The first key is made afterwards, in the
// console, by a person whose address has been verified. The console's
// "Continue with Google" for an existing account is POST /app/connect/:provider
// in src/routes/app.ts; its callback is the same one below.

const SUPPORT_EMAIL = 'hello@agentbill.dev'
const LINK_TTL_MINUTES = 15
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex')
const EmailBody = z.object({
  email: z.string().trim().toLowerCase().max(254).email(),
  next: z.string().max(200).optional(),
  from: z.enum(['login', 'register', 'app']).optional(),
})

// Per network: twelve an hour, the number /register has used since 2026-09-12
// for the reason it gives (a workshop behind one NAT is one address).
const linkNetworkLimiter = createLimiter({ max: 12, windowMs: 60 * 60_000, maxEntries: 20_000 })
// Per address, in memory: the fast half. The durable half is the count of
// email_sign_in_tokens rows for the address in the last hour, which holds
// across machines and cold starts the way recover.ts's does.
const LINKS_PER_ADDRESS_PER_HOUR = 3
const linkAddressLimiter = createLimiter({ max: LINKS_PER_ADDRESS_PER_HOUR, windowMs: 60 * 60_000, maxEntries: 20_000 })

// ---------------------------------------------------------------------------
// The email link
// ---------------------------------------------------------------------------

/**
 * Count one request for a sign-in link against the caller's network. The one
 * outcome a caller may be told, because it is about the caller and not about
 * the address: false means refuse with 429.
 */
export function allowLinkRequest(request: FastifyRequest): boolean {
  return linkNetworkLimiter.hit(limiterKey(request)).allowed
}

/**
 * Mint a link for `email` and mail it, after the caller has already been
 * answered. Fire and forget on purpose: waiting on the database and Resend
 * would make a known address measurably slower than an unknown one, and the
 * answer must not depend on which it is. Never throws.
 */
export function queueSignInLink(log: FastifyBaseLogger, email: string, next: string): void {
  // The in-memory per-address limit: past it, nothing is minted and nothing is
  // said. Refusing out loud would tell a stranger that somebody asked recently.
  if (!linkAddressLimiter.hit(email).allowed) {
    log.info('sign-in link not sent: this address asked too often this hour')
    return
  }
  void (async () => {
    try {
      const [recent] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM email_sign_in_tokens
        WHERE email = ${email} AND created_at > now() - INTERVAL '1 hour'
      `
      if ((recent?.n ?? 0) >= LINKS_PER_ADDRESS_PER_HOUR) {
        log.info('sign-in link not sent: this address asked too often this hour')
        return
      }
      const token = randomBytes(32).toString('base64url')
      const rowId = await sql.begin(async (tx) => {
        // One live link per address: asking again retires the last one.
        await tx`UPDATE email_sign_in_tokens SET consumed_at = now() WHERE email = ${email} AND consumed_at IS NULL`
        const [row] = await tx`
          INSERT INTO email_sign_in_tokens (email, token_hash, next_path, expires_at)
          VALUES (${email}, ${hashToken(token)}, ${next || null}, now() + (${LINK_TTL_MINUTES} * INTERVAL '1 minute'))
          RETURNING id
        `
        return String(row.id)
      })
      // An account made before sign-in existed, under this address, that nobody
      // has connected. The mail says so, to the mailbox and nowhere else: the
      // page that asked answered the same whatever this finds.
      const [legacy] = await sql`SELECT 1 AS ok FROM accounts WHERE email = ${email} AND owner_user_id IS NULL`
      const ok = await mailUser(log, 'signin', email, signInMail(token, Boolean(legacy)), rowId)
      if (!ok) log.warn('sign-in link was not sent')
    } catch (err) {
      log.error({ err }, 'sign-in link could not be minted')
    }
  })()
}

function signInMail(token: string, legacy: boolean): { subject: string; html: string } {
  const link = `${ORIGIN}/auth/email/${token}`
  return {
    subject: 'Your AgentBill sign-in link',
    html: `
        <p>Here is the link to sign in to AgentBill with this address.</p>
        <p><a href="${link}">Sign in to AgentBill</a></p>
        <p>It works once and expires in ${LINK_TTL_MINUTES} minutes. It opens a page with one
           button, and the sign-in happens when you press it, so a mail scanner that opens links
           cannot use it up. The first time you sign in, this makes your account, free; your API
           key is made in the console after that, shown once there, and never emailed.</p>
        ${legacy ? `<p>This address also has an AgentBill account that was made with an API key,
           before sign-in existed. This link does not open that one: it opens a separate account,
           because nothing ever confirmed who made the older one. To open the older account, sign
           in with its key at <a href="${ORIGIN}/app">${ORIGIN}/app</a> (lost it?
           <a href="${ORIGIN}/recover">${ORIGIN}/recover</a>), then connect Google or GitHub from
           its keys view.</p>` : ''}
        <p>If you did not ask for this, ignore it. Nothing happens unless the link is used.
           Questions: ${SUPPORT_EMAIL}</p>
      `,
  }
}

/** The link's address and landing path, if it is live. Read only. */
async function liveLink(token: string): Promise<{ email: string } | null> {
  const [row] = await sql`
    SELECT email FROM email_sign_in_tokens
    WHERE token_hash = ${hashToken(token)} AND consumed_at IS NULL AND expires_at > now()
  `
  return row ? { email: row.email as string } : null
}

/** Spend a link: the check and the write are one statement, by the database clock. */
async function spendLink(token: string): Promise<{ email: string; next: string } | null> {
  const [row] = await sql`
    UPDATE email_sign_in_tokens SET consumed_at = now()
    WHERE token_hash = ${hashToken(token)} AND consumed_at IS NULL AND expires_at > now()
    RETURNING email, next_path
  `
  return row ? { email: row.email as string, next: safeNext(row.nextPath) } : null
}

// ---------------------------------------------------------------------------
// Finishing a sign-in
// ---------------------------------------------------------------------------

const VIA: Record<string, string> = { google: 'Google', github: 'GitHub', email: 'an email link' }

/** The welcome note, now sent to an address that was just verified. */
async function emailWelcome(log: FastifyBaseLogger, email: string, accountId: string, via: string): Promise<boolean> {
  return mailUser(log, 'welcome', email, {
    subject: 'Your AgentBill account is ready',
    html: `
        <p>Your AgentBill account is open on the free tier. No card.</p>
        <p>You signed in with ${VIA[via] ?? 'your address'}. Sign in the same way at
           <a href="${ORIGIN}/login">${ORIGIN}/login</a> and your console opens.</p>
        <p>Your API key is made in the console, on its start screen. It is shown once there and is
           never in an email on purpose: an API key that lives in a mailbox is a key anyone who
           reads that mailbox has.</p>
        <p>The quickstart is at <a href="${ORIGIN}/docs">${ORIGIN}/docs</a>. Questions:
           ${SUPPORT_EMAIL}</p>
      `,
  }, accountId)
}

/**
 * Sign this browser in as the person `s`, end any key session it held, tell
 * the owner about a new account, and land. A new account, or one with no key
 * yet, lands on the start screen, which is where its first key is made.
 */
async function land(request: FastifyRequest, reply: FastifyReply, s: SignedIn, via: string, next: string, extra: string[] = []) {
  const cookie = userSessionCookie(s.userId, s.epoch)
  if (!cookie) {
    if (extra.length) reply.header('Set-Cookie', extra)
    return reply.redirect('/login?err=unavailable', 303)
  }
  reply.header('Set-Cookie', [...extra, cookie, CLEAR_KEY_COOKIE])
  if (s.created) {
    request.log.info({ accountId: s.accountId, via }, 'account created by sign-in')
    alertNewSignup(request.log, { accountId: s.accountId, email: s.email, plan: 'free', via })
    reportRegistration(request.log, request, { accountId: s.accountId, email: s.email, via })
    void emailWelcome(request.log, s.email, s.accountId, via)
      .catch((err) => request.log.error({ err }, 'welcome email threw'))
  }
  if (next) return reply.redirect(next, 303)
  const [key] = await sql`
    SELECT 1 AS ok FROM developer_api_keys
    WHERE account_id = ${s.accountId} AND (revoked_at IS NULL OR revoked_at > NOW()) AND (expires_at IS NULL OR expires_at > NOW())
    LIMIT 1
  `
  return reply.redirect(key ? '/app' : '/app?view=start', 303)
}

const REFUSAL_CODE: Record<Refusal, string> = {
  token_refused: 'failed',
  bad_id_token: 'failed',
  unverified_email: 'unverified',
  provider_error: 'failed',
}
const LINK_CODE: Record<string, string> = { identity_in_use: 'in_use', provider_taken: 'taken', email_in_use: 'email_in_use' }

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

const LOGIN_ERRS: Record<string, string> = {
  denied: 'The sign-in was cancelled. Nothing changed.',
  expired: 'That sign-in expired or was started in another browser. Start again here.',
  unverified: 'That account has no verified email address, so it cannot sign in here. Verify one with the provider, or use an email link.',
  failed: 'The provider did not confirm the sign-in. Try again.',
  taken: 'That address already signs in here with a different account at the same provider. Use that one.',
  rate: 'Too many attempts from this network. Try again in an hour.',
  unavailable: 'Sign-in is not configured on this server.',
}

function noStore(reply: FastifyReply): FastifyReply {
  return reply.type('text/html').header('Cache-Control', 'no-store').header('Referrer-Policy', 'same-origin')
    .header('X-Robots-Tag', 'noindex').header('X-Content-Type-Options', 'nosniff')
}

export const SIGNIN_PAGE_CSS = `${CHROME_CSS}${SIGNIN_CSS}
    /* Canvas: the register page's one column, the pitch centred over the
       warm-grey panel the form sits on. Every value is a token. */
    :root { --shell: var(--chrome-w); }
    .wrap { max-width: var(--shell); margin: 0 auto; padding-inline: var(--gutter); }
    /* --s8 on top, not the --s9 /register had: the sign-in block is three
       actions tall, and shots.mjs holds all three above a 735px fold. */
    .reg { max-width: 560px; margin: 0 auto; padding-block: var(--s8) 96px; }
    .pitch { margin-bottom: var(--s6); text-align: center; display: grid; justify-items: center; }
    .pitch h1 { color: var(--white); font-size: var(--fs-h1-sub); letter-spacing: -0.03em; line-height: 1.02;
                max-width: 14ch; overflow-wrap: anywhere; min-width: 0; }
    .lede { font-size: var(--fs-lede); color: var(--muted); margin: var(--s4) 0 0; max-width: 46ch; line-height: 1.55;
            text-wrap: pretty; }
    .lede code { font-family: var(--mono); font-size: .9em; color: var(--text); }
    .trust { margin-top: var(--s4); font-size: var(--fs-small); line-height: 20px; color: var(--dim); }
    .trust b { color: var(--muted); font-weight: 500; }
    .form-card { background: var(--panel-bg); border-radius: var(--r-card); padding: var(--s6); display: grid; gap: var(--s4); }
    .form-h h2 { color: var(--white); margin-bottom: 6px; font-size: var(--fs-h3); letter-spacing: -0.01em; }
    .form-h p { color: var(--muted); font-size: var(--fs-small); }
    .form-note { font-size: var(--fs-micro); color: var(--dim); line-height: 1.6; }
    .form-note a, .sent a { color: var(--text); text-underline-offset: 3px; text-decoration-color: var(--border-strong); }
    .form-note a:hover, .sent a:hover { text-decoration-color: currentColor; }
    .sent { display: grid; gap: var(--s3); }
    .sent h2 { color: var(--white); font-size: var(--fs-h3); letter-spacing: -0.01em; }
    .sent p { color: var(--muted); font-size: var(--fs-small); line-height: 1.6; }
    .cv-err { margin: 0; }
    @media (max-width: 900px) {
      .reg { padding-block: var(--s7) var(--s8); }
      .form-card { padding: var(--s4); }
    }
    @media (max-width: ${BP.md}px) {
      .lede { font-size: var(--fs-body); }
    }
`

export interface SigninPageOpts {
  path: '/login' | '/register'
  title: string
  description: string
  h1: string
  lede: string
  trust: string
  h2: string
  sub: string
  sent: boolean
  err: string
  next: string
  /** Page-specific head additions: a script's hash, a pixel. */
  extraHead?: string
  scriptHashes?: string[]
  scriptOrigins?: Parameters<typeof head>[0]['scriptOrigins']
  og?: Parameters<typeof head>[0]['og']
  script?: string
}

/** /login and /register: one page, two sets of words. */
export function signinPage(o: SigninPageOpts): string {
  const providers = configuredProviders()
  const from: SigninFrom = o.path === '/login' ? 'login' : 'register'
  const again = o.path
  const body = o.sent
    ? `<div class="sent" id="sent-state">
        <h2>Check your inbox.</h2>
        <p>If that address can receive mail, a sign-in link is on its way. It works once and expires in ${LINK_TTL_MINUTES} minutes, and the mail carries no key.</p>
        <p>Not there in a few minutes? Check spam, then <a href="${again}">ask for another</a>, or write to <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
      </div>`
    : `<div class="form-h">
        <h2>${o.h2}</h2>
        <p>${o.sub}</p>
      </div>
      ${Object.hasOwn(LOGIN_ERRS, o.err) ? `<p class="cv-err" role="alert">${LOGIN_ERRS[o.err]}</p>` : ''}
      ${signinPanel({ providers, from, next: o.next })}
      <p class="form-note">By continuing you agree to our <a href="/terms">Terms of Service</a> and <a href="/privacy">Privacy Policy</a>. No marketing email.</p>
      <p class="form-note">Made your account with only an API key, before sign-in existed? <a href="/app">Open the console with the key</a>, then connect Google or GitHub there. Lost the key? <a href="/recover">Get back in</a>.</p>`
  return `${head({
    title: o.title,
    description: o.description,
    path: o.path,
    og: o.og,
    extraHead: [signinFonts(providers), o.extraHead ?? ''].filter(Boolean).join('\n'),
    scriptHashes: o.scriptHashes,
    scriptOrigins: o.scriptOrigins,
    css: SIGNIN_PAGE_CSS,
  })}
<body>
${siteNav(o.path, { cta: o.path !== '/register' })}
<main>
<div class="reg wrap">
  <div class="pitch">
    <h1>${o.h1}</h1>
    <p class="lede">${o.lede}</p>
    <p class="trust">${o.trust}</p>
  </div>
  <div class="form-card">
    ${body}
  </div>
</div>
</main>
${siteFooter()}
${o.script ?? ''}
</body>
</html>`
}

/** A done or a dead end: the kit's closing band, in the sign-in shell. */
function band(title: string, inner: string): string {
  return `${head({ title: `${title} · AgentBill`, description: 'Sign in to AgentBill.', path: '/login', css: SIGNIN_PAGE_CSS })}
<body>
${siteNav('', { sticky: false })}
<main>
<div class="reg wrap">
  <div class="cv-close">
${inner}
  </div>
</div>
</main>
${siteFooter()}
</body>
</html>`
}

const DEAD_LINK = band('Link expired', `
    <h1>This link has expired.</h1>
    <p>A sign-in link works once and lasts ${LINK_TTL_MINUTES} minutes. This one has been used already, or it has run out.</p>
    <p><a href="/login">Ask for a new one</a>.</p>`)

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function authRoute(app: FastifyInstance) {
  app.get('/login', publicRoute(), async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, unknown>
    // Already signed in: the console is where this page leads anyway.
    if (q.sent !== '1' && typeof q.err !== 'string' && await hasSession(request)) return reply.redirect('/app', 303)
    return noStore(reply).send(signinPage({
      path: '/login',
      title: 'Sign in · AgentBill',
      description: 'Sign in to your AgentBill console with Google, GitHub, or a one-time link by email.',
      h1: 'Sign in.',
      lede: 'Your jobs, their ceilings, and every call refused on your behalf, in the console.',
      trust: '<b>Google, GitHub or an email link</b> · no password to keep',
      h2: 'Sign in to AgentBill',
      sub: 'New here? The same buttons make a free account.',
      sent: q.sent === '1',
      err: typeof q.err === 'string' ? q.err : '',
      next: safeNext(q.next),
    }))
  })

  // Start a sign-in. A GET, because it changes nothing on the server: it sets
  // the flow cookie and sends the browser to the provider. The only thing an
  // attacker can make a victim do with it is sign in as themselves.
  app.get('/auth/:provider', publicRoute(), async (request, reply) => {
    const p = (request.params as { provider: string }).provider
    const cfg = isProvider(p) ? providerConfig(p) : null
    if (!cfg) return sendNotFoundPage(request, reply, 404)
    const next = safeNext((request.query as Record<string, unknown> | undefined)?.next)
    const flow = newFlow(cfg.provider, 'signin', next)
    const cookie = flowCookie(flow)
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer')
    if (!cookie) return reply.redirect('/login?err=unavailable', 303)
    return reply.header('Set-Cookie', cookie).redirect(authorizeUrl(cfg, flow), 302)
  })

  app.get('/auth/:provider/callback', publicRoute(), async (request, reply) => {
    const p = (request.params as { provider: string }).provider
    const cfg = isProvider(p) ? providerConfig(p) : null
    if (!cfg) return sendNotFoundPage(request, reply, 404)
    // The code and state are in this URL; nothing after it may carry them on.
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer')
    const q = (request.query ?? {}) as Record<string, unknown>
    const flow = readFlow(request.headers.cookie, cfg.provider)
    // The flow cookie is spent on every outcome, so a second use of this
    // callback in this browser has nothing to finish.
    const clear = [CLEAR_FLOW_COOKIE]
    const fail = (code: string, mode: 'signin' | 'link' = flow?.m ?? 'signin') => {
      request.log.warn({ provider: cfg.provider, mode, code }, 'sign-in refused')
      return reply.header('Set-Cookie', clear).redirect(mode === 'link' ? `/app?view=keys&link=${code}` : `/login?err=${code}`, 303)
    }
    // No flow, or one this server did not sign, or expired: started in another
    // browser, or not started at all. Either way nothing here is ours to finish.
    if (!flow) return fail('expired', 'signin')
    if (typeof q.error === 'string') return fail('denied')
    if (!stateMatches(flow, q.state)) return fail('expired')
    const code = typeof q.code === 'string' && /^[\x21-\x7e]{1,512}$/.test(q.code) ? q.code : ''
    if (!code) return fail('expired')

    const v = await verifiedIdentity(cfg, code, flow)
    if (!v.ok) return fail(REFUSAL_CODE[v.reason])

    try {
      if (flow.m === 'link') {
        const r = await linkIdentity(flow.a!, v.id)
        if (!r.ok) return fail(LINK_CODE[r.reason] ?? 'failed')
        request.log.info({ provider: cfg.provider, accountId: r.s.accountId }, 'sign-in connected to an account')
        return land(request, reply, r.s, cfg.provider, '/app?view=keys&link=ok', clear)
      }
      const r = await signIn(v.id)
      if (!r.ok) return fail(LINK_CODE[r.reason] ?? 'failed')
      return land(request, reply, r.s, cfg.provider, safeNext(flow.x), clear)
    } catch (err) {
      request.log.error({ err, provider: cfg.provider }, 'sign-in could not be completed')
      return fail('failed')
    }
  })

  // Ask for a link. One answer for every address, known or not, and the work
  // happens after it. A form from our own pages gets a redirect to "check your
  // inbox"; JSON gets a 202 with the same sentence.
  app.post('/auth/email', publicRoute(), async (request, reply) => {
    if (!sameOrigin(request)) return reply.code(403).send({ error: 'forbidden', message: 'Cross-site requests are refused.' })
    const json = String(request.headers['content-type'] ?? '').includes('application/json')
    const body = (request.body ?? {}) as Record<string, unknown>
    const from = body.from === 'register' ? '/register' : '/login'
    if (!allowLinkRequest(request)) {
      return json
        ? reply.code(429).send({ error: 'rate_limited', message: 'Too many sign-in links from this network. Try again in an hour.' })
        : reply.redirect(`${from}?err=rate`, 303)
    }
    const parsed = EmailBody.safeParse(body)
    if (!parsed.success) {
      // A malformed address is the caller's own typo and says nothing about
      // anybody's account, so it is the one thing said out loud.
      return json
        ? reply.code(422).send({ error: 'validation_error', message: 'email: Invalid email' })
        : reply.redirect(from, 303)
    }
    queueSignInLink(request.log, parsed.data.email, safeNext(parsed.data.next))
    return json
      ? reply.code(202).send(CHECK_EMAIL)
      : reply.redirect(`${from}?sent=1`, 303)
  })

  // Read only, like /recover/:token: a mail scanner GETs this before the
  // person does, and a link spent by a scanner is dead when its owner clicks.
  app.get('/auth/email/:token', publicRoute(), async (request, reply) => {
    const token = (request.params as { token: string }).token
    const live = TOKEN_RE.test(token) ? await liveLink(token) : null
    if (!live) return noStore(reply).code(410).send(DEAD_LINK)
    return noStore(reply).send(band('Sign in', `
    <h1>Sign in to AgentBill.</h1>
    <p>As <b>${live.email.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</b>. This link works once.</p>
    <form method="POST" action="/auth/email/${token}">
      <button class="btn btn-lg" type="submit">Continue &rarr;</button>
    </form>`))
  })

  app.post('/auth/email/:token', publicRoute(), async (request, reply) => {
    if (!sameOrigin(request)) return reply.code(403).send({ error: 'forbidden' })
    const token = (request.params as { token: string }).token
    const spent = TOKEN_RE.test(token) ? await spendLink(token) : null
    if (!spent) return noStore(reply).code(410).send(DEAD_LINK)
    try {
      const r = await signIn({ provider: 'email', providerUserId: spent.email, email: spent.email })
      if (!r.ok) return reply.redirect('/login?err=taken', 303)
      return land(request, reply, r.s, 'email', spent.next)
    } catch (err) {
      request.log.error({ err }, 'email sign-in could not be completed')
      return reply.redirect('/login?err=failed', 303)
    }
  })
}

/** The one answer to a request for a link, for every address. */
export const CHECK_EMAIL = {
  status: 'check_email',
  message: `If that address can receive mail, a sign-in link is on its way. It works once and expires in ${LINK_TTL_MINUTES} minutes. Signing in opens your console, where your API key is made and shown once.`,
}
