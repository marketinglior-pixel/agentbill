import type { FastifyBaseLogger } from 'fastify'
import { sql } from '../db/index.js'

// A refusal (or, from the record path, an overrun that got through). One row
// each, see migration 005. Written fire-and-forget: the caller's response
// must never wait on it or fail because of it, and it MUST use the
// module-level `sql`, never a transaction handle. preflight's task rejection
// throws inside sql.begin() by design, so anything written through that tx
// is rolled back and the table stays silently empty.
export interface Decision {
  accountId: string
  reason: string
  snapshot: unknown
  source?: 'preflight' | 'events'
  blocked?: boolean
  agentId?: string | null
  customerRef?: string | null
  taskRef?: string | null
  estimatedUnits?: number | null
  ceilingUnits?: number | null
  usedUnits?: number | null
}

export function recordDecision(log: FastifyBaseLogger, d: Decision): void {
  // ::text::json, not ::json: with a json-typed parameter postgres.js runs its
  // own JSON.stringify on the already-serialized body and stores a string
  // literal. Sending it as text keeps the bytes verbatim; the cast is server-side.
  const insert = sql`
    INSERT INTO preflight_decisions
      (account_id, agent_id, customer_ref, task_ref, reason, source, blocked,
       estimated_units, ceiling_units, used_units, snapshot)
    VALUES
      (${d.accountId}, ${d.agentId?.slice(0, 256) ?? null}, ${d.customerRef?.slice(0, 256) ?? null}, ${d.taskRef ?? null},
       ${d.reason}, ${d.source ?? 'preflight'}, ${d.blocked ?? true},
       ${d.estimatedUnits ?? null}, ${d.ceilingUnits ?? null}, ${d.usedUnits ?? null},
       ${JSON.stringify(d.snapshot)}::text::json)
  `
  insert.then(
    () => undefined,
    (err: unknown) => log.error({ err, reason: d.reason, source: d.source ?? 'preflight' }, 'preflight_decisions insert failed'),
  )
}
