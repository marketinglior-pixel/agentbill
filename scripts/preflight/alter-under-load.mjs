// The driver for alter-under-load.sh. It owns the server process, so it can
// hold the ALTER against a warm pool and then restart it, which is the whole
// point: run.sh migrates before the server exists and cannot see any of this.
//
// Phases, each against the same mix of real API traffic:
//   warm     the pool prepares (or, in the window, parses) every statement
//   alter    the migration runs while 30 workers keep calling
//   after    the same pool, after the ALTER committed
//   closed   restarted with prepared statements back on (the window closed)
// Every request must answer, with a status its route gives on success. A 5xx,
// a network error, or a request still open after REQUEST_TIMEOUT_MS is a
// failure. Then the ledger invariants: every unit column is BIGINT, and each
// reserved counter equals the sum of its open reservation rows.
import postgres from 'postgres'
import { spawn } from 'node:child_process'
import { openSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { applyMigration } from '../db/apply-migration.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const PORT = Number(process.env.PORT ?? 3996)
const API = `http://localhost:${PORT}`
const KEY = process.env.API_KEY ?? 'agb_7e5700000000000000000000000000000000000000000001'
const ACCT = process.env.ACCOUNT_ID ?? '00000000-0000-0000-0000-0000000000aa'
const ALTER_FILE = process.env.ALTER_FILE
const PLANT = process.env.PLANT_SKIP_WINDOW === '1'
// 30-way bursts warm the pool and test it after the ALTER, the reviewer's
// reproduction. While the ALTER runs, fewer workers keep requests in flight
// (still far more than production sees): at 30 the migration spent 25 s and
// 36 attempts losing its lock_timeout to the queue, which rehearses the retry
// loop rather than the window.
const WORKERS = 30
const ALTER_WORKERS = Number(process.env.ALTER_WORKERS ?? 6)
const REQUEST_TIMEOUT_MS = 10_000
const SERVER_LOG = '/tmp/agentbill-alter-server.log'
if (!process.env.DATABASE_URL || !ALTER_FILE) throw new Error('DATABASE_URL and ALTER_FILE are required; run alter-under-load.sh')
// 'bigint' is 016's rehearsal (the ALTER ... TYPE window). 'keyhash' is 026's,
// 2026-09-25: the previous build serves while it runs and keeps minting keys,
// and the new build is started afterwards as the deploy.
// 'additive' is batch C's (028, 029, 030, 2026-09-25): ADD COLUMN only, the
// previous build serving through it with prepared statements on, as for 026.
const PROFILE = /\/026_[^/]*$/.test(ALTER_FILE) ? 'keyhash' : /\/0(2[89]|30)_[^/]*$/.test(ALTER_FILE) ? 'additive' : 'bigint'
// The columns each additive migration adds, checked absent before and present after.
const ADDED = {
  '028': [['accounts', 'monthly_events']],
  '029': [['accounts', 'plan_ends_at'], ['accounts', 'polar_subscription_id']],
  '030': [['developer_api_keys', 'session_epoch']],
}[(ALTER_FILE.match(/\/(0\d\d)_[^/]*$/) ?? [])[1]] ?? []
const NEW_JS = `${ROOT}dist/server.js`
const OLD_JS = process.env.OLD_SERVER_JS || null
if ((PROFILE === 'keyhash' || PROFILE === 'additive') && !OLD_JS) throw new Error('026 and 028-030 are rehearsed with the previous build serving: set OLD_SERVER_JS (alter-under-load.sh does)')
const PLANT_NO_TRIGGER = process.env.PLANT_NO_TRIGGER === '1'
const sha = (k) => createHash('sha256').update(k, 'utf8').digest('hex')
const MINTED = []

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`) } else { fail++; console.log(`  FAIL  ${name}  ${detail}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- the server
const logFd = openSync(SERVER_LOG, 'a')
const running = new Set()
async function startServer(extraEnv, js = NEW_JS) {
  // Nothing may already answer on the port. A server left over from an
  // earlier run answers /health too, against ITS database, and the whole
  // rehearsal would pass against the wrong server (it did once, 2026-09-23:
  // 0 event rows here for 1,986 records answered).
  const stale = await fetch(`${API}/health`).then(() => true).catch(() => false)
  if (stale) throw new Error(`something already answers on ${API}; stop it first (lsof -nP -iTCP:${PORT} -sTCP:LISTEN)`)
  const child = spawn(process.execPath, [js], {
    env: {
      ...process.env, PORT: String(PORT), NODE_ENV: 'test', DATABASE_SSL: 'disable',
      RATE_LIMIT_PER_MINUTE: '1000000', APP_SESSION_SECRET: 'alter-under-load-session-secret',
      DATABASE_PREPARE: undefined, ...extraEnv,
    },
    stdio: ['ignore', logFd, logFd],
  })
  running.add(child)
  for (let i = 0; i < 60; i++) {
    const up = await fetch(`${API}/health/db`).then((r) => r.status === 200).catch(() => false)
    // Up, and it is this child that answered: it is still alive.
    if (up && child.exitCode === null) { await sleep(300); if (child.exitCode === null) return child }
    if (child.exitCode !== null) break
    await sleep(500)
  }
  throw new Error(`server did not come up (exit ${child.exitCode}); see ${SERVER_LOG}`)
}
async function stopServer(child) {
  running.delete(child)
  if (child.exitCode !== null) return
  const exited = new Promise((r) => child.once('exit', r))
  child.kill('SIGTERM')
  const done = await Promise.race([exited.then(() => true), sleep(10_000).then(() => false)])
  if (!done) { child.kill('SIGKILL'); await exited }
}

// ---------------------------------------------------------------- the traffic
// A request is a failure unless it answers with one of `want`.
const call = async (kind, method, path, body, want) => {
  const started = Date.now()
  try {
    const r = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const text = await r.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { kind, status: r.status, ok: want.includes(r.status), json, text: text.slice(0, 160), ms: Date.now() - started }
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError'
    return { kind, status: timedOut ? 'timeout' : 'network', ok: false, json: null, text: String(e?.cause?.code ?? e?.message ?? e), ms: Date.now() - started }
  }
}

let seq = 0
let phase = 'warm'
// One unit of work: the calls a real client makes around one job step, and
// the reads a console makes. Every route that reads or writes a unit column.
async function cycle(w) {
  const n = ++seq
  const job = `alter-job-${w % 6}`
  const cust = `alter-cust-${w % 4}`
  const out = []
  const p = await call('preflight', 'POST', '/preflight', {
    agent_id: 'alter', customer_id: cust, task_ref: job, task_ceiling: 1_000_000_000, estimated_units: 700,
    ...(n % 3 === 0 ? { idempotency_key: `alter-k-${n}` } : {}),
  }, [200])
  out.push(p)
  const rid = p.json?.reservation_id
  out.push(await call('events', 'POST', '/events', {
    customer_id: cust, event_type: 'alter', idempotency_key: `alter-e-${n}`, units: 80, task_ref: job,
    ...(rid && n % 2 === 0 ? { reservation_id: rid } : {}),
    ...(n % 5 === 0 ? { usage_missing: true, units: 0 } : {}),
    metadata: { step: `s${n % 7}` },
  }, [200]))
  const reads = [
    () => call('tasks', 'GET', `/tasks/${job}`, undefined, [200]),
    () => call('tasks-list', 'GET', '/tasks?limit=5', undefined, [200]),
    () => call('budget-put', 'PUT', '/budget', { customer_id: cust, limit_units: 2_000_000_000 }, [200]),
    () => call('budget', 'GET', `/budget?customer_id=${cust}`, undefined, [200]),
    () => call('customers', 'GET', '/customers', undefined, [200]),
    () => call('checkpoint', 'POST', '/checkpoint', { agent_id: 'alter', customer_id: cust, units_so_far: 3 }, [200]),
    () => call('decisions', 'GET', '/decisions?limit=5', undefined, [200]),
    () => call('task-put', 'PUT', `/tasks/${job}/ceiling`, { ceiling_units: 1_000_000_000 }, [200]),
  ]
  out.push(await reads[n % reads.length]())
  // Batch C's additive columns are read by /step (028) and by the console
  // login (030), so the rehearsal calls both routes too.
  if (PROFILE === 'additive') {
    out.push(await call('step', 'POST', '/step', { agent_id: 'alter', step_name: `s${n % 3}`, units: 5 }, [200]))
  }
  // 026: a key minted by whichever build is serving, every eighth cycle. Before
  // the deploy that is the previous build, which writes only api_key.
  if (PROFILE === 'keyhash' && n % 8 === 0) {
    const g = await call('keys-generate', 'POST', '/keys/generate', { label: `alter-mint-${n}` }, [200])
    if (typeof g.json?.api_key === 'string') MINTED.push({ key: g.json.api_key, at: phase })
    out.push(g)
  }
  return out
}

async function burst(rounds = 1) {
  const all = []
  for (let r = 0; r < rounds; r++) {
    const res = await Promise.all(Array.from({ length: WORKERS }, (_, w) => cycle(w)))
    all.push(...res.flat())
  }
  return all
}

// Workers loop until stop() and the migration runs while they do.
function loadUntil(workers) {
  let running = true
  const results = []
  const loops = Array.from({ length: workers }, async (_, w) => {
    while (running) results.push(...await cycle(w))
  })
  return { results, stop: async () => { running = false; await Promise.all(loops) } }
}

const summary = (rs) => {
  const bad = rs.filter((r) => !r.ok)
  const by = {}
  for (const r of bad) by[`${r.kind}:${r.status}`] = (by[`${r.kind}:${r.status}`] ?? 0) + 1
  return { total: rs.length, bad: bad.length, by, sample: bad.slice(0, 3).map((r) => `${r.kind} ${r.status} ${r.text}`) }
}

// ---------------------------------------------------------------- the rehearsal
// A crash anywhere below must not leave a server running on the port.
process.on('exit', () => { for (const c of running) if (c.exitCode === null) c.kill('SIGKILL') })
process.on('uncaughtException', (e) => { console.error(e); process.exit(1) })
process.on('unhandledRejection', (e) => { console.error(e); process.exit(1) })
const windowEnv = PLANT ? {} : { DATABASE_PREPARE: 'false' }
console.log(PROFILE === 'additive'
  ? `\n[alter ${ALTER_FILE.split('/').pop().slice(0, 3)}] ${ALTER_FILE.split('/').pop()} under load (${ALTER_WORKERS} workers during, ${WORKERS} around it), the PREVIOUS build serving with prepared statements ON, no window${process.env.PLANT_SELECT_STAR === '1' ? '  (planted break: the previous build returns * from accounts inside a transaction)' : ''}`
  : PROFILE === 'keyhash'
  ? `\n[alter 026] ${ALTER_FILE.split('/').pop()} under load (${ALTER_WORKERS} workers during, ${WORKERS} around it), the PREVIOUS build serving with prepared statements ON, no window${PLANT_NO_TRIGGER ? '  (planted break: 026 without its fill trigger)' : ''}`
  : `\n[alter] ${ALTER_FILE.split('/').pop()} under load (${ALTER_WORKERS} workers during, ${WORKERS} around it), window ${PLANT ? 'SKIPPED (planted break: prepared statements kept across the ALTER)' : 'open (DATABASE_PREPARE=false)'}`)

const db = postgres(process.env.DATABASE_URL, { ssl: false, max: 1, onnotice: () => {} })
const UNIT_COLUMNS = [
  ['accounts', 'default_budget_units'], ['customers', 'limit_units'], ['customers', 'used_units'], ['customers', 'reserved_units'],
  ['task_budgets', 'ceiling_units'], ['task_budgets', 'used_units'], ['task_budgets', 'reserved_units'],
  ['reservations', 'units'], ['events', 'units'], ['step_costs', 'units'],
]
const columnTypes = async () => {
  const rows = await db`
    SELECT table_name, column_name, data_type FROM information_schema.columns
    WHERE table_schema = current_schema()`
  return UNIT_COLUMNS.map(([t, c]) => rows.find((r) => r.table_name === t && r.column_name === c)?.data_type)
}
const keyColumns = async () => (await db`
  SELECT column_name, is_nullable FROM information_schema.columns
  WHERE table_schema = current_schema() AND table_name = 'developer_api_keys' AND column_name IN ('key_hash', 'key_prefix', 'key_last4')
  ORDER BY column_name`)
const addedCols = async () => {
  const rows = await db`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()`
  return ADDED.filter(([t, c]) => rows.some((r) => r.table_name === t && r.column_name === c)).map(([t, c]) => `${t}.${c}`)
}
if (PROFILE === 'bigint') {
  ok('[alter] before: the unit columns are still INTEGER (the rehearsal starts from production\'s state)', (await columnTypes()).every((t) => t === 'integer'), JSON.stringify(await columnTypes()))
} else if (PROFILE === 'additive') {
  ok(`[alter ${ALTER_FILE.split('/').pop().slice(0, 3)}] before: ${ADDED.map(([t, c]) => `${t}.${c}`).join(', ')} not there yet (the rehearsal starts from production's state)`,
     ADDED.length > 0 && (await addedCols()).length === 0, JSON.stringify(await addedCols()))
} else {
  ok('[alter 026] before: developer_api_keys has no key_hash column yet (the rehearsal starts from production\'s state)', (await keyColumns()).length === 0, JSON.stringify(await keyColumns()))
}

// 026 needs no window: the previous build serves, with prepared statements on.
let server = PROFILE === 'keyhash' || PROFILE === 'additive' ? await startServer({}, OLD_JS) : await startServer(windowEnv)
const warm = await burst(3)
ok('[alter] warm: the pool serves the mix before the ALTER', summary(warm).bad === 0, JSON.stringify(summary(warm)))

phase = 'during'
const load = loadUntil(ALTER_WORKERS)
await sleep(1_000)
let migrated = null
const alterStarted = Date.now()
const retries = []
try {
  // The runner the deploy step uses, retrying when its locks are busy.
  // The planted break for 026: the same file without its fill trigger.
  let file = ALTER_FILE
  if (PLANT_NO_TRIGGER) {
    const text = readFileSync(ALTER_FILE, 'utf8').replace(/DROP TRIGGER IF EXISTS developer_api_keys_fill_hash[\s\S]*?EXECUTE FUNCTION developer_api_keys_fill_hash\(\);/, '-- planted: no trigger')
    if (text === readFileSync(ALTER_FILE, 'utf8')) throw new Error('PLANT_NO_TRIGGER found no trigger to strip')
    file = `${mkdtempSync(`${tmpdir()}/alter-plant-`)}/026_planted.sql`
    writeFileSync(file, text)
  }
  const r = await applyMigration(process.env.DATABASE_URL, file, { log: (m) => retries.push(m) })
  migrated = { ms: Date.now() - alterStarted, attempts: r.attempts }
} catch (e) {
  migrated = { error: `${e.code ?? ''} ${e.message}` }
}
await sleep(3_000)
await load.stop()
const during = load.results
console.log(`        the ALTER ${migrated.error ? `failed: ${migrated.error}` : `committed in ${migrated.ms} ms, attempt ${migrated.attempts}`} while ${during.length} requests ran`)
for (const m of retries.slice(0, -1)) console.log(`        ${m}`)
ok('[alter] the migration commits under load (retrying only lock_timeout / deadlock, which change nothing)', !migrated.error, migrated.error ?? '')
ok('[alter] during: every request made while the ALTER ran was answered, none 5xx, none left open', summary(during).bad === 0 && during.length > ALTER_WORKERS * 3,
   JSON.stringify(summary(during)))
const slowest = during.reduce((m, r) => Math.max(m, r.ms), 0)
console.log(`        slowest request during the migration: ${slowest} ms`)
phase = 'after'
const after = await burst(2)
ok('[alter] after: the same pool, once the ALTER committed, answers every request', summary(after).bad === 0, JSON.stringify(summary(after)))
if (PROFILE === 'bigint') {
  ok('[alter] every unit column is BIGINT', (await columnTypes()).every((t) => t === 'bigint'), JSON.stringify(await columnTypes()))
} else if (PROFILE === 'additive') {
  ok(`[alter ${ALTER_FILE.split('/').pop().slice(0, 3)}] after: the columns exist`, (await addedCols()).length === ADDED.length, JSON.stringify(await addedCols()))
  ok(`[alter ${ALTER_FILE.split('/').pop().slice(0, 3)}] no request waited on the migration for more than 2 s`, slowest < 2_000, `${slowest} ms`)
} else {
  const cols = await keyColumns()
  ok('[alter 026] key_hash, key_prefix and key_last4 exist and are NOT NULL', cols.length === 3 && cols.every((c) => c.is_nullable === 'NO'), JSON.stringify(cols))
  const [bad] = await db`
    SELECT count(*)::int AS n FROM developer_api_keys
    WHERE key_hash IS DISTINCT FROM encode(sha256(convert_to(api_key, 'UTF8')), 'hex')
       OR key_prefix IS DISTINCT FROM left(api_key, 8) OR key_last4 IS DISTINCT FROM right(api_key, 4)`
  ok('[alter 026] every row, the ones the previous build minted during and after the migration too, has the hash of its own key', bad.n === 0, `${bad.n} rows`)
  ok('[alter 026] no request waited on the migration for more than 2 s', slowest < 2_000, `${slowest} ms`)
}

// The window closes: the secret is unset, the machines restart, and prepared
// statements are back, prepared against the new types. For 026 this is the
// deploy: the new build replaces the previous one.
await stopServer(server)
phase = 'closed'
server = await startServer({})
const closed = await burst(2)
ok(`[alter] closed: ${PROFILE !== 'bigint' ? 'the new build deployed' : 'restarted with prepared statements on'}, every request is answered`, summary(closed).bad === 0, JSON.stringify(summary(closed)))
if (PROFILE === 'keyhash') {
  const oldMints = MINTED.filter((m) => m.at !== 'closed')
  const statuses = []
  for (const m of oldMints) {
    const r = await fetch(`${API}/keys`, { headers: { Authorization: `Bearer ${m.key}` } }).catch(() => null)
    statuses.push(r ? r.status : 'network')
    const body = r ? await r.json().catch(() => ({})) : {}
    if (JSON.stringify(body).match(/agb_[0-9a-f]{48}/)) statuses.push('LEAK')
  }
  const byPhase = oldMints.reduce((a, m) => ({ ...a, [m.at]: (a[m.at] ?? 0) + 1 }), {})
  console.log(`        keys the previous build minted: ${JSON.stringify(byPhase)}`)
  ok('[alter 026] on the new build, every key the previous build minted (before, during and after the migration) authenticates, and GET /keys shows none of them',
     oldMints.length > 0 && (byPhase.during ?? 0) > 0 && (byPhase.after ?? 0) > 0 && statuses.every((s) => s === 200), `${JSON.stringify(byPhase)} ${JSON.stringify([...new Set(statuses)])}`)
  const seed = await fetch(`${API}/keys`, { headers: { Authorization: `Bearer ${KEY}` } }).then((r) => r.status)
  ok('[alter 026] and so does the key that existed before the migration', seed === 200, `${seed}`)
}

const custDrift = await db`
  SELECT c.customer_ref, c.reserved_units::text AS counter, COALESCE(SUM(r.units), 0)::text AS open_rows
  FROM customers c LEFT JOIN reservations r ON r.customer_id = c.id AND r.released_at IS NULL
  WHERE c.account_id = ${ACCT}
  GROUP BY c.id HAVING c.reserved_units <> COALESCE(SUM(r.units), 0)`
const taskDrift = await db`
  SELECT t.task_ref, t.reserved_units::text AS counter, COALESCE(SUM(r.units), 0)::text AS open_rows
  FROM task_budgets t LEFT JOIN reservations r ON r.account_id = t.account_id AND r.task_ref = t.task_ref AND r.released_at IS NULL
  WHERE t.account_id = ${ACCT}
  GROUP BY t.id HAVING t.reserved_units <> COALESCE(SUM(r.units), 0)`
ok('[alter] invariant: every reserved counter equals the sum of its open reservations, customers and jobs', custDrift.length === 0 && taskDrift.length === 0,
   JSON.stringify({ custDrift, taskDrift }))
const stray = (await db`SELECT count(*)::int AS n FROM events WHERE account_id = ${ACCT}`)[0].n
const recorded = [...warm, ...during, ...after, ...closed].filter((r) => r.kind === 'events' && r.ok).length
ok('[alter] and every record that answered 200 is one event row', stray === recorded, `${stray} rows vs ${recorded} answered`)

await stopServer(server)
await db.end()
console.log(`\n${pass} passed, ${fail} failed${PLANT || PLANT_NO_TRIGGER || process.env.PLANT_SELECT_STAR === '1' ? '  (planted break: this run is expected to fail)' : ''}`)
process.exit(fail === 0 ? 0 : 1)
