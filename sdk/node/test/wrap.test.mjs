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
      const reqBody = req.body ? JSON.parse(String(req.body)) : null
      sent.push({ path, body: reqBody })
      const a = answer[path]
      const body = typeof a === 'function' ? a(reqBody) : a ?? (path === '/preflight' ? APPROVED : RECORDED)
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

test('a refusal is returned before the provider call is sent', async () => {
  reset({ '/preflight': REFUSED })
  const oa = new FakeOpenAI()
  const llm = sdk.wrap(oa, { taskRef: 'job-7', agentId: 'researcher' })
  const r = await llm.chat.completions.create({ model: 'gpt-4o-mini', messages: [] })   // nothing thrown
  assert.ok(sdk.isRefusal(r) && r instanceof sdk.Refusal)
  assert.equal(r.approved, false)
  assert.equal(r.reason, 'task_ceiling_exceeded'); assert.equal(r.taskRef, 'job-7')
  assert.deepEqual([r.used, r.ceiling, r.remaining, r.asked], [990, 1000, 10, 2000])
  assert.deepEqual(r.answer, REFUSED)                          // the server's answer, whole
  assert.ok(/990\/1000/.test(String(r)) && /not sent/.test(String(r)))
  assert.equal(oa.sent.length, 0)
  assert.equal(events().length, 0)
  // Not a provider response, and nothing on it pretends to be one.
  for (const k of ['choices', 'content', 'candidates', 'text', 'usage', 'message', 'output', 'id']) assert.equal(k in r, false, k)
  assert.equal(sdk.isRefusal(chatCompletion()), false); assert.equal(sdk.isRefusal(null), false)
  // The plain client is not changed: preflight() still throws, with the answer on it.
  await assert.rejects(sdk.preflight({ agentId: 'researcher', estimatedUnits: 2000, taskRef: 'job-7' }),
    (e) => e instanceof sdk.TaskCeilingExceededError && e.taskRemainingUnits === 10 && e.answer.task_used_units === 990)
})

test('a spent customer balance and a per-call ceiling are refusals too', async () => {
  reset({ '/preflight': { approved: false, reason: 'budget_exhausted', estimated_units: 2000, remaining_units: 0 } })
  const oa = new FakeOpenAI()
  const llm = sdk.wrap(oa, { taskRef: 'job-7', agentId: 'r', customerId: 'acme' })
  const r = await llm.chat.completions.create({ model: 'gpt-4o-mini', messages: [] })
  assert.ok(sdk.isRefusal(r)); assert.equal(r.reason, 'budget_exhausted'); assert.equal(r.remaining, 0); assert.equal(r.ceiling, undefined)
  assert.ok(/balance is spent/.test(String(r)))
  reset({ '/preflight': { approved: false, reason: 'ceiling_exceeded', estimated_units: 2000, ceiling: 500, remaining_units: null } })
  const c = await llm.chat.completions.create({ model: 'gpt-4o-mini', messages: [] })
  assert.ok(sdk.isRefusal(c)); assert.equal(c.reason, 'ceiling_exceeded'); assert.equal(c.ceiling, 500); assert.equal(c.asked, 2000)
  assert.equal(oa.sent.length, 0); assert.equal(events().length, 0)
  await assert.rejects(sdk.preflight({ agentId: 'r', estimatedUnits: 2000, ceiling: 500 }), sdk.CeilingExceededError)   // preflight(): unchanged
})

test('a refused stream is the refusal, and iterates to nothing', async () => {
  reset({ '/preflight': REFUSED })
  const oa = new FakeOpenAI({ chunks: [chunk('never')] })
  const llm = sdk.wrap(oa, { taskRef: 'job-7', agentId: 'r' })
  const s = await llm.chat.completions.create({ model: 'gpt-4o-mini', messages: [], stream: true })
  assert.ok(sdk.isRefusal(s))
  const seen = []
  for await (const c of s) seen.push(c)                        // a loop written for the stream runs zero times
  assert.deepEqual(seen, []); assert.deepEqual([...s], [])
  assert.equal(oa.sent.length, 0); assert.equal(events().length, 0)
  // The same on a Gemini stream.
  const g = new FakeGoogleGenAI({ chunks: [geminiResponse()] })
  const gs = await sdk.wrap(g, { taskRef: 'job-7', agentId: 'r' }).models.generateContentStream({ model: 'gemini-2.5-flash', contents: 'x' })
  assert.ok(sdk.isRefusal(gs)); assert.equal(g.sent.length, 0)
  // An approved stream carries .refusal, and it is null.
  reset()
  const ok = await llm.chat.completions.create({ model: 'gpt-4o-mini', messages: [], stream: true })
  assert.equal(sdk.isRefusal(ok), false); assert.equal(ok.refusal, null)
})

test('real failures still reject', async () => {
  // A refusal is a value; a failure is an error, the same AgentBillError preflight() throws.
  const oa = new FakeOpenAI()
  const llm = sdk.wrap(oa, { taskRef: 'job-7', agentId: 'r' })
  reset({ '/preflight': { error: 'unauthorized', message: 'Invalid API key.' } }, { '/preflight': 401 })
  await assert.rejects(llm.chat.completions.create({ model: 'gpt-4o-mini', messages: [] }), (e) => e instanceof sdk.AgentBillError && /401/.test(e.message))
  reset({ '/preflight': { error: 'boom' } }, { '/preflight': 500 })
  await assert.rejects(llm.chat.completions.create({ model: 'gpt-4o-mini', messages: [] }), (e) => e instanceof sdk.AgentBillError && /500/.test(e.message))
  reset({ '/preflight': { error: 'task_unit_mismatch', message: 'job-7 is counted in unit' } }, { '/preflight': 422 })
  await assert.rejects(llm.chat.completions.create({ model: 'gpt-4o-mini', messages: [] }), (e) => e instanceof sdk.AgentBillError && /task_unit_mismatch/.test(e.message))
  reset({ '/preflight': () => { throw new Error('connection refused') } })
  await assert.rejects(llm.chat.completions.create({ model: 'gpt-4o-mini', messages: [] }), (e) => !sdk.isRefusal(e))
  assert.equal(oa.sent.length, 0); assert.equal(events().length, 0)
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

test('a spent quota is refused by default, and the call is not sent', async () => {
  // Once the account's monthly quota is spent, preflight answers before it
  // looks at the job: no ceiling is checked. Sending anyway would turn the
  // ceiling off without a word, so the default refuses, and preflight()
  // itself still returns approved: false rather than throwing.
  reset({ '/preflight': QUOTA })
  const oa = new FakeOpenAI()
  const llm = sdk.wrap(oa, { taskRef: 'job-7', agentId: 'r' })
  const spent = await llm.chat.completions.create({ model: 'gpt-4o-mini', messages: [] })
  assert.ok(sdk.isRefusal(spent)); assert.equal(spent.reason, 'free_tier_exceeded'); assert.equal(spent.approved, false)
  assert.equal(spent.upgradeUrl, QUOTA.upgrade_url); assert.deepEqual(spent.answer, QUOTA); assert.equal(spent.taskRef, 'job-7')
  assert.deepEqual([spent.used, spent.ceiling, spent.remaining], [undefined, undefined, undefined])   // the job was not looked at
  assert.ok(/job 'job-7'/.test(String(spent)) && /not sent/.test(String(spent)) && /onQuota: 'send'/.test(String(spent)))
  reset({ '/preflight': { ...QUOTA, reason: 'plan_limit_exceeded', plan: 'starter' } })
  const plan = await llm.chat.completions.create({ model: 'gpt-4o-mini', messages: [] })
  assert.ok(sdk.isRefusal(plan)); assert.equal(plan.reason, 'plan_limit_exceeded'); assert.equal(plan.answer.plan, 'starter')
  assert.equal(oa.sent.length, 0)
  assert.equal(events().length, 0)
  const pf = await sdk.preflight({ agentId: 'r', estimatedUnits: 1, taskRef: 'job-7' })
  assert.equal(pf.approved, false); assert.equal(JSON.stringify(pf).includes('answer'), false)   // answer is there, not enumerable
})

test("onQuota 'send' sends unchecked, and warns once per job", async () => {
  reset({ '/preflight': QUOTA })
  const oa = new FakeOpenAI()
  const llm = sdk.wrap(oa, { taskRef: 'job-7', agentId: 'r', onQuota: 'send' })
  const other = sdk.wrap(llm, { taskRef: 'job-8' })         // a view of it: onQuota carries over
  for (let i = 0; i < 3; i++) await llm.chat.completions.create({ model: 'gpt-4o-mini', messages: [] })
  await other.chat.completions.create({ model: 'gpt-4o-mini', messages: [] })
  await tick()
  const quota = warnings.filter((w) => /quota/.test(w))
  assert.equal(quota.length, 2, quota.join(' | '))
  assert.ok(/'job-7'/.test(quota[0]) && /'job-8'/.test(quota[1]) && /nothing bounds the job/.test(quota[0]) && quota[0].includes(QUOTA.upgrade_url))
  assert.equal(oa.sent.length, 4)
  assert.ok(events().every((e) => !('reservation_id' in e)))   // nothing was reserved
})

test("onQuota is 'refuse' or 'send'", () => {
  for (const bad of ['ignore', 'raise']) {                    // 'raise' was the name before refusals were values
    assert.throws(() => sdk.wrap(new FakeOpenAI(), { taskRef: 'job-7', agentId: 'r', onQuota: bad }), /onQuota/)
  }
  sdk.wrap(new FakeOpenAI(), { taskRef: 'job-7', agentId: 'r', onQuota: 'refuse' })
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

// ------------------------------------------------------------- the record's key

test('a compatible endpoint gets a random key, even when its ids repeat', async () => {
  // Ollama's OpenAI compatibility layer issues chatcmpl-<0..998>: ids repeat.
  reset()
  const oa = new FakeOpenAI({ reply: chatCompletion({ id: 'chatcmpl-7' }) })
  oa.baseURL = 'http://localhost:11434/v1'
  const llm = sdk.wrap(oa, { taskRef: 'job-7', agentId: 'r' })
  for (let i = 0; i < 3; i++) await llm.chat.completions.create({ model: 'llama3', messages: [] })
  const keys = events().map((e) => e.idempotency_key)
  assert.equal(new Set(keys).size, 3)
  assert.ok(keys.every((k) => k.startsWith('r_')), keys.join(' '))
})

test('a duplicate answer is a collision, and the call is recorded again under its own key', async () => {
  reset({ '/events': (b) => (b.idempotency_key === 'chatcmpl-abc123' ? { event_id: null, status: 'duplicate_ignored' } : RECORDED) })
  const llm = sdk.wrap(new FakeOpenAI(), { taskRef: 'job-7', agentId: 'r' })
  await llm.chat.completions.create({ model: 'gpt-4o-mini', messages: [] })
  const [first, again] = events()
  assert.equal(first.idempotency_key, 'chatcmpl-abc123')
  assert.ok(again.idempotency_key.startsWith('r_'))
  assert.equal(again.reservation_id, RID); assert.equal(first.reservation_id, RID)
  assert.equal(again.units, 908); assert.deepEqual(again.metadata, first.metadata)
  await tick()
  assert.ok(warnings.some((w) => /reused a response id/.test(w)), warnings.join(' | '))
})

// ------------------------------------------------------------- OpenAI cache writes

test('openai cache writes are their own token type, plain and streamed, both APIs', async () => {
  reset()
  const u = { prompt_tokens: 50_000, completion_tokens: 400, prompt_tokens_details: { cached_tokens: 8_000, cache_write_tokens: 40_400 } }
  const ru = { input_tokens: 50_000, output_tokens: 400, input_tokens_details: { cached_tokens: 8_000, cache_write_tokens: 40_400 }, output_tokens_details: { reasoning_tokens: 0 } }
  const done = { id: 'resp_cw', model: 'gpt-5.6', usage: ru }
  const llm = sdk.wrap(new FakeOpenAI({
    reply: { id: 'chatcmpl-cw', model: 'gpt-5.6', usage: u, choices: [] },
    chunks: [chunk('a'), chunk(null, u)], response: done, events: [{ type: 'response.completed', response: done }],
  }), { taskRef: 'job-7', agentId: 'r' })
  await llm.chat.completions.create({ model: 'gpt-5.6', messages: [] })
  for await (const _ of await llm.chat.completions.create({ model: 'gpt-5.6', messages: [], stream: true })) { /* read */ }
  await llm.responses.create({ model: 'gpt-5.6', input: 'x' })
  for await (const _ of await llm.responses.create({ model: 'gpt-5.6', input: 'x', stream: true })) { /* read */ }
  assert.equal(events().length, 4)
  for (const ev of events()) {
    assert.deepEqual(ev.metadata.tokens, { input: 1_600, cache_read: 8_000, cache_write: 40_400, output: 400, reasoning: 0 })
    assert.equal(ev.units, 50_400)
  }
})

test('cache writes never make input negative', async () => {
  reset()
  const u = { prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 70, cache_write_tokens: 90 } }
  await sdk.wrap(new FakeOpenAI({ reply: { id: 'c', model: 'gpt-5.6', usage: u, choices: [] } }), { taskRef: 'job-7', agentId: 'r' })
    .chat.completions.create({ model: 'gpt-5.6', messages: [] })
  const t = events()[0].metadata.tokens
  assert.deepEqual([t.input, t.cache_read, t.cache_write], [0, 70, 30])
})

// ------------------------------------------------------------- Gemini automatic function calling

// Shaped like @google/genai's Models: the public methods are arrow functions
// made in the constructor, bound to the instance, and each round of automatic
// function calling is one this.generateContentInternal (or ...StreamInternal).
// Only the last response comes back, with only the last round's usage.
const gemRound = (i, callsTool) => ({ ...geminiResponse({ prompt: 1000 + 100 * i, cand: 50, id: `gem-round-${i}` }), callsTool })
class FakeGenAIModels {
  constructor(apiClient) {
    this.apiClient = apiClient
    this.generateContent = async (params) => {
      let response
      for (let i = 0; i < this.apiClient.rounds.length; i++) {
        response = await this.generateContentInternal(params)
        if (!response.callsTool) break
      }
      return response
    }
    this.generateContentStream = async (params) => {
      const self = this
      return (async function* () {
        for (let i = 0; i < self.apiClient.rounds.length; i++) {
          let last
          for await (const c of await self.generateContentInternalStreamShim(params)) { last = c; yield c }
          if (!last.callsTool) return
        }
      })()
    }
  }
  generateContentInternalStreamShim(params) { return this.generateContentStreamInternal(params) }
  async generateContentInternal(params) { return this.apiClient.next(params) }
  async generateContentStreamInternal(params) { const r = this.apiClient.next(params); return (async function* () { yield r })() }
}
function loopingGenAI(n) {
  const rounds = Array.from({ length: n }, (_, i) => gemRound(i, i < n - 1))
  const apiClient = { rounds, sent: [], next(params) { this.sent.push(params.model); return rounds[(this.sent.length - 1) % rounds.length] } }
  return { models: new FakeGenAIModels(apiClient), apiClient }
}

test('gemini: each round of automatic function calling is a measured call', async () => {
  reset()
  const g = loopingGenAI(3)
  const before = { generateContent: g.models.generateContent, internal: g.models.generateContentInternal }
  const llm = sdk.wrap(g, { taskRef: 'job-7', agentId: 'r', provider: 'gemini' })
  const reply = await llm.models.generateContent({ model: 'gemini-2.5-flash', contents: 'use the tool' })
  assert.equal(reply.responseId, 'gem-round-2')               // the caller still gets the last response
  assert.equal(g.apiClient.sent.length, 3)
  assert.equal(preflights().length, 3)                        // one preflight per round sent
  assert.deepEqual(events().map((e) => e.idempotency_key), ['gem-round-0', 'gem-round-1', 'gem-round-2'])
  assert.deepEqual(events().map((e) => e.units), [1050, 1150, 1250])
  // the client itself is untouched: its own methods are not the measured ones
  assert.equal(g.models.generateContent, before.generateContent)
  assert.equal(g.models.generateContentInternal, before.internal)
  assert.equal(Object.prototype.hasOwnProperty.call(g.models, 'generateContentInternal'), false)
  reset()
  await g.models.generateContent({ model: 'gemini-2.5-flash', contents: 'unwrapped' })
  assert.equal(sent.length, 0)
})

test('gemini: each round is measured when streamed too', async () => {
  reset()
  const g = loopingGenAI(2)
  const llm = sdk.wrap(g, { taskRef: 'job-7', agentId: 'r', provider: 'gemini' })
  const ids = []
  for await (const c of await llm.models.generateContentStream({ model: 'gemini-2.5-flash', contents: 'x' })) ids.push(c.responseId)
  assert.deepEqual(ids, ['gem-round-0', 'gem-round-1'])
  assert.deepEqual(events().map((e) => e.idempotency_key), ['gem-round-0', 'gem-round-1'])
  assert.equal(preflights().length, 2)
})

test('gemini: a refusal on a later round is returned, with the earlier rounds recorded', async () => {
  let n = 0
  reset({ '/preflight': () => (n++ === 0 ? APPROVED : REFUSED) })
  const g = loopingGenAI(3)
  const llm = sdk.wrap(g, { taskRef: 'job-7', agentId: 'r', provider: 'gemini' })
  const r = await llm.models.generateContent({ model: 'gemini-2.5-flash', contents: 'x' })   // nothing thrown
  assert.ok(sdk.isRefusal(r)); assert.equal(r.reason, 'task_ceiling_exceeded')
  assert.equal(g.apiClient.sent.length, 1)                    // round 2 was not sent
  assert.deepEqual(events().map((e) => e.idempotency_key), ['gem-round-0'])
})

test('gemini: a rounds stream refused on its first round is the refusal', async () => {
  reset({ '/preflight': REFUSED })
  const g = loopingGenAI(3)
  const llm = sdk.wrap(g, { taskRef: 'job-7', agentId: 'r', provider: 'gemini' })
  const s = await llm.models.generateContentStream({ model: 'gemini-2.5-flash', contents: 'x' })
  assert.ok(sdk.isRefusal(s))
  const seen = []
  for await (const c of s) seen.push(c)
  assert.deepEqual(seen, []); assert.equal(g.apiClient.sent.length, 0); assert.equal(events().length, 0)
})

test('gemini: a rounds stream refused on a later round ends, and exposes the refusal', async () => {
  // The one stream that can be refused after it started: the SDK's own loop
  // asks for another round mid-stream. The caller saw round 0, the stream
  // ends, .refusal says why, and round 0 is recorded.
  let n = 0
  reset({ '/preflight': () => (n++ === 0 ? APPROVED : REFUSED) })
  const g = loopingGenAI(3)
  const llm = sdk.wrap(g, { taskRef: 'job-7', agentId: 'r', provider: 'gemini' })
  const s = await llm.models.generateContentStream({ model: 'gemini-2.5-flash', contents: 'x' })
  assert.equal(sdk.isRefusal(s), false); assert.equal(s.refusal, null)
  const ids = []
  for await (const c of s) ids.push(c.responseId)
  assert.deepEqual(ids, ['gem-round-0'])
  assert.ok(sdk.isRefusal(s.refusal)); assert.equal(s.refusal.reason, 'task_ceiling_exceeded')
  assert.equal(g.apiClient.sent.length, 1)
  assert.deepEqual(events().map((e) => e.idempotency_key), ['gem-round-0'])
})

test('gemini: a client without the per-round methods refuses a call that would loop', async () => {
  reset()
  const g = new FakeGoogleGenAI()
  const llm = sdk.wrap(g, { taskRef: 'job-7', agentId: 'r' })
  const tool = { tool: async () => ({}), callTool: async () => [] }  // a CallableTool
  await assert.rejects(llm.models.generateContent({ model: 'gemini-2.5-flash', contents: 'x', config: { tools: [tool] } }),
    (e) => e instanceof TypeError && /automaticFunctionCalling/.test(e.message))
  assert.equal(g.sent.length, 0); assert.equal(sent.length, 0)  // not sent, not even preflighted
  await llm.models.generateContent({ model: 'gemini-2.5-flash', contents: 'x', config: { tools: [tool], automaticFunctionCalling: { disable: true } } })
  await llm.models.generateContent({ model: 'gemini-2.5-flash', contents: 'x', config: { tools: [{ functionDeclarations: [] }] } })
  assert.equal(g.sent.length, 2); assert.equal(events().length, 2)
})

// ------------------------------------------------------------- a job in dollars (server 2026-09-25)

const USD_APPROVED = { ...APPROVED, estimated_units: 100000, task_ceiling: 5000000, task_remaining_units: 4900000, task_unit: 'usd',
  estimate_source: 'default', estimated_usd: 0.1, task_ceiling_usd: 5, task_remaining_usd: 4.9 }
const USD_REFUSED = { approved: false, reason: 'task_ceiling_exceeded', estimated_units: 100000, task_ref: 'job-usd', task_ceiling: 250000,
  task_used_units: 200000, task_remaining_units: 50000, task_unit: 'usd', estimate_source: 'default', estimated_usd: 0.1,
  task_ceiling_usd: 0.25, task_used_usd: 0.2, task_remaining_usd: 0.05 }

test('taskCeilingUsd opens a dollar job and leaves the estimate to the server; the record carries what it prices', async () => {
  reset({ '/preflight': USD_APPROVED })
  const llm = sdk.wrap(new FakeOpenAI(), { taskRef: 'job-usd', agentId: 'researcher', taskCeilingUsd: 5 })
  await llm.chat.completions.create({ model: 'gpt-4o-mini', messages: [] })
  const [pf] = preflights()
  assert.equal(pf.unit, 'usd'); assert.equal(pf.task_ceiling_usd, 5)
  assert.equal('estimated_units' in pf, false); assert.equal('task_ceiling' in pf, false)
  const [ev] = events()
  assert.ok(ev.metadata.model && ev.metadata.tokens); assert.equal(ev.reservation_id, RID)
})

test("unit: 'usd' meters a dollar job opened elsewhere, and a re-wrap keeps it", async () => {
  reset({ '/preflight': USD_APPROVED })
  const llm = sdk.wrap(new FakeOpenAI(), { taskRef: 'job-usd', agentId: 'r', unit: 'usd' })
  await sdk.wrap(llm, { step: 'draft' }).chat.completions.create({ model: 'gpt-4o-mini', messages: [] })
  const [pf] = preflights()
  assert.equal(pf.unit, 'usd'); assert.equal('task_ceiling_usd' in pf, false); assert.equal('estimated_units' in pf, false)
})

test('a dollar refusal says dollars at list price, returned by wrap() and thrown by preflight()', async () => {
  reset({ '/preflight': USD_REFUSED })
  const oa = new FakeOpenAI()
  const r = await sdk.wrap(oa, { taskRef: 'job-usd', agentId: 'r', unit: 'usd' }).chat.completions.create({ model: 'gpt-4o-mini', messages: [] })
  assert.ok(sdk.isRefusal(r)); assert.equal(r.unit, 'usd'); assert.equal(oa.sent.length, 0)
  assert.match(String(r), /\$0\.2 of \$0\.25 at list price/); assert.match(String(r), /\$0\.1 this call asked/)
  await assert.rejects(sdk.preflight({ agentId: 'r', taskRef: 'job-usd', unit: 'usd' }),
    (e) => e instanceof sdk.TaskCeilingExceededError && e.taskUnit === 'usd' && /\$0\.05 remaining/.test(e.message))
})

test('dollar options are checked, and a token job is unchanged', async () => {
  assert.throws(() => sdk.wrap(new FakeOpenAI(), { taskRef: 'j', agentId: 'r', taskCeilingUsd: 5, taskCeiling: 100 }), TypeError)
  assert.throws(() => sdk.wrap(new FakeOpenAI(), { taskRef: 'j', agentId: 'r', taskCeilingUsd: 5, unit: 'token' }), TypeError)
  assert.throws(() => sdk.wrap(new FakeOpenAI(), { taskRef: 'j', agentId: 'r', unit: 'dollars' }), TypeError)
  reset()
  await sdk.wrap(new FakeOpenAI(), { taskRef: 'job-7', agentId: 'r', taskCeiling: 100000 }).chat.completions.create({ model: 'gpt-4o-mini', messages: [] })
  const [pf] = preflights()
  assert.equal(pf.unit, 'token'); assert.equal(pf.task_ceiling, 100000); assert.equal('task_ceiling_usd' in pf, false); assert.ok('estimated_units' in pf)
})

test('preflight() carries the dollar fields both ways', async () => {
  reset({ '/preflight': USD_APPROVED })
  const res = await sdk.preflight({ agentId: 'r', taskRef: 'job-usd', taskCeilingUsd: 5, estimatedUsd: 0.02 })
  const [pf] = preflights()
  assert.equal(pf.task_ceiling_usd, 5); assert.equal(pf.estimated_usd, 0.02)
  assert.equal(res.taskUnit, 'usd'); assert.equal(res.estimatedUsd, 0.1); assert.equal(res.taskRemainingUsd, 4.9); assert.equal(res.estimateSource, 'default')
})

// S19 follow-up, 2026-09-25: a preflight answer whose approved is truthy but
// not true is not permission. The wrapped call is refused and not sent, and
// nothing is recorded.
test('a truthy approved that is not true refuses the call and sends nothing', async () => {
  for (const approved of ['true', 1, 'yes']) {
    reset({ '/preflight': { ...APPROVED, approved } })
    const oa = new FakeOpenAI()
    const r = await sdk.wrap(oa, { taskRef: 'job-7', agentId: 'researcher' }).chat.completions.create({ model: 'gpt-4o-mini', messages: [] })
    assert.ok(sdk.isRefusal(r), `approved: ${JSON.stringify(approved)} must be a refusal`)
    assert.equal(oa.sent.length, 0)
    assert.equal(events().length, 0)
  }
})
