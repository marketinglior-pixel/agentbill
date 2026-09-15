/**
 * Drives the plugin with a fake OpenClaw api and a fake fetch. Every assertion
 * here was first run against a deliberately wrong implementation and failed,
 * so a green run means something. The shapes of events and contexts are the
 * ones in openclaw 2026.9.4's hook reference.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerCeiling, resolveConfig } from '../src/ceiling.js'

type Handler = (event: any, ctx: any) => any
type Call = { path: string; body: Record<string, unknown> }

function fakeServer(decide: (body: Record<string, unknown>) => { status: number; json: unknown }) {
  const calls: Call[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    calls.push({ path, body })
    const { status, json } = decide(body)
    return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } })
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

function fakeApi(pluginConfig: Record<string, unknown>) {
  const hooks = new Map<string, Handler>()
  const logs: string[] = []
  const api = {
    pluginConfig,
    logger: { info: (m: string) => logs.push('info ' + m), warn: (m: string) => logs.push('warn ' + m), error: (m: string) => logs.push('error ' + m) },
    on: (name: string, handler: Handler) => { hooks.set(name, handler) },
  }
  return { api, hooks, logs, fire: (name: string, event: any, ctx: any) => hooks.get(name)!(event, ctx) }
}

// Inject the fake fetch through the module's client by monkeypatching globalThis.fetch
// for the duration of one test. The client reads `fetch` at construction time.
async function withFetch<T>(f: typeof fetch, run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch
  globalThis.fetch = f
  try { return await run() } finally { globalThis.fetch = real }
}

const approved = { status: 200, json: { approved: true, reason: null, task_ref: 'x', task_ceiling: 500, task_used_units: 0, task_remaining_units: 500 } }
const refused = { status: 200, json: { approved: false, reason: 'task_ceiling_exceeded', task_ref: 'x', task_ceiling: 500, task_used_units: 512, task_remaining_units: 0 } }
const recorded = { status: 201, json: { ok: true } }

test('config defaults follow the manifest, and calls mode changes the unit defaults', () => {
  const t = resolveConfig({ apiKey: 'agb_x' }, {})
  assert.equal(t.units, 'tokens'); assert.equal(t.estimateUnits, 2000); assert.equal(t.toolCallUnits, 0)
  assert.equal(t.ceilingUnits, 500_000); assert.equal(t.failMode, 'closed'); assert.equal(t.baseUrl, 'https://agentbill.dev')
  const c = resolveConfig({ apiKey: 'agb_x', units: 'calls' }, {})
  assert.equal(c.estimateUnits, 1); assert.equal(c.toolCallUnits, 1)
  const e = resolveConfig({}, { AGENTBILL_API_KEY: 'agb_env' })
  assert.equal(e.apiKey, 'agb_env')
})

test('no key: the plugin says the ceiling is not enforced and registers no gate that could pass silently', () => {
  const { api, hooks, logs } = fakeApi({})
  registerCeiling(api as any)
  assert.equal(hooks.size, 0)
  assert.ok(logs.some((l) => l.startsWith('error') && l.includes('NOT enforced')), logs.join('\n'))
})

test('before_agent_run: approved passes, refused blocks with a user-facing sentence and category cost_limit', async () => {
  const srv = fakeServer((b) => (b.task_ref ? (b.estimated_units !== undefined && !('units' in b) ? approved : recorded) : recorded))
  await withFetch(srv.fetchImpl, async () => {
    const { api, fire } = fakeApi({ apiKey: 'agb_x', ceilingUnits: 500 })
    registerCeiling(api as any)
    fire('session_start', { sessionId: 's1', sessionKey: 'agent:main:discord:c1' }, { sessionId: 's1', sessionKey: 'agent:main:discord:c1' })
    const pass = await fire('before_agent_run', { prompt: 'hi', messages: [] }, { runId: 'r1', sessionKey: 'agent:main:discord:c1' })
    assert.deepEqual(pass, { outcome: 'pass' })
    const pf = srv.calls.find((c) => c.path === '/preflight')!
    assert.equal(pf.body.task_ref, 'openclaw:agent:main:discord:c1')
    assert.equal(pf.body.task_ceiling, 500)
    assert.equal(pf.body.estimated_units, 2000)
    assert.equal(pf.body.idempotency_key, 'r1:agent_run')
  })

  const srv2 = fakeServer(() => refused)
  await withFetch(srv2.fetchImpl, async () => {
    const { api, fire } = fakeApi({ apiKey: 'agb_x', ceilingUnits: 500 })
    registerCeiling(api as any)
    const out = await fire('before_agent_run', { prompt: 'hi', messages: [] }, { runId: 'r2', sessionKey: 'k' })
    assert.equal(out.outcome, 'block')
    assert.equal(out.category, 'cost_limit')
    assert.match(out.message, /refused \(task_ceiling_exceeded\)/)
    assert.match(out.message, /512\/500 tokens/)
    assert.match(out.message, /agentbill\.dev\/app/)
  })
})

test('before_tool_call: refused returns { block: true } and the idempotency key names the tool call', async () => {
  const srv = fakeServer(() => refused)
  await withFetch(srv.fetchImpl, async () => {
    const { api, fire } = fakeApi({ apiKey: 'agb_x' })
    registerCeiling(api as any)
    const out = await fire('before_tool_call', { toolName: 'exec', params: {}, toolCallId: 'tc9' }, { runId: 'r3', sessionKey: 'k', toolName: 'exec', toolCallId: 'tc9' })
    assert.equal(out.block, true)
    assert.match(out.blockReason, /AgentBill refused/)
    assert.equal(srv.calls[0]!.body.idempotency_key, 'r3:tool:tc9')
  })
})

test('a subagent draws down the parent task_ref, and its own session_end does not forget the parent', async () => {
  const srv = fakeServer((b) => ('units' in b ? recorded : approved))
  await withFetch(srv.fetchImpl, async () => {
    const { api, fire } = fakeApi({ apiKey: 'agb_x' })
    const c = registerCeiling(api as any)
    fire('session_start', { sessionId: 'p', sessionKey: 'parent' }, { sessionId: 'p', sessionKey: 'parent' })
    fire('subagent_spawned', { childSessionKey: 'child', agentId: 'a', mode: 'run', threadRequested: false }, { runId: 'r', childSessionKey: 'child', requesterSessionKey: 'parent' })
    await fire('before_tool_call', { toolName: 'web', params: {} }, { runId: 'r', sessionKey: 'child', toolName: 'web', toolCallId: 't1' })
    assert.equal(srv.calls[0]!.body.task_ref, 'openclaw:parent', 'child preflight must carry the parent task_ref')
    assert.equal(c.rootOf('child'), 'parent')
    fire('session_end', { sessionId: 'c', sessionKey: 'child', reason: 'idle' }, { sessionId: 'c', sessionKey: 'child' })
    assert.equal(c.rootOf('child'), 'child', 'link removed at child end')
    await fire('llm_output', { runId: 'r', sessionId: 'p', provider: 'x', model: 'y', assistantTexts: [], usage: { total: 321 } }, { sessionKey: 'parent' })
    const rec = srv.calls.find((x) => x.path === '/events')!
    assert.equal(rec.body.task_ref, 'openclaw:parent')
    assert.equal(rec.body.units, 321)
  })
})

test('llm_output records the usage total and moves the next estimate to the running average', async () => {
  const srv = fakeServer((b) => ('units' in b ? recorded : approved))
  await withFetch(srv.fetchImpl, async () => {
    const { api, fire } = fakeApi({ apiKey: 'agb_x' })
    registerCeiling(api as any)
    await fire('llm_output', { runId: 'r', sessionId: 's', provider: 'p', model: 'm', assistantTexts: [], usage: { input: 100, output: 50 } }, { sessionKey: 'k' })
    await fire('llm_output', { runId: 'r', sessionId: 's', provider: 'p', model: 'm', assistantTexts: [], usage: { total: 250 } }, { sessionKey: 'k' })
    const units = srv.calls.filter((x) => x.path === '/events').map((x) => x.body.units)
    assert.deepEqual(units, [150, 250])
    await fire('before_tool_call', { toolName: 'exec', params: {} }, { runId: 'r', sessionKey: 'k', toolName: 'exec', toolCallId: 't' })
    const pf = srv.calls.find((x) => x.path === '/preflight')!
    assert.equal(pf.body.estimated_units, 200, 'estimate is the average of 150 and 250, not the 2000 default')
  })
})

test('tool calls record 0 units in tokens mode (no event) and 1 unit in calls mode', async () => {
  const srv = fakeServer(() => recorded)
  await withFetch(srv.fetchImpl, async () => {
    const { api, fire } = fakeApi({ apiKey: 'agb_x' })
    registerCeiling(api as any)
    await fire('after_tool_call', { toolName: 'exec', params: {}, durationMs: 5 }, { runId: 'r', sessionKey: 'k', toolName: 'exec', toolCallId: 't' })
    assert.equal(srv.calls.length, 0)
  })
  const srv2 = fakeServer(() => recorded)
  await withFetch(srv2.fetchImpl, async () => {
    const { api, fire } = fakeApi({ apiKey: 'agb_x', units: 'calls' })
    registerCeiling(api as any)
    await fire('after_tool_call', { toolName: 'exec', params: {}, durationMs: 5 }, { runId: 'r', sessionKey: 'k', toolName: 'exec', toolCallId: 't' })
    assert.equal(srv2.calls[0]!.body.units, 1)
    assert.equal(srv2.calls[0]!.body.idempotency_key, 'openclaw:k:r:tool:t')
  })
})

test('failMode closed refuses when AgentBill is unreachable; failMode open lets the call run and warns', async () => {
  const dead = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
  await withFetch(dead, async () => {
    const closed = fakeApi({ apiKey: 'agb_x' })
    registerCeiling(closed.api as any)
    const out = await closed.fire('before_agent_run', { prompt: '', messages: [] }, { runId: 'r', sessionKey: 'k' })
    assert.equal(out.outcome, 'block')
    assert.match(out.message, /could not be reached/)

    const open = fakeApi({ apiKey: 'agb_x', failMode: 'open' })
    registerCeiling(open.api as any)
    const out2 = await open.fire('before_agent_run', { prompt: '', messages: [] }, { runId: 'r', sessionKey: 'k' })
    assert.deepEqual(out2, { outcome: 'pass' })
    assert.ok(open.logs.some((l) => l.includes('failMode=open')))
  })
})

test('a 5xx from /preflight is unreachable, not a refusal: failMode decides it, and the reason says so', async () => {
  // The first version of this test asserted only `block === true`, which is
  // also what a 503 misread as a refusal produces. It passed on the mutation
  // it was written to catch. So: the sentence must be the unreachable one, and
  // failMode=open must let the call run, which a refusal never does.
  const srv = fakeServer(() => ({ status: 503, json: { error: 'down' } }))
  await withFetch(srv.fetchImpl, async () => {
    const closed = fakeApi({ apiKey: 'agb_x' })
    registerCeiling(closed.api as any)
    const out = await closed.fire('before_tool_call', { toolName: 'exec', params: {} }, { runId: 'r', sessionKey: 'k', toolName: 'exec', toolCallId: 't' })
    assert.equal(out.block, true)
    assert.match(out.blockReason, /could not be reached \(preflight returned 503\)/)
    assert.doesNotMatch(out.blockReason, /AgentBill refused/)

    const open = fakeApi({ apiKey: 'agb_x', failMode: 'open' })
    registerCeiling(open.api as any)
    const out2 = await open.fire('before_tool_call', { toolName: 'exec', params: {} }, { runId: 'r', sessionKey: 'k', toolName: 'exec', toolCallId: 't' })
    assert.equal(out2, undefined, 'failMode=open lets a 503 through; a refusal would not')
  })
})

test("AgentBill's own plan quota refusing is not the operator's ceiling: the call runs and the warning is said once per task", async () => {
  const srv = fakeServer(() => ({ status: 402, json: { approved: false, reason: 'free_tier_exceeded', upgrade_url: 'https://agentbill.dev/pricing' } }))
  await withFetch(srv.fetchImpl, async () => {
    const { api, fire, logs } = fakeApi({ apiKey: 'agb_x' })
    registerCeiling(api as any)
    const a = await fire('before_agent_run', { prompt: '', messages: [] }, { runId: 'r1', sessionKey: 'k' })
    const b = await fire('before_agent_run', { prompt: '', messages: [] }, { runId: 'r2', sessionKey: 'k' })
    assert.deepEqual(a, { outcome: 'pass' }); assert.deepEqual(b, { outcome: 'pass' })
    assert.equal(logs.filter((l) => l.includes('free_tier_exceeded')).length, 1)
    assert.ok(logs.find((l) => l.includes('agentbill.dev/pricing')))
  })
})

test('customerFrom=sender attributes preflight and record to the sender', async () => {
  const srv = fakeServer((b) => ('units' in b ? recorded : approved))
  await withFetch(srv.fetchImpl, async () => {
    const { api, fire } = fakeApi({ apiKey: 'agb_x', customerFrom: 'sender' })
    registerCeiling(api as any)
    await fire('before_agent_run', { prompt: '', messages: [], senderId: 'u42' }, { runId: 'r', sessionKey: 'k' })
    await fire('llm_output', { runId: 'r', sessionId: 's', provider: 'p', model: 'm', assistantTexts: [], usage: { total: 10 } }, { sessionKey: 'k', senderId: 'u42' })
    assert.equal(srv.calls[0]!.body.customer_id, 'u42')
    assert.equal(srv.calls[1]!.body.customer_id, 'u42')
  })
})

test('without hooks.allowConversationAccess the plugin says the host blocks the model-turn gate; with it, it does not', () => {
  const off = fakeApi({ apiKey: 'agb_x' })
  registerCeiling(off.api as any)
  assert.ok(off.logs.some((l) => l.startsWith('error') && l.includes('allowConversationAccess') && l.includes('nothing is recorded')), off.logs.join('\n'))
  const on = fakeApi({ apiKey: 'agb_x' })
  ;(on.api as any).id = 'agentbill'
  ;(on.api as any).config = { plugins: { entries: { agentbill: { hooks: { allowConversationAccess: true } } } } }
  registerCeiling(on.api as any)
  assert.ok(!on.logs.some((l) => l.includes('allowConversationAccess is not true')), on.logs.join('\n'))
  assert.ok(on.logs.some((l) => l.includes('conversation hooks allowed')))
})
