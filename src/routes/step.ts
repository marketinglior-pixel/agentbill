import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sql } from '../db/index.js'
import { zId, zIdOrBlank, INT4_MAX } from '../lib/ids.js'
import { deliverWebhook, webhookSecretFor } from '../lib/webhook-target.js'
import { claimEvent, eventLimitFor, eventQuotaRefusal, EVENT_QUOTA_STATUS } from '../lib/event-quota.js'

const ANOMALY_MULTIPLIER = 2.0  // flag if units > baseline * 2
const BASELINE_MIN_SAMPLES = 5  // need at least 5 samples before flagging
const BASELINE_WINDOW = 30      // use last 30 steps for baseline

const StepBody = z.object({
  agent_id:    zId(),
  step_name:   zId(),
  units:       z.number().int().min(1).max(INT4_MAX),
  customer_id: zIdOrBlank().optional(),
})

export async function stepRoute(app: FastifyInstance) {
  // /step takes four small fields and no metadata (unknown keys are dropped
  // by the schema, never stored), so 16 KB is generous. Fastify's default was
  // 1 MB of JSON parsed for every call.
  app.post('/step', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    const parse = StepBody.safeParse(request.body)
    if (!parse.success) {
      return reply.code(422).send({ error: 'validation_error', details: parse.error.issues })
    }

    const { agent_id, step_name, units } = parse.data
    const accountId = request.accountId

    // Record this step, against the account's monthly records-and-steps
    // allowance (migration 028, src/lib/event-quota.ts): the claim and the
    // row commit together or not at all, and a refused step stores nothing.
    // This route locks no customer row, so the claim's UPDATE is the only
    // account lock it takes and there is no order to keep.
    const stored = await sql.begin(async (tx) => {
      const [acct] = await tx`SELECT plan FROM accounts WHERE id = ${accountId}`
      const plan = (acct?.plan as string) ?? 'free'
      const limit = eventLimitFor(plan)
      const claim = await claimEvent(tx, accountId, limit)
      if (!claim.ok) return { ok: false as const, plan, monthlyEvents: claim.monthlyEvents, limit: limit as number }
      await tx`
        INSERT INTO step_costs (account_id, agent_id, step_name, units)
        VALUES (${accountId}, ${agent_id}, ${step_name}, ${units})
      `
      return { ok: true as const }
    })
    if (!stored.ok) {
      return reply.code(EVENT_QUOTA_STATUS).send(eventQuotaRefusal(accountId, stored.plan, stored.monthlyEvents, stored.limit))
    }

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

    if (anomaly) {
      const [acct] = await sql`SELECT webhook_url, webhook_secret_nonce FROM accounts WHERE id = ${accountId}`
      if (acct?.webhookUrl) {
        const payload = JSON.stringify({
          event: 'anomaly.detected',
          agent_id,
          step_name,
          units,
          baseline_units: Math.round(baselineAvg),
          deviation_pct: deviationPct,
          timestamp: new Date().toISOString(),
        })
        // Fire and forget, as before, but through the guarded sender: the
        // address rules again at send time, no redirect followed, five
        // seconds at most, and signed when the row has a nonce (a URL saved
        // before migration 020 has none and goes out unsigned, as it did).
        const secret = acct.webhookSecretNonce ? webhookSecretFor(acct.webhookSecretNonce as string) : null
        const log = request.log
        void deliverWebhook(acct.webhookUrl as string, payload, { 'X-AgentBill-Account-Id': accountId }, secret)
          .then((r) => {
            if (!r.delivered) log.warn({ accountId, reason: r.reason, status: r.status }, 'anomaly webhook not delivered')
          })
          .catch((err) => log.warn({ accountId, err }, 'anomaly webhook threw'))
      }
    }

    return reply.send({
      recorded: true,
      anomaly,
      baseline_units: Math.round(baselineAvg),
      deviation_pct: deviationPct,
    })
  })
}
