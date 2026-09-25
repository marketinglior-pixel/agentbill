// [spike] Spend spikes (M2, 2026-09-26): with SPIKE_ALERTS=on, an agent or a
// customer at 3x its average day (and at least $1, or 100 calls, with three
// active days of history) gets one mail per day to the account's owner, every
// pass after it adds nothing, and the account's webhook is attempted through
// the guarded sender. Run on a server of its own with the job on and a
// sub-second schedule; the mail is read from the test outbox.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'

const settle = (ms) => new Promise((r) => setTimeout(r, ms))

export async function spikeGates({ API, sql, ok, bootS, stopS, portS }) {
  console.log('\n[spike]')
  let reached = false
  const S = '00000000-0000-0000-0000-00000000511e', O = '00000000-0000-0000-0000-00000000511f'
  try {
    await gates({ API, sql, ok, bootS, stopS, portS, S, O })
    reached = true
  } catch (err) {
    ok('[spike] a gate threw', false, String(err?.stack ?? err).slice(0, 800))
  } finally {
    await sql`DELETE FROM accounts WHERE id IN (${S}, ${O})`
  }
  ok('[spike] every gate ran to the end', reached)
}

async function gates({ API, sql, ok, bootS, stopS, portS, S, O }) {
  const EMAIL = `spike-owner-${Date.now()}@example.invalid`
  await sql`DELETE FROM accounts WHERE id IN (${S}, ${O})`
  await sql`INSERT INTO accounts (id, plan, email, monthly_calls, billing_period_start, webhook_url, webhook_secret_nonce)
            VALUES (${S}, 'free', ${EMAIL}, 0, date_trunc('month', CURRENT_DATE)::date, 'http://127.0.0.1:9/hook', 'spike-gates-nonce')`
  await sql`INSERT INTO accounts (id, plan, monthly_calls, billing_period_start) VALUES (${O}, 'free', 0, date_trunc('month', CURRENT_DATE)::date)`
  const cust = async (acct, ref) => (await sql`INSERT INTO customers (account_id, customer_ref) VALUES (${acct}, ${ref}) RETURNING id`)[0].id
  const acme = await cust(S, 'acme'), globex = await cust(S, 'globex'), custU = await cust(S, 'cust-u'), theirs = await cust(O, 'their-client')
  // Today is the start of the UTC day plus a second, so a run near midnight
  // cannot put "today" in yesterday; day k of the baseline is its noon.
  const seed = (acct, c, agent, usd, calls, dayOffset) => sql`
    INSERT INTO events (account_id, customer_id, event_type, units, idempotency_key, metadata, list_price_usd, created_at)
    SELECT ${acct}, ${c}, ${agent}, 1, 'spike-' || md5(random()::text || g::text), '{}'::jsonb, ${usd},
           CASE WHEN ${dayOffset}::int = 0
                THEN date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' + interval '1 second'
                ELSE date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - (${dayOffset}::int || ' days')::interval + interval '12 hours' END
    FROM generate_series(1, ${calls}::int) g`
  // spiky: $0.50 a day on five days, $2.00 today: 5.6x and over $1. A spike, and acme with it.
  for (const d of [1, 2, 3, 4, 5]) await seed(S, acme, 'spiky', 0.5, 1, d)
  await seed(S, acme, 'spiky', 2.0, 1, 0)
  // steady: $1 a day for seven days, $1.50 today: 1.5x. Not a spike.
  for (const d of [1, 2, 3, 4, 5, 6, 7]) await seed(S, globex, 'steady', 1.0, 1, d)
  await seed(S, globex, 'steady', 1.5, 1, 0)
  // newbie: two days of history, 10x today: not enough of a usual to compare with.
  for (const d of [1, 2]) await seed(S, globex, 'newbie', 0.05, 1, d)
  await seed(S, globex, 'newbie', 0.5, 1, 0)
  // tiny: 35x, but twenty cents. Not news.
  for (const d of [1, 2, 3, 4]) await seed(S, globex, 'tiny', 0.01, 1, d)
  await seed(S, globex, 'tiny', 0.2, 1, 0)
  // unpriced: calls, not dollars. 20 a day on three days, 150 today: 17.5x and over 100.
  for (const d of [1, 2, 3]) await seed(S, custU, 'unpriced', null, 20, d)
  await seed(S, custU, 'unpriced', null, 150, 0)
  // Another account's spike, with no email: recorded, mailed to nobody.
  for (const d of [1, 2, 3]) await seed(O, theirs, 'their-agent', 0.5, 1, d)
  await seed(O, theirs, 'their-agent', 5.0, 1, 0)

  const main = await fetch(`${API}/privacy`).then((r) => r.text())
  ok('[spike] off by default: the harness server\'s /privacy lists no spike alert', !main.includes('three times its usual day'))

  const dir = mkdtempSync(`${tmpdir()}/spike-gates-`)
  const outbox = `${dir}/outbox.jsonl`
  writeFileSync(outbox, '')
  // A fake Resend that accepts every send, so mailUser reports it sent.
  const fake = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"id":"fake"}') }) })
  await new Promise((r) => fake.listen(0, '127.0.0.1', r))
  const test = await bootS({ NODE_ENV: 'test', DATABASE_SSL: 'disable', RATE_LIMIT_PER_MINUTE: '100000', MAIL_TEST_OUTBOX: outbox,
    RESEND_API_KEY: 're_fake_spike', RESEND_BASE_URL: `http://127.0.0.1:${fake.address().port}`,
    SPIKE_ALERTS: 'on', SPIKE_FIRST_RUN_MS: '200', SPIKE_EVERY_MS: '1000' }, portS)
  try {
    const mails = () => readFileSync(outbox, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.to === EMAIL)
    for (let i = 0; i < 80 && mails().length === 0; i++) await settle(100)
    const rows = async () => sql`SELECT account_id, scope, subject, metric, today_value::float AS today, daily_avg::float AS avg, emailed, webhook
                                 FROM spend_spike_alerts WHERE account_id IN (${S}, ${O}) ORDER BY account_id, scope, subject`
    await settle(300)
    const r1 = await rows()
    const mine = r1.filter((r) => r.accountId === S)
    const key = mine.map((r) => `${r.scope}:${r.subject}:${r.metric}`).join(' ')
    ok('[spike] exactly the four spikes: agent spiky and customer acme in dollars, agent unpriced and customer cust-u in calls; not steady, newbie or tiny',
       key === 'agent:spiky:usd agent:unpriced:calls customer:acme:usd customer:cust-u:calls', key)
    const spiky = mine.find((r) => r.subject === 'spiky')
    ok('[spike] measured as the rule says: spiky $2.00 today against $2.50 over seven days, $0.357 a day',
       Math.abs((spiky?.today ?? 0) - 2) < 1e-9 && Math.abs((spiky?.avg ?? 0) - 2.5 / 7) < 1e-9, JSON.stringify(spiky))
    const m = mails()
    const html = m[0]?.html ?? ''
    ok('[spike] one mail to the owner, naming all four with today and the average day, and saying nothing was stopped',
       m.length === 1 && m[0].reason === 'account' && /4 agents and customers/.test(m[0].subject)
         && /<code>spiky<\/code><\/b>:\s*\$2\.00 so far today/.test(html) && html.includes('150 calls so far today')
         && html.includes('Nothing was stopped') && !html.includes('steady') && !html.includes('newbie') && !html.includes('tiny'),
       JSON.stringify(m.map((x) => x.subject)))
    ok('[spike] every claim says it was mailed, and the webhook was attempted through the guarded sender, which refused a local address',
       mine.every((r) => r.emailed === true && /^not delivered: /.test(r.webhook ?? '')), JSON.stringify(mine.map((r) => [r.subject, r.emailed, r.webhook])))
    const theirsRow = r1.find((r) => r.accountId === O)
    ok('[spike] another account\'s spike is recorded against that account, with no mail to anybody', !!theirsRow && theirsRow.emailed === false && m.length === 1)

    await settle(2500)
    const r2 = await rows()
    ok('[spike] later passes on the same day add nothing: still one mail and the same rows',
       mails().length === 1 && r2.length === r1.length, `${mails().length} mails, ${r2.length} rows`)

    const pp = await fetch(`http://localhost:${portS}/privacy`).then((r) => r.text())
    ok('[spike] with SPIKE_ALERTS=on, /privacy lists the alert', pp.includes('three times its usual day, once per agent or customer per day'))

    const { spikePayload, spikesOn } = await import('../../dist/lib/spike.js')
    const p = JSON.parse(spikePayload({ accountId: S, scope: 'agent', subject: 'spiky', metric: 'usd', today: 2, dailyAvg: 0.5 }, '2026-09-26'))
    ok('[spike] the webhook event is spend.spike with the subject, the day, both figures and the multiple, and says it is an estimate',
       p.event === 'spend.spike' && p.subject === 'spiky' && p.day === '2026-09-26' && p.today === 2 && p.daily_average === 0.5 && p.multiple === 4
         && p.estimate === 'list price over priced calls' && spikesOn({}) === false && spikesOn({ SPIKE_ALERTS: 'on' }) === true, JSON.stringify(p))
  } finally {
    await stopS(test)
    fake.close()
  }
}
