// Correctness harness for the preflight gate. Every assertion here is a bug
// that reached production once, so each one names the failure it prevents:
//
//   - a retried preflight reserving a second time (no idempotency key)
//   - N concurrent calls all passing a plan quota read outside the transaction
//   - a blocked call still burning quota, or leaving a reservation behind
//   - an abandoned run holding budget forever (no TTL, no sweeper)
//   - a late record() double-releasing a reservation the sweeper already took,
//     which is the one failure in this file that opens the gate instead of
//     closing it, and the reason settle decrements by what it actually closed
//
// The invariant checked after every phase is the one the whole design rests on:
//   customers.reserved_units == SUM(units) of that customer's open reservations
//
// Run with ./scripts/preflight/run.sh, which brings up a scratch database,
// applies the full migration chain and starts the server against it.

import postgres from 'postgres'

const API = process.env.API_BASE ?? 'http://localhost:3999'
const KEY = process.env.API_KEY ?? 'agb_testkey_local_verification_0001'
const ACCT = process.env.ACCOUNT_ID ?? '00000000-0000-0000-0000-0000000000aa'
const sql = postgres(process.env.DATABASE_URL, { ssl: false, transform: postgres.camel })

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}  ${detail}`) }
}

const pre = (body) => fetch(`${API}/preflight`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json() }))

const rec = (body) => fetch(`${API}/events`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json() }))

const reset = async () => {
  await sql`DELETE FROM reservations WHERE account_id = ${ACCT}`
  await sql`DELETE FROM preflight_requests WHERE account_id = ${ACCT}`
  await sql`DELETE FROM events WHERE account_id = ${ACCT}`
  await sql`DELETE FROM task_budgets WHERE account_id = ${ACCT}`
  await sql`DELETE FROM customers WHERE account_id = ${ACCT}`
  await sql`UPDATE accounts SET monthly_calls = 0, plan = 'free', default_budget_units = NULL,
            billing_period_start = date_trunc('month', CURRENT_DATE)::date WHERE id = ${ACCT}`
}
const acct = async () => (await sql`SELECT monthly_calls FROM accounts WHERE id = ${ACCT}`)[0].monthlyCalls
const cust = async (ref='default') => (await sql`SELECT id, used_units, reserved_units FROM customers WHERE account_id=${ACCT} AND customer_ref=${ref}`)[0]
const openSum = async (customerId) => Number((await sql`
  SELECT COALESCE(SUM(units),0) AS s FROM reservations WHERE customer_id=${customerId} AND released_at IS NULL`)[0].s)

// ---------------------------------------------------------------- 3: idempotency
console.log('\n[3] preflight idempotency')
await reset()
const a = await pre({ agent_id: 'r', estimated_units: 7, idempotency_key: 'k-1' })
const b = await pre({ agent_id: 'r', estimated_units: 7, idempotency_key: 'k-1' })
ok('both approved', a.body.approved === true && b.body.approved === true)
ok('same body replayed', JSON.stringify(a.body) === JSON.stringify(b.body),
   `${JSON.stringify(a.body)} vs ${JSON.stringify(b.body)}`)
let c = await cust()
ok('reserved once, not twice (7 not 14)', c.reservedUnits === 7, `got ${c.reservedUnits}`)
ok('one reservation row', await openSum(c.id) === 7)
ok('quota burned once', await acct() === 1, `got ${await acct()}`)

const d = await pre({ agent_id: 'r', estimated_units: 7 })   // no key
ok('no key still reserves again (14)', (await cust()).reservedUnits === 14)

// ---------------------------------------------------------------- 2: monthly quota race
console.log('\n[2] monthly_calls under concurrency')
await reset()
await sql`UPDATE accounts SET monthly_calls = 995 WHERE id = ${ACCT}`   // free limit 1000
const burst = await Promise.all(Array.from({ length: 25 }, () =>
  pre({ agent_id: 'r', estimated_units: 1 })))
const approved = burst.filter(r => r.body.approved === true).length
const blocked  = burst.filter(r => r.body.approved === false).length
ok('exactly 5 approved of 25 concurrent', approved === 5, `approved=${approved} blocked=${blocked}`)
ok('monthly_calls lands exactly on the limit', await acct() === 1000, `got ${await acct()}`)
ok('blocked ones say free_tier_exceeded',
   burst.filter(r => r.body.reason === 'free_tier_exceeded').length === 20)
c = await cust()
ok('reserved matches approvals only', c.reservedUnits === 5, `got ${c.reservedUnits}`)
ok('invariant: reserved == SUM(open rows)', c.reservedUnits === await openSum(c.id))

// ------------------------------------------- blocked call reserves nothing, burns no quota
console.log('\n[2b] a blocked call rolls everything back')
await reset()
await pre({ agent_id: 'r', estimated_units: 5, task_ref: 't1', task_ceiling: 10 })
const before = await acct()
const cBefore = (await cust()).reservedUnits
const rej = await pre({ agent_id: 'r', estimated_units: 50, task_ref: 't1' })
ok('task ceiling blocks', rej.body.reason === 'task_ceiling_exceeded', JSON.stringify(rej.body))
ok('no quota burned by the blocked call', await acct() === before, `${before} -> ${await acct()}`)
ok('no units reserved by the blocked call', (await cust()).reservedUnits === cBefore)
ok('invariant holds after rejection', (await cust()).reservedUnits === await openSum((await cust()).id))

// ---------------------------------------------------------------- 1: TTL + sweeper
console.log('\n[1] TTL sweeper reclaims abandoned reservations')
await reset()
await pre({ agent_id: 'r', estimated_units: 30, task_ref: 't2', task_ceiling: 100 })
c = await cust()
ok('held before sweep', c.reservedUnits === 30)
await sql`UPDATE reservations SET expires_at = now() - interval '1 minute' WHERE account_id = ${ACCT}`
const { sweepExpiredReservations } = await import('../../dist/lib/reservation-sweeper.js')
const reclaimed = await sweepExpiredReservations()
ok('sweeper reclaimed 1 row', reclaimed === 1, `got ${reclaimed}`)
c = await cust()
ok('customer reserved back to 0', c.reservedUnits === 0, `got ${c.reservedUnits}`)
const t2 = (await sql`SELECT reserved_units FROM task_budgets WHERE account_id=${ACCT} AND task_ref='t2'`)[0]
ok('task reserved back to 0', t2.reservedUnits === 0, `got ${t2.reservedUnits}`)
ok('sweeping again is a no-op', await sweepExpiredReservations() === 0)

// -------------------------------------- double-release: late record after a sweep
console.log('\n[1b] a late record cannot double-release')
// t2 above was swept. A second live reservation is now placed and must survive the late settle.
await pre({ agent_id: 'r', estimated_units: 12, task_ref: 't3', task_ceiling: 100 })
c = await cust()
ok('live reservation held', c.reservedUnits === 12, `got ${c.reservedUnits}`)
const late = await rec({ customer_id: 'default', event_type: 'llm', idempotency_key: 'late-1', units: 30, task_ref: 't2' })
ok('late record accepted', late.status === 200, JSON.stringify(late.body))
c = await cust()
ok('used_units still recorded (30)', c.usedUnits === 30, `got ${c.usedUnits}`)
ok('the live 12 units are STILL held, not double-released', c.reservedUnits === 12, `got ${c.reservedUnits}`)
ok('invariant: reserved == SUM(open rows)', c.reservedUnits === await openSum(c.id))

// -------------------------------------- normal settle closes its own reservation
console.log('\n[1c] normal settle closes exactly its own reservation')
const s = await rec({ customer_id: 'default', event_type: 'llm', idempotency_key: 'settle-1', units: 12, task_ref: 't3' })
ok('settle accepted', s.status === 200)
c = await cust()
ok('reserved back to 0', c.reservedUnits === 0, `got ${c.reservedUnits}`)
ok('invariant: reserved == SUM(open rows) == 0', c.reservedUnits === await openSum(c.id))

// -------------------------------------- failed run releases without billing
console.log('\n[1d] record(success=false) releases without billing')
await reset()
await pre({ agent_id: 'r', estimated_units: 9, task_ref: 't4', task_ceiling: 100 })
const usedBefore = (await cust()).usedUnits
const f = await rec({ customer_id: 'default', event_type: 'llm', idempotency_key: 'fail-1', units: 9, task_ref: 't4', success: false })
ok('release accepted', f.status === 200 && f.body.status === 'released', JSON.stringify(f.body))
c = await cust()
ok('reserved released', c.reservedUnits === 0, `got ${c.reservedUnits}`)
ok('nothing billed', c.usedUnits === usedBefore, `got ${c.usedUnits}`)
ok('invariant holds', c.reservedUnits === await openSum(c.id))

// ---------------------------------------------------------------- 4: key lifecycle
console.log('\n[4] revoke can kill a key that is mid-rotation')
// /keys/rotate parks a FUTURE timestamp in revoked_at and auth.ts treats that
// as a live 24h grace window. /keys/revoke matched on `revoked_at IS NULL`, so
// it skipped exactly those keys and answered "already_revoked" about a key that
// was still authenticating requests. A compromised key you had just rotated
// away from could not be killed through the API for 24 hours; the one on
// 2026-09-02 had to be closed by hand in the database.
//
// This phase runs last and on its own throwaway key, because it ends by
// revoking what it created.
const post = (path, body, key = KEY) => fetch(`${API}${path}`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body ?? {}),
}).then(async r => ({ status: r.status, body: await r.json() }))

const alive = (key) => fetch(`${API}/keys`, { headers: { 'Authorization': `Bearer ${key}` } })
  .then(r => r.status)

const gen = await post('/keys/generate', { label: 'lifecycle-test' })
ok('generated a scratch key', gen.status === 200 && typeof gen.body.api_key === 'string', JSON.stringify(gen.body))
const victim = gen.body.api_key
const prefix = victim.slice(0, 16)

ok('the new key authenticates', await alive(victim) === 200)

const rot = await post('/keys/rotate', {}, victim)
ok('rotate issued a replacement', rot.status === 200 && typeof rot.body.api_key === 'string', JSON.stringify(rot.body))
ok('rotated key still works during its grace window', await alive(victim) === 200)

// Asked in SQL, not against the host clock. The database runs ~120ms ahead of
// this process against a local container, which is enough to invert a
// just-written NOW() and is the second bug this phase found.
const rotatingRow = (await sql`
  SELECT revoked_at IS NOT NULL AS scheduled, revoked_at > NOW() AS in_future
  FROM developer_api_keys WHERE api_key = ${victim}`)[0]
ok('grace window is a FUTURE revoked_at, not NULL',
   rotatingRow.scheduled === true && rotatingRow.inFuture === true,
   JSON.stringify(rotatingRow))

// The regression itself. This used to return 400 already_revoked and leave the
// key authenticating for the rest of the window.
const rev = await post('/keys/revoke', { key_prefix: prefix })
ok('revoke kills a mid-rotation key', rev.status === 200 && rev.body.revoked === true, JSON.stringify(rev.body))
ok('revoked key is dead on the very next request', await alive(victim) === 401, `got ${await alive(victim)}`)

const revokedRow = (await sql`
  SELECT revoked_at <= NOW() AS is_past FROM developer_api_keys WHERE api_key = ${victim}`)[0]
ok('revoked_at was pulled back to the past', revokedRow.isPast === true, JSON.stringify(revokedRow))

// The two zero-row cases must not answer with the same sentence any more.
const again = await post('/keys/revoke', { key_prefix: prefix })
ok('revoking it twice reports already_revoked',
   again.status === 400 && again.body.error === 'already_revoked', JSON.stringify(again.body))

const missing = await post('/keys/revoke', { key_prefix: 'agb_thiskeydoesnotexist' })
ok('an unknown prefix reports key_not_found, not already_revoked',
   missing.status === 400 && missing.body.error === 'key_not_found', JSON.stringify(missing.body))

ok('the replacement key from the rotation is untouched', await alive(rot.body.api_key) === 200)

console.log(`\n${pass} passed, ${fail} failed`)
await sql.end()
process.exit(fail === 0 ? 0 : 1)
