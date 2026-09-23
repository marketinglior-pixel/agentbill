/**
 * wrap(): automatic metering for an OpenAI, Anthropic or Google Gen AI client.
 *
 *   import OpenAI from 'openai'
 *   import { wrap } from 'agentbill'
 *
 *   const llm = wrap(new OpenAI(), { taskRef: 'job-7', agentId: 'researcher', taskCeiling: 200_000 })
 *   const reply = await llm.chat.completions.create({ model: 'gpt-4o-mini', max_tokens: 300, messages })
 *
 * The wrapped client is the same client: every property and method is the
 * original's, and the call still goes from this process straight to the
 * provider. Around the measured methods, and only those, wrap() adds two calls
 * to AgentBill:
 *
 *   before  POST /preflight on the job, in tokens (the job's unit is "token"),
 *           with an estimate worked out here (see Average). A refusal throws
 *           TaskCeilingExceededError BEFORE the provider call is sent: the
 *           wrapped call does not go out, and your code decides what happens next.
 *   after   POST /events with the usage the provider reported on the response
 *           this process received, idempotencyKey = the provider's response id,
 *           and the reservationId preflight returned, so the record settles that
 *           reservation whole. metadata: provider, model, the token breakdown,
 *           duration_ms and step. No prompt, no answer, no header, no key.
 *
 * Measured methods:
 *   OpenAI     chat.completions.create, responses.create
 *   Anthropic  messages.create
 *   Gemini     models.generateContent, models.generateContentStream (@google/genai)
 * streaming included (a stream is recorded when it ends, or when the loop over
 * it stops). Any other method, or a client you did not wrap, is not measured.
 *
 * Missing usage is recorded as missing, never as 0 (usageMissing: the server
 * charges the call at least its reservation). A provider error before any
 * response releases the reservation. A failed record never loses the answer: it
 * is returned, and a process warning says the record failed.
 *
 * The wrapped create returns a plain Promise, so the provider SDK's
 * APIPromise helpers (.withResponse(), .asResponse()) are not on it; call the
 * unwrapped client for those, and that call is not measured.
 */
import { createHash, randomUUID } from 'node:crypto'
import { preflight, record, type Preflight } from './index.js'

export type WrapProvider = 'openai' | 'anthropic' | 'gemini'

export interface WrapOptions {
  /** The job every call is counted against, in tokens. Opened with unit "token"
   *  by the first call when taskCeiling is passed, or open it first with
   *  PUT /tasks/:task_ref/ceiling and {"ceiling_units": N, "unit": "token"}. */
  taskRef?: string
  /** The attribution label, as on preflight(). */
  agentId?: string
  /** A label for this part of the job, stored on each record and broken out by
   *  GET /tasks/:task_ref. For another step, wrap the wrapped client again:
   *  wrap(llm, { step: 'summarize' }) shares the job's running average. */
  step?: string
  customerId?: string
  /** Opens the job with this ceiling, in tokens, if it does not exist yet. */
  taskCeiling?: number
  /** The estimate before the job's first measured call in this process.
   *  Default 2,000. See Average for the whole rule. */
  defaultEstimate?: number
  /** When detection from the client's shape cannot tell. */
  provider?: WrapProvider
}

const INT4_MAX = 2_147_483_647
export const DEFAULT_ESTIMATE = 2_000

type Kind = 'openai_chat' | 'openai_responses' | 'anthropic' | 'gemini' | 'gemini_stream'
const METHODS: Record<WrapProvider, Record<string, Kind>> = {
  openai: { 'chat.completions.create': 'openai_chat', 'responses.create': 'openai_responses' },
  anthropic: { 'messages.create': 'anthropic' },
  gemini: { 'models.generateContent': 'gemini', 'models.generateContentStream': 'gemini_stream' },
}
const COPIES: Record<WrapProvider, string[]> = { openai: ['withOptions'], anthropic: ['withOptions'], gemini: [] }
const OFFICIAL_HOST: Partial<Record<WrapProvider, string>> = { openai: 'api.openai.com', anthropic: 'api.anthropic.com' }

type Tokens = Record<string, number>
type Facts = { id?: unknown; model?: unknown; tier?: unknown; tokens: Tokens | null }

// ------------------------------------------------------------- field access

const get = (o: any, ...names: string[]): any => {
  if (o == null) return undefined
  for (const n of names) if (o[n] != null) return o[n]
  return undefined
}
const count = (o: any, ...names: string[]): number | undefined => {
  const v = get(o, ...names)
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined
}

function tokens(t: { input?: number; cache_read?: number; cache_write?: number; cache_write_1h?: number; output?: number; reasoning?: number; audio_input?: number; audio_output?: number }): Tokens {
  const input = t.input ?? 0, cache_read = t.cache_read ?? 0, output = t.output ?? 0
  const out: Tokens = { input, cache_read, cache_write: t.cache_write ?? 0, output, reasoning: Math.min(t.reasoning ?? 0, output) }
  if (t.cache_write_1h) out.cache_write_1h = t.cache_write_1h
  if (t.audio_input) out.audio_input = Math.min(t.audio_input, input + cache_read)
  if (t.audio_output) out.audio_output = Math.min(t.audio_output, output)
  return out
}
const prompt = (t: Tokens) => t.input + t.cache_read + t.cache_write + (t.cache_write_1h ?? 0)
const total = (t: Tokens) => prompt(t) + t.output

// ------------------------------------------------------------- usage, per provider
// Each returns the normalised tokens, or null when no usage was reported. null
// is recorded as usageMissing, never as 0.

function usageOpenAIChat(u: any): Tokens | null {
  const p = count(u, 'prompt_tokens'), c = count(u, 'completion_tokens')
  if (p === undefined && c === undefined) return null
  const pt = p ?? 0, ct = c ?? 0
  const cached = Math.min(count(u?.prompt_tokens_details, 'cached_tokens') ?? 0, pt)
  return tokens({
    input: pt - cached, cache_read: cached, output: ct,
    reasoning: count(u?.completion_tokens_details, 'reasoning_tokens'),
    audio_input: count(u?.prompt_tokens_details, 'audio_tokens'), audio_output: count(u?.completion_tokens_details, 'audio_tokens'),
  })
}

function usageOpenAIResponses(u: any): Tokens | null {
  const i = count(u, 'input_tokens'), o = count(u, 'output_tokens')
  if (i === undefined && o === undefined) return null
  const it = i ?? 0
  const cached = Math.min(count(u?.input_tokens_details, 'cached_tokens') ?? 0, it)
  return tokens({ input: it - cached, cache_read: cached, output: o ?? 0, reasoning: count(u?.output_tokens_details, 'reasoning_tokens') })
}

function usageAnthropic(u: any): Tokens | null {
  // input_tokens excludes cache reads and writes on this API; each is billed at its own rate.
  const i = count(u, 'input_tokens'), o = count(u, 'output_tokens')
  if (i === undefined && o === undefined) return null
  let written = count(u, 'cache_creation_input_tokens')
  let oneHour = count(u?.cache_creation, 'ephemeral_1h_input_tokens') ?? 0
  if (written === undefined) written = (count(u?.cache_creation, 'ephemeral_5m_input_tokens') ?? 0) + oneHour
  oneHour = Math.min(oneHour, written)
  return tokens({
    input: i ?? 0, cache_read: count(u, 'cache_read_input_tokens'), cache_write: written - oneHour, cache_write_1h: oneHour,
    output: o ?? 0, reasoning: count(u?.output_tokens_details, 'thinking_tokens'),
  })
}

const modality = (details: any, want: string) =>
  (Array.isArray(details) ? details : []).reduce((n: number, d: any) =>
    String(d?.modality ?? '').toUpperCase().endsWith(want) ? n + (count(d, 'tokenCount', 'token_count') ?? 0) : n, 0)

function usageGemini(u: any): Tokens | null {
  // Gemini reports thinking OUTSIDE candidates: total = prompt + candidates +
  // thoughts (+ tool-use prompt). Output here is candidates + thoughts.
  const p = count(u, 'promptTokenCount', 'prompt_token_count')
  const c = count(u, 'candidatesTokenCount', 'candidates_token_count')
  const th = count(u, 'thoughtsTokenCount', 'thoughts_token_count')
  if (p === undefined && c === undefined && th === undefined) return null
  const pt = p ?? 0
  const cached = Math.min(count(u, 'cachedContentTokenCount', 'cached_content_token_count') ?? 0, pt)
  const tool = count(u, 'toolUsePromptTokenCount', 'tool_use_prompt_token_count') ?? 0
  return tokens({
    input: pt - cached + tool, cache_read: cached, output: (c ?? 0) + (th ?? 0), reasoning: th,
    audio_input: modality(get(u, 'promptTokensDetails', 'prompt_tokens_details'), 'AUDIO'),
    audio_output: modality(get(u, 'candidatesTokensDetails', 'candidates_tokens_details'), 'AUDIO'),
  })
}

function factsOf(kind: Kind, r: any): Facts {
  if (kind === 'openai_chat') return { id: r?.id, model: r?.model, tier: r?.service_tier, tokens: usageOpenAIChat(r?.usage) }
  if (kind === 'openai_responses') return { id: r?.id, model: r?.model, tier: r?.service_tier, tokens: usageOpenAIResponses(r?.usage) }
  if (kind === 'anthropic') return { id: r?.id, model: r?.model, tier: r?.usage?.service_tier, tokens: usageAnthropic(r?.usage) }
  return { id: get(r, 'responseId', 'response_id'), model: get(r, 'modelVersion', 'model_version'), tokens: usageGemini(get(r, 'usageMetadata', 'usage_metadata')) }
}

/** What a stream has said so far: id, model, tier, usage. */
class StreamFacts {
  id: unknown; model: unknown; tier: unknown
  usage: any = null
  private merged: Record<string, unknown> = {}
  constructor(readonly kind: Kind, readonly swallow: boolean) {}

  /** Observe one item; true when it must not reach the caller. */
  see(item: any): boolean {
    const k = this.kind
    if (k === 'openai_chat') {
      this.id ??= item?.id; this.model ??= item?.model; this.tier = item?.service_tier ?? this.tier
      if (item?.usage != null) {
        this.usage = item.usage
        // The chunk include_usage adds: no choices, only usage. Hidden when
        // wrap() turned include_usage on, so the caller's loop sees exactly
        // the chunks it would have seen without us.
        return this.swallow && !(Array.isArray(item.choices) && item.choices.length)
      }
      return false
    }
    if (k === 'openai_responses') {
      const r = item?.response
      if (r) {
        this.id ??= r.id; this.model ??= r.model; this.tier = r.service_tier ?? this.tier
        if (r.usage != null) this.usage = r.usage
      }
      return false
    }
    if (k === 'anthropic') {
      if (item?.type === 'message_start') { this.id = item.message?.id; this.model = item.message?.model; this.merge(item.message?.usage) }
      else if (item?.type === 'message_delta') this.merge(item.usage)
      return false
    }
    this.id ??= get(item, 'responseId', 'response_id'); this.model ??= get(item, 'modelVersion', 'model_version')
    const u = get(item, 'usageMetadata', 'usage_metadata')
    if (u != null) this.usage = u
    return false
  }

  private merge(u: any) {
    if (u == null) return
    for (const f of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'cache_creation', 'service_tier', 'output_tokens_details']) {
      if (u[f] != null) this.merged[f] = u[f]
    }
    this.usage = this.merged
  }

  facts(): Facts {
    const u = this.usage
    const k = this.kind
    const t = u == null ? null
      : k === 'openai_chat' ? usageOpenAIChat(u)
      : k === 'openai_responses' ? usageOpenAIResponses(u)
      : k === 'anthropic' ? usageAnthropic(u)
      : usageGemini(u)
    return { id: this.id, model: this.model, tier: k === 'anthropic' ? u?.service_tier : this.tier, tokens: t }
  }
}

// ------------------------------------------------------------- the estimate

function maxTokens(kind: Kind, body: any): number | undefined {
  const whole = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : undefined)
  if (kind === 'openai_chat') return whole(body?.max_completion_tokens) ?? whole(body?.max_tokens)
  if (kind === 'openai_responses') return whole(body?.max_output_tokens)
  if (kind === 'anthropic') return whole(body?.max_tokens)
  return whole(body?.config?.maxOutputTokens) ?? whole(body?.config?.max_output_tokens)
}

/**
 * The job's running average, in this process: the estimate preflight reserves.
 *
 *   - Before the job has a measured call here: defaultEstimate (2,000 unless set).
 *   - After: the running mean of the total tokens of the job's measured calls
 *     through wrapped clients in this process.
 *   - When the call sets a maximum output (max_tokens, max_completion_tokens,
 *     max_output_tokens, Gemini's config.maxOutputTokens), never more than the
 *     running mean of the prompt plus that maximum.
 *
 * The prompt is not counted and no request is added. It is an estimate, not a
 * bound: a call with a far bigger prompt than usual uses more than it reserved,
 * and the record charges what the provider reported, so that call can take the
 * job past its ceiling, by at most that one call for each caller running at the
 * same moment. The next preflight is refused. A call with no usage does not
 * move the average.
 */
class Average {
  n = 0
  total = 0
  prompt = 0
  estimate(fallback: number, max?: number): number {
    let est = this.n ? this.total : fallback
    if (max !== undefined) est = Math.min(est, (this.n ? this.prompt : 0) + max)
    return Math.max(1, Math.min(INT4_MAX, Math.ceil(est)))
  }
  observe(t: Tokens) {
    this.n++
    this.total += (total(t) - this.total) / this.n
    this.prompt += (prompt(t) - this.prompt) / this.n
  }
}

function idempotencyKey(id: unknown, agentId: string): string {
  // eslint-disable-next-line no-control-regex
  if (typeof id === 'string' && id.length > 0 && !/[\u0000-\u001f\u007f]/.test(id)) {
    return id.length <= 128 ? id : `resp-${createHash('sha256').update(id).digest('hex').slice(0, 40)}`
  }
  return `${agentId}_${randomUUID()}`
}

// ------------------------------------------------------------- the meter

interface Meter {
  provider: WrapProvider
  endpoint: string
  taskRef: string
  agentId: string
  customerId?: string
  step?: string
  taskCeiling?: number
  defaultEstimate: number
  averages: Map<string, Average>
  warned: { quota: boolean }
}

const warn = (message: string) => process.emitWarning(message, { type: 'AgentBillWarning' })

function averageOf(m: Meter): Average {
  let a = m.averages.get(m.taskRef)
  if (!a) { a = new Average(); m.averages.set(m.taskRef, a) }
  return a
}

async function preflightFor(m: Meter, kind: Kind, body: any): Promise<Preflight> {
  const pf = await preflight({
    agentId: m.agentId, customerId: m.customerId, taskRef: m.taskRef, taskCeiling: m.taskCeiling, unit: 'token',
    estimatedUnits: averageOf(m).estimate(m.defaultEstimate, maxTokens(kind, body)),
  })
  if (!pf.approved && !m.warned.quota) {
    // Only AgentBill's own quota comes back unthrown; your spend rules throw.
    m.warned.quota = true
    warn(`AgentBill preflight answered ${pf.reason}: this account's own monthly quota is spent, so the job's ceiling was not checked for this call and the call is sent anyway. Upgrade: ${pf.upgradeUrl}`)
  }
  return pf
}

async function release(m: Meter, pf: Preflight) {
  if (!pf.approved) return
  try {
    await record({ agentId: m.agentId, customerId: m.customerId, taskRef: m.taskRef, units: 0, success: false, reservationId: pf.reservationId })
  } catch (e) {
    warn(`AgentBill could not release this call's reservation (${(e as Error).message}); it stays held until it expires.`)
  }
}

async function settle(m: Meter, pf: Preflight, facts: Facts, requested: unknown, started: number, streamed: boolean) {
  const t = facts.tokens
  const model = facts.model ?? requested
  const metadata: Record<string, unknown> = {
    provider: m.endpoint, model: model ? String(model) : 'unknown', duration_ms: Math.round(performance.now() - started),
  }
  if (requested && String(requested) !== metadata.model) metadata.requested_model = String(requested)
  if (t) metadata.tokens = t
  if (m.step) metadata.step = m.step
  if (streamed) metadata.stream = true
  if (facts.tier) metadata.service_tier = String(facts.tier)
  try {
    await record({
      agentId: m.agentId, customerId: m.customerId, taskRef: m.taskRef,
      units: t ? Math.min(total(t), INT4_MAX) : 0, idempotencyKey: idempotencyKey(facts.id, m.agentId),
      reservationId: pf.approved ? pf.reservationId : undefined, metadata, usageMissing: t === null,
    })
  } catch (e) {
    warn(`AgentBill could not record this call (${(e as Error).message}). The response is returned; the call's reservation stays held until it expires.`)
  }
  if (t) averageOf(m).observe(t)
}

function observed(inner: any, m: Meter, pf: Preflight, sf: StreamFacts, requested: unknown, started: number): any {
  let done = false
  const end = async () => {
    if (done) return
    done = true
    await settle(m, pf, sf.facts(), requested, started, true)
  }
  async function* iterate() {
    try {
      for await (const item of inner) {
        if (!sf.see(item)) yield item
      }
    } finally {
      // Normal end, an error, or a loop that stopped early (break calls
      // return(), which runs this). The request was sent when create()
      // resolved, so each of these is a call to record; one that ended before
      // its usage arrived is recorded as usage missing.
      await end()
    }
  }
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === Symbol.asyncIterator) return () => iterate()
      const v = Reflect.get(target, prop, target)
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
}

function measured(fn: (...a: any[]) => any, kind: Kind, m: Meter) {
  const shape: Kind = kind === 'gemini_stream' ? 'gemini' : kind
  return async (body: any, ...rest: any[]) => {
    let sent = body
    let swallow = false
    const streamed = kind === 'gemini_stream' || body?.stream === true
    if (kind === 'openai_chat' && streamed) {
      const opts = body?.stream_options
      if (!(opts && typeof opts === 'object' && 'include_usage' in opts)) {
        // Chat Completions streams report usage only when asked. Asked for
        // here, on a copy of your body, and the extra chunk is hidden. An
        // include_usage you set yourself is left as you set it.
        sent = { ...body, stream_options: { ...(opts && typeof opts === 'object' ? opts : {}), include_usage: true } }
        swallow = true
      }
    }
    const pf = await preflightFor(m, shape, sent)
    const started = performance.now()
    let res: any
    try {
      res = await fn(sent, ...rest)
    } catch (e) {
      await release(m, pf)
      throw e
    }
    if (streamed) return observed(res, m, pf, new StreamFacts(shape, swallow), sent?.model, started)
    await settle(m, pf, factsOf(shape, res), sent?.model, started, false)
    return res
  }
}

// ------------------------------------------------------------- the proxy

const WRAPPED = Symbol.for('agentbill.wrap')

function proxy<T extends object>(target: T, m: Meter, path: string[]): T {
  const methods = METHODS[m.provider]
  const handler: ProxyHandler<T> = {
    get(t, prop) {
      if (prop === WRAPPED) return path.length === 0 ? { target: t, meter: m } : undefined
      const value = Reflect.get(t, prop, t)
      if (typeof prop !== 'string') return value
      const p = [...path, prop]
      const name = p.join('.')
      if (typeof value === 'function') {
        if (methods[name]) return measured(value.bind(t), methods[name], m)
        if (p.length === 1 && COPIES[m.provider].includes(prop)) return (...a: any[]) => proxy(value.apply(t, a), m, [])
        // Bound to the real object: provider SDKs keep private fields, which
        // a method called on the proxy could not read.
        return value.bind(t)
      }
      if (value && typeof value === 'object' && Object.keys(methods).some((k) => k.startsWith(name + '.'))) {
        return proxy(value, m, p)
      }
      return value
    },
  }
  return new Proxy(target, handler)
}

// ------------------------------------------------------------- detection

const callable = (o: any, ...path: string[]) => {
  let v = o
  for (const k of path) { try { v = v?.[k] } catch { return false } }
  return typeof v === 'function'
}

function detect(client: any): WrapProvider | null {
  if (callable(client, 'chat', 'completions', 'create') || callable(client, 'responses', 'create')) return 'openai'
  if (callable(client, 'models', 'generateContent')) return 'gemini'
  if (callable(client, 'messages', 'create')) return 'anthropic'
  return null
}

/** A client on another host (Azure, a proxy, an OpenAI-compatible server) is
 *  recorded as "<provider>-compatible" and not priced: another host's prices
 *  are not the provider's list prices. Gemini on Vertex AI is "gemini-vertex". */
function endpointOf(client: any, provider: WrapProvider): string {
  const official = OFFICIAL_HOST[provider]
  if (official) {
    const base = client?.baseURL ?? client?.base_url
    let host: string | undefined
    try { host = base ? new URL(String(base)).hostname : undefined } catch { host = undefined }
    if (host && host !== official) return `${provider}-compatible`
  }
  if (provider === 'gemini' && client?.vertexai === true) return 'gemini-vertex'
  return provider
}

/**
 * Meter every call a model client makes through its create methods, in tokens.
 * Returns the client, wrapped; the original is untouched and unmeasured.
 * wrap() on a wrapped client returns another view of it with the options you
 * pass changed (step, most often), sharing the job's running average.
 */
export function wrap<T extends object>(client: T, options: WrapOptions = {}): T {
  const inner = (client as any)?.[WRAPPED] as { target: T; meter: Meter } | undefined
  if (inner) {
    if (options.provider) throw new TypeError('A wrapped client keeps its provider; wrap the original to change it.')
    const changed = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined))
    return proxy(inner.target, { ...inner.meter, ...changed }, [])
  }
  if (!options.taskRef || !options.agentId) {
    throw new TypeError('wrap() needs taskRef and agentId: the job to count against, and the label.')
  }
  const provider = options.provider ?? detect(client)
  if (!provider || !METHODS[provider]) {
    throw new TypeError('wrap() recognises an OpenAI, Anthropic or @google/genai client and could not tell what this is. Pass provider: "openai", "anthropic" or "gemini".')
  }
  if (options.defaultEstimate !== undefined && !(Number.isSafeInteger(options.defaultEstimate) && options.defaultEstimate >= 1)) {
    throw new TypeError('defaultEstimate is a whole number of tokens, 1 or more.')
  }
  return proxy(client, {
    provider, endpoint: endpointOf(client, provider), taskRef: options.taskRef, agentId: options.agentId,
    customerId: options.customerId, step: options.step, taskCeiling: options.taskCeiling,
    defaultEstimate: options.defaultEstimate ?? DEFAULT_ESTIMATE, averages: new Map(), warned: { quota: false },
  }, [])
}
