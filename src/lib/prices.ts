// A list-price estimate for one model call, from the token counts the caller's
// provider reported, and nothing else.
//
// What this is. An estimate at public list price: tokens times the per-token
// rates in a dated snapshot of LiteLLM's price table (./price-snapshot.ts,
// named by PRICE_VERSION). What it is not: your invoice. Contract discounts,
// batch pricing, regional and data-residency pricing, and server-side tool
// fees (web search, code execution) are not in it, and a provider can change a
// price before the snapshot does. Every figure this module produces is stored
// next to the version it came from.
//
// The one rule it exists to keep: a call it cannot price is NEVER $0. It
// returns no figure and a sentence saying why ("no list price for <model>"),
// and every reader counts that call as unpriced. A silent $0 is the failure a
// ceiling product cannot have: a job would look cheaper than it was, which is
// the one direction a ceiling must never drift. The price table itself writes
// 0 both for a free model and for one it has no price for, and the two cannot
// be told apart, so an entry listed at 0 for both input and output is
// treated as unpriced too.
//
// Arithmetic is exact: every rate is a whole number of picodollars (1e-12
// USD) per token (the snapshot generator refuses one that is not), so a cost
// is BigInt tokens times BigInt rate and the stored decimal is that integer
// with twelve places. No float ever reaches a stored figure.
//
// Tiers. A model the table prices higher above a prompt size (the
// _above_<N>k_tokens fields: 200k for Anthropic and Gemini, 272k for recent
// OpenAI models) is priced at the tier the request's own prompt reached, the
// input plus cache reads plus cache writes, for every token of that request,
// which is how those tiers are billed. A service tier the response reports
// (flex, priority) is priced at that tier's rates. Where the request crossed
// a tier, or used a service tier, and the table has no rate for one of the
// token types it used, the call is not priced, with a reason naming the tier.
import { PRICE_SNAPSHOT, type SnapshotModel } from './price-snapshot.js'

export const PRICE_VERSION = PRICE_SNAPSHOT.version

/** Token counts for one call, in disjoint buckets except the last three.
 *  output INCLUDES reasoning; reasoning is the part of it the provider called
 *  thinking. audio_input is a part of input + cache_read, audio_output a part
 *  of output. */
export type Tokens = {
  input: number
  cache_read: number
  cache_write: number
  cache_write_1h: number
  output: number
  reasoning: number
  audio_input: number
  audio_output: number
}

const TOKEN_KEYS = ['input', 'cache_read', 'cache_write', 'cache_write_1h', 'output', 'reasoning', 'audio_input', 'audio_output'] as const

export type MeteredCall = {
  provider: string
  model: string
  requestedModel?: string
  tokens: Tokens
  serviceTier?: string
}

export type CallPrice =
  | { ok: true; picoUsd: bigint; model: string }
  | { ok: false; note: string }

/** What an event row stores. All three null: the record named no model call. */
export type EventPrice = { priceVersion: string | null; listPriceUsd: string | null; note: string | null }

const PRICED_PROVIDERS = new Set(['openai', 'anthropic', 'gemini'])
const PROVIDER_NAME: Record<string, string> = { openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Google' }

const PICO = 1_000_000_000_000n

/** Picodollars as a decimal string with twelve places: exact, for a NUMERIC column. */
export function usdFromPico(pico: bigint): string {
  const neg = pico < 0n
  const abs = neg ? -pico : pico
  const whole = abs / PICO
  const frac = (abs % PICO).toString().padStart(12, '0')
  return `${neg ? '-' : ''}${whole}.${frac}`
}

function picoRate(rate: number): bigint {
  return BigInt(Math.round(rate * 1e12))
}

function lookup(name: string | undefined): { key: string; entry: SnapshotModel } | null {
  if (!name) return null
  const candidates = [name, name.toLowerCase(), name.replace(/^models\//, ''), name.toLowerCase().replace(/^models\//, '')]
  for (const key of candidates) {
    const entry = PRICE_SNAPSHOT.models[key]
    if (entry) return { key, entry }
  }
  return null
}

/** The long-context thresholds an entry prices above, in tokens, highest first. */
function tiersOf(entry: SnapshotModel): number[] {
  const out = new Set<number>()
  for (const f of Object.keys(entry.rates)) {
    const m = f.match(/_above_(\d+)k_tokens/)
    if (m) out.add(Number(m[1]) * 1000)
  }
  return [...out].sort((a, b) => b - a)
}

function serviceSuffix(tier: string | undefined): string | null {
  if (tier == null || tier === '' || tier === 'default' || tier === 'standard' || tier === 'auto') return ''
  if (tier === 'flex') return '_flex'
  if (tier === 'priority') return '_priority'
  return null
}

const BUCKET_LABEL: Record<string, string> = {
  input: 'input tokens',
  cache_read: 'cache reads',
  cache_write: 'cache writes',
  cache_write_1h: 'one-hour cache writes',
  output: 'output tokens',
  reasoning: 'reasoning tokens',
}

/** Price one call. Never returns a figure it had to invent. */
export function priceCall(call: MeteredCall): CallPrice {
  const { provider, model, tokens } = call
  if (!PRICED_PROVIDERS.has(provider)) {
    const base = provider.replace(/-compatible$/, '')
    if (provider.endsWith('-compatible') && PROVIDER_NAME[base]) {
      return { ok: false, note: `no list price for ${model}: it was called through an endpoint other than ${PROVIDER_NAME[base]}'s own API` }
    }
    if (provider === 'gemini-vertex') return { ok: false, note: `no list price for ${model} on Vertex AI in this price table` }
    return { ok: false, note: `no list price for ${model} from ${provider}` }
  }
  const found = lookup(model) ?? lookup(call.requestedModel)
  if (!found || found.entry.provider !== provider) return { ok: false, note: `no list price for ${model}` }
  const { entry } = found
  const rates = entry.rates
  if (rates.input_cost_per_token === 0 && rates.output_cost_per_token === 0) {
    return { ok: false, note: `no list price for ${model}: the price table lists 0 for it, which it also writes when it has no price` }
  }

  if (tokens.audio_input > 0 || tokens.audio_output > 0) {
    return { ok: false, note: `no list price for audio tokens on ${model} in this estimate` }
  }

  const service = serviceSuffix(call.serviceTier)
  if (service === null) return { ok: false, note: `no list price for ${model} at service tier ${call.serviceTier}` }

  const prompt = tokens.input + tokens.cache_read + tokens.cache_write + tokens.cache_write_1h
  const tier = tiersOf(entry).find((t) => prompt > t) ?? null
  const tierSuffix = tier == null ? '' : `_above_${tier / 1000}k_tokens`

  const rateFor = (base: string, bucket: string): { rate: bigint } | { note: string } => {
    const name = `${base}${tierSuffix}${service}`
    const v = rates[name]
    if (typeof v === 'number') return { rate: picoRate(v) }
    const where = [
      tier != null ? `above ${tier / 1000}k input tokens` : '',
      service ? `at service tier ${call.serviceTier}` : '',
    ].filter(Boolean).join(' and ')
    return { note: where ? `no list price for ${model} ${where} (${BUCKET_LABEL[bucket]})` : `no list price for ${BUCKET_LABEL[bucket]} on ${model}` }
  }

  // Output is billed at the output rate, reasoning included, unless the table
  // gives reasoning a rate of its own (some Gemini models); then the reasoning
  // part is priced at that rate and the rest at the output rate.
  const hasReasoningRate = Object.keys(rates).some((f) => f.startsWith('output_cost_per_reasoning_token'))
  const reasoning = hasReasoningRate ? Math.min(tokens.reasoning, tokens.output) : 0
  const parts: [string, string, number][] = [
    ['input_cost_per_token', 'input', tokens.input],
    ['cache_read_input_token_cost', 'cache_read', tokens.cache_read],
    ['cache_creation_input_token_cost', 'cache_write', tokens.cache_write],
    ['cache_creation_input_token_cost_above_1hr', 'cache_write_1h', tokens.cache_write_1h],
    ['output_cost_per_token', 'output', tokens.output - reasoning],
  ]
  let total = 0n
  for (const [base, bucket, n] of parts) {
    if (n <= 0) continue
    const r = rateFor(base, bucket)
    if ('note' in r) return { ok: false, note: r.note }
    total += BigInt(n) * r.rate
  }
  if (reasoning > 0) {
    const own = rateFor('output_cost_per_reasoning_token', 'reasoning')
    const r = 'rate' in own ? own : rateFor('output_cost_per_token', 'reasoning')
    if ('note' in r) return { ok: false, note: r.note }
    total += BigInt(reasoning) * r.rate
  }
  return { ok: true, picoUsd: total, model: found.key }
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

/**
 * What a record's metadata says about the model call it records, in the shape
 * wrap() writes (and any HTTP client may write):
 *
 *   { "provider": "openai", "model": "gpt-4o-mini-2024-07-18",
 *     "requested_model": "gpt-4o-mini",
 *     "tokens": { "input": 812, "cache_read": 0, "cache_write": 0,
 *                 "output": 96, "reasoning": 0 },
 *     "service_tier": "default", "step": "plan", "duration_ms": 740 }
 *
 * A record with no model string is not a model call, and is not priced.
 */
export function priceEvent(metadata: Record<string, unknown> | undefined, usageMissing: boolean): EventPrice {
  const none: EventPrice = { priceVersion: null, listPriceUsd: null, note: null }
  if (!metadata || typeof metadata !== 'object') return none
  const model = typeof metadata.model === 'string' ? metadata.model.trim().slice(0, 200) : ''
  if (!model) return none
  const unpriced = (note: string): EventPrice => ({ priceVersion: PRICE_VERSION, listPriceUsd: null, note })
  if (usageMissing) return unpriced('usage missing: the provider reported no token counts, so there is nothing to price')
  const provider = typeof metadata.provider === 'string' ? metadata.provider.trim().toLowerCase().slice(0, 64) : ''
  if (!provider) return unpriced(`no list price for ${model}: the record does not name its provider`)
  const raw = metadata.tokens
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return unpriced(`no list price for ${model}: the record carries no token counts`)
  const t = raw as Record<string, unknown>
  const tokens = {} as Tokens
  for (const k of TOKEN_KEYS) {
    const v = t[k] ?? 0
    if (!isCount(v)) return unpriced(`no list price for ${model}: token counts must be whole numbers of zero or more`)
    tokens[k] = v
  }
  if (tokens.reasoning > tokens.output || tokens.audio_output > tokens.output) {
    return unpriced(`no list price for ${model}: reasoning and audio output are parts of output and cannot exceed it`)
  }
  const requested = typeof metadata.requested_model === 'string' ? metadata.requested_model.trim().slice(0, 200) : undefined
  const serviceTier = typeof metadata.service_tier === 'string' ? metadata.service_tier.trim().toLowerCase().slice(0, 32) : undefined
  const price = priceCall({ provider, model, requestedModel: requested || undefined, tokens, serviceTier: serviceTier || undefined })
  return price.ok
    ? { priceVersion: PRICE_VERSION, listPriceUsd: usdFromPico(price.picoUsd), note: null }
    : unpriced(price.note)
}

/** The sentence every list-price figure travels with, on the API and in the console. */
export const LIST_PRICE_LABEL =
  'An estimate at public list price, from a dated snapshot of the LiteLLM price table named in price_versions. ' +
  'List price, your invoice may differ: contract discounts, batch and regional pricing, and server-side tool fees are not in it. ' +
  'A call with no list price is counted in unpriced_calls and left out of the estimate, never counted as $0.'
