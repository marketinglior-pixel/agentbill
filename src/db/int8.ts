// How an int8 (BIGINT) value comes back from Postgres, and why it is a number.
//
// postgres.js returns int8 as a string by default, because a JS number cannot
// hold every int8. That default is safe for a value nobody does arithmetic on
// and it is a trap for a ledger: `used + units > limit` on two strings is a
// string comparison, and `"100" + 5` is "1005". Every unit column in this
// schema was INTEGER (int4, parsed to a number) when that code was written,
// so nothing in src/ was ready for strings.
//
// This parser is what makes moving those columns to BIGINT safe, and it has to
// be live BEFORE the ALTER (migration 016), not after it: old code reading a
// BIGINT column gets strings and does the arithmetic above. That is the one
// place in this repo where the order is code first, migration second.
//
// It returns a number only when the number is exact. Past
// Number.MAX_SAFE_INTEGER (2^53 - 1) a JS number silently rounds, and a
// ceiling that rounds is a ceiling that is wrong without saying so, so the
// parser throws instead. postgres.js turns a throw inside a parser into a
// rejected query and keeps the connection usable (checked against 3.4.9: the
// next query on the same connection, and the next transaction, both succeed),
// so the failure is one loud 500 on the request that read the value.
//
// Values that were already int8 before the ALTER change type too: count(*),
// BIGSERIAL ids and the BIGINT columns of preflight_decisions now arrive as
// numbers. Every existing reader of those already wrapped them in Number(),
// which was audited when this landed. SUM() over a BIGINT column is NUMERIC,
// not int8, and still arrives as a string: wrap it in Number() or unitsOf().

export const INT8_OID = 20

export function parseInt8(text: string): number {
  const n = Number(text)
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`int8 value ${text} is outside the range a JS number holds exactly (+/-${Number.MAX_SAFE_INTEGER}); refusing to round it`)
  }
  return n
}

/** The postgres.js custom type. `from` makes every int8 column parse through
 *  parseInt8; `serialize` keeps parameters exactly as postgres.js sends them
 *  by default ('' + x), so no write changes. */
export const int8Type = {
  to: INT8_OID,
  from: [INT8_OID],
  serialize: (x: unknown) => '' + x,
  parse: parseInt8,
}

/**
 * A unit value read from a row, as an exact integer. Accepts a number (int4,
 * or int8 through the parser) or a numeric string (SUM over BIGINT), and
 * throws on anything that is not an exact integer, so a ledger comparison can
 * never run on a string or on a rounded value.
 */
export function unitsOf(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`expected an exact integer unit value, got ${JSON.stringify(v)}`)
  }
  return n
}

/** unitsOf, keeping SQL NULL as null (limit_units NULL means "no limit"). */
export function unitsOrNull(v: unknown): number | null {
  return v == null ? null : unitsOf(v)
}
