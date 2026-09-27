// [source] The campaign label an account was created under (2026-09-27,
// migration 037). A visitor who lands on /register?src=X and signs up keeps X
// on the account, whether the sign-up is an email link, Google or GitHub, so
// "did this campaign bring an account, and did that account make a call?" is
// a query rather than a guess from timestamps. Each gate reads the account row
// the path created. The label is written once: a later sign-in under another
// label never changes it, and a label outside the one shape src/lib/source.ts
// allows is stored as nothing, never cleaned into something else.
//
// Uses the fake providers (scripts/preflight/fake-oauth.mjs) and the mail
// outbox exactly as the [auth] gates do.
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

export async function sourceGates(opts) {
  console.log('\n[source] the campaign label an account was created under')
  let reached = false
  try {
    await gates(opts)
    reached = true
  } catch (err) {
    opts.ok('[source] a gate threw', false, String(err?.stack ?? err).slice(0, 600))
  }
  opts.ok('[source] every gate ran to the end', reached)
}

async function gates({ API, sql, ok, fakeBase, outbox, adminCookie }) {
  const rnd = () => randomBytes(5).toString('hex')
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const SAME = { 'Sec-Fetch-Site': 'same-origin' }
  const FORM = { 'Content-Type': 'application/x-www-form-urlencoded', ...SAME }
  let net = 30
  const newNet = () => ({ 'fly-client-ip': `198.19.${Math.floor(net / 250)}.${(net++ % 250) + 1}` })
  const settle = (ms) => new Promise((r) => setTimeout(r, ms))
  const cookieVal = (res, name) => (res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? '').split(';')[0]
  const LABEL = 'meta-office-v1'
  const acctOf = async (email) => (await sql`
    SELECT a.id, a.signup_source FROM accounts a JOIN users u ON u.id = a.owner_user_id WHERE u.email = ${email}`)[0]
  const linkOf = async (email) => {
    for (let i = 0; i < 60; i++) {
      let lines = []
      try { lines = readFileSync(outbox, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch {}
      const m = lines.filter((x) => x.to === email && x.reason === 'signin').pop()
      const tok = (m?.html.match(/\/auth\/email\/([A-Za-z0-9_-]{43})/) ?? [])[1]
      if (tok) return tok
      await settle(50)
    }
    return ''
  }
  const emailSignUp = async (email, body) => {
    await fetch(`${API}/auth/email`, { method: 'POST', redirect: 'manual', headers: { ...FORM, ...newNet() }, body })
    const tok = await linkOf(email)
    const [row] = await sql`SELECT source FROM email_sign_in_tokens WHERE email = ${email} ORDER BY id DESC LIMIT 1`
    const spent = tok ? await fetch(`${API}/auth/email/${tok}`, { method: 'POST', redirect: 'manual', headers: SAME }) : null
    return { tokenSource: row?.source ?? null, status: spent?.status ?? 0, acct: await acctOf(email) }
  }
  const oauth = async (provider, user, query) => {
    const s = await fetch(`${API}/auth/${provider}${query}`, { redirect: 'manual', headers: newNet() })
    const flow = cookieVal(s, 'agentbill_oauth')
    const u = new URL(s.headers.get('location') ?? '')
    u.searchParams.set('fake_user', b64(user))
    const a = await fetch(u, { redirect: 'manual' })
    const cb = new URL(a.headers.get('location') ?? '')
    return fetch(`${API}/auth/${provider}/callback?${new URLSearchParams({ code: cb.searchParams.get('code') ?? '', state: cb.searchParams.get('state') ?? '' })}`,
      { redirect: 'manual', headers: { cookie: flow } })
  }

  // The page carries the label to every way in.
  const page = await fetch(`${API}/register?src=${LABEL}`).then((r) => r.text())
  const bad = await fetch(`${API}/register?src=${encodeURIComponent('Meta"><script>')}`).then((r) => r.text())
  ok('[source] /register?src= puts the label on the Google and GitHub buttons and in the email form; a label of another shape goes nowhere',
     page.includes(`href="/auth/google?src=${LABEL}"`) && page.includes(`href="/auth/github?src=${LABEL}"`)
       && page.includes(`<input type="hidden" name="src" value="${LABEL}" />`)
       && !bad.includes('name="src"') && !/auth\/google\?src=/.test(bad) && !bad.includes('<script>"'),
     (page.match(/href="\/auth\/google[^"]*"/) ?? ['no google button'])[0])

  // Email link: the label waits on the token, then lands on the account.
  const e1 = `src-email-${rnd()}@example.com`
  const r1 = await emailSignUp(e1, `from=register&src=${LABEL}&email=${encodeURIComponent(e1)}`)
  ok('[source] an email sign-up from a tagged page keeps the label on the link, then on the account the link creates',
     r1.tokenSource === LABEL && r1.status === 303 && r1.acct?.signupSource === LABEL, JSON.stringify(r1))

  // Untagged, and a label of the wrong shape: no source, never a mangled one.
  const e2 = `src-none-${rnd()}@example.com`
  const r2 = await emailSignUp(e2, `from=register&email=${encodeURIComponent(e2)}`)
  const e3 = `src-bad-${rnd()}@example.com`
  const r3 = await emailSignUp(e3, `from=register&src=${encodeURIComponent('Meta Office; DROP')}&email=${encodeURIComponent(e3)}`)
  ok('[source] an untagged sign-up, and one whose label is not a label, both create an account with no source',
     r2.acct && r2.acct.signupSource === null && r2.tokenSource === null && r3.acct && r3.acct.signupSource === null && r3.tokenSource === null,
     JSON.stringify({ r2, r3 }))

  // Google and GitHub: the label rides in the signed flow cookie.
  const g = `src-google-${rnd()}@example.com`
  const gr = await oauth('google', { sub: `src-${rnd()}`, email: g, email_verified: true }, `?src=${LABEL}`)
  const h = `src-github-${rnd()}@example.com`
  const hr = await oauth('github', { id: Number.parseInt(rnd().slice(0, 7), 16), login: 'src', emails: [{ email: h, primary: true, verified: true }] }, `?src=${LABEL}`)
  const ga = await acctOf(g), ha = await acctOf(h)
  ok('[source] Google and GitHub sign-ups from a tagged page keep the label on the account they create',
     gr.status === 303 && ga?.signupSource === LABEL && hr.status === 303 && ha?.signupSource === LABEL,
     JSON.stringify({ google: [gr.status, ga], github: [hr.status, ha] }))

  // Written once: signing in again under another label changes nothing.
  const again = await oauth('google', { sub: (await sql`SELECT provider_user_id FROM user_identities i JOIN users u ON u.id = i.user_id WHERE u.email = ${g}`)[0].providerUserId, email: g, email_verified: true }, '?src=other-campaign')
  const r1b = await emailSignUp(e1, `from=login&src=other-campaign&email=${encodeURIComponent(e1)}`)
  ok('[source] a later sign-in under another label never changes the label the account was created under',
     again.status === 303 && (await acctOf(g))?.signupSource === LABEL && r1b.acct?.signupSource === LABEL,
     JSON.stringify({ google: (await acctOf(g))?.signupSource, email: r1b.acct?.signupSource }))

  // The owner reads it.
  const admin = await fetch(`${API}/admin`, { headers: { cookie: await adminCookie(), 'fly-client-ip': '203.0.113.251' } }).then((r) => r.text())
  const section = admin.match(/<h2 id="signups">[\s\S]*?<h2 id="rejections">/)?.[0] ?? ''
  const row = section.match(new RegExp(`<code>${LABEL}</code></td>\\s*<td[^>]*>(\\d+)`))
  ok('[source] /admin counts the three accounts this file created under the label (email, Google, GitHub), none of them with a call yet',
     !!row && Number(row[1]) === 3 && new RegExp(`<code>${LABEL}</code></td>\\s*<td[^>]*>3 <span class="muted">/ 3</span></td>\\s*<td[^>]*>0</td>`).test(section),
     (section.match(new RegExp(`<code>${LABEL}</code>[\\s\\S]{0,200}`)) ?? [section.slice(0, 240)])[0])

  await sql`DELETE FROM accounts WHERE owner_user_id IN (SELECT id FROM users WHERE email LIKE 'src-%@example.com')`
  await sql`DELETE FROM users WHERE email LIKE 'src-%@example.com'`
}
