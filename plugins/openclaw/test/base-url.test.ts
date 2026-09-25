/**
 * Where the plugin is willing to send the API key. baseUrl has to be https, or
 * plain http to this machine; anything else is a config error that sends
 * nothing and is decided by failMode, like an unreachable server. Every refusal
 * case below was run against a build that skipped the check, and failed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerCeiling } from '../src/ceiling.js'
import { AgentBillClient, AgentBillConfigError } from '../src/client.js'

type Handler = (event: any, ctx: any) => any

function fakeFetch() {
  const urls: string[] = []
  const fetchImpl = (async (url: string) => {
    urls.push(url)
    return new Response(JSON.stringify({ approved: true, reason: null, task_ref: 'x', task_ceiling: 500, task_used_units: 0, task_remaining_units: 500 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { urls, fetchImpl }
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

async function withFetch<T>(f: typeof fetch, run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch
  globalThis.fetch = f
  try { return await run() } finally { globalThis.fetch = real }
}

const ACCEPTED = ['https://agentbill.test', 'http://localhost:3999', 'http://127.0.0.1:3999', 'http://[::1]:3999']
const REFUSED = ['http://example.com', 'http://localhost.example.com', 'ftp://agentbill.test', 'not a url']

for (const baseUrl of ACCEPTED) {
  test(`${baseUrl} is accepted: the preflight is sent there and the turn passes`, async () => {
    const srv = fakeFetch()
    await withFetch(srv.fetchImpl, async () => {
      const { api, fire, logs } = fakeApi({ apiKey: 'agb_x', baseUrl })
      registerCeiling(api as any)
      const out = await fire('before_agent_run', { prompt: 'hi', messages: [] }, { runId: 'r1', sessionKey: 'k' })
      assert.deepEqual(out, { outcome: 'pass' })
      assert.deepEqual(srv.urls, [`${baseUrl}/preflight`])
      assert.ok(!logs.some((l) => l.includes('baseUrl must be')), logs.join('\n'))
    })
  })
}

for (const baseUrl of REFUSED) {
  test(`${baseUrl}: the client refuses at construction with AgentBillConfigError`, () => {
    assert.throws(() => new AgentBillClient({ baseUrl, apiKey: 'agb_x', timeoutMs: 1000 }), AgentBillConfigError)
  })

  test(`${baseUrl}: failMode closed says so at startup, refuses every call, and sends nothing`, async () => {
    const srv = fakeFetch()
    await withFetch(srv.fetchImpl, async () => {
      const { api, fire, logs } = fakeApi({ apiKey: 'agb_x', baseUrl })
      registerCeiling(api as any)
      assert.ok(logs.some((l) => l.startsWith('error') && l.includes('baseUrl') && l.includes('refused (failMode=closed)')), logs.join('\n'))
      const turn = await fire('before_agent_run', { prompt: 'hi', messages: [] }, { runId: 'r1', sessionKey: 'k' })
      assert.equal(turn.outcome, 'block')
      assert.match(turn.message, /misconfigured/)
      const tool = await fire('before_tool_call', { toolName: 'exec', params: {} }, { runId: 'r1', sessionKey: 'k', toolCallId: 't1' })
      assert.equal(tool.block, true)
      await fire('llm_output', { usage: { total: 10 }, runId: 'r1' }, { sessionKey: 'k' })
      assert.deepEqual(srv.urls, [])
    })
  })
}

test('http://example.com with failMode open: calls run unmetered, it warns, and nothing is sent', async () => {
  const srv = fakeFetch()
  await withFetch(srv.fetchImpl, async () => {
    const { api, fire, logs } = fakeApi({ apiKey: 'agb_x', baseUrl: 'http://example.com', failMode: 'open' })
    registerCeiling(api as any)
    assert.ok(logs.some((l) => l.startsWith('error') && l.includes('failMode=open')), logs.join('\n'))
    const turn = await fire('before_agent_run', { prompt: 'hi', messages: [] }, { runId: 'r1', sessionKey: 'k' })
    assert.deepEqual(turn, { outcome: 'pass' })
    assert.ok(logs.some((l) => l.startsWith('warn') && l.includes('misconfigured')), logs.join('\n'))
    await fire('llm_output', { usage: { total: 10 }, runId: 'r1' }, { sessionKey: 'k' })
    assert.deepEqual(srv.urls, [])
  })
})
