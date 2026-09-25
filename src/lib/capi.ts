import type { FastifyBaseLogger, FastifyRequest } from 'fastify'
import { createHash } from 'node:crypto'
import { ORIGIN } from '../ui/site.js'
import { clientIp } from './client-ip.js'

// Meta Conversions API: one CompleteRegistration per new account, sent from
// the server on the sign-in that created it (src/routes/auth.ts, land()),
// 2026-09-26.
//
// Why from the server. The Meta ad campaign optimises on signups, and the only
// signal it had was PageView: no browser code ever fired a conversion (the
// comment in pixel.ts that said the register page did was stale). A signup
// completes on a redirect back from Google, GitHub or an email link, which is
// not a page the pixel is on, so the server is the one place that knows.
//
// What it sends, and the one choice made about it. Only when the browser
// carries Meta's own first-party cookie (_fbp, or _fbc from an ad click):
// that cookie exists only if the pixel already ran in this browser on one of
// PIXEL_PATHS. A browser that blocked the pixel is not reported by the server
// instead. That gives up the part of CAPI that recovers blocked events, on
// purpose: routing around somebody's blocker is not a thing this product does.
// With the cookie present, the event carries a SHA-256 of the lowercased email
// (Meta's matching format), a SHA-256 of the account id, the IP and user agent
// of the request, and the cookie values. /privacy says the same thing, and the
// [privacy] gate checks it names the Conversions API when this is configured.
//
// Never throws, never delays the sign-in: called with `void`, bounded by a
// timeout, and every branch leaves a log line.

const GRAPH_VERSION = 'v26.0'

/** The Graph origin. A local fake in tests, never in production. */
export function capiBase(env: NodeJS.ProcessEnv = process.env): string {
  const t = env.META_CAPI_TEST_BASE
  if (env.NODE_ENV !== 'production' && t && /^http:\/\/127\.0\.0\.1:\d+$/.test(t)) return t
  return 'https://graph.facebook.com'
}

export const capiConfigured = (env: NodeJS.ProcessEnv = process.env): boolean =>
  !!env.META_CAPI_ACCESS_TOKEN && /^\d{5,20}$/.test(env.META_PIXEL_ID ?? '')

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** A cookie value, bounded and without control characters, or ''. */
function cookie(header: string | undefined, name: string): string {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i < 0 || part.slice(0, i).trim() !== name) continue
    const v = part.slice(i + 1).trim()
    return /^[A-Za-z0-9._\-]{1,200}$/.test(v) ? v : ''
  }
  return ''
}

export interface Registration {
  accountId: string
  email: string
  via: string
}

export function reportRegistration(log: FastifyBaseLogger, request: FastifyRequest, r: Registration): void {
  void send(log, request, r).catch((err) => log.error({ err }, 'CAPI CompleteRegistration threw'))
}

async function send(log: FastifyBaseLogger, request: FastifyRequest, r: Registration): Promise<void> {
  if (!capiConfigured()) return
  const fbp = cookie(request.headers.cookie, '_fbp')
  const fbc = cookie(request.headers.cookie, '_fbc')
  if (!fbp && !fbc) {
    log.info({ accountId: r.accountId }, 'CAPI: no Meta cookie in this browser, signup not reported')
    return
  }
  const ua = String(request.headers['user-agent'] ?? '').slice(0, 512)
  const userData: Record<string, unknown> = {
    external_id: [sha256(r.accountId)],
    client_ip_address: clientIp(request),
    ...(ua ? { client_user_agent: ua } : {}),
    ...(fbp ? { fbp } : {}),
    ...(fbc ? { fbc } : {}),
  }
  const email = r.email.trim().toLowerCase()
  if (email.includes('@')) userData.em = [sha256(email)]
  const body: Record<string, unknown> = {
    data: [{
      event_name: 'CompleteRegistration',
      event_time: Math.floor(Date.now() / 1000),
      // One account, one event: Meta drops a repeat of the same event_id, so a
      // retried sign-in cannot count twice. Derived from the hash, so the
      // account id is not sent in the clear here either.
      event_id: `signup-${sha256(r.accountId).slice(0, 32)}`,
      action_source: 'website',
      event_source_url: `${ORIGIN}/login`,
      user_data: userData,
      custom_data: { content_name: r.via },
    }],
    // In the body, never the URL: a URL lands in access logs.
    access_token: process.env.META_CAPI_ACCESS_TOKEN,
  }
  const testCode = process.env.META_CAPI_TEST_EVENT_CODE
  if (testCode && /^TEST[A-Z0-9]{1,20}$/.test(testCode)) body.test_event_code = testCode

  const res = await fetch(`${capiBase()}/${GRAPH_VERSION}/${process.env.META_PIXEL_ID}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 300)
    log.error({ accountId: r.accountId, status: res.status, body: text }, 'CAPI CompleteRegistration refused')
    return
  }
  log.info({ accountId: r.accountId, fbp: Boolean(fbp), fbc: Boolean(fbc) }, 'CAPI CompleteRegistration sent')
}
