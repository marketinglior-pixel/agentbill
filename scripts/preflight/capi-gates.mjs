// [capi] Meta Conversions API (2026-09-26): a new account made by a real
// email-link sign-in sends one CompleteRegistration to Meta, and only when the
// browser carries Meta's own cookie; a returning sign-in, or a browser with no
// Meta cookie, sends nothing. Against a local fake of graph.facebook.com
// (META_CAPI_TEST_BASE, honoured only outside production).
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

export async function capiGates({ API, sql, ok, bootS, stopS, portS }) {
  console.log('\n[capi]')
  let reached = false
  try {
    await gates({ API, sql, ok, bootS, stopS, portS })
    reached = true
  } catch (err) {
    ok('[capi] a gate threw', false, String(err?.stack ?? err).slice(0, 800))
  }
  ok('[capi] every gate ran to the end', reached)
}

const sha = (s) => createHash('sha256').update(s).digest('hex')
const settle = (ms) => new Promise((r) => setTimeout(r, ms))

async function gates({ API, sql, ok, bootS, stopS, portS }) {
  const got = []
  const fake = createServer((req, res) => {
    let b = ''
    req.on('data', (d) => { b += d })
    req.on('end', () => {
      let body = null
      try { body = JSON.parse(b) } catch { /* recorded as null */ }
      got.push({ method: req.method, url: req.url, body })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ events_received: 1 }))
    })
  })
  await new Promise((r) => fake.listen(0, '127.0.0.1', r))
  const FAKE = `http://127.0.0.1:${fake.address().port}`
  const dir = mkdtempSync(`${tmpdir()}/capi-gates-`)
  const outbox = `${dir}/outbox.jsonl`
  writeFileSync(outbox, '')

  const main = await fetch(`${API}/privacy`).then((r) => r.text())
  ok('[capi] the harness server has a pixel and no CAPI token: /privacy does not name the Conversions API', !main.includes('Conversions API'))

  const PIXEL = '1234567890'
  const test = await bootS({
    NODE_ENV: 'test', DATABASE_SSL: 'disable', RATE_LIMIT_PER_MINUTE: '100000', AUTH_FAILURES_PER_MINUTE: '100000',
    APP_SESSION_SECRET: 'capi-gates-session-secret-0123456789abcdef', MAIL_TEST_OUTBOX: outbox,
    META_PIXEL_ID: PIXEL, META_CAPI_ACCESS_TOKEN: 'capi_fake_token', META_CAPI_TEST_BASE: FAKE,
  }, portS)
  const TB = `http://localhost:${portS}`
  const FORM = { 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin' }
  const linksTo = (email) => readFileSync(outbox, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((x) => x.to === email && x.reason === 'signin')
  // The link from the mail sent AFTER `before` mails existed: an earlier,
  // already used link is not this sign-in's.
  const tokenFor = async (email, before) => {
    for (let i = 0; i < 60; i++) {
      const m = linksTo(email)[before]
      const t = (m?.html.match(/\/auth\/email\/([A-Za-z0-9_-]{43})/) ?? [])[1]
      if (t) return t
      await settle(50)
    }
    return ''
  }
  let net = 40
  const signIn = async (email, cookie) => {
    const ip = `198.18.26.${net++}`
    const before = linksTo(email).length
    await fetch(`${TB}/auth/email`, { method: 'POST', redirect: 'manual', headers: { ...FORM, 'fly-client-ip': ip }, body: `email=${encodeURIComponent(email)}` })
    const t = await tokenFor(email, before)
    const r = await fetch(`${TB}/auth/email/${t}`, { method: 'POST', redirect: 'manual',
      headers: { 'Sec-Fetch-Site': 'same-origin', 'fly-client-ip': ip, 'user-agent': 'capi-gates/1.0', ...(cookie ? { cookie } : {}) } })
    return { status: r.status, ip }
  }
  const waitGot = async (n) => { for (let i = 0; i < 40 && got.length < n; i++) await settle(50); return got.length }
  const E1 = `capi-one-${Date.now()}@example.invalid`
  const E2 = `capi-two-${Date.now()}@example.invalid`
  try {
    const FBP = 'fb.1.1790000000000.1234567890'
    const FBC = 'fb.1.1790000000000.IwAR0abc'
    const s1 = await signIn(E1, `_fbp=${FBP}; _fbc=${FBC}; other=x`)
    await waitGot(1)
    const [u1] = await sql`SELECT a.id FROM accounts a JOIN users u ON u.id = a.owner_user_id WHERE u.email = ${E1}`
    const e = got[0]?.body?.data?.[0] ?? {}
    const ud = e.user_data ?? {}
    ok('[capi] a new account from a browser with Meta\'s cookie sends exactly one CompleteRegistration to /v26.0/<pixel>/events',
       s1.status === 303 && !!u1 && got.length === 1 && got[0].method === 'POST' && got[0].url === `/v26.0/${PIXEL}/events`
         && e.event_name === 'CompleteRegistration' && e.action_source === 'website' && e.event_id === `signup-${sha(u1?.id ?? '').slice(0, 32)}`,
       JSON.stringify({ s1, got: got.map((g) => g.url), e }))
    ok('[capi] it carries hashes, never the address or the account id in the clear, plus the request\'s IP, user agent and both cookies',
       JSON.stringify(ud.em) === JSON.stringify([sha(E1)]) && JSON.stringify(ud.external_id) === JSON.stringify([sha(u1?.id ?? '')])
         && ud.client_ip_address === s1.ip && ud.client_user_agent === 'capi-gates/1.0' && ud.fbp === FBP && ud.fbc === FBC
         && !JSON.stringify(got[0].body).includes(E1) && !JSON.stringify(got[0].body).includes(u1?.id ?? 'none'),
       JSON.stringify(ud))
    ok('[capi] the token is in the body and never in the URL', got[0]?.body?.access_token === 'capi_fake_token' && !String(got[0]?.url).includes('token'),
       String(got[0]?.url))

    const again = await signIn(E1, `_fbp=${FBP}`)
    await settle(600)
    ok('[capi] the same person signing in again sends nothing more', again.status === 303 && got.length === 1, `got ${got.length}`)

    const s2 = await signIn(E2, 'other=x')
    await settle(600)
    const [u2] = await sql`SELECT a.id FROM accounts a JOIN users u ON u.id = a.owner_user_id WHERE u.email = ${E2}`
    ok('[capi] a new account from a browser with no Meta cookie sends nothing: the server does not route around a blocked pixel',
       s2.status === 303 && !!u2 && got.length === 1, `got ${got.length}`)

    const pp = await fetch(`${TB}/privacy`).then((r) => r.text())
    ok('[capi] with the token configured, /privacy names the Conversions API, the hashes and the cookie condition',
       pp.includes('Conversions API') && pp.includes('SHA-256 hash of your email address') && pp.includes('If your browser blocked the pixel, the server'))

    const { capiBase } = await import('../../dist/lib/capi.js')
    ok('[capi] production ignores META_CAPI_TEST_BASE, and a non-local test base is ignored everywhere',
       capiBase({ NODE_ENV: 'production', META_CAPI_TEST_BASE: FAKE }) === 'https://graph.facebook.com'
         && capiBase({ NODE_ENV: 'test', META_CAPI_TEST_BASE: FAKE }) === FAKE
         && capiBase({ NODE_ENV: 'test', META_CAPI_TEST_BASE: 'https://evil.example' }) === 'https://graph.facebook.com')
  } finally {
    await stopS(test)
    fake.close()
    // Best effort: these rows are the harness's own, on a throwaway database.
    for (const email of [E1, E2]) {
      try {
        await sql`DELETE FROM accounts WHERE owner_user_id IN (SELECT id FROM users WHERE email = ${email})`
        await sql`DELETE FROM users WHERE email = ${email}`
      } catch { /* left for the throwaway database */ }
    }
  }
}
