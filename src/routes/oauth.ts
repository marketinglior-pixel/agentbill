import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { publicRoute } from '../middleware/auth.js'
import { limiterKey } from '../lib/client-ip.js'
import { head } from '../ui/theme.js'
import { siteNav, siteFooter } from '../ui/chrome.js'
import { SIGNIN_PAGE_CSS } from './auth.js'
import { APP_CSP, loadSession, provenSameOrigin, sameOrigin, type Viewer } from './app.js'
import { hmacHex, safeEqual, sessionSecret } from '../lib/session-secret.js'
import {
  protectedResourceMetadata, authorizationServerMetadata, registerClient, registerLimiter, tokenLimiter, authorizeLimiter,
  lookupClient, authenticateClient, matchRedirect, parseScope, resourceOk, mcpResource, issuer, createRequest, loadRequest,
  consumeRequest, issueCode, exchangeCode, refreshGrant, revokeToken, redirectHost, redirectOrigin, isLoopbackRedirect,
  disconnectApp, CHALLENGE_SHAPE, SCOPE_TEXT, scopeList, isCimdId, type PendingRequest, type Client,
} from '../lib/mcp-oauth.js'

// The OAuth 2.1 surface for the remote MCP endpoint, 2026-09-25. The rules are
// in src/lib/mcp-oauth.ts; this file is HTTP and pages.
//
//   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728
//   GET  /.well-known/oauth-authorization-server       RFC 8414
//   POST /oauth/register                               RFC 7591, per network limited
//   GET  /app/oauth/authorize                          validate, then consent or /login
//   POST /app/oauth/authorize                          Allow or Deny, same-origin, CSRF token
//   POST /oauth/token                                  code and refresh grants, per network limited
//   POST /oauth/revoke                                 RFC 7009
//   POST /app/oauth/grants/:id/disconnect              the console's Disconnect
//
// No CORS on any of it. Every client that uses these endpoints is a server or
// a native app, and a browser-based client from another origin gets the
// browser's default answer, which is no.

const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Token-endpoint answers are never cached (RFC 6749 section 5.1). */
const noStoreJson = (reply: FastifyReply) => reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache')

// ---------------------------------------------------------------------------
// The consent form's CSRF token
// ---------------------------------------------------------------------------

// Bound to the waiting request AND to the person's session epoch, so it is
// useless from another browser, after a logout, or for a different request.
// The POST is also refused unless the browser itself says it is same-origin.
const CONSENT_PURPOSE = 'agentbill-oauth-consent-v1'
const consentToken = (requestId: string, v: Viewer): string =>
  hmacHex(sessionSecret(), `${CONSENT_PURPOSE}.${requestId}.${v.userId}.${v.accountId}`)

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

const CONSENT_CSS = `${SIGNIN_PAGE_CSS}
    .consent { display: grid; gap: var(--s5); }
    .consent h2 { color: var(--white); font-size: var(--fs-h3); letter-spacing: -0.01em; overflow-wrap: anywhere; }
    .consent .who { display: grid; gap: 6px; }
    .consent .dest { display: grid; gap: 6px; background: var(--surface); border: 1px solid var(--border);
                     border-radius: var(--r-inner); padding: var(--s4); }
    .consent .dest-host { font-family: var(--mono); font-size: var(--fs-h3); color: var(--text); overflow-wrap: anywhere; }
    .consent .dest-full { font-family: var(--mono); font-size: var(--fs-micro); color: var(--dim); overflow-wrap: anywhere; }
    .consent ul { list-style: none; display: grid; gap: var(--s3); margin: 0; padding: 0; }
    .consent li { display: grid; gap: 2px; font-size: var(--fs-small); color: var(--muted); line-height: 1.55; }
    .consent li b { color: var(--text); font-weight: 500; }
    .consent .acts { display: flex; flex-wrap: wrap; gap: var(--s3); align-items: center; }
    .consent .acts form { margin: 0; }
    .consent .acts-row { display: flex; flex-wrap: wrap; gap: var(--s3); }
    .consent .fine { font-size: var(--fs-micro); color: var(--dim); line-height: 1.6; }
    .consent .fine a { color: var(--text); text-underline-offset: 3px; }
`

function shell(title: string, h1: string, lede: string, inner: string): string {
  return `${head({ title: `${title} · AgentBill`, description: 'Connect an app to AgentBill over MCP.', path: '/login', noindex: true, css: CONSENT_CSS })}
<body>
${siteNav('', { cta: false, sticky: false })}
<main>
<div class="reg wrap">
  <div class="pitch">
    <h1>${h1}</h1>
    <p class="lede">${lede}</p>
  </div>
  <div class="form-card">
${inner}
  </div>
</div>
</main>
${siteFooter()}
</body>
</html>`
}

/** Every page here: no cache, no referrer to anyone, noindex, and form-action only where the answer may go. */
function pageHeaders(reply: FastifyReply, formTo = ''): FastifyReply {
  const csp = formTo ? APP_CSP.replace("form-action 'self'", `form-action 'self' ${formTo}`) : APP_CSP
  return reply.type('text/html').header('Cache-Control', 'no-store').header('Referrer-Policy', 'same-origin')
    .header('X-Robots-Tag', 'noindex').header('Content-Security-Policy', csp)
}

/** A request that cannot be answered at its redirect_uri: said here, and nowhere else. */
function deadEnd(reply: FastifyReply, why: string, status = 400) {
  return pageHeaders(reply).code(status).send(shell('Connection request refused', 'This connection request cannot continue.',
    'Nothing was shared and nothing changed on your account.', `
    <div class="consent">
      <p class="cv-err" role="alert">${esc(why)}</p>
      <p class="fine">Start the connection again from the app you were connecting. If it keeps happening, write to
      <a href="mailto:hello@agentbill.dev">hello@agentbill.dev</a> with the app's name.</p>
    </div>`))
}

function consentPage(v: Viewer, req: PendingRequest, client: Client): string {
  const name = client.clientName ?? 'An app with no name'
  const host = redirectHost(req.redirectUri)
  const scopes = scopeList(req.scope)
  const local = isLoopbackRedirect(req.redirectUri)
  const published = client.kind === 'cimd' ? redirectHost(client.clientId) : ''
  const token = consentToken(req.id, v)
  const hidden = `<input type="hidden" name="request_id" value="${req.id}" /><input type="hidden" name="csrf" value="${token}" />`
  return shell('Connect an app', 'Connect an app to AgentBill?', 'An app is asking to use AgentBill\'s MCP tools on your account.', `
    <div class="consent">
      <div class="who">
        <p class="cv-label">The app says it is</p>
        <h2 id="client-name">${esc(name)}</h2>
        <p class="fine">${published
          ? `The app chose this name. Its identity document is published at <b>${esc(published)}</b>.`
          : 'The app chose this name when it registered itself with AgentBill. Nobody at AgentBill has checked it.'}</p>
      </div>
      <div class="dest">
        <p class="cv-label">When you choose, your browser goes to</p>
        <p class="dest-host" id="redirect-host">${esc(host)}</p>
        <p class="dest-full">${esc(req.redirectUri)}</p>
        ${local ? '<p class="fine" id="loopback-warning">This address is on your own computer. Allow only if you just started this connection from an app on this machine.</p>' : ''}
      </div>
      <div>
        <p class="cv-label">It will be able to</p>
        <ul>
${scopes.map((s) => `          <li><b>${SCOPE_TEXT[s].title}</b>${SCOPE_TEXT[s].can}</li>`).join('\n')}
        </ul>
      </div>
      <div>
        <p class="cv-label">It will not be able to</p>
        <ul>
          <li>See, create or revoke your API keys.</li>
          <li>Change your plan or anything about billing.</li>
          <li>Change the ceiling of a job that already exists.</li>
        </ul>
      </div>
      <p class="fine">Signed in as <b>${esc(v.userEmail ?? '')}</b>. You can disconnect it any time in the console, under API keys.</p>
      <div class="acts-row">
        <form method="POST" action="/app/oauth/authorize">${hidden}<input type="hidden" name="decision" value="approve" />
          <button class="btn btn-lg" type="submit" id="approve">Allow</button></form>
        <form method="POST" action="/app/oauth/authorize">${hidden}<input type="hidden" name="decision" value="deny" />
          <button class="btn-alt" type="submit" id="deny">Deny</button></form>
      </div>
    </div>`)
}

/** An account made with only an API key, before sign-in existed, has no person to consent. */
function legacyPage(requestId: string): string {
  const next = `/app/oauth/authorize?request_id=${requestId}`
  return shell('Connect an app', 'Sign in as a person to connect an app.',
    'This browser is signed in with an API key. Connecting an app needs a person to approve it.', `
    <div class="consent" id="legacy-account">
      <p>Your account was made with an API key, before sign-in existed, so nobody has signed in to it as a person yet.
      Connect Google or GitHub to it in the console, under <a href="/app?view=keys">API keys</a>. Then start the connection
      again from the app.</p>
      <p class="fine">Already connected Google or GitHub? <a href="/login?next=${encodeURIComponent(next)}">Sign in with it</a> and this request continues.</p>
    </div>`)
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const errorRedirect = (redirectUri: string, error: string, description: string, state: string | null): string => {
  const u = new URL(redirectUri)
  u.searchParams.set('error', error)
  u.searchParams.set('error_description', description)
  if (state !== null) u.searchParams.set('state', state)
  u.searchParams.set('iss', issuer())
  return u.toString()
}

export async function oauthRoute(app: FastifyInstance) {
  const prm = async (_: FastifyRequest, reply: FastifyReply) =>
    reply.header('Cache-Control', 'public, max-age=300').send(protectedResourceMetadata())
  app.get('/.well-known/oauth-protected-resource', publicRoute(), prm)
  app.get('/.well-known/oauth-protected-resource/mcp', publicRoute(), prm)
  app.get('/.well-known/oauth-authorization-server', publicRoute(), async (_, reply) =>
    reply.header('Cache-Control', 'public, max-age=300').send(authorizationServerMetadata()))

  app.post('/oauth/register', { ...publicRoute(), bodyLimit: 16 * 1024 }, async (request, reply) => {
    noStoreJson(reply)
    const hit = registerLimiter.hit(limiterKey(request))
    if (!hit.allowed) {
      return reply.code(429).header('Retry-After', String(Math.ceil((hit.resetAt - Date.now()) / 1000)))
        .send({ error: 'rate_limited', error_description: 'Too many client registrations from this network. Try again in an hour.' })
    }
    const r = await registerClient(request.body)
    if (r.status === 201) request.log.info({ kind: 'dcr' }, 'oauth client registered')
    return reply.code(r.status).send(r.body)
  })

  // The authorization endpoint. Validates everything it can before a person
  // is involved, in the order RFC 6749 section 4.1.2.1 sets: a bad client or
  // redirect_uri is said HERE and never redirected to (that is the open
  // redirect), everything after that goes back to the client as an error.
  app.get('/app/oauth/authorize', publicRoute(), async (request, reply) => {
    const q = (request.query ?? {}) as Record<string, unknown>
    let pending: PendingRequest | null
    let client: Client
    if (q.request_id !== undefined) {
      pending = await loadRequest(q.request_id)
      if (!pending) return deadEnd(reply, 'This connection request has expired or was already answered.', 410)
      const c = await lookupClient(pending.clientId, limiterKey(request), request.log)
      if (!c.ok) return deadEnd(reply, `The app is not known here: ${c.reason}.`)
      client = c.client
    } else {
      if (!authorizeLimiter.hit(limiterKey(request)).allowed) return deadEnd(reply, 'Too many connection requests from this network. Wait a minute.', 429)
      const c = await lookupClient(q.client_id, limiterKey(request), request.log)
      if (!c.ok) return deadEnd(reply, `The app is not known here: ${c.reason}.`)
      client = c.client
      const redirectUri = matchRedirect(client.redirectUris, q.redirect_uri)
      if (!redirectUri) return deadEnd(reply, 'The redirect_uri is not one this app registered.')
      const state = typeof q.state === 'string' ? q.state.slice(0, 512) : null
      const fail = (error: string, description: string) => reply.redirect(errorRedirect(redirectUri, error, description, state), 302)
      if (q.response_type !== 'code') return fail('unsupported_response_type', 'response_type must be code.')
      if (typeof q.code_challenge !== 'string' || !q.code_challenge) return fail('invalid_request', 'code_challenge is required: this server requires PKCE with S256.')
      if (q.code_challenge_method !== 'S256') return fail('invalid_request', 'code_challenge_method must be S256. plain is not accepted.')
      if (!CHALLENGE_SHAPE.test(q.code_challenge)) return fail('invalid_request', 'code_challenge must be 43 base64url characters.')
      const scopes = parseScope(q.scope)
      if (!scopes) return fail('invalid_scope', 'scope may name only agentbill:read and agentbill:meter.')
      const allowed = scopeList(client.scope)
      const granted = scopes.filter((s) => allowed.includes(s))
      if (!granted.length) return fail('invalid_scope', 'This app registered for none of the scopes it asked for.')
      if (!resourceOk(q.resource)) return fail('invalid_target', `resource must be ${mcpResource()}.`)
      const id = await createRequest({ clientId: client.clientId, redirectUri, state, codeChallenge: q.code_challenge,
                                       scope: granted.join(' '), resource: mcpResource() })
      pending = await loadRequest(id)
      if (!pending) return deadEnd(reply, 'This connection request could not be saved. Try again.', 503)
    }

    const viewer = await loadSession(request)
    if (!viewer) return reply.header('Cache-Control', 'no-store').redirect(`/login?next=${encodeURIComponent(`/app/oauth/authorize?request_id=${pending.id}`)}`, 303)
    if (viewer.via !== 'user' || !viewer.userId) return pageHeaders(reply).send(legacyPage(pending.id))
    return pageHeaders(reply, redirectOrigin(pending.redirectUri)).send(consentPage(viewer, pending, client))
  })

  // Allow or Deny. Refused unless the browser says the form is ours
  // (Sec-Fetch-Site or a matching Origin; a request with neither is refused
  // too, because nothing cross-site is ever proven same-origin by silence),
  // unless the token matches this request and this person, and unless the
  // request is still waiting. The request is spent by either answer.
  app.post('/app/oauth/authorize', publicRoute(), async (request, reply) => {
    if (!provenSameOrigin(request)) return reply.code(403).send({ error: 'forbidden', message: 'Cross-site requests are refused.' })
    const body = (request.body ?? {}) as Record<string, unknown>
    const viewer = await loadSession(request)
    if (!viewer || viewer.via !== 'user' || !viewer.userId) return reply.code(403).send({ error: 'forbidden', message: 'Sign in first.' })
    const requestId = typeof body.request_id === 'string' ? body.request_id : ''
    const csrf = typeof body.csrf === 'string' ? body.csrf : ''
    if (!requestId || !/^[0-9a-f]{64}$/.test(csrf) || !safeEqual(csrf, consentToken(requestId, viewer))) {
      return reply.code(403).send({ error: 'forbidden', message: 'This form is not valid for this session.' })
    }
    const decision = body.decision === 'approve' ? 'approve' : body.decision === 'deny' ? 'deny' : ''
    if (!decision) return reply.code(400).send({ error: 'bad_request' })
    const req = await consumeRequest(requestId)
    if (!req) return deadEnd(reply, 'This connection request has expired or was already answered.', 410)
    if (decision === 'deny') {
      request.log.info('oauth authorization denied by the person')
      return reply.redirect(errorRedirect(req.redirectUri, 'access_denied', 'The person denied the request.', req.state), 303)
    }
    const c = await lookupClient(req.clientId, limiterKey(request), request.log)
    if (!c.ok) return deadEnd(reply, `The app is not known here: ${c.reason}.`)
    const code = await issueCode(req, viewer.userId, viewer.accountId, c.client.clientName)
    const u = new URL(req.redirectUri)
    u.searchParams.set('code', code)
    if (req.state !== null) u.searchParams.set('state', req.state)
    u.searchParams.set('iss', issuer())
    request.log.info({ cimd: isCimdId(req.clientId) }, 'oauth authorization approved')
    return reply.header('Cache-Control', 'no-store').redirect(u.toString(), 303)
  })

  app.post('/oauth/token', { ...publicRoute(), bodyLimit: 16 * 1024 }, async (request, reply) => {
    noStoreJson(reply)
    const net = limiterKey(request)
    const hit = tokenLimiter.hit(net)
    if (!hit.allowed) {
      return reply.code(429).header('Retry-After', String(Math.ceil((hit.resetAt - Date.now()) / 1000)))
        .send({ error: 'rate_limited', error_description: 'Too many token requests from this network. Wait a minute.' })
    }
    const body = (request.body ?? {}) as Record<string, unknown>
    if (typeof body !== 'object' || Array.isArray(body)) return reply.code(400).send({ error: 'invalid_request' })
    const grantType = body.grant_type
    if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
      return reply.code(400).send({ error: 'unsupported_grant_type', error_description: 'grant_type must be authorization_code or refresh_token.' })
    }
    const c = await authenticateClient(body, request.headers.authorization, net, request.log)
    if (!c.ok) return reply.code(401).send({ error: 'invalid_client', error_description: c.reason })
    const r = grantType === 'authorization_code' ? await exchangeCode(c.client, body, request.log) : await refreshGrant(c.client, body, request.log)
    return reply.code(r.status).send(r.body)
  })

  app.post('/oauth/revoke', { ...publicRoute(), bodyLimit: 16 * 1024 }, async (request, reply) => {
    noStoreJson(reply)
    const net = limiterKey(request)
    if (!tokenLimiter.hit(net).allowed) return reply.code(429).send({ error: 'rate_limited' })
    const body = (request.body ?? {}) as Record<string, unknown>
    const c = await authenticateClient(body, request.headers.authorization, net, request.log)
    if (!c.ok) return reply.code(401).send({ error: 'invalid_client', error_description: c.reason })
    await revokeToken(c.client, body.token)
    return reply.code(200).send({})
  })

  // The console's Disconnect. A plain form, like every console write: the
  // console ships no script.
  app.post('/app/oauth/grants/:id/disconnect', publicRoute(), async (request, reply) => {
    if (!sameOrigin(request)) return reply.code(403).send({ error: 'forbidden' })
    const viewer = await loadSession(request)
    if (!viewer) return reply.redirect('/app?view=keys', 303)
    const id = (request.params as { id: string }).id
    const ok = UUID_RE.test(id) && await disconnectApp(viewer.accountId, id)
    if (ok) request.log.info({ accountId: viewer.accountId }, 'oauth connection disconnected from the console')
    return reply.redirect(`/app?view=keys&app=${ok ? 'disconnected' : 'gone'}`, 303)
  })
}
