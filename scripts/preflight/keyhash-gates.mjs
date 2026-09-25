// [keyhash] API keys stored hashed (security batch B, S3, 2026-09-25).
//
// Run by verify.mjs in both passes of run.sh:
//   ./scripts/preflight/run.sh --external                 026 applied, plaintext still in api_key
//   APPLY_LATER=1 ./scripts/preflight/run.sh --external   027 applied too: api_key NULL everywhere
// Every gate below holds in both, except the ones that name their pass. The
// pass is read from the database (027's scrub trigger), and checked against
// what run.sh was asked for, so a pass cannot quietly test the wrong schema.
//
// What each group proves:
//   pre     a key that existed BEFORE 026 (run.sh seeds it between 025 and
//           026, so 026's backfill is what gave it a hash) authenticates on
//           every path: the REST API, the console's key login, MCP Bearer, and
//           the /recover flow for its account.
//   window  a key the PREVIOUS build mints after 026 and before the deploy (a
//           raw INSERT of api_key alone, its exact shape) gets its hash from
//           the trigger and authenticates. After 027 that INSERT is refused.
//   plain   before 027 the build still writes api_key (a rollback must find
//           its keys); after 027 no row holds one, and no line of src/ reads it.
//   leak    no response, console view, admin page, MCP tool or email carries
//           a whole key, except the one-time answers that create one.
//   rules   revoked and expired keys are 401; a child key's expiry is clamped
//           to its parent's; revoke-all ends keys and key sessions and leaves
//           a way back; rotation grace is what it is configured to be; revoke
//           by key_id and the stored prefix forms; batch A still holds.
//   prod    the same paths on a server booted with NODE_ENV=production, no
//           test outbox, no test origin.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { keyHash, insertKeyRow } from './key-fixture.mjs'

const FULL = /agb_[0-9a-f]{48}/g
const fulls = (s) => [...new Set(String(s ?? '').match(FULL) ?? [])]
const mask = (k) => `${k.slice(0, 8)}…${k.slice(-4)}`
const shaped = (tag) => 'agb_' + createHash('sha256').update(`keyhash-${tag}-${Date.now()}-${Math.random()}`).digest('hex').slice(0, 48)

export async function keyhashGates(opts) {
  console.log('\n[keyhash] API keys stored hashed, looked up by hash, never shown twice')
  let reached = false
  try {
    await gates(opts)
    reached = true
  } catch (err) {
    opts.ok('[keyhash] a gate threw', false, String(err?.stack ?? err).slice(0, 400))
  }
  opts.ok('[keyhash] every gate ran to the end', reached)
}

async function gates({ API, sql, ok, bootS, stopS, portS, outbox, adminCookie, preKey, preAccount, root }) {
  const SAME = { 'Sec-Fetch-Site': 'same-origin' }
  const FORM = { 'Content-Type': 'application/x-www-form-urlencoded', ...SAME }
  let net = 1
  const newNet = () => ({ 'fly-client-ip': `198.19.${Math.floor(net / 250)}.${(net++ % 250) + 1}` })
  const settle = (ms) => new Promise((r) => setTimeout(r, ms))
  const cookieVal = (res, name) => (res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? '').split(';')[0]
  const j = async (r) => { const t = await r.text(); try { return { status: r.status, body: JSON.parse(t), text: t } } catch { return { status: r.status, body: null, text: t } } }
  const get = (path, key, base = API, headers = {}) => fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${key}`, ...headers } }).then(j)
  const post = (path, body, key, base = API) => fetch(`${base}${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
  }).then(j)
  const status = async (key, base = API) => (await get('/keys', key, base)).status
  const keyLogin = async (key, base = API) => {
    const r = await fetch(`${base}/app/session`, { method: 'POST', redirect: 'manual', headers: { ...FORM, ...newNet() }, body: `api_key=${encodeURIComponent(key)}` })
    return { status: r.status, location: r.headers.get('location') ?? '', cookie: cookieVal(r, 'agentbill_app') }
  }
  const page = (path, cookie, base = API) => fetch(`${base}${path}`, { headers: { cookie } }).then(async (r) => ({ status: r.status, html: await r.text() }))
  const MCPH = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' }
  let rpcId = 1
  const rpc = async (bearer, method, params = {}, base = API) => {
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...MCPH, Authorization: `Bearer ${bearer}`, ...newNet() }, body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }) })
    const text = await r.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { status: r.status, json, text }
  }
  const newAccount = async (tag, { email = true } = {}) => {
    const [a] = await sql`INSERT INTO accounts (plan, email, monthly_calls, billing_period_start)
      VALUES ('free', ${email ? `keyhash-${tag}-${randomBytes(4).toString('hex')}@example.invalid` : null}, 0, date_trunc('month', CURRENT_DATE)::date)
      RETURNING id, email`
    return a
  }
  const outboxLines = () => { try { return readFileSync(outbox, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] } }
  const recoverToken = async (accountId) => {
    const t = randomBytes(32).toString('base64url')
    await sql`INSERT INTO account_recovery_tokens (account_id, token_hash, expires_at) VALUES (${accountId}, ${createHash('sha256').update(t).digest('hex')}, NOW() + INTERVAL '10 minutes')`
    return t
  }
  const recoverPost = (token, action, base = API) => fetch(`${base}/recover/${token}`, { method: 'POST', redirect: 'manual', headers: FORM, body: `action=${action}` })
    .then(async (r) => ({ status: r.status, html: await r.text() }))
  const VIEWS = ['', '?view=start', '?view=overview', '?view=activity', '?view=tasks', '?view=refusals', '?view=customers', '?view=keys', '?view=limits']

  // ---------------------------------------------------------------- the pass
  const [trig] = await sql`SELECT
      (SELECT count(*)::int FROM pg_trigger WHERE tgname = 'developer_api_keys_fill_hash') AS fill,
      (SELECT count(*)::int FROM pg_trigger WHERE tgname = 'developer_api_keys_scrub_plaintext') AS scrub`
  const later = trig.scrub === 1
  ok(`[keyhash] this pass is ${later ? 'AFTER 027 (plaintext scrubbed)' : 'after 026, before 027'}, as run.sh was asked (APPLY_LATER=${process.env.APPLY_LATER || 'unset'})`,
     later === (process.env.APPLY_LATER === '1') && (later ? trig.fill === 0 : trig.fill === 1), JSON.stringify(trig))
  const [cols] = await sql`SELECT count(*) FILTER (WHERE is_nullable = 'NO')::int AS nn FROM information_schema.columns
    WHERE table_name = 'developer_api_keys' AND column_name IN ('key_hash', 'key_prefix', 'key_last4')`
  ok('[keyhash] key_hash, key_prefix and key_last4 are NOT NULL on every row, and key_hash is UNIQUE',
     cols.nn === 3 && (await sql`SELECT 1 FROM pg_indexes WHERE indexname = 'developer_api_keys_key_hash_key' AND indexdef LIKE 'CREATE UNIQUE%'`).length === 1)

  // ---------------------------------------------------------------- pre: a key from before 026
  const [preRow] = await sql`SELECT key_hash, key_prefix, key_last4, api_key, label FROM developer_api_keys WHERE key_hash = ${keyHash(preKey)}`
  ok('[keyhash pre] the key seeded before 026 was given its hash, prefix and last four by the backfill',
     preRow?.keyHash === keyHash(preKey) && preRow.keyPrefix === preKey.slice(0, 8) && preRow.keyLast4 === preKey.slice(-4) && preRow.label === 'before-026'
       && (later ? preRow.apiKey === null : preRow.apiKey === preKey), JSON.stringify({ ...preRow, apiKey: preRow?.apiKey ? '(present)' : null }))
  const preList = await get('/keys', preKey)
  ok('[keyhash pre] REST: it authenticates, and GET /keys lists it as agb_1234…abcd with an id, with no api_key field and no whole key',
     preList.status === 200 && preList.body.keys.some((k) => k.key === mask(preKey) && k.current === true && /^[0-9a-f-]{36}$/.test(k.id))
       && preList.body.keys.every((k) => !('api_key' in k)) && fulls(preList.text).length === 0, preList.text.slice(0, 300))
  const preSess = await keyLogin(preKey)
  const preKeysView = await page('/app?view=keys', preSess.cookie)
  ok('[keyhash pre] console: the key login opens it, and the keys view marks it without printing it',
     preSess.status === 303 && preSess.location === '/app' && !!preSess.cookie && preKeysView.status === 200
       && preKeysView.html.includes('Signed in with a key') && preKeysView.html.includes(mask(preKey)) && fulls(preKeysView.html).length === 0,
     `${preSess.status} ${preSess.location} ${fulls(preKeysView.html).length}`)
  const preTools = await rpc(preKey, 'tools/list')
  const preCall = await rpc(preKey, 'tools/call', { name: 'top_jobs', arguments: {} })
  ok('[keyhash pre] MCP Bearer: tools/list and a tool call both answer for it',
     preTools.status === 200 && (preTools.json?.result?.tools ?? []).length >= 5 && preCall.status === 200 && !preCall.json?.error, `${preTools.status} ${preCall.status} ${preCall.text.slice(0, 160)}`)

  // /recover, the real way in: the form, the mail, the link.
  const [preAcct] = await sql`SELECT email FROM accounts WHERE id = ${preAccount}`
  const askR = await fetch(`${API}/recover`, { method: 'POST', redirect: 'manual', headers: { ...FORM, ...newNet() }, body: `email=${encodeURIComponent(preAcct.email)}` })
  let recMail = null
  for (let i = 0; i < 60 && !recMail; i++) { recMail = outboxLines().find((m) => m.to === preAcct.email && /\/recover\/[A-Za-z0-9_-]{43}/.test(m.html)); if (!recMail) await settle(50) }
  const recTok = (recMail?.html.match(/\/recover\/([A-Za-z0-9_-]{43})/) ?? [])[1] ?? ''
  const [recRow] = await sql`SELECT EXTRACT(EPOCH FROM (expires_at - created_at))::int AS ttl, consumed_at FROM account_recovery_tokens WHERE token_hash = ${createHash('sha256').update(recTok).digest('hex')}`
  ok('[keyhash pre] /recover mails a link for its account; the mail carries no key and says a NEW key is made; the link lasts 60 minutes',
     askR.status === 303 && !!recTok && recRow?.ttl === 3600 && fulls(recMail.html).length === 0 && /get a new API key/.test(recMail.html) && !/see your current API key/.test(recMail.html),
     `${askR.status} ${recTok ? 'token' : 'no token'} ttl=${recRow?.ttl}`)
  const choice1 = await fetch(`${API}/recover/${recTok}`).then(async (r) => ({ status: r.status, html: await r.text() }))
  const choice2 = await fetch(`${API}/recover/${recTok}`).then(async (r) => ({ status: r.status, html: await r.text() }))
  const [recAfterGet] = await sql`SELECT consumed_at FROM account_recovery_tokens WHERE token_hash = ${createHash('sha256').update(recTok).digest('hex')}`
  ok('[keyhash pre] the link page offers the two choices, a new key beside the old ones or a replacement, shows no key, and two GETs do not spend it',
     choice1.status === 200 && choice2.status === 200 && recAfterGet?.consumedAt === null
       && choice1.html.includes('name="action" value="add"') && choice1.html.includes('name="action" value="replace"')
       && choice1.html.includes('(the old ones keep working)') && choice1.html.includes('(the old ones stop working)')
       && !choice1.html.includes('value="reveal"') && !/Show my key/.test(choice1.html) && fulls(choice1.html).length === 0,
     `${choice1.status} ${choice2.status}`)
  const added = await recoverPost(recTok, 'add')
  const addedKeys = fulls(added.html)
  ok('[keyhash pre] "add": one NEW key, shown once on the page with its export line; the old key keeps working and so does the new one',
     added.status === 200 && addedKeys.length === 1 && addedKeys[0] !== preKey && added.html.includes(`export AGENTBILL_API_KEY=${addedKeys[0]}`)
       && await status(addedKeys[0]) === 200 && await status(preKey) === 200, `${added.status} ${addedKeys.length}`)
  ok('[keyhash pre] and the link is single use: a second POST is 410 and makes nothing',
     (await recoverPost(recTok, 'add')).status === 410)
  const tokR = await recoverToken(preAccount)
  const replaced = await recoverPost(tokR, 'replace')
  const replacedKeys = fulls(replaced.html)
  const preAfter = await get('/keys', preKey)
  ok('[keyhash pre] "replace": one new key, and every key the account had (the pre-026 one, the added one) is 401 key_revoked at once',
     replaced.status === 200 && replacedKeys.length === 1 && await status(replacedKeys[0]) === 200
       && preAfter.status === 401 && preAfter.body?.error === 'key_revoked' && await status(addedKeys[0]) === 401, `${replaced.status} ${preAfter.status}`)
  ok('[keyhash pre] and the console session that key opened is over too',
     !(await page('/app?view=keys', preSess.cookie)).html.includes('Signed in with a key'))

  // ---------------------------------------------------------------- window: the previous build mints after 026
  const accW = await newAccount('window')
  const keyW = shaped('window')
  let rawErr = null
  try { await sql`INSERT INTO developer_api_keys (account_id, api_key, label) VALUES (${accW.id}, ${keyW}, 'old-build-shape')` } catch (e) { rawErr = e }
  if (!later) {
    const [w] = await sql`SELECT key_hash, key_prefix, key_last4 FROM developer_api_keys WHERE account_id = ${accW.id}`
    const wSess = await keyLogin(keyW)
    const wMcp = await rpc(keyW, 'tools/list')
    ok('[keyhash window] a raw INSERT of api_key alone, the previous build\'s shape, gets its hash, prefix and last four from the trigger',
       rawErr === null && w?.keyHash === keyHash(keyW) && w.keyPrefix === keyW.slice(0, 8) && w.keyLast4 === keyW.slice(-4), String(rawErr ?? JSON.stringify(w)))
    ok('[keyhash window] and that key authenticates on the new build: REST, the console key login, MCP Bearer',
       await status(keyW) === 200 && wSess.status === 303 && wSess.location === '/app' && wMcp.status === 200, `${wSess.status} ${wMcp.status}`)
  } else {
    ok('[keyhash window, after 027] the same raw INSERT is refused (key_hash NOT NULL): after 027 only code that hashes can mint a key',
       rawErr?.code === '23502' && /key_hash/.test(rawErr?.message ?? ''), String(rawErr?.message ?? 'no error'))
  }

  // ---------------------------------------------------------------- plain: the transition write, and after 027 none
  const accP = await newAccount('plain')
  const keyP0 = shaped('plain0')
  await insertKeyRow(sql, accP.id, keyP0, 'plain-parent')
  const genP = await post('/keys/generate', { label: 'plain-child' }, keyP0)
  const [pRow] = await sql`SELECT api_key, key_hash FROM developer_api_keys WHERE id = ${genP.body?.id ?? null}`
  if (!later) {
    ok('[keyhash plain] before 027, a key the build mints is also written to api_key, so a rollback to the previous build still finds it',
       genP.status === 200 && pRow?.apiKey === genP.body.api_key && pRow.keyHash === keyHash(genP.body.api_key)
         && (await sql`SELECT count(*)::int AS n FROM developer_api_keys WHERE api_key = ${genP.body.api_key}`)[0].n === 1)
  } else {
    const [plainLeft] = await sql`SELECT count(*)::int AS n FROM developer_api_keys WHERE api_key IS NOT NULL`
    const [chk] = await sql`SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'developer_api_keys_no_plaintext'`
    ok('[keyhash plain, after 027] no row holds a plaintext key, a key minted now included, and a CHECK keeps it that way',
       genP.status === 200 && pRow?.apiKey === null && pRow.keyHash === keyHash(genP.body.api_key) && plainLeft.n === 0 && chk.n === 1,
       `${genP.status} rows with plaintext: ${plainLeft.n}`)
    ok('[keyhash plain, after 027] and the key minted with no plaintext stored authenticates', await status(genP.body.api_key) === 200)
  }
  // Nothing in src/ reads api_key. Every line that names it is one of the
  // listed kinds: prose, a doc snippet, the console's form field, the one-time
  // JSON field, and the transition write in api-keys.ts. A new SELECT, WHERE
  // or RETURNING on the column is none of those and is named here.
  const tsFiles = []
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) tsFiles.push(p) } }
  walk(join(root, 'src'))
  const ALLOWED = [
    /^\s*(\/\/|\*|\/\*|--)/,                                   // a comment
    /AgentBillClient\(api_key=/,                                // a doc snippet
    /takes api_key as an argument/,                             // llms.txt prose
    /^\s*api_key=os\.environ\[/,                               // a doc snippet's second line
    /body\?\.api_key/, /(for|id|name)="api_key"/,               // the console's key-login form
    /^\s*api_key: (minted|out\.minted)\.key,$/,                 // the one-time JSON field on generate / rotate
    /^\s*INSERT INTO developer_api_keys \(account_id, key_hash, key_prefix, key_last4, label, expires_at, api_key\)$/,   // the transition write
  ]
  const readers = []
  for (const f of tsFiles) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/\bapi_key\b/.test(line) && !ALLOWED.some((re) => re.test(line))) readers.push(`${f.slice(root.length)}:${i + 1}: ${line.trim().slice(0, 90)}`)
    })
  }
  const inserts = tsFiles.filter((f) => /INSERT INTO developer_api_keys/.test(readFileSync(f, 'utf8'))).map((f) => f.slice(root.length))
  ok('[keyhash plain] no line of src/ reads api_key: every mention is prose, a snippet, the form field, the one-time response field or the transition write',
     readers.length === 0, readers.slice(0, 5).join(' | '))
  ok('[keyhash plain] and src/lib/api-keys.ts is the only file in src/ that inserts a key', JSON.stringify(inserts) === JSON.stringify(['src/lib/api-keys.ts']), JSON.stringify(inserts))

  // ---------------------------------------------------------------- rules: revoked, expired
  const accR = await newAccount('rules')
  const keyLive = shaped('live'), keyRev = shaped('rev'), keyExp = shaped('exp')
  await insertKeyRow(sql, accR.id, keyLive, 'live')
  await insertKeyRow(sql, accR.id, keyRev, 'revoked', { revokedAt: sql`NOW() - INTERVAL '1 second'` })
  await insertKeyRow(sql, accR.id, keyExp, 'expired', { expiresAt: sql`NOW() - INTERVAL '1 second'` })
  const rRev = await get('/keys', keyRev), rExp = await get('/keys', keyExp)
  const lRev = await keyLogin(keyRev), lExp = await keyLogin(keyExp)
  const mRev = await rpc(keyRev, 'tools/list'), mExp = await rpc(keyExp, 'tools/list')
  ok('[keyhash rules] a revoked key is 401 key_revoked and an expired one 401 key_expired, on REST, the console login and MCP',
     rRev.status === 401 && rRev.body?.error === 'key_revoked' && rExp.status === 401 && rExp.body?.error === 'key_expired'
       && lRev.location.includes('err=revoked') && lExp.location.includes('err=expired') && !lRev.cookie && !lExp.cookie
       && mRev.status === 401 && mExp.status === 401, `${rRev.status} ${rExp.status} ${lRev.location} ${lExp.location} ${mRev.status} ${mExp.status}`)
  const unknown = await get('/keys', shaped('unknown'))
  ok('[keyhash rules] a key-shaped token that matches no hash is 401 unauthorized, the body a malformed one gets',
     unknown.status === 401 && unknown.body?.error === 'unauthorized' && unknown.body?.message === 'Invalid API key.', unknown.text)

  // ---------------------------------------------------------------- rules: a child never outlives its parent
  const accC = await newAccount('clamp')
  const parent = shaped('parent')
  await insertKeyRow(sql, accC.id, parent, 'parent', { expiresAt: sql`NOW() + INTERVAL '2 days'` })
  const [pExp] = await sql`SELECT expires_at FROM developer_api_keys WHERE key_hash = ${keyHash(parent)}`
  const c30 = await post('/keys/generate', { label: 'c30', expires_in_days: 30 }, parent)
  const cNone = await post('/keys/generate', { label: 'cnone' }, parent)
  const c1 = await post('/keys/generate', { label: 'c1', expires_in_days: 1 }, parent)
  const expOf = async (id) => (await sql`SELECT expires_at FROM developer_api_keys WHERE id = ${id}`)[0]?.expiresAt?.getTime()
  const oneDay = Date.now() + 86_400_000
  ok('[keyhash rules] a key expiring in 2 days mints a 30-day key and a no-expiry key: both are clamped to the parent\'s expiry, and say so',
     c30.status === 200 && cNone.status === 200 && await expOf(c30.body.id) === pExp.expiresAt.getTime() && await expOf(cNone.body.id) === pExp.expiresAt.getTime()
       && c30.body.clamped_to_parent === true && cNone.body.clamped_to_parent === true, JSON.stringify([c30.body?.expires_at, cNone.body?.expires_at, pExp.expiresAt]))
  ok('[keyhash rules] a 1-day key from the same parent keeps its own, earlier expiry',
     c1.status === 200 && c1.body.clamped_to_parent === false && Math.abs((await expOf(c1.body.id)) - oneDay) < 60_000)
  const gchild = await post('/keys/generate', { label: 'grandchild' }, cNone.body.api_key)
  ok('[keyhash rules] and the clamp carries down a generation', gchild.status === 200 && await expOf(gchild.body.id) === pExp.expiresAt.getTime())
  const rotP = await post('/keys/rotate', {}, parent)
  ok('[keyhash rules] rotating the parent: the replacement inherits its expiry, so rotation is no way around it',
     rotP.status === 200 && await expOf(rotP.body.id) === pExp.expiresAt.getTime(), JSON.stringify(rotP.body).slice(0, 200))
  const inGrace = await post('/keys/generate', { label: 'from-grace' }, parent)
  const [pNow] = await sql`SELECT revoked_at FROM developer_api_keys WHERE key_hash = ${keyHash(parent)}`
  ok('[keyhash rules] a key minted by a key in its rotation grace dies when the grace ends',
     inGrace.status === 200 && await expOf(inGrace.body.id) === pNow.revokedAt.getTime(), `${inGrace.status}`)
  const accU = await newAccount('unbounded')
  const free = shaped('free')
  await insertKeyRow(sql, accU.id, free, 'free')
  const fNone = await post('/keys/generate', { label: 'fnone' }, free)
  ok('[keyhash rules] a key with no expiry and no grace mints a key with none', fNone.status === 200 && fNone.body.expires_at === null && fNone.body.clamped_to_parent === false)

  // ---------------------------------------------------------------- rules: rotation grace
  const graceOf = async (key) => (await sql`SELECT EXTRACT(EPOCH FROM (revoked_at - NOW()))::int AS s FROM developer_api_keys WHERE key_hash = ${keyHash(key)}`)[0]?.s
  const accG = await newAccount('grace')
  const g1 = shaped('g1'), g2 = shaped('g2'), g3 = shaped('g3')
  for (const k of [g1, g2, g3]) await insertKeyRow(sql, accG.id, k, 'grace')
  const rDefault = await post('/keys/rotate', {}, g1)
  const sDefault = await graceOf(g1)
  ok('[keyhash rules] rotation grace defaults to 60 minutes (was 24 hours): the old key still works and its revoked_at is an hour out, on the DB clock',
     rDefault.status === 200 && rDefault.body.grace_minutes === 60 && sDefault > 3500 && sDefault <= 3600 && await status(g1) === 200,
     `${rDefault.body?.grace_minutes} ${sDefault}`)
  const rNone = await post('/keys/rotate', { grace_minutes: 0 }, g2)
  const rNoneAfter = await get('/keys', g2)
  ok('[keyhash rules] grace_minutes: 0 rotates with no grace: the old key is 401 key_revoked on the very next request',
     rNone.status === 200 && rNone.body.grace_minutes === 0 && rNoneAfter.status === 401 && rNoneAfter.body?.error === 'key_revoked' && await status(rNone.body.api_key) === 200,
     `${rNone.status} ${rNoneAfter.status}`)
  const rFive = await post('/keys/rotate', { grace_minutes: 5 }, g3)
  const sFive = await graceOf(g3)
  ok('[keyhash rules] grace_minutes: 5 is five minutes', rFive.status === 200 && sFive > 280 && sFive <= 300, `${sFive}`)
  const badG = await Promise.all([{ grace_minutes: -1 }, { grace_minutes: 1441 }, { grace_minutes: 1.5 }, { grace_minutes: '10' }]
    .map((b) => post('/keys/rotate', b, rFive.body.api_key)))
  ok('[keyhash rules] a grace out of 0..1440, or not an integer, is 422 and rotates nothing', badG.every((r) => r.status === 422) && await status(rFive.body.api_key) === 200,
     badG.map((r) => r.status).join(','))
  ok('[keyhash rules] rotating a key already in its grace is refused (400), so a grace cannot be extended by rotating again',
     (await post('/keys/rotate', {}, g1)).status === 400)
  const envG = await bootS({ DATABASE_SSL: 'disable', APP_SESSION_SECRET: 'keyhash-boot-secret-keyhash-boot-secret', KEY_ROTATION_GRACE_MINUTES: '7', RATE_LIMIT_PER_MINUTE: '100000' }, portS)
  const g4 = shaped('g4')
  await insertKeyRow(sql, accG.id, g4, 'grace-env')
  const rEnv = envG.exited ? { status: 0, body: null } : await post('/keys/rotate', {}, g4, `http://localhost:${portS}`)
  const sEnv = await graceOf(g4)
  await stopS(envG)
  ok('[keyhash rules] KEY_ROTATION_GRACE_MINUTES=7 on the server makes the default seven minutes', rEnv.status === 200 && rEnv.body.grace_minutes === 7 && sEnv > 400 && sEnv <= 420,
     `${rEnv.status} ${rEnv.body?.grace_minutes} ${sEnv}`)
  const envBad = await bootS({ DATABASE_SSL: 'disable', KEY_ROTATION_GRACE_MINUTES: 'a day' }, portS)
  ok('[keyhash rules] and a value that is not a number of minutes stops the boot, naming the setting',
     envBad.exited && envBad.code !== 0 && /KEY_ROTATION_GRACE_MINUTES must be an integer/.test(envBad.out()), envBad.out().slice(-200))
  await stopS(envBad)

  // ---------------------------------------------------------------- rules: revoke by what is stored
  const accV = await newAccount('revoke')
  const v = [shaped('v0'), shaped('v1'), shaped('v2'), shaped('v3'), shaped('v4')]
  for (const k of v) await insertKeyRow(sql, accV.id, k, 'revoke-forms')
  const listV = (await get('/keys', v[0])).body.keys
  const idOf = (k) => listV.find((x) => x.key === mask(k))?.id
  const byId = await post('/keys/revoke', { key_id: idOf(v[1]) }, v[0])
  const byMask = await post('/keys/revoke', { key_prefix: mask(v[2]) }, v[0])
  const byDots = await post('/keys/revoke', { key_prefix: `${v[3].slice(0, 8)}...${v[3].slice(-4)}` }, v[0])
  const byFull = await post('/keys/revoke', { key_prefix: v[4] }, v[0])
  ok('[keyhash rules] revoke by key_id, by agb_1234…abcd, by agb_1234...abcd and by the whole key: each revokes exactly that one',
     [byId, byMask, byDots, byFull].every((r) => r.status === 200 && r.body.revoked_count === 1)
       && (await Promise.all(v.slice(1).map((k) => status(k)))).every((s) => s === 401) && await status(v[0]) === 200,
     [byId, byMask, byDots, byFull].map((r) => `${r.status}:${r.body?.revoked_count ?? r.body?.error}`).join(' '))
  const tooLong = await post('/keys/revoke', { key_prefix: v[0].slice(0, 16) }, v[0])
  const both = await post('/keys/revoke', { key_id: idOf(v[0]), key_prefix: v[0].slice(0, 8) }, v[0])
  ok('[keyhash rules] a 16-character prefix (the stored part is 8) is 422 and names the forms that work; key_id with key_prefix is 422',
     tooLong.status === 422 && /agb_1234…abcd/.test(tooLong.body?.message ?? '') && both.status === 422 && await status(v[0]) === 200, `${tooLong.status} ${both.status}`)
  const otherId = (await get('/keys', keyLive)).body.keys[0].id
  const cross = await post('/keys/revoke', { key_id: otherId }, v[0])
  ok('[keyhash rules] a key_id from another account is key_not_found and revokes nothing', cross.status === 400 && cross.body.error === 'key_not_found' && await status(keyLive) === 200)

  // ---------------------------------------------------------------- rules: revoke all
  // A legacy account: an email, no person, three keys and a console session.
  const accA = await newAccount('revall')
  const a = [shaped('a0'), shaped('a1'), shaped('a2')]
  for (const k of a) await insertKeyRow(sql, accA.id, k, 'revall')
  await sql`UPDATE developer_api_keys SET revoked_at = NOW() + INTERVAL '30 minutes' WHERE key_hash = ${keyHash(a[2])}`   // one mid-rotation
  const aSess = await keyLogin(a[1])
  const noConfirm = await post('/keys/revoke-all', {}, a[0])
  ok('[keyhash rules] POST /keys/revoke-all without {"confirm": true} is 422 and revokes nothing',
     noConfirm.status === 422 && /confirm/.test(noConfirm.body?.message ?? '') && (await Promise.all(a.map((k) => status(k)))).every((s) => s === 200))
  const all = await post('/keys/revoke-all', { confirm: true }, a[0])
  const aStates = await Promise.all(a.map((k) => get('/keys', k)))
  const aView = await page('/app?view=keys', aSess.cookie)
  ok('[keyhash rules] revoke-all: every key, the caller and the one mid-rotation included, is 401 key_revoked at once',
     all.status === 200 && all.body.revoked_count === 3 && aStates.every((r) => r.status === 401 && r.body?.error === 'key_revoked'), JSON.stringify(all.body))
  ok('[keyhash rules] and the console session one of them opened is over on its next request',
     aSess.status === 303 && !aView.html.includes('Signed in with a key') && aView.html.includes('action="/app/session"'))
  ok('[keyhash rules] and it mints nothing (a stolen key cannot trade itself for a fresh one): no new key, no key in the answer, the way back named instead',
     fulls(all.text).length === 0 && all.body.recover_url === 'https://agentbill.dev/recover' && all.body.sign_in_url === null
       && (await sql`SELECT count(*)::int AS n FROM developer_api_keys WHERE account_id = ${accA.id}`)[0].n === 3)
  const backTok = await recoverToken(accA.id)
  const back = await recoverPost(backTok, 'add')
  const backKey = fulls(back.html)[0]
  ok('[keyhash rules] the way back for a key-only account: /recover makes a new key that authenticates', back.status === 200 && !!backKey && await status(backKey) === 200)
  // Nobody could get back in: no email, no person. Refused, nothing changed.
  const accN = await newAccount('noway', { email: false })
  const nKey = shaped('n0')
  await insertKeyRow(sql, accN.id, nKey, 'noway')
  const refused = await post('/keys/revoke-all', { confirm: true }, nKey)
  ok('[keyhash rules] revoke-all on an account with no email and no person is 409 no_recovery_path, and the key still works',
     refused.status === 409 && refused.body.error === 'no_recovery_path' && await status(nKey) === 200, JSON.stringify(refused.body))

  // The console's button, from a key session: signs this browser out and says where to go.
  const accK = await newAccount('revall-console')
  const kk = [shaped('k0'), shaped('k1')]
  for (const k of kk) await insertKeyRow(sql, accK.id, k, 'revall-console')
  const kSess = await keyLogin(kk[0])
  const kView = await page('/app?view=keys', kSess.cookie)
  const cNo = await fetch(`${API}/app/keys/revoke-all`, { method: 'POST', redirect: 'manual', headers: { ...FORM, cookie: kSess.cookie }, body: 'confirm=no' })
  const cX = await fetch(`${API}/app/keys/revoke-all`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example', cookie: kSess.cookie }, body: 'confirm=yes' })
  const kAlive = await Promise.all(kk.map((k) => status(k)))
  const cYes = await fetch(`${API}/app/keys/revoke-all`, { method: 'POST', redirect: 'manual', headers: { ...FORM, cookie: kSess.cookie }, body: 'confirm=yes' })
  const kLanding = await page(cYes.headers.get('location') ?? '/app', kSess.cookie)
  ok('[keyhash rules] console: the keys view has the Revoke all form, with a box to tick, and says a key session signs out with it',
     kView.html.includes('action="/app/keys/revoke-all"') && kView.html.includes('name="confirm" value="yes"') && /signs out too/.test(kView.html) && fulls(kView.html).length === 0)
  ok('[keyhash rules] console: unticked it revokes nothing, cross-site it is 403',
     cNo.status === 303 && (cNo.headers.get('location') ?? '').includes('keys=confirm') && cX.status === 403 && kAlive.every((s) => s === 200), `${cNo.status} ${cX.status} ${kAlive}`)
  ok('[keyhash rules] console, key session: ticked, both keys are dead, the session ends, and the sign-in page says to use /recover',
     cYes.status === 303 && cYes.headers.get('location') === '/app?err=revoked_all' && (await Promise.all(kk.map((k) => status(k)))).every((s) => s === 401)
       && kLanding.html.includes('agentbill.dev/recover') && !kLanding.html.includes('Signed in with a key'), `${cYes.status} ${cYes.headers.get('location')}`)

  // A person: signs in by email, makes the first key, revokes all, stays in, makes another.
  const pEmail = `keyhash-person-${randomBytes(4).toString('hex')}@example.invalid`
  await fetch(`${API}/auth/email`, { method: 'POST', redirect: 'manual', headers: { ...FORM, ...newNet() }, body: `email=${encodeURIComponent(pEmail)}` })
  let pMail = null
  for (let i = 0; i < 60 && !pMail; i++) { pMail = outboxLines().find((m) => m.to === pEmail && m.reason === 'signin'); if (!pMail) await settle(50) }
  const pTok = (pMail?.html.match(/\/auth\/email\/([A-Za-z0-9_-]{43})/) ?? [])[1] ?? ''
  const pIn = await fetch(`${API}/auth/email/${pTok}`, { method: 'POST', redirect: 'manual', headers: SAME })
  const person = cookieVal(pIn, 'agentbill_user')
  const pStart = await page('/app?view=start', person)
  const first = await fetch(`${API}/app/keys/first`, { method: 'POST', redirect: 'manual', headers: { ...SAME, cookie: person } }).then(async (r) => ({ status: r.status, html: await r.text() }))
  const firstKey = fulls(first.html)
  const personViews = await Promise.all(VIEWS.map((vw) => page(`/app${vw}`, person)))
  ok('[keyhash leak] a person\'s first key is on its one-time page, and on none of the console\'s views after it',
     !!person && pStart.html.includes('action="/app/keys/first"') && first.status === 200 && firstKey.length === 1 && await status(firstKey[0]) === 200
       && personViews.every((p) => p.status === 200 && fulls(p.html).length === 0) && personViews.some((p) => p.html.includes(mask(firstKey[0]))),
     `${first.status} ${firstKey.length} ${personViews.map((p) => `${p.status}:${fulls(p.html).length}`).join(',')}`)
  const pAll = await fetch(`${API}/app/keys/revoke-all`, { method: 'POST', redirect: 'manual', headers: { ...FORM, cookie: person }, body: 'confirm=yes' })
  const pAfter = await page(pAll.headers.get('location') ?? '/app', person)
  const pStart2 = await page('/app?view=start', person)
  ok('[keyhash rules] console, a person: revoke all kills the key, keeps the person signed in, and the start screen offers a new key',
     pAll.status === 303 && pAll.headers.get('location') === '/app?view=keys&keys=revoked_all' && await status(firstKey[0]) === 401
       && pAfter.html.includes('id="keys-flash"') && pStart2.html.includes('action="/app/keys/first"'), `${pAll.status} ${pAll.headers.get('location')}`)

  // ---------------------------------------------------------------- leak: every other surface
  const [acctOwnKey] = await sql`SELECT id FROM developer_api_keys WHERE account_id = ${accR.id} AND label = 'live'`
  const legacyLogin = await keyLogin(keyLive)
  const keyViews = await Promise.all(VIEWS.map((vw) => page(`/app${vw}`, legacyLogin.cookie)))
  const demoViews = await Promise.all(VIEWS.map((vw) => page(`/app?demo=1${vw ? `&${vw.slice(1)}` : ''}`, '')))
  ok('[keyhash leak] a key session: every console view renders, and none carries a whole key; the keys view marks this session\'s key by its id',
     !!acctOwnKey && keyViews.every((p) => p.status === 200 && fulls(p.html).length === 0) && keyViews[7].html.includes('this session') && keyViews[7].html.includes(mask(keyLive)),
     keyViews.map((p) => `${p.status}:${fulls(p.html).length}`).join(','))
  ok('[keyhash leak] and neither does the sample console', demoViews.every((p) => p.status === 200 && fulls(p.html).length === 0))
  const admin = await adminCookie()
  const adminPages = await Promise.all(['/admin', '/admin/accounts'].map((p) => page(p, admin)))
  ok('[keyhash leak] the admin pages carry no whole key', adminPages.every((p) => p.status === 200 && fulls(p.html).length === 0), adminPages.map((p) => p.status).join(','))
  const tools = await rpc(keyLive, 'tools/list')
  const toolTexts = [tools.text]
  for (const name of ['task_status', 'top_jobs', 'recent_refusals']) toolTexts.push((await rpc(keyLive, 'tools/call', { name, arguments: name === 'task_status' ? { task_ref: 'keyhash-none' } : {} })).text)
  ok('[keyhash leak] MCP: tools/list and every read tool answer without a whole key, and no tool makes or shows one',
     tools.status === 200 && toolTexts.every((t) => fulls(t).length === 0) && !(tools.json?.result?.tools ?? []).some((t) => /key/i.test(t.name)))
  const listR = await get('/keys', keyLive)
  ok('[keyhash leak] GET /keys, with revoked and expired keys on the account, returns none of them whole',
     listR.status === 200 && listR.body.keys.length === 3 && fulls(listR.text).length === 0 && listR.body.keys.every((k) => /^agb_[0-9a-f]{4}…[0-9a-f]{4}$/.test(k.key)))
  // The new-network mail names the key by its display form.
  const accI = await newAccount('ipmail')
  const keyI = shaped('ipmail')
  await insertKeyRow(sql, accI.id, keyI, 'ipmail')
  await get('/keys', keyI, API, { 'fly-client-ip': '192.0.2.10' })
  await get('/keys', keyI, API, { 'fly-client-ip': '192.0.2.99' })
  let ipMail = null
  for (let i = 0; i < 60 && !ipMail; i++) { ipMail = outboxLines().find((m) => m.to === accI.email && /new network/.test(m.subject)); if (!ipMail) await settle(50) }
  ok('[keyhash leak] the new-network alert names the key as agb_1234…abcd, never whole', !!ipMail && ipMail.html.includes(mask(keyI)) && fulls(ipMail.html).length === 0,
     ipMail ? ipMail.html.slice(0, 120) : 'no mail')

  // ---------------------------------------------------------------- prod: the same paths with NODE_ENV=production
  const LONG = 'keyhash-production-session-secret-0123456789'
  const prod = await bootS({ NODE_ENV: 'production', DATABASE_SSL: 'disable', DATABASE_SSL_INSECURE_OK: '1', APP_SESSION_SECRET: LONG }, portS)
  const PB = `http://localhost:${portS}`
  const accX = await newAccount('prod')
  const keyX = shaped('prod')
  await insertKeyRow(sql, accX.id, keyX, 'prod')
  const xList = await get('/keys', keyX, PB)
  const xGen = await post('/keys/generate', { label: 'prod-child', expires_in_days: 3 }, keyX, PB)
  const xRot = await post('/keys/rotate', {}, xGen.body?.api_key, PB)
  const xSess = await keyLogin(keyX, PB)
  const xView = await page('/app?view=keys', xSess.cookie, PB)
  const xMcp = await new Promise((resolve) => {
    import('node:http').then(({ request }) => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      const q = request({ host: 'localhost', port: portS, path: '/mcp', method: 'POST',
        headers: { ...MCPH, Host: 'agentbill.dev', Authorization: `Bearer ${keyX}`, 'Content-Length': Buffer.byteLength(body) } }, (res) => {
        let t = ''; res.on('data', (d) => { t += d }); res.on('end', () => resolve({ status: res.statusCode, text: t }))
      })
      q.on('error', (e) => resolve({ status: 0, text: String(e) }))
      q.end(body)
    })
  })
  const xAll = await post('/keys/revoke-all', { confirm: true }, keyX, PB)
  const xDead = await Promise.all([keyX, xGen.body?.api_key, xRot.body?.api_key].map((k) => status(k, PB)))
  const xView2 = await page('/app?view=keys', xSess.cookie, PB)
  const prodOut = prod.out()
  await stopS(prod)
  ok('[keyhash prod] NODE_ENV=production: REST by hash, generate (shown once), rotate with the hour\'s grace, the console key login, MCP Bearer on agentbill.dev',
     !prod.exited && xList.status === 200 && fulls(xList.text).length === 0 && xGen.status === 200 && fulls(xGen.text).length === 1
       && xRot.status === 200 && xRot.body.grace_minutes === 60 && xSess.status === 303 && xSess.location === '/app' && xView.status === 200 && fulls(xView.html).length === 0
       && xMcp.status === 200 && /"tools"/.test(xMcp.text),
     `${prod.exited} ${xList.status} ${xGen.status} ${xRot.status} ${xSess.status} ${xView.status} ${xMcp.status}`)
  ok('[keyhash prod] and revoke-all there: every key 401, the key session over, and the production server\'s own log holds no whole key',
     xAll.status === 200 && xAll.body.revoked_count === 3 && xDead.every((s) => s === 401) && !xView2.html.includes('Signed in with a key')
       && prodOut.length > 0 && fulls(prodOut).length === 0, `${xAll.status} ${xDead} ${fulls(prodOut).length}`)

  // ---------------------------------------------------------------- log: the net under the serializer
  // A request whose PATH is a live key. The request line is logged for every
  // request, so without the redaction this key would be in the log verbatim.
  await fetch(`${API}/keys/${keyLive}`)
  await fetch(`${API}/recover/${keyLive}`)
}

/**
 * The end-of-run checks, after every other gate has run and mailed: nothing
 * in the server's whole log or in any mail it sent carries a whole key.
 */
export function keyhashFinalGates({ ok, serverLog, outbox }) {
  let log = ''
  try { log = readFileSync(serverLog, 'utf8') } catch {}
  ok('[keyhash log] the server log never holds a whole key, the request whose path was one included; it says agb_[redacted] instead',
     log.length > 0 && fulls(log).length === 0 && log.includes('agb_[redacted]'), `${fulls(log).length} key(s) in ${log.length} bytes`)
  let mails = []
  try { mails = readFileSync(outbox, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch {}
  const leaking = mails.filter((m) => fulls(`${m.subject} ${m.html}`).length > 0)
  ok('[keyhash leak] no email the server sent in this run carries a whole key (signups, sign-in links, recovery, alerts, quota)',
     mails.length > 10 && leaking.length === 0, `${mails.length} mails, ${leaking.length} with a key: ${leaking.slice(0, 2).map((m) => m.subject).join(' | ')}`)
}
