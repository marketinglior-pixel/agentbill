import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sql } from '../db/index.js'

const ListQuery = z.object({
  agent_id: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
})

function serialize(t: {
  taskRef: string
  agentId: string
  ceilingUnits: number
  usedUnits: number
  reservedUnits: number
  createdAt: Date
  updatedAt: Date
}) {
  return {
    task_ref: t.taskRef,
    agent_id: t.agentId,
    ceiling_units: t.ceilingUnits,
    used_units: t.usedUnits,
    reserved_units: t.reservedUnits,
    remaining_units: Math.max(0, t.ceilingUnits - t.usedUnits - t.reservedUnits),
    exceeded: t.usedUnits > t.ceilingUnits,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
  }
}

export async function tasksRoute(app: FastifyInstance) {
  // Attribution view: what has each job cost, per agent.
  app.get('/tasks', async (request, reply) => {
    const parse = ListQuery.safeParse(request.query ?? {})
    if (!parse.success) {
      return reply.code(422).send({ error: 'validation_error', details: parse.error.issues })
    }
    const { agent_id, limit } = parse.data
    const accountId = (request as any).accountId

    const rows = agent_id
      ? await sql`
          SELECT task_ref, agent_id, ceiling_units, used_units, reserved_units, created_at, updated_at
          FROM task_budgets
          WHERE account_id = ${accountId} AND agent_id = ${agent_id}
          ORDER BY created_at DESC
          LIMIT ${limit}
        `
      : await sql`
          SELECT task_ref, agent_id, ceiling_units, used_units, reserved_units, created_at, updated_at
          FROM task_budgets
          WHERE account_id = ${accountId}
          ORDER BY created_at DESC
          LIMIT ${limit}
        `

    return reply.send({ tasks: rows.map((r) => serialize(r as any)) })
  })

  // Single task status, poll this to watch a job burn down its budget.
  app.get('/tasks/:task_ref', async (request, reply) => {
    const taskRef = (request.params as { task_ref: string }).task_ref
    const accountId = (request as any).accountId

    const [row] = await sql`
      SELECT task_ref, agent_id, ceiling_units, used_units, reserved_units, created_at, updated_at
      FROM task_budgets
      WHERE account_id = ${accountId} AND task_ref = ${taskRef}
    `

    if (!row) {
      return reply.code(404).send({
        error: 'task_not_found',
        message: `No task with task_ref "${taskRef}". Tasks are created by the first preflight that passes task_ref + task_ceiling.`,
      })
    }

    return reply.send(serialize(row as any))
  })
}
