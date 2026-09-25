// Where the Node SDK is willing to send the API key, and how long it waits.
// The SDK reads AGENTBILL_BASE_URL at import, so each case imports a fresh
// module instance (a distinct query string) after setting the env. undici's
// MockAgent answers every origin used here and counts what reached it, and it
// refuses any real connection.
//
// Run: npm test (builds dist/ first). CI runs it in the node-sdk job.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici'

const APPROVED = { approved: true, reason: null, estimated_units: 1, remaining_units: 9 }
const ORIGINS = [
  'https://agentbill.test',
  'http://localhost:3999',
  'http://127.0.0.1:3999',
  'http://[::1]:3999',
  'http://example.com',
  'http://localhost.example.com',
]
const SLOW = 'https://slow.agentbill.test'

let hits = []
let previous
let n = 0

before(() => {
  previous = getGlobalDispatcher()
  const agent = new MockAgent()
  agent.disableNetConnect()
  for (const origin of ORIGINS) {
    agent.get(origin).intercept({ path: () => true, method: () => true })
      .reply(() => {
        hits.push(origin)
        return { statusCode: 200, data: JSON.stringify(APPROVED), responseOptions: { headers: { 'content-type': 'application/json' } } }
      })
      .persist()
  }
  agent.get(SLOW).intercept({ path: () => true, method: () => true })
    .reply(200, JSON.stringify(APPROVED), { headers: { 'content-type': 'application/json' } })
    .delay(2000)
    .persist()
  setGlobalDispatcher(agent)
  process.env.AGENTBILL_API_KEY = 'agb_node_sdk_test_key_not_real'
})

after(() => setGlobalDispatcher(previous))

async function sdkAt(base) {
  process.env.AGENTBILL_BASE_URL = base
  hits = []
  return import(`../dist/index.js?base=${++n}`)
}

for (const base of ['https://agentbill.test', 'http://localhost:3999', 'http://127.0.0.1:3999', 'http://[::1]:3999']) {
  test(`${base} is accepted and the request is sent`, async () => {
    const sdk = await sdkAt(base)
    const pf = await sdk.preflight({ agentId: 'a', estimatedUnits: 1 })
    assert.equal(pf.approved, true)
    assert.deepEqual(hits, [base])
  })
}

for (const base of ['http://example.com', 'http://localhost.example.com', 'ftp://agentbill.test', 'not a url']) {
  test(`${base} is refused with AgentBillError and nothing is sent`, async () => {
    const sdk = await sdkAt(base)
    await assert.rejects(sdk.preflight({ agentId: 'a', estimatedUnits: 1 }), (err) => {
      assert.ok(err instanceof sdk.AgentBillError, `expected AgentBillError, got ${err?.name}: ${err?.message}`)
      assert.match(err.message, /AGENTBILL_BASE_URL/)
      return true
    })
    await assert.rejects(sdk.record({ agentId: 'a', units: 1 }), sdk.AgentBillError)
    assert.deepEqual(hits, [])
  })
}

test('a bad base URL does not throw at import', async () => {
  process.env.AGENTBILL_BASE_URL = 'http://example.com'
  await assert.doesNotReject(import(`../dist/index.js?import=${++n}`))
})

test('every request carries a 10 second timeout', async () => {
  const sdk = await sdkAt(SLOW)
  const real = AbortSignal.timeout
  const asked = []
  // The SDK asks for 10000 ms; the stub records that and fires in 50 ms so the
  // test does not wait. The reply is delayed 2 s, so only the signal ends it.
  AbortSignal.timeout = (ms) => { asked.push(ms); return real.call(AbortSignal, 50) }
  try {
    await assert.rejects(sdk.preflight({ agentId: 'a', estimatedUnits: 1 }), (err) => {
      assert.equal(err.name, 'TimeoutError')
      return true
    })
  } finally {
    AbortSignal.timeout = real
  }
  assert.deepEqual(asked, [10000])
})
