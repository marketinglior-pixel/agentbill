import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sql } from '../db/index.js'
import { zId, zIdOrBlank, INT4_MAX } from '../lib/ids.js'
import { unitsOf, unitsOrNull } from '../db/int8.js'

const CheckpointBody = z.object({
  agent_id:     zId(),
  customer_id:  zIdOrBlank().optional(),
  units_so_far: z.number().int().min(0).max(INT4_MAX),
  ceiling:      z.number().int().positive().max(INT4_MAX).optional(),
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

    // Exact integers, never raw row values: `used + units_so_far` on a
    // string is concatenation, and the columns are BIGINT from migration 016.
    const limit = unitsOrNull(rows[0].limitUnits)
    const used = unitsOf(rows[0].usedUnits)
    const reserved = unitsOf(rows[0].reservedUnits)

    if (limit !== null && used + units_so_far > limit) {
      return reply.send({
        approved: false,
        reason: 'budget_exhausted',
        units_so_far,
        remaining_units: limit - used - reserved,
      })
    }

    const remaining = limit !== null
      ? limit - used - reserved
      : null

    return reply.send({
      approved: true,
      reason: null,
      units_so_far,
      remaining_units: remaining,
    })
  })
}
