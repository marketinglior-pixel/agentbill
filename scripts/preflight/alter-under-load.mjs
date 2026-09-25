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
import { openSync } from 'node:fs'
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

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`) } else { fail++; console.log(`  FAIL  ${name}  ${detail}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- the server
const logFd = openSync(SERVER_LOG, 'a')
const running = new Set()
async function startServer(extraEnv) {
  // Nothing may already answer on the port. A server left over from an
  // earlier run answers /health too, against ITS database, and the whole
  // rehearsal would pass against the wrong server (it did once, 2026-09-23:
  // 0 event rows here for 1,986 records answered).
  const stale = await fetch(`${API}/health`).then(() => true).catch(() => false)
  if (stale) throw new Error(`something already answers on ${API}; stop it first (lsof -nP -iTCP:${PORT} -sTCP:LISTEN)`)
  const child = spawn(process.execPath, [`${ROOT}dist/server.js`], {
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
console.log(`\n[alter] ${ALTER_FILE.split('/').pop()} under load (${ALTER_WORKERS} workers during, ${WORKERS} around it), window ${PLANT ? 'SKIPPED (planted break: prepared statements kept across the ALTER)' : 'open (DATABASE_PREPARE=false)'}`)

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
ok('[alter] before: the unit columns are still INTEGER (the rehearsal starts from production\'s state)', (await columnTypes()).every((t) => t === 'integer'), JSON.stringify(await columnTypes()))

let server = await startServer(windowEnv)
const warm = await burst(3)
ok('[alter] warm: the pool serves the mix before the ALTER', summary(warm).bad === 0, JSON.stringify(summary(warm)))

const load = loadUntil(ALTER_WORKERS)
await sleep(1_000)
let migrated = null
const alterStarted = Date.now()
const retries = []
try {
  // The runner the deploy step uses, retrying when its locks are busy.
  const r = await applyMigration(process.env.DATABASE_URL, ALTER_FILE, { log: (m) => retries.push(m) })
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
const after = await burst(2)
ok('[alter] after: the same pool, once the ALTER committed, answers every request', summary(after).bad === 0, JSON.stringify(summary(after)))
ok('[alter] every unit column is BIGINT', (await columnTypes()).every((t) => t === 'bigint'), JSON.stringify(await columnTypes()))

// The window closes: the secret is unset, the machines restart, and prepared
// statements are back, prepared against the new types.
await stopServer(server)
server = await startServer({})
const closed = await burst(2)
ok('[alter] closed: restarted with prepared statements on, every request is answered', summary(closed).bad === 0, JSON.stringify(summary(closed)))

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
console.log(`\n${pass} passed, ${fail} failed${PLANT ? '  (planted break: this run is expected to fail)' : ''}`)
process.exit(fail === 0 ? 0 : 1)
