// [inbound] hello@agentbill.dev (2026-09-25): POST /webhooks/resend verifies
// Resend's Svix signature, claims each delivery once (migration 031), forwards
// mail addressed to hello@ to the owner with Reply-To set to the sender, and
// stops at a per-day and a per-sender ceiling.
//
// Signed with svix, the library the Resend SDK verifies with, and forwarded
// against a local fake of Resend's API (RESEND_BASE_URL, read by the SDK
// itself). Nothing here talks to Resend.
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'

export async function inboundGates({ API, sql, ok, bootS, stopS, portS }) {
  console.log('\n[inbound]')
  let reached = false
  try {
    await gates({ API, sql, ok, bootS, stopS, portS })
    reached = true
  } catch (err) {
    ok('[inbound] a gate threw', false, String(err?.stack ?? err).slice(0, 800))
  }
  ok('[inbound] every gate ran to the end', reached)
}

async function gates({ API, sql, ok, bootS, stopS, portS }) {
  const { Webhook } = await import('svix')
  const SECRET = 'whsec_' + Buffer.from('inbound-gates-secret-0123456789abcdef').toString('base64')
  const wh = new Webhook(SECRET)
  const other = new Webhook('whsec_' + Buffer.from('some-other-secret-0123456789abcdef').toString('base64'))
  const OWNER = 'owner-inbound@example.invalid'

  // The fake Resend API: GET /emails/receiving/:id answers from `mails`,
  // POST /emails records what would have been sent. Two ids misbehave on send.
  const mails = new Map()
  const sent = []
  let fail5xxOnce = new Set(['em_retry'])
  const fake = createServer((req, res) => {
    let b = ''
    req.on('data', (d) => { b += d })
    req.on('end', () => {
      const json = (code, v) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)) }
      const m = /^\/emails\/receiving\/([^/?]+)$/.exec(req.url ?? '')
      if (req.method === 'GET' && m) {
        const e = mails.get(decodeURIComponent(m[1]))
        return e ? json(200, e) : json(404, { name: 'not_found', message: 'Email not found', statusCode: 404 })
      }
      if (req.method === 'POST' && req.url === '/emails') {
        let body = {}
        try { body = JSON.parse(b) } catch { /* recorded as empty */ }
        const tag = String(body.subject ?? '')
        if ([...fail5xxOnce].some((id) => tag.includes(id))) {
          fail5xxOnce = new Set([...fail5xxOnce].filter((id) => !tag.includes(id)))
          return json(500, { name: 'internal_server_error', message: 'boom', statusCode: 500 })
        }
        if (tag.includes('em_reject')) return json(422, { name: 'validation_error', message: 'bad reply_to', statusCode: 422 })
        sent.push(body)
        return json(200, { id: `sent_${sent.length}` })
      }
      json(404, { name: 'not_found', message: 'no route', statusCode: 404 })
    })
  })
  await new Promise((r) => fake.listen(0, '127.0.0.1', r))
  const FAKE = `http://127.0.0.1:${fake.address().port}`

  const mail = (id, over = {}) => {
    const e = {
      object: 'email', id, to: ['hello@agentbill.dev'], from: 'Dana Tester <dana@example.com>',
      created_at: '2026-09-25T20:00:00.000Z', subject: `Question about AgentBill ${id}`, bcc: null, cc: null,
      reply_to: null, html: '<p>Hi, <b>does it work?</b></p>', text: 'Hi, does it work?', headers: {},
      message_id: `<${id}@example.com>`, attachments: [], ...over,
    }
    mails.set(id, e)
    return e
  }
  let seq = 0
  const post = async (base, data, { signer = wh, id, type = 'email.received', headers = {} } = {}) => {
    const body = JSON.stringify({ type, created_at: '2026-09-25T20:00:00.000Z', data })
    const msgId = id ?? `msg_inbound_${seq++}_${Math.random().toString(36).slice(2, 8)}`
    const sig = signer ? signer.sign(msgId, new Date(), body) : ''
    const r = await fetch(`${base}/webhooks/resend`, { method: 'POST', body, headers: {
      'Content-Type': 'application/json', ...(signer ? { 'svix-id': msgId, 'svix-timestamp': String(Math.floor(Date.now() / 1000)), 'svix-signature': sig } : {}), ...headers } })
    return { status: r.status, body: await r.json().catch(() => null), msgId }
  }
  const ev = (e) => ({ email_id: e.id, created_at: e.created_at, from: e.from, to: e.to, cc: e.cc ?? [], bcc: [], message_id: e.message_id, subject: e.subject, attachments: [] })
  const rows = async (emailId) => sql`SELECT webhook_id, outcome, sender_hash FROM inbound_mail_deliveries WHERE email_id = ${emailId}`

  // The main harness server has no RESEND_INBOUND_WEBHOOK_SECRET.
  const unset = await post(API, ev(mail('em_unset')))
  ok('[inbound] with RESEND_INBOUND_WEBHOOK_SECRET unset the route answers 503 and forwards nothing', unset.status === 503 && sent.length === 0, JSON.stringify(unset))

  await sql`DELETE FROM inbound_mail_deliveries WHERE email_id LIKE 'em_%'`
  const test = await bootS({
    NODE_ENV: 'test', DATABASE_SSL: 'disable', RATE_LIMIT_PER_MINUTE: '100000',
    RESEND_API_KEY: 're_fake_inbound', RESEND_BASE_URL: FAKE, OWNER_ALERT_EMAIL: OWNER, RESEND_INBOUND_WEBHOOK_SECRET: SECRET,
  }, portS)
  const TB = `http://localhost:${portS}`
  try {
    const u = await post(TB, ev(mail('em_unsigned')), { signer: null })
    const w = await post(TB, ev(mail('em_wrongsig')), { signer: other })
    ok('[inbound] an unsigned delivery and one signed with another secret are both 401, and nothing is forwarded or claimed',
       u.status === 401 && w.status === 401 && sent.length === 0
         && (await rows('em_unsigned')).length === 0 && (await rows('em_wrongsig')).length === 0, `${u.status} ${w.status} sent ${sent.length}`)

    const e1 = mail('em_first', { from: '"Ev<i>l" <eve@example.com>', cc: ['Someone <cc@example.com>'] })
    const f1 = await post(TB, ev(e1))
    const s1 = sent[0] ?? {}
    ok('[inbound] a signed email.received to hello@ is forwarded to the owner, from our domain, with Reply-To the sender',
       f1.status === 200 && f1.body?.forwarded === true && sent.length === 1
         && (s1.to === OWNER || (Array.isArray(s1.to) && s1.to.length === 1 && s1.to[0] === OWNER)),
       JSON.stringify({ f1, to: s1.to }))
    ok('[inbound] the forward is from forward@agentbill.dev, Reply-To is the original sender, and the subject is tagged',
       String(s1.from) === 'AgentBill inbox <forward@agentbill.dev>' && !/@/.test(String(s1.from).split('<')[0]) && JSON.stringify(s1.reply_to) === JSON.stringify(['"Ev<i>l" <eve@example.com>'])
         && s1.subject === '[hello@] Question about AgentBill em_first',
       JSON.stringify({ from: s1.from, reply_to: s1.reply_to, subject: s1.subject }))
    ok('[inbound] the header block escapes the sender (no raw <i> from a display name) and keeps the original body',
       String(s1.html).includes('Ev&lt;i&gt;l') && !String(s1.html).split('</div>')[0].includes('<i>')
         && String(s1.html).includes('<b>does it work?</b>') && String(s1.text).includes('Cc: Someone <cc@example.com>'),
       String(s1.html).slice(0, 400))
    const r1 = await rows('em_first')
    ok('[inbound] the claim row holds ids, an outcome and a hash, never the address',
       r1.length === 1 && r1[0].outcome === 'forwarded' && r1[0].senderHash === createHash('sha256').update('eve@example.com').digest('hex')
         && !JSON.stringify(r1).includes('eve@'), JSON.stringify(r1))

    const again = await post(TB, ev(e1), { id: f1.msgId })
    ok('[inbound] the same svix-id delivered again forwards nothing more', again.status === 200 && again.body?.duplicate === true && sent.length === 1, JSON.stringify(again))

    const e2 = mail('em_other', { to: ['sales@agentbill.dev'] })
    const f2 = await post(TB, ev(e2))
    const e3 = mail('em_own', { from: 'AgentBill <alerts@agentbill.dev>' })
    const f3 = await post(TB, ev(e3))
    const f4 = await post(TB, { id: 'x' }, { type: 'email.delivered' })
    ok('[inbound] mail to another address at the domain, mail from our own domain, and a non-received event are 200, not forwarded, not claimed',
       f2.status === 200 && f2.body?.forwarded === false && f3.status === 200 && f3.body?.forwarded === false && f4.status === 200
         && sent.length === 1 && (await rows('em_other')).length === 0 && (await rows('em_own')).length === 0,
       JSON.stringify({ f2, f3, f4, sent: sent.length }))

    const e5 = mail('em_retry')
    const f5 = await post(TB, ev(e5))
    const afterFail = await rows('em_retry')
    const f5b = await post(TB, ev(e5), { id: f5.msgId })
    ok('[inbound] a 5xx from Resend answers 503 and gives the claim back, and the retry with the same svix-id is forwarded',
       f5.status === 503 && afterFail.length === 0 && f5b.status === 200 && f5b.body?.forwarded === true && sent.length === 2
         && (await rows('em_retry'))[0]?.outcome === 'forwarded', JSON.stringify({ f5, afterFail, f5b }))

    const e6 = mail('em_reject')
    const f6 = await post(TB, ev(e6))
    ok('[inbound] a 4xx from Resend is final: 200, not forwarded, outcome failed, so Resend stops retrying',
       f6.status === 200 && f6.body?.forwarded === false && (await rows('em_reject'))[0]?.outcome === 'failed' && sent.length === 2,
       JSON.stringify(f6))

    // Per sender: ten earlier rows today for one address, then the eleventh.
    const spam = createHash('sha256').update('spam@example.com').digest('hex')
    for (let i = 0; i < 10; i++) {
      await sql`INSERT INTO inbound_mail_deliveries (webhook_id, email_id, sender_hash, outcome, received_at) VALUES (${'msg_seed_s' + i}, ${'em_seed_s' + i}, ${spam}, 'forwarded', now() - interval '1 second')`
    }
    const f7 = await post(TB, ev(mail('em_spam', { from: 'spam@example.com' })))
    const f8 = await post(TB, ev(mail('em_notspam', { from: 'real@example.com' })))
    ok('[inbound] the 11th mail today from one sender is kept in Resend, not forwarded, and another sender still is',
       f7.status === 200 && f7.body?.forwarded === false && (await rows('em_spam'))[0]?.outcome === 'capped_sender'
         && f8.body?.forwarded === true && sent.length === 3, JSON.stringify({ f7, f8, sent: sent.length }))

    // Per day: fill the day to exactly INBOUND_PER_DAY rows before the next.
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM inbound_mail_deliveries WHERE received_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`
    for (let i = n; i < 100; i++) {
      await sql`INSERT INTO inbound_mail_deliveries (webhook_id, email_id, sender_hash, outcome, received_at) VALUES (${'msg_seed_d' + i}, ${'em_seed_d' + i}, ${'h' + i}, 'forwarded', now() - interval '1 second')`
    }
    const f9 = await post(TB, ev(mail('em_day1', { from: 'late1@example.com' })))
    const f10 = await post(TB, ev(mail('em_day2', { from: 'late2@example.com' })))
    await new Promise((r) => setTimeout(r, 300))
    const notices = sent.filter((s) => String(s.subject).includes('forwarding paused'))
    ok('[inbound] past 100 today nothing more is forwarded, and the owner gets exactly one notice',
       f9.body?.forwarded === false && f10.body?.forwarded === false && (await rows('em_day1'))[0]?.outcome === 'capped_day'
         && notices.length === 1 && sent.filter((s) => String(s.subject).startsWith('[hello@]')).length === 3,
       JSON.stringify({ f9, f10, notices: notices.length, sent: sent.map((s) => s.subject) }))
  } finally {
    await stopS(test)
    fake.close()
    await sql`DELETE FROM inbound_mail_deliveries WHERE email_id LIKE 'em_%'`
  }
}
