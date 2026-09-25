// [batchc] Security batch C (2026-09-25): the audit items left after batches A
// and B. One section per item, each on accounts it plants and deletes itself.
//
//   [S7 events]  POST /events and POST /step count against a monthly
//                records-and-steps allowance (migration 028,
//                src/lib/event-quota.ts), exactly under concurrency, and the
//                record that settles its own preflight is never refused.
//   [S24 payments] a canceled plan runs to the end of its paid period
//                (migration 029, src/lib/plan-period.ts); the checkout is
//                minted for the signed-in session's account only, never for
//                an account id in a URL.
//   [S17 logout] logging out of a key session ends it on the server
//                (migration 030): a copy of the cookie is dead after it.
//   [migration tls] scripts/db/apply-migration.mjs verifies the database
//                certificate by the server's own rule; the only opt-out is
//                DATABASE_SSL=disable on this machine.
//
// Every gate here was planted red once before it was trusted; the plants and
// which gate each turned red are in the commit that added the gate.
import { insertKeyRow } from './key-fixture.mjs'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'

const shaped = (tag) => 'agb_' + createHash('sha256').update(`${tag}-${randomBytes(6).toString('hex')}`).digest('hex').slice(0, 48)

export async function batchcGates(opts) {
  const sections = [['S7 events', eventsGates], ['S24 payments', paymentsGates], ['S17 logout', logoutGates], ['migration tls', migrationTlsGates]]
  for (const [name, fn] of sections) {
    console.log(`\n[batchc ${name}]`)
    let reached = false
    try {
      await fn(opts)
      reached = true
    } catch (err) {
      opts.ok(`[batchc ${name}] a gate threw`, false, String(err?.stack ?? err).slice(0, 800))
    }
    opts.ok(`[batchc ${name}] every gate ran to the end`, reached)
  }
}

// ------------------------------------------------------------------ S7
async function eventsGates({ API, sql, ok }) {
  const E = '00000000-0000-0000-0000-0000000000e7'
  const KE = shaped('batchc-events')
  // One network for every call here, so the new-network alert mails nobody
  // and the per-network limits are not what is being measured.
  const NET = { 'fly-client-ip': '198.18.7.7' }
  await sql`DELETE FROM accounts WHERE id = ${E}`
  await sql`INSERT INTO accounts (id, plan, monthly_calls, billing_period_start) VALUES (${E}, 'free', 0, date_trunc('month', CURRENT_DATE)::date)`
  await insertKeyRow(sql, E, KE, 'harness-batchc-events')
  const call = async (path, body, k = KE) => {
    const r = await fetch(`${API}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${k}`, 'Content-Type': 'application/json', ...NET }, body: JSON.stringify(body) })
    return { status: r.status, body: await r.json().catch(() => null) }
  }
  let n = 0
  const uniq = () => `bc-${Date.now().toString(36)}-${n++}`
  const rec = (b = {}) => call('/events', { customer_id: 'bc-cust', event_type: 'bc-agent', idempotency_key: uniq(), units: 3, ...b })
  const step = () => call('/step', { agent_id: 'bc-agent', step_name: 'bc-step', units: 5 })
  const pre = (b = {}) => call('/preflight', { agent_id: 'bc-agent', customer_id: 'bc-cust', estimated_units: 4, ...b })
  const state = async () => (await sql`SELECT plan, monthly_calls, monthly_events FROM accounts WHERE id = ${E}`)[0]
  const set = async (fields) => { await sql`UPDATE accounts SET ${sql(fields)} WHERE id = ${E}` }
  const eventRows = async () => (await sql`SELECT count(*)::int AS n FROM events WHERE account_id = ${E}`)[0].n
  const stepRows = async () => (await sql`SELECT count(*)::int AS n FROM step_costs WHERE account_id = ${E}`)[0].n
  const LIMIT = 3_000   // the documented Free allowance: 3 per preflight call, 1,000 calls

  const { eventLimitFor, EVENTS_PER_PREFLIGHT_CALL } = await import('../../dist/lib/event-quota.js')
  ok('[S7 events] the allowance is 3 records or steps per included preflight call: Free 3,000, Builder 150,000, Team 1,500,000, Scale 6,000,000, legacy paid uncapped',
     EVENTS_PER_PREFLIGHT_CALL === 3 && eventLimitFor('free') === LIMIT && eventLimitFor('builder') === 150_000 && eventLimitFor('team') === 1_500_000
       && eventLimitFor('scale') === 6_000_000 && eventLimitFor('paid') === null && eventLimitFor('nonsense') === LIMIT)

  // ---- 40 records in parallel, 5 of room: exactly 5 stored, 35 refused
  await set({ monthly_events: LIMIT - 5 })
  const r40 = await Promise.all(Array.from({ length: 40 }, () => rec()))
  const stored40 = r40.filter((r) => r.status === 200 && r.body?.status === 'recorded').length
  const refused40 = r40.filter((r) => r.status === 402 && r.body?.reason === 'free_tier_exceeded' && r.body?.quota === 'events').length
  const s40 = await state()
  ok('[S7 events] 40 records in parallel with 5 of the month left: exactly 5 stored and 35 refused, nothing else (no overshoot, no refusal while there was room)',
     stored40 === 5 && refused40 === 35 && s40.monthlyEvents === LIMIT && await eventRows() === 5,
     `stored ${stored40}, refused ${refused40}, statuses ${[...new Set(r40.map((r) => r.status))]}, counter ${s40.monthlyEvents}, rows ${await eventRows()}`)
  const one = r40.find((r) => r.status === 402)?.body ?? {}
  ok('[S7 events] the refusal is preflight\'s quota shape: approved false, recorded false, reason free_tier_exceeded, plan, monthly_events, events_limit and upgrade_url to /pricing',
     one.approved === false && one.recorded === false && one.plan === 'free' && one.monthly_events === LIMIT && one.events_limit === LIMIT
       && typeof one.upgrade_url === 'string' && one.upgrade_url.startsWith('https://agentbill.dev/pricing') && /records and steps/.test(one.message ?? ''),
     JSON.stringify(one))

  // ---- steps, the same way
  await set({ monthly_events: LIMIT - 5 })
  const s40r = await Promise.all(Array.from({ length: 40 }, () => step()))
  const sOk = s40r.filter((r) => r.status === 200 && r.body?.recorded === true).length
  const sNo = s40r.filter((r) => r.status === 402 && r.body?.quota === 'events').length
  ok('[S7 events] 40 steps in parallel with 5 left: exactly 5 stored and 35 refused with the same refusal',
     sOk === 5 && sNo === 35 && (await state()).monthlyEvents === LIMIT && await stepRows() === 5,
     `ok ${sOk}, refused ${sNo}, counter ${(await state()).monthlyEvents}, step rows ${await stepRows()}`)

  // ---- records and steps share one allowance
  const rowsBefore = (await eventRows()) + (await stepRows())
  await set({ monthly_events: LIMIT - 10 })
  const mix = await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? rec() : step())))
  const mixOk = mix.filter((r) => r.status === 200).length
  const rowsAfter = (await eventRows()) + (await stepRows())
  ok('[S7 events] 20 records and 20 steps in parallel with 10 left: 10 stored between them, the counter on the limit, 10 new rows',
     mixOk === 10 && mix.filter((r) => r.status === 402).length === 30 && (await state()).monthlyEvents === LIMIT && rowsAfter - rowsBefore === 10,
     `ok ${mixOk}, rows +${rowsAfter - rowsBefore}, counter ${(await state()).monthlyEvents}`)

  // ---- with the allowance spent: what is still never refused
  await set({ monthly_events: LIMIT, monthly_calls: 0 })
  const p1 = await pre({ task_ref: 'bc-job', task_ceiling: 100_000 })
  const settle1 = await rec({ task_ref: 'bc-job', reservation_id: p1.body?.reservation_id, units: 4 })
  const [res1] = await sql`SELECT released_at IS NOT NULL AS closed FROM reservations WHERE public_id = ${p1.body?.reservation_id ?? '00000000-0000-0000-0000-000000000000'}`
  const [job1] = await sql`SELECT used_units FROM task_budgets WHERE account_id = ${E} AND task_ref = 'bc-job'`
  ok('[S7 events] allowance spent: the record that settles its own preflight\'s reservation is stored, closes it, lands on the job, and takes nothing from the allowance',
     p1.body?.approved === true && settle1.status === 200 && settle1.body?.reservation_status === 'settled' && res1?.closed === true
       && job1?.usedUnits === 4 && (await state()).monthlyEvents === LIMIT,
     `${JSON.stringify(p1.body)} -> ${settle1.status} ${JSON.stringify(settle1.body)} counter ${(await state()).monthlyEvents}`)
  const again1 = await rec({ task_ref: 'bc-job', reservation_id: p1.body?.reservation_id, units: 4 })
  ok('[S7 events] and a second record naming the same (now closed) reservation is not covered: 402',
     again1.status === 402 && again1.body?.quota === 'events', `${again1.status} ${JSON.stringify(again1.body)}`)

  // 40 preflight + settle pairs in parallel, allowance spent: every settle
  // stored, no 5xx from the account/customer lock order (a deadlock is a 500).
  await set({ monthly_events: LIMIT, monthly_calls: 0 })
  const pairs = await Promise.all(Array.from({ length: 40 }, async () => {
    const p = await pre({ task_ref: 'bc-job2', task_ceiling: 1_000_000 })
    const r = await rec({ task_ref: 'bc-job2', reservation_id: p.body?.reservation_id, units: 2 })
    return [p.status, p.body?.approved, r.status, r.body?.reservation_status]
  }))
  const openJob2 = Number((await sql`SELECT coalesce(sum(units), 0) AS s FROM reservations WHERE account_id = ${E} AND task_ref = 'bc-job2' AND released_at IS NULL`)[0].s)
  ok('[S7 events] 40 preflight+settle pairs in parallel with the allowance spent: 40 approved, 40 settles stored, no 5xx, nothing left reserved, the counter untouched',
     pairs.every(([ps, pa, rs, rst]) => ps === 200 && pa === true && rs === 200 && rst === 'settled') && openJob2 === 0 && (await state()).monthlyEvents === LIMIT,
     JSON.stringify([...new Set(pairs.map((p) => p.join('/')))]))
  // A mixed burst on one account and one customer: preflights holding the
  // account row while records want it. Any deadlock Postgres breaks is a 500.
  await set({ monthly_events: 0, monthly_calls: 0 })
  const burst = await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? pre() : rec())))
  ok('[S7 events] 20 preflights and 20 unsettled records interleaved on one account and customer: every one answers 200, none 5xx',
     burst.every((r) => r.status === 200), JSON.stringify([...new Set(burst.map((r) => r.status))]))

  // Duplicates and releases.
  await set({ monthly_events: 100 })
  const dupKey = uniq()
  const d1 = await rec({ idempotency_key: dupKey })
  const d2 = await rec({ idempotency_key: dupKey })
  ok('[S7 events] a record and its duplicate take one from the allowance, not two',
     d1.status === 200 && d2.status === 200 && d2.body?.status === 'duplicate_ignored' && (await state()).monthlyEvents === 101, `${d1.status} ${d2.body?.status} ${(await state()).monthlyEvents}`)
  await set({ monthly_events: LIMIT })
  const d3 = await rec({ idempotency_key: dupKey })
  ok('[S7 events] allowance spent: a retry of a stored record is still answered duplicate_ignored, not refused',
     d3.status === 200 && d3.body?.status === 'duplicate_ignored', `${d3.status} ${JSON.stringify(d3.body)}`)
  const p2 = await pre({ task_ref: 'bc-job', task_ceiling: 100_000 })
  const rel = await rec({ task_ref: 'bc-job', reservation_id: p2.body?.reservation_id, success: false, units: 0 })
  ok('[S7 events] allowance spent: a release (success false) is never refused and frees its reservation',
     rel.status === 200 && rel.body?.status === 'released' && rel.body?.reservation_status === 'settled' && (await state()).monthlyEvents === LIMIT,
     `${rel.status} ${JSON.stringify(rel.body)}`)

  // ---- one billing month for both counters
  await set({ monthly_events: LIMIT, monthly_calls: 1_000 })
  await sql`UPDATE accounts SET billing_period_start = (date_trunc('month', CURRENT_DATE) - INTERVAL '1 month')::date WHERE id = ${E}`
  const roll = await rec()
  const afterRoll = await state()
  ok('[S7 events] a record in a new month rolls the period: stored, monthly_events 1, and monthly_calls zeroed with it',
     roll.status === 200 && afterRoll.monthlyEvents === 1 && afterRoll.monthlyCalls === 0, `${roll.status} ${JSON.stringify(afterRoll)}`)
  await set({ monthly_events: LIMIT, monthly_calls: 1_000 })
  await sql`UPDATE accounts SET billing_period_start = (date_trunc('month', CURRENT_DATE) - INTERVAL '1 month')::date WHERE id = ${E}`
  const roll2 = await pre()
  const afterRoll2 = await state()
  ok('[S7 events] and a preflight in a new month zeroes monthly_events as it rolls monthly_calls to 1',
     roll2.body?.approved === true && afterRoll2.monthlyCalls === 1 && afterRoll2.monthlyEvents === 0, `${JSON.stringify(roll2.body)} ${JSON.stringify(afterRoll2)}`)

  // ---- plans
  await set({ plan: 'builder', monthly_events: 149_999 })
  const b1 = await rec(), b2 = await rec()
  ok('[S7 events] Builder: the 150,000th record is stored and the next is refused plan_limit_exceeded',
     b1.status === 200 && b2.status === 402 && b2.body?.reason === 'plan_limit_exceeded' && b2.body?.events_limit === 150_000, `${b1.status} ${b2.status} ${JSON.stringify(b2.body)}`)
  await set({ plan: 'paid', monthly_events: 50_000_000 })
  ok('[S7 events] the legacy paid plan is uncapped, as its preflight calls are', (await rec()).status === 200 && (await step()).status === 200)
  await set({ plan: 'free' })

  // ---- MCP's record_event tool, the same function behind another door
  await set({ monthly_events: LIMIT })
  const mcp = await fetch(`${API}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18', Authorization: `Bearer ${KE}`, ...NET },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'record_event', arguments: { agent_id: 'bc-agent', customer_id: 'bc-cust', units: 1 } } }),
  }).then(async (r) => { const t = await r.text(); try { return JSON.parse(t) } catch { return { raw: t.slice(0, 200) } } })
  const out = mcp?.result?.structuredContent ?? null
  ok('[S7 events] MCP record_event with the allowance spent: recorded false, reason free_tier_exceeded, the upgrade_url, not an error and not "budget_exhausted"',
     out?.recorded === false && out?.reason === 'free_tier_exceeded' && out?.quota === 'events' && typeof out?.upgrade_url === 'string' && mcp?.result?.isError !== true,
     JSON.stringify(mcp).slice(0, 300))

  // ---- the console says it
  const login = await fetch(`${API}/app/session`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin', ...NET }, body: `api_key=${KE}` })
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
  await set({ monthly_events: 1234 })
  const appHtml = await fetch(`${API}/app`, { headers: { cookie } }).then((r) => r.text())
  ok('[S7 events] the console\'s account card shows this month\'s records and steps against the allowance',
     appHtml.includes('<b>1,234</b> / 3,000 records and steps'), (appHtml.match(/acct-q">[^<]*<b>[^<]*<\/b>[^<]*/g) ?? []).join(' | '))
  const pricing = await fetch(`${API}/pricing`).then((r) => r.text())
  ok('[S7 events] /pricing states the allowance from the same constants (3 per call, 3,000 on Free)',
     pricing.includes('3 a month for every preflight call a plan includes (3,000 on Free)'))

  // ---- wrap(), both SDKs, the production path: a record refused on the
  // allowance never breaks the run. It can only be refused when there is no
  // reservation to settle: on_quota "send" with the preflight quota spent.
  await set({ monthly_events: LIMIT, monthly_calls: 1_000 })
  const py = process.env.WRAP_PYTHON
  const dir = mkdtempSync(`${tmpdir()}/bc-wrap-`)
  writeFileSync(`${dir}/w.py`, `
import json, os, warnings
from types import SimpleNamespace as NS
import agentbill
class C:
    sent = 0
    def create(self, **kw):
        C.sent += 1
        return NS(id="chatcmpl-bc-%d" % C.sent, model="gpt-4o-mini", choices=[NS(message=NS(content="hi"))], usage=NS(prompt_tokens=10, completion_tokens=2))
llm = agentbill.wrap(NS(chat=NS(completions=C()), base_url="https://api.openai.com/v1/"), task_ref="bc-wrap-py", agent_id="bc-py",
                     task_ceiling=10_000, on_quota="send", provider="openai")
out = {}
with warnings.catch_warnings(record=True) as w:
    warnings.simplefilter("always")
    try:
        r = llm.chat.completions.create(model="gpt-4o-mini", messages=[])
        out = {"returned": type(r).__name__, "content": r.choices[0].message.content, "sent": C.sent, "raised": None}
    except Exception as e:
        out = {"raised": "%s: %s" % (type(e).__name__, e), "sent": C.sent}
    out["warnings"] = [str(x.message) for x in w]
print(json.dumps(out))
`)
  const pyRun = py ? spawnSync(py, [`${dir}/w.py`], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, PYTHONPATH: new URL('../../sdk/python', import.meta.url).pathname, AGENTBILL_BASE_URL: API, AGENTBILL_API_KEY: KE } }) : null
  let pyOut = null
  try { pyOut = JSON.parse((pyRun?.stdout ?? '').trim().split('\n').pop()) } catch {}
  ok('[S7 events] python wrap(on_quota="send"), both quotas spent: the provider\'s answer is returned, nothing raised, and a RuntimeWarning says the record could not be stored (402)',
     pyOut?.raised === null && pyOut?.content === 'hi' && pyOut?.sent === 1 && (pyOut?.warnings ?? []).some((m) => /could not record this call/.test(m) && /402/.test(m)),
     py ? `${pyRun?.status} ${(pyRun?.stdout ?? '').slice(-400)} ${(pyRun?.stderr ?? '').slice(-400)}` : 'WRAP_PYTHON is not set')
  const nodeSdk = await import(new URL('../../sdk/node/dist/index.js', import.meta.url).href).catch(() => null)
  const envBefore = { base: process.env.AGENTBILL_BASE_URL, key: process.env.AGENTBILL_API_KEY }
  const warned = []
  const onWarn = (w) => { if (w?.name === 'AgentBillWarning') warned.push(String(w.message)) }
  process.on('warning', onWarn)
  let nodeOut = null
  try {
    process.env.AGENTBILL_BASE_URL = API
    process.env.AGENTBILL_API_KEY = KE
    let sent = 0
    const fake = { baseURL: 'https://api.openai.com/v1', chat: { completions: { async create() {
      sent++
      return { id: `chatcmpl-bc-node-${sent}`, model: 'gpt-4o-mini', choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }
    } } } }
    const llm = nodeSdk.wrap(fake, { taskRef: 'bc-wrap-node', agentId: 'bc-node', taskCeiling: 10_000, onQuota: 'send' })
    const r = await llm.chat.completions.create({ model: 'gpt-4o-mini', messages: [] })
    await new Promise((res) => setTimeout(res, 100))
    nodeOut = { content: r?.choices?.[0]?.message?.content, sent, raised: null }
  } catch (e) {
    nodeOut = { raised: `${e?.name}: ${e?.message}` }
  } finally {
    process.off('warning', onWarn)
    if (envBefore.base === undefined) delete process.env.AGENTBILL_BASE_URL; else process.env.AGENTBILL_BASE_URL = envBefore.base
    if (envBefore.key === undefined) delete process.env.AGENTBILL_API_KEY; else process.env.AGENTBILL_API_KEY = envBefore.key
  }
  ok('[S7 events] node wrap({ onQuota: "send" }), both quotas spent: the answer is returned, nothing thrown, and an AgentBillWarning names the 402 and free_tier_exceeded',
     nodeOut?.raised === null && nodeOut?.content === 'hi' && nodeOut?.sent === 1 && warned.some((m) => /could not record this call/.test(m) && /402/.test(m) && /free_tier_exceeded/.test(m)),
     `${JSON.stringify(nodeOut)} ${JSON.stringify(warned)}`)

  await sql`DELETE FROM accounts WHERE id = ${E}`
}

// ------------------------------------------------------------------ S24
async function paymentsGates({ API, sql, ok, bootS, stopS, portS }) {
  const { Webhook } = await import('standardwebhooks')
  const wh = new Webhook(Buffer.from(process.env.WEBHOOK_SECRET ?? '', 'utf-8').toString('base64'))
  let seq = 0
  // Signed exactly as Polar signs (Standard Webhooks), through the library
  // Polar's SDK uses: the production verification path, no bypass.
  const hook = async (payload) => {
    const body = JSON.stringify(payload)
    const id = `msg_bc_${Date.now()}_${seq++}`
    const date = new Date()
    const r = await fetch(`${API}/webhooks/polar`, { method: 'POST', body, headers: {
      'Content-Type': 'application/json', 'webhook-id': id, 'webhook-timestamp': String(Math.floor(date.getTime() / 1000)),
      'webhook-signature': wh.sign(id, date, body) } })
    return { status: r.status, body: await r.text() }
  }
  const P = '00000000-0000-0000-0000-0000000024a1'
  const KP = shaped('batchc-pay')
  const NET = { 'fly-client-ip': '198.18.24.1' }
  await sql`DELETE FROM accounts WHERE id = ${P}`
  await sql`INSERT INTO accounts (id, plan, monthly_calls, billing_period_start) VALUES (${P}, 'free', 0, date_trunc('month', CURRENT_DATE)::date)`
  await insertKeyRow(sql, P, KP, 'harness-batchc-pay')
  const md = { agentbill_account_id: P }
  const BUILDER = process.env.POLAR_PRODUCT_ID_BUILDER ?? 'prod_verify_builder'
  const acct = async () => (await sql`
    SELECT plan, plan_ends_at, polar_subscription_id, (plan_ends_at > NOW()) AS ends_later FROM accounts WHERE id = ${P}`)[0]
  const pre = async () => {
    const r = await fetch(`${API}/preflight`, { method: 'POST', headers: { Authorization: `Bearer ${KP}`, 'Content-Type': 'application/json', ...NET },
      body: JSON.stringify({ agent_id: 'bc-pay', estimated_units: 1 }) })
    return r.json()
  }
  const inDays = (d) => new Date(Date.now() + d * 86_400_000).toISOString()
  const sub = (id, extra = {}) => ({ id, status: 'active', product_id: BUILDER, customer_id: 'cus_bc', metadata: md, ...extra })

  // ---- a purchase remembers its subscription
  const up = await hook({ type: 'subscription.active', data: sub('sub_bc_1') })
  let a = await acct()
  ok('[S24 payments] a purchase (subscription.active) upgrades and remembers the subscription behind the plan',
     up.status === 200 && a.plan === 'builder' && a.polarSubscriptionId === 'sub_bc_1' && a.planEndsAt === null, `${up.status} ${JSON.stringify(a)}`)

  // ---- canceled: the plan runs to the period end Polar sends
  const end10 = inDays(10)
  const c1 = await hook({ type: 'subscription.canceled', data: sub('sub_bc_1', { cancel_at_period_end: true, canceled_at: new Date().toISOString(), ends_at: end10, current_period_end: end10 }) })
  a = await acct()
  await sql`UPDATE accounts SET monthly_calls = 1500 WHERE id = ${P}`
  const p1 = await pre()
  ok('[S24 payments] subscription.canceled keeps the plan: still builder, plan_ends_at is Polar\'s ends_at, and a call past the free quota (1,501st) is approved',
     c1.status === 200 && a.plan === 'builder' && a.planEndsAt !== null && Math.abs(new Date(a.planEndsAt).getTime() - Date.parse(end10)) < 1000 && p1.approved === true,
     `${c1.status} ${JSON.stringify(a)} ${JSON.stringify(p1)}`)
  const login = await fetch(`${API}/app/session`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin', ...NET }, body: `api_key=${KP}` })
  const cookieP = (login.headers.get('set-cookie') ?? '').split(';')[0]
  const shown = new Date(end10).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  const appP = await fetch(`${API}/app`, { headers: { cookie: cookieP } }).then((r) => r.text())
  ok('[S24 payments] and the console says so: "Canceled · builder until <date>"', appP.includes(`Canceled · builder until <b>${shown}</b>`), shown)

  // ---- uncanceled clears it; a cancel with only current_period_end uses it
  const u1 = await hook({ type: 'subscription.uncanceled', data: sub('sub_bc_1') })
  a = await acct()
  ok('[S24 payments] subscription.uncanceled clears the scheduled end', u1.status === 200 && a.plan === 'builder' && a.planEndsAt === null, JSON.stringify(a))
  const end5 = inDays(5)
  await hook({ type: 'subscription.canceled', data: sub('sub_bc_1', { cancel_at_period_end: true, current_period_end: end5 }) })
  a = await acct()
  ok('[S24 payments] a cancel that names only current_period_end runs to that', a.plan === 'builder' && a.planEndsAt !== null && Math.abs(new Date(a.planEndsAt).getTime() - Date.parse(end5)) < 1000, JSON.stringify(a))
  await hook({ type: 'subscription.uncanceled', data: sub('sub_bc_1') })
  const nop = await hook({ type: 'subscription.canceled', data: sub('sub_bc_1', { cancel_at_period_end: true }) })
  a = await acct()
  ok('[S24 payments] a cancel with no period end at all changes nothing (revoked ends it when Polar ends access), and is not a downgrade',
     nop.status === 200 && a.plan === 'builder' && a.planEndsAt === null, JSON.stringify(a))

  // ---- another subscription's events leave this plan alone
  const oc = await hook({ type: 'subscription.canceled', data: sub('sub_bc_OLD', { ends_at: inDays(1) }) })
  const orv = await hook({ type: 'subscription.revoked', data: sub('sub_bc_OLD', { status: 'canceled' }) })
  a = await acct()
  ok('[S24 payments] a cancel and a revoke of a DIFFERENT subscription (an old one) leave the plan and its end untouched',
     oc.status === 200 && orv.status === 200 && a.plan === 'builder' && a.planEndsAt === null && a.polarSubscriptionId === 'sub_bc_1', JSON.stringify(a))

  // ---- the end passes: free at read time, then the sweeper writes it
  await hook({ type: 'subscription.canceled', data: sub('sub_bc_1', { ends_at: inDays(3) }) })
  await sql`UPDATE accounts SET plan_ends_at = NOW() - INTERVAL '1 second', monthly_calls = 1500 WHERE id = ${P}`
  const p2 = await pre()
  const stored = (await acct()).plan
  ok('[S24 payments] once plan_ends_at has passed, preflight reads the plan as free (free_tier_exceeded at 1,500) before any sweep, by the database clock',
     p2.approved === false && p2.reason === 'free_tier_exceeded' && p2.plan === 'free' && stored === 'builder', `${JSON.stringify(p2)} stored=${stored}`)
  const { sweepEndedPlans } = await import('../../dist/lib/plan-period.js')
  const swept = await sweepEndedPlans()
  a = await acct()
  const [cnt] = await sql`SELECT monthly_calls, polar_customer_id FROM accounts WHERE id = ${P}`
  ok('[S24 payments] and the sweeper writes the downgrade: free, the end and the subscription cleared, the counters into a new period',
     swept >= 1 && a.plan === 'free' && a.planEndsAt === null && a.polarSubscriptionId === null && cnt.monthlyCalls === 0 && cnt.polarCustomerId === null,
     `swept ${swept} ${JSON.stringify(a)} ${JSON.stringify(cnt)}`)

  // ---- revoked still ends it at once; a late cancel with a past end too
  await hook({ type: 'order.paid', data: { status: 'paid', product_id: BUILDER, customer_id: 'cus_bc', subscription_id: 'sub_bc_2', metadata: md } })
  a = await acct()
  ok('[S24 payments] order.paid upgrades and remembers the subscription it names', a.plan === 'builder' && a.polarSubscriptionId === 'sub_bc_2', JSON.stringify(a))
  const rv = await hook({ type: 'subscription.revoked', data: sub('sub_bc_2', { status: 'canceled', ended_at: new Date().toISOString() }) })
  a = await acct()
  ok('[S24 payments] subscription.revoked downgrades at once, as before', rv.status === 200 && a.plan === 'free' && a.polarSubscriptionId === null, JSON.stringify(a))
  await hook({ type: 'subscription.active', data: sub('sub_bc_3') })
  await sql`UPDATE accounts SET monthly_calls = 1500 WHERE id = ${P}`
  await hook({ type: 'subscription.canceled', data: sub('sub_bc_3', { ends_at: new Date(Date.now() - 60_000).toISOString() }) })
  const p3 = await pre()
  ok('[S24 payments] a cancel delivered after its own period end reads as free at once', p3.approved === false && p3.plan === 'free', JSON.stringify(p3))

  // ---- (b) the checkout is bound to the session. Production first, no bypass.
  const LONG = 'batchc-production-session-secret-0123456789'
  const prod = await bootS({ NODE_ENV: 'production', DATABASE_SSL: 'disable', DATABASE_SSL_INSECURE_OK: '1', APP_SESSION_SECRET: LONG,
    POLAR_API_TEST_BASE: 'http://127.0.0.1:9', POLAR_PRODUCT_ID_TEAM: 'prod_verify_team' }, portS)
  const PB = `http://localhost:${portS}`
  try {
    const pr = await fetch(`${PB}/pricing?account_id=${P}`).then(async (r) => ({ status: r.status, html: await r.text() }))
    const hrefs = [...pr.html.matchAll(/<a\b[^>]*data-tier="(builder|team|scale)"[^>]*>/g)].map((m) => m[0])
    ok('[S24 payments] production: /pricing?account_id=<id> renders no link carrying the id, every paid button goes to /app/upgrade/<tier>, and there is no key box',
       pr.status === 200 && !pr.html.includes(P) && !pr.html.includes('account_id=') && hrefs.length === 3
         && hrefs.every((h) => /href="\/app\/upgrade\/(builder|team|scale)"/.test(h)) && !pr.html.includes('id="keyin"'),
       `${pr.status} ${hrefs.join(' ')}`)
    const up301 = await fetch(`${PB}/upgrade?account_id=${P}`, { redirect: 'manual' })
    const old = await fetch(`${PB}/checkout/team?account_id=${P}`, { redirect: 'manual' })
    const anon = await fetch(`${PB}/app/checkout/team?account_id=${P}`, { redirect: 'manual' })
    const signin = await fetch(`${PB}/app/upgrade/team`).then((r) => r.text())
    ok('[S24 payments] production: the old /checkout/team?account_id=<id> mints nothing and sends the browser to sign in; /app/checkout/team with no session does the same; that page is the sign-in for Team',
       old.status === 302 && old.headers.get('location') === '/app/upgrade/team' && anon.status === 302 && anon.headers.get('location') === '/app/upgrade/team'
         && signin.includes('Sign in to buy Team') && up301.status === 301,
       `${old.status} ${old.headers.get('location')} ${anon.status} ${anon.headers.get('location')}`)
  } finally { await stopS(prod) }
  const { polarApiBase } = await import('../../dist/integrations/polar.js')
  ok('[S24 payments] production ignores POLAR_API_TEST_BASE: Polar is api.polar.sh whatever the environment says',
     polarApiBase({ NODE_ENV: 'production', POLAR_API_TEST_BASE: 'http://127.0.0.1:9' }) === 'https://api.polar.sh'
       && polarApiBase({ NODE_ENV: 'test', POLAR_API_TEST_BASE: 'http://127.0.0.1:9' }) === 'http://127.0.0.1:9'
       && polarApiBase({ NODE_ENV: 'test', POLAR_API_TEST_BASE: 'https://evil.example' }) === 'https://api.polar.sh')

  // What the checkout is minted with, read from a local fake of Polar's API.
  const minted = []
  const fake = createServer((req, res) => {
    let b = ''
    req.on('data', (d) => { b += d })
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/v1/checkouts') {
        try { minted.push(JSON.parse(b)) } catch { minted.push({ bad: b }) }
        res.writeHead(201, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ id: 'co_fake', url: 'https://sandbox.polar.sh/checkout/co_fake' }))
      }
      res.writeHead(404); res.end()
    })
  })
  await new Promise((r) => fake.listen(0, '127.0.0.1', r))
  const FAKE = `http://127.0.0.1:${fake.address().port}`
  const TSECRET = 'batchc-test-session-secret-0123456789abcdef'
  const test = await bootS({ NODE_ENV: 'test', DATABASE_SSL: 'disable', APP_SESSION_SECRET: TSECRET, RATE_LIMIT_PER_MINUTE: '100000',
    POLAR_API_TEST_BASE: FAKE, POLAR_API_KEY: 'polar_fake_key', POLAR_PRODUCT_ID_TEAM: 'prod_verify_team', POLAR_PRODUCT_ID_SCALE: 'prod_verify_scale' }, portS)
  const TB = `http://localhost:${portS}`
  try {
    const OTHER = '00000000-0000-0000-0000-0000000024b2'
    await sql`DELETE FROM accounts WHERE id = ${OTHER}`
    await sql`INSERT INTO accounts (id, plan) VALUES (${OTHER}, 'free')`
    const l = await fetch(`${TB}/app/session`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin', ...NET }, body: `api_key=${KP}` })
    const ck = (l.headers.get('set-cookie') ?? '').split(';')[0]
    const r1 = await fetch(`${TB}/app/checkout/team?account_id=${OTHER}`, { redirect: 'manual', headers: { cookie: ck } })
    ok('[S24 payments] a key session asking /app/checkout/team?account_id=<another account>: the checkout is minted for the session\'s own account, never the one in the URL',
       r1.status === 302 && r1.headers.get('location') === 'https://sandbox.polar.sh/checkout/co_fake' && minted.length === 1
         && minted[0]?.metadata?.agentbill_account_id === P && JSON.stringify(minted[0]?.products) === '["prod_verify_team"]',
       `${r1.status} ${r1.headers.get('location')} ${JSON.stringify(minted)}`)
    // A person's session, for an account a sign-in owns.
    const U = '00000000-0000-0000-0000-0000000024c3', UA = '00000000-0000-0000-0000-0000000024c4'
    await sql`DELETE FROM accounts WHERE id = ${UA}`
    await sql`DELETE FROM users WHERE id = ${U}`
    await sql`INSERT INTO users (id, email, email_verified_at) VALUES (${U}, 'bc-checkout-person@example.invalid', now())`
    await sql`INSERT INTO accounts (id, plan, owner_user_id) VALUES (${UA}, 'free', ${U})`
    const secretBefore = process.env.APP_SESSION_SECRET
    process.env.APP_SESSION_SECRET = TSECRET
    const { userSessionCookie } = await import('../../dist/lib/user-session.js')
    const uck = (userSessionCookie(U, 0) ?? '').split(';')[0]
    if (secretBefore === undefined) delete process.env.APP_SESSION_SECRET; else process.env.APP_SESSION_SECRET = secretBefore
    const r2 = await fetch(`${TB}/app/checkout/scale?account_id=${P}`, { redirect: 'manual', headers: { cookie: uck } })
    ok('[S24 payments] a person\'s session: /app/checkout/scale?account_id=<another account> mints for the account that person owns',
       r2.status === 302 && minted.length === 2 && minted[1]?.metadata?.agentbill_account_id === UA, `${r2.status} ${JSON.stringify(minted[1])}`)
    const r3 = await fetch(`${TB}/app/checkout/team?account_id=${P}`, { redirect: 'manual' })
    const r4 = await fetch(`${TB}/checkout/team?account_id=${P}`, { redirect: 'manual' })
    const r5 = await fetch(`${TB}/app/upgrade/team`, { headers: { cookie: ck } }).then((r) => r.text())
    ok('[S24 payments] with no session, neither /app/checkout nor the old /checkout mints anything for the id in the URL, and a signed-in hand-off page carries no account id',
       r3.headers.get('location') === '/app/upgrade/team' && r4.headers.get('location') === '/app/upgrade/team' && minted.length === 2
         && r5.includes('url=/app/checkout/team"') && !r5.includes('account_id'),
       `${r3.headers.get('location')} ${r4.headers.get('location')} minted ${minted.length}`)
    await sql`DELETE FROM accounts WHERE id IN (${OTHER}, ${UA})`
    await sql`DELETE FROM users WHERE id = ${U}`
  } finally {
    await stopS(test)
    fake.close()
  }
  const pf = await pre()
  ok('[S24 payments] a quota refusal\'s upgrade_url is /pricing, with no account id in it', pf.upgrade_url === 'https://agentbill.dev/pricing', JSON.stringify(pf))
  await sql`DELETE FROM accounts WHERE id = ${P}`
}

// ------------------------------------------------------------------ S17
async function logoutGates({ API, sql, ok, bootS, stopS, portS }) {
  const K = '00000000-0000-0000-0000-0000000017a1'
  const KK = shaped('batchc-logout')
  const NET = { 'fly-client-ip': '198.18.17.1' }
  await sql`DELETE FROM accounts WHERE id = ${K}`
  await sql`INSERT INTO accounts (id, plan) VALUES (${K}, 'free')`
  await insertKeyRow(sql, K, KK, 'harness-batchc-logout')
  const [{ id: keyId }] = await sql`SELECT id FROM developer_api_keys WHERE account_id = ${K}`
  const FORM = { 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin', ...NET }
  const login = async (base = API) => {
    const r = await fetch(`${base}/app/session`, { method: 'POST', redirect: 'manual', headers: FORM, body: `api_key=${KK}` })
    return (r.headers.getSetCookie().find((c) => c.startsWith('agentbill_app=')) ?? '').split(';')[0]
  }
  const signedIn = async (cookie, base = API) => (await fetch(`${base}/app`, { headers: { cookie } }).then((r) => r.text())).includes('Signed in with a key')
  const logout = (cookie, base = API) => fetch(`${base}/app/logout`, { method: 'POST', redirect: 'manual', headers: { ...FORM, cookie } })
  const epoch = async () => (await sql`SELECT session_epoch FROM developer_api_keys WHERE id = ${keyId}`)[0].sessionEpoch

  const c1 = await login()
  const copy = c1   // the same cookie, taken to another device before the logout
  const other = await login()   // a second browser, same key
  ok('[S17 logout] a key login mints a v2 cookie carrying the key\'s epoch (0), and it opens the console',
     /^agentbill_app=v2\.[0-9a-f-]{36}\.0\.\d+\.[0-9a-f]{64}$/.test(c1) && await signedIn(c1) && await signedIn(other), c1.slice(0, 60))
  const out = await logout(c1)
  ok('[S17 logout] logout: 303, both cookies cleared in this browser, and the key\'s session_epoch moves to 1',
     out.status === 303 && out.headers.getSetCookie().some((c) => /^agentbill_app=;.*Max-Age=0/.test(c)) && await epoch() === 1, `${out.status} epoch ${await epoch()}`)
  ok('[S17 logout] a COPY of the cookie taken before the logout opens nothing, and neither does the other browser signed in with the same key',
     !(await signedIn(copy)) && !(await signedIn(other)))
  const c2 = await login()
  ok('[S17 logout] signing in again works (a cookie at epoch 1), and the old copy stays dead', c2.includes('.1.') && await signedIn(c2) && !(await signedIn(copy)))
  await logout(copy)
  ok('[S17 logout] a logout sent with the dead copy changes nothing: the epoch stays 1 and the new session stays open', await epoch() === 1 && await signedIn(c2), `epoch ${await epoch()}`)

  // A cookie in the old shape (<keyId>.<exp>.<mac>), minted before this
  // commit with the harness server's secret: epoch 0, until the next logout.
  const secret = (readFileSync(new URL('./run.sh', import.meta.url), 'utf8').match(/APP_SESSION_SECRET="([^"]+)"/) ?? [])[1]
  const exp = Math.floor(Date.now() / 1000) + 3600
  const legacy = (id) => `agentbill_app=${id}.${exp}.${createHmac('sha256', secret).update(`${id}.${exp}`).digest('hex')}`
  await sql`UPDATE developer_api_keys SET session_epoch = 0 WHERE id = ${keyId}`
  const old = legacy(keyId)
  const oldBefore = await signedIn(old)
  await logout(await login())
  ok('[S17 logout] a cookie in the pre-030 shape is read as epoch 0: it opened the console, and after the key\'s next logout it is dead',
     Boolean(secret) && oldBefore === true && !(await signedIn(old)), `secret ${Boolean(secret)} before ${oldBefore}`)
  // The attack a MAC without the epoch would allow: keep a copy, let its
  // owner log out, then edit the copy's epoch forward to the row's new value.
  const kept = await login()
  const keptEpoch = Number((kept.match(/^agentbill_app=v2\.[0-9a-f-]{36}\.(\d+)\./) ?? [])[1])
  await logout(kept)
  const forged = kept.replace(/^(agentbill_app=v2\.[0-9a-f-]{36}\.)\d+/, `$1${keptEpoch + 1}`)
  const fresh = await login()
  ok('[S17 logout] a dead copy with its epoch edited forward to the key\'s new epoch is refused (the MAC covers the epoch), while a real new session opens',
     Number.isInteger(keptEpoch) && await epoch() === keptEpoch + 1 && forged !== kept && !(await signedIn(forged)) && await signedIn(fresh), `kept at ${keptEpoch}, row ${await epoch()}`)

  // The production path: NODE_ENV=production, no harness setting in play.
  const LONG = 'batchc-production-session-secret-0123456789'
  const prod = await bootS({ NODE_ENV: 'production', DATABASE_SSL: 'disable', DATABASE_SSL_INSECURE_OK: '1', APP_SESSION_SECRET: LONG }, portS)
  const PB = `http://localhost:${portS}`
  try {
    const p1 = await login(PB)
    const pcopy = p1
    const before = await signedIn(p1, PB)
    const pout = await logout(p1, PB)
    ok('[S17 logout] production: sign in with the key, log out, and the copied cookie opens nothing',
       before && pout.status === 303 && !(await signedIn(pcopy, PB)), `${before} ${pout.status}`)
  } finally { await stopS(prod) }
  await sql`DELETE FROM accounts WHERE id = ${K}`
}

// ------------------------------------------------------------------ migration runner TLS
async function migrationTlsGates({ ok, sql }) {
  const { tlsFor, applyMigration } = await import('../db/apply-migration.mjs')
  const { SUPABASE_ROOT_2021_CA } = await import('../../dist/db/tls.js')
  const tls = await import('node:tls')
  const net = await import('node:net')
  const PROD = 'postgres://postgres.x:pw@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres'
  const v = await tlsFor(PROD, {})
  ok('[migration tls] by default the runner verifies: rejectUnauthorized true, the server\'s embedded Supabase root among the CAs',
     v && v.rejectUnauthorized === true && Array.isArray(v.ca) && v.ca.includes(SUPABASE_ROOT_2021_CA), JSON.stringify(v && { r: v.rejectUnauthorized, n: v.ca?.length }))
  const refuse = async (url, env) => tlsFor(url, env, () => {}).then(() => 'accepted', (e) => e.message)
  const req = await refuse(PROD, { DATABASE_SSL: 'require' })
  const remote = await refuse(PROD, { DATABASE_SSL: 'disable' })
  const warned = []
  const local = await tlsFor('postgres://u@localhost:5432/x', { DATABASE_SSL: 'disable' }, (m) => warned.push(m))
  const local6 = await tlsFor('postgres://u@[::1]:5432/x', { DATABASE_SSL: 'disable' }, (m) => warned.push(m))
  ok('[migration tls] DATABASE_SSL=require is refused, disable is refused for a remote host, and disable for localhost / ::1 is allowed with a WARNING every time',
     /not accepted here/.test(req) && /this machine only/.test(remote) && local === false && local6 === false && warned.length === 2 && warned.every((m) => /WARNING.*WITHOUT TLS/.test(m)),
     JSON.stringify({ req, remote, local, local6, warned }))

  // A local stand-in for a TLS Postgres: answers the SSLRequest with 'S' and
  // then does the TLS handshake with a certificate of our making. What tells
  // "verified and accepted" from "refused" is whether the runner then SENDS
  // anything over it (its startup message, user name first): the server side
  // sees the handshake complete in both cases under TLS 1.3, because the
  // client checks the certificate after the server has finished.
  const dir = mkdtempSync(`${tmpdir()}/bc-migtls-`)
  const mk = (name, san) => {
    spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/${name}.key`, '-out', `${dir}/${name}.pem`, '-days', '1',
      '-subj', `/CN=${name}`, '-addext', `subjectAltName=${san}`], { stdio: 'ignore' })
    return { key: readFileSync(`${dir}/${name}.key`), cert: readFileSync(`${dir}/${name}.pem`), file: `${dir}/${name}.pem` }
  }
  const good = mk('localhost', 'DNS:localhost,IP:127.0.0.1')
  const wrong = mk('db.other.example', 'DNS:db.other.example')
  const listen = (cert) => new Promise((resolve) => {
    const seen = { startup: 0 }
    const srv = net.createServer((sock) => {
      sock.once('data', () => {
        sock.write('S')
        const t = new tls.TLSSocket(sock, { isServer: true, key: cert.key, cert: cert.cert })
        // Answer the startup with a Postgres ErrorResponse (FATAL 28000), so
        // the client ends cleanly instead of waiting on a dropped socket.
        t.on('data', () => {
          if (seen.startup++ > 0) return
          const f = Buffer.from('SFATAL\0C28000\0Mbatchc fake server\0\0', 'utf8')
          const head = Buffer.alloc(5); head.write('E', 0); head.writeInt32BE(f.length + 4, 1)
          t.end(Buffer.concat([head, f]))
        })
        t.on('error', () => t.destroy())
      })
    }).listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, seen }))
  })
  writeFileSync(`${dir}/probe.sql`, 'SELECT 1;')
  const attempt = async (port, env) => {
    const before = { ...process.env }
    Object.assign(process.env, { DATABASE_SSL: '', DATABASE_SSL_CA_FILE: '' }, env)
    if (!env.DATABASE_SSL_CA_FILE) delete process.env.DATABASE_SSL_CA_FILE
    try {
      await applyMigration(`postgres://u:p@localhost:${port}/x`, `${dir}/probe.sql`, { attempts: 1, log: () => {} })
      return 'applied'
    } catch (e) { return e?.code ?? e?.message } finally {
      for (const k of ['DATABASE_SSL', 'DATABASE_SSL_CA_FILE']) { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k] }
    }
  }
  const g1 = await listen(good), g2 = await listen(good), w = await listen(wrong)
  const selfSigned = await attempt(g1.port, {})
  const trusted = await attempt(g2.port, { DATABASE_SSL_CA_FILE: good.file })
  const misnamed = await attempt(w.port, { DATABASE_SSL_CA_FILE: wrong.file })
  g1.srv.close(); g2.srv.close(); w.srv.close()
  ok('[migration tls] against a TLS server whose root it was not given, the runner refuses the certificate (self-signed) and sends nothing over the connection',
     /SELF_SIGNED|UNABLE_TO_VERIFY|unable to verify/i.test(String(selfSigned)) && g1.seen.startup === 0, `${selfSigned} startup=${g1.seen.startup}`)
  ok('[migration tls] given that root (DATABASE_SSL_CA_FILE), the same kind of server is accepted and the runner sends its startup message',
     g2.seen.startup > 0 && String(trusted) === '28000', `${trusted} startup=${g2.seen.startup}`)
  ok('[migration tls] a trusted certificate for another host name is refused and nothing is sent (the host name is checked, not only the chain)',
     /ALTNAME|does not match|Hostname\/IP/i.test(String(misnamed)) && w.seen.startup === 0, `${misnamed} startup=${w.seen.startup}`)

  // And it still applies to the local harness database, the explicit way.
  writeFileSync(`${dir}/local.sql`, 'CREATE TABLE IF NOT EXISTS batchc_migration_tls_probe (x int);')
  const before = process.env.DATABASE_SSL
  process.env.DATABASE_SSL = 'disable'
  let applied
  try { applied = await applyMigration(process.env.DATABASE_URL, `${dir}/local.sql`, { attempts: 1, log: () => {} }) } catch (e) { applied = e?.message }
  finally { if (before === undefined) delete process.env.DATABASE_SSL; else process.env.DATABASE_SSL = before }
  const [t] = await sql`SELECT count(*)::int AS n FROM pg_tables WHERE tablename = 'batchc_migration_tls_probe'`
  ok('[migration tls] with DATABASE_SSL=disable on localhost it applies to the local harness database', applied?.attempts === 1 && t.n === 1, JSON.stringify(applied))
  await sql`DROP TABLE IF EXISTS batchc_migration_tls_probe`
}
