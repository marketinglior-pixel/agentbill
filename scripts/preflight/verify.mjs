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
import { gzipSync, brotliCompressSync } from 'node:zlib'
import { ipOrigin } from '../../dist/lib/ip-origin.js'

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

// ------------------------------------------- quota alerts: once per threshold per period
// The claim lives in account_quota_alerts (migration 009). Delivery is
// fire-and-forget, so each check waits for the async write to land.
console.log('\n[2c] quota alerts claim once per threshold per period')
const settle = (ms) => new Promise(r => setTimeout(r, ms))
const claims = async () => (await sql`
  SELECT threshold FROM account_quota_alerts WHERE account_id = ${ACCT} ORDER BY threshold`).map(r => r.threshold)
await settle(400)
// [2] above refused 20 concurrent calls at the limit. That burst IS the 100% event,
// and the assertion is that twenty refusals produced one row, not twenty.
ok('20 concurrent refusals claimed the 100% alert exactly once', (await claims()).join(',') === '100', `got [${await claims()}]`)
await reset()   // leaves account_quota_alerts alone on purpose: same period, the 100 row must survive
await sql`UPDATE accounts SET monthly_calls = 749 WHERE id = ${ACCT}`
await pre({ agent_id: 'r', estimated_units: 1 })   // lands on 750, which is 75% of 1000
await pre({ agent_id: 'r', estimated_units: 1 })   // 751 crosses nothing
await settle(400)
ok('call 750 claims 75%, call 751 claims nothing', (await claims()).join(',') === '75,100', `got [${await claims()}]`)
await sql`UPDATE accounts SET monthly_calls = 899 WHERE id = ${ACCT}`
await Promise.all(Array.from({ length: 10 }, () => pre({ agent_id: 'r', estimated_units: 1 })))   // 900..909
await settle(400)
ok('90% claimed exactly once under a 10-call burst', (await claims()).join(',') === '75,90,100', `got [${await claims()}]`)
const [row75] = await sql`SELECT monthly_calls FROM account_quota_alerts WHERE account_id = ${ACCT} AND threshold = 75`
ok('the 75% row records the count that crossed it', row75?.monthlyCalls === 750, `got ${row75?.monthlyCalls}`)

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
// The reclaim is only worth something if the CALLER gets the budget back. A
// counter at 0 with a ceiling that still refuses would be the same outage in a
// different column. So: the call that was refused while the abandoned 30 were
// held is approved once they are reclaimed. The refusal half is asserted
// first, so a sweep that reclaimed nothing cannot pass this by accident.
await pre({ agent_id: 'r', estimated_units: 30, task_ref: 't2b', task_ceiling: 100 })
const heldRefusal = await pre({ agent_id: 'r', estimated_units: 80, task_ref: 't2b' })
ok('[recovery] while 30 are held, 80 more on a ceiling of 100 is refused', heldRefusal.body.approved === false && heldRefusal.body.reason === 'task_ceiling_exceeded', JSON.stringify(heldRefusal.body))
await sql`UPDATE reservations SET expires_at = now() - interval '1 minute' WHERE account_id = ${ACCT} AND task_ref = 't2b'`
ok('[recovery] the abandoned row is reclaimed', await sweepExpiredReservations() === 1)
const afterSweep = await pre({ agent_id: 'r', estimated_units: 80, task_ref: 't2b' })
ok('[recovery] the same call is approved once the sweeper has run: the ceiling recovers', afterSweep.body.approved === true && afterSweep.body.task_remaining_units === 20, JSON.stringify(afterSweep.body))
// And the recovered reservation is an ordinary one: it releases. success:false
// is the honest settle for a probe that never ran anything: it closes the row
// without billing, so the gates after this one find the customer exactly as
// it was, reserved 0 and used untouched. The first version of this block
// settled with success:true and 80 billed units leaked into '[1b] used_units
// still recorded (30)', which read 110.
const usedBeforeRelease = (await cust()).usedUnits
const recoveredSettle = await rec({ customer_id: 'default', event_type: 'llm', idempotency_key: 'recovery-settle', units: 80, task_ref: 't2b', success: false })
const afterRelease = await cust()
ok('[recovery] the post-sweep reservation releases like any other, and bills nothing', recoveredSettle.status === 200 && afterRelease.reservedUnits === 0 && afterRelease.usedUnits === usedBeforeRelease, `status ${recoveredSettle.status}, reserved ${afterRelease.reservedUnits}, used ${usedBeforeRelease} -> ${afterRelease.usedUnits}`)

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

// ------------------------------------- 5: the IP alert counts networks, not addresses
// On 2026-09-11 the owner of one account received roughly eleven "new IP
// detected" mails a minute, for two days, about a key nobody had stolen.
//
// The alert compared the request against a single column, last_seen_ip, and
// mailed on any difference. That is a one-slot memory, so two addresses in
// rotation alert on EVERY request: A is not B, then B is not A, forever. And
// two addresses are always in rotation. macOS holds a stable `secured` IPv6
// address plus one or more `temporary` privacy addresses on the same /64 and
// picks between them per connection. Measured on the founder's laptop that day,
// 100 consecutive requests to production: 28 changes, nothing moved.
//
// The unit is now the origin (the /64, or the IPv4 address) and the memory is a
// UNIQUE claim row per origin, so every assertion below is a count of rows and
// of alerts, not of requests. The three HOME_ addresses are the real ones read
// off that laptop with ifconfig.
console.log('\n[5] IP alerts claim once per network')

const HOME_A = '2a00:a041:e327:b500:5033:89cf:1791:b686'   // temporary
const HOME_B = '2a00:a041:e327:b500:5173:edf9:1a7d:7a95'   // temporary, deprecated
const HOME_C = '2a00:a041:e327:b500:1c9c:2cbc:a2e3:ff6f'   // autoconf secured
const CAFE   = '2a02:169:3f00:1::1'
const OFFICE = '203.0.113.77'

ok('three addresses of one laptop are one origin',
   ipOrigin(HOME_A) === ipOrigin(HOME_B) && ipOrigin(HOME_B) === ipOrigin(HOME_C),
   `${ipOrigin(HOME_A)} ${ipOrigin(HOME_B)} ${ipOrigin(HOME_C)}`)
ok('the neighbouring /64 is NOT that origin',
   ipOrigin('2a00:a041:e327:b501::1') !== ipOrigin(HOME_A))
ok('an IPv4-mapped address keeps its own v4 identity',
   ipOrigin('::ffff:203.0.113.9') === '203.0.113.9', ipOrigin('::ffff:203.0.113.9'))
ok('a non-address has no origin', ipOrigin('not-an-ip') === null)

const ipGen = await post('/keys/generate', { label: 'ip-origin-test' })
const ipKey = ipGen.body.api_key
const ipKeyId = (await sql`SELECT id FROM developer_api_keys WHERE api_key = ${ipKey}`)[0].id

// fly-client-ip is what clientIp() trusts first, and behind Fly the proxy
// overwrites whatever a caller sent. Here there is no proxy, so it is the lever.
const from = (ip) => fetch(`${API}/keys`, {
  headers: { 'Authorization': `Bearer ${ipKey}`, 'fly-client-ip': ip },
}).then(r => r.status)

const rowsFor = () => sql`
  SELECT origin, alerted_at FROM api_key_ip_origins WHERE api_key_id = ${ipKeyId} ORDER BY id`
const counts = async () => {
  const r = await rowsFor()
  return { origins: r.length, alerts: r.filter(x => x.alertedAt !== null).length }
}

/**
 * Read a counter once it has stopped moving, instead of sleeping a guess.
 *
 * Every assertion in this section used to be `await settle(300..800)` then read,
 * and each one of them was a race, not just the one that lost. The alert write
 * is dispatched fire-and-forget from the onRequest hook AFTER the response is
 * sent (auth.ts), so the fetch resolving proves nothing about the row. On a warm
 * database the write lands inside the sleep and the gate is green; on a cold one
 * it does not. Reproduced 2026-09-12 on a fresh database: the daily-cap gate read
 * `{"origins":6,"alerts":4}` and the same query moments later returned 5.
 *
 * `want` is an EARLY EXIT, not an expectation the wait enforces. Three ways out,
 * and the assertion always runs on what was actually read:
 *   - the counter reaches `want`      -> return at once, so a passing run is fast
 *   - it goes quiet for QUIET_MS      -> return that, so a genuinely wrong value
 *                                        is reported quickly instead of at the
 *                                        deadline
 *   - DEADLINE_MS elapses             -> return the last read, and let the gate
 *                                        fail on it
 *
 * That is what keeps these gates able to fail. A wait that polled until it saw
 * the number it wanted, and asserted that it had, would be a gate that can only
 * ever pass: mutate ALERTS_PER_DAY to 4 and it would spin to the deadline and
 * then assert 4 === 4 against a `want` it had already given up on. Proven by
 * mutation both ways before this was trusted (see the header of this file).
 */
// The quiet window is a FAILURE-REPORTING LATENCY, not a correctness parameter,
// and getting that backwards is what made the first version of this helper fail
// on its own first run. A correct run never waits for it: the early exit fires
// the moment the counter reaches `want`, and these counters only ever increase,
// so they cannot pass through the wanted value and move on. Quiet only decides
// how long a WRONG value takes to be reported. So it is set well above the
// longest gap the write path can produce rather than trimmed for speed.
//
// Two gaps measured, and the second one is why this number is 8 seconds rather
// than the 2.5 it was first set to.
//
// The 20-concurrent-request gate reads {origins:3, alerts:2}, and those are two
// separate writes: auth.ts claims the origin with an INSERT, then SELECTs the
// context, then UPDATEs alerted_at. With 20 requests in flight against a pool of
// 10, the winner's SELECT and UPDATE queue behind nineteen losing claims, so
// `origins` hits 3 while `alerts` is still 1 for over half a second. At
// QUIET_MS = 500 the helper called that settled and went red on a correct
// system.
//
// The longer gap is the FIRST alert on a cold database, and it was missed the
// first time because the number was set from the worst gap SEEN rather than the
// worst the path can produce. Measured 2026-09-16 on a fresh database, from the
// row itself: origin 2a02:169:3f00:1::/64 first_seen_at 17:01:15.077,
// alerted_at 17:01:18.616. Three and a half seconds, because that request pays
// for the first execution of the joined `ctx` query and the first UPDATE on the
// table. At 2,500 the gate read {origins:2, alerts:0} and failed on a correct
// system, one second before the write landed.
//
// Eight is comfortably past that and costs almost nothing: a passing run never
// waits for quiet at all, because the early exit fires as soon as the counter
// reaches the wanted value. Quiet only bounds how long a WRONG value takes to be
// reported.
const QUIET_MS = 8_000
const DEADLINE_MS = 20_000
const POLL_MS = 50
const same = (a, b) => a.origins === b.origins && a.alerts === b.alerts
const reads = async (want, quietMs = QUIET_MS) => {
  const started = Date.now()
  let last = await counts()
  let changedAt = Date.now()
  while (!(want && same(last, want))) {
    if (Date.now() - started >= DEADLINE_MS) break
    await settle(POLL_MS)
    const now = await counts()
    if (same(now, last)) {
      if (Date.now() - changedAt >= quietMs) break
    } else {
      last = now
      changedAt = Date.now()
    }
  }
  return last
}

/**
 * The same wait with the early exit DELIBERATELY withheld, for the two gates
 * whose claim is that nothing happened.
 *
 * `reads(want)` returning as soon as it sees `want` is right when the assertion
 * is about a change: the state before the change differs from the state after
 * it, so an immediate match means the change has landed. It is WRONG when the
 * expected state is also the state we started in, because then "it already
 * matches" and "nothing has happened yet" are the same reading, and a regression
 * that added a row half a second later would be reported as the pass it is not.
 * The flap gate below is exactly that shape: two origins and one alert, before
 * and after.
 *
 * So those wait on quiet alone, and on a longer quiet, because quiet is the
 * whole claim rather than a way of knowing a write has finished.
 */
// Above the 3.5s first-alert gap too, and for the same reason: this wait has no
// early exit, so it is the ONLY thing standing between "nothing happened" and
// "the write has not landed yet". At 1,500 it would have declared a regression
// absent a second before the regression's own write appeared.
const QUIET_NEGATIVE_MS = 5_000
const readsQuiet = () => reads(null, QUIET_NEGATIVE_MS)

// The exact shape that produced the flood: one laptop, one network, address
// churning underneath. The old code sent 29 mails for this; the claim sends 0,
// and the first origin a key is ever seen from is not a change at all.
for (let i = 0; i < 30; i++) await from([HOME_A, HOME_B, HOME_C][i % 3])
let ipc = await reads({ origins: 1, alerts: 0 })
ok('30 requests across 3 rotating addresses claim ONE origin', ipc.origins === 1, JSON.stringify(ipc))
ok('and alert nobody, because it is the first network', ipc.alerts === 0, JSON.stringify(ipc))

// A real move. This is the signal the alert exists for and it must survive.
await from(CAFE)
ipc = await reads({ origins: 2, alerts: 1 })
ok('a genuinely new network claims a second origin', ipc.origins === 2, JSON.stringify(ipc))
ok('and alerts exactly once', ipc.alerts === 1, JSON.stringify(ipc))

// Flapping between two KNOWN networks is the same one-slot trap one level up.
for (let i = 0; i < 20; i++) await from(i % 2 ? HOME_A : CAFE)
ipc = await readsQuiet()
ok('20 flaps between two known networks add no rows', ipc.origins === 2, JSON.stringify(ipc))
ok('and send nothing further', ipc.alerts === 1, JSON.stringify(ipc))

// Same assertion the quota alerts make: N concurrent callers, one claim. The
// INSERT ... ON CONFLICT is the only thing that can decide this.
await Promise.all(Array.from({ length: 20 }, () => from(OFFICE)))
ipc = await reads({ origins: 3, alerts: 2 })
ok('20 concurrent requests from one new network claim it once', ipc.origins === 3, JSON.stringify(ipc))
ok('and alert exactly once', ipc.alerts === 2, JSON.stringify(ipc))

// The backstop: distinct networks are not themselves a bound. Without a ceiling,
// a caller spraying one key across many source /64s would earn a mail per
// network, forever, because every one of them is a genuinely new origin.
//
// WHAT THIS BLOCK SHOWS, AND WHAT IT DOES NOT. It walks the count up to the
// ceiling and stops there. That is a PRECONDITION for testing the ceiling, not
// a test of it, and this comment claimed the opposite until 2026-09-13.
//
// Proven by mutation rather than by reading: turn the check into dead code
// (`if (false && Number(ctx.recent) >= ALERTS_PER_DAY)` in auth.ts) and the gate
// below stays GREEN, because six origins produce exactly five alerts whether or
// not a ceiling exists. The line that goes red is the seventh-origin pair
// further down, at {"origins":7,"alerts":6}. Anyone scanning this file for
// "is the cap tested" would have found yes here and been wrong about where.
//
// One correction to the sentence above while it is being rewritten: the unit is
// the ACCOUNT, not the key. `recent` in auth.ts joins developer_api_keys on
// account_id, since #47. Counted per key, POST /keys/generate handed every newly
// minted key a fresh allowance of five into the same inbox, which is the flood
// rebuilt out of the one thing the counter was not counting.
for (const n of ['2001:db8:1::9', '2001:db8:2::9', '2001:db8:3::9']) await from(n)
ipc = await reads({ origins: 6, alerts: 5 })
ok('five alerts accumulate, which is the cap value', ipc.alerts === 5, JSON.stringify(ipc))


// The cap counts per ACCOUNT, not per key, 2026-09-12. POST /keys/generate has
// no per-account key cap, so a cap keyed on api_key_id handed every new key a
// fresh allowance of five into the SAME mailbox: the flood of 2026-09-11 built
// out of the one thing the cap was not counting. Mutating the `recent` subquery
// back to `WHERE api_key_id = ...` makes this gate red.
const [acctOfKey8] = await sql`SELECT account_id FROM developer_api_keys WHERE api_key = ${KEY}`
const secondKey8 = 'agb_' + 'c'.repeat(48)
await sql`
  INSERT INTO developer_api_keys (account_id, api_key, label)
  VALUES (${acctOfKey8.accountId ?? acctOfKey8.account_id}, ${secondKey8}, 'ip-cap-second-key')
  ON CONFLICT DO NOTHING`
const [k2] = await sql`SELECT id FROM developer_api_keys WHERE api_key = ${secondKey8}`
// Two origins on the fresh key, so its own per-key count would permit an alert.
for (const n of ['2001:db8:9a::1', '2001:db8:9b::1']) {
  await sql`
    INSERT INTO api_key_ip_origins (api_key_id, origin, last_ip)
    VALUES (${k2.id}, ${n + '/64'}, ${n})
    ON CONFLICT (api_key_id, origin) DO NOTHING`
}
const perAccount8 = (await sql`
  SELECT (SELECT count(*)::int FROM api_key_ip_origins WHERE api_key_id = ${k2.id}) AS per_key,
         (SELECT count(*)::int FROM api_key_ip_origins o
            JOIN developer_api_keys k ON k.id = o.api_key_id
           WHERE k.account_id = ${acctOfKey8.accountId ?? acctOfKey8.account_id}
             AND o.alerted_at > NOW() - INTERVAL '24 hours') AS recent
`)[0]
ok('[ip-cap] a second key on the same account inherits the account\'s spent allowance, not a fresh one',
   perAccount8.recent >= 5 && perAccount8.perKey === 2,
   JSON.stringify(perAccount8))
await sql`DELETE FROM api_key_ip_origins WHERE api_key_id = ${k2.id}`
await sql`DELETE FROM developer_api_keys WHERE id = ${k2.id}`

// Two stages, because this pair makes a positive and a negative claim about the
// same moment and they need opposite waits. auth.ts claims the origin with an
// INSERT and only then decides whether to alert, so `origins` reaching 7 says
// nothing yet about whether an alert is coming: quiet alone could settle on
// {6,5} before the INSERT lands, and an early exit on {7,5} could return before
// the UPDATE that a regression would write. So: get past the INSERT first, then
// wait for quiet to see whether anything follows it.
//
// This is the pair that actually tests ENFORCEMENT. Proven by mutation on
// 2026-09-13: with the cap check turned into dead code, the gate above stays
// green and this one goes red at {"origins":7,"alerts":6}.
await from('2001:db8:4::9')
await reads({ origins: 7, alerts: 5 })
ipc = await readsQuiet()
ok('a 6th new network is still recorded', ipc.origins === 7, JSON.stringify(ipc))
ok('but is not mailed once the cap is reached', ipc.alerts === 5, JSON.stringify(ipc))

// ---------------------------------------------------------------------------
// Opaque ids. Every one of these was a 500 on 2026-09-07, and eleven of them
// answered with the raw Postgres sentence "invalid byte sequence for encoding
// UTF8: 0x00" in the response body, because a caller string reached a text
// parameter unvalidated and Fastify's default error handler serialises
// error.message. The ids are checked by one predicate now (src/lib/ids.ts) and
// no 5xx may carry a database message.
// ---------------------------------------------------------------------------
const NUL = String.fromCharCode(0)
const get = (path, key = KEY) => fetch(`${API}${path}`, { headers: { 'Authorization': `Bearer ${key}` } })
  .then(async r => ({ status: r.status, text: await r.text() }))

const idCases = [
  ['GET /decisions?task_ref', () => get('/decisions?task_ref=%00')],
  ['GET /decisions?agent_id', () => get('/decisions?agent_id=%00')],
  ['GET /tasks?agent_id', () => get('/tasks?agent_id=%00')],
  ['GET /tasks/:task_ref', () => get('/tasks/%00')],
  ['PUT /tasks/:task_ref/ceiling', () => fetch(`${API}/tasks/%00/ceiling`, {
    method: 'PUT', headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ceiling_units: 5 }) }).then(async r => ({ status: r.status, text: await r.text() }))],
  ['GET /budget?customer_id', () => get('/budget?customer_id=%00')],
  ['POST /preflight task_ref', () => pre({ agent_id: 'ctrl', task_ref: `t${NUL}`, task_ceiling: 5, estimated_units: 1 })],
  ['POST /preflight idempotency_key', () => pre({ agent_id: 'ctrl', idempotency_key: `k${NUL}`, estimated_units: 1 })],
  ['POST /events customer_id', () => rec({ customer_id: `c${NUL}`, event_type: 'run', idempotency_key: 'ctrl-1', units: 1 })],
  ['POST /events event_type', () => rec({ customer_id: 'ctrl', event_type: `e${NUL}`, idempotency_key: 'ctrl-2', units: 1 })],
  ['POST /keys/generate label', () => post('/keys/generate', { label: `l${NUL}` })],
]

for (const [name, run] of idCases) {
  const r = await run()
  const body = r.text ?? JSON.stringify(r.body)
  ok(`${name}: a control character is 422, not 500`, r.status === 422, `got ${r.status} ${body.slice(0, 120)}`)
  ok(`${name}: no database message in the body`, !/invalid byte sequence|encoding "UTF8"|22021/i.test(body), body.slice(0, 160))
}

// The rule rejects control characters, not ids: anything printable still works.
const okUnicode = await get(`/decisions?task_ref=${encodeURIComponent('one two')}`)
ok('a printable task_ref with a space is still accepted', okUnicode.status === 200, `got ${okUnicode.status}`)
const okLong = await get(`/decisions?task_ref=${'a'.repeat(128)}`)
ok('a task_ref at the 128 limit is accepted', okLong.status === 200, `got ${okLong.status}`)
const tooLong = await get(`/decisions?task_ref=${'a'.repeat(129)}`)
ok('a task_ref past the limit is 422', tooLong.status === 422, `got ${tooLong.status}`)

// The prefix on /keys/revoke was the LIKE pattern itself. Every key contains
// the underscore of "agb_", a single-character wildcard, so "agb_%" matched
// every key on the account and one request revoked all of them. Measured on
// 2026-09-07: revoked_count 2 of 2. This assertion fails loudly if it returns,
// because the key it would revoke is the one this harness authenticates with.
// The prefix is long enough to pass the length rule and still carries a
// wildcard: under LIKE this matched the harness's own key (the % swallowing
// the rest of it), under starts_with it matches nothing.
const wildcard = await post('/keys/revoke', { key_prefix: `${KEY.slice(0, 15)}%` })
ok('a prefix is a prefix, not a LIKE pattern',
   wildcard.status === 400 && wildcard.body.error === 'key_not_found', JSON.stringify(wildcard.body))
ok('the harness key survived the wildcard prefix', await alive(KEY) === 200, `got ${await alive(KEY)}`)

// zod's .url() is a validator, not a filter: the WHATWG parser tolerates a
// control character and zod hands back the ORIGINAL string, so a webhook URL
// carrying a NUL reached the UPDATE and 500ed.
const badUrl = await post('/webhook-config', { url: `https://example.com/a${NUL}b` })
ok('a control character inside a valid https URL is 422', badUrl.status === 422, JSON.stringify(badUrl.body).slice(0, 140))
const goodUrl = await post('/webhook-config', { url: 'https://example.com/hook' })
ok('an ordinary https URL is still accepted', goodUrl.status === 200, JSON.stringify(goodUrl.body).slice(0, 140))

// Polar signs with Standard Webhooks: HMAC-SHA256 over
// `${webhook-id}.${webhook-timestamp}.${body}`, base64, in a `webhook-signature`
// header, alongside webhook-id and webhook-timestamp. THE HARNESS SIGNS THROUGH
// THE SAME LIBRARY THE SERVER VERIFIES WITH. It used to sign v1,<hex over body>,
// which is what the old verifier expected, so "a correctly signed upgrade is
// accepted" passed while production rejected every real webhook 401: both sides
// were wrong the same way, and the test measured the code against itself. A real
// $0 checkout on 2026-09-07 produced ten 401s and exposed it.
const { Webhook } = await import('standardwebhooks')
const SECRET = process.env.WEBHOOK_SECRET ?? ''
const wh = new Webhook(Buffer.from(SECRET, 'utf-8').toString('base64'))
let msgSeq = 0
const signHeaders = (body, { date = new Date(), signBody = body } = {}) => {
  const id = `msg_${Date.now()}_${msgSeq++}`
  return {
    'webhook-id': id,
    'webhook-timestamp': String(Math.floor(date.getTime() / 1000)),
    'webhook-signature': wh.sign(id, date, signBody),
  }
}
const hook = (payload, { sign = true } = {}) => {
  const body = JSON.stringify(payload)
  const headers = { 'Content-Type': 'application/json', ...(sign ? signHeaders(body) : {}) }
  return fetch(`${API}/webhooks/polar`, { method: 'POST', headers, body })
    .then(async r => ({ status: r.status, body: await r.text() }))
}
const postHook = (body, headers) =>
  fetch(`${API}/webhooks/polar`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body })
    .then(async r => ({ status: r.status, body: await r.text() }))

const unsigned = await hook({ type: 'subscription.active', data: {} }, { sign: false })
ok('an unsigned webhook is refused', unsigned.status === 401, `${unsigned.status} ${unsigned.body.slice(0, 120)}`)

// Well-formed headers, garbage signature: this is a FORGED signature, not just
// missing headers, so it exercises the constant-time compare and not the guard.
const forgedBody = JSON.stringify({ type: 'subscription.active', data: {} })
const forgedHdr = signHeaders(forgedBody)
forgedHdr['webhook-signature'] = 'v1,' + Buffer.from('not-the-real-mac').toString('base64')
const forged = await postHook(forgedBody, forgedHdr)
ok('a forged signature is refused', forged.status === 401, `got ${forged.status}`)

// The empty-string bug: a signature computed over '' must not verify a real body.
const emptyBody = JSON.stringify({ type: 'subscription.active', data: {} })
const emptySig = await postHook(emptyBody, signHeaders(emptyBody, { signBody: '' }))
ok('a signature over the empty string is refused', emptySig.status === 401, `got ${emptySig.status}`)

// A valid signature over a DIFFERENT body must not verify this one.
const swapBody = JSON.stringify({ type: 'subscription.active', data: { metadata: { agentbill_account_id: ACCT } } })
const swapped = await postHook(swapBody, signHeaders(swapBody, { signBody: JSON.stringify({ type: 'a', data: {} }) }))
ok('a valid signature over a different body is refused', swapped.status === 401, `got ${swapped.status}`)

// A correctly signed body with a stale timestamp must be refused: Standard
// Webhooks rejects anything older than five minutes, which is replay protection
// this endpoint gains for free by using the library.
const oldBody = JSON.stringify({ type: 'subscription.active', data: {} })
const oldStamp = new Date(Date.now() - 10 * 60_000)
const stale = await postHook(oldBody, signHeaders(oldBody, { date: oldStamp }))
ok('a valid signature with a stale timestamp is refused', stale.status === 401, `got ${stale.status}`)

// The path a paying customer actually takes, which has never worked.
const upgraded = await hook({ type: 'subscription.active', data: { customer_id: 'cus_verify', product_id: 'unknown-product', metadata: { agentbill_account_id: ACCT } } })
ok('a correctly signed upgrade is accepted', upgraded.status === 200, `${upgraded.status} ${upgraded.body.slice(0, 120)}`)
const planRow = (await sql`SELECT plan, polar_customer_id FROM accounts WHERE id = ${ACCT}`)[0]
ok('and it actually moved the account off free', planRow.plan !== 'free' && planRow.polarCustomerId === 'cus_verify', JSON.stringify(planRow))
await sql`UPDATE accounts SET plan = 'free', polar_customer_id = NULL, monthly_calls = 0 WHERE id = ${ACCT}`

const badHook = await hook({ type: 'subscription.active', data: { customer_id: 'polar_1', metadata: { agentbill_account_id: 'not-a-uuid' } } })
ok('a malformed account id in a Polar webhook is 200, not 500',
   badHook.status === 200 && !/invalid input syntax|22P02/i.test(badHook.body), `${badHook.status} ${badHook.body.slice(0, 140)}`)

// A value the schema accepts must be a value the column accepts. That is the
// same rule as the id rules above, in the other direction: every units and
// ceiling column is INTEGER and every schema said z.number().int() with no
// ceiling, so 3_000_000_000 was Postgres 22003 and a 500.
const bigUnits = await rec({ customer_id: 'intmax', event_type: 'run', idempotency_key: `im-${Date.now()}`, units: 3_000_000_000 })
ok('a number past INTEGER is 422, not 500', bigUnits.status === 422, `${bigUnits.status} ${JSON.stringify(bigUnits.body).slice(0, 120)}`)
const bigEst = await pre({ agent_id: 'intmax', estimated_units: 3_000_000_000 })
ok('estimated_units past INTEGER is 422, not 500', bigEst.status === 422, `${bigEst.status} ${JSON.stringify(bigEst.body).slice(0, 120)}`)

// events.units had min(0) while the table has CHECK (units >= 1), so a value
// the route accepted was one the database refused.
const zeroUnits = await rec({ customer_id: 'zero', event_type: 'run', idempotency_key: `z-${Date.now()}`, units: 0 })
ok('units 0 is 422, not the 500 the CHECK produced', zeroUnits.status === 422, `${zeroUnits.status} ${JSON.stringify(zeroUnits.body).slice(0, 120)}`)

// preflight, checkpoint and step all read "" as "the default customer", so the
// id rule must keep accepting it: this regressed to 422 when zId landed.
const blankCustomer = await pre({ agent_id: 'blank', customer_id: '', estimated_units: 1 })
ok('an empty customer_id still means the default customer', blankCustomer.status === 200, `${blankCustomer.status} ${JSON.stringify(blankCustomer.body).slice(0, 120)}`)

// A task_ref may be 128 characters, and Fastify's default ceiling on a path
// segment is 100, so this route answered the router's 404 for a task the API
// was happy to create.
const longRef = 'r'.repeat(110)
const longLookup = await get(`/tasks/${longRef}`)
ok('a 110-character task_ref reaches the handler', longLookup.status === 404 && /task_not_found/.test(longLookup.text),
   `${longLookup.status} ${longLookup.text.slice(0, 120)}`)

// "agb_" is the prefix every key shares, and it was the shortest this schema
// allowed, so the minimum value was the accidental catch-all.
const shortPrefix = await post('/keys/revoke', { key_prefix: 'agb_' })
ok('the key prefix every key shares is too short to accept', shortPrefix.status === 422, JSON.stringify(shortPrefix.body).slice(0, 120))
ok('the harness key survived that too', await alive(KEY) === 200, `got ${await alive(KEY)}`)

// The Polar customer id is caller input as much as the account id is.
const hookCtrl = await hook({ type: 'subscription.active', data: { customer_id: `c${NUL}`, metadata: { agentbill_account_id: ACCT } } })
ok('a control character in the Polar customer id is 200, not 500',
   hookCtrl.status === 200 && !/invalid byte sequence|22021/i.test(hookCtrl.body), `${hookCtrl.status} ${hookCtrl.body.slice(0, 120)}`)

// ---------------------------------------------------------------------------
// The rejected-webhook alert keeps module state (a per-reason tally and a
// cooldown) and runs on the request path. State on a request path is a way to
// make the tenth call behave unlike the first, and this route answers a sender
// that retries, so the tenth call is the normal case rather than the edge.
// Nothing here asserts that an email went out; it asserts that trying to send
// one cannot change what the route answers.
const rejectBurst = []
for (let i = 0; i < 6; i++) rejectBurst.push(await hook({ type: 'subscription.active', data: {} }, { sign: false }))
ok('six rejections in a row all still answer 401', rejectBurst.every((r) => r.status === 401),
   rejectBurst.map((r) => r.status).join(','))
ok('and none of them leaked an alert or a stack into the body',
   rejectBurst.every((r) => /invalid_signature/.test(r.body) && !/webhook-alert|resend|Error:/i.test(r.body)),
   rejectBurst[0].body.slice(0, 120))

// The 200 branch is the one that costs money: the signature verified, so a real
// payment arrived, and answering 200 is what stops Polar retrying it. It has to
// keep answering 200 (a 500 would be retried forever) while the account stays
// on the plan it had.
const beforePlan = (await sql`SELECT plan FROM accounts WHERE id = ${ACCT}`)[0]?.plan
const unusable = await hook({ type: 'subscription.active', data: { customer_id: 'alert-probe', metadata: { agentbill_account_id: 'still-not-a-uuid' } } })
ok('a signed webhook with an unusable account id is 200, not a retry loop', unusable.status === 200, `${unusable.status} ${unusable.body.slice(0, 100)}`)
const afterPlan = (await sql`SELECT plan FROM accounts WHERE id = ${ACCT}`)[0]?.plan
ok('and it changed no plan', beforePlan === afterPlan, `${beforePlan} -> ${afterPlan}`)

// ---------------------------------------------------------------------------
// Fastify 5. Each of these is a behaviour the major changed, and each was
// measured on a local v4 and a local v5 before it was written down.

// @fastify/compress 9 rebuilt its request-decompression transform, and this app
// receives a compressed request body from nobody, which is exactly why a
// regression here would be silent. The gate is that a compressed body and a
// plain one produce the same answer, and that a broken one is a 4xx.
const sendEncoded = (enc, payload) => fetch(`${API}/preflight`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'Content-Encoding': enc },
  body: payload,
}).then(async (r) => ({ status: r.status, text: await r.text() }))

const bodyJson = JSON.stringify({ agent_id: 'encoding', estimated_units: 1 })
const gz = await sendEncoded('gzip', gzipSync(bodyJson))
ok('a gzip request body decompresses and is approved', gz.status === 200 && /"approved":true/.test(gz.text), `${gz.status} ${gz.text.slice(0, 120)}`)
const brq = await sendEncoded('br', brotliCompressSync(bodyJson))
ok('a brotli request body decompresses and is approved', brq.status === 200 && /"approved":true/.test(brq.text), `${brq.status} ${brq.text.slice(0, 120)}`)
const badGz = await sendEncoded('gzip', Buffer.from('not gzip at all'))
ok('a corrupt compressed body is 400, not 500', badGz.status === 400, `${badGz.status} ${badGz.text.slice(0, 120)}`)
const unkEnc = await sendEncoded('weird', bodyJson)
ok('an unknown Content-Encoding is 415, not 500', unkEnc.status === 415, `${unkEnc.status} ${unkEnc.text.slice(0, 120)}`)

// Fastify 5 added a third frameworkErrors call site: an over-long path segment
// used to fall to the not-found handler and now arrives here, which is a reply
// that never reaches the onSend hook. It went out with no security headers at
// all until this was caught, so the header is the assertion, not the status.
const overLong = await fetch(`${API}/tasks/${'a'.repeat(200)}`, { headers: { Authorization: `Bearer ${KEY}` } })
const overLongBody = await overLong.text()
ok('a path segment past the ceiling is 414', overLong.status === 414, `${overLong.status} ${overLongBody.slice(0, 120)}`)
ok('and it still carries nosniff', overLong.headers.get('x-content-type-options') === 'nosniff', String(overLong.headers.get('x-content-type-options')))
ok('and it still carries X-Frame-Options', overLong.headers.get('x-frame-options') === 'DENY', String(overLong.headers.get('x-frame-options')))
ok('and it reflects no part of the URL', !/aaaaaaaaaa/.test(overLongBody), overLongBody.slice(0, 120))

// A malformed percent-encoding is the other frameworkErrors path, and it was
// bare of the same headers under Fastify 4.
const malformedUrl = await fetch(`${API}/%`)
ok('a malformed URL is 400 and carries nosniff',
   malformedUrl.status === 400 && malformedUrl.headers.get('x-content-type-options') === 'nosniff',
   `${malformedUrl.status} ${malformedUrl.headers.get('x-content-type-options')}`)

// request.hostname stopped including the port in Fastify 5, and the same-origin
// guard on the login form compared it against a URL host that does include one,
// so every non-443 origin answered 403. Production never showed it because Host
// there carries no port. The cross-origin direction is asserted next to it,
// because a guard that stops refusing is the worse half of this bug.
const session = (headers) => fetch(`${API}/app/session`, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
  body: 'api_key=agb_notarealkey_0000',
}).then((r) => r.status)
const origin = new URL(API).origin
ok('a same-origin POST with a port and no Sec-Fetch-Site is not refused', await session({ Origin: origin }) !== 403)
ok('a cross-origin POST is still refused', await session({ Origin: 'https://evil.example' }) === 403)
ok('Sec-Fetch-Site: cross-site is still refused', await session({ Origin: origin, 'Sec-Fetch-Site': 'cross-site' }) === 403)

// ------------------------------- 5b: abuse counters bucket by network, not address
// Same root cause as [5], one level up and with teeth. These counters keyed on
// the raw address string, so on IPv6 a caller got a FRESH allowance every time
// the OS picked a different privacy address out of the same /64, which it does
// per connection. The limit that reads as 10 an hour was, for an IPv6 caller
// willing to do nothing but wait for a rotation, not 10 an hour.
//
// /recover is the surface under test because its limiter runs before any
// lookup, a refusal is a 429 and a pass is a 303, and an address that owns no
// account creates nothing and sends nothing either way.
console.log('\n[5b] rate-limit buckets are per network')

const recover = (ip, email = 'nobody-limiter-test@example.com') =>
  fetch(`${API}/recover`, {
    method: 'POST', redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': new URL(API).origin,
      'fly-client-ip': ip,
    },
    body: `email=${encodeURIComponent(email)}`,
  }).then((r) => r.status)

// RECOVER_IP_LIMIT is 10 an hour. Spend exactly that from one address.
const spent = []
for (let i = 0; i < 10; i++) spent.push(await recover('2001:db8:aa::1'))
ok('10 attempts from one address are all allowed', spent.every((s) => s === 303), `got [${spent}]`)
ok('the 11th from that address is refused', await recover('2001:db8:aa::1') === 429)

// The fix. A different /128 inside the SAME /64 is the same caller, and under
// the old key it walked straight through with a full allowance.
ok('a different address in the same /64 is the same bucket',
   await recover('2001:db8:aa::2') === 429)
ok('and so is a third one', await recover('2001:db8:aa:0:abcd:ef01:2345:6789') === 429)

// The other half: collapsing must not over-collapse. A real neighbouring
// network is a different caller and must still be served.
ok('a different /64 is a different bucket', await recover('2001:db8:bb::1') === 303)

// IPv4 is its own origin, so its behaviour is unchanged in both directions.
ok('an IPv4 address gets its own bucket', await recover('198.51.100.10') === 303)
ok('a second IPv4 address is a separate bucket', await recover('198.51.100.11') === 303)

// The page the reveal branch renders, 2026-09-12. Until today this was the one
// surface in the product holding a plaintext key that said only "store it in an
// environment variable" and left the reader to retype the line themselves, and
// the console's own sentence sent them here for a line that was not here. It is
// now the second place that can print `export AGENTBILL_API_KEY=<the key>` with
// nothing to fill in, which is what makes /register#done survivable: that
// screen is a client-side replaceState and its copy of the line cannot be
// reloaded. Never covered before, on either the old copy or the new.
// randomBytes(32).toString('base64url') is 43 chars, which is exactly what
// TOKEN_RE demands (recover.ts:50); a hand-built string of the wrong length is
// rejected before the token is ever looked up, and the gate would then pass or
// fail for the wrong reason.
const { createHash, randomBytes } = await import('node:crypto')
const revealToken = randomBytes(32).toString('base64url')
const [revealAcct] = await sql`SELECT id FROM accounts WHERE id = ${ACCT}`
await sql`
  INSERT INTO account_recovery_tokens (account_id, token_hash, expires_at)
  VALUES (${revealAcct.id}, ${createHash('sha256').update(revealToken).digest('hex')}, NOW() + INTERVAL '10 minutes')
`
const revealRes = await fetch(`${API}/recover/${revealToken}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', origin: API },
  body: 'action=reveal',
  redirect: 'manual',
})
const revealHtml = await revealRes.text()
ok('[recover] the reveal page prints the live key', revealRes.status === 200 && revealHtml.includes(KEY),
   `${revealRes.status}`)
ok('[recover] and the export line that sets it, with the key already in it and no placeholder',
   revealHtml.includes(`export AGENTBILL_API_KEY=${KEY}`)
     && !/export AGENTBILL_API_KEY=(&lt;|\s|<)/.test(revealHtml))
ok('[recover] and names the two ways in that need no terminal',
   revealHtml.includes('AgentBillClient(api_key=...)') && revealHtml.includes('Authorization: Bearer')
     && !revealHtml.includes('Store it in an environment variable, not in your code'))
ok('[recover] a spent token cannot show it again',
   (await fetch(`${API}/recover/${revealToken}`, { method: 'POST', redirect: 'manual',
     headers: { 'Content-Type': 'application/x-www-form-urlencoded', origin: API },
     body: 'action=reveal' })).status !== 200)

// ---------------------------------------------------------------- 6: PUT /budget
console.log('\n[6] a customer ceiling can be set, raised and lowered')
// Until this endpoint existed the only way to choose a customer's ceiling was
// accounts.default_budget_units, read once at customer-creation time and
// hardcoded to 1000 at signup. A customer's budget was therefore fixed for
// life and the documented fix was a hand-written UPDATE.
//
// The assertion that matters is the lowering group: a ceiling may legally land
// BELOW what is already used and reserved. Nothing may be rewritten to fit it
// and no counter may go negative; the customer is simply refused until the
// reservations settle or expire.
await reset()

// This section runs on its own key. The suite fires ~100 authenticated requests
// through KEY inside the limiter's 60-second window, which is exactly the
// per-key cap in src/lib/rate-limiter.ts, and this is the last section, so it
// was the one that started answering 429 when [2c] added a dozen calls above.
// A fresh key is a fresh bucket; it is also what a customer would do. Mint it
// through the real endpoint rather than seeding it, so the harness cannot
// depend on a key the server never issued.
const KEY6 = (await post('/keys/generate', { label: 'harness-section-6' })).body.api_key
if (typeof KEY6 !== 'string' || !KEY6.startsWith('agb_')) throw new Error('[6] could not mint its key')

const put = (body) => fetch(`${API}/budget`, {
  method: 'PUT',
  headers: { 'Authorization': `Bearer ${KEY6}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json() }))

const getBudget = (ref) => fetch(`${API}/budget?customer_id=${encodeURIComponent(ref)}`, {
  headers: { 'Authorization': `Bearer ${KEY6}` },
}).then(async r => ({ status: r.status, body: await r.json() }))

// Set a ceiling on a customer that has never made a call.
const created = await put({ customer_id: 'cust_put', limit_units: 100 })
ok('PUT creates the customer and sets the ceiling',
   created.status === 200 && created.body.limit === 100 && created.body.customer_created === true,
   JSON.stringify(created.body))
ok('and GET agrees with it', (await getBudget('cust_put')).body.limit === 100)

// Raise it. The second PUT must update, not insert a second row.
const raised = await put({ customer_id: 'cust_put', limit_units: 300 })
ok('PUT raises an existing ceiling', raised.status === 200 && raised.body.limit === 300, JSON.stringify(raised.body))
ok('and reports it was not created this time', raised.body.customer_created === false)
const rowCount = Number((await sql`
  SELECT count(*) AS n FROM customers WHERE account_id=${ACCT} AND customer_ref='cust_put'`)[0].n)
ok('and there is still exactly one row', rowCount === 1, String(rowCount))

// A ceiling of 0 refuses everything; null clears it.
await put({ customer_id: 'cust_put', limit_units: 0 })
const atZero = await pre({ agent_id: 'r', customer_id: 'cust_put', estimated_units: 1 })
ok('a ceiling of 0 refuses everything',
   atZero.body.approved === false && atZero.body.reason === 'budget_exhausted', JSON.stringify(atZero.body))
const unlimited = await put({ customer_id: 'cust_put', limit_units: null })
ok('null clears the ceiling',
   unlimited.body.limit === null && unlimited.body.remaining === null, JSON.stringify(unlimited.body))
const afterNull = await pre({ agent_id: 'r', customer_id: 'cust_put', estimated_units: 999999 })
ok('and then nothing is refused on budget', afterNull.body.approved === true, JSON.stringify(afterNull.body))

// The real case: lower the ceiling under what is already committed.
await reset()
await put({ customer_id: 'cust_low', limit_units: 100 })
await pre({ agent_id: 'r', customer_id: 'cust_low', estimated_units: 40, idempotency_key: 'low-1' })
await rec({ customer_id: 'cust_low', event_type: 'llm', idempotency_key: 'low-rec-1', units: 40 })
await pre({ agent_id: 'r', customer_id: 'cust_low', estimated_units: 30, idempotency_key: 'low-2' })  // left open
const beforeLower = await cust('cust_low')
ok('setup: 40 used and 30 reserved',
   beforeLower.usedUnits === 40 && beforeLower.reservedUnits === 30, JSON.stringify(beforeLower))

const lowered = await put({ customer_id: 'cust_low', limit_units: 50 })
ok('the ceiling may be lowered under used + reserved',
   lowered.status === 200 && lowered.body.limit === 50, JSON.stringify(lowered.body))
ok('used and reserved are untouched by it',
   lowered.body.used === 40 && lowered.body.reserved === 30, JSON.stringify(lowered.body))
ok('remaining is floored at 0, never negative', lowered.body.remaining === 0, JSON.stringify(lowered.body))
ok('and it reports the customer as blocked', lowered.body.is_blocked === true, JSON.stringify(lowered.body))

const afterLower = await pre({ agent_id: 'r', customer_id: 'cust_low', estimated_units: 1 })
ok('the next call is refused rather than reserved',
   afterLower.body.approved === false && afterLower.body.reason === 'budget_exhausted', JSON.stringify(afterLower.body))
const lowRow = await cust('cust_low')
ok('and no counter went negative',
   lowRow.usedUnits === 40 && lowRow.reservedUnits === 30, JSON.stringify(lowRow))
ok('reserved still equals the open reservations', lowRow.reservedUnits === await openSum(lowRow.id))

// Raising it again must let the same customer through, with no repair step.
await put({ customer_id: 'cust_low', limit_units: 200 })
const afterRaise = await pre({ agent_id: 'r', customer_id: 'cust_low', estimated_units: 10 })
ok('raising the ceiling releases the customer immediately',
   afterRaise.body.approved === true, JSON.stringify(afterRaise.body))

// Validation, and the one that matters: an absent limit_units is not "no change".
const noField = await put({ customer_id: 'cust_put' })
ok('a body with no limit_units is 422, not a silent no-op', noField.status === 422, String(noField.status))
const negative = await put({ customer_id: 'cust_put', limit_units: -5 })
ok('a negative ceiling is 422', negative.status === 422, String(negative.status))
const badRef = await put({ customer_id: 'a\u0000b', limit_units: 10 })
ok('a NUL in customer_id is 422, never a 500', badRef.status === 422, String(badRef.status))
const overLongCustomerRef = await put({ customer_id: 'x'.repeat(129), limit_units: 10 })
ok('a customer_id past 128 characters is 422', overLongCustomerRef.status === 422, String(overLongCustomerRef.status))
const noAuth = await fetch(`${API}/budget`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ customer_id: 'x', limit_units: 1 }),
}).then(r => r.status)
ok('PUT /budget is not public', noAuth === 401, String(noAuth))

// The write must stay inside the calling account.
const otherPut = await put({ customer_id: 'cust_put', limit_units: 7 })
const otherRow = Number((await sql`
  SELECT count(*) AS n FROM customers WHERE customer_ref='cust_put' AND account_id <> ${ACCT}`)[0].n)
ok('the write stays inside the caller account', otherPut.status === 200 && otherRow === 0, String(otherRow))

// ---------------------------------------------------------------- 7: checkout hand-off
// /pricing's paid buttons point at /app/upgrade/:tier. The pricing page cannot
// see the console session (cookie is Path=/app), so this route does the
// deciding. What must hold: no session shows a login carrying the tier as a
// validated next; a forged next is dropped, never echoed; a real login with a
// next lands on the upgrade page; and with a session the page is a 200
// hand-off, not a redirect chain, because Chrome enforces form-action 'self'
// against every redirect after a form POST and would block the polar.sh hop.
console.log('\n[7] pricing hands a keyed account to checkout without re-registering')
const nav = (path, init = {}) => fetch(`${API}${path}`, { redirect: 'manual', ...init })
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin' }
let r7 = await nav('/app/upgrade/team')
let html7 = await r7.text()
ok('no session: the login page, not a redirect', r7.status === 200, String(r7.status))
ok('and it carries the tier as a validated next', html7.includes('name="next" value="/app/upgrade/team"'))
ok('and it says what the sign-in is for', html7.includes('Sign in to buy Team'))
r7 = await nav('/app/upgrade/nope')
ok('an unknown tier goes back to pricing', r7.status === 302 && (r7.headers.get('location') ?? '').endsWith('/pricing'), `${r7.status} ${r7.headers.get('location')}`)
r7 = await nav('/app/session', { method: 'POST', headers: FORM, body: 'api_key=agb_notarealkey_0000&next=https%3A%2F%2Fevil.example%2F' })
let loc7 = r7.headers.get('location') ?? ''
ok('a forged next is dropped on the error path, never echoed', r7.status === 303 && loc7 === '/app?err=key', loc7)
r7 = await nav('/app/session', { method: 'POST', headers: FORM, body: 'api_key=agb_notarealkey_0000&next=%2Fapp%2Fupgrade%2Fteam' })
loc7 = r7.headers.get('location') ?? ''
ok('a valid next survives a failed login', r7.status === 303 && loc7 === '/app?err=key&next=%2Fapp%2Fupgrade%2Fteam', loc7)
r7 = await nav('/app/session', { method: 'POST', headers: FORM, body: `api_key=${KEY}&next=%2Fapp%2Fupgrade%2Fteam` })
loc7 = r7.headers.get('location') ?? ''
ok('a real login with next lands on the upgrade page, not /app', r7.status === 303 && loc7 === '/app/upgrade/team', loc7)
const cookie7 = (r7.headers.get('set-cookie') ?? '').split(';')[0]
ok('and it set the session cookie', cookie7.startsWith('agentbill_app='), cookie7.slice(0, 20))
r7 = await nav('/app/upgrade/team', { headers: { cookie: cookie7 } })
html7 = await r7.text()
ok('with a session the page is a 200 hand-off, not a redirect chain', r7.status === 200 && html7.includes('http-equiv="refresh"'), String(r7.status))
ok('and it hands off to checkout for this account', html7.includes(`/checkout/team?account_id=${ACCT}`))
ok('and /app itself still opens with that cookie', (await nav('/app', { headers: { cookie: cookie7 } })).status === 200)

// ---------------------------------------------------------------- 8: a job's ceiling from the console
console.log('\n[8] a job ceiling can be opened and changed from outside the code')
// Until 2026-09-10 the only way to choose a job's ceiling was task_ceiling on
// the first preflight of a new task_ref, and every later value was dropped
// without a word. The console's empty state told a reader to go pass two
// arguments in code. The rule now: the last successful save through
// PUT /tasks/:task_ref/ceiling (or the console form, same statement) is the
// ceiling in force; a task_ceiling on preflight cannot change one; a ceiling may
// not go under used + reserved; nothing in flight is rewritten; and every
// preflight answers with the ceiling that decided it.
await reset()
// Own key: the suite is near the per-key limiter's window by this point,
// same reason section 6 mints one.
const KEY8 = (await post('/keys/generate', { label: 'harness-section-8' })).body.api_key
if (typeof KEY8 !== 'string' || !KEY8.startsWith('agb_')) throw new Error('[8] could not mint its key')
const pre8 = (body) => fetch(`${API}/preflight`, {
  method: 'POST', headers: { 'Authorization': `Bearer ${KEY8}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }))
const rec8 = (body) => fetch(`${API}/events`, {
  method: 'POST', headers: { 'Authorization': `Bearer ${KEY8}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }))
const putCeil = (ref, body, key = KEY8) => fetch(`${API}/tasks/${encodeURIComponent(ref)}/ceiling`, {
  method: 'PUT', headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }))
const task8 = async (ref) => (await sql`
  SELECT agent_id, ceiling_units, used_units, reserved_units FROM task_budgets WHERE account_id=${ACCT} AND task_ref=${ref}`)[0]

// Open a job from outside the code, then preflight with only its name.
const openedJob = await putCeil('job-c', { ceiling_units: 50, agent_id: 'r' })
ok('PUT opens the job with its ceiling',
   openedJob.status === 200 && openedJob.body.ceiling_units === 50 && openedJob.body.task_created === true, JSON.stringify(openedJob.body))
const onlyRef = await pre8({ agent_id: 'r', task_ref: 'job-c', estimated_units: 5 })
ok('a preflight with only task_ref is approved against the console ceiling',
   onlyRef.body.approved === true, JSON.stringify(onlyRef.body))
ok('and the answer carries the ceiling in force', onlyRef.body.task_ceiling === 50, JSON.stringify(onlyRef.body))
ok('and remaining is ceiling minus this reservation', onlyRef.body.task_remaining_units === 45, JSON.stringify(onlyRef.body))

// A task_ceiling on preflight cannot raise it once the job exists, and the answer says which ceiling decided.
const codeRaiseTry = await pre8({ agent_id: 'r', task_ref: 'job-c', task_ceiling: 999, estimated_units: 5 })
ok('a task_ceiling from code on an existing job is approved on the stored ceiling, not the passed one',
   codeRaiseTry.body.approved === true && codeRaiseTry.body.task_ceiling === 50, JSON.stringify(codeRaiseTry.body))
ok('and the row still says 50', (await task8('job-c')).ceilingUnits === 50)
// A refusal carries it too, so the retry that "raised" it can see it did not.
const codeRefusedTry = await pre8({ agent_id: 'r', task_ref: 'job-c', task_ceiling: 999, estimated_units: 45 })
ok('the refusal names the ceiling that decided it',
   codeRefusedTry.body.approved === false && codeRefusedTry.body.reason === 'task_ceiling_exceeded' && codeRefusedTry.body.task_ceiling === 50,
   JSON.stringify(codeRefusedTry.body))

// The console can, and the next preflight sees it, with no repair step.
const raisedJob = await putCeil('job-c', { ceiling_units: 80, agent_id: 'someone-else' })
ok('PUT raises an existing ceiling', raisedJob.status === 200 && raisedJob.body.ceiling_units === 80 && raisedJob.body.task_created === false, JSON.stringify(raisedJob.body))
ok('and the agent that opened the job is kept even when the save names another', raisedJob.body.agent_id === 'r', raisedJob.body.agent_id)
const afterRaiseJob = await pre8({ agent_id: 'r', task_ref: 'job-c', estimated_units: 45 })
ok('the call refused at 50 is approved at 80', afterRaiseJob.body.approved === true && afterRaiseJob.body.task_ceiling === 80, JSON.stringify(afterRaiseJob.body))
const rows8 = Number((await sql`SELECT count(*) AS n FROM task_budgets WHERE account_id=${ACCT} AND task_ref='job-c'`)[0].n)
ok('still exactly one row', rows8 === 1, String(rows8))

// A job opened from code first: the console's later save is what stays in force.
await pre8({ agent_id: 'r', task_ref: 'job-code', task_ceiling: 30, estimated_units: 1 })
await putCeil('job-code', { ceiling_units: 60 })
const codeThenConsoleJob = await pre8({ agent_id: 'r', task_ref: 'job-code', task_ceiling: 30, estimated_units: 1 })
ok('after a console save, the first-preflight number is no longer the ceiling',
   codeThenConsoleJob.body.task_ceiling === 60, JSON.stringify(codeThenConsoleJob.body))

// The lowering rule. 20 spent, 30 reserved and open: 50 is committed.
await reset()
await putCeil('job-low', { ceiling_units: 100, agent_id: 'r' })
await pre8({ agent_id: 'r', task_ref: 'job-low', estimated_units: 20, idempotency_key: 'jl-1' })
await rec8({ customer_id: 'default', event_type: 'llm', idempotency_key: 'jl-rec-1', units: 20, task_ref: 'job-low' })
await pre8({ agent_id: 'r', task_ref: 'job-low', estimated_units: 30, idempotency_key: 'jl-2' })   // left open
let lowJob = await task8('job-low')
ok('setup: 20 spent and 30 reserved', lowJob.usedUnits === 20 && lowJob.reservedUnits === 30, JSON.stringify(lowJob))

const underApi = await putCeil('job-low', { ceiling_units: 40 })
ok('a ceiling under used + reserved is refused, not clamped',
   underApi.status === 409 && underApi.body.error === 'ceiling_below_committed', JSON.stringify(underApi.body))
ok('and it names the smallest value that would be accepted', underApi.body.minimum_ceiling_units === 50, JSON.stringify(underApi.body))
lowJob = await task8('job-low')
ok('the row is untouched by the refused save', lowJob.ceilingUnits === 100 && lowJob.usedUnits === 20 && lowJob.reservedUnits === 30, JSON.stringify(lowJob))

const exactJob = await putCeil('job-low', { ceiling_units: 50 })
ok('exactly used + reserved is accepted', exactJob.status === 200 && exactJob.body.ceiling_units === 50 && exactJob.body.remaining_units === 0, JSON.stringify(exactJob.body))
lowJob = await task8('job-low')
ok('the reservation in flight is not rewritten by the lower ceiling', lowJob.reservedUnits === 30, JSON.stringify(lowJob))
const atWallJob = await pre8({ agent_id: 'r', task_ref: 'job-low', estimated_units: 1 })
ok('the next preflight is refused on the new ceiling',
   atWallJob.body.approved === false && atWallJob.body.reason === 'task_ceiling_exceeded' && atWallJob.body.task_ceiling === 50 && atWallJob.body.task_remaining_units === 0,
   JSON.stringify(atWallJob.body))
// The open reservation settles normally under the lowered ceiling.
const settled8 = await rec8({ customer_id: 'default', event_type: 'llm', idempotency_key: 'jl-rec-2', units: 30, task_ref: 'job-low' })
lowJob = await task8('job-low')
ok('settling the open reservation moves it to spent, nothing negative',
   settled8.status === 200 && lowJob.usedUnits === 50 && lowJob.reservedUnits === 0, JSON.stringify({ status: settled8.status, lowJob }))

// Validation and boundaries.
ok('a ceiling of 0 is 422', (await putCeil('job-low', { ceiling_units: 0 })).status === 422)
ok('a non-integer ceiling is 422', (await putCeil('job-low', { ceiling_units: 12.5 })).status === 422)
ok('a missing ceiling_units is 422, not a silent no-op', (await putCeil('job-low', {})).status === 422)
ok('a ceiling past int4 is 422', (await putCeil('job-low', { ceiling_units: 3_000_000_000 })).status === 422)
ok('a NUL in agent_id is 422', (await putCeil('job-low', { ceiling_units: 60, agent_id: 'a\u0000b' })).status === 422)
const noAuth8 = await fetch(`${API}/tasks/job-low/ceiling`, { method: 'PUT',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ceiling_units: 1 }) }).then(r => r.status)
ok('PUT /tasks/:task_ref/ceiling is not public', noAuth8 === 401, String(noAuth8))
ok('a job opened without agent_id is labelled console until someone spends',
   (await putCeil('job-plain', { ceiling_units: 5 })).body.agent_id === 'console')
await pre8({ agent_id: 'writer', task_ref: 'job-plain', estimated_units: 1 })
ok('the first agent to spend under it claims the label', (await task8('job-plain')).agentId === 'writer')
await pre8({ agent_id: 'editor', task_ref: 'job-plain', estimated_units: 1 })
ok('and a later agent does not take it over', (await task8('job-plain')).agentId === 'writer')

// The console form runs the same statement, session-gated and same-origin only.
const nav8 = (path, init = {}) => fetch(`${API}${path}`, { redirect: 'manual', ...init })

/**
 * Read a page until it says what the write path will eventually make it say,
 * or the deadline passes. Same contract as `reads()` above: `until` is an
 * EARLY EXIT, never an expectation this wait enforces. The gate always runs
 * on the last body actually read, so a page that never gets there is reported
 * as what it is, at the deadline, rather than spun into a pass.
 *
 * Why it exists: every approved:false is written to preflight_decisions
 * fire-and-forget, through the module-level sql and never through the
 * request's tx (preflight.ts). So the sixth call resolving proves nothing
 * about the row the start screen renders. On a warm database the row lands
 * before the next GET; on CI's cold one it did not, three times on 2026-09-15,
 * on commits that touched no server code.
 */
const PAGE_DEADLINE_MS = 20_000
const pageUntil = async (path, init, until) => {
  const started = Date.now()
  let body = await nav8(path, init).then(r => r.text())
  while (!until(body) && Date.now() - started < PAGE_DEADLINE_MS) {
    await settle(POLL_MS)
    body = await nav8(path, init).then(r => r.text())
  }
  return body
}
const FORM8 = { 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin' }
const login8 = await nav8('/app/session', { method: 'POST', headers: FORM8, body: `api_key=${KEY8}` })
const cookie8 = (login8.headers.get('set-cookie') ?? '').split(';')[0]
ok('[console] login for the form', cookie8.startsWith('agentbill_app='), cookie8.slice(0, 20))
const anon8 = await nav8('/app/tasks', { method: 'POST', headers: FORM8, body: 'task_ref=job-anon&ceiling_units=9' })
ok('[console] a POST with no session writes nothing and lands on the tasks view',
   anon8.status === 303 && anon8.headers.get('location') === '/app?view=tasks' && !(await task8('job-anon')), `${anon8.status} ${anon8.headers.get('location')}`)
const xsite8 = await nav8('/app/tasks', { method: 'POST', headers: { ...FORM8, 'Sec-Fetch-Site': 'cross-site', cookie: cookie8 }, body: 'task_ref=job-x&ceiling_units=9' })
ok('[console] a cross-site POST is 403 and writes nothing', xsite8.status === 403 && !(await task8('job-x')), String(xsite8.status))
const form8 = await nav8('/app/tasks', { method: 'POST', headers: { ...FORM8, cookie: cookie8 }, body: 'task_ref=job-form&ceiling_units=500&agent_id=researcher' })
ok('[console] the form opens a job and comes back saying so',
   form8.status === 303 && form8.headers.get('location') === '/app?view=tasks&saved=job-form&created=1', `${form8.status} ${form8.headers.get('location')}`)
const formRowJob = await task8('job-form')
ok('[console] with the ceiling and agent it was given', formRowJob?.ceilingUnits === 500 && formRowJob?.agentId === 'researcher', JSON.stringify(formRowJob))
const page8 = await nav8('/app?view=tasks&saved=job-form&created=1', { headers: { cookie: cookie8 } }).then(r => r.text())
ok('[console] the tasks view shows the job at 0 / 500 and the confirmation',
   page8.includes('job-form') && page8.includes('<b>0</b> / 500') && page8.includes('Ceiling set on <code>job-form</code>, a new job'), 'page did not carry the row or the confirmation')
ok('[console] and states the rule in one line', page8.includes('last save wins') && page8.includes('is not applied'))
const fromCode8 = await pre8({ agent_id: 'researcher', task_ref: 'job-form', estimated_units: 120 })
ok('[console] a preflight that names the job is approved on the form ceiling', fromCode8.body.approved === true && fromCode8.body.task_ceiling === 500, JSON.stringify(fromCode8.body))
const under8 = await nav8('/app/tasks', { method: 'POST', headers: { ...FORM8, cookie: cookie8 }, body: 'task_ref=job-form&ceiling_units=100' })
ok('[console] lowering under the reservation in flight comes back as an error with the minimum',
   under8.status === 303 && under8.headers.get('location') === '/app?view=tasks&err=below&ref=job-form&min=120', `${under8.status} ${under8.headers.get('location')}`)
ok('[console] and the row was not changed', (await task8('job-form')).ceilingUnits === 500)
const bad8 = await nav8('/app/tasks', { method: 'POST', headers: { ...FORM8, cookie: cookie8 }, body: 'task_ref=job-form&ceiling_units=1e3' })
ok('[console] a ceiling that is not digits is rejected before any write', bad8.status === 303 && bad8.headers.get('location') === '/app?view=tasks&err=ceiling&ref=job-form', `${bad8.headers.get('location')}`)
const badRef8 = await nav8('/app/tasks', { method: 'POST', headers: { ...FORM8, cookie: cookie8 }, body: 'task_ref=%00&ceiling_units=5' })
ok('[console] a NUL task_ref is rejected, never a 500', badRef8.status === 303 && badRef8.headers.get('location') === '/app?view=tasks&err=ref', `${badRef8.status} ${badRef8.headers.get('location')}`)
const errPage8 = await nav8('/app?view=tasks&err=below&ref=job-form&min=120', { headers: { cookie: cookie8 } }).then(r => r.text())
ok('[console] the error page says what would be accepted', errPage8.includes('<b>120</b> units committed'))
const demoRes8 = await nav8('/app?view=tasks&demo=1', { headers: { cookie: cookie8 } })
const demo8 = await demoRes8.text()
ok('[console] sample data renders (200, labelled) and never shows the form',
   demoRes8.status === 200 && demo8.includes('Sample data') && !demo8.includes('action="/app/tasks"'), String(demoRes8.status))

// The 404 names the second way to open a job.
const never8 = await fetch(`${API}/tasks/never-opened`, { headers: { 'Authorization': `Bearer ${KEY8}` } }).then(async r => ({ status: r.status, body: await r.json() }))
ok('an unknown task names PUT /tasks/:task_ref/ceiling as a way in', never8.status === 404 && /PUT \/tasks\/:task_ref\/ceiling/.test(never8.body.message), JSON.stringify(never8.body))

// Idempotent replay after the console lowered the ceiling: the stored decision, no second reservation.
const replay8 = await pre8({ agent_id: 'r', task_ref: 'job-low', estimated_units: 30, idempotency_key: 'jl-2' })
ok('a replayed preflight answers its decision-time ceiling and reserves nothing more',
   replay8.body.approved === true && replay8.body.task_ceiling === 100 && (await task8('job-low')).reservedUnits === 0, JSON.stringify(replay8.body))

// Isolation: another account cannot touch this account's job through the same task_ref.
const OTHER8 = '00000000-0000-0000-0000-0000000000cc'
await sql`INSERT INTO accounts (id, plan, default_budget_units, monthly_calls, billing_period_start)
          VALUES (${OTHER8}, 'free', NULL, 0, date_trunc('month', CURRENT_DATE)::date) ON CONFLICT (id) DO NOTHING`
const OTHERKEY8 = 'agb_testkey_other_account_00000002'
await sql`INSERT INTO developer_api_keys (account_id, api_key, label) VALUES (${OTHER8}, ${OTHERKEY8}, 'other') ON CONFLICT DO NOTHING`
await putCeil('job-iso', { ceiling_units: 80, agent_id: 'r' })   // job-c was cleared by reset() above
const foreign8 = await putCeil('job-iso', { ceiling_units: 7 }, OTHERKEY8)
ok('another account writing the same task_ref gets its own row', foreign8.status === 200 && foreign8.body.task_created === true, JSON.stringify(foreign8.body))
ok('and this account\'s ceiling did not move', (await task8('job-iso')).ceilingUnits === 80)
ok('exactly one row for that ref outside this account', Number((await sql`SELECT count(*) AS n FROM task_budgets WHERE task_ref='job-iso' AND account_id <> ${ACCT}`)[0].n) === 1)
await sql`DELETE FROM accounts WHERE id = ${OTHER8}`

// The atomicity claim: a save racing ten reserves never leaves used + reserved above the ceiling.
await putCeil('job-race', { ceiling_units: 100, agent_id: 'r' })
const race8 = await Promise.all([
  putCeil('job-race', { ceiling_units: 50 }),
  ...Array.from({ length: 10 }, (_, i) => pre8({ agent_id: 'r', task_ref: 'job-race', estimated_units: 10, idempotency_key: `race-${i}` })),
])
const raceRow8 = await task8('job-race')
const raceOpen8 = Number((await sql`SELECT COALESCE(SUM(units),0) AS s FROM reservations WHERE account_id=${ACCT} AND task_ref='job-race' AND released_at IS NULL`)[0].s)
ok('under a save racing ten reserves, used + reserved never exceeds the ceiling',
   raceRow8.usedUnits + raceRow8.reservedUnits <= raceRow8.ceilingUnits, JSON.stringify(raceRow8))
ok('and reserved equals the open reservation rows', raceRow8.reservedUnits === raceOpen8, `${raceRow8.reservedUnits} vs ${raceOpen8}`)
ok('and the save either landed at 50 with room, or was refused with the committed number',
   (race8[0].status === 200 && raceRow8.ceilingUnits === 50) || (race8[0].status === 409 && race8[0].body.minimum_ceiling_units === raceRow8.usedUnits + raceRow8.reservedUnits && raceRow8.ceilingUnits === 100),
   JSON.stringify(race8[0].body))

// A lowered ceiling at the wall, then the TTL sweeper: reserved returns to 0, nothing negative, the room reopens.
await putCeil('job-ttl', { ceiling_units: 100, agent_id: 'r' })
await pre8({ agent_id: 'r', task_ref: 'job-ttl', estimated_units: 30, idempotency_key: 'ttl-1' })
const wall8 = await putCeil('job-ttl', { ceiling_units: 30 })
ok('a ceiling exactly at the open reservation is accepted', wall8.status === 200 && wall8.body.remaining_units === 0, JSON.stringify(wall8.body))
await sql`UPDATE reservations SET expires_at = now() - interval '1 minute' WHERE account_id=${ACCT} AND task_ref='job-ttl' AND released_at IS NULL`
await sweepExpiredReservations()
const ttlRow8 = await task8('job-ttl')
ok('the sweeper releases it without going negative', ttlRow8.reservedUnits === 0 && ttlRow8.usedUnits === 0, JSON.stringify(ttlRow8))
const afterTtl8 = await pre8({ agent_id: 'r', task_ref: 'job-ttl', estimated_units: 30 })
ok('and the room is back under the lowered ceiling', afterTtl8.body.approved === true && afterTtl8.body.task_ceiling === 30, JSON.stringify(afterTtl8.body))
// A settle for more than was reserved after the wall lands as a leak, never a negative remaining.
const over8 = await rec8({ customer_id: 'default', event_type: 'llm', idempotency_key: 'ttl-rec-over', units: 40, task_ref: 'job-ttl' })
const leak8 = await fetch(`${API}/tasks/job-ttl`, { headers: { 'Authorization': `Bearer ${KEY8}` } }).then(r => r.json())
ok('spend past the wall is kept as a leak with remaining 0, not a negative number',
   over8.status === 200 && leak8.used_units === 40 && leak8.exceeded === true && leak8.remaining_units === 0, JSON.stringify(leak8))

// Console form edges: a 129-char ref, a bad agent, a ref that needs encoding, agent on an existing job, and the empty states.
const long8 = await nav8('/app/tasks', { method: 'POST', headers: { ...FORM8, cookie: cookie8 }, body: `task_ref=${'r'.repeat(129)}&ceiling_units=5` })
ok('[console] a 129-character job name is refused without being echoed', long8.status === 303 && long8.headers.get('location') === '/app?view=tasks&err=ref', `${long8.headers.get('location')}`)
const badAgent8 = await nav8('/app/tasks', { method: 'POST', headers: { ...FORM8, cookie: cookie8 }, body: 'task_ref=job-form&ceiling_units=600&agent_id=a%00b' })
ok('[console] a control character in the agent label is err=agent', badAgent8.status === 303 && badAgent8.headers.get('location') === '/app?view=tasks&err=agent&ref=job-form', `${badAgent8.headers.get('location')}`)
const enc8 = await nav8('/app/tasks', { method: 'POST', headers: { ...FORM8, cookie: cookie8 }, body: `task_ref=${encodeURIComponent('job 1&x')}&ceiling_units=5` })
ok('[console] a job name with a space and an ampersand round-trips encoded', enc8.status === 303 && enc8.headers.get('location') === '/app?view=tasks&saved=job%201%26x&created=1', `${enc8.headers.get('location')}`)
const encPage8 = await nav8('/app?view=tasks&saved=job%201%26x&created=1', { headers: { cookie: cookie8 } }).then(r => r.text())
ok('[console] and is shown escaped', encPage8.includes('Ceiling set on <code>job 1&amp;x</code>'))
const keep8 = await nav8('/app/tasks', { method: 'POST', headers: { ...FORM8, cookie: cookie8 }, body: 'task_ref=job-form&ceiling_units=600&agent_id=other' })
ok('[console] a save on an existing job reports the agent label was not applied', keep8.status === 303 && keep8.headers.get('location') === '/app?view=tasks&saved=job-form&agent=kept', `${keep8.headers.get('location')}`)
ok('[console] and the row keeps its agent', (await task8('job-form')).agentId === 'researcher')
const keptPage8 = await nav8('/app?view=tasks&saved=job-form&agent=kept', { headers: { cookie: cookie8 } }).then(r => r.text())
ok('[console] the page says the label was not changed', keptPage8.includes('The agent label was not changed'))
// A link can name any job; the status line only echoes a job that exists on this account.
const spoof8 = await nav8('/app?view=tasks&saved=not-a-job-here&created=1', { headers: { cookie: cookie8 } }).then(r => r.text())
ok('[console] a saved= for a job this account does not have is not echoed', !spoof8.includes('not-a-job-here') && spoof8.includes('Ceiling saved.'))
// The 120 reserved above may have aged past its TTL and been swept by the
// time this runs, so the expected number is read from the row, which is the
// point: the page must print the row's number, never the URL's.
const committed8 = (await task8('job-form')).usedUnits + (await task8('job-form')).reservedUnits
const spoofMin8 = await nav8('/app?view=tasks&err=below&ref=job-form&min=7', { headers: { cookie: cookie8 } }).then(r => r.text())
ok('[console] the committed number comes from the row, not the URL',
   spoofMin8.includes(`<b>${committed8.toLocaleString('en-US')}</b> units committed`) && !spoofMin8.includes('<b>7</b> units committed'), `row says ${committed8}`)
const spoofRef8 = await nav8('/app?view=tasks&err=below&ref=nope-nope&min=7', { headers: { cookie: cookie8 } }).then(r => r.text())
ok('[console] err=below for an unknown job falls back to the generic line', !spoofRef8.includes('nope-nope') && spoofRef8.includes('under what the job has already committed'))
// Empty states, on a clean account.
await reset()
const emptyTasks8 = await nav8('/app?view=tasks', { headers: { cookie: cookie8 } }).then(r => r.text())
ok('[console] the tasks view empty state points at the form above it', emptyTasks8.includes('No jobs yet. One job is one budget. Name a job above'))
const emptyOverview8 = await nav8('/app', { headers: { cookie: cookie8 } }).then(r => r.text())
ok('[console] the overview empty state links to the tasks view instead', emptyOverview8.includes('No jobs yet') && emptyOverview8.includes('view=tasks">Name a job'))

// ------------------------------------------------- 8b: the onboarding path
//
// Ticket 2026-09-10: an account has to reach a first understandable preflight
// on a job the holder created, without anyone helping and without reading a
// blog. Nothing here existed before, and the first run it replaces was a raw
// curl asking for 5 units against a per-request ceiling of 1: a refusal
// manufactured on a job the reader never opened.
//
// reset() above leaves preflight_decisions behind, so the account it calls
// clean is not virgin and overviewView never rendered its first run at all.
// That is why this gate could not see the screen it is about until now.
await sql`DELETE FROM preflight_decisions WHERE account_id = ${ACCT}`
const virgin8 = await nav8('/app', { headers: { cookie: cookie8 } }).then(r => r.text())
ok('[onboarding] the first run is three numbered steps and a form, not a curl that manufactures a refusal',
   virgin8.includes('class="setf3"') && virgin8.includes('Three steps to your first refusal')
     && !virgin8.includes('"ceiling":1'), 'the virgin overview did not render the steps')
// Ticket 2026-09-11, after dogfood run 3 ended on /register#done with "I do
// not understand what I need to do". The install is INSIDE the numbered
// sequence, after the step that needs no terminal, and before the sample it
// makes runnable. The cold-path ticket the same evening made the refusal the
// third step, so name and units share the first; the order is unchanged and
// is asserted on the rendered page, not the source.
const iName8 = virgin8.indexOf('Name this job')
const iUnits8 = virgin8.indexOf('How many units is this job worth')
const iPip8 = virgin8.indexOf('pip install agentbill-sdk')
const iAsk8 = virgin8.indexOf('Ask before each call')
const iSample8 = virgin8.search(/<pre class="snip">/)
ok('[onboarding] the install opens step 2: after the job name and the units, before the ask and the sample',
   iName8 > -1 && iUnits8 > iName8 && iPip8 > iUnits8 && iAsk8 > iPip8 && iSample8 > iAsk8,
   `name ${iName8}, units ${iUnits8}, pip ${iPip8}, ask ${iAsk8}, sample ${iSample8}`)
ok('[onboarding] the sequence is numbered 1 to 3 on one screen, the count UX v1 locked, and nothing on it is a bullet',
   ['1', '2', '3'].every((n) => virgin8.includes(`<span class="ns3-n">${n}</span>`))
     && !virgin8.includes('<span class="ns3-n">4</span>') && !virgin8.includes('ns3-n">&middot;'))
// Locked path, item 4: "one job = one budget" is read first, the wire name second.
const iBudget8 = virgin8.indexOf('One job is one budget')
const iRef8 = virgin8.indexOf('task_ref')
ok('[onboarding] "one job is one budget" is read before the name task_ref',
   iBudget8 > -1 && iRef8 > -1 && iBudget8 < iRef8, `budget at ${iBudget8}, task_ref at ${iRef8}`)
ok('[onboarding] and the page says whose decision the refusal is',
   virgin8.includes('Your code decides what the job does next'))
// The same rule, on the surface it was never asserted on. #33 fixed the order
// on /register#done and the homepage fold kept the old one: "Preflight says no
// when this job is out of units" opened the only explanation above the fold
// with our endpoint's name, to a reader who does not have one yet. Nothing in
// this harness looked at / at all, which is why it survived the pass that
// found it three screens away. The check compares INDEXES and not presence,
// because presence was already true of the copy it replaces.
const fold8 = await fetch(`${API}/`).then(r => r.text())
const iWork8 = fold8.indexOf('asks whether this job has units left')
const iPre8 = fold8.search(/\bpreflight\b/i)
ok('[fold] the concept is read before the name preflight',
   iWork8 > -1 && iPre8 > -1 && iWork8 < iPre8, `concept at ${iWork8}, preflight at ${iPre8}`)
// The sample is task_ref-only on purpose: the ceiling is set before the code
// runs, and a task_ceiling sent after the job exists is not applied.
// Before a save the sample is a literal <pre>, the one copy CI executes; the
// hygiene gate holds it byte-identical to taskSnippet(). It is not escaped, so
// the quote here is a real quote, not &quot;.
const snipAt8 = virgin8.search(/<pre class="snip">/)
const snip8 = snipAt8 === -1 ? '' : virgin8.slice(snipAt8, virgin8.indexOf('</pre>', snipAt8))
ok('[onboarding] the sample preflights with task_ref and carries no task_ceiling',
   snip8.includes('task_ref="job-1"') && !snip8.includes('task_ceiling'), snip8.slice(0, 120))
// One paste is one run is one refusal: the sample loops one call past the
// ceiling it was written for, and the ceiling is what ends the loop. Before
// 2026-09-12 it made one call and asked the reader to run it N+1 times.
ok('[onboarding] the sample loops one call past the ceiling, so one run is one refusal',
   snip8.includes('for _ in range(4)') && snip8.includes('ceiling of 3'), snip8.slice(0, 200))
// The start screen is its own view, off the rail, and where /register#done
// signs a new key in. Its form posts back to itself; the tasks view's editor
// posts nothing and lands where it always has.
const startView8 = await nav8('/app?view=start', { headers: { cookie: cookie8 } }).then(r => r.text())
ok('[start] ?view=start is the same three steps, off the rail, and its form posts back to itself',
   startView8.includes('Three steps to your first refusal') && startView8.includes('name="back" value="start"')
     && !startView8.includes('<span>Start</span>'), 'the start view did not render the steps')
const saveStart8 = await nav8('/app/tasks', { method: 'POST', headers: { ...FORM8, cookie: cookie8 }, body: 'task_ref=job-mine&ceiling_units=5&back=start' })
ok('[start] a save from the start screen lands back on the start screen',
   saveStart8.status === 303 && saveStart8.headers.get('location') === '/app?view=start&saved=job-mine&created=1', `${saveStart8.headers.get('location')}`)
// After a save the sample is the reader's own job, read off the row, with
// the row's ceiling in the loop bound.
const mine8 = await nav8('/app?view=start&saved=job-mine&created=1', { headers: { cookie: cookie8 } }).then(r => r.text())
ok('[onboarding] a saved job puts its own name and ceiling in the lines the reader pastes',
   mine8.includes('task_ref=&quot;job-mine&quot;') && mine8.includes('range(6)') && mine8.includes('ceiling of 5'), 'no personalised sample')
ok('[start] before any call, step 3 says nothing is here yet and how to get there',
   mine8.includes('Nothing here yet') && mine8.includes('reload this page'), 'step 3 resting state missing')
const saveElse8 = await nav8('/app/tasks', { method: 'POST', headers: { ...FORM8, cookie: cookie8 }, body: 'task_ref=job-mine&ceiling_units=5&back=%2Fevil' })
ok('[start] back is an allowlist of two, not an echo',
   saveElse8.headers.get('location') === '/app?view=tasks&saved=job-mine', `${saveElse8.headers.get('location')}`)
// The refusal the screen exists to show. Five reservations of one unit fill a
// ceiling of five; the sixth is refused, and step 3 then carries the row and
// the persisted body, while the overview stops being the start screen.
for (let i = 0; i < 5; i++) await pre({ agent_id: 'researcher', task_ref: 'job-mine', estimated_units: 1 })
const sixth8 = await pre({ agent_id: 'researcher', task_ref: 'job-mine', estimated_units: 1 })
ok('[start] the sixth call on a ceiling of 5 is refused', sixth8.body.approved === false && sixth8.body.reason === 'task_ceiling_exceeded', JSON.stringify(sixth8.body))
const afterRefuse8 = await pageUntil('/app?view=start', { headers: { cookie: cookie8 } }, b => b.includes('Refused. Asked 1 unit'))
ok('[start] step 3 shows the refusal with the body the code received',
   afterRefuse8.includes('Refused. Asked 1 unit') && afterRefuse8.includes('&quot;reason&quot;: &quot;task_ceiling_exceeded&quot;')
     && afterRefuse8.includes('Open the console'), 'step 3 did not show the refusal')
const overviewAfter8 = await pageUntil('/app', { headers: { cookie: cookie8 } }, b => b.includes('class="kpis"'))
ok('[start] after the first refusal the overview is the dashboard, and the start screen stays reachable',
   overviewAfter8.includes('class="kpis"') && !overviewAfter8.includes('Three steps to your first refusal')
     && afterRefuse8.includes('class="setf3"'), 'the overview did not become the dashboard')
// A name that cannot sit inside a Python string falls back rather than
// rendering a block that does not parse. esc() is HTML escaping: &quot;
// renders in the browser as the character that closes the string.
await nav8('/app/tasks', { method: 'POST', headers: { ...FORM8, cookie: cookie8 }, body: `task_ref=${encodeURIComponent('say "hi"')}&ceiling_units=5` })
const quoted8 = await nav8('/app?view=start', { headers: { cookie: cookie8 } }).then(r => r.text())
ok('[onboarding] a job name carrying a quote does not go inside the sample',
   quoted8.includes('cannot hold inline') && !quoted8.includes('task_ref=&quot;say &quot;hi&quot;'), 'the quote reached the sample')
// A failed save must never come back proposing a name. verifyFlash strips
// f.ref whenever no row carries that name, which is exactly a failed save on a
// NEW job, and the first version of this screen then fell through to whatever
// other job the account had. Fixing the ceiling and pressing Save rewrote THAT
// job's budget, and nothing on screen said the name had changed.
await nav8('/app/tasks', { method: 'POST', headers: { ...FORM8, cookie: cookie8 }, body: 'task_ref=job-existing&ceiling_units=5' })
const retarget8 = await nav8('/app/tasks', { method: 'POST', headers: { ...FORM8, cookie: cookie8 }, body: 'task_ref=job-brand-new&ceiling_units=1e3' })
ok('[onboarding] a bad ceiling on a new job name is refused before any write',
   retarget8.headers.get('location') === '/app?view=tasks&err=ceiling&ref=job-brand-new', `${retarget8.headers.get('location')}`)
const after8 = await nav8('/app?view=tasks&err=ceiling&ref=job-brand-new', { headers: { cookie: cookie8 } }).then(r => r.text())
const field8 = (after8.match(/<input id="t-ref"[^>]*value="([^"]*)"/) ?? [])[1]
ok('[onboarding] and the name field does not come back holding a different job',
   field8 === '', `the field offered "${field8}" for a save the reader did not make`)
const afterStart8 = await nav8('/app?view=start&err=ceiling&ref=job-brand-new', { headers: { cookie: cookie8 } }).then(r => r.text())
const fieldStart8 = (afterStart8.match(/<input id="t-ref"[^>]*value="([^"]*)"/) ?? [])[1]
const ceilStart8 = (afterStart8.match(/<input id="t-ceil"[^>]*value="([^"]*)"/) ?? [])[1]
ok('[start] the same rule on the start screen: neither field comes back holding a different job',
   fieldStart8 === '' && ceilStart8 === '', `name "${fieldStart8}", ceiling "${ceilStart8}"`)
// The microcopy bans, measured on the VISIBLE text and not the markup: every
// one of these words appears inside the CSS of every page on the site
// (display:block, flex-wrap), so a grep over HTML can only ever be noise.
const visible8 = (h) => h.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<script[\s\S]*?<\/script>/g, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ')
const register8 = await fetch(`${API}/register`).then(r => r.text())
const login8b = await fetch(`${API}/app`).then(r => r.text())
// The fold, 2026-09-12. One demo beside the headline, one action, and the
// caption that says what the ceiling is and is not without a word about
// anyone else. The brochure rows (keys, the console overview) are gone from
// the cold path.
const hero8 = fold8.slice(fold8.indexOf('<header class="hero'), fold8.indexOf('</header>'))
// Rewritten 2026-09-16 for the paper identity (`c70b8bd`), and the rewrite is
// five gates where there were two, on purpose.
//
// What changed in the hero: the static dual-state demo became a looping film
// (`figure.plate`), and the caption string `job ceiling &middot; not a month
// window &middot; not a proxy` was dissolved into the copy: "not on the month"
// is in the h1 and "not a proxy" is in the sub. That was a decision, not a
// regression (`M-memory/decisions.md`, 2026-09-16, chosen by Lior from three
// rendered identities), so these gates follow the guarantee rather than the
// markup that used to carry it.
//
// What the old demo card showed, BOTH states side by side, a month window with
// room next to this job refused, did not leave the fold: it moved out of the
// hero and into Fig. 1, the section directly under it, drawn as four meters
// under one ceiling line. The plate carries the refusal, the h1 states the
// contrast, and the figure demonstrates it. The Fig. 1 gate below is the one
// that holds that.
ok('[fold] the film sits after the headline and carries the burn-down to a refusal',
   fold8.includes('class="plate"') && fold8.indexOf('class="plate"') > fold8.indexOf('A ceiling on this job')
     && fold8.includes('492 of 500 units') && /refused/.test(visible8(hero8)),
   'no plate in the fold, or it does not reach a refusal')
// `preload="none"` means the film may never be fetched, and autoplay is refused
// outright under Low Power Mode and by reduced-motion settings. So the argument
// cannot live in the video alone: the poster and the two captions have to carry
// it for a reader who sees no moving picture at all. That is what this asserts.
ok('[fold] the argument survives a film that never plays',
   fold8.includes('poster="/hero-poster.jpg"') && /aria-label="[^"]+"/.test(fold8)
     && fold8.includes('job-142 burns down') && fold8.includes('researcher asks 12'),
   'the film is the only thing saying what happens')
// 2026-09-22: the sub under the h1 is a locked sentence (the pause-Broad,
// hygiene, one-targeted-relaunch ticket). "not a proxy" left the sub with it
// and lives in the request-path row's eyebrow, so this gate follows the
// guarantee rather than the old markup: the h1 still carries the contrast, the
// page still says no proxy, and the sub is the sentence below, byte for byte
// once its tags and line breaks are folded. The em dash the ticket's own text
// carried is a period here: voice-dna bans the character on every surface and
// hygiene greps for the literal, so the entity form is asserted on the hero
// too, since &mdash; renders the same dash and no grep in this repo sees it.
const LOCKED_SUB8 = 'AgentBill is a per-task spending ceiling for autonomous AI agents. Before the next model call, preflight returns approved: false when this task_ref is out of units. Your code decides whether to stop, skip, or replan.'
const subHtml8 = (hero8.match(/<p class="sub">([\s\S]*?)<\/p>/) ?? [])[1] ?? ''
const subText8 = subHtml8.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
ok('[fold] the copy still says what the ceiling is and is not',
   fold8.includes('not on the month') && fold8.includes('No proxy') && subText8.startsWith('AgentBill is a per-task spending ceiling'),
   `sub reads: ${subText8.slice(0, 80)}`)
ok('[fold] the sub under the h1 is the locked sentence, byte for byte, and the hero carries no em dash',
   subText8 === LOCKED_SUB8 && !hero8.includes('&mdash;') && !hero8.includes('\u2014'),
   subText8 === LOCKED_SUB8 ? 'an em dash (literal or &mdash;) is in the hero' : `sub reads: ${subText8}`)
// The locked sentence says "whether to stop, skip, or replan", and that "stop"
// is the reader's verb: the sentence exists to say whose decision the refusal
// is. Everything else in the family stays banned on the hero, by name here and
// by the [onboarding] loop below, which reads the hero with this one phrase cut
// out exactly. Mutation that proved both: "stops runaway" planted in the sub,
// this gate and the loop's hero line red, everything else green.
ok('[fold] the hero never says we stop the run: no stops, stopped, runaway, or "<we|it|preflight> stop"',
   !/\bstops\b|\bstopped\b|\bstopping\b|\brunaway\b|\b(we|it|agentbill|preflight|the sdk)\s+stops?\b/i.test(visible8(hero8)),
   (visible8(hero8).match(/\bstops\b|\bstopped\b|\bstopping\b|\brunaway\b|\b(we|it|agentbill|preflight|the sdk)\s+stops?\b/gi) ?? []).join(', '))
// The served markup wraps the sentence across source lines, so the cut has to
// tolerate a line break inside it: the first version matched single spaces,
// cut nothing, and the loop went red on the locked sentence itself.
const heroBan8 = hero8.replace(/whether to stop,\s+skip,\s+or replan/g, ' ')
// Fig. 1: the dual state, DRAWN. Three meters under the cap (a clock, an
// org-month, a USD window), this task_ref refused, one ceiling line across all
// four. The numbers are read off the plate's foot line rather than typed here:
// home.ts draws the plate foot, the figure's lit row and the figure's ceiling
// label from one heroRefusalBody(), so the three must agree, and a gate that
// typed 492 would go red on a change that changed nothing.
const plateFoot8 = fold8.match(/(\d[\d,]*) of (\d[\d,]*) units &middot; [a-z_-]+ asks (\d[\d,]*) &middot; refused/)
const [, used8, ceil8] = plateFoot8 ?? ['', '', '']
const figStart8 = fold8.indexOf('<figure class="fig"')
const fig8 = figStart8 < 0 ? '' : fold8.slice(figStart8, fold8.indexOf('</figure>', figStart8))
ok('[fold] Fig. 1 draws both states under one ceiling line: a month meter with room, this task_ref refused',
   plateFoot8 !== null && fig8.includes('Fig. 1') && fig8.includes(`ceiling &middot; ${ceil8}`)
     && /class="mrow">\s*<span class="m-l">Org &middot; month<\/span>[\s\S]*?<span class="m-s">under the cap<\/span>/.test(fig8)
     && /class="mrow lit">\s*<span class="m-l">task_ref [^<]*<\/span>[\s\S]*?<span class="m-s">refused<\/span>/.test(fig8)
     && fig8.includes(`${used8} / ${ceil8}`),
   fig8 ? `the figure does not show a month meter under the cap beside this job refused at ${used8} / ${ceil8}` : 'no Fig. 1 under the hero')
// The claims guard, now standing on its own. It was the second half of the
// caption gate and had NOTHING to do with the caption: it bans the words that
// carry a claim about somebody else, from the one surface most likely to grow
// one. It was still passing when the caption clause it was joined to went dead,
// which is the danger: anyone deleting a stale gate would have taken this with
// it and nothing would have gone red. Retired claims are listed in
// C-core/voice-dna.md; the audit that produced them is in M-memory/decisions.md,
// 2026-09-03.
//
// Extended here to the hero's aria-labels. `visible8` strips tags, so attribute
// text never reached this regex, and an aria-label is read aloud to a screen
// reader: it is a claim surface the guard could not see.
const heroClaims8 = visible8(hero8) + ' ' + (hero8.match(/aria-label="([^"]*)"/g) ?? []).join(' ')
ok('[fold] the hero claims nothing about anyone else',
   !/\b(only|first|nobody)\b/i.test(heroClaims8),
   (heroClaims8.match(/\b(only|first|nobody)\b/gi) ?? []).join(', '))
ok('[fold] one primary action in the hero, and the brochure rows are gone',
   (hero8.match(/class="btn btn-lg"/g) ?? []).length === 1 && !hero8.includes('btn-ghost')
     && !fold8.includes('Keys you can revoke') && !fold8.includes('What the ceiling saved you from'))
// 2026-09-18, the depth question. The demo sits about two screens down on a
// desktop and three on a phone, and none of the first 40 paid visits reached
// it. Lior chose the measured alternative to a reorder: one text link in the
// hero to #playground, counted as try_click, so the data decides whether the
// demo moves. A link and not a second button; the gate above keeps the button
// count at one, this one keeps the link at one, on the whole page and not only
// in the hero (the wiring is document-wide and the tile is read as "the hero's
// link", so a second one anywhere would pool into the number), and the anchor
// on the page. The tag is selected first and its class tested after, so the
// attribute order cannot hide a button: the first version tested
// class-then-href in one regex and review showed <a href="#playground"
// class="btn"> passing both gates. Breaks that proved it, each restored
// byte-identical: the link removed (0 on the page); href-first class="btn"
// (this gate alone red); class-first class="btn btn-lg" (this gate and the
// one above both red); a second #playground link in the closing section
// (2 on the page, 1 in the hero, red).
const tryRe8 = /<a\b[^>]*\bhref="#playground"[^>]*>/g
const tryPage8 = fold8.match(tryRe8) ?? []
const tryHero8 = hero8.match(tryRe8) ?? []
ok('[fold] the hero carries one text link to the demo, a link and not a second button, and the anchor exists',
   tryPage8.length === 1 && tryHero8.length === 1
     && !/\bclass="[^"]*\bbtn\b/.test(tryPage8[0])
     && fold8.includes('id="playground"'),
   `${tryPage8.length} on the page, ${tryHero8.length} in the hero; ${tryPage8[0] ?? 'no tag'}`)
// /register, 2026-09-12: setup language above one form, nothing under it
// that pitches, and a key screen whose one action signs the key into the
// start screen rather than sending the reader to a login card.
ok('[register] the lede is setup language and nothing under the form pitches',
   register8.includes('Key once.') && register8.includes('Your code decides.') && !register8.includes('One decorator')
     && !register8.includes('class="facts"') && !register8.includes('the entire integration surface'))
ok('[register] the key screen signs the key into the start screen, same origin, this tab',
   register8.includes('action="/app/session"') && register8.includes('name="next" value="/app?view=start"') && register8.includes('id="key-field"'))
const toStart8 = await nav8('/app/session', { method: 'POST', headers: FORM8, body: `api_key=${KEY8}&next=%2Fapp%3Fview%3Dstart` })
ok('[register] /app/session honours next=/app?view=start', toStart8.status === 303 && toStart8.headers.get('location') === '/app?view=start', `${toStart8.headers.get('location')}`)
const toElse8 = await nav8('/app/session', { method: 'POST', headers: FORM8, body: `api_key=${KEY8}&next=%2Fapp%3Fview%3Dkeys` })
ok('[register] and drops any other view', toElse8.status === 303 && toElse8.headers.get('location') === '/app', `${toElse8.headers.get('location')}`)
// [profile] 2026-09-19. The three optional fields left the signup form,
// where they pushed the only button off a 1440x900 and a 1536x864 screen, and
// are asked on the key screen, saved by fetch to /app/profile on the session
// the 201 sets. Four things this holds: the form asks for one thing; the key
// screen asks for the rest; the endpoint writes only what was given, to the
// signed-in account, from this origin only; and a blank is not a value.
const formHtmlP = register8.slice(register8.indexOf('id="form-state"'), register8.indexOf('id="success-state"'))
const doneHtmlP = register8.slice(register8.indexOf('id="success-state"'))
const formFieldsP = (formHtmlP.match(/<(input|select)\b/g) ?? []).length
ok('[profile] the signup form asks for the email and nothing else',
   formFieldsP === 1 && formHtmlP.includes('type="email"'), `${formFieldsP} fields in the form`)
ok('[profile] the key screen carries the three optional fields and saves them by fetch to /app/profile',
   doneHtmlP.includes('id="profile-form"') && doneHtmlP.includes('id="name"') && doneHtmlP.includes('id="use_case"')
     && doneHtmlP.includes('id="stack"') && register8.includes("fetch('/app/profile'"))
const JSONP = { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }
const anonP = await nav8('/app/profile', { method: 'POST', headers: JSONP, body: JSON.stringify({ name: 'Nobody' }) })
ok('[profile] no session: 401, nothing written', anonP.status === 401, `${anonP.status}`)
const crossP = await nav8('/app/profile', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site', cookie: cookie8 }, body: JSON.stringify({ name: 'Nobody' }) })
ok('[profile] a cross-site POST on a valid session: 403', crossP.status === 403, `${crossP.status}`)
const savedP = await nav8('/app/profile', { method: 'POST', headers: { ...JSONP, cookie: cookie8 }, body: JSON.stringify({ name: 'Harness Eight', use_case: 'research', stack: '' }) })
const savedBodyP = await savedP.json()
ok('[profile] a signed-in save answers 200 with exactly what it wrote, and "" is not a choice',
   savedP.status === 200 && JSON.stringify(savedBodyP.saved) === JSON.stringify({ name: 'Harness Eight', use_case: 'research' }), JSON.stringify(savedBodyP))
const [rowP] = await sql`SELECT name, use_case, stack FROM accounts WHERE id = ${process.env.ACCOUNT_ID}`
ok('[profile] and the row says so', rowP.name === 'Harness Eight' && rowP.useCase === 'research', JSON.stringify(rowP))
const onlyP = await nav8('/app/profile', { method: 'POST', headers: { ...JSONP, cookie: cookie8 }, body: JSON.stringify({ stack: 'python' }) })
const [rowPb] = await sql`SELECT name, use_case, stack FROM accounts WHERE id = ${process.env.ACCOUNT_ID}`
ok('[profile] a later save of one field leaves the others as they were',
   onlyP.status === 200 && rowPb.name === 'Harness Eight' && rowPb.useCase === 'research' && rowPb.stack === 'python', JSON.stringify(rowPb))
const badP = await nav8('/app/profile', { method: 'POST', headers: { ...JSONP, cookie: cookie8 }, body: JSON.stringify({ use_case: 'crypto' }) })
ok('[profile] a value outside the option list: 422, not a write', badP.status === 422, `${badP.status}`)
const blankP = await nav8('/app/profile', { method: 'POST', headers: { ...JSONP, cookie: cookie8 }, body: JSON.stringify({ name: '   ', stack: '' }) })
ok('[profile] blanks alone: 422, nothing to save', blankP.status === 422, `${blankP.status}`)
// The key screen does one job. Until 2026-09-11 it also carried the install
// command as an unnumbered bullet above the console's numbered steps, so the
// first instruction a new key holder read was to open a terminal, and the one
// link that needs no terminal was last on the page. The sequence now has one
// owner. What stays here is what only this page can do: print the key, and
// print it into the export line, because a placeholder gap in that line is how
// a key became agb_agb_ and a 401 (2026-09-09).
ok('[onboarding] /register teaches no sequence: no install command, no numbered steps, no sample',
   !register8.includes('pip install agentbill-sdk') && !register8.includes('Three steps')
     && !register8.includes('Keep these two') && !register8.includes('class="ns-pre"')
     && !register8.includes('Name this job'))
ok('[onboarding] /register keeps the key, the export line it fills, and one action',
   register8.includes('id="key-display"') && register8.includes('id="key-export"')
     && register8.includes('Open the console'))
// P0 of 2026-09-12, from Alex's re-verify on 9fa5718. Two failures, one cause:
// nothing on the register path touched the console session. A browser that
// had signed into another account earlier showed THAT account when the new
// key holder clicked the header's Console link, and the key screen's button
// opened a new tab, which a tester following one tab read as a button that
// does nothing. Now a 201 from POST /register carries the same Set-Cookie
// /app/session mints, name and path identical so it overwrites whatever sat
// there, and the button moves this tab.
const goForm8 = (register8.match(/<form[^>]*id="go-form"[^>]*>/) ?? [''])[0]
ok('[register] the key screen\'s form moves this tab: it has no target',
   goForm8.includes('action="/app/session"') && !/\btarget=/.test(goForm8), goForm8)
ok('[register] docs and the questions page are an aside under the button, not a second action',
   !/<a[^>]*class="btn-go"/.test(register8) && !register8.includes('Docs</a>, or')
     && register8.indexOf('class="btn-go"') < register8.indexOf('class="aside"')
     && register8.slice(register8.indexOf('class="aside"')).includes('href="/docs"'))
const email8 = `harness-register-${Date.now()}@example.invalid`
const reg8 = await fetch(`${API}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: email8 }) })
const regBody8 = await reg8.json()
const regCookie8 = reg8.headers.get('set-cookie') ?? ''
ok('[register] a 201 carries the console session for the key it minted, on the login cookie\'s name and path',
   reg8.status === 201 && typeof regBody8.api_key === 'string' && regCookie8.startsWith('agentbill_app=')
     && /;\s*Path=\/app(;|$)/.test(regCookie8) && /HttpOnly/.test(regCookie8), `${reg8.status} ${regCookie8.slice(0, 40)}`)
const attrs8 = (c) => c.split(';').slice(1).map((s) => s.trim()).sort().join('|')
ok('[register] register and login mint the cookie from one recipe, or the second could not overwrite the first',
   attrs8(regCookie8) === attrs8(login8.headers.get('set-cookie') ?? ''), `${regCookie8} vs ${login8.headers.get('set-cookie')}`)
const asNew8 = await nav8('/app?view=start', { headers: { cookie: regCookie8.split(';')[0] } }).then(r => r.text())
ok('[register] and that cookie opens the start screen as the account just created, not another',
   asNew8.includes('Three steps to your first refusal') && asNew8.includes(email8) && !asNew8.includes('>no email<'),
   'the new session did not render the new account')
// The owner's signup alert, 2026-09-12. There is no Resend key in the harness,
// so what is checked here is the DECISION, not a delivery: the daily cap is a
// rank read from the accounts table (src/lib/signup-alert.ts), and the whole
// guard rests on every signup owning a different integer. That is the property
// an alert on a public endpoint needs, and the reason it is a rank rather than
// "how many accounts exist in the last 24 hours": two signups arriving together
// can both read the same count, and a rolling window can fall back under the
// cap and be crossed twice. Proven on real Postgres with two real registers,
// because the previous alert that mailed one owner 13,835 times in two days
// also passed every test it had.
const rankOf8 = async (email) => (await sql`
  SELECT (SELECT count(*)::int FROM accounts
           WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
             AND created_at < (SELECT created_at FROM accounts WHERE email = ${email})) AS rank
`)[0].rank
const email8b = `harness-register-${Date.now()}b@example.invalid`
const reg8b = await fetch(`${API}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: email8b }) })
ok('[signup-alert] a second signup still gets its key: telling the owner cannot hold up a register',
   reg8b.status === 201 && typeof (await reg8b.clone().json()).api_key === 'string', `${reg8b.status}`)
const [rank8, rank8b] = [await rankOf8(email8), await rankOf8(email8b)]
ok('[signup-alert] two signups on one day own two different ranks, and the later one is higher',
   Number.isInteger(rank8) && rank8b === rank8 + 1, `${rank8} then ${rank8b}`)
// The cap is an inequality over that rank, so the boundary is a pure function
// of it: one signup a day is the first over the line and sends the one notice.
const DAILY_CAP8 = 25
const decide8 = (rank) => rank < DAILY_CAP8 ? 'signup' : rank === DAILY_CAP8 ? 'one notice' : 'silent'
ok('[signup-alert] the cap sends 25 signups, then exactly one notice, then nothing',
   [...Array(30).keys()].map(decide8).join(',') ===
     `${Array(25).fill('signup').join(',')},one notice,${Array(4).fill('silent').join(',')}`)

// The welcome ceiling, 2026-09-12, and the reason it is a rank and not a count.
//
// The count version was measured failing in BOTH directions in this exact
// geometry (the row committed by one transaction, counted by a later
// statement), and the dominant failure was UNDER-sending: a real signup reads a
// number inflated by rows that committed after its own and loses its welcome
// mail with room to spare. That is worse than overshoot, so the gate below
// asserts the property that rules it out rather than the cap's arithmetic: the
// rank of a row cannot be raised by a row that came later.
//
// Crossed for real against Postgres rather than evaluated as a pure function.
// The previous gate above is a pure function over 30 integers, which is
// presence, not effect.
const PER_DAY8 = 50
const PER_HOUR8 = 20
// The exact query src/lib/mail.ts runs, so a change to one that is not made to
// the other shows up here rather than in production.
const ranks8 = async (email) => (await sql`
  WITH me AS (SELECT created_at FROM accounts WHERE email = ${email})
  SELECT (SELECT count(*)::int FROM accounts, me
           WHERE accounts.created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
             AND accounts.created_at < me.created_at) AS day,
         (SELECT count(*)::int FROM accounts, me
           WHERE accounts.created_at >= date_trunc('hour', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
             AND accounts.created_at < me.created_at) AS hour
  FROM me
`)[0]
const seeded8 = []
for (let i = 0; i < 3; i++) {
  const e = `harness-ceiling-${Date.now()}-${i}@example.invalid`
  await sql`INSERT INTO accounts (email, plan) VALUES (${e}, 'free')`
  seeded8.push({ email: e, ...(await ranks8(e)) })
}
ok('[mail] each welcome send owns one rank per window, and a later row never raises an earlier one',
   seeded8.every((r, i) => i === 0 || (r.day === seeded8[i - 1].day + 1 && r.hour === seeded8[i - 1].hour + 1))
     && (await ranks8(seeded8[0].email)).day === seeded8[0].day,
   JSON.stringify(seeded8.map((r) => [r.day, r.hour])))
// Both terms, and the announcement, are pure functions of those two ranks.
const gated8 = (r) => r !== null && (r.day >= PER_DAY8 || r.hour >= PER_HOUR8)
ok('[mail] the ceiling holds at each window value and nowhere earlier',
   !gated8({ day: PER_DAY8 - 1, hour: PER_HOUR8 - 1 })
     && gated8({ day: PER_DAY8, hour: 0 })
     && gated8({ day: 0, hour: PER_HOUR8 })
     && !gated8(null))
// The hourly term is the one that makes a day's allowance unspendable in a
// burst: without it, all 50 can go out inside ninety seconds, which is the
// shape that took Gmail delivery from 66% to 17% in September.
ok('[mail] a burst inside one hour is refused long before the daily term would notice',
   gated8({ day: PER_HOUR8, hour: PER_HOUR8 }) && PER_HOUR8 < PER_DAY8)
const announces8 = (r) => r.day === PER_DAY8 || (r.day < PER_DAY8 && r.hour === PER_HOUR8)
ok('[mail] exactly one row in each window announces, so the notice does not depend on which machine served it',
   [...Array(PER_DAY8 + 2).keys()].filter((d) => announces8({ day: d, hour: 0 })).length === 1
     && [...Array(PER_HOUR8 + 2).keys()].filter((h) => announces8({ day: 0, hour: h })).length === 1)
for (const r of seeded8) await sql`DELETE FROM accounts WHERE email = ${r.email}`
ok('[mail] the seeded rows are gone again',
   (await sql`SELECT count(*)::int AS n FROM accounts WHERE email LIKE 'harness-ceiling-%'`)[0].n === 0)

// A row written while verifying is not data.
for (const e of [email8, email8b]) {
  const [acct] = await sql`SELECT id FROM accounts WHERE email = ${e}`
  if (!acct) continue
  await sql`DELETE FROM developer_api_keys WHERE account_id = ${acct.id}`
  await sql`DELETE FROM accounts WHERE id = ${acct.id}`
}
ok('[register] the harness accounts are gone again',
   (await sql`SELECT count(*)::int AS n FROM accounts WHERE email IN (${email8}, ${email8b})`)[0].n === 0)

// Under the fold, 2026-09-12. The request-path row is the one row; it teaches
// the console/PUT order with the field the endpoint actually takes; nothing on
// the page offers task_ceiling on a first call as a peer of that path; the
// task-budgets and refusals panels are off the cold path; and the not-list is
// four lines that say nothing about anyone else.
ok('[home] the ceiling is taught console-first with ceiling_units, and task_ceiling is not a peer path',
   fold8.includes('PUT /tasks/:task_ref/ceiling') && visible8(fold8).includes('ceiling_units')
     && !/on\s+its first call/.test(fold8) && !/pass <span class="mono-in">task_ceiling/.test(fold8))
ok('[home] the task-budgets and refusals panels are off the cold path',
   !fold8.includes('what the agent got back') && !fold8.includes('one job, many calls, one ceiling') && !fold8.includes('class="ref-row"'))
const notsAt8 = fold8.indexOf('class="nots"')
const nots8 = notsAt8 === -1 ? '' : fold8.slice(notsAt8, fold8.indexOf('</ul>', notsAt8))
ok('[home] the not-list is four lines, none about stopping a run or about who has agreed to anything',
   (nots8.match(/<li>/g) ?? []).length === 4 && !fold8.includes('Stop your run') && !fold8.includes('Nobody has agreed')
     && !/\bnobody\b/i.test(visible8(fold8)) && !/\b(stop|kill|block|dies)[a-z]*\b/i.test(visible8(nots8)),
   `${(nots8.match(/<li>/g) ?? []).length} items`)
ok('[start] the footer names the endpoint with the field it takes, and does not teach task_ceiling from code',
   visible8(virgin8).includes('ceiling_units') && !/\btask_ceiling\b/.test(visible8(virgin8)))

// Attribute text counts as copy, 2026-09-16. `visible8` strips tags, so every
// gate built on it has been blind to aria-label, title, alt and placeholder,
// and all four are read to somebody: aria-label and alt out loud by a screen
// reader, title and placeholder on screen. The microcopy ban is a voice-dna
// hard rule, so `aria-label="We block the call"` was a sentence that could ship
// with every gate green.
//
// Found while splitting the hero's claims guard, which had the identical hole.
// Checked before closing it rather than assumed: 21 attributes across /, /app,
// /register, /pricing and /docs, all clean, so this is a latent hole and not a
// live defect. Closing it costs one line and the mutation below proves it bites.
const readable8 = (html) =>
  visible8(html) + ' ' + [...html.matchAll(/(?:aria-label|title|alt|placeholder)="([^"]*)"/gi)].map((m) => m[1]).join(' ')

// The blog post that argues the thesis, 2026-09-18. For four months it argued
// with a fictional agent and no sources, called the product a per-request
// ceiling, taught the pre-pivot samples (customer_id, BudgetExhaustedError,
// blocked: True) and used every banned word, while every gate stayed green,
// because no gate read /blog. Five gates. Each was run against the post it
// replaced before that post was replaced, and each went red there; the record
// is in the PR that added them. Scope is the post body, <h1> to the related
// guides: the site footer links to GitHub, npm and PyPI and those are not
// sources. Quotes and samples are cut out before the word ban runs, because a
// vendor or a reporter saying "stopped" is not us claiming we stop the run.
const blog8 = await fetch(`${API}/blog/monthly-caps-wont-save-you`).then((r) => r.text())
const postStart8 = blog8.indexOf('<h1>')
const postEnd8 = postStart8 < 0 ? -1 : blog8.indexOf('class="also"', postStart8)
const post8 = postStart8 < 0 || postEnd8 < 0 ? '' : blog8.slice(postStart8, postEnd8)
const blogLinks8 = [...post8.matchAll(/<a href="(https:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
  .map((m) => ({ href: m[1], text: visible8(m[2]).trim() }))
// Where a source may live: a provider's own docs, or the provider's own tracker.
// Shared by the blog gates and the band gates below, so the two surfaces cannot
// drift apart on what counts as a source. A link anywhere else is the guard
// against citing a competitor's launch post as if it were a bystander.
const SOURCE_HOSTS8 = [/^https:\/\/github\.com\/anthropics\//, /^https:\/\/community\.openai\.com\//,
                       /^https:\/\/developers\.openai\.com\//, /^https:\/\/platform\.claude\.com\//, /^https:\/\/ai\.google\.dev\//]
const offList8 = blogLinks8.filter((l) => !SOURCE_HOSTS8.some((re) => re.test(l.href)))
ok('[blog] the post cites at least six sources, every one at a provider or the provider\'s own tracker',
   blogLinks8.length >= 6 && offList8.length === 0,
   `${blogLinks8.length} links; off-list: ${offList8.map((l) => l.href).join(', ') || 'none'}`)
const blogProse8 = post8.replace(/<blockquote[\s\S]*?<\/blockquote>/g, ' ').replace(/<pre[\s\S]*?<\/pre>/g, ' ')
{
  const hits = readable8(blogProse8).match(/\b[a-z]*(stop|kill|block|dies)[a-z]*\b|\b(first|nobody|only)\b|per-request ceiling|\bcustomer/gi) ?? []
  ok('[blog] outside its quotes and samples the post never says stop, kill, block, dies, first, nobody, only, per-request ceiling or customer',
     hits.length === 0, hits.join(', '))
}
const blogPre8 = [...post8.matchAll(/<pre[\s\S]*?<\/pre>/g)].map((m) => m[0]).join('\n')
ok('[blog] the samples teach the task_ref order and none of the retired one',
   blogPre8.includes('task_ref="job-142"') && blogPre8.includes("taskRef: 'job-142'")
     && !/customer_id|customerId|BudgetExhaustedError|blocked|task_ceiling\s*=|taskCeiling\s*:/.test(blogPre8),
   (blogPre8.match(/customer_id|customerId|BudgetExhaustedError|blocked|task_ceiling\s*=|taskCeiling\s*:/g) ?? ['no task_ref sample']).join(', '))
const misnamed8 = blogLinks8.filter((l) => l.text !== l.href.replace(/^https:\/\//, ''))
ok('[blog] every external link says, in its own text, exactly where it goes',
   blogLinks8.length > 0 && misnamed8.length === 0,
   misnamed8.map((l) => `"${l.text}" -> ${l.href}`).join('; ') || 'no external links')
// The band under Fig. 1, 2026-09-18: the one place on / where a third party is
// quoted or characterised, and until now in no gate's slice. The sentence "with
// no way to detect or stop it from the CLI" sat here for twelve days under a
// paid campaign with main green, because the hero guard reads the <header>, the
// not-list guard reads the <ul>, and nothing read what lies between them. The
// two PRs that touched the band since then enforced the rule with a script in a
// session scratchpad, and a gate outside the repo dies with its session. Five
// assertions here, each proven red on the page that carried that sentence or on
// a synthetic mutation before it was committed; the record is in the PR.
const bandAt8 = fold8.indexOf('<section class="band">')
const band8 = bandAt8 < 0 ? '' : fold8.slice(bandAt8, fold8.indexOf('</section>', bandAt8))
// A gate on an empty slice passes for free, so the slice is asserted first.
ok('[band] the evidence band is on the page and has a slice of its own',
   band8.length > 0 && band8.includes('class="evid"'), 'no <section class="band"> with an .evid inside')
// Inline quotes, &ldquo;...&rdquo;, come out before the word ban: a vendor or a
// reporter saying "stopped" inside a quote is not us claiming we stop the run.
// "no way to" is on the list by name because it is the sentence that lived.
const bandProse8 = band8.replace(/&ldquo;[\s\S]*?&rdquo;/g, ' ')
{
  const hits = readable8(bandProse8).match(/\b[a-z]*(stop|kill|block|dies)[a-z]*\b|\b(first|nobody|only)\b|\bno way to\b/gi) ?? []
  ok('[band] outside its quotes the band never says stop, kill, block, dies, first, nobody, only or "no way to"',
     band8.length > 0 && hits.length === 0, hits.join(', ') || 'empty band')
}
const evids8 = [...band8.matchAll(/<div class="evid">([\s\S]*?)<\/div>/g)].map((m) => m[1])
const evidLinks8 = evids8.map((e) => [...e.matchAll(/<a href="(https:\/\/[^"]+)"([^>]*)>([\s\S]*?)<\/a>/g)]
  .map((m) => ({ href: m[1], attrs: m[2], text: visible8(m[3]).trim() })))
const linkOk8 = (ls) => ls.length === 1 && SOURCE_HOSTS8.some((re) => re.test(ls[0].href))
  && ls[0].text === ls[0].href.replace(/^https:\/\//, '') && /rel="nofollow noopener"/.test(ls[0].attrs)
ok('[band] every evidence line carries exactly one link, at a source host, whose text says where it goes',
   evids8.length > 0 && evidLinks8.every(linkOk8),
   evidLinks8.map((ls, i) => linkOk8(ls) ? '' : `evid ${i + 1}: ${ls.length} link(s)${ls[0] ? ` "${ls[0].text}" -> ${ls[0].href}` : ''}`).filter(Boolean).join('; ') || 'no evidence lines')
// A sentence about somebody else in our own voice, with no figure and no
// quotation marks, is exactly the shape that fell: neither arithmetic nor a quote.
const evidenceShaped8 = (e) => /\$\d/.test(e) || /&ldquo;[\s\S]*?&rdquo;/.test(e)
ok('[band] every evidence line is arithmetic or a quote: a $ figure, or a sentence in quotation marks',
   evids8.length > 0 && evids8.every(evidenceShaped8),
   `${evids8.filter((e) => !evidenceShaped8(e)).length} line(s) with neither`)
for (const [name, html] of [['the console first run', virgin8], ['the console after a save', mine8],
                            ['the console after the first refusal', afterRefuse8], ['the homepage fold, outside the locked sentence', heroBan8],
                            ['the blog post on monthly caps, outside its quotes and samples', blogProse8],
                            ['the homepage evidence band, outside its quotes', bandProse8],
                            ['/register', register8], ['the console login card', login8b]]) {
  const hits = readable8(html).match(/\b[a-z]*(stop|kill|block|dies)[a-z]*\b/gi) ?? []
  ok(`[onboarding] ${name} never says the run is stopped, killed, blocked or dies`, hits.length === 0, hits.join(', '))
}

// ---------------------------------------------------------------- pulse: the events between a landing and an account
// 2026-09-18, the first day the site had paid traffic. Meta counted 40 landing
// page views, accounts gained 0 rows, and site_pulse, our own table, had no
// event for anything a visitor does between arriving and registering, so a
// page nobody engaged and a form everybody abandoned read as the same zero.
// Two events closed that gap in PR #62: cta_click on any homepage link to
// /register, and register_view when /register loads. A third, try_click on the
// hero's link to the demo, followed the same day.
//
// The CSP gate is here for two reasons, neither of them a past hash drift: no
// hash drift has shipped, because src/lib/csp.ts inlineScript() derives the tag
// and its hash from one string. The 2026-09-06 incident that did ship (commit
// 184d110) had a MATCHING hash and a script that failed to parse, and the gate
// for that is hygiene's node --check, not this one. This one exists because
// (1) this change rewrote both hashed scripts, and (2) src/lib/pixel.ts hashes
// its own tag with a regex, outside that one-string guarantee, which is why
// run.sh now sets a synthetic META_PIXEL_ID: without it the harness served
// three scripts on / where production serves four, and the pixel path was
// never under any gate.
//
// Each gate below was run against a deliberate break before it was trusted,
// in an isolated worktree, restored byte-identical afterwards. What each read:
//   drop 'cta_click' from the enum ............ "land as rows" read register_view alone;
//                                               "list still closed" read 1 row
//   replace the click listener's call ......... the homepage wiring gate went red
//   remove pulse('register_view') ............. the /register gate went red
//   drop PLAYGROUND_HASH in home.ts ........... the / CSP gate read "1 of 4 unhashed"
//   drop ${PULSE_CLIENT_SRC} from register.ts . helper@-1 form@469 beacon@6184
//   move the beacon above the form wiring ..... helper@1368 form@1970 beacon@1902
//   one bucket for both event classes ......... flood gate read playground_run:38, no cta_click
//   pixel tag written as <script async> ....... both CSP gates red, "1 of 4" and "1 of 3",
//                                               the unhashed script beginning !function(f,b,e,v
//   drop 'try_click' from the enum (09-18, PR 2) "land as rows" read cta_click, register_view;
//                                               "list still closed" read 2 rows
//   remove pulse('page_view') (09-22) ......... "fires page_view once" read 0 call(s), and the
//                                               shots.mjs browser gate read 0 beacons on both loads
//   drop 'page_view' from the enum (09-22) .... tsc refused the build: the bucket expression
//                                               compares event to a name the enum no longer has
//   page_view routed to the funnel bucket ..... the load-flood gate read page_view:8, no click,
//                                               and two [source] writes after it were dropped too
//   page_views dropped from the by-source query the /admin page-loads gate read 0 in the first cell
// Every other gate in this file stayed green under every one of those breaks.
console.log('\n[pulse] the funnel events between a landing page view and an account row')
const home9 = await fetch(`${API}/`).then((r) => r.text())
const register9 = await fetch(`${API}/register`).then((r) => r.text())
// Inline scripts only: JSON-LD is data, and a src= tag is covered by origin.
const scripts9 = (html) => [...html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  .filter((m) => !/ld\+json|\bsrc=/.test(m[1] ?? '')).map((m) => m[2])
const csp9 = (html) => (html.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/) ?? [])[1] ?? ''
const sha9 = (js) => `'sha256-${createHash('sha256').update(js, 'utf8').digest('base64')}'`
for (const [name, html] of [['/', home9], ['/register', register9]]) {
  const all = scripts9(html)
  const missing = all.filter((js) => !csp9(html).includes(sha9(js)))
  ok(`[pulse] every inline script on ${name} is named by that page's CSP`, all.length > 0 && missing.length === 0,
     missing.length ? `${missing.length} of ${all.length} unhashed; first begins ${JSON.stringify(missing[0].slice(0, 60))}` : `${all.length} scripts`)
}
const homeJs9 = scripts9(home9).join('\n')
// The helper has to be IN the script that calls it, before the call. The call
// string alone was the first version of these two gates, and it stays present
// when the interpolated helper is dropped, which is the one break that matters.
ok('[pulse] the homepage script defines pulse() and wires every link to /register to a cta_click beacon',
   homeJs9.includes('a[href="/register"]') && homeJs9.includes("pulse('cta_click')")
     && homeJs9.indexOf('function pulse(') > -1
     && homeJs9.indexOf('function pulse(') < homeJs9.indexOf("pulse('cta_click')"))
// Break that proved it: the listener's call replaced by a setAttribute; this
// gate alone went red.
ok('[pulse] the homepage wires the demo link to a try_click beacon',
   homeJs9.includes('a[href="#playground"]') && homeJs9.includes("pulse('try_click')"))
const regJs9 = scripts9(register9).join('\n')
// On /register the order is load-bearing: helper, then the submit listener,
// then the beacon. Placed above the listener, a helper that failed to arrive
// would throw before the form was wired, and the form's native fallback is a
// GET with the address in the URL. Review caught that on 2026-09-18.
const regHelper9 = regJs9.indexOf('function pulse(')
const regForm9 = regJs9.indexOf("getElementById('reg-form').addEventListener")
const regBeacon9 = regJs9.indexOf("pulse('register_view')")
ok('[pulse] /register defines pulse(), wires the form, and only then fires register_view, once',
   (regJs9.match(/pulse\('register_view'\)/g) ?? []).length === 1
     && regHelper9 > -1 && regForm9 > -1 && regHelper9 < regForm9 && regForm9 < regBeacon9,
   `helper@${regHelper9} form@${regForm9} beacon@${regBeacon9}`)
// The write itself, end to end, plus the closed list. The handler awaits the
// insert before it answers, so the row is there when the 204 is.
const view9 = `verify9${Date.now()}`
const post9 = (body) => fetch(`${API}/pulse`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                body: JSON.stringify(body) }).then((r) => r.status)
const st9 = [await post9({ event: 'cta_click', view_id: view9 }),
             await post9({ event: 'register_view', view_id: view9 }),
             await post9({ event: 'try_click', view_id: view9 }),
             await post9({ event: 'page_view', view_id: view9 }),
             await post9({ event: 'cta_view', view_id: view9 })]
const rows9 = (await sql`SELECT event FROM site_pulse WHERE view_id = ${view9} ORDER BY event`).map((r) => r.event)
ok('[pulse] cta_click, page_view, register_view and try_click are on the allowlist and land as rows',
   JSON.stringify(rows9) === JSON.stringify(['cta_click', 'page_view', 'register_view', 'try_click']), rows9.join(', ') || 'no rows')
ok('[pulse] and the list is still closed: an unknown name is dropped and still answers 204',
   st9.every((c) => c === 204) && rows9.length === 4, `statuses ${st9.join('/')}, ${rows9.length} rows`)
// page_view, 2026-09-22: the funnel's first step in our own rows. Once per
// load, after the helper it calls and before the playground guard, so a page
// with no playground on it (or a guard that returns early) still counts the
// load. Breaks that proved it, each restored byte-identical: the call
// removed (0 on the page); the call moved below the guard (order red);
// 'page_view' dropped from the enum (the "land as rows" gate above read three
// names and the closed-list gate read 3 rows).
const pvCalls9 = (homeJs9.match(/pulse\('page_view'\)/g) ?? []).length
const pvAt9 = homeJs9.indexOf("pulse('page_view')")
const guardAt9 = homeJs9.indexOf("if (!el('run')) return")
ok('[pulse] the homepage fires page_view once per load, after the helper and before the playground guard',
   pvCalls9 === 1 && homeJs9.indexOf('function pulse(') < pvAt9 && guardAt9 > -1 && pvAt9 < guardAt9,
   `${pvCalls9} call(s); helper@${homeJs9.indexOf('function pulse(')} page_view@${pvAt9} guard@${guardAt9}`)
// And /admin reads the loads per surface and for the week. Two tagged loads
// are written and the row for that label has to show them in its first
// numeric cell as "30d / 7d", both 2, because they are minutes old and inside
// both windows; the tiles carry the week under each total. Placed BEFORE the
// load flood below on purpose: the flood fills this address's page bucket for
// the hour, and a tagged load written after it is dropped, which is how the
// first version of this gate read "0 / 0" on code that was right. The label
// is minted per run: on a database that survives between runs a fixed label
// accumulates, and this gate read "4 / 4" and "6 / 6" on code that was right
// before it was made unique. Break that proved it: the page_views column
// dropped from the by-source query, and the row's first cell read 0.
const pvSrc9 = `pv${Date.now().toString(36)}`
await post9({ event: 'page_view', view_id: `${view9}pv1`, source: pvSrc9 })
await post9({ event: 'page_view', view_id: `${view9}pv2`, source: pvSrc9 })
const adminPv9 = await fetch(`${API}/admin`, { headers: { Authorization: `Bearer ${process.env.ADMIN_SECRET}` } })
  .then((r) => r.text()).catch(() => '')
const srcRow9 = adminPv9.match(new RegExp(`<td><code>${pvSrc9}</code></td>\\s*<td[^>]*>(\\d+) <span class="muted">/ (\\d+)</span></td>`)) ?? []
ok('[pulse] /admin reports page loads for a tagged surface, 30 days and 7 days, and the tiles carry the week',
   srcRow9[1] === '2' && srcRow9[2] === '2' && adminPv9.includes('Homepage: page loads')
     && /Last 7 days: \d+/.test(adminPv9) && adminPv9.includes('Page loads (30d / 7d)'),
   srcRow9.length ? `row reads ${srcRow9[1]} / ${srcRow9[2]}` : (adminPv9 ? 'no page-loads cell for the tagged source' : 'admin not fetched (ADMIN_SECRET set?)'))
// Two buckets, not one. Forty playground writes from one network and then a
// click through: under the single bucket this change was first written with,
// the click was the forty-first write and vanished into a 204, so the visitor
// who played hardest read back as one who never clicked.
const flood9 = `flood9${Date.now()}`
for (let i = 0; i < 40; i++) await post9({ event: 'playground_run', view_id: flood9, ceiling: 500 })
const after9 = [await post9({ event: 'playground_run', view_id: flood9, ceiling: 500 }),
                await post9({ event: 'cta_click', view_id: flood9 })]
const floodRows9 = (await sql`SELECT event, count(*)::int AS n FROM site_pulse WHERE view_id = ${flood9} GROUP BY event ORDER BY event`)
  .map((r) => `${r.event}:${r.n}`)
ok('[pulse] forty playground writes from one network do not cost that visitor the click through',
   after9.every((c) => c === 204) && JSON.stringify(floodRows9) === JSON.stringify(['cta_click:1', 'playground_run:40']),
   `statuses ${after9.join('/')}, rows ${floodRows9.join(', ') || 'none'}`)
// And a third bucket for loads, 2026-09-22. An office behind one address is
// many people loading the page in an hour; if a load shared the funnel bucket,
// the thirtieth visitor's click through would be the sixteenth write and gone.
// Thirty-one loads are posted; the bucket holds thirty an hour and this
// address has already written three loads above (one on the allowlist gate,
// two tagged), so 27 land here and the rest are dropped, while a click and a
// /register load after them still land. The count is asserted as a range
// rather than a number so a gate added above this one does not move it, and
// the range is still a gate: routed to the funnel bucket, page_view read 8
// and neither the click nor the /register load after it landed; with no cap
// at all it would read 31.
// The two writes after the flood are funnel events, not a playground run: the
// forty-run flood above has already filled this address's playground bucket
// for the hour, and the first version of this gate asked for a run and read
// its absence as the page bucket's fault.
const pv9 = `pv9${Date.now()}`
for (let i = 0; i < 31; i++) await post9({ event: 'page_view', view_id: `${pv9}-${i}` })
const afterPv9 = [await post9({ event: 'cta_click', view_id: `${pv9}-c` }),
                  await post9({ event: 'register_view', view_id: `${pv9}-v` })]
const pvRows9 = Object.fromEntries((await sql`SELECT event, count(*)::int AS n FROM site_pulse WHERE view_id LIKE ${pv9 + '%'} GROUP BY event`)
  .map((r) => [r.event, r.n]))
ok('[pulse] page loads from one network fill their own bucket at thirty an hour, and the click and the /register load after them still land',
   afterPv9.every((c) => c === 204) && pvRows9.cta_click === 1 && pvRows9.register_view === 1
     && pvRows9.page_view >= 27 && pvRows9.page_view <= 30,
   `statuses ${afterPv9.join('/')}, rows ${JSON.stringify(pvRows9)}`)

// ---------------------------------------------------------------- source: which surface sent the visit
// 2026-09-20. Until migration 012 every row in site_pulse was anonymous as to
// origin and so was every row in accounts, so a registration arriving from a
// directory listing was indistinguishable from one arriving from the paid
// campaign. That was survivable with one channel running and stops being so
// with two, because the funnel tiles on /admin are the only read the ad spend
// buys. These gates check the column end to end AND the two places the value
// has to survive a handoff, which is where this kind of change actually fails.
console.log('\n[source] a tagged visit stays tagged from the landing page to the form')
const { readFileSync: readFileSync9 } = await import('node:fs')
const ROOT9 = new URL('../../', import.meta.url).pathname
const SRC9 = 'harnesssrc'
const homeTagged9 = await fetch(`${API}/?src=${SRC9}`).then((r) => r.text())

// 1. One rule, two runtimes. The page decides whether to send a label and the
// handler decides whether to store it, and they are different files in
// different languages. Drift here is silent and one-directional: the page
// sends what the server drops, and the surface reads "that directory sent
// nobody" rather than "the gate disagreed with itself".
const serverRe9 = (readFileSync9(`${ROOT9}/src/lib/source.ts`, 'utf8').match(/SOURCE_RE = (\/.*\/)\n/) ?? [])[1] ?? 'server?'
const clientRe9 = (readFileSync9(`${ROOT9}/src/ui/pulse-client.ts`, 'utf8').match(/return (\/.*\/)\.test\(v\)/) ?? [])[1] ?? 'client?'
ok('[source] the page and the handler apply the same pattern, character for character',
   serverRe9 === clientRe9 && serverRe9 !== 'server?', `server ${serverRe9} vs client ${clientRe9}`)

// 2. The page tags its own links to /register. Six of them on the homepage,
// from three shared components across six routes, which is why the rewrite is
// one loop where the beacon already lives rather than a parameter threaded
// through nav, the tier card and the footer.
//
// This gate reads the SERVED script, so it goes red if the loop is dropped.
// It does not prove the rewrite happens -- that needs a browser and is gated
// in shots.mjs, which clicks one of these links and reads the href back.
const taggedJs9 = scripts9(homeTagged9).join('\n')
const anchors9 = (homeTagged9.match(/<a [^>]*href="\/register"/g) ?? []).length
ok('[source] the homepage carries the /register links the rewrite is written against, and the loop that rewrites them',
   anchors9 === 6 && taggedJs9.includes("querySelectorAll('a[href=\"/register\"]')")
     && taggedJs9.includes("setAttribute('href', '/register?src='"),
   `${anchors9} anchors (expected 6)`)

// 3. And the click beacon still matches them AFTER the rewrite. An exact
// attribute selector matches nothing once the href gains a query string: the
// beacon would go silent on exactly the traffic the label was added to
// measure, while every string-presence check above stayed green. Break that
// proved it: the selector narrowed back to a[href="/register"] alone, and this
// gate was the only one that went red.
const ctaSel9 = (taggedJs9.match(/var CTA_LINKS = document\.querySelectorAll\('([^']*)'\)/) ?? [])[1] ?? ''
const acceptsTagged9 = ctaSel9.split(',').map((x) => x.trim())
  .some((sel) => sel.startsWith('a[href^="') && '/register?src=x'.startsWith(sel.slice(9, -2)))
const acceptsPlain9 = ctaSel9.includes('a[href="/register"]')
ok('[source] the cta_click selector accepts a /register link both before and after it is tagged',
   ctaSel9 !== '' && acceptsPlain9 && acceptsTagged9, `selector ${JSON.stringify(ctaSel9)}`)

// 4. The label reaches the payload. Read from the page's own URL and nothing
// else: not the referrer, not the user agent.
ok('[source] the beacon reads src from the page URL and puts it on the payload',
   taggedJs9.includes('[?&]src=') && taggedJs9.includes('payload.source = SRC'))

// 5. The write, end to end, and the rule that decides what is stored. The
// handler awaits the insert before answering, so the row is there when the
// 204 is.
const vTag9 = `src9${Date.now()}`
const postS9 = (body) => fetch(`${API}/pulse`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                 body: JSON.stringify(body) }).then((r) => r.status)
const sOk9 = await postS9({ event: 'cta_click', view_id: `${vTag9}a`, source: SRC9 })
const sUp9 = await postS9({ event: 'cta_click', view_id: `${vTag9}b`, source: 'HarnessSRC' })
const sBad9 = await postS9({ event: 'cta_click', view_id: `${vTag9}c`, source: 'no spaces!' })
const sLong9 = await postS9({ event: 'cta_click', view_id: `${vTag9}d`, source: 'x'.repeat(40) })
const sNone9 = await postS9({ event: 'cta_click', view_id: `${vTag9}e` })
const tagRows9 = (await sql`SELECT view_id, source FROM site_pulse WHERE view_id LIKE ${vTag9 + '%'} ORDER BY view_id`)
  .map((r) => `${r.viewId.slice(-1)}=${r.source ?? 'null'}`)
ok('[source] a well-formed label is stored and an uppercase one is folded to the same row value',
   [sOk9, sUp9].every((c) => c === 204) && tagRows9[0] === `a=${SRC9}` && tagRows9[1] === `b=${SRC9}`,
   `statuses ${sOk9}/${sUp9}, rows ${tagRows9.join(', ') || 'none'}`)

// 6. Why the schema says .catch(null) and not a refusal. A junk label must
// cost the row its source and never the row: otherwise anyone who shares a
// link with a mangled parameter is deleting our funnel for us.
ok('[source] a junk or over-long label costs the row its source, never the row itself',
   [sBad9, sLong9, sNone9].every((c) => c === 204) && tagRows9.length === 5
     && tagRows9.slice(2).every((r) => r.endsWith('=null')),
   `statuses ${sBad9}/${sLong9}/${sNone9}, rows ${tagRows9.join(', ') || 'none'}`)

// 7. /admin reports the slice, and says out loud that it does not sum to the
// tiles. The paragraph above those tiles read "no source column exists yet"
// until this commit: a claim about our own data, on our own surface, goes
// stale in the same commit that makes it false or it does not go at all.
const adminSrc9 = await fetch(`${API}/admin`, { headers: { Authorization: `Bearer ${process.env.ADMIN_SECRET}` } })
  .then((r) => r.text()).catch(() => '')
ok('[source] /admin shows the tagged slice and no longer claims the column does not exist',
   adminSrc9.includes('Tagged surfaces') && adminSrc9.includes(SRC9) && !adminSrc9.includes('no source column exists yet'),
   adminSrc9 ? `${adminSrc9.length} bytes` : 'admin not fetched (ADMIN_SECRET set?)')


// ---------------------------------------------------------------- legal: one date per page
// /privacy's visible "Last updated" and the dateModified in its JSON-LD (which
// is also the sitemap's lastmod) read the same registry row in src/ui/site.ts
// since 2026-09-18, after an hour in which a literal in legal.ts said
// September and the registry said August. The gate reads both off the served
// page and formats the ISO date the way legal.ts does. Break that proved it:
// a literal put back in /privacy's <p class="updated"> read
// shown "August 27, 2026", dateModified 2026-09-18, and only this gate went red.
console.log('\n[legal] the date a reader sees on a legal page is the date its structured data carries')
for (const path of ['/privacy', '/terms']) {
  const html = await fetch(`${API}${path}`).then((r) => r.text())
  const shown = (html.match(/Last updated: ([^<]+)</) ?? [])[1] ?? ''
  const iso = (html.match(/"dateModified":"(\d{4}-\d{2}-\d{2})"/) ?? [])[1] ?? ''
  const fromIso = iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : ''
  ok(`[legal] ${path} shows the date its JSON-LD dateModified carries`, shown !== '' && iso !== '' && shown === fromIso,
     `shown "${shown}", dateModified ${iso || 'absent'} -> "${fromIso}"`)
}

// ---------------------------------------------------------------- faq: what a quota refusal is, 2026-09-23
// The /faq answer to "What happens when I reach the free tier's N calls?" said
// the quota refusal "is the same shape of refusal as a task ceiling, so your
// code catches it the same way". It is not: both SDKs raise only when the
// developer's own spend rule refused the call, and RETURN approved false with
// upgrade_url on free_tier_exceeded and plan_limit_exceeded, on purpose. Code
// written to that sentence caught nothing and went on calling the provider,
// and the answer two questions above it on the same page said the opposite.
// No gate read /faq at all, which is how it survived. This reads the served
// answer (visible, and in the FAQPage JSON-LD, which the same array drives)
// AND the two SDK sources it describes, so the page and the SDKs cannot drift
// apart again without one of these going red. Breaks that proved them, each on
// a fresh database and restored: the old answer put back (the first three red,
// the SDK gate green); the Python SDK made to raise on free_tier_exceeded (the
// SDK gate alone red).
const faq10 = await fetch(`${API}/faq`).then((r) => r.text())
// Anchored on the question's own <h2> and the paragraph under it, not on the
// question text: the docs shell lists every question again in its contents,
// and the first version of this gate sliced that list and read no answer.
const freeHtml10 = (faq10.match(/<h2[^>]*>What happens when I reach the free tier[^<]*<\/h2>\s*<p>([\s\S]*?)<\/p>/) ?? [])[1] ?? ''
const freeA10 = visible8(freeHtml10).replace(/\s+/g, ' ').trim()
ok('[faq] the free-tier answer says the SDK returns approved: false with an upgrade_url instead of raising, and your code decides',
   freeA10.includes('approved: false') && freeA10.includes('free_tier_exceeded') && freeA10.includes('upgrade_url')
     && freeA10.includes('returns that answer instead of raising') && freeA10.includes('check result.approved')
     && freeA10.includes('your code decides') && !faq10.includes('catches it the same way'),
   freeA10.slice(0, 220) || 'the free-tier answer is not on /faq')
ok('[faq] the free-tier answer never says stop, kill, block, dies or first',
   freeA10.length > 0 && !/\b[a-z]*(stop|kill|block|dies)[a-z]*\b|\bfirst\b/i.test(freeA10),
   (freeA10.match(/\b[a-z]*(stop|kill|block|dies)[a-z]*\b|\bfirst\b/gi) ?? []).join(', '))
const faqLd10 = (() => {
  for (const m of faq10.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try { const j = JSON.parse(m[1]); if (j['@type'] === 'FAQPage') return j } catch {}
  }
  return null
})()
const ldFree10 = faqLd10?.mainEntity?.find((x) => /free tier/.test(x.name))?.acceptedAnswer?.text ?? ''
ok('[faq] the FAQPage JSON-LD carries the same corrected answer',
   ldFree10.includes('returns that answer instead of raising') && !ldFree10.includes('catches it the same way'),
   ldFree10.slice(0, 160) || 'no FAQPage answer for the free tier')
// The claim is about the SDKs, so the SDKs are read too. If either ever starts
// raising on a quota refusal, the page above becomes false again, and this is
// the line that says so before a reader does.
const py10 = readFileSync9(`${ROOT9}/sdk/python/agentbill/client.py`, 'utf8')
const node10 = readFileSync9(`${ROOT9}/sdk/node/src/index.ts`, 'utf8')
ok('[faq] and both SDKs still return, not raise, on free_tier_exceeded and plan_limit_exceeded',
   !/reason\s*==\s*["'](free_tier_exceeded|plan_limit_exceeded)["']/.test(py10)
     && !/reason\s*===\s*'(free_tier_exceeded|plan_limit_exceeded)'/.test(node10)
     && /if result\.reason == "task_ceiling_exceeded":\s*raise TaskCeilingExceededError/.test(py10)
     && node10.includes('free_tier_exceeded and plan_limit_exceeded deliberately do NOT throw'),
   'an SDK branches on a quota refusal, so the /faq answer may no longer be true')

// ---------------------------------------------------------------- integrations: the pages that name what we plug into, 2026-09-23
// /integrations and its pages, plus every guide under /docs/. No gate read the
// guides at all: /docs/task-budgets printed "blocked, the other worker took the
// last units" and "stopped at ...", and /docs/langchain-billing said "stop if
// ceiling is hit" in a comment, with main green. These are the pages that name a
// framework or a host next to our product, which is where "blocks the run" or
// "works with Claude Code" is one careless sentence away.
//
// The scope is read from the sitemap, so a new page under either path is in it
// the day it ships, and the first assertion proves the slice is not empty.
//
// What counts as OUR sentence, and why the word ban reads only that:
//   - prose: the page's <title> and meta description, the text of <main> with
//     code blocks and <blockquote>s cut out, inline code with a space in it
//     (a phrase like "kickoff() is blocked here" is a sentence, not a name),
//     the attribute text a screen reader or tooltip shows, and every comment
//     inside a code block;
//   - sentences inside samples: every string literal that is not a key, so
//     print("stopped") counts as much as print("blocked, the other worker took
//     the last units"). A key is a string between {, a comma or the start of
//     the line, and a colon.
// Left out, on purpose: identifiers and API field names a sample must spell the
// way the API does ("blocked": true on GET /decisions, "is_blocked" on /budget,
// OpenClaw's outcome: 'block'); a vendor's own words inside a <blockquote>; and
// the words of the SDK's or the plugin's own refusal sentence in an output line
// (class="out-*"), which is what a reader's terminal will print. That allowance
// is read from source, not typed: each sentence is rebuilt from the template
// client.py and ceiling.ts build it with, every placeholder one unspaced value,
// and only a line that is the whole sentence is let through. Even then the
// values it filled in are checked, because they are ours. "first" is banned
// wherever the word ban reads, except inside a file name (first-run.mjs), which
// is a name and not a claim.
console.log('\n[integrations] the pages that name what AgentBill plugs into say what it does, and nothing it does not')
const decode11 = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
const text11 = (h) => decode11(h.replace(/<[^>]+>/g, ' ')).replace(/&(?:[a-z]+|#\d+|#x[0-9a-f]+);/gi, ' ')
const WORDS11 = /\b(stop|stops|stopped|stopping|block|blocks|blocked|blocking|kill|kills|killed|killing|halt|halts|halted|halting)\b|\bcut(?:s|ting)? off\b/gi
const FIRST11 = /\bfirst\b(?![\w-]*\.(?:mjs|cjs|js|ts|py)\b)/gi
const NAMED11 = /\bn8n\b|\bclaude[\s_-]*code\b/gi
const DASH11 = /—|&mdash;|&#8212;|&#x2014;/gi
const py11 = readFileSync9(`${ROOT9}/sdk/python/agentbill/client.py`, 'utf8')
const claw11 = readFileSync9(`${ROOT9}/plugins/openclaw/src/ceiling.ts`, 'utf8')
// client.py joins three f-string pieces; ceiling.ts writes one template literal.
const HOLE11 = /\$\{[^{}]*\}|\{[^{}]*\}/g
const pyTpl11 = [...((py11.match(/f"Refused \(task_ceiling_exceeded\): [^"]*"(?:\s*f"[^"]*")*/) ?? [''])[0]).matchAll(/f"([^"]*)"/g)]
  .map((m) => m[1]).join('')
const clawTpl11 = (claw11.match(/`(AgentBill refused \(\$\{[^`]*)`/) ?? [])[1] ?? ''
const esc11 = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const SDK_OUT11 = [['client.py', pyTpl11], ['ceiling.ts', clawTpl11]].map(([file, tpl]) => ({
  file, holes: (tpl.match(HOLE11) ?? []).length, re: new RegExp(`^${tpl.split(HOLE11).map(esc11).join('(\\S+)')}$`),
}))
ok('[integrations] the refusal sentences the output-line allowance trusts are still built in client.py and ceiling.ts',
   SDK_OUT11.every((t) => t.holes >= 3), SDK_OUT11.filter((t) => t.holes < 3).map((t) => t.file).join(', '))
/** An output line that is one of those sentences whole reads as its values; any other line reads as itself. */
const sdkOut11 = (line) => {
  for (const t of SDK_OUT11) { const m = line.trim().match(t.re); if (m) return m.slice(1).join(' ') }
  return line
}
const isKey11 = (l, m) => /^\s*:/.test(l.slice(m.index + m[0].length)) && /(?:^|[{,])\s*$/.test(l.slice(0, m.index))

const map11 = await fetch(`${API}/sitemap.xml`).then((r) => r.text())
const scope11 = [...map11.matchAll(/<loc>https:\/\/agentbill\.dev([^<]*)<\/loc>/g)].map((m) => m[1])
  .filter((p) => p === '/integrations' || p.startsWith('/integrations/') || p.startsWith('/docs/'))
const WANT11 = ['/integrations', '/integrations/openclaw', '/integrations/langchain', '/integrations/openai-agents-sdk',
                '/integrations/crewai', '/integrations/mcp']
ok('[integrations] the sitemap carries the hub, the five integration pages and the guides under /docs/',
   WANT11.every((p) => scope11.includes(p)) && scope11.filter((p) => p.startsWith('/docs/')).length >= 3,
   `in scope: ${scope11.join(' ')}`)

const pages11 = []
for (const path of scope11) {
  const res = await fetch(`${API}${path}`)
  const html = await res.text()
  const at = html.indexOf('<main class="container">')
  const main = at < 0 ? '' : html.slice(at, html.indexOf('</main>', at))
  const pres = [...main.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/g)].map((m) => m[1])
  const lines = pres.flatMap((p) => p.split('\n'))
  const code = lines.filter((l) => !/class="out-/.test(l)).map(text11)
  const out = lines.filter((l) => /class="out-/.test(l)).map(text11)
  const comments = [...pres.flatMap((p) => [...p.matchAll(/<span class="comment">([\s\S]*?)<\/span>/g)].map((m) => text11(m[1]))),
                    ...code.map((l) => (l.match(/(?:^|\s)(?:#|\/\/) (.*)$/) ?? [])[1] ?? '')]
  const strings = code.flatMap((l) => [...l.matchAll(/"([^"\n]*)"|'([^'\n]*)'/g)].filter((m) => !isKey11(l, m)).map((m) => m[1] ?? m[2]))
  const proseHtml = main.replace(/<pre[\s\S]*?<\/pre>/g, ' ').replace(/<blockquote[\s\S]*?<\/blockquote>/g, ' ')
    .replace(/<span class="inline">([\s\S]*?)<\/span>|<code>([\s\S]*?)<\/code>/g, (_, a, b) => (/\s/.test((a ?? b).trim()) ? ` ${a ?? b} ` : ' '))
  const prose = [(html.match(/<title>([^<]*)<\/title>/) ?? [])[1] ?? '',
                 (html.match(/<meta name="description" content="([^"]*)"/) ?? [])[1] ?? '',
                 text11(proseHtml),
                 ...[...main.matchAll(/(?:aria-label|title|alt|placeholder)="([^"]*)"/gi)].map((m) => m[1]),
                 ...comments].join('\n')
  pages11.push({ path, status: res.status, html, main, pres: pres.map((p) => decode11(p.replace(/<[^>]+>/g, ''))),
                 prose, sentences: [...strings, ...out.map(sdkOut11)].join('\n'), code: code.join('\n') })
}
const hits11 = (re, pick) => pages11.flatMap((p) => (pick(p).match(re) ?? []).map((w) => `${p.path}: ${w}`))
{
  const h = [...hits11(WORDS11, (p) => p.prose), ...hits11(WORDS11, (p) => p.sentences)]
  ok('[integrations] no page says stop, block, kill, halt or cut off, in its prose, its comments or the sentences in its samples',
     pages11.length >= WANT11.length && pages11.every((p) => p.status === 200 && p.main.length > 0) && h.length === 0,
     h.join('; ') || pages11.filter((p) => p.status !== 200 || !p.main).map((p) => `${p.path} ${p.status}`).join(', '))
}
{
  const h = [...hits11(FIRST11, (p) => p.prose), ...hits11(FIRST11, (p) => p.sentences)]
  ok('[integrations] no page says "first" in its prose, its comments or the sentences in its samples',
     pages11.length > 0 && h.length === 0, h.join('; '))
}
{
  const h = hits11(DASH11, (p) => p.html)
  ok('[integrations] no em dash anywhere on these pages, literal or entity', pages11.length > 0 && h.length === 0, h.join('; '))
}
{
  const h = [...hits11(NAMED11, (p) => p.prose), ...hits11(NAMED11, (p) => p.main), ...hits11(NAMED11, (p) => p.code)]
  ok('[integrations] n8n and Claude Code are named nowhere on these pages: nothing we ship installs into either',
     pages11.length > 0 && h.length === 0, [...new Set(h)].join('; '))
}

// The install line and the config a reader copies from /integrations/openclaw
// are the plugin README's own fenced blocks, byte for byte, and so is the
// refusal sample. The README is what ClawHub shows; two copies that drift is a
// page teaching a config the listing does not.
const fenced11 = (file) => [...readFileSync9(`${ROOT9}/${file}`, 'utf8').matchAll(/^```[\w-]*\n([\s\S]*?)\n^```/gm)].map((m) => m[1])
const page11 = (path) => pages11.find((p) => p.path === path) ?? { pres: [], prose: '', main: '', html: '' }
const clawDoc11 = fenced11('plugins/openclaw/README.md')
const clawWant11 = [clawDoc11.find((b) => b.startsWith('openclaw plugins install')),
                    clawDoc11.find((b) => b.includes('"allowConversationAccess": true')),
                    clawDoc11.find((b) => b.startsWith('AgentBill refused ('))]
const clawPres11 = page11('/integrations/openclaw').pres.map((p) => p.trim())
const clawLog11 = (readFileSync9(`${ROOT9}/plugins/openclaw/README.md`, 'utf8').replace(/\s+/g, ' ')
  .match(/`(\[agentbill\] ceiling [^`]+)`/) ?? [])[1] ?? 'no log line in the README'
ok('[integrations] /integrations/openclaw carries the README\'s install line, config and refusal sample byte for byte, and its log line',
   clawWant11.every((b) => b && clawPres11.includes(b)) && text11(page11('/integrations/openclaw').main).replace(/\s+/g, ' ').includes(clawLog11),
   clawWant11.map((b, i) => (b && clawPres11.includes(b) ? '' : `README block ${i + 1} not on the page`)).filter(Boolean).join('; ') || `log line "${clawLog11}" not on the page`)
// OpenClaw runs before_agent_run, the hook that refuses a model turn, only on
// its embedded and CLI runners (docs/plugins/hooks.md in openclaw 2026.9.4: "do
// not rely on it as a Codex or Copilot input gate"). The page said, with no
// condition, that OpenClaw does not send a refused turn, and so did the hub and
// llms.txt. Each place a reader meets that claim names the runners it holds
// on, in the same paragraph, and each place must be found for this to pass.
{
  const claw = page11('/integrations/openclaw')
  const llms = await fetch(`${API}/llms.txt`).then((r) => r.text())
  const said = [
    ['the OpenClaw description', decode11((claw.html.match(/<meta name="description" content="([^"]*)"/) ?? [])[1] ?? '')],
    ['the OpenClaw lede', text11((claw.main.match(/<p class="lede">([\s\S]*?)<\/p>/) ?? [])[1] ?? '')],
    ['the hub', text11((page11('/integrations').main.match(/<p><b>Your agent runs inside OpenClaw\.<\/b>([\s\S]*?)<\/p>/) ?? [])[1] ?? '')],
    ['llms.txt', (llms.match(/^- \[OpenClaw plugin\].*$/m) ?? [''])[0]],
  ].map(([where, s]) => [where, s.replace(/\s+/g, ' ').trim()])
  const bad = said.filter(([, s]) => !s || (/\bsend\b/.test(s) && !s.includes('embedded and CLI runners')))
  ok('[integrations] wherever OpenClaw is said not to send a refused turn, the same paragraph names the runners where that holds',
     bad.length === 0, bad.map(([where, s]) => (s ? `${where}: "${s}"` : `${where}: not found`)).join('; '))
}
const mcpDoc11 = fenced11('mcp/README.md')
const mcpWant11 = [mcpDoc11.find((b) => b === 'uvx agentbill-mcp'), mcpDoc11.find((b) => b.includes('"mcpServers"'))]
const mcpPres11 = page11('/integrations/mcp').pres.map((p) => p.trim())
ok('[integrations] /integrations/mcp carries the MCP README\'s install line and server map byte for byte',
   mcpWant11.every((b) => b && mcpPres11.includes(b)),
   mcpWant11.map((b, i) => (b && mcpPres11.includes(b) ? '' : `README block ${i + 1} not on the page`)).filter(Boolean).join('; '))

// The samples teach the order the product has now: the job's ceiling is set
// beforehand, code passes task_ref and what the call is worth. None of what the
// replaced guides taught: customer_id, a per-call ceiling, checkpoint() as a
// task ceiling, and exceptions nothing raises (FreeTierExceededError since 0.6.0).
{
  const RETIRED11 = /customer_id\s*=|customerId\s*:|\bceiling\s*=|\btask_ceiling\s*=|taskCeiling\s*:|\.checkpoint\(|FreeTierExceededError|BudgetExhaustedError|\bCeilingExceededError/g
  const h = pages11.filter((p) => p.path.startsWith('/integrations')).flatMap((p) => (p.code.match(RETIRED11) ?? []).map((w) => `${p.path}: ${w}`))
  ok('[integrations] the integration samples pass task_ref and none of the retired pattern', h.length === 0, h.join('; '))
}

// The two guides these pages replaced answer 301, to the page that replaced
// each, and are in no sitemap entry: a redirect listed as a page is a sitemap
// whose URLs do not answer 200.
{
  const moved = [['/docs/langchain-billing', '/integrations/langchain'], ['/docs/openai-agent-spend-ceiling', '/integrations/openai-agents-sdk']]
  const got = await Promise.all(moved.map(([from]) => fetch(`${API}${from}`, { redirect: 'manual' })))
  const seen = moved.map(([from, to], i) => ({ from, to, status: got[i].status, location: got[i].headers.get('location'),
                                                listed: map11.includes(`agentbill.dev${from}<`) }))
  const bad = seen.filter((m) => m.status !== 301 || m.location !== m.to || m.listed)
  ok('[integrations] the two replaced guides answer 301 to the pages that replaced them, and are out of the sitemap',
     bad.length === 0, bad.map((m) => `${m.from} -> ${m.status} ${m.location}${m.listed ? ', still in the sitemap' : ''}`).join('; '))
  // A tagged link to an old path keeps its label through the redirect, the way
  // /upgrade forwards to /pricing: site_pulse reads ?src= from the page it lands on.
  const tagged = await Promise.all(moved.map(([from]) => fetch(`${API}${from}?src=dir-test`, { redirect: 'manual' })))
  const lost = moved.map(([from, to], i) => ({ from, want: `${to}?src=dir-test`, got: tagged[i].headers.get('location') }))
    .filter((m) => m.got !== m.want)
  ok('[integrations] the two old guide paths carry ?src= through the 301',
     lost.length === 0, lost.map((m) => `${m.from} -> ${m.got}`).join('; '))
  // And nothing else travels: a label outside cleanSource()'s shape, or any
  // other parameter, is dropped, so the Location is always our own path.
  const junk = await Promise.all(moved.map(([from]) => fetch(`${API}${from}?src=%2F%2Fevil.example&next=https://evil.example`, { redirect: 'manual' })))
  const leaked = moved.map(([from, to], i) => ({ from, to, got: junk[i].headers.get('location') })).filter((m) => m.got !== m.to)
  ok('[integrations] the old guide paths forward no parameter but a valid ?src=',
     leaked.length === 0, leaked.map((m) => `${m.from} -> ${m.got}`).join('; '))
}

// The hub: every version it shows is SDK_VERSIONS, the one copy that is checked
// against the registries, and a framework row is a Guide with no registry link,
// because there is no package for it and the table must not suggest one.
{
  const { SDK_VERSIONS } = await import('../../dist/lib/llms.js')
  const hub = page11('/integrations').main
  const rows = [...hub.matchAll(/<tr><td>([\s\S]*?)<\/td><td>([^<]*)<\/td><td>[\s\S]*?<\/td><td>([\s\S]*?)<\/td><td>/g)]
    .map((m) => ({ name: text11(m[1]).replace(/\s+/g, ' ').trim(), kind: m[2], registry: m[3] }))
  const shown = rows.flatMap((r) => r.name.match(/\d+\.\d+\.\d+/g) ?? [])
  const guides = rows.filter((r) => /^(LangChain|OpenAI Agents SDK|CrewAI)$/.test(r.name))
  ok('[integrations] the hub renders its versions from SDK_VERSIONS and lists each framework as a Guide with no registry',
     shown.length === Object.keys(SDK_VERSIONS).length && shown.every((v) => Object.values(SDK_VERSIONS).includes(v))
       && Object.values(SDK_VERSIONS).every((v) => shown.includes(v))
       && guides.length === 3 && guides.every((r) => r.kind === 'Guide' && !/<a /.test(r.registry)),
   `versions shown ${shown.join(', ')} vs ${Object.values(SDK_VERSIONS).join(', ')}; guides ${guides.map((r) => `${r.name}=${r.kind}`).join(', ')}`)
}

console.log(`\n${pass} passed, ${fail} failed`)
await sql.end()
process.exit(fail === 0 ? 0 : 1)
