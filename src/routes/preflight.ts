import type { FastifyInstance, FastifyBaseLogger } from 'fastify'
import { z } from 'zod'
import { sql } from '../db/index.js'
import { zId, zIdOrBlank, INT4_MAX } from '../lib/ids.js'
import { reportUsage, PLAN_LIMITS } from '../integrations/polar.js'
import { recordDecision } from '../lib/decisions.js'
import { reservationExpiry } from '../lib/reservations.js'
import { alertQuota, thresholdCrossed } from '../lib/quota-alert.js'
import { CONSOLE_AGENT, TASK_UNITS, unitMismatchMessage } from '../lib/task-ceiling.js'
import { unitsOf, unitsOrNull } from '../db/int8.js'

const PreflightBody = z.object({
  agent_id: zId(),
  customer_id: zIdOrBlank().optional(),
  estimated_units: z.number().int().positive().max(INT4_MAX).optional(),
  ceiling: z.number().int().positive().max(INT4_MAX).optional(),
  task_ref: zId().optional(),
  task_ceiling: z.number().int().positive().max(INT4_MAX).optional(),
  idempotency_key: zId().optional(),
  // What this job's numbers count. Read when this call opens the job (with
  // task_ceiling); on a job that already exists it is checked, and a
  // different unit is a 422, never a relabel. Omitted, nothing is checked and
  // a job this call opens is counted in 'unit'. See migration 014.
  unit: z.enum(TASK_UNITS).optional(),
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
      | 'task_ceiling_required'
      | 'task_unit_mismatch',
    public detail: Record<string, unknown> = {}
  ) {
    super(reason)
  }
}

// Thrown when a concurrent request already claimed this idempotency key. The
// duplicate blocks on the unique index until the original commits, so by the
// time this is thrown the original's decision either exists or is one write away.
class ReplayNeeded extends Error {}

/** A decision as the route sends it: the HTTP status and the JSON body. */
export type ServiceResult = { status: number; body: unknown }

/**
 * The whole of POST /preflight for one account, without the HTTP around it.
 *
 * Lifted out of the route on 2026-09-25 so the remote MCP endpoint's preflight
 * tool (src/lib/mcp-tools.ts) runs this same function, not a copy of it and not
 * an HTTP call to this server: one reservation rule, one quota rule, one
 * idempotency rule, whichever door the call came through. `log` is the
 * request's logger. The route below is now three lines.
 */
export async function runPreflight(accountId: string, input: unknown, log: FastifyBaseLogger): Promise<ServiceResult> {
    const parse = PreflightBody.safeParse(input)
    if (!parse.success) {
      return { status: 422, body: { error: 'validation_error', details: parse.error.issues } }
    }

    const {
      agent_id, customer_id, estimated_units, ceiling,
      task_ref, task_ceiling, idempotency_key, unit,
    } = parse.data
    // A unit belongs to a job. Sent without one it would be read by nothing,
    // and a field the server silently ignores is how a caller comes to
    // believe a job is counted in tokens when no job was named.
    if (unit !== undefined && task_ref === undefined) {
      return { status: 422, body: {
        error: 'validation_error',
        message: 'unit describes a job, so it needs task_ref. Pass task_ref (and task_ceiling to open the job), or leave unit out.',
      } }
    }
    const customerRef = customer_id || 'default'
    const taskRef = task_ref ?? null

    // Same key, same decision, one reservation. Without this a retried
    // preflight reserved a second time, so the mechanism meant to prevent
    // waste was the one consuming the budget.
    //
    // And the same answer on the wire: the body, its status and
    // application/json. Until 2026-09-23 a replay went out as
    // HTTP 200 text/plain whatever it held, for two reasons. The body was
    // written ${JSON.stringify(body)}::json, and postgres.js JSON.stringify's a
    // json-typed parameter again, so every stored response was a JSON string
    // holding JSON text, which reply.send() sends as text. And no status was
    // kept, so a remembered 422 (task_ceiling_required) replayed as a 200 with
    // no approved key, which the Python SDK read as KeyError('approved').
    //
    // Read back as text, never as json: the pool's camel transform renames
    // the keys of a json value it parses (reservation_id would come back as
    // reservationId), the same reason decisions.ts reads snapshot as text.
    // A row written before the fix is that JSON string, so it is unwrapped
    // once more. A stored body with an error and no approved key can only be
    // a 422 that an earlier build remembered, and it is answered as a 422.
    //
    // It returns the remembered answer, or null when there is none. Until
    // 2026-09-23 it returned the Fastify reply, a thenable that resolves to
    // undefined once sent, so every replay fell through into the reserve
    // transaction, lost the claim, and sent twice more ("Reply was already
    // sent" in the server log). Since 2026-09-25 nothing in this function
    // sends at all: the route and the MCP tool each send what it returns.
    const replay = async (): Promise<ServiceResult | null> => {
      const [prior] = await sql`
        SELECT response::text AS response FROM preflight_requests
        WHERE account_id = ${accountId} AND idempotency_key = ${idempotency_key!}
      `
      if (!prior) return null
      if (prior.response == null) {
        // The deciding request committed but has not written its body yet.
        // Answering anything else here would either invent a decision or let
        // this retry reserve on top of one already held.
        return { status: 409, body: {
          error: 'preflight_in_progress',
          message: `A preflight with idempotency_key "${idempotency_key}" is still being decided. Retry in a moment.`,
        } }
      }
      let stored: unknown = JSON.parse(prior.response)
      if (typeof stored === 'string') stored = JSON.parse(stored)
      const legacy422 = stored !== null && typeof stored === 'object'
        && typeof (stored as Record<string, unknown>).error === 'string' && !('approved' in stored)
      return { status: legacy422 ? 422 : 200, body: stored }
    }

    // Remembers a decision reached outside the reserve transaction: the early
    // ceiling refusal and the approved:false refusals of the rollback path,
    // all of them HTTP 200. The two 422s (task_unit_mismatch,
    // task_ceiling_required) are deliberately not remembered: nothing was
    // reserved and no quota was burned, the claim on the key rolled back
    // with the transaction, so a retry with the same key is decided again,
    // and gets the same 422 with its own status or, once the job exists,
    // its approval. ::text::json so the column holds the object itself, not
    // a string of it. ON CONFLICT DO NOTHING so a concurrent evaluation of
    // the same key keeps whichever answer landed first.
    const remember = async (body: unknown) => {
      if (!idempotency_key) return
      await sql`
        INSERT INTO preflight_requests (account_id, idempotency_key, response)
        VALUES (${accountId}, ${idempotency_key}, ${JSON.stringify(body)}::text::json)
        ON CONFLICT (account_id, idempotency_key) DO NOTHING
      `.catch((err) => log.error({ err }, 'preflight idempotency write failed'))
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
      recordDecision(log, {
        accountId, agentId: agent_id, customerRef, taskRef,
        reason: body.reason, estimatedUnits: estimated_units, ceilingUnits: ceiling, snapshot: body,
      })
      await remember(body)
      return { status: 200, body }
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
      return { status: 401, body: { error: 'account_not_found' } }
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
              ? Math.max(0, unitsOf(current.limitUnits) - unitsOf(current.usedUnits) - unitsOf(current.reservedUnits))
              : 0,
          })
        }

        // Task-level ceiling: a cross-call budget for one job/run. Same atomic
        // reserve pattern as customers, scoped to (account_id, task_ref).
        let task = null
        if (task_ref) {
          if (task_ceiling != null) {
            // The first call for a new task_ref opens it with this ceiling.
            // Once the row exists, a task_ceiling sent here is not applied:
            // the ceiling changes only through PUT /tasks/:task_ref/ceiling or
            // the console form, and the last save is the one in force. So a
            // retry of THIS call cannot raise the number it was meant to
            // respect. An approved answer and a task_ceiling_exceeded refusal
            // carry the ceiling that decided them as task_ceiling; the other
            // refusals are decided before this row is consulted.
            await tx`
              INSERT INTO task_budgets (account_id, agent_id, task_ref, ceiling_units, unit)
              VALUES (${accountId}, ${agent_id}, ${task_ref}, ${task_ceiling}, ${unit ?? 'unit'})
              ON CONFLICT (account_id, task_ref) DO NOTHING
            `
          }

          // A declared unit is checked before anything is reserved, so a
          // mismatch rolls back like every other rejection here: no quota
          // burned, nothing held. The unit is fixed when the job opens.
          if (unit !== undefined) {
            const [declared] = await tx`
              SELECT unit FROM task_budgets
              WHERE account_id = ${accountId} AND task_ref = ${task_ref}
            `
            if (declared && declared.unit !== unit) {
              throw new PreflightRejection('task_unit_mismatch', { unit: declared.unit })
            }
          }

          // A job opened from the console or the API without an agent label
          // carries the placeholder CONSOLE_AGENT. The first agent that spends
          // under it claims the label, in the same conditional UPDATE as the
          // reserve, so attribution (GET /tasks?agent_id=, the refusals filter,
          // the leak decision) names the agent that ran and not the form. An
          // agent literally named "console" is relabelled by the next one to
          // spend; that is the cost of not adding a column for the flag.
          const taskReserved = await tx`
            UPDATE task_budgets
            SET reserved_units = reserved_units + ${reserveUnits},
                agent_id       = CASE WHEN agent_id = ${CONSOLE_AGENT} THEN ${agent_id} ELSE agent_id END,
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
                  task_ceiling: unitsOf(current.ceilingUnits),
                  task_used_units: unitsOf(current.usedUnits),
                  task_remaining_units: Math.max(
                    0, unitsOf(current.ceilingUnits) - unitsOf(current.usedUnits) - unitsOf(current.reservedUnits)
                  ),
                })
              : new PreflightRejection('task_ceiling_required')
          }
          task = taskReserved[0]
        }

        // The reservation becomes a row, not just a bump on a counter. This is
        // what lets an abandoned run be reclaimed: the counter alone cannot be
        // swept because it does not know how much of itself is stale.
        //
        // public_id is the handle the answer carries as reservation_id, so
        // record() can settle THIS reservation whole instead of shrinking the
        // oldest ones FIFO. Random, not the BIGSERIAL id, which is global and
        // would tell any caller how many preflights everyone else made.
        const [held] = await tx`
          INSERT INTO reservations (account_id, customer_id, task_ref, units, expires_at)
          VALUES (${accountId}, ${reserved[0].id}, ${taskRef}, ${reserveUnits}, ${expiresAt})
          RETURNING public_id
        `

        return { row: reserved[0], task, monthlyCalls: quota.monthlyCalls, reservationId: held.publicId as string }
      })
    } catch (err) {
      if (err instanceof ReplayNeeded) {
        const replayed = await replay()
        if (replayed) return replayed
        // The claiming transaction rolled back and freed the key. Nothing was
        // reserved under it, so the caller is safe to retry.
        return { status: 409, body: {
          error: 'preflight_in_progress',
          message: `A preflight with idempotency_key "${idempotency_key}" is still being decided. Retry in a moment.`,
        } }
      }

      if (err instanceof PreflightRejection) {
        if (err.reason === 'task_unit_mismatch') {
          const jobUnit = String(err.detail.unit)
          const body = {
            error: 'task_unit_mismatch',
            message: unitMismatchMessage(task_ref!, jobUnit, unit!),
            task_ref,
            unit: jobUnit,
            declared_unit: unit,
          }
          return { status: 422, body }
        }

        if (err.reason === 'task_ceiling_required') {
          const body = {
            error: 'task_ceiling_required',
            message: `Unknown task_ref "${task_ref}". Pass task_ceiling on the first preflight of a new task, or open the job first with PUT /tasks/:task_ref/ceiling or in the console.`,
          }
          return { status: 422, body }
        }

        const body =
          err.reason === 'plan_limit_exceeded'
            ? {
                approved: false,
                reason: account.plan === 'free' ? 'free_tier_exceeded' : 'plan_limit_exceeded',
                plan: account.plan,
                monthly_calls: err.detail.monthly_calls,
                plan_limit: planLimit,
                upgrade_url: `https://agentbill.dev/pricing?account_id=${accountId}`,
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

        // The first refusal of the period is the moment the customer needs to
        // hear about, because the wire stays quiet on purpose. Once per period,
        // enforced in the database; see quota-alert.ts.
        if (err.reason === 'plan_limit_exceeded' && planLimit !== null) {
          alertQuota(log, {
            accountId, plan: account.plan, limit: planLimit, threshold: 100,
            monthlyCalls: Number(err.detail.monthly_calls ?? planLimit),
          })
        }

        // The transaction is already rolled back; these writes are outside it
        // on purpose, or the record of the refusal would roll back with it.
        recordDecision(log, {
          accountId, agentId: agent_id, customerRef, taskRef,
          reason: body.reason as string,
          estimatedUnits: estimated_units ?? null,
          ceilingUnits: (body as any).plan_limit ?? (body as any).task_ceiling ?? null,
          usedUnits: (body as any).monthly_calls ?? (body as any).task_used_units ?? null,
          snapshot: body,
        })
        await remember(body)
        return { status: 200, body }
      }

      throw err
    }

    // Did this call cross 75% or 90% of the plan quota? The count came back
    // from the locked UPDATE, so exactly one call sees each integer.
    if (planLimit !== null) {
      const crossed = thresholdCrossed(result.monthlyCalls, planLimit)
      if (crossed) {
        alertQuota(log, {
          accountId, plan: account.plan, limit: planLimit, threshold: crossed,
          monthlyCalls: result.monthlyCalls,
        })
      }
    }

    const row = result.row
    const limit = unitsOrNull(row.limitUnits)
    const remaining = limit != null
      ? limit - unitsOf(row.usedUnits) - unitsOf(row.reservedUnits)
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
      // Pass this back on POST /events as reservation_id and the record
      // settles this reservation whole: the actual moves used_units and the
      // unused rest is released at once. Without it the record closes the
      // oldest reservations FIFO by the actual only.
      reservation_id: result.reservationId,
      ...(task
        ? {
            task_ref,
            // The ceiling that decided this call. Until 2026-09-10 an approved
            // answer did not carry it, so a task_ceiling the server did not
            // apply was invisible from code; the console row was the only
            // place the real number showed.
            task_ceiling: unitsOf(task.ceilingUnits),
            task_remaining_units:
              unitsOf(task.ceilingUnits) - unitsOf(task.usedUnits) - unitsOf(task.reservedUnits),
          }
        : {}),
    }

    if (idempotency_key) {
      await sql`
        UPDATE preflight_requests
        SET response = ${JSON.stringify(body)}::text::json
        WHERE account_id = ${accountId} AND idempotency_key = ${idempotency_key}
      `.catch((err) => log.error({ err }, 'preflight idempotency write failed'))
    }

    return { status: 200, body }
}

export async function preflightRoute(app: FastifyInstance) {
  app.post('/preflight', async (request, reply) => {
    const r = await runPreflight(request.accountId, request.body, request.log)
    return reply.status(r.status).send(r.body)
  })
}
