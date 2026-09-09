import { sql } from '../db/index.js'

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
  createdAt: Date
  updatedAt: Date
  taskCreated: boolean
}

export type SetTaskCeiling =
  | { ok: true; row: TaskCeilingRow }
  | { ok: false; reason: 'below_committed'; ceilingUnits: number; usedUnits: number; reservedUnits: number; minimum: number }

/** The agent label a job gets when it is opened from the console or the API
 *  without one. Attribution only; nothing is capped by it. Replaced by the
 *  first agent that spends under the job. */
export const CONSOLE_AGENT = 'console'

export async function setTaskCeiling(
  accountId: string,
  taskRef: string,
  ceilingUnits: number,
  agentId: string | null | undefined,
): Promise<SetTaskCeiling> {
  return sql.begin(async (tx) => {
    const [current] = await tx`
      SELECT ceiling_units, used_units, reserved_units
      FROM task_budgets
      WHERE account_id = ${accountId} AND task_ref = ${taskRef}
      FOR UPDATE
    `
    const below = (c: { ceilingUnits: unknown; usedUnits: unknown; reservedUnits: unknown }): SetTaskCeiling => {
      const usedUnits = Number(c.usedUnits)
      const reservedUnits = Number(c.reservedUnits)
      return { ok: false, reason: 'below_committed', ceilingUnits: Number(c.ceilingUnits), usedUnits, reservedUnits, minimum: usedUnits + reservedUnits }
    }
    if (current && Number(current.usedUnits) + Number(current.reservedUnits) > ceilingUnits) return below(current as any)

    // xmax = 0 is true only for a row this statement inserted; on the DO UPDATE
    // path it carries the locking transaction id. It decides one informational
    // field, never a write. Same trick as PUT /budget.
    const [row] = await tx`
      INSERT INTO task_budgets (account_id, agent_id, task_ref, ceiling_units)
      VALUES (${accountId}, ${agentId || CONSOLE_AGENT}, ${taskRef}, ${ceilingUnits})
      ON CONFLICT (account_id, task_ref) DO UPDATE
        SET ceiling_units = EXCLUDED.ceiling_units,
            updated_at    = now()
        WHERE task_budgets.used_units + task_budgets.reserved_units <= EXCLUDED.ceiling_units
      RETURNING task_ref, agent_id, ceiling_units, used_units, reserved_units, created_at, updated_at,
                (xmax = 0) AS task_created
    `
    if (!row) {
      // Only reachable if a row appeared between the SELECT and the INSERT
      // with units already committed, which a fresh row cannot have. Report
      // the locked truth rather than guess.
      const [again] = await tx`
        SELECT ceiling_units, used_units, reserved_units
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
        ceilingUnits: Number(row.ceilingUnits),
        usedUnits: Number(row.usedUnits),
        reservedUnits: Number(row.reservedUnits),
        createdAt: row.createdAt as Date,
        updatedAt: row.updatedAt as Date,
        taskCreated: row.taskCreated === true,
      },
    }
  })
}
