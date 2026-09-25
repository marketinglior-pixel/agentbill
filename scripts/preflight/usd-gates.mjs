// [usd] A job whose ceiling is in dollars (T3, migration 025, 2026-09-25).
//
// What each gate stands behind:
//   - the unit and its column exist, and the old two units still validate;
//   - PUT and preflight accept a ceiling in dollars, exactly one ceiling at a
//     time, and a dollar job keeps its unit;
//   - preflight reserves an estimate (the caller's, the job's median, or the
//     $0.10 default), and 40 preflights in parallel never reserve past the
//     ceiling, with the counter equal to the open reservation rows;
//   - record settles to the list price of the tokens reported, and an
//     unpriced call is charged its reservation or the job's estimate, never
//     $0, counted in unpriced_calls, with price_version on every event;
//   - another account's jobs and prices never reach this one;
//   - a job in units or tokens answers exactly as it did;
//   - the console sets "$5 for this job" and suggests in dollars from priced
//     history;
//   - the Python SDK's wrap(task_ceiling_usd=...) end to end against this
//     server: the production path, a real key over HTTP, no test bypass.
//
// Every account here is its own, planted and deleted by this file.
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'

export async function usdGates(opts) {
  console.log('\n[usd] a job whose ceiling is in dollars')
  let reached = false
  try {
    await gates(opts)
    reached = true
  } catch (err) {
    opts.ok('[usd] a gate threw', false, String(err?.stack ?? err).slice(0, 600))
  }
  opts.ok('[usd] every gate ran to the end', reached)
}

async function gates({ API, sql, ok, legacyKey }) {
  const key = (tag) => 'agb_' + createHash('sha256').update(`${tag}-${randomBytes(6).toString('hex')}`).digest('hex').slice(0, 48)
  const A = '00000000-0000-0000-0000-0000000000d1'
  const B = '00000000-0000-0000-0000-0000000000d2'
  const KA = key('usd-a'), KB = key('usd-b')
  for (const [id, k] of [[A, KA], [B, KB]]) {
    await sql`DELETE FROM accounts WHERE id = ${id}`
    await sql`INSERT INTO accounts (id, plan, monthly_calls, billing_period_start) VALUES (${id}, 'scale', 0, date_trunc('month', CURRENT_DATE)::date)`
    await sql`INSERT INTO developer_api_keys (account_id, api_key, label) VALUES (${id}, ${k}, 'harness-usd')`
  }
  const call = async (method, path, body, k = KA) => {
    const r = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    return { status: r.status, body: await r.json().catch(() => null) }
  }
  const pre = (b, k) => call('POST', '/preflight', { agent_id: 'usd-agent', ...b }, k)
  let n = 0
  const rec = (b, k) => call('POST', '/events', { customer_id: 'default', event_type: 'usd-agent', idempotency_key: `usd-${Date.now()}-${n++}`, ...b }, k)
  const job = async (ref, acct = A) => (await sql`SELECT unit, ceiling_units, used_units, reserved_units, unpriced_calls, usage_missing_calls FROM task_budgets WHERE account_id = ${acct} AND task_ref = ${ref}`)[0]
  const openSum = async (ref, acct = A) => Number((await sql`SELECT coalesce(sum(units), 0) AS s FROM reservations WHERE account_id = ${acct} AND task_ref = ${ref} AND released_at IS NULL`)[0].s)
  const gpt4o = (input, output) => ({ provider: 'openai', model: 'gpt-4o', tokens: { input, output } })
  const [{ version: PV }] = [{ version: (await import('../../dist/lib/prices.js')).PRICE_VERSION }]

  // ---- the schema
  const con = await sql`SELECT pg_get_constraintdef(oid) AS def, convalidated FROM pg_constraint WHERE conname = 'task_budgets_unit_known'`
  const col = await sql`SELECT column_default FROM information_schema.columns WHERE table_name = 'task_budgets' AND column_name = 'unpriced_calls'`
  let rejected = false
  try { await sql`INSERT INTO task_budgets (account_id, agent_id, task_ref, ceiling_units, unit) VALUES (${A}, 'x', 'usd-bad-unit', 1, 'dollar')` } catch { rejected = true }
  ok('[usd] migration 025: the unit check allows usd beside unit and token, is validated, rejects anything else, and unpriced_calls defaults to 0',
     /'unit'/.test(con[0]?.def) && /'token'/.test(con[0]?.def) && /'usd'/.test(con[0]?.def) && con[0]?.convalidated === true && rejected && col[0]?.columnDefault === '0',
     JSON.stringify({ con, col, rejected }))

  // ---- opening a job in dollars
  const put5 = await call('PUT', '/tasks/usd-put/ceiling', { ceiling_usd: 5 })
  ok('[usd] PUT ceiling_usd: 5 opens a job in usd at 5,000,000 micro-dollars and answers the same figure in dollars',
     put5.status === 200 && put5.body.unit === 'usd' && put5.body.ceiling_units === 5_000_000 && put5.body.ceiling_usd === 5 && put5.body.remaining_usd === 5
       && put5.body.unpriced_calls === 0 && put5.body.task_created === true, JSON.stringify(put5))
  const bad = await Promise.all([
    call('PUT', '/tasks/usd-put2/ceiling', { ceiling_usd: 5, ceiling_units: 5 }),
    call('PUT', '/tasks/usd-put2/ceiling', {}),
    call('PUT', '/tasks/usd-put2/ceiling', { ceiling_usd: 0.0000001 }),
    call('PUT', '/tasks/usd-put2/ceiling', { ceiling_usd: 5, unit: 'token' }),
    call('PUT', '/tasks/usd-put2/ceiling', { ceiling_usd: 1_000_001 }),
    pre({ task_ref: 'usd-put2', task_ceiling_usd: 5, task_ceiling: 5 }),
    pre({ task_ref: 'usd-put2', task_ceiling_usd: 5, unit: 'unit' }),
    pre({ estimated_usd: 0.5 }),
  ])
  ok('[usd] exactly one ceiling: both, neither, seven decimals, a unit other than usd beside it, over $1,000,000, and estimated_usd with no job are each a 422, and nothing opened',
     bad.every((r) => r.status === 422) && !(await job('usd-put2')), bad.map((r) => r.status).join(','))
  await call('PUT', '/tasks/usd-tok/ceiling', { ceiling_units: 1000, unit: 'token' })
  const clash = await call('PUT', '/tasks/usd-tok/ceiling', { ceiling_usd: 2 })
  const clashP = await pre({ task_ref: 'usd-put', unit: 'token', estimated_units: 5 })
  const clashE = await pre({ task_ref: 'usd-tok', estimated_usd: 0.01 })
  ok('[usd] a job keeps its unit: dollars on a token job and tokens on a dollar job are task_unit_mismatch, and so is estimated_usd on a token job',
     clash.status === 422 && clash.body.error === 'task_unit_mismatch' && clash.body.unit === 'token'
       && clashP.status === 422 && clashP.body.unit === 'usd' && clashE.status === 422 && clashE.body.unit === 'token'
       && (await job('usd-tok')).ceilingUnits === 1000 && (await job('usd-put')).reservedUnits === 0,
     JSON.stringify([clash.body, clashP.body, clashE.body]).slice(0, 400))
  const opened = await pre({ task_ref: 'usd-pf', task_ceiling_usd: 1.5, estimated_units: 1 })
  ok('[usd] preflight task_ceiling_usd opens the job in usd, reserves the $0.10 default (a bare estimated_units: 1 beside it is not micro-dollars) and says so in both units',
     opened.body?.approved === true && opened.body.task_unit === 'usd' && opened.body.estimate_source === 'default' && opened.body.estimated_units === 100_000
       && opened.body.estimated_usd === 0.1 && opened.body.task_ceiling === 1_500_000 && opened.body.task_ceiling_usd === 1.5 && opened.body.task_remaining_units === 1_400_000
       && (await job('usd-pf')).unit === 'usd' && (await job('usd-pf')).reservedUnits === 100_000, JSON.stringify(opened.body))

  // ---- the remote MCP endpoint's preflight tool, over a bearer key: the production path an assistant takes
  const mcp = await fetch(`${API}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${KA}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'preflight', arguments: { agent_id: 'mcp-usd', task_ref: 'usd-mcp', task_ceiling_usd: 2 } } }) })
  const mcpText = await mcp.text()
  let mcpOut = null
  try { mcpOut = JSON.parse(mcpText.startsWith('{') ? mcpText : (mcpText.match(/^data: (.*)$/m) ?? [])[1]).result?.structuredContent } catch {}
  ok('[usd] MCP preflight with task_ceiling_usd: the tool\'s default estimated_units of 1 is not sent, so the $0.10 default is reserved, and the dollar figures come back',
     mcp.status === 200 && mcpOut?.approved === true && mcpOut.task_unit === 'usd' && mcpOut.estimate_source === 'default' && mcpOut.estimated_usd === 0.1
       && mcpOut.task_ceiling_usd === 2 && (await job('usd-mcp')).reservedUnits === 100_000, mcpText.slice(0, 400))

  // ---- concurrency: 40 at once on $1.00, at the $0.10 default and at a caller's $0.03
  await call('PUT', '/tasks/usd-burst/ceiling', { ceiling_usd: 1 })
  const burst = await Promise.all(Array.from({ length: 40 }, () => pre({ task_ref: 'usd-burst' })))
  const jb = await job('usd-burst')
  const yes = burst.filter((r) => r.body?.approved === true).length
  const no = burst.filter((r) => r.body?.approved === false && r.body.reason === 'task_ceiling_exceeded').length
  ok('[usd] 40 parallel preflights on a $1.00 job at the $0.10 default: exactly 10 approved, 30 refused, reserved is exactly the ceiling and equals the open reservation rows',
     yes === 10 && no === 30 && jb.reservedUnits === 1_000_000 && jb.usedUnits === 0 && (await openSum('usd-burst')) === 1_000_000, `${yes}/${no} ${JSON.stringify(jb)}`)
  await call('PUT', '/tasks/usd-burst3/ceiling', { ceiling_usd: 1 })
  const burst3 = await Promise.all(Array.from({ length: 40 }, () => pre({ task_ref: 'usd-burst3', estimated_usd: 0.03 })))
  const jb3 = await job('usd-burst3')
  const yes3 = burst3.filter((r) => r.body?.approved === true).length
  ok('[usd] and at the caller\'s own $0.03: exactly 33 approved ($0.99), never past the ceiling',
     yes3 === 33 && jb3.reservedUnits === 990_000 && jb3.reservedUnits <= jb3.ceilingUnits && (await openSum('usd-burst3')) === 990_000
       && burst3.filter((r) => r.body?.approved).every((r) => r.body.estimate_source === 'caller' && r.body.estimated_units === 30_000), `${yes3} ${JSON.stringify(jb3)}`)
  const refusedB = burst.find((r) => r.body?.approved === false)?.body
  const [decB] = await sql`SELECT estimated_units, ceiling_units, used_units FROM preflight_decisions WHERE account_id = ${A} AND task_ref = 'usd-burst' ORDER BY id LIMIT 1`
  ok('[usd] a refusal on a dollar job carries the ask and the job in micro-dollars and in dollars, with whose estimate it was, and the decision row keeps the ask',
     refusedB?.task_unit === 'usd' && refusedB.estimated_units === 100_000 && refusedB.estimated_usd === 0.1 && refusedB.estimate_source === 'default'
       && refusedB.task_ceiling === 1_000_000 && refusedB.task_ceiling_usd === 1 && refusedB.task_remaining_usd === 0 && Number(decB?.estimatedUnits) === 100_000,
     JSON.stringify({ refusedB, decB }))

  // ---- settling to the actual, and the median it leaves behind
  await call('PUT', '/tasks/usd-settle/ceiling', { ceiling_usd: 0.25 })
  const p1 = await pre({ task_ref: 'usd-settle' })
  const r1 = await rec({ task_ref: 'usd-settle', reservation_id: p1.body.reservation_id, units: 12_000, metadata: gpt4o(10_000, 2_000) })
  const j1 = await job('usd-settle')
  const [e1] = await sql`SELECT units, list_price_usd::text AS usd, price_version, metadata->>'usd_charge_basis' AS basis FROM events WHERE account_id = ${A} AND task_ref = 'usd-settle'`
  ok('[usd] record settles the reservation to the list price of the tokens: gpt-4o, 10,000 in and 2,000 out, is $0.045, whatever units the caller sent',
     r1.status === 200 && r1.body.charge_basis === 'list_price' && r1.body.units_recorded === 45_000 && r1.body.charged_usd === 0.045
       && r1.body.reservation_status === 'settled' && r1.body.reservation_released_units === 100_000
       && j1.usedUnits === 45_000 && j1.reservedUnits === 0 && e1.units === 45_000 && e1.usd === '0.045000000000' && e1.priceVersion === PV && e1.basis === 'list_price',
     JSON.stringify({ r1: r1.body, j1, e1 }))
  const p2 = await pre({ task_ref: 'usd-settle' })
  ok('[usd] the next preflight reserves the job\'s median call, $0.045, and says it came from the job',
     p2.body?.approved === true && p2.body.estimate_source === 'job_median' && p2.body.estimated_units === 45_000, JSON.stringify(p2.body))
  const p2b = await pre({ task_ref: 'usd-settle', estimated_units: 3 })
  const p2c = await pre({ task_ref: 'usd-settle', estimated_units: 7_000, unit: 'usd' })
  ok('[usd] a bare estimated_units is not read as money (the job\'s median is reserved and named), while one sent with unit usd is the caller\'s micro-dollars',
     p2b.body?.estimate_source === 'job_median' && p2b.body.estimated_units === 45_000 && p2c.body?.estimate_source === 'caller' && p2c.body.estimated_units === 7_000,
     JSON.stringify([p2b.body?.estimate_source, p2b.body?.estimated_units, p2c.body?.estimate_source, p2c.body?.estimated_units]))
  for (const p of [p2b, p2c]) await rec({ task_ref: 'usd-settle', reservation_id: p.body.reservation_id, success: false, units: 0 })

  // ---- the unpriced call: never $0
  const r2 = await rec({ task_ref: 'usd-settle', reservation_id: p2.body.reservation_id, units: 1 })
  const p3 = await pre({ task_ref: 'usd-settle' })
  const r3 = await rec({ task_ref: 'usd-settle', reservation_id: p3.body.reservation_id, units: 500, metadata: { provider: 'openai', model: 'no-such-model-9', tokens: { input: 500, output: 0 } } })
  const p4 = await pre({ task_ref: 'usd-settle' })
  const r4 = await rec({ task_ref: 'usd-settle', reservation_id: p4.body.reservation_id, units: 0, usage_missing: true, metadata: { provider: 'openai', model: 'gpt-4o' } })
  const r5 = await rec({ task_ref: 'usd-settle', units: 1 })
  const j5 = await job('usd-settle')
  const ev5 = await sql`SELECT units, list_price_usd, price_version, price_note, metadata->>'usd_unpriced' AS unpriced, metadata->>'usd_charge_basis' AS basis
    FROM events WHERE account_id = ${A} AND task_ref = 'usd-settle' ORDER BY created_at, id`
  ok('[usd] an unpriced call on a dollar job is charged its reservation, never $0: no model, a model with no list price, and usage missing, each at the $0.045 it held',
     [r2, r3, r4].every((r) => r.status === 200 && r.body.charge_basis === 'reservation' && r.body.units_recorded === 45_000 && r.body.charged_usd === 0.045),
     JSON.stringify([r2.body, r3.body, r4.body]).slice(0, 500))
  ok('[usd] and with no reservation open it is charged the job\'s own estimate, the median of its priced calls',
     r5.status === 200 && r5.body.charge_basis === 'estimate' && r5.body.units_recorded === 45_000, JSON.stringify(r5.body))
  ok('[usd] the job counts them: 4 unpriced calls, one of them usage missing, $0.225 used, nothing left reserved',
     j5.unpricedCalls === 4 && j5.usageMissingCalls === 1 && j5.usedUnits === 225_000 && j5.reservedUnits === 0 && (await openSum('usd-settle')) === 0, JSON.stringify(j5))
  ok('[usd] every settled event names the price table it was charged against, and an unpriced one stores no list price and says why',
     ev5.length === 5 && ev5.every((e) => e.priceVersion === PV) && ev5.slice(1).every((e) => e.listPriceUsd === null && e.unpriced === 'true' && /never \$0/.test(e.priceNote ?? ''))
       && ev5[0].unpriced === null, JSON.stringify(ev5).slice(0, 600))
  const t5 = await call('GET', '/tasks/usd-settle')
  ok('[usd] GET /tasks/:task_ref: the micro-dollars, the same in dollars, unpriced_calls, and a breakdown that prices only the priced call',
     t5.body?.unit === 'usd' && t5.body.used_units === 225_000 && t5.body.used_usd === 0.225 && t5.body.remaining_usd === 0.025 && t5.body.unpriced_calls === 4
       && t5.body.breakdown?.list_price_usd_estimate === 0.045 && t5.body.breakdown?.unpriced_calls === 4, JSON.stringify(t5.body).slice(0, 400))
  const p6 = await pre({ task_ref: 'usd-settle' })
  ok('[usd] and the job is now refused: $0.225 used, $0.045 asked, $0.25 ceiling',
     p6.body?.approved === false && p6.body.reason === 'task_ceiling_exceeded' && p6.body.task_used_usd === 0.225 && p6.body.estimated_usd === 0.045, JSON.stringify(p6.body))
  const pF = await pre({ task_ref: 'usd-pf' })
  const rF = await rec({ task_ref: 'usd-pf', reservation_id: pF.body.reservation_id, success: false, units: 0 })
  const rFu = await rec({ task_ref: 'usd-pf', success: false, units: 1 })
  ok('[usd] a failed call releases its reservation and charges nothing: named whole, and unnamed the oldest open one whole, not 1 micro-dollar of it',
     rF.body?.status === 'released' && rF.body.reservation_released_units === 100_000 && rFu.body?.status === 'released'
       && (await job('usd-pf')).usedUnits === 0 && (await job('usd-pf')).reservedUnits === 0 && (await openSum('usd-pf')) === 0, JSON.stringify([rF.body, rFu.body, await job('usd-pf')]))

  // ---- isolation: another account, the same task_ref, dear calls of its own
  await call('PUT', '/tasks/usd-shared/ceiling', { ceiling_usd: 100 }, KB)
  for (let i = 0; i < 3; i++) {
    const p = await pre({ task_ref: 'usd-shared' }, KB)
    await rec({ task_ref: 'usd-shared', reservation_id: p.body.reservation_id, metadata: gpt4o(200_000, 20_000) }, KB)
  }
  await call('PUT', '/tasks/usd-shared/ceiling', { ceiling_usd: 1 })
  const pa = await pre({ task_ref: 'usd-shared' })
  const jB = await job('usd-shared', B)
  ok('[usd] another account\'s job under the same task_ref: its $0.70 calls never set this account\'s estimate, and this account\'s reserve never touches its row',
     pa.body?.estimate_source === 'default' && pa.body.estimated_units === 100_000 && jB.usedUnits === 2_100_000 && jB.reservedUnits === 0 && jB.ceilingUnits === 100_000_000,
     JSON.stringify({ pa: pa.body, jB }))
  const listA = await call('GET', '/tasks')
  ok('[usd] and neither account lists the other\'s dollar job', !JSON.stringify(listA.body).includes('2100000') && (await call('GET', '/tasks', null, KB)).body.tasks.length === 1)

  // ---- old callers: a job in units and one in tokens answer exactly as before
  const u1 = await pre({ task_ref: 'usd-old-unit', task_ceiling: 10, estimated_units: 3 })
  const u2 = await rec({ task_ref: 'usd-old-unit', reservation_id: u1.body.reservation_id, units: 2 })
  const tk1 = await pre({ task_ref: 'usd-old-tok', task_ceiling: 1000, unit: 'token', estimated_units: 300 })
  const tk2 = await rec({ task_ref: 'usd-old-tok', reservation_id: tk1.body.reservation_id, units: 250, metadata: gpt4o(200, 50) })
  const noTask = await pre({ estimated_units: 4 })
  const usdKeys = (b) => Object.keys(b ?? {}).filter((k) => /usd|estimate_source|task_unit|charge/.test(k))
  ok('[usd] old callers: a job in units and one in tokens reserve and record the numbers they send, with no dollar field added, and so does a preflight with no job',
     u1.body.approved && u1.body.estimated_units === 3 && u1.body.task_remaining_units === 7 && u2.body.task_used_units === 2 && u2.body.task_remaining_units === 8
       && tk1.body.estimated_units === 300 && tk2.body.task_used_units === 250 && noTask.body.estimated_units === 4
       && [u1, u2, tk1, tk2, noTask].every((r) => usdKeys(r.body).length === 0)
       && (await job('usd-old-unit')).unit === 'unit' && (await job('usd-old-tok')).unit === 'token',
     JSON.stringify([u1.body, u2.body, tk1.body, tk2.body].map(usdKeys)))
  const [tkEv] = await sql`SELECT units, list_price_usd::text AS usd FROM events WHERE account_id = ${A} AND task_ref = 'usd-old-tok'`
  ok('[usd] a token job\'s record is still the tokens sent, with the list price stored beside it as before',
     tkEv?.units === 250 && tkEv.usd === '0.001000000000', JSON.stringify(tkEv))

  // ---- the console: "$5 for this job"
  const FORM = { 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin' }
  const login = await fetch(`${API}/app/session`, { method: 'POST', redirect: 'manual', headers: FORM, body: `api_key=${KA}` })
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
  const post = (body) => fetch(`${API}/app/tasks`, { method: 'POST', redirect: 'manual', headers: { ...FORM, cookie }, body })
  const page = (q) => fetch(`${API}/app?${q}`, { headers: { cookie } }).then((r) => r.text())
  const s1 = await post('task_ref=usd-form&ceiling=5&unit=usd')
  const s2 = await post('task_ref=usd-form&ceiling=4&unit=token')
  const s3 = await post('task_ref=usd-form2&ceiling=5.1234567&unit=usd')
  const s4 = await post('task_ref=usd-form&ceiling=%244.25&unit=usd')
  const jf = await job('usd-form')
  ok('[usd] the console form opens "$5 for this job" in usd, refuses tokens on it and seven decimals, and a later "$4.25" saves 4,250,000',
     s1.status === 303 && s1.headers.get('location') === '/app?view=tasks&saved=usd-form&created=1'
       && s2.headers.get('location') === '/app?view=tasks&err=unit&ref=usd-form' && s3.headers.get('location') === '/app?view=tasks&err=usd&ref=usd-form2'
       && s4.headers.get('location') === '/app?view=tasks&saved=usd-form' && jf?.unit === 'usd' && jf.ceilingUnits === 4_250_000 && !(await job('usd-form2')),
     JSON.stringify([s1.headers.get('location'), s2.headers.get('location'), s3.headers.get('location'), s4.headers.get('location'), jf]))
  const unitMsg = await page('view=tasks&err=unit&ref=usd-form')
  const tasksP = await page('view=tasks')
  const rowF = (tasksP.match(/<tr[^>]*>(?:(?!<\/tr>)[\s\S])*?usd-form<\/a>[\s\S]*?<\/tr>/) ?? [''])[0]
  ok('[usd] the unit error names the job\'s own unit from its row, and the job\'s row reads in dollars with a dollar editor',
     unitMsg.includes('is counted in dollars') && rowF.includes('<b>$0</b> / $4.25 <span class="est">est.</span>') && rowF.includes('$4.25 left')
       && rowF.includes('name="unit" value="usd"') && rowF.includes('name="ceiling" type="text" inputmode="decimal"') && rowF.includes('value="4.25"'),
     rowF.replace(/\s+/g, ' ').slice(0, 500))
  const settleRow = (tasksP.match(/<tr[^>]*>(?:(?!<\/tr>)[\s\S])*?usd-settle<\/a>[\s\S]*?<\/tr>/) ?? [''])[0]
  ok('[usd] a dollar job with unpriced calls says how many were charged at their estimate',
     settleRow.includes('<b>$0.225</b> / $0.25') && settleRow.includes('4 calls with no list price, charged at their estimate'), settleRow.replace(/\s+/g, ' ').slice(0, 500))
  const refP = await page('view=refusals&task=usd-burst')
  ok('[usd] a refusal on a dollar job reads in dollars on the refusals view',
     refP.includes('Asked to reserve $0.10 with the task at $0 of $1.00, at list price.'), (refP.match(/<td class="msg[^"]*">[^<]*/) ?? [''])[0])

  // ---- the suggestion from history, in dollars when the history is priced
  for (const [ref, input] of [['usd-h1', 2_000], ['usd-h2', 4_000], ['usd-h3', 6_000]]) {
    const p = await pre({ agent_id: 'priced-agent', task_ref: ref, task_ceiling: 100_000, unit: 'token', estimated_units: 100 })
    await rec({ event_type: 'priced-agent', task_ref: ref, reservation_id: p.body.reservation_id, units: input, metadata: gpt4o(input, 0) })
  }
  const hist = await page('view=tasks')
  const hrow = (hist.match(/<div class="hrow">(?:(?!<\/div>)[\s\S])*?priced-agent[\s\S]*?<\/div>/) ?? [''])[0]
  const pickP = await page('view=tasks&history=priced-agent&pick=p50')
  const field = (pickP.match(/<input id="t-ceil"[^>]*>/) ?? [''])[0]
  const sel = (pickP.match(/<select id="t-unit"[\s\S]*?<\/select>/) ?? [''])[0]
  ok('[usd] an agent whose finished jobs were all priced is suggested in dollars: p50 $0.01, p90 and max $0.015, at list price',
     hrow.includes('p50 <b>$0.01</b>') && hrow.includes('max <b>$0.015</b>') && hrow.includes('at list price') && !hrow.includes('tokens'), hrow.replace(/\s+/g, ' ').slice(0, 400))
  ok('[usd] and a pick fills "$0.01" with dollars chosen, still editable, nothing saved',
     /value="0\.01"/.test(field) && /<option value="usd" selected>/.test(sel) && !(await job('priced-agent-next')), `${field} ${sel.replace(/\s+/g, ' ').slice(0, 200)}`)

  // ---- the production path: the Python SDK's wrap(task_ceiling_usd=...) against this server
  const PY = process.env.WRAP_PYTHON
  const dir = mkdtempSync(`${tmpdir()}/agentbill-usd-`)
  writeFileSync(`${dir}/run.py`, `import json, agentbill
from types import SimpleNamespace as NS
from agentbill import Refusal
class Msgs:
    sent = 0
    def create(self, **kw):
        Msgs.sent += 1
        return NS(id=f"msg_usd_{Msgs.sent}", model="claude-sonnet-4-5", usage=NS(input_tokens=10000, output_tokens=1000,
                  cache_read_input_tokens=0, cache_creation_input_tokens=0), content=[NS(type="text", text="ok")])
class FakeAnthropic:
    def __init__(self):
        self.messages = Msgs()
        self.base_url = "https://api.anthropic.com"
FakeAnthropic.__module__ = "anthropic"
llm = agentbill.wrap(FakeAnthropic(), task_ref="usd-sdk", agent_id="py-usd", task_ceiling_usd=0.2, provider="anthropic")
out = {"calls": []}
for i in range(8):
    r = llm.messages.create(model="claude-sonnet-4-5", max_tokens=1000, messages=[{"role": "user", "content": "x"}])
    if isinstance(r, Refusal):
        out["refused"] = {"at": i + 1, "unit": r.unit, "reason": r.reason, "text": str(r)}
        break
    out["calls"].append(r.id)
out["sent"] = Msgs.sent
print(json.dumps(out))
`)
  const root = new URL('../../sdk/python', import.meta.url).pathname
  const run = PY ? spawnSync(PY, [`${dir}/run.py`], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, PYTHONPATH: root, AGENTBILL_BASE_URL: API, AGENTBILL_API_KEY: KA } }) : null
  let out = null
  try { out = JSON.parse((run?.stdout ?? '').trim().split('\n').pop()) } catch {}
  const js = await job('usd-sdk')
  const evs = await sql`SELECT units, list_price_usd::text AS usd, price_version FROM events WHERE account_id = ${A} AND task_ref = 'usd-sdk' ORDER BY created_at`
  // claude-sonnet-4-5: 10,000 in at $3/M and 1,000 out at $15/M is $0.045 a call.
  // $0.10 default, then the $0.045 median: the 5th call asks $0.045 with $0.18 used, $0.02 left, and is refused.
  ok('[usd] python wrap(task_ceiling_usd=0.2): four real calls at $0.045 each, settled to list price, the fifth returned as a dollar Refusal before it is sent',
     run?.status === 0 && out?.sent === 4 && out.calls.length === 4 && out.refused?.at === 5 && out.refused.unit === 'usd' && out.refused.reason === 'task_ceiling_exceeded'
       && /\$0\.18 of \$0\.2 at list price/.test(out.refused.text) && js?.unit === 'usd' && js.usedUnits === 180_000 && js.reservedUnits === 0
       && evs.length === 4 && evs.every((e) => e.units === 45_000 && e.usd === '0.045000000000' && e.priceVersion === PV),
     PY ? `${run?.status} ${(run?.stdout ?? '').slice(-300)} ${(run?.stderr ?? '').slice(-400)} ${JSON.stringify(js)}` : 'WRAP_PYTHON is not set')

  // ---- customer balances never mix units (2026-09-25)
  // A customer's used / limit / left and the 800-unit owner alert count the
  // units and tokens the code reported, never a dollar job's micro-dollars.
  const cust = async (ref, acct = A) => (await sql`SELECT used_units, reserved_units, limit_units FROM customers WHERE account_id = ${acct} AND customer_ref = ${ref}`)[0]
  await call('PUT', '/budget', { customer_id: 'cust-mix', limit_units: 800 })
  await call('PUT', '/tasks/cust-usd-job/ceiling', { ceiling_usd: 10 })
  const pc = await pre({ task_ref: 'cust-usd-job', customer_id: 'cust-mix' })
  const midC = await cust('cust-mix')
  await rec({ task_ref: 'cust-usd-job', customer_id: 'cust-mix', reservation_id: pc.body.reservation_id, metadata: gpt4o(100_000, 10_000) })
  const afterC = await cust('cust-mix')
  const jc = await job('cust-usd-job')
  ok('[usd] a dollar job\'s spend never moves the customer\'s unit balance: $0.35 recorded, the customer still at 0 used and 0 reserved, during the call and after it',
     pc.body?.approved === true && midC.usedUnits === 0 && midC.reservedUnits === 0 && afterC.usedUnits === 0 && afterC.reservedUnits === 0 && jc.usedUnits === 350_000,
     JSON.stringify({ midC, afterC, jc }))
  // The same customer spends its 800 units on a unit job: it is then at its
  // unit limit. A unit call is refused; the dollar job, bounded by its own
  // ceiling and never drawing on the unit balance, is not.
  const pu = await pre({ task_ref: 'cust-unit-job', task_ceiling: 5000, customer_id: 'cust-mix', estimated_units: 800 })
  await rec({ task_ref: 'cust-unit-job', customer_id: 'cust-mix', reservation_id: pu.body.reservation_id, units: 800 })
  const puNo = await pre({ task_ref: 'cust-unit-job', customer_id: 'cust-mix', estimated_units: 1 })
  const pcYes = await pre({ task_ref: 'cust-usd-job', customer_id: 'cust-mix' })
  await rec({ task_ref: 'cust-usd-job', customer_id: 'cust-mix', reservation_id: pcYes.body.reservation_id, success: false, units: 0 })
  ok('[usd] the customer\'s unit limit governs unit work only: at 800 of 800 units a unit call is budget_exhausted, a call on its dollar job is approved, and its balance reads 800',
     puNo.body?.approved === false && puNo.body.reason === 'budget_exhausted' && pcYes.body?.approved === true && (await cust('cust-mix')).usedUnits === 800
       && (await cust('cust-mix')).reservedUnits === 0, JSON.stringify([puNo.body, pcYes.body?.approved, await cust('cust-mix')]))
  // The 800-unit alert: $0.001 is 1,000 micro-dollars, past 800 if it were read as units.
  await call('PUT', '/tasks/cust-alert-job/ceiling', { ceiling_usd: 1 })
  const pa1 = await pre({ task_ref: 'cust-alert-job', customer_id: 'cust-alert-usd' })
  await rec({ task_ref: 'cust-alert-job', customer_id: 'cust-alert-usd', reservation_id: pa1.body.reservation_id, metadata: gpt4o(400, 0) })
  const pa2 = await pre({ task_ref: 'cust-alert-units', task_ceiling: 5000, customer_id: 'cust-alert-units', estimated_units: 900 })
  await rec({ task_ref: 'cust-alert-units', customer_id: 'cust-alert-units', reservation_id: pa2.body.reservation_id, units: 900 })
  const alertsFor = async () => {
    for (let i = 0; i < 40; i++) {
      const rows = await sql`SELECT customer_ref FROM customer_usage_alerts WHERE account_id = ${A}`
      if (rows.some((r) => r.customerRef === 'cust-alert-units')) return rows.map((r) => r.customerRef)
      await new Promise((r) => setTimeout(r, 100))
    }
    return (await sql`SELECT customer_ref FROM customer_usage_alerts WHERE account_id = ${A}`).map((r) => r.customerRef)
  }
  const claimed = await alertsFor()
  ok('[usd] the customer usage alert never fires on dollar spend: 1,000 micro-dollars claim nothing, while 900 units on another customer do',
     claimed.includes('cust-alert-units') && !claimed.includes('cust-alert-usd') && (await cust('cust-alert-usd')).usedUnits === 0 && (await job('cust-alert-job')).usedUnits === 1_000,
     JSON.stringify({ claimed, usd: await cust('cust-alert-usd') }))
  // The sweeper: an expired dollar reservation must not be taken off the
  // customer's unit reservations still in flight.
  const pInflight = await pre({ task_ref: 'cust-sweep-units', task_ceiling: 5000, customer_id: 'cust-sweep', estimated_units: 50 })
  await call('PUT', '/tasks/cust-sweep-usd/ceiling', { ceiling_usd: 1 })
  const pExp = await pre({ task_ref: 'cust-sweep-usd', customer_id: 'cust-sweep' })
  await sql`UPDATE reservations SET expires_at = now() - interval '1 minute' WHERE public_id = ${pExp.body.reservation_id}`
  const { sweepExpiredReservations } = await import('../../dist/lib/reservation-sweeper.js')
  await sweepExpiredReservations()
  const cs = await cust('cust-sweep')
  ok('[usd] the sweeper reclaims an expired dollar reservation from its job and leaves the customer\'s 50 units in flight alone',
     pInflight.body?.approved === true && cs.reservedUnits === 50 && (await job('cust-sweep-usd')).reservedUnits === 0 && (await job('cust-sweep-units')).reservedUnits === 50,
     JSON.stringify({ cs, usd: await job('cust-sweep-usd') }))
  await rec({ task_ref: 'cust-sweep-units', customer_id: 'cust-sweep', reservation_id: pInflight.body.reservation_id, success: false, units: 0 })

  // /customers: units and dollars, side by side, never summed.
  const custList = await call('GET', '/customers')
  const cm = (custList.body ?? []).find((c) => c.customerId === 'cust-mix')
  const [cmUsd] = await sql`SELECT sum(e.list_price_usd)::text AS usd FROM events e JOIN customers c ON c.id = e.customer_id WHERE c.account_id = ${A} AND c.customer_ref = 'cust-mix'`
  ok('[usd] GET /customers: used and remaining stay units (800, 0 left), and the dollar spend is a separate estimate, equal to the priced events, labelled',
     cm?.used === 800 && cm.limit === 800 && cm.remaining === 0 && cm.isBlocked === true && cm.listPriceUsdEstimate === Number(cmUsd.usd) && cm.listPriceUsdEstimate === 0.35
       && cm.pricedCalls === 1 && /list price/.test(cm.listPriceLabel ?? ''), JSON.stringify(cm))
  const custPage = await page('view=customers')
  const cmRow = (custPage.match(/<tr[^>]*>\s*<td class="id lead" title="cust-mix">[\s\S]*?<\/tr>/) ?? [''])[0]
  ok('[usd] the customers view shows Est. cost and Units used as two columns: $0.35 beside 800, never 350,800',
     custPage.includes('<th class="num">Est. cost</th><th class="num">Units used</th>') && cmRow.includes('>$0.35</td>') && cmRow.includes('title="units and tokens your code reported, never dollars">800</td>')
       && !custPage.includes('350,800') && !custPage.includes('350800'), cmRow.replace(/\s+/g, ' ').slice(0, 400))

  // An account that never used dollars or a priced call: /customers and
  // GET /tasks?sort=used byte for byte as before T3 (keys, order, values).
  const C = '00000000-0000-0000-0000-0000000000d3', KC = key('usd-c')
  await sql`DELETE FROM accounts WHERE id = ${C}`
  await sql`INSERT INTO accounts (id, plan, monthly_calls, billing_period_start) VALUES (${C}, 'scale', 0, date_trunc('month', CURRENT_DATE)::date)`
  await sql`INSERT INTO developer_api_keys (account_id, api_key, label) VALUES (${C}, ${KC}, 'harness-usd-old')`
  await call('PUT', '/budget', { customer_id: 'old-a', limit_units: 100 }, KC)
  for (const [c, t, u] of [['old-a', 'old-j1', 30], ['old-b', 'old-j2', 70], ['old-a', 'old-j3', 5], ['old-c', 'old-j2', 1]]) {
    const p = await pre({ task_ref: t, task_ceiling: 1000, customer_id: c, estimated_units: u }, KC)
    await rec({ task_ref: t, customer_id: c, reservation_id: p.body.reservation_id, units: u }, KC)
  }
  const rawCust = await fetch(`${API}/customers`, { headers: { Authorization: `Bearer ${KC}` } }).then((r) => r.text())
  const oldRows = await sql`SELECT customer_ref, limit_units, used_units, created_at FROM customers WHERE account_id = ${C} ORDER BY created_at DESC, id DESC`
  const expectCust = JSON.stringify(oldRows.map((r) => ({ customerId: r.customerRef, limit: r.limitUnits, used: r.usedUnits,
    remaining: r.limitUnits == null ? null : r.limitUnits - r.usedUnits, isBlocked: r.limitUnits != null && r.usedUnits >= r.limitUnits, createdAt: r.createdAt })))
  const rawTasks = await fetch(`${API}/tasks?sort=used`, { headers: { Authorization: `Bearer ${KC}` } }).then((r) => r.json())
  const oldTaskOrder = (await sql`SELECT task_ref FROM task_budgets WHERE account_id = ${C} ORDER BY used_units DESC, created_at DESC`).map((r) => r.taskRef).join(',')
  ok('[usd] an account with no dollar job and no priced call: GET /customers is byte for byte the pre-T3 shape and values, and GET /tasks?sort=used keeps the pre-T3 order',
     oldRows.length === 3 && rawCust === expectCust && rawTasks.tasks.map((t) => t.task_ref).join(',') === oldTaskOrder && oldTaskOrder === 'old-j2,old-j1,old-j3'
       && !/usd|price/i.test(rawCust), `${rawCust.slice(0, 300)} | expected ${expectCust.slice(0, 300)} | ${oldTaskOrder}`)
  await sql`DELETE FROM accounts WHERE id = ${C}`

  // ---- ranking never compares numbers in different units
  const R = '00000000-0000-0000-0000-0000000000d4', KR = key('usd-r')
  await sql`DELETE FROM accounts WHERE id = ${R}`
  await sql`INSERT INTO accounts (id, plan, monthly_calls, billing_period_start) VALUES (${R}, 'scale', 0, date_trunc('month', CURRENT_DATE)::date)`
  await sql`INSERT INTO developer_api_keys (account_id, api_key, label) VALUES (${R}, ${KR}, 'harness-usd-rank')`
  const gpt4oOut = (output) => ({ provider: 'openai', model: 'gpt-4o', tokens: { input: 0, output } })
  // $0.50 on a dollar job (500,000 micro-dollars), $2.00 on a token job that
  // used 200,000 tokens, $0.30 on a $5 dollar job (300,000), a 400,000-token
  // job with no price, and a unit job at 9,999,999 of its own units.
  await call('PUT', '/tasks/rank-usd-050/ceiling', { ceiling_usd: 1 }, KR)
  await call('PUT', '/tasks/rank-usd-5/ceiling', { ceiling_usd: 5 }, KR)
  const steps = [
    ['rank-usd-050', {}, { metadata: gpt4o(200_000, 0) }],
    ['rank-tok-200', { task_ceiling: 1_000_000, unit: 'token', estimated_units: 1000 }, { units: 200_000, metadata: gpt4oOut(200_000) }],
    ['rank-usd-5', {}, { metadata: gpt4o(120_000, 0) }],
    ['rank-tok-400k', { task_ceiling: 1_000_000, unit: 'token', estimated_units: 1000 }, { units: 400_000 }],
    ['rank-unit-big', { task_ceiling: 20_000_000, estimated_units: 9_999_999 }, { units: 9_999_999 }],
  ]
  for (const [ref, pb, rb] of steps) {
    const p = await pre({ task_ref: ref, ...pb }, KR)
    await rec({ task_ref: ref, reservation_id: p.body.reservation_id, ...rb }, KR)
  }
  const WANT = 'rank-tok-200,rank-usd-050,rank-usd-5,rank-tok-400k,rank-unit-big'
  const RAW_ORDER = (await sql`SELECT task_ref FROM task_budgets WHERE account_id = ${R} ORDER BY used_units DESC`).map((r) => r.taskRef).join(',')
  const apiRank = await call('GET', '/tasks?sort=used', null, KR)
  ok('[usd] GET /tasks?sort=used: $2.00 before $0.50 though it counts fewer, the $0.30 job before 400,000 unpriced tokens, and the 9,999,999 units last, where raw numbers would put them first',
     apiRank.body?.tasks?.map((t) => t.task_ref).join(',') === WANT && RAW_ORDER === 'rank-unit-big,rank-usd-050,rank-tok-400k,rank-usd-5,rank-tok-200',
     `${apiRank.body?.tasks?.map((t) => `${t.task_ref}:${t.used_units}`).join(',')} raw ${RAW_ORDER}`)
  const mcpTop = async (sort) => {
    const r = await fetch(`${API}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${KR}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'top_jobs', arguments: { sort, limit: 10 } } }) })
    const t = await r.text()
    try { return JSON.parse(t.startsWith('{') ? t : (t.match(/^data: (.*)$/m) ?? [])[1]).result?.structuredContent } catch { return { raw: t.slice(0, 300) } }
  }
  const topU = await mcpTop('units'), topL = await mcpTop('list_price')
  const byRef = (o, ref) => (o?.jobs ?? []).find((j) => j.task_ref === ref) ?? {}
  ok('[usd] MCP top_jobs over a key ranks the same way on both sorts, and states the rule',
     (topU?.jobs ?? []).map((j) => j.task_ref).join(',') === WANT && (topL?.jobs ?? []).map((j) => j.task_ref).join(',') === WANT
       && /never compared/.test(topU.order ?? ''), JSON.stringify(topU).slice(0, 400))
  ok('[usd] and every job says in words what its numbers count, so an assistant cannot quote micro-dollars as units',
     byRef(topU, 'rank-usd-050').used === '$0.50 of $1.00 at list price' && /micro-dollars/.test(byRef(topU, 'rank-usd-050').units_count) && byRef(topU, 'rank-usd-050').rank_usd === 0.5
       && byRef(topU, 'rank-tok-200').used === '200,000 tokens of 1,000,000 tokens' && byRef(topU, 'rank-tok-200').rank_usd === 2
       && byRef(topU, 'rank-tok-400k').rank_usd === null && byRef(topU, 'rank-unit-big').used === '9,999,999 units of 20,000,000 units'
       && /not money/.test(byRef(topU, 'rank-unit-big').units_count), JSON.stringify((topU?.jobs ?? []).map((j) => [j.task_ref, j.used, j.rank_usd])))
  const loginR = await fetch(`${API}/app/session`, { method: 'POST', redirect: 'manual', headers: FORM, body: `api_key=${KR}` })
  const cookieR = (loginR.headers.get('set-cookie') ?? '').split(';')[0]
  const mostR = await fetch(`${API}/app?view=tasks&sort=used`, { headers: { cookie: cookieR } }).then((r) => r.text())
  const rowsR = [...mostR.matchAll(/<div class="tk-n"><a [^>]*>([^<]+)<\/a>/g)].map((m) => m[1]).join(',')
  ok('[usd] and the console\'s Most used lists them in the same order', rowsR === WANT, rowsR)
  await sql`DELETE FROM accounts WHERE id = ${R}`

  // ---- the legacy key's account is untouched by all of it
  const legacy = await fetch(`${API}/tasks?limit=200`, { headers: { Authorization: `Bearer ${legacyKey}` } }).then((r) => r.json())
  ok('[usd] the harness\'s main account lists none of these jobs', !(legacy.tasks ?? []).some((t) => String(t.task_ref).startsWith('usd-')), '')
  for (const id of [A, B]) await sql`DELETE FROM accounts WHERE id = ${id}`
}
