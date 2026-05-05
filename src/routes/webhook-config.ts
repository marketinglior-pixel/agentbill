import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sql } from '../db/index.js'

const WebhookConfigBody = z.object({
  url: z.string().url().startsWith('https://'),
})

export async function webhookConfigRoute(app: FastifyInstance) {
  app.post('/webhook-config', async (request, reply) => {
    const parse = WebhookConfigBody.safeParse(request.body)
    if (!parse.success) {
      return reply.code(422).send({ error: 'validation_error', details: parse.error.issues })
    }

    const { url } = parse.data
    const accountId = (request as any).accountId

    await sql`
      UPDATE accounts SET webhook_url = ${url} WHERE id = ${accountId}
    `

    return reply.send({ webhook_url: url })
  })
}
