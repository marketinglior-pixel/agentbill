import type { Sql } from 'postgres'

// How long a reservation holds budget before the sweeper reclaims it. Must be
// longer than the longest run a caller can legitimately have in flight, since
// a reclaimed reservation stops protecting that run's budget. Generous on
// purpose: the cost of a too-long TTL is budget held slightly too long, the
// cost of a too-short one is a ceiling that stops enforcing mid-run.
export const RESERVATION_TTL_MINUTES = Number(process.env.RESERVATION_TTL_MINUTES ?? 60)

export function reservationExpiry(now = new Date()): Date {
  return new Date(now.getTime() + RESERVATION_TTL_MINUTES * 60_000)
}

type Tx = Sql<{}> | any

/**
 * Close open reservations FIFO until `amount` units are covered, and report how
 * many were actually covered.
 *
 * The caller must decrement reserved_units by the RETURNED number, never by
 * `amount`. That is the whole point: if the sweeper already reclaimed this
 * reservation, there is no open row left, this returns 0, and the late settle
 * leaves reserved_units alone instead of subtracting a second time. Decrementing
 * by `amount` blindly is what would put the counter below the units actually
 * held and hand out budget that is still in flight.
 *
 * Rows are matched on (customer, task_ref) exactly, with NULL matching NULL, so
 * a settle for one task never consumes another task's reservation.
 */
export async function consumeReservations(
  tx: Tx,
  customerId: string,
  taskRef: string | null,
  amount: number
): Promise<number> {
  if (amount <= 0) return 0

  const open = await tx`
    SELECT id, units
    FROM reservations
    WHERE customer_id = ${customerId}
      AND task_ref IS NOT DISTINCT FROM ${taskRef}
      AND released_at IS NULL
    ORDER BY created_at, id
  `

  let remaining = amount
  for (const row of open) {
    if (remaining <= 0) break
    if (row.units <= remaining) {
      await tx`UPDATE reservations SET released_at = now() WHERE id = ${row.id}`
      remaining -= row.units
    } else {
      // Partially covered: shrink the row and leave it open, so the invariant
      // reserved_units == SUM(open units) still holds afterwards.
      await tx`UPDATE reservations SET units = units - ${remaining} WHERE id = ${row.id}`
      remaining = 0
    }
  }

  return amount - remaining
}
