import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sql } from '../db/index.js'

const CheckpointBody = z.object({
  agent_id:     z.string().min(1),
  customer_id:  z.string().optional(),
  units_so_far: z.number().int().min(0),
  ceiling:      z.number().int().positive().optional(),
})

export async function checkpointRoute(app: FastifyInstance) {
  app.post('/checkpoint', async (request, reply) => {
    const parse = CheckpointBody.safeParse(request.body)
    if (!parse.success) {
      return reply.code(422).send({ error: 'validation_error', details: parse.error.issues })
    }

    const { units_so_far, ceiling, customer_id } = parse.data
    const accountId = (request as any).accountId

    // Ceiling check, no DB needed
    if (ceiling != null && units_so_far > ceiling) {
      return reply.send({
        approved: false,
        reason: 'ceiling_exceeded',
        units_so_far,
        remaining_units: null,
      })
    }

    // Budget check, read-only, no reservation changes
    const customerRef = customer_id || 'default'
    const rows = await sql`
      SELECT limit_units, used_units, reserved_units
      FROM customers
      WHERE account_id = ${accountId} AND customer_ref = ${customerRef}
    `

    if (rows.length === 0) {
      // Customer not seen before, no budget set, approved
      return reply.send({
        approved: true,
        reason: null,
        units_so_far,
        remaining_units: null,
      })
    }

    const customer = rows[0]

    if (
      customer.limitUnits !== null &&
      customer.usedUnits + units_so_far > customer.limitUnits
    ) {
      return reply.send({
        approved: false,
        reason: 'budget_exhausted',
        units_so_far,
        remaining_units: customer.limitUnits - customer.usedUnits - customer.reservedUnits,
      })
    }

    const remaining = customer.limitUnits !== null
      ? customer.limitUnits - customer.usedUnits - customer.reservedUnits
      : null

    return reply.send({
      approved: true,
      reason: null,
      units_so_far,
      remaining_units: remaining,
    })
  })
}
