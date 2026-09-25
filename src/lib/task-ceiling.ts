import { sql } from '../db/index.js'
import { unitsOf } from '../db/int8.js'

/**
 * The one statement that sets a job's ceiling from outside the calling code.
 * Both writers use it: PUT /tasks/:task_ref/ceiling and the console's form.
 * It is one function so the two cannot disagree about the rule.
 *
 * The rule (ticket 2026-09-10, "budget UX v1"):
 *
 *   The last successful save here is the ceiling preflight uses. Code may
 *   still open a job by passing task_ceiling on the first preflight of a new
 *   task_ref; once the row exists, a task_ceiling on preflight is not applied,
 *   and the ceiling changes only through this function, from the endpoint or
 *   the console. Until 2026-09-10 the first preflight's number was fixed for
 *   life and a later value from anywhere was dropped without a word.
 *
 * A ceiling may not land under what the job has already spent plus what is
 * reserved by calls in flight. That is refused with the number that would be
 * accepted, never clamped and never silently kept. A save rewrites no
 * reservation: each one settles through record() or expires on its TTL.
 *
 * The read and the write are one transaction on one row lock. The SELECT ...
 * FOR UPDATE waits for any preflight reserve on the same row to commit, so
 * the numbers a refusal reports are the numbers that refused, and a reserve
 * that arrives after the lock sees the new ceiling. The conditional WHERE on
 * the upsert stays as a second guard for the insert-vs-insert race.
 *
 * On the update path agent_id is left as the agent that opened the job: the
 * label attributes spend, and a save is not spend. A job opened without a
 * label carries CONSOLE_AGENT until the first agent spends under it
 * (preflight.ts claims the label in its reserve UPDATE).
 */
export type TaskCeilingRow = {
  taskRef: string
  agentId: string
  ceilingUnits: number
  usedUnits: number
  reservedUnits: number
  unit: TaskUnit
  usageMissingCalls: number
  unpricedCalls: number
  createdAt: Date
  updatedAt: Date
  taskCreated: boolean
}

export type SetTaskCeiling =
  | { ok: true; row: TaskCeilingRow }
  | { ok: false; reason: 'below_committed'; ceilingUnits: number; usedUnits: number; reservedUnits: number; minimum: number; unit: TaskUnit }
  | { ok: false; reason: 'unit_mismatch'; unit: TaskUnit }

/**
 * What a job's numbers count (migrations 014, 025). 'unit' is the developer's
 * own unit and the default; 'token' is a count the caller's provider reported,
 * which the SDKs' wrap() sends; 'usd' is integer micro-dollars at public list
 * price, which the SERVER works out: preflight reserves an estimate
 * (src/lib/usd-estimate.ts) and record charges the list price of the tokens
 * the record reports (src/lib/prices.ts). Declared by whoever opens the job
 * and fixed from then on.
 */
export const TASK_UNITS = ['unit', 'token', 'usd'] as const
export type TaskUnit = (typeof TASK_UNITS)[number]

export const asTaskUnit = (v: unknown): TaskUnit => (v === 'token' ? 'token' : v === 'usd' ? 'usd' : 'unit')

/** "tokens" / "units" / "micro-dollars", singular for exactly one. For labels next to a raw number. */
export function unitWord(unit: unknown, n = 2): string {
  const one = asTaskUnit(unit)
  if (one === 'usd') return n === 1 ? 'micro-dollar' : 'micro-dollars'
  return n === 1 ? one : `${one}s`
}

/** One dollar in the ledger's unit. */
export const MICROS_PER_USD = 1_000_000
/** The largest dollar ceiling accepted: $1,000,000, 1e12 micro-dollars, exact in a JS number and a BIGINT. */
export const USD_MICROS_MAX = 1_000_000_000_000

/** Micro-dollars as a plain dollar figure. Display and JSON only; the ledger stays in integers. */
export const usdOf = (micros: number): number => micros / MICROS_PER_USD

/**
 * Dollars, as a caller or a form sends them, to integer micro-dollars, or
 * null when the value is not a positive amount with at most six decimals
 * under USD_MICROS_MAX. Read through its decimal string, never multiplied as
 * a float, so "0.1" is exactly 100,000 and not 100,000.00000000001.
 */
export function microsFromUsd(v: unknown): number | null {
  const text = typeof v === 'number' ? (Number.isFinite(v) ? v.toFixed(7).replace(/0+$/, '').replace(/\.$/, '') : '') : typeof v === 'string' ? v.trim().replace(/^\$/, '') : ''
  const m = /^([0-9]{1,7})(?:\.([0-9]{1,6}))?$/.exec(text)
  if (!m) return null
  const micros = Number(m[1]) * MICROS_PER_USD + Number((m[2] ?? '').padEnd(6, '0'))
  return micros >= 1 && micros <= USD_MICROS_MAX ? micros : null
}

/**
 * A stored list price (events.list_price_usd, a NUMERIC with twelve places,
 * src/lib/prices.ts) to micro-dollars, rounded UP: a dollar ceiling may be
 * charged a fraction of a micro-dollar more than the call cost, never less.
 */
export function microsFromListPrice(decimal: string): number {
  const [whole, frac = ''] = decimal.split('.')
  const pico = BigInt(whole) * 1_000_000_000_000n + BigInt(frac.padEnd(12, '0').slice(0, 12) || '0')
  return Number((pico + 999_999n) / 1_000_000n)
}

/**
 * A micro-dollar amount the way a person reads one: $5.00, $0.225, $0.0081, $0.
 * Under a cent it keeps two significant figures, under a dollar up to four
 * decimals, and from a dollar two, so a job's $0.015 never reads as $0.02 and
 * a priced call never reads as the $0 it must not be.
 */
export function usdText(micros: number): string {
  return usdAmount(usdOf(micros))
}

/** The same rule on a dollar figure that may be finer than a micro-dollar (a stored list price). */
export function usdAmount(n: number): string {
  if (n === 0) return '$0'
  const a = Math.abs(n)
  if (a < 0.01) return '$' + n.toLocaleString('en-US', { maximumSignificantDigits: 2 })
  if (a < 1) {
    const [w, f = ''] = n.toFixed(4).replace(/0+$/, '').split('.')
    return `$${w}.${f.padEnd(2, '0')}`
  }
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** A job's number in its own unit, for a sentence: "$5.00", "20,000 tokens", "3 units". */
export function amountText(unit: unknown, n: number): string {
  const u = asTaskUnit(unit)
  return u === 'usd' ? usdText(n) : `${n.toLocaleString('en-US')} ${unitWord(u, n)}`
}

/** The one sentence a unit mismatch answers with, on preflight and on PUT. */
export function unitMismatchMessage(taskRef: string, jobUnit: string, declared: string): string {
  const name = (u: string) => (asTaskUnit(u) === 'usd' ? 'dollars' : unitWord(u))
  return `Task "${taskRef}" is counted in ${name(jobUnit)}, and this call declared ${name(declared)}. A job's unit is fixed when it opens, so every number in it stays the same kind of number. Send unit "${jobUnit}", leave unit out, or use a new task_ref for a job counted in ${name(declared)}.`
}

/** The agent label a job gets when it is opened from the console or the API
 *  without one. Attribution only; nothing is capped by it. Replaced by the
 *  first agent that spends under the job. */
export const CONSOLE_AGENT = 'console'

export async function setTaskCeiling(
  accountId: string,
  taskRef: string,
  ceilingUnits: number,
  agentId: string | null | undefined,
  // Read when this save opens the job; checked against an existing job. The
  // console form never sends one, so a console save neither sets nor checks it.
  unit?: TaskUnit,
): Promise<SetTaskCeiling> {
  return sql.begin(async (tx) => {
    const [current] = await tx`
      SELECT ceiling_units, used_units, reserved_units, unit
      FROM task_budgets
      WHERE account_id = ${accountId} AND task_ref = ${taskRef}
      FOR UPDATE
    `
    if (current && unit !== undefined && current.unit !== unit) {
      return { ok: false, reason: 'unit_mismatch', unit: asTaskUnit(current.unit) }
    }
    const below = (c: { ceilingUnits: unknown; usedUnits: unknown; reservedUnits: unknown; unit?: unknown }): SetTaskCeiling => {
      const usedUnits = unitsOf(c.usedUnits)
      const reservedUnits = unitsOf(c.reservedUnits)
      return { ok: false, reason: 'below_committed', ceilingUnits: unitsOf(c.ceilingUnits), usedUnits, reservedUnits, minimum: usedUnits + reservedUnits, unit: asTaskUnit(c.unit) }
    }
    if (current && unitsOf(current.usedUnits) + unitsOf(current.reservedUnits) > ceilingUnits) return below(current as any)

    // xmax = 0 is true only for a row this statement inserted; on the DO UPDATE
    // path it carries the locking transaction id. It decides one informational
    // field, never a write. Same trick as PUT /budget.
    // The unit is written only on the insert path. ON CONFLICT DO UPDATE sets
    // the ceiling and nothing else, so a save can never relabel a job.
    const [row] = await tx`
      INSERT INTO task_budgets (account_id, agent_id, task_ref, ceiling_units, unit)
      VALUES (${accountId}, ${agentId || CONSOLE_AGENT}, ${taskRef}, ${ceilingUnits}, ${unit ?? 'unit'})
      ON CONFLICT (account_id, task_ref) DO UPDATE
        SET ceiling_units = EXCLUDED.ceiling_units,
            updated_at    = now()
        WHERE task_budgets.used_units + task_budgets.reserved_units <= EXCLUDED.ceiling_units
      RETURNING task_ref, agent_id, ceiling_units, used_units, reserved_units, unit, usage_missing_calls, unpriced_calls,
                created_at, updated_at, (xmax = 0) AS task_created
    `
    if (!row) {
      // Only reachable if a row appeared between the SELECT and the INSERT
      // with units already committed, which a fresh row cannot have. Report
      // the locked truth rather than guess.
      const [again] = await tx`
        SELECT ceiling_units, used_units, reserved_units, unit
        FROM task_budgets
        WHERE account_id = ${accountId} AND task_ref = ${taskRef}
        FOR UPDATE
      `
      return below((again ?? { ceilingUnits: 0, usedUnits: 0, reservedUnits: 0 }) as any)
    }
    return {
      ok: true,
      row: {
        taskRef: row.taskRef as string,
        agentId: row.agentId as string,
        ceilingUnits: unitsOf(row.ceilingUnits),
        usedUnits: unitsOf(row.usedUnits),
        reservedUnits: unitsOf(row.reservedUnits),
        unit: asTaskUnit(row.unit),
        usageMissingCalls: unitsOf(row.usageMissingCalls),
        unpricedCalls: unitsOf(row.unpricedCalls ?? 0),
        createdAt: row.createdAt as Date,
        updatedAt: row.updatedAt as Date,
        taskCreated: row.taskCreated === true,
      },
    }
  })
}
