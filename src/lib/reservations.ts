import type { Sql } from 'postgres'
import { unitsOf } from '../db/int8.js'

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
 *
 * This is the path for a record that does not name its reservation (every SDK
 * released before reservation_id existed, and raw HTTP callers that do not
 * pass one). It covers `amount` and no more, so a reservation larger than the
 * actual is shrunk and the rest stays held until the sweeper takes it. A
 * record that names its reservation goes through settleNamedReservation.
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
    const held = unitsOf(row.units)
    if (held <= remaining) {
      await tx`UPDATE reservations SET released_at = now() WHERE id = ${row.id}`
      remaining -= held
    } else {
      // Partially covered: shrink the row and leave it open, so the invariant
      // reserved_units == SUM(open units) still holds afterwards.
      await tx`UPDATE reservations SET units = units - ${remaining} WHERE id = ${row.id}`
      remaining = 0
    }
  }

  return amount - remaining
}

/**
 * The size of the oldest open reservation of this customer and task_ref, the
 * one consumeReservations closes first, or 0 when none is open.
 *
 * It is the floor for a usage_missing record that names no reservation (or
 * names one that is not found): charging at least this much and settling FIFO
 * by that amount closes this row whole. Read, not locked, exactly like the
 * FIFO settle's own SELECT: the caller holds the customer row lock, which is
 * what serialises records for one customer, and the sweeper claims with SKIP
 * LOCKED. If the sweeper takes this row in between, the floor still reflects
 * what the job had reserved for the call, and the settle releases only what it
 * finds open.
 */
export async function oldestOpenReservationUnits(tx: Tx, customerId: string, taskRef: string | null): Promise<number> {
  const [row] = await tx`
    SELECT units
    FROM reservations
    WHERE customer_id = ${customerId}
      AND task_ref IS NOT DISTINCT FROM ${taskRef}
      AND released_at IS NULL
    ORDER BY created_at, id
    LIMIT 1
  `
  return row ? unitsOf(row.units) : 0
}

/** What a record that named its reservation found. */
export type NamedReservation =
  | { state: 'open'; id: string | number; units: number }
  | { state: 'already_closed'; id: string | number; units: number }
  | { state: 'not_found' }

/**
 * Find and lock the reservation a record names, scoped so it can only ever be
 * this account's, this customer's and this task's. Another account's handle,
 * a handle for a different customer or task_ref, and a handle that never
 * existed all read the same: not_found. Nothing is changed here.
 *
 * Lock order matches every other settle path: the caller already holds the
 * customer row FOR UPDATE, and this locks the reservation row after it.
 */
export async function findNamedReservation(
  tx: Tx,
  accountId: string,
  customerId: string,
  taskRef: string | null,
  publicId: string
): Promise<NamedReservation> {
  const [row] = await tx`
    SELECT id, units, released_at
    FROM reservations
    WHERE public_id = ${publicId}
      AND account_id = ${accountId}
      AND customer_id = ${customerId}
      AND task_ref IS NOT DISTINCT FROM ${taskRef}
    FOR UPDATE
  `
  if (!row) return { state: 'not_found' }
  return { state: row.releasedAt == null ? 'open' : 'already_closed', id: row.id, units: unitsOf(row.units) }
}

/**
 * Close the named reservation WHOLE and return what it was holding, which is
 * what the caller must take off reserved_units. The unused part of a
 * reservation is released now rather than when the sweeper gets to it.
 *
 * Returns 0 when the row is already closed (settled by an earlier record, or
 * reclaimed by the sweeper), so settling the same reservation twice releases
 * it once. The `released_at IS NULL` guard makes that true even against a
 * writer that did not take the row lock.
 */
export async function settleNamedReservation(tx: Tx, r: NamedReservation): Promise<number> {
  if (r.state !== 'open') return 0
  const [closed] = await tx`
    UPDATE reservations SET released_at = now()
    WHERE id = ${r.id} AND released_at IS NULL
    RETURNING units
  `
  return closed ? unitsOf(closed.units) : 0
}
