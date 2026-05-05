import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sql } from '../db/index.js'
import { reportUsage, getCheckoutUrl } from '../integrations/polar.js'

const FREE_TIER_LIMIT = 1_000

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

    // Load account: plan, monthly usage, billing period
    const [account] = await sql`
      SELECT id, plan, polar_customer_id, monthly_calls, billing_period_start, default_budget_units
      FROM accounts
      WHERE id = ${accountId}
    `

    if (!account) {
      return reply.status(401).send({ error: 'account_not_found' })
    }

    // Reset monthly counter if we've crossed into a new billing period
    const now = new Date()
    const periodStart = new Date(account.billingPeriodStart)
    const isNewMonth =
      now.getFullYear() > periodStart.getFullYear() ||
      now.getMonth() > periodStart.getMonth()

    if (isNewMonth) {
      await sql`
        UPDATE accounts
        SET monthly_calls = 0,
            billing_period_start = date_trunc('month', CURRENT_DATE)::DATE
        WHERE id = ${accountId}
      `
      account.monthlyCalls = 0
    }

    // Free tier enforcement
    if (account.plan === 'free' && account.monthlyCalls >= FREE_TIER_LIMIT) {
      return reply.send({
        approved: false,
        reason: 'free_tier_exceeded',
        monthly_calls: account.monthlyCalls,
        free_tier_limit: FREE_TIER_LIMIT,
        upgrade_url: getCheckoutUrl(accountId),
      })
    }

    // Per-customer budget check — atomic reserve to prevent TOCTOU race condition.
    // Under concurrent load, a plain read-check-approve lets multiple requests all
    // see the same remaining balance and all get approved. Instead we atomically
    // increment reserved_units inside a transaction; if the budget is exhausted the
    // UPDATE matches 0 rows and we block without a race.
    const customerRef = customer_id || 'default'
    const reserveUnits = estimated_units ?? 1

    const result = await sql.begin(async (tx) => {
      // Lazy-create the customer row if it doesn't exist yet.
      await tx`
        INSERT INTO customers (account_id, customer_ref, limit_units)
        VALUES (${accountId}, ${customerRef}, ${account.defaultBudgetUnits ?? null})
        ON CONFLICT DO NOTHING
      `

      // Atomic reserve: only succeeds when budget allows it.
      // Returns the updated row so we can report remaining_units.
      const reserved = await tx`
        UPDATE customers
        SET reserved_units = reserved_units + ${reserveUnits}
        WHERE account_id = ${accountId}
          AND customer_ref = ${customerRef}
          AND (
            limit_units IS NULL
            OR used_units + reserved_units + ${reserveUnits} <= limit_units
          )
        RETURNING limit_units, used_units, reserved_units
      `

      if (reserved.length === 0) {
        // Budget exhausted — read current state for the response
        const [current] = await tx`
          SELECT limit_units, used_units, reserved_units
          FROM customers
          WHERE account_id = ${accountId} AND customer_ref = ${customerRef}
        `
        return { approved: false as const, current }
      }

      return { approved: true as const, row: reserved[0] }
    })

    if (!result.approved) {
      const c = result.current
      return reply.send({
        approved: false,
        reason: 'budget_exhausted',
        estimated_units: estimated_units ?? null,
        remaining_units: c ? c.limitUnits - c.usedUnits - c.reservedUnits : 0,
      })
    }

    const row = result.row
    const remaining = row.limitUnits != null
      ? row.limitUnits - row.usedUnits - row.reservedUnits
      : null

    // Approved — increment monthly counter
    await sql`
      UPDATE accounts
      SET monthly_calls = monthly_calls + 1
      WHERE id = ${accountId}
    `

    // For paid accounts: report usage to Polar for billing
    if (account.plan === 'paid' && account.polarCustomerId) {
      void reportUsage(account.polarCustomerId, 1)
    }

    return reply.send({
      approved: true,
      reason: null,
      estimated_units: estimated_units ?? null,
      remaining_units: remaining,
    })
  })
}
