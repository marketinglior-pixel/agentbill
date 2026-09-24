// What one job's recorded calls were, by model and by step: calls, units,
// tokens by type, and an estimate at public list price. GET /tasks/:task_ref
// carries it as `breakdown`, additively.
//
// Read from events.task_ref (migration 017), so it sees the calls recorded
// from that migration on. A job with units recorded before it has units this
// breakdown cannot attribute, and it says how many (unattributed_units)
// instead of letting the rows look like the whole job.
//
// Token counts come from the metadata wrap() writes (tokens.input, ...), read
// only where the value is a whole number: metadata is the caller's, and one
// malformed record must not turn the job's page into a 500. A record with no
// model named is a call recorded by hand; it counts in calls and units, and
// in unpriced_calls, with that reason.
//
// Dollars: list_price_usd_estimate sums the priced calls only. A call that
// could not be priced is in unpriced_calls with its reason, and is never read
// as $0. When no call in a row is priced the estimate is null, not 0.
import postgres from 'postgres'
import { sql } from '../db/index.js'
import { unitsOf } from '../db/int8.js'
import { LIST_PRICE_LABEL } from './prices.js'

type Row = Record<string, unknown>

const TOKEN_FIELDS = ['input', 'cache_read', 'cache_write', 'cache_write_1h', 'output', 'reasoning'] as const

// A display count from a SUM (NUMERIC, so a string) of values that were each
// checked to be at most 15 digits. Not a ledger number: nothing compares it to
// a ceiling, so it is read as a plain Number and never throws.
const count = (v: unknown): number => (v == null ? 0 : Number(v))
const usd = (v: unknown): number | null => (v == null ? null : Number(v))

function shape(r: Row, noModel: boolean) {
  const tokens: Record<string, number> = {}
  // The pool camel-cases column names (tok_cache_read arrives as tokCacheRead).
  for (const f of TOKEN_FIELDS) tokens[f] = count(r[postgres.toCamel(`tok_${f}`)])
  const unpriced = count(r.unpricedCalls)
  const notes = Array.isArray(r.notes) ? (r.notes as string[]).filter(Boolean) : []
  if (noModel && unpriced > 0 && !notes.length) notes.push('no model named in the record: a call recorded by hand, not through wrap()')
  return {
    calls: count(r.calls),
    units: unitsOf(r.units ?? 0),
    tokens,
    usage_missing_calls: count(r.usageMissingCalls),
    list_price_usd_estimate: count(r.pricedCalls) > 0 ? usd(r.listPriceUsd) : null,
    priced_calls: count(r.pricedCalls),
    unpriced_calls: unpriced,
    unpriced_reasons: notes.slice(0, 5),
  }
}

// One SELECT list for both groupings. Each token sum reads the value only when
// it is a whole number of at most 15 digits.
const tokenSums = TOKEN_FIELDS.map((f) =>
  `sum(CASE WHEN metadata->'tokens'->>'${f}' ~ '^[0-9]{1,15}$' THEN (metadata->'tokens'->>'${f}')::bigint END) AS tok_${f}`
).join(',\n       ')

const AGG = `
       count(*) AS calls,
       coalesce(sum(units), 0) AS units,
       ${tokenSums},
       count(*) FILTER (WHERE metadata->>'usage_missing' = 'true') AS usage_missing_calls,
       sum(list_price_usd) AS list_price_usd,
       count(list_price_usd) AS priced_calls,
       count(*) - count(list_price_usd) AS unpriced_calls,
       array_agg(DISTINCT price_note) FILTER (WHERE price_note IS NOT NULL) AS notes,
       array_agg(DISTINCT price_version) FILTER (WHERE price_version IS NOT NULL) AS versions`

export async function taskBreakdown(accountId: string, taskRef: string, usedUnits: number) {
  const byModel = await sql.unsafe(`
    SELECT nullif(metadata->>'provider', '') AS provider,
           nullif(metadata->>'model', '') AS model,
           ${AGG}
    FROM events
    WHERE account_id = $1 AND task_ref = $2
    GROUP BY 1, 2
    ORDER BY sum(list_price_usd) DESC NULLS LAST, coalesce(sum(units), 0) DESC
    LIMIT 50`, [accountId, taskRef]) as Row[]
  const byStep = await sql.unsafe(`
    SELECT nullif(metadata->>'step', '') AS step,
           ${AGG}
    FROM events
    WHERE account_id = $1 AND task_ref = $2
    GROUP BY 1
    ORDER BY sum(list_price_usd) DESC NULLS LAST, coalesce(sum(units), 0) DESC
    LIMIT 50`, [accountId, taskRef]) as Row[]

  const models = byModel.map((r) => ({
    provider: (r.provider as string | null) ?? null,
    model: (r.model as string | null) ?? null,
    ...shape(r, r.model == null),
  }))
  const steps = byStep.map((r) => ({ step: (r.step as string | null) ?? null, ...shape(r, false) }))

  // Totals from their own aggregate, not from the rows above, so they hold
  // however many groups there are, and the dollar total is the exact SUM of
  // the stored decimals rather than a sum of the rows' floats.
  const [total] = await sql`
    SELECT count(*) AS calls,
           coalesce(sum(units), 0) AS units,
           count(list_price_usd) AS priced_calls,
           count(*) - count(list_price_usd) AS unpriced_calls,
           sum(list_price_usd) AS usd,
           array_agg(DISTINCT price_version) FILTER (WHERE price_version IS NOT NULL) AS versions
    FROM events
    WHERE account_id = ${accountId} AND task_ref = ${taskRef}
  `
  const units = unitsOf(total?.units ?? 0)
  const priced = count(total?.pricedCalls)

  return {
    calls: count(total?.calls),
    units,
    // The job's used_units that no row here accounts for: calls recorded
    // before events carried task_ref (migration 017). 0 for a job opened after.
    unattributed_units: Math.max(0, usedUnits - units),
    list_price_usd_estimate: priced > 0 ? usd(total?.usd) : null,
    priced_calls: priced,
    unpriced_calls: count(total?.unpricedCalls),
    price_versions: (Array.isArray(total?.versions) ? [...(total!.versions as string[])] : []).sort(),
    list_price_label: LIST_PRICE_LABEL,
    by_model: models,
    by_step: steps,
  }
}
