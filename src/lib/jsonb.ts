// A JSON value made storable in a jsonb column, the one way it can fail.
//
// jsonb is stricter than JSON.stringify. Two things a JS string can hold, and
// that JSON.stringify writes out as valid JSON text, are refused by jsonb's
// input function: the escape \u0000 ("unsupported Unicode escape sequence",
// jsonb stores text and text cannot hold NUL) and a lone UTF-16 surrogate
// such as \ud800 ("Unicode low surrogate must follow a high surrogate"). A
// string cut with .slice() in the middle of an emoji is enough for the second.
//
// Until /events stored metadata as a real object (::text::jsonb, 2026-09-23)
// it stored the whole thing as one JSON string, and both inputs were accepted.
// With the cast they were a 500 that rolled the record back, so the call went
// unrecorded and its reservation stayed held until the sweeper took it. An
// installed SDK that put text in metadata got that 500 with no change of its
// own. So the value is made valid here, before the transaction, instead:
// every NUL is removed and every lone surrogate becomes U+FFFD, in keys as
// well as in values, at any depth. Nothing else changes, and a value with
// neither is returned as the same structure it was.
//
// Only for jsonb. A plain json column (preflight_requests.response,
// preflight_decisions.snapshot) keeps its input text verbatim and accepts both.

// ES2024 string methods, present in every Node this runs on (engines: >=22)
// and missing from the ES2022 lib tsconfig compiles against.
declare global {
  interface String {
    isWellFormed(): boolean
    toWellFormed(): string
  }
}

const NUL = /\u0000/g

/** A string jsonb accepts: no NUL, and no lone surrogate (each becomes U+FFFD). */
export function jsonbString(s: string): string {
  const noNul = s.includes('\u0000') ? s.replace(NUL, '') : s
  return noNul.isWellFormed() ? noNul : noNul.toWellFormed()
}

/** A copy of a JSON value (what JSON.parse returns) that jsonb accepts. */
export function jsonbSafe(value: unknown): unknown {
  if (typeof value === 'string') return jsonbString(value)
  if (Array.isArray(value)) return value.map(jsonbSafe)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[jsonbString(k)] = jsonbSafe(v)
    return out
  }
  return value
}
