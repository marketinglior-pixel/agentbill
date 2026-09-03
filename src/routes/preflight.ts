import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sql } from '../db/index.js'
import { reportUsage, PLAN_LIMITS } from '../integrations/polar.js'
import { recordDecision } from '../lib/decisions.js'
import { reservationExpiry } from '../lib/reservations.js'

const PreflightBody = z.object({
  agent_id: z.string().min(1),
  customer_id: z.string().optional(),
  estimated_units: z.number().int().positive().optional(),
  ceiling: z.number().int().positive().optional(),
  task_ref: z.string().min(1).max(128).optional(),
  task_ceiling: z.number().int().positive().optional(),
  idempotency_key: z.string().min(1).max(128).optional(),
})

// Every rejection inside the reserve transaction is thrown, never returned.
// That is deliberate and it is the invariant the whole route now rests on:
// a blocked call rolls back, so it reserves no units and burns no plan quota.
// Returning a rejection from inside sql.begin() would commit the quota
// increment for a call that never ran.
class PreflightRejection extends Error {
  constructor(
    public reason:
      | 'plan_limit_exceeded'
      | 'budget_exhausted'
      | 'task_ceiling_exceeded'
      | 'task_ceiling_required',
    public detail: Record<string, unknown> = {}
  ) {
    super(reason)
  }
}

// Thrown when a concurrent request already claimed this idempotency key. The
// duplicate blocks on the unique index until the original commits, so by the
// time this is thrown the original's decision either exists or is one write away.
class ReplayNeeded extends Error {}

export async function preflightRoute(app: FastifyInstance) {
  app.post('/preflight', async (request, reply) => {
    const parse = PreflightBody.safeParse(request.body)
    if (!parse.success) {
      return reply.status(422).send({ error: 'Validation error', details: parse.error.issues })
    }

    const {
      agent_id, customer_id, estimated_units, ceiling,
      task_ref, task_ceiling, idempotency_key,
    } = parse.data
    const accountId = (request as any).accountId
    const customerRef = customer_id || 'default'
    const taskRef = task_ref ?? null

    // Same key, same decision, one reservation. Without this a retried
    // preflight reserved a second time, so the mechanism meant to prevent
    // waste was the one consuming the budget.
    const replay = async () => {
      const [prior] = await sql`
        SELECT response FROM preflight_requests
        WHERE account_id = ${accountId} AND idempotency_key = ${idempotency_key!}
      `
      if (!prior) return null
      if (prior.response == null) {
        // The deciding request committed but has not written its body yet.
        // Answering anything else here would either invent a decision or let
        // this retry reserve on top of one already held.
        return reply.status(409).send({
          error: 'preflight_in_progress',
          message: `A preflight with idempotency_key "${idempotency_key}" is still being decided. Retry in a moment.`,
        })
      }
      return reply.send(prior.response)
    }

    // Remembers a decision reached outside the reserve transaction (the two
    // early rejections, and the rollback paths). ON CONFLICT DO NOTHING so a
    // concurrent evaluation of the same key keeps whichever answer landed first.
    const remember = async (body: unknown) => {
      if (!idempotency_key) return
      await sql`
        INSERT INTO preflight_requests (account_id, idempotency_key, response)
        VALUES (${accountId}, ${idempotency_key}, ${JSON.stringify(body)}::json)
        ON CONFLICT (account_id, idempotency_key) DO NOTHING
      `.catch((err) => request.log.error({ err }, 'preflight idempotency write failed'))
    }

    if (idempotency_key) {
      const replayed = await replay()
      if (replayed) return replayed
    }

    // Every approved:false below is also written to preflight_decisions
    // (migration 005) so the account has a record of what it was saved from.
    // Fire-and-forget through the module-level sql, never through tx.

    // Ceiling check, no DB needed, reserves nothing
    if (ceiling != null && estimated_units != null && estimated_units > ceiling) {
      const body = {
        approved: false,
        reason: 'ceiling_exceeded',
        estimated_units,
        ceiling,
        remaining_units: null,
      }
      recordDecision(request.log, {
        accountId, agentId: agent_id, customerRef, taskRef,
        reason: body.reason, estimatedUnits: estimated_units, ceilingUnits: ceiling, snapshot: body,
      })
      await remember(body)
      return reply.send(body)
    }

    // Load account: plan and per-customer default. The monthly counter is NOT
    // read here to decide anything, it is checked and incremented atomically
    // inside the transaction below.
    const [account] = await sql`
      SELECT id, plan, polar_customer_id, default_budget_units
      FROM accounts
      WHERE id = ${accountId}
    `

    if (!account) {
      return reply.status(401).send({ error: 'account_not_found' })
    }

    // Monthly plan quota. Legacy 'paid' is unlimited (metered per call);
    // unknown plans get the free quota rather than a free pass.
    const planLimit: number | null =
      account.plan === 'paid' ? null : PLAN_LIMITS[account.plan] ?? PLAN_LIMITS.free

    const reserveUnits = estimated_units ?? 1
    const expiresAt = reservationExpiry()

    let result
    try {
      result = await sql.begin(async (tx) => {
        // Claim the idempotency key first. A concurrent duplicate blocks here
        // until this transaction commits or rolls back, so it can never run
        // the reservation below in parallel with us.
        if (idempotency_key) {
          const claimed = await tx`
            INSERT INTO preflight_requests (account_id, idempotency_key)
            VALUES (${accountId}, ${idempotency_key})
            ON CONFLICT (account_id, idempotency_key) DO NOTHING
            RETURNING id
          `
          if (claimed.length === 0) throw new ReplayNeeded()
        }

        // Monthly quota: check and increment in ONE conditional UPDATE, inside
        // the transaction. The old code read the counter, compared it, and
        // incremented in three separate unlocked statements, so N concurrent
        // calls at the limit all read the same number and all passed.
        // The CASE also rolls the billing period, which the old read-then-write
        // reset had the same race on.
        const [quota] = await tx`
          UPDATE accounts
          SET monthly_calls = CASE
                WHEN billing_period_start < date_trunc('month', CURRENT_DATE)::DATE THEN 1
                ELSE monthly_calls + 1
              END,
              billing_period_start = CASE
                WHEN billing_period_start < date_trunc('month', CURRENT_DATE)::DATE
                THEN date_trunc('month', CURRENT_DATE)::DATE
                ELSE billing_period_start
              END
          WHERE id = ${accountId}
            AND (
              ${planLimit}::int IS NULL
              OR billing_period_start < date_trunc('month', CURRENT_DATE)::DATE
              OR monthly_calls < ${planLimit}
            )
          RETURNING monthly_calls
        `

        if (!quota) {
          const [current] = await tx`
            SELECT monthly_calls FROM accounts WHERE id = ${accountId}
          `
          throw new PreflightRejection('plan_limit_exceeded', {
            monthly_calls: current?.monthlyCalls ?? planLimit,
          })
        }

        // Lazy-create the customer row if it doesn't exist yet.
        await tx`
          INSERT INTO customers (account_id, customer_ref, limit_units)
          VALUES (${accountId}, ${customerRef}, ${account.defaultBudgetUnits ?? null})
          ON CONFLICT DO NOTHING
        `

        // Atomic reserve: only succeeds when budget allows it. Under concurrent
        // load a plain read-check-approve lets several requests see the same
        // remaining balance and all get approved; the conditional UPDATE cannot.
        const reserved = await tx`
          UPDATE customers
          SET reserved_units = reserved_units + ${reserveUnits}
          WHERE account_id = ${accountId}
            AND customer_ref = ${customerRef}
            AND (
              limit_units IS NULL
              OR used_units + reserved_units + ${reserveUnits} <= limit_units
            )
          RETURNING id, limit_units, used_units, reserved_units
        `

        if (reserved.length === 0) {
          const [current] = await tx`
            SELECT limit_units, used_units, reserved_units
            FROM customers
            WHERE account_id = ${accountId} AND customer_ref = ${customerRef}
          `
          throw new PreflightRejection('budget_exhausted', {
            remaining_units: current
              ? Math.max(0, current.limitUnits - current.usedUnits - current.reservedUnits)
              : 0,
          })
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
            // Rolls back the customer reservation and the quota increment too.
            throw current
              ? new PreflightRejection('task_ceiling_exceeded', {
                  task_ceiling: current.ceilingUnits,
                  task_used_units: current.usedUnits,
                  task_remaining_units: Math.max(
                    0, current.ceilingUnits - current.usedUnits - current.reservedUnits
                  ),
                })
              : new PreflightRejection('task_ceiling_required')
          }
          task = taskReserved[0]
        }

        // The reservation becomes a row, not just a bump on a counter. This is
        // what lets an abandoned run be reclaimed: the counter alone cannot be
        // swept because it does not know how much of itself is stale.
        await tx`
          INSERT INTO reservations (account_id, customer_id, task_ref, units, expires_at)
          VALUES (${accountId}, ${reserved[0].id}, ${taskRef}, ${reserveUnits}, ${expiresAt})
        `

        return { row: reserved[0], task, monthlyCalls: quota.monthlyCalls }
      })
    } catch (err) {
      if (err instanceof ReplayNeeded) {
        const replayed = await replay()
        if (replayed) return replayed
        // The claiming transaction rolled back and freed the key. Nothing was
        // reserved under it, so the caller is safe to retry.
        return reply.status(409).send({
          error: 'preflight_in_progress',
          message: `A preflight with idempotency_key "${idempotency_key}" is still being decided. Retry in a moment.`,
        })
      }

      if (err instanceof PreflightRejection) {
        if (err.reason === 'task_ceiling_required') {
          const body = {
            error: 'task_ceiling_required',
            message: `Unknown task_ref "${task_ref}". Pass task_ceiling on the first preflight of a new task.`,
          }
          await remember(body)
          return reply.status(422).send(body)
        }

        const body =
          err.reason === 'plan_limit_exceeded'
            ? {
                approved: false,
                reason: account.plan === 'free' ? 'free_tier_exceeded' : 'plan_limit_exceeded',
                plan: account.plan,
                monthly_calls: err.detail.monthly_calls,
                plan_limit: planLimit,
                upgrade_url: `https://agentbill.dev/upgrade?account_id=${accountId}`,
              }
            : err.reason === 'budget_exhausted'
              ? {
                  approved: false,
                  reason: 'budget_exhausted',
                  estimated_units: estimated_units ?? null,
                  remaining_units: err.detail.remaining_units,
                }
              : {
                  approved: false,
                  reason: 'task_ceiling_exceeded',
                  estimated_units: estimated_units ?? null,
                  task_ref,
                  ...err.detail,
                }

        // The transaction is already rolled back; these writes are outside it
        // on purpose, or the record of the refusal would roll back with it.
        recordDecision(request.log, {
          accountId, agentId: agent_id, customerRef, taskRef,
          reason: body.reason as string,
          estimatedUnits: estimated_units ?? null,
          ceilingUnits: (body as any).plan_limit ?? (body as any).task_ceiling ?? null,
          usedUnits: (body as any).monthly_calls ?? (body as any).task_used_units ?? null,
          snapshot: body,
        })
        await remember(body)
        return reply.send(body)
      }

      throw err
    }

    const row = result.row
    const remaining = row.limitUnits != null
      ? row.limitUnits - row.usedUnits - row.reservedUnits
      : null

    // For paid accounts: report usage to Polar for billing
    if (account.plan === 'paid' && account.polarCustomerId) {
      void reportUsage(account.polarCustomerId, 1)
    }

    const task = result.task
    const body = {
      approved: true,
      reason: null,
      estimated_units: estimated_units ?? null,
      remaining_units: remaining,
      // When settling this run, call record() before this timestamp. After it
      // the sweeper reclaims the reservation and the units stop being held.
      reservation_expires_at: expiresAt.toISOString(),
      ...(task
        ? {
            task_ref,
            task_remaining_units:
              task.ceilingUnits - task.usedUnits - task.reservedUnits,
          }
        : {}),
    }

    if (idempotency_key) {
      await sql`
        UPDATE preflight_requests
        SET response = ${JSON.stringify(body)}::json
        WHERE account_id = ${accountId} AND idempotency_key = ${idempotency_key}
      `.catch((err) => request.log.error({ err }, 'preflight idempotency write failed'))
    }

    return reply.send(body)
  })
}
