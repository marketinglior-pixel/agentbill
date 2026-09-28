// [otel] Claude Code's telemetry, received at /otel/v1/logs (2026-09-28).
//
// The fixture is the shape of a real export: Claude Code 2.1.274, claude -p,
// OTEL_EXPORTER_OTLP_PROTOCOL=http/json, read off a local listener. Its
// api_request record's token counts and cost_usd are that export's own
// (haiku 4.5: 10 in, 60 out, 20,828 cache reads, 10,407 cache writes,
// $0.0232068), so the price gate checks our table against Claude Code's
// figure, not against a number written here. The ids, the email and the
// prompt are fixture values, and the privacy gates look for exactly those.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { insertKeyRow } from './key-fixture.mjs'

export async function otelGates(opts) {
  console.log('\n[otel] Claude Code telemetry at /otel/v1/logs')
  let reached = false
  try {
    await gates(opts)
    reached = true
  } catch (err) {
    opts.ok('[otel] a gate threw', false, String(err?.stack ?? err).slice(0, 600))
  }
  opts.ok('[otel] every gate ran to the end', reached)
}

async function gates({ API, sql, ok }) {
  const A = '00000000-0000-0000-0000-0000000000e1'
  const KA = 'agb_' + createHash('sha256').update(`otel-${randomBytes(6).toString('hex')}`).digest('hex').slice(0, 48)
  await sql`DELETE FROM accounts WHERE id = ${A}`
  await sql`INSERT INTO accounts (id, plan, monthly_calls, billing_period_start) VALUES (${A}, 'scale', 0, date_trunc('month', CURRENT_DATE)::date)`
  await insertKeyRow(sql, A, KA, 'harness-otel')

  const EMAIL = `otel-fixture-${randomBytes(3).toString('hex')}@example.com`
  const ACCT = randomUUID(), ORG = randomUUID(), USER = randomBytes(16).toString('hex')
  const PROMPT = `OTEL-SECRET-PROMPT-${randomBytes(4).toString('hex')}`
  const s = (key, v) => ({ key, value: typeof v === 'number' ? (Number.isInteger(v) ? { intValue: v } : { doubleValue: v }) : { stringValue: String(v) } })
  const std = (session, extra = {}) => [
    ...Object.entries(extra).map(([k, v]) => s(k, v)),
    s('user.id', USER), s('session.id', session), s('organization.id', ORG), s('user.email', EMAIL),
    s('user.account_uuid', ACCT), s('user.account_id', `user_${ACCT.slice(0, 8)}`), s('terminal.type', 'non-interactive'),
  ]
  const apiRecord = (session, reqId, t, extra = {}) => ({
    timeUnixNano: '1790602844738000000', observedTimeUnixNano: '1790602844738000000',
    body: { stringValue: 'claude_code.api_request' }, droppedAttributesCount: 0,
    attributes: [...std(session, extra), s('event.name', 'api_request'), s('event.timestamp', '2026-09-28T13:40:44.738Z'),
      s('event.sequence', 14), s('prompt.id', randomUUID()), s('model', t.model ?? 'claude-haiku-4-5-20251001'),
      s('input_tokens', t.input), s('output_tokens', t.output), s('cache_read_tokens', t.cr), s('cache_creation_tokens', t.cw),
      s('cost_usd', t.cost), s('cost_usd_micros', Math.round(t.cost * 1e6)), s('duration_ms', 1265), s('ttft_ms', 748),
      s('request_id', reqId), s('client_request_id', randomUUID()), s('speed', 'normal'), s('query_source', 'sdk')],
  })
  const promptRecord = (session) => ({
    timeUnixNano: '1790602844000000000', body: { stringValue: 'claude_code.user_prompt' },
    attributes: [...std(session), s('event.name', 'user_prompt'), s('prompt_length', PROMPT.length), s('prompt', PROMPT)],
  })
  const exportOf = (records, resource = { client: 'acme-dental', agent: 'support-bot' }) => ({
    resourceLogs: [{
      resource: { attributes: [...Object.entries(resource).map(([k, v]) => s(k, v)), s('service.name', 'claude-code'), s('service.version', '2.1.274')] },
      scopeLogs: [{ scope: { name: 'com.anthropic.claude_code.events', version: '2.1.274' }, logRecords: records }],
    }],
  })
  const post = (path, body, { key = KA, type = 'application/json', encoding } = {}) => fetch(`${API}${path}`, {
    method: 'POST',
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': type, ...(encoding ? { 'Content-Encoding': encoding } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
  const events = async () => sql`
    SELECT e.event_type, e.units, e.list_price_usd::text AS usd, e.metadata::text AS meta, e.idempotency_key, c.customer_ref
    FROM events e JOIN customers c ON c.id = e.customer_id WHERE e.account_id = ${A} ORDER BY e.created_at, e.id`
    .then((rows) => rows.map((r) => ({ ...r, metadata: JSON.parse(r.meta ?? '{}') })))  // raw keys: the harness's sql camel-cases jsonb
  const { priceCall } = await import('../../dist/lib/prices.js')

  // One real-shaped export: a prompt event and one API request.
  const S1 = randomUUID(), R1 = `req_${randomBytes(12).toString('hex')}`
  const REAL = { input: 10, output: 60, cr: 20828, cw: 10407, cost: 0.0232068 }
  const first = await post('/otel/v1/logs', exportOf([promptRecord(S1), apiRecord(S1, R1, REAL)]))
  const e1 = await events()
  const m = e1[0]?.metadata ?? {}
  ok('[otel] a Claude Code export becomes one record per API request, under the project\'s client and agent, with its model and tokens',
     first.status === 200 && JSON.stringify(first.body) === '{}' && e1.length === 1 && e1[0].customerRef === 'acme-dental' && e1[0].eventType === 'support-bot'
       && e1[0].units === 10 + 60 + 20828 + 10407 && m.provider === 'anthropic' && m.model === 'claude-haiku-4-5-20251001' && m.source === 'claude-code'
       && m.tokens?.input === 10 && m.tokens?.output === 60 && m.tokens?.cache_read === 20828 && m.step === 'sdk' && e1[0].idempotencyKey === `claude-code:${R1}`,
     JSON.stringify({ first, e1 }).slice(0, 600))
  ok('[otel] its price at list is Claude Code\'s own cost_usd to the micro-dollar: cache writes read as one-hour writes, which is what the export matches',
     e1[0]?.usd === '0.023206800000' && m.tokens?.cache_write_1h === 10407 && m.tokens?.cache_write === 0 && m.claude_code_cost_usd === 0.0232068,
     JSON.stringify({ usd: e1[0]?.usd, tokens: m.tokens }))

  // The same batch again, as an exporter retry sends it.
  const again = await post('/otel/v1/logs', exportOf([promptRecord(S1), apiRecord(S1, R1, REAL)]))
  ok('[otel] a batch sent twice records each request once (the request id is the idempotency key)',
     again.status === 200 && (await events()).length === 1, `${again.status} ${(await events()).length}`)

  // Nothing personal and no prompt is kept, anywhere this account owns.
  const everything = JSON.stringify(await sql`SELECT e.*, c.* FROM events e JOIN customers c ON c.id = e.customer_id WHERE e.account_id = ${A}`)
  const leaked = [EMAIL, ACCT, ORG, USER, PROMPT, 'user.email', 'organization.id', 'account_uuid'].filter((x) => everything.includes(x))
  ok('[otel] no email, account, organization or user id, and no prompt text, reaches any stored row',
     leaked.length === 0, leaked.join(', ') || 'none')

  // Other events alone record nothing.
  const S2 = randomUUID()
  const noApi = await post('/otel/v1/logs', exportOf([promptRecord(S2)]))
  ok('[otel] an export with no api_request record is accepted and records nothing',
     noApi.status === 200 && (await events()).length === 1, `${noApi.status}`)

  // No label, and a label that is not one: filed under default, never mangled.
  await post('/otel/v1/logs', exportOf([apiRecord(S2, `req_nolabel_${randomBytes(4).toString('hex')}`, REAL)], {}))
  await post('/otel/v1/logs', exportOf([apiRecord(S2, `req_badlabel_${randomBytes(4).toString('hex')}`, REAL)], { client: 'Acme Dental; DROP' }))
  const e3 = await events()
  ok('[otel] no client label, or one that is not a label, is filed under default and the agent under claude-code',
     e3.length === 3 && e3.slice(1).every((r) => r.customerRef === 'default' && r.eventType === 'claude-code'),
     JSON.stringify(e3.slice(1).map((r) => [r.customerRef, r.eventType])))

  // A cost that lands on five-minute cache writes is priced as five-minute.
  const fiveTokens = { input: 10, cache_read: 20828, cache_write: 10407, cache_write_1h: 0, output: 60, reasoning: 0, audio_input: 0, audio_output: 0 }
  const five = priceCall({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001', tokens: fiveTokens })
  const fiveUsd = Number(five.picoUsd) / 1e12
  await post('/otel/v1/logs', exportOf([apiRecord(S2, `req_five_${randomBytes(4).toString('hex')}`, { ...REAL, cost: fiveUsd })]))
  const e4 = (await events()).at(-1)
  ok('[otel] when Claude Code\'s cost matches five-minute cache writes, the record is priced as five-minute writes',
     five.ok && e4?.metadata?.tokens?.cache_write === 10407 && e4?.metadata?.tokens?.cache_write_1h === 0 && Math.abs(Number(e4.usd) - fiveUsd) < 1e-9,
     JSON.stringify({ fiveUsd, tokens: e4?.metadata?.tokens, usd: e4?.usd }))

  // The door: a key, and JSON only.
  const noKey = await post('/otel/v1/logs', exportOf([]), { key: '' })
  const badKey = await post('/otel/v1/logs', exportOf([]), { key: 'agb_' + 'f'.repeat(48) })
  const proto = await post('/otel/v1/logs', 'x', { type: 'application/x-protobuf' })
  const gz = await post('/otel/v1/logs', exportOf([]), { encoding: 'gzip' })
  ok('[otel] no key or an unknown key is 401; protobuf or a compressed body is 415 and says to use http/json',
     noKey.status === 401 && badKey.status === 401 && proto.status === 415 && /http\/json/.test(proto.body?.message ?? '') && gz.status === 415,
     JSON.stringify([noKey.status, badKey.status, proto, gz.status]))
  const before = (await events()).length
  const metrics = await post('/otel/v1/metrics', { resourceMetrics: [] })
  ok('[otel] a metrics export is accepted and stores nothing', metrics.status === 200 && (await events()).length === before, `${metrics.status}`)

  await sql`DELETE FROM accounts WHERE id = ${A}`
}
