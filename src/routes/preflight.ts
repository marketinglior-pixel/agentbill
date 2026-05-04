import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sql } from '../db/index.js'

const PreflightBody = z.object({
  agent_id: z.string().min(1),
  customer_id: z.string().optional(),
  estimated_units: z.number().int().positive().optional(),
  ceiling: z.number().int().positive().optional(),
})

export async function preflightRoute(app: FastifyInstance) {
  app.post('/preflight', async (request, reply) => {
    const parse = PreflightBody.safeParse(request.body)
    if (!parse.success) {
      return reply.status(422).send({ error: 'Validation error', details: parse.error.issues })
    }

    const { agent_id, customer_id, estimated_units, ceiling } = parse.data
    const accountId = (request as any).accountId

    // Ceiling check — no DB needed
    if (ceiling != null && estimated_units != null && estimated_units > ceiling) {
      return reply.send({
        approved: false,
        reason: 'ceiling_exceeded',
        estimated_units,
        ceiling,
        remaining_units: null,
      })
    }

    // Budget check
    const customerRef = customer_id || 'default'

    let rows = await sql`
      SELECT limit_units, used_units
      FROM customers
      WHERE account_id = ${accountId} AND customer_ref = ${customerRef}
    `

    if (rows.length === 0) {
      const [account] = await sql`
        SELECT default_budget_units FROM accounts WHERE id = ${accountId}
      `
      await sql`
        INSERT INTO customers (account_id, customer_ref, limit_units)
        VALUES (${accountId}, ${customerRef}, ${account?.default_budget_units ?? null})
        ON CONFLICT DO NOTHING
      `
      rows = await sql`
        SELECT limit_units, used_units
        FROM customers
        WHERE account_id = ${accountId} AND customer_ref = ${customerRef}
      `
    }

    const customer = rows[0]
    const remaining = customer.limit_units != null
      ? customer.limit_units - customer.used_units
      : null

    if (remaining != null && remaining <= 0) {
      return reply.send({
        approved: false,
        reason: 'budget_exhausted',
        estimated_units: estimated_units ?? null,
        remaining_units: remaining,
      })
    }

    return reply.send({
      approved: true,
      reason: null,
      estimated_units: estimated_units ?? null,
      remaining_units: remaining,
    })
  })
}
