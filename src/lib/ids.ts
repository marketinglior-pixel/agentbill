import { z } from 'zod'

// The one rule for a caller-chosen string that ends up in a Postgres text
// column: agent_id, customer_id, task_ref, idempotency_key, event_type,
// step_name, a key label, a view id.
//
// It exists because Postgres does not accept a NUL byte in a text parameter.
// It answers 22021, "invalid byte sequence for encoding UTF8: 0x00", the driver
// puts that sentence in error.message, and Fastify's default error handler
// serialises it into the response body. So `GET /decisions?task_ref=%00` was a
// 500 carrying a database error, on a route whose own zod schema had already
// accepted the value: `z.string().min(1)` is true of a lone NUL byte.
//
// The rule is stricter than "no NUL" on purpose. These are identifiers, not
// prose: a tab, a newline or a DEL inside one is a bug at the caller, and a
// value that cannot be typed back into a URL or a log line is not an id. This
// is the same test the console's filter reader applies, and it is here rather
// than in two files so the two cannot drift.
//
// Length is part of the rule for the same reason. Several of these fields had
// no maximum at all, so an id was an unbounded write into an indexed column.
// 128 is what preflight already enforced on task_ref and idempotency_key.
export const ID_MAX = 128

const CONTROL = /[\u0000-\u001f\u007f]/

/** True when a string carries a C0 control character or DEL. */
export const hasControlChars = (v: string): boolean => CONTROL.test(v)

/** The predicate behind `zId`, for the one caller that does not use zod. */
export function isId(v: unknown, max: number = ID_MAX): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= max && !hasControlChars(v)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * True for the canonical form of a uuid.
 *
 * `accounts.id` is a uuid column, so a value of another shape is not a lookup
 * that finds nothing, it is Postgres 22P02 and a 500. The console's session
 * token has its own lowercase-only copy of this shape in app.ts, deliberately
 * left there: widening it to accept uppercase would change what authenticates.
 */
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v)

const MESSAGE = 'must not contain control characters'

/**
 * Adds the control-character rule to a string schema, keeping whatever bounds
 * that schema already declares. For free text (a name, a use case) rather than
 * an identifier: the length limits stay the route's own decision.
 */
export const plain = <T extends z.ZodString>(schema: T) => schema.refine((v) => !hasControlChars(v), MESSAGE)

/** An opaque identifier: 1 to `max` characters, no control characters. */
export const zId = (max: number = ID_MAX) => plain(z.string().min(1).max(max))

/**
 * An id on a route that reads "" as "not given".
 *
 * preflight, checkpoint and step all write `customer_id || 'default'`, so an
 * empty string was a documented way to say "the default customer" and zId's
 * min(1) turned it into a 422. Accepting it here keeps that contract instead
 * of quietly changing an API while fixing a different bug.
 */
export const zIdOrBlank = (max: number = ID_MAX) => z.union([z.literal(''), zId(max)])

/**
 * The largest value an INTEGER column holds.
 *
 * The string rules above exist because a value the schema accepts must be a
 * value the column accepts. Numbers had the same gap in the other direction:
 * every units and ceiling column is INTEGER, every schema said
 * `z.number().int()` with no ceiling, and 3_000_000_000 was Postgres 22003 and
 * a 500 on /events and /preflight.
 */
export const INT4_MAX = 2_147_483_647
