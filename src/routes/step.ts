import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sql } from '../db/index.js'

const ANOMALY_MULTIPLIER = 2.0  // flag if units > baseline * 2
const BASELINE_MIN_SAMPLES = 5  // need at least 5 samples before flagging
const BASELINE_WINDOW = 30      // use last 30 steps for baseline

const StepBody = z.object({
  agent_id:    z.string().min(1),
  step_name:   z.string().min(1),
  units:       z.number().int().min(1),
  customer_id: z.string().optional(),
})

export async function stepRoute(app: FastifyInstance) {
  app.post('/step', async (request, reply) => {
    const parse = StepBody.safeParse(request.body)
    if (!parse.success) {
      return reply.code(422).send({ error: 'validation_error', details: parse.error.issues })
    }

    const { agent_id, step_name, units } = parse.data
    const accountId = (request as any).accountId

    // Record this step
    await sql`
      INSERT INTO step_costs (account_id, agent_id, step_name, units)
      VALUES (${accountId}, ${agent_id}, ${step_name}, ${units})
    `

    // Compute baseline from last N steps (excluding the one just inserted)
    const baseline = await sql`
      SELECT
        COUNT(*)::int        AS sample_count,
        AVG(units)::float    AS avg_units,
        STDDEV(units)::float AS stddev_units
      FROM (
        SELECT units FROM step_costs
        WHERE account_id = ${accountId}
          AND agent_id   = ${agent_id}
          AND step_name  = ${step_name}
        ORDER BY created_at DESC
        OFFSET 1           -- exclude the row we just inserted
        LIMIT ${BASELINE_WINDOW}
      ) recent
    `

    const { sampleCount, avgUnits, stddevUnits } = baseline[0]

    if (sampleCount < BASELINE_MIN_SAMPLES) {
      return reply.send({
        recorded: true,
        anomaly: false,
        baseline_units: null,
        deviation_pct: null,
      })
    }

    const baselineAvg = avgUnits as number
    const deviationPct = Math.round(((units - baselineAvg) / baselineAvg) * 100)
    const anomaly = units > baselineAvg * ANOMALY_MULTIPLIER

    return reply.send({
      recorded: true,
      anomaly,
      baseline_units: Math.round(baselineAvg),
      deviation_pct: deviationPct,
    })
  })
}
