import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { sessionSecret, hmacHex, safeEqual, readCookie } from './session-secret.js'
import { ORIGIN } from '../ui/site.js'

// Sign-in with Google (OpenID Connect) and GitHub (an OAuth App), 2026-09-25.
//
// What this file decides, and why each one is here rather than in the route:
//
//   No server state. The flow's secrets (state, the PKCE verifier, Google's
//   nonce, and what the flow is for) travel in one HMAC-signed, HttpOnly,
//   ten-minute cookie scoped to /auth. The callback trusts nothing it did not
//   sign, so a flow can only be finished by the browser that started it.
//
//   The callback URL is fixed. It is <public base>/auth/<provider>/callback,
//   and the public base is ORIGIN (https://agentbill.dev) in production,
//   never the Host header: a Host the attacker chose would otherwise pick the
//   address Google sends the code to. PUBLIC_BASE_URL overrides it only when
//   NODE_ENV is not production, for a developer testing in a real browser.
//
//   Provider endpoints are constants. OAUTH_TEST_BASE points both providers at
//   a local fake (scripts/preflight/fake-oauth.mjs) and is IGNORED in
//   production, so a stray environment variable cannot route a production
//   code exchange, with the client secret in it, to somewhere else.
//
//   A provider with either half of its client pair unset does not exist: its
//   button is not drawn and its routes answer 404. Deploying this before the
//   secrets are set is therefore a no-op for both providers.
//
//   Only a verified address signs anyone in. Google: `email_verified === true`
//   from the userinfo endpoint, with the id_token's aud, iss, nonce and expiry
//   checked (it arrives over TLS straight from the token endpoint, which is
//   what OIDC Core 3.1.3.7 accepts in place of a signature check), and its
//   `sub` equal to userinfo's. GitHub: the primary address from /user/emails,
//   and only when it says `verified: true`. Anything else is refused, never
//   downgraded to "signed in with an unverified address".

export type Provider = 'google' | 'github'
export const PROVIDERS: readonly Provider[] = ['google', 'github']
export const isProvider = (v: unknown): v is Provider => v === 'google' || v === 'github'

export interface ProviderConfig {
  provider: Provider
  clientId: string
  clientSecret: string
  authUrl: string
  tokenUrl: string
  /** Google: the userinfo endpoint. */
  userinfoUrl: string
  /** GitHub: the REST API root that /user and /user/emails hang off. */
  apiBase: string
  /** Google: the issuers an id_token may name. */
  issuers: readonly string[]
  redirectUri: string
}

const isProd = (env: NodeJS.ProcessEnv) => env.NODE_ENV === 'production'

/** The origin callbacks are built on. Never the request's Host. */
export function publicBase(env: NodeJS.ProcessEnv = process.env): string {
  const o = !isProd(env) && env.PUBLIC_BASE_URL ? env.PUBLIC_BASE_URL : ORIGIN
  return o.replace(/\/+$/, '')
}

/** The endpoint override a test may set. Absent in production whatever the environment says. */
export function testBase(env: NodeJS.ProcessEnv = process.env): string | null {
  if (isProd(env)) return null
  const b = env.OAUTH_TEST_BASE
  return b ? b.replace(/\/+$/, '') : null
}

export function providerConfig(provider: Provider, env: NodeJS.ProcessEnv = process.env): ProviderConfig | null {
  const up = provider.toUpperCase()
  const clientId = env[`${up}_CLIENT_ID`]
  const clientSecret = env[`${up}_CLIENT_SECRET`]
  if (!clientId || !clientSecret) return null
  const fake = testBase(env)
  const redirectUri = `${publicBase(env)}/auth/${provider}/callback`
  if (provider === 'google') {
    return {
      provider, clientId, clientSecret, redirectUri,
      authUrl: fake ? `${fake}/google/authorize` : 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: fake ? `${fake}/google/token` : 'https://oauth2.googleapis.com/token',
      userinfoUrl: fake ? `${fake}/google/userinfo` : 'https://openidconnect.googleapis.com/v1/userinfo',
      apiBase: '',
      issuers: fake ? [`${fake}/google`] : ['https://accounts.google.com', 'accounts.google.com'],
    }
  }
  return {
    provider, clientId, clientSecret, redirectUri,
    authUrl: fake ? `${fake}/github/authorize` : 'https://github.com/login/oauth/authorize',
    tokenUrl: fake ? `${fake}/github/token` : 'https://github.com/login/oauth/access_token',
    userinfoUrl: '',
    apiBase: fake ? `${fake}/github/api` : 'https://api.github.com',
    issuers: [],
  }
}

export const configuredProviders = (env: NodeJS.ProcessEnv = process.env): Provider[] =>
  PROVIDERS.filter((p) => providerConfig(p, env) !== null)

// ---------------------------------------------------------------------------
// The flow cookie
// ---------------------------------------------------------------------------

export const FLOW_COOKIE = 'agentbill_oauth'
const FLOW_MAX_AGE = 600
const FLOW_PURPOSE = 'agentbill-oauth-flow-v1'
const FLOW_ATTRS = 'HttpOnly; Secure; SameSite=Lax; Path=/auth'

/** What one sign-in attempt is for, signed into the cookie that carries it. */
export interface Flow {
  /** provider */
  p: Provider
  /** state, compared with the callback's ?state= */
  s: string
  /** PKCE code_verifier */
  v: string
  /** OIDC nonce (Google) */
  n: string
  /** signin: find or create the person. link: add this identity to account `a`. */
  m: 'signin' | 'link'
  /** the account a link flow adds to, read from the session that started it */
  a?: string
  /** where to land afterwards, already validated to a same-host path */
  x: string
  /** expiry, unix seconds */
  e: number
}

const b64u = (n: number) => randomBytes(n).toString('base64url')
export const pkceChallenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url')

export function newFlow(p: Provider, m: Flow['m'], x: string, a?: string): Flow {
  return { p, s: b64u(24), v: b64u(32), n: b64u(24), m, ...(a ? { a } : {}), x, e: Math.floor(Date.now() / 1000) + FLOW_MAX_AGE }
}

export function flowCookie(flow: Flow): string | null {
  const secret = sessionSecret()
  if (!secret) return null
  const body = Buffer.from(JSON.stringify(flow)).toString('base64url')
  return `${FLOW_COOKIE}=${body}.${hmacHex(secret, `${FLOW_PURPOSE}.${body}`)}; ${FLOW_ATTRS}; Max-Age=${FLOW_MAX_AGE}`
}

export const CLEAR_FLOW_COOKIE = `${FLOW_COOKIE}=; ${FLOW_ATTRS}; Max-Age=0`

const FlowShape = z.object({
  p: z.enum(['google', 'github']),
  s: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
  v: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  n: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
  m: z.enum(['signin', 'link']),
  a: z.string().uuid().optional(),
  x: z.string().max(200),
  e: z.number().int(),
})

/** The flow this browser started for `provider`, if the cookie is ours, whole and unexpired. */
export function readFlow(cookieHeader: string | undefined, provider: Provider): Flow | null {
  const secret = sessionSecret()
  if (!secret) return null
  const raw = readCookie(cookieHeader ?? '', FLOW_COOKIE)
  const dot = raw.lastIndexOf('.')
  if (dot <= 0 || raw.length > 2048) return null
  const body = raw.slice(0, dot), mac = raw.slice(dot + 1)
  if (!/^[0-9a-f]{64}$/.test(mac) || !safeEqual(mac, hmacHex(secret, `${FLOW_PURPOSE}.${body}`))) return null
  let parsed: unknown
  try { parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) } catch { return null }
  const f = FlowShape.safeParse(parsed)
  if (!f.success) return null
  if (f.data.p !== provider || f.data.e < Date.now() / 1000) return null
  return f.data as Flow
}

/** The state a callback carried, compared in constant time against the flow's. */
export const stateMatches = (flow: Flow, state: unknown): boolean =>
  typeof state === 'string' && safeEqual(state, flow.s)

// ---------------------------------------------------------------------------
// The authorization request
// ---------------------------------------------------------------------------

export function authorizeUrl(cfg: ProviderConfig, flow: Flow): string {
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    state: flow.s,
    code_challenge: pkceChallenge(flow.v),
    code_challenge_method: 'S256',
  })
  if (cfg.provider === 'google') {
    q.set('response_type', 'code')
    q.set('scope', 'openid email profile')
    q.set('nonce', flow.n)
    q.set('prompt', 'select_account')
  } else {
    q.set('scope', 'read:user user:email')
    q.set('allow_signup', 'true')
  }
  return `${cfg.authUrl}?${q.toString()}`
}

// ---------------------------------------------------------------------------
// The callback: code for token, token for a verified identity
// ---------------------------------------------------------------------------

export interface VerifiedIdentity {
  provider: Provider | 'email'
  providerUserId: string
  email: string
}

export type Refusal =
  | 'token_refused'       // the provider would not exchange the code: replayed, expired, wrong verifier
  | 'bad_id_token'        // Google's id_token failed aud, iss, nonce, expiry or sub
  | 'unverified_email'    // no address the provider vouches for
  | 'provider_error'      // the provider answered something we could not read

const EmailShape = z.string().trim().toLowerCase().max(254).email()
const TIMEOUT_MS = 10_000

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text()
  if (text.length > 200_000) throw new Error('provider response too large')
  return JSON.parse(text)
}

function decodeJwtPayload(jwt: unknown): Record<string, unknown> | null {
  if (typeof jwt !== 'string' || jwt.length > 8192) return null
  const parts = jwt.split('.')
  if (parts.length !== 3) return null
  try {
    const v = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return v && typeof v === 'object' ? v as Record<string, unknown> : null
  } catch { return null }
}

export async function verifiedIdentity(cfg: ProviderConfig, code: string, flow: Flow):
    Promise<{ ok: true; id: VerifiedIdentity } | { ok: false; reason: Refusal }> {
  try {
    const tokenRes = await fetch(cfg.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        code,
        redirect_uri: cfg.redirectUri,
        grant_type: 'authorization_code',
        code_verifier: flow.v,
      }).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const tok = await readJson(tokenRes).catch(() => null) as Record<string, unknown> | null
    // GitHub answers a bad code with a 200 and an `error` field, so a status
    // alone is not the test.
    if (!tokenRes.ok || !tok || typeof tok.access_token !== 'string' || 'error' in tok) {
      return { ok: false, reason: 'token_refused' }
    }
    const access = tok.access_token
    return cfg.provider === 'google' ? await google(cfg, flow, access, tok.id_token) : await github(cfg, access)
  } catch {
    return { ok: false, reason: 'provider_error' }
  }
}

async function google(cfg: ProviderConfig, flow: Flow, access: string, idToken: unknown):
    Promise<{ ok: true; id: VerifiedIdentity } | { ok: false; reason: Refusal }> {
  const claims = decodeJwtPayload(idToken)
  const now = Date.now() / 1000
  const aud = claims?.aud
  const audOk = aud === cfg.clientId || (Array.isArray(aud) && aud.includes(cfg.clientId))
  if (!claims || !audOk || !cfg.issuers.includes(String(claims.iss))
      || typeof claims.nonce !== 'string' || !safeEqual(claims.nonce, flow.n)
      || typeof claims.exp !== 'number' || claims.exp < now
      || typeof claims.sub !== 'string' || !claims.sub) {
    return { ok: false, reason: 'bad_id_token' }
  }
  const res = await fetch(cfg.userinfoUrl, {
    headers: { Authorization: `Bearer ${access}`, Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) return { ok: false, reason: 'provider_error' }
  const info = await readJson(res) as Record<string, unknown>
  if (info?.sub !== claims.sub) return { ok: false, reason: 'bad_id_token' }
  // Strictly the boolean. A string "true", a missing field, and false are all
  // an address Google has not vouched for.
  if (info.email_verified !== true) return { ok: false, reason: 'unverified_email' }
  const email = EmailShape.safeParse(info.email)
  if (!email.success) return { ok: false, reason: 'unverified_email' }
  if (!/^[0-9A-Za-z_-]{1,255}$/.test(claims.sub)) return { ok: false, reason: 'bad_id_token' }
  return { ok: true, id: { provider: 'google', providerUserId: claims.sub, email: email.data } }
}

async function github(cfg: ProviderConfig, access: string):
    Promise<{ ok: true; id: VerifiedIdentity } | { ok: false; reason: Refusal }> {
  const headers = {
    Authorization: `Bearer ${access}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'AgentBill',
  }
  const [userRes, emailsRes] = await Promise.all([
    fetch(`${cfg.apiBase}/user`, { headers, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) }),
    fetch(`${cfg.apiBase}/user/emails`, { headers, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) }),
  ])
  if (!userRes.ok || !emailsRes.ok) return { ok: false, reason: 'provider_error' }
  const user = await readJson(userRes) as Record<string, unknown>
  const emails = await readJson(emailsRes)
  // The numeric id, never the login: a login can be renamed and then claimed
  // by somebody else.
  if (!Number.isSafeInteger(user?.id) || (user.id as number) <= 0) return { ok: false, reason: 'provider_error' }
  if (!Array.isArray(emails)) return { ok: false, reason: 'provider_error' }
  const primary = emails.find((e) => e && typeof e === 'object' && (e as Record<string, unknown>).primary === true)
  if (!primary || (primary as Record<string, unknown>).verified !== true) return { ok: false, reason: 'unverified_email' }
  const email = EmailShape.safeParse((primary as Record<string, unknown>).email)
  if (!email.success) return { ok: false, reason: 'unverified_email' }
  return { ok: true, id: { provider: 'github', providerUserId: String(user.id), email: email.data } }
}
