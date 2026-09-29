import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { runRecord } from './events.js'
import { priceCall, type Tokens } from '../lib/prices.js'
import { isId, INT4_MAX } from '../lib/ids.js'
import { sql } from '../db/index.js'

// Claude Code's own telemetry, received once and recorded per call
// (2026-09-28).
//
// An agency that builds in Claude Code or n8n has no code of its own to put
// wrap() in, which is why the start screen stayed unclear to a user who builds
// in both. Claude Code exports OpenTelemetry by itself. Pointed here with two
// small files in a client's project, every API request Claude Code makes
// arrives as one log record, and each becomes one AgentBill record, labelled
// with that project's client:
//
//   .claude/settings.json        CLAUDE_CODE_ENABLE_TELEMETRY=1,
//                                OTEL_LOGS_EXPORTER=otlp,
//                                OTEL_EXPORTER_OTLP_PROTOCOL=http/json,
//                                OTEL_EXPORTER_OTLP_ENDPOINT=https://agentbill.dev/otel,
//                                OTEL_RESOURCE_ATTRIBUTES=client=<client>
//   .claude/settings.local.json  OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <key>
//
// Read from a real export of Claude Code 2.1.274 (claude -p against a local
// listener): an http/json POST to <endpoint>/v1/logs, scope
// com.anthropic.claude_code.events, one record per request with event.name
// "api_request" and model, input_tokens, output_tokens, cache_read_tokens,
// cache_creation_tokens, cost_usd, duration_ms, request_id and query_source.
// The resource carries OTEL_RESOURCE_ATTRIBUTES as given.
//
// What is kept: the model, the four token counts, the duration, the session
// id, and Claude Code's own cost figure beside ours. What is never stored:
// the email, account, organization and user ids Claude Code attaches to every
// record, and every other event (the prompt event, tool results, MCP
// connections), whatever it carries. Each record goes through runRecord, the
// same function behind POST /events and the MCP record_event tool, so it is
// priced, capped, deduplicated and alerted exactly like a call wrap() records.

/** Where Claude Code is told to send. Its exporter appends /v1/logs. */
export const OTEL_BASE = '/otel'

const MAX_RECORDS = 500

type AnyValue = { stringValue?: string; intValue?: string | number; doubleValue?: number; boolValue?: boolean }
type KeyValue = { key?: string; value?: AnyValue }

const valueOf = (v: AnyValue | undefined): string | number | boolean | undefined => {
  if (!v || typeof v !== 'object') return undefined
  if (typeof v.stringValue === 'string') return v.stringValue
  if (v.intValue !== undefined) return Number(v.intValue)
  if (typeof v.doubleValue === 'number') return v.doubleValue
  if (typeof v.boolValue === 'boolean') return v.boolValue
  return undefined
}

const attrs = (list: unknown): Map<string, string | number | boolean> => {
  const m = new Map<string, string | number | boolean>()
  if (!Array.isArray(list)) return m
  for (const kv of list as KeyValue[]) {
    if (kv && typeof kv.key === 'string') {
      const v = valueOf(kv.value)
      if (v !== undefined) m.set(kv.key, v)
    }
  }
  return m
}

const count = (v: unknown): number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0

/** A label from OTEL_RESOURCE_ATTRIBUTES, or null when it is not one we keep.
 *  Exported for the start screen, which builds the settings file with one. */
export const otelLabel = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(s) && isId(s) ? s : null
}

/**
 * Claude Code reports cache writes as one number. The API bills a five-minute
 * write and a one-hour write at different rates, and the export does not say
 * which, so both are priced and the one that lands on Claude Code's own
 * cost_usd is kept. With no cost_usd, one-hour, which is what every export
 * read so far matched to the cent.
 */
export function claudeCodeTokens(model: string, t: { input: number; output: number; cacheRead: number; cacheCreation: number }, costUsd: number | null): Tokens {
  const base: Tokens = { input: t.input, cache_read: t.cacheRead, cache_write: 0, cache_write_1h: 0, output: t.output, reasoning: 0, audio_input: 0, audio_output: 0 }
  const oneHour: Tokens = { ...base, cache_write_1h: t.cacheCreation }
  if (t.cacheCreation === 0 || costUsd === null) return oneHour
  const fiveMin: Tokens = { ...base, cache_write: t.cacheCreation }
  const usd = (tokens: Tokens): number | null => {
    const p = priceCall({ provider: 'anthropic', model, tokens })
    return p.ok ? Number(p.picoUsd) / 1e12 : null
  }
  const a = usd(oneHour), b = usd(fiveMin)
  if (a === null || b === null) return oneHour
  return Math.abs(b - costUsd) < Math.abs(a - costUsd) ? fiveMin : oneHour
}

type Outcome = { accepted: number; rejected: number; error: string | null; retry: boolean }

export async function otelRoute(app: FastifyInstance) {
  // An export of a busy session read at up to 21 KB per batch; 1 MB leaves
  // room without letting a body grow unbounded.

  // Checked before the body is parsed: Fastify answers an unknown content type
  // (the exporter's default, protobuf) with a bare 415 of its own, and a gzip
  // body fails the JSON parser, and neither says what to change.
  const jsonOnly = async (request: FastifyRequest, reply: FastifyReply) => {
    const type = String(request.headers['content-type'] ?? '')
    const encoding = String(request.headers['content-encoding'] ?? '').toLowerCase()
    if (!type.startsWith('application/json') || (encoding && encoding !== 'identity')) {
      return reply.code(415).send({
        error: 'unsupported_media_type',
        message: 'AgentBill reads OTLP as uncompressed JSON. Set OTEL_EXPORTER_OTLP_PROTOCOL=http/json and leave OTEL_EXPORTER_OTLP_COMPRESSION unset.',
      })
    }
  }
  const opts = { bodyLimit: 1024 * 1024, onRequest: jsonOnly }

  app.post(`${OTEL_BASE}/v1/logs`, opts, async (request, reply) => {
    const body = request.body as { resourceLogs?: unknown } | null
    if (!body || typeof body !== 'object' || !Array.isArray(body.resourceLogs)) {
      return reply.code(400).send({ error: 'validation_error', message: 'Expected an OTLP logs export: an object with resourceLogs.' })
    }

    const out: Outcome = { accepted: 0, rejected: 0, error: null, retry: false }
    let seen = 0
    for (const rl of body.resourceLogs as Array<Record<string, unknown>>) {
      const resource = attrs((rl?.resource as Record<string, unknown> | undefined)?.attributes)
      for (const sl of (Array.isArray(rl?.scopeLogs) ? rl.scopeLogs : []) as Array<Record<string, unknown>>) {
        for (const rec of (Array.isArray(sl?.logRecords) ? sl.logRecords : []) as Array<Record<string, unknown>>) {
          const a = attrs(rec?.attributes)
          if (a.get('event.name') !== 'api_request') continue
          if (++seen > MAX_RECORDS) { out.rejected++; out.error ??= `at most ${MAX_RECORDS} api_request records per export`; continue }

          const model = typeof a.get('model') === 'string' ? String(a.get('model')).slice(0, 200) : ''
          const requestId = a.get('request_id') ?? a.get('client_request_id')
          const session = a.get('session.id')
          const idem = typeof requestId === 'string' && requestId
            ? `claude-code:${requestId}`
            : typeof session === 'string' && session ? `claude-code:${session}:${a.get('event.sequence')}` : ''
          if (!model || !idem || !isId(idem)) { out.rejected++; out.error ??= 'an api_request record without a model or a request id'; continue }

          const t = {
            input: count(a.get('input_tokens')), output: count(a.get('output_tokens')),
            cacheRead: count(a.get('cache_read_tokens')), cacheCreation: count(a.get('cache_creation_tokens')),
          }
          const cost = typeof a.get('cost_usd') === 'number' ? Number(a.get('cost_usd')) : null
          const tokens = claudeCodeTokens(model, t, cost)
          const total = t.input + t.output + t.cacheRead + t.cacheCreation
          const client = otelLabel(resource.get('client') ?? a.get('client'))
          const agent = otelLabel(resource.get('agent') ?? a.get('agent'))
          const step = otelLabel(a.get('query_source'))
          const duration = count(a.get('duration_ms'))

          const r = await runRecord(request.accountId, {
            customer_id: client ?? 'default',
            event_type: agent ?? 'claude-code',
            idempotency_key: idem,
            units: Math.min(total, INT4_MAX),
            metadata: {
              provider: 'anthropic',
              model,
              tokens,
              source: 'claude-code',
              ...(step ? { step } : {}),
              ...(duration ? { duration_ms: duration } : {}),
              ...(typeof session === 'string' && isId(session) ? { session_id: session } : {}),
              ...(cost !== null && Number.isFinite(cost) ? { claude_code_cost_usd: cost } : {}),
            },
          }, request.log)
          if (r.status >= 200 && r.status < 300) out.accepted++
          else {
            out.rejected++
            if (r.status >= 500) out.retry = true
            const b = r.body as { message?: string; error?: string } | null
            out.error ??= b?.message ?? b?.error ?? `record answered ${r.status}`
          }
        }
      }
    }

    // A server fault is the one case the exporter should send the batch again;
    // every record carries its request id, so the retry records nothing twice.
    // Anything else (a quota, a bad record) is answered 200 with a partial
    // success, as OTLP asks, so an exporter does not retry a batch forever.
    if (out.retry && out.accepted === 0) return reply.code(503).send({ error: 'unavailable', message: out.error })
    return reply.code(200).send(out.rejected
      ? { partialSuccess: { rejectedLogRecords: out.rejected, errorMessage: out.error ?? '' } }
      : {})
  })

  // What one Claude Code session has spent so far (2026-09-29), for the cap.
  // Every record above carries the session id, so a session's spend is the
  // sum over its records: Claude Code's own cost_usd where the record has it,
  // else our list-price estimate. Bounded to the account asking and to the
  // last 30 days of its records.
  const sessionSpend = async (accountId: string, id: string) => {
    const [row] = await sql`
      SELECT count(*)::int AS calls,
             coalesce(sum(coalesce((metadata->>'claude_code_cost_usd')::numeric, list_price_usd)), 0)::float8 AS spent,
             max(created_at) AS last_at
      FROM events
      WHERE account_id = ${accountId}
        AND metadata->>'session_id' = ${id}
        AND created_at > now() - interval '30 days'`
    return { spent: Math.round(Number(row?.spent ?? 0) * 1e6) / 1e6, calls: Number(row?.calls ?? 0), lastAt: row?.lastAt ?? null }
  }
  const capOf = (raw: unknown): number | null => {
    const n = typeof raw === 'string' ? Number(raw.trim()) : NaN
    return Number.isFinite(n) && n > 0 && n <= 1_000_000 ? n : null
  }
  const sessionOk = (id: unknown): id is string => typeof id === 'string' && isId(id) && id.length <= 128

  // GET: the figure, for anything that wants to read it. ?cap=<usd> adds over.
  app.get(`${OTEL_BASE}/session/:id`, async (request, reply) => {
    const id = (request.params as { id?: string }).id
    if (!sessionOk(id)) return reply.code(400).send({ error: 'validation_error', message: 'The session id is 1 to 128 characters with no control characters.' })
    const cap = capOf((request.query as Record<string, unknown> | undefined)?.cap)
    const s = await sessionSpend(request.accountId, id)
    return reply.header('Cache-Control', 'no-store').send({
      session_id: id, spent_usd: s.spent, calls: s.calls, last_recorded_at: s.lastAt, cap_usd: cap, over: cap !== null && s.spent >= cap,
    })
  })

  // POST: Claude Code's own HTTP hook (PostToolUse) posts its hook input here,
  // with the key and the cap in headers it fills from the project's settings.
  // The answer is Claude Code's hook decision: {} to go on, or continue:false
  // with the reason shown to the user once the session has reached its cap.
  // An HTTP hook, because Claude Code does not pass OTEL_* variables to a
  // command hook (found 2026-09-29 by a probe hook), and because it needs no
  // Node or shell on the machine, so it works the same on Windows.
  // No cap, no session id: {} and nothing else. It never stops a session on
  // our error: a 5xx is a non-blocking error to Claude Code.
  app.post(`${OTEL_BASE}/hook`, { bodyLimit: 1024 * 1024 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const cap = capOf(request.headers['x-agentbill-cap'])
    const body = (request.body ?? {}) as Record<string, unknown>
    const id = body.session_id
    if (cap === null || !sessionOk(id)) return reply.send({})
    const s = await sessionSpend(request.accountId, id)
    if (s.spent < cap) return reply.send({})
    return reply.send({
      continue: false,
      stopReason: `AgentBill: this session has spent $${s.spent.toFixed(2)} of its $${cap.toFixed(2)} cap. To keep going, raise AGENTBILL_SESSION_CAP_USD in .claude/settings.json, then say continue.`,
    })
  })

  // Metrics are not read: every figure is in the api_request events. Accepted
  // and dropped, so a setup that also exports metrics sees no errors.
  app.post(`${OTEL_BASE}/v1/metrics`, opts, async (_request, reply) => reply.code(200).send({}))
}
