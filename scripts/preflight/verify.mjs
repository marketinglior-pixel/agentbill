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
ok('[onboarding] the first run is three steps and a form, not a curl that manufactures a refusal',
   virgin8.includes('class="setf3"') && virgin8.includes('Three steps put a row on this page')
     && !virgin8.includes('"ceiling":1'), 'the virgin overview did not render the steps')
// Locked path, item 4: "one job = one budget" is read first, the wire name second.
const iBudget8 = virgin8.indexOf('One job is one budget')
const iRef8 = virgin8.indexOf('task_ref')
ok('[onboarding] "one job is one budget" is read before the name task_ref',
   iBudget8 > -1 && iRef8 > -1 && iBudget8 < iRef8, `budget at ${iBudget8}, task_ref at ${iRef8}`)
ok('[onboarding] and the page says whose decision the refusal is',
   virgin8.includes('Your code decides what the job does next'))
// The sample is task_ref-only on purpose: the ceiling is set before the code
// runs, and a task_ceiling sent after the job exists is not applied.
const snipAt8 = virgin8.indexOf('<div class="snip">')
const snip8 = snipAt8 === -1 ? '' : virgin8.slice(snipAt8, virgin8.indexOf('</div>', snipAt8))
ok('[onboarding] the sample preflights with task_ref and carries no task_ceiling',
   snip8.includes('task_ref=&quot;') && !snip8.includes('task_ceiling'), snip8.slice(0, 120))
// After a save the sample is the reader's own job, read off the row.
await nav8('/app/tasks', { method: 'POST', headers: { ...FORM8, cookie: cookie8 }, body: 'task_ref=job-mine&ceiling_units=5' })
const mine8 = await nav8('/app?view=tasks&saved=job-mine&created=1', { headers: { cookie: cookie8 } }).then(r => r.text())
ok('[onboarding] a saved job puts its own name in the lines the reader pastes',
   mine8.includes('task_ref=&quot;job-mine&quot;') && mine8.includes('units left: 4'), 'no personalised sample')
// A name that cannot sit inside a Python string falls back rather than
// rendering a block that does not parse. esc() is HTML escaping: &quot;
// renders in the browser as the character that closes the string.
await nav8('/app/tasks', { method: 'POST', headers: { ...FORM8, cookie: cookie8 }, body: `task_ref=${encodeURIComponent('say "hi"')}&ceiling_units=5` })
const quoted8 = await nav8('/app?view=tasks', { headers: { cookie: cookie8 } }).then(r => r.text())
ok('[onboarding] a job name carrying a quote does not go inside the sample',
   quoted8.includes('cannot hold inline') && !quoted8.includes('task_ref=&quot;say &quot;hi&quot;'), 'the quote reached the sample')
// The microcopy bans, measured on the VISIBLE text and not the markup: every
// one of these words appears inside the CSS of every page on the site
// (display:block, flex-wrap), so a grep over HTML can only ever be noise.
const visible8 = (h) => h.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<script[\s\S]*?<\/script>/g, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ')
const register8 = await fetch(`${API}/register`).then(r => r.text())
const login8b = await fetch(`${API}/app`).then(r => r.text())
for (const [name, html] of [['the console first run', virgin8], ['the console after a save', mine8],
                            ['/register', register8], ['the console login card', login8b]]) {
  const hits = visible8(html).match(/\b[a-z]*(stop|kill|block|dies)[a-z]*\b/gi) ?? []
  ok(`[onboarding] ${name} never says the run is stopped, killed, blocked or dies`, hits.length === 0, hits.join(', '))
}

console.log(`\n${pass} passed, ${fail} failed`)
await sql.end()
process.exit(fail === 0 ? 0 : 1)
