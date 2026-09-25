// [dash] The overview's dashboard (M2, 2026-09-26): the cards read the
// account's own events and refusals, in the window asked for, with records
// stored before 2026-09-23 as a JSON string counted too, and nothing from any
// other account. Seeded straight into the tables the API writes, then read
// through a real key session on the running server.
import { insertKeyRow } from './key-fixture.mjs'
import { createHash, randomBytes } from 'node:crypto'

const shaped = (tag) => 'agb_' + createHash('sha256').update(`${tag}-${randomBytes(6).toString('hex')}`).digest('hex').slice(0, 48)
const visible = (h) => h.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<title>[\s\S]*?<\/title>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ')
const dashOf = (html) => visible(html.match(/<div class="dash">([\s\S]*?)<h2>Recent tasks/)?.[1] ?? '')

export async function dashGates({ API, sql, ok }) {
  console.log('\n[dash]')
  let reached = false
  const D = '00000000-0000-0000-0000-00000000da51', O = '00000000-0000-0000-0000-00000000da52'
  try {
    await gates({ API, sql, ok, D, O })
    reached = true
  } catch (err) {
    ok('[dash] a gate threw', false, String(err?.stack ?? err).slice(0, 800))
  } finally {
    await sql`DELETE FROM accounts WHERE id IN (${D}, ${O})`
  }
  ok('[dash] every gate ran to the end', reached)
}

async function gates({ API, sql, ok, D, O }) {
  const KD = shaped('dash')
  const NET = { 'fly-client-ip': '198.18.51.1' }
  await sql`DELETE FROM accounts WHERE id IN (${D}, ${O})`
  await sql`INSERT INTO accounts (id, plan, monthly_calls, billing_period_start) VALUES (${D}, 'free', 0, date_trunc('month', CURRENT_DATE)::date), (${O}, 'free', 0, date_trunc('month', CURRENT_DATE)::date)`
  await insertKeyRow(sql, D, KD, 'dash')
  const [acme] = await sql`INSERT INTO customers (account_id, customer_ref) VALUES (${D}, 'acme') RETURNING id`
  const [globex] = await sql`INSERT INTO customers (account_id, customer_ref) VALUES (${D}, 'globex') RETURNING id`
  const [theirs] = await sql`INSERT INTO customers (account_id, customer_ref) VALUES (${O}, 'someone-else') RETURNING id`
  // Written the two ways src/routes/events.ts has: today's ::text::jsonb (an
  // object), and before 2026-09-23 a bare parameter, which postgres.js
  // stringified a second time into a jsonb STRING holding the JSON text.
  const ev = (acct, cust, type, md, usd, ago, legacy = false) => legacy
    ? sql`INSERT INTO events (account_id, customer_id, event_type, units, idempotency_key, metadata, list_price_usd, created_at)
          VALUES (${acct}, ${cust}, ${type}, 1, ${'dash-' + randomBytes(6).toString('hex')}, ${md}::jsonb, ${usd}, now() - ${ago}::interval)`
    : sql`INSERT INTO events (account_id, customer_id, event_type, units, idempotency_key, metadata, list_price_usd, created_at)
          VALUES (${acct}, ${cust}, ${type}, 1, ${'dash-' + randomBytes(6).toString('hex')}, ${md}::text::jsonb, ${usd}, now() - ${ago}::interval)`
  const obj = (o) => JSON.stringify(o)
  await ev(D, acme.id, 'agent-a', obj({ model: 'claude-x', provider: 'anthropic', tokens: { input: 100, output: 50 }, duration_ms: 1200 }), 0.5, '5 minutes')
  await ev(D, globex.id, 'agent-b', obj({ model: 'gpt-y', provider: 'openai', tokens: { input: 40, output: 10 }, duration_ms: 800 }), 0.25, '2 days')
  // The shape records had before 2026-09-23: a JSON string whose text is the object.
  await ev(D, acme.id, 'agent-a', obj({ model: 'legacy-m', tokens: { input: 10, output: 5 } }), 0.1, '1 hour', true)
  // An old string that is not JSON text must not fail the page.
  await ev(D, acme.id, 'agent-a', 'not json at all', null, '3 hours', true)
  await ev(D, acme.id, '<img src=x onerror=alert(1)>', obj({ model: 'old-m' }), 1.0, '40 days')
  await ev(O, theirs.id, 'their-agent', obj({ model: 'their-model' }), 100, '1 hour')
  const dec = (acct, reason, agent, blocked, ago) => sql`
    INSERT INTO preflight_decisions (account_id, agent_id, reason, source, blocked, snapshot, created_at)
    VALUES (${acct}, ${agent}, ${reason}, 'preflight', ${blocked}, '{}'::json, now() - ${ago}::interval)`
  await dec(D, 'task_ceiling_exceeded', 'agent-a', true, '10 minutes')
  await dec(D, 'task_ceiling_exceeded', 'agent-a', true, '3 days')
  await dec(D, 'ceiling_exceeded', 'agent-b', true, '1 day')
  await dec(D, 'task_overrun_recorded', 'agent-a', false, '1 day')
  await dec(O, 'ceiling_exceeded', 'their-agent', true, '1 hour')

  const shapes = await sql`SELECT jsonb_typeof(metadata) AS t, count(*)::int AS n FROM events WHERE account_id = ${D} GROUP BY 1 ORDER BY 1`
  ok('[dash] the seed is the two shapes production holds: 3 objects (today) and 2 JSON strings (before 2026-09-23)',
     JSON.stringify(shapes) === JSON.stringify([{ t: 'object', n: 3 }, { t: 'string', n: 2 }]), JSON.stringify(shapes))

  const login = await fetch(`${API}/app/session`, { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin', ...NET }, body: `api_key=${KD}` })
  const ck = (login.headers.get('set-cookie') ?? '').split(';')[0]
  const page = async (q) => { const r = await fetch(`${API}/app${q}`, { headers: { cookie: ck, ...NET } }); return { status: r.status, html: await r.text() } }

  const m = await page('')
  const t = dashOf(m.html)
  ok('[dash] the default window (1M): cost is this account\'s priced calls in 30 days, legacy-string records included, $0.85',
     m.status === 200 && /Cost \$0\.85/.test(t), t.slice(0, 200))
  ok('[dash] calls, tokens and latency: 4 calls, 215 tokens (a legacy record\'s 15 among them), mean 1.00 s over the 2 timed calls',
     /Calls 4 /.test(t) && /Tokens 215 /.test(t) && t.includes('150 in · 65 out') && /Latency 1\.00 s per call/.test(t) && t.includes('Mean over 2 timed calls'), t)
  ok('[dash] refusals: 3 refused by reason (Job ceiling 2, Call ceiling 1) and the leak, none of the other account\'s',
     /Refusals .*3 refused/.test(t) && /Job ceiling 2/.test(t) && /Call ceiling 1/.test(t) && t.includes('1 ran past a ceiling after approval'), t)
  ok('[dash] top models by estimated cost: claude-x $0.50 first, then gpt-y, and the legacy record\'s model is named',
     /Top models claude-x \$0\.50/.test(t) && t.indexOf('gpt-y') > t.indexOf('claude-x') && t.includes('legacy-m') && !t.includes('old-m'), t)
  ok('[dash] top agents carry their refusals, and top customers their cost: agent-a $0.60 with 2 refused, acme $0.60',
     /agent-a \$0\.60 [^·]*3 calls · 2 refused/.test(t) && /Top customers .*acme \$0\.60/.test(t), t)
  ok('[dash] nothing from another account: no $100, no their-model, no their-agent, no someone-else',
     !t.includes('100') && !t.includes('their-') && !t.includes('someone-else'))

  const q = await page('?range=90d')
  const t90 = dashOf(q.html)
  ok('[dash] 3M reaches the 40-day-old record: $1.85, old-m named, and a hostile event_type is text, never markup',
     /Cost \$1\.85/.test(t90) && t90.includes('old-m') && !q.html.includes('<img src=x') && q.html.includes('&lt;img src=x onerror=alert(1)&gt;'), t90.slice(0, 200))

  const h = await page('?range=24h')
  const t24 = dashOf(h.html)
  const costSvg = h.html.match(/aria-label="Estimated cost per bucket">([\s\S]*?)<\/svg>/)?.[1] ?? ''
  ok('[dash] 24H is hourly: $0.60 (the 5-minute and 1-hour records), 24 bars, and the axis in UTC hours',
     /Cost \$0\.60/.test(t24) && (costSvg.match(/class="dc-bar"/g) ?? []).length === 24 && /\d\d:00 UTC/.test(t24), `${t24.slice(0, 160)} bars ${(costSvg.match(/class="dc-bar"/g) ?? []).length}`)
  ok('[dash] the period control is 24H 7D 1M 3M, with the window asked for marked current',
     /aria-current="true">24H</.test(h.html) && />7D</.test(h.html) && />1M</.test(h.html) && />3M</.test(h.html) && /aria-current="true">1M</.test(m.html))

  const demo = await fetch(`${API}/app?demo=1`).then((r) => r.text())
  const sections = (demo.match(/<section class="dc/g) ?? []).length
  const samples = (demo.match(/<section class="dc[\s\S]*?<\/header>/g) ?? []).filter((x) => x.includes('>sample<')).length
  ok('[dash] the sample console draws the dashboard, priced, and every one of its cards says sample',
     demo.includes('class="dash"') && sections >= 8 && samples === sections && /Cost sample \$\d/.test(dashOf(demo)), `${sections} cards, ${samples} tagged`)
}
