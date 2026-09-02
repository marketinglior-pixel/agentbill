import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sql } from '../db/index.js'

const ListQuery = z.object({
  agent_id: z.string().min(1).optional(),
  task_ref: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
})

// The receipt, machine-readable: every block this account's agents hit,
// newest first, with the literal response body each one received.
export async function decisionsRoute(app: FastifyInstance) {
  app.get('/decisions', async (request, reply) => {
    const parse = ListQuery.safeParse(request.query ?? {})
    if (!parse.success) {
      return reply.code(422).send({ error: 'validation_error', details: parse.error.issues })
    }
    const { agent_id, task_ref, limit } = parse.data
    const accountId = (request as any).accountId

    const rows = await sql`
      SELECT agent_id, customer_ref, task_ref, reason, source, blocked,
             estimated_units, ceiling_units, used_units, snapshot::text AS snapshot, created_at
      FROM preflight_decisions
      WHERE account_id = ${accountId}
        ${agent_id ? sql`AND agent_id = ${agent_id}` : sql``}
        ${task_ref ? sql`AND task_ref = ${task_ref}` : sql``}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}
    `

    const [totals] = await sql`
      SELECT count(*) FILTER (WHERE blocked)     AS blocked,
             count(*) FILTER (WHERE NOT blocked) AS overruns
      FROM preflight_decisions
      WHERE account_id = ${accountId}
    `

    return reply.send({
      blocked_total: Number(totals?.blocked ?? 0),
      overrun_total: Number(totals?.overruns ?? 0),
      // No id in the payload: it is a global BIGSERIAL and would leak
      // cross-tenant volume. snapshot is read as text so the camel transform
      // on json columns cannot rename the keys the SDK actually received.
      decisions: rows.map((r: any) => ({
        agent_id: r.agentId,
        customer_id: r.customerRef,
        task_ref: r.taskRef,
        reason: r.reason,
        source: r.source,
        blocked: r.blocked,
        estimated_units: r.estimatedUnits == null ? null : Number(r.estimatedUnits),
        ceiling_units: r.ceilingUnits == null ? null : Number(r.ceilingUnits),
        used_units: r.usedUnits == null ? null : Number(r.usedUnits),
        response: JSON.parse(r.snapshot),
        created_at: r.createdAt,
      })),
    })
  })
}
