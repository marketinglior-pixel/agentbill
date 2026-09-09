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

console.log(`\n${pass} passed, ${fail} failed`)
await sql.end()
process.exit(fail === 0 ? 0 : 1)
