// [mcp] The remote MCP endpoint and its OAuth 2.1 server (2026-09-25).
//
// Every gate here stands behind a security or correctness property of
// https://agentbill.dev/mcp, and each was planted red once before it was
// trusted to pass (see the commit that added this file). The last gate runs
// the whole flow with the MCP TypeScript SDK's own client (dynamic client
// registration, authorize with a signed-in test user, token, tools/list,
// tools/call preflight), so the server is proven against a real
// implementation of the spec and not only against this file's reading of it.
//
// Called from verify.mjs with its `ok`, its database handle and its boot
// helpers. Every network is its own fly-client-ip, so the per-network limits
// under test never meet each other or the rest of the harness.
import { readFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

export async function mcpGates(opts) {
  console.log('\n[mcp] the remote MCP endpoint, its OAuth server, and its tools')
  let reached = false
  try {
    await gates(opts)
    reached = true
  } catch (err) {
    opts.ok('[mcp] a gate threw', false, String(err?.stack ?? err).slice(0, 400))
  }
  opts.ok('[mcp] every gate ran to the end', reached)
}

async function gates({ API, sql, ok, bootS, stopS, portS, serverLog, legacyKey, legacyAccount }) {
  const rnd = () => randomBytes(5).toString('hex')
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const SAME = { 'Sec-Fetch-Site': 'same-origin' }
  const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' }
  let net = 10
  const newNet = () => ({ 'fly-client-ip': `198.19.${Math.floor(net / 250)}.${(net++ % 250) + 1}` })
  const cookieVal = (res, name) => (res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? '').split(';')[0]
  const PRM_URL = `${API}/.well-known/oauth-protected-resource/mcp`
  const RESOURCE = `${API}/mcp`
  const seen = { secrets: [] }
  const remember = (...v) => { for (const x of v) if (typeof x === 'string' && x.length >= 20) seen.secrets.push(x) }

  // ---- a signed-in person, through the fake Google the [auth] gates use
  const signIn = async (email) => {
    const s = await fetch(`${API}/auth/google`, { redirect: 'manual' })
    const flow = cookieVal(s, 'agentbill_oauth')
    const u = new URL(s.headers.get('location'))
    u.searchParams.set('fake_user', b64({ sub: `mcp-${rnd()}`, email, email_verified: true }))
    const a = await fetch(u, { redirect: 'manual' })
    const cb = new URL(a.headers.get('location'))
    const r = await fetch(`${API}/auth/google/callback?${new URLSearchParams({ code: cb.searchParams.get('code'), state: cb.searchParams.get('state') })}`,
      { redirect: 'manual', headers: { cookie: flow } })
    const cookie = cookieVal(r, 'agentbill_user')
    const [row] = await sql`SELECT a.id AS account_id, u.id AS user_id FROM users u JOIN accounts a ON a.owner_user_id = u.id WHERE u.email = ${email}`
    return { cookie, accountId: row?.accountId, userId: row?.userId }
  }

  // ---- OAuth helpers, one step each, so a gate can break exactly one step
  const REDIRECT = 'https://client.example/callback'
  const register = (body, headers = newNet()) => fetch(`${API}/oauth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
  const pkce = () => {
    const verifier = randomBytes(32).toString('base64url')
    return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
  }
  const authorizeUrl = (clientId, p, extra = {}) => `${API}/app/oauth/authorize?${new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: p.challenge,
    code_challenge_method: 'S256', state: 'st-' + rnd(), scope: 'agentbill:read agentbill:meter', resource: RESOURCE, ...extra,
  })}`
  const get = (url, cookie, headers = {}) => fetch(url, { redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), ...newNet(), ...headers } })
  const consentOf = (html) => ({
    requestId: (html.match(/name="request_id" value="([A-Za-z0-9_-]{32})"/) ?? [])[1] ?? '',
    csrf: (html.match(/name="csrf" value="([0-9a-f]{64})"/) ?? [])[1] ?? '',
  })
  const decide = (c, decision, cookie, headers = SAME) => fetch(`${API}/app/oauth/authorize`, {
    method: 'POST', redirect: 'manual', headers: { ...FORM, ...headers, ...(cookie ? { cookie } : {}), ...newNet() },
    body: new URLSearchParams({ request_id: c.requestId, csrf: c.csrf, decision }).toString(),
  })
  /** authorize, consent, approve: the code on the redirect, or what went wrong. */
  const codeFor = async (clientId, cookie, p = pkce(), extra = {}) => {
    const page = await get(authorizeUrl(clientId, p, extra), cookie)
    const html = await page.text()
    const c = consentOf(html)
    const r = await decide(c, 'approve', cookie)
    const loc = new URL(r.headers.get('location') ?? 'http://none/')
    return { p, code: loc.searchParams.get('code') ?? '', state: loc.searchParams.get('state'), iss: loc.searchParams.get('iss'),
             location: loc, status: r.status, html, page }
  }
  const token = (body, headers = newNet()) => fetch(`${API}/oauth/token`, {
    method: 'POST', headers: { ...FORM, ...headers }, body: new URLSearchParams(body).toString(),
  }).then(async (r) => ({ status: r.status, headers: r.headers, body: await r.json().catch(() => null) }))
  const tokensFor = async (clientId, cookie, extra = {}) => {
    const c = await codeFor(clientId, cookie, pkce(), extra)
    const t = await token({ grant_type: 'authorization_code', client_id: clientId, code: c.code, redirect_uri: REDIRECT, code_verifier: c.p.verifier, resource: RESOURCE })
    remember(c.code, t.body?.access_token, t.body?.refresh_token)
    return { ...t.body, code: c.code }
  }

  // ---- MCP over HTTP, raw
  const MCPH = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' }
  let rpcId = 1
  const rpc = async (bearer, method, params = {}, headers = {}) => {
    const r = await fetch(`${API}/mcp`, {
      method: 'POST',
      headers: { ...MCPH, ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...newNet(), ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
    })
    const text = await r.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { status: r.status, headers: r.headers, json, text }
  }
  const call = async (bearer, name, args) => {
    const r = await rpc(bearer, 'tools/call', { name, arguments: args })
    return { ...r, out: r.json?.result?.structuredContent ?? null }
  }

  // ================================================================ metadata
  const { OAuthMetadataSchema, OAuthProtectedResourceMetadataSchema } = await import('@modelcontextprotocol/sdk/shared/auth.js')
  const prmRoot = await fetch(`${API}/.well-known/oauth-protected-resource`).then((r) => r.json())
  const prm = await fetch(PRM_URL).then((r) => r.json())
  const asm = await fetch(`${API}/.well-known/oauth-authorization-server`).then((r) => r.json())
  ok('[mcp] protected resource metadata (RFC 9728) at the root and at /mcp: this resource, this issuer, the two scopes, and the SDK\'s schema accepts it',
     OAuthProtectedResourceMetadataSchema.safeParse(prm).success && JSON.stringify(prm) === JSON.stringify(prmRoot)
       && prm.resource === RESOURCE && prm.authorization_servers?.[0] === API && prm.scopes_supported?.join(' ') === 'agentbill:read agentbill:meter',
     JSON.stringify(prm))
  ok('[mcp] authorization server metadata (RFC 8414): the SDK\'s schema accepts it, the issuer is this origin, and S256 is the only PKCE method',
     OAuthMetadataSchema.safeParse(asm).success && asm.issuer === API && JSON.stringify(asm.code_challenge_methods_supported) === '["S256"]'
       && asm.authorization_endpoint === `${API}/app/oauth/authorize` && asm.registration_endpoint === `${API}/oauth/register`
       && asm.client_id_metadata_document_supported === true && asm.authorization_response_iss_parameter_supported === true,
     JSON.stringify(asm).slice(0, 200))

  // ================================================================ access to /mcp
  const none = await rpc('', 'tools/list')
  const wa = none.headers.get('www-authenticate') ?? ''
  ok('[mcp] no credentials: 401, and WWW-Authenticate names the resource metadata and the scopes (RFC 9728 section 5.1)',
     none.status === 401 && wa.startsWith('Bearer ') && wa.includes(`resource_metadata="${PRM_URL}"`) && wa.includes('scope="agentbill:read agentbill:meter"'),
     `${none.status} ${wa}`)
  const unknownKey = 'agb_' + createHash('sha256').update('mcp-unknown-' + rnd()).digest('hex').slice(0, 48)
  const bad = await rpc(unknownKey, 'tools/list')
  const junk = await rpc('not-a-token-at-all', 'tools/list')
  const fakeAt = await rpc('agbo_' + 'ab'.repeat(32), 'tools/list')
  ok('[mcp] a key that matches nothing, a string that is no token, and a token-shaped string we never issued are each 401 with the challenge',
     [bad, junk, fakeAt].every((r) => r.status === 401 && (r.headers.get('www-authenticate') ?? '').includes('resource_metadata='))
       && (bad.headers.get('www-authenticate') ?? '').includes('error="invalid_token"'),
     [bad, junk, fakeAt].map((r) => r.status).join(','))
  const revokedKey = 'agb_' + createHash('sha256').update('mcp-revoked-' + rnd()).digest('hex').slice(0, 48)
  await sql`INSERT INTO developer_api_keys (account_id, api_key, label, revoked_at) VALUES (${legacyAccount}, ${revokedKey}, 'mcp-revoked', now() - INTERVAL '1 minute')`
  const rk = await rpc(revokedKey, 'tools/list')
  ok('[mcp] a revoked API key is refused: 401 key_revoked, through the same function the REST API uses',
     rk.status === 401 && rk.json?.error === 'key_revoked', `${rk.status} ${rk.text.slice(0, 80)}`)
  const init = await rpc(legacyKey, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gate', version: '1' } })
  const list = await rpc(legacyKey, 'tools/list')
  const names = (list.json?.result?.tools ?? []).map((t) => t.name).sort().join(',')
  ok('[mcp] an API key: initialize answers as the agentbill server, and tools/list has the five tools',
     init.status === 200 && init.json?.result?.serverInfo?.name === 'agentbill' && names === 'preflight,recent_refusals,record_event,task_status,top_jobs',
     `${init.status} ${names}`)
  const ann = Object.fromEntries((list.json?.result?.tools ?? []).map((t) => [t.name, t.annotations ?? {}]))
  ok('[mcp] the annotations are honest: the three read tools say readOnlyHint, preflight and record_event do not, and none claims destructive or open-world',
     ['task_status', 'top_jobs', 'recent_refusals'].every((n) => ann[n]?.readOnlyHint === true)
       && ['preflight', 'record_event'].every((n) => ann[n]?.readOnlyHint === false && ann[n]?.destructiveHint === false)
       && Object.values(ann).every((a) => a.openWorldHint === false), JSON.stringify(ann))
  const toolNames = (list.json?.result?.tools ?? []).map((t) => `${t.name} ${t.description}`).join(' ')
  ok('[mcp] no tool reaches keys, plans or billing: none is named for them, and no description offers them',
     !/\b(key|keys|plan|billing|checkout|upgrade|ceiling_set|revoke)\b/i.test((list.json?.result?.tools ?? []).map((t) => t.name).join(' '))
       && !/(create|show|reveal|list|revoke)s? (an |your )?api key/i.test(toolNames), toolNames.slice(0, 120))

  // Origin and Host (DNS rebinding), and no CORS
  const hostile = await rpc(legacyKey, 'tools/list', {}, { Origin: 'https://evil.example' })
  const ownOrigin = await rpc(legacyKey, 'tools/list', {}, { Origin: API })
  const hostRes = await new Promise((resolve) => {
    import('node:http').then(({ request }) => {
      const u = new URL(API)
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      const q = request({ host: u.hostname, port: u.port, path: '/mcp', method: 'POST',
        headers: { ...MCPH, Host: 'evil.example', Authorization: `Bearer ${legacyKey}`, 'Content-Length': Buffer.byteLength(body), ...newNet() } }, (res) => {
        res.resume(); resolve(res.statusCode)
      })
      q.on('error', () => resolve(0))
      q.end(body)
    })
  })
  ok('[mcp] a hostile Origin is 403 before authentication, our own Origin is served, and a foreign Host header is 403',
     hostile.status === 403 && ownOrigin.status === 200 && hostRes === 403, `${hostile.status} ${ownOrigin.status} ${hostRes}`)
  const pre = await fetch(`${API}/mcp`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } })
  ok('[mcp] no CORS anywhere: neither an answer nor a preflight carries Access-Control-Allow-Origin',
     [none, bad, init, list, hostile, ownOrigin].every((r) => !r.headers.get('access-control-allow-origin')) && !pre.headers.get('access-control-allow-origin'),
     `${pre.status}`)
  const getKey = await fetch(`${API}/mcp`, { headers: { Authorization: `Bearer ${legacyKey}`, Accept: 'text/event-stream', ...newNet() } })
  const delKey = await fetch(`${API}/mcp`, { method: 'DELETE', headers: { Authorization: `Bearer ${legacyKey}`, ...newNet() } })
  const getNone = await fetch(`${API}/mcp`, { headers: { Accept: 'text/event-stream', ...newNet() } })
  const getBrowser = await fetch(`${API}/mcp`, { redirect: 'manual', headers: { Accept: 'text/html,application/xhtml+xml', ...newNet() } })
  ok('[mcp] stateless: GET and DELETE are 405 Allow: POST once authenticated, 401 before; a browser GET is sent to the connect page',
     getKey.status === 405 && getKey.headers.get('allow') === 'POST' && delKey.status === 405 && getNone.status === 401
       && getBrowser.status === 303 && getBrowser.headers.get('location') === '/integrations/mcp',
     `${getKey.status} ${delKey.status} ${getNone.status} ${getBrowser.status}`)
  ok('[mcp] and no session id is ever minted', !init.headers.get('mcp-session-id') && !list.headers.get('mcp-session-id'))

  // ================================================================ registration (RFC 7591)
  const personA = await signIn(`mcp-a-${rnd()}@example.com`)
  const personB = await signIn(`mcp-b-${rnd()}@example.com`)
  ok('[mcp] setup: two people signed in, each with their own account', !!personA.cookie && !!personB.cookie && personA.accountId !== personB.accountId)

  const pub = await register({ client_name: 'Gate client', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] })
  const conf = await register({ client_name: 'Gate confidential', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'] })
  remember(conf.body?.client_secret)
  const [confRow] = await sql`SELECT client_secret_hash FROM oauth_clients WHERE client_id = ${conf.body?.client_id ?? ''}`
  ok('[mcp] DCR: a public client gets an agbcl_ id and no secret; a confidential one gets a secret shown once, stored only as its SHA-256',
     pub.status === 201 && /^agbcl_[0-9a-f]{32}$/.test(pub.body?.client_id ?? '') && !('client_secret' in (pub.body ?? {}))
       && conf.status === 201 && /^agbcs_[0-9a-f]{64}$/.test(conf.body?.client_secret ?? '') && conf.body.token_endpoint_auth_method === 'client_secret_basic'
       && confRow?.clientSecretHash === createHash('sha256').update(conf.body.client_secret).digest('hex')
       && (await sql`SELECT count(*)::int AS n FROM oauth_clients WHERE client_secret_hash = ${conf.body.client_secret}`)[0].n === 0,
     `${pub.status} ${conf.status}`)
  const badRedirects = await Promise.all([
    'http://evil.example/cb', 'cursor://anysphere.cursor-mcp/oauth/callback', 'https://client.example/cb#frag', 'https://user:pw@client.example/cb', 'javascript:alert(1)',
  ].map((u) => register({ redirect_uris: [u], token_endpoint_auth_method: 'none' })))
  const loopback = await register({ redirect_uris: ['http://127.0.0.1:33418/callback', 'http://localhost:8787/callback'], token_endpoint_auth_method: 'none' })
  ok('[mcp] DCR refuses a redirect URI that is plain http off loopback, a custom scheme, a fragment, userinfo or javascript:, and accepts loopback http',
     badRedirects.every((r) => r.status === 400 && r.body?.error === 'invalid_redirect_uri') && loopback.status === 201,
     badRedirects.map((r) => r.status).join(',') + ` loopback ${loopback.status}`)
  const pubId = pub.body.client_id

  // ================================================================ the authorization endpoint
  const anon = await get(authorizeUrl(pubId, pkce()), '')
  const anonLoc = anon.headers.get('location') ?? ''
  const nextParam = new URL(anonLoc, API).searchParams.get('next') ?? ''
  const loginPage = anonLoc ? await fetch(new URL(anonLoc, API)).then((r) => r.text()) : ''
  ok('[mcp] authorize with no session goes to /login, carrying a next that is this same request by its id, and the sign-in page keeps it',
     anon.status === 303 && anonLoc.startsWith('/login?next=') && /^\/app\/oauth\/authorize\?request_id=[A-Za-z0-9_-]{32}$/.test(nextParam)
       && loginPage.includes(`/auth/google?next=${encodeURIComponent(nextParam)}`) && loginPage.includes(`name="next" value="${nextParam}"`),
     `${anon.status} ${anonLoc}`)
  const afterLogin = await get(new URL(nextParam, API).toString(), personA.cookie)
  const afterHtml = await afterLogin.text()
  ok('[mcp] and after signing in, that id opens the consent page for the same request',
     afterLogin.status === 200 && afterHtml.includes('id="approve"') && afterHtml.includes('client.example'))
  const legacySession = cookieVal(await fetch(`${API}/app/session`, { method: 'POST', redirect: 'manual', headers: { ...FORM, ...SAME, ...newNet() }, body: `api_key=${legacyKey}` }), 'agentbill_app')
  const legacyAuth = await get(authorizeUrl(pubId, pkce()), legacySession)
  const legacyHtml = await legacyAuth.text()
  ok('[mcp] a browser signed in with only an API key is told to connect Google or GitHub in the console, with the link, and gets no Allow button',
     legacyAuth.status === 200 && legacyHtml.includes('id="legacy-account"') && legacyHtml.includes('href="/app?view=keys"') && !legacyHtml.includes('id="approve"'))

  const mismatch = await get(authorizeUrl(pubId, pkce(), { redirect_uri: 'https://evil.example/callback' }), personA.cookie)
  const unknownClient = await get(authorizeUrl('agbcl_' + '0'.repeat(32), pkce(), { redirect_uri: 'https://evil.example/callback' }), personA.cookie)
  const pathSwap = await get(authorizeUrl(pubId, pkce(), { redirect_uri: 'https://client.example/callback/../evil' }), personA.cookie)
  ok('[mcp] a redirect_uri that is not the registered one, or a client_id nobody registered, is answered on our own page: 400 and no Location (no open redirect)',
     [mismatch, unknownClient, pathSwap].every((r) => r.status === 400 && !r.headers.get('location')), [mismatch, unknownClient, pathSwap].map((r) => r.status).join(','))
  const errOf = (r) => { const l = r.headers.get('location'); const u = l ? new URL(l) : null; return u ? { at: `${u.origin}${u.pathname}`, error: u.searchParams.get('error'), iss: u.searchParams.get('iss'), state: u.searchParams.get('state') } : {} }
  const noPkce = errOf(await get(authorizeUrl(pubId, pkce(), { code_challenge: '' }), personA.cookie))
  const plain = errOf(await get(authorizeUrl(pubId, pkce(), { code_challenge_method: 'plain' }), personA.cookie))
  const u3 = new URL(authorizeUrl(pubId, pkce())); u3.searchParams.delete('code_challenge_method')
  const noMethod = errOf(await get(u3.toString(), personA.cookie))
  ok('[mcp] PKCE is required and S256 only: no challenge, method plain, and no method at all each go back as invalid_request, with iss',
     [noPkce, plain, noMethod].every((e) => e.at === REDIRECT && e.error === 'invalid_request' && e.iss === API),
     JSON.stringify([noPkce, plain, noMethod]))
  const otherAud = errOf(await get(authorizeUrl(pubId, pkce(), { resource: 'https://other.example/mcp' }), personA.cookie))
  const badScope = errOf(await get(authorizeUrl(pubId, pkce(), { scope: 'agentbill:admin' }), personA.cookie))
  ok('[mcp] a resource that is not this server is invalid_target, and a scope that is not ours is invalid_scope',
     otherAud.error === 'invalid_target' && badScope.error === 'invalid_scope', JSON.stringify([otherAud, badScope]))

  // The consent page
  const evilName = await register({ client_name: '<script>alert(1)</script>Evil "app"', redirect_uris: ['http://127.0.0.1:43111/cb'], token_endpoint_auth_method: 'none' })
  const evilPage = await get(`${API}/app/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: evilName.body.client_id, redirect_uri: 'http://127.0.0.1:43111/cb',
    code_challenge: pkce().challenge, code_challenge_method: 'S256', state: 'x' })}`, personA.cookie)
  const evilHtml = await evilPage.text()
  const csp = evilPage.headers.get('content-security-policy') ?? ''
  ok('[mcp] the consent page shows the client name as text, the redirect host on its own line, the loopback warning, and form-action allows only us and that origin',
     evilHtml.includes('&lt;script&gt;alert(1)&lt;/script&gt;Evil &quot;app&quot;') && !evilHtml.includes('<script>alert(1)')
       && /id="redirect-host">127\.0\.0\.1:43111</.test(evilHtml) && evilHtml.includes('id="loopback-warning"')
       && csp.includes("form-action 'self' http://127.0.0.1:43111;") && csp.includes("frame-ancestors 'none'") && !/<script(?![^>]*ld\+json)/.test(evilHtml),
     csp)
  ok('[mcp] it names what the app can and cannot do, and the page is never cached',
     afterHtml.includes('Ask preflight and record usage') && afterHtml.includes('Read your jobs and refusals') && afterHtml.includes('See, create or revoke your API keys')
       && afterLogin.headers.get('cache-control') === 'no-store')

  // Cross-site consent, a wrong token, and a token from another person
  const pendingPage = await get(authorizeUrl(pubId, pkce()), personA.cookie)
  const pc = consentOf(await pendingPage.text())
  const cross = await decide(pc, 'approve', personA.cookie, { 'Sec-Fetch-Site': 'cross-site' })
  const silent = await decide(pc, 'approve', personA.cookie, {})
  const evilOrigin = await decide(pc, 'approve', personA.cookie, { Origin: 'https://evil.example' })
  const wrongCsrf = await decide({ ...pc, csrf: 'f'.repeat(64) }, 'approve', personA.cookie)
  const otherPerson = await decide(pc, 'approve', personB.cookie)
  const [stillPending] = await sql`SELECT consumed_at FROM oauth_requests WHERE id = ${pc.requestId}`
  ok('[mcp] the consent POST refuses cross-site, a request that says nothing about its origin, a foreign Origin, a wrong CSRF token and another person\'s session',
     [cross, silent, evilOrigin, wrongCsrf, otherPerson].every((r) => r.status === 403) && stillPending && stillPending.consumedAt === null,
     [cross, silent, evilOrigin, wrongCsrf, otherPerson].map((r) => r.status).join(','))
  const denied = await decide(pc, 'deny', personA.cookie)
  const deniedTo = errOf(denied)
  const again = await decide(pc, 'approve', personA.cookie)
  ok('[mcp] Deny goes back as access_denied with the state and iss, and spends the request: answering it again is 410',
     denied.status === 303 && deniedTo.at === REDIRECT && deniedTo.error === 'access_denied' && !!deniedTo.state && deniedTo.iss === API && again.status === 410,
     `${denied.status} ${JSON.stringify(deniedTo)} ${again.status}`)

  // ================================================================ the token endpoint
  const c1 = await codeFor(pubId, personA.cookie)
  remember(c1.code)
  ok('[mcp] Allow: 303 to the registered redirect_uri with a code, the state and iss', c1.status === 303 && `${c1.location.origin}${c1.location.pathname}` === REDIRECT
     && /^agbc_[0-9a-f]{64}$/.test(c1.code) && !!c1.state && c1.iss === API, `${c1.status} ${c1.location}`)
  const wrongVerifier = await token({ grant_type: 'authorization_code', client_id: pubId, code: c1.code, redirect_uri: REDIRECT, code_verifier: pkce().verifier })
  const rightAfter = await token({ grant_type: 'authorization_code', client_id: pubId, code: c1.code, redirect_uri: REDIRECT, code_verifier: c1.p.verifier })
  ok('[mcp] a code_verifier that does not match is invalid_grant, and it burns the code: the right verifier afterwards is refused too',
     wrongVerifier.status === 400 && wrongVerifier.body?.error === 'invalid_grant' && rightAfter.status === 400 && rightAfter.body?.error === 'invalid_grant',
     `${wrongVerifier.status} ${rightAfter.status}`)
  const c2 = await codeFor(pubId, personA.cookie)
  remember(c2.code)
  const noVerifier = await token({ grant_type: 'authorization_code', client_id: pubId, code: c2.code, redirect_uri: REDIRECT })
  const c3 = await codeFor(pubId, personA.cookie)
  remember(c3.code)
  const wrongRedirect = await token({ grant_type: 'authorization_code', client_id: pubId, code: c3.code, redirect_uri: 'https://client.example/other', code_verifier: c3.p.verifier })
  const c4 = await codeFor(pubId, personA.cookie)
  remember(c4.code)
  const wrongClient = await token({ grant_type: 'authorization_code', client_id: loopback.body.client_id, code: c4.code, redirect_uri: REDIRECT, code_verifier: c4.p.verifier })
  ok('[mcp] no code_verifier, a redirect_uri other than the authorization request\'s, and another client\'s id are each refused',
     noVerifier.status === 400 && wrongRedirect.body?.error === 'invalid_grant' && wrongClient.body?.error === 'invalid_grant',
     `${noVerifier.status}/${noVerifier.body?.error} ${wrongRedirect.body?.error} ${wrongClient.body?.error}`)

  const c5 = await codeFor(pubId, personA.cookie)
  remember(c5.code)
  const t5 = await token({ grant_type: 'authorization_code', client_id: pubId, code: c5.code, redirect_uri: REDIRECT, code_verifier: c5.p.verifier, resource: RESOURCE })
  remember(t5.body?.access_token, t5.body?.refresh_token)
  const hashes = await sql`SELECT token_hash FROM oauth_tokens WHERE token_hash IN (${t5.body?.access_token ?? ''}, ${t5.body?.refresh_token ?? ''})`
  const hashed = await sql`SELECT count(*)::int AS n FROM oauth_tokens WHERE token_hash IN (${createHash('sha256').update(t5.body?.access_token ?? '').digest('hex')}, ${createHash('sha256').update(t5.body?.refresh_token ?? '').digest('hex')})`
  ok('[mcp] the exchange: Bearer, an hour, an agbo_ access token and an agbr_ refresh token, no-store, and only their hashes in the database',
     t5.status === 200 && t5.body.token_type === 'Bearer' && t5.body.expires_in === 3600 && /^agbo_[0-9a-f]{64}$/.test(t5.body.access_token)
       && /^agbr_[0-9a-f]{64}$/.test(t5.body.refresh_token) && t5.headers.get('cache-control') === 'no-store'
       && hashes.length === 0 && hashed[0].n === 2 && (await sql`SELECT count(*)::int AS n FROM oauth_codes WHERE code_hash = ${c5.code}`)[0].n === 0,
     `${t5.status} ${JSON.stringify(t5.body).slice(0, 80)}`)
  const at5 = t5.body.access_token
  const works5 = await rpc(at5, 'tools/list')
  const reuse = await token({ grant_type: 'authorization_code', client_id: pubId, code: c5.code, redirect_uri: REDIRECT, code_verifier: c5.p.verifier })
  const after5 = await rpc(at5, 'tools/list')
  ok('[mcp] the code is single use: a second exchange is invalid_grant and revokes what the first one issued',
     works5.status === 200 && reuse.status === 400 && reuse.body?.error === 'invalid_grant' && after5.status === 401,
     `${works5.status} ${reuse.status} ${after5.status}`)

  // Refresh rotation and reuse detection
  const t6 = await tokensFor(pubId, personA.cookie)
  const r1 = await token({ grant_type: 'refresh_token', client_id: pubId, refresh_token: t6.refresh_token })
  remember(r1.body?.access_token, r1.body?.refresh_token)
  const oldAccess = await rpc(t6.access_token, 'tools/list')
  const newAccess = await rpc(r1.body?.access_token, 'tools/list')
  ok('[mcp] refresh rotates: a new access and a new refresh token, the new pair works, and the access token minted beside the spent refresh token is dead',
     r1.status === 200 && r1.body.refresh_token !== t6.refresh_token && r1.body.access_token !== t6.access_token && newAccess.status === 200 && oldAccess.status === 401,
     `${r1.status} new=${newAccess.status} old=${oldAccess.status}`)
  const replay = await token({ grant_type: 'refresh_token', client_id: pubId, refresh_token: t6.refresh_token })
  const chainAccess = await rpc(r1.body?.access_token, 'tools/list')
  const chainRefresh = await token({ grant_type: 'refresh_token', client_id: pubId, refresh_token: r1.body?.refresh_token })
  const [g6] = await sql`SELECT g.revoked_reason FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id WHERE t.token_hash = ${createHash('sha256').update(t6.refresh_token).digest('hex')}`
  ok('[mcp] a spent refresh token presented again revokes the whole chain: invalid_grant, and the newest access and refresh tokens are dead too',
     replay.status === 400 && replay.body?.error === 'invalid_grant' && chainAccess.status === 401 && chainRefresh.status === 400 && g6?.revokedReason === 'refresh_reuse',
     `${replay.status} ${chainAccess.status} ${chainRefresh.status} ${g6?.revokedReason}`)
  const t6b = await tokensFor(pubId, personA.cookie)
  const widen = await token({ grant_type: 'refresh_token', client_id: pubId, refresh_token: t6b.refresh_token, scope: 'agentbill:read agentbill:meter agentbill:admin' })
  ok('[mcp] a refresh may not ask for a scope that is not ours', widen.status === 400 && widen.body?.error === 'invalid_scope', `${widen.status} ${widen.body?.error}`)

  // Confidential client: its secret, in Basic or in the body
  const cc = await codeFor(conf.body.client_id, personA.cookie)
  remember(cc.code)
  const noSecret = await token({ grant_type: 'authorization_code', client_id: conf.body.client_id, code: cc.code, redirect_uri: REDIRECT, code_verifier: cc.p.verifier })
  const basic = Buffer.from(`${encodeURIComponent(conf.body.client_id)}:${encodeURIComponent(conf.body.client_secret)}`).toString('base64')
  const withSecret = await token({ grant_type: 'authorization_code', code: cc.code, redirect_uri: REDIRECT, code_verifier: cc.p.verifier }, { ...newNet(), Authorization: `Basic ${basic}` })
  remember(withSecret.body?.access_token, withSecret.body?.refresh_token)
  ok('[mcp] a confidential client without its secret is invalid_client (401), and with it in a Basic header it is served',
     noSecret.status === 401 && noSecret.body?.error === 'invalid_client' && withSecret.status === 200, `${noSecret.status} ${withSecret.status}`)

  // Revocation (RFC 7009), expiry, audience
  const t7 = await tokensFor(pubId, personA.cookie)
  const rv = await fetch(`${API}/oauth/revoke`, { method: 'POST', headers: { ...FORM, ...newNet() }, body: new URLSearchParams({ client_id: pubId, token: t7.access_token }).toString() })
  const afterRv = await rpc(t7.access_token, 'tools/list')
  ok('[mcp] a revoked OAuth access token is refused: 200 from /oauth/revoke, then 401 on /mcp', rv.status === 200 && afterRv.status === 401
     && (afterRv.headers.get('www-authenticate') ?? '').includes('error="invalid_token"'), `${rv.status} ${afterRv.status}`)
  const t8 = await tokensFor(pubId, personA.cookie)
  await sql`UPDATE oauth_tokens SET expires_at = created_at WHERE token_hash = ${createHash('sha256').update(t8.access_token).digest('hex')}`
  const expired = await rpc(t8.access_token, 'tools/list')
  ok('[mcp] an expired OAuth access token is refused: 401 invalid_token', expired.status === 401 && /expired/.test(expired.json?.message ?? ''), `${expired.status} ${expired.text.slice(0, 80)}`)
  const t9 = await tokensFor(pubId, personA.cookie)
  await sql`UPDATE oauth_grants SET resource = 'https://other.example/mcp' WHERE id = (SELECT grant_id FROM oauth_tokens WHERE token_hash = ${createHash('sha256').update(t9.access_token).digest('hex')})`
  const aud = await rpc(t9.access_token, 'tools/list')
  ok('[mcp] a token issued for another audience is refused: 401, "issued for another resource"', aud.status === 401 && /another resource/.test(aud.json?.message ?? ''), `${aud.status} ${aud.text.slice(0, 80)}`)

  // Scopes: a read-only token
  const readOnly = await tokensFor(pubId, personA.cookie, { scope: 'agentbill:read' })
  const roList = await rpc(readOnly.access_token, 'tools/list')
  const roCall = await call(readOnly.access_token, 'preflight', { agent_id: 'gate', task_ref: `ro-${rnd()}`, task_ceiling: 10 })
  const roWa = roCall.headers.get('www-authenticate') ?? ''
  ok('[mcp] a token with agentbill:read alone lists the three read tools, and preflight is 403 insufficient_scope naming agentbill:meter',
     (roList.json?.result?.tools ?? []).map((t) => t.name).sort().join(',') === 'recent_refusals,task_status,top_jobs'
       && roCall.status === 403 && roWa.includes('error="insufficient_scope"') && roWa.includes('agentbill:meter') && roWa.includes('resource_metadata='),
     `${roCall.status} ${roWa}`)

  // ================================================================ tools, parity with REST, isolation
  const tA = await tokensFor(pubId, personA.cookie)
  const tB = await tokensFor(pubId, personB.cookie)
  const job = `mcp-job-${rnd()}`
  const open = await call(tA.access_token, 'preflight', { agent_id: 'gate', task_ref: job, task_ceiling: 10, estimated_units: 8 })
  const restKey = 'agb_' + createHash('sha256').update('mcp-rest-' + rnd()).digest('hex').slice(0, 48)
  await sql`INSERT INTO developer_api_keys (account_id, api_key, label) VALUES (${personA.accountId}, ${restKey}, 'mcp-parity')`
  const rest = await fetch(`${API}/preflight`, { method: 'POST', headers: { Authorization: `Bearer ${restKey}`, 'Content-Type': 'application/json', ...newNet() },
    body: JSON.stringify({ agent_id: 'gate', task_ref: job, estimated_units: 5 }) }).then((r) => r.json())
  const [heldBefore] = await sql`SELECT reserved_units, used_units FROM task_budgets WHERE account_id = ${personA.accountId} AND task_ref = ${job}`
  const viaMcp = await call(tA.access_token, 'preflight', { agent_id: 'gate', task_ref: job, estimated_units: 5 })
  const [heldAfter] = await sql`SELECT reserved_units, used_units FROM task_budgets WHERE account_id = ${personA.accountId} AND task_ref = ${job}`
  const o = viaMcp.out ?? {}
  ok('[mcp] preflight refuses at the ceiling through MCP exactly as REST does: the same reason and the same job numbers, as a result and not an error',
     open.out?.approved === true && rest.approved === false && rest.reason === 'task_ceiling_exceeded' && o.approved === false && o.reason === rest.reason
       && o.task_ceiling === rest.task_ceiling && o.task_used_units === rest.task_used_units && o.task_remaining_units === rest.task_remaining_units
       && viaMcp.json?.result?.isError !== true,
     JSON.stringify({ rest, o }).slice(0, 300))
  ok('[mcp] and its sentence is the Python server\'s, word for word, and the refusal reserved nothing',
     o.message === `Refused (task_ceiling_exceeded): task '${job}' is at 0/10 units and 2 remaining is not enough for this call.`
       && Number(heldAfter?.reservedUnits) === Number(heldBefore?.reservedUnits), `${o.message} ${heldBefore?.reservedUnits}->${heldAfter?.reservedUnits}`)
  const rec = await call(tA.access_token, 'record_event', { agent_id: 'gate', task_ref: job, units: 6, reservation_id: open.out?.reservation_id,
    idempotency_key: `mcp-rec-${rnd()}`, metadata: { provider: 'openai', model: 'gpt-4o-mini', tokens: { input: 1000, output: 100 } } })
  const [settled] = await sql`SELECT reserved_units, used_units FROM task_budgets WHERE account_id = ${personA.accountId} AND task_ref = ${job}`
  const [resv] = await sql`SELECT released_at FROM reservations WHERE public_id = ${open.out?.reservation_id ?? '00000000-0000-0000-0000-000000000000'}`
  ok('[mcp] record_event meters: the job\'s used_units rise by what was recorded, and the named reservation is settled whole',
     rec.out?.recorded === true && rec.out?.status === 'recorded' && rec.out?.reservation_status === 'settled' && Number(settled?.usedUnits) === 6
       && Number(settled?.reservedUnits) === 0 && !!resv?.releasedAt, JSON.stringify(rec.out).slice(0, 200))
  const stA = await call(tA.access_token, 'task_status', { task_ref: job })
  const stB = await call(tB.access_token, 'task_status', { task_ref: job })
  const topB = await call(tB.access_token, 'top_jobs', { limit: 50 })
  const refB = await call(tB.access_token, 'recent_refusals', { task_ref: job })
  const topA = await call(tA.access_token, 'top_jobs', { sort: 'list_price', limit: 50 })
  ok('[mcp] account isolation: A reads its job, and B\'s token finds nothing of it through any tool',
     stA.out?.found === true && stA.out?.used_units === 6 && stB.out?.found === false
       && !(topB.out?.jobs ?? []).some((j) => j.task_ref === job) && (refB.out?.decisions ?? []).length === 0 && refB.out?.blocked_total === 0,
     JSON.stringify({ a: stA.out?.found, b: stB.out, top: topB.out?.jobs?.length, ref: refB.out?.decisions?.length }))
  ok('[mcp] the jobs ranking labels dollars as a list-price estimate, and shows null, never 0, for a job with no priced call',
     typeof topA.out?.list_price_label === 'string' && /estimate at public list price/.test(topA.out.list_price_label)
       && (topA.out.jobs ?? []).find((j) => j.task_ref === job)?.list_price_usd_estimate > 0
       && (topA.out.jobs ?? []).filter((j) => j.priced_calls === 0).every((j) => j.list_price_usd_estimate === null),
     JSON.stringify(topA.out?.jobs?.[0] ?? {}).slice(0, 200))
  const refA = await call(tA.access_token, 'recent_refusals', { task_ref: job })
  const outputs = [list.text, stA.text, topA.text, refA.text, open.text, viaMcp.text, rec.text].join('\n')
  const KEY_RE = /agb_[0-9a-f]{48}/
  const OAUTH_RE = /agb(?:o|r|c|cs)_[0-9a-f]{64}/
  ok('[mcp] no tool output carries key material: no API key and no OAuth token, code or secret in tools/list or any call',
     (refA.out?.decisions ?? []).length === 2 && !KEY_RE.test(outputs) && !OAUTH_RE.test(outputs) && !outputs.includes(restKey) && !outputs.includes(legacyKey),
     `refusals=${(refA.out?.decisions ?? []).length}`)

  // ================================================================ the console: connected apps, Disconnect
  const keysView = await fetch(`${API}/app?view=keys`, { headers: { cookie: personA.cookie } }).then((r) => r.text())
  const grantId = (keysView.match(/action="\/app\/oauth\/grants\/([0-9a-f-]{36})\/disconnect"/) ?? [])[1] ?? ''
  const [tAGrant] = await sql`SELECT grant_id FROM oauth_tokens WHERE token_hash = ${createHash('sha256').update(tA.access_token).digest('hex')}`
  ok('[mcp] the console\'s keys view lists the connected app by name and host, with a Disconnect form per connection',
     keysView.includes('id="connected-apps"') && keysView.includes('Gate client') && keysView.includes('client.example') && !!grantId
       && keysView.includes(`/app/oauth/grants/${tAGrant?.grantId}/disconnect`))
  const crossDisc = await fetch(`${API}/app/oauth/grants/${tAGrant.grantId}/disconnect`, { method: 'POST', redirect: 'manual', headers: { 'Sec-Fetch-Site': 'cross-site', cookie: personA.cookie } })
  const bDisc = await fetch(`${API}/app/oauth/grants/${tAGrant.grantId}/disconnect`, { method: 'POST', redirect: 'manual', headers: { ...SAME, cookie: personB.cookie } })
  const stillA = await rpc(tA.access_token, 'tools/list')
  const disc = await fetch(`${API}/app/oauth/grants/${tAGrant.grantId}/disconnect`, { method: 'POST', redirect: 'manual', headers: { ...SAME, cookie: personA.cookie } })
  const goneA = await rpc(tA.access_token, 'tools/list')
  const goneRefresh = await token({ grant_type: 'refresh_token', client_id: pubId, refresh_token: tA.refresh_token })
  const keysAfter = await fetch(`${API}/app?view=keys&app=disconnected`, { headers: { cookie: personA.cookie } }).then((r) => r.text())
  ok('[mcp] Disconnect: refused cross-site and from another account; from the owner it ends the access and refresh tokens and the row leaves the list',
     crossDisc.status === 403 && bDisc.headers.get('location') === '/app?view=keys&app=gone' && stillA.status === 200
       && disc.status === 303 && disc.headers.get('location') === '/app?view=keys&app=disconnected' && goneA.status === 401 && goneRefresh.status === 400
       && !keysAfter.includes(`/app/oauth/grants/${tAGrant.grantId}/disconnect`) && keysAfter.includes('id="app-flash"'),
     `${crossDisc.status} ${bDisc.headers.get('location')} ${disc.status} ${goneA.status} ${goneRefresh.status}`)

  // ================================================================ limits and table growth
  const regNet = newNet()
  const regs = []
  for (let i = 0; i < 11; i++) regs.push((await register({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }, regNet)).status)
  const regOther = (await register({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' })).status
  ok('[mcp] DCR is limited per network: ten an hour, the eleventh is 429, and another network is unaffected',
     regs.slice(0, 10).every((s) => s === 201) && regs[10] === 429 && regOther === 201, regs.join(','))
  const tokNet = newNet()
  const toks = []
  for (let i = 0; i < 31; i++) toks.push((await token({ grant_type: 'refresh_token', client_id: pubId, refresh_token: 'agbr_' + '0'.repeat(64) }, tokNet)).status)
  ok('[mcp] the token endpoint is limited per network: thirty a minute, the thirty-first is 429',
     toks.slice(0, 30).every((s) => s === 400) && toks[30] === 429, toks.slice(-3).join(','))
  const oldId = 'agbcl_' + randomBytes(16).toString('hex')
  await sql`INSERT INTO oauth_clients (client_id, kind, redirect_uris, scope, created_at) VALUES (${oldId}, 'dcr', ${[REDIRECT]}, 'agentbill:read', now() - INTERVAL '2 days')`
  await register({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' })
  const [pruned] = await sql`SELECT count(*)::int AS n FROM oauth_clients WHERE client_id = ${oldId}`
  const [usedKept] = await sql`SELECT count(*)::int AS n FROM oauth_clients WHERE client_id = ${pubId}`
  ok('[mcp] a registration nobody used for a day is pruned, and one with a connection is kept', pruned.n === 0 && usedKept.n === 1, `${pruned.n} ${usedKept.n}`)
  const [unusedNow] = await sql`SELECT count(*)::int AS n FROM oauth_clients WHERE kind = 'dcr' AND last_used_at IS NULL`
  const capped = await bootS({ NODE_ENV: 'test', DATABASE_SSL: 'disable', APP_SESSION_SECRET: 'preflight-verify-session-secret', OAUTH_MAX_UNUSED_CLIENTS: String(unusedNow.n) }, portS)
  const capRes = await fetch(`http://localhost:${portS}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...newNet() },
    body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) })).catch(() => ({ status: 0 }))
  ok('[mcp] the unused-registration table has a global ceiling: at it, registration is 429 from any network', capRes.status === 429, `${capRes.status} ${JSON.stringify(capRes.body)}`)
  await stopS(capped)

  // ================================================================ client ID metadata documents
  const docs = new Map()
  const docServer = createServer((req, res) => {
    const d = docs.get(req.url)
    if (!d) { res.writeHead(404); return res.end() }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d))
  })
  await new Promise((r) => docServer.listen(0, '127.0.0.1', r))
  const docOrigin = `http://127.0.0.1:${docServer.address().port}`
  const cimdId = `${docOrigin}/client.json`
  docs.set('/client.json', { client_id: cimdId, client_name: 'Gate CIMD client', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' })
  docs.set('/liar.json', { client_id: 'https://someone-else.example/client.json', client_name: 'Liar', redirect_uris: [REDIRECT] })
  const cimd = await bootS({ NODE_ENV: 'test', DATABASE_SSL: 'disable', APP_SESSION_SECRET: 'preflight-verify-session-secret', OAUTH_CIMD_TEST_ORIGIN: docOrigin,
    MCP_PUBLIC_ORIGIN: `http://localhost:${portS}` }, portS)
  const S = `http://localhost:${portS}`
  const cp = pkce()
  const cimdQ = (id) => `${S}/app/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: id, redirect_uri: REDIRECT, code_challenge: cp.challenge, code_challenge_method: 'S256', state: 's' })}`
  const cimdPage = await fetch(cimdQ(cimdId), { redirect: 'manual', headers: { cookie: personA.cookie, ...newNet() } })
  const cimdHtml = await cimdPage.text()
  const liar = await fetch(cimdQ(`${docOrigin}/liar.json`), { redirect: 'manual', headers: { cookie: personA.cookie, ...newNet() } })
  const ssrf = await Promise.all(['https://127.0.0.1/client.json', 'https://localhost/client.json', 'https://169.254.169.254/latest/meta-data', 'https://metadata.internal/c.json', 'http://example.com/c.json']
    .map((id) => fetch(cimdQ(id), { redirect: 'manual', headers: { cookie: personA.cookie, ...newNet() } }).then((r) => ({ status: r.status, loc: r.headers.get('location') }))))
  ok('[mcp] a client ID metadata document client: the document is fetched, its name shown with where it is published, and the consent page offers Allow',
     cimdPage.status === 200 && cimdHtml.includes('Gate CIMD client') && cimdHtml.includes('Its identity document is published at') && cimdHtml.includes('id="approve"'),
     `${cimdPage.status}`)
  ok('[mcp] a document whose client_id is not its own URL is refused, and a client_id on loopback, a private or metadata address, .internal or plain http is never fetched',
     liar.status === 400 && !liar.headers.get('location') && ssrf.every((r) => r.status === 400 && !r.loc), `${liar.status} ${ssrf.map((r) => r.status).join(',')}`)
  await stopS(cimd)
  docServer.close()

  // ================================================================ end to end, with the SDK's own client
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const { UnauthorizedError } = await import('@modelcontextprotocol/sdk/client/auth.js')
  const E2E_REDIRECT = 'http://127.0.0.1:53682/callback'
  const store = {}
  let authCode = ''
  const e2eNet = newNet()
  const provider = {
    get redirectUrl() { return E2E_REDIRECT },
    get clientMetadata() {
      return { client_name: 'SDK end-to-end client', redirect_uris: [E2E_REDIRECT], grant_types: ['authorization_code', 'refresh_token'],
               response_types: ['code'], token_endpoint_auth_method: 'none' }
    },
    clientInformation: () => store.client,
    saveClientInformation: (c) => { store.client = c },
    tokens: () => store.tokens,
    saveTokens: (t) => { store.tokens = t; remember(t.access_token, t.refresh_token) },
    saveCodeVerifier: (v) => { store.verifier = v },
    codeVerifier: () => store.verifier,
    // The browser's part: the signed-in person opens the URL, sees the consent
    // page and presses Allow. Everything else is the SDK.
    redirectToAuthorization: async (url) => {
      store.authorizeUrl = url.toString()
      const page = await fetch(url, { redirect: 'manual', headers: { cookie: personA.cookie, ...e2eNet } })
      const c = consentOf(await page.text())
      const r = await fetch(`${API}/app/oauth/authorize`, { method: 'POST', redirect: 'manual',
        headers: { ...FORM, ...SAME, cookie: personA.cookie, ...e2eNet }, body: new URLSearchParams({ request_id: c.requestId, csrf: c.csrf, decision: 'approve' }).toString() })
      const loc = new URL(r.headers.get('location') ?? 'http://none/')
      store.iss = loc.searchParams.get('iss')
      authCode = loc.searchParams.get('code') ?? ''
      remember(authCode)
    },
  }
  // The SDK hands fetch a Headers object; spreading one gives {}, so the
  // network is set on a copy of it rather than merged into a literal.
  const withNet = (url, init = {}) => {
    const h = new Headers(init.headers ?? {})
    h.set('fly-client-ip', e2eNet['fly-client-ip'])
    return fetch(url, { ...init, headers: h })
  }
  let firstTry = 'none'
  const t1 = new StreamableHTTPClientTransport(new URL(`${API}/mcp`), { authProvider: provider, fetch: withNet })
  try { await new Client({ name: 'gate', version: '1' }).connect(t1); firstTry = 'connected without auth' } catch (e) { firstTry = e instanceof UnauthorizedError ? 'unauthorized' : String(e) }
  if (authCode) await t1.finishAuth(authCode)
  const e2eClient = new Client({ name: 'gate', version: '1' })
  const t2 = new StreamableHTTPClientTransport(new URL(`${API}/mcp`), { authProvider: provider, fetch: withNet })
  let e2eTools = [], e2eCall = null, e2eErr = ''
  try {
    await e2eClient.connect(t2)
    e2eTools = (await e2eClient.listTools()).tools.map((t) => t.name).sort()
    e2eCall = await e2eClient.callTool({ name: 'preflight', arguments: { agent_id: 'sdk-e2e', task_ref: `e2e-${rnd()}`, task_ceiling: 100, estimated_units: 10 } })
  } catch (e) { e2eErr = String(e).slice(0, 200) }
  await e2eClient.close().catch(() => {})
  const au = new URL(store.authorizeUrl ?? 'http://none/')
  ok('[mcp] end to end with the SDK\'s client: 401 and discovery, DCR, authorize with S256 and the resource, consent, token, then tools/list and a preflight',
     firstTry === 'unauthorized' && /^agbcl_/.test(store.client?.client_id ?? '') && au.searchParams.get('code_challenge_method') === 'S256'
       && au.searchParams.get('resource') === RESOURCE && store.iss === API && /^agbo_/.test(store.tokens?.access_token ?? '')
       && e2eTools.join(',') === 'preflight,recent_refusals,record_event,task_status,top_jobs' && e2eCall?.structuredContent?.approved === true,
     `first=${firstTry} client=${store.client?.client_id} tools=${e2eTools.join(',')} call=${JSON.stringify(e2eCall?.structuredContent ?? null)} err=${e2eErr}`)

  // ================================================================ the log
  await new Promise((r) => setTimeout(r, 400))
  let log = ''
  try { log = readFileSync(serverLog, 'utf8') } catch {}
  const leaked = seen.secrets.filter((s) => log.includes(s))
  ok('[mcp] no code, access token, refresh token or client secret this run minted appears in the server log, and no request line carries a query',
     log.length > 0 && seen.secrets.length >= 20 && leaked.length === 0 && !OAUTH_RE.test(log) && !/"url":"\/app\/oauth\/authorize\?/.test(log),
     `secrets=${seen.secrets.length} leaked=${leaked.length}`)
}
