import type { FastifyInstance } from 'fastify'
import { sql } from '../db/index.js'
import { isIP } from 'node:net'
import { clientIp as resolveClientIp } from '../lib/client-ip.js'
import { checkRateLimit } from '../lib/rate-limiter.js'
import { Resend } from 'resend'

declare module 'fastify' {
  interface FastifyRequest {
    accountId: string
  }
  interface FastifyContextConfig {
    /**
     * Declared at the route, beside its handler: this path serves the public
     * web, not the API. See publicRoute() below.
     */
    public?: boolean
    /** Set by the Polar webhook route so it can verify the signature. */
    rawBody?: boolean
  }
}

/**
 * Route options that mark a path as public.
 *
 * This used to be a Set of path strings in this file. A new public page had to
 * remember to join a list it had no reason to know about, and when one did not,
 * the page answered the public with `401 {"error":"unauthorized"}`. /blog
 * shipped that way and stayed that way: the index was redesigned in 280f24e and
 * linked from two pages while nobody outside could load it.
 *
 * A function, not a shared constant, so each route gets its own object and
 * nothing can be aliased into every other route's options.
 *
 * This is still forgettable, just forgettable next to the handler instead of a
 * file away. What makes it safe is the crawl gate in CI, which walks every link
 * on the site and fails the build on a 401.
 */
export const publicRoute = () => ({ config: { public: true } })

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null
const FROM = process.env.RESEND_FROM ?? 'AgentBill <onboarding@resend.dev>'

async function sendIpAlert(email: string, apiKey: string, oldIp: string, newIp: string) {
  if (!resend) return
  const masked = apiKey.slice(0, 8) + '...'
  await resend.emails.send({
    from: FROM,
    to: email,
    subject: `AgentBill: new IP detected on your API key`,
    html: `
      <p>Your API key <strong>${masked}</strong> was just used from a new IP address.</p>
      <p><strong>Previous IP:</strong> ${isIP(oldIp) ? oldIp : 'unparseable'}<br/>
         <strong>New IP:</strong> ${isIP(newIp) ? newIp : 'unparseable'}</p>
      <p>If this was you, ignore this message. If not, revoke the key immediately:</p>
      <pre>curl -X POST https://agentbill.dev/keys/revoke \\
  -H "Authorization: Bearer &lt;your key&gt;"</pre>
      <p><a href="https://agentbill.dev/app">Open your receipt</a></p>
    `,
  })
}

export function registerAuth(app: FastifyInstance) {
  app.addHook('onRequest', async (request, reply) => {
    // Routing already failed, so there is no route and nothing to authenticate.
    //
    // This has to be handled here rather than by ordering setNotFoundHandler
    // around this hook. Fastify copies every root onRequest hook into the 404
    // context at preReady (fastify/lib/fourOhFour.js), whichever order the two
    // are registered in, so an unmatched URL runs this hook and answered every
    // typo, every dead inbound link and every crawler probe with a JSON 401.
    //
    // It must also come first: the 404 context is built with
    // `config: opts.config || {}`, so the routeOptions check below reads
    // undefined there and would fall straight through to the bearer check.
    //
    // Consequence worth keeping deliberately: GET /preflight (a POST-only
    // route) now answers 404 while GET /keys answers 401, so an unauthenticated
    // prober can tell a real private route from noise. Nothing is learned that
    // llms.txt, the public repository and both published SDKs do not already
    // say out loud. Do not "fix" this by 401ing unmatched URLs again.
    if (request.is404) return

    // Declared public at the route itself. See publicRoute() above.
    if (request.routeOptions.config?.public === true) return

    const auth = request.headers.authorization ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''

    if (!token) {
      return reply.code(401).send({
        error: 'unauthorized',
        message: 'Missing API key. Pass Authorization: Bearer <your_key>.',
      })
    }

    // Rate limit: 100 requests per minute per key
    const rate = checkRateLimit(token)
    if (!rate.allowed) {
      return reply.code(429).send({
        error: 'rate_limit_exceeded',
        message: 'Too many requests. Limit: 100 per minute.',
        reset_at: new Date(rate.resetAt).toISOString(),
      })
    }

    // Look up key in DB: account, revocation, expiry, and IP tracking.
    //
    // is_revoked and is_expired are decided in SQL on purpose. revoked_at is
    // written by the database clock (`SET revoked_at = NOW()` in /keys/revoke),
    // so comparing it against the application's clock lets any skew between the
    // two machines become a window in which a revoked key still authenticates.
    // Measured at ~120ms against a local container, and app and database are
    // different hosts in production. The clock that writes the timestamp is the
    // clock that must read it.
    const rows = await sql`
      SELECT k.account_id, k.revoked_at, k.expires_at, k.last_seen_ip, a.email,
             (k.revoked_at IS NOT NULL AND k.revoked_at <= NOW()) AS is_revoked,
             (k.expires_at IS NOT NULL AND k.expires_at <= NOW()) AS is_expired
      FROM developer_api_keys k
      JOIN accounts a ON a.id = k.account_id
      WHERE k.api_key = ${token}
      LIMIT 1
    `

    if (rows.length === 0) {
      return reply.code(401).send({
        error: 'unauthorized',
        message: 'Invalid API key.',
      })
    }

    // revoked_at in the past = immediately revoked; in the future = grace period (rotation)
    if (rows[0].isRevoked) {
      return reply.code(401).send({
        error: 'key_revoked',
        message: 'This API key has been revoked. Generate a new one with POST /keys/generate.',
      })
    }

    if (rows[0].isExpired) {
      return reply.code(401).send({
        error: 'key_expired',
        message: 'This API key has expired. Generate a new one with POST /keys/generate.',
      })
    }

    // fly-client-ip is authoritative; x-forwarded-for[0] is client-forgeable
    // behind Fly (it appends), which let a stolen key spam the owner alert.
    const clientIp = resolveClientIp(request)

    const previousIp = rows[0].lastSeenIp as string | null

    // Update last seen IP (fire and forget, non-blocking)
    if (clientIp && clientIp !== previousIp) {
      sql`
        UPDATE developer_api_keys
        SET last_seen_ip = ${clientIp}
        WHERE api_key = ${token}
      `.catch(() => {})

      // Alert on IP change only if a previous IP exists (skip on first use)
      if (previousIp) {
        sendIpAlert(rows[0].email as string, token, previousIp, clientIp).catch(() => {})
      }
    }

    request.accountId = rows[0].accountId as string
  })
}
