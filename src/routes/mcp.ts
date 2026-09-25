import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { publicRoute, authenticateKey, bearerToken, isKeyShaped } from '../middleware/auth.js'
import { limiterKey } from '../lib/client-ip.js'
import { authFailureLimiter, checkRateLimit, checkAccountRateLimit, MAX_REQUESTS, MAX_ACCOUNT_REQUESTS } from '../lib/rate-limiter.js'
import { challenge, verifyAccessToken, publicOrigin, SCOPES, type Scope } from '../lib/mcp-oauth.js'
import { buildMcpServer, TOOL_SCOPE } from '../lib/mcp-tools.js'
import { ORIGIN } from '../ui/site.js'

// https://agentbill.dev/mcp, the remote MCP endpoint, 2026-09-25.
//
// Streamable HTTP through the official TypeScript SDK (@modelcontextprotocol/
// sdk, pinned in package.json), stateless: every POST builds a server and a
// transport, answers with one JSON body, and keeps nothing. There is no
// session to hijack, fix or expire, and no memory that grows with clients.
// GET and DELETE are the old revisions' standalone stream and session end,
// which a stateless server does not have: 405, as the spec says.
//
// Two ways in, one account out:
//   Authorization: Bearer agb_...   an API key, through the same function the
//                                   REST API authenticates with (limits and
//                                   the new-network alert included). Both scopes.
//   Authorization: Bearer agbo_...  an OAuth access token from this server's
//                                   own authorization server (src/lib/
//                                   mcp-oauth.ts), bound to this resource.
//                                   The scopes the person approved.
// Anything else is a 401 carrying the WWW-Authenticate challenge that points a
// client at the protected resource metadata, which is how Claude's custom
// connector learns to start OAuth.
//
// The transport's answer is sent through Fastify, not written to the socket
// under it, so the security headers, the log line and the error handler apply
// to /mcp as to every other route.
//
// DNS rebinding and cross-site use: a request whose Origin is not this site is
// 403 (the Streamable HTTP spec's MUST), and one whose Host is not ours is 403.
// No CORS header is ever sent, so no other origin can read an answer.

const RPC_ERROR = (code: number, message: string) => ({ jsonrpc: '2.0', error: { code, message }, id: null })

/** The Host values /mcp answers. Loopback only outside production. */
function hostAllowed(host: string | undefined): boolean {
  if (!host) return false
  const ours = new Set(['agentbill.dev', 'agentbill.fly.dev', new URL(ORIGIN).host, new URL(publicOrigin()).host])
  if (process.env.CANONICAL_HOST) ours.add(process.env.CANONICAL_HOST)
  if (ours.has(host)) return true
  return process.env.NODE_ENV !== 'production' && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)
}

/** An Origin header, when a browser sent one, must be this site. */
function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true
  let o: URL
  try { o = new URL(origin) } catch { return false }
  const allowed = new Set([new URL(ORIGIN).origin, new URL(publicOrigin()).origin])
  if (allowed.has(o.origin)) return true
  // The page this server itself serves, on whatever host it was reached by.
  return !!host && o.host === host && (o.protocol === 'https:' || process.env.NODE_ENV !== 'production')
}

type Caller = { accountId: string; scopes: readonly Scope[] }

/**
 * Who is calling, or null when an answer has already been sent. The two
 * token kinds are told apart by shape before anything is looked up.
 */
async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<Caller | null> {
  const token = bearerToken(request)
  if (!token) {
    reply.code(401).header('WWW-Authenticate', challenge())
      .send({ error: 'unauthorized', message: 'Authorization required. Connect with OAuth, or pass Authorization: Bearer <your AgentBill API key>.' })
    return null
  }
  if (token.startsWith('agb_') || isKeyShaped(token)) {
    const ok = await authenticateKey(request, reply, token, challenge({ code: 'invalid_token', description: 'The API key was not accepted.' }))
    return ok ? { accountId: request.accountId, scopes: SCOPES } : null
  }
  const network = limiterKey(request)
  const failures = authFailureLimiter.blocked(network)
  if (!failures.allowed) {
    reply.code(429).send({ error: 'rate_limit_exceeded', message: 'Too many requests with an unknown token from this network. Wait a minute.',
                           reset_at: new Date(failures.resetAt).toISOString() })
    return null
  }
  const v = await verifyAccessToken(token)
  if (!v.ok) {
    if (v.unknown) authFailureLimiter.hit(network)
    reply.code(401).header('WWW-Authenticate', challenge({ code: 'invalid_token', description: v.description }))
      .send({ error: 'invalid_token', message: v.description })
    return null
  }
  // The same two buckets a key draws on: this connection's own, then the
  // account's, which every key and every connection on it share.
  const rate = checkRateLimit(`grant:${v.grantId}`)
  if (!rate.allowed) {
    reply.code(429).send({ error: 'rate_limit_exceeded', message: `Too many requests. Limit: ${MAX_REQUESTS} per minute.`, reset_at: new Date(rate.resetAt).toISOString() })
    return null
  }
  const acct = checkAccountRateLimit(v.accountId)
  if (!acct.allowed) {
    reply.code(429).send({ error: 'rate_limit_exceeded', message: `Too many requests for this account. Limit: ${MAX_ACCOUNT_REQUESTS} per minute.`,
                           reset_at: new Date(acct.resetAt).toISOString() })
    return null
  }
  return { accountId: v.accountId, scopes: v.scopes }
}

/** 403 before anything else when Host or Origin is not ours. True when it answered. */
function refusedAsCrossSite(request: FastifyRequest, reply: FastifyReply): boolean {
  const host = request.headers.host
  if (!hostAllowed(host)) { reply.code(403).send(RPC_ERROR(-32000, 'Invalid Host header.')); return true }
  const origin = typeof request.headers.origin === 'string' ? request.headers.origin : undefined
  if (!originAllowed(origin, host)) { reply.code(403).send(RPC_ERROR(-32000, 'Invalid Origin header.')); return true }
  return false
}

/** The tools/call names in a body the caller may not use, and the scopes they need. */
function missingScopes(body: unknown, held: readonly Scope[]): Scope[] {
  const msgs = Array.isArray(body) ? body : [body]
  const need = new Set<Scope>()
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue
    const { method, params } = m as { method?: unknown; params?: { name?: unknown } }
    if (method !== 'tools/call' || typeof params?.name !== 'string') continue
    const s = TOOL_SCOPE[params.name]
    if (s && !held.includes(s)) need.add(s)
  }
  return [...need]
}

export async function mcpRoute(app: FastifyInstance) {
  app.post('/mcp', { ...publicRoute(), bodyLimit: 64 * 1024 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    if (refusedAsCrossSite(request, reply)) return reply
    const caller = await authenticate(request, reply)
    if (!caller) return reply

    // A tool the token's scopes do not reach is refused at the HTTP layer with
    // the step-up challenge the authorization spec describes (403,
    // insufficient_scope, every scope the call needs in one challenge).
    const need = missingScopes(request.body, caller.scopes)
    if (need.length) {
      const scope = [...new Set([...caller.scopes, ...need])].join(' ')
      return reply.code(403)
        .header('WWW-Authenticate', challenge({ code: 'insufficient_scope', description: `This call needs ${need.join(' ')}.`, scope }))
        .send(RPC_ERROR(-32001, `Insufficient scope: this call needs ${need.join(' ')}.`))
    }

    const server = buildMcpServer({ accountId: caller.accountId, scopes: caller.scopes, log: request.log })
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    transport.onerror = (err) => request.log.warn({ msg: err.message.slice(0, 120) }, 'mcp transport refused a request')
    try {
      await server.connect(transport)
      // The request as the SDK reads it. Authorization and Cookie are not
      // passed on: the caller is already known, and nothing downstream needs
      // the credential it proved itself with.
      const headers = new Headers()
      for (const [k, v] of Object.entries(request.headers)) {
        if (k === 'authorization' || k === 'cookie' || v === undefined) continue
        headers.set(k, Array.isArray(v) ? v.join(', ') : String(v))
      }
      const web = new Request(`${publicOrigin()}/mcp`, { method: 'POST', headers })
      const res = await transport.handleRequest(web, { parsedBody: request.body })
      reply.code(res.status)
      const type = res.headers.get('content-type')
      if (type) reply.type(type)
      const text = await res.text()
      return reply.send(text.length ? text : undefined)
    } finally {
      await transport.close().catch(() => {})
      await server.close().catch(() => {})
    }
  })

  // No standalone stream and no session in a stateless server. A person who
  // types the address into a browser is shown the connect page instead of a
  // JSON 401; any client (no text/html in Accept, or credentials sent) gets
  // the spec's answers.
  const noStream = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'no-store')
    const accept = String(request.headers.accept ?? '')
    if (request.method === 'GET' && !request.headers.authorization && accept.includes('text/html') && !accept.includes('text/event-stream')) {
      return reply.redirect('/integrations/mcp', 303)
    }
    if (refusedAsCrossSite(request, reply)) return reply
    const caller = await authenticate(request, reply)
    if (!caller) return reply
    return reply.code(405).header('Allow', 'POST').send(RPC_ERROR(-32000, 'Method not allowed. This server is stateless: POST each message to /mcp.'))
  }
  app.get('/mcp', publicRoute(), noStream)
  app.delete('/mcp', publicRoute(), noStream)
}
