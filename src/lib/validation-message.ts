import type { ZodIssue } from 'zod'

// What a 422 says about the body it refused (2026-09-29).
//
// POST /events used to answer a body with no event_type with "Required" and
// nothing else: the first issue's message, without its path. A paid tester
// building in n8n spent over an hour guessing which field it meant, because
// the docs describe the SDK's record(), which fills event_type,
// customer_id and idempotency_key in for you, and a raw request does not.
// Every issue is named now, by its field, and the missing ones are listed
// together.

export type FieldProblem = { field: string; problem: string }

const isMissing = (i: ZodIssue): boolean => i.code === 'invalid_type' && (i as { received?: unknown }).received === 'undefined'

/** One sentence naming every field that was missing or wrong, and the same as a list. */
export function describeIssues(issues: readonly ZodIssue[], hint = ''): { message: string; fields: FieldProblem[] } {
  const fields = issues.map((i) => ({ field: i.path.join('.') || '(body)', problem: isMissing(i) ? 'required' : i.message }))
  const missing = [...new Set(fields.filter((f) => f.problem === 'required').map((f) => f.field))]
  const wrong = fields.filter((f) => f.problem !== 'required').map((f) => `${f.field}: ${f.problem}`)
  const parts: string[] = []
  if (missing.length) parts.push(`Missing required field${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}.`)
  if (wrong.length) parts.push(`${wrong.join('; ')}.`)
  if (hint) parts.push(hint)
  return { message: parts.join(' ') || 'Invalid request body.', fields }
}
