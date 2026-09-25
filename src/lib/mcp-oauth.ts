import { createHash, randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import type { FastifyBaseLogger } from 'fastify'
import { sql } from '../db/index.js'
import { ORIGIN } from '../ui/site.js'
import { createLimiter } from './rate-limiter.js'
import { safeEqual } from './session-secret.js'
import { urlProblem, getJsonOnce, guardedLookup } from './webhook-target.js'

// agentbill.dev as the OAuth 2.1 authorization server for its own remote MCP
// endpoint, 2026-09-25. Written against the MCP authorization specification,
// revision 2026-07-28 (modelcontextprotocol.io/specification/2026-07-28/basic/
// authorization, read that day), and the RFCs it names:
//
//   RFC 9728  protected resource metadata, and the 401 that points at it
//   RFC 8414  authorization server metadata
//   RFC 7591  dynamic client registration (deprecated in the MCP spec, kept
//             for the clients that still use it: Cursor, VS Code, Antigravity)
//   CIMD      client ID metadata documents (draft-ietf-oauth-client-id-
//             metadata-document-00), which the spec says servers SHOULD support
//   RFC 8707  resource indicators: every token is bound to the one resource
//   RFC 9207  the iss parameter on the authorization response
//   RFC 7009  token revocation
//
// Tokens are opaque and random. Nothing a client holds is stored: codes,
// access tokens, refresh tokens and client secrets are kept as SHA-256 only
// (migration 024). A token is recognised by its prefix, which is also how /mcp
// tells one apart from an API key (agb_ and 48 hex, src/middleware/auth.ts).
//
// Scopes, deliberately two:
//   agentbill:read   the read tools: a job's status, jobs ranked by spend, the
//                    recent refusals. Reads only.
//   agentbill:meter  preflight and record_event: reserve units against a job's
//                    ceiling (and open a job with one), and record what a call
//                    used. It spends the account's monthly preflight quota.
// Nothing any scope reaches can create or show an API key, change a plan,
// touch billing, or change an existing job's ceiling.

// ---------------------------------------------------------------------------
// Where we are
// ---------------------------------------------------------------------------

/**
 * The public origin tokens are bound to and metadata names. agentbill.dev in
 * production, always. Outside production MCP_PUBLIC_ORIGIN may move it, because
 * the harness serves on localhost and a real MCP client (the SDK's, in the
 * end-to-end gate) refuses metadata whose resource is not the URL it dialled.
 */
export function publicOrigin(): string {
  const o = process.env.MCP_PUBLIC_ORIGIN
  if (process.env.NODE_ENV !== 'production' && o && /^https?:\/\/[^/]+$/.test(o)) return o
  return ORIGIN
}
export const issuer = (): string => publicOrigin()
export const mcpResource = (): string => `${publicOrigin()}/mcp`
export const resourceMetadataUrl = (): string => `${publicOrigin()}/.well-known/oauth-protected-resource/mcp`

export const SCOPES = ['agentbill:read', 'agentbill:meter'] as const
export type Scope = (typeof SCOPES)[number]
export const ALL_SCOPES = SCOPES.join(' ')

/** What each scope lets a connected app do, in the words the consent page uses. */
export const SCOPE_TEXT: Record<Scope, { title: string; can: string }> = {
  'agentbill:read': {
    title: 'Read your jobs and refusals',
    can: 'See each job, its ceiling and what it used, jobs ranked by what they used, and the calls that were refused.',
  },
  'agentbill:meter': {
    title: 'Ask preflight and record usage',
    can: 'Ask preflight before a call, which reserves units against a job\'s ceiling and counts against your monthly preflight calls, open a new job with a ceiling that way, and record what a call used.',
  },
}

/** The value every 401 on /mcp carries (RFC 9728 section 5.1, RFC 6750 section 3). */
export function challenge(error?: { code: 'invalid_token' | 'insufficient_scope'; description: string; scope?: string }): string {
  const parts = [`resource_metadata="${resourceMetadataUrl()}"`, `scope="${error?.scope ?? ALL_SCOPES}"`]
  if (error) parts.push(`error="${error.code}"`, `error_description="${error.description.replace(/["\\]/g, '')}"`)
  return `Bearer ${parts.join(', ')}`
}

export function protectedResourceMetadata() {
  return {
    resource: mcpResource(),
    authorization_servers: [issuer()],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'AgentBill',
    resource_documentation: `${publicOrigin()}/integrations/mcp`,
  }
}

// Endpoints. The authorization endpoint is under /app because the person's
// session cookie is scoped Path=/app (src/lib/user-session.ts): anywhere else
// the browser would not send it, and the consent page could not see who is
// asking. Nothing else here reads a cookie.
export function authorizationServerMetadata() {
  const o = issuer()
  return {
    issuer: o,
    authorization_endpoint: `${o}/app/oauth/authorize`,
    token_endpoint: `${o}/oauth/token`,
    registration_endpoint: `${o}/oauth/register`,
    revocation_endpoint: `${o}/oauth/revoke`,
    scopes_supported: [...SCOPES],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    // S256 and nothing else. `plain` is not listed, and a request that asks
    // for it, or sends no challenge at all, is refused.
    code_challenge_methods_supported: ['S256'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${o}/integrations/mcp`,
  }
}

// ---------------------------------------------------------------------------
// Secrets: minted once, stored hashed
// ---------------------------------------------------------------------------

export const sha256 = (v: string): string => createHash('sha256').update(v).digest('hex')
const mint = (prefix: string, bytes = 32) => prefix + randomBytes(bytes).toString('hex')

const ACCESS_PREFIX = 'agbo_'
const REFRESH_PREFIX = 'agbr_'
const CODE_PREFIX = 'agbc_'
const CLIENT_PREFIX = 'agbcl_'
const SECRET_PREFIX = 'agbcs_'
export const ACCESS_TOKEN_SHAPE = /^agbo_[0-9a-f]{64}$/
const REFRESH_SHAPE = /^agbr_[0-9a-f]{64}$/
const CODE_SHAPE = /^agbc_[0-9a-f]{64}$/
const SECRET_SHAPE = /^agbcs_[0-9a-f]{64}$/
const DCR_ID_SHAPE = /^agbcl_[0-9a-f]{32}$/
/** Every secret this file mints, for the harness's log and output scans. */
export const OAUTH_SECRET_RE = /agb(?:o|r|c|cs)_[0-9a-f]{64}/g

export const ACCESS_TTL_S = 3600
const REFRESH_TTL_DAYS = 30
const CODE_TTL_S = 300
const REQUEST_TTL_S = 600

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const envInt = (name: string, fallback: number): number => {
  const n = Number(process.env[name])
  return Number.isInteger(n) && n > 0 ? n : fallback
}

// Per network (limiterKey). Registration is the endpoint anyone can call to
// make a row, so it is the tightest: ten an hour is more than any person
// connecting apps needs and far less than a flood wants.
export const REGISTER_PER_HOUR = envInt('OAUTH_REGISTER_PER_HOUR', 10)
export const TOKEN_PER_MINUTE = envInt('OAUTH_TOKEN_PER_MINUTE', 30)
const AUTHORIZE_PER_MINUTE = envInt('OAUTH_AUTHORIZE_PER_MINUTE', 30)
const CIMD_FETCH_PER_MINUTE = envInt('OAUTH_CIMD_FETCH_PER_MINUTE', 10)
/**
 * Registrations that never completed an authorization, across everyone. Past
 * this, registration answers 429 until the daily prune makes room: the table
 * cannot be grown past a known size by any number of networks.
 */
export const MAX_UNUSED_CLIENTS = envInt('OAUTH_MAX_UNUSED_CLIENTS', 2000)

export const registerLimiter = createLimiter({ max: REGISTER_PER_HOUR, windowMs: 60 * 60_000, maxEntries: 20_000 })
export const tokenLimiter = createLimiter({ max: TOKEN_PER_MINUTE, windowMs: 60_000, maxEntries: 20_000 })
export const authorizeLimiter = createLimiter({ max: AUTHORIZE_PER_MINUTE, windowMs: 60_000, maxEntries: 20_000 })
const cimdLimiter = createLimiter({ max: CIMD_FETCH_PER_MINUTE, windowMs: 60_000, maxEntries: 20_000 })

// ---------------------------------------------------------------------------
// Redirect URIs
// ---------------------------------------------------------------------------

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
const isLoopbackUrl = (u: URL) => u.protocol === 'http:' && LOOPBACK.has(u.hostname)

/**
 * Why a redirect URI cannot be registered, or null. https with a real host,
 * or http on a loopback address for a native client (OAuth 2.1 section 8.4.2,
 * RFC 8252 section 7.3). No fragment, no userinfo, nothing that is not a URL.
 * Custom schemes are refused: the MCP spec says every redirect URI is either
 * localhost or https.
 */
export function redirectProblem(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length < 8 || raw.length > 512) return 'a redirect URI is 8 to 512 characters'
  let u: URL
  try { u = new URL(raw) } catch { return 'not a valid URL' }
  if (u.hash || raw.includes('#')) return 'a redirect URI may not carry a fragment'
  if (u.username || u.password) return 'a redirect URI may not carry a username or password'
  if (isLoopbackUrl(u)) return null
  if (u.protocol !== 'https:') return 'a redirect URI must use https, or http on localhost or 127.0.0.1'
  if (!u.hostname.includes('.') && isIP(u.hostname.replace(/^\[|\]$/g, '')) === 0) return 'a redirect URI must name a fully qualified host'
  return null
}

/**
 * The registered URI the presented one matches, or null. Exact string match,
 * with the one exception OAuth 2.1 requires of a server: a loopback redirect
 * may name any port at request time, because a native app binds whatever port
 * is free. Everything else about it (scheme, host, path, query) still matches
 * exactly.
 */
export function matchRedirect(registered: readonly string[], presented: unknown): string | null {
  if (typeof presented !== 'string' || !presented) return null
  if (registered.includes(presented)) return presented
  let p: URL
  try { p = new URL(presented) } catch { return null }
  if (!isLoopbackUrl(p)) return null
  for (const r of registered) {
    let u: URL
    try { u = new URL(r) } catch { continue }
    if (!isLoopbackUrl(u)) continue
    if (u.hostname === p.hostname && u.pathname === p.pathname && u.search === p.search && !p.hash) return presented
  }
  return null
}

export const redirectHost = (uri: string): string => { try { return new URL(uri).host } catch { return '' } }
export const redirectOrigin = (uri: string): string => { try { return new URL(uri).origin } catch { return '' } }
export const isLoopbackRedirect = (uri: string): boolean => { try { return isLoopbackUrl(new URL(uri)) } catch { return false } }

// ---------------------------------------------------------------------------
// Scope and resource
// ---------------------------------------------------------------------------

/** The scopes asked for, or null when one is not ours. Empty asks for all. */
export function parseScope(raw: unknown): Scope[] | null {
  if (raw === undefined || raw === null || raw === '') return [...SCOPES]
  if (typeof raw !== 'string' || raw.length > 200) return null
  const asked = raw.split(' ').filter(Boolean)
  if (!asked.length) return [...SCOPES]
  if (!asked.every((s) => (SCOPES as readonly string[]).includes(s))) return null
  return SCOPES.filter((s) => asked.includes(s))
}
export const scopeList = (s: string): Scope[] => SCOPES.filter((x) => s.split(' ').includes(x))

/**
 * Whether a `resource` parameter names this MCP server. There is one resource,
 * so there is one right answer. Scheme and host compare case-insensitively (the
 * spec asks servers to accept an uppercase host); the path does not, and a
 * trailing slash is a different URI. Absent is read as this server, the only
 * resource we issue for, and the token is bound to it all the same.
 */
export function resourceOk(raw: unknown): boolean {
  if (raw === undefined || raw === null || raw === '') return true
  if (typeof raw !== 'string' || raw.length > 512) return false
  let u: URL
  try { u = new URL(raw) } catch { return false }
  const want = new URL(mcpResource())
  return !u.hash && !u.search && u.protocol === want.protocol && u.host === want.host && u.pathname === want.pathname
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

export interface Client {
  clientId: string
  kind: 'dcr' | 'cimd'
  clientName: string | null
  clientUri: string | null
  redirectUris: string[]
  tokenEndpointAuthMethod: 'none' | 'client_secret_post' | 'client_secret_basic'
  clientSecretHash: string | null
  scope: string
  fetchedAt: Date | null
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g
/** A name a client chose, made safe to hold: no control or direction characters, 200 at most. */
const cleanName = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const s = v.replace(CONTROL, '').replace(/\s+/g, ' ').trim().slice(0, 200)
  return s || null
}

const AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'] as const

export type RegisterResult = { status: number; body: Record<string, unknown> }

/** Drop registrations nobody used within a day, and every expired request, code and token. */
export async function pruneOAuth(): Promise<void> {
  await sql`
    DELETE FROM oauth_clients c
    WHERE c.kind = 'dcr' AND c.last_used_at IS NULL AND c.created_at < now() - INTERVAL '24 hours'
      AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.client_id)
  `
  await sql`DELETE FROM oauth_requests WHERE expires_at < now() - INTERVAL '1 hour'`
  await sql`DELETE FROM oauth_codes WHERE expires_at < now() - INTERVAL '1 day'`
  await sql`DELETE FROM oauth_tokens WHERE expires_at < now() - INTERVAL '1 day'`
}

/**
 * POST /oauth/register (RFC 7591). The caller's network has already been
 * counted. Answers 201 with the client, or 400 with the RFC's error codes.
 */
export async function registerClient(body: unknown): Promise<RegisterResult> {
  const bad = (error: string, description: string): RegisterResult => ({ status: 400, body: { error, error_description: description } })
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('invalid_client_metadata', 'The body must be a JSON object.')
  const b = body as Record<string, unknown>
  const uris = b.redirect_uris
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > 10) return bad('invalid_redirect_uri', 'redirect_uris must list 1 to 10 URIs.')
  for (const u of uris) {
    const why = redirectProblem(u)
    if (why) return bad('invalid_redirect_uri', why)
  }
  const method = b.token_endpoint_auth_method ?? 'client_secret_basic'
  if (typeof method !== 'string' || !(AUTH_METHODS as readonly string[]).includes(method)) {
    return bad('invalid_client_metadata', 'token_endpoint_auth_method must be none, client_secret_post or client_secret_basic.')
  }
  const grants = b.grant_types ?? ['authorization_code']
  if (!Array.isArray(grants) || !grants.every((g) => g === 'authorization_code' || g === 'refresh_token') || !grants.includes('authorization_code')) {
    return bad('invalid_client_metadata', 'grant_types may be authorization_code and refresh_token, and must include authorization_code.')
  }
  const responses = b.response_types ?? ['code']
  if (!Array.isArray(responses) || responses.length !== 1 || responses[0] !== 'code') {
    return bad('invalid_client_metadata', 'response_types must be ["code"].')
  }
  const scopes = parseScope(b.scope)
  if (!scopes) return bad('invalid_client_metadata', `scope may name only ${ALL_SCOPES}.`)
  let clientUri: string | null = null
  if (b.client_uri !== undefined && b.client_uri !== null) {
    if (typeof b.client_uri !== 'string' || b.client_uri.length > 512 || !/^https:\/\//.test(b.client_uri)) {
      return bad('invalid_client_metadata', 'client_uri must be an https URL.')
    }
    clientUri = b.client_uri
  }

  await pruneOAuth()
  const [unused] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM oauth_clients WHERE kind = 'dcr' AND last_used_at IS NULL`
  if ((unused?.n ?? 0) >= MAX_UNUSED_CLIENTS) {
    return { status: 429, body: { error: 'temporarily_unavailable', error_description: 'Registration is at capacity. Try again later.' } }
  }

  const clientId = mint(CLIENT_PREFIX, 16)
  const secret = method === 'none' ? null : mint(SECRET_PREFIX)
  const name = cleanName(b.client_name)
  const scope = scopes.join(' ')
  const [row] = await sql`
    INSERT INTO oauth_clients (client_id, kind, client_name, client_uri, redirect_uris, token_endpoint_auth_method, client_secret_hash, scope)
    VALUES (${clientId}, 'dcr', ${name}, ${clientUri}, ${uris as string[]}, ${method}, ${secret ? sha256(secret) : null}, ${scope})
    RETURNING created_at
  `
  return {
    status: 201,
    body: {
      client_id: clientId,
      client_id_issued_at: Math.floor(new Date(row.createdAt as Date).getTime() / 1000),
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_name: name ?? undefined,
      client_uri: clientUri ?? undefined,
      redirect_uris: uris,
      token_endpoint_auth_method: method,
      grant_types: grants,
      response_types: ['code'],
      scope,
    },
  }
}

const rowToClient = (r: Record<string, unknown>): Client => ({
  clientId: r.clientId as string,
  kind: r.kind as Client['kind'],
  clientName: (r.clientName as string | null) ?? null,
  clientUri: (r.clientUri as string | null) ?? null,
  redirectUris: r.redirectUris as string[],
  tokenEndpointAuthMethod: r.tokenEndpointAuthMethod as Client['tokenEndpointAuthMethod'],
  clientSecretHash: (r.clientSecretHash as string | null) ?? null,
  scope: r.scope as string,
  fetchedAt: (r.fetchedAt as Date | null) ?? null,
})

async function storedClient(clientId: string): Promise<Client | null> {
  const [r] = await sql`SELECT * FROM oauth_clients WHERE client_id = ${clientId}`
  return r ? rowToClient(r) : null
}

/** Whether a client_id is shaped like a Client ID Metadata Document URL. */
export const isCimdId = (v: string): boolean => /^https:\/\//.test(v) || isCimdTestUrl(v)

/**
 * Outside production the harness serves a metadata document from a local
 * http server, which the guarded fetch below refuses by design (loopback, not
 * https). OAUTH_CIMD_TEST_ORIGIN names that one origin; production never reads
 * it, so there a client_id is fetched through the guard or not at all.
 */
function isCimdTestUrl(v: string): boolean {
  const o = process.env.OAUTH_CIMD_TEST_ORIGIN
  return process.env.NODE_ENV !== 'production' && !!o && /^http:\/\/127\.0\.0\.1:\d+$/.test(o) && v.startsWith(`${o}/`)
}

const CIMD_MAX_BYTES = 8 * 1024
const CIMD_REFRESH_MS = 60 * 60_000

/** Why this URL may not be a client_id, or null. The draft's rules plus our outbound ones. */
function cimdUrlProblem(id: string): string | null {
  if (id.length > 512) return 'the client_id URL is longer than 512 characters'
  if (isCimdTestUrl(id)) return null
  const p = urlProblem(id)
  if ('reason' in p) return p.reason
  if (p.url.hash || id.includes('#')) return 'the client_id URL may not carry a fragment'
  if (p.url.search) return 'the client_id URL may not carry a query'
  if (p.url.pathname === '/' || !p.url.pathname) return 'the client_id URL must have a path'
  if (p.url.port && p.url.port !== '443') return 'the client_id URL must use the default port'
  const host = p.url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) return 'the client_id URL must name a host, not an address'
  // A name, not an address: urlProblem has held it to the hostname rules, and
  // the addresses it resolves to are checked where they are dialled
  // (guardedLookup). isPrivateAddress takes an IP, and called here on a name it
  // refused every public client_id, claude.ai's included (2026-09-25).
  return null
}

async function fetchCimd(id: string): Promise<{ ok: true; json: unknown } | { ok: false; reason: string }> {
  if (isCimdTestUrl(id)) {
    try {
      const r = await fetch(id, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
      if (r.status !== 200) return { ok: false, reason: `answered ${r.status}` }
      const text = await r.text()
      if (text.length > CIMD_MAX_BYTES) return { ok: false, reason: 'too large' }
      return { ok: true, json: JSON.parse(text) }
    } catch { return { ok: false, reason: 'fetch failed' } }
  }
  return getJsonOnce(id, { lookup: guardedLookup, maxBytes: CIMD_MAX_BYTES })
}

export type ClientLookup = { ok: true; client: Client } | { ok: false; reason: string }

/**
 * The client named by `clientId`: a registration, or a metadata document that
 * is fetched now if we have none or ours is more than an hour old. `network`
 * counts the fetch, so nobody can make this server fetch URLs in a loop.
 */
export async function lookupClient(clientId: unknown, network: string, log: FastifyBaseLogger): Promise<ClientLookup> {
  if (typeof clientId !== 'string' || !clientId) return { ok: false, reason: 'client_id is missing' }
  if (DCR_ID_SHAPE.test(clientId)) {
    const c = await storedClient(clientId)
    return c ? { ok: true, client: c } : { ok: false, reason: 'this client_id is not registered here' }
  }
  if (!isCimdId(clientId)) return { ok: false, reason: 'this client_id is not registered here' }
  const why = cimdUrlProblem(clientId)
  if (why) return { ok: false, reason: why }
  const cached = await storedClient(clientId)
  if (cached && cached.fetchedAt && Date.now() - cached.fetchedAt.getTime() < CIMD_REFRESH_MS) return { ok: true, client: cached }
  if (!cimdLimiter.hit(network).allowed) {
    return cached ? { ok: true, client: cached } : { ok: false, reason: 'too many client metadata fetches from this network' }
  }
  const got = await fetchCimd(clientId)
  if (!got.ok) {
    log.warn({ reason: got.reason }, 'oauth client metadata document could not be fetched')
    return { ok: false, reason: `the client metadata document could not be read (${got.reason})` }
  }
  const doc = got.json as Record<string, unknown> | null
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, reason: 'the client metadata document is not a JSON object' }
  if (doc.client_id !== clientId) return { ok: false, reason: 'the document\'s client_id is not its own URL' }
  const uris = doc.redirect_uris
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > 10 || uris.some((u) => redirectProblem(u))) {
    return { ok: false, reason: 'the document\'s redirect_uris are missing or not acceptable' }
  }
  const method = doc.token_endpoint_auth_method ?? 'none'
  if (method !== 'none') return { ok: false, reason: 'only token_endpoint_auth_method none is supported for a metadata document client' }
  const name = cleanName(doc.client_name)
  const clientUri = typeof doc.client_uri === 'string' && /^https:\/\//.test(doc.client_uri) && doc.client_uri.length <= 512 ? doc.client_uri : null
  const [r] = await sql`
    INSERT INTO oauth_clients (client_id, kind, client_name, client_uri, redirect_uris, token_endpoint_auth_method, scope, fetched_at)
    VALUES (${clientId}, 'cimd', ${name}, ${clientUri}, ${uris as string[]}, 'none', ${ALL_SCOPES}, now())
    ON CONFLICT (client_id) DO UPDATE SET client_name = EXCLUDED.client_name, client_uri = EXCLUDED.client_uri,
      redirect_uris = EXCLUDED.redirect_uris, fetched_at = now()
    RETURNING *
  `
  return { ok: true, client: rowToClient(r) }
}

/**
 * Client authentication at the token and revocation endpoints. A public
 * client names itself; a confidential one proves it with its secret, in the
 * body or in a Basic header, compared by hash in constant time.
 */
export async function authenticateClient(
  body: Record<string, unknown>, authorization: string | undefined, network: string, log: FastifyBaseLogger,
): Promise<ClientLookup> {
  let id = typeof body.client_id === 'string' ? body.client_id : ''
  let secret = typeof body.client_secret === 'string' ? body.client_secret : ''
  const basic = /^basic\s+(.+)$/i.exec(authorization ?? '')
  if (basic) {
    let decoded = ''
    try { decoded = Buffer.from(basic[1].trim(), 'base64').toString('utf8') } catch { /* refused below */ }
    const colon = decoded.indexOf(':')
    if (colon < 0) return { ok: false, reason: 'malformed Basic credentials' }
    try {
      const bid = decodeURIComponent(decoded.slice(0, colon))
      const bsecret = decodeURIComponent(decoded.slice(colon + 1))
      if (id && id !== bid) return { ok: false, reason: 'two different client_ids' }
      id = bid; secret = bsecret
    } catch { return { ok: false, reason: 'malformed Basic credentials' } }
  }
  const found = await lookupClient(id, network, log)
  if (!found.ok) return found
  const c = found.client
  if (c.tokenEndpointAuthMethod === 'none') return found
  if (!SECRET_SHAPE.test(secret) || !c.clientSecretHash || !safeEqual(sha256(secret), c.clientSecretHash)) {
    return { ok: false, reason: 'client authentication failed' }
  }
  return found
}

// ---------------------------------------------------------------------------
// Authorization requests, waiting for a person
// ---------------------------------------------------------------------------

export interface PendingRequest {
  id: string
  clientId: string
  redirectUri: string
  state: string | null
  codeChallenge: string
  scope: string
  resource: string
}

export const REQUEST_ID_SHAPE = /^[A-Za-z0-9_-]{32}$/
export const CHALLENGE_SHAPE = /^[A-Za-z0-9_-]{43}$/

export async function createRequest(r: Omit<PendingRequest, 'id'>): Promise<string> {
  const id = randomBytes(24).toString('base64url')
  await sql`
    INSERT INTO oauth_requests (id, client_id, redirect_uri, state, code_challenge, scope, resource, expires_at)
    VALUES (${id}, ${r.clientId}, ${r.redirectUri}, ${r.state}, ${r.codeChallenge}, ${r.scope}, ${r.resource},
            now() + (${REQUEST_TTL_S} * INTERVAL '1 second'))
  `
  return id
}

const toRequest = (r: Record<string, unknown>): PendingRequest => ({
  id: r.id as string, clientId: r.clientId as string, redirectUri: r.redirectUri as string, state: (r.state as string | null) ?? null,
  codeChallenge: r.codeChallenge as string, scope: r.scope as string, resource: r.resource as string,
})

/** A live request, read only: the consent page may be reloaded. */
export async function loadRequest(id: unknown): Promise<PendingRequest | null> {
  if (typeof id !== 'string' || !REQUEST_ID_SHAPE.test(id)) return null
  const [r] = await sql`SELECT * FROM oauth_requests WHERE id = ${id} AND consumed_at IS NULL AND expires_at > now()`
  return r ? toRequest(r) : null
}

/** Spend a request: the check and the write in one statement, by the database clock. */
export async function consumeRequest(id: unknown): Promise<PendingRequest | null> {
  if (typeof id !== 'string' || !REQUEST_ID_SHAPE.test(id)) return null
  const [r] = await sql`
    UPDATE oauth_requests SET consumed_at = now()
    WHERE id = ${id} AND consumed_at IS NULL AND expires_at > now()
    RETURNING *
  `
  return r ? toRequest(r) : null
}

// ---------------------------------------------------------------------------
// Codes and tokens
// ---------------------------------------------------------------------------

export async function issueCode(req: PendingRequest, userId: string, accountId: string, clientName: string | null): Promise<string> {
  const code = mint(CODE_PREFIX)
  await sql`
    INSERT INTO oauth_codes (code_hash, client_id, user_id, account_id, redirect_uri, code_challenge, scope, resource, client_name, expires_at)
    VALUES (${sha256(code)}, ${req.clientId}, ${userId}, ${accountId}, ${req.redirectUri}, ${req.codeChallenge}, ${req.scope},
            ${req.resource}, ${clientName}, now() + (${CODE_TTL_S} * INTERVAL '1 second'))
  `
  return code
}

// The same loose type src/lib/reservations.ts gives a transaction handle.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any

async function issueTokens(tx: Tx, grantId: string, scope: string) {
  const access = mint(ACCESS_PREFIX)
  const refresh = mint(REFRESH_PREFIX)
  await tx`
    INSERT INTO oauth_tokens (token_hash, grant_id, kind, expires_at) VALUES
      (${sha256(access)}, ${grantId}, 'access', now() + (${ACCESS_TTL_S} * INTERVAL '1 second')),
      (${sha256(refresh)}, ${grantId}, 'refresh', now() + (${REFRESH_TTL_DAYS} * INTERVAL '1 day'))
  `
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope }
}

export type TokenResult = { status: number; body: Record<string, unknown> }
const tokenError = (error: string, description: string, status = 400): TokenResult => ({ status, body: { error, error_description: description } })

async function revokeGrant(grantId: string, reason: 'user' | 'refresh_reuse' | 'code_reuse' | 'client', q: Tx = sql) {
  await q`UPDATE oauth_grants SET revoked_at = now(), revoked_reason = ${reason} WHERE id = ${grantId} AND revoked_at IS NULL`
  await q`UPDATE oauth_tokens SET revoked_at = now() WHERE grant_id = ${grantId} AND revoked_at IS NULL`
}

const VERIFIER_SHAPE = /^[A-Za-z0-9._~-]{43,128}$/

/** grant_type=authorization_code, for a client already authenticated. */
export async function exchangeCode(client: Client, body: Record<string, unknown>, log: FastifyBaseLogger): Promise<TokenResult> {
  const code = typeof body.code === 'string' ? body.code : ''
  if (!CODE_SHAPE.test(code)) return tokenError('invalid_grant', 'The authorization code is not valid.')
  const verifier = typeof body.code_verifier === 'string' ? body.code_verifier : ''
  if (!verifier) return tokenError('invalid_request', 'code_verifier is required: this server requires PKCE.')
  const hash = sha256(code)
  return sql.begin(async (tx) => {
    const [row] = await tx`
      UPDATE oauth_codes SET consumed_at = now()
      WHERE code_hash = ${hash} AND consumed_at IS NULL
      RETURNING *, (expires_at > now()) AS live
    `
    if (!row) {
      // Spent already: somebody is presenting a code a second time. Whatever
      // the first exchange issued is revoked (RFC 6749 section 4.1.2).
      const [spent] = await tx`SELECT grant_id FROM oauth_codes WHERE code_hash = ${hash}`
      if (spent?.grantId) {
        await revokeGrant(spent.grantId as string, 'code_reuse', tx)
        log.warn({ clientId: client.clientId }, 'oauth code presented twice: its grant is revoked')
      }
      return tokenError('invalid_grant', 'The authorization code is not valid.')
    }
    // Every check after the code is spent: a failed attempt burns it, so a
    // stolen code cannot be retried against guessed verifiers.
    if (!row.live) return tokenError('invalid_grant', 'The authorization code has expired.')
    if (row.clientId !== client.clientId) return tokenError('invalid_grant', 'The authorization code was issued to another client.')
    if (body.redirect_uri !== row.redirectUri) return tokenError('invalid_grant', 'redirect_uri does not match the authorization request.')
    if (!VERIFIER_SHAPE.test(verifier) || createHash('sha256').update(verifier).digest('base64url') !== row.codeChallenge) {
      return tokenError('invalid_grant', 'code_verifier does not match the code_challenge.')
    }
    if (body.resource !== undefined && (!resourceOk(body.resource) || !body.resource)) {
      return tokenError('invalid_target', `resource must be ${mcpResource()}.`)
    }
    const [grant] = await tx`
      INSERT INTO oauth_grants (client_id, user_id, account_id, scope, resource, client_name, redirect_host)
      VALUES (${row.clientId}, ${row.userId}, ${row.accountId}, ${row.scope}, ${row.resource}, ${row.clientName ?? null}, ${redirectHost(row.redirectUri as string)})
      RETURNING id
    `
    await tx`UPDATE oauth_codes SET grant_id = ${grant.id} WHERE code_hash = ${hash}`
    await tx`UPDATE oauth_clients SET last_used_at = now() WHERE client_id = ${client.clientId}`
    return { status: 200, body: await issueTokens(tx, grant.id as string, row.scope as string) }
  })
}

/**
 * grant_type=refresh_token. Rotating: the presented token is spent and a new
 * pair is issued. A spent or revoked refresh token presented again means two
 * parties hold it, and the whole grant is revoked (OAuth 2.1 section 4.3.1).
 */
export async function refreshGrant(client: Client, body: Record<string, unknown>, log: FastifyBaseLogger): Promise<TokenResult> {
  const token = typeof body.refresh_token === 'string' ? body.refresh_token : ''
  if (!REFRESH_SHAPE.test(token)) return tokenError('invalid_grant', 'The refresh token is not valid.')
  const hash = sha256(token)
  return sql.begin(async (tx) => {
    const [row] = await tx`
      SELECT t.grant_id, t.rotated_at, t.revoked_at, (t.expires_at <= now()) AS expired,
             g.client_id, g.scope, g.revoked_at AS grant_revoked_at, g.account_id, g.user_id,
             (a.owner_user_id = g.user_id) AS still_owner
      FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id JOIN accounts a ON a.id = g.account_id
      WHERE t.token_hash = ${hash} AND t.kind = 'refresh'
      FOR UPDATE OF t
    `
    if (!row) return tokenError('invalid_grant', 'The refresh token is not valid.')
    if (row.clientId !== client.clientId) return tokenError('invalid_grant', 'The refresh token was issued to another client.')
    if (row.grantRevokedAt) return tokenError('invalid_grant', 'This connection was disconnected.')
    if (row.rotatedAt || row.revokedAt) {
      await revokeGrant(row.grantId as string, 'refresh_reuse', tx)
      log.warn({ clientId: client.clientId }, 'oauth refresh token presented after it was spent: its grant is revoked')
      return tokenError('invalid_grant', 'The refresh token was already used. This connection is now disconnected; connect it again.')
    }
    if (row.expired) return tokenError('invalid_grant', 'The refresh token has expired.')
    if (!row.stillOwner) return tokenError('invalid_grant', 'The account this connection was made for has a different owner now.')
    if (body.resource !== undefined && (!resourceOk(body.resource) || !body.resource)) {
      return tokenError('invalid_target', `resource must be ${mcpResource()}.`)
    }
    // A narrower scope may be asked for; never a wider one.
    let scope = row.scope as string
    if (body.scope !== undefined) {
      const asked = parseScope(body.scope)
      const held = scopeList(row.scope as string)
      if (!asked || !asked.every((s) => held.includes(s))) return tokenError('invalid_scope', 'A refresh may not widen the scope.')
      scope = asked.join(' ')
    }
    await tx`UPDATE oauth_tokens SET rotated_at = now() WHERE token_hash = ${hash}`
    // The access tokens minted beside the spent refresh token die with it, so
    // at most one live pair exists per grant.
    await tx`UPDATE oauth_tokens SET revoked_at = now() WHERE grant_id = ${row.grantId} AND kind = 'access' AND revoked_at IS NULL`
    if (scope !== row.scope) await tx`UPDATE oauth_grants SET scope = ${scope} WHERE id = ${row.grantId}`
    return { status: 200, body: await issueTokens(tx, row.grantId as string, scope) }
  })
}

/**
 * RFC 7009. A refresh token revokes its whole grant; an access token only
 * itself. A token that is not ours, or not this client's, is answered 200 all
 * the same, as the RFC says, and nothing changes.
 */
export async function revokeToken(client: Client, token: unknown): Promise<void> {
  if (typeof token !== 'string') return
  const hash = sha256(token)
  const [row] = await sql`
    SELECT t.kind, t.grant_id, g.client_id FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
    WHERE t.token_hash = ${hash}
  `
  if (!row || row.clientId !== client.clientId) return
  if (row.kind === 'refresh') await revokeGrant(row.grantId as string, 'client')
  else await sql`UPDATE oauth_tokens SET revoked_at = now() WHERE token_hash = ${hash} AND revoked_at IS NULL`
}

export type AccessVerdict =
  | { ok: true; accountId: string; grantId: string; clientId: string; scopes: Scope[] }
  | { ok: false; description: string; unknown: boolean }

/**
 * An access token presented to /mcp. Every rule is decided in SQL against the
 * database clock, the rule src/middleware/auth.ts keeps for keys: unexpired,
 * not revoked, its grant not disconnected, issued for THIS resource, and the
 * person who approved it still owning the account.
 */
export async function verifyAccessToken(token: string): Promise<AccessVerdict> {
  if (!ACCESS_TOKEN_SHAPE.test(token)) return { ok: false, description: 'The access token is not valid.', unknown: true }
  const [row] = await sql`
    SELECT g.id AS grant_id, g.account_id, g.client_id, g.scope, g.resource,
           (t.expires_at <= now()) AS expired, (t.revoked_at IS NOT NULL) AS revoked,
           (g.revoked_at IS NOT NULL) AS disconnected, (a.owner_user_id IS NOT DISTINCT FROM g.user_id) AS still_owner
    FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id JOIN accounts a ON a.id = g.account_id
    WHERE t.token_hash = ${sha256(token)} AND t.kind = 'access'
  `
  if (!row) return { ok: false, description: 'The access token is not valid.', unknown: true }
  if (row.revoked || row.disconnected) return { ok: false, description: 'The access token was revoked.', unknown: false }
  if (row.expired) return { ok: false, description: 'The access token has expired.', unknown: false }
  if (row.resource !== mcpResource()) return { ok: false, description: 'The access token was issued for another resource.', unknown: false }
  if (!row.stillOwner) return { ok: false, description: 'The account has a different owner now.', unknown: false }
  // last_used_at for the console's list, at most once a minute per grant.
  sql`UPDATE oauth_grants SET last_used_at = now() WHERE id = ${row.grantId} AND (last_used_at IS NULL OR last_used_at < now() - INTERVAL '1 minute')`
    .catch(() => {})
  return { ok: true, accountId: row.accountId as string, grantId: row.grantId as string, clientId: row.clientId as string, scopes: scopeList(row.scope as string) }
}

// ---------------------------------------------------------------------------
// The console: connected apps
// ---------------------------------------------------------------------------

export interface ConnectedApp {
  id: string
  clientName: string | null
  clientId: string
  kind: 'dcr' | 'cimd'
  redirectHost: string
  scopes: Scope[]
  createdAt: Date
  lastUsedAt: Date | null
}

/** The live connections on an account: not disconnected, and holding a refresh token that can still be used. */
export async function connectedApps(accountId: string): Promise<ConnectedApp[]> {
  const rows = await sql`
    SELECT g.id, g.client_name, g.client_id, c.kind, g.redirect_host, g.scope, g.created_at, g.last_used_at
    FROM oauth_grants g JOIN oauth_clients c ON c.client_id = g.client_id
    WHERE g.account_id = ${accountId} AND g.revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.grant_id = g.id AND t.kind = 'refresh'
                    AND t.rotated_at IS NULL AND t.revoked_at IS NULL AND t.expires_at > now())
    ORDER BY g.created_at DESC
    LIMIT 50
  `
  return rows.map((r) => ({
    id: r.id as string, clientName: (r.clientName as string | null) ?? null, clientId: r.clientId as string, kind: r.kind as ConnectedApp['kind'],
    redirectHost: r.redirectHost as string, scopes: scopeList(r.scope as string), createdAt: r.createdAt as Date, lastUsedAt: (r.lastUsedAt as Date | null) ?? null,
  }))
}

/** Disconnect: only a grant on this account, and it takes every token with it. */
export async function disconnectApp(accountId: string, grantId: string): Promise<boolean> {
  const [g] = await sql`SELECT id FROM oauth_grants WHERE id = ${grantId} AND account_id = ${accountId} AND revoked_at IS NULL`
  if (!g) return false
  await revokeGrant(grantId, 'user')
  return true
}

let pruner: NodeJS.Timeout | null = null
/** Hourly, beside the reservation sweeper. The registration endpoint also prunes before it counts. */
export function startOAuthPruner(log: FastifyBaseLogger): void {
  if (pruner) return
  pruner = setInterval(() => { pruneOAuth().catch((err) => log.warn({ err }, 'oauth prune failed')) }, 60 * 60_000)
  pruner.unref()
}
