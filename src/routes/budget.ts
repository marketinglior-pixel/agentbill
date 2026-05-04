import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sql } from '../db/index.js'

const BudgetQuery = z.object({
  customer_id: z.string().min(1),
})

export async function budgetRoute(app: FastifyInstance) {
  app.get('/budget', async (request, reply) => {
    const parsed = BudgetQuery.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(422).send({
        error: 'validation_error',
        message: 'Query parameter customer_id is required',
      })
    }

    const { customer_id: customerRef } = parsed.data
    const accountId = request.accountId
    const defaultBudget: number | null = null

    try {
      // Lazy-create: if customer doesn't exist, create with default budget.
      // This endpoint never returns 404.
      const inserted = await sql`
        INSERT INTO customers (account_id, customer_ref, limit_units)
        VALUES (${accountId}, ${customerRef}, ${defaultBudget})
        ON CONFLICT (account_id, customer_ref) DO NOTHING
        RETURNING *
      `

      const customerCreated = inserted.length > 0
      const customer = customerCreated
        ? inserted[0]
        : (await sql`
            SELECT * FROM customers
            WHERE account_id = ${accountId} AND customer_ref = ${customerRef}
          `)[0]

      const remaining = customer.limitUnits !== null
        ? customer.limitUnits - customer.usedUnits
        : null

      const isBlocked = customer.limitUnits !== null && remaining! <= 0

      return reply.code(200).send({
        customer_id: customerRef,
        customer_created: customerCreated,
        limit: customer.limitUnits,
        used: customer.usedUnits,
        remaining,
        is_blocked: isBlocked,
      })

    } catch (err) {
      request.log.error(err)
      const msg = err instanceof Error ? err.message : String(err)
      return reply.code(500).send({ error: 'internal_error', message: msg })
    }
  })
}
