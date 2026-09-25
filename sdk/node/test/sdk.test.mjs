// What the Node SDK sends. No socket opens: the SDK fetches through undici,
// and undici's MockAgent answers every request in-process and refuses any
// real connection. The SDK reads its base URL from AGENTBILL_BASE_URL at
// import, so the import happens after the env is set.
//
// Run: npm test (builds dist/ first). CI runs it in the node-sdk job.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici'

const RID = '3f1c2b7a-8d4e-4b1a-9c2d-5e6f7a8b9c0d'
const APPROVED = {
  approved: true, reason: null, estimated_units: 70000, remaining_units: null,
  reservation_expires_at: '2026-09-23T12:00:00.000Z', reservation_id: RID,
  task_ref: 'job-142', task_ceiling: 500000, task_remaining_units: 430000,
}
const RECORDED = { event_id: 'e1', status: 'recorded', customer_created: false, customer_remaining_units: null }
const ORIGIN = 'https://agentbill.test'

let sent = []
let answer = {}
let sdk
let previous

before(async () => {
  previous = getGlobalDispatcher()
  const agent = new MockAgent()
  agent.disableNetConnect()
  agent.get(ORIGIN)
    .intercept({ path: () => true, method: () => true })
    .reply((req) => {
      const path = new URL(req.path, ORIGIN).pathname
      sent.push({ method: req.method, path, body: req.body ? JSON.parse(String(req.body)) : null })
      const body = answer[path] ?? (path === '/preflight' ? APPROVED : RECORDED)
      return { statusCode: 200, data: JSON.stringify(body), responseOptions: { headers: { 'content-type': 'application/json' } } }
    })
    .persist()
  setGlobalDispatcher(agent)
  process.env.AGENTBILL_BASE_URL = ORIGIN
  process.env.AGENTBILL_API_KEY = 'agb_node_sdk_test_key_not_real'
  sdk = await import('../dist/index.js')
})

after(() => setGlobalDispatcher(previous))

const reset = (a = {}) => { sent = []; answer = a }
const events = () => sent.filter((s) => s.path === '/events').map((s) => s.body)

test('preflight exposes the reservation id', async () => {
  reset()
  const pf = await sdk.preflight({ agentId: 'researcher', estimatedUnits: 70000, taskRef: 'job-142' })
  assert.equal(pf.reservationId, RID)
})

test('result.record() carries agent, customer, task and the reservation id', async () => {
  reset()
  const pf = await sdk.preflight({ agentId: 'researcher', estimatedUnits: 70000, customerId: 'acct_42', taskRef: 'job-142' })
  await pf.record({ units: 8000 })
  const [body] = events()
  assert.equal(body.reservation_id, RID)
  assert.equal(body.event_type, 'researcher')
  assert.equal(body.customer_id, 'acct_42')
  assert.equal(body.task_ref, 'job-142')
  assert.equal(body.units, 8000)
  assert.equal(body.success, true)
})

test('the result object keeps its data shape: record is not enumerable', async () => {
  reset()
  const pf = await sdk.preflight({ agentId: 'researcher', estimatedUnits: 5, taskRef: 'job-142' })
  assert.equal(typeof pf.record, 'function')
  assert.equal(Object.keys(pf).includes('record'), false)
  assert.equal('record' in JSON.parse(JSON.stringify(pf)), false)
  assert.deepEqual(Object.keys({ ...pf }).sort(), ['approved', 'estimatedUnits', 'reason', 'remainingUnits', 'reservationExpiresAt', 'reservationId', 'taskRef', 'taskRemainingUnits', 'upgradeUrl'])
})

test('a record that asks for nothing new sends exactly the old payload', async () => {
  reset()
  await sdk.record({ agentId: 'researcher', units: 12, taskRef: 'job-142' })
  const [body] = events()
  assert.deepEqual(Object.keys(body).sort(), ['customer_id', 'event_type', 'idempotency_key', 'success', 'task_ref', 'units'])
  assert.match(body.idempotency_key, /^researcher_[0-9a-f]+$/)
})

test('record passes an idempotency key through, on both paths', async () => {
  reset()
  await sdk.record({ agentId: 'researcher', units: 12, idempotencyKey: 'resp_abc123' })
  const pf = await sdk.preflight({ agentId: 'researcher', estimatedUnits: 5, taskRef: 'job-142' })
  await pf.record({ units: 5, idempotencyKey: 'resp_def456' })
  assert.deepEqual(events().map((b) => b.idempotency_key), ['resp_abc123', 'resp_def456'])
})

test('units 0, usageMissing and metadata go out as sent', async () => {
  reset()
  await sdk.record({ agentId: 'researcher', units: 0, reservationId: RID })
  await sdk.record({ agentId: 'researcher', units: 0, usageMissing: true, metadata: { model: 'gpt-4o' } })
  const [zero, missing] = events()
  assert.equal(zero.units, 0)
  assert.equal(zero.reservation_id, RID)
  assert.equal('usage_missing' in zero, false)
  assert.equal(missing.usage_missing, true)
  assert.deepEqual(missing.metadata, { model: 'gpt-4o' })
})

test('against a server without reservation_id the record settles the old way', async () => {
  const { reservation_id, ...old } = APPROVED
  reset({ '/preflight': old })
  const pf = await sdk.preflight({ agentId: 'researcher', estimatedUnits: 70000, taskRef: 'job-142' })
  assert.equal(pf.reservationId, undefined)
  await pf.record({ units: 8000 })
  assert.equal('reservation_id' in events()[0], false)
})

test('preflight sends unit only when given', async () => {
  reset()
  await sdk.preflight({ agentId: 'researcher', estimatedUnits: 5, taskRef: 'job-142', taskCeiling: 500000, unit: 'token' })
  await sdk.preflight({ agentId: 'researcher', estimatedUnits: 5, taskRef: 'job-142' })
  const [a, b] = sent.filter((s) => s.path === '/preflight').map((s) => s.body)
  assert.equal(a.unit, 'token')
  assert.equal('unit' in b, false)
})

test('getTask reads unit and usageMissingCalls, and defaults them for an old server', async () => {
  const base = { task_ref: 'job-142', agent_id: 'r', ceiling_units: 500000, used_units: 8000, reserved_units: 0, remaining_units: 492000, exceeded: false }
  reset({ '/tasks/job-142': { ...base, unit: 'token', usage_missing_calls: 2 } })
  const a = await sdk.getTask('job-142')
  reset({ '/tasks/job-142': base })
  const b = await sdk.getTask('job-142')
  assert.deepEqual([a.unit, a.usageMissingCalls], ['token', 2])
  assert.deepEqual([b.unit, b.usageMissingCalls], ['unit', 0])
})

test('meter: a units function may return 0, which records nothing instead of throwing', async () => {
  reset()
  const run = sdk.meter(async () => ({ resolved: false }), { event: 'ticket', customerId: 'c1', units: (r) => (r.resolved ? 5 : 0) })
  assert.deepEqual(await run({}), { resolved: false })
  assert.equal(events().length, 0)
  const bad = sdk.meter(async () => ({}), { event: 'ticket', customerId: 'c1', units: () => -1 })
  await assert.rejects(() => bad({}), /non-negative integer/)
})

// S19 follow-up, 2026-09-25: approved is read as a boolean, never as a truthy
// value. A 200 whose approved is the string "true", "yes", 1, an object or
// absent (a proxy page, a truncated body, a future shape) is not a verdict,
// so preflight() answers approved: false and never hands back a reservation
// to spend. Before this, `!data.approved` and `Boolean(data.approved)` read
// every one of those as permission.
test('approved is true only on a JSON true, never on a truthy value', async () => {
  for (const approved of ['true', 'yes', 1, {}, [], undefined]) {
    reset({ '/preflight': { ...APPROVED, approved } })
    const pf = await sdk.preflight({ agentId: 'researcher', estimatedUnits: 5, taskRef: 'job-142' })
    assert.equal(pf.approved, false, `approved: ${JSON.stringify(approved)} must not be approved`)
  }
  reset({ '/preflight': APPROVED })
  const ok = await sdk.preflight({ agentId: 'researcher', estimatedUnits: 5, taskRef: 'job-142' })
  assert.equal(ok.approved, true)
})
