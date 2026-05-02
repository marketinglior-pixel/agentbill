import type { FastifyInstance } from 'fastify'

const PUBLIC_PATHS = new Set(['/health', '/dashboard', '/customers'])

export function registerAuth(app: FastifyInstance) {
  const apiKey = process.env.AGENTBILL_API_KEY

  if (!apiKey) {
    app.log.warn('AGENTBILL_API_KEY is not set — all API requests will be rejected.')
  }

  app.addHook('onRequest', async (request, reply) => {
    if (PUBLIC_PATHS.has(request.url.split('?')[0])) return

    const auth = request.headers.authorization ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''

    if (!apiKey || token !== apiKey) {
      return reply.code(401).send({
        error: 'unauthorized',
        message: 'Missing or invalid API key. Pass Authorization: Bearer <your_key>.',
      })
    }
  })
}
