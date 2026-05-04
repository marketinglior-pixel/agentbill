import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sql } from '../db/index.js'
import { randomBytes } from 'crypto'

const RegisterBody = z.object({
  email: z.string().email(),
  name:  z.string().min(1).max(128).optional(),
})

function generateApiKey(): string {
  return 'agb_' + randomBytes(24).toString('hex')
}

export async function registerRoute(app: FastifyInstance) {
  app.post('/register', async (request, reply) => {
    const parsed = RegisterBody.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(422).send({
        error: 'validation_error',
        message: parsed.error.issues[0]?.message ?? 'Invalid request body',
      })
    }

    const { email, name } = parsed.data

    try {
      const result = await sql.begin(async (tx) => {
        // Create account (or return existing if email already registered)
        const [account] = await tx`
          INSERT INTO accounts (email, name, plan)
          VALUES (${email}, ${name ?? null}, 'free')
          ON CONFLICT (email) DO NOTHING
          RETURNING id
        `

        if (!account) {
          return { type: 'already_exists' as const }
        }

        // Generate and store API key
        const apiKey = generateApiKey()
        await tx`
          INSERT INTO developer_api_keys (account_id, api_key, label)
          VALUES (${account.id}, ${apiKey}, 'default')
        `

        return { type: 'created' as const, accountId: account.id as string, apiKey }
      })

      if (result.type === 'already_exists') {
        return reply.code(409).send({
          error: 'already_exists',
          message: 'An account with this email already exists.',
        })
      }

      return reply.code(201).send({
        account_id: result.accountId,
        api_key: result.apiKey,
        message: 'Account created. Store your API key — it will not be shown again.',
      })

    } catch (err) {
      request.log.error(err)
      return reply.code(500).send({ error: 'internal_error', message: 'Unexpected server error' })
    }
  })
}
