// [batchc] Security batch C (2026-09-25): the audit items left after batches A
// and B. One section per item, each on accounts it plants and deletes itself.
//
//   [S7 events]  POST /events and POST /step count against a monthly
//                records-and-steps allowance (migration 028,
//                src/lib/event-quota.ts), exactly under concurrency, and the
//                record that settles its own preflight is never refused.
//
// Every gate here was planted red once before it was trusted; the plants and
// which gate each turned red are in the commit that added the gate.
import { insertKeyRow } from './key-fixture.mjs'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const shaped = (tag) => 'agb_' + createHash('sha256').update(`${tag}-${randomBytes(6).toString('hex')}`).digest('hex').slice(0, 48)

export async function batchcGates(opts) {
  const sections = [['S7 events', eventsGates]]
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
