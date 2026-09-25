#!/usr/bin/env node
// A local stand-in for Google's and GitHub's OAuth endpoints, for the [auth]
// gates in verify.mjs. The server under test reaches it through
// OAUTH_TEST_BASE, which src/lib/oauth.ts honours only when NODE_ENV is not
// production.
//
//   node fake-oauth.mjs <port-file>
//
// Listens on an ephemeral port on 127.0.0.1 and writes the port to <port-file>.
// It behaves like the real providers in the ways the gates depend on:
//
//   - a code is single use: the second exchange of it is refused, as Google
//     and GitHub refuse it;
//   - PKCE: when /authorize carried a code_challenge, /token must carry the
//     verifier whose S256 is that challenge;
//   - redirect_uri must be exactly https://agentbill.dev/auth/<p>/callback at
//     /authorize (Google's redirect_uri_mismatch), and the same at /token;
//   - the client id and secret must be the configured pair;
//   - GitHub answers a bad code with a 200 and an `error` field.
//
// Who signs in is the harness's choice: it appends fake_user=<base64url JSON>
// to the authorize URL the server produced, e.g.
//   { sub, email, email_verified }                         Google
//   { id, login, emails: [{ email, primary, verified }] }  GitHub
// and optionally fake_nonce=<value> to make Google's id_token carry a nonce
// other than the one requested.
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'

const portFile = process.argv[2]
const EXPECT_REDIRECT = process.env.FAKE_REDIRECT_BASE ?? 'https://agentbill.dev'
const CLIENTS = {
  google: { id: process.env.GOOGLE_CLIENT_ID ?? 'fake-google-client', secret: process.env.GOOGLE_CLIENT_SECRET ?? 'fake-google-secret' },
  github: { id: process.env.GITHUB_CLIENT_ID ?? 'fake-github-client', secret: process.env.GITHUB_CLIENT_SECRET ?? 'fake-github-secret' },
}

const codes = new Map()   // code -> { provider, clientId, redirectUri, challenge, method, nonce, user, used }
const tokens = new Map()  // access token -> { provider, user }
const log = []            // every /token request, for the gates to read

const b64u = (b) => Buffer.from(b).toString('base64url')
const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}
const readBody = (req) => new Promise((resolve) => {
  let b = ''
  req.on('data', (d) => { b += d })
  req.on('end', () => resolve(b))
})

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fake')
  const [, provider, ...rest] = url.pathname.split('/')
  const path = rest.join('/')
  const base = `http://${req.headers.host}`

  if (url.pathname === '/__log') return send(res, 200, log)
  if (url.pathname === '/__reset') { log.length = 0; return send(res, 200, { ok: true }) }
  if (provider !== 'google' && provider !== 'github') return send(res, 404, { error: 'not_found' })
  const client = CLIENTS[provider]

  if (path === 'authorize' && req.method === 'GET') {
    const q = url.searchParams
    const redirectUri = q.get('redirect_uri')
    if (q.get('client_id') !== client.id) return send(res, 400, { error: 'invalid_client' })
    if (redirectUri !== `${EXPECT_REDIRECT}/auth/${provider}/callback`) return send(res, 400, { error: 'redirect_uri_mismatch', got: redirectUri })
    let user
    try { user = JSON.parse(Buffer.from(q.get('fake_user') ?? '', 'base64url').toString('utf8')) } catch { return send(res, 400, { error: 'fake_user missing' }) }
    const code = b64u(randomBytes(18))
    codes.set(code, {
      provider, clientId: client.id, redirectUri,
      challenge: q.get('code_challenge'), method: q.get('code_challenge_method'),
      nonce: q.has('fake_nonce') ? q.get('fake_nonce') : q.get('nonce'),
      scope: q.get('scope'), user, used: false,
    })
    const to = new URL(redirectUri)
    to.searchParams.set('code', code)
    to.searchParams.set('state', q.get('state') ?? '')
    res.writeHead(302, { Location: to.toString() })
    return res.end()
  }

  if (path === 'token' && req.method === 'POST') {
    const f = new URLSearchParams(await readBody(req))
    const entry = { provider, code: f.get('code'), redirect_uri: f.get('redirect_uri'), has_verifier: f.has('code_verifier'), outcome: '' }
    log.push(entry)
    const refuse = (why) => {
      entry.outcome = why
      // GitHub: 200 with an error field. Google: 400 invalid_grant.
      return provider === 'github' ? send(res, 200, { error: 'bad_verification_code', error_description: why }) : send(res, 400, { error: 'invalid_grant', error_description: why })
    }
    const c = codes.get(f.get('code') ?? '')
    if (!c) return refuse('unknown code')
    if (c.used) return refuse('code already used')
    c.used = true
    if (f.get('client_id') !== client.id || f.get('client_secret') !== client.secret) return refuse('bad client')
    if (f.get('redirect_uri') !== c.redirectUri) return refuse('redirect_uri mismatch')
    if (c.challenge) {
      const v = f.get('code_verifier') ?? ''
      if (c.method !== 'S256' || createHash('sha256').update(v).digest('base64url') !== c.challenge) return refuse('pkce mismatch')
    }
    const access = b64u(randomBytes(24))
    tokens.set(access, { provider, user: c.user })
    entry.outcome = 'ok'
    if (provider === 'github') return send(res, 200, { access_token: access, token_type: 'bearer', scope: c.scope })
    const now = Math.floor(Date.now() / 1000)
    const idt = [
      b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' })),
      b64u(JSON.stringify({ iss: `${base}/google`, aud: client.id, sub: c.user.sub, email: c.user.email,
                            email_verified: c.user.email_verified, nonce: c.nonce, iat: now, exp: now + 3600 })),
      b64u('not-a-real-signature'),
    ].join('.')
    return send(res, 200, { access_token: access, id_token: idt, token_type: 'Bearer', expires_in: 3599 })
  }

  const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '')
  const t = tokens.get(bearer)
  if (provider === 'google' && path === 'userinfo') {
    if (!t) return send(res, 401, { error: 'invalid_token' })
    const u = t.user
    return send(res, 200, { sub: u.sub, email: u.email, email_verified: u.email_verified, name: u.name ?? 'Fake User' })
  }
  if (provider === 'github' && path === 'api/user') {
    if (!t) return send(res, 401, { message: 'Bad credentials' })
    return send(res, 200, { id: t.user.id, login: t.user.login ?? 'fake' })
  }
  if (provider === 'github' && path === 'api/user/emails') {
    if (!t) return send(res, 401, { message: 'Bad credentials' })
    return send(res, 200, t.user.emails ?? [])
  }
  return send(res, 404, { error: 'not_found' })
})

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port
  if (portFile) writeFileSync(portFile, String(port))
  console.log(`fake oauth on ${port}`)
})
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => server.close(() => process.exit(0)))
