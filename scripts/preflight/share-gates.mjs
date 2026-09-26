// [share] Public links to the office (2026-09-26, Lior: the owner chooses
// whether agent names and dollar amounts are shown). Every promise the console
// and the privacy page make about a link is read back from the server here:
// what a stranger's page contains with each choice, that the card is checked
// before it is stored, that the page is a frozen snapshot, that stopping
// deletes what it published, and that one account cannot touch another's link.
import { insertKeyRow } from './key-fixture.mjs'
import { createHash, randomBytes } from 'node:crypto'
import { deflateSync, crc32 } from 'node:zlib'

const shaped = (tag) => 'agb_' + createHash('sha256').update(`${tag}-${randomBytes(6).toString('hex')}`).digest('hex').slice(0, 48)
const visible = (h) => h.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ')

// A real PNG, built here without a canvas: chunks with their CRCs, rows of one colour.
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function png({ w = 1200, h = 630, extra = [], tail = Buffer.alloc(0), breakCrc = false } = {}) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6
  const row = Buffer.alloc(1 + w * 4, 0x33); row[0] = 0
  const idat = chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: h }, () => row))))
  if (breakCrc) idat[idat.length - 1] ^= 0xff
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...extra, idat, chunk('IEND', Buffer.alloc(0)), tail])
}
const dataUrl = (buf) => 'data:image/png;base64,' + buf.toString('base64')

export async function shareGates({ API, sql, ok }) {
  console.log('\n[share]')
  let reached = false
  const A = '00000000-0000-0000-0000-00000000b5e1', B = '00000000-0000-0000-0000-00000000b5e2'
  try {
    await gates({ API, sql, ok, A, B })
    reached = true
  } catch (err) {
    ok('[share] a gate threw', false, String(err?.stack ?? err).slice(0, 800))
  } finally {
    await sql`DELETE FROM accounts WHERE id IN (${A}, ${B})`
  }
  ok('[share] every gate ran to the end', reached)
}

async function gates({ API, sql, ok, A, B }) {
  await sql`DELETE FROM accounts WHERE id IN (${A}, ${B})`
  for (const id of [A, B]) await sql`INSERT INTO accounts (id, plan, monthly_calls, billing_period_start) VALUES (${id}, 'free', 0, date_trunc('month', CURRENT_DATE)::date)`
  const KA = shaped('share-a'), KB = shaped('share-b')
  await insertKeyRow(sql, A, KA, 'share')
  await insertKeyRow(sql, B, KB, 'share')
  const login = async (key, net) => (await fetch(`${API}/app/session`, { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'same-origin', 'fly-client-ip': net }, body: `api_key=${key}` }))
    .headers.get('set-cookie')?.split(';')[0] ?? ''
  const ckA = await login(KA, '198.18.55.1'), ckB = await login(KB, '198.18.55.2')
  const post = (ck, path, form, site = 'same-origin') => fetch(`${API}${path}`, { method: 'POST', redirect: 'manual',
    headers: { cookie: ck, 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': site, 'fly-client-ip': '198.18.55.1' },
    body: new URLSearchParams(form).toString() })
  const share = async (ck, form) => { const r = await post(ck, '/app/office/share', form); return { status: r.status, to: r.headers.get('location') ?? '' } }
  const rows = (acct) => sql`SELECT id, token, show_names, show_usd, snapshot, card_png, stopped_at FROM office_shares WHERE account_id = ${acct} ORDER BY created_at`

  // The office to share: four agents, one of them named to break out of HTML,
  // priced calls this month, and a refusal so one is sent home.
  const EVIL = '<script>alert("x")</script>&"bot'
  const NAMES = ['alpha-support-bot', 'beta-lead-enricher', 'gamma-invoice-reader', EVIL]
  const [cust] = await sql`INSERT INTO customers (account_id, customer_ref) VALUES (${A}, 'default') RETURNING id`
  for (const [i, name] of NAMES.entries()) for (let k = 0; k <= i; k++)
    await sql`INSERT INTO events (account_id, customer_id, event_type, units, idempotency_key, metadata, list_price_usd, created_at)
              VALUES (${A}, ${cust.id}, ${name}, 1, ${'sh-' + randomBytes(6).toString('hex')}, '{}'::jsonb, ${1.25 + i}, now() - interval '2 days')`
  await sql`INSERT INTO preflight_decisions (account_id, agent_id, reason, source, blocked, snapshot) VALUES (${A}, ${NAMES[0]}, 'task_ceiling_exceeded', 'preflight', true, '{}'::json)`
  const card = png()

  // Cross-site, and no session: nothing is made.
  const cross = await post(ckA, '/app/office/share', { names: '1', usd: '1', card: dataUrl(card) }, 'cross-site')
  const anon = await post('', '/app/office/share', { names: '1', usd: '1' })
  ok('[share] a cross-site POST is 403 and a POST with no session makes nothing',
     cross.status === 403 && anon.status === 303 && (await rows(A)).length === 0, `${cross.status} ${anon.status}`)

  // 1. Names hidden, dollars shown, with a card.
  const s1 = await share(ckA, { usd: '1', card: dataUrl(card) })
  const [r1] = await rows(A)
  ok('[share] a link is made: 303 back to the office with share=made, never the token in the URL',
     s1.status === 303 && s1.to.includes('share=made') && r1 && !s1.to.includes(r1.token) && r1.showNames === false && r1.showUsd === true,
     JSON.stringify(s1))
  const p1 = await fetch(`${API}/share/${r1.token}`)
  const h1 = await p1.text()
  ok('[share] names hidden: no real agent name anywhere in the page, its data or its metadata; the agents are "agent 1".."agent 4"',
     p1.status === 200 && NAMES.every((n) => !h1.includes(n) && !h1.includes(n.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c])))
       && ['agent 1', 'agent 4'].every((n) => h1.includes(n)) && !h1.includes('alpha') && !h1.includes('gamma'),
     NAMES.filter((n) => h1.includes(n)).join(', ') || `status ${p1.status}`)
  const snap1 = r1.snapshot
  ok('[share] the stored snapshot holds no real name either: the choice is applied on the server, not in the page',
     !JSON.stringify(snap1).includes('alpha') && snap1.agents.length === 4 && snap1.agents.every((a) => /^agent [1-4]$/.test(a.name)) && snap1.usdHidden === false
       && snap1.summary.payroll > 0 && /^agent [1-4]$/.test(snap1.summary.top?.name ?? ''),
     JSON.stringify(snap1).slice(0, 200))
  ok('[share] the page is noindex (header and meta), carries its own card as og:image, and loads only /app/office.js',
     p1.headers.get('x-robots-tag') === 'noindex' && /<meta name="robots" content="noindex"/.test(h1)
       && h1.includes(`<meta property="og:image" content="https://agentbill.dev/share/${r1.token}/card.png"`)
       && /script-src 'self'/.test(h1) && !/<script>(?!<\/script>)/.test(h1.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, '')),
     h1.match(/<meta property="og:image"[^>]*>/)?.[0] ?? 'no og:image')
  const c1 = await fetch(`${API}/share/${r1.token}/card.png`)
  const b1 = Buffer.from(await c1.arrayBuffer())
  ok('[share] the card is served as the exact bytes stored, as image/png with nosniff and a sandboxing policy',
     c1.status === 200 && c1.headers.get('content-type') === 'image/png' && c1.headers.get('x-content-type-options') === 'nosniff'
       && /sandbox/.test(c1.headers.get('content-security-policy') ?? '') && b1.equals(card),
     `${c1.status} ${c1.headers.get('content-type')} ${b1.length}`)

  // 2. Names shown, dollars hidden, one name hostile.
  const s2 = await share(ckA, { names: '1', card: dataUrl(card) })
  const r2 = (await rows(A))[1]
  const h2 = await (await fetch(`${API}/share/${r2.token}`)).text()
  const snap2 = r2.snapshot
  ok('[share] dollars hidden: no salary, payroll or amount in the snapshot, and no "$" figure anywhere a reader or a crawler reads',
     s2.to.includes('share=made') && snap2.usdHidden === true && snap2.summary.payroll === null && snap2.agents.every((a) => a.sal === null)
       && (snap2.summary.top?.sal ?? null) === null && !/\$\d/.test(h2.replace(/<style[\s\S]*?<\/style>/g, '')) && !/\$\d/.test(snap2.shareText),
     (h2.replace(/<style[\s\S]*?<\/style>/g, '').match(/.{0,40}\$\d.{0,20}/) ?? [''])[0])
  ok('[share] names shown: a hostile agent name is on the page only escaped, never as markup',
     h2.includes('alpha-support-bot') && !h2.includes('<script>alert') && !h2.includes('"bot') && h2.includes('\\u003cscript\\u003e'),
     (h2.match(/.{0,30}alert.{0,30}/) ?? ['no hostile name'])[0])

  // The card is checked: each of these makes no link.
  const before = (await rows(A)).length
  const bad = {
    'wrong size': dataUrl(png({ w: 600, h: 315 })),
    'a text chunk': dataUrl(png({ extra: [chunk('tEXt', Buffer.from('Comment\0hello'))] })),
    'a broken CRC': dataUrl(png({ breakCrc: true })),
    'bytes after IEND': dataUrl(png({ tail: Buffer.from('<html>') })),
    'not a PNG': 'data:image/png;base64,' + Buffer.from('GIF89a not a png at all').toString('base64'),
    'another type': 'data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64'),
  }
  const refused = []
  for (const [what, value] of Object.entries(bad)) { const r = await share(ckA, { usd: '1', card: value }); if (!r.to.includes('share=bad_card')) refused.push(`${what}: ${r.to}`) }
  ok('[share] a card that is the wrong size, carries a text chunk, has a broken CRC, trails bytes, is not a PNG or is another type is refused, and no link is made',
     refused.length === 0 && (await rows(A)).length === before, refused.join('; ') || 'all refused')

  // Without JavaScript there is no card: a link is made, and the page shares the site's card.
  const s3 = await share(ckA, { usd: '1' })
  const r3 = (await rows(A))[before]
  const h3 = await (await fetch(`${API}/share/${r3.token}`)).text()
  const c3 = await fetch(`${API}/share/${r3.token}/card.png`)
  ok('[share] a link made with no card works, points og:image at the site card, and has no card.png',
     s3.to.includes('share=made') && r3.cardPng === null && !h3.includes(`/share/${r3.token}/card.png`) && /og:image" content="https:\/\/agentbill\.dev\/og\.png/.test(h3) && c3.status === 404,
     (h3.match(/<meta property="og:image"[^>]*>/) ?? [''])[0])

  // A snapshot: a call recorded after the link was made does not reach it.
  await sql`INSERT INTO events (account_id, customer_id, event_type, units, idempotency_key, metadata, list_price_usd)
            VALUES (${A}, ${cust.id}, 'delta-late-hire', 1, ${'sh-late-' + randomBytes(4).toString('hex')}, '{}'::jsonb, 99)`
  const h2b = await (await fetch(`${API}/share/${r2.token}`)).text()
  ok('[share] the page is frozen: an agent that joins after the link was made is not on it',
     !h2b.includes('delta-late-hire') && h2b.includes('alpha-support-bot'))

  // Another account cannot stop it; its owner can, and that deletes what it published.
  const other = await post(ckB, `/app/office/share/${r2.id}/stop`, {})
  const stillUp = (await fetch(`${API}/share/${r2.token}`)).status
  const mine = await post(ckA, `/app/office/share/${r2.id}/stop`, {})
  const [after] = await sql`SELECT stopped_at IS NOT NULL AS stopped, card_png IS NULL AS no_card, snapshot::text AS snap FROM office_shares WHERE id = ${r2.id}`
  const gone = await fetch(`${API}/share/${r2.token}`), goneCard = await fetch(`${API}/share/${r2.token}/card.png`)
  ok('[share] another account\'s stop is not_found and changes nothing; the owner\'s stop makes page and card 404 and deletes the card and the snapshot',
     (other.headers.get('location') ?? '').includes('share=not_found') && stillUp === 200 && (mine.headers.get('location') ?? '').includes('share=stopped')
       && gone.status === 404 && goneCard.status === 404 && after.stopped && after.noCard && after.snap === '{}',
     `${other.headers.get('location')} ${stillUp} ${gone.status} ${goneCard.status} ${JSON.stringify(after)}`)
  const crossStop = await post(ckA, `/app/office/share/${r1.id}/stop`, {}, 'cross-site')
  ok('[share] a cross-site stop is 403 and the link stays up', crossStop.status === 403 && (await fetch(`${API}/share/${r1.token}`)).status === 200)

  // Tokens that were never issued, malformed ones, and a path trick: one 404.
  const probes = ['AAAAAAAAAAAAAAAAAAAAAAAA', 'short', `${r1.token}x`, '..%2F..%2Fapp']
  const probeCodes = await Promise.all(probes.map(async (t) => (await fetch(`${API}/share/${t}`)).status))
  ok('[share] an unknown, malformed or tampered token is 404, the same as a stopped one', probeCodes.every((c) => c === 404), probeCodes.join(','))

  // The console lists the account's own live links, and only those.
  const office = await (await fetch(`${API}/app?view=office`, { headers: { cookie: ckA, 'fly-client-ip': '198.18.55.1' } })).text()
  const officeB = await (await fetch(`${API}/app?view=office`, { headers: { cookie: ckB, 'fly-client-ip': '198.18.55.2' } })).text()
  ok('[share] the office view lists this account\'s live links with Stop sharing, not stopped ones, and not to another account',
     office.includes(`/share/${r1.token}`) && office.includes(`/share/${r3.token}`) && !office.includes(`/share/${r2.token}`)
       && office.includes('Stop sharing') && !officeB.includes(r1.token) && visible(office).includes('names hidden · dollars shown'),
     visible(office.match(/<section class="of-links"[\s\S]*?<\/section>/)?.[0] ?? '').slice(0, 200))

  // The day's limit counts stopped links too.
  const { SHARES_PER_DAY } = await import('../../dist/lib/share.js')
  const made = (await rows(A)).length
  let last = ''
  for (let i = made; i <= SHARES_PER_DAY; i++) last = (await share(ckA, { usd: '1' })).to
  ok(`[share] the ${SHARES_PER_DAY + 1}th link in a UTC day is refused with day_limit, stopped links counted`,
     last.includes('share=day_limit') && (await rows(A)).length === SHARES_PER_DAY, `${last} rows=${(await rows(A)).length}`)

  // The sample console offers no link, and robots.txt lets a preview crawler read one.
  const demo = await (await fetch(`${API}/app?demo=1&view=office`)).text()
  const robots = await (await fetch(`${API}/robots.txt`)).text()
  ok('[share] the sample console has no Create a public link, and robots.txt does not disallow /share',
     !demo.includes('Create a public link') && demo.includes('The sample console has nothing of yours to publish') && !/Disallow:\s*\/share/i.test(robots))
}
