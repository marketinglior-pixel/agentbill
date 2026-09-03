import { sql } from '../db/index.js'

// Reclaims the budget held by runs that never came back.
//
// preflight reserves before the call and record() settles after it. A process
// killed in between used to leave its units claimed forever: no expiry, no
// sweeper, and the ceiling silently tightened until someone cleared the counter
// by hand. This is the thing that clears it.
//
// The direction of the old failure matters for how this is written. A leaked
// reservation made the ceiling too TIGHT, never too loose, so nothing unsafe
// was ever approved. That is the property to preserve: every step here either
// reclaims exactly what a row holds or reclaims nothing, and no path can drive
// a counter below the units still genuinely in flight.

const SWEEP_INTERVAL_MS = 5 * 60_000  // 5 minutes
const BATCH_LIMIT = 500               // bound the work per tick

/**
 * Claim and release one batch of expired reservations. Returns the number of
 * rows reclaimed.
 *
 * Claim and counter-decrement happen in ONE transaction. If the process dies
 * mid-sweep the whole batch rolls back, so a row is never marked released while
 * its units are still counted against the budget. FOR UPDATE SKIP LOCKED makes
 * this safe to run on every machine at once, which it is: production runs two.
 */
export async function sweepExpiredReservations(): Promise<number> {
  return sql.begin(async (tx) => {
    const claimed = await tx`
      UPDATE reservations
      SET released_at = now()
      WHERE id IN (
        SELECT id FROM reservations
        WHERE released_at IS NULL AND expires_at < now()
        ORDER BY expires_at
        LIMIT ${BATCH_LIMIT}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, account_id, customer_id, task_ref, units
    `

    for (const row of claimed) {
      await tx`
        UPDATE customers
        SET reserved_units = GREATEST(0, reserved_units - ${row.units}),
            updated_at     = now()
        WHERE id = ${row.customerId}
      `
      if (row.taskRef) {
        await tx`
          UPDATE task_budgets
          SET reserved_units = GREATEST(0, reserved_units - ${row.units}),
              updated_at     = now()
          WHERE account_id = ${row.accountId} AND task_ref = ${row.taskRef}
        `
      }
    }

    return claimed.length
  })
}

async function tick(): Promise<void> {
  try {
    const reclaimed = await sweepExpiredReservations()
    if (reclaimed > 0) {
      console.log(`[reservation-sweeper] reclaimed ${reclaimed} expired reservation(s)`)
    }
  } catch (err) {
    // A failed sweep is not an outage. The budget stays held until the next
    // tick, which is the safe direction, so log and move on.
    console.error('[reservation-sweeper] sweep failed:', (err as Error).message)
  }
}

export function startReservationSweeper(): void {
  const timer = setInterval(() => { void tick() }, SWEEP_INTERVAL_MS)
  timer.unref() // never keep the process alive just for the sweeper
}
