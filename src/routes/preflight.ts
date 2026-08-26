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
  task_ref: z.string().min(1).max(128).optional(),
  task_ceiling: z.number().int().positive().optional(),
})

// Thrown inside the reserve transaction so a task-level rejection rolls back
// the customer-level reservation too — the two reserves are all-or-nothing.
class TaskRejection extends Error {
  constructor(
    public reason: 'task_ceiling_exceeded' | 'task_ceiling_required',
    public current?: { ceilingUnits: number; usedUnits: number; reservedUnits: number }
  ) {
    super(reason)
  }
}

export async function preflightRoute(app: FastifyInstance) {
  app.post('/preflight', async (request, reply) => {
    const parse = PreflightBody.safeParse(request.body)
    if (!parse.success) {
      return reply.status(422).send({ error: 'Validation error', details: parse.error.issues })
    }

    const { agent_id, customer_id, estimated_units, ceiling, task_ref, task_ceiling } = parse.data
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

    let result
    try {
      result = await sql.begin(async (tx) => {
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

        // Task-level ceiling: a cross-call budget for one job/run. Same atomic
        // reserve pattern as customers, scoped to (account_id, task_ref).
        let task = null
        if (task_ref) {
          if (task_ceiling != null) {
            // First call for this task creates it; the ceiling is fixed at
            // creation and later task_ceiling values are ignored.
            await tx`
              INSERT INTO task_budgets (account_id, agent_id, task_ref, ceiling_units)
              VALUES (${accountId}, ${agent_id}, ${task_ref}, ${task_ceiling})
              ON CONFLICT (account_id, task_ref) DO NOTHING
            `
          }

          const taskReserved = await tx`
            UPDATE task_budgets
            SET reserved_units = reserved_units + ${reserveUnits},
                updated_at     = now()
            WHERE account_id = ${accountId}
              AND task_ref = ${task_ref}
              AND used_units + reserved_units + ${reserveUnits} <= ceiling_units
            RETURNING ceiling_units, used_units, reserved_units
          `

          if (taskReserved.length === 0) {
            const [current] = await tx`
              SELECT ceiling_units, used_units, reserved_units
              FROM task_budgets
              WHERE account_id = ${accountId} AND task_ref = ${task_ref}
            `
            // Rolls back the customer reservation above as well.
            throw current
              ? new TaskRejection(
                  'task_ceiling_exceeded',
                  current as unknown as { ceilingUnits: number; usedUnits: number; reservedUnits: number }
                )
              : new TaskRejection('task_ceiling_required')
          }
          task = taskReserved[0]
        }

        return { approved: true as const, row: reserved[0], task }
      })
    } catch (err) {
      if (err instanceof TaskRejection && err.reason === 'task_ceiling_required') {
        return reply.status(422).send({
          error: 'task_ceiling_required',
          message: `Unknown task_ref "${task_ref}". Pass task_ceiling on the first preflight of a new task.`,
        })
      }
      if (err instanceof TaskRejection && err.current) {
        const t = err.current
        return reply.send({
          approved: false,
          reason: 'task_ceiling_exceeded',
          estimated_units: estimated_units ?? null,
          task_ref,
          task_ceiling: t.ceilingUnits,
          task_used_units: t.usedUnits,
          task_remaining_units: Math.max(0, t.ceilingUnits - t.usedUnits - t.reservedUnits),
        })
      }
      throw err
    }

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

    const task = result.task
    return reply.send({
      approved: true,
      reason: null,
      estimated_units: estimated_units ?? null,
      remaining_units: remaining,
      ...(task
        ? {
            task_ref,
            task_remaining_units:
              task.ceilingUnits - task.usedUnits - task.reservedUnits,
          }
        : {}),
    })
  })
}
