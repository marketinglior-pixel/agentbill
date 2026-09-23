import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sql } from '../db/index.js'
import { unitsOf, unitsOrNull } from '../db/int8.js'
import { zId, INT4_MAX } from '../lib/ids.js'
import { mailOwner, ownerMailReady } from '../lib/mail.js'
import { recordDecision } from '../lib/decisions.js'
import { consumeReservations, findNamedReservation, oldestOpenReservationUnits, settleNamedReservation, type NamedReservation } from '../lib/reservations.js'
import { jsonbSafe } from '../lib/jsonb.js'

const ALERT_THRESHOLD = 800

async function maybeSendThresholdAlert(customerRef: string, usedUnits: number, prevUsedUnits: number) {
  if (!ownerMailReady()) return
  if (prevUsedUnits >= ALERT_THRESHOLD || usedUnits < ALERT_THRESHOLD) return
  await mailOwner({
    subject: `AgentBill: customer "${customerRef}" has used ${usedUnits} units`,
    html: `
      <p>Customer <strong>${customerRef}</strong> has used <strong>${usedUnits} units</strong>, past the ${ALERT_THRESHOLD}-unit alert threshold. This is a usage signal, not the account's plan quota, which is counted in preflight calls per month.</p>
      <p>This is a good time to reach out and convert them to a paying customer.</p>
      <p><a href="https://agentbill.dev/admin">Open the admin radar</a></p>
    `,
  })
}

const EventBody = z.object({
  customer_id:      zId(),
  event_type:       zId(),
  idempotency_key:  zId(),
  // 0 is a real answer: a provider can report 0 tokens, and a tool call in a
  // tokens job costs 0 of them on its own. Until migration 015 the table said
  // CHECK (units >= 1) and this said min(1), so "it ran and cost nothing" was
  // a 422 and the only way around it was to skip record and leave the call's
  // reservation held until the sweeper took it.
  units:            z.number().int().min(0).max(INT4_MAX).default(1),
  metadata:         z.record(z.unknown()).optional(),
  success:          z.boolean().default(true),
  task_ref:         zId().optional(),
  // The reservation_id preflight returned. Settles THAT reservation whole:
  // units moves used_units and the unused rest is released now, instead of
  // closing the oldest rows FIFO by `units` and leaving the rest held until
  // the sweeper. Optional: a record without it behaves exactly as before.
  // null is read as absent, so a client serialising an empty field is fine.
  reservation_id:   z.string().uuid().nullish(),
  // The provider reported no usage for this call. It is NOT read as 0: the
  // call is charged at least the reservation this record settles (the one
  // reservation_id names, or else the oldest open one of this customer and
  // task_ref), and counted on the job as usage_missing_calls. With no
  // reservation open the units sent are recorded. See migration 015.
  usage_missing:    z.boolean().optional(),
})

type ReservationStatus = 'settled' | 'already_closed' | 'not_found'

const statusOf = (r: NamedReservation | null): ReservationStatus | null =>
  r == null ? null : r.state === 'open' ? 'settled' : r.state

export async function eventsRoute(app: FastifyInstance) {
  app.post('/events', async (request, reply) => {
    const parsed = EventBody.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(422).send({
        error: 'validation_error',
        message: parsed.error.issues[0]?.message ?? 'Invalid request body',
      })
    }

    const {
      customer_id: customerRef, event_type, idempotency_key, units: reportedUnits,
      metadata, success, task_ref, reservation_id, usage_missing,
    } = parsed.data
    const usageMissing = usage_missing === true
    // The event row's metadata, as JSON text jsonb accepts, built before the
    // transaction so nothing a caller put in it can roll the record back.
    // The caller's part is made valid first and the flag added after, so no
    // key of theirs can become usage_missing by losing a NUL.
    const safeMetadata = metadata !== undefined ? jsonbSafe(metadata) as Record<string, unknown> : undefined
    const rowMetadata = usageMissing ? { ...(safeMetadata ?? {}), usage_missing: true } : safeMetadata
    const metadataText = rowMetadata !== undefined ? JSON.stringify(rowMetadata) : null
    const accountId = request.accountId
    const defaultBudget: number | null = null
    const taskRef = task_ref ?? null

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
        const lockedLimit = unitsOrNull(locked.limitUnits)
        const lockedUsed = unitsOf(locked.usedUnits)
        const lockedReserved = unitsOf(locked.reservedUnits)

        // ----------------------------------------------------------------
        // 2b. The reservation this record names, if it names one. Found and
        //     locked, not yet closed: the budget check below may still refuse
        //     the record, and a refused record must leave its reservation as
        //     it found it, exactly as the unnamed path always has.
        // ----------------------------------------------------------------
        const named = reservation_id
          ? await findNamedReservation(tx, accountId, locked.id, taskRef, reservation_id)
          : null

        // What the call is charged. Normally what the caller reported. With
        // usage_missing it is never less than the reservation the record
        // settles: the caller's worst-case estimate, made before the call, is
        // the best number anyone has, and 0 would let a job look cheaper than
        // it was.
        //   - Named and found: that reservation. One already closed (settled
        //     or swept) still says how big it was, so it still sets the floor.
        //   - Unnamed, or a name that matched nothing: the oldest open
        //     reservation of this customer and task_ref, the one the FIFO
        //     settle below closes first. units is raised to at least its size,
        //     so that settle closes it whole. Until 2026-09-23 this path had no
        //     floor at all: preflight reserving 70,000 and then
        //     record(units 0, usage_missing) without reservation_id recorded 0
        //     and left the 70,000 held until the TTL.
        //   - No reservation open: there is nothing to go by, and the units
        //     sent are recorded. The job still counts the call in
        //     usage_missing_calls, so the total never reads as clean.
        const found = named != null && named.state !== 'not_found' ? named : null
        const floorUnits = !usageMissing
          ? 0
          : found
            ? found.units
            : await oldestOpenReservationUnits(tx, locked.id, taskRef)
        const units = usageMissing ? Math.max(reportedUnits, floorUnits) : reportedUnits

        // ----------------------------------------------------------------
        // 3a. If success=false: release the preflight reservation only.
        //     No event recorded, no used_units incremented.
        // ----------------------------------------------------------------
        if (!success) {
          // Close the reservation rows this run holds and release exactly what
          // they were holding, never the raw `units`. If the sweeper already
          // reclaimed them, consumed is 0 and the counters are left alone
          // instead of being decremented a second time. A named reservation
          // is released whole; an unnamed release goes FIFO by `units`, as
          // before, and so does a name that matched nothing.
          const consumed = found
            ? await settleNamedReservation(tx, found)
            : await consumeReservations(tx, locked.id, taskRef, reportedUnits)
          await tx`
            UPDATE customers
            SET reserved_units = GREATEST(0, reserved_units - ${consumed}),
                updated_at     = now()
            WHERE id = ${locked.id}
          `
          if (task_ref) {
            // Failed run: release the task reservation, spend nothing.
            await tx`
              UPDATE task_budgets
              SET reserved_units = GREATEST(0, reserved_units - ${consumed}),
                  updated_at     = now()
              WHERE account_id = ${accountId} AND task_ref = ${task_ref}
            `
          }
          return { type: 'released' as const, customerCreated, reservation: statusOf(named), consumed }
        }

        // ----------------------------------------------------------------
        // 3b. Budget check, happens under the row lock. Integers, never the
        //     raw row values: once these columns are BIGINT a driver that
        //     hands back strings turns this + into concatenation.
        // ----------------------------------------------------------------
        if (lockedLimit !== null && lockedUsed + units > lockedLimit) {
          return { type: 'budget_exhausted' as const, customerRef }
        }

        // ----------------------------------------------------------------
        // 4. Insert event. ON CONFLICT DO NOTHING handles duplicates at
        //    DB level without an error, idempotency is enforced here.
        //    usage_missing is stamped into the row's metadata, so the event
        //    itself says its units are a floor and not a measurement.
        // ----------------------------------------------------------------
        //
        //    ::text::jsonb, not a bare parameter. Bound straight to the jsonb
        //    column, postgres.js runs its own JSON.stringify on the string
        //    already serialized here, and until 2026-09-23 every metadata
        //    this route wrote was a JSON string holding JSON text:
        //    jsonb_typeof 'string', and metadata->>'anything' NULL. Nothing
        //    read the column, which is how it lasted. Rows written before the
        //    fix are still strings; read them with (metadata #>> '{}')::jsonb.
        //    Same trap, same cast, as recordDecision in lib/decisions.ts.
        //    jsonbSafe because the cast made jsonb's own input rules apply:
        //    a NUL or a lone surrogate in any string was accepted inside the
        //    old JSON string and is a 22P05 / 22P02 as an object. See
        //    lib/jsonb.ts; metadataText is built before the transaction.
        const [event] = await tx`
          INSERT INTO events (account_id, customer_id, event_type, units, idempotency_key, metadata)
          VALUES (${accountId}, ${customer.id}, ${event_type}, ${units}, ${idempotency_key}, ${metadataText}::text::jsonb)
          ON CONFLICT (account_id, idempotency_key) DO NOTHING
          RETURNING id
        `

        if (!event) {
          // Duplicate, row already exists, budget untouched. The first
          // request with this key already settled whatever it named.
          return {
            type: 'duplicate' as const,
            customerCreated,
            remainingUnits: lockedLimit !== null
              ? lockedLimit - lockedUsed - lockedReserved
              : null,
          }
        }

        // ----------------------------------------------------------------
        // 5. Reconcile: increment used_units and close the reservation rows
        //    preflight opened. used_units always moves by `units` because the
        //    spend really happened; reserved_units moves by `consumed`, the
        //    units the closed rows were actually holding.
        //
        //    Named and open: that one row closes whole, and consumed is all
        //    it held, so the part the call did not use is released now.
        //    Named and already closed: consumed is 0. It was this call's
        //    reservation and it is gone; taking the actual out of some other
        //    call's reservation instead would release budget that call still
        //    needs.
        //    Unnamed, or a name that matched nothing: FIFO by `units`, the
        //    path every record took before reservation_id existed, with its
        //    two known cases where consumed is 0:
        //      - record() with no prior preflight: nothing to release.
        //      - a reservation the sweeper already reclaimed: this late settle
        //        cannot subtract it a second time and push the counter below
        //        the units still in flight.
        // ----------------------------------------------------------------
        const consumed = found
          ? await settleNamedReservation(tx, found)
          : await consumeReservations(tx, customer.id, taskRef, units)

        const [updated] = await tx`
          UPDATE customers
          SET used_units     = used_units + ${units},
              reserved_units = GREATEST(0, reserved_units - ${consumed}),
              updated_at     = now()
          WHERE id = ${customer.id}
          RETURNING used_units, limit_units, reserved_units
        `
        const updatedUsed = unitsOf(updated.usedUnits)
        const updatedLimit = unitsOrNull(updated.limitUnits)

        const remainingUnits = updatedLimit !== null
          ? updatedLimit - updatedUsed - unitsOf(updated.reservedUnits)
          : null

        // ----------------------------------------------------------------
        // 6. Task reconcile: usage is recorded even past the ceiling,
        //    records report reality (the spend already happened); only
        //    preflight prevents. Overage surfaces as task_exceeded.
        // ----------------------------------------------------------------
        let taskRow: { agentId: string | null; ceilingUnits: number; usedUnits: number; reservedUnits: number } | null = null
        if (task_ref) {
          const [t] = await tx`
            UPDATE task_budgets
            SET used_units          = used_units + ${units},
                reserved_units      = GREATEST(0, reserved_units - ${consumed}),
                usage_missing_calls = usage_missing_calls + ${usageMissing ? 1 : 0},
                updated_at          = now()
            WHERE account_id = ${accountId} AND task_ref = ${task_ref}
            RETURNING agent_id, ceiling_units, used_units, reserved_units
          `
          taskRow = t
            ? { agentId: t.agentId ?? null, ceilingUnits: unitsOf(t.ceilingUnits), usedUnits: unitsOf(t.usedUnits), reservedUnits: unitsOf(t.reservedUnits) }
            : null
        }

        return {
          type: 'recorded' as const,
          eventId: event.id as string,
          customerCreated,
          remainingUnits,
          prevUsedUnits: updatedUsed - units,
          usedUnits: updatedUsed,
          customerRef,
          taskRow,
          units,
          reservation: statusOf(named),
          consumed,
        }
      })

      if (result.type === 'released') {
        return reply.code(200).send({
          status: 'released',
          customer_created: result.customerCreated,
          ...(result.reservation
            ? { reservation_status: result.reservation, reservation_released_units: result.consumed }
            : {}),
        })
      }

      if (result.type === 'budget_exhausted') {
        const body = {
          error: 'budget_exhausted',
          message: `Customer ${result.customerRef} has 0 units remaining.`,
          customer_id: result.customerRef,
        }
        recordDecision(request.log, {
          accountId, source: 'events', customerRef: result.customerRef, taskRef,
          reason: body.error, estimatedUnits: reportedUnits, snapshot: body,
        })
        return reply.code(402).send(body)
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
      const body = {
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
        // Present only when the request named a reservation. settled: that
        // row closed whole and reservation_released_units is what it held.
        // already_closed: an earlier record or the sweeper had closed it, and
        // nothing more was released. not_found: the id matched no reservation
        // of this customer and task_ref, so the record settled FIFO instead,
        // the way a record without an id does.
        ...(result.reservation
          ? { reservation_status: result.reservation, reservation_released_units: result.consumed }
          : {}),
        // Present only for usage_missing: the units the call was charged,
        // which is at least its reservation and may be more than was sent.
        ...(usageMissing ? { usage_missing: true, units_recorded: result.units } : {}),
      }
      // Spend that landed past the ceiling: preflight was skipped, or the
      // actual exceeded the estimate it approved. Nothing stopped it. Recorded
      // with blocked=false, the honest half of the receipt (a leak, not a save).
      if (t && t.usedUnits > t.ceilingUnits) {
        recordDecision(request.log, {
          accountId, source: 'events', blocked: false, agentId: t.agentId ?? null,
          customerRef: result.customerRef, taskRef,
          reason: 'task_overrun_recorded', estimatedUnits: result.units,
          ceilingUnits: t.ceilingUnits, usedUnits: t.usedUnits, snapshot: body,
        })
      }
      return reply.code(200).send(body)

    } catch (err) {
      request.log.error(err)
      return reply.code(500).send({ error: 'internal_error', message: 'Unexpected server error' })
    }
  })
}
