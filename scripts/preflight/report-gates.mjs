// [report] The Agents view and the monthly customer report (M2, 2026-09-26):
// both read the signed-in account's own rows, the month is a UTC calendar
// month, the CSV cannot be read as a formula by a spreadsheet, and nothing is
// served without a session except the labelled sample.
import { insertKeyRow } from './key-fixture.mjs'
import { createHash, randomBytes } from 'node:crypto'

const shaped = (tag) => 'agb_' + createHash('sha256').update(`${tag}-${randomBytes(6).toString('hex')}`).digest('hex').slice(0, 48)
const visible = (h) => h.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<title>[\s\S]*?<\/title>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ')

export async function reportGates({ API, sql, ok }) {
  console.log('\n[report]')
  let reached = false
  const R = '00000000-0000-0000-0000-00000000de91', O = '00000000-0000-0000-0000-00000000de92'
  try {
    await gates({ API, sql, ok, R, O })
    reached = true
  } catch (err) {
    ok('[report] a gate threw', false, String(err?.stack ?? err).slice(0, 800))
  } finally {
    await sql`DELETE FROM accounts WHERE id IN (${R}, ${O})`
  }
  ok('[report] every gate ran to the end', reached)
}

async function gates({ API, sql, ok, R, O }) {
  const KR = shaped('report')
  const NET = { 'fly-client-ip': '198.18.52.1' }
  await sql`DELETE FROM accounts WHERE id IN (${R}, ${O})`
  await sql`INSERT INTO accounts (id, plan, monthly_calls, billing_period_start) VALUES (${R}, 'free', 0, date_trunc('month', CURRENT_DATE)::date), (${O}, 'free', 0, date_trunc('month', CURRENT_DATE)::date)`
  await insertKeyRow(sql, R, KR, 'report')
  const cust = async (acct, ref) => (await sql`INSERT INTO customers (account_id, customer_ref) VALUES (${acct}, ${ref}) RETURNING id`)[0].id
  const acme = await cust(R, 'acme'), globex = await cust(R, 'globex'), evil = await cust(R, '=HYPERLINK("http://evil.example","x")'), theirs = await cust(O, 'their-client')
  const now = new Date()
  const prevMonthDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 2, 12))
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
  const prev = `${prevMonthDay.getUTCFullYear()}-${String(prevMonthDay.getUTCMonth() + 1).padStart(2, '0')}`
  const ev = (acct, c, type, md, usd, at) => sql`
    INSERT INTO events (account_id, customer_id, event_type, units, idempotency_key, metadata, list_price_usd, created_at)
    VALUES (${acct}, ${c}, ${type}, 1, ${'rep-' + randomBytes(6).toString('hex')}, ${JSON.stringify(md)}::text::jsonb, ${usd}, ${at})`
  const recent = new Date(now.getTime() - 60_000)
  await ev(R, acme, 'triage', { model: 'claude-x', tokens: { input: 100, output: 20 }, duration_ms: 500 }, 0.4, recent)
  await ev(R, acme, 'triage', { model: 'claude-x', tokens: { input: 50, output: 10 }, duration_ms: 1500 }, 0.2, recent)
  await ev(R, acme, 'writer', { model: 'gpt-y', tokens: { input: 10, output: 5 } }, 0.05, recent)
  await ev(R, globex, 'writer', { model: 'gpt-y' }, null, recent)
  await ev(R, evil, '<script>x</script>', { model: 'm' }, 0.01, recent)
  // Last month, under its own agent, so a 30-day window that reaches into last
  // month on the 1st cannot move the agents rows below.
  await ev(R, acme, 'archived', { model: 'claude-x' }, 9.0, prevMonthDay)
  // An agent first seen 60 days ago is not new in a 30-day window; triage is.
  await ev(R, acme, 'veteran', { model: 'old' }, 0.02, new Date(now.getTime() - 60 * 86_400_000))
  await ev(R, acme, 'veteran', { model: 'old' }, 0.03, recent)
  await ev(O, theirs, 'their-agent', { model: 'theirs' }, 50, recent)
  await sql`INSERT INTO preflight_decisions (account_id, agent_id, reason, source, blocked, snapshot) VALUES (${R}, 'triage', 'task_ceiling_exceeded', 'preflight', true, '{}'::json)`

  const login = await fetch(`${API}/app/session`, { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin', ...NET }, body: `api_key=${KR}` })
  const ck = (login.headers.get('set-cookie') ?? '').split(';')[0]
  const get = (path, withCookie = true) => fetch(`${API}${path}`, { redirect: 'manual', headers: withCookie ? { cookie: ck, ...NET } : NET })

  // ------------------------------------------------------------ agents
  const ag = await get('/app?view=agents').then((r) => r.text())
  const agT = visible(ag.match(/<table class="cv-table cards">([\s\S]*?)<\/table>/)?.[1] ?? '')
  ok('[report] the agents view: each agent with its est. cost, calls, tokens, mean latency and refusals, dearest first',
     /triage new \$0\.60 2 180 1\.00 s 1 /.test(agT) && agT.indexOf('triage') < agT.indexOf('writer'), agT)
  ok('[report] "new" is all-time: an agent first seen 60 days ago is not new; its refusals link to the refusals view for it',
     /veteran \$0\.03 1 /.test(agT) && !/veteran new/.test(agT) && ag.includes('href="/app?view=refusals&amp;agent=triage"'), agT)
  ok('[report] an agent named in markup is text, and no other account\'s agent is listed',
     ag.includes('&lt;script&gt;x&lt;/script&gt;') && !ag.includes('<script>x') && !ag.includes('their-agent'))
  const agFoot = visible(ag.match(/<div class="foot">([\s\S]*?)<\/div>/)?.[1] ?? '').trim()
  ok('[report] and its footer says latency, first and last seen are worked out on the page, not served by the API',
     agFoot.startsWith('Every number on this page is on the API too, except this view\'s latency, first seen and last seen, which this page works out from those same records'), agFoot.slice(0, 200))

  // ------------------------------------------------------------ the month on the customers view
  const cu = await get('/app?view=customers').then((r) => r.text())
  const block = visible(cu.slice(cu.indexOf('<h2>'), cu.indexOf('<h2>Balances')))
  ok('[report] the customers view opens on this UTC month: acme $0.68 over 4 calls, globex unpriced, a total, and nothing from last month or another account',
     /acme \$0\.68 4 /.test(block) && /globex no price 1 /.test(block) && /Total \$0\.69 6/.test(block) && !block.includes('9.0') && !block.includes('their-client'), block.slice(0, 400))
  ok('[report] with a CSV and a printable report for the month, and a report link per customer',
     cu.includes(`href="/app/report.csv?month=${month}"`) && cu.includes(`href="/app/report?month=${month}"`) && cu.includes(`href="/app/report?month=${month}&amp;customer=acme"`))
  const cuPrev = await get(`/app?view=customers&month=${prev}`).then((r) => r.text())
  const blockPrev = visible(cuPrev.slice(cuPrev.indexOf('<h2>'), cuPrev.indexOf('<h2>Balances')))
  ok('[report] ?month= the previous month: acme $9.00 only', /acme \$9\.00 1 /.test(blockPrev) && !blockPrev.includes('globex'), blockPrev.slice(0, 300))
  const bad = await get('/app?view=customers&month=2025-13')
  const badT = await bad.text()
  ok('[report] a month that is not one falls back to this month, never a 500', bad.status === 200 && /acme \$0\.68/.test(visible(badT)))

  // ------------------------------------------------------------ the CSV
  const csvR = await get(`/app/report.csv?month=${month}`)
  const csv = await csvR.text()
  const lines = csv.trim().split('\r\n')
  ok('[report] the CSV: text/csv, an attachment named for the month, one line per customer, agent and model, and a total per customer',
     csvR.status === 200 && /^text\/csv/.test(csvR.headers.get('content-type') ?? '') && csvR.headers.get('content-disposition') === `attachment; filename="agentbill-report-${month}.csv"`
       && lines[0] === '"month","customer_id","agent","model","calls","priced_calls","unpriced_calls","tokens_in","tokens_out","list_price_usd_estimate"'
       && lines.includes(`"${month}","acme","triage","claude-x","2","2","0","150","30","0.600000"`)
       && lines.includes(`"${month}","acme","(customer total)","","4","4","0","160","35","0.680000"`)
       && lines.includes(`"${month}","globex","writer","gpt-y","1","0","1","0","0",""`), csv.slice(0, 600))
  ok('[report] a customer_id a spreadsheet would run as a formula is written as text (CWE-1236)',
     csv.includes(`"'=HYPERLINK(""http://evil.example"",""x"")"`) && !/(^|,)"=HYPERLINK/m.test(csv), csv.split('\r\n').find((l) => l.includes('HYPERLINK')))
  ok('[report] the CSV holds no other account\'s rows and no other month\'s', !csv.includes('their-') && !csv.includes('9.000000'))

  // ------------------------------------------------------------ the printable report
  const one = await get(`/app/report?month=${month}&customer=acme`).then((r) => r.text())
  const oneT = visible(one)
  ok('[report] the printable report for one customer: only that customer, its lines, the estimate label, and no page script',
     oneT.includes('Usage report') && /acme \$0\.68/.test(oneT) && oneT.includes('claude-x') && !oneT.includes('globex') && oneT.includes('An estimate at public list price') && !/<script/i.test(one), oneT.slice(0, 300))

  // ------------------------------------------------------------ without a session
  const anonCsv = await get(`/app/report.csv?month=${month}`, false)
  const anonPage = await get(`/app/report?month=${month}`, false)
  ok('[report] without a session neither the CSV nor the report serves a byte of data: both send you to the console',
     anonCsv.status === 303 && anonCsv.headers.get('location') === `/app?view=customers&month=${month}` && anonPage.status === 303
       && !(await anonCsv.text()).includes('acme'))
  const sampleCsv = await get(`/app/report.csv?demo=1&month=${month}`, false)
  ok('[report] the sample CSV is served to anyone, named as a sample', sampleCsv.status === 200 && (sampleCsv.headers.get('content-disposition') ?? '').includes('sample-report'))
}
