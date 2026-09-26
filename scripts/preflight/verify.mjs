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
import { createHash as createHashK } from 'node:crypto'
import { gzipSync, brotliCompressSync } from 'node:zlib'
import { ipOrigin } from '../../dist/lib/ip-origin.js'
import { int8Type, parseInt8 } from '../../dist/db/int8.js'
import { keyHash, insertKeyRow } from './key-fixture.mjs'

const API = process.env.API_BASE ?? 'http://localhost:3999'
// Every key the harness plants is shaped like a real one (agb_ and 48 hex),
// because since 2026-09-25 auth.ts answers any other shape 401 before it
// reaches the database. The tag makes each one distinct and reproducible.
const shapedKey = (tag) => 'agb_' + createHashK('sha256').update(String(tag)).digest('hex').slice(0, 48)
// /admin is read the way the owner reads it since 2026-09-25: sign in through
// the form, then carry the session cookie. The raw secret as a Bearer header
// is no longer accepted anywhere. One login per run, from its own network so
// the per-network login limit never meets the gates that test it.
let adminCookieV = null
const adminCookie = async () => {
  if (adminCookieV) return adminCookieV
  const r = await fetch(`${API}/admin/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin', 'fly-client-ip': '203.0.113.250' },
    body: `secret=${encodeURIComponent(process.env.ADMIN_SECRET ?? '')}`,
  })
  adminCookieV = (r.headers.get('set-cookie') ?? '').split(';')[0]
  return adminCookieV
}
const KEY = process.env.API_KEY ?? 'agb_7e5700000000000000000000000000000000000000000001'
const ACCT = process.env.ACCOUNT_ID ?? '00000000-0000-0000-0000-0000000000aa'
// The same int8 parser the server uses. Migration 016 makes every unit column
// BIGINT, and without it this harness's own reads (c.reservedUnits === 12)
// would compare strings to numbers and fail for a reason that is not the
// code under test. The API responses are read over HTTP and are unaffected.
const sql = postgres(process.env.DATABASE_URL, { ssl: false, transform: postgres.camel, types: { int8: int8Type } })

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
  await sql`UPDATE accounts SET monthly_calls = 0, monthly_events = 0, plan = 'free', default_budget_units = NULL,
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
// The whole key: since 2026-09-25 a prefix longer than the 8 stored
// characters cannot be matched (keys.ts), and the whole key is matched by its
// hash, which names exactly this one.
const prefix = victim

ok('the new key authenticates', await alive(victim) === 200)

const rot = await post('/keys/rotate', {}, victim)
ok('rotate issued a replacement', rot.status === 200 && typeof rot.body.api_key === 'string', JSON.stringify(rot.body))
ok('rotated key still works during its grace window', await alive(victim) === 200)

// Asked in SQL, not against the host clock. The database runs ~120ms ahead of
// this process against a local container, which is enough to invert a
// just-written NOW() and is the second bug this phase found.
const rotatingRow = (await sql`
  SELECT revoked_at IS NOT NULL AS scheduled, revoked_at > NOW() AS in_future
  FROM developer_api_keys WHERE key_hash = ${keyHash(victim)}`)[0]
ok('grace window is a FUTURE revoked_at, not NULL',
   rotatingRow.scheduled === true && rotatingRow.inFuture === true,
   JSON.stringify(rotatingRow))

// The regression itself. This used to return 400 already_revoked and leave the
// key authenticating for the rest of the window.
const rev = await post('/keys/revoke', { key_prefix: prefix })
ok('revoke kills a mid-rotation key', rev.status === 200 && rev.body.revoked === true, JSON.stringify(rev.body))
ok('revoked key is dead on the very next request', await alive(victim) === 401, `got ${await alive(victim)}`)

const revokedRow = (await sql`
  SELECT revoked_at <= NOW() AS is_past FROM developer_api_keys WHERE key_hash = ${keyHash(victim)}`)[0]
ok('revoked_at was pulled back to the past', revokedRow.isPast === true, JSON.stringify(revokedRow))

// The two zero-row cases must not answer with the same sentence any more.
const again = await post('/keys/revoke', { key_prefix: prefix })
ok('revoking it twice reports already_revoked',
   again.status === 400 && again.body.error === 'already_revoked', JSON.stringify(again.body))

const missing = await post('/keys/revoke', { key_prefix: 'agb_zzzz' })
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
const ipKeyId = (await sql`SELECT id FROM developer_api_keys WHERE key_hash = ${keyHash(ipKey)}`)[0].id

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
const [acctOfKey8] = await sql`SELECT account_id FROM developer_api_keys WHERE key_hash = ${keyHash(KEY)}`
const secondKey8 = 'agb_' + 'c'.repeat(48)
await insertKeyRow(sql, acctOfKey8.accountId ?? acctOfKey8.account_id, secondKey8, 'ip-cap-second-key', { ifAbsent: true })
const [k2] = await sql`SELECT id FROM developer_api_keys WHERE key_hash = ${keyHash(secondKey8)}`
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
// the rest of it), under starts_with it matched nothing, and since
// 2026-09-25 it is compared for equality with the stored 8-character
// key_prefix, which no pattern language reaches either. 8 characters, the one
// prefix length a hashed key can still be matched by (keys.ts).
const wildcard = await post('/keys/revoke', { key_prefix: `${KEY.slice(0, 4)}%%%%` })
ok('a prefix is a prefix, not a LIKE pattern',
   wildcard.status === 400 && wildcard.body.error === 'key_not_found', JSON.stringify(wildcard.body))
ok('the harness key survived the wildcard prefix', await alive(KEY) === 200, `got ${await alive(KEY)}`)

// zod's .url() is a validator, not a filter: the WHATWG parser tolerates a
// control character and zod hands back the ORIGINAL string, so a webhook URL
// carrying a NUL reached the UPDATE and 500ed.
const badUrl = await post('/webhook-config', { url: `https://example.com/a${NUL}b` })
ok('a control character inside a valid https URL is 422', badUrl.status === 422, JSON.stringify(badUrl.body).slice(0, 140))
// A public address literal rather than a name: since 2026-09-25 a saved URL's
// host is resolved and every address checked ([secfix] S4), and a literal
// keeps this gate independent of the runner's DNS.
const goodUrl = await post('/webhook-config', { url: 'https://1.1.1.1/hook' })
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

// The path a paying customer actually takes, which has never worked. Since
// 2026-09-25 it has to be a live subscription for a product this server sells:
// an unknown product used to map to the unlimited 'paid' plan ([secfix] S5).
const upgraded = await hook({ type: 'subscription.active', data: { status: 'active', customer_id: 'cus_verify', product_id: process.env.POLAR_PRODUCT_ID_BUILDER, metadata: { agentbill_account_id: ACCT } } })
ok('a correctly signed upgrade is accepted', upgraded.status === 200, `${upgraded.status} ${upgraded.body.slice(0, 120)}`)
const planRow = (await sql`SELECT plan, polar_customer_id FROM accounts WHERE id = ${ACCT}`)[0]
ok('and it actually moved the account off free, to the plan the product buys', planRow.plan === 'builder' && planRow.polarCustomerId === 'cus_verify', JSON.stringify(planRow))
await sql`UPDATE accounts SET plan = 'free', polar_customer_id = NULL, monthly_calls = 0 WHERE id = ${ACCT}`

const badHook = await hook({ type: 'subscription.active', data: { status: 'active', product_id: process.env.POLAR_PRODUCT_ID_BUILDER, customer_id: 'polar_1', metadata: { agentbill_account_id: 'not-a-uuid' } } })
ok('a malformed account id in a Polar webhook is 200, not 500',
   badHook.status === 200 && !/invalid input syntax|22P02/i.test(badHook.body), `${badHook.status} ${badHook.body.slice(0, 140)}`)

// A value the schema accepts must be a value the column accepts. That is the
// same rule as the id rules above, in the other direction: every units and
// ceiling column was INTEGER and every schema said z.number().int() with no
// ceiling, so 3_000_000_000 was Postgres 22003 and a 500. The columns are
// BIGINT since migration 016 and the per-request bound stays INT4_MAX until a
// later deploy raises it on purpose, so this still answers 422.
const bigUnits = await rec({ customer_id: 'intmax', event_type: 'run', idempotency_key: `im-${Date.now()}`, units: 3_000_000_000 })
ok('a number past INTEGER is 422, not 500', bigUnits.status === 422, `${bigUnits.status} ${JSON.stringify(bigUnits.body).slice(0, 120)}`)
const bigEst = await pre({ agent_id: 'intmax', estimated_units: 3_000_000_000 })
ok('estimated_units past INTEGER is 422, not 500', bigEst.status === 422, `${bigEst.status} ${JSON.stringify(bigEst.body).slice(0, 120)}`)

// events.units had min(0) while the table had CHECK (units >= 1), so a value
// the route accepted was one the database refused: a 500. That was closed as
// a 422 on 2026-09-07. Migration 015 then made 0 a real answer (a provider
// can report 0 tokens, and a tool call in a tokens job costs 0 on its own),
// with the route and the column agreeing on it, so the rule this line holds
// is the original one: what the schema accepts, the column accepts.
const zeroKey = `z-${Date.now()}`
const zeroUnits = await rec({ customer_id: 'zero', event_type: 'run', idempotency_key: zeroKey, units: 0 })
const zeroRow = (await sql`SELECT units FROM events WHERE account_id = ${ACCT} AND idempotency_key = ${zeroKey}`)[0]
ok('units 0 is recorded as a zero-cost call: 200 and a row of 0, not a 422 and not a 500',
   zeroUnits.status === 200 && zeroUnits.body.status === 'recorded' && zeroRow?.units === 0,
   `${zeroUnits.status} ${JSON.stringify(zeroUnits.body).slice(0, 120)} row ${JSON.stringify(zeroRow)}`)
const negUnits = await rec({ customer_id: 'zero', event_type: 'run', idempotency_key: `zn-${Date.now()}`, units: -1 })
ok('units -1 is still a 422', negUnits.status === 422, `${negUnits.status} ${JSON.stringify(negUnits.body).slice(0, 120)}`)

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
const hookCtrl = await hook({ type: 'subscription.active', data: { status: 'active', product_id: process.env.POLAR_PRODUCT_ID_BUILDER, customer_id: `c${NUL}`, metadata: { agentbill_account_id: ACCT } } })
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
const unusable = await hook({ type: 'subscription.active', data: { status: 'active', product_id: process.env.POLAR_PRODUCT_ID_BUILDER, customer_id: 'alert-probe', metadata: { agentbill_account_id: 'still-not-a-uuid' } } })
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
// 2026-09-25 (security batch B): reveal is gone. The server keeps only a hash,
// so recovery makes a NEW key. A form rendered before the change still posts
// action=reveal, and that is read as "add": a new key beside the old ones.
const revealRes = await fetch(`${API}/recover/${revealToken}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', origin: API },
  body: 'action=reveal',
  redirect: 'manual',
})
const revealHtml = await revealRes.text()
const revealKey = (revealHtml.match(/agb_[0-9a-f]{48}/g) ?? [])
ok('[recover] a pre-change "reveal" post prints a NEW key, never the existing one',
   revealRes.status === 200 && revealKey.length >= 1 && new Set(revealKey).size === 1 && !revealHtml.includes(KEY), `${revealRes.status} ${revealKey.length}`)
ok('[recover] and the export line that sets it, with the key already in it and no placeholder',
   revealKey.length > 0 && revealHtml.includes(`export AGENTBILL_API_KEY=${revealKey[0]}`)
     && !/export AGENTBILL_API_KEY=(&lt;|\s|<)/.test(revealHtml))
ok('[recover] and names the two ways in that need no terminal',
   revealHtml.includes('AgentBillClient(api_key=...)') && revealHtml.includes('Authorization: Bearer')
     && !revealHtml.includes('Store it in an environment variable, not in your code'))
ok('[recover] the new key authenticates, and the old one still does (add revokes nothing)',
   revealKey.length > 0 && await alive(revealKey[0]) === 200 && await alive(KEY) === 200)
ok('[recover] a spent token cannot make another',
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
// Since 2026-09-25 (S24) the hand-off carries no account id: /app/checkout/:tier
// mints for the session's account. The [S24 checkout] gates prove the binding.
ok('and it hands off to the session-bound checkout, with no account id in the link',
   html7.includes('url=/app/checkout/team"') && !html7.includes('account_id='), (html7.match(/url=[^"]*/) ?? [''])[0])
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
const OTHERKEY8 = shapedKey('other-account-8')
await insertKeyRow(sql, OTHER8, OTHERKEY8, 'other', { ifAbsent: true })
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

// ------------------------------------------------- 8b: the start screen, "how will you connect?"
//
// 2026-09-25. The founder, as a user: "not clear at all", "quite complicated".
// Claude, reading his account over MCP: "There's no dollar estimate. None of
// its calls were recorded with a model name." The start screen's first sample
// called record(units=1), so a new account's first experience could never be
// a dollar. The screen now asks how the reader will connect, shows one short
// path per answer, and ends on the account's first recorded model call with
// its tokens, its model and its list-price estimate.
//
// Its own account, so nothing the gates above left behind decides what a
// virgin account sees, and nothing here reaches the account they share.
//
// The production path: the Python and the Node sample are taken off the
// served page, unescaped, and run as a reader would paste them, with the real
// SDKs, the real key over HTTP and this server pricing the record. Only the
// provider is a stand-in (no OpenAI key in CI). No test bypass is on that
// path: the key is a bearer header, checked by the same hook production runs.
// The homepage, read by the gates further down.
const fold8 = await fetch(`${API}/`).then(r => r.text())
const visibleST = (h) => h.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ')
const ACCT_ST = '00000000-0000-0000-0000-0000000000c1'
const KEY_ST = shapedKey(`start-screen-${Date.now()}`)
await sql`DELETE FROM accounts WHERE id = ${ACCT_ST}`
await sql`INSERT INTO accounts (id, plan, monthly_calls, billing_period_start) VALUES (${ACCT_ST}, 'free', 0, date_trunc('month', CURRENT_DATE)::date)`
await insertKeyRow(sql, ACCT_ST, KEY_ST, 'harness-start')
const loginST = await nav8('/app/session', { method: 'POST', headers: FORM8, body: `api_key=${KEY_ST}` })
const cookieST = (loginST.headers.get('set-cookie') ?? '').split(';')[0]
const pageST = (path) => nav8(path, { headers: { cookie: cookieST } })
const virgin8 = await pageST('/app').then(r => r.text())
const viaLinksST = [...virgin8.matchAll(/<a class="via" href="([^"]+)"([^>]*)>/g)].map((m) => [m[1], m[2]])
ok('[start] a virgin account\'s overview asks how you will connect, with three links and nothing chosen, and no ceiling form',
   virgin8.includes('How will you connect?') && viaLinksST.length === 3
     && JSON.stringify(viaLinksST.map((l) => l[0])) === JSON.stringify(['/app?view=start&amp;via=mcp', '/app?view=start&amp;via=python', '/app?view=start&amp;via=node'])
     && viaLinksST.every((l) => !l[1].includes('aria-current')) && !virgin8.includes('class="setf3"') && !virgin8.includes('Three steps'),
   JSON.stringify(viaLinksST))
ok('[start] before anything is recorded the screen says where the first call will appear',
   virgin8.includes('Nothing recorded yet. Run it, then reload this page'), 'no waiting line')
const unesc = (h) => h.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
const snipOf = (h) => { const m = h.match(/<pre class="snip">([\s\S]*?)<\/pre>/); return m ? unesc(m[1]) : '' }
const pyPageST = await pageST('/app?view=start&via=python')
const pyST = await pyPageST.text()
const nodeST = await pageST('/app?view=start&via=node').then(r => r.text())
const mcpResST = await pageST('/app?view=start&via=mcp')
const mcpST = await mcpResST.text()
const current = (h) => (h.match(/<a class="via" href="[^"]*via=(\w+)" aria-current="true">/) ?? [])[1]
ok('[start] Python: the chosen card is marked, the install upgrades, and the one sample wraps an OpenAI client on job first-call',
   current(pyST) === 'python' && pyST.includes('pip install -U agentbill-sdk openai') && snipOf(pyST).includes('agentbill.wrap(OpenAI(), task_ref="first-call"')
     && !/client\.record\(|units=1/.test(snipOf(pyST)), snipOf(pyST).slice(0, 160))
ok('[start] Node: the same, with the npm package and wrap(new OpenAI())',
   current(nodeST) === 'node' && nodeST.includes('npm install agentbill openai') && snipOf(nodeST).includes("wrap(new OpenAI(), { taskRef: 'first-call'"),
   snipOf(nodeST).slice(0, 160))
ok('[start] MCP: the connect page, a copyable first prompt, and what it does and does not do, said plainly',
   current(mcpST) === 'mcp' && mcpST.includes('href="/integrations/mcp"') && mcpST.includes('id="mcp-prompt"') && mcpST.includes('data-copy="mcp-prompt"')
     && mcpST.includes('record_event') && mcpST.includes('It does not meter the tokens of your chat with it') && !mcpST.includes('<pre class="snip">'),
   'the MCP path is missing a part')
const cspST = (r) => r.headers.get('content-security-policy') ?? ''
const copyHashST = (mcpST.match(/<script[^>]*>[\s\S]*?<\/script>/) ?? [''])[0]
ok('[start] the copy control is the one script, under a hash, on the MCP path only: the other paths and views carry no script-src',
   /script-src 'sha256-[A-Za-z0-9+/=]+'/.test(cspST(mcpResST)) && copyHashST.includes('data-copy') && !/script-src/.test(cspST(pyPageST))
     && !/<script/.test(pyST) && !/<script/.test(nodeST), `${cspST(mcpResST).slice(0, 120)} | ${cspST(pyPageST).slice(0, 80)}`)
const evilST = await pageST('/app?view=start&via=%3Cscript%3E').then(r => r.text())
ok('[start] a via that is not one of the three chooses nothing and is never echoed',
   evilST.includes('How will you connect?') && !current(evilST) && !evilST.includes('%3Cscript') && !/via=<|via=&lt;/.test(evilST))

// A record that names no model: the screen says why there is no dollar yet,
// and the overview stops being the start screen, because something arrived.
await fetch(`${API}/events`, { method: 'POST', headers: { Authorization: `Bearer ${KEY_ST}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ customer_id: 'default', event_type: 'hand', idempotency_key: `st-hand-${Date.now()}`, units: 1 }) })
const handST = await pageST('/app?view=start&via=python').then(r => r.text())
const overST = await pageST('/app').then(r => r.text())
ok('[start] a record that names no model: the screen says none can be priced, and shows no dollar figure for it',
   handST.includes('none of them names a model, so none can be priced') && !handST.includes('Your first call was recorded'), 'no unpriced line')
ok('[start] and once anything is recorded the overview is the dashboard, with the start screen still reachable',
   overST.includes('class="dash"') && overST.includes('class="leak') && !overST.includes('How will you connect?') && handST.includes('How will you connect?'))

// The production path, Python: the literal on the page, run as pasted.
const { mkdtempSync: mkdtST, writeFileSync: writeST, mkdirSync: mkdirST, symlinkSync: linkST } = await import('node:fs')
const { tmpdir: tmpST } = await import('node:os')
const { spawnSync: spawnST } = await import('node:child_process')
const ROOT_ST = new URL('../../', import.meta.url).pathname
const dirST = mkdtST(`${tmpST()}/agentbill-start-`)
// A stand-in for the openai package: the constructor and the one method the
// sample calls, answering with the usage shape OpenAI reports. It sees the
// request, so the gate can assert the call went out once.
mkdirST(`${dirST}/py/openai`, { recursive: true })
writeST(`${dirST}/py/openai/__init__.py`, `from types import SimpleNamespace as NS
SENT = []
class OpenAI:
    def __init__(self, *a, **k):
        self.base_url = "https://api.openai.com/v1/"
        def create(**kw):
            SENT.append(kw)
            print("SENT", len(SENT), kw.get("model"))
            return NS(id="chatcmpl-start-py", model="gpt-4o-mini-2024-07-18", service_tier="default",
                      usage=NS(prompt_tokens=14, completion_tokens=9, total_tokens=23,
                               prompt_tokens_details=NS(cached_tokens=0), completion_tokens_details=NS(reasoning_tokens=0)),
                      choices=[NS(index=0, message=NS(role="assistant", content="hi there friend"))])
        self.chat = NS(completions=NS(create=create))
OpenAI.__module__ = "openai"
`)
writeST(`${dirST}/first_call.py`, snipOf(pyST))
const PY_ST = process.env.WRAP_PYTHON
const envST = { ...process.env, AGENTBILL_API_KEY: KEY_ST, AGENTBILL_BASE_URL: API }
const pyRunST = PY_ST ? spawnST(PY_ST, [`${dirST}/first_call.py`], { encoding: 'utf8', timeout: 60_000,
  env: { ...envST, PYTHONPATH: `${dirST}/py:${ROOT_ST}sdk/python` } }) : null
ok('[start] python: the sample on the page runs as pasted with the real SDK and key, sends one call and prints the answer',
   pyRunST?.status === 0 && /SENT 1 gpt-4o-mini/.test(pyRunST.stdout) && pyRunST.stdout.includes('hi there friend'),
   PY_ST ? `${pyRunST?.status} ${(pyRunST?.stdout ?? '').slice(-200)} ${(pyRunST?.stderr ?? '').slice(-300)}` : 'WRAP_PYTHON is not set')
const [evPyST] = await sql`SELECT units, list_price_usd::text AS usd, price_version, task_ref, metadata->>'model' AS model
  FROM events WHERE account_id = ${ACCT_ST} AND idempotency_key = 'chatcmpl-start-py'`
ok('[start] python: the record names the model and 23 tokens, and the server priced it at $0.0000075 with the snapshot it used',
   evPyST?.units === 23 && evPyST.usd === '0.000007500000' && evPyST.taskRef === 'first-call' && evPyST.model === 'gpt-4o-mini-2024-07-18' && !!evPyST.priceVersion,
   JSON.stringify(evPyST))
const [jobST] = await sql`SELECT unit, ceiling_units, used_units, reserved_units FROM task_budgets WHERE account_id = ${ACCT_ST} AND task_ref = 'first-call'`
ok('[start] python: wrap() opened first-call in tokens at the 20,000 the screen says, and nothing is left reserved',
   jobST?.unit === 'token' && jobST.ceilingUnits === 20_000 && jobST.usedUnits === 23 && jobST.reservedUnits === 0, JSON.stringify(jobST))
const afterRefuse8 = await pageST('/app?view=start&via=mcp').then(r => r.text())
const firstLineST = visibleST((afterRefuse8.match(/<p class="first-ok" id="first-call">([\s\S]*?)<\/p>/) ?? [])[1] ?? '').replace(/\s+/g, ' ').trim()
ok('[start] the screen ends on the first call: the stored estimate, labelled, its tokens and its model, on every path',
   firstLineST.replace(/ ([,.])/g, '$1') === 'Your first call was recorded: $0.0000075 (estimate at list price), 23 tokens, model gpt-4o-mini-2024-07-18 on job first-call.',
   firstLineST)
ok('[start] and the estimate carries the list-price label beside it',
   afterRefuse8.includes('An estimate at public list price') && afterRefuse8.includes('(estimate at list price)'))

// The production path, Node: the same, through the Node SDK as run.sh built it.
mkdirST(`${dirST}/node/node_modules/openai`, { recursive: true })
linkST(`${ROOT_ST}sdk/node`, `${dirST}/node/node_modules/agentbill`)
writeST(`${dirST}/node/node_modules/openai/package.json`, JSON.stringify({ name: 'openai', version: '0.0.0-harness', type: 'module', main: 'index.js', exports: './index.js' }))
writeST(`${dirST}/node/node_modules/openai/index.js`, `export default class OpenAI {
  constructor() {
    this.baseURL = 'https://api.openai.com/v1'
    this.chat = { completions: { create: async (body) => { console.log('SENT', body.model)
      return { id: 'chatcmpl-start-node', model: 'gpt-4o-mini-2024-07-18', usage: { prompt_tokens: 14, completion_tokens: 10, total_tokens: 24,
        prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } },
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello from node' } }] } } } }
  }
}
export { OpenAI }
`)
writeST(`${dirST}/node/first-call.mjs`, snipOf(nodeST))
const nodeRunST = spawnST(process.execPath, [`${dirST}/node/first-call.mjs`], { encoding: 'utf8', timeout: 60_000, cwd: `${dirST}/node`, env: envST })
ok('[start] node: saved as first-call.mjs and run with node, the sample sends one call and prints the answer',
   nodeRunST.status === 0 && /SENT gpt-4o-mini/.test(nodeRunST.stdout) && nodeRunST.stdout.includes('hello from node'),
   `${nodeRunST.status} ${nodeRunST.stdout.slice(-200)} ${nodeRunST.stderr.slice(-300)}`)
const [evNodeST] = await sql`SELECT units, list_price_usd::text AS usd, price_version, task_ref FROM events WHERE account_id = ${ACCT_ST} AND idempotency_key = 'chatcmpl-start-node'`
ok('[start] node: its record is priced from its own 24 tokens, $0.0000081, on the same job',
   evNodeST?.units === 24 && evNodeST.usd === '0.000008100000' && evNodeST.taskRef === 'first-call' && !!evNodeST.priceVersion, JSON.stringify(evNodeST))
const mine8 = await pageST('/app?view=start&via=node').then(r => r.text())
ok('[start] the first call stays the first: the Node run after it (24 tokens) does not replace the Python one (23) on the screen',
   mine8.includes('Your first call was recorded: <b>$0.0000075</b>') && mine8.includes(', 23 tokens,') && !mine8.includes(', 24 tokens,') && (mine8.match(/<p class="first-ok"/g) ?? []).length === 1)

// The console that follows, on this account: dollars lead, tokens beside them.
const actST = await pageST('/app?view=activity').then(r => r.text())
// Since M2 (2026-09-26) the overview's figures are the dashboard's cards.
const tilesST = visibleST((await pageST('/app').then(r => r.text())).match(/<div class="dash">([\s\S]*?)<h2>Recent tasks/)?.[1] ?? '').replace(/\s+/g, ' ')
ok('[start] after a priced call the overview cards lead with the estimate and tokens, not units',
   /Cost \$0\.000016/.test(tilesST) && /Tokens 47/.test(tilesST) && tilesST.includes('List-price estimate') && !/Units (metered|recorded|refused)/.test(tilesST), tilesST.slice(0, 240))
ok('[start] and the activity chart is the cost chart, its split by event_type in dollars',
   actST.includes('id="cost-chart"') && actST.includes('Share of cost') && actST.includes('An estimate at public list price') && !actST.includes('Units recorded'),
   'activity is not the cost view')
await sql`DELETE FROM accounts WHERE id = ${ACCT_ST}`
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
//
// Rewritten again 2026-09-23 for the canvas redesign (T1 of the value pack,
// Lior's FIGMA GO). The film and Fig. 1 left the page, and the two gates that
// held them went with them on purpose; what they guaranteed did not leave. The
// film's gate said the fold reaches a refusal after the headline, and its
// fallback gate said the argument survives a reader who never sees a moving
// picture. The frame below is static text, so the second is true by
// construction, and this gate holds the first: a product frame inside the hero,
// after the h1, reaching the playground's own refusal in visible text, with the
// numbers read from the same RUN the page renders from rather than typed here
// (a gate that typed 492 would go red on a change that changed nothing), and
// labelled sample inside its own frame. No video and no image in the fold.
const { RUN: RUN8, REFUSAL: REFUSAL8 } = await import('../../dist/ui/playground.js')
const frAt8 = hero8.indexOf('<figure class="frame"')
const frame8 = frAt8 < 0 ? '' : hero8.slice(frAt8)
const frVis8 = visible8(frame8).replace(/\s+/g, ' ')
const n8 = (x) => Number(x).toLocaleString('en-US')
ok('[fold] the product frame follows the h1 in the hero and reaches the playground\'s own refusal, in text, labelled sample',
   frAt8 > -1 && hero8.indexOf('<h1') > -1 && frAt8 > hero8.indexOf('<h1')
     && frVis8.includes(RUN8.taskRef) && frVis8.includes(`${n8(RUN8.used)} / ${n8(RUN8.ceiling)} units`)
     && frVis8.includes(RUN8.refused.name) && frVis8.includes(`asks ${n8(RUN8.refused.asked)}`)
     && frVis8.includes('approved: false') && frVis8.includes(REFUSAL8.name) && /\bsample\b/i.test(frVis8)
     && !hero8.includes('<video') && !/<img\b/.test(frame8),
   frame8 ? frVis8.slice(0, 200) : 'no product frame in the hero')
// The h1 is locked the way the sub is. 2026-09-23: Lior's decision 1 kept this
// line for the experiment on `/`; 2026-09-24 the experiment was decided and the
// line became HEADLINE for the whole site (HOME_H1 folded in and deleted).
// Typed here on purpose, unlike the numbers: the point is that the words do
// not move, and HEADLINE is the thing that would move them.
// Relocked 2026-09-26 on Lior's choice of the client-cost line, after M2.
const LOCKED_H1_8 = "See what every client's agents cost you, before the invoice does"
const h1Text8 = ((hero8.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) ?? [])[1] ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
ok('[fold] the h1 is the locked line, byte for byte', h1Text8 === LOCKED_H1_8, `h1 reads: ${h1Text8}`)
// ---------------------------------------------------------------- the share card
// 2026-09-24: a WhatsApp preview of agentbill.dev showed "A ceiling on this
// job, not on the month" on the dark card, next to the new description. Two
// failures, one gate each. The card was never rebuilt when `/` took a new h1
// (a grep cannot see a PNG, so the card now records the headline it rendered,
// OG_HEADLINE), and even a rebuilt card would not have reached a chat that had
// seen the old one, because every head named a bare /og.png and chat apps
// cache by URL (it is now /og.png?v=<hash of the bytes>).
const { OG_HEADLINE, OG_VERSION, OG_PNG } = await import('../../dist/lib/og-image.js')
const { OG_IMAGE } = await import('../../dist/ui/og.js')
const { HEADLINE: HEADLINE_OG } = await import('../../dist/ui/site.js')
const titleOg = ((fold8.match(/<title>([^<]*)<\/title>/) ?? [])[1] ?? '')
ok('[og] the card was built from HEADLINE, and the h1 and <title> of / are the same constant',
   OG_HEADLINE === HEADLINE_OG && h1Text8 === HEADLINE_OG && titleOg === `AgentBill · ${HEADLINE_OG}`,
   `card "${OG_HEADLINE}", HEADLINE "${HEADLINE_OG}", h1 "${h1Text8}", title "${titleOg}"`)
const { createHash: hashOg } = await import('node:crypto')
const sha12Og = (b) => hashOg('sha256').update(b).digest('hex').slice(0, 12)
const pngDimOg = (b) => b.length > 24 ? `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}` : 'none'
const verOg = await fetch(`${API}/og.png?v=${OG_VERSION}`)
const verBytesOg = Buffer.from(await verOg.arrayBuffer())
ok('[og] /og.png?v=<OG_VERSION> serves the 1200x630 PNG whose sha256 is that version, immutable',
   verOg.status === 200 && verOg.headers.get('content-type') === 'image/png' && sha12Og(verBytesOg) === OG_VERSION
     && sha12Og(OG_PNG) === OG_VERSION && pngDimOg(verBytesOg) === '1200x630'
     && verOg.headers.get('cache-control') === 'public, max-age=31536000, immutable',
   `${verOg.status} ${verOg.headers.get('content-type')} sha ${sha12Og(verBytesOg)} vs v=${OG_VERSION}, ${pngDimOg(verBytesOg)}, cache "${verOg.headers.get('cache-control')}"`)
// The bare path is what old shares and ads carry, and a stale ?v= is what a
// page cached before a rebuild names. Both get the current card, and neither
// may be told it is immutable: it has no version to keep.
const bareOg = await fetch(`${API}/og.png`)
const bareBytesOg = Buffer.from(await bareOg.arrayBuffer())
const staleOg = await fetch(`${API}/og.png?v=000000000000`)
await staleOg.arrayBuffer()
ok('[og] bare /og.png and a stale ?v= serve the same card for a day, never immutable',
   bareOg.status === 200 && bareOg.headers.get('content-type') === 'image/png' && sha12Og(bareBytesOg) === OG_VERSION
     && bareOg.headers.get('cache-control') === 'public, max-age=86400'
     && staleOg.status === 200 && staleOg.headers.get('cache-control') === 'public, max-age=86400',
   `bare ${bareOg.status} "${bareOg.headers.get('cache-control')}", stale ${staleOg.status} "${staleOg.headers.get('cache-control')}"`)
// Every place a head can name the card: og:image, twitter:image, the WebPage
// node's primaryImageOfPage and the SoftwareApplication node's image. Read on
// every sitemap page, a noindex page and the 404, because head() builds them
// all and a page-local head is how /docs once shipped og tags with no image.
const mapOg = await fetch(`${API}/sitemap.xml`).then((r) => r.text())
const pathsOg = [...mapOg.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => new URL(m[1]).pathname).concat(['/recover', '/no-such-page-og'])
const badOg = []
let urlsOg = 0
for (const p of pathsOg) {
  // Accept names HTML because the 404 answers JSON to anything else.
  const h = await fetch(`${API}${p}`, { headers: { accept: 'text/html' } }).then((r) => r.text())
  const named = [
    ...[...h.matchAll(/<meta (?:property|name)="(?:og:image|twitter:image)" content="([^"]*)"/g)].map((m) => m[1]),
    ...[...h.matchAll(/"(?:image|url)":"([^"]*og\.png[^"]*)"/g)].map((m) => m[1]),
  ]
  const cardRefs = (h.match(/og\.png/g) ?? []).length
  urlsOg += named.length
  if (named.length < 2 || named.some((u) => u !== OG_IMAGE) || cardRefs !== named.length) badOg.push(`${p}: ${named.length} named, ${cardRefs} og.png refs, ${[...new Set(named)].join(' ')}`)
}
ok(`[og] every card URL a head emits is ${OG_IMAGE.replace(/^https:\/\/[^/]+/, '')}, on every sitemap page, a noindex page and the 404`,
   pathsOg.length > 10 && badOg.length === 0 && OG_IMAGE.endsWith(`/og.png?v=${OG_VERSION}`),
   `${pathsOg.length} pages, ${urlsOg} URLs; ${badOg.slice(0, 4).join('; ')}`)
// The concept before the name, on the hero and not in <head>. The rule (see
// above): the reader meets the thing before our endpoint's name. The h1 names
// the concept, the sub is the first place preflight appears, and the pill
// above the h1 must not say it.
const heroVis8 = visible8(hero8).replace(/\s+/g, ' ')
// The concept since 2026-09-26 is the h1's: what your clients' agents cost you.
const iConcept8 = heroVis8.indexOf("agents cost you")
const iPreName8 = heroVis8.search(/\bpreflight\b/i)
ok('[fold] the concept is read before the name preflight, in the hero and not in <head>',
   hero8.length > 0 && iConcept8 > -1 && iPreName8 > -1 && iConcept8 < iPreName8, `concept at ${iConcept8}, preflight at ${iPreName8}`)
// 2026-09-22: the sub under the h1 is a locked sentence (the pause-Broad,
// hygiene, one-targeted-relaunch ticket). "not a proxy" left the sub with it
// and lives in the request-path row's eyebrow, so this gate follows the
// guarantee rather than the old markup: the h1 still carries the contrast, the
// page still says no proxy, and the sub is the sentence below, byte for byte
// once its tags and line breaks are folded. The em dash the ticket's own text
// carried is a period here: voice-dna bans the character on every surface and
// hygiene greps for the literal, so the entity form is asserted on the hero
// too, since &mdash; renders the same dash and no grep in this repo sees it.
const LOCKED_SUB8 = 'Per agent, per client, per job, in dollars at list price, with a monthly report you can bill from. Give any job a ceiling, and the call that would cross it gets approved: false before it runs. Your code decides whether to stop, skip, or replan.'
const subHtml8 = (hero8.match(/<p class="sub">([\s\S]*?)<\/p>/) ?? [])[1] ?? ''
const subText8 = subHtml8.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
// 2026-09-23: the month/job contrast left the h1 with the redesign and lives in
// the statement panel, so this gate follows it there, and it reads the BODY:
// the old version was satisfied by <title> for "not on the month" and would
// have stayed green with the contrast gone from the page.
const body8 = fold8.slice(fold8.indexOf('<body'))
const stAt8 = fold8.indexOf('<section class="wrap sec statement">')
const st8 = stAt8 < 0 ? '' : fold8.slice(stAt8, fold8.indexOf('</section>', stAt8))
const stVis8 = visible8(st8).replace(/\s+/g, ' ')
ok('[fold] the page still says what the ceiling is and is not: the statement draws month against job, the body says no proxy, the sub is locked',
   st8.length > 0 && stVis8.includes('Month caps, org caps, and session or window budgets are real')
     && stVis8.includes('A job ceiling meters one job') && stVis8.includes('only if it asks preflight')
     && visible8(body8).includes('No proxy') && subText8.startsWith('Per agent, per client, per job'),
   `statement ${st8.length} bytes; sub reads: ${subText8.slice(0, 80)}`)
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
// The dual state, DRAWN, 2026-09-23: Fig. 1 left with the redesign and the
// statement's figure carries its argument: the same account in the same minute,
// a month meter with room beside this job at its ceiling, the next call
// refused. The job's numbers are RUN's, not typed, and the month row is a share
// of a window labelled sample, because this product has no month meter to read.
const stFigAt8 = st8.indexOf('<figure class="st-fig">')
const stFig8 = stFigAt8 < 0 ? '' : st8.slice(stFigAt8, st8.indexOf('</figure>', stFigAt8))
const stFigVis8 = visible8(stFig8).replace(/\s+/g, ' ')
ok('[fold] the statement draws both states in one frame: a month meter under the cap, this job refused at its ceiling, labelled sample',
   stFig8.length > 0 && /\bsample\b/i.test(stFigVis8)
     && /Org month cap \d+% used under the cap/.test(stFigVis8)
     && stFigVis8.includes(`${RUN8.taskRef} ${n8(RUN8.used)} / ${n8(RUN8.ceiling)}`)
     && stFigVis8.includes(`next call asks ${n8(RUN8.refused.asked)}`) && /\brefused\b/.test(stFigVis8),
   stFig8 ? stFigVis8.slice(0, 200) : 'no figure in the statement')
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
// And, 2026-09-23, to title, alt and placeholder, the other attributes a reader
// or an assistive tool reads out, now that the hero carries a whole frame.
const heroClaims8 = visible8(hero8) + ' ' + (hero8.match(/(?:aria-label|title|alt|placeholder)="([^"]*)"/g) ?? []).join(' ')
ok('[fold] the hero claims nothing about anyone else',
   !/\b(only|first|nobody)\b/i.test(heroClaims8),
   (heroClaims8.match(/\b(only|first|nobody)\b/gi) ?? []).join(', '))
// Two hero actions from 2026-09-23 (Lior's decision 6): the one primary, filled,
// to /register, and one secondary pill to #estimate that is not a second fill.
// The tag is selected first and its class tested after, so attribute order
// cannot hide a button; the primary keeps the exact class shots.mjs selects.
const heroA8 = [...hero8.matchAll(/<a\b[^>]*>/g)].map((m) => m[0])
const hrefOf8 = (t) => (t.match(/\bhref="([^"]*)"/) ?? [])[1]
// Class TOKENS, not a regex over the attribute: \bbtn\b also matches the btn
// in btn-alt, because a hyphen is a word boundary. The first version of this
// gate did exactly that and failed on the page it was written for.
const classes8 = (t) => ((t.match(/\bclass="([^"]*)"/) ?? [])[1] ?? '').split(/\s+/).filter(Boolean)
const prim8 = heroA8.filter((t) => /\bclass="btn btn-lg"/.test(t))
const fills8 = heroA8.filter((t) => classes8(t).includes('btn'))
const sec8 = heroA8.filter((t) => hrefOf8(t) === '#estimate')
ok('[fold] two hero actions and no third: one filled primary to /register, one secondary pill to #estimate, brochure rows gone',
   prim8.length === 1 && hrefOf8(prim8[0]) === '/register' && fills8.length === 1
     && sec8.length === 1 && !classes8(sec8[0]).some((c) => c === 'btn' || c === 'btn-lg' || c === 'btn-ghost') && heroA8.length === 2
     && !fold8.includes('Keys you can revoke') && !fold8.includes('What the ceiling saved you from'),
   heroA8.join(' | '))
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
//
// 2026-09-23: Lior retired the text link with the redesign (decision 6) and the
// second hero action is a pill to #estimate. The same shape holds for it: one
// link to #estimate on the whole page, in the hero (the beacon is document-wide
// and the tile is read as "the hero's pill", so a second one would pool into
// it); no link to #playground left anywhere, so no dead try_click wiring points
// at nothing; and both anchors exist.
const tryRe8 = /<a\b[^>]*\bhref="#playground"[^>]*>/g
const estRe8 = /<a\b[^>]*\bhref="#estimate"[^>]*>/g
const estPage8 = fold8.match(estRe8) ?? []
const estHero8 = hero8.match(estRe8) ?? []
ok('[fold] the hero carries the one link to #estimate, the retired demo link is gone, and both anchors exist',
   estPage8.length === 1 && estHero8.length === 1 && (fold8.match(tryRe8) ?? []).length === 0
     && /\bid="estimate"/.test(fold8) && fold8.includes('id="playground"'),
   `${estPage8.length} #estimate links on the page, ${estHero8.length} in the hero, ${(fold8.match(tryRe8) ?? []).length} to #playground`)
// /register, 2026-09-12: setup language above one form, nothing under it
// that pitches, and a key screen whose one action signs the key into the
// start screen rather than sending the reader to a login card.
ok('[register] the lede is setup language and nothing under the form pitches',
   register8.includes('Key once.') && register8.includes('Your code decides.') && !register8.includes('One decorator')
     && !register8.includes('class="facts"') && !register8.includes('the entire integration surface'))
// 2026-09-25: /register shows no key. It is the sign-in block, and the key is
// made in the console by a person whose address is verified ([auth] gates).
ok('[register] the page is the sign-in block and hands out no key: no key screen, no key field, the email form posts to /auth/email',
   register8.includes('action="/auth/email"') && !register8.includes('id="key-field"') && !register8.includes('id="key-display"')
     && !register8.includes('id="success-state"'))
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
// The email form's visible fields, hidden inputs aside (it carries `from`).
const formHtmlP = (register8.match(/<form class="signin-email"[\s\S]*?<\/form>/) ?? [''])[0]
const formFieldsP = (formHtmlP.match(/<(input|select)\b(?![^>]*type="hidden")/g) ?? []).length
ok('[profile] the signup form asks for the email and nothing else',
   formFieldsP === 1 && formHtmlP.includes('type="email"'), `${formFieldsP} fields in the form`)
// The optional three left with the key screen (2026-09-25): no account exists
// when /register answers, so there is nothing yet to attach them to. The
// endpoint stays, and is held below.
ok('[profile] and /register asks none of the optional three before an account exists',
   !register8.includes('id="use_case"') && !register8.includes('id="stack"') && !register8.includes("fetch('/app/profile'"))
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
// The key and the line that sets it moved to the console's first-key page,
// which the [auth] gates read; /register carries neither.
ok('[onboarding] /register carries no key and no export line: both are on the console\'s first-key page now',
   !register8.includes('id="key-export"') && !register8.includes('export AGENTBILL_API_KEY='))
// P0 of 2026-09-12, from Alex's re-verify on 9fa5718. Two failures, one cause:
// nothing on the register path touched the console session. A browser that
// had signed into another account earlier showed THAT account when the new
// key holder clicked the header's Console link, and the key screen's button
// opened a new tab, which a tester following one tab read as a button that
// does nothing. Now a 201 from POST /register carries the same Set-Cookie
// /app/session mints, name and path identical so it overwrites whatever sat
// there, and the button moves this tab.
// 2026-09-25: the key screen and its console button left /register with
// sign-in, so the two gates on that button are retired rather than weakened:
// what they held (one action, this tab, no key in a URL) is the first-key page
// now, a 200 with the key and a link to the start screen ([auth] gates).
ok('[register] the key screen and its hand-off form are gone, not hidden',
   !register8.includes('id="go-form"') && !register8.includes('class="btn-go"') && !register8.includes('action="/app/session"'))
// An account now exists only after a verified sign-in. The JSON POST mails a
// link; spending the link makes the account and signs the browser in as its
// owner, and that session opens the start screen as the account just created.
const OUTBOX8 = process.env.MAIL_TEST_OUTBOX
const linkFor8 = async (email) => {
  const { readFileSync } = await import('node:fs')
  for (let i = 0; i < 60; i++) {
    let mails = []
    try { mails = readFileSync(OUTBOX8, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch {}
    const m = mails.find((x) => x.to === email && x.reason === 'signin')
    const t = (m?.html.match(/\/auth\/email\/([A-Za-z0-9_-]{43})/) ?? [])[1]
    if (t) return t
    await new Promise((r) => setTimeout(r, 50))
  }
  return ''
}
const signUp8 = async (email, net) => {
  const r = await fetch(`${API}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', 'fly-client-ip': net },
    body: JSON.stringify({ email }) })
  const body = await r.json()
  const token = await linkFor8(email)
  const spent = await fetch(`${API}/auth/email/${token}`, { method: 'POST', redirect: 'manual', headers: { 'Sec-Fetch-Site': 'same-origin' } })
  return { r, body, spent, cookie: (spent.headers.getSetCookie().find((c) => c.startsWith('agentbill_user=')) ?? '') }
}
const email8 = `harness-register-${Date.now()}@example.invalid`
const up8 = await signUp8(email8, '203.0.113.81')
ok('[register] POST /register answers 202 check_email with no key and no cookie; the emailed link makes the account and signs this browser in as its owner',
   up8.r.status === 202 && up8.body.status === 'check_email' && !('api_key' in up8.body) && !up8.r.headers.get('set-cookie')
     && up8.spent.status === 303 && up8.spent.headers.get('location') === '/app?view=start' && /;\s*Path=\/app(;|$)/.test(up8.cookie) && /HttpOnly/.test(up8.cookie),
   `${up8.r.status} ${up8.spent.status} ${up8.cookie.slice(0, 30)}`)
const attrs8 = (c) => c.split(';').slice(1).map((s) => s.trim()).filter((a) => !a.startsWith('Max-Age')).sort().join('|')
ok('[register] the person\'s session and the key session share name-independent attributes (HttpOnly, Secure, SameSite=Lax, Path=/app), so each can clear the other',
   attrs8(up8.cookie) === attrs8(login8.headers.getSetCookie()[0] ?? ''), `${attrs8(up8.cookie)} vs ${attrs8(login8.headers.getSetCookie()[0] ?? '')}`)
const asNew8 = await nav8('/app?view=start', { headers: { cookie: up8.cookie.split(';')[0] } }).then(r => r.text())
ok('[register] and that cookie opens the start screen as the account just created, not another',
   asNew8.includes('How will you connect?') && asNew8.includes(email8) && !asNew8.includes('>no email<'),
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
const up8b = await signUp8(email8b, '203.0.113.82')
ok('[signup-alert] a second signup still lands in its console: telling the owner cannot hold up a sign-in',
   up8b.spent.status === 303 && up8b.cookie.startsWith('agentbill_user='), `${up8b.spent.status}`)
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
  if (acct) {
    await sql`DELETE FROM developer_api_keys WHERE account_id = ${acct.id}`
    await sql`DELETE FROM accounts WHERE id = ${acct.id}`
  }
  await sql`DELETE FROM users WHERE email = ${e}`
  await sql`DELETE FROM email_sign_in_tokens WHERE email = ${e}`
}
ok('[register] the harness accounts are gone again',
   (await sql`SELECT count(*)::int AS n FROM accounts WHERE email IN (${email8}, ${email8b})`)[0].n === 0)

// Under the fold, 2026-09-12. The request-path row is the one row; it teaches
// the console/PUT order with the field the endpoint actually takes; nothing on
// the page offers task_ceiling on a first call as a peer of that path; the
// task-budgets and refusals panels are off the cold path; and the not-list is
// four lines that say nothing about anyone else.
//
// 2026-09-23: the request-path row left with the redesign and "How it works"
// teaches the order now, so the gate reads that section's VISIBLE text. The
// old version was half-satisfied by the JSON-LD, which also names the PUT
// route, and would have stayed green with the lesson gone from the page.
const howAt8 = fold8.indexOf('<section class="wrap sec how">')
const how8 = howAt8 < 0 ? '' : fold8.slice(howAt8, fold8.indexOf('</section>', howAt8))
const howVis8 = visible8(how8).replace(/\s+/g, ' ')
ok('[home] How it works teaches the ceiling console-first with ceiling_units, and task_ceiling is not a peer path',
   how8.length > 0 && /in the console/.test(howVis8) && howVis8.includes('PUT /tasks/:task_ref/ceiling')
     && howVis8.includes('ceiling_units') && howVis8.indexOf('console') < howVis8.indexOf('PUT /tasks')
     && !/\btask_ceiling\b/.test(visible8(body8)) && !/on\s+its first call/.test(fold8)
     && !/pass <span class="mono-in">task_ceiling/.test(fold8),
   howVis8.slice(0, 200) || 'no How it works section')
ok('[home] the task-budgets and refusals panels are off the cold path',
   !fold8.includes('what the agent got back') && !fold8.includes('one job, many calls, one ceiling') && !fold8.includes('class="ref-row"'))
const notsAt8 = fold8.indexOf('class="nots"')
const nots8 = notsAt8 === -1 ? '' : fold8.slice(notsAt8, fold8.indexOf('</ul>', notsAt8))
ok('[home] the not-list is four lines, none about stopping a run or about who has agreed to anything',
   (nots8.match(/<li>/g) ?? []).length === 4 && !fold8.includes('Stop your run') && !fold8.includes('Nobody has agreed')
     && !/\bnobody\b/i.test(visible8(fold8)) && !/\b(stop|kill|block|dies)[a-z]*\b/i.test(visible8(nots8)),
   `${(nots8.match(/<li>/g) ?? []).length} items`)
// The bill line of the not-list, 2026-09-24. "The API never turns units into
// dollars" was true until list_price_usd_estimate (GET /tasks/:task_ref,
// src/lib/prices.ts) started serving a dollar figure for a token job. The line
// now says what the figure is (an estimate, at public list price, on calls
// wrap() measured) and keeps the phrase /upgrade counts on, "units refused is
// not money".
const billLine8 = visible8((nots8.match(/<li><b>Read your provider bill\.<\/b>([\s\S]*?)<\/li>/) ?? [])[1] ?? '').replace(/\s+/g, ' ').trim()
ok('[home] the bill line calls the dollar figure an estimate at list price on calls wrap() measured, and never says the API turns no units into dollars',
   billLine8.includes('A dollar figure appears only as an estimate at public list price, on calls wrap() measured.')
     && billLine8.includes('units refused is not money') && !/never turns units into dollars|no dollar estimate/i.test(visible8(fold8)),
   billLine8.slice(0, 160) || 'no bill line')
ok('[start] the first screen teaches no preflight or record by hand: nothing on it asks the reader to pick a number of units',
   !/How many units|in units|units=1|ceiling_units/.test(visible8(virgin8)) && !virgin8.includes('name="ceiling_units"'))

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

// ---------------------------------------------------------------- the redesigned homepage's new surfaces, 2026-09-23
// Every section the canvas redesign added is a claim surface the gates above
// did not read: the statement, the estimator, the demo's new copy, How it works,
// the ICP chips and the questions. Each is sliced by an exact, first anchor and
// the slice is asserted before anything is asserted about it, because a gate on
// an empty slice passes for free. Lior's rules for this pack, in his words:
// estimator dollars are the visitor's and never "AgentBill measured $"; no
// stop, kill or bill-metering claims; no em dash; no "first".
const slice8 = (open) => { const i = fold8.indexOf(open); return i < 0 ? '' : fold8.slice(i, fold8.indexOf('</section>', i)) }
const est8 = slice8('<section class="wrap sec est-sec" id="estimate">')
const pgSec8 = slice8('<section class="wrap sec pg-sec" id="playground">')
const icp8 = slice8('<section class="wrap sec icp">')
const faq8 = slice8('<section class="wrap sec faq" id="faq">')
const pricing8 = slice8('<section class="wrap sec pricing" id="pricing">')
ok('[home] every new section is on the page and has a slice of its own',
   [st8, est8, pgSec8, how8, icp8, faq8, pricing8].every((x) => x.length > 0),
   ['statement', 'estimate', 'demo', 'how', 'icp', 'faq', 'pricing'].filter((_, i) => ![st8, est8, pgSec8, how8, icp8, faq8, pricing8][i].length).join(', ') || 'all present')
for (const [name, html] of [['the statement', st8], ['the estimator', est8], ['the demo', pgSec8], ['How it works', how8],
                            ['the ICP chips', icp8], ['the questions', faq8]]) {
  const hits = readable8(html).match(/\b[a-z]*(stop|kill|block|dies)[a-z]*\b|\b(first|nobody)\b|\bno way to\b/gi) ?? []
  ok(`[home] ${name} never says stop, kill, block, dies, first, nobody or "no way to"`, html.length > 0 && hits.length === 0, hits.join(', ') || (html.length ? '' : 'empty slice'))
}
// The estimator: the visitor's arithmetic, labelled as theirs and as an
// estimate inside its own frame, one way out to /register, and no sentence that
// says AgentBill measured, tracked or billed a dollar.
const estVis8 = visible8(est8).replace(/\s+/g, ' ')
ok('[estimate] the dollars are the visitor\'s arithmetic: three inputs, labelled example and estimate, units not dollars, one link to /register',
   (est8.match(/<input\b/g) ?? []).length === 3 && /\bid="est-ex">example</.test(est8)
     && estVis8.includes('An estimate, not a measurement') && estVis8.includes('AgentBill counts units, not dollars')
     && estVis8.includes('Your cost per call') && (est8.match(/<a [^>]*href="\/register"/g) ?? []).length === 1
     && !/<form\b/.test(est8),
   estVis8.slice(0, 200))
const METER8 = /\b(we|agentbill|it)\s+(measures?|measured|meters?|tracks?|reads?|bills?)\s+(your\s+)?(bill|invoice|spend|dollars?|costs?|money)\b|\bmeasured\s+\$|\bwe\s+read\s+your\b/i
ok('[home] no sentence on the page says AgentBill measures, tracks or reads anyone\'s dollars or bill',
   !METER8.test(readable8(body8)), (readable8(body8).match(METER8) ?? [''])[0])
// The estimator's own script makes no network call. The page's one pulse
// client counts that it was used and never what was typed; this reads the
// script the page ships, from the build, and fails on any way out.
const { ESTIMATOR_SOURCE: EST_SRC8 } = await import('../../dist/ui/estimator.js')
ok('[estimate] the estimator script has no way to send what was typed: no fetch, beacon, XHR, WebSocket or image ping',
   EST_SRC8.length > 0 && !/\bfetch\s*\(|sendBeacon|XMLHttpRequest|WebSocket|new\s+Image\b|\.src\s*=/.test(EST_SRC8)
     && fold8.includes(EST_SRC8.trim().slice(0, 40)),
   'the estimator script carries a network call, or is not the script the page serves')
// No em dash a reader can see, on the whole page (the hero gate covers the
// hero only, and hygiene greps the source, not the served page).
ok('[home] no em dash anywhere a reader can see it, literal or entity',
   !/\u2014|&mdash;|&#8212;|&#x2014;/i.test(body8.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '')))
ok('[home] no "first" anywhere on the page a reader can read it',
   !/\bfirst\b/i.test(readable8(body8)), (readable8(body8).match(/.{0,30}\bfirst\b.{0,30}/i) ?? [''])[0])
// Decision 7: Free keeps the only filled plan button; Team is marked by its
// border and chip, never by a second fill. Tag first, class after.
const planA8 = [...pricing8.matchAll(/<a\b[^>]*>/g)].map((m) => m[0])
const planFill8 = planA8.filter((t) => /\bclass="btn"/.test(t))
ok('[home] Free carries the only filled plan button, to /register; every paid plan is the outlined one',
   planFill8.length === 1 && /href="\/register"/.test(planFill8[0])
     && planA8.filter((t) => /data-tier=/.test(t)).every((t) => /\bclass="btn-ghost"/.test(t))
     && planA8.filter((t) => /data-tier=/.test(t)).length === 3,
   planA8.join(' | '))

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
// 2026-09-23: the demo link was retired with the redesign and its wiring went
// with it; the hero's second action is the pill to #estimate. The last clause
// is the part the old gate lacked: the selector has to match a link that is
// actually on the page, or the beacon is wired to nothing and the tile reads
// zero for a reason that is not the visitors'.
ok('[pulse] the homepage wires the hero\'s #estimate pill to estimate_click, and the pill exists',
   homeJs9.includes('a[href="#estimate"]') && homeJs9.includes("pulse('estimate_click')")
     && homeJs9.indexOf('function pulse(') < homeJs9.indexOf("pulse('estimate_click')")
     && (home9.match(/<a\b[^>]*\bhref="#estimate"/g) ?? []).length === 1
     && !homeJs9.includes('a[href="#playground"]'))
ok('[pulse] estimate_use fires once per load, from the estimator\'s own inputs, and carries no number',
   homeJs9.includes("document.querySelectorAll('#est input')") && /if \(estUsed\) return;\s*estUsed = true;\s*pulse\('estimate_use'\);/.test(homeJs9)
     && (homeJs9.match(/pulse\('estimate_use'/g) ?? []).length === 1)
ok('[pulse] the Meta pixel is still on / (the ads measure the landing through it)',
   home9.includes("fbq('init', '1234567890')"))
const regJs9 = scripts9(register9).join('\n')
// On /register the beacon comes after the helper and is the last thing the
// script does. Since 2026-09-25 the form needs no script at all: it is a native
// POST to /auth/email (method="post", so a failed script can never turn it
// into a GET with the address in the URL), and the script wires nothing.
const regHelper9 = regJs9.indexOf('function pulse(')
const regBeacon9 = regJs9.indexOf("pulse('register_view')")
ok('[pulse] /register defines pulse() and only then fires register_view, once, and its form works with no script',
   (regJs9.match(/pulse\('register_view'\)/g) ?? []).length === 1
     && regHelper9 > -1 && regHelper9 < regBeacon9 && !regJs9.includes('addEventListener(\'submit\'')
     && /<form class="signin-email" id="email-form" method="post" action="\/auth\/email">/.test(register9),
   `helper@${regHelper9} beacon@${regBeacon9}`)
// The write itself, end to end, plus the closed list. The handler awaits the
// insert before it answers, so the row is there when the 204 is.
const view9 = `verify9${Date.now()}`
const post9 = (body) => fetch(`${API}/pulse`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                body: JSON.stringify(body) }).then((r) => r.status)
const st9 = [await post9({ event: 'cta_click', view_id: view9 }),
             await post9({ event: 'register_view', view_id: view9 }),
             await post9({ event: 'try_click', view_id: view9 }),
             await post9({ event: 'page_view', view_id: view9 }),
             await post9({ event: 'estimate_click', view_id: view9 }),
             await post9({ event: 'estimate_use', view_id: view9 }),
             await post9({ event: 'cta_view', view_id: view9 })]
const rows9 = (await sql`SELECT event FROM site_pulse WHERE view_id = ${view9} ORDER BY event`).map((r) => r.event)
ok('[pulse] cta_click, estimate_click, estimate_use, page_view, register_view and try_click are on the allowlist and land as rows',
   JSON.stringify(rows9) === JSON.stringify(['cta_click', 'estimate_click', 'estimate_use', 'page_view', 'register_view', 'try_click']), rows9.join(', ') || 'no rows')
ok('[pulse] and the list is still closed: an unknown name is dropped and still answers 204',
   st9.every((c) => c === 204) && rows9.length === 6, `statuses ${st9.join('/')}, ${rows9.length} rows`)
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
const adminPv9 = await fetch(`${API}/admin`, { headers: { cookie: await adminCookie() } })
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

// 2. The page tags its own links to /register. Eight of them on the homepage
// since 2026-09-25 (the nav's button, the nav menu's Sign up, the sticky bar,
// the hero, the estimator's card, the Free tier card, the close, the footer;
// Sign up joined the menu with sign-in), from shared components and the page, which is why the rewrite is
// one loop where the beacon already lives rather than a parameter threaded
// through nav, the tier card and the footer.
//
// This gate reads the SERVED script, so it goes red if the loop is dropped.
// It does not prove the rewrite happens -- that needs a browser and is gated
// in shots.mjs, which clicks one of these links and reads the href back.
const taggedJs9 = scripts9(homeTagged9).join('\n')
const anchors9 = (homeTagged9.match(/<a [^>]*href="\/register"/g) ?? []).length
ok('[source] the homepage carries the /register links the rewrite is written against, and the loop that rewrites them',
   anchors9 === 8 && taggedJs9.includes("querySelectorAll('a[href=\"/register\"]')")
     && taggedJs9.includes("setAttribute('href', '/register?src='"),
   `${anchors9} anchors (expected 8)`)

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
const adminSrc9 = await fetch(`${API}/admin`, { headers: { cookie: await adminCookie() } })
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

// ---------------------------------------------------------------- meter, stage A: 2026-09-23
// Four ledger changes every later metering option depends on, each held by
// gates that name the failure they prevent. The memo that ordered them is
// O-output/2026-09-23-agent-metrics-decision-memo.md in the vault.
//
//   1. A record settles the call's OWN reservation (reservation_id). Before it,
//      record(units=actual) shrank the oldest reservation by `actual` and left
//      the rest held for the 60-minute TTL, so a caller reserving the worst
//      case and recording the real usage was refused long before its ceiling.
//   2. Every unit column is BIGINT, read through an int8 parser that returns
//      an exact number or fails loudly, never a string and never a rounded one.
//   3. A job declares what it counts (task_budgets.unit), fixed when it opens.
//   4. A call that cost 0 records 0; a call with no usage reported is charged
//      at least its reservation and counted, never recorded as a silent 0.
//
// Everything here is additive: the first gates below run the old client's
// exact request shape and assert the old answer, byte for byte where it matters.
console.log('\n[meter] a call settles its own reservation, and the ledger holds past INT4')
await reset()
const KEYM = (await post('/keys/generate', { label: 'harness-section-meter' })).body.api_key
if (typeof KEYM !== 'string' || !KEYM.startsWith('agb_')) throw new Error('[meter] could not mint its key')
const callM = (method, path, body, key = KEYM) => fetch(`${API}${path}`, {
  method, headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async r => { const text = await r.text(); let json = null; try { json = JSON.parse(text) } catch {} return { status: r.status, body: json, text } })
const preM = (b, key) => callM('POST', '/preflight', b, key)
const recM = (b, key) => callM('POST', '/events', b, key)
const taskM = async (ref) => (await sql`
  SELECT ceiling_units, used_units, reserved_units, unit, usage_missing_calls FROM task_budgets WHERE account_id=${ACCT} AND task_ref=${ref}`)[0]
const openForTask = async (ref) => Number((await sql`
  SELECT COALESCE(SUM(units),0) AS s FROM reservations WHERE account_id=${ACCT} AND task_ref=${ref} AND released_at IS NULL`)[0].s)
const UUID_M = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
let seqM = 0
const keyM = (p) => `${p}-${Date.now()}-${++seqM}`

// One job, the memo's numbers: every call reserves 70,000 (input plus
// max_tokens, say), uses 8,000, against a ceiling of 500,000.
const runJobM = async (ref, named, maxCalls) => {
  const out = { refusedAt: null, usedAtRefusal: null, maxReserved: 0, statuses: new Set(), released: new Set(), recordKeys: new Set(), bad: null }
  for (let i = 1; i <= maxCalls; i++) {
    const p = await preM({ agent_id: 'meter', task_ref: ref, task_ceiling: 500_000, estimated_units: 70_000 })
    if (p.body?.approved !== true) { out.refusedAt = i; out.usedAtRefusal = p.body?.task_used_units; break }
    const r = await recM({ customer_id: 'default', event_type: 'meter', idempotency_key: keyM(ref), units: 8_000, task_ref: ref,
                           ...(named ? { reservation_id: p.body.reservation_id } : {}) })
    if (r.status !== 200 || r.body?.status !== 'recorded') { out.bad = `call ${i}: ${r.status} ${r.text.slice(0, 120)}`; break }
    for (const k of Object.keys(r.body)) out.recordKeys.add(k)
    if (named) { out.statuses.add(r.body.reservation_status); out.released.add(r.body.reservation_released_units) }
    out.maxReserved = Math.max(out.maxReserved, (await taskM(ref)).reservedUnits)
  }
  return out
}

// The old client's request, unchanged: no reservation_id. Same answer as ever,
// including the stranding, because that is what an installed 0.6.x / 0.4.x
// SDK does and it must keep getting the answer it was written against.
const oldJob = await runJobM('meter-old', false, 12)
ok('[meter] an old client (no reservation_id) is still refused on call 8, with 56,000 spent: its answer did not change',
   oldJob.refusedAt === 8 && oldJob.usedAtRefusal === 56_000 && oldJob.bad === null, JSON.stringify({ ...oldJob, statuses: undefined, released: undefined, recordKeys: undefined }))
ok('[meter] and its record answer carries no new key',
   [...oldJob.recordKeys].sort().join(',') === 'customer_created,customer_remaining_units,event_id,status,task_exceeded,task_remaining_units,task_used_units',
   [...oldJob.recordKeys].sort().join(','))
ok('[meter] the stranding the fix exists for is real: the old job holds 7 x 62,000 reserved after its refusal',
   (await taskM('meter-old')).reservedUnits === 434_000 && await openForTask('meter-old') === 434_000, JSON.stringify(await taskM('meter-old')))

// The same job naming each reservation: the ceiling is reached by what was
// USED. 54 calls fit (54 x 8,000 = 432,000, and 432,000 + 70,000 > 500,000
// refuses the 55th), and nothing is held between calls.
const namedJob = await runJobM('meter-named', true, 60)
ok('[meter] naming the reservation, the job is NOT refused around call 7 or 8: 54 calls run and the 55th is refused at 432,000 used',
   namedJob.refusedAt === 55 && namedJob.usedAtRefusal === 432_000 && namedJob.bad === null, JSON.stringify({ ...namedJob, statuses: [...namedJob.statuses], released: [...namedJob.released], recordKeys: undefined }))
ok('[meter] and after every record nothing of the job stays reserved', namedJob.maxReserved === 0, `max reserved ${namedJob.maxReserved}`)
ok('[meter] every record says it settled its reservation and released all 70,000 it held',
   [...namedJob.statuses].join() === 'settled' && [...namedJob.released].join() === '70000', `${[...namedJob.statuses]} ${[...namedJob.released]}`)
const custM = await cust()
ok('[meter] invariant: the customer reserved == SUM(open rows) after both jobs', custM.reservedUnits === await openSum(custM.id), `${custM.reservedUnits} vs ${await openSum(custM.id)}`)

// The handle itself.
const idA = await preM({ agent_id: 'meter', task_ref: 'meter-id', task_ceiling: 1_000, estimated_units: 5, idempotency_key: 'meter-id-k1' })
const idB = await preM({ agent_id: 'meter', task_ref: 'meter-id', task_ceiling: 1_000, estimated_units: 5, idempotency_key: 'meter-id-k1' })
const idC = await preM({ agent_id: 'meter', task_ref: 'meter-id', estimated_units: 5 })
ok('[meter] an approved answer carries reservation_id as a random uuid, not the global row id',
   UUID_M.test(idA.body?.reservation_id ?? '') && UUID_M.test(idC.body?.reservation_id ?? '') && idA.body.reservation_id !== idC.body.reservation_id,
   `${idA.body?.reservation_id} ${idC.body?.reservation_id}`)
ok('[meter] a replayed preflight (same idempotency_key) carries the same reservation_id', idB.body?.reservation_id === idA.body?.reservation_id, `${idA.body?.reservation_id} vs ${idB.body?.reservation_id}`)
ok('[meter] and the approved answer is the old answer plus reservation_id, nothing else',
   Object.keys(idA.body).sort().join(',') === 'approved,estimated_units,reason,remaining_units,reservation_expires_at,reservation_id,task_ceiling,task_ref,task_remaining_units',
   Object.keys(idA.body).sort().join(','))
const refusedM = await preM({ agent_id: 'meter', task_ref: 'meter-id', estimated_units: 5_000 })
ok('[meter] a refusal carries no reservation_id: nothing was reserved', refusedM.body?.approved === false && !('reservation_id' in refusedM.body), JSON.stringify(refusedM.body))

// Settling is idempotent per reservation, whatever the idempotency_key does.
const once = await recM({ customer_id: 'default', event_type: 'meter', idempotency_key: keyM('once'), units: 3, task_ref: 'meter-id', reservation_id: idA.body.reservation_id })
const tOnce = await taskM('meter-id')
const twice = await recM({ customer_id: 'default', event_type: 'meter', idempotency_key: keyM('twice'), units: 3, task_ref: 'meter-id', reservation_id: idA.body.reservation_id })
const tTwice = await taskM('meter-id')
ok('[meter] the first record naming a reservation settles it (5 released) and moves used by 3',
   once.body?.reservation_status === 'settled' && once.body?.reservation_released_units === 5 && tOnce.reservedUnits === 5 && tOnce.usedUnits === 3,
   `${JSON.stringify(once.body)} task ${JSON.stringify(tOnce)}`)
ok('[meter] a second record naming the same reservation releases nothing more: already_closed, the other call\'s 5 still held',
   twice.body?.reservation_status === 'already_closed' && twice.body?.reservation_released_units === 0 && tTwice.reservedUnits === 5 && tTwice.usedUnits === 6,
   `${JSON.stringify(twice.body)} task ${JSON.stringify(tTwice)}`)
const dupKey = keyM('dup')
await recM({ customer_id: 'default', event_type: 'meter', idempotency_key: dupKey, units: 2, task_ref: 'meter-id', reservation_id: idC.body.reservation_id })
const tDup1 = await taskM('meter-id')
const dup = await recM({ customer_id: 'default', event_type: 'meter', idempotency_key: dupKey, units: 2, task_ref: 'meter-id', reservation_id: idC.body.reservation_id })
const tDup2 = await taskM('meter-id')
ok('[meter] a retried record (same idempotency_key) is duplicate_ignored and moves nothing',
   dup.body?.status === 'duplicate_ignored' && tDup1.usedUnits === tDup2.usedUnits && tDup1.reservedUnits === tDup2.reservedUnits && tDup2.reservedUnits === 0,
   `${JSON.stringify(dup.body)} ${JSON.stringify(tDup1)} -> ${JSON.stringify(tDup2)}`)

// success:false naming the reservation releases all of it, whatever units says.
const failP = await preM({ agent_id: 'meter', task_ref: 'meter-fail', task_ceiling: 500_000, estimated_units: 70_000 })
const failR = await recM({ customer_id: 'default', event_type: 'meter', idempotency_key: keyM('fail'), units: 1, task_ref: 'meter-fail', success: false, reservation_id: failP.body.reservation_id })
const tFail = await taskM('meter-fail')
ok('[meter] success:false naming the reservation releases all 70,000 (the unnamed path would release only the 1 it was sent) and bills nothing',
   failR.body?.status === 'released' && failR.body?.reservation_released_units === 70_000 && tFail.reservedUnits === 0 && tFail.usedUnits === 0,
   `${JSON.stringify(failR.body)} ${JSON.stringify(tFail)}`)

// A handle that is not this customer's and this task's matches nothing, and
// the record falls back to the unnamed path instead of touching it.
const aP = await preM({ agent_id: 'meter', task_ref: 'meter-a', task_ceiling: 1_000, estimated_units: 70 })
await preM({ agent_id: 'meter', task_ref: 'meter-b', task_ceiling: 1_000, estimated_units: 40 })
const wrongTask = await recM({ customer_id: 'default', event_type: 'meter', idempotency_key: keyM('wrong'), units: 10, task_ref: 'meter-b', reservation_id: aP.body.reservation_id })
ok('[meter] a reservation_id from another task_ref is not_found; that task\'s 70 stay held and this record settles FIFO (40 shrinks to 30)',
   wrongTask.body?.reservation_status === 'not_found' && (await taskM('meter-a')).reservedUnits === 70 && (await taskM('meter-b')).reservedUnits === 30 && await openForTask('meter-b') === 30,
   `${JSON.stringify(wrongTask.body)} a ${JSON.stringify(await taskM('meter-a'))} b ${JSON.stringify(await taskM('meter-b'))}`)
const garbled = await recM({ customer_id: 'default', event_type: 'meter', idempotency_key: keyM('garbled'), units: 1, reservation_id: 'not-a-uuid' })
ok('[meter] a reservation_id that is not a uuid is a 422, never a 500', garbled.status === 422, `${garbled.status} ${garbled.text.slice(0, 120)}`)

// Another account's handle is not a handle here, even for the same names.
const ACCT_BM = '00000000-0000-0000-0000-0000000000bd'
const KEY_BM = shapedKey(`meter-b-${Date.now()}`)
await sql`INSERT INTO accounts (id, plan, monthly_calls, billing_period_start) VALUES (${ACCT_BM}, 'free', 0, date_trunc('month', CURRENT_DATE)::date) ON CONFLICT (id) DO NOTHING`
await insertKeyRow(sql, ACCT_BM, KEY_BM, 'harness-meter-b')
const bP = await preM({ agent_id: 'meter', task_ref: 'meter-x', task_ceiling: 1_000, estimated_units: 40 }, KEY_BM)
await preM({ agent_id: 'meter', task_ref: 'meter-x', task_ceiling: 1_000, estimated_units: 25 })
const crossM = await recM({ customer_id: 'default', event_type: 'meter', idempotency_key: keyM('cross'), units: 25, task_ref: 'meter-x', reservation_id: bP.body?.reservation_id })
const bHeld = Number((await sql`SELECT reserved_units FROM task_budgets WHERE account_id = ${ACCT_BM} AND task_ref = 'meter-x'`)[0]?.reservedUnits)
ok('[meter] another account\'s reservation_id is not_found here, and that account\'s 40 stay held',
   bP.body?.approved === true && crossM.body?.reservation_status === 'not_found' && bHeld === 40, `${JSON.stringify(crossM.body)} b held ${bHeld}`)
await sql`DELETE FROM accounts WHERE id = ${ACCT_BM}`

// A reservation the sweeper already reclaimed, named late: nothing is released
// twice, and a live reservation beside it keeps what it holds.
const swP = await preM({ agent_id: 'meter', task_ref: 'meter-sw', task_ceiling: 1_000, estimated_units: 30 })
await sql`UPDATE reservations SET expires_at = now() - interval '1 minute' WHERE public_id = ${swP.body.reservation_id}`
const { sweepExpiredReservations: sweepM } = await import('../../dist/lib/reservation-sweeper.js')
await sweepM()
await preM({ agent_id: 'meter', task_ref: 'meter-sw', estimated_units: 12 })
const swR = await recM({ customer_id: 'default', event_type: 'meter', idempotency_key: keyM('sw'), units: 10, task_ref: 'meter-sw', reservation_id: swP.body.reservation_id })
const tSw = await taskM('meter-sw')
ok('[meter] naming a reservation the sweeper took: already_closed, 0 released, the live 12 beside it still held, used moves by 10',
   swR.body?.reservation_status === 'already_closed' && swR.body?.reservation_released_units === 0 && tSw.reservedUnits === 12 && tSw.usedUnits === 10 && await openForTask('meter-sw') === 12,
   `${JSON.stringify(swR.body)} ${JSON.stringify(tSw)}`)

// ---------------------------------------------------------------- zero and missing usage
const zP = await preM({ agent_id: 'meter', task_ref: 'meter-zero', task_ceiling: 500_000, estimated_units: 2_000 })
const zR = await recM({ customer_id: 'default', event_type: 'meter', idempotency_key: keyM('zero'), units: 0, task_ref: 'meter-zero', reservation_id: zP.body.reservation_id })
const tZero = await taskM('meter-zero')
ok('[meter] units 0 naming its reservation (a tool call in a tokens job) settles it: 2,000 released, 0 used',
   zR.status === 200 && zR.body?.reservation_released_units === 2_000 && tZero.reservedUnits === 0 && tZero.usedUnits === 0,
   `${zR.status} ${JSON.stringify(zR.body)} ${JSON.stringify(tZero)}`)
ok('[meter] and a plain record carries no usage_missing key', !('usage_missing' in (zR.body ?? {})) && !('units_recorded' in (zR.body ?? {})), JSON.stringify(zR.body))

const mP = await preM({ agent_id: 'meter', task_ref: 'meter-missing', task_ceiling: 500_000, estimated_units: 70_000 })
const mKey = keyM('missing')
const mR = await recM({ customer_id: 'default', event_type: 'meter', idempotency_key: mKey, units: 0, usage_missing: true, task_ref: 'meter-missing',
                        reservation_id: mP.body.reservation_id, metadata: { step: 'draft' } })
const tMissing = await taskM('meter-missing')
// Read with SQL's own JSON operators, not through the driver: the harness's
// camel transform would rename the keys, and the question is whether the
// database can see the flag. It could not before 2026-09-23: every metadata
// /events wrote was a JSON string holding JSON text (jsonb_typeof 'string'),
// so metadata->>'usage_missing' was NULL whatever the request said.
const mRow = (await sql`
  SELECT units, jsonb_typeof(metadata) AS kind, metadata->>'usage_missing' AS flag, metadata->>'step' AS step
  FROM events WHERE account_id = ${ACCT} AND idempotency_key = ${mKey}`)[0]
ok('[meter] usage_missing is NOT a 0: the call is charged its whole 70,000 reservation, and the answer says so',
   mR.status === 200 && mR.body?.usage_missing === true && mR.body?.units_recorded === 70_000 && tMissing.usedUnits === 70_000 && tMissing.reservedUnits === 0,
   `${mR.status} ${JSON.stringify(mR.body)} ${JSON.stringify(tMissing)}`)
ok('[meter] the job counts it as a call with no usage reported', tMissing.usageMissingCalls === 1, JSON.stringify(tMissing))
ok('[meter] and the event row itself says so, as a JSON object the database can query, keeping the caller\'s metadata',
   mRow?.units === 70_000 && mRow?.kind === 'object' && mRow?.flag === 'true' && mRow?.step === 'draft', JSON.stringify(mRow))
const plainKey = keyM('plain-meta')
await recM({ customer_id: 'default', event_type: 'meter', idempotency_key: plainKey, units: 1, metadata: { step: 'plan', model: 'm' } })
const plainRow = (await sql`
  SELECT jsonb_typeof(metadata) AS kind, metadata->>'step' AS step, metadata ? 'usage_missing' AS flagged
  FROM events WHERE account_id = ${ACCT} AND idempotency_key = ${plainKey}`)[0]
ok('[meter] a plain record\'s metadata is stored as a JSON object too, and is not flagged', plainRow?.kind === 'object' && plainRow?.step === 'plan' && plainRow?.flagged === false, JSON.stringify(plainRow))
const mP2 = await preM({ agent_id: 'meter', task_ref: 'meter-missing', estimated_units: 70_000 })
const mR2 = await recM({ customer_id: 'default', event_type: 'meter', idempotency_key: keyM('missing2'), units: 90_000, usage_missing: true, task_ref: 'meter-missing', reservation_id: mP2.body.reservation_id })
ok('[meter] usage_missing with units above the reservation charges the larger number', mR2.body?.units_recorded === 90_000 && (await taskM('meter-missing')).usedUnits === 160_000,
   `${JSON.stringify(mR2.body)} ${JSON.stringify(await taskM('meter-missing'))}`)
const mR3 = await recM({ customer_id: 'default', event_type: 'meter', idempotency_key: keyM('missing3'), units: 0, usage_missing: true, task_ref: 'meter-missing' })
const tMissing3 = await taskM('meter-missing')
ok('[meter] usage_missing with no reservation to go by records what was sent, and is still counted, so the total is never silently clean',
   mR3.body?.units_recorded === 0 && tMissing3.usedUnits === 160_000 && tMissing3.usageMissingCalls === 3, `${JSON.stringify(mR3.body)} ${JSON.stringify(tMissing3)}`)
const mGet = await callM('GET', '/tasks/meter-missing')
ok('[meter] GET /tasks/:task_ref carries usage_missing_calls', mGet.body?.usage_missing_calls === 3, JSON.stringify(mGet.body))

// ---------------------------------------------------------------- the unit a job counts in
const quotaBeforeUnit = await acct()
const tokOpen = await preM({ agent_id: 'meter', task_ref: 'meter-tok', task_ceiling: 900, estimated_units: 300, unit: 'token' })
const tokGet = await callM('GET', '/tasks/meter-tok')
ok('[meter] a job opened with unit "token" says token on GET /tasks/:task_ref', tokOpen.body?.approved === true && tokGet.body?.unit === 'token', `${JSON.stringify(tokOpen.body)} ${JSON.stringify(tokGet.body)}`)
const quotaAfterOpen = await acct()
const tokMismatch = await preM({ agent_id: 'meter', task_ref: 'meter-tok', estimated_units: 5, unit: 'unit' })
ok('[meter] a later call declaring a different unit is a 422 task_unit_mismatch that names both',
   tokMismatch.status === 422 && tokMismatch.body?.error === 'task_unit_mismatch' && tokMismatch.body?.unit === 'token' && tokMismatch.body?.declared_unit === 'unit'
     && /counted in tokens/.test(tokMismatch.body?.message ?? '') && /declared units/.test(tokMismatch.body?.message ?? ''),
   `${tokMismatch.status} ${tokMismatch.text.slice(0, 200)}`)
ok('[meter] and reserves nothing and burns no quota', (await taskM('meter-tok')).reservedUnits === 300 && await acct() === quotaAfterOpen && quotaAfterOpen === quotaBeforeUnit + 1,
   `${JSON.stringify(await taskM('meter-tok'))} quota ${quotaBeforeUnit} -> ${quotaAfterOpen} -> ${await acct()}`)
const tokSame = await preM({ agent_id: 'meter', task_ref: 'meter-tok', estimated_units: 5, unit: 'token' })
const tokNone = await preM({ agent_id: 'meter', task_ref: 'meter-tok', estimated_units: 5 })
ok('[meter] the same unit, or none at all (every existing client), is approved as before', tokSame.body?.approved === true && tokNone.body?.approved === true, `${JSON.stringify(tokSame.body)} ${JSON.stringify(tokNone.body)}`)
await recM({ customer_id: 'default', event_type: 'meter', idempotency_key: keyM('tok'), units: 300, task_ref: 'meter-tok', reservation_id: tokOpen.body.reservation_id })
await recM({ customer_id: 'default', event_type: 'meter', idempotency_key: keyM('tok'), units: 0, task_ref: 'meter-tok', reservation_id: tokSame.body.reservation_id })
await recM({ customer_id: 'default', event_type: 'meter', idempotency_key: keyM('tok'), units: 0, task_ref: 'meter-tok', reservation_id: tokNone.body.reservation_id })
const unitNoRef = await preM({ agent_id: 'meter', estimated_units: 5, unit: 'token' })
ok('[meter] unit without a task_ref is a 422: it would describe no job', unitNoRef.status === 422 && /needs task_ref/.test(unitNoRef.body?.message ?? ''), `${unitNoRef.status} ${unitNoRef.text.slice(0, 120)}`)
// On a job this call would OPEN, so the only thing that can refuse it is the
// schema: aimed at meter-tok, a unit mismatch answered 422 too, and this gate
// passed with the schema rule removed.
const unitBad = await preM({ agent_id: 'meter', task_ref: 'meter-badunit', task_ceiling: 100, estimated_units: 5, unit: 'dollar' })
ok('[meter] a unit that is neither "unit" nor "token" is a 422 validation_error and opens no job',
   unitBad.status === 422 && unitBad.body?.error === 'validation_error' && !(await taskM('meter-badunit')), `${unitBad.status} ${unitBad.text.slice(0, 120)}`)
const defOpen = await preM({ agent_id: 'meter', task_ref: 'meter-def', task_ceiling: 100, estimated_units: 1 })
await recM({ customer_id: 'default', event_type: 'meter', idempotency_key: keyM('def'), units: 1, task_ref: 'meter-def', reservation_id: defOpen.body?.reservation_id })
const putOpen = await callM('PUT', '/tasks/meter-put/ceiling', { ceiling_units: 100 })
ok('[meter] a job opened without a unit, from preflight or PUT, is counted in "unit"',
   (await taskM('meter-def')).unit === 'unit' && putOpen.body?.unit === 'unit' && defOpen.body?.approved === true, `${JSON.stringify(await taskM('meter-def'))} ${JSON.stringify(putOpen.body)}`)
const putMismatch = await callM('PUT', '/tasks/meter-put/ceiling', { ceiling_units: 200, unit: 'token' })
ok('[meter] PUT declaring a different unit on an existing job is a 422 task_unit_mismatch and leaves the ceiling alone',
   putMismatch.status === 422 && putMismatch.body?.error === 'task_unit_mismatch' && (await taskM('meter-put')).ceilingUnits === 100, `${putMismatch.status} ${putMismatch.text.slice(0, 160)}`)
const putTok = await callM('PUT', '/tasks/meter-put-tok/ceiling', { ceiling_units: 5_000, unit: 'token' })
const putTok2 = await callM('PUT', '/tasks/meter-put-tok/ceiling', { ceiling_units: 6_000 })
ok('[meter] PUT can open a job in tokens, and a later save without a unit keeps it in tokens',
   putTok.body?.unit === 'token' && putTok.body?.task_created === true && putTok2.status === 200 && putTok2.body?.unit === 'token' && putTok2.body?.ceiling_units === 6_000,
   `${JSON.stringify(putTok.body)} ${JSON.stringify(putTok2.body)}`)
const listM = await callM('GET', '/tasks?limit=200')
const listTok = listM.body?.tasks?.find((t) => t.task_ref === 'meter-tok')
const listDef = listM.body?.tasks?.find((t) => t.task_ref === 'meter-def')
ok('[meter] GET /tasks lists each job with its unit', listTok?.unit === 'token' && listDef?.unit === 'unit', `${JSON.stringify(listTok)} ${JSON.stringify(listDef)}`)

// The console prints the unit beside a tokens job's numbers, and nothing new
// beside a job in the developer's own unit. The number sits in the canvas
// row's units cell (<td class="num" data-l="units">, src/routes/app.ts
// taskRow) since the canvas restyle merged on 2026-09-24; before that it was
// a <span> in .bnum, which is what these two gates closed on.
const navM = (path, init = {}) => fetch(`${API}${path}`, { redirect: 'manual', ...init })
const loginM = await navM('/app/session', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin' }, body: `api_key=${KEYM}` })
const cookieM = (loginM.headers.get('set-cookie') ?? '').split(';')[0]
const pageM = await navM('/app?view=tasks', { headers: { cookie: cookieM } }).then((r) => r.text())
ok('[meter] the console shows a tokens job as "300 / 900 tokens" and "600 tokens left"',
   pageM.includes('<b>300</b> / 900 tokens</td>') && pageM.includes('600 tokens left'), (pageM.match(/meter-tok[\s\S]{0,600}/) ?? [''])[0].replace(/\s+/g, ' ').slice(0, 300))
// 2026-09-25: a job in the developer's own unit now names it too, as what it
// literally is, "units", with "your own count" on the cell, so a unit job is
// never mistaken for tokens or dollars beside a job that is (ticket: units out).
ok('[meter] and a job in the developer\'s own unit says units, labelled as your own count, never tokens',
   /<td class="num" data-l="used" title="units: your own count"><b>1<\/b> \/ 100 units<\/td>/.test(pageM) && !/<b>1<\/b> \/ 100 tokens/.test(pageM), (pageM.match(/meter-def[\s\S]{0,400}/) ?? [''])[0].replace(/\s+/g, ' ').slice(0, 200))
// One of meter-missing's three calls found no reservation open and was
// recorded at the 0 it sent, so "charged at their reservation", the wording
// before 2026-09-23, was false on this very row.
ok('[meter] and a job with unmeasured calls says how many, and that the reservation was the floor only where one was open',
   pageM.includes('3 calls with no usage reported, charged at least the reservation where one was open') && !pageM.includes('charged at their reservation'),
   (pageM.match(/meter-missing[\s\S]{0,900}/) ?? [''])[0].replace(/\s+/g, ' ').slice(0, 400))

// ---------------------------------------------------------------- usage_missing with no reservation_id
// Review of stage A, 2026-09-23: preflight reserving 70,000, then
// record(units 0, usage_missing) WITHOUT reservation_id answered
// units_recorded 0, the job showed 0 used with 70,000 still reserved until
// the TTL, and every document said such a call "is charged at least what its
// reservation held". The unnamed path now floors at the oldest open
// reservation of the customer and task_ref and closes it whole.
const unP = await preM({ agent_id: 'meter', task_ref: 'meter-missing-unnamed', task_ceiling: 500_000, estimated_units: 70_000 })
const unR = await recM({ customer_id: 'default', event_type: 'meter', idempotency_key: keyM('missing-unnamed'), units: 0, usage_missing: true, task_ref: 'meter-missing-unnamed' })
const tUn = await taskM('meter-missing-unnamed')
ok('[meter] usage_missing without reservation_id is charged the 70,000 its job had open, not 0, and nothing stays held',
   unP.body?.approved === true && unR.status === 200 && unR.body?.units_recorded === 70_000 && tUn.usedUnits === 70_000 && tUn.reservedUnits === 0
     && await openForTask('meter-missing-unnamed') === 0 && tUn.usageMissingCalls === 1 && !('reservation_status' in (unR.body ?? {})),
   `${unR.status} ${JSON.stringify(unR.body)} ${JSON.stringify(tUn)}`)
// A reservation_id that matches nothing takes the unnamed path, floor included.
await preM({ agent_id: 'meter', task_ref: 'meter-missing-nf', task_ceiling: 500_000, estimated_units: 50_000 })
const nfR = await recM({ customer_id: 'default', event_type: 'meter', idempotency_key: keyM('missing-nf'), units: 0, usage_missing: true, task_ref: 'meter-missing-nf',
                         reservation_id: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f' })
const tNf = await taskM('meter-missing-nf')
ok('[meter] usage_missing naming a reservation that is not_found is floored the same way: 50,000, closed whole',
   nfR.body?.reservation_status === 'not_found' && nfR.body?.units_recorded === 50_000 && tNf.usedUnits === 50_000 && tNf.reservedUnits === 0,
   `${JSON.stringify(nfR.body)} ${JSON.stringify(tNf)}`)
// The floor is the OLDEST open reservation, the one the FIFO settle closes
// first, and only that one: the newer one beside it keeps what it holds.
await preM({ agent_id: 'meter', task_ref: 'meter-missing-two', task_ceiling: 500_000, estimated_units: 30_000 })
await preM({ agent_id: 'meter', task_ref: 'meter-missing-two', estimated_units: 90_000 })
const twoR = await recM({ customer_id: 'default', event_type: 'meter', idempotency_key: keyM('missing-two'), units: 0, usage_missing: true, task_ref: 'meter-missing-two' })
const tTwo = await taskM('meter-missing-two')
ok('[meter] with two open, it is the oldest (30,000) that sets the floor and closes; the newer 90,000 stays held',
   twoR.body?.units_recorded === 30_000 && tTwo.usedUnits === 30_000 && tTwo.reservedUnits === 90_000 && await openForTask('meter-missing-two') === 90_000,
   `${JSON.stringify(twoR.body)} ${JSON.stringify(tTwo)}`)
// An old client's record (no usage_missing) on the unnamed path is untouched:
// FIFO by the units it sent, no floor.
await preM({ agent_id: 'meter', task_ref: 'meter-plain-unnamed', task_ceiling: 500_000, estimated_units: 70_000 })
const plR = await recM({ customer_id: 'default', event_type: 'meter', idempotency_key: keyM('plain-unnamed'), units: 8_000, task_ref: 'meter-plain-unnamed' })
const tPl = await taskM('meter-plain-unnamed')
ok('[meter] and a plain unnamed record still settles FIFO by what it sent: 8,000 used, 62,000 held, no units_recorded key',
   plR.body?.status === 'recorded' && !('units_recorded' in plR.body) && tPl.usedUnits === 8_000 && tPl.reservedUnits === 62_000,
   `${JSON.stringify(plR.body)} ${JSON.stringify(tPl)}`)

// ---------------------------------------------------------------- metadata jsonb refuses
// Review of stage A, 2026-09-23: with metadata stored as an object
// (::text::jsonb), a NUL or a lone surrogate anywhere in it was a 500 that
// rolled the whole record back, so the call was never recorded and its
// reservation stayed held. On cc5a1d2 the same bodies were 200, stored inside
// a JSON string. A string cut mid-emoji by .slice() is enough for the second.
const metaCases = [
  ['nul', { note: 'a\u0000b', 'k\u0000ey': 1 }, { note: 'ab', key: '1' }],
  ['surrogate', { note: '\ud800', nested: [{ cut: 'ok \ud83d' }] }, { note: '\ufffd', cut: 'ok \ufffd' }],
]
for (const [label, meta, want] of metaCases) {
  const mp = await preM({ agent_id: 'meter', task_ref: `meter-meta-${label}`, task_ceiling: 1_000, estimated_units: 40 })
  const mk = keyM(`meta-${label}`)
  const mr = await recM({ customer_id: 'default', event_type: 'meter', idempotency_key: mk, units: 5, task_ref: `meter-meta-${label}`, reservation_id: mp.body?.reservation_id, metadata: meta })
  const row = (await sql`
    SELECT units, jsonb_typeof(metadata) AS kind, metadata->>'note' AS note, metadata->>'key' AS key,
           metadata #>> '{nested,0,cut}' AS cut
    FROM events WHERE account_id = ${ACCT} AND idempotency_key = ${mk}`)[0]
  const tm = await taskM(`meter-meta-${label}`)
  const got = { note: row?.note, ...(want.key !== undefined ? { key: row?.key } : {}), ...(want.cut !== undefined ? { cut: row?.cut } : {}) }
  ok(`[meter] metadata with a ${label === 'nul' ? 'NUL' : 'lone surrogate'} in a string (and a key) is recorded, 200, not a 500 that loses the call`,
     mr.status === 200 && mr.body?.status === 'recorded' && row?.units === 5 && row?.kind === 'object',
     `${mr.status} ${mr.text.slice(0, 160)} ${JSON.stringify(row)}`)
  ok(`[meter] and stored made valid (${label === 'nul' ? 'NUL removed' : 'lone surrogate as U+FFFD'}), with the reservation settled`,
     JSON.stringify(got) === JSON.stringify(want) && tm.reservedUnits === 0 && tm.usedUnits === 5,
     `${JSON.stringify(got)} vs ${JSON.stringify(want)} task ${JSON.stringify(tm)}`)
}

// ---------------------------------------------------------------- a replayed preflight answers as it was answered
// Review of stage A, 2026-09-23: a retried preflight with the same
// idempotency_key after a task_unit_mismatch came back HTTP 200, text/plain,
// carrying the 422 body, and the Python SDK's retry raised
// KeyError('approved'). Two causes: remember() stored no status, and
// ${JSON.stringify(body)}::json double-encoded every stored answer, so every
// replay, approvals included, went out as text/plain.
const rawPre = (b) => fetch(`${API}/preflight`, {
  method: 'POST', headers: { 'Authorization': `Bearer ${KEYM}`, 'Content-Type': 'application/json' }, body: JSON.stringify(b),
}).then(async (r) => { const text = await r.text(); let json = null; try { json = JSON.parse(text) } catch {} return { status: r.status, type: r.headers.get('content-type') ?? '', body: json, text } })
const isJsonType = (t) => /^application\/json/.test(t)
const rpKey = keyM('replay')
const rpA = await rawPre({ agent_id: 'meter', task_ref: 'meter-replay', task_ceiling: 1_000, estimated_units: 7, unit: 'token', idempotency_key: rpKey })
const rpB = await rawPre({ agent_id: 'meter', task_ref: 'meter-replay', task_ceiling: 1_000, estimated_units: 7, unit: 'token', idempotency_key: rpKey })
ok('[meter] a replayed approval is the same body, HTTP 200 and application/json (it was text/plain)',
   rpA.status === 200 && rpB.status === 200 && rpA.body?.approved === true && rpB.text === rpA.text && isJsonType(rpA.type) && isJsonType(rpB.type)
     && (await taskM('meter-replay')).reservedUnits === 7,
   `${rpA.status} ${rpA.type} | ${rpB.status} ${rpB.type} ${rpB.text.slice(0, 120)}`)
const mmKey = keyM('replay-mismatch')
const mmA = await rawPre({ agent_id: 'meter', task_ref: 'meter-replay', estimated_units: 5, unit: 'unit', idempotency_key: mmKey })
const mmB = await rawPre({ agent_id: 'meter', task_ref: 'meter-replay', estimated_units: 5, unit: 'unit', idempotency_key: mmKey })
ok('[meter] task_unit_mismatch retried with the same key is a 422 again, as application/json, never a 200 with the 422 body',
   mmA.status === 422 && mmB.status === 422 && mmB.body?.error === 'task_unit_mismatch' && isJsonType(mmB.type) && !('approved' in (mmB.body ?? {})),
   `${mmA.status} | ${mmB.status} ${mmB.type} ${mmB.text.slice(0, 160)}`)
const rqKey = keyM('replay-required')
const rqA = await rawPre({ agent_id: 'meter', task_ref: 'meter-replay-new', estimated_units: 5, idempotency_key: rqKey })
const rqB = await rawPre({ agent_id: 'meter', task_ref: 'meter-replay-new', estimated_units: 5, idempotency_key: rqKey })
ok('[meter] task_ceiling_required retried with the same key is a 422 again, as application/json',
   rqA.status === 422 && rqB.status === 422 && rqB.body?.error === 'task_ceiling_required' && isJsonType(rqB.type), `${rqA.status} | ${rqB.status} ${rqB.type} ${rqB.text.slice(0, 160)}`)
// Nothing was reserved under a 422, so the key was never spent: once the job
// is opened, the same key is decided again, and approved once.
await callM('PUT', '/tasks/meter-replay-new/ceiling', { ceiling_units: 100 })
const rqC = await rawPre({ agent_id: 'meter', task_ref: 'meter-replay-new', estimated_units: 5, idempotency_key: rqKey })
const rqD = await rawPre({ agent_id: 'meter', task_ref: 'meter-replay-new', estimated_units: 5, idempotency_key: rqKey })
ok('[meter] and once the job exists the same key is approved, and reserved once',
   rqC.status === 200 && rqC.body?.approved === true && rqD.text === rqC.text && (await taskM('meter-replay-new')).reservedUnits === 5,
   `${rqC.status} ${rqC.text.slice(0, 120)} | ${rqD.text.slice(0, 80)} ${JSON.stringify(await taskM('meter-replay-new'))}`)
const rfKey = keyM('replay-refused')
const rfA = await rawPre({ agent_id: 'meter', task_ref: 'meter-replay-new', estimated_units: 500, idempotency_key: rfKey })
const rfB = await rawPre({ agent_id: 'meter', task_ref: 'meter-replay-new', estimated_units: 500, idempotency_key: rfKey })
ok('[meter] a remembered refusal (approved:false, 200) replays as the same 200 JSON body',
   rfA.status === 200 && rfA.body?.approved === false && rfA.body?.reason === 'task_ceiling_exceeded' && rfB.status === 200 && rfB.text === rfA.text && isJsonType(rfB.type),
   `${rfA.text.slice(0, 120)} | ${rfB.status} ${rfB.type}`)
// Rows an earlier build wrote are JSON strings holding JSON text. They must
// replay as the object, with the status they were answered with.
const legacyOk = { approved: true, reason: null, estimated_units: 3, remaining_units: null, reservation_expires_at: '2026-09-23T00:00:00.000Z', task_ref: 'meter-legacy', task_ceiling: 10, task_remaining_units: 7 }
const legacyReq = { error: 'task_ceiling_required', message: 'Unknown task_ref "meter-legacy-422".' }
const lgOkKey = keyM('legacy-ok'), lg422Key = keyM('legacy-422')
await sql`INSERT INTO preflight_requests (account_id, idempotency_key, response) VALUES
  (${ACCT}, ${lgOkKey}, to_json(${JSON.stringify(legacyOk)}::text)), (${ACCT}, ${lg422Key}, to_json(${JSON.stringify(legacyReq)}::text))`
const lgKind = (await sql`SELECT json_typeof(response) AS k FROM preflight_requests WHERE account_id = ${ACCT} AND idempotency_key = ${lgOkKey}`)[0]?.k
const lgOk = await rawPre({ agent_id: 'meter', task_ref: 'meter-legacy', estimated_units: 3, idempotency_key: lgOkKey })
const lg422 = await rawPre({ agent_id: 'meter', task_ref: 'meter-legacy-422', estimated_units: 3, idempotency_key: lg422Key })
ok('[meter] a row an earlier build stored as a JSON string replays as the object it holds, snake_case keys intact, 200 application/json',
   lgKind === 'string' && lgOk.status === 200 && isJsonType(lgOk.type) && JSON.stringify(lgOk.body) === JSON.stringify(legacyOk),
   `${lgKind} ${lgOk.status} ${lgOk.type} ${lgOk.text.slice(0, 160)}`)
ok('[meter] and a 422 an earlier build remembered replays as a 422',
   lg422.status === 422 && lg422.body?.error === 'task_ceiling_required' && isJsonType(lg422.type), `${lg422.status} ${lg422.type} ${lg422.text.slice(0, 120)}`)
const rpStored = (await sql`SELECT json_typeof(response) AS k FROM preflight_requests WHERE account_id = ${ACCT} AND idempotency_key = ${rpKey}`)[0]?.k
ok('[meter] and what this build stores is the object itself, not a string of it', rpStored === 'object', String(rpStored))

// ---------------------------------------------------------------- BIGINT, and the parser that makes it safe
const UNIT_COLUMNS_M = [
  ['accounts', 'default_budget_units'], ['customers', 'limit_units'], ['customers', 'used_units'], ['customers', 'reserved_units'],
  ['task_budgets', 'ceiling_units'], ['task_budgets', 'used_units'], ['task_budgets', 'reserved_units'],
  ['reservations', 'units'], ['events', 'units'], ['step_costs', 'units'],
]
const colTypesM = await sql`
  SELECT table_name, column_name, data_type FROM information_schema.columns
  WHERE table_schema = current_schema()
    AND table_name IN ('accounts', 'customers', 'task_budgets', 'reservations', 'events', 'step_costs')`
const typeOfM = (t, c) => colTypesM.find((r) => r.tableName === t && r.columnName === c)?.dataType
const notBigM = UNIT_COLUMNS_M.filter(([t, c]) => typeOfM(t, c) !== 'bigint')
ok('[meter] every unit column is BIGINT after the migration chain (016)', notBigM.length === 0,
   JSON.stringify(notBigM.map(([t, c]) => `${t}.${c}=${typeOfM(t, c)}`)))

// The parser, directly: exact numbers, and a throw where a JS number would round.
const { parseInt8: parseInt8M, unitsOf: unitsOfM } = await import('../../dist/db/int8.js')
const throwsM = (f) => { try { f(); return false } catch { return true } }
ok('[meter] parseInt8 returns exact numbers up to 2^53 - 1 and throws past it, either sign',
   parseInt8M('42') === 42 && parseInt8M('9007199254740991') === Number.MAX_SAFE_INTEGER && parseInt8M('-9007199254740991') === -Number.MAX_SAFE_INTEGER
     && throwsM(() => parseInt8M('9007199254740992')) && throwsM(() => parseInt8M('-9007199254740992')))
ok('[meter] unitsOf reads a number or a NUMERIC string exactly and refuses everything else',
   unitsOfM(7) === 7 && unitsOfM('3000000000') === 3_000_000_000 && throwsM(() => unitsOfM('1005x')) && throwsM(() => unitsOfM(null)) && throwsM(() => unitsOfM(1.5)) && throwsM(() => unitsOfM('')))

if (notBigM.length === 0) {
  // A running total past INT4, which an INTEGER column would have refused
  // with 22003 and a 500. Read back exact, and done arithmetic on as numbers.
  await callM('PUT', '/tasks/meter-big/ceiling', { ceiling_units: 2_000_000_000 })
  await sql`UPDATE task_budgets SET ceiling_units = 5000000000, used_units = 3000000000 WHERE account_id = ${ACCT} AND task_ref = 'meter-big'`
  const bigGet = await callM('GET', '/tasks/meter-big')
  ok('[meter] GET /tasks reads a job past INT4 exactly, as numbers',
     bigGet.body?.ceiling_units === 5_000_000_000 && bigGet.body?.used_units === 3_000_000_000 && bigGet.body?.remaining_units === 2_000_000_000,
     bigGet.text.slice(0, 200))
  const bigP = await preM({ agent_id: 'meter', task_ref: 'meter-big', estimated_units: 1_000 })
  const bigR = await recM({ customer_id: 'default', event_type: 'meter', idempotency_key: keyM('big'), units: 1_000, task_ref: 'meter-big', reservation_id: bigP.body?.reservation_id })
  ok('[meter] and preflight and record do the arithmetic as numbers past INT4',
     bigP.body?.task_remaining_units === 1_999_999_000 && bigR.body?.task_used_units === 3_000_001_000 && bigR.body?.task_remaining_units === 1_999_999_000,
     `${JSON.stringify(bigP.body)} ${JSON.stringify(bigR.body)}`)

  // events.ts: `used + units > limit`. On strings that is concatenation, and
  // "3000000000" + 2000 compared to "3000001000" as text says the record fits.
  await callM('PUT', '/budget', { customer_id: 'meter-bigc', limit_units: 2_000_000_000 })
  await sql`UPDATE customers SET limit_units = 3000001000, used_units = 3000000000 WHERE account_id = ${ACCT} AND customer_ref = 'meter-bigc'`
  const overC = await recM({ customer_id: 'meter-bigc', event_type: 'meter', idempotency_key: keyM('bigc'), units: 2_000 })
  const fitC = await recM({ customer_id: 'meter-bigc', event_type: 'meter', idempotency_key: keyM('bigc'), units: 1_000 })
  ok('[meter] the customer budget check past INT4 is integer arithmetic: 3,000,000,000 + 2,000 over a 3,000,001,000 limit is 402',
     overC.status === 402 && overC.body?.error === 'budget_exhausted', `${overC.status} ${overC.text.slice(0, 160)}`)
  ok('[meter] and + 1,000 fits exactly, leaving 0', fitC.status === 200 && fitC.body?.customer_remaining_units === 0, `${fitC.status} ${fitC.text.slice(0, 160)}`)
  const budC = await callM('GET', '/budget?customer_id=meter-bigc')
  const custsM = await callM('GET', '/customers')
  const rowC = custsM.body?.find?.((r) => (r.customer_id ?? r.customerId) === 'meter-bigc')
  ok('[meter] GET /budget and GET /customers return those totals as exact numbers, not strings',
     budC.body?.limit === 3_000_001_000 && budC.body?.used === 3_000_001_000 && rowC?.used === 3_000_001_000 && typeof rowC?.limit === 'number',
     `${budC.text.slice(0, 160)} ${JSON.stringify(rowC)}`)

  // Past 2^53 a JS number rounds. The parser throws, so the read is one loud
  // 500 that carries neither the true value nor a rounded one, and the
  // connection it failed on keeps serving.
  await callM('PUT', '/tasks/meter-huge/ceiling', { ceiling_units: 100 })
  await sql`UPDATE task_budgets SET used_units = 9007199254740993 WHERE account_id = ${ACCT} AND task_ref = 'meter-huge'`
  const deadM = (e) => ({ status: 0, body: null, text: `no answer: ${e?.cause?.code ?? e?.message ?? e}` })
  const hugeGet = await callM('GET', '/tasks/meter-huge').catch(deadM)
  ok('[meter] a value past 2^53 is a loud 500, never a rounded number and never a string',
     hugeGet.status === 500 && !/900719925474099/.test(hugeGet.text), `${hugeGet.status} ${hugeGet.text.slice(0, 160)}`)
  await sql`DELETE FROM task_budgets WHERE account_id = ${ACCT} AND task_ref = 'meter-huge'`
  // A transport failure is an answer here, not a crash of the harness: the
  // failure this gate exists for is a server that died on the throw.
  await settle(200)
  const afterHuge = await Promise.all([callM('GET', '/tasks/meter-big').catch(deadM), callM('GET', '/tasks?limit=5').catch(deadM), fetch(`${API}/health/db`).then((r) => r.status).catch(() => 0)])
  ok('[meter] and the server keeps answering on the same pool afterwards', afterHuge[0].status === 200 && afterHuge[1].status === 200 && afterHuge[2] === 200,
     afterHuge.map((x) => x.status ?? x).join(','))
} else {
  console.log(`  SKIP  [meter] the past-INT4 gates: ${notBigM.length} unit column(s) are not BIGINT yet (migration 016 not applied)`)
}

// Every unit field on every endpoint this stage touched is a JSON number.
const typeProbeP = await preM({ agent_id: 'meter', task_ref: 'meter-types', task_ceiling: 100, estimated_units: 4, customer_id: 'meter-typesc' })
await callM('PUT', '/budget', { customer_id: 'meter-typesc', limit_units: 1_000 })
const typeProbeP2 = await preM({ agent_id: 'meter', task_ref: 'meter-types', estimated_units: 4, customer_id: 'meter-typesc' })
const typeProbeR = await recM({ customer_id: 'meter-typesc', event_type: 'meter', idempotency_key: keyM('types'), units: 4, task_ref: 'meter-types', reservation_id: typeProbeP.body.reservation_id })
const typeProbeT = await callM('GET', '/tasks/meter-types')
const typeProbePut = await callM('PUT', '/tasks/meter-types/ceiling', { ceiling_units: 200 })
const typeProbeB = await callM('GET', '/budget?customer_id=meter-typesc')
const typeProbeC = await callM('POST', '/checkpoint', { agent_id: 'meter', customer_id: 'meter-typesc', units_so_far: 3 })
const typeProbeD = await callM('GET', '/decisions?task_ref=meter-id')
const numsM = {
  'preflight.task_ceiling': typeProbeP.body?.task_ceiling, 'preflight.task_remaining_units': typeProbeP.body?.task_remaining_units,
  'preflight.remaining_units': typeProbeP2.body?.remaining_units,
  'events.task_used_units': typeProbeR.body?.task_used_units, 'events.task_remaining_units': typeProbeR.body?.task_remaining_units,
  'events.customer_remaining_units': typeProbeR.body?.customer_remaining_units, 'events.reservation_released_units': typeProbeR.body?.reservation_released_units,
  'tasks.ceiling_units': typeProbeT.body?.ceiling_units, 'tasks.used_units': typeProbeT.body?.used_units, 'tasks.reserved_units': typeProbeT.body?.reserved_units,
  'tasks.remaining_units': typeProbeT.body?.remaining_units, 'tasks.usage_missing_calls': typeProbeT.body?.usage_missing_calls,
  'put.ceiling_units': typeProbePut.body?.ceiling_units, 'put.used_units': typeProbePut.body?.used_units,
  'budget.limit': typeProbeB.body?.limit, 'budget.used': typeProbeB.body?.used, 'budget.remaining': typeProbeB.body?.remaining,
  'checkpoint.remaining_units': typeProbeC.body?.remaining_units,
  'decisions.estimated_units': typeProbeD.body?.decisions?.[0]?.estimated_units, 'decisions.blocked_total': typeProbeD.body?.blocked_total,
}
const notNumM = Object.entries(numsM).filter(([, v]) => typeof v !== 'number')
ok('[meter] every unit field on preflight, events, tasks, budget, checkpoint and decisions is a JSON number', notNumM.length === 0, JSON.stringify(Object.fromEntries(notNumM)))

// ---------------------------------------------------------------- [price] list price on the record
// Stage B, 2026-09-24. A record whose metadata names a model call (provider,
// model, tokens: the shape wrap() writes, and any HTTP client may write) is
// priced by the server at public list price from a dated snapshot, and the
// figure is stored beside the snapshot's name. The one rule every gate below
// leans on: a call that cannot be priced is NEVER $0. It stores no figure and
// a sentence saying why, and every reader counts it as unpriced.
{ // [price], in its own block scope so its names cannot collide with the sections above
console.log('\n[price] a model call is priced at list price, exactly, and a call that cannot be priced is never $0')
const { PRICE_VERSION: PV, priceCall: priceCallP, usdFromPico: usdP } = await import('../../dist/lib/prices.js')
const KEYP = (await post('/keys/generate', { label: 'harness-section-price' })).body.api_key
if (typeof KEYP !== 'string' || !KEYP.startsWith('agb_')) throw new Error('[price] could not mint its key')
const callP = (method, path, body) => fetch(`${API}${path}`, {
  method, headers: { 'Authorization': `Bearer ${KEYP}`, 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async r => { const text = await r.text(); let json = null; try { json = JSON.parse(text) } catch {} return { status: r.status, body: json, text } })
let seqP = 0
const keyP = (p) => `${p}-${Date.now()}-${++seqP}`
const recP = (taskRef, metadata, extra = {}) => callP('POST', '/events', {
  customer_id: 'price-c', event_type: 'price', idempotency_key: keyP(taskRef), units: extra.units ?? 1, task_ref: taskRef,
  ...(metadata === undefined ? {} : { metadata }), ...extra,
})
const rowP = async (key) => (await sql`
  SELECT task_ref AS ref, price_version AS version, list_price_usd::text AS usd, price_note AS note, units FROM events
  WHERE account_id = ${ACCT} AND idempotency_key = ${key}`)[0]
const toks = (o) => ({ input: 0, cache_read: 0, cache_write: 0, output: 0, reasoning: 0, ...o })
// One record, then its row, by the key it was sent with.
const pricedRow = async (taskRef, metadata, extra = {}) => {
  const k = keyP(taskRef)
  const r = await callP('POST', '/events', { customer_id: 'price-c', event_type: 'price', idempotency_key: k, units: extra.units ?? 1,
    task_ref: taskRef, ...(metadata === undefined ? {} : { metadata }), ...extra })
  return { answer: r, row: await rowP(k) }
}

await callP('PUT', '/tasks/price-job/ceiling', { ceiling_units: 10_000_000, unit: 'token' })

const mini = await pricedRow('price-job', { provider: 'openai', model: 'gpt-4o-mini-2024-07-18', requested_model: 'gpt-4o-mini', step: 'plan',
  tokens: toks({ input: 1000, cache_read: 200, output: 500 }) }, { units: 1700 })
ok('[price] gpt-4o-mini: 1,000 input, 200 cache read, 500 output is $0.000465 exactly, stored as NUMERIC with the snapshot name',
   mini.row?.usd === '0.000465000000' && mini.row?.version === PV && mini.row?.note === null && mini.row?.ref === 'price-job',
   JSON.stringify(mini.row))
ok('[price] and the record answer is the old answer: pricing adds no key to it',
   Object.keys(mini.answer.body ?? {}).sort().join(',') === 'customer_created,customer_remaining_units,event_id,status,task_exceeded,task_remaining_units,task_used_units',
   Object.keys(mini.answer.body ?? {}).sort().join(','))

const unknown = await pricedRow('price-job', { provider: 'openai', model: 'gpt-9-imaginary', tokens: toks({ input: 10, output: 10 }) }, { units: 20 })
ok('[price] a model the table does not have: no figure, and the note says "no list price for" that model, not $0',
   unknown.row?.usd === null && unknown.row?.note === 'no list price for gpt-9-imaginary' && unknown.row?.version === PV, JSON.stringify(unknown.row))

const zero = await pricedRow('price-job', { provider: 'gemini', model: 'gemma-4-31b-it', tokens: toks({ input: 10, output: 10 }) }, { units: 20 })
ok('[price] a model the table lists at 0 is not priced at $0: the table writes 0 for unknown prices too',
   zero.row?.usd === null && /^no list price for gemma-4-31b-it: the price table lists 0/.test(zero.row?.note ?? ''), JSON.stringify(zero.row))

const longCtx = await pricedRow('price-job', { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929',
  tokens: toks({ input: 150_000, cache_read: 60_000, output: 1_000 }) }, { units: 211_000 })
ok('[price] a 210k-token prompt on claude-sonnet-4-5 is priced at the above-200k rates for every token: $0.9585, not the base $0.483',
   longCtx.row?.usd === '0.958500000000', JSON.stringify(longCtx.row))
const oneHour = await pricedRow('price-job', { provider: 'anthropic', model: 'claude-sonnet-4-5',
  tokens: toks({ input: 1000, cache_write: 1000, cache_write_1h: 1000, output: 100 }) }, { units: 3100 })
ok('[price] a one-hour cache write is priced at its own rate: 1,000 input + 1,000 five-minute + 1,000 one-hour writes + 100 output = $0.01425',
   oneHour.row?.usd === '0.014250000000', JSON.stringify(oneHour.row))

const gap = await pricedRow('price-job', { provider: 'openai', model: 'gpt-5.4', service_tier: 'priority', tokens: toks({ input: 300_000, output: 10 }) }, { units: 300_010 })
ok('[price] above a tier at a service tier the table has no rate for: not priced, and the note names both',
   gap.row?.usd === null && gap.row?.note === 'no list price for gpt-5.4 above 272k input tokens and at service tier priority (input tokens)', JSON.stringify(gap.row))

const flex = await pricedRow('price-job', { provider: 'openai', model: 'gpt-5-mini', service_tier: 'flex', tokens: toks({ input: 1000, output: 100 }) }, { units: 1100 })
ok('[price] a flex call is priced at the flex rates: $0.000225, not the standard $0.00045', flex.row?.usd === '0.000225000000', JSON.stringify(flex.row))
const scale = await pricedRow('price-job', { provider: 'openai', model: 'gpt-5-mini', service_tier: 'scale', tokens: toks({ input: 1000, output: 100 }) }, { units: 1100 })
ok('[price] a service tier the pricer does not know is not priced', scale.row?.usd === null && scale.row?.note === 'no list price for gpt-5-mini at service tier scale', JSON.stringify(scale.row))

const thinking = await pricedRow('price-job', { provider: 'gemini', model: 'gemini-robotics-er-2-preview', step: 'think',
  tokens: toks({ output: 100, reasoning: 60 }) }, { units: 100 })
ok('[price] reasoning with its own rate: 40 output at $5/M + 60 reasoning at $10/M = $0.0008',
   thinking.row?.usd === '0.000800000000', JSON.stringify(thinking.row))

const missingP = await pricedRow('price-job', { provider: 'openai', model: 'gpt-4o-mini' }, { units: 0, usage_missing: true })
ok('[price] usage missing: no figure, and the note says there was nothing to price',
   missingP.row?.usd === null && /^usage missing/.test(missingP.row?.note ?? ''), JSON.stringify(missingP.row))

const compat = await pricedRow('price-job', { provider: 'openai-compatible', model: 'gpt-4o-mini', tokens: toks({ input: 10, output: 10 }) }, { units: 20 })
ok("[price] a call through another host is not priced at OpenAI's list price",
   compat.row?.usd === null && compat.row?.note === "no list price for gpt-4o-mini: it was called through an endpoint other than OpenAI's own API", JSON.stringify(compat.row))

const junk = await pricedRow('price-job', { provider: 'openai', model: 'gpt-4o-mini', tokens: { input: 1.5, output: 'many' } }, { units: 5 })
ok('[price] token counts that are not whole numbers are not priced, and the record still lands',
   junk.answer.status === 200 && junk.row?.usd === null && /whole numbers/.test(junk.row?.note ?? ''), `${junk.answer.status} ${JSON.stringify(junk.row)}`)

const plain = await pricedRow('price-job', undefined, { units: 7 })
ok('[price] a record with no model named is not a model call: task_ref stored, no price columns',
   plain.row?.ref === 'price-job' && plain.row?.usd === null && plain.row?.version === null && plain.row?.note === null, JSON.stringify(plain.row))

// The pure pricer agrees with the stored rows, from the same code the server runs.
const pure = priceCallP({ provider: 'openai', model: 'gpt-4o-mini', tokens: { input: 1000, cache_read: 200, cache_write: 0, cache_write_1h: 0, output: 500, reasoning: 0, audio_input: 0, audio_output: 0 } })
ok('[price] the pricer is exact integer arithmetic: 465,000,000 picodollars', pure.ok === true && pure.picoUsd === 465_000_000n && usdP(pure.picoUsd) === '0.000465000000', JSON.stringify({ ...pure, picoUsd: String(pure.picoUsd) }))

// ---------------------------------------------------------------- [price] the read side
const taskP = await callP('GET', '/tasks/price-job')
const bd = taskP.body?.breakdown
const oldTaskKeys = 'agent_id,ceiling_units,created_at,exceeded,remaining_units,reserved_units,task_ref,unit,updated_at,usage_missing_calls,used_units'
ok('[price] GET /tasks/:task_ref is the old answer plus breakdown, nothing else changed',
   taskP.status === 200 && Object.keys(taskP.body).filter((k) => k !== 'breakdown').sort().join(',') === oldTaskKeys && typeof bd === 'object',
   `${taskP.status} ${Object.keys(taskP.body ?? {}).sort().join(',')}`)
const listP = await callP('GET', '/tasks?limit=5')
ok('[price] the list endpoint carries no breakdown', listP.status === 200 && listP.body.tasks.every((t) => !('breakdown' in t)), JSON.stringify(listP.body?.tasks?.[0] ?? {}))
const expectUsd = 0.000465 + 0.9585 + 0.01425 + 0.000225 + 0.0008
// 13 records on price-job: 5 priced (mini, longCtx, oneHour, flex, thinking), 8 not.
const callsP = 13
ok('[price] the job total is the exact sum of the priced calls, and unpriced calls are counted, never added as $0',
   bd?.calls === callsP && bd?.priced_calls === 5 && bd?.unpriced_calls === 8 && Math.abs(bd?.list_price_usd_estimate - expectUsd) < 1e-12,
   JSON.stringify({ calls: bd?.calls, priced: bd?.priced_calls, unpriced: bd?.unpriced_calls, usd: bd?.list_price_usd_estimate, expectUsd }))
ok('[price] the estimate carries its label and the snapshot it came from',
   /your invoice may differ/.test(bd?.list_price_label ?? '') && /never counted as \$0/.test(bd?.list_price_label ?? '') && JSON.stringify(bd?.price_versions) === JSON.stringify([PV]),
   JSON.stringify({ label: bd?.list_price_label, versions: bd?.price_versions }))
const m4 = bd?.by_model?.find((m) => m.model === 'gpt-4o-mini-2024-07-18')
ok('[price] by model: the gpt-4o-mini row has its tokens by type and its own estimate',
   m4?.provider === 'openai' && m4?.calls === 1 && m4?.units === 1700 && JSON.stringify(m4?.tokens) === JSON.stringify({ input: 1000, cache_read: 200, cache_write: 0, cache_write_1h: 0, output: 500, reasoning: 0 }) && m4?.list_price_usd_estimate === 0.000465,
   JSON.stringify(m4))
const mUnknown = bd?.by_model?.find((m) => m.model === 'gpt-9-imaginary')
ok('[price] a row whose every call is unpriced shows null, not 0, and says why',
   mUnknown?.list_price_usd_estimate === null && mUnknown?.unpriced_calls === 1 && mUnknown?.unpriced_reasons?.[0] === 'no list price for gpt-9-imaginary', JSON.stringify(mUnknown))
const mNone = bd?.by_model?.find((m) => m.model === null)
ok('[price] the record with no model is its own row, unpriced, with that reason',
   mNone?.calls === 1 && mNone?.units === 7 && mNone?.list_price_usd_estimate === null && /no model named/.test(mNone?.unpriced_reasons?.[0] ?? ''), JSON.stringify(mNone))
// openai/gpt-4o-mini holds the usage_missing record and the malformed one; the
// openai-compatible call with the same model name is a row of its own.
const mMissing = bd?.by_model?.find((m) => m.model === 'gpt-4o-mini' && m.provider === 'openai')
const mCompat = bd?.by_model?.find((m) => m.model === 'gpt-4o-mini' && m.provider === 'openai-compatible')
ok('[price] a usage_missing call is counted as such in its row, and a compatible endpoint is a row of its own',
   mMissing?.calls === 2 && mMissing?.usage_missing_calls === 1 && mMissing?.list_price_usd_estimate === null && mCompat?.calls === 1 && mCompat?.list_price_usd_estimate === null,
   JSON.stringify({ mMissing, mCompat }))
const sPlan = bd?.by_step?.find((s) => s.step === 'plan'), sThink = bd?.by_step?.find((s) => s.step === 'think'), sNone = bd?.by_step?.find((s) => s.step === null)
ok('[price] by step: plan, think, and the calls with no step, each with its own estimate',
   sPlan?.calls === 1 && sPlan?.list_price_usd_estimate === 0.000465 && sThink?.list_price_usd_estimate === 0.0008 && sNone?.calls === 11 && bd?.by_step?.length === 3,
   JSON.stringify(bd?.by_step?.map((s) => [s.step, s.calls, s.list_price_usd_estimate])))
const usedP = taskP.body?.used_units
ok('[price] every unit of this job is attributed: unattributed_units is 0 and the rows add up to used_units',
   bd?.unattributed_units === 0 && bd?.units === usedP, `units ${bd?.units} used ${usedP} unattributed ${bd?.unattributed_units}`)
// A job that existed before events carried task_ref: its units are not hidden.
await callP('PUT', '/tasks/price-old/ceiling', { ceiling_units: 1000 })
await sql`UPDATE task_budgets SET used_units = 40 WHERE account_id = ${ACCT} AND task_ref = 'price-old'`
const oldP = (await callP('GET', '/tasks/price-old')).body?.breakdown
ok('[price] units recorded before migration 017 are reported as unattributed, not dropped',
   oldP?.unattributed_units === 40 && oldP?.calls === 0 && oldP?.list_price_usd_estimate === null && Array.isArray(oldP?.by_model) && oldP.by_model.length === 0, JSON.stringify(oldP))

} // end [price]

{ // [wrap], in its own block scope for the same reason
// ---------------------------------------------------------------- [wrap] the Node SDK against this server
// The built Node SDK (sdk/node/dist, built by run.sh), a fake OpenAI client
// shaped like the real one, and everything on AgentBill's side real.
console.log('\n[wrap] wrap() against a real server: the refused call is not sent, the rest is recorded and priced')
const KEYW = (await post('/keys/generate', { label: 'harness-section-wrap' })).body.api_key
if (typeof KEYW !== 'string' || !KEYW.startsWith('agb_')) throw new Error('[wrap] could not mint its key')
process.env.AGENTBILL_BASE_URL = API
process.env.AGENTBILL_API_KEY = KEYW
const { existsSync: existsW } = await import('node:fs')
const sdkPathW = new URL('../../sdk/node/dist/index.js', import.meta.url)
const nodeSdk = existsW(sdkPathW) ? await import(sdkPathW.href) : null
ok('[wrap] the Node SDK is built (run.sh builds sdk/node before this runs)', typeof nodeSdk?.wrap === 'function', sdkPathW.pathname)
const callW = (method, path, body) => fetch(`${API}${path}`, {
  method, headers: { 'Authorization': `Bearer ${KEYW}`, 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))
const runW = Date.now().toString(36)
// jsonb keeps its own key order, so objects read back are compared by entries.
const sameW = (a, b) => a != null && JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort())

if (nodeSdk) {
  // 1,200 tokens a call (1,000 prompt of which 200 cached, 200 completion);
  // ceiling 5,000; default estimate 1,000. Calls 1-4 fit (4,800), and the 5th
  // (4,800 + 1,200 > 5,000) is refused before the fake is called.
  let sentW = 0
  const fakeOpenAI = {
    baseURL: 'https://api.openai.com/v1',
    chat: { completions: { async create(body) {
      sentW++
      if (body.stream) {
        const withUsage = body.stream_options?.include_usage === true
        return { async *[Symbol.asyncIterator]() {
          yield { id: `chatcmpl-w-${runW}-s`, model: 'gpt-4o-mini-2024-07-18', choices: [{ delta: { content: 'a' } }], usage: null }
          if (withUsage) yield { id: `chatcmpl-w-${runW}-s`, model: 'gpt-4o-mini-2024-07-18', choices: [], usage: { prompt_tokens: 40, completion_tokens: 5 } }
        } }
      }
      if (body.messages?.[0]?.content === 'no usage') return { id: `chatcmpl-w-${runW}-nou`, model: 'gpt-4o-mini-2024-07-18', choices: [] }
      return { id: `chatcmpl-w-${runW}-${sentW}`, model: 'gpt-4o-mini-2024-07-18', service_tier: 'default', choices: [{ message: { content: 'x' } }],
        usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 200 }, completion_tokens_details: { reasoning_tokens: 0 } } }
    } } },
  }
  const refW = `wrap-node-${runW}`
  const llmW = nodeSdk.wrap(fakeOpenAI, { taskRef: refW, agentId: 'node-e2e', step: 'plan', taskCeiling: 5_000, defaultEstimate: 1_000 })
  // 2026-09-24 (Lior): a refusal is a value the wrapped call returns, never
  // an exception; exceptions are for failures. So the loop breaks on a
  // returned Refusal, and anything thrown is a red.
  let refusedAt = null, refusalW = null, threwW = null
  for (let i = 1; i <= 8; i++) {
    try {
      const r = await llmW.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'go' }] })
      if (nodeSdk.isRefusal(r)) { refusedAt = i; refusalW = r; break }
    } catch (e) { threwW = e; break }
  }
  ok('[wrap] node: the 5th call comes back as a Refusal (task_ceiling_exceeded, 4,800/5,000, asked 1,200, approved false, no choices, nothing thrown), and the fake provider was sent 4 calls, not 5',
     refusedAt === 5 && threwW === null && refusalW instanceof nodeSdk.Refusal && refusalW.approved === false && refusalW.reason === 'task_ceiling_exceeded' &&
     refusalW.used === 4_800 && refusalW.ceiling === 5_000 && refusalW.remaining === 200 && refusalW.asked === 1_200 && refusalW.taskRef === refW &&
     refusalW.answer?.reason === 'task_ceiling_exceeded' && !('choices' in refusalW) && sentW === 4,
     `refusedAt=${refusedAt} sent=${sentW} threw=${threwW?.name}: ${threwW?.message} ${refusalW}`)
  // A throw here is a FAIL with the error named, never a crash of this script:
  // planted (wrap throwing again) on 2026-09-24 it ended the run at this line
  // and hid every red after it.
  let refusedStreamW = null, refusedChunksW = 0, streamThrewW = null
  try {
    refusedStreamW = await llmW.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'go' }], stream: true })
    for await (const _c of refusedStreamW) refusedChunksW++
  } catch (e) { streamThrewW = e }
  ok('[wrap] node: a streamed call on the same refused job is the Refusal itself, iterates to nothing, and the fake was still sent 4',
     streamThrewW === null && nodeSdk.isRefusal(refusedStreamW) && refusedChunksW === 0 && sentW === 4,
     `threw=${streamThrewW?.name}: ${streamThrewW?.message} isRefusal=${nodeSdk.isRefusal(refusedStreamW)} chunks=${refusedChunksW} sent=${sentW}`)
  const tW = await callW('GET', `/tasks/${refW}`)
  ok('[wrap] node: the job is a tokens job with 4,800 used and nothing left reserved',
     tW.body?.unit === 'token' && tW.body?.used_units === 4_800 && tW.body?.reserved_units === 0 && tW.body?.ceiling_units === 5_000, JSON.stringify(tW.body && { ...tW.body, breakdown: undefined }))
  // metadata as text: the harness pool camel-cases the keys of a jsonb value it parses.
  const evW = (await sql`SELECT idempotency_key, units, list_price_usd::text AS usd, metadata::text AS meta FROM events WHERE task_ref = ${refW} ORDER BY created_at`)
    .map((e) => ({ ...e, metadata: JSON.parse(e.meta) }))
  ok('[wrap] node: 4 events, each keyed by the provider response id, each priced at $0.000255',
     evW.length === 4 && evW.every((e, i) => e.idempotencyKey === `chatcmpl-w-${runW}-${i + 1}` && e.units === 1_200 && e.usd === '0.000255000000'),
     JSON.stringify(evW.map((e) => [e.idempotencyKey, e.units, e.usd])))
  ok('[wrap] node: the metadata on the row is what wrap() sent: provider, model, the token breakdown, step, duration, and nothing of the conversation',
     evW[0]?.metadata?.provider === 'openai' && evW[0]?.metadata?.model === 'gpt-4o-mini-2024-07-18' && evW[0]?.metadata?.step === 'plan' &&
     sameW(evW[0]?.metadata?.tokens, { input: 800, cache_read: 200, cache_write: 0, output: 200, reasoning: 0 }) &&
     Number.isInteger(evW[0]?.metadata?.duration_ms) && !JSON.stringify(evW).includes('"go"'),
     JSON.stringify(evW[0]?.metadata))
  const bW = tW.body?.breakdown
  ok('[wrap] node: GET /tasks breaks the job down by model and by step: 4 calls, $0.00102 at list price',
     bW?.by_model?.length === 1 && bW.by_model[0].model === 'gpt-4o-mini-2024-07-18' && bW.by_model[0].calls === 4 && bW.list_price_usd_estimate === 0.00102 &&
     bW?.by_step?.[0]?.step === 'plan' && bW.by_step[0].tokens.output === 800, JSON.stringify(bW && { ...bW, list_price_label: undefined }))

  // A stream: include_usage turned on, the usage chunk hidden, the call recorded.
  const refS = `wrap-node-stream-${runW}`
  const streamW = nodeSdk.wrap(fakeOpenAI, { taskRef: refS, agentId: 'node-e2e', taskCeiling: 5_000 })
  const seenW = []
  for await (const c of await streamW.chat.completions.create({ model: 'gpt-4o-mini', messages: [], stream: true })) seenW.push(c.choices.length)
  const tS = await callW('GET', `/tasks/${refS}`)
  ok('[wrap] node: a streamed call is recorded from its usage chunk, and the caller never saw that chunk',
     JSON.stringify(seenW) === '[1]' && tS.body?.used_units === 45 && tS.body?.reserved_units === 0, `${JSON.stringify(seenW)} ${JSON.stringify(tS.body && { ...tS.body, breakdown: undefined })}`)

  // No usage: recorded as missing, charged at the reservation, never 0.
  const refN = `wrap-node-nousage-${runW}`
  const nou = nodeSdk.wrap(fakeOpenAI, { taskRef: refN, agentId: 'node-e2e', taskCeiling: 5_000, defaultEstimate: 900 })
  await nou.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'no usage' }] })
  const tN = await callW('GET', `/tasks/${refN}`)
  ok('[wrap] node: a response with no usage is charged its 900-token reservation, counted as usage missing, and not priced',
     tN.body?.used_units === 900 && tN.body?.reserved_units === 0 && tN.body?.usage_missing_calls === 1 &&
     tN.body?.breakdown?.list_price_usd_estimate === null && /^usage missing/.test(tN.body?.breakdown?.by_model?.[0]?.unpriced_reasons?.[0] ?? ''),
     JSON.stringify(tN.body))

  // A job opened in units cannot be counted in tokens: the call is not sent.
  await callW('PUT', `/tasks/wrap-units-${runW}/ceiling`, { ceiling_units: 100 })
  const sentBefore = sentW
  let mismatch = null
  try { await nodeSdk.wrap(fakeOpenAI, { taskRef: `wrap-units-${runW}`, agentId: 'node-e2e' }).chat.completions.create({ model: 'gpt-4o-mini', messages: [] }) } catch (e) { mismatch = e }
  ok('[wrap] node: a job counted in units is a task_unit_mismatch that names both units, and the call is not sent',
     mismatch instanceof nodeSdk.AgentBillError && /422/.test(mismatch.message) && /task_unit_mismatch/.test(mismatch.message) && /tokens/.test(mismatch.message) && sentW === sentBefore,
     `${mismatch?.message} sent ${sentW - sentBefore}`)

  // The account's own monthly quota spent. preflight answers it before it
  // looks at the job, so no ceiling is checked; each wrapped model call is one
  // preflight, so the free tier's 1,000 are 1,000 model calls. Reproduced
  // 2026-09-24 before the fix: 10 calls sent, 0 refused, 12,000 used against a
  // 3,000 ceiling, one warning. On its own account, so the rest keep their quota.
  const ACCT_Q = '00000000-0000-0000-0000-0000000000be'
  const KEY_Q = shapedKey(`wrap-quota-${runW}`)
  await sql`INSERT INTO accounts (id, plan, monthly_calls, billing_period_start) VALUES (${ACCT_Q}, 'free', 0, date_trunc('month', CURRENT_DATE)::date) ON CONFLICT (id) DO UPDATE SET monthly_calls = 0, plan = 'free'`
  await insertKeyRow(sql, ACCT_Q, KEY_Q, 'harness-wrap-quota')
  const refQ = `wrap-quota-${runW}`
  const openQ = await fetch(`${API}/tasks/${refQ}/ceiling`, { method: 'PUT', headers: { 'Authorization': `Bearer ${KEY_Q}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ceiling_units: 3_000, unit: 'token' }) })
  await sql`UPDATE accounts SET monthly_calls = 1000, billing_period_start = date_trunc('month', CURRENT_DATE)::date WHERE id = ${ACCT_Q}`
  const warnedQ = []
  const onWarnQ = (w) => { if (w.name === 'AgentBillWarning') warnedQ.push(w.message) }
  process.on('warning', onWarnQ)
  process.env.AGENTBILL_API_KEY = KEY_Q
  const taskQ = async () => (await sql`SELECT used_units, reserved_units, ceiling_units FROM task_budgets WHERE account_id = ${ACCT_Q} AND task_ref = ${refQ}`)[0]
  try {
    const sentQ0 = sentW
    let spentQ = null, threwQ = null
    try { spentQ = await nodeSdk.wrap(fakeOpenAI, { taskRef: refQ, agentId: 'node-e2e' }).chat.completions.create({ model: 'gpt-4o-mini', messages: [] }) } catch (e) { threwQ = e }
    const tQ = await taskQ()
    ok('[wrap] node: with the monthly quota spent (1,000 of 1,000 on free) the call comes back as a Refusal (free_tier_exceeded) with the upgrade link, nothing thrown, is not sent, and the job is untouched',
       openQ.status === 200 && threwQ === null && nodeSdk.isRefusal(spentQ) && spentQ.reason === 'free_tier_exceeded' && /pricing/.test(spentQ.upgradeUrl ?? '') &&
       spentQ.answer?.plan === 'free' && sentW === sentQ0 && tQ?.usedUnits === 0 && tQ?.reservedUnits === 0,
       `put ${openQ.status} threw=${threwQ?.name}: ${threwQ?.message} got ${spentQ} sent ${sentW - sentQ0} ${JSON.stringify(tQ)}`)
    const llmQ = nodeSdk.wrap(fakeOpenAI, { taskRef: refQ, agentId: 'node-e2e', onQuota: 'send' })
    for (let i = 0; i < 5; i++) await llmQ.chat.completions.create({ model: 'gpt-4o-mini', messages: [] })
    await settle(50)
    const tQ2 = await taskQ()
    const quotaWarnings = warnedQ.filter((w) => /quota/.test(w))
    ok("[wrap] node: onQuota 'send' is the documented carve-out: 5 calls sent unchecked, 6,000 used past the 3,000 ceiling, and one warning that says nothing bounds the job",
       sentW === sentQ0 + 5 && tQ2?.usedUnits === 6_000 && tQ2?.reservedUnits === 0 && quotaWarnings.length === 1 && /nothing bounds the job/.test(quotaWarnings[0] ?? ''),
       `sent ${sentW - sentQ0} ${JSON.stringify(tQ2)} warnings ${JSON.stringify(quotaWarnings)}`)
  } finally {
    process.env.AGENTBILL_API_KEY = KEYW
    process.off('warning', onWarnQ)
  }

  // An OpenAI-compatible server that reuses response ids (Ollama's layer
  // issues chatcmpl-<0..998>). Keyed by that id, calls 2 and 3 were
  // duplicate_ignored: 1,200 used of 3,600, 2,400 held until the TTL.
  let sentC = 0
  const compatible = {
    baseURL: 'http://localhost:11434/v1',
    chat: { completions: { async create() { sentC++; return { id: 'chatcmpl-7', model: 'llama3', choices: [], usage: { prompt_tokens: 1000, completion_tokens: 200 } } } } },
  }
  const refC = `wrap-compatible-${runW}`
  const llmC = nodeSdk.wrap(compatible, { taskRef: refC, agentId: 'node-e2e', taskCeiling: 50_000 })
  for (let i = 0; i < 3; i++) await llmC.chat.completions.create({ model: 'llama3', messages: [] })
  const tC = await callW('GET', `/tasks/${refC}`)
  const keysC = (await sql`SELECT idempotency_key FROM events WHERE task_ref = ${refC}`).map((e) => e.idempotencyKey)
  ok('[wrap] node: a compatible endpoint that repeats one response id: 3 calls, 3 records under 3 keys, 3,600 used, nothing held',
     sentC === 3 && tC.body?.used_units === 3_600 && tC.body?.reserved_units === 0 && tC.body?.breakdown?.calls === 3 && new Set(keysC).size === 3,
     `sent ${sentC} ${JSON.stringify(tC.body && { ...tC.body, breakdown: tC.body.breakdown?.calls })} keys ${keysC.join(' ')}`)

  // The provider's own API reusing an id is not expected, but a duplicate on
  // a record wrap() made once is a collision whatever the endpoint.
  const officialDup = {
    baseURL: 'https://api.openai.com/v1',
    chat: { completions: { async create() { return { id: `chatcmpl-dup-${runW}`, model: 'gpt-4o-mini-2024-07-18', choices: [], usage: { prompt_tokens: 1000, completion_tokens: 200 } } } } },
  }
  const refD = `wrap-dup-${runW}`
  const llmD = nodeSdk.wrap(officialDup, { taskRef: refD, agentId: 'node-e2e', taskCeiling: 50_000 })
  await llmD.chat.completions.create({ model: 'gpt-4o-mini', messages: [] })
  await llmD.chat.completions.create({ model: 'gpt-4o-mini', messages: [] })
  const tD = await callW('GET', `/tasks/${refD}`)
  ok('[wrap] node: a response id the server already has is re-recorded under a random key, so both calls count and nothing is held',
     tD.body?.used_units === 2_400 && tD.body?.reserved_units === 0 && tD.body?.breakdown?.calls === 2,
     JSON.stringify(tD.body && { ...tD.body, breakdown: tD.body.breakdown?.calls }))

  // OpenAI cache writes: 40,400 of a 50,000-token gpt-5.6 prompt written to
  // the cache, priced at the table's cache-write rate ($5/M) and not as input
  // ($4/M): 1,600 x 4e-6 + 8,000 x 4e-7 + 40,400 x 5e-6 + 400 x 2e-5 = $0.2196.
  // Read as uncached input it was $0.1792.
  const cacheWriter = {
    baseURL: 'https://api.openai.com/v1',
    chat: { completions: { async create() { return { id: `chatcmpl-cw-${runW}`, model: 'gpt-5.6', service_tier: 'default', choices: [],
      usage: { prompt_tokens: 50_000, completion_tokens: 400, prompt_tokens_details: { cached_tokens: 8_000, cache_write_tokens: 40_400 } } } } } },
  }
  const refP = `wrap-cachewrite-${runW}`
  await nodeSdk.wrap(cacheWriter, { taskRef: refP, agentId: 'node-e2e', taskCeiling: 500_000 }).chat.completions.create({ model: 'gpt-5.6', messages: [] })
  const evP = (await sql`SELECT units, list_price_usd::text AS usd, metadata::text AS meta FROM events WHERE task_ref = ${refP}`).map((e) => ({ ...e, metadata: JSON.parse(e.meta) }))
  ok('[price] gpt-5.6 with cache writes is priced at the cache-write rate: 40,400 cache_write tokens, $0.2196 at list price',
     evP.length === 1 && evP[0].units === 50_400 && evP[0].usd === '0.219600000000' &&
     sameW(evP[0].metadata?.tokens, { input: 1_600, cache_read: 8_000, cache_write: 40_400, output: 400, reasoning: 0 }),
     JSON.stringify(evP.map((e) => [e.units, e.usd, e.metadata?.tokens])))

  // Gemini automatic function calling: one generateContent, three model
  // requests, only the last response returned. Shaped like @google/genai's
  // Models (public methods are arrows bound in the constructor, each round is
  // this.generateContentInternal). Before the fix: 1 preflight, 1 record of
  // the last round's usage.
  class GenAIModelsW {
    constructor(apiClient) {
      this.apiClient = apiClient
      this.generateContent = async (params) => {
        let r
        for (let i = 0; i < 3; i++) { r = await this.generateContentInternal(params); if (!r.functionCalls) break }
        return r
      }
      this.generateContentStream = async (params) => this.generateContentStreamInternal(params)
    }
    async generateContentInternal() {
      const i = this.apiClient.sent++
      return { responseId: `gem-afc-${runW}-${i}`, modelVersion: 'gemini-2.5-flash', functionCalls: i < 2 ? [{ name: 'lookup' }] : undefined,
        usageMetadata: { promptTokenCount: 1000 + 100 * i, candidatesTokenCount: 50 } }
    }
    async generateContentStreamInternal() { return (async function* () {})() }
  }
  const apiW = { sent: 0 }
  const refG = `wrap-gemini-afc-${runW}`
  const gemW = nodeSdk.wrap({ models: new GenAIModelsW(apiW) }, { taskRef: refG, agentId: 'node-e2e', taskCeiling: 50_000, provider: 'gemini' })
  const lastG = await gemW.models.generateContent({ model: 'gemini-2.5-flash', contents: 'x', config: { tools: [{ callTool: async () => [] }] } })
  const tG = await callW('GET', `/tasks/${refG}`)
  ok('[wrap] node: gemini automatic function calling is measured per round: 3 requests, 3 records, 3,450 used, the caller gets the last response',
     apiW.sent === 3 && lastG?.responseId === `gem-afc-${runW}-2` && tG.body?.used_units === 3_450 && tG.body?.reserved_units === 0 && tG.body?.breakdown?.calls === 3,
     `sent ${apiW.sent} ${JSON.stringify(tG.body && { ...tG.body, breakdown: tG.body.breakdown?.calls })}`)
}

// ---------------------------------------------------------------- [wrap] the Python SDK against this server
const { spawnSync: spawnW } = await import('node:child_process')
const PYW = process.env.WRAP_PYTHON
const sdkPyW = new URL('../../sdk/python', import.meta.url).pathname
const e2eW = new URL('./wrap_e2e.py', import.meta.url).pathname
// Scenario C needs an account whose monthly quota is spent, planted here.
const ACCT_QP = '00000000-0000-0000-0000-0000000000bf'
const KEY_QP = shapedKey(`wrap-quota-py-${runW}`)
await sql`INSERT INTO accounts (id, plan, monthly_calls, billing_period_start) VALUES (${ACCT_QP}, 'free', 1000, date_trunc('month', CURRENT_DATE)::date) ON CONFLICT (id) DO UPDATE SET monthly_calls = 1000, plan = 'free', billing_period_start = date_trunc('month', CURRENT_DATE)::date`
await insertKeyRow(sql, ACCT_QP, KEY_QP, 'harness-wrap-quota-py')
const pyRun = PYW ? spawnW(PYW, [e2eW, runW], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, PYTHONPATH: sdkPyW, AGENTBILL_BASE_URL: API, AGENTBILL_API_KEY: KEYW, AGENTBILL_QUOTA_KEY: KEY_QP } }) : null
let pyOut = null
try { pyOut = JSON.parse((pyRun?.stdout ?? '').trim().split('\n').pop()) } catch {}
ok('[wrap] python: the e2e script ran (run.sh sets WRAP_PYTHON to a venv with requests and httpx)',
   pyRun?.status === 0 && pyOut !== null, PYW ? `status ${pyRun?.status} ${(pyRun?.stderr ?? '').slice(-400)}` : 'WRAP_PYTHON is not set')
if (pyOut) {
  const refP = pyOut.sync?.refused
  ok('[wrap] python: the 4th Anthropic call comes back as a Refusal (task_ceiling_exceeded, 3,900/4,000, asked 1,300, falsy, no content, nothing raised), and the fake was sent 3',
     pyOut.sync?.sent === 3 && pyOut.sync?.raised == null && refP?.at_call === 4 && refP?.type === 'Refusal' && refP?.reason === 'task_ceiling_exceeded' &&
     refP?.used === 3_900 && refP?.ceiling === 4_000 && refP?.remaining === 100 && refP?.asked === 1_300 && refP?.falsy === true && refP?.has_content === false &&
     refP?.answer_reason === 'task_ceiling_exceeded', JSON.stringify(pyOut.sync))
  ok('[wrap] python: a streamed call on the same refused job is the Refusal itself, iterates to nothing, and the fake was still sent 3',
     pyOut.sync?.stream?.type === 'Refusal' && pyOut.sync?.stream?.items === 0 && pyOut.sync?.stream?.sent === 3, JSON.stringify(pyOut.sync?.stream))
  const tPy = await callW('GET', `/tasks/wrap-py-${runW}`)
  const evPy = await sql`SELECT idempotency_key, units, list_price_usd::text AS usd FROM events WHERE task_ref = ${`wrap-py-${runW}`} ORDER BY created_at`
  ok('[wrap] python: 3 records of 1,300 tokens, keyed by the message id, each $0.00738 at list price, nothing left reserved',
     tPy.body?.unit === 'token' && tPy.body?.used_units === 3_900 && tPy.body?.reserved_units === 0 && evPy.length === 3 &&
     evPy.every((e, i) => e.idempotencyKey === `msg_e2e_${runW}_${i + 1}` && e.units === 1_300 && e.usd === '0.007380000000'),
     JSON.stringify({ task: tPy.body && { ...tPy.body, breakdown: undefined }, ev: evPy }))
  const pre3 = (await sql`SELECT estimated_units FROM preflight_decisions WHERE account_id = ${ACCT} AND task_ref = ${`wrap-py-${runW}`}`)[0]
  ok('[wrap] python: the refused preflight asked for the running average, 1,300, not a number the developer typed',
     pre3?.estimatedUnits === 1_300, JSON.stringify(pre3))
  const tPyS = await callW('GET', `/tasks/wrap-py-stream-${runW}`)
  ok('[wrap] python: an async stream is recorded from the usage chunk wrap() asked for, and the caller saw only the text chunks',
     JSON.stringify(pyOut.async_stream?.texts) === '["he","llo"]' && pyOut.async_stream?.include_usage === true && tPyS.body?.used_units === 69 && tPyS.body?.reserved_units === 0,
     JSON.stringify({ out: pyOut.async_stream, task: tPyS.body && { ...tPyS.body, breakdown: undefined } }))
  const eventsQP = await sql`SELECT count(*)::int AS n FROM events WHERE account_id = ${ACCT_QP}`
  ok('[wrap] python: with the monthly quota spent, wrap() returns a Refusal (free_tier_exceeded) with the upgrade link, raises nothing, the fake was sent nothing, and nothing was recorded',
     pyOut.quota?.returned === 'Refusal' && pyOut.quota?.reason === 'free_tier_exceeded' && pyOut.quota?.raised == null &&
     /pricing/.test(pyOut.quota?.upgrade_url ?? '') && pyOut.quota?.sent === 0 && eventsQP[0]?.n === 0,
     JSON.stringify({ quota: pyOut.quota, events: eventsQP }))
  const tPyB = await callW('GET', `/tasks/wrap-py-break-${runW}`)
  ok('[wrap] python: a for loop that breaks, with no close() and no with-block, is recorded as usage missing and holds nothing',
     tPyB.body?.used_units === 700 && tPyB.body?.reserved_units === 0 && tPyB.body?.usage_missing_calls === 1,
     JSON.stringify(tPyB.body && { ...tPyB.body, breakdown: undefined }))
  const tPyC = await callW('GET', `/tasks/wrap-py-compatible-${runW}`)
  ok('[wrap] python: a compatible endpoint that repeats one response id: 3 calls, 3 records, 3,600 used, nothing held',
     pyOut.compatible?.sent === 3 && tPyC.body?.used_units === 3_600 && tPyC.body?.reserved_units === 0 && tPyC.body?.breakdown?.calls === 3,
     JSON.stringify(tPyC.body && { ...tPyC.body, breakdown: tPyC.body.breakdown?.calls }))
  const tPyG = await callW('GET', `/tasks/wrap-py-afc-${runW}`)
  ok('[wrap] python: gemini automatic function calling is measured per round: 3 requests, 3 records, 3,450 used, the caller gets the last response',
     pyOut.afc?.sent === 3 && pyOut.afc?.last === `gem-py-afc-${runW}-2` && tPyG.body?.used_units === 3_450 && tPyG.body?.reserved_units === 0 && tPyG.body?.breakdown?.calls === 3,
     JSON.stringify({ out: pyOut.afc, task: tPyG.body && { ...tPyG.body, breakdown: tPyG.body.breakdown?.calls } }))
}
} // end [wrap]

// ---------------------------------------------------------------- every answer sent once
// Found while fixing the replay above, 2026-09-23. replay() returned the
// Fastify reply, which is a thenable that resolves to undefined once sent, so
// `if (await replay())` never took the early return: every replayed preflight
// fell through into the reserve transaction, lost the claim and tried to
// answer twice more. The claim kept it from reserving; the server logged
// "Reply was already sent" each time, and nothing read the log. This does,
// after every section above has run. Last, so it sees all of them.
await settle(300)
const { readFileSync: readServerLog } = await import('node:fs')
const SERVER_LOG_M = process.env.SERVER_LOG ?? '/tmp/agentbill-verify-server.log'
let serverLogM = ''
try { serverLogM = readServerLog(SERVER_LOG_M, 'utf8') } catch {}
const doubleSendsM = serverLogM.match(/Reply was already sent[^"]*"[^"]*"[^"]*"[^"]*"/g) ?? []
ok('[meter] the server answered every request once: no "Reply was already sent" anywhere in its log',
   serverLogM.length > 0 && doubleSendsM.length === 0,
   `${doubleSendsM.length} in ${SERVER_LOG_M} (${serverLogM.length} bytes) ${doubleSendsM.slice(0, 1).join('')}`)


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
// Claude Code left this pattern on 2026-09-25: the remote MCP endpoint is a
// thing Claude Code connects to, and /integrations/mcp names it beside a
// command checked against its current documentation. It is still banned on
// every other page here, and n8n everywhere: nothing we ship installs into it.
const NAMED11 = /\bn8n\b/gi
const CLAUDE_CODE11 = /\bclaude[\s_-]*code\b/gi
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
  ok('[integrations] n8n is named nowhere on these pages: nothing we ship installs into it',
     pages11.length > 0 && h.length === 0, [...new Set(h)].join('; '))
  const cc = pages11.filter((p) => p.path !== '/integrations/mcp')
    .flatMap((p) => [p.prose, p.main, p.code].flatMap((t) => (t.match(CLAUDE_CODE11) ?? []).map((w) => `${p.path}: ${w}`)))
  const mcpMain = pages11.find((p) => p.path === '/integrations/mcp')?.main ?? ''
  ok('[integrations] Claude Code is named on /integrations/mcp alone, and there beside the command its docs give',
     cc.length === 0 && mcpMain.includes('claude mcp add --transport http agentbill https://agentbill.dev/mcp'), [...new Set(cc)].join('; '))
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

// ---------------------------------------------------------------- suggest: a ceiling from the account's own finished jobs, 2026-09-23
// The task budgets view lists, per agent, the p50, p90 and max used_units of
// its last HISTORY_JOBS finished jobs (spent units, no reservation, not the
// console placeholder label), in units, and a click puts one in the ceiling
// field, still editable. Nothing here writes, and ?demo=1 shows the same
// suggestion worked out from the sample rows. Each gate below was made red
// once by a planted break and green again after restoring from a copy; the
// breaks are listed in the commit that added them.
console.log('\n[suggest] a suggested ceiling from the account\'s own finished jobs, in units')
await reset()
const { HISTORY_JOBS: JOBS_S, HISTORY_AGENTS: AGENTS_S, percentileDisc: pdS } = await import('../../dist/lib/ceiling-suggest.js')
const { RESERVATION_TTL_MINUTES: TTL_S } = await import('../../dist/lib/reservations.js')
const getS = (path, cookie = cookie8) => nav8(path, { headers: cookie ? { cookie } : {} }).then(async (r) => ({ status: r.status, html: await r.text() }))
// visible8 turns every tag into a space, so "used_units</code>, as" reads
// "used_units , as"; a browser draws no space there, and neither does this.
const shownS = (h) => visible8(h).replace(/\s+/g, ' ').replace(/ ([,.;:])/g, '$1').trim()
// The suggestion block, from its frame to the form's own fine print after it.
const histOfS = (h) => {
  const a = h.indexOf('<div class="hist">')
  if (a === -1) return ''
  const b = h.indexOf('<p class="fine">One job, one budget', a)
  return h.slice(a, b === -1 ? undefined : b)
}
// One row per agent: its label, the agent as printed, and each figure's name,
// number and link. A one-job row has one figure, named "one" here.
const rowsOfS = (block) => [...block.matchAll(/<div class="hrow"><span class="hw">([^<]*)<b class="ha">([^<]*)<\/b><\/span><span class="hp">([\s\S]*?)<\/span><\/div>/g)]
  .map((m) => ({
    label: m[1], agent: m[2],
    figs: Object.fromEntries([...m[3].matchAll(/<a class="pk[^"]*" href="[^"]*"[^>]*>(p50 |p90 |max |)<b>([0-9,]+)<\/b><\/a>/g)].map((f) => [f[1].trim() || 'one', f[2]])),
    hrefs: [...m[3].matchAll(/href="([^"]*)"/g)].map((f) => f[1]),
  }))
const rowOfS = (block, agent) => rowsOfS(block).find((r) => r.agent === agent)
const figsS = (r) => (r ? JSON.stringify(r.figs) : 'no row')
const ceilFieldS = (h) => (h.match(/<input id="t-ceil"[^>]*>/) ?? [''])[0]
const agentFieldS = (h) => (h.match(/<input id="t-agent"[^>]*>/) ?? [''])[0]
const pickLineS = (h) => (h.match(/<p class="conv">[\s\S]*?<\/p>/) ?? [''])[0]

// Another account, whose finished jobs sit under this account's agent label
// and one of its own, each with a count no job here has. Present from the
// start, so the "hidden" gate below reads an account whose neighbour HAS history.
const OTHER_S = '00000000-0000-0000-0000-0000000000ee'
await sql`INSERT INTO accounts (id, plan, default_budget_units, monthly_calls, billing_period_start)
          VALUES (${OTHER_S}, 'free', NULL, 0, date_trunc('month', CURRENT_DATE)::date) ON CONFLICT (id) DO NOTHING`
await sql`INSERT INTO task_budgets (account_id, agent_id, task_ref, ceiling_units, used_units, reserved_units, updated_at)
          VALUES (${OTHER_S}, 'summarizer', 'sg-b-1', 100000, 5555, 0, now()), (${OTHER_S}, 'tenant-b-agent', 'sg-b-2', 100000, 4242, 0, now())`

// Hidden without history: jobs exist on this account and none is finished.
// One opened and never spent under, one with a call in flight (spent, then
// reserved again through the real preflight path), one spent under the
// console's placeholder label. Each stays in the fixture below as a row that
// must not count.
await putCeil('sg-zero', { ceiling_units: 50, agent_id: 'crawler' })
await putCeil('sg-flight', { ceiling_units: 100000, agent_id: 'summarizer' })
await pre8({ agent_id: 'summarizer', task_ref: 'sg-flight', estimated_units: 7777, idempotency_key: 'sg-flight-pre-1' })
await rec8({ customer_id: 'default', event_type: 'llm', idempotency_key: 'sg-flight-rec-1', units: 7777, task_ref: 'sg-flight' })
await pre8({ agent_id: 'summarizer', task_ref: 'sg-flight', estimated_units: 5, idempotency_key: 'sg-flight-pre-2' })
await sql`INSERT INTO task_budgets (account_id, agent_id, task_ref, ceiling_units, used_units, reserved_units)
          VALUES (${ACCT}, 'console', 'sg-console', 100000, 8888, 0)`
const flightS = await task8('sg-flight')
const bareS = await getS('/app?view=tasks')
const barePickS = await getS('/app?view=tasks&history=summarizer&pick=p90')
ok('[suggest] hidden while no job on this account is finished: jobs exist, one in flight, one never spent under, one under the console label, and a neighbour account has history',
   bareS.status === 200 && flightS?.usedUnits === 7777 && flightS?.reservedUnits === 5
     && bareS.html.includes('sg-flight') && bareS.html.includes('sg-zero') && bareS.html.includes('action="/app/tasks"')
     && !bareS.html.includes('class="hist"') && !bareS.html.includes('Suggested ceilings') && !bareS.html.includes('from your last')
     && !bareS.html.includes('A suggested ceiling is')
     && !/<input id="t-ceil"[^>]*value=/.test(ceilFieldS(barePickS.html)) && pickLineS(barePickS.html) === '',
   `${bareS.status} ${JSON.stringify(flightS)} hist=${bareS.html.includes('class="hist"')} | ${histOfS(bareS.html).slice(0, 200)}`)

// The fixture. summarizer: 21 finished jobs, the oldest far outside the rest
// (99,999), so it must fall off the last 20; the newer twenty used 10, 20,
// ..., 200, so p50 is the 10th smallest (100), p90 the 18th (180), max 200.
// crawler: two jobs written here and one settled through the real PUT,
// preflight and record path: 30, 40, 50, so p50 40, p90 50, max 50, and a
// counted sg-zero (0) would make that four jobs and a p50 of 30. And an agent
// label made of markup, opened and settled through the real path: one job, 30.
// And a second markup label with two jobs, 60 and 70, one of them through the
// real path, because the line under the form has one branch for an agent with
// one job and another for an agent with several, and each prints the label.
// Then agents whose latest job is older than any of those, enough to make one
// more agent than HISTORY_AGENTS: the oldest must get no row.
for (let i = 0; i < 21; i++) {
  await sql`INSERT INTO task_budgets (account_id, agent_id, task_ref, ceiling_units, used_units, reserved_units, updated_at)
            VALUES (${ACCT}, 'summarizer', ${`sg-s-${i}`}, 100000, ${i === 0 ? 99999 : i * 10}, 0, now() - ${`${200 - i} minutes`}::interval)`
}
await sql`INSERT INTO task_budgets (account_id, agent_id, task_ref, ceiling_units, used_units, reserved_units, updated_at)
          VALUES (${ACCT}, 'crawler', 'sg-c-1', 1000, 30, 0, now() - interval '150 minutes'),
                 (${ACCT}, 'crawler', 'sg-c-2', 1000, 50, 0, now() - interval '140 minutes')`
await putCeil('sg-c-api', { ceiling_units: 100, agent_id: 'crawler' })
await pre8({ agent_id: 'crawler', task_ref: 'sg-c-api', estimated_units: 40, idempotency_key: 'sg-c-api-pre' })
await rec8({ customer_id: 'default', event_type: 'llm', idempotency_key: 'sg-c-api-rec', units: 40, task_ref: 'sg-c-api' })
const HOSTILE_S = '"><img src=x>'
const HOSTILE_ESC_S = '&quot;&gt;&lt;img src=x&gt;'
const HOSTILE_URI_S = encodeURIComponent(HOSTILE_S)
const hostilePutS = await putCeil('sg-hostile', { ceiling_units: 100, agent_id: HOSTILE_S })
await pre8({ agent_id: HOSTILE_S, task_ref: 'sg-hostile', estimated_units: 30, idempotency_key: 'sg-hostile-pre' })
await rec8({ customer_id: 'default', event_type: 'llm', idempotency_key: 'sg-hostile-rec', units: 30, task_ref: 'sg-hostile' })
const HOSTILE2_S = "'><img src=y style=z>"
const HOSTILE2_ESC_S = '&#39;&gt;&lt;img src=y style=z&gt;'
const HOSTILE2_URI_S = encodeURIComponent(HOSTILE2_S)
await sql`INSERT INTO task_budgets (account_id, agent_id, task_ref, ceiling_units, used_units, reserved_units, updated_at)
          VALUES (${ACCT}, ${HOSTILE2_S}, 'sg-hostile2-a', 1000, 60, 0, now() - interval '100 minutes')`
const hostile2PutS = await putCeil('sg-hostile2-b', { ceiling_units: 100, agent_id: HOSTILE2_S })
await pre8({ agent_id: HOSTILE2_S, task_ref: 'sg-hostile2-b', estimated_units: 70, idempotency_key: 'sg-hostile2-pre' })
await rec8({ customer_id: 'default', event_type: 'llm', idempotency_key: 'sg-hostile2-rec', units: 70, task_ref: 'sg-hostile2-b' })
// summarizer, crawler and the two markup labels are four agents, the newest
// job of each at most 180 minutes old. Each filler's one job is older than
// that, and the last filler's is the oldest of all, so it is the one left out.
const FILLERS_S = Array.from({ length: Math.max(1, AGENTS_S + 1 - 4) }, (_, j) => ({ agent: `sg-old-${j + 1}`, used: 6101 + j, mins: 300 + 10 * j }))
for (const f of FILLERS_S) {
  await sql`INSERT INTO task_budgets (account_id, agent_id, task_ref, ceiling_units, used_units, reserved_units, updated_at)
            VALUES (${ACCT}, ${f.agent}, ${`sg-job-${f.agent}`}, 100000, ${f.used}, 0, now() - ${`${f.mins} minutes`}::interval)`
}
const DROPPED_S = FILLERS_S[FILLERS_S.length - 1]

const pageS = await getS('/app?view=tasks')
const blockS = histOfS(pageS.html)
const sumS = rowOfS(blockS, 'summarizer')
const crawlS = rowOfS(blockS, 'crawler')
const hostRowS = rowOfS(blockS, HOSTILE_ESC_S)
const host2RowS = rowOfS(blockS, HOSTILE2_ESC_S)
// Every figure shown is one real finished job's used_units under that agent
// on this account, read back from the table with a query of the gate's own.
const realS = async (agent) => new Set((await sql`SELECT used_units FROM task_budgets WHERE account_id = ${ACCT} AND agent_id = ${agent}
                                                AND used_units > 0 AND reserved_units = 0`).map((r) => r.usedUnits.toLocaleString('en-US')))
const sumRealS = await realS('summarizer')
const crawlRealS = await realS('crawler')
ok('[suggest] p50, p90 and max come from the right rows: an agent\'s last 20 finished jobs, never one in flight, never one with nothing spent, never an older one, never the console label',
   pageS.status === 200
     && sumS?.label === 'from your last 20 jobs of ' && sumS.figs.p50 === '100' && sumS.figs.p90 === '180' && sumS.figs.max === '200'
     && crawlS?.label === 'from your last 3 jobs of ' && crawlS.figs.p50 === '40' && crawlS.figs.p90 === '50' && crawlS.figs.max === '50'
     && hostRowS?.label === 'from your last job of ' && hostRowS.figs.one === '30' && Object.keys(hostRowS.figs).length === 1
     && !/99,999|7,777|8,888/.test(blockS) && !rowOfS(blockS, 'console')
     && Object.values(sumS.figs).every((v) => sumRealS.has(v)) && Object.values(crawlS.figs).every((v) => crawlRealS.has(v)),
   `summarizer ${figsS(sumS)} "${sumS?.label}", crawler ${figsS(crawlS)} "${crawlS?.label}", markup ${figsS(hostRowS)}, rows ${rowsOfS(blockS).map((r) => r.agent).join(' | ') || blockS.slice(0, 200)}`)

// The rank rule on its own, against Postgres's percentile_disc, which is what
// p50 and p90 mean here: 400 sets of 1 to 40 values with repeats.
let seedS = 20260923
const randS = (n) => { seedS ^= seedS << 13; seedS ^= seedS >>> 17; seedS ^= seedS << 5; return (seedS >>> 0) % n }
const setsS = Array.from({ length: 400 }, (_, i) => Array.from({ length: 1 + (i % 40) }, () => 1 + randS(300)))
const pgS = await sql`
  SELECT t.i, percentile_disc(0.5) WITHIN GROUP (ORDER BY t.v) AS p50, percentile_disc(0.9) WITHIN GROUP (ORDER BY t.v) AS p90
  FROM (SELECT (e.ord - 1)::int AS i, x.value::int AS v
        FROM json_array_elements((${JSON.stringify(setsS)}::text)::json) WITH ORDINALITY AS e(arr, ord),
             json_array_elements_text(e.arr) AS x(value)) t
  GROUP BY t.i ORDER BY t.i`
const rankMissS = pgS.filter((r) => {
  const sorted = [...setsS[r.i]].sort((a, b) => a - b)
  return pdS(sorted, 50) !== Number(r.p50) || pdS(sorted, 90) !== Number(r.p90)
}).map((r) => `n=${setsS[r.i].length}: pg ${r.p50}/${r.p90}, ours ${pdS([...setsS[r.i]].sort((a, b) => a - b), 50)}/${pdS([...setsS[r.i]].sort((a, b) => a - b), 90)}`)
ok('[suggest] p50 and p90 are Postgres\'s percentile_disc over 400 random sets of 1 to 40 values, so every figure is a value a job used',
   pgS.length === 400 && rankMissS.length === 0, rankMissS.slice(0, 3).join('; ') || `${pgS.length} sets`)

// Isolation: the neighbour's 5,555 under this account's own label and its
// 4,242 under a label of its own never reach this page, and a link naming
// the neighbour's agent fills nothing.
const foreignPickS = await getS('/app?view=tasks&history=tenant-b-agent&pick=max')
ok('[suggest] another account\'s jobs never count: not under this account\'s agent label, not under its own, and a pick naming its agent fills nothing',
   !pageS.html.includes('tenant-b-agent') && !pageS.html.includes('5,555') && !pageS.html.includes('4,242')
     && sumS?.label === 'from your last 20 jobs of ' && sumS.figs.max === '200' && sumS.figs.p50 === '100'
     && !/<input id="t-ceil"[^>]*value=/.test(ceilFieldS(foreignPickS.html)) && pickLineS(foreignPickS.html) === ''
     && !foreignPickS.html.includes('5,555') && !foreignPickS.html.includes('4,242'),
   `tenant-b-agent ${pageS.html.includes('tenant-b-agent')}, 5,555 ${pageS.html.includes('5,555')}, 4,242 ${pageS.html.includes('4,242')}, summarizer ${figsS(sumS)}, foreign pick "${ceilFieldS(foreignPickS.html)}"`)

// Escaping: a label made of markup is text in its row and its link, and,
// once picked, in the agent field and the line under the form.
// The line under the form has two branches, one job and several, and both
// print the label, so a markup label is picked in each: the one-job label
// above, and the second, whose two jobs are 60 and 70 (p90 70).
const hostPickS = await getS(`/app?view=tasks&history=${HOSTILE_URI_S}&pick=max`)
const host2PickS = await getS(`/app?view=tasks&history=${HOSTILE2_URI_S}&pick=p90`)
const rawImgS = (h) => (h.match(/[^\n]*<img src=[xy][^\n]*/) ?? [''])[0].slice(0, 200)
ok('[suggest] an agent label made of markup is printed as text: in its row, its link, the agent field and the line under the form, for an agent with one job and for one with several',
   hostilePutS.status === 200 && !pageS.html.includes('<img src=x>') && !hostPickS.html.includes('<img src=x>')
     && blockS.includes(`<b class="ha">${HOSTILE_ESC_S}</b>`) && (hostRowS?.hrefs[0] ?? '').includes(`history=${HOSTILE_URI_S}&amp;pick=max`)
     && agentFieldS(hostPickS.html).includes(`value="${HOSTILE_ESC_S}"`) && /value="30"/.test(ceilFieldS(hostPickS.html))
     && pickLineS(hostPickS.html).includes(`what your last job of ${HOSTILE_ESC_S} used`)
     && hostile2PutS.status === 200 && !pageS.html.includes('<img src=y') && !host2PickS.html.includes('<img src=y')
     && host2RowS?.label === 'from your last 2 jobs of ' && host2RowS.figs.p50 === '60' && host2RowS.figs.p90 === '70' && host2RowS.figs.max === '70'
     && (host2RowS.hrefs[1] ?? '').includes(`history=${HOSTILE2_URI_S}&amp;pick=p90`)
     && agentFieldS(host2PickS.html).includes(`value="${HOSTILE2_ESC_S}"`) && /value="70"/.test(ceilFieldS(host2PickS.html))
     && pickLineS(host2PickS.html).includes(`the p90 of your last 2 jobs of ${HOSTILE2_ESC_S},`),
   `${hostilePutS.status}/${hostile2PutS.status} one job: ${rawImgS(hostPickS.html) || pickLineS(hostPickS.html) || 'no line'} | two jobs ${figsS(host2RowS)}: ${rawImgS(host2PickS.html) || pickLineS(host2PickS.html) || 'no line'}`)

// The cap. At most HISTORY_AGENTS agents get a row, the ones whose latest
// finished jobs are the most recent. The fixture has one agent more than
// that, and the one whose job is oldest gets no row, no figure in the block,
// and a pick naming it fills nothing. The fine print and /docs print the same
// constant (the wording gate below), so a reader with one agent too many can
// tell why it is missing.
const keptS = ['summarizer', 'crawler', HOSTILE_ESC_S, HOSTILE2_ESC_S, ...FILLERS_S.slice(0, -1).map((f) => f.agent)]
const droppedPickS = await getS(`/app?view=tasks&history=${DROPPED_S.agent}&pick=max`)
const droppedRealS = await realS(DROPPED_S.agent)
ok(`[suggest] at most ${AGENTS_S} agents get a row, the ones whose latest finished jobs are the most recent: of ${keptS.length + 1} agents with finished jobs, the one whose job is oldest gets no row and a pick naming it fills nothing`,
   rowsOfS(blockS).length === AGENTS_S && keptS.length === AGENTS_S && keptS.every((a) => rowOfS(blockS, a))
     && !rowOfS(blockS, DROPPED_S.agent) && !blockS.includes(DROPPED_S.used.toLocaleString('en-US')) && droppedRealS.size === 1 && droppedRealS.has(DROPPED_S.used.toLocaleString('en-US'))
     && !/<input id="t-ceil"[^>]*value=/.test(ceilFieldS(droppedPickS.html)) && pickLineS(droppedPickS.html) === '',
   `${rowsOfS(blockS).length} rows: ${rowsOfS(blockS).map((r) => r.agent).join(' | ')} | dropped ${DROPPED_S.agent} row ${Boolean(rowOfS(blockS, DROPPED_S.agent))}, pick "${ceilFieldS(droppedPickS.html)}"`)

// A click fills the field. Picking p90 puts 180 and the summarizer label in
// the form, both editable, marks the figure that is in the field, writes
// nothing, and a pick the rows do not back fills nothing. Then the form saves
// it through the one write it always had.
const countS = async () => Number((await sql`SELECT count(*) AS n FROM task_budgets WHERE account_id = ${ACCT}`)[0].n)
const beforeS = await countS()
const pickedS = await getS('/app?view=tasks&history=summarizer&pick=p90')
const afterS = await countS()
const noFillS = async (q) => { const h = (await getS(`/app?view=tasks&${q}`)).html; return !/<input id="t-ceil"[^>]*value=/.test(ceilFieldS(h)) && pickLineS(h) === '' }
const unbackedS = await Promise.all(['history=nobody&pick=p90', 'history=summarizer&pick=p99', 'history=console&pick=max', 'pick=max', 'history=summarizer'].map(noFillS))
const savedS = await nav8('/app/tasks', { method: 'POST', headers: { ...FORM8, cookie: cookie8 }, body: 'task_ref=sg-next&ceiling_units=180&agent_id=summarizer' })
const nextS = await task8('sg-next')
ok('[suggest] picking p90 fills 180 and the summarizer label, both editable, writes nothing, and a pick the rows do not back fills nothing; the save is the form\'s own',
   /value="180"/.test(ceilFieldS(pickedS.html)) && !/readonly|disabled/.test(ceilFieldS(pickedS.html))
     && /value="summarizer"/.test(agentFieldS(pickedS.html)) && !/readonly|disabled/.test(agentFieldS(pickedS.html))
     && pickedS.html.includes('<a class="pk on" href="/app?view=tasks&amp;history=summarizer&amp;pick=p90" aria-current="true">')
     && shownS(pickLineS(pickedS.html)).includes('In the ceiling field: 180 units, the p90 of your last 20 jobs of summarizer')
     && shownS(pickLineS(pickedS.html)).includes('Nothing is saved until you press Set ceiling')
     && pickedS.html.includes('action="/app/tasks"') && beforeS === afterS && unbackedS.every(Boolean)
     && savedS.headers.get('location') === '/app?view=tasks&saved=sg-next&created=1' && nextS?.ceilingUnits === 180 && nextS?.agentId === 'summarizer',
   `${ceilFieldS(pickedS.html)} ${agentFieldS(pickedS.html)} | ${shownS(pickLineS(pickedS.html))} | unbacked ${unbackedS.join(',')} | ${beforeS}->${afterS} | ${savedS.headers.get('location')}`)

// ?demo=1: the same suggestion, worked out from the labelled sample rows the
// view lists below it, with no form that can save. researcher has two
// settled sample jobs (118 and 492) and enricher one (1,025); summarizer and
// crawler each have a call in flight in the sample, so neither is offered.
// Signed in or not, the sample never shows this account's figures.
const demoS = await getS('/app?demo=1&view=tasks', null)
const demoBlockS = histOfS(demoS.html)
const demoResS = rowOfS(demoBlockS, 'researcher')
const demoEnrS = rowOfS(demoBlockS, 'enricher')
const demoPickS = await getS('/app?demo=1&view=tasks&history=researcher&pick=p90', null)
const demoInS = await getS('/app?demo=1&view=tasks')
ok('[suggest] ?demo=1 shows the suggestion from the labelled sample rows, a click fills the field there too, and nothing on it can save',
   demoS.status === 200 && demoS.html.includes('Sample data') && rowsOfS(demoBlockS).length === 2
     && demoResS?.label === 'from your last 2 jobs of ' && demoResS.figs.p50 === '118' && demoResS.figs.p90 === '492' && demoResS.figs.max === '492'
     && demoEnrS?.label === 'from your last job of ' && demoEnrS.figs.one === '1,025'
     && !rowOfS(demoBlockS, 'summarizer') && !rowOfS(demoBlockS, 'crawler')
     && demoResS.hrefs.every((u) => u.startsWith('/app?demo=1&amp;view=tasks&amp;history=researcher&amp;pick='))
     && !/method="POST"/i.test(demoS.html) && !demoS.html.includes('action="/app/tasks"') && demoS.html.includes('<a class="btn" href="/register">')
     && /value="492"/.test(ceilFieldS(demoPickS.html)) && /value="researcher"/.test(agentFieldS(demoPickS.html)) && !/method="POST"/i.test(demoPickS.html)
     && shownS(pickLineS(demoPickS.html)).includes('the p90 of your last 2 jobs of researcher') && shownS(pickLineS(demoPickS.html)).includes('This is sample data, so nothing here is saved')
     && histOfS(demoInS.html) === demoBlockS && !demoInS.html.includes('action="/app/tasks"'),
   `${demoS.status} researcher ${figsS(demoResS)} "${demoResS?.label}", enricher ${figsS(demoEnrS)}, rows ${rowsOfS(demoBlockS).map((r) => r.agent).join(' | ') || 'none'}, POST form ${/method="POST"/i.test(demoS.html)}`)

// The words say what the code computes. The footer and the fine print name
// the same N as the constant the server runs on, and /docs holds every fact
// the fine print used to carry (2026-09-24, when it was cut from a paragraph
// to two lines): finished defined by column, the reservation that holds a job
// out and its TTL from RESERVATION_TTL_MINUTES, a refused job counted at what
// it spent, the console label left out, and how many agents get a row. The
// fine print is two lines at the 86ch measure (229 characters against a
// 798px paragraph, measured in a browser at 1440 on 2026-09-24), links to
// that paragraph by an anchor that must exist, and no
// served surface keeps the old review's sentence, which named
// GET /tasks?agent_id= (created_at order, every job) as what the percentile
// was taken over.
const footS = shownS((pageS.html.match(/<div class="foot">[\s\S]*?<\/div>/) ?? [''])[0])
const fineRawS = (blockS.match(/<p class="fine">[\s\S]*?<\/p>/) ?? [''])[0]
const fineS = shownS(fineRawS)
const demoFineS = shownS((demoBlockS.match(/<p class="fine">[\s\S]*?<\/p>/) ?? [''])[0])
const docsRawS = await fetch(`${API}/docs`).then((r) => r.text())
const docsS = shownS(docsRawS)
// What left the page. None of it may be on the fine print any more, and all
// of it must be in /docs, or a fact was dropped rather than moved.
const MOVED_S = /Finished means|reservation expires|a sweep releases|refused at its ceiling|placeholder label|At most \d+ agents|gets no suggestion/
const OLD_S = /percentile of the used_units that GET \/tasks\?agent_id=|GET \/tasks\?agent_id= returns/i
const sitemapS = await fetch(`${API}/sitemap.xml`).then((r) => r.text())
const pathsS = [...new Set([...sitemapS.matchAll(/<loc>https?:\/\/[^/<]+(\/[^<]*)<\/loc>/g)].map((m) => m[1]))]
const oldSaidS = []
for (const path of [...pathsS, '/llms.txt', '/llms-full.txt']) {
  const hit = shownS(await fetch(`${API}${path}`).then((r) => r.text())).match(OLD_S)
  if (hit) oldSaidS.push(`${path}: "${hit[0]}"`)
}
for (const [name, h] of [['tasks', pageS.html], ['tasks+pick', pickedS.html], ['demo', demoS.html]]) {
  const hit = shownS(h).match(OLD_S)
  if (hit) oldSaidS.push(`${name}: "${hit[0]}"`)
}
// T3, 2026-09-25: a suggestion is in dollars at list price when the history
// is priced. That is the one money the suggestion may name, in these exact
// words; the gate below takes them out and then asks for no money at all.
const IN_USD_S = "in dollars at list price when every call of those jobs was priced, and in the jobs' own unit otherwise"
const IN_USD_FOOT_S = 'or its breakdown.list_price_usd_estimate when every call was priced'
ok('[suggest] the fine print is two lines, the click and the figures, and links to the /docs paragraph that holds every fact that left it: finished defined by column, the reservation that holds a job out and its TTL, a refused job counted at what it spent, the console label left out, and how many agents get a row',
   footS.includes(`A suggested ceiling is one job's used_units, or its breakdown.list_price_usd_estimate when every call was priced, as GET /tasks/:task_ref returns it: the p50, p90 or max over one agent's ${JOBS_S} most recently updated finished jobs, worked out on this page.`)
     && fineS === `A pick fills the ceiling field with that agent's label; nothing is saved until you press Set ceiling. Each figure is the p50, p90 or max of that agent's last ${JOBS_S} finished jobs: one real job's total, ${IN_USD_S}. How the suggestion is computed.`
     && demoFineS === `A pick fills the ceiling field with that agent's label; sample data, so nothing here is saved. Each figure is the p50, p90 or max of that agent's last ${JOBS_S} finished jobs: one real job's total, ${IN_USD_S}. How the suggestion is computed.`
     && !MOVED_S.test(fineS) && !MOVED_S.test(demoFineS)
     && fineRawS.includes('<a href="/docs#ceiling-suggestion">How the suggestion is computed</a>')
     && /<h3 id="ceiling-suggestion">/.test(docsRawS)
     && docsS.includes(`For at most ${AGENTS_S} agents, those whose latest finished jobs are the most recent, it shows the p50, p90 and max used_units of each one's ${JOBS_S} most recently updated finished jobs, so every figure is one real job's total.`)
     && docsS.includes('Any other agent, including one with no finished job, gets no suggestion.')
     && docsS.includes('Finished means the job has spent units and holds no reservation: used_units above 0 and reserved_units 0.')
     && docsS.includes('No event marks a job as done, so a job resting between two calls counts, and a call still in flight keeps its job out until it records, or, if it never does, until its reservation expires after ' + TTL_S + ' minutes and a sweep releases it.')
     && docsS.includes('A job refused at its ceiling counts at what it spent.')
     && docsS.includes('Jobs with the placeholder label console, the one a job carries until an approved call names an agent, are left out.')
     && !/for each agent, the p50/i.test(docsS)
     && pathsS.length >= 10 && oldSaidS.length === 0,
   oldSaidS.join('; ') || `foot: ${footS.slice(-200)} | fine (${fineS.length}): ${fineS} | demo fine: ${demoFineS.slice(0, 160)} | docs anchor ${/<h3 id="ceiling-suggestion">/.test(docsRawS)}, moved on page ${MOVED_S.test(fineS)}`)

// Units only, and the house words. Everything this change prints, read as
// served: the suggestion on the real and the sample view, both lines under
// the form, the sample's button, the footer sentence and the /docs paragraph.
// No money word of any kind, and none of the house's banned words.
const docsParaS = (docsS.match(/How the suggestion is computed Not sure what a job needs\?[^]*?names an agent, are left out\./) ?? [''])[0]
const newCopyS = [blockS, demoBlockS, pickLineS(pickedS.html), pickLineS(demoPickS.html), pickLineS(hostPickS.html), pickLineS(host2PickS.html),
  (demoS.html.match(/<a class="btn" href="\/register">[^<]*<\/a>/) ?? [''])[0], (footS.match(/A suggested ceiling is[^]*$/) ?? [''])[0]].map(shownS).join(' ') + ' ' + docsParaS
const moneyS = newCopyS.split(IN_USD_S).join(' ').split(IN_USD_FOOT_S).join(' ').match(/\$|dollar|\bUSD\b|\bcents?\b|\brates?\b|\bprices?\b|\bpricing\b|\bcosts?\b|\bbill(ed|ing)?\b|\binvoices?\b/gi) ?? []
const bannedS = newCopyS.match(/\b[a-z]*(stop|block|kill|halt)[a-z]*\b|\bcuts? off\b|\bfirst\b|\bonly one\b/gi) ?? []
ok('[suggest] everything the suggestion prints on a history with no priced job is in units: no money word but the one labelled clause, and none of the banned house words',
   newCopyS.includes(IN_USD_S) && newCopyS.length > 1500 && docsParaS.length > 900 && moneyS.length === 0 && bannedS.length === 0,
   [...moneyS, ...bannedS].join(', ') || `${newCopyS.length} chars, docs paragraph ${docsParaS.length}`)
await sql`DELETE FROM accounts WHERE id = ${OTHER_S}`

// ---------------------------------------------------------------- jobs: which job used the most, 2026-09-23
// From a builder's interview (vault, B-brain/05-research/2026-09-23-shahar-elhadad-interview.md,
// 04:24 to 05:10): he wants to be shown which process costs the most and which takes the
// longest, without working it out himself. Until this, the console ranked customers only:
// tasks were listed by updated_at, GET /tasks by created_at, and nothing split the units by
// event_type. What is asserted, each on what the server actually serves:
//   1. GET /tasks keeps its order for a client that sends no sort; sort=used ranks by
//      used_units; any other sort is a 422.
//   2. The tasks view's Recent is the order it always had; Most used ranks the same rows.
//   3. A row's time is the span between the first and the last preflight on record for that
//      job (reservations, plus preflight-source decisions), and nothing else moves it: not
//      task_budgets' own timestamps, not a record, not another account's rows. It says "on
//      record", never "seen", and the footer names it as the number GET /tasks does not return.
//   4. GET /usage?by=event_type and the activity view split this account's units the same
//      way, and another account's records never appear in either.
console.log('\n[jobs] which job used the most, and what the units were recorded under')
await reset()
await sql`DELETE FROM preflight_decisions WHERE account_id = ${ACCT}`
const KEYJ = (await post('/keys/generate', { label: 'harness-jobs' })).body.api_key
if (typeof KEYJ !== 'string' || !KEYJ.startsWith('agb_')) throw new Error('[jobs] could not mint its key')
const OTHERJ = '00000000-0000-0000-0000-0000000000dd'
const OTHERKEYJ = shapedKey('other-account-jobs')
await sql`INSERT INTO accounts (id, plan, default_budget_units, monthly_calls, billing_period_start)
          VALUES (${OTHERJ}, 'free', NULL, 0, date_trunc('month', CURRENT_DATE)::date) ON CONFLICT (id) DO NOTHING`
await insertKeyRow(sql, OTHERJ, OTHERKEYJ, 'other-jobs', { ifAbsent: true })
const authJ = (key) => ({ 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' })
const preJ = (body, key = KEYJ) => fetch(`${API}/preflight`, { method: 'POST', headers: authJ(key), body: JSON.stringify(body) })
  .then(async r => ({ status: r.status, body: await r.json() }))
let seqJ = 0
const recJ = (body, key = KEYJ) => fetch(`${API}/events`, { method: 'POST', headers: authJ(key),
  body: JSON.stringify({ customer_id: 'default', idempotency_key: `jobs-${seqJ++}`, ...body }) })
  .then(async r => ({ status: r.status, body: await r.json() }))
const ceilJ = (ref, body, key = KEYJ) => fetch(`${API}/tasks/${encodeURIComponent(ref)}/ceiling`, { method: 'PUT', headers: authJ(key), body: JSON.stringify(body) })
  .then(async r => ({ status: r.status, body: await r.json() }))
const getJ = (path, key = KEYJ) => fetch(`${API}${path}`, { headers: key ? { 'Authorization': `Bearer ${key}` } : {} })
  .then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))
const T0 = Date.now()
const agoJ = (mins) => new Date(T0 - mins * 60_000)

// 1. Three jobs, created in one order, used in a second, touched in a third, so each
//    order is a claim of its own and no two can pass for each other, including the two
//    alpha jobs on their own (created: mid, old; used: old, mid).
for (const [ref, agent, units] of [['jobs-old', 'alpha', 300], ['jobs-mid', 'alpha', 50], ['jobs-new', 'beta', 10]]) {
  await ceilJ(ref, { ceiling_units: 1000, agent_id: agent })
  await preJ({ agent_id: agent, task_ref: ref, estimated_units: units })
  await recJ({ event_type: agent, units, task_ref: ref })
}
await sql`UPDATE task_budgets SET created_at = ${agoJ(180)}, updated_at = ${agoJ(1)}  WHERE account_id = ${ACCT} AND task_ref = 'jobs-old'`
await sql`UPDATE task_budgets SET created_at = ${agoJ(120)}, updated_at = ${agoJ(10)} WHERE account_id = ${ACCT} AND task_ref = 'jobs-mid'`
await sql`UPDATE task_budgets SET created_at = ${agoJ(60)},  updated_at = ${agoJ(5)}  WHERE account_id = ${ACCT} AND task_ref = 'jobs-new'`
// Another account's job, the newest, the most recently touched and the most used in the
// database, under the agent label alpha this account also uses, so a list query that lost
// its account filter would put it at the top of every order below. Until 2026-09-23 no
// other account had a task when GET /tasks was called, and the review found that replacing
// `account_id = ${accountId}` with `true` in the list query left the whole harness green.
await ceilJ('jobs-other', { ceiling_units: 10000, agent_id: 'alpha' }, OTHERKEYJ)
await sql`UPDATE task_budgets SET used_units = 9999, created_at = now(), updated_at = now() WHERE account_id = ${OTHERJ} AND task_ref = 'jobs-other'`
const otherTaskJ = await getJ('/tasks/jobs-other', OTHERKEYJ)
ok('[jobs] setup: another account holds jobs-other, at 9999 units used', otherTaskJ.status === 200 && otherTaskJ.body?.used_units === 9999,
   `${otherTaskJ.status} ${JSON.stringify(otherTaskJ.body).slice(0, 120)}`)
const refsJ = (r) => (r.body?.tasks ?? []).map((t) => t.task_ref).join(',')
const plainJ = await getJ('/tasks')
ok('[jobs] GET /tasks with no sort is still newest job first, as every existing client got it',
   plainJ.status === 200 && refsJ(plainJ) === 'jobs-new,jobs-mid,jobs-old', `${plainJ.status} ${refsJ(plainJ)}`)
const createdJ = await getJ('/tasks?sort=created')
ok('[jobs] and sort=created is that same order, named', refsJ(createdJ) === 'jobs-new,jobs-mid,jobs-old', refsJ(createdJ))
const usedJ = await getJ('/tasks?sort=used')
ok('[jobs] GET /tasks?sort=used ranks the jobs by used_units',
   usedJ.status === 200 && refsJ(usedJ) === 'jobs-old,jobs-mid,jobs-new' && usedJ.body.tasks.map((t) => t.used_units).join(',') === '300,50,10',
   `${usedJ.status} ${JSON.stringify(usedJ.body?.tasks?.map((t) => [t.task_ref, t.used_units]))}`)
const alphaJ = await getJ('/tasks?agent_id=alpha&sort=used')
ok('[jobs] sort=used composes with agent_id', refsJ(alphaJ) === 'jobs-old,jobs-mid', refsJ(alphaJ))
const badSortJ = await getJ('/tasks?sort=cost')
ok('[jobs] an unknown sort is a 422, not a silent default', badSortJ.status === 422 && badSortJ.body?.error === 'validation_error',
   `${badSortJ.status} ${JSON.stringify(badSortJ.body).slice(0, 120)}`)
const listsJ = [['/tasks', plainJ], ['?sort=created', createdJ], ['?sort=used', usedJ], ['?agent_id=alpha&sort=used', alphaJ]]
const otherHereJ = await getJ('/tasks/jobs-other')
ok('[jobs] another account\'s job is in none of GET /tasks, ?sort=created, ?sort=used or ?agent_id=alpha&sort=used, and is 404 by name',
   listsJ.every(([, r]) => r.status === 200 && !refsJ(r).split(',').includes('jobs-other')) && otherHereJ.status === 404,
   `${listsJ.map(([q, r]) => `${q}: ${refsJ(r)}`).join(' | ')} | /tasks/jobs-other: ${otherHereJ.status}`)

// 2. The same three rows on the console.
const loginJ = await nav8('/app/session', { method: 'POST', headers: FORM8, body: `api_key=${KEYJ}` })
const cookieJ = (loginJ.headers.get('set-cookie') ?? '').split(';')[0]
ok('[jobs] login for the console views', cookieJ.startsWith('agentbill_app='), cookieJ.slice(0, 20))
const pageJ = (path) => nav8(path, { headers: { cookie: cookieJ } }).then((r) => r.text())
// The row's name cell as the canvas console draws it (design/canvas-everywhere,
// 2026-09-24): a table row whose lead cell opens with <div class="tk-n"><a>.
// Until the merge it read the dark console's <div class="btask">.
const rowsJ = (h) => [...h.matchAll(/<div class="tk-n"><a [^>]*>([^<]+)<\/a>/g)].map((m) => m[1]).join(',')
const recentJ = await pageJ('/app?view=tasks')
ok('[jobs] the tasks view opens on Recent, most recently touched first, the order it always had',
   rowsJ(recentJ) === 'jobs-old,jobs-new,jobs-mid' && recentJ.includes('<a class="on" href="/app?view=tasks" aria-current="true">Recent</a>'),
   rowsJ(recentJ))
const mostJ = await pageJ('/app?view=tasks&sort=used')
ok('[jobs] Most used ranks the same rows by units used, and says so under them',
   rowsJ(mostJ) === 'jobs-old,jobs-mid,jobs-new' && mostJ.includes('<a class="on" href="/app?view=tasks&amp;sort=used" aria-current="true">Most used</a>')
     && mostJ.includes('most used first'), rowsJ(mostJ))
ok('[jobs] and another account\'s job is on neither order of this account\'s tasks view',
   !recentJ.includes('jobs-other') && !mostJ.includes('jobs-other') && rowsJ(recentJ) !== '' && rowsJ(mostJ) !== '',
   `recent: ${rowsJ(recentJ)} | most used: ${rowsJ(mostJ)}`)
ok('[jobs] the order belongs to the tasks view: no link to another view carries it',
   !/href="\/app\?view=(?!tasks)[a-z]+&amp;sort=used/.test(mostJ) && mostJ.includes('href="/app?view=activity"'), 'a link to another view kept sort=used')

// 3. The span, on a job opened with a ceiling and no call yet.
await ceilJ('jobs-span', { ceiling_units: 100, agent_id: 'alpha' })
const rowOfJ = (h, ref) => {
  const i = h.indexOf(`>${ref}</a>`)
  if (i < 0) return ''
  // The next row is the next <tr; the canvas rows are table rows, not .brow divs.
  const j = h.indexOf('<tr', i)
  return h.slice(i, j < 0 ? undefined : j)
}
const seenJ = async (ref) => visible8((rowOfJ(await pageJ('/app?view=tasks'), ref).match(/<span class="bseen">([\s\S]*?)<\/span>/) ?? [])[1] ?? '')
  .replace(/\s+/g, ' ').trim()
const decisionRowJ = async (ref, source, account = ACCT) => {
  const started = Date.now()
  let rows = []
  while (Date.now() - started < PAGE_DEADLINE_MS) {
    rows = await sql`SELECT id FROM preflight_decisions WHERE account_id = ${account} AND task_ref = ${ref} AND source = ${source} ORDER BY id`
    if (rows.length) break
    await settle(POLL_MS)
  }
  return rows
}
let seenNowJ = await seenJ('jobs-span')
ok('[jobs] a job opened with no preflight says so and shows no span', seenNowJ === 'no preflight on record', seenNowJ || 'no seen line on the row')
await preJ({ agent_id: 'alpha', task_ref: 'jobs-span', estimated_units: 10 })
seenNowJ = await seenJ('jobs-span')
ok('[jobs] one preflight is one preflight, not a span', seenNowJ === 'one preflight on record', seenNowJ)
await preJ({ agent_id: 'alpha', task_ref: 'jobs-span', estimated_units: 10 })
await preJ({ agent_id: 'alpha', task_ref: 'jobs-span', estimated_units: 10 })
const resJ = await sql`SELECT id FROM reservations WHERE account_id = ${ACCT} AND task_ref = 'jobs-span' ORDER BY id`
ok('[jobs] setup: three approved preflights left three reservation rows', resJ.length === 3, String(resJ.length))
await sql`UPDATE reservations SET created_at = ${agoJ(180)} WHERE id = ${resJ[0]?.id ?? 0}`
await sql`UPDATE reservations SET created_at = ${agoJ(120)} WHERE id = ${resJ[1]?.id ?? 0}`
await sql`UPDATE reservations SET created_at = ${agoJ(60)}  WHERE id = ${resJ[2]?.id ?? 0}`
seenNowJ = await seenJ('jobs-span')
ok('[jobs] the span runs from the first stored preflight to the last, and is labelled as that',
   seenNowJ === '2h 0m, first to last preflight on record', seenNowJ)
const refusedJ = await preJ({ agent_id: 'alpha', task_ref: 'jobs-span', estimated_units: 500 })
const refusedRowJ = await decisionRowJ('jobs-span', 'preflight')
await sql`UPDATE preflight_decisions SET created_at = ${agoJ(30)} WHERE id = ${refusedRowJ[0]?.id ?? 0}`
seenNowJ = await seenJ('jobs-span')
ok('[jobs] a refused preflight is a preflight on record, so it extends the span',
   refusedJ.body.reason === 'task_ceiling_exceeded' && refusedRowJ.length === 1 && seenNowJ === '2h 30m, first to last preflight on record',
   `${refusedJ.body.reason} ${refusedRowJ.length} "${seenNowJ}"`)
// task_budgets' own timestamps are not the span: a ceiling save moves updated_at, and
// created_at is when the job was opened, not a call.
const saveJ = await nav8('/app/tasks', { method: 'POST', headers: { ...FORM8, cookie: cookieJ }, body: 'task_ref=jobs-span&ceiling_units=150' })
await sql`UPDATE task_budgets SET created_at = ${agoJ(600)} WHERE account_id = ${ACCT} AND task_ref = 'jobs-span'`
seenNowJ = await seenJ('jobs-span')
ok('[jobs] a ceiling save and the job\'s created_at do not move it',
   saveJ.status === 303 && seenNowJ === '2h 30m, first to last preflight on record', `${saveJ.status} "${seenNowJ}"`)
// A record is not a preflight, even one that lands past the ceiling and leaves a row.
const leakJ = await recJ({ event_type: 'alpha', units: 200, task_ref: 'jobs-span' })
const leakRowJ = await decisionRowJ('jobs-span', 'events')
seenNowJ = await seenJ('jobs-span')
ok('[jobs] a record, even one that leaks and leaves a decision row, does not move it',
   leakJ.body.task_exceeded === true && leakRowJ.length === 1 && seenNowJ === '2h 30m, first to last preflight on record',
   `${JSON.stringify(leakJ.body).slice(0, 80)} ${leakRowJ.length} "${seenNowJ}"`)
// Another account's job of the same name is its own, and so are its rows.
await ceilJ('jobs-span', { ceiling_units: 100, agent_id: 'other' }, OTHERKEYJ)
await preJ({ agent_id: 'other', task_ref: 'jobs-span', estimated_units: 5 }, OTHERKEYJ)
await preJ({ agent_id: 'other', task_ref: 'jobs-span', estimated_units: 500 }, OTHERKEYJ)
const otherRefusalJ = await decisionRowJ('jobs-span', 'preflight', OTHERJ)
await sql`UPDATE reservations SET created_at = ${agoJ(1000)} WHERE account_id = ${OTHERJ} AND task_ref = 'jobs-span'`
await sql`UPDATE preflight_decisions SET created_at = ${agoJ(2)} WHERE account_id = ${OTHERJ} AND task_ref = 'jobs-span'`
seenNowJ = await seenJ('jobs-span')
ok('[jobs] another account\'s preflights on the same task_ref never enter this span',
   otherRefusalJ.length === 1 && seenNowJ === '2h 30m, first to last preflight on record', `${otherRefusalJ.length} "${seenNowJ}"`)
// The rows are fewer than the preflights: reservations begin with migration 006 on
// 2026-09-03, and a refusal row is written fire-and-forget. The review's reproduction: a
// job a preflight opened and spent under, whose reservation row is then removed, as if it
// ran before 006. The job exists only because a preflight opened it, so "no preflight seen"
// would be false. What is true is that none is on record.
await preJ({ agent_id: 'alpha', task_ref: 'jobs-prerec', task_ceiling: 100, estimated_units: 10 })
await recJ({ event_type: 'alpha', units: 10, task_ref: 'jobs-prerec' })
const goneJ = await sql`DELETE FROM reservations WHERE account_id = ${ACCT} AND task_ref = 'jobs-prerec' AND released_at IS NOT NULL RETURNING id`
const prerecRowJ = visible8(rowOfJ(await pageJ('/app?view=tasks'), 'jobs-prerec')).replace(/\s+/g, ' ')
seenNowJ = await seenJ('jobs-prerec')
ok('[jobs] a job whose preflights left no row shows its spend and says no preflight is on record, not that none was seen',
   goneJ.length === 1 && /\b10 \/ 100\b/.test(prerecRowJ) && seenNowJ === 'no preflight on record',
   `${goneJ.length} "${seenNowJ}" ${prerecRowJ.slice(0, 160)}`)
// The footer says every number on the page is on the API too, and the span is not on it:
// GET /tasks and GET /tasks/:task_ref serialize the budget and its two timestamps, and no
// route returns reservations. So the footer and the served JSON must agree. While the JSON
// carries no span field, each page that draws a span names it as the exception and a page
// that draws none does not; if GET /tasks ever returns the span, the exception must go.
const oneTaskJ = await getJ('/tasks/jobs-span')
const listTaskJ = await getJ('/tasks')
const servedKeysJ = [...Object.keys(oneTaskJ.body ?? {}), ...(listTaskJ.body?.tasks ?? []).flatMap((t) => Object.keys(t))]
const spanKeysJ = [...new Set(servedKeysJ.filter((k) => /preflight|seen|span|first|last/i.test(k)))]
const footJ = (h) => visible8((h.match(/<div class="foot">([\s\S]*?)<\/div>/) ?? [])[1] ?? '').replace(/\s+/g, ' ').trim()
const EXCEPTION_J = 'except the preflight span on a task row, which the API does not return'
const footPagesJ = []
for (const [path, cookie, draws] of [['/app?view=tasks', cookieJ, true], ['/app', cookieJ, true], ['/app?view=keys', cookieJ, false],
                                      ['/app?demo=1&view=tasks', null, true], ['/app?demo=1', null, true], ['/app?demo=1&view=activity', null, false]]) {
  const h = await nav8(path, cookie ? { headers: { cookie } } : {}).then((r) => r.text())
  footPagesJ.push({ path, draws: h.includes('<span class="bseen">'), expected: draws, foot: footJ(h) })
}
ok('[jobs] the footer and the served JSON agree: GET /tasks returns no preflight span, so each page that draws one names it as the exception, and a page that draws none does not',
   oneTaskJ.status === 200 && servedKeysJ.includes('used_units')
     && footPagesJ.every((f) => f.draws === f.expected && f.foot.startsWith('Every number on this page is on the API too')
       && f.foot.includes(EXCEPTION_J) === (f.draws && spanKeysJ.length === 0)),
   `served span fields ${JSON.stringify(spanKeysJ)} | ${footPagesJ.map((f) => `${f.path} draws=${f.draws} "${f.foot.slice(0, 120)}"`).join(' | ')}`)
const tasksPageJ = await pageJ('/app?view=tasks')
const noteNowJ = [...tasksPageJ.matchAll(/<p class="note">([\s\S]*?)<\/p>/g)].map((m) => visible8(m[1]).replace(/\s+/g, ' '))
  .find((t) => t.includes('Used is what your code reported')) ?? ''
ok('[jobs] the tasks note says the time is from records that begin 2026-09-03, that GET /tasks has the rows without it, and never "full attribution" or "seen"',
   noteNowJ.includes('first to the last preflight on record') && noteNowJ.includes('Those records begin 2026-09-03')
     && noteNowJ.includes('The same rows, without that time, are on GET /tasks') && !/full attribution|\bseen\b/i.test(noteNowJ),
   noteNowJ || 'no tasks note')

// 4. What the units were recorded under.
await reset()
for (const [event_type, units] of [['search', 20], ['search', 10], ['summarize', 10], ['archive', 500]]) await recJ({ event_type, units })
await sql`UPDATE events SET created_at = now() - interval '40 days' WHERE account_id = ${ACCT} AND event_type = 'archive'`
await recJ({ event_type: 'other-tenant-secret', units: 9999 }, OTHERKEYJ)
const noKeyJ = await getJ('/usage?by=event_type', null)
const badKeyJ = await getJ('/usage?by=event_type', 'agb_not_a_real_key_for_jobs_000')
ok('[jobs] GET /usage is a bearer route: no key and a wrong key are both 401',
   noKeyJ.status === 401 && badKeyJ.status === 401, `${noKeyJ.status} ${badKeyJ.status}`)
const noByJ = await getJ('/usage')
const byCustJ = await getJ('/usage?by=customer')
const days0J = await getJ('/usage?by=event_type&days=0')
const days91J = await getJ('/usage?by=event_type&days=91')
ok('[jobs] by=event_type is required and days is 1 to 90, each a 422',
   [noByJ, byCustJ, days0J, days91J].every((r) => r.status === 422 && r.body?.error === 'validation_error'),
   [noByJ, byCustJ, days0J, days91J].map((r) => r.status).join(','))
const u30J = await getJ('/usage?by=event_type')
const groupsJ = (b) => JSON.stringify((b?.groups ?? []).map((g) => [g.event_type, g.units, g.events, g.share]))
ok('[jobs] GET /usage splits the window by event_type, heaviest first, each with its share of the total',
   u30J.status === 200 && u30J.body.by === 'event_type' && u30J.body.days === 30 && /^\d{4}-\d{2}-\d{2}$/.test(u30J.body.since)
     && u30J.body.total_units === 40 && u30J.body.total_events === 3 && u30J.body.group_count === 2
     && groupsJ(u30J.body) === JSON.stringify([['search', 30, 2, 0.75], ['summarize', 10, 1, 0.25]]),
   JSON.stringify(u30J.body))
const u90J = await getJ('/usage?by=event_type&days=90')
ok('[jobs] the window is days: a record from 40 days ago is in 90 and not in 30',
   u90J.body?.total_units === 540 && u90J.body.groups?.[0]?.event_type === 'archive' && !groupsJ(u30J.body).includes('archive'),
   JSON.stringify(u90J.body))
const u1J = await getJ('/usage?by=event_type&limit=1')
ok('[jobs] a limit cuts the groups, never the totals',
   u1J.body?.groups?.length === 1 && u1J.body.group_count === 2 && u1J.body.total_units === 40, JSON.stringify(u1J.body))
ok('[jobs] another account\'s records never appear in this account\'s split, nor in its totals',
   !JSON.stringify(u30J.body).includes('other-tenant-secret') && !JSON.stringify(u90J.body).includes('other-tenant-secret') && u90J.body?.total_units === 540,
   JSON.stringify(u90J.body))
const uOtherJ = await getJ('/usage?by=event_type', OTHERKEYJ)
ok('[jobs] and that account sees its own records and none of this one\'s',
   uOtherJ.body?.total_units === 9999 && groupsJ(uOtherJ.body) === JSON.stringify([['other-tenant-secret', 9999, 1, 1]]), JSON.stringify(uOtherJ.body))
// The console reads the same function, so the page says what the API says.
const splitJ = (h) => {
  const s = h.slice(h.indexOf('<h2>By event_type'), h.indexOf('<h2>Day by day'))
  return [...s.matchAll(/<td class="id lead" title="[^"]*">([^<]+)<\/td>[\s\S]*?<span>([^<]+) of units<\/span>[\s\S]*?<td class="num" data-l="units">([0-9,]+)<\/td>\s*<td class="num" data-l="records">([0-9,]+)<\/td>/g)]
    .map((m) => [m[1], m[2], Number(m[3].replace(/,/g, '')), Number(m[4].replace(/,/g, ''))])
}
// The day-by-day table on canvas is the kit's table with the page's own
// .days class; the dark console wrapped it in <div class="frame tw days">.
const dayUnitsJ = (h) => [...h.slice(h.indexOf('<table class="cv-table is-ruled days">')).matchAll(/<td class="when">[\s\S]*?<\/td>\s*<td class="num">([0-9,]+)<\/td>/g)]
  .reduce((a, m) => a + Number(m[1].replace(/,/g, '')), 0)
const sumJ = (rows) => rows.reduce((a, r) => a + r[2], 0)
const actJ = await pageJ('/app?view=activity')
ok('[jobs] the activity view shows the same split, each share of every unit in the window',
   JSON.stringify(splitJ(actJ)) === JSON.stringify([['search', '75%', 30, 2], ['summarize', '25%', 10, 1]]), JSON.stringify(splitJ(actJ)))
ok('[jobs] and never another account\'s event_type', !actJ.includes('other-tenant-secret'))
ok('[jobs] the split sums to the day-by-day units over the same window', sumJ(splitJ(actJ)) === dayUnitsJ(actJ) && dayUnitsJ(actJ) === 40,
   `${sumJ(splitJ(actJ))} vs ${dayUnitsJ(actJ)}`)
const act90J = await pageJ('/app?view=activity&range=90d')
ok('[jobs] and it moves with the period control', splitJ(act90J)[0]?.[0] === 'archive' && sumJ(splitJ(act90J)) === dayUnitsJ(act90J) && dayUnitsJ(act90J) === 540,
   `${JSON.stringify(splitJ(act90J))} vs ${dayUnitsJ(act90J)}`)
const splitTextJ = visible8(actJ.slice(actJ.indexOf('<h2>By event_type'), actJ.indexOf('<h2>Day by day'))).replace(/\s+/g, ' ')
ok('[jobs] the split says whose units they are and what event_type holds',
   splitTextJ.includes('in the units your code reported') && splitTextJ.includes('record() in both SDKs sends its agent_id as the event_type')
     && splitTextJ.includes('GET /usage?by=event_type'), splitTextJ.slice(0, 200))

// The sample console shows both, from its own labelled sample rows. The
// banner's label is the kit's mono label on canvas (it was <b>Sample data</b>
// on the dark console).
const SAMPLE_LABEL_J = '<span class="cv-label">Sample data</span>'
const demoUsedJ = await fetch(`${API}/app?demo=1&view=tasks&sort=used`).then((r) => r.text())
ok('[jobs] the sample console ranks its sample jobs by Most used, inside the sample frame',
   rowsJ(demoUsedJ) === 'nightly-crawl,batch-2211,job-8871,job-8864,job-8870' && demoUsedJ.includes(SAMPLE_LABEL_J)
     && demoUsedJ.includes('<a class="on" href="/app?demo=1&amp;view=tasks&amp;sort=used" aria-current="true">Most used</a>'), rowsJ(demoUsedJ))
const demoRecentJ = await fetch(`${API}/app?demo=1&view=tasks`).then((r) => r.text())
ok('[jobs] and Recent there is most recently touched first, as its note says', rowsJ(demoRecentJ) === 'job-8871,batch-2211,job-8870,nightly-crawl,job-8864',
   rowsJ(demoRecentJ))
const demoSeenJ = [...demoUsedJ.matchAll(/<span class="bseen">([\s\S]*?)<\/span>/g)].map((m) => visible8(m[1]).replace(/\s+/g, ' ').trim())
ok('[jobs] every sample row carries its span, labelled the same way', demoSeenJ.length === 5 && demoSeenJ.every((s) => /^\S+( \S+)?, first to last preflight on record$/.test(s)),
   JSON.stringify(demoSeenJ))
for (const range of ['7d', '30d', '90d']) {
  const h = await fetch(`${API}/app?demo=1&view=activity&range=${range}`).then((r) => r.text())
  ok(`[jobs] the sample split sums to the sample day-by-day units (${range})`,
     h.includes(SAMPLE_LABEL_J) && splitJ(h).length === 4 && sumJ(splitJ(h)) === dayUnitsJ(h) && dayUnitsJ(h) > 0,
     `${sumJ(splitJ(h))} vs ${dayUnitsJ(h)}`)
}

// The words. Everything this lane added that a reader sees: the tasks note and seen lines,
// the split on the activity view, and the two API sections on /docs.
const docsJ = await fetch(`${API}/docs`).then((r) => r.text())
const docsNewJ = docsJ.slice(docsJ.indexOf('<h3 id="get-tasks">'), docsJ.indexOf('<h3 id="put-budget">'))
const tasksNoteJ = (mostJ.match(/<p class="note">([\s\S]*?)<\/p>/) ?? [])[1] ?? ''
const newCopyJ = visible8([tasksNoteJ, demoSeenJ.join(' '), actJ.slice(actJ.indexOf('<h2>By event_type'), actJ.indexOf('<h2>Day by day')), docsNewJ].join(' '))
ok('[jobs] /docs documents GET /tasks?sort and GET /usage', docsNewJ.includes('<h3 id="get-usage">GET /usage</h3>') && docsNewJ.includes('sort=used'), docsNewJ.slice(0, 80) || 'no new docs sections')
// 2026-09-25: the tasks note names a dollar figure in exactly one form, the
// list-price estimate of a job's priced calls, which is what the console
// prints beside a job. That one phrase is allowed; any other money is not.
const ALLOWED_MONEY_J = 'a dollar figure is the list-price estimate of the job\'s priced calls'
// T3 follow-up, 2026-09-25: GET /tasks?sort=used ranks by dollars where a job
// has them, and /docs says so in exactly this sentence; it is allowed, and
// taken out before the check, like the tasks note's.
const ALLOWED_RANK_J = "Jobs with a dollar figure come first, dearest first: a job in dollars by its own ledger, any other job by the list price of its priced calls."
const moneyCopyJ = newCopyJ.split(ALLOWED_MONEY_J).join(' ').split(ALLOWED_RANK_J).join(' ')
ok('[jobs] the new copy never says stop, block, kill, halt or cut off, and names money only as the list-price estimate',
   newCopyJ.length > 400 && newCopyJ.includes(ALLOWED_MONEY_J) && newCopyJ.replace(/\s+/g, ' ').includes(ALLOWED_RANK_J) && !/\b[a-z]*(stop|block|kill|halt)[a-z]*\b|\bcuts? off\b|\$\s?\d|dollar|\bUSD\b|provider bill/i.test(moneyCopyJ),
   (moneyCopyJ.match(/\b[a-z]*(stop|block|kill|halt)[a-z]*\b|\bcuts? off\b|\$\s?\d|dollar|\bUSD\b|provider bill/gi) ?? []).join(', '))
// server.ts: the canonical-host redirect skips only paths on this list, and a cross-host
// 301 drops the Authorization header, so a bearer GET missing from it breaks on the old host.
const prefixesJ = (readFileSync9(`${ROOT9}/src/server.ts`, 'utf8').match(/const API_PREFIXES = \[([\s\S]*?)\]/) ?? [])[1] ?? ''
ok('[jobs] /usage is on the API prefix list, so the canonical-host redirect never strips its bearer header',
   /'\/usage'/.test(prefixesJ), prefixesJ.replace(/\s+/g, ' '))
await sql`DELETE FROM accounts WHERE id = ${OTHERJ}`

// ---------------------------------------------------------------- [secfix] security batch A, 2026-09-25
// Each gate below is one finding of the OWASP audit of 2026-09-25
// (O-output/2026-09-25-security-audit-owasp.md in the vault), and each was
// shown red on a planted break before it was trusted. Several need the
// production values of limits the main harness server raises, so they run
// against a SECOND server started here, on the next port, on the same DB.
console.log('\n[secfix] security batch A')
const { readFileSync: readS, mkdtempSync: mkdtempS, writeFileSync: writeS } = await import('node:fs')
const { spawn: spawnS, spawnSync: spawnSyncS } = await import('node:child_process')
const { createHash: hashS, createHmac: hmacS, randomBytes: rndS } = await import('node:crypto')
const { tmpdir: tmpdirS } = await import('node:os')
const ROOT_S = new URL('../../', import.meta.url).pathname
const settleS = (ms) => new Promise((r) => setTimeout(r, ms))
const PORT_S = Number(new URL(API).port) + 1
const API_S = `http://localhost:${PORT_S}`
const bearerS = (k, extra = {}) => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json', ...extra })
const getSX = (base, path, key, extra = {}) => fetch(`${base}${path}`, { headers: bearerS(key, extra) })
  .then(async (r) => ({ status: r.status, headers: r.headers, body: await r.json().catch(() => null) }))
const postS = (base, path, body, key, extra = {}) => fetch(`${base}${path}`, { method: 'POST', headers: bearerS(key, extra), body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, headers: r.headers, body: await r.json().catch(() => null) }))

// Start a server with the env given, and either wait for /health or for it to exit.
const bootS = (env, port) => new Promise((resolve) => {
  let out = ''
  const child = spawnS(process.execPath, [`${ROOT_S}dist/server.js`], {
    env: { PATH: process.env.PATH, DATABASE_URL: process.env.DATABASE_URL, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { out += d })
  let done = false
  const finish = (v) => { if (!done) { done = true; resolve(v) } }
  child.on('exit', (code) => finish({ child, exited: true, code, out: () => out }))
  ;(async () => {
    for (let i = 0; i < 60 && !done; i++) {
      await settleS(250)
      const up = await fetch(`http://localhost:${port}/health`).then((r) => r.ok).catch(() => false)
      if (up) return finish({ child, exited: false, code: null, out: () => out })
    }
    finish({ child, exited: false, code: null, out: () => out, timedOut: true })
  })()
})
const stopS = async (b) => { if (b && !b.exited) { b.child.kill('SIGTERM'); await new Promise((r) => b.child.once('exit', r)) } }

// ------------------------------------------------ S1: the seeded key is gone and revoked
const multitenancyS = readS(`${ROOT_S}src/db/migrate-multitenancy.sql`, 'utf8')
ok('[secfix S1] migrate-multitenancy.sql no longer inserts any API key', !/INSERT\s+INTO\s+developer_api_keys/i.test(multitenancyS))
const LEGACY_HASH_S = 'aa759fef4307b14170837d3c226ac284414ff2c7c7e41ce8a2194faa5a2c8b42'
const [legacyLiveS] = await sql`
  SELECT count(*)::int AS n FROM developer_api_keys
  WHERE (label = 'legacy-hardcoded-key' OR key_hash = ${LEGACY_HASH_S})
    AND (revoked_at IS NULL OR revoked_at > NOW())`
ok('[secfix S1] after the schema chain, no live row carries the seeded key or its label', legacyLiveS.n === 0, `${legacyLiveS.n} live`)
// A database built from an older checkout still has the row: plant one and apply 019 to it.
const plantedS = shapedKey(`legacy-plant-${Date.now()}`)
await insertKeyRow(sql, ACCT, plantedS, 'legacy-hardcoded-key')
const beforeS1 = await getSX(API, '/keys', plantedS)
const mig019 = readS(`${ROOT_S}src/db/migrations/019_revoke_legacy_hardcoded_key.sql`, 'utf8')
await sql.unsafe(mig019)
const afterS1 = await getSX(API, '/keys', plantedS)
ok('[secfix S1] migration 019 revokes a planted legacy row: it authenticated before, key_revoked after',
   beforeS1.status === 200 && afterS1.status === 401 && afterS1.body?.error === 'key_revoked', `${beforeS1.status} -> ${afterS1.status} ${JSON.stringify(afterS1.body)}`)
const [rev1S] = await sql`SELECT revoked_at FROM developer_api_keys WHERE key_hash = ${keyHash(plantedS)}`
await settleS(20)
await sql.unsafe(mig019)
const [rev2S] = await sql`SELECT revoked_at FROM developer_api_keys WHERE key_hash = ${keyHash(plantedS)}`
ok('[secfix S1] and 019 is idempotent: a second run leaves revoked_at as it was', rev1S?.revokedAt != null && rev1S.revokedAt.getTime() === rev2S?.revokedAt?.getTime(), `${rev1S?.revokedAt} ${rev2S?.revokedAt}`)
await sql`DELETE FROM developer_api_keys WHERE key_hash = ${keyHash(plantedS)}`

// ------------------------------------------------ S2: shape before counters, bounded counters
const { createLimiter, authFailureLimiter } = await import('../../dist/lib/rate-limiter.js')
const capS = createLimiter({ max: 3, windowMs: 60_000, maxEntries: 500 })
for (let i = 0; i < 20_000; i++) capS.hit(`fake-${i}`)
ok('[secfix S2] 20,000 distinct keys never grow a counter past its ceiling', capS.size() <= 500, `size ${capS.size()}`)
const expS = createLimiter({ max: 3, windowMs: 30, maxEntries: 10_000 })
for (let i = 0; i < 300; i++) expS.hit(`e-${i}`)
await settleS(60)
expS.hit('after')
ok('[secfix S2] expired windows are evicted, not kept', expS.size() === 1, `size ${expS.size()}`)
ok('[secfix S2] the counters on the auth path are bounded', Number.isFinite(authFailureLimiter.maxEntries) && authFailureLimiter.maxEntries <= 20_000)
const malformedS = []
for (let i = 0; i < 20; i++) {
  malformedS.push(...await Promise.all(Array.from({ length: 100 }, (_, j) =>
    fetch(`${API}/keys`, { headers: { Authorization: `Bearer fake-${i}-${j}-${rndS(6).toString('hex')}` } }).then(async (r) => ({ status: r.status, body: await r.json() })))))
}
ok('[secfix S2] 2,000 distinct malformed tokens are each a 401 unauthorized, none a 429 or a 500',
   malformedS.length === 2000 && malformedS.every((r) => r.status === 401 && r.body?.error === 'unauthorized'),
   JSON.stringify([...new Set(malformedS.map((r) => r.status))]))
ok('[secfix S2] the real key still works after them', await alive(KEY) === 200)
const authSrcS = readS(`${ROOT_S}src/middleware/auth.ts`, 'utf8')
const iShape = authSrcS.indexOf('if (!isKeyShaped(token))'), iBlocked = authSrcS.indexOf('authFailureLimiter.blocked(network)')
const iLookup = authSrcS.indexOf('WHERE k.key_hash = ${hashKey(token)}'), iKeyRate = authSrcS.indexOf('checkRateLimit(rows[0].id')
ok('[secfix S2] auth.ts order: shape, then the network failure check, then the lookup, then the per-key limit by key id',
   iShape > 0 && iShape < iBlocked && iBlocked < iLookup && iLookup < iKeyRate, `${iShape} ${iBlocked} ${iLookup} ${iKeyRate}`)

// A second server with the production failure limit and small per-key/account limits.
const ACCT_S16 = '00000000-0000-0000-0000-00000000516a'
await sql`INSERT INTO accounts (id, plan, email) VALUES (${ACCT_S16}, 'free', ${`secfix-s16-${Date.now()}@example.invalid`}) ON CONFLICT (id) DO NOTHING`
const keysS16 = [1, 2, 3].map((n) => shapedKey(`s16-${n}-${Date.now()}`))
for (const k of keysS16) await insertKeyRow(sql, ACCT_S16, k, 'secfix-s16')
const srvS = await bootS({ NODE_ENV: 'test', DATABASE_SSL: 'disable', AUTH_FAILURES_PER_MINUTE: '10', RATE_LIMIT_PER_MINUTE: '5', RATE_LIMIT_ACCOUNT_PER_MINUTE: '8' }, PORT_S)
ok('[secfix] a second server with production-shaped limits started', !srvS.exited && !srvS.timedOut, srvS.out().slice(-300))
const netA = { 'fly-client-ip': '198.51.100.21' }, netB = { 'fly-client-ip': '198.51.100.22' }
const guessesS = []
for (let i = 0; i < 12; i++) guessesS.push((await getSX(API_S, '/keys', shapedKey(`guess-${i}-${Date.now()}`), netA)).status)
ok('[secfix S2] unknown keys from one network: ten 401s, then 429 before the database is asked again',
   guessesS.slice(0, 10).every((s) => s === 401) && guessesS.slice(10).every((s) => s === 429), guessesS.join(','))
const netC = { 'fly-client-ip': '198.51.100.23' }
const malformedC = []
for (let i = 0; i < 15; i++) malformedC.push((await getSX(API_S, '/keys', `not-a-key-${i}-${Date.now()}`, netC)).status)
ok('[secfix S2] malformed tokens are answered before any counter: fifteen from one network on the production-limit server are all 401, none 429',
   malformedC.every((s) => s === 401), malformedC.join(','))
const realFromB = await getSX(API_S, '/keys', keysS16[2], netB)
ok('[secfix S2] a real key from another network is unaffected', realFromB.status === 200, `${realFromB.status}`)
const manyNetsS = await Promise.all(Array.from({ length: 1500 }, (_, i) =>
  getSX(API_S, '/budget?customer_id=x', shapedKey(`spray-${i}`), { 'fly-client-ip': `100.${(i >> 8) & 255}.${i & 255}.9` }).then((r) => r.status)))
ok('[secfix S2] 1,500 well-formed fake keys from 1,500 networks are each a 401, and the server stays up',
   manyNetsS.every((s) => s === 401) && (await fetch(`${API_S}/health`).then((r) => r.status)) === 200, JSON.stringify([...new Set(manyNetsS)]))

// ------------------------------------------------ S16: per-account limit, paging
const k1S = []
for (let i = 0; i < 6; i++) k1S.push((await getSX(API_S, '/keys', keysS16[0], netB)).status)
ok('[secfix S16] per key: 5 a minute, then 429', k1S.slice(0, 5).every((s) => s === 200) && k1S[5] === 429, k1S.join(','))
const k2S = []
for (let i = 0; i < 5; i++) k2S.push(await getSX(API_S, '/keys', keysS16[1], netB))
// key 3 spent 1 above, key 1 spent 5 (its 6th was refused by the per-key limit
// before the account was counted), so the account has 8 - 6 = 2 left for key 2.
ok('[secfix S16] per account: a second key gets only what the account has left, then 429 naming the account',
   k2S.slice(0, 2).every((r) => r.status === 200) && k2S.slice(2).every((r) => r.status === 429 && /account/.test(r.body?.message ?? '')),
   k2S.map((r) => r.status).join(','))
await stopS(srvS)

const ACCT_PG = '00000000-0000-0000-0000-0000000005a9'
await sql`INSERT INTO accounts (id, plan, email) VALUES (${ACCT_PG}, 'free', ${`secfix-pg-${Date.now()}@example.invalid`}) ON CONFLICT (id) DO NOTHING`
const KEY_PG = shapedKey(`pg-${Date.now()}`)
await insertKeyRow(sql, ACCT_PG, KEY_PG, 'pg-1')
await insertKeyRow(sql, ACCT_PG, shapedKey(`pg2-${Date.now()}`), 'pg-2')
await insertKeyRow(sql, ACCT_PG, shapedKey(`pg3-${Date.now()}`), 'pg-3')
await sql`INSERT INTO customers (account_id, customer_ref, created_at)
          SELECT ${ACCT_PG}, 'c-' || g, now() - (g || ' seconds')::interval FROM generate_series(1, 205) g`
const c1S = await getSX(API, '/customers', KEY_PG)
const cur1 = c1S.headers.get('x-next-cursor')
const c2S = await getSX(API, `/customers?cursor=${cur1}`, KEY_PG)
// The body's keys are what postgres.camel made of the SELECT's aliases
// (customerId, isBlocked, createdAt) and always have been; unchanged here.
const idsS = [...(c1S.body ?? []), ...(c2S.body ?? [])].map((r) => r.customerId)
ok('[secfix S16] GET /customers: 200 by default, the next page named in X-Next-Cursor and Link, the last page with neither',
   Array.isArray(c1S.body) && c1S.body.length === 200 && !!cur1 && /rel="next"/.test(c1S.headers.get('link') ?? '')
     && c2S.body?.length === 5 && !c2S.headers.get('x-next-cursor'), `${c1S.body?.length} ${cur1} ${c2S.body?.length}`)
ok('[secfix S16] and the two pages are all 205 customers once each, newest first, in the shape callers already read',
   new Set(idsS).size === 205 && idsS[0] === 'c-1' && idsS[204] === 'c-205' && !('rowId' in c1S.body[0]) && Object.keys(c1S.body[0]).sort().join(',') === 'createdAt,customerId,isBlocked,limit,remaining,used', `${new Set(idsS).size} ${idsS[0]} ${idsS[204]}`)
const kp1 = await getSX(API, '/keys?limit=2', KEY_PG)
const kp2 = await getSX(API, `/keys?limit=2&cursor=${kp1.body?.next_cursor}`, KEY_PG)
ok('[secfix S16] GET /keys pages too: next_cursor, then null on the last page',
   kp1.body?.keys?.length === 2 && typeof kp1.body.next_cursor === 'string' && kp2.body?.keys?.length === 1 && kp2.body.next_cursor === null
     && kp1.body.keys[0].label === 'pg-1', JSON.stringify([kp1.body?.keys?.map((k) => k.label), kp2.body?.keys?.map((k) => k.label)]))
const kDefault = await getSX(API, '/keys', KEY_PG)
ok('[secfix S16] an unpaged /keys is every key plus next_cursor null, as before', kDefault.body?.keys?.length === 3 && kDefault.body.next_cursor === null)
const badPg = await Promise.all([getSX(API, '/customers?limit=0', KEY_PG), getSX(API, '/customers?limit=501', KEY_PG), getSX(API, '/customers?cursor=nope', KEY_PG)])
ok('[secfix S16] limit 0, limit 501 and a cursor this endpoint never returned are each a 422', badPg.every((r) => r.status === 422), badPg.map((r) => r.status).join(','))

// ------------------------------------------------ S4: webhook targets
const refusedS4 = {}
for (const u of ['https://169.254.169.254/', 'https://127.0.0.1/', 'https://[fdaa::3]/', 'https://x.internal/', 'https://[::ffff:127.0.0.1]/',
                 'https://[::ffff:a9fe:a9fe]/', 'https://10.0.0.1/', 'https://172.16.5.4/', 'https://192.168.1.1/', 'https://100.64.0.1/',
                 'https://0.0.0.0/', 'https://[fe80::1]/', 'https://[::1]/', 'https://localhost/', 'https://printer.local/', 'https://app.flycast/',
                 'https://intranet/', 'https://user:pw@1.1.1.1/', 'https://2130706433/']) {
  refusedS4[u] = (await post('/webhook-config', { url: u })).status
}
ok('[secfix S4] every loopback, private, link-local, ULA, Fly-internal, mapped and single-label target is refused at save time',
   Object.values(refusedS4).every((s) => s === 422), JSON.stringify(Object.entries(refusedS4).filter(([, s]) => s !== 422)))
const goodS4 = await post('/webhook-config', { url: 'https://1.1.1.1/agentbill-hook' })
const [rowS4] = await sql`SELECT webhook_url, webhook_secret_nonce FROM accounts WHERE id = ${ACCT}`
ok('[secfix S4] a public target is saved and its signing secret is returned once, never stored',
   goodS4.status === 200 && /^whsec_[0-9a-f]{64}$/.test(goodS4.body?.signing_secret ?? '') && /^[0-9a-f]{48}$/.test(rowS4.webhookSecretNonce ?? '')
     && !JSON.stringify(await sql`SELECT * FROM accounts WHERE id = ${ACCT}`).includes(goodS4.body.signing_secret), JSON.stringify(goodS4.body).slice(0, 120))
const wt = await import('../../dist/lib/webhook-target.js')
const privS = ['169.254.169.254', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', 'fdaa::3', 'fd00::1', 'fc00::1', '64:ff9b::a00:1', '2002:7f00:1::', '::', '::1', '100.127.255.254', '0.1.2.3', '::7f00:1']
const pubS = ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111', '100.128.0.1', '172.32.0.1', '::ffff:1.1.1.1']
ok('[secfix S4] the address classifier: every private form private, every public form public',
   privS.every((a) => wt.isPrivateAddress(a)) && pubS.every((a) => !wt.isPrivateAddress(a)),
   JSON.stringify({ missed: privS.filter((a) => !wt.isPrivateAddress(a)), wrong: pubS.filter((a) => wt.isPrivateAddress(a)) }))
const guardedS = await new Promise((r) => wt.guardedLookup('localhost', {}, (err) => r(err?.code ?? 'no error')))
ok('[secfix S4] at send time the connect-time resolver refuses a name that resolves to loopback', guardedS === 'EWEBHOOKPRIVATE', guardedS)
ok('[secfix S4] the send timeout is five seconds', wt.WEBHOOK_TIMEOUT_MS === 5000)
// The transport never follows a redirect: a local https server answers 302 to a
// second listener, and the second listener must never be asked.
const tlsDirS = mkdtempS(`${tmpdirS()}/agentbill-secfix-`)
spawnSyncS('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${tlsDirS}/k.pem`, '-out', `${tlsDirS}/c.pem`, '-days', '1',
  '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' })
const certS = readS(`${tlsDirS}/c.pem`), keyPemS = readS(`${tlsDirS}/k.pem`)
const { createServer: httpsServerS } = await import('node:https')
const { createServer: httpServerS } = await import('node:http')
let landedS = 0, seenS = null
const landS = httpServerS((q, a) => { landedS++; a.end('landed') }).listen(0, '127.0.0.1')
await new Promise((r) => landS.once('listening', r))
const hopS = httpsServerS({ key: keyPemS, cert: certS }, (q, a) => {
  let b = ''; q.on('data', (d) => { b += d }); q.on('end', () => {
    seenS = { headers: q.headers, body: b }
    if (q.url === '/slow') return
    a.writeHead(302, { Location: `http://127.0.0.1:${landS.address().port}/landed` }); a.end()
  })
}).listen(0, '127.0.0.1')
await new Promise((r) => hopS.once('listening', r))
const secretS = 'whsec_' + 'ab'.repeat(32)
const bodyS = JSON.stringify({ event: 'anomaly.detected', units: 9 })
const sigS = wt.signatureHeader(secretS, bodyS)
const hopRes = await wt.postOnce(`https://127.0.0.1:${hopS.address().port}/hook`, bodyS, { 'Content-Type': 'application/json', 'X-AgentBill-Signature': sigS },
  { lookup: (await import('node:dns')).lookup, ca: certS })
await settleS(200)
ok('[secfix S4] a 302 is the answer, recorded as not delivered, and its Location is never requested',
   hopRes.delivered === false && hopRes.status === 302 && landedS === 0, `${JSON.stringify(hopRes)} landed=${landedS}`)
const [, tS, vS] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(seenS?.headers?.['x-agentbill-signature'] ?? '') ?? []
ok('[secfix S4] the delivery carries X-AgentBill-Signature, an HMAC-SHA256 of "<t>.<body>" a receiver can check',
   !!vS && vS === hmacS('sha256', secretS).update(`${tS}.${seenS.body}`).digest('hex'), seenS?.headers?.['x-agentbill-signature'])
const t0S = Date.now()
const slowRes = await wt.postOnce(`https://127.0.0.1:${hopS.address().port}/slow`, bodyS, {}, { lookup: (await import('node:dns')).lookup, ca: certS, timeoutMs: 300 })
ok('[secfix S4] a target that never answers is abandoned at the timeout', slowRes.delivered === false && slowRes.reason === 'timed out' && Date.now() - t0S < 3000, `${JSON.stringify(slowRes)} ${Date.now() - t0S}ms`)
// Send time, end to end: a row that points at loopback (saved before the rule,
// or a name whose DNS changed) is never dialled when /step flags an anomaly.
let dialledS = 0
const trapS = (await import('node:net')).createServer((c) => { dialledS++; c.destroy() }).listen(0, '127.0.0.1')
await new Promise((r) => trapS.once('listening', r))
await sql`UPDATE accounts SET webhook_url = ${`https://127.0.0.1:${trapS.address().port}/hook`} WHERE id = ${ACCT}`
for (let i = 0; i < 6; i++) await post('/step', { agent_id: 'secfix-s4', step_name: 'hop', units: 10 })
const anomS = await post('/step', { agent_id: 'secfix-s4', step_name: 'hop', units: 500 })
await sql`UPDATE accounts SET webhook_url = 'https://localhost/hook' WHERE id = ${ACCT}`
await post('/step', { agent_id: 'secfix-s4', step_name: 'hop', units: 900 })
await settleS(500)
ok('[secfix S4] at send time, an anomaly for a loopback webhook row is flagged and nothing is dialled',
   anomS.body?.anomaly === true && dialledS === 0, `anomaly=${anomS.body?.anomaly} dialled=${dialledS}`)
await sql`UPDATE accounts SET webhook_url = NULL, webhook_secret_nonce = NULL WHERE id = ${ACCT}`
hopS.close(); landS.close(); trapS.close()

// ------------------------------------------------ S5 + S24: Polar upgrades only on a paid event for a sold product, once
const planOfS = async () => (await sql`SELECT plan FROM accounts WHERE id = ${ACCT}`)[0].plan
const toFreeS = () => sql`UPDATE accounts SET plan = 'free', polar_customer_id = NULL WHERE id = ${ACCT}`
const md = { agentbill_account_id: ACCT }
const B = process.env.POLAR_PRODUCT_ID_BUILDER, T = process.env.POLAR_PRODUCT_ID_TEAM
await toFreeS()
const s5 = {}
s5.pendingOrder = [(await hook({ type: 'order.created', data: { status: 'pending', product_id: B, customer_id: 'cus_s5', metadata: md } })).status, await planOfS()]
s5.createdOrderPaid = [(await hook({ type: 'order.created', data: { status: 'paid', product_id: B, customer_id: 'cus_s5', metadata: md } })).status, await planOfS()]
s5.unknownProduct = [(await hook({ type: 'order.paid', data: { status: 'paid', product_id: 'prod_nobody_sells_this', customer_id: 'cus_s5', metadata: md } })).status, await planOfS()]
s5.noProduct = [(await hook({ type: 'order.paid', data: { status: 'paid', customer_id: 'cus_s5', metadata: md } })).status, await planOfS()]
s5.incompleteSub = [(await hook({ type: 'subscription.created', data: { status: 'incomplete', product_id: T, customer_id: 'cus_s5', metadata: md } })).status, await planOfS()]
s5.activeNoStatus = [(await hook({ type: 'subscription.active', data: { product_id: T, customer_id: 'cus_s5', metadata: md } })).status, await planOfS()]
ok('[secfix S5] a pending order, order.created, an unknown product, no product, an incomplete subscription: each 200, none upgrades',
   Object.values(s5).every(([st, pl]) => st === 200 && pl === 'free'), JSON.stringify(s5))
const paidS = await hook({ type: 'order.paid', data: { status: 'paid', product_id: B, customer_id: 'cus_s5', metadata: md } })
const planPaid = await planOfS()
await toFreeS()
const subS = await hook({ type: 'subscription.created', data: { status: 'active', product_id: T, customer_id: 'cus_s5', metadata: md } })
const planSub = await planOfS()
ok('[secfix S5] order.paid for a sold product upgrades to that product\'s plan, and so does an active subscription',
   paidS.status === 200 && planPaid === 'builder' && subS.status === 200 && planSub === 'team', `${planPaid} ${planSub}`)
// Replay: the same delivery (same webhook-id, same body, fresh signature window) twice.
await toFreeS()
const replayBody = JSON.stringify({ type: 'order.paid', data: { status: 'paid', product_id: B, customer_id: 'cus_s5r', metadata: md } })
const replayHdr = signHeaders(replayBody)
const r1S = await postHook(replayBody, replayHdr)
const planR1 = await planOfS()
await toFreeS()
const r2S = await postHook(replayBody, replayHdr)
const planR2 = await planOfS()
const [claimS] = await sql`SELECT count(*)::int AS n FROM polar_webhook_deliveries WHERE webhook_id = ${replayHdr['webhook-id']}`
ok('[secfix S24] one delivery acts once: a replay of the same webhook-id is 200, acknowledged as a duplicate, and changes nothing',
   r1S.status === 200 && planR1 === 'builder' && r2S.status === 200 && /"duplicate":true/.test(r2S.body) && planR2 === 'free' && claimS.n === 1,
   `${planR1} ${r2S.body} ${planR2} claims=${claimS.n}`)
await toFreeS()

// ------------------------------------------------ S7: metadata bounds
const recS = (metadata, extra = {}) => rec({ customer_id: 'secfix-s7', event_type: 'run', idempotency_key: `s7-${rndS(6).toString('hex')}`, units: 1, metadata, ...extra })
const pad = (n) => ({ blob: 'x'.repeat(n - '{"blob":""}'.length) })
const at8k = await recS(pad(8192)), over8k = await recS(pad(8193))
const keys32 = await recS(Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`k${i}`, i])))
const keys33 = await recS(Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, i])))
ok('[secfix S7] metadata of exactly 8,192 bytes and of 32 keys records; 8,193 bytes and 33 keys are each a 422 that says why',
   at8k.status === 200 && keys32.status === 200 && over8k.status === 422 && /8193 bytes/.test(over8k.body?.message) && keys33.status === 422 && /33 keys/.test(keys33.body?.message),
   JSON.stringify([at8k.status, keys32.status, over8k.body, keys33.body]))
const wrapShape = { provider: 'openai', model: 'gpt-4o-mini-2024-07-18', duration_ms: 1234, requested_model: 'gpt-4o-mini', step: 'draft', stream: true, service_tier: 'default',
                    tokens: { input: 1200, output: 300, cached_input: 100, reasoning: 0 } }
ok('[secfix S7] the metadata wrap() writes is well under both bounds', Object.keys(wrapShape).length <= 8 && JSON.stringify(wrapShape).length < 1024 && (await recS(wrapShape)).status === 200)
const hugeS = await fetch(`${API}/events`, { method: 'POST', headers: bearerS(KEY), body: JSON.stringify({ customer_id: 'x', event_type: 'run', idempotency_key: 'huge', metadata: { a: 'x'.repeat(70_000) } }) })
ok('[secfix S7] a body over 64 KB is refused before it is parsed (413)', hugeS.status === 413, `${hugeS.status}`)

// ------------------------------------------------ S8: the owner's usage alert, escaped and capped
const { usageAlertMail } = await import('../../dist/routes/events.js')
const evilRef = '<img src=x onerror=alert(1)>"&'
const mailS8 = usageAlertMail(ACCT, evilRef, 900)
ok('[secfix S8] a customer_id carrying markup is escaped in the alert body and stripped from the subject',
   !mailS8.html.includes('<img') && mailS8.html.includes('&lt;img src=x onerror=alert(1)&gt;&quot;&amp;') && !/[<>"&]/.test(mailS8.subject.replace(/^AgentBill: customer "/, '').replace(/" has used 900 units$/, '')),
   mailS8.subject)
const ACCT_S8 = '00000000-0000-0000-0000-0000000005e8'
await sql`INSERT INTO accounts (id, plan, email) VALUES (${ACCT_S8}, 'free', ${`secfix-s8-${Date.now()}@example.invalid`}) ON CONFLICT (id) DO NOTHING`
const KEY_S8 = shapedKey(`s8-${Date.now()}`)
await insertKeyRow(sql, ACCT_S8, KEY_S8, 's8')
for (let i = 0; i < 6; i++) {
  await postS(API, '/events', { customer_id: `s8-${i}-${evilRef}`, event_type: 'run', idempotency_key: `s8-${i}-${Date.now()}`, units: 900 }, KEY_S8)
}
await postS(API, '/events', { customer_id: 's8-0-' + evilRef, event_type: 'run', idempotency_key: `s8-again-${Date.now()}`, units: 900 }, KEY_S8)
await settleS(500)
const claimsS8 = (await sql`SELECT customer_ref FROM customer_usage_alerts WHERE account_id = ${ACCT_S8} ORDER BY id`).map((r) => r.customerRef)
let logS8 = ''
try { logS8 = readS(process.env.SERVER_LOG ?? '/tmp/agentbill-verify-server.log', 'utf8') } catch {}
const suppressedS8 = logS8.split('\n').filter((l) => l.includes('usage alert suppressed') && l.includes(ACCT_S8)).length
ok('[secfix S8] six customers crossing 800 on one account: six claims, one each, and all but the daily three suppressed',
   claimsS8.length === 6 && new Set(claimsS8).size === 6 && suppressedS8 === 3, `claims=${claimsS8.length} suppressed=${suppressedS8}`)

// ------------------------------------------------ S9: admin
const loginS9 = (secret, extra = {}) => fetch(`${API}/admin/login`, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin', 'fly-client-ip': '198.51.100.90', ...extra },
  body: `secret=${encodeURIComponent(secret)}`,
})
const WRONG_S9 = `wrong-${rndS(8).toString('hex')}`
const triesS9 = []
for (let i = 0; i < 11; i++) triesS9.push((await loginS9(WRONG_S9)).status)
ok('[secfix S9] /admin/login: ten attempts a network, then 429', triesS9.slice(0, 10).every((s) => s === 401) && triesS9[10] === 429, triesS9.join(','))
const rightBlocked = await loginS9(process.env.ADMIN_SECRET)
ok('[secfix S9] and the limit holds for the right secret from that network too', rightBlocked.status === 429)
const crossS9 = await loginS9(process.env.ADMIN_SECRET, { 'Sec-Fetch-Site': 'cross-site', 'fly-client-ip': '198.51.100.91' })
ok('[secfix S9] a cross-site login POST is refused', crossS9.status === 403)
const goodS9 = await loginS9(process.env.ADMIN_SECRET, { 'fly-client-ip': '198.51.100.92' })
const setS9 = goodS9.headers.get('set-cookie') ?? ''
const tokS9 = /agentbill_admin=([^;]+)/.exec(setS9)?.[1] ?? ''
const [, iatS9, expS9] = /^(\d{10})\.(\d{10})\.[0-9a-f]{64}$/.exec(tokS9) ?? []
ok('[secfix S9] a good login sets a token that carries its issue time and a twelve-hour expiry',
   goodS9.status === 303 && Number(expS9) - Number(iatS9) === 43200 && /Max-Age=43200/.test(setS9) && /HttpOnly/.test(setS9) && /SameSite=Strict/.test(setS9), setS9.replace(/=[0-9a-f.]{40,}/, '=...'))
const pageS9 = (cookie, extra = {}) => fetch(`${API}/admin`, { headers: { ...(cookie ? { cookie: `agentbill_admin=${cookie}` } : {}), ...extra } }).then((r) => r.text())
const DASH = 'Page loads (30d / 7d)'
const macS9 = (iat, exp) => hmacS('sha256', process.env.ADMIN_SECRET).update(`agentbill-admin-session-v2.${iat}.${exp}`).digest('hex')
const nowS9 = Math.floor(Date.now() / 1000)
const expiredTok = `${nowS9 - 50000}.${nowS9 - 50000 + 43200}.${macS9(nowS9 - 50000, nowS9 - 50000 + 43200)}`
const legacyTok = hmacS('sha256', process.env.ADMIN_SECRET).update('agentbill-admin-session').digest('hex')
const tamperedTok = tokS9.replace(/.$/, (c) => (c === '0' ? '1' : '0'))
const viewsS9 = {
  fresh: (await pageS9(tokS9)).includes(DASH),
  expired: (await pageS9(expiredTok)).includes(DASH),
  legacyConstant: (await pageS9(legacyTok)).includes(DASH),
  tampered: (await pageS9(tamperedTok)).includes(DASH),
  bearerSecret: (await pageS9('', { Authorization: `Bearer ${process.env.ADMIN_SECRET}` })).includes(DASH),
}
ok('[secfix S9] only the fresh token opens /admin: an expired one, the old constant one, a tampered one and the raw secret as Bearer do not',
   viewsS9.fresh && !viewsS9.expired && !viewsS9.legacyConstant && !viewsS9.tampered && !viewsS9.bearerSecret, JSON.stringify(viewsS9))
const acctsBearer = await fetch(`${API}/admin/accounts`, { headers: { Authorization: `Bearer ${process.env.ADMIN_SECRET}` } })
const acctsCookie = await fetch(`${API}/admin/accounts`, { headers: { cookie: `agentbill_admin=${tokS9}` } })
ok('[secfix S9] /admin/accounts: 401 to the raw secret as Bearer, 200 to the session', acctsBearer.status === 401 && acctsCookie.status === 200, `${acctsBearer.status} ${acctsCookie.status}`)
const outS9 = await fetch(`${API}/admin/logout`, { method: 'POST', redirect: 'manual', headers: { 'Sec-Fetch-Site': 'same-origin', cookie: `agentbill_admin=${tokS9}` } })
ok('[secfix S9] POST /admin/logout clears the cookie', outS9.status === 303 && /agentbill_admin=;.*Max-Age=0/.test(outS9.headers.get('set-cookie') ?? ''), outS9.headers.get('set-cookie'))
let logS9 = ''
try { logS9 = readS(process.env.SERVER_LOG ?? '/tmp/agentbill-verify-server.log', 'utf8') } catch {}
ok('[secfix S9] failed logins are logged as warnings, and the value typed is not',
   logS9.split('\n').filter((l) => l.includes('admin login failed') && l.includes('"level":40')).length >= 10 && !logS9.includes(WRONG_S9))

// ------------------------------------------------ S11: /register is same-origin only for browsers
const regS11 = (extra) => fetch(`${API}/register`, { method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/json', 'fly-client-ip': `198.51.100.${110 + Math.floor(Math.random() * 100)}`, ...extra },
  body: JSON.stringify({ email: `secfix-s11-${rndS(5).toString('hex')}@example.invalid` }) })
const crossForm = await fetch(`${API}/register`, { method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example', 'fly-client-ip': '198.51.100.101' },
  body: `email=${encodeURIComponent(`secfix-s11-x-${Date.now()}@example.invalid`)}` })
const crossOrigin = await regS11({ Origin: 'https://evil.example' })
const sameS11 = await regS11({ 'Sec-Fetch-Site': 'same-origin' })
const bareS11 = await regS11({})
ok('[secfix S11] a cross-site form POST to /register is 403, and so is a foreign Origin without Sec-Fetch-Site',
   crossForm.status === 403 && crossOrigin.status === 403, `${crossForm.status} ${crossOrigin.status}`)
// 2026-09-25: /register makes no account and signs nobody in, so neither
// answer carries a cookie now; both mail a link and say so.
ok('[secfix S11] same-origin and a headerless client (curl, the SDKs) both get 202 check_email, and neither gets a cookie',
   sameS11.status === 202 && !sameS11.headers.get('set-cookie') && bareS11.status === 202 && !bareS11.headers.get('set-cookie'),
   `${sameS11.status} ${bareS11.status} ${bareS11.headers.get('set-cookie')}`)
const [crossRow] = await sql`SELECT count(*)::int AS n FROM accounts WHERE email LIKE 'secfix-s11-x-%'`
ok('[secfix S11] and the refused cross-site POST created no account', crossRow.n === 0)

// ------------------------------------------------ S21: no form can put the email in a URL
const regHtmlS = await fetch(`${API}/register`).then((r) => r.text())
const formTagS = (id) => (regHtmlS.match(new RegExp(`<form[^>]*id="${id}"[^>]*>`)) ?? [''])[0]
// The signup form is the sign-in block's email form since 2026-09-25; the
// profile form left /register with the key screen.
ok('[secfix S21] the signup form says method="post"',
   /method="post"/i.test(formTagS('email-form')) && !regHtmlS.includes('id="profile-form"'), formTagS('email-form'))

// ------------------------------------------------ S14: tokens and query strings stay out of the log
const tokS14 = rndS(32).toString('base64url')
await sql`INSERT INTO account_recovery_tokens (account_id, token_hash, expires_at) VALUES (${ACCT}, ${hashS('sha256').update(tokS14).digest('hex')}, NOW() + INTERVAL '10 minutes')`
const QS14 = `q${rndS(6).toString('hex')}`
await fetch(`${API}/recover/${tokS14}?src=${QS14}`)
await fetch(`${API}/recover/${tokS14}`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin' }, body: 'action=noop' })
await fetch(`${API}/pricing?utm_campaign=${QS14}`)
await settleS(300)
let logS14 = ''
try { logS14 = readS(process.env.SERVER_LOG ?? '/tmp/agentbill-verify-server.log', 'utf8') } catch {}
ok('[secfix S14] the log never holds a recovery token or a query string, and says /recover/[redacted] instead',
   logS14.length > 0 && !logS14.includes(tokS14) && !logS14.includes(revealToken) && !logS14.includes(QS14) && logS14.includes('/recover/[redacted]'),
   `token=${logS14.includes(tokS14)} reveal=${logS14.includes(revealToken)} query=${logS14.includes(QS14)}`)
ok('[secfix S14] and no signup or recovery log line carries an email address',
   !logS14.split('\n').some((l) => /"msg":"(new signup|recovery email was not accepted by Resend)"/.test(l) && /@example\.invalid/.test(l)))

// ------------------------------------------------ S10, S15, S18: production boot rules
const { dbSsl } = await import('../../dist/db/tls.js')
let prodSsl = { mode: 'threw', ssl: {} }
try { prodSsl = dbSsl({ NODE_ENV: 'production' }) } catch {}
ok('[secfix S10] in production the default is verify: rejectUnauthorized, with the Supabase root among the CAs',
   prodSsl.mode === 'verify' && prodSsl.ssl.rejectUnauthorized === true && (prodSsl.ssl.ca ?? []).some((c) => c.includes('MIIDxDCCAqygAwIBAgIUbLxMod62P2ktCiAkxnKJwtE9VPYw')))
const throwsS = (env) => { try { dbSsl(env); return false } catch { return true } }
ok('[secfix S10] require and disable refuse in production without the override, and are allowed elsewhere',
   throwsS({ NODE_ENV: 'production', DATABASE_SSL: 'require' }) && throwsS({ NODE_ENV: 'production', DATABASE_SSL: 'disable' })
     && dbSsl({ NODE_ENV: 'production', DATABASE_SSL: 'require', DATABASE_SSL_INSECURE_OK: '1' }).notice?.includes('NOT verified')
     && dbSsl({}).mode === 'require' && dbSsl({ DATABASE_SSL: 'disable' }).ssl === false && throwsS({ DATABASE_SSL: 'bogus' }))
const LONG = 'x'.repeat(40)
const prodDisable = await bootS({ NODE_ENV: 'production', DATABASE_SSL: 'disable', APP_SESSION_SECRET: LONG }, PORT_S)
ok('[secfix S10] a production boot with DATABASE_SSL=disable and no override exits instead of serving',
   prodDisable.exited && prodDisable.code !== 0 && /Refusing to start/.test(prodDisable.out()), `exited=${prodDisable.exited} code=${prodDisable.code}`)
await stopS(prodDisable)
const shortSecret = await bootS({ NODE_ENV: 'production', DATABASE_SSL: 'disable', DATABASE_SSL_INSECURE_OK: '1', APP_SESSION_SECRET: 'short' }, PORT_S)
ok('[secfix S18] a production boot with a 5-byte APP_SESSION_SECRET exits and says which secret',
   shortSecret.exited && shortSecret.code === 1 && /APP_SESSION_SECRET is 5 bytes/.test(shortSecret.out()), shortSecret.out().slice(-200))
await stopS(shortSecret)
const shortAdmin = await bootS({ NODE_ENV: 'production', DATABASE_SSL: 'disable', DATABASE_SSL_INSECURE_OK: '1', APP_SESSION_SECRET: LONG, ADMIN_SECRET: 'tiny' }, PORT_S)
ok('[secfix S18] and so does one with a short ADMIN_SECRET', shortAdmin.exited && shortAdmin.code === 1 && /ADMIN_SECRET is 4 bytes/.test(shortAdmin.out()))
await stopS(shortAdmin)
// verify mode against this harness's plain, TLS-less Postgres: it starts, the
// probe fails, and /health/db says down without the driver's words.
const prodVerify = await bootS({ NODE_ENV: 'production', APP_SESSION_SECRET: LONG }, PORT_S)
const hdbRes = await fetch(`${API_S}/health/db`).catch(() => null)
const hdb = hdbRes ? await hdbRes.json().catch(() => ({})) : {}
ok('[secfix S15] /health/db when the database is unreachable: 503 {status:"down"} and no driver message',
   hdbRes?.status === 503 && hdb.status === 'down' && hdb.db === 'down' && !('error' in hdb) && Object.keys(hdb).sort().join(',') === 'db,latency_ms,status', JSON.stringify(hdb))
ok('[secfix S15] and the detail went to the log instead', /database probe failed/.test(prodVerify.out()))
await stopS(prodVerify)
const insecureOk = await bootS({ NODE_ENV: 'production', DATABASE_SSL: 'disable', DATABASE_SSL_INSECURE_OK: '1', APP_SESSION_SECRET: LONG }, PORT_S)
ok('[secfix S10] with the explicit override it serves, and says so loudly', !insecureOk.exited && /WARNING DATABASE_SSL=disable/.test(insecureOk.out()))
await stopS(insecureOk)

// ------------------------------------------------ S23, S24: the published words, the image
const secMd = readS(`${ROOT_S}SECURITY.md`, 'utf8')
ok('[secfix S23] SECURITY.md names the supported versions, the contacts, and what the clients send',
   ['agentbill-sdk', '0.7.x', '0.5.x', 'agentbill-mcp', '0.2.x', '@agentbill/openclaw', 'hello@agentbill.dev', 'private vulnerability reporting',
    'requested_model', 'service_tier', 'response id', 'never'].every((w) => secMd.includes(w)) && !secMd.includes('gmail') && !secMd.includes('0.3.x'),
   ['agentbill-sdk', '0.7.x', '0.5.x', 'agentbill-mcp', '0.2.x', '@agentbill/openclaw', 'hello@agentbill.dev', 'private vulnerability reporting', 'requested_model', 'service_tier', 'response id'].filter((w) => !secMd.includes(w)).join(','))
const secPage = await fetch(`${API}/security`)
const secHtml = await secPage.text()
const secText = visible8(secHtml).replace(/\s+/g, ' ')
const sitemapSX = await fetch(`${API}/sitemap.xml`).then((r) => r.text())
const homeS = await fetch(`${API}/`).then((r) => r.text())
const docsSX = await fetch(`${API}/docs`).then((r) => r.text())
ok('[secfix S23] /security is a public page, in the sitemap, linked from the footer and from /docs',
   secPage.status === 200 && sitemapSX.includes('<loc>https://agentbill.dev/security</loc>') && /<footer[\s\S]*href="\/security"[\s\S]*<\/footer>/.test(homeS)
     && /<main[\s\S]*href="\/security"[\s\S]*<\/main>/.test(docsSX), `${secPage.status}`)
ok('[secfix S23] /security says how to report and how to revoke, and claims no key hashing',
   secText.includes('hello@agentbill.dev') && secText.includes('/keys/revoke') && !/\bhash(ed|es)? (API )?keys\b|keys are (stored )?hashed/i.test(secText) && /plain text/i.test(secText),
   secText.slice(0, 160))
ok('[secfix S23] and none of its copy says stop, block or kill, or carries an em dash',
   !/\b(stops|blocks|kills)\b/i.test(secText) && !secHtml.includes('\u2014'))
ok('[secfix S24] the runtime image runs as the node user', /^USER node$/m.test(readS(`${ROOT_S}Dockerfile`, 'utf8')))

// ------------------------------------------------ [auth] sign-in (2026-09-25), in its own file
const { authGates } = await import('./auth-gates.mjs')
await authGates({
  API, sql, ok, bootS, stopS, portS: PORT_S,
  fakeBase: process.env.OAUTH_TEST_BASE, outbox: process.env.MAIL_TEST_OUTBOX,
  serverLog: process.env.SERVER_LOG ?? '/tmp/agentbill-verify-server.log',
  legacyKey: KEY, legacyAccount: ACCT,
})

// ------------------------------------------------ [usd] a job whose ceiling is in dollars (T3, 2026-09-25), in its own file
const { usdGates } = await import('./usd-gates.mjs')
await usdGates({ API, sql, ok, legacyKey: KEY })

// ------------------------------------------------ [mcp] the remote MCP endpoint (2026-09-25), in its own file
// ------------------------------------------------ [openclaw] and [connect-marks] (2026-09-25), in their own file
const { openclawGates } = await import('./openclaw-gates.mjs')
await openclawGates({ API, ok })

const { mcpGates } = await import('./mcp-gates.mjs')
await mcpGates({
  API, sql, ok, bootS, stopS, portS: PORT_S,
  serverLog: process.env.SERVER_LOG ?? '/tmp/agentbill-verify-server.log',
  legacyKey: KEY, legacyAccount: ACCT,
})

// ------------------------------------------------ [keyhash] API keys stored hashed (security batch B, 2026-09-25), in its own file
const { keyhashGates, keyhashFinalGates } = await import('./keyhash-gates.mjs')
await keyhashGates({
  API, sql, ok, bootS, stopS, portS: PORT_S, adminCookie, root: ROOT_S,
  outbox: process.env.MAIL_TEST_OUTBOX,
  preKey: process.env.PRE_026_KEY, preAccount: process.env.PRE_026_ACCOUNT,
})
// ------------------------------------------------ [batchc] security batch C (2026-09-25), in its own file
const { batchcGates } = await import('./batchc-gates.mjs')
await batchcGates({
  API, sql, ok, bootS, stopS, portS: PORT_S, adminCookie, root: ROOT_S,
  outbox: process.env.MAIL_TEST_OUTBOX,
  serverLog: process.env.SERVER_LOG ?? '/tmp/agentbill-verify-server.log',
})
// ------------------------------------------------ [inbound] hello@agentbill.dev forwarding (2026-09-25), in its own file
const { inboundGates } = await import('./inbound-gates.mjs')
await inboundGates({ API, sql, ok, bootS, stopS, portS: PORT_S })
// ------------------------------------------------ [dash] the overview's dashboard (M2, 2026-09-26), in its own file
const { dashGates } = await import('./dash-gates.mjs')
await dashGates({ API, sql, ok })
const { reportGates } = await import('./report-gates.mjs')
await reportGates({ API, sql, ok })
const { officeGates } = await import('./office-gates.mjs')
await officeGates({ API, sql, ok })
const { setupGates } = await import('./setup-gates.mjs')
await setupGates({ API, sql, ok })
const { spikeGates } = await import('./spike-gates.mjs')
await spikeGates({ API, sql, ok, bootS, stopS, portS: PORT_S })
// ------------------------------------------------ [capi] Meta Conversions API (2026-09-26), in its own file
const { capiGates } = await import('./capi-gates.mjs')
await capiGates({ API, sql, ok, bootS, stopS, portS: PORT_S })
// Last, so every mail and every log line of the run is in what they read.
await new Promise((r) => setTimeout(r, 500))
keyhashFinalGates({ ok, serverLog: process.env.SERVER_LOG ?? '/tmp/agentbill-verify-server.log', outbox: process.env.MAIL_TEST_OUTBOX })

console.log(`\n${pass} passed, ${fail} failed`)
await sql.end()
process.exit(fail === 0 ? 0 : 1)
