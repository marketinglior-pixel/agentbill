import type { FastifyInstance } from 'fastify'
import { sql } from '../db/index.js'

// Extend FastifyRequest so routes can read request.accountId
declare module 'fastify' {
  interface FastifyRequest {
    accountId: string
  }
}

const PUBLIC_PATHS = new Set([
  '/', '/docs', '/health', '/dashboard', '/register', '/upgrade', '/webhooks/polar', '/llms.txt',
  '/docs/limit-cost-per-agent-run', '/docs/langchain-billing', '/docs/openai-agent-spend-ceiling',
  '/blog/monthly-caps-wont-save-you',
  '/blog/how-preflight-avoids-double-billing',
])

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

    // Look up key in DB → get account_id
    const rows = await sql`
      SELECT account_id FROM developer_api_keys
      WHERE api_key = ${token}
      LIMIT 1
    `

    if (rows.length === 0) {
      return reply.code(401).send({
        error: 'unauthorized',
        message: 'Invalid API key.',
      })
    }

    request.accountId = rows[0].accountId as string
  })
}
