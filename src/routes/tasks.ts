import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sql } from '../db/index.js'
import { zId, INT4_MAX } from '../lib/ids.js'
import { setTaskCeiling } from '../lib/task-ceiling.js'

const TaskParams = z.object({ task_ref: zId() })

const CeilingBody = z.object({
  // Same bounds as task_ceiling on POST /preflight: a positive int4.
  ceiling_units: z.number().int().positive().max(INT4_MAX),
  // Only read when this call opens the job. An existing job keeps the agent
  // that opened it: the label attributes spend, and a save is not spend.
  agent_id: zId().optional(),
})

const ListQuery = z.object({
  agent_id: zId().optional(),
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
    // The one caller string on this API that arrives as a path segment
    // rather than a query or a body, and the only one that reached SQL with
    // no schema at all: /tasks/%00 was a 500.
    const params = TaskParams.safeParse(request.params)
    if (!params.success) {
      return reply.code(422).send({ error: 'validation_error', details: params.error.issues })
    }
    const taskRef = params.data.task_ref
    const accountId = (request as any).accountId

    const [row] = await sql`
      SELECT task_ref, agent_id, ceiling_units, used_units, reserved_units, created_at, updated_at
      FROM task_budgets
      WHERE account_id = ${accountId} AND task_ref = ${taskRef}
    `

    if (!row) {
      return reply.code(404).send({
        error: 'task_not_found',
        message: `No task with task_ref "${taskRef}". A task is opened by the first preflight that passes task_ref + task_ceiling, or by PUT /tasks/:task_ref/ceiling.`,
      })
    }

    return reply.send(serialize(row as any))
  })

  // Set a job's ceiling from outside the calling code.
  //
  // Until 2026-09-10 a ceiling could only be chosen as task_ceiling on the
  // first preflight of a new task_ref, and every later value, from any caller,
  // was dropped without a word (preflight.ts: ON CONFLICT DO NOTHING). The only
  // way to change one was a hand-written UPDATE, and the console's empty state
  // sent a reader back to their editor to set a budget. The rule now:
  //
  //   The last successful save here is the ceiling preflight uses. Code may
  //   still open a job with task_ceiling when no row exists; once a row exists,
  //   code cannot change it and this endpoint can. Every preflight answers with
  //   the ceiling in force as task_ceiling, so a value that was not applied is
  //   visible, not silent.
  //
  // A ceiling may not go under used + reserved: that is a 409 carrying the
  // smallest value that would be accepted. Reservations in flight are never
  // rewritten by a save; they settle through record() or expire on their TTL,
  // and the next preflight reads the new ceiling. The rule lives in
  // src/lib/task-ceiling.ts, shared with the console's form.
  app.put('/tasks/:task_ref/ceiling', async (request, reply) => {
    const params = TaskParams.safeParse(request.params)
    if (!params.success) {
      return reply.code(422).send({ error: 'validation_error', details: params.error.issues })
    }
    const parsed = CeilingBody.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(422).send({
        error: 'validation_error',
        message: 'Body needs ceiling_units (a positive integer). agent_id is optional (1 to 128 characters, no control characters) and is read only when this call opens the job.',
        details: parsed.error.issues,
      })
    }
    const taskRef = params.data.task_ref
    const accountId = (request as any).accountId

    try {
      const result = await setTaskCeiling(accountId, taskRef, parsed.data.ceiling_units, parsed.data.agent_id)
      if (!result.ok) {
        return reply.code(409).send({
          error: 'ceiling_below_committed',
          message: `Task "${taskRef}" has ${result.usedUnits} units spent and ${result.reservedUnits} reserved by calls in flight. The ceiling cannot go under ${result.minimum}: pass ${result.minimum} or more, or wait for the reservations to settle or expire.`,
          task_ref: taskRef,
          ceiling_units: result.ceilingUnits,
          used_units: result.usedUnits,
          reserved_units: result.reservedUnits,
          minimum_ceiling_units: result.minimum,
        })
      }
      return reply.send({ ...serialize(result.row), task_created: result.row.taskCreated })
    } catch (err) {
      request.log.error(err)
      return reply.code(500).send({ error: 'internal_error', message: 'Unexpected server error' })
    }
  })
}
