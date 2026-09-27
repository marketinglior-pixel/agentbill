// [rejections] The preflights answered 422, counted (2026-09-27, migration
// 036). The count is what tests the suspect "a new job sent without a ceiling
// is why a key never becomes a first call", so each gate here reads it back
// from the table: one row per account, reason and day; a repeat adds to n; a
// 200 adds nothing; nothing of the request is kept; the stuck account is told
// apart from one that later recorded a call; and counting that fails never
// changes the answer the caller gets.
import { insertKeyRow } from './key-fixture.mjs'
import { createHash, randomBytes } from 'node:crypto'

const shaped = (tag) => 'agb_' + createHash('sha256').update(`${tag}-${randomBytes(6).toString('hex')}`).digest('hex').slice(0, 48)

export async function rejectionGates({ API, sql, ok, adminCookie }) {
  console.log('\n[rejections]')
  let reached = false
  const A = '00000000-0000-0000-0000-00000000c422'
  try {
    await gates({ API, sql, ok, adminCookie, A })
    reached = true
  } catch (err) {
    ok('[rejections] a gate threw', false, String(err?.stack ?? err).slice(0, 800))
  } finally {
    await sql`ALTER TABLE IF EXISTS preflight_rejections_hidden RENAME TO preflight_rejections`.catch(() => {})
    await sql`DELETE FROM accounts WHERE id = ${A}`
  }
  ok('[rejections] every gate ran to the end', reached)
}

async function gates({ API, sql, ok, adminCookie, A }) {
  await sql`DELETE FROM accounts WHERE id = ${A}`
  await sql`INSERT INTO accounts (id, plan, monthly_calls, billing_period_start) VALUES (${A}, 'free', 0, date_trunc('month', CURRENT_DATE)::date)`
  const KEY = shaped('rejections')
  await insertKeyRow(sql, A, KEY, 'rejections')
  const pre = (body) => fetch(`${API}/preflight`, { method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'fly-client-ip': '198.18.56.1' }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
  const rows = () => sql`SELECT reason, n, day FROM preflight_rejections WHERE account_id = ${A} ORDER BY reason`
  const nOf = async (reason) => ((await rows()).find((r) => r.reason === reason)?.n ?? 0)

  // A new job with no ceiling: the 422 the suspect is about.
  const TREF = 'rej-' + randomBytes(4).toString('hex')
  const first = await pre({ agent_id: 'rej-agent', estimated_units: 5, task_ref: TREF })
  const r1 = await rows()
  ok('[rejections] a new job sent with no ceiling is 422 task_ceiling_required, and one row counts it for this account, today, n=1',
     first.status === 422 && first.body?.error === 'task_ceiling_required' && r1.length === 1 && r1[0].reason === 'task_ceiling_required' && r1[0].n === 1,
     `${first.status} ${JSON.stringify(r1)}`)
  await pre({ agent_id: 'rej-agent', estimated_units: 5, task_ref: TREF })
  ok('[rejections] the same 422 again adds to that row, n=2, and makes no second row', (await rows()).length === 1 && (await nOf('task_ceiling_required')) === 2)

  // An answered preflight is not a rejection.
  const opened = await pre({ agent_id: 'rej-agent', estimated_units: 5, task_ref: TREF, task_ceiling: 1000 })
  ok('[rejections] a preflight that opens the job with a ceiling is a 200 and counts nothing',
     opened.status === 200 && opened.body?.approved === true && (await rows()).length === 1 && (await nOf('task_ceiling_required')) === 2,
     `${opened.status} ${JSON.stringify(await rows())}`)

  // The other 422s are counted under their own reasons.
  const mismatch = await pre({ agent_id: 'rej-agent', estimated_units: 5, task_ref: TREF, unit: 'token' })
  const bad = await pre({ agent_id: 'rej-agent', estimated_units: -5, task_ref: TREF })
  ok('[rejections] a unit that is not the job\'s and a body that does not parse are counted as task_unit_mismatch and validation_error',
     mismatch.status === 422 && mismatch.body?.error === 'task_unit_mismatch' && (await nOf('task_unit_mismatch')) === 1
       && bad.status === 422 && bad.body?.error === 'validation_error' && (await nOf('validation_error')) === 1,
     `${mismatch.status}/${mismatch.body?.error} ${bad.status}/${bad.body?.error}`)

  // Nothing of the request is kept.
  const cols = (await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'preflight_rejections' ORDER BY column_name`).map((c) => c.columnName ?? c.column_name)
  ok('[rejections] the table holds the account, reason, day and counts only: no task_ref, body, key or agent',
     JSON.stringify(cols) === JSON.stringify(['account_id', 'day', 'first_at', 'last_at', 'n', 'reason']), cols.join(','))

  // The stuck count: never recorded a call, then did.
  const { loadRejections } = await import('../../dist/lib/preflight-rejections.js')
  const mine = async () => {
    const [x] = await sql`
      SELECT count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.account_id = r.account_id))::int AS never,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM events e WHERE e.account_id = r.account_id AND e.created_at > r.first_at))::int AS after
      FROM preflight_rejections r WHERE r.account_id = ${A} AND r.reason = 'task_ceiling_required'`
    return x
  }
  const before = await mine()
  const all0 = (await loadRejections(30)).find((r) => r.reason === 'task_ceiling_required')
  const [cust] = await sql`INSERT INTO customers (account_id, customer_ref) VALUES (${A}, 'default') ON CONFLICT (account_id, customer_ref) DO UPDATE SET customer_ref = EXCLUDED.customer_ref RETURNING id`
  await sql`INSERT INTO events (account_id, customer_id, event_type, units, idempotency_key, metadata) VALUES (${A}, ${cust.id}, 'rej-agent', 1, ${'rej-' + randomBytes(4).toString('hex')}, '{}'::jsonb)`
  const after = await mine()
  const all1 = (await loadRejections(30)).find((r) => r.reason === 'task_ceiling_required')
  ok('[rejections] the account is counted as never having recorded a call, then, once it records one, as having recorded one after',
     before.never === 1 && before.after === 0 && after.never === 0 && after.after === 1
       && all0 && all1 && all1.neverCalled === all0.neverCalled - 1 && all1.calledAfter === all0.calledAfter + 1,
     `${JSON.stringify(before)} -> ${JSON.stringify(after)} | ${JSON.stringify(all0)} -> ${JSON.stringify(all1)}`)

  // The owner sees it.
  const admin = await fetch(`${API}/admin`, { headers: { cookie: await adminCookie(), 'fly-client-ip': '203.0.113.250' } }).then((r) => r.text())
  const section = admin.match(/<h2 id="rejections">[\s\S]*?<h2>Accounts<\/h2>/)?.[0] ?? ''
  ok('[rejections] /admin shows the 422 table with task_ceiling_required and the never-recorded-a-call column',
     section.includes('<code>task_ceiling_required</code>') && section.includes('Accounts that never recorded a call'), section.slice(0, 200) || 'no section')

  // Counting that fails never changes the answer.
  await sql`ALTER TABLE preflight_rejections RENAME TO preflight_rejections_hidden`
  const blind = await pre({ agent_id: 'rej-agent', estimated_units: 5, task_ref: 'rej-other-' + randomBytes(3).toString('hex') })
  await sql`ALTER TABLE preflight_rejections_hidden RENAME TO preflight_rejections`
  ok('[rejections] with the table gone the caller still gets the same 422 task_ceiling_required, not a 500',
     blind.status === 422 && blind.body?.error === 'task_ceiling_required', `${blind.status} ${JSON.stringify(blind.body)?.slice(0, 120)}`)
}
