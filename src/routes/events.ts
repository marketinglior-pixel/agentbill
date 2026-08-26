import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sql } from '../db/index.js'
import { Resend } from 'resend'

const ALERT_THRESHOLD = 800
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null
const ownerAlertEmail = process.env.OWNER_ALERT_EMAIL

async function maybeSendThresholdAlert(customerRef: string, usedUnits: number, prevUsedUnits: number) {
  if (!resend || !ownerAlertEmail) return
  if (prevUsedUnits >= ALERT_THRESHOLD || usedUnits < ALERT_THRESHOLD) return
  await resend.emails.send({
    from: 'AgentBill <onboarding@resend.dev>',
    to: ownerAlertEmail,
    subject: `AgentBill: customer "${customerRef}" approaching 1000 units (${usedUnits} used)`,
    html: `
      <p>Customer <strong>${customerRef}</strong> has used <strong>${usedUnits} units</strong> and is approaching the 1000 free-tier limit.</p>
      <p>This is a good time to reach out and convert them to a paying customer.</p>
      <p><a href="https://agentbill.fly.dev/dashboard">View dashboard</a></p>
    `,
  })
}

const EventBody = z.object({
  customer_id:      z.string().min(1),
  event_type:       z.string().min(1),
  idempotency_key:  z.string().min(1).max(128),
  units:            z.number().int().min(0).default(1),
  metadata:         z.record(z.unknown()).optional(),
  success:          z.boolean().default(true),
  task_ref:         z.string().min(1).max(128).optional(),
})

export async function eventsRoute(app: FastifyInstance) {
  app.post('/events', async (request, reply) => {
    const parsed = EventBody.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(422).send({
        error: 'validation_error',
        message: parsed.error.issues[0]?.message ?? 'Invalid request body',
      })
    }

    const { customer_id: customerRef, event_type, idempotency_key, units, metadata, success, task_ref } = parsed.data
    const metadataJson = metadata !== undefined ? JSON.stringify(metadata) : null
    const accountId = request.accountId
    const defaultBudget: number | null = null

    try {
      const result = await sql.begin(async (tx) => {
        // ----------------------------------------------------------------
        // 1. Lazy-create customer if unknown.
        //    ON CONFLICT DO NOTHING so we never overwrite an existing row.
        // ----------------------------------------------------------------
        const inserted = await tx`
          INSERT INTO customers (account_id, customer_ref, limit_units)
          VALUES (${accountId}, ${customerRef}, ${defaultBudget})
          ON CONFLICT (account_id, customer_ref) DO NOTHING
          RETURNING *
        `

        const customerCreated = inserted.length > 0
        const customer = customerCreated
          ? inserted[0]
          : (await tx`
              SELECT * FROM customers
              WHERE account_id = ${accountId} AND customer_ref = ${customerRef}
            `)[0]

        // ----------------------------------------------------------------
        // 2. Lock the customer row to serialize concurrent billing writes.
        //    Without this, two simultaneous requests could both read
        //    used_units < limit and both proceed past the budget check.
        // ----------------------------------------------------------------
        const [locked] = await tx`
          SELECT id, limit_units, used_units, reserved_units
          FROM customers
          WHERE id = ${customer.id}
          FOR UPDATE
        `

        // ----------------------------------------------------------------
        // 3a. If success=false: release the preflight reservation only.
        //     No event recorded, no used_units incremented.
        // ----------------------------------------------------------------
        if (!success) {
          await tx`
            UPDATE customers
            SET reserved_units = GREATEST(0, reserved_units - ${units}),
                updated_at     = now()
            WHERE id = ${locked.id}
          `
          if (task_ref) {
            // Failed run: release the task reservation, spend nothing.
            await tx`
              UPDATE task_budgets
              SET reserved_units = GREATEST(0, reserved_units - ${units}),
                  updated_at     = now()
              WHERE account_id = ${accountId} AND task_ref = ${task_ref}
            `
          }
          return { type: 'released' as const, customerCreated }
        }

        // ----------------------------------------------------------------
        // 3b. Budget check — happens under the row lock.
        // ----------------------------------------------------------------
        if (
          locked.limitUnits !== null &&
          locked.usedUnits + units > locked.limitUnits
        ) {
          return { type: 'budget_exhausted' as const, customerRef }
        }

        // ----------------------------------------------------------------
        // 4. Insert event. ON CONFLICT DO NOTHING handles duplicates at
        //    DB level without an error — idempotency is enforced here.
        // ----------------------------------------------------------------
        const [event] = await tx`
          INSERT INTO events (account_id, customer_id, event_type, units, idempotency_key, metadata)
          VALUES (${accountId}, ${customer.id}, ${event_type}, ${units}, ${idempotency_key}, ${metadataJson})
          ON CONFLICT (account_id, idempotency_key) DO NOTHING
          RETURNING id
        `

        if (!event) {
          // Duplicate — row already exists, budget untouched
          return {
            type: 'duplicate' as const,
            customerCreated,
            remainingUnits: locked.limitUnits !== null
              ? locked.limitUnits - locked.usedUnits - locked.reservedUnits
              : null,
          }
        }

        // ----------------------------------------------------------------
        // 5. Reconcile: increment used_units and release the reservation
        //    that preflight placed. GREATEST(0, ...) guards against record
        //    calls that arrive without a prior preflight (no reservation held).
        // ----------------------------------------------------------------
        const [updated] = await tx`
          UPDATE customers
          SET used_units     = used_units + ${units},
              reserved_units = GREATEST(0, reserved_units - ${units}),
              updated_at     = now()
          WHERE id = ${customer.id}
          RETURNING used_units, limit_units, reserved_units
        `

        const remainingUnits = updated.limitUnits !== null
          ? updated.limitUnits - updated.usedUnits - updated.reservedUnits
          : null

        // ----------------------------------------------------------------
        // 6. Task reconcile: usage is recorded even past the ceiling —
        //    records report reality (the spend already happened); only
        //    preflight prevents. Overage surfaces as task_exceeded.
        // ----------------------------------------------------------------
        let taskRow = null
        if (task_ref) {
          const [t] = await tx`
            UPDATE task_budgets
            SET used_units     = used_units + ${units},
                reserved_units = GREATEST(0, reserved_units - ${units}),
                updated_at     = now()
            WHERE account_id = ${accountId} AND task_ref = ${task_ref}
            RETURNING ceiling_units, used_units, reserved_units
          `
          taskRow = t ?? null
        }

        return {
          type: 'recorded' as const,
          eventId: event.id as string,
          customerCreated,
          remainingUnits,
          prevUsedUnits: updated.usedUnits - units,
          usedUnits: updated.usedUnits,
          customerRef,
          taskRow,
        }
      })

      if (result.type === 'released') {
        return reply.code(200).send({
          status: 'released',
          customer_created: result.customerCreated,
        })
      }

      if (result.type === 'budget_exhausted') {
        return reply.code(402).send({
          error: 'budget_exhausted',
          message: `Customer ${result.customerRef} has 0 units remaining.`,
          customer_id: result.customerRef,
        })
      }

      if (result.type === 'duplicate') {
        return reply.code(200).send({
          event_id: null,
          status: 'duplicate_ignored',
          customer_created: result.customerCreated,
          customer_remaining_units: result.remainingUnits,
        })
      }

      maybeSendThresholdAlert(result.customerRef, result.usedUnits, result.prevUsedUnits).catch(() => {})

      const t = result.taskRow
      return reply.code(200).send({
        event_id: result.eventId,
        status: 'recorded',
        customer_created: result.customerCreated,
        customer_remaining_units: result.remainingUnits,
        ...(t
          ? {
              task_used_units: t.usedUnits,
              task_remaining_units: Math.max(0, t.ceilingUnits - t.usedUnits - t.reservedUnits),
              task_exceeded: t.usedUnits > t.ceilingUnits,
            }
          : {}),
      })

    } catch (err) {
      request.log.error(err)
      return reply.code(500).send({ error: 'internal_error', message: 'Unexpected server error' })
    }
  })
}
