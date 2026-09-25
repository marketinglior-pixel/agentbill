// [auth] Sign-in with Google, GitHub and an email link (2026-09-25).
//
// Every gate here stands behind a security property of the sign-in stage, and
// each was planted red once before it was trusted to pass (see the commit that
// added this file). The providers are scripts/preflight/fake-oauth.mjs, which
// refuses a reused code, a wrong PKCE verifier and a wrong redirect_uri the way
// Google and GitHub do; the server under test reaches it through
// OAUTH_TEST_BASE.
//
// Called from verify.mjs with its `ok`, its database handle and its boot
// helpers. Every network is its own fly-client-ip, so the per-network limiters
// under test never meet each other or the rest of the harness.
import { keyHash, insertKeyRow } from './key-fixture.mjs'
import { readFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'

// A gate that throws takes every gate after it with it, silently: a broken
// step (no authorize URL, no cookie) must read as a FAIL, and the run must say
// that it did not reach its end.
export async function authGates(opts) {
  console.log('\n[auth] sign-in with Google, GitHub and an email link')
  let reached = false
  try {
    await gates(opts)
    reached = true
  } catch (err) {
    opts.ok('[auth] a gate threw', false, String(err?.stack ?? err).slice(0, 300))
  }
  opts.ok('[auth] every gate ran to the end', reached)
}

async function gates({ API, sql, ok, fakeBase, outbox, serverLog, bootS, stopS, portS, legacyKey, legacyAccount }) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const rnd = () => randomBytes(5).toString('hex')
  const SAME = { 'Sec-Fetch-Site': 'same-origin' }
  const FORM = { 'Content-Type': 'application/x-www-form-urlencoded', ...SAME }
  const JSONH = { 'Content-Type': 'application/json', ...SAME }
  let net = 10
  const newNet = () => ({ 'fly-client-ip': `198.18.${Math.floor(net / 250)}.${(net++ % 250) + 1}` })
  const cookiesOf = (res) => res.headers.getSetCookie()
  const cookieVal = (res, name) => (cookiesOf(res).find((c) => c.startsWith(`${name}=`)) ?? '').split(';')[0]
  const fakeLog = () => fetch(`${fakeBase}/__log`).then((r) => r.json())

  // One OAuth round trip, step by step, so a gate can break exactly one step.
  // node:http, not fetch, where the Host header itself is the thing under test:
  // fetch treats Host as a header it may rewrite.
  const rawGet = (url, headers) => new Promise((resolve) => {
    const u = new URL(url)
    import('node:http').then(({ request }) => {
      const q = request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers }, (res) => {
        res.resume(); resolve({ status: res.statusCode, location: res.headers.location ?? '', cookies: res.headers['set-cookie'] ?? [] })
      })
      q.on('error', () => resolve({ status: 0, location: '', cookies: [] }))
      q.end()
    })
  })
  const start = async (provider, { next, headers = {} } = {}) => {
    const r = await fetch(`${API}/auth/${provider}${next !== undefined ? `?next=${encodeURIComponent(next)}` : ''}`, { redirect: 'manual', headers })
    return { status: r.status, location: r.headers.get('location') ?? '', flow: cookieVal(r, 'agentbill_oauth'), raw: r }
  }
  const authorize = async (authUrl, user, extra = {}) => {
    let u
    try { u = new URL(authUrl) } catch { return { error: `no authorize URL (${JSON.stringify(authUrl)})` } }
    u.searchParams.set('fake_user', b64(user))
    for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v)
    const r = await fetch(u, { redirect: 'manual' })
    const loc = r.headers.get('location')
    if (!loc) return { error: await r.text() }
    const cb = new URL(loc)
    return { path: cb.pathname, code: cb.searchParams.get('code'), state: cb.searchParams.get('state'), search: cb.search }
  }
  const callback = (provider, params, flowCookie) => fetch(`${API}/auth/${provider}/callback?${new URLSearchParams(params)}`,
    { redirect: 'manual', headers: flowCookie ? { cookie: flowCookie } : {} })
  const signInWith = async (provider, user, opts = {}) => {
    const s = await start(provider, opts)
    const a = await authorize(s.location, user)
    const r = await callback(provider, { code: a.code, state: a.state }, s.flow)
    return { res: r, user: cookieVal(r, 'agentbill_user'), location: r.headers.get('location') ?? '', code: a.code, state: a.state, flow: s.flow }
  }
  const console_ = (cookie, view = '') => fetch(`${API}/app${view}`, { headers: { cookie } }).then((r) => r.text())
  const outboxFor = (to) => {
    let lines = []
    try { lines = readFileSync(outbox, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch {}
    return lines.filter((m) => m.to === to)
  }
  const tokenOf = (mail) => (mail?.html.match(/\/auth\/email\/([A-Za-z0-9_-]{43})/) ?? [])[1] ?? ''
  const settle = (ms) => new Promise((r) => setTimeout(r, ms))
  // Sign-in links only: a new account's welcome note goes to the same address.
  const linksFor = (to) => outboxFor(to).filter((m) => m.reason === 'signin')
  const waitMail = async (to, n = 1) => {
    for (let i = 0; i < 40; i++) { if (linksFor(to).length >= n) break; await settle(50) }
    return linksFor(to)
  }
  const tokenRows = (email) => sql`SELECT id, next_path, consumed_at, expires_at, created_at FROM email_sign_in_tokens WHERE email = ${email} ORDER BY id`
  const userOf = async (email) => (await sql`SELECT id, email, email_verified_at, session_epoch FROM users WHERE email = ${email}`)[0]
  const acctOfUser = async (userId) => (await sql`SELECT id, email FROM accounts WHERE owner_user_id = ${userId}`)[0]
  const liveKeys = async (accountId) => (await sql`SELECT count(*)::int AS n FROM developer_api_keys WHERE account_id = ${accountId} AND revoked_at IS NULL`)[0].n
  const seen = { codes: [], states: [], tokens: [] }

  // ------------------------------------------------------------ pages
  const login = await fetch(`${API}/login`).then((r) => r.text())
  const register = await fetch(`${API}/register`).then((r) => r.text())
  for (const [name, html] of [['/login', login], ['/register', register]]) {
    ok(`[auth] ${name}: Continue with Google (Google's standard G), Continue with GitHub, and an email form that POSTs to /auth/email`,
       html.includes('href="/auth/google"') && html.includes('>Continue with Google<') && html.includes('fill="#4285F4"') && html.includes('fill="#EA4335"')
         && html.includes('href="/auth/github"') && html.includes('>Continue with GitHub<')
         && /<form class="signin-email" id="email-form" method="post" action="\/auth\/email">/.test(html) && html.includes('type="email"'),
       name)
  }
  ok('[auth] /login ships no script, and neither page can put the address in a URL (method="post")',
     !/<script(?![^>]*ld\+json)[^>]*>/.test(login) && !/<form[^>]*method="get"/i.test(login + register))
  ok('[auth] the nav carries Log in and Sign up', /<a class="console" href="\/login"[^>]*>Log in<\/a>/.test(register) && register.includes('<li><a href="/register" aria-current="page">Sign up</a></li>'))

  // ------------------------------------------------------------ provider switches: unset hides and 404s; production ignores the test base
  const bare = await bootS({ NODE_ENV: 'test', DATABASE_SSL: 'disable', APP_SESSION_SECRET: 'preflight-verify-session-secret' }, portS)
  const bareBase = `http://localhost:${portS}`
  const bareLogin = await fetch(`${bareBase}/login`).then((r) => r.text()).catch(() => '')
  const bare404 = await Promise.all(['/auth/google', '/auth/github', '/auth/google/callback?code=x&state=y', '/auth/github/callback?code=x&state=y']
    .map((p) => fetch(`${bareBase}${p}`, { redirect: 'manual' }).then((r) => r.status).catch(() => 0)))
  const bareConnect = await fetch(`${bareBase}/app/connect/google`, { method: 'POST', headers: SAME }).then((r) => r.status).catch(() => 0)
  ok('[auth] with no client id and secret set, neither button is drawn, the email form still is, and every provider route answers 404',
     !bare.exited && !bareLogin.includes('/auth/google') && !bareLogin.includes('/auth/github') && bareLogin.includes('action="/auth/email"')
       && bare404.every((s) => s === 404) && bareConnect === 404, `${bare404.join(',')} connect=${bareConnect}`)
  await stopS(bare)
  const LONG = 'y'.repeat(40)
  const prod = await bootS({ NODE_ENV: 'production', DATABASE_SSL: 'disable', DATABASE_SSL_INSECURE_OK: '1', APP_SESSION_SECRET: LONG,
    GOOGLE_CLIENT_ID: 'prod-google', GOOGLE_CLIENT_SECRET: 'prod-google-secret', GITHUB_CLIENT_ID: 'prod-github', GITHUB_CLIENT_SECRET: 'prod-github-secret',
    OAUTH_TEST_BASE: fakeBase, PUBLIC_BASE_URL: 'https://evil.example' }, portS)
  const prodG = (await rawGet(`${bareBase}/auth/google`, { Host: 'evil.example' })).location
  const prodH = await fetch(`${bareBase}/auth/github`, { redirect: 'manual' }).then((r) => r.headers.get('location') ?? '').catch(() => '')
  const qG = new URL(prodG || 'http://x').searchParams, qH = new URL(prodH || 'http://x').searchParams
  ok('[auth] in production OAUTH_TEST_BASE and PUBLIC_BASE_URL are ignored: the real endpoints, and the exact agentbill.dev callbacks',
     prodG.startsWith('https://accounts.google.com/o/oauth2/v2/auth?') && qG.get('redirect_uri') === 'https://agentbill.dev/auth/google/callback'
       && prodH.startsWith('https://github.com/login/oauth/authorize?') && qH.get('redirect_uri') === 'https://agentbill.dev/auth/github/callback',
     `${prodG.slice(0, 60)} ${qG.get('redirect_uri')} ${prodH.slice(0, 50)} ${qH.get('redirect_uri')}`)
  await stopS(prod)

  // ------------------------------------------------------------ the authorization request
  const g0h = await rawGet(`${API}/auth/google`, { Host: 'evil.example:9999', 'X-Forwarded-Host': 'evil.example' })
  const g0 = { location: g0h.location, raw: { headers: { getSetCookie: () => g0h.cookies } } }
  const qg = new URL(g0.location).searchParams
  ok('[auth] the callback URL comes from the configured base, never the Host header: a request with Host evil.example still names agentbill.dev',
     qg.get('redirect_uri') === 'https://agentbill.dev/auth/google/callback', qg.get('redirect_uri'))
  ok('[auth] Google: code + S256 PKCE + state + nonce, scopes openid email profile, and the flow cookie is HttpOnly, Secure, SameSite=Lax, /auth, ten minutes',
     qg.get('response_type') === 'code' && qg.get('code_challenge_method') === 'S256' && /^[A-Za-z0-9_-]{43}$/.test(qg.get('code_challenge') ?? '')
       && /^[A-Za-z0-9_-]{32}$/.test(qg.get('state') ?? '') && /^[A-Za-z0-9_-]{32}$/.test(qg.get('nonce') ?? '') && qg.get('scope') === 'openid email profile'
       && /HttpOnly/.test(cookiesOf(g0.raw)[0]) && /Secure/.test(cookiesOf(g0.raw)[0]) && /SameSite=Lax/.test(cookiesOf(g0.raw)[0])
       && /Path=\/auth/.test(cookiesOf(g0.raw)[0]) && /Max-Age=600/.test(cookiesOf(g0.raw)[0]), g0.location.slice(0, 80))
  const h0 = await start('github')
  const qh = new URL(h0.location).searchParams
  ok('[auth] GitHub: state + S256 PKCE, scope read:user user:email, callback https://agentbill.dev/auth/github/callback',
     qh.get('scope') === 'read:user user:email' && qh.get('code_challenge_method') === 'S256' && /^[A-Za-z0-9_-]{32}$/.test(qh.get('state') ?? '')
       && qh.get('redirect_uri') === 'https://agentbill.dev/auth/github/callback')

  // ------------------------------------------------------------ Google, happy path
  const gEmail = `auth-g-${rnd()}@example.com`
  const gSub = `g-${rnd()}`
  const g1 = await signInWith('google', { sub: gSub, email: gEmail.toUpperCase(), email_verified: true })
  seen.codes.push(g1.code); seen.states.push(g1.state)
  const g1Set = cookiesOf(g1.res).find((c) => c.startsWith('agentbill_user=')) ?? ''
  const g1User = await userOf(gEmail)
  const g1Acct = g1User ? await acctOfUser(g1User.id) : null
  ok('[auth] a new Google user: 303 to the start screen, a user session (HttpOnly, Secure, SameSite=Lax, Path=/app), the flow cookie spent, the key cookie cleared',
     g1.res.status === 303 && g1.location === '/app?view=start' && /HttpOnly/.test(g1Set) && /Secure/.test(g1Set) && /SameSite=Lax/.test(g1Set) && /Path=\/app;/.test(g1Set)
       && cookiesOf(g1.res).some((c) => /^agentbill_oauth=;.*Max-Age=0/.test(c)) && cookiesOf(g1.res).some((c) => /^agentbill_app=;.*Max-Age=0/.test(c)),
     `${g1.res.status} ${g1.location}`)
  ok('[auth] and the rows: one user with the address lowercased and verified, the Google sub as its identity, one account it owns, and no key',
     !!g1User && g1User.emailVerifiedAt instanceof Date && !!g1Acct && g1Acct.email === gEmail && await liveKeys(g1Acct.id) === 0
       && (await sql`SELECT count(*)::int AS n FROM user_identities WHERE user_id = ${g1User.id} AND provider = 'google' AND provider_user_id = ${gSub}`)[0].n === 1,
     JSON.stringify({ user: !!g1User, acct: g1Acct }))
  const g1Home = await console_(g1.user, '?view=start')
  ok('[auth] the console opens for that session, says "Signed in as" the address, and offers the first key',
     g1Home.includes('Signed in as') && g1Home.includes(gEmail) && g1Home.includes('action="/app/keys/first"'))
  const g1Again = await signInWith('google', { sub: gSub, email: gEmail, email_verified: true })
  ok('[auth] signing in again with the same Google account opens the same account, and creates nothing',
     g1Again.res.status === 303 && (await sql`SELECT count(*)::int AS n FROM users WHERE email = ${gEmail}`)[0].n === 1
       && (await sql`SELECT count(*)::int AS n FROM accounts WHERE owner_user_id = ${g1User?.id}`)[0].n === 1)

  // ------------------------------------------------------------ the first key
  const fk1 = await fetch(`${API}/app/keys/first`, { method: 'POST', redirect: 'manual', headers: { ...SAME, cookie: g1.user } })
  const fk1Html = await fk1.text()
  const fkKey = (fk1Html.match(/agb_[0-9a-f]{48}/) ?? [])[0]
  const fk2 = await fetch(`${API}/app/keys/first`, { method: 'POST', redirect: 'manual', headers: { ...SAME, cookie: g1.user } })
  ok('[auth] the start screen makes the first key once: a 200 page that shows it (no-store), and a second press makes none',
     fk1.status === 200 && !!fkKey && fk1.headers.get('cache-control') === 'no-store' && fk1Html.includes(`export AGENTBILL_API_KEY=${fkKey}`)
       && fk2.status === 303 && fk2.headers.get('location') === '/app?view=keys' && await liveKeys(g1Acct.id) === 1, `${fk1.status} ${fk2.status}`)
  const fkAlive = await fetch(`${API}/keys`, { headers: { Authorization: `Bearer ${fkKey}` } }).then((r) => r.status)
  ok('[auth] and that key works on the API', fkAlive === 200, `${fkAlive}`)
  const fkAnon = await fetch(`${API}/app/keys/first`, { method: 'POST', redirect: 'manual', headers: SAME })
  const legacySession = cookieVal(await fetch(`${API}/app/session`, { method: 'POST', redirect: 'manual', headers: FORM, body: `api_key=${legacyKey}` }), 'agentbill_app')
  const fkKeySess = await fetch(`${API}/app/keys/first`, { method: 'POST', redirect: 'manual', headers: { ...SAME, cookie: legacySession } })
  ok('[auth] no session makes no key, and a key session is not a person: it is sent to the keys view with nothing made',
     fkAnon.status === 303 && fkAnon.headers.get('location') === '/app' && fkKeySess.status === 303 && fkKeySess.headers.get('location') === '/app?view=keys')

  // ------------------------------------------------------------ refusals on the callback
  const exchanged = async (code) => (await fakeLog()).filter((e) => e.code === code)
  // State mismatch.
  const sm = await start('google')
  const smA = await authorize(sm.location, { sub: `sm-${rnd()}`, email: `auth-sm-${rnd()}@example.com`, email_verified: true })
  const smR = await callback('google', { code: smA.code, state: smA.state.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')) }, sm.flow)
  // Missing state.
  const ms = await start('google')
  const msA = await authorize(ms.location, { sub: `ms-${rnd()}`, email: `auth-ms-${rnd()}@example.com`, email_verified: true })
  const msR = await callback('google', { code: msA.code }, ms.flow)
  // No flow cookie: finished in a browser that did not start it.
  const nf = await start('google')
  const nfA = await authorize(nf.location, { sub: `nf-${rnd()}`, email: `auth-nf-${rnd()}@example.com`, email_verified: true })
  const nfR = await callback('google', { code: nfA.code, state: nfA.state }, '')
  // A flow cookie whose signature does not hold.
  const tf = await start('google')
  const tfA = await authorize(tf.location, { sub: `tf-${rnd()}`, email: `auth-tf-${rnd()}@example.com`, email_verified: true })
  const tfR = await callback('google', { code: tfA.code, state: tfA.state }, tf.flow.replace(/.$/, (c) => (c === '0' ? '1' : '0')))
  // The provider said no.
  const dn = await start('google')
  const dnR = await callback('google', { error: 'access_denied', state: new URL(dn.location).searchParams.get('state') }, dn.flow)
  const refused = (r) => r.status === 303 && (r.headers.get('location') ?? '').startsWith('/login?err=') && !cookieVal(r, 'agentbill_user')
  ok('[auth] refused, with no session and the code never exchanged: a state mismatch, a missing state, no flow cookie, a tampered flow cookie',
     [smR, msR, nfR, tfR].every(refused) && (await exchanged(smA.code)).length === 0 && (await exchanged(msA.code)).length === 0
       && (await exchanged(nfA.code)).length === 0 && (await exchanged(tfA.code)).length === 0,
     [smR, msR, nfR, tfR].map((r) => `${r.status} ${r.headers.get('location')}`).join(' | '))
  ok('[auth] a cancelled sign-in lands on /login?err=denied with nothing set', refused(dnR) && dnR.headers.get('location') === '/login?err=denied')
  // Replayed code: the same callback again, with a copy of the flow cookie the first one spent.
  const rp = await signInWith('google', { sub: `rp-${rnd()}`, email: `auth-rp-${rnd()}@example.com`, email_verified: true })
  const rpR = await callback('google', { code: rp.code, state: rp.state }, rp.flow)
  const rpLog = await exchanged(rp.code)
  ok('[auth] a replayed code is refused: the provider will not exchange it twice, and the second callback sets no session',
     rp.res.status === 303 && !!rp.user && refused(rpR) && rpLog.length === 2 && rpLog[1].outcome === 'code already used', JSON.stringify(rpLog.map((e) => e.outcome)))
  // PKCE: a code minted for flow B presented with flow A's cookie and state.
  const pA = await start('google'), pB = await start('google')
  const pBa = await authorize(pB.location, { sub: `pk-${rnd()}`, email: `auth-pk-${rnd()}@example.com`, email_verified: true })
  const pR = await callback('google', { code: pBa.code, state: new URL(pA.location).searchParams.get('state') }, pA.flow)
  const pLog = await exchanged(pBa.code)
  ok('[auth] a PKCE verifier mismatch is refused: a code issued to one flow cannot be finished by another flow\'s cookie',
     refused(pR) && pLog.length === 1 && pLog[0].outcome === 'pkce mismatch' && pLog[0].has_verifier === true, JSON.stringify(pLog))
  const hA = await start('github'), hB = await start('github')
  const hBa = await authorize(hB.location, { id: 900000 + Math.floor(Math.random() * 99999), emails: [{ email: `auth-hpk-${rnd()}@example.com`, primary: true, verified: true }] })
  const hR = await callback('github', { code: hBa.code, state: new URL(hA.location).searchParams.get('state') }, hA.flow)
  ok('[auth] and the same for GitHub, which answers a bad exchange with a 200 and an error field',
     refused(hR) && (await exchanged(hBa.code))[0]?.outcome === 'pkce mismatch')
  // Nonce.
  const nn = await start('google')
  const nnA = await authorize(nn.location, { sub: `nn-${rnd()}`, email: `auth-nn-${rnd()}@example.com`, email_verified: true }, { fake_nonce: 'not-the-nonce-we-sent-000000000' })
  const nnR = await callback('google', { code: nnA.code, state: nnA.state }, nn.flow)
  ok('[auth] an id_token whose nonce is not the one this flow sent is refused', refused(nnR) && nnR.headers.get('location') === '/login?err=failed')

  // ------------------------------------------------------------ unverified addresses
  const uvEmail = `auth-uv-${rnd()}@example.com`
  const uv1 = await signInWith('google', { sub: `uv-${rnd()}`, email: uvEmail, email_verified: false })
  const uv2 = await signInWith('google', { sub: `uv-${rnd()}`, email: uvEmail, email_verified: 'true' })
  const uv3 = await signInWith('google', { sub: `uv-${rnd()}`, email: uvEmail })
  const ghUv = `auth-ghuv-${rnd()}@example.com`
  const uv4 = await signInWith('github', { id: 800000 + Math.floor(Math.random() * 99999), emails: [
    { email: ghUv, primary: true, verified: false }, { email: `auth-ghuv2-${rnd()}@example.com`, primary: false, verified: true }] })
  ok('[auth] Google email_verified false, the string "true", or absent, and a GitHub primary with verified:false (a verified secondary does not count): each refused, no person made',
     [uv1, uv2, uv3, uv4].every((x) => x.res.status === 303 && x.location === '/login?err=unverified' && !x.user)
       && (await sql`SELECT count(*)::int AS n FROM users WHERE email IN (${uvEmail}, ${ghUv})`)[0].n === 0,
     [uv1, uv2, uv3, uv4].map((x) => x.location).join(' '))

  // ------------------------------------------------------------ GitHub, happy path
  const ghId = 700000 + Math.floor(Math.random() * 99999)
  const ghEmail = `auth-gh-${rnd()}@example.com`
  const gh1 = await signInWith('github', { id: ghId, login: 'octo', emails: [{ email: `other-${rnd()}@example.com`, primary: false, verified: true }, { email: ghEmail, primary: true, verified: true }] })
  const ghUser = await userOf(ghEmail)
  ok('[auth] a GitHub user signs in with the verified primary address, and the identity is the numeric id',
     gh1.res.status === 303 && !!gh1.user && !!ghUser
       && (await sql`SELECT count(*)::int AS n FROM user_identities WHERE user_id = ${ghUser.id} AND provider = 'github' AND provider_user_id = ${String(ghId)}`)[0].n === 1)

  // ------------------------------------------------------------ no auto-link by email
  const vEmail = `auth-victim-${rnd()}@example.com`
  const vKey = 'agb_' + createHash('sha256').update(`victim-${vEmail}`).digest('hex').slice(0, 48)
  const [vAcct] = await sql`INSERT INTO accounts (email, plan) VALUES (${vEmail}, 'free') RETURNING id`
  await insertKeyRow(sql, vAcct.id, vKey, 'pre-registered')
  const v1 = await signInWith('google', { sub: `v-${rnd()}`, email: vEmail, email_verified: true })
  const vUser = await userOf(vEmail)
  const vNew = vUser ? await acctOfUser(vUser.id) : null
  const [vOld] = await sql`SELECT owner_user_id, email FROM accounts WHERE id = ${vAcct.id}`
  const vHome = await console_(v1.user)
  ok('[auth] no auto-link: a verified Google address matching an account made with only a key gets a NEW account; the old one stays unowned and unopened',
     v1.res.status === 303 && !!vNew && vNew.id !== vAcct.id && vOld.ownerUserId === null && vOld.email === vEmail && vNew.email === null
       && !vHome.includes(vKey.slice(0, 8) + '…' + vKey.slice(-4)), JSON.stringify({ vNew, vOld }))
  const vMailAsk = await fetch(`${API}/auth/email`, { method: 'POST', redirect: 'manual', headers: { ...FORM, ...newNet() }, body: `email=${encodeURIComponent(vEmail)}` })
  const vMail = (await waitMail(vEmail))[0]
  const vTok = tokenOf(vMail)
  seen.tokens.push(vTok)
  const vLink = await fetch(`${API}/auth/email/${vTok}`, { method: 'POST', redirect: 'manual', headers: SAME })
  const [vOld2] = await sql`SELECT owner_user_id FROM accounts WHERE id = ${vAcct.id}`
  ok('[auth] and an email link to the same address signs into that same new person, never the old account; its mail says why',
     vMailAsk.status === 303 && vLink.status === 303 && !!cookieVal(vLink, 'agentbill_user') && vOld2.ownerUserId === null
       && (await sql`SELECT count(*)::int AS n FROM users WHERE email = ${vEmail}`)[0].n === 1
       && (await sql`SELECT count(*)::int AS n FROM accounts WHERE owner_user_id = ${vUser?.id}`)[0].n === 1
       && /made with an API key,\s+before sign-in existed/.test(vMail?.html ?? ''), `${vMailAsk.status} ${vLink.status}`)

  // ------------------------------------------------------------ explicit connect from a key session
  const cSess = cookieVal(await fetch(`${API}/app/session`, { method: 'POST', redirect: 'manual', headers: FORM, body: `api_key=${vKey}` }), 'agentbill_app')
  const cHomeKey = await console_(cSess)
  const cCross = await fetch(`${API}/app/connect/github`, { method: 'POST', redirect: 'manual', headers: { 'Sec-Fetch-Site': 'cross-site', cookie: cSess } })
  const cStart = await fetch(`${API}/app/connect/github`, { method: 'POST', redirect: 'manual', headers: { ...SAME, cookie: cSess } })
  const cHtml = await cStart.text()
  const cTo = (cHtml.match(/http-equiv="refresh" content="0;url=([^"]+)"/) ?? [])[1]?.replace(/&amp;/g, '&') ?? ''
  const cFlow = cookieVal(cStart, 'agentbill_oauth')
  const cId = 600000 + Math.floor(Math.random() * 99999)
  const cOwnerEmail = `auth-owner-${rnd()}@example.com`
  const cA = await authorize(cTo, { id: cId, emails: [{ email: cOwnerEmail, primary: true, verified: true }] })
  const cR = await callback('github', { code: cA.code, state: cA.state }, cFlow)
  const [cRow] = await sql`SELECT owner_user_id FROM accounts WHERE id = ${vAcct.id}`
  ok('[auth] a key session is nudged to connect, and a cross-site POST to /app/connect is 403',
     cHomeKey.includes('Signed in with a key') && cHomeKey.includes('Connect a sign-in') && cCross.status === 403)
  ok('[auth] "Continue with GitHub" from the key session connects GitHub to THAT account, and lands on the keys view signed in as its new owner',
     cStart.status === 200 && cTo.includes('/github/authorize?') && cR.status === 303 && cR.headers.get('location') === '/app?view=keys&link=ok'
       && !!cRow.ownerUserId && !!cookieVal(cR, 'agentbill_user'), `${cStart.status} ${cR.status} ${cR.headers.get('location')}`)
  const cLater = await signInWith('github', { id: cId, emails: [{ email: cOwnerEmail, primary: true, verified: true }] })
  const cLaterHome = await console_(cLater.user, '?view=keys')
  ok('[auth] and from then on that GitHub account signs in to the old account, key and all',
     cLater.res.status === 303 && cLaterHome.includes(vKey.slice(0, 8)) && cLaterHome.includes('is connected'))
  // The same identity cannot be connected to a second account.
  const c2Start = await fetch(`${API}/app/connect/google`, { method: 'POST', redirect: 'manual', headers: { ...SAME, cookie: legacySession } })
  const c2To = ((await c2Start.text()).match(/content="0;url=([^"]+)"/) ?? [])[1]?.replace(/&amp;/g, '&') ?? ''
  const c2A = await authorize(c2To, { sub: gSub, email: gEmail, email_verified: true })
  const c2R = await callback('google', { code: c2A.code, state: c2A.state }, cookieVal(c2Start, 'agentbill_oauth'))
  const [legacyRow] = await sql`SELECT owner_user_id FROM accounts WHERE id = ${legacyAccount}`
  ok('[auth] a Google account that already opens another account cannot be connected to this one', c2R.headers.get('location') === '/app?view=keys&link=in_use'
     && legacyRow.ownerUserId === null && !cookieVal(c2R, 'agentbill_user'), c2R.headers.get('location'))

  // ------------------------------------------------------------ open redirect
  const nexts = {}
  for (const n of ['https://evil.example', '//evil.example', '/\\evil.example', '/app/../\\evil', 'javascript:alert(1)', '/app/upgrade/team']) {
    const r = await signInWith('google', { sub: `nx-${rnd()}`, email: `auth-nx-${rnd()}@example.com`, email_verified: true }, { next: n })
    nexts[n] = r.location
  }
  const cbNext = await (async () => {
    const s = await start('google')
    const a = await authorize(s.location, { sub: `nx2-${rnd()}`, email: `auth-nx2-${rnd()}@example.com`, email_verified: true })
    return (await callback('google', { code: a.code, state: a.state, next: 'https://evil.example' }, s.flow)).headers.get('location')
  })()
  ok('[auth] no open redirect: any next that is not an allowed same-host path lands on the start screen, a next on the callback is ignored, and /app/upgrade/team is kept',
     Object.entries(nexts).every(([n, loc]) => (n === '/app/upgrade/team' ? loc === '/app/upgrade/team' : loc === '/app?view=start')) && cbNext === '/app?view=start',
     JSON.stringify(nexts) + ' ' + cbNext)

  // ------------------------------------------------------------ the email link
  const newEmail = `auth-new-${rnd()}@example.com`
  const oldEmail = vEmail
  const netE = newNet()
  const askForm = (email, headers = netE) => fetch(`${API}/auth/email`, { method: 'POST', redirect: 'manual', headers: { ...FORM, ...headers }, body: `email=${encodeURIComponent(email)}` })
  const askJson = (email, headers = netE, path = '/auth/email') => fetch(`${API}${path}`, { method: 'POST', redirect: 'manual', headers: { ...JSONH, ...headers }, body: JSON.stringify({ email }) })
  const fNew = await askForm(newEmail), fOld = await askForm(`auth-known-${rnd()}@example.com`)
  const jNew = await askJson(`auth-new2-${rnd()}@example.com`), jOld = await askJson(gEmail)
  const [jNewB, jOldB] = [await jNew.text(), await jOld.text()]
  ok('[auth] the same answer for a new and a known address: the form 303s to /login?sent=1 both times, JSON is 202 with byte-identical bodies',
     fNew.status === 303 && fOld.status === 303 && fNew.headers.get('location') === '/login?sent=1' && fOld.headers.get('location') === fNew.headers.get('location')
       && jNew.status === 202 && jOld.status === 202 && jNewB === jOldB && !jNewB.includes('api_key'), `${jNewB}`)
  const mNew = (await waitMail(newEmail))[0]
  const tNew = tokenOf(mNew)
  seen.tokens.push(tNew)
  const g1r = await fetch(`${API}/auth/email/${tNew}`)
  const g2r = await fetch(`${API}/auth/email/${tNew}`)
  const [afterGet] = await tokenRows(newEmail)
  ok('[auth] GET on the link is a confirm page and does not spend it, however many times a scanner opens it',
     mNew?.reason === 'signin' && g1r.status === 200 && g2r.status === 200 && (await g2r.text()).includes(`action="/auth/email/${tNew}"`) && afterGet?.consumedAt === null)
  const p1 = await fetch(`${API}/auth/email/${tNew}`, { method: 'POST', redirect: 'manual', headers: SAME })
  const p2 = await fetch(`${API}/auth/email/${tNew}`, { method: 'POST', redirect: 'manual', headers: SAME })
  const g3 = await fetch(`${API}/auth/email/${tNew}`)
  ok('[auth] the POST spends it and signs in; it is single use: a second POST and a later GET are 410',
     p1.status === 303 && !!cookieVal(p1, 'agentbill_user') && p1.headers.get('location') === '/app?view=start' && p2.status === 410 && !cookieVal(p2, 'agentbill_user') && g3.status === 410)
  const tExp = randomBytes(32).toString('base64url')
  await sql`INSERT INTO email_sign_in_tokens (email, token_hash, created_at, expires_at)
            VALUES (${`auth-exp-${rnd()}@example.com`}, ${createHash('sha256').update(tExp).digest('hex')}, now() - INTERVAL '16 minutes', now() - INTERVAL '1 minute')`
  const eG = await fetch(`${API}/auth/email/${tExp}`)
  const eP = await fetch(`${API}/auth/email/${tExp}`, { method: 'POST', redirect: 'manual', headers: SAME })
  let longRefused = false
  try { await sql`INSERT INTO email_sign_in_tokens (email, token_hash, expires_at) VALUES ('auth-long@example.com', ${'0'.repeat(64)}, now() + INTERVAL '16 minutes')` } catch { longRefused = true }
  ok('[auth] an expired link is 410 on GET and POST, and the table itself refuses a link that lives longer than fifteen minutes',
     eG.status === 410 && eP.status === 410 && longRefused)
  const again1 = await askForm(newEmail)
  const oldTokens = await tokenRows(newEmail)
  ok('[auth] asking again retires the address\'s earlier live link', again1.status === 303 && oldTokens.filter((t) => t.consumedAt === null).length <= 1)
  const nxEmail = `auth-nxm-${rnd()}@example.com`
  await fetch(`${API}/auth/email`, { method: 'POST', redirect: 'manual', headers: { ...FORM, ...newNet() }, body: `email=${encodeURIComponent(nxEmail)}&next=${encodeURIComponent('https://evil.example')}` })
  await waitMail(nxEmail)
  ok('[auth] an email link carries no next it was not allowed to', (await tokenRows(nxEmail))[0]?.nextPath === null)

  // Rate limits.
  const perAddr = `auth-rate-${rnd()}@example.com`
  for (let i = 0; i < 5; i++) await askJson(perAddr, newNet())
  await settle(400)
  const perAddrRows = (await tokenRows(perAddr)).length
  const netR = newNet()
  const perNet = []
  for (let i = 0; i < 13; i++) perNet.push((await askJson(`auth-net-${i}-${rnd()}@example.com`, netR)).status)
  const perNetForm = await askForm(`auth-net-f-${rnd()}@example.com`, netR)
  ok('[auth] rate limited: three links an hour per address whatever the network (five asked, three minted), and twelve requests an hour per network, then 429',
     perAddrRows === 3 && perNet.slice(0, 12).every((s) => s === 202) && perNet[12] === 429 && perNetForm.headers.get('location') === '/login?err=rate',
     `rows=${perAddrRows} ${perNet.join(',')}`)

  // ------------------------------------------------------------ JSON POST /register no longer hands out a key
  const rNew = `auth-reg-${rnd()}@example.com`
  const netReg = newNet()
  const regNew = await askJson(rNew, netReg, '/register')
  const regOld = await askJson(vEmail, netReg, '/register')
  const [regNewB, regOldB] = [await regNew.text(), await regOld.text()]
  const regMail = await waitMail(rNew)
  const vMails = await waitMail(vEmail, 2)
  ok('[auth] JSON POST /register: 202 check_email, no api_key and no cookie, the same body for a new and a known address, and no account until the link is used',
     regNew.status === 202 && regOld.status === 202 && regNewB === regOldB && JSON.parse(regNewB).status === 'check_email' && !regNewB.includes('api_key')
       && !regNew.headers.get('set-cookie') && (await sql`SELECT count(*)::int AS n FROM accounts WHERE email = ${rNew}`)[0].n === 0
       && regMail[0]?.reason === 'signin' && !!tokenOf(regMail[0]) && vMails.length === 2, regNewB)
  seen.tokens.push(tokenOf(regMail[0]))

  // ------------------------------------------------------------ cross-site POSTs
  const X = { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example' }
  const xs = {
    email: (await fetch(`${API}/auth/email`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...X }, body: 'email=x%40example.com' })).status,
    emailOrigin: (await fetch(`${API}/auth/email`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{"email":"x@example.com"}' })).status,
    token: (await fetch(`${API}/auth/email/${'A'.repeat(43)}`, { method: 'POST', redirect: 'manual', headers: X })).status,
    connect: (await fetch(`${API}/app/connect/google`, { method: 'POST', redirect: 'manual', headers: { ...X, cookie: g1.user } })).status,
    firstKey: (await fetch(`${API}/app/keys/first`, { method: 'POST', redirect: 'manual', headers: { ...X, cookie: g1.user } })).status,
    logout: (await fetch(`${API}/app/logout`, { method: 'POST', redirect: 'manual', headers: { ...X, cookie: g1.user } })).status,
    register: (await fetch(`${API}/register`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json', ...X }, body: '{"email":"x@example.com"}' })).status,
  }
  ok('[auth] cross-site POSTs are 403: /auth/email (by Sec-Fetch-Site and by Origin), /auth/email/:token, /app/connect, /app/keys/first, /app/logout, /register',
     Object.values(xs).every((s) => s === 403), JSON.stringify(xs))
  ok('[auth] and the refused logout ended nothing', (await console_(g1.user)).includes('Signed in as'))

  // ------------------------------------------------------------ sessions
  const tampered = g1.user.replace(/.$/, (c) => (c === '0' ? '1' : '0'))
  const [uid] = g1.user.slice('agentbill_user='.length).split('.')
  const swapped = `agentbill_app=${g1.user.slice('agentbill_user='.length)}`
  ok('[auth] a user cookie with a bad signature opens nothing, and a user token presented as the key cookie is not a key session',
     !(await console_(tampered)).includes('Signed in as') && !(await console_(swapped)).includes('Signed in'))
  const copy = g1.user
  const epochBefore = (await userOf(gEmail)).sessionEpoch
  const out = await fetch(`${API}/app/logout`, { method: 'POST', redirect: 'manual', headers: { ...SAME, cookie: g1.user } })
  const epochAfter = (await userOf(gEmail)).sessionEpoch
  const copyHome = await console_(copy)
  ok('[auth] logout moves the epoch on in the database and clears both cookies, so a COPY of the cookie taken before it opens nothing',
     out.status === 303 && epochAfter === epochBefore + 1 && cookiesOf(out).some((c) => /^agentbill_user=;.*Max-Age=0/.test(c))
       && cookiesOf(out).some((c) => /^agentbill_app=;.*Max-Age=0/.test(c)) && !copyHome.includes('Signed in as') && copyHome.includes('action="/app/session"'),
     `${epochBefore} -> ${epochAfter}`)
  const back = await signInWith('google', { sub: gSub, email: gEmail, email_verified: true })
  ok('[auth] and the next sign-in works, on the new epoch', back.res.status === 303 && (await console_(back.user)).includes('Signed in as') && back.user.split('.')[1] === String(epochAfter))
  void uid

  // ------------------------------------------------------------ the legacy key login
  const kl = await fetch(`${API}/app/session`, { method: 'POST', redirect: 'manual', headers: { ...FORM, cookie: back.user }, body: `api_key=${legacyKey}` })
  const klHome = await console_(cookieVal(kl, 'agentbill_app'))
  ok('[auth] the legacy key login still works: 303 to /app, the key cookie set, any person\'s session in that browser cleared, and the console reads as the key',
     kl.status === 303 && kl.headers.get('location') === '/app' && /^agentbill_app=v2\.[0-9a-f-]{36}\.\d+\.\d+\.[0-9a-f]{64}$/.test(cookieVal(kl, 'agentbill_app'))
       && cookiesOf(kl).some((c) => /^agentbill_user=;.*Max-Age=0/.test(c)) && klHome.includes('Signed in with a key'))
  const klLogin = await fetch(`${API}/app`).then((r) => r.text())
  ok('[auth] and the console\'s sign-in card still offers it, beside the ways in', klLogin.includes('action="/app/session"') && klLogin.includes('name="api_key"') && klLogin.includes('action="/auth/email"'))

  // ------------------------------------------------------------ the log
  await settle(300)
  let logText = ''
  try { logText = readFileSync(serverLog, 'utf8') } catch {}
  const leaked = [...seen.tokens, ...seen.codes, ...seen.states].filter((t) => t && logText.includes(t))
  ok('[auth] no email-link token, OAuth code or state is in the server log, and the link path is logged as /auth/email/[redacted]',
     logText.length > 0 && leaked.length === 0 && logText.includes('/auth/email/[redacted]') && !logText.includes('/auth/google/callback?'),
     `${leaked.length} leaked`)
  ok('[auth] and no sign-in log line carries an address', !logText.split('\n').some((l) => /sign-in|signed in|sign in/i.test(l) && /auth-[a-z0-9-]+@example\.com/.test(l)))

  // Leave nothing behind but the rows the rest of the harness does not read.
  await sql`DELETE FROM email_sign_in_tokens WHERE email LIKE 'auth-%'`
  await sql`DELETE FROM developer_api_keys WHERE account_id IN (SELECT a.id FROM accounts a JOIN users u ON u.id = a.owner_user_id WHERE u.email LIKE 'auth-%')`
  await sql`DELETE FROM developer_api_keys WHERE account_id = ${vAcct.id}`
  await sql`DELETE FROM accounts WHERE owner_user_id IN (SELECT id FROM users WHERE email LIKE 'auth-%') OR id = ${vAcct.id}`
  await sql`DELETE FROM users WHERE email LIKE 'auth-%'`
  ok('[auth] the harness people and accounts are gone again',
     (await sql`SELECT count(*)::int AS n FROM users WHERE email LIKE 'auth-%'`)[0].n === 0)
}
