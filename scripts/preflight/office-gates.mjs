// [office] The office (M3, 2026-09-26): the room is the account's own agents,
// each in the one state its rows say (a spike, a refusal, a first call, a
// recent call, or none), with its salary exactly this month's list-price
// estimate; the engine is the only script, served from this origin to the
// office view alone, and it cannot invent a number or run anything the data
// block smuggles in.
import { insertKeyRow } from './key-fixture.mjs'
import { createHash, randomBytes } from 'node:crypto'

const shaped = (tag) => 'agb_' + createHash('sha256').update(`${tag}-${randomBytes(6).toString('hex')}`).digest('hex').slice(0, 48)

export async function officeGates({ API, sql, ok }) {
  console.log('\n[office]')
  let reached = false
  const F = '00000000-0000-0000-0000-0000000000f1', O = '00000000-0000-0000-0000-0000000000f2'
  try {
    await gates({ API, sql, ok, F, O })
    reached = true
  } catch (err) {
    ok('[office] a gate threw', false, String(err?.stack ?? err).slice(0, 800))
  } finally {
    await sql`DELETE FROM accounts WHERE id IN (${F}, ${O})`
  }
  ok('[office] every gate ran to the end', reached)
}

async function gates({ API, sql, ok, F, O }) {
  const KF = shaped('office')
  const NET = { 'fly-client-ip': '198.18.53.1' }
  await sql`DELETE FROM accounts WHERE id IN (${F}, ${O})`
  await sql`INSERT INTO accounts (id, plan, monthly_calls, billing_period_start) VALUES (${F}, 'free', 0, date_trunc('month', CURRENT_DATE)::date), (${O}, 'free', 0, date_trunc('month', CURRENT_DATE)::date)`
  await insertKeyRow(sql, F, KF, 'office')
  const [c] = await sql`INSERT INTO customers (account_id, customer_ref) VALUES (${F}, 'c') RETURNING id`
  const [oc] = await sql`INSERT INTO customers (account_id, customer_ref) VALUES (${O}, 'oc') RETURNING id`
  const monthStart = sql`date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`
  const ev = (acct, cust, agent, usd, at) => sql`
    INSERT INTO events (account_id, customer_id, event_type, units, idempotency_key, metadata, list_price_usd, created_at)
    VALUES (${acct}, ${cust}, ${agent}, 1, ${'off-' + randomBytes(6).toString('hex')}, '{}'::jsonb, ${usd}, ${at})`
  // Every "this month" row sits at the start of the month plus a minute, or a
  // minute ago, whichever the case needs; "first seen" rows go back 40 days.
  await sql`INSERT INTO events (account_id, customer_id, event_type, units, idempotency_key, metadata, list_price_usd, created_at)
            VALUES (${F}, ${c.id}, 'worker', 1, ${'off-' + randomBytes(6).toString('hex')}, '{}'::jsonb, 1.0, now() - interval '1 minute'),
                   (${F}, ${c.id}, 'worker', 1, ${'off-' + randomBytes(6).toString('hex')}, '{}'::jsonb, 0.25, now() - interval '40 days')`
  await ev(F, c.id, 'idler', 0.5, new Date(Date.now() - 2 * 3_600_000))
  await ev(F, c.id, 'idler', 0.1, new Date(Date.now() - 40 * 86_400_000))
  await ev(F, c.id, 'homebound', 0.3, new Date(Date.now() - 3 * 3_600_000))
  await ev(F, c.id, 'homebound', 0.1, new Date(Date.now() - 40 * 86_400_000))
  await ev(F, c.id, 'rookie', 0.2, new Date(Date.now() - 3_600_000))
  await ev(F, c.id, 'panicky', 2.0, new Date(Date.now() - 5 * 3_600_000))
  await ev(F, c.id, 'panicky', 0.1, new Date(Date.now() - 40 * 86_400_000))
  await ev(F, c.id, 'unpriced-agent', null, new Date(Date.now() - 4 * 3_600_000))
  await ev(F, c.id, 'unpriced-agent', null, new Date(Date.now() - 40 * 86_400_000))
  await ev(F, c.id, '</script><script>alert(1)</script>', 0.01, new Date(Date.now() - 6 * 3_600_000))
  await sql`INSERT INTO events (account_id, customer_id, event_type, units, idempotency_key, metadata, list_price_usd, created_at)
            VALUES (${F}, ${c.id}, 'lastmonth', 1, ${'off-' + randomBytes(6).toString('hex')}, '{}'::jsonb, 5.0, ${monthStart} - interval '2 days')`
  await ev(O, oc.id, 'their-agent', 50, new Date(Date.now() - 60_000))
  await sql`INSERT INTO preflight_decisions (account_id, agent_id, reason, source, blocked, snapshot) VALUES (${F}, 'homebound', 'task_ceiling_exceeded', 'preflight', true, '{}'::json)`
  // A refusal that is not a ceiling does not send anyone home.
  await sql`INSERT INTO preflight_decisions (account_id, agent_id, reason, source, blocked, snapshot) VALUES (${F}, 'idler', 'free_tier_exceeded', 'preflight', true, '{}'::json)`
  await sql`INSERT INTO spend_spike_alerts (account_id, scope, subject, day, metric, today_value, daily_avg) VALUES (${F}, 'agent', 'panicky', (now() AT TIME ZONE 'UTC')::date, 'usd', 2, 0.2)`

  const login = await fetch(`${API}/app/session`, { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin', ...NET }, body: `api_key=${KF}` })
  const ck = (login.headers.get('set-cookie') ?? '').split(';')[0]
  const get = (path) => fetch(`${API}${path}`, { headers: { cookie: ck, ...NET } })

  const r = await get('/app?view=office')
  const html = await r.text()
  const block = html.match(/<script type="application\/json" id="office-data">([\s\S]*?)<\/script>/)?.[1] ?? ''
  let data = null
  try { data = JSON.parse(block) } catch { /* reported below */ }
  const by = Object.fromEntries((data?.agents ?? []).map((a) => [a.name, a]))
  const states = ['worker', 'idler', 'homebound', 'rookie', 'panicky'].map((n) => `${n}:${by[n]?.state}`).join(' ')
  ok('[office] each agent is in the state its rows say: working (a call a minute ago), idle, sent (a ceiling refused it), new (first call today), panic (a spike today)',
     states === 'worker:working idler:idle homebound:sent rookie:new panicky:panic', states)
  ok('[office] a refusal that is not a ceiling sends nobody home, and an agent with nothing this month is not on staff, nor is another account\'s',
     by.idler?.state === 'idle' && !by.lastmonth && !by['their-agent'] && data?.sample === false, JSON.stringify(Object.keys(by)))
  ok('[office] a salary is exactly this month\'s estimate (worker $1, not the $1.25 of all time), and unpriced is null, never $0',
     by.worker?.sal === 1 && by.homebound?.sal === 0.3 && by['unpriced-agent']?.sal === null, JSON.stringify(by.worker) + JSON.stringify(by['unpriced-agent']))
  const cards = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  ok('[office] the cards: payroll $4.01 (priced agents this month), 7 on staff, 1 at their desk, 1 sent home',
     /Payroll this month \$4\.01/.test(cards) && /Agents on staff 7 /.test(cards) && /At their desk 1 /.test(cards) && /Sent home today 1 /.test(cards), cards.slice(cards.indexOf('Payroll'), cards.indexOf('Payroll') + 160))
  ok('[office] a name that closes the script tag is escaped inside the data block, and parses back to itself',
     !block.includes('</script>') && block.includes('\\u003c/script\\u003e') && !!by['</script><script>alert(1)</script>'])
  const csp = r.headers.get('content-security-policy') ?? ''
  const other = (await get('/app?view=agents')).headers.get('content-security-policy') ?? ''
  ok('[office] only the office view may run a script, and only from this origin: script-src \'self\', never unsafe-inline, no connect-src',
     /script-src 'self'(;|$)/.test(csp) && !csp.includes('unsafe-inline\'; script') && !/script-src[^;]*unsafe/.test(csp) && !csp.includes('connect-src') && !other.includes('script-src'), `${csp} | ${other}`)
  ok('[office] the page loads exactly one script, /app/office.js, and no inline one',
     (html.match(/<script(?![^>]*type="application\/json")[^>]*>/g) ?? []).join('') === '<script src="/app/office.js" defer>')

  const js = await fetch(`${API}/app/office.js`)
  const jsText = await js.text()
  ok('[office] /app/office.js is served as JavaScript, reads the data block, and has no Hire or Spike button of its own',
     js.status === 200 && /javascript/.test(js.headers.get('content-type') ?? '') && jsText.includes("getElementById('office-data')") && !/Hire an agent|Trigger a spike/.test(jsText))
  ok('[office] and it never changes a salary: no assignment to .sal anywhere in the engine',
     !/\.sal\s*(\+|-|\*)?=[^=]/.test(jsText), (jsText.match(/.{30}\.sal\s*(\+|-|\*)?=.{20}/) ?? [''])[0])
  // The payroll card (M3, 2026-09-26): drawn in the browser and never sent.
  ok('[office] the payroll card is made in the browser: the engine draws it with canvas and has no way to send it (no fetch, XHR, beacon, socket or form)',
     jsText.includes('makeCard') && jsText.includes('toBlob') && jsText.includes('made with AgentBill')
       && !/fetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|\.submit\(|navigator\.share/.test(jsText))
  const s = data?.summary ?? {}
  ok('[office] and it prints the same figures as the cards above the room: payroll $4.01, 7 on staff, 1 at a desk, 1 sent home, the highest paid named with its index',
     s.payroll === 4.01 && s.staff === 7 && s.atDesk === 1 && s.sentHome === 1 && s.top?.name === 'panicky' && s.top?.sal === 2 && typeof s.top?.idx === 'number'
       && data.agents[s.top.idx]?.name === 'panicky' && /^\d{4}-\d{2}$/.test(s.month ?? ''), JSON.stringify(s))
  ok('[office] the page offers the card, the choice to hide agent names on it, and a download named for the month, and says nothing is uploaded',
     html.includes('id="office-card"') && html.includes('id="office-card-anon"') && new RegExp(`download="agentbill-payroll-${s.month}\\.png"`).test(html)
       && html.includes('nothing is uploaded or posted'))
  const png = await fetch(`${API}/app/office-sprites.png`)
  const buf = Buffer.from(await png.arrayBuffer())
  ok('[office] the sprite sheet is round 3\'s sheet_1x.png, byte for byte',
     png.status === 200 && png.headers.get('content-type') === 'image/png'
       && createHash('sha256').update(buf).digest('hex') === 'b700a75dfd7dd83c460230b588abc44296e8d6e07f3f7e3c8db89e8570f8f4de')

  const demo = await fetch(`${API}/app?demo=1&view=office`).then((x) => x.text())
  const demoData = JSON.parse(demo.match(/id="office-data">([\s\S]*?)<\/script>/)?.[1] ?? '{}')
  ok('[office] the sample office is labelled: its data says sample, and its frame carries the SAMPLE tag',
     demoData.sample === true && demo.includes('>sample<') && (demoData.agents ?? []).length >= 5)
}
