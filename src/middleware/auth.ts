import type { FastifyInstance } from 'fastify'
import { sql } from '../db/index.js'
import { checkRateLimit } from '../lib/rate-limiter.js'
import { Resend } from 'resend'

declare module 'fastify' {
  interface FastifyRequest {
    accountId: string
  }
}

const PUBLIC_PATHS = new Set([
  '/', '/docs', '/health', '/health/db', '/register', '/upgrade', '/webhooks/polar', '/llms.txt',
  '/admin', '/admin/accounts', '/admin/login',
  '/robots.txt', '/sitemap.xml', '/google816aee44e74d69c3.html',
  '/docs/limit-cost-per-agent-run', '/docs/langchain-billing', '/docs/openai-agent-spend-ceiling',
  '/docs/task-budgets',
  '/blog/monthly-caps-wont-save-you',
  '/blog/how-preflight-avoids-double-billing',
])

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null

async function sendIpAlert(email: string, apiKey: string, oldIp: string, newIp: string) {
  if (!resend) return
  const masked = apiKey.slice(0, 8) + '...'
  await resend.emails.send({
    from: 'AgentBill <onboarding@resend.dev>',
    to: email,
    subject: `AgentBill: new IP detected on your API key`,
    html: `
      <p>Your API key <strong>${masked}</strong> was just used from a new IP address.</p>
      <p><strong>Previous IP:</strong> ${oldIp}<br/>
         <strong>New IP:</strong> ${newIp}</p>
      <p>If this was you, ignore this message. If not, revoke the key immediately:</p>
      <pre>curl -X POST https://agentbill.fly.dev/keys/revoke \\
  -H "Authorization: Bearer ${masked}"</pre>
      <p><a href="https://agentbill.fly.dev/dashboard">View dashboard</a></p>
    `,
  })
}

export function registerAuth(app: FastifyInstance) {
  app.addHook('onRequest', async (request, reply) => {
    if (PUBLIC_PATHS.has(request.url.split('?')[0])) return

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

    // Look up key in DB: account, revocation, expiry, and IP tracking
    const rows = await sql`
      SELECT k.account_id, k.revoked_at, k.expires_at, k.last_seen_ip, a.email
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

    const now = new Date()

    // revoked_at in the past = immediately revoked; in the future = grace period (rotation)
    if (rows[0].revokedAt !== null && new Date(rows[0].revokedAt) <= now) {
      return reply.code(401).send({
        error: 'key_revoked',
        message: 'This API key has been revoked. Generate a new one with POST /keys/generate.',
      })
    }

    if (rows[0].expiresAt !== null && new Date(rows[0].expiresAt) <= now) {
      return reply.code(401).send({
        error: 'key_expired',
        message: 'This API key has expired. Generate a new one with POST /keys/generate.',
      })
    }

    const clientIp = (request.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
      ?? request.ip

    const previousIp = rows[0].lastSeenIp as string | null

    // Update last seen IP (fire and forget — non-blocking)
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
