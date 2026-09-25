import type { FastifyInstance, FastifyRequest } from 'fastify'
import { sessionSecret, hmacHex, readCookie, safeEqual } from '../lib/session-secret.js'
import { sql } from '../db/index.js'
import { PLAN_LIMITS, checkoutPath } from '../integrations/polar.js'
import { limiterKey } from '../lib/client-ip.js'
import { head, BP } from '../ui/theme.js'
import { publicRoute, isKeyShaped } from '../middleware/auth.js'
import { mark, MARK_CSS } from '../ui/mark.js'
import { KEY_CTA, KEY_CTA_SHORT, CHROME_CSS, siteNav, siteFooter } from '../ui/chrome.js'
import { KIT_CSS, tag, SAMPLE_TAG, label, meter } from '../ui/kit.js'
import { z } from 'zod'
import { isId, INT4_MAX, plain } from '../lib/ids.js'
import { setTaskCeiling, CONSOLE_AGENT, unitWord, TASK_UNITS, asTaskUnit, amountText, usdText, usdAmount, microsFromUsd, microsFromListPrice, type TaskUnit } from '../lib/task-ceiling.js'
import { HISTORY_JOBS, HISTORY_AGENTS, PICKS, summarizeHistory, type Pick, type AgentHistory, type HistoryJob } from '../lib/ceiling-suggest.js'
import {
  VIAS, asVia, type Via, CONNECT_Q, CONNECT_LEDE, VIA_TITLE, VIA_SUB, MCP_PROMPT, MCP_DOES, MCP_DOES_NOT,
  INSTALL_PY_WRAP, INSTALL_NODE_WRAP, KEYS_LINE, WHAT_RUNS, ANTHROPIC_LINE, WAITING_LINE,
} from '../ui/steps.js'
import { LIST_PRICE_LABEL } from '../lib/prices.js'
import { rankOrderSql } from '../lib/task-rank.js'
import { checkRateLimit } from '../lib/rate-limiter.js'
import { KEY_COMMANDS } from '../ui/panels.js'
import { usageByEventType, EVENT_TOKENS_SQL, type EventTypeUsage } from '../lib/usage.js'
import { readUserSession, CLEAR_USER_COOKIE } from '../lib/user-session.js'
import { endSessions, linkedProviders } from '../lib/users.js'
import { configuredProviders, providerConfig, isProvider, newFlow, flowCookie, authorizeUrl, type Provider } from '../lib/oauth.js'
import { signinPanel, signinFonts, SIGNIN_CSS } from '../ui/signin.js'
import { GOOGLE_G, GITHUB_MARK } from '../ui/provider-marks.js'
import { COPY_CSS, COPY_JS, COPY_HASH, copyPlate } from '../ui/copy.js'
import { hashKey, insertKey, maskKey, keyPrefixOf, keyLast4Of } from '../lib/api-keys.js'
import { revokeAllKeys } from './keys.js'
import { connectedApps, SCOPE_TEXT, type ConnectedApp } from '../lib/mcp-oauth.js'

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
//
// It makes exactly one kind of write (2026-09-10): a job's ceiling, through
// POST /app/tasks, the same statement PUT /tasks/:task_ref/ceiling runs. It
// arrived because the empty state below used to send a reader back to their
// editor to set a budget, and the founder, dogfooding, said that was the
// product's whole problem. Every other number here is still read-only.
// The suggested ceiling on the tasks view (2026-09-23) adds no write: it is a
// link that reloads this view with one of the account's own used_units in the
// ceiling field, and the save is still the reader's. See loadHistory below.
// This page loads no script at all and the CSP below has no script-src; the
// chart's hover layer is CSS. Corrected 2026-09-10: that sentence used to
// justify itself with "a live key is rendered into it", which stopped being
// true in this commit. The first run's curl was the last full key on the
// page; every key rendered here now is masked (first 8, last 4). The
// script-free rule stands on its own, and it is what lets the onboarding form
// below be a plain POST.

const COOKIE = 'agentbill_app'
const MAX_AGE = 7 * 24 * 3_600
const LOGIN_LIMIT = 20
const LOGIN_WINDOW_MS = 15 * 60_000
const loginHits = new Map<string, number[]>()

// img-src and manifest-src are here because head() emits the favicon and
// manifest links on every page, and this is the one page with a real CSP:
// under default-src 'none' the browser blocked all four and logged a
// violation for each on every load. 'self' only, plus data: for the one
// inline SVG the site uses as a select arrow.
//
// form-action 'self' has a consequence the checkout hand-off is built around:
// Chrome enforces it against EVERY redirect that follows a form POST, so a
// login that 303s into a redirect chain ending at polar.sh is blocked at the
// last hop, silently. The hand-off below therefore lands on a 200 page and
// hops from there.
export const APP_CSP = "default-src 'none'; img-src 'self' data:; manifest-src 'self'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"

// The only places a post-login redirect may go: a checkout hand-off, or the
// start screen, which is where /register#done signs a new key in. Anything
// else, a full URL included, is dropped and the login lands on /app as it
// always has, so this cannot become an open redirect however the query is
// edited.
// Exported 2026-09-25: the sign-in routes (src/routes/auth.ts) carry `next`
// through Google, GitHub and the email link with this same allowlist, so a
// sign-in cannot become an open redirect either.
// 2026-09-25: and the MCP connect flow's consent page, by the id of the
// authorization request waiting there (src/routes/oauth.ts). An id, not the
// request's own query string: the path is fixed and the id is 32 characters of
// base64url, so nothing a caller puts in it can change where the browser goes.
const NEXT_RE = /^\/app(\/upgrade\/(builder|team|scale)|\?view=start|\/oauth\/authorize\?request_id=[A-Za-z0-9_-]{32})$/
export const safeNext = (v: unknown): string => (typeof v === 'string' && NEXT_RE.test(v) ? v : '')
const TIERS = new Set(['builder', 'team', 'scale'])
const back = (err: string, next: string) => `/app?err=${err}${next ? `&next=${encodeURIComponent(next)}` : ''}`

export type Viewer = {
  /** The key this console reads as. A user session with no active key yet has ''. */
  keyId: string
  /** That key as every surface shows it, agb_1234…abcd, or '' with no key.
   *  Never the key: since 2026-09-25 the server keeps only its hash. */
  keyMask: string
  keyLabel: string | null
  accountId: string
  email: string | null
  plan: string
  monthlyCalls: number
  /** The balance every new customer of this account is born with. NULL = no limit. */
  defaultBudgetUnits: number | null
  /** How this browser signed in: a pasted key (the legacy login) or as a person. */
  via: 'key' | 'user'
  /** The person, for a user session; null for a key session. */
  userId: string | null
  userEmail: string | null
  /** The providers the account's owner can sign in with. */
  linked: string[]
}

/** The rate bucket for the console's own writes: the key's, as the API uses,
 *  or the account's when a person is signed in with no key yet. */
const bucket = (v: Viewer): string => v.keyId || `account:${v.accountId}`

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
      .header('Content-Security-Policy', APP_CSP)
    const q = request.query as Record<string, unknown>
    const demo = q?.demo === '1'
    const range = typeof q?.range === 'string' && Object.hasOwn(RANGES, q.range) ? q.range : DEFAULT_RANGE
    const view = typeof q?.view === 'string' && Object.hasOwn(VIEWS, q.view) ? (q.view as ViewKey) : DEFAULT_VIEW
    const filter = readFilter(q)
    // The order belongs to the tasks view alone: the overview's "Recent tasks"
    // reads the same rows and must stay recent whatever the query says.
    const sort: TaskSort = view === 'tasks' && q?.sort === 'used' ? 'used' : 'recent'
    const flash = readFlash(q)
    const link = typeof q?.link === 'string' && Object.hasOwn(LINK_TEXT, q.link) ? q.link : null
    const viewer = await loadSession(request)

    // The sample console is the only place a prospect can see what the product
    // actually produces, so it is public. Without a session it renders against
    // a stand-in viewer and swaps the account chrome for a signup CTA. This
    // check must stay ABOVE the login return: it used to sit below it, which
    // made ?demo=1 reachable only to people who had already signed up.
    if (!viewer) {
      if (demo) {
        const sample = demoConsole(filter, RANGES[range].days, sort)
        return reply.send(consolePage({ v: DEMO_VIEWER, d: sample, demo: true, anon: true, range, view, filter, sort,
                                        suggest: view === 'tasks' ? readSuggest(demoHistory(sample.tasks), q) : null }))
      }
      return reply.send(loginPage(typeof q?.err === 'string' ? q.err : '', safeNext(q?.next)))
    }
    const providers = configuredProviders()

    const data = demo ? demoConsole(filter, RANGES[range].days, sort) : await loadConsole(viewer.accountId, RANGES[range].days, filter, sort)
    // The tasks view's suggested ceilings: the account's own finished jobs,
    // or, under sample data, the sample rows the same view lists below.
    const suggest = view !== 'tasks' ? null
      : readSuggest(demo ? demoHistory(data.tasks) : await loadHistory(viewer.accountId), q)
    // Apps connected over MCP (OAuth, src/lib/mcp-oauth.ts), on the keys view,
    // with the outcome of a Disconnect: a code from a closed set, never echoed.
    const apps = view === 'keys' && !demo ? await connectedApps(viewer.accountId) : []
    const appMsg = q?.app === 'disconnected' || q?.app === 'gone' ? q.app : null
    const keysMsg = q?.keys === 'revoked_all' || q?.keys === 'revoke_refused' || q?.keys === 'confirm' ? q.keys : null
    const via = asVia(q?.via)
    // The MCP path's prompt has a Copy control, the one script this page can
    // run, under its own hash and only where the control is drawn.
    if (via === 'mcp' && !demo) reply.header('Content-Security-Policy', APP_CSP.replace("default-src 'none'", `default-src 'none'; script-src ${COPY_HASH}`))
    return reply.send(consolePage({ v: viewer, d: data, demo, anon: false, range, view, filter, sort, apps, appMsg, keysMsg, via,
                                    flash: demo ? null : await verifyFlash(viewer.accountId, flash), suggest, link, providers }))
  })

  // The console's one write: open a job with a ceiling, or change one. A plain
  // HTML form, because this page ships no script (see APP_CSP). The rule and
  // the statement are in src/lib/task-ceiling.ts, shared with the API route,
  // and the outcome travels back on the query string the way login errors do:
  // ?saved=<task_ref> on success, ?err=<code>&ref=<task_ref> otherwise, both
  // validated again on the way in before anything is rendered.
  app.post('/app/tasks', publicRoute(), async (request, reply) => {
    if (!sameOrigin(request)) return reply.code(403).send({ error: 'forbidden' })
    const viewer = await loadSession(request)
    // No session, or a session that died with its key: the tasks view, which
    // is the login page for an anonymous visitor. Nothing was written.
    if (!viewer) return reply.redirect('/app?view=tasks', 303)

    const body = request.body as Record<string, unknown>
    const ref = typeof body?.task_ref === 'string' ? body.task_ref.trim() : ''
    const agent = typeof body?.agent_id === 'string' ? body.agent_id.trim() : ''
    // The amount arrives as ceiling (the form's field, since 2026-09-25) or
    // ceiling_units (the field before it, still accepted), in the unit the
    // form's select names: dollars for "usd", a whole number otherwise.
    const rawField = typeof body?.ceiling === 'string' ? body.ceiling : body?.ceiling_units
    const raw = typeof rawField === 'string' ? rawField.trim() : ''
    const unitRaw = body?.unit
    const unitSel: TaskUnit | undefined = typeof unitRaw === 'string' && (TASK_UNITS as readonly string[]).includes(unitRaw) ? unitRaw as TaskUnit : undefined
    // Which screen the answer lands on. The start screen posts back=start so a
    // reader on the three-step path stays on it; the tasks view's editor sends
    // nothing and lands where it always has. An allowlist of two, not an echo:
    // the value goes into a redirect.
    const backTo = body?.back === 'start' ? 'start' : 'tasks'
    const to = (extra: string) => reply.redirect(`/app?view=${backTo}&${extra}`, 303)
    const fail = (code: string) => to(`err=${code}${isId(ref) ? `&ref=${encodeURIComponent(ref)}` : ''}`)

    // The same 100/min bucket the API applies to this key, so the console is
    // not a less-limited path to the same table than the endpoint.
    if (!checkRateLimit(bucket(viewer)).allowed) return fail('rate')
    if (!isId(ref)) return fail('ref')
    if (agent && !isId(agent)) return fail('agent')
    // Digits only, then the int4 bound the column and the API both enforce.
    // Number('1e3') is 1000 and Number('') is 0; neither is a ceiling anyone typed.
    if (unitRaw !== undefined && unitSel === undefined) return fail('ceiling')
    // A ceiling in dollars is read exactly to the micro-dollar ("5", "5.00",
    // "$0.25"); any other unit is a whole number, as it always was.
    const amount = unitSel === 'usd'
      ? microsFromUsd(raw)
      : /^[0-9]{1,10}$/.test(raw) && Number(raw) >= 1 && Number(raw) <= INT4_MAX ? Number(raw) : null
    if (amount === null) return fail(unitSel === 'usd' ? 'usd' : 'ceiling')

    // The unit is read when this save opens the job and checked against one
    // that exists: a job's unit is fixed, so a save in another unit is refused
    // with the job's own unit in the answer, never a relabel. A form with no
    // unit (a row's editor for a job in tokens or units) checks nothing.
    const result = await setTaskCeiling(viewer.accountId, ref, amount, agent || null, unitSel)
    if (!result.ok && result.reason === 'unit_mismatch') return fail('unit')
    if (!result.ok) return to(`err=below&ref=${encodeURIComponent(ref)}&min=${result.reason === 'below_committed' ? result.minimum : 0}`)
    // An agent label typed for a job that already existed was not applied
    // (the label is read only when a save opens the job); say so.
    const kept = agent && !result.row.taskCreated ? '&agent=kept' : ''
    return to(`saved=${encodeURIComponent(ref)}${result.row.taskCreated ? '&created=1' : ''}${kept}`)
  })

  // The optional context the signup form used to ask for (name, what you are
  // building, language). It was asked on /register's key screen from
  // 2026-09-19 until that screen left with sign-in (2026-09-25); the endpoint
  // stays for any client that already posts to it, and JSON in and JSON out. Every field is optional and every field is bounded the way
  // RegisterBody bounds it; the two selects are closed sets, so they are
  // enums here and not free text.
  app.post('/app/profile', publicRoute(), async (request, reply) => {
    if (!sameOrigin(request)) return reply.code(403).send({ error: 'forbidden' })
    const viewer = await loadSession(request)
    if (!viewer) return reply.code(401).send({ error: 'unauthorized', message: 'Sign in to the console first.' })
    if (!checkRateLimit(bucket(viewer)).allowed) return reply.code(429).send({ error: 'rate_limited' })
    const parsed = ProfileBody.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(422).send({
        error: 'validation_error',
        message: [parsed.error.issues[0]?.path?.join('.'), parsed.error.issues[0]?.message].filter(Boolean).join(': '),
      })
    }
    // Only what was given is written. "" from an untouched select is not a
    // choice, and a blank name is not a name, so neither overwrites a value
    // the row already has.
    const patch: Record<string, string> = {}
    for (const k of ['name', 'use_case', 'stack'] as const) {
      const v = parsed.data[k]
      if (typeof v === 'string' && v.length > 0) patch[k] = v
    }
    if (Object.keys(patch).length === 0) {
      return reply.code(422).send({ error: 'validation_error', message: 'Nothing to save.' })
    }
    await sql`UPDATE accounts SET ${sql(patch)} WHERE id = ${viewer.accountId}`
    return reply.code(200).send({ saved: patch })
  })

  // The canonical-host redirect preserves a trailing slash; without this the
  // 404 handler's Bearer hook would answer /app/ with a JSON 401.
  app.get('/app/', publicRoute(), async (_request, reply) => reply.redirect('/app' + (_request.url.includes('?') ? _request.url.slice(_request.url.indexOf('?')) : ''), 301))

  app.post('/app/session', publicRoute(), async (request, reply) => {
    if (!sameOrigin(request)) return reply.code(403).send({ error: 'forbidden' })
    if (!allowLogin(limiterKey(request))) return reply.redirect('/app?err=rate', 303)
    const secret = sessionSecret()
    if (!secret) return reply.redirect('/app?err=unavailable', 303)

    const body = request.body as Record<string, unknown>
    const key = typeof body?.api_key === 'string' ? body.api_key.trim() : ''
    // Where to go after a good login. Validated, and carried across a failed
    // attempt so a buyer who mistypes the key is not dropped back on /app with
    // the tier forgotten.
    const next = safeNext(body?.next)
    // Only the one shape a key has reaches the database, as in the API
    // middleware; anything else is the same "not found" a wrong key gets.
    if (!isKeyShaped(key)) return reply.redirect(back('key', next), 303)

    // Decided in SQL, same reason as the API middleware: revoked_at is written
    // by the database clock, so an app-side comparison turns clock skew into a
    // window where a revoked key can still open the console.
    const [row] = await sql`
      SELECT id,
             (revoked_at IS NOT NULL AND revoked_at <= NOW()) AS is_revoked,
             (expires_at IS NOT NULL AND expires_at <= NOW()) AS is_expired
      FROM developer_api_keys
      WHERE key_hash = ${hashKey(key)}
      LIMIT 1
    `
    if (!row) return reply.redirect(back('key', next), 303)
    if (row.isRevoked) return reply.redirect(back('revoked', next), 303)
    if (row.isExpired) return reply.redirect(back('expired', next), 303)

    const cookie = sessionCookieFor(row.id as string)
    if (!cookie) return reply.redirect('/app?err=unavailable', 303)
    // One session per browser: a key sign-in ends a person's sign-in here,
    // or the console would have two answers to "who is this".
    reply.header('Set-Cookie', [cookie, CLEAR_USER_COOKIE])
    return reply.redirect(next || '/app', 303)
  })

  // Logout ends the session on the server as well as in this browser, for a
  // person: the epoch moves on, so a copy of the cookie taken before this
  // (another device, a stolen jar) stops working on its next request. A key
  // session still ends only in this browser and with its key, as before.
  app.post('/app/logout', publicRoute(), async (request, reply) => {
    if (!sameOrigin(request)) return reply.code(403).send({ error: 'forbidden' })
    const u = readUserSession(request.headers.cookie)
    if (u) await endSessions(u.userId, u.epoch)
    reply.header('Set-Cookie', [CLEAR_KEY_COOKIE, CLEAR_USER_COOKIE])
    return reply.redirect('/app', 303)
  })

  // The first key, made by the person it belongs to. An account created by a
  // sign-in is born with no key (src/lib/users.ts): the verified address comes
  // first and the key second, which is the whole of "no key to an unverified
  // email". The start screen's one button posts here; the answer is a 200 page
  // that shows the key once, not a redirect, because a key in a redirect's URL
  // lands in history, Referer headers and every log on the way.
  //
  // Only for a person, and only while the account has no working key: a key
  // session already holds one, and a second key is POST /keys/generate's job.
  // The row lock makes a double submit one key, not two.
  app.post('/app/keys/first', publicRoute(), async (request, reply) => {
    if (!sameOrigin(request)) return reply.code(403).send({ error: 'forbidden' })
    const viewer = await loadSession(request)
    if (!viewer) return reply.redirect('/app', 303)
    if (viewer.via !== 'user') return reply.redirect('/app?view=keys', 303)
    if (!checkRateLimit(bucket(viewer)).allowed) return reply.redirect('/app?view=start&err=rate', 303)
    const apiKey = await sql.begin(async (tx) => {
      await tx`SELECT id FROM accounts WHERE id = ${viewer.accountId} FOR UPDATE`
      const [live] = await tx`
        SELECT 1 AS ok FROM developer_api_keys
        WHERE account_id = ${viewer.accountId}
          AND (revoked_at IS NULL OR revoked_at > NOW())
          AND (expires_at IS NULL OR expires_at > NOW())
        LIMIT 1
      `
      if (live) return null
      return (await insertKey(tx, { accountId: viewer.accountId, label: 'default' })).key
    })
    if (!apiKey) return reply.redirect('/app?view=keys', 303)
    request.log.info({ accountId: viewer.accountId }, 'first key created from the console')
    reply.type('text/html').header('Cache-Control', 'no-store').header('Referrer-Policy', 'same-origin')
      .header('X-Robots-Tag', 'noindex')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', APP_CSP.replace("default-src 'none'", `default-src 'none'; script-src ${COPY_HASH}`))
    return reply.send(firstKeyPage(apiKey))
  })

  // "Revoke all keys", the console's half of POST /keys/revoke-all (the rule
  // and the recovery-path guard are revokeAllKeys in src/routes/keys.ts). A
  // form with a confirmation box, because it cannot be undone: every key on
  // the account stops authenticating, and every console opened with a key
  // (this one too, when it was) is signed out on its next request, because a
  // key session reads its key's state every time. A person's session stays:
  // it is not a key, and it is their way to a new one, the start screen's
  // "Create my API key". A key session's way back is /recover, which the
  // sign-in page it lands on says.
  app.post('/app/keys/revoke-all', publicRoute(), async (request, reply) => {
    if (!sameOrigin(request)) return reply.code(403).send({ error: 'forbidden' })
    const viewer = await loadSession(request)
    if (!viewer) return reply.redirect('/app', 303)
    if ((request.body as Record<string, unknown>)?.confirm !== 'yes') return reply.redirect('/app?view=keys&keys=confirm', 303)
    if (!checkRateLimit(bucket(viewer)).allowed) return reply.redirect('/app?view=keys&err=rate', 303)
    const done = await revokeAllKeys(viewer.accountId)
    if (!done.ok) return reply.redirect('/app?view=keys&keys=revoke_refused', 303)
    request.log.info({ accountId: viewer.accountId, count: done.count, via: viewer.via }, 'every key revoked from the console')
    if (viewer.via === 'key') {
      reply.header('Set-Cookie', CLEAR_KEY_COOKIE)
      return reply.redirect('/app?err=revoked_all', 303)
    }
    return reply.redirect('/app?view=keys&keys=revoked_all', 303)
  })

  // "Connect Google" / "Connect GitHub" in the console. The one way an account
  // made before sign-in existed gets an owner: somebody signed into it (with
  // its key, or as its owner) asks for it here, from this origin. Nothing ever
  // links by matching accounts.email. The account id travels in the signed
  // flow cookie, never in a URL.
  //
  // A 200 hand-off page, not a redirect: APP_CSP's form-action 'self' is
  // enforced by Chrome on every redirect after a form POST, so a 303 to
  // accounts.google.com would be blocked at the hop, silently (see APP_CSP).
  app.post('/app/connect/:provider', publicRoute(), async (request, reply) => {
    if (!sameOrigin(request)) return reply.code(403).send({ error: 'forbidden' })
    const p = (request.params as { provider: string }).provider
    const cfg = isProvider(p) ? providerConfig(p) : null
    if (!cfg) return reply.code(404).send({ error: 'not_found' })
    const viewer = await loadSession(request)
    if (!viewer) return reply.redirect('/app', 303)
    const flow = newFlow(cfg.provider, 'link', '', viewer.accountId)
    const cookie = flowCookie(flow)
    if (!cookie) return reply.redirect('/app?err=unavailable', 303)
    reply.type('text/html').header('Cache-Control', 'no-store').header('Referrer-Policy', 'same-origin')
      .header('X-Robots-Tag', 'noindex')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', APP_CSP)
      .header('Set-Cookie', cookie)
    return reply.send(connectHandoff(cfg.provider, authorizeUrl(cfg, flow)))
  })

  // Where the paid buttons on /pricing point. The pricing page cannot see the
  // console session (the cookie is scoped Path=/app, deliberately), so it sends
  // the click here, where the session IS visible, and this route decides:
  //
  //   session       a 200 hand-off page that refreshes into /checkout/:tier for
  //                 that account. A page, not a redirect: see APP_CSP for why a
  //                 redirect chain from the login form is blocked in Chrome.
  //   no session    the login page, with this path as its validated next, so
  //                 one paste of the key lands the buyer back here and on into
  //                 checkout. The page tells someone with no key where to get
  //                 one; it does not try to register them.
  //
  // Until 2026-09-09 those buttons went to /register for anyone not carrying
  // ?account_id, so a ready buyer with an account was sent to sign up again.
  app.get('/app/upgrade/:tier', publicRoute(), async (request, reply) => {
    const tier = (request.params as { tier: string }).tier
    if (!TIERS.has(tier)) return reply.redirect('/pricing', 302)
    const viewer = await loadSession(request)
    reply.type('text/html').header('Cache-Control', 'no-store').header('Referrer-Policy', 'same-origin')
      .header('X-Robots-Tag', 'noindex')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', APP_CSP)
    if (!viewer) return reply.send(loginPage('', `/app/upgrade/${tier}`))
    return reply.send(handoffPage(tier, checkoutPath(tier, viewer.accountId)))
  })
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

// sessionSecret, safeEqual and readCookie live in src/lib/session-secret.ts
// since 2026-09-25, shared with the user session and the OAuth flow cookie.
const sign = (payload: string, secret: string): string => hmacHex(secret, payload)

function mintToken(keyId: string, secret: string): string {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE
  const payload = `${keyId}.${exp}`
  return `${payload}.${sign(payload, secret)}`
}

/** Ends a key session in this browser. Every sign-in as a person sends it, so
 *  a browser is never signed in two ways at once. */
export const CLEAR_KEY_COOKIE = `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/app; Max-Age=0`

/**
 * The Set-Cookie value that signs a browser into the console as `keyId`: the
 * legacy key login, POST /app/session. Until 2026-09-25 POST /register minted
 * it too, on the 201 that carried a new key; register no longer issues keys
 * (src/routes/register.ts), so the key login is its one caller. Null when this
 * server has no session secret.
 */
export function sessionCookieFor(keyId: string): string | null {
  const secret = sessionSecret()
  if (!secret) return null
  return `${COOKIE}=${mintToken(keyId, secret)}; HttpOnly; Secure; SameSite=Lax; Path=/app; Max-Age=${MAX_AGE}`
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


/**
 * A person's session. The epoch is compared against the row, so a cookie
 * minted before the last logout is dead however valid its signature. The key
 * it reads as is the account's oldest working one, or none: an account a
 * sign-in created has no key until its start screen makes one.
 */
async function loadUserViewer(u: { userId: string; epoch: number }): Promise<Viewer | null> {
  const [row] = await sql`
    SELECT u.id AS user_id, u.email AS user_email, u.session_epoch,
           a.id AS account_id, a.email, a.plan, a.monthly_calls, a.default_budget_units
    FROM users u JOIN accounts a ON a.owner_user_id = u.id
    WHERE u.id = ${u.userId}
  `
  if (!row || Number(row.sessionEpoch) !== u.epoch) return null
  const [key] = await sql`
    SELECT id, key_prefix, key_last4, label FROM developer_api_keys
    WHERE account_id = ${row.accountId}
      AND (revoked_at IS NULL OR revoked_at > NOW())
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY created_at ASC LIMIT 1
  `
  return {
    keyId: (key?.id as string) ?? '',
    keyMask: key ? maskKey(key.keyPrefix as string, key.keyLast4 as string) : '',
    keyLabel: (key?.label as string | null) ?? null,
    accountId: row.accountId as string,
    email: (row.email as string | null) ?? null,
    plan: (row.plan as string) ?? 'free',
    monthlyCalls: Number(row.monthlyCalls ?? 0),
    defaultBudgetUnits: row.defaultBudgetUnits == null ? null : Number(row.defaultBudgetUnits),
    via: 'user',
    userId: row.userId as string,
    userEmail: row.userEmail as string,
    linked: await linkedProviders(row.accountId as string),
  }
}

/** Whether this browser holds a live console session of either kind. */
export async function hasSession(request: FastifyRequest): Promise<boolean> {
  return (await loadSession(request)) !== null
}

export async function loadSession(request: FastifyRequest): Promise<Viewer | null> {
  const u = readUserSession(request.headers.cookie)
  if (u) {
    const v = await loadUserViewer(u)
    if (v) return v
  }
  const secret = sessionSecret()
  if (!secret) return null
  const token = readCookie(request.headers.cookie ?? '', COOKIE)
  if (!token) return null
  const keyId = verifyToken(token, secret)
  if (!keyId) return null

  const [row] = await sql`
    SELECT k.id AS key_id, k.key_prefix, k.key_last4, k.label,
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
    keyMask: maskKey(row.keyPrefix as string, row.keyLast4 as string),
    keyLabel: (row.label as string | null) ?? null,
    accountId: row.accountId as string,
    email: (row.email as string | null) ?? null,
    plan: (row.plan as string) ?? 'free',
    monthlyCalls: Number(row.monthlyCalls ?? 0),
    defaultBudgetUnits: row.defaultBudgetUnits == null ? null : Number(row.defaultBudgetUnits),
    via: 'key',
    userId: null,
    userEmail: null,
    linked: await linkedProviders(row.accountId as string),
  }
}

// CSRF guard for the two form POSTs. Sec-Fetch-Site is set by the browser
// and cannot be forged by a page, so when it is present it decides: only
// same-origin passes. Without it (old browsers, curl) fall back to the Origin
// host. A literal `Origin: null` is what a browser sends for a POST under a
// no-referrer policy, so it counts only when Sec-Fetch-Site already vouched.
/**
 * Exported because /recover posts too, and a second copy of this would be a
 * second chance to reintroduce the Fastify 5 host/hostname bug documented below.
 */
// Mirrors RegisterBody in register.ts for the two free-text bounds; the two
// selects are the option lists the key screen renders, nothing else.
const ProfileBody = z.object({
  name:     plain(z.string().trim().max(128)).optional(),
  use_case: z.enum(['', 'ai_saas', 'internal_agents', 'agent_platform', 'research', 'other']).optional(),
  stack:    z.enum(['', 'python', 'nodejs', 'other']).optional(),
})

export function sameOrigin(request: FastifyRequest): boolean {
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

/**
 * Stricter than sameOrigin(): true only when the browser SAID the request is
 * same-origin, by Sec-Fetch-Site or by an Origin that matches this host. A
 * request with neither header (curl, an SDK) is allowed through sameOrigin()
 * because it cannot be a cross-site form, but it is not proven to come from
 * our own page either, so nothing that signs a browser in is handed to it.
 */
export function provenSameOrigin(request: FastifyRequest): boolean {
  const sfs = request.headers['sec-fetch-site']
  if (typeof sfs === 'string') return sfs === 'same-origin'
  const origin = request.headers.origin
  if (typeof origin !== 'string') return false
  try { return new URL(origin).host === request.host } catch { return false }
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
  // Not in the rail: it is where a new key lands and where the overview sends
  // an account that has no refusal yet, and a rail item for "start" beside
  // "overview" is two names for the same first screen.
  start:     { title: 'Start',        lede: 'Connect once, and your first recorded call shows up here with its tokens and what it cost at list price.', hidden: true },
  overview:  { title: 'Overview',     lede: 'What ran, what was refused, and the one number that should be zero.' },
  activity:  { title: 'Activity',     lede: 'What your calls cost at list price, the tokens they used and the calls refused, day by day, split by event_type.' },
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

/** The tasks view's order. recent: most recently touched first, the order it
 *  always had. used: most used_units first, the ranking GET /tasks?sort=used
 *  gives too. Ties break the way each surface's default orders: by recency
 *  here, by creation on the API. */
type TaskSort = 'recent' | 'used'
const TASK_SORTS: Record<TaskSort, string> = { recent: 'Recent', used: 'Most used' }

/** The day the preflight span's records begin: migration 006 (99f0934) gave
 *  every approved preflight a reservations row. Refusal rows begin a day
 *  earlier, with 005, so this is the later of the two. */
const PREFLIGHT_RECORDS_SINCE = '2026-09-03'

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

/** One day. units is what the code reported (tokens for a wrap() call, the
 *  developer's own count otherwise); usd is the list-price estimate over the
 *  day's priced calls and priced how many there were, so a day with calls and
 *  no price reads as unpriced, never as $0; tokens is what providers reported. */
type Series = { day: string; blocks: number; units: number; refused: number; usd: number; priced: number; tokens: number; calls: number }
/** What POST /app/tasks left on the query string for the tasks view to say. */
type Flash = { saved?: string; created?: boolean; agentKept?: boolean; err?: 'ref' | 'ceiling' | 'agent' | 'below' | 'rate' | 'usd' | 'unit'; ref?: string; min?: number
  /** The named job's unit, read off its row by verifyFlash, never off the URL. */
  unit?: string }
const FLASH_ERRS = new Set(['ref', 'ceiling', 'agent', 'below', 'rate', 'usd', 'unit'])

/** Shape only. readFlash accepts what a redirect from POST /app/tasks would
 *  carry; verifyFlash below decides what may be shown. */
function readFlash(q: Record<string, unknown>): Flash | null {
  const f: Flash = {}
  if (isId(q?.saved)) f.saved = q.saved as string
  if (q?.created === '1') f.created = true
  if (q?.agent === 'kept') f.agentKept = true
  if (typeof q?.err === 'string' && FLASH_ERRS.has(q.err)) f.err = q.err as Flash['err']
  if (isId(q?.ref)) f.ref = q.ref as string
  if (typeof q?.min === 'string' && /^[0-9]{1,13}$/.test(q.min)) f.min = Number(q.min)
  return Object.keys(f).length ? f : null
}

/**
 * A task_ref on the query string is text anyone can put in a link. It is only
 * echoed inside a status line when a job with that name exists on THIS
 * account, and the committed number for err=below comes from that row, not
 * from the URL. Otherwise the line is generic. Same discipline as loginPage,
 * which reflects codes and never free text. One row read, only when a flash
 * names a task.
 */
async function verifyFlash(accountId: string, f: Flash | null): Promise<Flash | null> {
  if (!f) return null
  const name = f.saved ?? f.ref
  if (!name) return f
  const [row] = await sql`
    SELECT used_units, reserved_units, unit FROM task_budgets
    WHERE account_id = ${accountId} AND task_ref = ${name}
  `
  if (!row) return { ...f, saved: f.saved ? '' : undefined, ref: undefined, min: undefined }
  return { ...f, unit: String(row.unit ?? 'unit'), min: f.err === 'below' ? Number(row.usedUnits) + Number(row.reservedUnits) : undefined }
}

// ---------------------------------------------------------------------------
// The tasks view's suggested ceiling (2026-09-23): per agent, the p50, p90
// and max used_units of its last HISTORY_JOBS finished jobs, from this
// account's own rows, in units. It writes nothing. Each figure is a link that
// reloads the tasks view with that number in the ceiling field and the
// agent's label beside it, both still editable, and the save is the reader's,
// through the same form. The arithmetic is src/lib/ceiling-suggest.ts.
//
// "Finished" has to be defined here, because no event marks a job as done.
// A job counts once it has spent units and holds no reservation
// (used_units > 0 AND reserved_units = 0), and a job still carrying the
// console's placeholder label is left out, because no agent has claimed it.
// So a job resting between two calls counts, and a call that never records
// keeps its job out until its reservation expires (RESERVATION_TTL_MINUTES)
// and the sweeper releases it (every SWEEP_INTERVAL_MS). The fine print under
// the suggestion says the same, from the same constants.
// ---------------------------------------------------------------------------

/** What the tasks view shows beside its form: the rows, and a figure the reader picked. */
type Suggest = {
  history: AgentHistory[]
  /** Recomputed from the rows on every load, never read off the URL. */
  pick: { agentId: string; which: Pick; units: number; jobs: number; unit: string } | null
}

/**
 * This account's finished jobs, HISTORY_JOBS per agent, for the
 * HISTORY_AGENTS agents whose latest finished job is the most recent. The
 * account clause is what keeps another account's jobs, under the same agent
 * label or any other, out of this account's figures; the harness holds it.
 */
async function loadHistory(accountId: string): Promise<HistoryJob[]> {
  const rows = await sql`
    WITH finished AS (
      SELECT agent_id, used_units, updated_at, unit, task_ref,
             row_number() OVER (PARTITION BY agent_id ORDER BY updated_at DESC, id DESC) AS rn
      FROM task_budgets
      WHERE account_id = ${accountId}
        AND used_units > 0
        AND reserved_units = 0
        AND agent_id <> ${CONSOLE_AGENT}
    ),
    agents AS (
      SELECT agent_id, max(updated_at) AS last_at
      FROM finished
      GROUP BY agent_id
      ORDER BY last_at DESC, agent_id COLLATE "C"
      LIMIT ${HISTORY_AGENTS}
    )
    SELECT f.agent_id, f.used_units, f.updated_at, f.unit, c.usd::text AS usd, coalesce(c.priced, 0) AS priced, coalesce(c.calls, 0) AS calls
    FROM finished f JOIN agents a ON a.agent_id = f.agent_id
    LEFT JOIN LATERAL (
      SELECT sum(list_price_usd) AS usd, count(list_price_usd) AS priced, count(*) AS calls
      FROM events WHERE account_id = ${accountId} AND task_ref = f.task_ref
    ) c ON true
    WHERE f.rn <= ${HISTORY_JOBS}
  `
  // A job's dollar total is offered only when every one of its calls was
  // priced; a job in dollars counts them already (src/lib/ceiling-suggest.ts).
  return rows.map((r) => {
    const unit = String(r.unit ?? 'unit')
    const calls = Number(r.calls), priced = Number(r.priced)
    const usdMicros = unit === 'usd' ? Number(r.usedUnits) : calls > 0 && priced === calls && r.usd != null ? microsFromListPrice(String(r.usd)) : null
    return { agentId: String(r.agentId), usedUnits: Number(r.usedUnits), updatedAt: new Date(r.updatedAt as Date), unit, usdMicros }
  })
}

/** The same test as loadHistory, on the sample rows ?demo=1 lists, so the
 *  sample suggestion is worked out from the jobs on the same page. */
function demoHistory(tasks: TaskRow[]): HistoryJob[] {
  return tasks
    .filter((t) => Number(t.usedUnits) > 0 && Number(t.reservedUnits) === 0 && t.agentId !== CONSOLE_AGENT)
    .map((t) => ({ agentId: t.agentId, usedUnits: Number(t.usedUnits), updatedAt: new Date(t.updatedAt), unit: t.unit ?? 'unit' }))
}

/** The pick names an agent and a statistic; the number comes from the rows,
 *  so a link naming an agent this account has no finished job for fills nothing. */
function readSuggest(rows: HistoryJob[], q: Record<string, unknown>): Suggest {
  const history = summarizeHistory(rows)
  const which = PICKS.find((k) => k === q?.pick)
  const row = isId(q?.history) ? history.find((h) => h.agentId === q.history) : undefined
  return { history, pick: row && which ? { agentId: row.agentId, which, units: row[which], jobs: row.jobs, unit: row.unit } : null }
}

/** firstSeen, lastSeen and preflights describe the preflights on record for
 *  this job, approved or refused. See loadConsole for where they come from,
 *  why they can be fewer than the preflights the job made, and why
 *  task_budgets' own timestamps are not them. */
// unit and usageMissingCalls are absent on the demo rows, which read as 'unit' and 0.
// usd is the list-price estimate over the job's priced calls (null when none
// is priced, never 0 for "unpriced"), from events.task_ref (migration 017).
type TaskRow = { taskRef: string; agentId: string; ceilingUnits: number; usedUnits: number; reservedUnits: number; unit?: string; usageMissingCalls?: number; updatedAt: Date
                 firstSeen: Date | null; lastSeen: Date | null; preflights: number
                 usd?: number | null; pricedCalls?: number; calls?: number; tokens?: number; unpricedCalls?: number }
// usedUnits and limitUnits count units and tokens, never a dollar job's
// micro-dollars; usd is what the customer's priced calls cost at list price,
// null when none is priced (2026-09-25).
type CustomerRow = { customerRef: string; limitUnits: number | null; usedUnits: number; reservedUnits: number; usd?: number | null; pricedCalls?: number }
type KeyRow = { id: string; keyPrefix: string; keyLast4: string; label: string | null; createdAt: Date; revokedAt: Date | null; expiresAt: Date | null; lastSeenIp: string | null }
// unit is the job's (task_budgets.unit, joined on task_ref), so a refusal on a
// job counted in tokens says tokens. Absent for a call that named no job.
type DecisionRow = { agentId: string | null; taskRef: string | null; reason: string; blocked: boolean; estimatedUnits: number | null; ceilingUnits: number | null; usedUnits: number | null; snapshot: string; createdAt: Date; unit?: string | null }

/** The account's first recorded model call: the one the start screen ends on.
 *  usd null means it could not be priced, and note says why. */
type FirstCall = { model: string; step: string | null; taskRef: string | null; tokens: number; usd: number | null; note: string | null; createdAt: Date }

// Everything a page shows is here or derived from here. The in-period counts
// (blocked, units recorded, units refused) are sums over `series`, so a tile and
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
  /** The window's recorded units split by event_type (src/lib/usage.ts, the
   *  same function GET /usage runs). Its total is the units-metered sum of
   *  `series`, because both read events over the same window. */
  usage: EventTypeUsage
  decisions: DecisionRow[]
  /** Rows matching the current filter, across the whole account. */
  decisionMatched: number
  truncated: boolean
  /** Whether this account has recorded anything at all, ever. */
  recorded: boolean
  /** Whether any call on this account was ever priced. Until one is, the
   *  console shows units, the only number it has; after, the list-price
   *  estimate leads and tokens sit beside it. */
  pricedEver: boolean
  first: FirstCall | null
}

async function loadConsole(accountId: string, days: number, f: Filter, sort: TaskSort = 'recent'): Promise<Console> {
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
           coalesce(e.units, 0)     AS units,
           coalesce(e.usd, 0)       AS usd,
           coalesce(e.priced, 0)    AS priced,
           coalesce(e.tokens, 0)    AS tokens,
           coalesce(e.calls, 0)     AS calls
    FROM generate_series(current_date - ${days - 1}::int, current_date, interval '1 day') d
    LEFT JOIN (
      SELECT created_at::date AS day, count(*) AS blocks, coalesce(sum(estimated_units), 0) AS refused
      FROM preflight_decisions
      WHERE account_id = ${accountId} AND blocked AND created_at >= current_date - ${days - 1}::int
      GROUP BY 1
    ) b ON b.day = d::date
    LEFT JOIN (
      SELECT created_at::date AS day, sum(units) AS units, sum(list_price_usd) AS usd,
             count(list_price_usd) AS priced, sum(${sql.unsafe(EVENT_TOKENS_SQL)}) AS tokens, count(*) AS calls
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
  // The page of jobs, then the preflights on record for each one. An
  // approved preflight leaves a reservations row and a refused one a
  // preflight_decisions row with source 'preflight'; both are stamped at
  // insert and neither is ever deleted (a settle or the sweeper only releases
  // a reservation). "On record" and not "seen", because the rows are fewer
  // than the preflights: reservations exist from PREFLIGHT_RECORDS_SINCE
  // (migration 006), so a job a preflight opened before then has no row for
  // it, and a refusal row is written fire-and-forget (recordDecision), so a
  // failed write drops that refusal. GET /tasks returns none of this, and
  // the footer says so on every page that draws a span.
  // task_budgets' own timestamps are not used, on purpose:
  // created_at is when the job was opened, from code or from the console, and
  // updated_at also moves on a ceiling save and when the sweeper releases an
  // expired reservation, neither of which is a call. An ordinary record()
  // leaves no per-task timestamp (events carry no task_ref; only a record
  // that lands past the ceiling leaves a decision row, with source 'events'),
  // which is why the row counts preflights and says preflight, not call.
  // Most used is the ranking GET /tasks?sort=used gives (src/lib/task-rank.ts):
  // dollars first where a job has them, then tokens, then units, never one
  // unit's number against another's. The outer query orders the page by the
  // position the inner one gave it.
  const order = () => sort === 'used' ? sql.unsafe(`${rankOrderSql('task_budgets')}, updated_at DESC`) : sql`updated_at DESC`
  const tasks = await sql`
    WITH page AS (
      SELECT task_ref, agent_id, ceiling_units, used_units, reserved_units, unit, usage_missing_calls, unpriced_calls, updated_at,
             row_number() OVER (ORDER BY ${order()}) AS pos
      FROM task_budgets
      WHERE account_id = ${accountId}
      ORDER BY ${order()}
      LIMIT 20
    ), spans AS (
      SELECT task_ref, min(at) AS first_seen, max(at) AS last_seen, count(*) AS preflights
      FROM (
        SELECT task_ref, created_at AS at FROM reservations
        WHERE account_id = ${accountId} AND task_ref IN (SELECT task_ref FROM page)
        UNION ALL
        SELECT task_ref, created_at AS at FROM preflight_decisions
        WHERE account_id = ${accountId} AND source = 'preflight' AND task_ref IN (SELECT task_ref FROM page)
      ) seen
      GROUP BY task_ref
    )
    , cost AS (
      SELECT task_ref, sum(list_price_usd) AS usd, count(list_price_usd) AS priced_calls, count(*) AS calls,
             sum(${sql.unsafe(EVENT_TOKENS_SQL)}) AS tokens
      FROM events
      WHERE account_id = ${accountId} AND task_ref IN (SELECT task_ref FROM page)
      GROUP BY task_ref
    )
    SELECT page.task_ref, page.agent_id, page.ceiling_units, page.used_units, page.reserved_units, page.unit, page.usage_missing_calls, page.unpriced_calls, page.updated_at,
           spans.first_seen, spans.last_seen, coalesce(spans.preflights, 0) AS preflights,
           cost.usd, coalesce(cost.priced_calls, 0) AS priced_calls, coalesce(cost.calls, 0) AS calls, coalesce(cost.tokens, 0) AS tokens
    FROM page LEFT JOIN spans ON spans.task_ref = page.task_ref
              LEFT JOIN cost ON cost.task_ref = page.task_ref
    ORDER BY page.pos
  `
  // Heaviest first by the list-price estimate where a customer has priced
  // calls, then by units: the same honest order the tasks view uses, so a
  // customer's micro-dollars never compete with another's tokens.
  const customers = await sql`
    SELECT c.customer_ref, c.limit_units, c.used_units, c.reserved_units, e.usd::text AS usd, coalesce(e.priced, 0) AS priced_calls
    FROM customers c
    LEFT JOIN LATERAL (
      SELECT sum(list_price_usd) AS usd, count(list_price_usd) AS priced
      FROM events WHERE customer_id = c.id AND list_price_usd IS NOT NULL
    ) e ON true
    WHERE c.account_id = ${accountId}
    ORDER BY e.usd DESC NULLS LAST, c.used_units DESC, c.created_at DESC
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
    SELECT id, key_prefix, key_last4, label, created_at, revoked_at, expires_at, last_seen_ip
    FROM developer_api_keys
    WHERE account_id = ${accountId}
    ORDER BY created_at ASC
  `
  // Priced ever, recorded ever, and the first model call: each one indexed
  // read that stops at its first row.
  const [ever] = await sql`
    SELECT EXISTS (SELECT 1 FROM events WHERE account_id = ${accountId}) AS recorded,
           EXISTS (SELECT 1 FROM events WHERE account_id = ${accountId} AND list_price_usd IS NOT NULL) AS priced
  `
  const pricedEver = ever?.priced === true
  const usage = await usageByEventType(accountId, days, 20, pricedEver ? 'usd' : 'units')
  const [firstRow] = await sql`
    SELECT metadata->>'model' AS model, nullif(metadata->>'step', '') AS step, task_ref,
           list_price_usd::text AS usd, price_note, (${sql.unsafe(EVENT_TOKENS_SQL)}) AS tokens, created_at
    FROM events
    WHERE account_id = ${accountId} AND jsonb_typeof(metadata->'tokens') = 'object'
      AND coalesce(metadata->>'model', '') <> ''
    ORDER BY created_at, id
    LIMIT 1
  `
  const decisions = await sql`
    SELECT d.agent_id, d.task_ref, d.reason, d.blocked, d.estimated_units, d.ceiling_units,
           d.used_units, d.snapshot::text AS snapshot, d.created_at, tb.unit
    FROM preflight_decisions d
    LEFT JOIN task_budgets tb ON tb.account_id = d.account_id AND tb.task_ref = d.task_ref
    WHERE d.account_id = ${accountId}
      ${f.task ? sql`AND d.task_ref = ${f.task}` : sql``}
      ${f.agent ? sql`AND d.agent_id = ${f.agent}` : sql``}
      ${f.only === 'leaks' ? sql`AND NOT d.blocked` : sql``}
    ORDER BY d.created_at DESC, d.id DESC
    LIMIT 100
  `
  const byReason: Record<string, number> = {}
  for (const r of reasons) byReason[String(r.reason)] = Number(r.n)
  return {
    decisionTotal: Number(totals?.total ?? 0),
    overruns: Number(totals?.overruns ?? 0),
    lastBlock: (totals?.lastBlock as Date | null) ?? null,
    prevBlocked: Number(prev?.blocks ?? 0),
    series: (series as unknown as Series[]).map((s) => ({ day: s.day, blocks: Number(s.blocks), units: Number(s.units), refused: Number(s.refused),
                                                          usd: Number(s.usd), priced: Number(s.priced), tokens: Number(s.tokens), calls: Number(s.calls) })),
    byReason,
    tasks: (tasks as unknown as TaskRow[]).map((t) => ({ ...t, preflights: Number(t.preflights),
      usd: Number(t.pricedCalls) > 0 ? Number(t.usd) : null, pricedCalls: Number(t.pricedCalls), calls: Number(t.calls), tokens: Number(t.tokens) })),
    taskCount: Number(ttotal?.n ?? 0),
    taskLive: Number(ttotal?.live ?? 0),
    taskNear: Number(ttotal?.near ?? 0),
    customers: (customers as unknown as CustomerRow[]).map((c) => ({ ...c, usd: Number(c.pricedCalls) > 0 ? Number(c.usd) : null, pricedCalls: Number(c.pricedCalls) })),
    customerCount: Number(ctotal?.n ?? 0),
    customerWithLimit: Number(ctotal?.withLimit ?? 0),
    customerTotal: Number(ctotal?.total ?? 0),
    keys: keys as unknown as KeyRow[],
    usage,
    decisions: decisions as unknown as DecisionRow[],
    decisionMatched: Number(matched?.n ?? 0),
    // From the count, not the page length: exactly 100 matching rows is a
    // complete list, and the page length alone called it "100 of 100".
    truncated: Number(matched?.n ?? 0) > decisions.length,
    recorded: ever?.recorded === true,
    pricedEver,
    first: firstRow ? {
      model: String(firstRow.model), step: (firstRow.step as string | null) ?? null, taskRef: (firstRow.taskRef as string | null) ?? null,
      tokens: Number(firstRow.tokens ?? 0), usd: firstRow.usd == null ? null : Number(firstRow.usd),
      note: (firstRow.priceNote as string | null) ?? null, createdAt: firstRow.createdAt as Date,
    } : null,
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
  keyMask: maskKey(keyPrefixOf(DEMO_KEY), keyLast4Of(DEMO_KEY)),
  keyLabel: DEMO_KEY_LABEL,
  accountId: 'demo',
  email: null,
  plan: 'builder',
  monthlyCalls: 12480,
  defaultBudgetUnits: 5000,
  via: 'key',
  userId: null,
  userEmail: null,
  linked: [],
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
export function demoConsole(f: Filter = {}, days = 30, sort: TaskSort = 'recent'): Console {
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
    // The sample account records in units of its own and names no model, so
    // it has nothing to price: the console shows it the way it shows any
    // account without a priced call, in units. The homepage renders these
    // same rows, which is why they stay one sample account in one unit.
    return { day: iso(shape.length - 1 - i), blocks, units: n * 40, refused: blocks * DEMO_AVG_ASK, usd: 0, priced: 0, tokens: 0, calls: Math.round(n * 40 / 35) }
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
  // Each snapshot is the body preflight.ts actually sends for that reason, field
  // for field: approved, reason, estimated_units, then the reason's own detail.
  // There is no `message` on the wire. The sentence a person reads is composed
  // by decisionLine() from these columns; the "Task ... blocked" text that used
  // to sit here is the SDK's client-side exception string, not the response.
  const all = [
    mk(0, 22, 'researcher', 'job-8871', 'task_ceiling_exceeded', true, 40, 500, 492,
      { approved: false, reason: 'task_ceiling_exceeded', estimated_units: 40, task_ref: 'job-8871', task_ceiling: 500, task_used_units: 492, task_remaining_units: 8 }),
    mk(0, 74, 'crawler', 'nightly-crawl', 'task_ceiling_exceeded', true, 200, 2000, 1840,
      { approved: false, reason: 'task_ceiling_exceeded', estimated_units: 200, task_ref: 'nightly-crawl', task_ceiling: 2000, task_used_units: 1840, task_remaining_units: 160 }),
    mk(0, 190, 'enricher', 'batch-2211', 'task_ceiling_exceeded', true, 25, 1000, 1000,
      { approved: false, reason: 'task_ceiling_exceeded', estimated_units: 25, task_ref: 'batch-2211', task_ceiling: 1000, task_used_units: 1000, task_remaining_units: 0 }),
    mk(1, 30, 'summarizer', null, 'ceiling_exceeded', true, 120, 50, null,
      { approved: false, reason: 'ceiling_exceeded', estimated_units: 120, ceiling: 50, remaining_units: null }),
    mk(1, 410, 'researcher', 'job-8864', 'budget_exhausted', true, 60, null, 1000,
      { approved: false, reason: 'budget_exhausted', estimated_units: 60, remaining_units: 0 }),
  ]
  // The one leak: a record that landed on batch-2211 an hour ago with no
  // preflight, after the ceiling had refused it two hours earlier. Inserted
  // in time order so the list stays newest first, and the task row below
  // carries the same 1,025, so the overview, the task and the row agree.
  all.splice(1, 0, mk(0, 60, 'enricher', 'batch-2211', 'task_overrun_recorded', false, 25, 1000, 1025,
    { recorded: true, task_ref: 'batch-2211', task_used_units: 1025, task_remaining_units: 0, task_exceeded: true, note: 'recorded past the ceiling: preflight was skipped for this call' }))
  const decisions = all.filter((d) => (!f.task || d.taskRef === f.task) && (!f.agent || d.agentId === f.agent) && (f.only !== 'leaks' || !d.blocked))
  // Heaviest first, the order a real account gets from ORDER BY used_units
  // DESC in loadConsole(): the list says "heaviest first", and the overview takes
  // the first five of it as the top customers. Sorted here as well as written
  // in order, so an edit to a number cannot put the heaviest last again.
  const customers: CustomerRow[] = [
    { customerRef: 'cust_umbrella', limitUnits: null, usedUnits: 9310, reservedUnits: 0 },
    { customerRef: 'cust_acme',     limitUnits: 5000, usedUnits: 4820, reservedUnits: 0 },
    { customerRef: 'cust_globex',   limitUnits: 5000, usedUnits: 2140, reservedUnits: 30 },
    { customerRef: 'cust_initech',  limitUnits: 1000, usedUnits: 1000, reservedUnits: 0 },
  ].sort((x, y) => y.usedUnits - x.usedUnits)
  const ago = (mins: number) => new Date(Date.now() - mins * 60_000)
  // lastSeen is the latest preflight the sample job made, approved or
  // refused, so it agrees with the refusal rows above: job-8871 was refused
  // 22 minutes ago, nightly-crawl 74, batch-2211 190. batch-2211 was touched
  // more recently than that (updatedAt, 60 minutes) by the record that
  // leaked, and a record is not a preflight, so its span stops at 190.
  const sampleTasks: TaskRow[] = [
      { taskRef: 'job-8871', agentId: 'researcher',  ceilingUnits: 500,  usedUnits: 492, reservedUnits: 0,  updatedAt: ago(22),
        firstSeen: ago(240), lastSeen: ago(22), preflights: 13 },
      { taskRef: 'job-8870', agentId: 'summarizer',  ceilingUnits: 200,  usedUnits: 96,  reservedUnits: 12, updatedAt: ago(180),
        firstSeen: ago(205), lastSeen: ago(180), preflights: 9 },
      { taskRef: 'nightly-crawl', agentId: 'crawler', ceilingUnits: 2000, usedUnits: 1840, reservedUnits: 60, updatedAt: ago(300),
        firstSeen: ago(430), lastSeen: ago(74), preflights: 11 },
      { taskRef: 'job-8864', agentId: 'researcher',  ceilingUnits: 500,  usedUnits: 118, reservedUnits: 0,  updatedAt: day(1),
        firstSeen: ago(1920), lastSeen: ago(1440), preflights: 4 },
      { taskRef: 'batch-2211', agentId: 'enricher',  ceilingUnits: 1000, usedUnits: 1025, reservedUnits: 0, updatedAt: ago(60),
        firstSeen: ago(340), lastSeen: ago(190), preflights: 41 },
  ]
  // The two orders loadConsole gives, applied to the sample rows, so the
  // toggle means the same thing under sample data.
  const recent = (a: TaskRow, b: TaskRow) => b.updatedAt.getTime() - a.updatedAt.getTime()
  const tasks = [...sampleTasks].sort(sort === 'used' ? (a, b) => b.usedUnits - a.usedUnits || recent(a, b) : recent)
  // The window's units split by event_type, cut from the same total the
  // chart and the tiles sum, so the split cannot disagree with them. The
  // labels are the sample agents because that is what record() sends as
  // event_type; the last one takes the remainder so the parts sum exactly.
  const metered = series.reduce((a, x) => a + x.units, 0)
  const split: Array<[string, number, number]> = [['crawler', 0.5, 50], ['enricher', 0.28, 25], ['researcher', 0.18, 40], ['summarizer', 0, 12]]
  let rest = metered
  const groups = split.map(([eventType, frac, perRecord], i) => {
    const units = i === split.length - 1 ? rest : Math.round(metered * frac)
    rest -= units
    return { eventType, units, events: units > 0 ? Math.max(1, Math.round(units / perRecord)) : 0, usd: null, pricedEvents: 0, tokens: 0 }
  }).filter((g) => g.units > 0).sort((a, b) => b.units - a.units || a.eventType.localeCompare(b.eventType))
  const usage: EventTypeUsage = {
    since: iso(days - 1),
    totalUnits: metered,
    totalEvents: groups.reduce((a, g) => a + g.events, 0),
    totalUsd: null,
    totalPriced: 0,
    groupCount: groups.length,
    groups,
  }
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
      { id: 'demo', keyPrefix: keyPrefixOf(DEMO_KEY), keyLast4: keyLast4Of(DEMO_KEY), label: DEMO_KEY_LABEL, createdAt: day(38), revokedAt: null, expiresAt: null, lastSeenIp: '203.0.113.42' },
      { id: 'demo-ci', keyPrefix: keyPrefixOf(DEMO_KEY_CI), keyLast4: keyLast4Of(DEMO_KEY_CI), label: 'ci', createdAt: day(12), revokedAt: null, expiresAt: day(-9), lastSeenIp: '198.51.100.7' },
    ],
    usage,
    decisions,
    decisionMatched: decisions.length,
    truncated: false,
    recorded: true,
    pricedEver: false,
    first: null,
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

/**
 * A list-price estimate as the console prints it. Under a cent it keeps two
 * significant figures, because one short call costs a fraction of a cent and
 * rounding it to $0.00 would print the $0 a priced call must never read as.
 * The figure is always one the server stored (events.list_price_usd); every
 * place that prints one labels it as an estimate at list price.
 */
function usd(n: number): string {
  // One formatter for every dollar on the page (src/lib/task-ceiling.ts), at
  // micro-dollar resolution, the ledger's own.
  return usdAmount(n)
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

export const REASON_LABEL: Record<string, string> = {
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
export function decisionLine(r: DecisionRow): string {
  let body: Record<string, unknown> = {}
  try { body = JSON.parse(r.snapshot) as Record<string, unknown> } catch { /* verbatim below */ }
  if (typeof body.message === 'string') return body.message
  const ceil = r.ceilingUnits == null ? null : num(Number(r.ceilingUnits))
  const used = r.usedUnits == null ? null : num(Number(r.usedUnits))
  // A call that names no estimated_units is not an unknown quantity: preflight
  // reserves `estimated_units ?? 1`, so it asked for one unit and the ceiling
  // decided against one unit. This used to print "Asked ? units", and the
  // onboarding sample is exactly the call that produces it: the console's own
  // step 2 tells a reader "a call that says nothing counts as one unit", and
  // the first refusal they saw then contradicted it with a question mark.
  const n = r.estimatedUnits == null ? 1 : Number(r.estimatedUnits)
  // A job counted in tokens (the unit wrap() opens a job in) says tokens; a
  // row with no job, or a job in the developer's own unit, says units.
  const word = (k: number) => unitWord(r.unit === 'token' ? 'token' : 'unit', k)
  if (r.unit === 'usd') {
    // A dollar job: the columns are micro-dollars, printed as the estimate they are.
    const $ = (v: number | null) => (v == null ? '?' : usdText(Number(v)))
    if (r.reason === 'task_ceiling_exceeded') return `Asked to reserve ${$(n)} with the task at ${$(r.usedUnits)} of ${$(r.ceilingUnits)}, at list price.`
    if (r.reason === 'task_overrun_recorded') return `Recorded ${$(r.estimatedUnits)} after the call ran; the task stands at ${$(r.usedUnits)} of ${$(r.ceilingUnits)}, at list price.`
  }
  const asked = `${num(n)} ${word(n)}`
  const of = r.unit === 'token' ? ' tokens' : ''
  switch (r.reason) {
    case 'ceiling_exceeded': return `Asked ${asked} against a per-request ceiling of ${ceil ?? '?'}.`
    case 'task_ceiling_exceeded': return `Asked ${asked} with the task at ${used ?? '?'} of ${ceil ?? '?'}${of}.`
    case 'budget_exhausted': return `Asked ${asked}; the customer had ${typeof body.remaining_units === 'number' ? num(body.remaining_units) : '0'} remaining.`
    case 'free_tier_exceeded':
    case 'plan_limit_exceeded': return `${used ?? '?'} of ${ceil ?? '?'} preflight calls this month; the plan quota is spent.`
    // Not `asked`: this row is a record(), where the number is what was
    // settled and has no default. A missing one stays unknown rather than
    // claiming one unit was recorded.
    case 'task_overrun_recorded': return `Recorded ${r.estimatedUnits == null ? '?' : num(Number(r.estimatedUnits))} ${word(r.estimatedUnits == null ? 2 : Number(r.estimatedUnits))} after the call ran; the task stands at ${used ?? '?'} of ${ceil ?? '?'}${of}.`
    default: return r.reason
  }
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

// The console keeps its own chrome: it is an authenticated surface with a rail,
// not a marketing page, so it takes neither siteNav nor siteFooter. It takes the
// shared tokens and, since 2026-09-23, the shared component kit (src/ui/kit.ts):
// the buttons, tags, chips, the panel-in-panel frame, the meter, the table, the
// code plate, the callout, the fields, the segmented control and the rail link
// are the homepage's, and this stylesheet only lays them out. The signed-out
// login and the checkout hand-off are public pages and carry the site nav and
// footer instead (LOGIN_CSS, below).
// The kit, without its comments. They are the kit's documentation, not the
// page's, and one of them names task_ref: the [onboarding] gate compares where
// "One job is one budget" and the first task_ref fall in the RAW response,
// stylesheet included, and a CSS comment above the steps read as the page
// teaching the wire name first. No reader sees a comment; the bytes go too.
const KIT = KIT_CSS.replace(/\/\*[\s\S]*?\*\//g, '')

const CSS = `${KIT}${COPY_CSS}
  /* Hallmark · genre: modern-minimal · macrostructure: Workbench (app shell: side rail + server-rendered views)
     · nav: N3 side rail, folds to a top bar and a view menu under 960px · footer: none (in-page API note)
     · design-system: design.md, the canvas system · designed-as-app */

  /* Colour semantics on canvas, 2026-09-23. The console used to spend its
     accent on --held ("AgentBill stopped something") in green. On canvas the
     one accent is the refusal, so the same meanings re-cast:

       ordinary traffic   ink and the warm greys: metered units, a running
                          task, a live key. Neutral on purpose.
       the refusal        --signal: a task at its ceiling, a customer at their
                          limit, the refused day on the chart, the refusal chip,
                          the approved: false line on the plate. What --held was.
       a leak             --signal filled (.chip-fail) or its tint: spend that got
                          past a ceiling, or an account about to stop working.
                          Its bar is the signal hatched, the homepage's mark for
                          units past the ceiling, so it never reads as the held bar.
       approaching        the .chip-near chip, and only the chip: the bar stays ink.
                          A bar is ink, the signal, or the signal hatched; a third
                          warm hue beside the signal read as the same colour.

     --held: var(--green) is gone from this block: --green is the ink on canvas,
     so held rendered black and meant nothing. */
  :root {
    /* The nav's width, which CHROME_CSS defines and this page does not load.
       The main column starts on the same measure as every other page. */
    --chrome-w: 1072px; --shell: var(--chrome-w);
  }

  body { font-size: var(--fs-small); line-height: 1.5; }
  a { text-decoration: none; }
  a:hover { text-decoration: underline; text-underline-offset: 3px; }
  a.btn:hover, a.btn-alt:hover, a.btn-ghost:hover, a.cv-navlink:hover, a.logo:hover { text-decoration: none; }
  code { font-family: var(--mono); font-size: .92em; }

  /* ---- The shell: a rail and a main column. The rail is the warm-grey
     column the kit calls --rail-bg, sticky for the viewport's height, so the
     views and the account are in reach from any scroll position. Under --lg
     the same markup becomes a top bar and a view menu. */
  /* The rail's ground is painted on the shell as well, so the grey column
     runs the page's full height: the rail itself is one viewport tall. */
  .shell { display: grid; grid-template-columns: var(--rail-w) minmax(0, 1fr); min-height: 100vh;
           background: linear-gradient(90deg, var(--rail-bg) 0 calc(var(--rail-w) - 1px), var(--border) 0 var(--rail-w), transparent 0); }
  .rail { position: sticky; top: 0; height: 100vh; overflow-y: auto; display: flex; flex-direction: column;
          gap: var(--s5); padding: var(--s4) var(--s3); background: var(--rail-bg); border-right: 1px solid var(--border); }
  .logo { display: flex; align-items: center; gap: 9px; min-height: var(--h-md); padding: 0 var(--s3); font-family: var(--mono);
          font-weight: 700; font-size: var(--fs-body); color: var(--text); white-space: nowrap; }
${MARK_CSS}

  /* The account card: the white card on the rail's grey, panel in panel. The
     one bar here that is about the account rather than the product; the plan
     quota's end is a ceiling like any other, so it carries the tick. It is
     ink below 90% and the signal from 90%, where calls start being refused;
     the link to raise the ceiling still appears from 75%. */
  .acct { background: var(--card-bg); border: 1px solid var(--card-line); border-radius: var(--r-inner);
          padding: 14px var(--s4) var(--s4); display: grid; gap: var(--s2); min-width: 0; }
  .acct-who { font-size: var(--fs-small); font-weight: 500; color: var(--text); overflow: hidden;
              text-overflow: ellipsis; white-space: nowrap; }
  .acct-row { display: flex; align-items: center; justify-content: space-between; gap: var(--s2);
              font-family: var(--mono); font-size: var(--fs-chip); color: var(--dim); white-space: nowrap; }
  .acct-m { padding-top: var(--s2); }
  .acct-m .cv-meter { height: 6px; }
  .acct-m .cv-meter > u { top: -5px; height: 16px; }
  .acct-m.is-fail .cv-meter > i { background: var(--signal); }
  .acct-q { font-family: var(--mono); font-size: var(--fs-chip); color: var(--dim); font-variant-numeric: tabular-nums; line-height: 1.55; }
  .acct-q b { color: var(--text); font-weight: 500; }
  .acct-q a { color: var(--text); text-decoration: underline; text-underline-offset: 2px; }

  /* The views. The current one is a fact the server decided (aria-current),
     drawn as the kit's white pill on the rail's grey. */
  .views { display: flex; flex-direction: column; gap: 2px; }
  .views .mode { position: relative; margin-top: 13px; }
  .views .mode::before { content: ''; position: absolute; left: var(--s3); right: var(--s3); top: -8px;
                         border-top: 1px solid var(--border2); }
  .mode span::before { content: '\\2194  '; color: var(--dim); }
  .vmenu { display: none; }
  .rail-foot { margin-top: auto; display: flex; flex-direction: column; gap: var(--s2); }
  .rail-foot form { display: contents; }
  .rail-foot .btn, .rail-foot .btn-ghost { width: 100%; }
  .rail .btn-ghost { background: var(--surface); }
  .btn .short { display: none; }

  /* ---- The main column, on the nav's measure, centred in what the rail leaves. */
  .main { min-width: 0; }
  .wrap { max-width: var(--shell); margin: 0 auto; padding: var(--s7) var(--s6) var(--s8); }
  .vh { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--s4); flex-wrap: wrap;
        margin-bottom: var(--s5); }
  h1 { font-size: var(--fs-h1-app); letter-spacing: -0.02em; line-height: 1.15; }
  .sub { color: var(--muted); font-size: var(--fs-body); margin-top: var(--s2); max-width: 64ch; line-height: 1.55; }

  /* Sample data says so in a callout under the header, and again inside every
     frame's own bar, so a screenshot of any one frame carries the label. */
  .banner { margin-bottom: var(--s5); }
  .banner p { max-width: 90ch; }
  .banner a { color: var(--text); text-decoration: underline; text-underline-offset: 2px; }

  /* Section heads on a view with more than one frame: Geist at the h3 rung,
     sentence case, with the view link at the right. */
  h2 { font-size: var(--fs-h3); letter-spacing: -0.01em; line-height: 1.3; display: flex; align-items: baseline;
       justify-content: space-between; gap: var(--s3); margin: var(--s7) 0 var(--s3); }
  h2 a { font-family: var(--sans); font-size: var(--fs-small); font-weight: 500; color: var(--text); white-space: nowrap; }
  h2 span { font-family: var(--mono); font-size: var(--fs-micro); font-weight: 400; color: var(--dim); }
  .muted { color: var(--muted); } .dim { color: var(--dim); } .none { color: var(--dim); }
  /* A link inside a sentence is the ink, so it carries the underline: without
     a colour it is the only mark that says it is a link. */
  .wrap p a:not(.btn), .lim .param a { text-decoration: underline; text-underline-offset: 2px; }
  .note { margin-top: var(--s3); color: var(--dim); max-width: 78ch; }
  /* A sentence between a section head and its frame. */
  .lede { color: var(--muted); max-width: 78ch; margin: 0 0 var(--s4); }
  .note code, .fine code, .nothing code { color: var(--muted); }

  /* ---- The frame's bar, as this page fills it: the tag that names what the
     frame holds, and SAMPLE at the right under sample data. */
  .cv-bar-t .tag { flex: none; }
  .cv-panel + .key { margin-top: var(--s3); }

  /* ---- The overview's figures. One card, four cells on hairlines, and the
     leak strip under them. The four each say their own window in their label. */
  .kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .tile { padding: 20px; display: flex; flex-direction: column; gap: var(--s2); min-width: 0;
          border-left: 1px solid var(--card-line); }
  .tile:first-child { border-left: 0; }
  .tile .cv-stat { line-height: 1.05; overflow-wrap: anywhere; }
  /* margin-top: auto, so the four footers share one baseline whether or not
     the cell above them carries a sparkline. */
  .tf { font-family: var(--mono); font-size: var(--fs-chip); color: var(--dim); font-variant-numeric: tabular-nums; margin-top: auto; }
  .tf.now { color: var(--muted); }
  .spark { display: flex; align-items: flex-end; gap: 2px; height: 28px; margin-top: var(--s1); }
  .spark i { flex: 1 1 0; min-width: 0; background: var(--meter-fill); border-radius: 2px 2px 0 0; }
  .spark i.held { background: var(--signal); }
  .spark i.zero { background: var(--border); height: 1px; }

  /* Leaked spend is not a peer of the four cells. It is the only number here
     whose good value is zero, so it has its own strip with its explanation
     attached, tinted in the signal only when it is not zero: the refused row's
     treatment, because it is the refusal that did not happen. */
  .leak { display: flex; align-items: center; gap: var(--s4); margin: 0 var(--s4) var(--s4); padding: 14px var(--s4);
          border-radius: var(--r-row); background: var(--surface2); }
  .leak-n { font-family: var(--display); font-size: var(--fs-figure); font-weight: 500; line-height: 1;
            letter-spacing: -0.02em; font-variant-numeric: tabular-nums; min-width: 2ch; text-align: right; }
  .leak-t { flex: 1 1 auto; min-width: 0; display: grid; gap: 3px; }
  .leak-t p { color: var(--muted); max-width: 78ch; }
  .leak a { color: var(--text); white-space: nowrap; font-weight: 500; }
  .leak.bad { background: var(--fail-bg); }
  .leak.bad .leak-n, .leak.bad .cv-label { color: var(--signal); }

  /* ---- The overview's task frame: the log on the left, this job on the
     right, as the homepage frame draws them. */
  .side-h { display: flex; align-items: center; justify-content: space-between; gap: var(--s2); min-width: 0; }
  .cv-side .cv-no { overflow-wrap: anywhere; }
  /* A persisted body, on the plate. A div, not the code tag: scripts/snippets
     harvests every code block under src/routes and executes it, and this one
     is interpolated. */
  .plate { white-space: pre-wrap; overflow-wrap: anywhere; }

  /* ---- The chart. Two rows, one series each, one scale each, one x-axis.
     Units are the ink, the meter's fill; refusals are the signal. */
  .chart { padding: 20px 20px var(--s4); }
  .crow { display: grid; grid-template-columns: 128px minmax(0, 1fr); gap: var(--s4); align-items: stretch; }
  .crow + .crow { margin-top: var(--s4); }
  .clab { display: flex; flex-direction: column; justify-content: flex-start; gap: 2px; padding-top: 2px; }
  .clab b { font-weight: 500; color: var(--text); display: flex; align-items: center; gap: var(--s2); }
  .clab b::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--meter-fill); flex: none; }
  .clab.held b::before { background: var(--signal); }
  .clab span { font-family: var(--mono); font-size: var(--fs-chip); color: var(--dim); font-variant-numeric: tabular-nums; }
  /* A 44px gutter on the left of the plot carries the y ticks, so a tick never
     sits on a bar. The x-axis row pads by the same amount to stay in step. */
  .cplot { position: relative; padding-left: 44px; }
  .cgrid { position: absolute; inset: 0 0 0 44px; display: flex; flex-direction: column; justify-content: space-between;
           pointer-events: none; }
  .cgrid span { border-top: 1px solid var(--border-soft); height: 0; position: relative; }
  .cgrid span::after { content: attr(data-y); position: absolute; right: calc(100% + 8px); top: -8px;
                       font-family: var(--mono); font-size: var(--fs-tick); color: var(--dim);
                       font-variant-numeric: tabular-nums; white-space: nowrap; }
  .cbars { display: flex; align-items: flex-end; gap: 3px; height: 180px; position: relative; }
  /* Ninety columns at a 3px gap spent 267px on gaps, which is more than a
     phone's whole plot; the bars measured 0px. Dense windows use 1px. */
  .cbars.dense, .cx div.dense { gap: 1px; }
  .cbars.strip { height: 40px; }
  .col { flex: 1 1 0; min-width: 0; height: 100%; display: flex; align-items: flex-end; justify-content: center;
         position: relative; }
  .col i { display: block; width: 100%; max-width: 28px; border-radius: 4px 4px 1px 1px; background: var(--meter-fill); }
  .col i.held { background: var(--signal); }
  .col i.zero { display: none; }
  /* The one direct label: the peak. */
  .strip .col.peak::before { display: none; }
  .col.peak::before { content: attr(data-v); position: absolute; left: 50%; transform: translateX(-50%);
                      top: -18px; font-family: var(--mono); font-size: var(--fs-chip); color: var(--muted);
                      font-variant-numeric: tabular-nums; white-space: nowrap; }
  /* The hover layer, in CSS: one readout per day with every series at that x,
     on a white card with a hairline, like every card on this page. */
  .col::after { content: attr(data-t); display: none; position: absolute; bottom: calc(100% + 6px); left: 50%;
                transform: translateX(-50%); z-index: 2; background: var(--surface); color: var(--text);
                border: 1px solid var(--border2); border-radius: var(--r-field); padding: 6px 10px;
                font-family: var(--mono); font-size: var(--fs-chip); white-space: nowrap; }
  .col:hover::after { display: block; }
  .col.tall::after { bottom: auto; top: 6px; }
  .col:hover i { opacity: .72; }
  .col.l::after { left: 0; transform: none; } .col.r::after { left: auto; right: 0; transform: none; }
  .cx { display: grid; grid-template-columns: 128px minmax(0, 1fr); gap: var(--s4); margin-top: var(--s2); }
  .cx div { display: flex; gap: 3px; padding-left: 44px; }
  .cx span { flex: 1 1 0; min-width: 0; font-family: var(--mono); font-size: var(--fs-tick); color: var(--dim);
             white-space: nowrap; overflow: visible; display: flex; justify-content: center; }
  .cx div:not(.x1) span:last-child { justify-content: flex-end; }

  /* ---- Tables. The kit's table, as the homepage frame's log reads: mono
     uppercase column labels, mono names, right-aligned mono numbers. A row
     at its ceiling or past it is the refused row, tinted in the signal. */
  .cv-scroll { -webkit-overflow-scrolling: touch; }
  .cv-body.flush { padding: 6px 10px 10px; }
  .cv-table td.num, .cv-table th.num { font-family: var(--mono); white-space: nowrap; text-align: right; }
  .cv-table td.num b { color: var(--text); font-weight: 500; }
  .cv-table tr.is-no td.num b { color: inherit; }
  .cv-table td.when { font-family: var(--mono); font-size: var(--fs-micro); color: var(--dim); white-space: nowrap; }
  .cv-table td.id { font-family: var(--mono); white-space: nowrap; max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
  .cv-table td.id a, .cv-table td.lead a { color: var(--text); }
  .cv-table tr.is-no td.id a, .cv-table tr.is-no td.lead a { color: inherit; }
  .cv-table td.msg { color: var(--muted); min-width: 26ch; }
  .cv-table td.msg.bad { color: var(--signal); }
  .cv-table td.lead { font-family: var(--mono); }
  .cv-table tr.zero td { color: var(--dim); }
  /* Hover is for a pointer. On a phone the rows are cards and a sticky
     hover tint on the last-tapped card would read as a state. */
  @media (hover: hover) and (min-width: ${BP.sm + 1}px) {
    .cv-table tbody tr:not(.is-no):hover td { background: var(--row-hover); }
    .cv-table tbody tr:not(.is-no):hover td:first-child { border-radius: var(--r-row) 0 0 var(--r-row); }
    .cv-table tbody tr:not(.is-no):hover td:last-child { border-radius: 0 var(--r-row) var(--r-row) 0; }
    .cv-table.is-ruled tbody tr:hover td { border-radius: 0; }
  }
  .cv-table td.state { white-space: nowrap; }
  /* A state that is not a decision is a tag; a dead key is the same tag, quieter. */
  .tag.dead { color: var(--dim); border-style: dashed; }

  /* The task rows. The name and its agent on one line and the counts under
     them, the units as the frame's figure (used / ceiling), and the burn-down
     as the kit's meter at row size: spent, reserved by a call in flight, and
     the ceiling as the signal tick at the end.
     The job's name is the row's identity and is never cut: "job-88..." cannot
     be told from job-8871 or job-8864. It wraps inside its cell if it must, and
     the agent label is what gives way: it drops to its own line when the two
     do not fit, and takes the ellipsis. */
  .tk { display: grid; gap: 2px; min-width: 0; }
  .tk-n { display: flex; flex-wrap: wrap; align-items: baseline; column-gap: var(--s2); min-width: 0; }
  .tk-n a { min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
  .tk-a { font-family: var(--sans); color: var(--dim); min-width: 0; max-width: 100%;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tk-f { font-family: var(--mono); font-size: var(--fs-chip); color: var(--dim); font-variant-numeric: tabular-nums; }
  /* When AgentBill saw the job's preflights (#74): a line of its own under
     the counts, in the same mono voice, so it reads the same at every width
     and never sits beside the relative time as if the two were one figure. */
  .tk-f.tk-s { overflow-wrap: anywhere; }
  tr.is-no .tk-a, tr.is-no .tk-f { color: var(--row-no-ink); }
  td.burn { width: 22%; min-width: 96px; }
  .cv-meter.is-row { height: 6px; }
  .cv-meter.is-row > u { top: -5px; height: 16px; }
  .cv-meter > s { position: absolute; top: 0; bottom: 0; background: var(--res); text-decoration: none; }
  /* Ink plus one signal, as on the homepage. A task within a fifth of its
     ceiling keeps the ink bar and says so with its chip. The ceiling held is
     the signal; a leak is the signal hatched, the homepage playground's mark
     for units past the ceiling (.pg-ghost), so held and leaked differ by more
     than a shade of the same hue. */
  .cv-meter.held > i { background: var(--signal); }
  .cv-meter.fail > i, .key i.fail { background: repeating-linear-gradient(45deg, var(--signal) 0 3px, transparent 3px 6px); }
  /* The legend under the tasks: the bar's parts and states as bar swatches,
     and "within a fifth" as the chip those rows carry, since its bar is ink. */
  .key { display: flex; gap: var(--s2) var(--s4); flex-wrap: wrap; align-items: center; font-family: var(--mono);
         font-size: var(--fs-chip); color: var(--dim); margin: var(--s3) 0 0; }
  .key > span { display: flex; align-items: center; gap: 6px; }
  .key i { width: 18px; height: 8px; border-radius: var(--r-pill); display: inline-block; flex: none;
           background: var(--meter-fill); }
  .key i.res { background: var(--res); } .key i.held { background: var(--signal); }
  .key i.fail { background-color: var(--meter-track); }
  /* The row's own chip, at the legend's size so it does not out-weigh the line. */
  .key .chip-near { font-size: inherit; padding-block: 1px; }

  /* Share of spend: one hue for one series, the bar scaled to the heaviest
     customer, the percentage of every customer's lifetime spend beside it. */
  .share { display: flex; align-items: center; gap: var(--s2); }
  .share .cv-meter { width: 110px; flex: none; }
  .share > span:last-child { font-family: var(--mono); font-size: var(--fs-micro); color: var(--muted);
                             font-variant-numeric: tabular-nums; white-space: nowrap; }

  /* The body a refused call received, behind a disclosure. The summary is a
     small outlined pill; the body opens on the plate. */
  details summary { cursor: pointer; list-style: none; }
  details summary::-webkit-details-marker { display: none; }
  td details summary, .ns3 details summary { display: inline-flex; align-items: center; gap: 6px; font-family: var(--mono);
          font-size: var(--fs-micro); color: var(--text); white-space: nowrap; }
  td details summary { min-height: 28px; padding: 0 12px; border: 1px solid var(--border2); border-radius: var(--r-pill);
                       background: var(--surface); }
  td details summary:hover { border-color: var(--dim); }
  details summary::before { content: '\\25B8'; color: var(--dim); } details[open] summary::before { content: '\\25BE'; }
  td .cv-code { margin-top: var(--s2); white-space: pre; }

  /* The filter row on the refusals view. A filter is a fact about the list,
     so it says what it is and how to clear it. */
  .filters { display: flex; align-items: center; gap: var(--s2); flex-wrap: wrap; margin: 0 0 var(--s3);
             font-family: var(--mono); font-size: var(--fs-micro); color: var(--dim); }
  .filters .chip-f { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--border2);
                     border-radius: var(--r-pill); padding: 0 12px; min-height: var(--h-sm); color: var(--muted);
                     background: var(--surface); max-width: 100%; min-width: 0; }
  .filters .chip-f b { color: var(--text); font-weight: 500; min-width: 0; overflow: hidden; text-overflow: ellipsis;
                       white-space: nowrap; }
  .filters a { color: var(--text); text-decoration: underline; text-underline-offset: 2px; }

  /* The limits ladder. Four rules in evaluation order, each with its live
     counts on the grey plate at its right. Named .lim, not .rule: the
     refusals table has a td.rule and a shared name gave that cell a grid. */
  .lim { display: grid; grid-template-columns: 34px minmax(0, 1.2fr) minmax(0, 1fr); gap: var(--s4) var(--s5);
         padding: 20px; border-top: 1px solid var(--card-line); }
  .cv-bar + .lim { border-top: 0; }
  .lim .n { font-family: var(--mono); font-size: var(--fs-micro); color: var(--dim); padding-top: 3px; }
  .lim h3 { font-size: var(--fs-body); letter-spacing: -0.01em; color: var(--text); margin-bottom: 2px; }
  .lim .param { font-family: var(--mono); font-size: var(--fs-micro); color: var(--muted); margin-bottom: var(--s2); }
  .lim p { color: var(--muted); max-width: 60ch; }
  .lim .live { display: flex; flex-direction: column; gap: 6px; align-self: start; background: var(--side-bg);
               border-radius: var(--r-field); padding: 14px var(--s4); font-family: var(--mono); font-size: var(--fs-micro);
               color: var(--muted); font-variant-numeric: tabular-nums; }
  .lim .live b { color: var(--text); font-weight: 500; }
  .lim .live .fail { color: var(--signal); }
  .lim .live a { color: var(--text); font-family: var(--sans); font-size: var(--fs-small); font-weight: 500; margin-top: 2px; }

  /* Commands, as display, not as a code sample: a div, never the code tag,
     because scripts/snippets harvests every code block on every route and
     executes it. */
  .cmd { display: grid; grid-template-columns: minmax(0, 220px) minmax(0, 1fr); gap: var(--s4); padding: 12px 20px;
         border-top: 1px solid var(--card-line); align-items: baseline; }
  .cmd:first-child { border-top: 0; }
  .cmd b { font-family: var(--mono); font-size: var(--fs-micro); color: var(--text); font-weight: 400; white-space: nowrap; }
  .cmd span { color: var(--muted); }

  /* Revoke all keys, 2026-09-25: the kit's card, a sentence that says what
     happens next, a box to tick and the outlined pill. No red fill: this is a
     control somebody reaches for on purpose, not an error. */
  .revall { padding: var(--s4) 20px; display: grid; gap: var(--s3); }
  .revall p { margin: 0; color: var(--muted); max-width: 72ch; }
  .revall a { color: var(--text); text-decoration: underline; text-underline-offset: 2px; }
  .revall form { display: flex; flex-wrap: wrap; gap: var(--s3) var(--s4); align-items: center; }
  .revall-ok { display: inline-flex; gap: var(--s2); align-items: center; color: var(--text); }

  /* Empty states: the kit's dashed frame, saying what would be here and the
     one step that fills it. */
  .cv-empty p { max-width: 64ch; }
  .cv-empty a { color: var(--text); text-decoration: underline; text-underline-offset: 2px; }
  .nothing { color: var(--muted); }
  .foot { margin-top: var(--s7); padding-top: var(--s4); border-top: 1px solid var(--border); color: var(--dim);
          line-height: 1.7; }
  .foot code { font-size: var(--fs-micro); color: var(--muted); }

  /* ---- Sign-in, 2026-09-25. Who this browser is signed in as, on the account
     card; the ways in on the keys view; the first key on the start screen. */
  .acct-via { font-family: var(--mono); font-size: var(--fs-chip); color: var(--dim); letter-spacing: var(--track-chip);
              text-transform: uppercase; }
  .connects { display: grid; gap: var(--s2); max-width: 360px; }
  .connects form { display: block; }
  .ways { padding: var(--s2) 20px var(--s4); display: grid; gap: 0; }
  .way { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--s4); align-items: center;
         padding: 14px 0; border-bottom: 1px solid var(--row-line); }
  .way:last-child { border-bottom: 0; }
  .way p { margin: 0; color: var(--muted); }
  .way b { color: var(--text); font-weight: 500; }
  .way form { min-width: 240px; }
  .firstkey { display: grid; gap: var(--s3); justify-items: start; }
  .firstkey p { max-width: 70ch; }
  @media (max-width: ${BP.md}px) {
    .way { grid-template-columns: minmax(0, 1fr); }
    .way form { min-width: 0; }
  }
${SIGNIN_CSS}

  /* ---- Forms: the kit's fields. A save confirmation is one line on a white
     strip; an error is one line of --red, never a filled block. */
  .ok { color: var(--text); background: var(--surface); border: 1px solid var(--card-line); border-radius: var(--r-field);
        padding: 12px var(--s4); overflow-wrap: anywhere; }
  .err { color: var(--red); overflow-wrap: anywhere; }
  .fine { color: var(--dim); }
  .fine a, .ns3 a:not(.btn) { color: var(--text); text-decoration: underline; text-underline-offset: 2px; }

  /* The tasks view's form (POST /app/tasks), on the panel's grey. */
  .setc { background: var(--panel-bg); border-radius: var(--r-card); padding: var(--s5); display: grid; gap: var(--s4);
          margin-bottom: var(--s5); }
  .setf { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, .9fr) minmax(0, 1fr) auto; gap: var(--s3); align-items: end; }
  .setf code { font-size: .9em; color: var(--dim); font-weight: 400; margin-left: 2px; }
  .setc .fine { max-width: 86ch; }
  /* The inline save on a row: a field and a button at the in-control height. */
  .bset { display: flex; align-items: center; gap: var(--s2); justify-content: flex-end; }
  /* The column head says CEILING; the label stays for a screen reader and
     comes back on a phone, where the rows are cards with no column heads. */
  .bset label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  /* 15ch, not 10: the padding and border come out of a border-box width, and
     Chrome's spinner takes a slice of what is left on hover, so 10ch showed
     five digits of a 500,000 ceiling. Measured 2026-09-24 at 12px Geist Mono:
     108px wide, 86px of content, 7.2px a digit. The max is INT4_MAX, ten
     digits: they fit at rest, and nine fit beside the spinner. */
  .bset .cv-field { width: 15ch; min-height: var(--h-sm); padding: 4px 10px; font-size: var(--fs-micro); border-radius: var(--r-row); }
  .bset .btn-ghost { min-height: var(--h-sm); padding: 5px 14px; line-height: 20px; font-size: var(--fs-micro); }
  /* Under sample data the form's button is a link (#75), so it needs the box
     a button gets for free, at the L height the button beside these fields has. */
  .setf .btn { min-height: var(--h-lg); }
  .setf a.btn { display: inline-flex; align-items: center; justify-content: center; text-align: center; }
  /* The suggested ceilings under the form (#75). A white card on the panel's
     grey, the kit's card recipe, opened by the mono label. Each figure is a
     link that reloads this view with it in the field, drawn as a chip in the
     kit's chip style; the one in the field is outlined in ink, the only mark
     a picked value gets, because a suggestion is not a decision. */
  .conv { color: var(--muted); overflow-wrap: anywhere; }
  .conv b { color: var(--text); font-weight: 500; }
  .hist { background: var(--card-bg); border: 1px solid var(--card-line); border-radius: var(--r-inner);
          padding: 14px 20px 16px; display: grid; gap: var(--s2); min-width: 0; }
  .hist .lbl { margin-bottom: var(--s1); }
  .hist .fine { margin-top: var(--s2); }
  .hrow { display: grid; grid-template-columns: minmax(0, 20rem) minmax(0, 1fr); align-items: center; gap: var(--s2) var(--s4);
          padding: var(--s2) 0; border-top: 1px solid var(--row-line); min-width: 0; }
  .hp { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2); font-family: var(--mono);
        font-size: var(--fs-chip); color: var(--dim); min-width: 0; }
  .pk { display: inline-flex; align-items: center; gap: 6px; min-height: var(--h-sm); padding: 3px 12px;
        border: 1px solid var(--chip-line); border-radius: var(--r-pill); background: var(--surface);
        font-family: var(--mono); font-size: var(--fs-micro); color: var(--muted); text-decoration: none;
        white-space: nowrap; font-variant-numeric: tabular-nums; transition: border-color .15s; }
  .pk b { color: var(--text); font-weight: 500; }
  .pk:hover { border-color: var(--dim); color: var(--text); text-decoration: none; }
  .pk.on { border-color: var(--text); box-shadow: 0 0 0 1px var(--text); color: var(--text); }
  .hw { color: var(--muted); font-size: var(--fs-small); min-width: 0; overflow-wrap: anywhere; }
  .hw .ha { color: var(--text); font-family: var(--mono); font-weight: 500; }
  @media (max-width: ${BP.lg}px) {
    .hrow { grid-template-columns: minmax(0, 1fr); gap: var(--s1); }
  }

  /* ---- The three-step start screen. One column at every width: these rows
     are read in order, and a step beside its neighbour is not a step. The
     panel's grey holds three white step cards; the ordinal is a ring, and
     the frame is solid, because this is not an empty state: it is the screen
     a new account is meant to be on. */
  .start { display: grid; gap: var(--s3); }
  .start > .intro { color: var(--text); font-size: var(--fs-lede); line-height: 1.5; max-width: 46ch; margin: var(--s2) var(--s2) var(--s3); }
  .start > .fine, .start > .seedemo { margin: 0 var(--s2); max-width: 86ch; }
  .start > .fine { margin-top: var(--s3); }
  .start > .seedemo a { color: var(--text); font-weight: 500; }
  .setf3 { display: block; }
  .ns3 { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: var(--s4); align-items: start;
         background: var(--card-bg); border: 1px solid var(--card-line); border-radius: var(--r-inner); padding: var(--s5); }
  .ns3-n { font-family: var(--mono); font-size: var(--fs-micro); color: var(--text); width: 28px; height: 28px;
           border: 1px solid var(--border2); background: var(--surface2); border-radius: 50%;
           display: grid; place-items: center; }
  .ns3 > div { display: grid; gap: var(--s3); min-width: 0; justify-items: start; }
  .ns3 > div > * { max-width: 100%; }
  .ns3 > div > p { color: var(--muted); max-width: 74ch; }
  .ns3 > div > p.units { margin-top: var(--s3); }
  .ns3 > div > .fld { display: grid; width: 100%; max-width: 36ch; }
  .fld .cv-flabel { color: var(--text); }
  .ns3 details { width: 100%; }
  .ns3 details .cv-field { margin-top: var(--s2); max-width: 36ch; }
  .ns3 details .fine { margin-top: var(--s2); }
  .ns3 .btn { margin-top: var(--s2); }
  .ns3 .out { font-family: var(--mono); font-size: .92em; color: var(--text); }
  .ns3 .got { display: flex; align-items: center; gap: var(--s3); flex-wrap: wrap; }
  .ns3 .got .dim { font-family: var(--mono); font-size: var(--fs-micro); }
  /* Named with its parent, or .ns3 > div > p (muted) outranks the kit's
     signal and the one refusal line on the screen reads as body text. */
  .ns3 > div > p.cv-no { color: var(--signal); font-size: var(--fs-body); }
  .start .cv-code { width: 100%; }
  /* The question, then three answers as cards. A card is a link, so the
     choice works with no script; the chosen one carries aria-current and the
     kit's inset ring, and the others stay quiet. */
  .start > .ask { margin: var(--s2) var(--s2) 0; display: grid; gap: var(--s2); }
  .start > .ask .intro { color: var(--text); font-size: var(--fs-h3); font-weight: 500; line-height: 1.3; margin: 0; }
  .start > .ask p { color: var(--muted); max-width: 64ch; }
  .vias { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--s3); }
  .via { display: grid; gap: var(--s1); align-content: start; background: var(--card-bg); border: 1px solid var(--card-line);
         border-radius: var(--r-inner); padding: var(--s4); color: var(--text); text-decoration: none; min-height: var(--h-lg); }
  .via b { font-weight: 500; }
  .via span { color: var(--muted); font-size: var(--fs-small); line-height: 1.45; }
  .via:hover { border-color: var(--border2); text-decoration: none; }
  .via[aria-current] { border-color: var(--text); box-shadow: inset 0 0 0 1px var(--text); }
  .does { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--s3); width: 100%; }
  .does > div { background: var(--surface2); border-radius: var(--r-inner); padding: var(--s3) var(--s4); display: grid; gap: var(--s1); }
  .does p { color: var(--muted); font-size: var(--fs-small); line-height: 1.5; }
  .ns3 > div > p.first-ok { color: var(--text); font-size: var(--fs-body); }
  .first-ok b { font-weight: 600; }
  .est { color: var(--muted); }
  .first-wait { grid-template-columns: minmax(0, 1fr); }
  .start .cv-plate, .start .cp { max-width: 100%; }
  /* Your code on a light card with a hairline, the kit's .cv-snip recipe,
     under one class for two tags, on purpose. scripts/snippets/extract.mjs
     harvests every code block under src/routes and executes it, and records
     an interpolated one as "dynamic" with empty code, which drops it from the
     gate in silence. So the personalised sample (the reader's job name inside
     it) and the install line are divs, and the pre-save sample, a literal, is
     the one code block: it is the copy CI actually runs, and the hygiene gate
     holds it byte-identical to taskSnippet(). Same convention as .cmd here.

     The tag name is spelled without angle brackets in this comment and the one
     beside the sample, on purpose. The harvester's regex reads a bare tag in a
     comment as an opening tag and swallows the file to the next closing one,
     which took this very sample out of CI for one commit on 2026-09-11 and
     showed up only as python 38 -> 37 in the inventory. */
  .snip { width: 100%; background: var(--snip-bg); border: 1px solid var(--card-line); border-radius: var(--r-inner);
          padding: 14px 18px; font-family: var(--mono); font-size: var(--fs-code); color: var(--text); line-height: 1.7;
          white-space: pre-wrap; overflow-wrap: anywhere; }

  a:focus-visible, button:focus-visible, input:focus-visible, summary:focus-visible {
    outline: 2px solid var(--green); outline-offset: 2px; }

  @media (max-width: ${BP.lg}px) {
    /* The rail becomes a bar and a menu. Same markup: the identity row on the
       site nav's height and ground, then the views behind one disclosure
       whose summary names the current view. */
    .shell { display: block; background: none; }
    .rail { position: sticky; top: 0; height: auto; overflow: visible; z-index: 10; display: grid;
            grid-template-columns: auto minmax(0, 1fr) auto; grid-template-areas: "logo acct foot" "views views views";
            align-items: center; gap: 0 var(--s3); padding: 0 var(--gutter) var(--s3);
            background: var(--nav-bg); backdrop-filter: blur(14px); border-right: none; border-bottom: 1px solid var(--border); }
    .logo { grid-area: logo; padding: 0; min-height: 60px; }
    .acct { grid-area: acct; background: none; border: none; padding: 0; min-width: 0;
            display: flex; align-items: center; justify-content: flex-end; gap: var(--s3); overflow: hidden; }
    .acct-who, .acct-q, .acct-m { display: none; }
    .rail-foot { grid-area: foot; margin: 0; flex-direction: row; }
    .rail-foot > .cv-navlink { display: none; }
    .rail-foot .btn, .rail-foot .btn-ghost { width: auto; }
    .views { display: none; }
    .vmenu { display: block; grid-area: views; position: relative; }
    .vmenu summary { display: flex; align-items: center; gap: var(--s3); min-height: var(--h-lg); padding: 0 var(--s4);
                     background: var(--surface2); border: 1px solid var(--border); border-radius: var(--r-field);
                     color: var(--text); font-weight: 500; }
    .vmenu summary::before, .vmenu[open] summary::before { content: none; }
    .vmenu summary b { font-weight: 500; }
    .vmenu summary i { margin-left: auto; width: 8px; height: 8px; border-right: 1.5px solid var(--dim);
                       border-bottom: 1.5px solid var(--dim); transform: translateY(-2px) rotate(45deg); }
    .vmenu[open] summary { border-color: var(--border-strong); }
    .vmenu[open] summary i { transform: translateY(2px) rotate(-135deg); }
    .vlist { position: absolute; left: 0; right: 0; top: calc(100% + 6px); z-index: 11; display: flex; flex-direction: column;
             gap: 2px; padding: 6px; background: var(--surface); border: 1px solid var(--border2); border-radius: var(--r-field); }
    .vlist .cv-navlink { min-height: var(--h-lg); }
    .vlist .cv-navlink[aria-current="page"] { background: var(--surface2); box-shadow: none; }
    .vlist .mode, .vlist .more { position: relative; margin-top: 9px; }
    .vlist .mode::before, .vlist .more::before { content: ''; position: absolute; left: var(--s3); right: var(--s3); top: -6px;
                                                 border-top: 1px solid var(--border); }
    .vlist .mode + .more { margin-top: 0; }
    .vlist .mode + .more::before { content: none; }
    .wrap { padding: var(--s5) var(--gutter) var(--s7); }
    .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .tile:nth-child(3) { border-left: 0; }
    .tile:nth-child(n+3) { border-top: 1px solid var(--card-line); }
    .crow, .cx { grid-template-columns: minmax(0, 1fr); gap: var(--s2); }
    .clab { flex-direction: row; align-items: baseline; gap: var(--s3); }
    /* The row title sits above the plot here, where the peak's direct label
       used to land on it; the title already names the peak. */
    .col.peak::before { display: none; }
    h2 { flex-wrap: wrap; }
    .cbars { height: 140px; }
    .lim { grid-template-columns: 28px minmax(0, 1fr); }
    .lim .live { grid-column: 2; }
    .setf { grid-template-columns: minmax(0, 1fr); }
    .setf .btn { width: 100%; }
  }
  @media (max-width: ${BP.md}px) {
    .cv-body.flush { padding: var(--s1) var(--s1) var(--s2); }
    .setc { padding: var(--s4); border-radius: var(--r-card-sm); }
    .ns3 { padding: var(--s4); gap: var(--s3); }
    .start > .intro { font-size: var(--fs-body); margin-inline: var(--s1); }
    .vias, .does { grid-template-columns: minmax(0, 1fr); }
    .start > .ask { margin-inline: var(--s1); }
    .tile { padding: var(--s4); }
    .leak { margin: 0 var(--s2) var(--s2); padding: var(--s3); }
    .chart { padding: var(--s4) var(--s3) var(--s3); }
    .lim { padding: var(--s4); gap: var(--s3); }
    .cmd { padding: 12px var(--s4); }
  }
  @media (max-width: ${BP.sm}px) {
    /* The leak strip: the link takes its own line instead of squeezing the
       sentence into an 84px column beside it. */
    .leak { flex-wrap: wrap; align-items: flex-start; }
    .leak-t { flex: 1 1 160px; }
    .leak a { flex-basis: 100%; }
    /* The hover readout is wider than a phone's plot and there is no hover on
       a phone; the day-by-day table on the activity view carries the values. */
    .col:hover::after { display: none; }
    .cx div.x1 .alt, .cx div.dense .alt { visibility: hidden; }
    /* The tables on a phone: the same rows, laid out as cards on hairlines.
       Six columns in a sideways scroller hid the sentence that explains the
       row behind two swipes. One DOM, no second copy for the small screen. */
    .cards thead, .refusals thead { display: none; }
    .cards tr, .refusals tr { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px var(--s3);
             padding: var(--s3) 10px; align-items: center; border-top: 1px solid var(--row-line); }
    .cards tbody tr:first-child, .refusals tbody tr:first-child { border-top: 0; }
    .cards tr.is-no, .refusals tr.is-no { border-radius: var(--r-row); background: var(--row-no-bg); border-top-color: transparent; }
    .cards tr.is-no + tr { border-top-color: transparent; }
    /* Named with the table's class, so they outrank the kit's ruled and
       tinted cell rules (two classes each) without an !important. */
    .cv-table.cards td, .cv-table.refusals td { display: block; padding: 0; border: none; }
    .cv-table.cards tr.is-no td, .cv-table.refusals tr.is-no td { background: none; }
    .cards td.lead { max-width: none; }
    .cards td.state { grid-column: 2; grid-row: 1; justify-self: end; }
    .cards td.wide, .cards td.burn { grid-column: 1 / -1; width: auto; }
    .cards td.num, .cards td.when { grid-column: 1 / -1; text-align: left; font-size: var(--fs-micro); white-space: normal; }
    .cards td[data-l]::before, .refusals td[data-l]::before { content: attr(data-l) '  '; color: var(--dim); font-family: var(--mono);
                                font-size: var(--fs-chip); text-transform: uppercase; letter-spacing: var(--track-chip); }
    .cards .share .cv-meter { flex: 1 1 60px; width: auto; }
    .cards .bset { justify-content: flex-start; }
    .cards .bset label { position: static; width: auto; height: auto; overflow: visible; clip-path: none; }
    .cards .bset .cv-field, .cards .bset .btn-ghost { min-height: var(--h-md); }
    .refusals td.rule { grid-column: 2; grid-row: 1; justify-self: end; }
    .refusals td.when { grid-column: 1; grid-row: 1; }
    /* Two equal tracks under the time and the rule, the ids at the mono's
       small step: the kit's 14px on a 1fr/auto grid cut an agent name by
       38px at 320 (the shots gate, 2026-09-23). */
    .cv-table.refusals tr { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
    .refusals td.id { max-width: none; font-size: var(--fs-micro); }
    .refusals td.msg, .refusals td.body { grid-column: 1 / -1; }
    .refusals td.msg { margin-top: 2px; min-width: 0; }
    /* Named with the table's class, or th.num's nowrap (two classes) keeps
       REFUSED UNITS on one line and the table scrolls at 320. */
    .cv-table.days th { white-space: normal; }
    .cv-table.days th, .cv-table.days td { padding-inline: 6px; }
    .days td.when .dim { display: none; }
    td .cv-code { white-space: pre-wrap; word-break: break-word; }
    /* The key tail and the wordmark wanted the same 80px at 375px; the tail is
       the one that can go, the banner and the rail say which mode this is. */
    .acct-row span:last-child { display: none; }
    .cmd { grid-template-columns: minmax(0, 1fr); gap: 4px; }
  }
  @media (max-width: ${BP.xs}px) {
    /* A seven-digit figure needs more than a half-width cell has at 320px;
       one column keeps the number inside its frame. */
    .kpis { grid-template-columns: minmax(0, 1fr); }
    .tile { border-left: 0; }
    /* At 320 a half track is 120px; an id and its label need their own line. */
    .refusals td.id { grid-column: 1 / -1; }
    /* The same for a task: the agent goes under the job's name on every row,
       not only on the rows whose names happen to be long. */
    .tk-n { flex-direction: column; align-items: flex-start; }
    .tile + .tile { border-top: 1px solid var(--card-line); }
    .btn-key .long { display: none; }
    .btn-key .short { display: inline; }
  }
`

// The signed-out login and the checkout hand-off are public pages: a visitor
// reaches them from the site nav's Console link, so they carry the same nav
// and footer as every other page, and the card is the panel-in-panel frame.
// No sticky bar: the one action on this page is the card's own button.
const LOGIN_CSS = `${CHROME_CSS}${SIGNIN_CSS}${COPY_CSS}
  :root { --shell: var(--chrome-w); }
  .login-wrap { max-width: var(--shell); margin: 0 auto; padding: var(--s8) var(--gutter) 0; }
  .login { max-width: 520px; margin: 0 auto; }
  .login .cv-card { padding: var(--s6); display: grid; gap: var(--s4); }
  .login h1 { font-size: var(--fs-h1-app); letter-spacing: -0.02em; line-height: 1.15; }
  .login p { color: var(--muted); }
  .login p a { color: var(--text); text-decoration: underline; text-underline-offset: 2px; }
  .login form { display: grid; gap: var(--s2); margin-top: var(--s1); }
  .login form .btn { width: 100%; margin-top: var(--s3); }
  .login .fine { font-size: var(--fs-small); color: var(--dim); }
  .login .fine + .fine { margin-top: calc(-1 * var(--s2)); }
  .login .err { margin: 0; }
  .login .signin form { margin-top: 0; }
  .login .signin form .btn { margin-top: var(--s3); }
  /* The key login, under the ways in: the legacy door for the accounts made
     before sign-in existed, a disclosure so it is there without competing. */
  .login details summary { cursor: pointer; color: var(--muted); font-size: var(--fs-small); }
  .login details[open] summary { margin-bottom: var(--s3); }
  .login .keyform .btn { background: var(--surface3); color: var(--text); }
  .login .cv-plate { margin: 0; }
  .login .go { justify-self: start; }
  .site-foot { margin-top: var(--s9); }
  @media (max-width: ${BP.md}px) {
    .login-wrap { padding-top: var(--s6); }
    .login .cv-card { padding: var(--s5) var(--s4); }
  }
`

const HEAD = (title: string, css = CSS) => head({
  title: `${esc(title)} · AgentBill`,
  description: 'Your AgentBill console: refusals, task budgets, keys and usage for one API key.',
  // noindex comes from the registry (index: false), which is the same entry
  // robots.txt reads, so the two cannot disagree about this page.
  path: '/app',
  css,
  // Google Sans for the Google button, only on a server where it is drawn.
  extraHead: signinFonts(configuredProviders()),
})
const LOGIN_HEAD = (title: string) => HEAD(title, LOGIN_CSS)

const ERRORS: Record<string, string> = {
  key: 'That key was not found. It starts with agb_ and was shown once, when it was made.',
  revoked: 'That key has been revoked. Generate a new one with POST /keys/generate.',
  expired: 'That key has expired. Generate a new one with POST /keys/generate.',
  rate: 'Too many attempts from this address. Try again in 15 minutes.',
  unavailable: 'Sign-in is not configured on this server.',
  revoked_all: 'Every key on the account is revoked, the one this browser signed in with too. Get a new key with the account\'s email address at agentbill.dev/recover, or sign in above if the account has Google, GitHub or an email link.',
}

/** What a connect attempt came back with, on the keys view. Codes only: the
 *  query string is text anyone can put in a link, so nothing free is echoed. */
const LINK_TEXT: Record<string, string> = {
  ok: 'Connected. You can sign in to this account with it from now on, and the console no longer needs your key to open.',
  denied: 'Nothing was connected: the sign-in was cancelled.',
  expired: 'Nothing was connected: that attempt expired or was started in another browser. Try again.',
  unverified: 'Nothing was connected: that account has no verified email address.',
  failed: 'Nothing was connected: the provider did not confirm the sign-in. Try again.',
  in_use: 'Nothing was connected: that sign-in already opens a different AgentBill account.',
  taken: 'Nothing was connected: this account already has a different sign-in with that provider.',
  email_in_use: 'Nothing was connected: that address already signs in to a different AgentBill account.',
}

/**
 * `next` is already validated by the caller (safeNext), so the only values
 * that reach here are /app/upgrade/<tier>. When it is set the page is a sign-in
 * on the way to checkout and says so; the form carries it as a hidden field
 * and /app/session honours it after a good login.
 */
function loginPage(err: string, next = ''): string {
  const tier = next ? next.slice(next.lastIndexOf('/') + 1) : ''
  const tierName = tier ? tier[0].toUpperCase() + tier.slice(1) : ''
  return `${LOGIN_HEAD(tier ? `Sign in to buy ${tierName}` : 'Console')}
<body>
${siteNav('/app', { sticky: false })}
  <main class="login-wrap">
    <div class="login cv-panel"><div class="cv-card">
    ${tier
      ? `<h1>Sign in to buy ${esc(tierName)}.</h1>
    <p>Sign in to the account that should carry the plan. After that you go straight to checkout.
       No account yet? The same sign-in makes one, free.</p>`
      : `<h1>Your console</h1>
    <p>Live task budgets, every call refused on your behalf, and the exact response your agent got. Sign in, or sign up: the first sign-in makes a free account.</p>`}
    ${Object.hasOwn(ERRORS, err) ? `<p class="err cv-err">${esc(ERRORS[err])}</p>` : ''}
    ${signinPanel({ providers: configuredProviders(), from: 'app', next, submit: 'Email me a sign-in link' })}
    <details class="keyform"${err && Object.hasOwn(ERRORS, err) ? ' open' : ''}>
      <summary>Sign in with an API key instead</summary>
      <form method="POST" action="/app/session" autocomplete="off">
        ${next ? `<input type="hidden" name="next" value="${esc(next)}" />` : ''}
        <label class="cv-flabel" for="api_key">API key</label>
        <input id="api_key" class="cv-field m" name="api_key" type="password" placeholder="agb_..." required />
        <button class="btn btn-lg" type="submit">${tier ? 'Continue to checkout' : 'Open console'} &rarr;</button>
      </form>
      <p class="fine">For an account made before sign-in existed. The key is exchanged for an HttpOnly cookie that lasts 7 days and ends when the key is revoked. Once in, connect Google or GitHub from the keys view and the console opens without the key from then on.</p>
    </details>
    <p class="fine">This page loads no script. <a href="/app?demo=1">See the console with sample data</a> first.</p>
    <p class="fine">Had a key and no longer have it? <a href="/recover">Get back in</a> with the email you registered with.</p>
    </div></div>
  </main>
${siteFooter()}
</body>
</html>`
}

/**
 * The 200 page between a signed-in click on /pricing and Polar. It refreshes
 * into /checkout/:tier at once; the link is the fallback for a client that
 * ignores meta refresh. A page rather than a 302 on purpose: a redirect chain
 * that starts at the login form and ends at polar.sh is what Chrome's
 * form-action check blocks, and the block is silent. See APP_CSP.
 */
function handoffPage(tier: string, to: string): string {
  const name = tier[0].toUpperCase() + tier.slice(1)
  return `${head({
    title: `Opening checkout for ${esc(name)} · AgentBill`,
    description: 'Handing this account to Polar for checkout.',
    path: '/app',
    css: LOGIN_CSS,
    extraHead: `<meta http-equiv="refresh" content="0;url=${esc(to)}">`,
  })}
<body>
${siteNav('/app', { sticky: false })}
  <main class="login-wrap">
    <div class="login cv-panel"><div class="cv-card">
    <h1>Opening checkout for ${esc(name)}.</h1>
    <p>Polar takes the payment, and the plan lands on the account you are signed in as.
       If nothing happens in a second, <a href="${esc(to)}">continue to checkout</a>.</p>
    </div></div>
  </main>
${siteFooter()}
</body>
</html>`
}

/** The 200 page between "Continue with Google" in the console and the
 *  provider. Same reason as handoffPage: a redirect after a form POST is
 *  checked against form-action, and the provider is not 'self'. */
function connectHandoff(provider: Provider, to: string): string {
  const name = provider === 'google' ? 'Google' : 'GitHub'
  return `${head({
    title: `Connecting ${name} · AgentBill`,
    description: 'Handing this sign-in to the provider.',
    path: '/app',
    css: LOGIN_CSS,
    extraHead: `<meta http-equiv="refresh" content="0;url=${esc(to)}">`,
  })}
<body>
${siteNav('/app', { sticky: false })}
  <main class="login-wrap">
    <div class="login cv-panel"><div class="cv-card">
    <h1>Opening ${esc(name)}.</h1>
    <p>Sign in there and you come straight back here, with ${esc(name)} connected to this account.
       If nothing happens in a second, <a href="${esc(to)}">continue to ${esc(name)}</a>.</p>
    </div></div>
  </main>
${siteFooter()}
</body>
</html>`
}

/**
 * The first key, shown once. The same two plates the register screen used to
 * carry (the key, and the line that sets it), each with Copy, because this is
 * the screen that screen's job moved to: a key made for a verified person, in
 * the console, after the sign-in rather than before it.
 */
function firstKeyPage(apiKey: string): string {
  return `${HEAD('Your API key', LOGIN_CSS)}
<body>
${siteNav('/app', { sticky: false })}
  <main class="login-wrap">
    <div class="login cv-panel"><div class="cv-card">
    <h1>Your API key is ready.</h1>
    <p>Copy it now. This page is not shown again, and the console masks every key it lists.</p>
    ${copyPlate('key-display', esc(apiKey))}
    <p>Nothing in the console needs it pasted in: your code sends it, with every call. In Python or Node that means <code>AGENTBILL_API_KEY</code>, and this line sets it in the terminal your code runs in.</p>
    ${copyPlate('key-export', `export AGENTBILL_API_KEY=${esc(apiKey)}`)}
    <p class="fine">No terminal? Send the key yourself as an <code>Authorization: Bearer</code> header from whatever makes the call.</p>
    <a class="btn btn-lg go" href="/app?view=start">Continue to the start screen &rarr;</a>
    </div></div>
  </main>
${siteFooter()}
${COPY_JS}
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Page state and links
// ---------------------------------------------------------------------------

type Page = { v: Viewer; d: Console; demo: boolean; anon: boolean; range: string; view: ViewKey; filter: Filter; sort: TaskSort; flash?: Flash | null; suggest?: Suggest | null
  /** A connect attempt's outcome code, already checked against LINK_TEXT. */
  link?: string | null
  /** The providers configured on this server. */
  providers?: Provider[]
  /** Apps connected to this account over MCP, for the keys view. */
  apps?: ConnectedApp[]
  /** A Disconnect's outcome, 'disconnected' or 'gone'. */
  appMsg?: 'disconnected' | 'gone' | null
  /** A Revoke all's outcome, a code from a closed set. */
  keysMsg?: 'revoked_all' | 'revoke_refused' | 'confirm' | null
  /** The start screen's answer to "how will you connect?", off ?via=. */
  via?: Via | null }

/** Every link on the page is built here, so demo=1 and the period survive a
 *  change of view. A prospect on the sample console who clicked a rail item
 *  and landed on the login page would never come back. */
function href(p: Page, view: ViewKey, extra: Partial<{ range: string; task: string; agent: string; only: string; demo: boolean; sort: TaskSort; history: string; pick: Pick; via: Via }> = {}): string {
  const q: string[] = []
  const demo = extra.demo ?? p.demo
  if (demo) q.push('demo=1')
  if (view !== DEFAULT_VIEW) q.push(`view=${view}`)
  // The order is the tasks view's. It survives a link back to the same view
  // (the sample-data toggle, the rail's current item) and no other.
  const sort = extra.sort ?? (view === p.view ? p.sort : 'recent')
  if (view === 'tasks' && sort === 'used') q.push('sort=used')
  const range = extra.range ?? p.range
  if (range !== DEFAULT_RANGE) q.push(`range=${encodeURIComponent(range)}`)
  if (extra.task) q.push(`task=${encodeURIComponent(extra.task)}`)
  if (extra.agent) q.push(`agent=${encodeURIComponent(extra.agent)}`)
  if (extra.only) q.push(`only=${encodeURIComponent(extra.only)}`)
  // A suggested ceiling's link: which agent, which figure. The number itself
  // is never on the URL; readSuggest looks it up in the rows.
  if (extra.history) q.push(`history=${encodeURIComponent(extra.history)}`)
  if (extra.pick) q.push(`pick=${extra.pick}`)
  if (extra.via) q.push(`via=${extra.via}`)
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
  const who = p.anon ? 'Sample console' : p.v.via === 'user' ? (p.v.userEmail ?? 'no email') : (p.v.email ?? 'no email')
  const via = p.anon ? '' : p.v.via === 'user' ? 'Signed in as' : 'Signed in with a key'
  const plan = p.demo ? DEMO_VIEWER : p.v
  const { limit, pct, cls } = planOf(plan)
  const keyTail = p.v.keyMask || 'no key yet'
  const quota = limit === null
    ? `<b>${num(plan.monthlyCalls)}</b> calls this month · metered, no cap`
    : `<b>${num(plan.monthlyCalls)}</b> / ${num(limit)} calls · this billing month${pct >= 75
        ? ` · <a href="/pricing?account_id=${encodeURIComponent(p.v.accountId)}">raise the ceiling</a>` : ''}`
  // The plan's end is a ceiling, so it is the kit's meter with the tick. The
  // share is the meter's own arithmetic from the two numbers; the state class
  // is planOf's, so the colour and the percentage cannot disagree.
  return `<div class="acct">
        ${via ? `<div class="acct-via">${via}</div>` : ''}
        <div class="acct-who" title="${esc(who)}">${esc(who)}</div>
        <div class="acct-row">${tag(esc(plan.plan))}<span title="${p.v.keyLabel ? esc(p.v.keyLabel) : 'key'}">${esc(keyTail)}</span></div>
        ${limit === null ? '' : `<div class="acct-m${cls ? ` is-${cls}` : ''}">${meter(plan.monthlyCalls, limit)}</div>`}
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
  const items = (Object.keys(VIEWS) as ViewKey[]).filter((k) => !('hidden' in VIEWS[k])).map((k) =>
    `<a class="cv-navlink" href="${href(p, k)}"${k === p.view ? ' aria-current="page"' : ''}><span>${VIEWS[k].title}</span>${counts[k] ? `<span class="n">${counts[k]}</span>` : ''}</a>`).join('\n        ')
  const mode = p.anon
    ? ''
    : p.demo
      ? `<a class="cv-navlink mode" href="${href(p, p.view, { demo: false })}"><span>Your data</span></a>`
      : `<a class="cv-navlink mode" href="${href(p, p.view, { demo: true })}"><span>Sample data</span></a>`
  // The phone's copy of the same list, inside a native disclosure whose
  // summary names the current view. A horizontal strip put the current item
  // off screen on the last three views, with no highlight and no hint that
  // it scrolled; a summary that reads "Limits" cannot hide which page this is.
  const menu = `<details class="vmenu">
        <summary>${label('View')}<b>${VIEWS[p.view].title}</b><i aria-hidden="true"></i></summary>
        <div class="vlist">
        ${items}
        ${mode}
        <a class="cv-navlink more" href="/docs"><span>Docs</span></a>
        </div>
      </details>`
  const action = p.anon
    ? `<a class="btn btn-key" href="/register"><span class="long">${KEY_CTA}</span><span class="short">${KEY_CTA_SHORT}</span></a>`
    : `<form method="POST" action="/app/logout"><button class="btn-ghost" type="submit">Sign out</button></form>`
  return `<aside class="rail">
      <a class="logo" href="/">${mark(18)}AgentBill</a>
      ${accountCard(p)}
      <nav class="views" aria-label="Console views">
        ${items}
        ${mode}
      </nav>
      ${menu}
      <div class="rail-foot">
        <a class="cv-navlink" href="/docs">Docs</a>
        ${action}
      </div>
    </aside>`
}

/** The tasks view's order, in the header slot the period control takes on
 *  the views that carry a window. The kit's segmented control, as the period
 *  control is; the current item keeps class="on" beside aria-current because
 *  the harness reads the link whole. */
function sortControl(p: Page): string {
  return `<span class="cv-seg" aria-label="Order">${(Object.keys(TASK_SORTS) as TaskSort[]).map((k) =>
    `<a class="${k === p.sort ? 'on' : ''}" href="${href(p, 'tasks', { sort: k })}"${k === p.sort ? ' aria-current="true"' : ''}>${esc(TASK_SORTS[k])}</a>`).join('')}</span>`
}

function periodControl(p: Page): string {
  return `<span class="cv-seg" aria-label="Period">${Object.entries(RANGES).map(([k, r]) =>
    `<a href="${href(p, p.view, { range: k })}"${k === p.range ? ' aria-current="true"' : ''}>${esc(r.label)}</a>`).join('')}</span>`
}

function sparkline(series: Series[], key: 'units' | 'blocks' | 'refused' | 'usd' | 'tokens', cls: string): string {
  const max = Math.max(1, ...series.map((s) => s[key]))
  return `<div class="spark" aria-hidden="true">${series.map((s) => {
    const v = s[key]
    return v > 0 ? `<i class="${cls}" style="height:${Math.max(6, Math.round((v / max) * 100))}%"></i>` : '<i class="zero"></i>'
  }).join('')}</div>`
}

/**
 * The frame, for anything that shows product data: the warm-grey panel, the
 * white card, and the bar that opens it. `bar` is the left of the bar (the tag
 * that names what the frame holds); SAMPLE sits at its right under sample data,
 * so a screenshot of any one frame still says the numbers are invented.
 */
function frame(p: Page, bar: string, body: string, cls = ''): string {
  return `<div class="cv-panel${cls ? ` ${cls}` : ''}"><div class="cv-card">
      <div class="cv-bar"><span class="cv-bar-t">${bar}</span>${p.demo ? SAMPLE_TAG : ''}</div>
      ${body}
    </div></div>`
}
/** A bar's left half: the tag that names what the frame holds. The bar carries
 *  no fact of its own: every count or order it could state is already in the
 *  heading, the lede or the note on the same screen, and a second copy is copy
 *  the restyle added (review, 2026-09-23). */
const barOf = (name: string, id = false) => tag(name, id)

/** The key a frame belongs to, masked the way every key on this page is. */

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
  if (d.pricedEver) {
    // An account with a priced call leads with the estimate and the tokens.
    // Both are sums over the same series the chart draws, so a tile and the
    // chart beside it cannot disagree. Days with calls and no price are not
    // in the dollar sum, and the tile says how many calls that was.
    const cost = d.series.reduce((a, x) => a + x.usd, 0)
    const priced = d.series.reduce((a, x) => a + x.priced, 0)
    const calls = d.series.reduce((a, x) => a + x.calls, 0)
    const tokens = d.series.reduce((a, x) => a + x.tokens, 0)
    const unpriced = calls - priced
    return `<div class="kpis">
      <div class="tile">
        ${label(`Est. cost · ${esc(win)}`)}
        <div class="cv-stat" title="${esc(LIST_PRICE_LABEL)}"><b>${priced ? usd(cost) : 'none'}</b></div>
        ${sparkline(d.series, 'usd', '')}
        <div class="tf">${priced ? `at list price, ${num(priced)} priced ${priced === 1 ? 'call' : 'calls'}${unpriced ? ` · ${num(unpriced)} with no price` : ''}` : 'no priced call in this window'}</div>
      </div>
      <div class="tile">
        ${label(`Tokens · ${esc(win)}`)}
        <div class="cv-stat"><b>${num(tokens)}</b></div>
        ${sparkline(d.series, 'tokens', '')}
        <div class="tf">${num(calls)} ${calls === 1 ? 'call' : 'calls'} recorded</div>
      </div>
      <div class="tile">
        ${label(`Refused · ${esc(win)}`)}
        <div class="cv-stat"><b>${num(blocked)}</b></div>
        ${sparkline(d.series, 'blocks', 'held')}
        ${delta(blocked, d.prevBlocked, rangeLabel)}
      </div>
      <div class="tile">
        ${label('Live tasks · now')}
        <div class="cv-stat"><b>${num(live)}</b></div>
        <div class="tf now">${live === 0 ? 'none under a ceiling' : near ? `${num(near)} within a fifth of the ceiling` : 'all comfortably under their ceilings'}</div>
      </div>
    </div>`
  }
  return `<div class="kpis">
      <div class="tile">
        ${label(`Refused · ${esc(win)}`)}
        <div class="cv-stat"><b>${num(blocked)}</b></div>
        ${sparkline(d.series, 'blocks', 'held')}
        ${delta(blocked, d.prevBlocked, rangeLabel)}
      </div>
      <div class="tile">
        ${label(`Units refused · ${esc(win)}`)}
        <div class="cv-stat"><b>${num(refused)}</b></div>
        ${sparkline(d.series, 'refused', '')}
        <div class="tf">${blocked ? `${num(avgAsk)} units per refused call` : 'units asked for and not run'}</div>
      </div>
      <div class="tile">
        ${label(`Units recorded · ${esc(win)}`)}
        <div class="cv-stat"><b>${num(metered)}</b></div>
        ${sparkline(d.series, 'units', '')}
        <div class="tf">${d.lastBlock ? `last refusal ${rel(d.lastBlock)}` : 'no refusal yet'}</div>
      </div>
      <div class="tile">
        ${label('Live tasks · now')}
        <div class="cv-stat"><b>${num(live)}</b></div>
        <div class="tf now">${live === 0 ? 'none under a ceiling' : near ? `${num(near)} within a fifth of the ceiling` : 'all comfortably under their ceilings'}</div>
      </div>
    </div>`
}

function leakRow(p: Page): string {
  const n = p.d.overruns
  return `<div class="leak${n > 0 ? ' bad' : ''}">
      <div class="leak-n">${num(n)}</div>
      <div class="leak-t">
        ${label('Leaked past a ceiling · all time')}
        <p>${n > 0
          ? 'Calls that ran after their task was already at its limit, because preflight was skipped or the estimate came in low. The one number here that should be zero.'
          : 'Nothing has run past a ceiling. The one number here that should stay at zero, and it has.'}</p>
      </div>
      ${n > 0 ? `<a href="${href(p, 'refusals', { only: 'leaks' })}">See the ${n === 1 ? 'call' : 'calls'} &rarr;</a>` : ''}
    </div>`
}

/** The overview's figures: one card whose bar names the account they belong to. */
function figures(p: Page, rangeLabel: string): string {
  const mask = p.demo ? DEMO_VIEWER.keyMask : p.v.keyMask
  return frame(p, barOf(mask ? esc(mask) : 'no key yet', true), `${kpis(p, rangeLabel)}
      ${leakRow(p)}`, 'figs')
}

// Two rows, one series each, one scale each, one x-axis. The label column is
// the legend: each row is single-series and named, so no swatch box is needed.
function chartBlock(p: Page, series: Series[], rangeLabel: string): string {
  if (p.d.pricedEver) return costChart(p, series, rangeLabel)
  const n = series.length
  const unitMax = Math.max(...series.map((s) => s.units), 0)
  const blockMax = Math.max(...series.map((s) => s.blocks), 0)
  const top = niceMax(unitMax)
  const peakI = unitMax > 0 ? series.findIndex((s) => s.units === unitMax) : -1
  const peakB = blockMax > 0 ? series.findIndex((s) => s.blocks === blockMax) : -1
  const edge = (i: number) => (i < 3 ? ' l' : i >= n - 3 ? ' r' : '')
  const tip = (s: Series) => `${fmtDay(s.day)} · ${num(s.units)} units recorded · ${num(s.blocks)} refused`
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
  return frame(p, barOf(esc(rangeLabel)), `<div class="chart">
      <div class="crow">
        <div class="clab"><b>Units recorded</b><span>${unitMax > 0 ? `peak ${num(unitMax)} on ${esc(fmtDay(series[peakI].day))}` : 'nothing metered yet'}</span></div>
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
    </div>`)
}

/**
 * The chart for an account with a priced call: the list-price estimate per
 * day as the main series, tokens as the second row, refusals as the third.
 * Same frame, same axis and same hover layer as the units chart; the dollar
 * scale's ticks are the estimate itself. A day with calls and no price draws
 * no cost bar, and its tip says how many calls had no price, so an unpriced
 * day never reads as a free one.
 */
function costChart(p: Page, series: Series[], rangeLabel: string): string {
  const n = series.length
  const usdMax = Math.max(...series.map((s) => s.usd), 0)
  const tokMax = Math.max(...series.map((s) => s.tokens), 0)
  const blockMax = Math.max(...series.map((s) => s.blocks), 0)
  // niceMax works on whole numbers; the cost axis is scaled to micro-dollars
  // for it and printed back in dollars.
  const top = usdMax > 0 ? niceMax(Math.ceil(usdMax * 1e6)) / 1e6 : 1
  const peakI = usdMax > 0 ? series.findIndex((s) => s.usd === usdMax) : -1
  const peakT = tokMax > 0 ? series.findIndex((s) => s.tokens === tokMax) : -1
  const peakB = blockMax > 0 ? series.findIndex((s) => s.blocks === blockMax) : -1
  const edge = (i: number) => (i < 3 ? ' l' : i >= n - 3 ? ' r' : '')
  const unpriced = (s: Series) => s.calls - s.priced
  const tip = (s: Series) => `${fmtDay(s.day)} · ${s.priced ? `${usd(s.usd)} est. at list price` : 'no priced call'}${unpriced(s) ? ` · ${num(unpriced(s))} with no price` : ''} · ${num(s.tokens)} tokens · ${num(s.blocks)} refused`
  const dense = n > 31 ? ' dense' : ''
  const cols = series.map((s, i) => {
    const h = s.usd > 0 ? Math.max(2, Math.round((s.usd / top) * 100)) : 0
    return `<div class="col${edge(i)}${i === peakI ? ' peak' : ''}${h >= 80 ? ' tall' : ''}" data-t="${esc(tip(s))}" data-v="${s.priced ? usd(s.usd) : 'none'}">${h ? `<i style="height:${h}%"></i>` : '<i class="zero"></i>'}</div>`
  }).join('')
  const tcols = series.map((s, i) => {
    const h = s.tokens > 0 ? Math.max(4, Math.round((s.tokens / Math.max(1, tokMax)) * 100)) : 0
    return `<div class="col${edge(i)}${i === peakT ? ' peak' : ''}" data-t="${esc(tip(s))}" data-v="${num(s.tokens)}">${h ? `<i style="height:${h}%"></i>` : '<i class="zero"></i>'}</div>`
  }).join('')
  const bcols = series.map((s, i) => {
    const h = s.blocks > 0 ? Math.max(4, Math.round((s.blocks / Math.max(1, blockMax)) * 100)) : 0
    return `<div class="col${edge(i)}${i === peakB ? ' peak' : ''}" data-t="${esc(tip(s))}" data-v="${num(s.blocks)}">${h ? `<i class="held" style="height:${h}%"></i>` : '<i class="zero"></i>'}</div>`
  }).join('')
  const stride = n <= 7 ? 1 : n <= 31 ? 7 : 15
  let nth = 0
  const xs = series.map((s, i) => {
    const on = (n - 1 - i) % stride === 0
    const alt = on && nth++ % 2 === 1 ? ' class="alt"' : ''
    return `<span${alt}>${on ? esc(fmtDay(s.day)) : ''}</span>`
  }).join('')
  return frame(p, barOf(esc(rangeLabel)), `<div class="chart" id="cost-chart">
      <div class="crow">
        <div class="clab"><b>Est. cost</b><span>${usdMax > 0 ? `peak ${usd(usdMax)} on ${esc(fmtDay(series[peakI].day))}, at list price` : 'no priced call in this window'}</span></div>
        <div class="cplot">
          <div class="cgrid"><span data-y="${usd(top)}"></span><span data-y="${usd(top / 2)}"></span><span data-y="$0"></span></div>
          <div class="cbars${dense}">${cols}</div>
        </div>
      </div>
      <div class="crow">
        <div class="clab"><b>Tokens</b><span>${tokMax > 0 ? `peak ${num(tokMax)} a day` : 'none in this window'}</span></div>
        <div class="cplot"><div class="cbars strip${dense}">${tcols}</div></div>
      </div>
      <div class="crow">
        <div class="clab held"><b>Refused</b><span>${blockMax > 0 ? `peak ${num(blockMax)} a day` : 'none in this window'}</span></div>
        <div class="cplot"><div class="cbars strip${dense}">${bcols}</div></div>
      </div>
      <div class="cx"><span></span><div class="${dense.trim()}${stride === 1 ? ' x1' : ''}">${xs}</div></div>
    </div>`)
}

function activityTable(p: Page, series: Series[], rangeLabel: string): string {
  if (p.d.pricedEver) {
    const rows = [...series].reverse().map((s) => `<tr${s.calls === 0 && s.blocks === 0 ? ' class="zero"' : ''}>
      <td class="when">${esc(fmtDay(s.day))} <span class="dim">${esc(new Date(`${s.day}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }))}</span></td>
      <td class="num" data-l="est. cost">${s.priced ? usd(s.usd) : s.calls ? '<span class="dim">no price</span>' : usd(0)}</td>
      <td class="num" data-l="tokens">${num(s.tokens)}</td>
      <td class="num" data-l="calls">${num(s.calls)}</td>
      <td class="num" data-l="refused">${num(s.blocks)}</td>
    </tr>`).join('')
    return frame(p, barOf(esc(rangeLabel)), `<div class="cv-body flush cv-scroll"><table class="cv-table is-ruled days cost">
    <thead><tr><th>Day</th><th class="num">Est. cost</th><th class="num">Tokens</th><th class="num">Calls</th><th class="num">Refused</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`)
  }
  const rows = [...series].reverse().map((s) => `<tr${s.units === 0 && s.blocks === 0 ? ' class="zero"' : ''}>
      <td class="when">${esc(fmtDay(s.day))} <span class="dim">${esc(new Date(`${s.day}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }))}</span></td>
      <td class="num">${num(s.units)}</td>
      <td class="num">${num(s.blocks)}</td>
      <td class="num">${num(s.refused)}</td>
    </tr>`).join('')
  return frame(p, barOf(esc(rangeLabel)), `<div class="cv-body flush cv-scroll"><table class="cv-table is-ruled days">
    <thead><tr><th>Day</th><th class="num">Metered</th><th class="num">Refused</th><th class="num">Refused units</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`)
}

/** "2h 30m", as HTML: the two parts are joined by a no-break space so a
 *  narrow row never splits the figure across lines. Minutes are floored, so a
 *  span never reads longer than the rows it was measured from. */
function fmtSpan(ms: number): string {
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) return 'under a minute'
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  if (h < 48) return `${h}h&nbsp;${mins % 60}m`
  return `${Math.floor(h / 24)}d&nbsp;${h % 24}h`
}

/** The span of this job's preflights, labelled as exactly what it is: from
 *  the first preflight on record to the last, approved or refused. "On
 *  record", not "seen": a job can have made preflights that left no row (see
 *  loadConsole), and "none seen" would be false for it. It is not the job's
 *  own duration either: AgentBill has the calls your code asks about, not
 *  when the job started or when it finished. */
function seenLine(t: TaskRow): string {
  if (!t.preflights || !t.firstSeen || !t.lastSeen) return 'no preflight on record'
  if (t.preflights === 1) return 'one preflight on record'
  return `${fmtSpan(new Date(t.lastSeen).getTime() - new Date(t.firstSeen).getTime())}, first to last preflight on record`
}

function taskRow(p: Page, t: TaskRow, i = 0, editable = false): string {
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
  // was skipped; that is the leak the overview counts, so it is the filled
  // signal here too. At the ceiling the next call was refused, which is the
  // refused row: the frame's tint and the outlined refusal chip.
  const leaked = used > ceiling
  const cls = leaked ? 'fail' : ratio >= 1 ? 'held' : ratio >= 0.8 ? 'near' : ''
  const state = leaked
    ? '<span class="chip-fail">leaked</span>'
    : used >= ceiling
      ? '<span class="chip-no">ceiling hit</span>'
      : ratio >= 0.8 ? '<span class="chip-near">close</span>' : tag('running')
  const refusedRow = leaked || used >= ceiling
  // Every row names its unit (migration 014): tokens for a job wrap() opened,
  // units for a job counted in the developer's own unit, which is labelled as
  // exactly that, because it is the one number here nobody measured.
  const tokens = t.unit === 'token'
  // A job in dollars (migration 025) keeps micro-dollars in its row and
  // prints them as dollars; its ledger IS the list-price estimate, so it
  // carries no second cost line, only how many calls were charged at an
  // estimate because they could not be priced.
  const dollars = t.unit === 'usd'
  const per = tokens ? ' tokens' : ' units'
  const amt = (n: number) => (dollars ? usdText(n) : `${num(n)}${per}`)
  // Calls recorded without a usage count were charged at least the
  // reservation they settled, not 0, so the total is partly an estimate; the
  // row says how many. A call that found no reservation open was recorded at
  // what was sent, which is why the note says "where one was open" and not
  // "charged at their reservation", the wording before 2026-09-23 that was
  // false for exactly those calls.
  const missing = Number(t.usageMissingCalls ?? 0)
  const missingLine = missing > 0
    ? `<div class="tk-f tk-s"><span class="bmiss">${num(missing)} ${missing === 1 ? 'call' : 'calls'} with no usage reported, charged at least the reservation where one was open</span></div>`
    : ''
  return `<tr${refusedRow ? ' class="is-no"' : ''}>
      <td class="lead"><div class="tk">
        <div class="tk-n"><a href="${href(p, 'refusals', { task: t.taskRef })}" title="Refusals for this task">${esc(t.taskRef)}</a><span class="tk-a">${esc(t.agentId)}</span></div>
        <div class="tk-f">${leaked ? `${amt(used - ceiling)} past the ceiling` : `${amt(remaining)} left`}${reserved > 0 ? ` · ${dollars ? usdText(reserved) : num(reserved)} reserved in flight` : ''} · ${rel(t.updatedAt)}</div>
        <div class="tk-f tk-s"><span class="bseen">${seenLine(t)}</span></div>${missingLine}${dollars ? unpricedLine(t) : costLine(t)}
      </div></td>
      ${dollars
        ? `<td class="num" data-l="used" title="${esc(LIST_PRICE_LABEL)}"><b>${usdText(used)}</b> / ${usdText(ceiling)} <span class="est">est.</span></td>`
        : `<td class="num" data-l="used"${tokens ? '' : ' title="units: your own count"'}><b>${num(used)}</b> / ${num(ceiling)}${per}</td>`}
      <td class="burn"><div class="cv-meter is-row${cls ? ` ${cls}` : ''}" aria-hidden="true"><i style="width:${usedPct.toFixed(1)}%"></i><s style="left:${usedPct.toFixed(1)}%;width:${resPct.toFixed(1)}%"></s><u></u></div></td>
      <td class="state">${state}</td>${editable ? `
      <td class="wide"><form method="POST" action="/app/tasks" class="bset" autocomplete="off">
          <input type="hidden" name="task_ref" value="${esc(t.taskRef)}" />
          <label class="cv-label" for="ceil-${i}">ceiling${dollars ? ', $' : ''}</label>
          ${dollars
            ? `<input type="hidden" name="unit" value="usd" /><input id="ceil-${i}" class="cv-field m" name="ceiling" type="text" inputmode="decimal" pattern="\\$?[0-9]{1,7}(\\.[0-9]{1,6})?" value="${dollarInput(ceiling)}" required />`
            : `<input id="ceil-${i}" class="cv-field m" name="ceiling_units" type="number" inputmode="numeric" min="${Math.max(1, used + reserved)}" max="${INT4_MAX}" step="1" value="${ceiling}" required />`}
          <button class="btn-ghost" type="submit">Save</button>
        </form></td>` : ''}
    </tr>`
}

/** Micro-dollars as a form value: 5000000 is "5.00", 90000 is "0.09", 7500 is "0.0075". */
function dollarInput(micros: number): string {
  const s = (micros / 1_000_000).toFixed(6).replace(/0+$/, '')
  const [w, f = ''] = s.split('.')
  return `${w}.${f.padEnd(2, '0')}`
}

/** A dollar job's calls that could not be priced: charged what was held for them, never $0. */
function unpricedLine(t: TaskRow): string {
  const n = Number(t.unpricedCalls ?? 0)
  return n > 0
    ? `<div class="tk-f tk-s"><span class="bmiss">${num(n)} ${n === 1 ? 'call' : 'calls'} with no list price, charged at ${n === 1 ? 'its' : 'their'} estimate</span></div>`
    : ''
}

/**
 * What the job's recorded calls cost at list price: the sum the server stored
 * on each priced event of this task_ref, never a conversion of the job's
 * units. A job with calls and no price says so; a job with no calls says
 * nothing, because there is nothing yet to be honest about.
 */
function costLine(t: TaskRow): string {
  const calls = Number(t.calls ?? 0)
  if (!calls) return ''
  const priced = Number(t.pricedCalls ?? 0)
  const left = calls - priced
  if (t.usd == null) {
    return `<div class="tk-f tk-s"><span class="bcost" title="${t.unit === 'token' ? 'No call on this job named a model with a list price.' : 'Units are your own count, and no call on this job named a model.'}">${t.unit === 'token' ? 'no list price' : 'your own count, no $ estimate'}</span></div>`
  }
  return `<div class="tk-f tk-s"><span class="bcost" title="${esc(LIST_PRICE_LABEL)}"><b>${usd(t.usd)}</b> est.${left ? `, ${num(left)} of ${num(calls)} calls unpriced` : ''}</span></div>`
}

function tasksBlock(p: Page, tasks: TaskRow[], side = ''): string {
  const editable = p.view === 'tasks' && !p.demo
  if (tasks.length === 0) {
    // One job is one budget, and the budget can be set here before any code
    // runs. The old text sent a reader back to their editor to pass two
    // arguments, which was the console admitting it could not do the one thing
    // a person opening it wanted from it.
    const where = editable
      ? 'Name a job above and give it a ceiling'
      : `<a href="${href(p, 'tasks')}">Name a job and give it a ceiling</a>`
    return `<div class="cv-empty"><p class="nothing">No jobs yet. One job is one budget. ${where}, then have your code preflight with that <code>task_ref</code>; it appears here and burns down live. A job opened from code, with <code>task_ref</code> and <code>task_ceiling</code> on its first preflight, appears the same way.</p></div>`
  }
  const table = `<div class="cv-body flush cv-scroll"><table class="cv-table cards tasks">
    <thead><tr><th>Task</th><th class="num">Used</th><th>Burn-down</th><th>State</th>${editable ? '<th class="num">Ceiling</th>' : ''}</tr></thead>
    <tbody>${tasks.map((t, i) => taskRow(p, t, i, editable)).join('')}</tbody>
  </table></div>`
  return frame(p, barOf('task_ref', true),
    side ? `<div class="cv-split">${table}${side}</div>` : table)
}

/**
 * The right column of the overview's task frame: the job the newest refusal
 * landed on, as the homepage frame draws "this job". Its used over its ceiling
 * as the figure, the kit's meter (which computes its own share, so the bar
 * cannot disagree with the number), the refusal's own sentence in the signal,
 * and the persisted body on the plate. Every value comes from the rows this
 * page already loaded; nothing here is new data. Without a refusal on a job
 * it is the most recently touched job, figure and meter only.
 */
function jobSide(p: Page): string {
  const d = p.d
  const refusal = d.decisions.find((r) => r.blocked && r.taskRef && d.tasks.some((t) => t.taskRef === r.taskRef)) ?? null
  const job = refusal ? d.tasks.find((t) => t.taskRef === refusal.taskRef) ?? null : d.tasks[0] ?? null
  if (!job) return ''
  const used = Number(job.usedUnits)
  const ceiling = Number(job.ceilingUnits)
  return `<div class="cv-side">
        <div class="side-h">${label('this job')}${tag(esc(job.taskRef), true)}</div>
        ${job.unit === 'usd'
          ? `<div class="cv-stat" title="${esc(LIST_PRICE_LABEL)}"><b>${usdText(used)}</b> <span>/ ${usdText(ceiling)}, est. at list price</span></div>`
          : `<div class="cv-stat"><b>${num(used)}</b> <span>/ ${num(ceiling)} ${unitWord(job.unit)}${job.unit === 'token' ? '' : ', your own count'}</span></div>`}
        ${meter(used, ceiling)}
        ${job.usd != null && job.unit !== 'usd' ? `<p class="side-cost" title="${esc(LIST_PRICE_LABEL)}"><b>${usd(job.usd)}</b> est. at list price</p>` : ''}
        ${refusal ? `<p class="cv-no">${esc(decisionLine(refusal))}</p>
        <div class="cv-code is-sm plate">${plateBody(refusal.snapshot)}</div>` : ''}
      </div>`
}

/**
 * A persisted body for the plate: pretty-printed when it parses and verbatim
 * when it does not, the rule every body on this page follows, with the
 * approved: false line in the plate's signal, as the homepage plate marks it.
 * Escaped first, so the wrap is the only markup in it.
 */
function plateBody(snapshot: string): string {
  let pretty = snapshot
  try { pretty = JSON.stringify(JSON.parse(snapshot), null, 2) } catch { /* leave verbatim */ }
  return esc(pretty).split('\n')
    .map((l) => (/^\s*&quot;approved&quot;: false,?$/.test(l) ? `<span class="no">${l}</span>` : l)).join('\n')
}

const FLASH_TEXT: Record<NonNullable<Flash['err']>, (f: Flash) => string> = {
  ref: () => 'The job name (task_ref) is 1 to 128 characters with no control characters.',
  ceiling: () => 'The ceiling is a whole number, 1 or more, in the job\u2019s own unit.',
  usd: () => 'A ceiling in dollars is more than $0 and at most $1,000,000, with at most six decimals: 5, 5.00 or 0.25.',
  unit: (f) => f.ref && f.unit
    ? `<code>${esc(f.ref)}</code> is counted in ${f.unit === 'usd' ? 'dollars' : unitWord(f.unit)}, and a job\u2019s unit is fixed when it opens. Choose ${f.unit === 'usd' ? 'dollars' : unitWord(f.unit)} and save again, or name a new job.`
    : 'That job is counted in another unit, and a job\u2019s unit is fixed when it opens. Choose its unit and save again, or name a new job.',
  agent: () => 'The agent label is 1 to 128 characters with no control characters.',
  rate: () => 'Too many saves in one minute for this key. Wait a moment and try again.',
  below: (f) => f.ref && f.min != null
    ? `<code>${esc(f.ref)}</code> already has ${f.unit === 'usd' ? `<b>${usdText(f.min)}</b>` : `<b>${num(f.min)}</b> ${unitWord(f.unit, f.min)}`} committed: spent, plus reserved by calls in flight. The ceiling cannot go under that. Set ${f.unit === 'usd' ? usdText(f.min) : num(f.min)} or more, or wait for the reservations to settle or expire.`
    : 'That ceiling is under what the job has already committed: spent, plus reserved by calls in flight. Set it at or above that number, or wait for the reservations to settle or expire.',
}

/** The form that opens a job or changes its ceiling, with the suggested
 *  ceilings under it. Tasks view only.
 *
 *  Under sample data the same fields render with no form around them and a
 *  link where the button was (2026-09-23), so a prospect can try the
 *  suggestion and nothing can be saved: a save there would write to the real
 *  account behind a page that says nothing on it is real. Until then the
 *  sample tasks view showed no form at all.
 *
 *  Until 2026-09-12 this doubled as the three-step first run for an account
 *  that had spent nothing, because POST /app/tasks always landed here. The
 *  start screen (startScreen below, ?view=start) owns that path now and the
 *  start form posts back to itself, so this is the compact editor for
 *  everyone, with one line pointing a reader who has no refusal yet at the
 *  screen built for them. */
function ceilingForm(p: Page): string {
  const pointer = p.d.lastBlock === null && p.d.overruns === 0
    ? `<p class="fine"><a href="${href(p, 'start')}">New here? Connect first, and your first call shows what it cost &rarr;</a></p>` : ''
  const f = p.flash
  const said = !f ? ''
    : f.saved !== undefined ? `<p class="ok">${f.saved ? `Ceiling set on <code>${esc(f.saved)}</code>${f.created ? ', a new job' : ''}.` : 'Ceiling saved.'} Every preflight that names this task_ref uses it from the next call.${f.agentKept ? ' The agent label was not changed: it is read only when a save opens the job.' : ''}</p>`
    : f.err ? `<p class="err cv-err">${FLASH_TEXT[f.err](f)}</p>`
    : ''
  const keep = f?.err && f.ref ? esc(f.ref) : ''
  // A picked suggestion fills the ceiling and the agent label. Neither is
  // read-only, and nothing is saved until the reader presses the button.
  const pick = p.suggest?.pick ?? null
  const fields = `
      <div><label class="cv-flabel" for="t-ref">Job <code>task_ref</code></label><input id="t-ref" class="cv-field m" name="task_ref" placeholder="job-142" maxlength="128" value="${keep}" required /></div>
      <div><label class="cv-flabel" for="t-ceil">Ceiling</label><input id="t-ceil" class="cv-field m" name="ceiling" type="text" inputmode="decimal" maxlength="16" ${pick ? `value="${pick.unit === 'usd' ? dollarInput(pick.units) : pick.units}"` : 'placeholder="5.00"'} required /></div>
      <div><label class="cv-flabel" for="t-unit">In</label><select id="t-unit" class="cv-field m" name="unit">${(['usd', 'token', 'unit'] as const).map((u) =>
        `<option value="${u}"${(pick ? pick.unit : 'usd') === u ? ' selected' : ''}>${u === 'usd' ? 'dollars, at list price' : u === 'token' ? 'tokens' : 'units, your own count'}</option>`).join('')}</select></div>
      <div><label class="cv-flabel" for="t-agent">Agent label, optional</label><input id="t-agent" class="cv-field m" name="agent_id" placeholder="researcher" maxlength="128"${pick ? ` value="${esc(pick.agentId)}"` : ''} /></div>`
  const form = p.demo
    ? `<div class="setf">${fields}
      <a class="btn" href="${p.anon ? '/register' : href(p, 'tasks', { demo: false })}">${p.anon ? 'Get an API key to set it' : 'Set it on your account'}</a>
    </div>`
    : `<form method="POST" action="/app/tasks" class="setf" autocomplete="off">${fields}
      <button class="btn btn-lg" type="submit">Set ceiling</button>
    </form>`
  return `<div class="setc">
    ${said}${pointer}
    ${form}
    ${pickLine(p)}
    ${historyBlock(p)}
    <p class="fine">One job, one budget, in dollars, tokens or units of your own, chosen when the job opens and fixed after. A ceiling in dollars is the list-price estimate of the tokens each call reports: preflight reserves the job's recent median call, or $0.10 before its first priced call, and each record settles to what the call cost. A call with no list price is charged its reservation, never $0. The ceiling saved here is the one preflight uses. Your code can open a job with <code>task_ceiling</code> on its first call; once the job exists, a <code>task_ceiling</code> on preflight is not applied, and the ceiling changes only here or through <code>PUT /tasks/:task_ref/ceiling</code>: last save wins. The agent label is read only when a save opens the job. When the job has no room left, preflight answers <code>approved: false</code> and your code decides what next.</p>
  </div>`
}

/** The line under the form once a suggestion is in the field: which figure,
 *  from which jobs, and that it is still the reader's to change. */
function pickLine(p: Page): string {
  const k = p.suggest?.pick
  if (!k) return ''
  // The label is escaped once, here, so neither branch below can print it raw.
  const who = esc(k.agentId)
  const from = k.jobs === 1
    ? `what your last job of ${who} used`
    : `the ${k.which} of your last ${num(k.jobs)} jobs of ${who}`
  return `<p class="conv">In the ceiling field: <b>${amountText(k.unit, k.units)}</b>, ${from}, with that agent's label beside it. Still editable: change it if the next job will not look like ${k.jobs === 1 ? 'that one' : 'those'}.${p.demo ? ' This is sample data, so nothing here is saved.' : ' Nothing is saved until you press Set ceiling.'}</p>`
}


/**
 * The suggested ceilings. Hidden when no agent has a finished job, because a
 * suggestion from no history would be a number made up. Each figure is a
 * link that puts it in the ceiling field with that agent's label; the page
 * then looks it up in the rows again rather than trusting the link.
 */
function historyBlock(p: Page): string {
  const s = p.suggest
  if (!s || s.history.length === 0) return ''
  const rows = s.history.map((h) => {
    const on = (k: Pick) => s.pick?.agentId === h.agentId && s.pick.which === k
    const link = (k: Pick, name: string) =>
      `<a class="pk${on(k) ? ' on' : ''}" href="${href(p, 'tasks', { history: h.agentId, pick: k })}"${on(k) ? ' aria-current="true"' : ''}>${name}<b>${h.unit === 'usd' ? usdText(h[k]) : num(h[k])}</b></a>`
    // One job has one figure; three equal links would be noise.
    const figures = h.jobs === 1 ? link('max', '') : PICKS.map((k) => link(k, `${k} `)).join('')
    return `<div class="hrow"><span class="hw">from your last ${h.jobs === 1 ? 'job' : `${num(h.jobs)} jobs`} of <b class="ha">${esc(h.agentId)}</b></span><span class="hp">${figures}<span class="hu">${h.unit === 'usd' ? 'at list price' : unitWord(h.unit)}</span></span></div>`
  }).join('')
  return `<div class="hist">
      <p class="lbl cv-label">Suggested ceilings</p>
      ${rows}
      <p class="fine">A pick fills the ceiling field with that agent's label; ${p.demo ? 'sample data, so nothing here is saved' : 'nothing is saved until you press Set ceiling'}. Each figure is the p50, p90 or max of that agent's last ${num(HISTORY_JOBS)} finished jobs: one real job's total, in dollars at list price when every call of those jobs was priced, and in the jobs' own unit otherwise. <a href="/docs#ceiling-suggestion">How the suggestion is computed</a>.</p>
    </div>`
}

// The legend: the bar's two parts as swatches, then the three states, named
// with the same words as before. A bar within a fifth of its ceiling stays
// ink, so that state's mark is the chip its row carries, not a swatch.
const TASK_KEY = `<div class="key"><span><i></i> spent</span><span><i class="res"></i> reserved by a call in flight</span><span><span class="chip-near">close</span> within a fifth of the ceiling</span><span><i class="held"></i> ceiling held: the next call was refused</span><span><i class="fail"></i> leaked past the ceiling</span></div>`

/** The decision a row carries: the refusal chip, outlined in the signal, or
 *  the leak, the signal filled. The rule's name is the chip's text. */
const ruleChip = (r: DecisionRow) =>
  `<span class="${r.blocked === false ? 'chip-fail' : 'chip-no'}" title="${esc(r.reason)}">${esc(REASON_LABEL[r.reason] ?? r.reason)}</span>`

/** One refusal as a log row. `body` adds the column with what the agent got. */
function refusalRow(p: Page, r: DecisionRow, body: boolean): string {
  const leak = r.blocked === false
  const when = new Date(r.createdAt)
  return `<tr>
      <td class="when" title="${esc(when.toISOString())}">${rel(when)}</td>
      <td class="rule">${ruleChip(r)}</td>
      <td class="id" data-l="agent" title="${esc(r.agentId ?? '')}">${r.agentId ? `<a href="${href(p, 'refusals', { agent: r.agentId })}">${esc(r.agentId)}</a>` : '<span class="none">none</span>'}</td>
      <td class="id" data-l="task" title="${esc(r.taskRef ?? '')}">${r.taskRef ? `<a href="${href(p, 'refusals', { task: r.taskRef })}">${esc(r.taskRef)}</a>` : '<span class="none">none</span>'}</td>
      <td class="msg${leak ? ' bad' : ''}">${esc(decisionLine(r))}</td>${body ? `
      <td class="body"><details><summary>body</summary><pre class="cv-code is-sm">${plateBody(r.snapshot)}</pre></details></td>` : ''}
    </tr>`
}

/** The overview's latest refusals: the same rows as the refusals view, without the body. */
function refusalRows(p: Page, rows: DecisionRow[]): string {
  return `<div class="cv-body flush cv-scroll"><table class="cv-table refusals">
    <thead><tr><th>When</th><th>Rule</th><th>Agent</th><th>Task</th><th>What happened</th></tr></thead>
    <tbody>${rows.map((r) => refusalRow(p, r, false)).join('')}</tbody>
  </table></div>`
}

function decisionsTable(p: Page, rows: DecisionRow[], truncated: boolean): string {
  const filtered = p.filter.task || p.filter.agent || p.filter.only
  if (rows.length === 0) {
    return `<div class="cv-empty"><p class="nothing">${filtered
      ? 'Nothing on this account matches this filter.'
      : 'Nothing refused yet. Every call AgentBill refuses lands here with the literal JSON your agent received.'}</p></div>`
  }
  return `${frame(p, barOf('refusals'), `<div class="cv-body flush cv-scroll"><table class="cv-table is-ruled refusals">
    <thead><tr><th>When</th><th>Rule</th><th>Agent</th><th>Task</th><th>What happened</th><th>What the agent got</th></tr></thead>
    <tbody>${rows.map((r) => refusalRow(p, r, true)).join('')}</tbody>
  </table></div>`)}
  ${truncated ? `<p class="note">The latest 100 of ${num(p.d.decisionMatched)}${filtered ? ' that match' : ''}. The full list is on <code>GET /decisions</code>.</p>` : ''}`
}

/** The window's units by event_type. The bar is scaled to the heaviest
 *  group, the percentage is of every unit in the window, the same shape the
 *  customers table uses for share of spend. */
function usageTable(p: Page, u: EventTypeUsage, rangeLabel: string): string {
  if (u.groups.length === 0) {
    return `<div class="cv-empty"><p class="nothing">Nothing recorded in the last ${esc(rangeLabel)}. Each event your code records lands here under its <code>event_type</code>.</p></div>`
  }
  if (p.d.pricedEver && u.totalPriced > 0) {
    // Shares are of the window's estimate; a group with no priced call has no
    // share of it and says so, rather than reading as 0% of the money.
    const dearest = Math.max(...u.groups.map((g) => g.usd ?? 0), 0)
    const total = u.totalUsd ?? 0
    const rows = u.groups.map((g) => {
      const share = g.usd != null && total > 0 ? (g.usd / total) * 100 : null
      const pct = share == null ? 'no price' : share > 0 && share < 1 ? '&lt;1% of cost' : `${Math.round(share)}% of cost`
      const w = g.usd != null && dearest > 0 ? Math.max(2, Math.round((g.usd / dearest) * 100)) : 0
      return `<tr>
      <td class="id lead" title="${esc(g.eventType)}">${esc(g.eventType)}</td>
      <td class="wide"><div class="share"><div class="cv-meter is-row" aria-hidden="true"><i style="width:${w}%"></i></div><span>${pct}</span></div></td>
      <td class="num" data-l="est. cost">${g.usd != null ? usd(g.usd) : '<span class="dim">no price</span>'}</td>
      <td class="num" data-l="tokens">${num(g.tokens)}</td>
      <td class="num" data-l="records">${num(g.events)}</td>
    </tr>`
    }).join('')
    return frame(p, barOf('event_type', true), `<div class="cv-body flush cv-scroll"><table class="cv-table cards cost">
    <thead><tr><th>event_type</th><th>Share of cost</th><th class="num">Est. cost</th><th class="num">Tokens</th><th class="num">Records</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`)
  }
  const heaviest = Math.max(1, ...u.groups.map((g) => g.units))
  const body = u.groups.map((g) => {
    const share = u.totalUnits > 0 ? (g.units / u.totalUnits) * 100 : 0
    const pct = share > 0 && share < 1 ? '&lt;1%' : `${Math.round(share)}%`
    return `<tr>
      <td class="id lead" title="${esc(g.eventType)}">${esc(g.eventType)}</td>
      <td class="wide"><div class="share"><div class="cv-meter is-row" aria-hidden="true"><i style="width:${Math.max(2, Math.round((g.units / heaviest) * 100))}%"></i></div><span>${pct} of units</span></div></td>
      <td class="num" data-l="units">${num(g.units)}</td>
      <td class="num" data-l="records">${num(g.events)}</td>
    </tr>`
  }).join('')
  return frame(p, barOf('event_type', true), `<div class="cv-body flush cv-scroll"><table class="cv-table cards">
    <thead><tr><th>event_type</th><th>Share of units</th><th class="num">Units</th><th class="num">Records</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>`)
}

function customersTable(p: Page, rows: CustomerRow[], total: number, compact = false): string {
  if (rows.length === 0) {
    return `<div class="cv-empty"><p class="nothing">No customers yet. Pass <code>customer_id</code> on a preflight or record call and each of your end users gets an independent balance here.</p></div>`
  }
  const maxUsed = Math.max(1, ...rows.map((c) => Number(c.usedUnits)))
  // Two kinds of number, two columns, never one sum (2026-09-25). Used, limit
  // and left are the customer's balance in the units and tokens the code
  // reported; a dollar job never moves them. Est. cost is what the customer's
  // priced calls cost at list price, and it has no limit and no "left": a
  // dollar job is bounded by its own ceiling, on the tasks view.
  const priced = rows.some((c) => c.usd != null)
  const body = rows.map((c) => {
    const used = Number(c.usedUnits)
    const limit = c.limitUnits == null ? null : Number(c.limitUnits)
    const share = total > 0 ? Math.round((used / total) * 100) : 0
    const fill = Math.round((used / maxUsed) * 100)
    const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0
    const cls = limit && used >= limit ? 'held' : pct >= 80 ? 'near' : ''
    // A customer at their limit is a limit that held, not an incident: the
    // refused row, because that customer's next call is refused.
    const atLimit = !!limit && used >= limit
    const status = atLimit ? '<span class="chip-no">at limit</span>' : tag('ok')
    return `<tr${atLimit ? ' class="is-no"' : ''}>
      <td class="id lead" title="${esc(c.customerRef)}">${esc(c.customerRef)}</td>
      <td class="wide"><div class="share"><div class="cv-meter is-row${cls ? ` ${cls}` : ''}" aria-hidden="true"><i style="width:${Math.max(2, fill)}%"></i></div><span>${share}% of units</span></div></td>${priced ? `
      <td class="num" data-l="est. cost"${c.usd != null ? ` title="${esc(LIST_PRICE_LABEL)}"` : ''}>${c.usd != null ? usd(c.usd) : '<span class="dim">no price</span>'}</td>` : ''}
      <td class="num" data-l="units used" title="units and tokens your code reported, never dollars">${num(used)}</td>
      <td class="num" data-l="limit">${limit == null ? '<span class="dim">no limit</span>' : num(limit)}</td>
      <td class="num" data-l="left">${limit == null ? '<span class="dim">no limit</span>' : num(Math.max(0, limit - used))}</td>
      <td class="state">${status}</td>
    </tr>`
  }).join('')
  return frame(p, barOf('customer_id', true), `<div class="cv-body flush cv-scroll"><table class="cv-table cards">
    <thead><tr><th>Customer</th><th>Share of units${compact ? '' : ' · all customers'}</th>${priced ? '<th class="num">Est. cost</th>' : ''}<th class="num">Units used</th><th class="num">Limit</th><th class="num">Left</th><th>State</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>`)
}

function keysTable(p: Page, rows: KeyRow[], viewerKeyId: string): string {
  if (rows.length === 0) return `<div class="cv-empty"><p class="nothing">No keys on this account.</p></div>`
  const now = Date.now()
  const body = rows.map((k) => {
    const mine = viewerKeyId !== '' && k.id === viewerKeyId
    const mask = maskKey(k.keyPrefix, k.keyLast4)
    const revoked = k.revokedAt ? new Date(k.revokedAt).getTime() : null
    const expires = k.expiresAt ? new Date(k.expiresAt).getTime() : null
    // A working key is not an achievement, so it is a plain tag. A colour
    // here would be a second meaning for the accent.
    let state = tag('active')
    if (revoked !== null && revoked <= now) state = '<span class="tag dead">revoked</span>'
    else if (revoked !== null) state = '<span class="chip-near">rotating</span>'
    else if (expires !== null && expires <= now) state = '<span class="tag dead">expired</span>'
    else if (expires !== null && expires - now < 86_400_000) state = '<span class="chip-near">expiring</span>'
    return `<tr>
      <td class="id lead">${esc(mask)}</td>
      <td class="wide">${k.label ? esc(k.label) : '<span class="none">no label</span>'}${mine ? ' <span class="tag" title="The key that opened this console">this session</span>' : ''}</td>
      <td class="state">${state}</td>
      <td class="when" data-l="created">${rel(k.createdAt)}</td>
      <td class="when" data-l="expires">${k.expiresAt ? rel(k.expiresAt) : '<span class="none">never</span>'}</td>
      <td class="when" data-l="last seen from">${k.lastSeenIp ? esc(k.lastSeenIp) : '<span class="none">unused</span>'}</td>
    </tr>`
  }).join('')
  return frame(p, barOf('keys'), `<div class="cv-body flush cv-scroll"><table class="cv-table cards">
    <thead><tr><th>Key</th><th>Label</th><th>State</th><th>Created</th><th>Expires</th><th>Last seen from</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>`)
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
    ? 'with no limit'
    : `with <b>${num(v.defaultBudgetUnits)} units</b>, the account default`
  return `${frame(p, barOf('preflight'), `
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
          <p>A customer is created the first time its id is seen, ${born}. Change it with <code>PUT /budget</code>, which also creates the customer if it is new; a ceiling may be set below what is already used and reserved, and that customer is then refused until the reservations settle. Calls without a <code>customer_id</code> share the customer named <code>default</code>. The reservation is atomic: used, reserved and the estimate must fit under the limit together, or the call is refused with <code>budget_exhausted</code>.</p>
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
          <p>Every call and tool that shares a <code>task_ref</code> is checked against one ceiling. The job is opened with it, on the first preflight that passes <code>task_ceiling</code> or on the <a href="${href(p, 'tasks')}">task budgets</a> view; after that the last save in the console is the ceiling in force, and a <code>task_ceiling</code> from code is not applied. A preflight for a job that does not exist yet, sent without a ceiling, is rejected with <code>task_ceiling_required</code>. Refused with <code>task_ceiling_exceeded</code>. A record that lands past the ceiling after the call ran is kept as a leak, not hidden.</p>
        </div>
        <div class="live">
          <span><b>${num(live)}</b> ${live === 1 ? 'task' : 'tasks'} under a ceiling now</span>
          ${refusedLine(by('task_ceiling_exceeded'))}
          <span><b class="${d.overruns ? 'fail' : ''}">${num(d.overruns)}</b> leaked · all time</span>
          ${d.taskCount ? `<a href="${href(p, 'tasks')}">Burn-down &rarr;</a>` : ''}
        </div>
      </div>`)}
    <p class="note">The per-request ceiling is an argument to the call itself and has no endpoint. A customer's ceiling is set from the API: <code>GET /budget?customer_id=</code> returns the balance and creates the customer if it is new, <code>PUT /budget</code> sets it. A job's ceiling is the one number this console edits, on the <a href="${href(p, 'tasks')}">task budgets</a> view or with <code>PUT /tasks/:task_ref/ceiling</code>.</p>`
}

/**
 * The start screen, 2026-09-25: one question, how will you connect, and for
 * each answer one short path that ends on the account's first recorded model
 * call, shown back with its tokens, its model and its list-price estimate.
 * Rendered at ?view=start (where a new key lands) and as the overview until
 * the account has recorded anything (see onboardingDue). The words are in
 * src/ui/steps.ts; the choice is ?via=, a link, because this page ships no
 * script of its own (the one exception is the copy control on the MCP path,
 * under its own hash).
 *
 * Why it changed. The three steps it replaced (a job and a ceiling in units, a
 * sample that called record(units=1), the refusal) never showed a new account
 * a dollar: record(units=1) names no model, so the server has nothing to
 * price. The founder, as a user, found them "not clear at all". The ceiling
 * and the refusal are now the next thing, on the Task budgets view.
 *
 * The two code samples are literal blocks in this file (pythonSample and
 * nodeSample below), because scripts/snippets/extract.mjs executes only a
 * literal one, and records an interpolated one as "dynamic" with no code,
 * which drops it from CI in silence. The hygiene gate counts them. Neither
 * carries anything of the reader's: wrap() opens its own job, first-call,
 * with a ceiling in tokens, on the first call.
 *
 * The last block is the account's own first model call (loadConsole's
 * `first`): the earliest event whose metadata names a model and carries token
 * counts. Its dollar figure is the one the server stored when the record
 * landed (events.list_price_usd, src/lib/prices.ts), never one worked out
 * here, and a call it could not price says why instead of showing $0.
 */
function pythonSample(): string {
  return `<pre class="snip">import agentbill
from openai import OpenAI

# reads AGENTBILL_API_KEY and OPENAI_API_KEY from the environment
llm = agentbill.wrap(OpenAI(), task_ref="first-call",
                     agent_id="start", task_ceiling=20_000)
reply = llm.chat.completions.create(
    model="gpt-4o-mini",
    max_tokens=20,
    messages=[{"role": "user", "content": "Say hi in three words."}],
)
if isinstance(reply, agentbill.Refusal):
    print(reply)
else:
    print(reply.choices[0].message.content)</pre>`
}

function nodeSample(): string {
  return `<pre class="snip">import OpenAI from 'openai'
import { wrap, isRefusal } from 'agentbill'

// reads AGENTBILL_API_KEY and OPENAI_API_KEY from the environment
const llm = wrap(new OpenAI(), { taskRef: 'first-call', agentId: 'start', taskCeiling: 20_000 })
const reply = await llm.chat.completions.create({
  model: 'gpt-4o-mini',
  max_tokens: 20,
  messages: [{ role: 'user', content: 'Say hi in three words.' }],
})
console.log(isRefusal(reply) ? String(reply) : reply.choices[0].message.content)</pre>`
}

/** The last step of every path: the account's first model call, or where it will appear. */
function firstCallBlock(p: Page): string {
  const f = p.d.first
  const job = (ref: string | null) => ref ? ` on job <code>${esc(ref)}</code>` : ''
  const step = (s: string | null) => s ? `, step <code>${esc(s)}</code>` : ''
  if (f && f.usd != null) {
    return `<p class="first-ok" id="first-call">Your first call was recorded: <b>${usd(f.usd)}</b> <span class="est" title="${esc(LIST_PRICE_LABEL)}">(estimate at list price)</span>, ${num(f.tokens)} ${f.tokens === 1 ? 'token' : 'tokens'}, model <code>${esc(f.model)}</code>${job(f.taskRef)}${step(f.step)}.</p>
       <p class="fine">${esc(LIST_PRICE_LABEL)}</p>
       <p>Next, give a job a ceiling on <a href="${href(p, 'tasks')}">Task budgets</a>. Once it is spent, preflight answers <code>approved: false</code> before the call goes out, and your code decides what happens next.</p>
       <p><a class="btn" href="${href(p, 'overview')}">Open the console &rarr;</a></p>`
  }
  if (f) {
    return `<p class="first-ok" id="first-call">Your first call was recorded: ${num(f.tokens)} ${f.tokens === 1 ? 'token' : 'tokens'}, model <code>${esc(f.model)}</code>${job(f.taskRef)}${step(f.step)}. It has no dollar estimate: ${esc(f.note ?? 'it could not be priced')}. A call with no list price is never counted as $0.</p>
       <p><a class="btn" href="${href(p, 'overview')}">Open the console &rarr;</a></p>`
  }
  if (p.d.recorded) {
    return `<p id="first-call">Calls are arriving on this account, but none of them names a model, so none can be priced. The lines above record the model and the tokens your provider reported, and the first one appears here.</p>`
  }
  return `<p id="first-call">${WAITING_LINE}</p>`
}

function startScreen(p: Page): string {
  const f = p.flash
  const said = !f ? ''
    : f.saved !== undefined ? `<p class="ok">${f.saved ? `Ceiling set on <code>${esc(f.saved)}</code>${f.created ? ', a new job' : ''}.` : 'Ceiling saved.'} Every preflight that names this task_ref uses it from the next call.</p>`
    : f.err ? `<p class="err cv-err">${FLASH_TEXT[f.err](f)}</p>`
    : ''
  // A person whose account has no key yet: the key comes first, from here.
  const firstKey = !p.anon && !p.demo && p.v.via === 'user' && !p.v.keyId
    ? `<div class="ns3 firstkey-row"><span class="ns3-n">0</span><div class="firstkey">
          <p>Your account is open and has no API key yet. Make it here: it is shown once, on the next screen, and your code sends it with every call.</p>
          <form method="POST" action="/app/keys/first"><button class="btn btn-lg" type="submit">Create my API key &rarr;</button></form>
        </div></div>`
    : ''
  const via = p.via ?? null
  const cards = VIAS.map((v) =>
    `<a class="via" href="${href(p, 'start', { via: v })}"${v === via ? ' aria-current="true"' : ''}><b>${VIA_TITLE[v]}</b><span>${VIA_SUB[v]}</span></a>`).join('\n        ')
  const step = (n: number, body: string) => `<div class="ns3"><span class="ns3-n">${n}</span><div>${body}</div></div>`
  const last = (n: number) => step(n, `<p><b>Your first call</b></p>${firstCallBlock(p)}`)
  let path = ''
  if (via === 'mcp') {
    path = [
      step(1, `<p>Add AgentBill to your client. The connect page has the steps for Claude, ChatGPT, Claude Code, Codex, Cursor and any other MCP client: sign in, allow, done.</p>
        <p><a class="btn" href="/integrations/mcp">Open the connect page &rarr;</a></p>`),
      step(2, `<p>Paste this into a new chat.</p>
        ${copyPlate('mcp-prompt', esc(MCP_PROMPT))}
        <div class="does"><div>${label('What it does')}<p>${MCP_DOES}</p></div><div>${label('What it does not')}<p>${MCP_DOES_NOT}</p></div></div>
        <p class="fine">The prompt records a test call, with the token counts you gave it, so you can see one priced record land here. It is not a measurement of anything, and it is recorded under step <code>test</code>.</p>`),
      last(3),
    ].join('\n      ')
  } else if (via === 'python') {
    path = [
      step(1, `<p>Install the SDK and the OpenAI client, once, where your code runs.</p>
        <div class="snip">${INSTALL_PY_WRAP}</div>`),
      step(2, `<p>Run this. It makes one real call to OpenAI through <code>wrap()</code>.</p>
        ${pythonSample()}
        <p class="fine">${KEYS_LINE}</p>
        <p class="fine">${WHAT_RUNS}</p>
        <p class="fine">${ANTHROPIC_LINE}</p>`),
      last(3),
    ].join('\n      ')
  } else if (via === 'node') {
    path = [
      step(1, `<p>Install the SDK and the OpenAI client, once, where your code runs.</p>
        <div class="snip">${INSTALL_NODE_WRAP}</div>`),
      step(2, `<p>Save this as <code>first-call.mjs</code> and run <code>node first-call.mjs</code>. It makes one real call to OpenAI through <code>wrap()</code>.</p>
        ${nodeSample()}
        <p class="fine">${KEYS_LINE}</p>
        <p class="fine">${WHAT_RUNS}</p>
        <p class="fine">${ANTHROPIC_LINE}</p>`),
      last(3),
    ].join('\n      ')
  } else {
    path = `<div class="ns3 first-wait"><div>${firstCallBlock(p)}</div></div>`
  }
  return `<div class="start cv-panel">
      ${said}
      ${firstKey}
      <div class="ask"><h2 class="intro">${CONNECT_Q}</h2><p>${CONNECT_LEDE}</p></div>
      <nav class="vias" aria-label="${CONNECT_Q}">
        ${cards}
      </nav>
      ${path}
      <p class="seedemo"><a href="${href(p, 'overview', { demo: true })}">Show me the console with sample data &rarr;</a></p>
    </div>`
}

/**
 * Whether the overview is still the start screen: until the account has
 * recorded anything, and has no refusal and no leak. Before that the
 * dashboard is tiles of zero and a chart of nothing, and the one useful thing
 * on the page is how to connect. A refusal or a leak counts as having arrived,
 * because each is a row the dashboard shows.
 */
function onboardingDue(p: Page): boolean {
  return !p.demo && !p.d.recorded && p.d.lastBlock === null && p.d.overruns === 0 && !p.filter.task && !p.filter.agent
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function overviewView(p: Page, rangeLabel: string): string {
  const d = p.d
  if (p.view === 'start' ? !p.demo : onboardingDue(p)) return startScreen(p)
  const latest = d.decisions.slice(0, 5)
  const topCustomers = d.customers.slice(0, 5)
  return `${figures(p, rangeLabel)}

    <h2>Activity <a href="${href(p, 'activity')}">Day by day &rarr;</a></h2>
    ${chartBlock(p, d.series, rangeLabel)}

    <h2>Recent tasks <a href="${href(p, 'tasks')}">All ${d.taskCount ? num(d.taskCount) + ' ' : ''}&rarr;</a></h2>
    ${tasksBlock(p, d.tasks.slice(0, 4), jobSide(p))}

    <h2>Latest refusals <a href="${href(p, 'refusals')}">All ${d.decisionTotal ? num(d.decisionTotal) + ' ' : ''}&rarr;</a></h2>
    ${latest.length
      ? frame(p, barOf('refusals'), refusalRows(p, latest))
      : '<div class="cv-empty"><p class="nothing">Nothing refused yet.</p></div>'}

    <h2>Customers by spend <a href="${href(p, 'customers')}">All ${d.customerCount ? num(d.customerCount) + ' ' : ''}&rarr;</a></h2>
    ${customersTable(p, topCustomers, d.customerTotal, true)}`
}

function activityView(p: Page, rangeLabel: string): string {
  const u = p.d.usage
  if (p.d.pricedEver && u.totalPriced > 0) {
    const more = u.groupCount > u.groups.length ? `The ${num(u.groups.length)} dearest of ${num(u.groupCount)} event_types. ` : ''
    const left = u.totalEvents - u.totalPriced
    return `${chartBlock(p, p.d.series, rangeLabel)}
    <p class="note">${esc(LIST_PRICE_LABEL)}</p>
    <h2>By event_type <span>the last ${esc(rangeLabel)}, dearest first</span></h2>
    <p class="lede">What the calls recorded in this window cost at list price, and the tokens their providers reported, grouped by the <code>event_type</code> each record carried. <code>wrap()</code> and <code>record()</code> in both SDKs send the <code>agent_id</code> as the <code>event_type</code>, so for those calls this is a split by agent.</p>
    ${usageTable(p, u, rangeLabel)}
    <p class="note">${more}Shares are of the ${usd(u.totalUsd ?? 0)} estimated over ${num(u.totalPriced)} priced ${u.totalPriced === 1 ? 'call' : 'calls'} in the window${left > 0 ? `; ${num(left)} ${left === 1 ? 'record has' : 'records have'} no list price and ${left === 1 ? 'is' : 'are'} left out of it, never counted as $0` : ''}. The same records are on <code>GET /usage?by=event_type</code>, and each job's estimate on <code>GET /tasks/:task_ref</code>.</p>
    <h2>Day by day <span>the last ${esc(rangeLabel)}, newest first</span></h2>
    ${activityTable(p, p.d.series, rangeLabel)}`
  }
  const more = u.groupCount > u.groups.length ? `The ${num(u.groups.length)} heaviest of ${num(u.groupCount)} event_types. ` : ''
  return `${chartBlock(p, p.d.series, rangeLabel)}
    <h2>By event_type <span>the last ${esc(rangeLabel)}, heaviest first</span></h2>
    <p class="lede">The units recorded in this window, in the units your code reported, grouped by the <code>event_type</code> each record carried. <code>record()</code> in both SDKs sends its <code>agent_id</code> as the <code>event_type</code>, so for those calls this is a split by agent; <code>meter()</code> and a direct <code>POST /events</code> carry the event name your code passed.</p>
    ${usageTable(p, u, rangeLabel)}
    ${u.groups.length ? `<p class="note">${more}Shares are of all ${num(u.totalUnits)} units recorded in the window. The same split is on <code>GET /usage?by=event_type</code>.</p>` : ''}
    <h2>Day by day <span>the last ${esc(rangeLabel)}, newest first</span></h2>
    ${activityTable(p, p.d.series, rangeLabel)}`
}

function tasksView(p: Page): string {
  const used = p.sort === 'used'
  const page = p.d.taskCount > p.d.tasks.length
    ? `The ${num(p.d.tasks.length)} ${used ? 'most used' : 'most recently touched'} of ${num(p.d.taskCount)} tasks.`
    : `${num(p.d.taskCount)} ${p.d.taskCount === 1 ? 'task' : 'tasks'}, ${used ? 'most used first' : 'most recently touched first'}.`
  return `${ceilingForm(p)}
    ${tasksBlock(p, p.d.tasks)}
    ${p.d.tasks.length ? TASK_KEY : ''}
    <p class="note">${page} Used is what your code reported: tokens on a job <code>wrap()</code> opened, your own count on a job in units, and a dollar figure is the list-price estimate of the job's priced calls. The time on a row runs from the first to the last preflight on record for that job, approved or refused; it is not the job's own duration, and a record() does not move it. Those records begin ${PREFLIGHT_RECORDS_SINCE}, so a job older than that shows only its preflights since then. The same rows, without that time, are on <code>GET /tasks</code> (<code>?sort=used</code> for this ranking) and <code>GET /tasks/:task_ref</code>.</p>`
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
    <p class="note">${p.d.customerCount > p.d.customers.length ? `The ${num(p.d.customers.length)} heaviest of ${num(p.d.customerCount)} customers.` : `${num(p.d.customerCount)} ${p.d.customerCount === 1 ? 'customer' : 'customers'}, heaviest first.`} Heaviest is the list-price estimate where a customer has priced calls, then units. Units used, limit and left are each customer's lifetime balance in the units and tokens your code reported, and share is of every customer's units on this account, including any not listed. A job whose ceiling is in dollars never moves that balance: its spend is in Est. cost, at public list price over priced calls only, and it is bounded by its own ceiling, not by a customer limit. The full list is on <code>GET /customers</code>.</p>`
}

/** Every way into this account, and a button for each one it does not have. */
function waysIn(p: Page): string {
  if (p.anon || p.demo) return ''
  const providers = p.providers ?? []
  const said = p.link && Object.hasOwn(LINK_TEXT, p.link)
    ? `<p class="${p.link === 'ok' ? 'ok' : 'err cv-err'}">${esc(LINK_TEXT[p.link])}</p>` : ''
  const rows = (['google', 'github'] as const).filter((pr) => providers.includes(pr) || p.v.linked.includes(pr)).map((pr) => {
    const name = pr === 'google' ? 'Google' : 'GitHub'
    return p.v.linked.includes(pr)
      ? `<div class="way"><p><b>${name}</b> is connected. It opens this account.</p>${tag('connected')}</div>`
      : `<div class="way"><p><b>${name}</b> is not connected.</p>${connectButton(pr)}</div>`
  })
  const email = p.v.linked.includes('email')
    ? `<div class="way"><p><b>Email link</b> to ${esc(p.v.userEmail ?? '')}. It opens this account.</p>${tag('connected')}</div>` : ''
  const key = `<div class="way"><p><b>API key</b>: ${p.v.via === 'key' ? 'how this browser signed in.' : 'any active key still opens this console from the sign-in page.'}</p>${tag(p.v.via === 'key' ? 'this session' : 'works')}</div>`
  return `<h2 id="signin">Sign-in <span>the ways into this account</span></h2>
    ${said}
    ${frame(p, barOf('sign-in'), `<div class="ways">${[...rows, email, key].filter(Boolean).join('\n      ')}</div>`)}
    <p class="note">A sign-in is connected only from here, by somebody already signed in. Nothing is ever connected because an email address matches.</p>`
}

function connectButton(pr: Provider): string {
  // Google's rules allow three phrasings on its button, and "Connect" is not
  // one of them, so both buttons say Continue; the row says what it does.
  const name = pr === 'google' ? 'Google' : 'GitHub'
  return `<form method="POST" action="/app/connect/${pr}"><button class="pbtn is-${pr}" type="submit">${pr === 'google' ? GOOGLE_G : GITHUB_MARK}<span>Continue with ${name}</span></button></form>`
}

/**
 * Apps connected over MCP with OAuth: Claude's custom connector, ChatGPT, or
 * any client that went through the consent page. Each is one grant, and
 * Disconnect revokes it and every token it holds at once. An app that uses an
 * API key instead is not listed here: it is a key, above, and revoking the key
 * is how it is disconnected.
 */
function connectedAppsBlock(p: Page): string {
  if (p.anon || p.demo) return ''
  const apps = p.apps ?? []
  const said = p.appMsg === 'disconnected'
    ? '<p class="ok" id="app-flash">Disconnected. That app can no longer call AgentBill on this account; connecting it again asks you again.</p>'
    : p.appMsg === 'gone' ? '<p class="err cv-err" id="app-flash">That connection was already gone.</p>' : ''
  const body = apps.length === 0
    ? `<div class="cv-empty"><p class="nothing">No app is connected. Connect one from <a href="/integrations/mcp">the MCP page</a>.</p></div>`
    : `<div class="cv-body flush cv-scroll"><table class="cv-table cards" id="connected-apps">
    <thead><tr><th>App</th><th>Goes back to</th><th>Can</th><th>Connected</th><th>Last used</th><th></th></tr></thead>
    <tbody>${apps.map((a) => `<tr>
      <td class="wide">${a.clientName ? esc(a.clientName) : '<span class="none">no name</span>'} <span class="none" title="The app chose this name">named by the app</span></td>
      <td class="id">${esc(a.redirectHost)}</td>
      <td>${a.scopes.map((s) => `<span title="${esc(SCOPE_TEXT[s].title)}">${tag(s.replace('agentbill:', ''))}</span>`).join(' ')}</td>
      <td class="when" data-l="connected">${rel(a.createdAt)}</td>
      <td class="when" data-l="last used">${a.lastUsedAt ? rel(a.lastUsedAt) : '<span class="none">not yet</span>'}</td>
      <td><form method="POST" action="/app/oauth/grants/${a.id}/disconnect"><button class="btn-ghost" type="submit">Disconnect</button></form></td>
    </tr>`).join('')}</tbody>
  </table></div>`
  return `<h2 id="apps">Connected apps <span>over MCP, with your approval</span></h2>
    ${said}
    ${frame(p, barOf('apps'), body)}
    <p class="note">Each row is an app you allowed on the consent page. It reaches this account only through the MCP tools, never your API keys, your plan or billing. An app you connected with an API key is that key, above.</p>`
}

/** The outcome of Revoke all, on the keys view. Codes only, never echoed. */
function keysMsg(p: Page): string {
  if (p.keysMsg === 'revoked_all') return `<p class="ok" id="keys-flash">Every key on this account is revoked and no longer authenticates. ${p.v.via === 'user' ? '<a href="/app?view=start">Create a new key</a> on the start screen; it is shown once.' : ''}</p>`
  if (p.keysMsg === 'confirm') return '<p class="err cv-err" id="keys-flash">Nothing was revoked: tick the box to confirm first.</p>'
  if (p.keysMsg === 'revoke_refused') return '<p class="err cv-err" id="keys-flash">Nothing was revoked: this account has no email address and no sign-in, so with every key gone nobody could get back in. Connect Google or GitHub above first.</p>'
  return ''
}

/** Revoke all keys: one form, a box to tick, and what happens next said
 *  before the button, not after. Not drawn on the sample console. */
function revokeAllBlock(p: Page): string {
  if (p.anon || p.demo) return ''
  const live = p.d.keys.filter((k) => !k.revokedAt || new Date(k.revokedAt).getTime() > Date.now()).length
  if (live === 0) return ''
  const after = p.v.via === 'key'
    ? 'This console was opened with a key, so it signs out too. To get back in, use <a href="/recover">/recover</a> with the account\'s email address, or a sign-in connected above.'
    : 'You stay signed in, and the start screen makes a new key, shown once.'
  return `<h2 id="revoke-all">Revoke all keys <span>when a key may have leaked and you do not know which</span></h2>
    <div class="cv-card revall">
      <p>Every key on this account stops working on its next request, keys in a rotation grace too, and every console opened with a key is signed out. Nothing that calls AgentBill with one of them gets through until you deploy a new key. ${after}</p>
      <form method="POST" action="/app/keys/revoke-all">
        <label class="revall-ok"><input type="checkbox" name="confirm" value="yes" required /> Revoke all ${live} active key${live === 1 ? '' : 's'}</label>
        <button class="btn-ghost" type="submit">Revoke all keys</button>
      </form>
    </div>`
}

function keysView(p: Page): string {
  return `${waysIn(p)}
    ${keysMsg(p)}
    ${keysTable(p, p.d.keys, p.v.via === 'key' ? p.v.keyId : '')}
    ${connectedAppsBlock(p)}
    <h2>Manage keys <span>from the API, with any active key</span></h2>
    <div class="cv-card cmds">
      ${KEY_COMMANDS.map(([ep, what]) =>
        `<div class="cmd"><b>${ep}</b><span>${what}${ep.endsWith('/revoke') ? ' A revoked key ends this session on its next request.' : ''}</span></div>`).join('\n      ')}
    </div>
    <p class="note">${p.anon ? 'Sample keys: neither authenticates anything.' : p.v.via === 'key' ? 'Oldest first. The key that opened this console is marked.' : 'Oldest first.'} A key is shown once, when it is made; here it is only its first and last characters.</p>
    ${revokeAllBlock(p)}`
}

// ---------------------------------------------------------------------------
// Console page
// ---------------------------------------------------------------------------

function consolePage(p: Page): string {
  const rangeLabel = RANGES[p.range]?.label ?? RANGES[DEFAULT_RANGE].label
  // The overview wears the start screen's title while it IS the start screen;
  // "what ran, what was refused" over three steps and no rows would be a
  // header describing a different page. Under sample data ?view=start is the
  // dashboard, because the start form writes to the real account.
  const asStart = p.view === 'start' ? !p.demo : p.view === 'overview' && onboardingDue(p)
  const meta = asStart ? VIEWS.start : p.view === 'start' ? VIEWS.overview : VIEWS[p.view]

  const banner = p.demo
    ? `<div class="banner cv-callout">
        ${label('Sample data')}
        <p>${p.anon
            ? 'Every number on this page is invented. This is what the console looks like once your agents are calling preflight. <a href="/register">Get an API key</a> and it fills with your own runs.'
            : `Nothing on this page is from your account. It shows what the console looks like once your agents are calling preflight. <a href="${href(p, p.view, { demo: false })}">Back to your real console</a>.`}</p>
      </div>`
    : ''

  // A key session on an account nobody has connected a sign-in to yet: the
  // one nudge, on every view, until it is done.
  const providers = p.providers ?? []
  const nudge = !p.anon && !p.demo && p.v.via === 'key' && p.v.linked.length === 0 && providers.length && p.view !== 'keys'
    ? `<div class="banner cv-callout">
        ${label('Sign-in')}
        <p>You opened this console with your API key. Connect Google or GitHub and it opens without the key from now on. <a href="${href(p, 'keys')}#signin">Connect a sign-in</a>.</p>
      </div>`
    : ''

  const body = p.view === 'overview' || p.view === 'start' ? overviewView(p, rangeLabel)
    : p.view === 'activity' ? activityView(p, rangeLabel)
    : p.view === 'tasks' ? tasksView(p)
    : p.view === 'refusals' ? refusalsView(p)
    : p.view === 'customers' ? customersView(p)
    : p.view === 'keys' ? keysView(p)
    : limitsBlock(p, rangeLabel)
  // The footer says every number here is on the API too. The preflight span
  // under a task row is not: GET /tasks serializes the budget and its two
  // timestamps, and no route returns reservations. So a page that draws a
  // span names it as the exception. taskRow is what draws one.
  const spanShown = body.includes('<span class="bseen">')

  return `${HEAD(meta.title)}
<body>
  <div class="shell">
    ${rail(p)}
    <main class="main">
      <div class="wrap">
        <header class="vh">
          <div><h1>${meta.title}</h1><p class="sub">${meta.lede}</p></div>
          ${RANGED.has(p.view) && !asStart ? periodControl(p) : p.view === 'tasks' ? sortControl(p) : ''}
        </header>
        ${banner}
        ${nudge}
        ${body}
        <div class="foot">
          Every number on this page is on the API too${spanShown ? ', except the preflight span on a task row, which the API does not return' : ''}:
          <code>GET /decisions</code> for refusals, <code>/tasks</code> for budgets and <code>/tasks/:task_ref</code> for a job's list-price estimate, <code>/usage?by=event_type</code> for the split by event_type and its estimate, <code>/customers</code> for balances, <code>/keys</code> for keys, each with <code>Authorization: Bearer &lt;your key&gt;</code>.${p.suggest?.history.length ? ` A suggested ceiling is one job's <code>used_units</code>, or its <code>breakdown.list_price_usd_estimate</code> when every call was priced, as <code>GET /tasks/:task_ref</code> returns it: the p50, p90 or max over one agent's ${num(HISTORY_JOBS)} most recently updated finished jobs, worked out on this page.` : ''}
        </div>
      </div>
    </main>
  </div>
${body.includes('data-copy=') ? COPY_JS : ''}
</body>
</html>`
}
