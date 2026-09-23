// wrap(): what it sends before and after a model call, per provider. Fake
// provider clients shaped like the real SDKs' responses (openai chat and
// responses, @anthropic-ai/sdk messages, @google/genai generateContent),
// streamed and not. AgentBill's own API is answered by undici's MockAgent, so
// no socket opens. The server half is gated in scripts/preflight/verify.mjs [wrap].
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici'

const RID = '3f1c2b7a-8d4e-4b1a-9c2d-5e6f7a8b9c0d'
const APPROVED = {
  approved: true, reason: null, estimated_units: 1, remaining_units: null,
  reservation_expires_at: '2026-09-24T12:00:00.000Z', reservation_id: RID,
  task_ref: 'job-7', task_ceiling: 100000, task_remaining_units: 99000,
}
const REFUSED = { approved: false, reason: 'task_ceiling_exceeded', estimated_units: 2000, task_ref: 'job-7', task_ceiling: 1000, task_used_units: 990, task_remaining_units: 10 }
const QUOTA = { approved: false, reason: 'free_tier_exceeded', plan: 'free', monthly_calls: 1000, plan_limit: 1000, upgrade_url: 'https://agentbill.dev/pricing?account_id=x' }
const RECORDED = { event_id: 'e1', status: 'recorded', customer_created: false, customer_remaining_units: null }
const ORIGIN = 'https://agentbill.test'

let sent = []
let answer = {}
let status = {}
let sdk
let previous
const warnings = []

before(async () => {
  previous = getGlobalDispatcher()
  const agent = new MockAgent()
  agent.disableNetConnect()
  agent.get(ORIGIN)
    .intercept({ path: () => true, method: () => true })
    .reply((req) => {
      const path = new URL(req.path, ORIGIN).pathname
      sent.push({ path, body: req.body ? JSON.parse(String(req.body)) : null })
      const body = answer[path] ?? (path === '/preflight' ? APPROVED : RECORDED)
      return { statusCode: status[path] ?? 200, data: JSON.stringify(body), responseOptions: { headers: { 'content-type': 'application/json' } } }
    })
    .persist()
  setGlobalDispatcher(agent)
  process.env.AGENTBILL_BASE_URL = ORIGIN
  process.env.AGENTBILL_API_KEY = 'agb_node_sdk_test_key_not_real'
  process.on('warning', (w) => { if (w.name === 'AgentBillWarning') warnings.push(w.message) })
  sdk = await import('../dist/index.js')
})

after(() => setGlobalDispatcher(previous))

const reset = (a = {}, s = {}) => { sent = []; answer = a; status = s; warnings.length = 0 }
const preflights = () => sent.filter((s) => s.path === '/preflight').map((s) => s.body)
const events = () => sent.filter((s) => s.path === '/events').map((s) => s.body)
const tick = () => new Promise((r) => setImmediate(r))

// ------------------------------------------------------------- fake providers

const chatCompletion = ({ prompt = 812, cached = 0, completion = 96, reasoning = 0, id = 'chatcmpl-abc123', usage = true } = {}) => ({
  id, model: 'gpt-4o-mini-2024-07-18', service_tier: 'default',
  usage: usage ? { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: cached, audio_tokens: 0 }, completion_tokens_details: { reasoning_tokens: reasoning, audio_tokens: 0 } } : undefined,
  choices: [{ message: { role: 'assistant', content: 'three uses' } }],
})

// A stream the way the openai and anthropic SDKs return one: async iterable,
// with properties of its own (controller) that must still be there.
function fakeStream(items) {
  return {
    controller: new AbortController(),
    async *[Symbol.asyncIterator]() { for (const i of items) yield i },
  }
}

class FakeOpenAI {
  // Private state, like the real SDK: a method called with `this` = a Proxy
  // could not read it, so this proves wrap() calls methods on the real object.
  #secret = 'private'
  constructor({ reply, chunks, response, events, throws } = {}) {
    this.sent = []
    this.baseURL = 'https://api.openai.com/v1'
    const self = this
    this.chat = { completions: { async create(body) {
      self.sent.push(body)
      if (throws) throw throws
      if (body.stream) return fakeStream(typeof chunks === 'function' ? [...chunks(body)] : chunks)
      return reply ?? chatCompletion()
    } } }
    this.responses = { async create(body) { self.sent.push(body); return body.stream ? fakeStream(events) : response } }
    this.models = { list: async () => ['gpt-4o-mini'] }
  }
  whoami() { return this.#secret }
}

const anthropicMessage = ({ inp = 1200, out = 300, cacheRead = 0, cacheWrite = 0, oneHour = 0, usage = true } = {}) => ({
  id: 'msg_01abc', model: 'claude-sonnet-4-5-20250929', content: [{ type: 'text', text: 'ok' }],
  usage: usage ? { input_tokens: inp, output_tokens: out, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite,
    cache_creation: { ephemeral_5m_input_tokens: cacheWrite - oneHour, ephemeral_1h_input_tokens: oneHour }, service_tier: 'standard' } : undefined,
})

class FakeAnthropic {
  constructor({ reply, events } = {}) {
    this.sent = []
    this.baseURL = 'https://api.anthropic.com'
    const self = this
    this.messages = { async create(body) { self.sent.push(body); return body.stream ? fakeStream(events) : (reply ?? anthropicMessage()) } }
  }
}

const geminiResponse = ({ prompt = 900, cand = 120, thoughts = 0, cached = 0, usage = true, id = 'gem-resp-1' } = {}) => ({
  responseId: id, modelVersion: 'gemini-2.5-flash', text: 'ok',
  usageMetadata: usage ? { promptTokenCount: prompt, candidatesTokenCount: cand, thoughtsTokenCount: thoughts, cachedContentTokenCount: cached, totalTokenCount: prompt + cand + thoughts } : undefined,
})

class FakeGoogleGenAI {
  constructor({ reply, chunks = [] } = {}) {
    this.sent = []
    const self = this
    this.models = {
      async generateContent(params) { self.sent.push(params); return reply ?? geminiResponse() },
      async generateContentStream(params) { self.sent.push(params); return (async function* () { for (const c of chunks) yield c })() },
    }
  }
}

// ------------------------------------------------------------- the round trip

test('openai chat: preflight in tokens, then the reported usage, keyed by the response id', async () => {
  reset()
  const oa = new FakeOpenAI({ reply: chatCompletion({ prompt: 812, cached: 200, completion: 96, reasoning: 10 }) })
  const llm = sdk.wrap(oa, { taskRef: 'job-7', agentId: 'researcher', step: 'plan' })
  const reply = await llm.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(reply.choices[0].message.content, 'three uses')
  const [pf] = preflights()
  assert.equal(pf.unit, 'token'); assert.equal(pf.task_ref, 'job-7'); assert.equal(pf.estimated_units, sdk.DEFAULT_ESTIMATE)
  const [ev] = events()
  assert.equal(ev.units, 908)
  assert.equal(ev.idempotency_key, 'chatcmpl-abc123')
  assert.equal(ev.reservation_id, RID)
  assert.equal(ev.metadata.provider, 'openai')
  assert.equal(ev.metadata.model, 'gpt-4o-mini-2024-07-18')
  assert.equal(ev.metadata.requested_model, 'gpt-4o-mini')
  assert.equal(ev.metadata.step, 'plan')
  assert.deepEqual(ev.metadata.tokens, { input: 612, cache_read: 200, cache_write: 0, output: 96, reasoning: 10 })
  assert.ok(Number.isInteger(ev.metadata.duration_ms))
  assert.equal('usage_missing' in ev, false)
  assert.equal(JSON.stringify(sent).includes('three uses'), false)
  assert.equal(JSON.stringify(sent).includes('"hi"'), false)
})

test('a refusal throws before the provider call is sent', async () => {
  reset({ '/preflight': REFUSED })
  const oa = new FakeOpenAI()
  const llm = sdk.wrap(oa, { taskRef: 'job-7', agentId: 'researcher' })
  await assert.rejects(llm.chat.completions.create({ model: 'gpt-4o-mini', messages: [] }), sdk.TaskCeilingExceededError)
  assert.equal(oa.sent.length, 0)
  assert.equal(events().length, 0)
})

test('missing usage is recorded as missing, never as 0', async () => {
  reset()
  const llm = sdk.wrap(new FakeOpenAI({ reply: chatCompletion({ usage: false }) }), { taskRef: 'job-7', agentId: 'r' })
  await llm.chat.completions.create({ model: 'gpt-4o-mini', messages: [] })
  const [ev] = events()
  assert.equal(ev.usage_missing, true)
  assert.equal('tokens' in ev.metadata, false)
  assert.equal(ev.reservation_id, RID)
})

test('a provider error releases the reservation and is thrown unchanged', async () => {
  reset()
  const boom = new Error('429 from the provider')
  const llm = sdk.wrap(new FakeOpenAI({ throws: boom }), { taskRef: 'job-7', agentId: 'r' })
  await assert.rejects(llm.chat.completions.create({ model: 'gpt-4o-mini', messages: [] }), (e) => e === boom)
  const [ev] = events()
  assert.equal(ev.success, false); assert.equal(ev.units, 0); assert.equal(ev.reservation_id, RID)
})

test('a failed record never loses the answer', async () => {
  reset({}, { '/events': 500 })
  const llm = sdk.wrap(new FakeOpenAI(), { taskRef: 'job-7', agentId: 'r' })
  const reply = await llm.chat.completions.create({ model: 'gpt-4o-mini', messages: [] })
  assert.equal(reply.id, 'chatcmpl-abc123')
  await tick()
  assert.ok(warnings.some((w) => /could not record/.test(w)), warnings.join(' | '))
})

test("AgentBill's own quota never stops the call", async () => {
  reset({ '/preflight': QUOTA })
  const oa = new FakeOpenAI()
  const llm = sdk.wrap(oa, { taskRef: 'job-7', agentId: 'r' })
  await llm.chat.completions.create({ model: 'gpt-4o-mini', messages: [] })
  assert.equal(oa.sent.length, 1)
  assert.equal('reservation_id' in events()[0], false)
  await tick()
  assert.ok(warnings.some((w) => /Upgrade/.test(w)), warnings.join(' | '))
})

// ------------------------------------------------------------- the estimate

test('the estimate is the running average, capped by the call’s maximum output', async () => {
  reset()
  const llm = sdk.wrap(new FakeOpenAI({ reply: chatCompletion({ prompt: 1000, completion: 500 }) }), { taskRef: 'job-7', agentId: 'r', defaultEstimate: 3000 })
  await llm.chat.completions.create({ model: 'gpt-4o-mini', messages: [], max_tokens: 200 })
  await llm.chat.completions.create({ model: 'gpt-4o-mini', messages: [] })
  await llm.chat.completions.create({ model: 'gpt-4o-mini', messages: [], max_completion_tokens: 100 })
  assert.deepEqual(preflights().map((p) => p.estimated_units), [200, 1500, 1100])
})

test('a re-wrap for another step shares the job average', async () => {
  reset()
  const base = sdk.wrap(new FakeOpenAI({ reply: chatCompletion({ prompt: 700, completion: 300 }) }), { taskRef: 'job-7', agentId: 'r', step: 'plan' })
  await base.chat.completions.create({ model: 'gpt-4o-mini', messages: [] })
  const summarize = sdk.wrap(base, { step: 'summarize' })
  await summarize.chat.completions.create({ model: 'gpt-4o-mini', messages: [] })
  assert.equal(preflights()[1].estimated_units, 1000)
  assert.deepEqual(events().map((e) => e.metadata.step), ['plan', 'summarize'])
})

// ------------------------------------------------------------- streaming

const chunk = (text, usage) => ({ id: 'chatcmpl-s1', model: 'gpt-4o-mini-2024-07-18', choices: text == null ? [] : [{ delta: { content: text } }], usage: usage ?? null })

test('openai stream: usage is turned on and the chunk it adds is hidden', async () => {
  reset()
  const chunks = function* (body) {
    yield chunk('Hel'); yield chunk('lo')
    if (body.stream_options?.include_usage) yield chunk(null, { prompt_tokens: 50, completion_tokens: 7 })
  }
  const oa = new FakeOpenAI({ chunks })
  const llm = sdk.wrap(oa, { taskRef: 'job-7', agentId: 'r' })
  const stream = await llm.chat.completions.create({ model: 'gpt-4o-mini', messages: [], stream: true })
  assert.ok(stream.controller instanceof AbortController)   // the stream's own properties are there
  const texts = []
  for await (const c of stream) texts.push(c.choices[0].delta.content)   // would throw on the usage chunk
  assert.deepEqual(texts, ['Hel', 'lo'])
  assert.deepEqual(oa.sent[0].stream_options, { include_usage: true })
  const [ev] = events()
  assert.equal(ev.units, 57); assert.equal(ev.idempotency_key, 'chatcmpl-s1'); assert.equal(ev.metadata.stream, true)
})

test('an include_usage the caller set is left alone, and the caller body is not mutated', async () => {
  reset()
  const oa = new FakeOpenAI({ chunks: [chunk('x')] })
  const llm = sdk.wrap(oa, { taskRef: 'job-7', agentId: 'r' })
  const body = { model: 'gpt-4o-mini', messages: [], stream: true }
  for await (const _ of await llm.chat.completions.create(body)) { /* read it all */ }
  assert.equal('stream_options' in body, false)
  const llm2 = sdk.wrap(new FakeOpenAI({ chunks: [chunk('x')] }), { taskRef: 'job-7', agentId: 'r' })
  for await (const _ of await llm2.chat.completions.create({ ...body, stream_options: { include_usage: false } })) { /* read */ }
  assert.equal(events()[1].usage_missing, true)
})

test('a loop that stops early still records, as usage missing', async () => {
  reset()
  const llm = sdk.wrap(new FakeOpenAI({ chunks: [chunk('a'), chunk('b'), chunk(null, { prompt_tokens: 9, completion_tokens: 2 })] }), { taskRef: 'job-7', agentId: 'r' })
  for await (const c of await llm.chat.completions.create({ model: 'gpt-4o-mini', messages: [], stream: true })) { if (c) break }
  const [ev] = events()
  assert.equal(ev.usage_missing, true)
})

test('openai responses, plain and streamed', async () => {
  reset()
  const usage = { input_tokens: 400, output_tokens: 80, input_tokens_details: { cached_tokens: 100 }, output_tokens_details: { reasoning_tokens: 30 } }
  const done = { id: 'resp_9', model: 'gpt-5-mini-2025-08-07', service_tier: 'flex', usage }
  const evs = [{ type: 'response.created', response: { id: 'resp_9', model: 'gpt-5-mini-2025-08-07' } }, { type: 'response.output_text.delta', delta: 'hi' }, { type: 'response.completed', response: done }]
  const llm = sdk.wrap(new FakeOpenAI({ response: done, events: evs }), { taskRef: 'job-7', agentId: 'r' })
  await llm.responses.create({ model: 'gpt-5-mini', input: 'hi', max_output_tokens: 50 })
  const seen = []
  for await (const e of await llm.responses.create({ model: 'gpt-5-mini', input: 'hi', stream: true })) seen.push(e.type)
  assert.deepEqual(seen, ['response.created', 'response.output_text.delta', 'response.completed'])
  for (const ev of events()) {
    assert.equal(ev.units, 480); assert.equal(ev.idempotency_key, 'resp_9'); assert.equal(ev.metadata.service_tier, 'flex')
    assert.deepEqual(ev.metadata.tokens, { input: 300, cache_read: 100, cache_write: 0, output: 80, reasoning: 30 })
  }
  assert.equal(preflights()[0].estimated_units, 50)
})

test('anthropic: cache reads and both cache writes, plain and streamed', async () => {
  reset()
  const streamEvents = [
    { type: 'message_start', message: { id: 'msg_s', model: 'claude-sonnet-4-5-20250929', usage: { input_tokens: 900, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    { type: 'content_block_delta', delta: { text: 'hi' } },
    { type: 'message_delta', usage: { output_tokens: 40 } },
    { type: 'message_delta', usage: { output_tokens: 75 } },
    { type: 'message_stop' },
  ]
  const llm = sdk.wrap(new FakeAnthropic({ reply: anthropicMessage({ inp: 1200, out: 300, cacheRead: 5000, cacheWrite: 800, oneHour: 300 }), events: streamEvents }), { taskRef: 'job-7', agentId: 'r' })
  await llm.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 1024, messages: [] })
  let n = 0
  for await (const _ of await llm.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 100, messages: [], stream: true })) n++
  assert.equal(n, 5)
  const [a, b] = events()
  assert.equal(a.units, 7300)
  assert.deepEqual(a.metadata.tokens, { input: 1200, cache_read: 5000, cache_write: 500, cache_write_1h: 300, output: 300, reasoning: 0 })
  assert.equal(a.metadata.service_tier, 'standard'); assert.equal(a.idempotency_key, 'msg_01abc')
  assert.equal(b.units, 975); assert.equal(b.idempotency_key, 'msg_s')
  assert.equal(preflights()[0].estimated_units, 1024)
})

test('gemini: thoughts count as output, outside candidates; the stream takes the last usage', async () => {
  reset()
  const g = new FakeGoogleGenAI({ reply: geminiResponse({ prompt: 900, cand: 120, thoughts: 600, cached: 300 }),
    chunks: [geminiResponse({ prompt: 50, cand: 3, id: 'g-s' }), geminiResponse({ prompt: 50, cand: 11, id: 'g-s' })] })
  const llm = sdk.wrap(g, { taskRef: 'job-7', agentId: 'r' })
  await llm.models.generateContent({ model: 'gemini-2.5-flash', contents: 'hi', config: { maxOutputTokens: 800 } })
  let n = 0
  for await (const _ of await llm.models.generateContentStream({ model: 'gemini-2.5-flash', contents: 'hi' })) n++
  assert.equal(n, 2)
  const [a, b] = events()
  assert.equal(a.units, 1620)
  assert.deepEqual(a.metadata.tokens, { input: 600, cache_read: 300, cache_write: 0, output: 720, reasoning: 600 })
  assert.equal(a.idempotency_key, 'gem-resp-1'); assert.equal(a.metadata.model, 'gemini-2.5-flash')
  assert.equal(b.units, 61); assert.equal(b.idempotency_key, 'g-s')
  assert.equal(preflights()[0].estimated_units, 800)
})

// ------------------------------------------------------------- the client stays the client

test('unmeasured methods are handed through, bound to the real object', async () => {
  reset()
  const oa = new FakeOpenAI()
  const llm = sdk.wrap(oa, { taskRef: 'job-7', agentId: 'r' })
  assert.deepEqual(await llm.models.list(), ['gpt-4o-mini'])
  assert.equal(llm.whoami(), 'private')             // a private field read through the wrap
  assert.equal(llm.baseURL, oa.baseURL)
  assert.equal(sent.length, 0)
  await oa.chat.completions.create({ model: 'gpt-4o-mini', messages: [] })   // the original is not wrapped
  assert.equal(sent.length, 0)
})

test('a client on another host is recorded as compatible', async () => {
  reset()
  const oa = new FakeOpenAI()
  oa.baseURL = 'https://my-proxy.example.com/v1'
  await sdk.wrap(oa, { taskRef: 'job-7', agentId: 'r' }).chat.completions.create({ model: 'gpt-4o-mini', messages: [] })
  assert.equal(events()[0].metadata.provider, 'openai-compatible')
})

test('wrap needs a job and a client it recognises', () => {
  assert.throws(() => sdk.wrap(new FakeOpenAI(), { taskRef: 'job-7' }), /taskRef and agentId/)
  assert.throws(() => sdk.wrap({}, { taskRef: 'job-7', agentId: 'r' }), /could not tell/)
})

test('getTask carries the breakdown when the server sends one, and nothing when it does not', async () => {
  const base = { task_ref: 'job-7', agent_id: 'r', ceiling_units: 10, used_units: 1, reserved_units: 0, remaining_units: 9, exceeded: false }
  reset({ '/tasks/job-7': { ...base, breakdown: { calls: 1, by_model: [] } } })
  assert.deepEqual((await sdk.getTask('job-7')).breakdown, { calls: 1, by_model: [] })
  reset({ '/tasks/job-7': base })
  assert.equal('breakdown' in (await sdk.getTask('job-7')), false)
})
