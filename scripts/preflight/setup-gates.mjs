// [setup] The setup guide (2026-09-26): six steps across the console, each
// done by the account's own rows and never by a click, walked here on a fresh
// account one row at a time; the office step is the one visit it records;
// hiding it is a same-origin POST and it stays hidden; the sample console
// never draws it.
import { insertKeyRow } from './key-fixture.mjs'
import { createHash, randomBytes } from 'node:crypto'

const shaped = (tag) => 'agb_' + createHash('sha256').update(`${tag}-${randomBytes(6).toString('hex')}`).digest('hex').slice(0, 48)
const visible = (h) => h.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ')

export async function setupGates({ API, sql, ok }) {
  console.log('\n[setup]')
  let reached = false
  const A = '00000000-0000-0000-0000-00000000a5e1', B = '00000000-0000-0000-0000-00000000a5e2', C = '00000000-0000-0000-0000-00000000a5e3'
  const U = '00000000-0000-0000-0000-00000000a5e4'
  try {
    await gates({ API, sql, ok, A, B, C, U })
    reached = true
  } catch (err) {
    ok('[setup] a gate threw', false, String(err?.stack ?? err).slice(0, 800))
  } finally {
    await sql`DELETE FROM accounts WHERE id IN (${A}, ${B}, ${C})`
    await sql`DELETE FROM oauth_clients WHERE client_id = 'setup-gates-client'`
    await sql`DELETE FROM users WHERE id = ${U}`
  }
  ok('[setup] every gate ran to the end', reached)
}

async function gates({ API, sql, ok, A, B, C, U }) {
  await sql`DELETE FROM accounts WHERE id IN (${A}, ${B}, ${C})`
  for (const id of [A, B, C]) await sql`INSERT INTO accounts (id, plan, monthly_calls, billing_period_start) VALUES (${id}, 'free', 0, date_trunc('month', CURRENT_DATE)::date)`
  const KA = shaped('setup-a'), KB = shaped('setup-b')
  await insertKeyRow(sql, A, KA, 'setup')
  await insertKeyRow(sql, B, KB, 'setup')
  const login = async (key, net) => (await fetch(`${API}/app/session`, { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin', 'fly-client-ip': net }, body: `api_key=${key}` }))
    .headers.get('set-cookie')?.split(';')[0] ?? ''
  const ckA = await login(KA, '198.18.54.1')
  const page = (ck, q) => fetch(`${API}/app${q}`, { headers: { cookie: ck, 'fly-client-ip': '198.18.54.1' } }).then((r) => r.text())
  const bar = (h) => visible(h.match(/<section class="su cv-callout"[\s\S]*?<\/section>/)?.[0] ?? '')
  const [def] = await sql`INSERT INTO customers (account_id, customer_ref) VALUES (${A}, 'default') RETURNING id`
  const [acme] = await sql`INSERT INTO customers (account_id, customer_ref) VALUES (${A}, 'acme') RETURNING id`
  const ev = (cust, usd) => sql`INSERT INTO events (account_id, customer_id, event_type, units, idempotency_key, metadata, list_price_usd)
    VALUES (${A}, ${cust}, 'setup-agent', 1, ${'su-' + randomBytes(6).toString('hex')}, '{}'::jsonb, ${usd})`

  // Step 1 is the key itself.
  let b = bar(await page(ckA, ''))
  ok('[setup] a new account with a key: 1 of 6, Connect ticked, and the next step named with a link to where it is done',
     /Setup 1 of 6 done/.test(b) && /✓ Connect/.test(b) && /Next: Your first priced call/.test(b), b)
  // An unpriced record is not the priced first call.
  await ev(def.id, null)
  b = bar(await page(ckA, '?view=start'))
  ok('[setup] a record with no list price does not tick the first priced call; on its screen the step says what to do',
     /Setup 1 of 6 done/.test(b) && /Step 2: Your first priced call\. Make one model call/.test(b), b)
  await ev(def.id, 0.01)
  b = bar(await page(ckA, '?view=customers'))
  ok('[setup] a priced call ticks step 2; on the customers view step 3 says how to pass customer_id from Python, Node and MCP',
     /Setup 2 of 6 done/.test(b) && /Step 3: Name your customers/.test(b) && b.includes('wrap(client, customer_id="acme")') && b.includes("customerId: 'acme'"), b)
  await ev(acme.id, 0.01)
  b = bar(await page(ckA, '?view=tasks'))
  ok('[setup] a call for a customer other than default ticks step 3; the tasks view shows step 4', /Setup 3 of 6 done/.test(b) && /Step 4: Give a job a ceiling/.test(b), b)
  await sql`INSERT INTO task_budgets (account_id, agent_id, task_ref, ceiling_units, unit) VALUES (${A}, 'setup-agent', 'first-ceiling', 1000000, 'usd')`
  b = bar(await page(ckA, '?view=refusals'))
  ok('[setup] a job with a ceiling ticks step 4; the refusals view shows step 5, with the one-line way to see a refusal on purpose',
     /Setup 4 of 6 done/.test(b) && /Step 5: See a refusal/.test(b) && b.includes('task_ceiling_usd=0.000001'), b)
  await sql`INSERT INTO preflight_decisions (account_id, agent_id, reason, source, blocked, snapshot) VALUES (${A}, 'setup-agent', 'task_ceiling_exceeded', 'preflight', true, '{}'::json)`
  const office = await page(ckA, '?view=office')
  b = bar(office)
  const [seen] = await sql`SELECT setup_office_seen_at IS NOT NULL AS seen FROM accounts WHERE id = ${A}`
  ok('[setup] a refusal ticks step 5; the first visit to the office shows the last step and records it', /Setup 5 of 6 done/.test(b) && /Step 6: Meet the office/.test(b) && seen.seen === true, b)
  const after = await page(ckA, '')
  ok('[setup] with all six done the guide is gone from every view', !after.includes('class="su cv-callout"') && !(await page(ckA, '?view=tasks')).includes('class="su cv-callout"'))

  // Hiding it.
  const ckB = await login(KB, '198.18.54.2')
  const cross = await fetch(`${API}/app/setup/hide`, { method: 'POST', redirect: 'manual', headers: { cookie: ckB, 'Sec-Fetch-Site': 'cross-site' } })
  const stillB = (await page(ckB, '')).includes('class="su cv-callout"')
  const hide = await fetch(`${API}/app/setup/hide`, { method: 'POST', redirect: 'manual', headers: { cookie: ckB, 'Sec-Fetch-Site': 'same-origin' } })
  const goneB = !(await page(ckB, '')).includes('class="su cv-callout"')
  const [hb] = await sql`SELECT setup_hidden_at IS NOT NULL AS hidden FROM accounts WHERE id = ${B}`
  ok('[setup] Hide the guide: a cross-site POST is 403 and changes nothing; a same-origin one hides it for good',
     cross.status === 403 && stillB && hide.status === 303 && goneB && hb.hidden === true, `${cross.status} ${stillB} ${hide.status} ${goneB}`)

  // An MCP grant connects an account that has no key.
  await sql`INSERT INTO users (id, email, email_verified_at) VALUES (${U}, ${'setup-mcp-' + Date.now() + '@example.invalid'}, now())`
  await sql`INSERT INTO oauth_clients (client_id, kind, redirect_uris, scope) VALUES ('setup-gates-client', 'dcr', ARRAY['https://client.example/cb'], 'mcp')`
  await sql`INSERT INTO oauth_grants (client_id, user_id, account_id, scope, resource, redirect_host) VALUES ('setup-gates-client', ${U}, ${C}, 'mcp', 'https://agentbill.dev/mcp', 'client.example')`
  const { loadSetup } = await import('../../dist/lib/setup.js')
  const sc = await loadSetup(C)
  ok('[setup] an account connected over MCP, with no key, has Connect ticked', sc.done.connect === true && sc.count === 1 && sc.next === 'first_call', JSON.stringify(sc))

  const demo = await fetch(`${API}/app?demo=1`).then((r) => r.text())
  ok('[setup] the sample console never draws the guide', !demo.includes('class="su cv-callout"'))
}
