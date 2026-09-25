import { lookup } from 'node:dns/promises'
import { lookup as lookupCb, type LookupAddress } from 'node:dns'
import { isIP } from 'node:net'
import { request as httpsRequest } from 'node:https'
import { createHmac, randomBytes, hkdfSync } from 'node:crypto'

// Where the anomaly webhook (POST /step) is allowed to deliver, and how.
//
// Until 2026-09-25 the only rule was "starts with https://". The sender
// followed redirects, had no timeout and no signature, and in the audit that
// day it opened a connection to 169.254.169.254, the cloud metadata address,
// from inside production. A URL an account types is a request our server
// makes on its behalf, so the rules below are about OUR network, not theirs:
// nothing on a loopback, private, link-local or Fly-internal address, checked
// when the URL is saved and again, on the address actually dialled, when it is
// sent, because a hostname that resolved to a public address on Monday can
// resolve to 10.0.0.5 on Tuesday.

/** Hostname suffixes that only mean something inside a private network. */
const PRIVATE_SUFFIXES = ['.internal', '.local', '.localhost', '.localdomain', '.home.arpa', '.flycast', '.lan']

export type TargetVerdict = { ok: true } | { ok: false; reason: string }

/** Eight 16-bit groups for an IPv6 literal, or null when it is not one. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase()
  const zone = s.indexOf('%')
  if (zone !== -1) s = s.slice(0, zone)
  // A trailing dotted quad (::ffff:127.0.0.1) is two groups.
  const dotted = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) {
    const v4 = dotted[2].split('.').map(Number)
    if (v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
    s = `${dotted[1]}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const part = (h: string) => (h === '' ? [] : h.split(':'))
  const head = part(halves[0])
  const tail = halves.length === 2 ? part(halves[1]) : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail]
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN))
  return out.some((n) => Number.isNaN(n)) ? null : out
}

function v4Private(ip: string): boolean {
  const o = ip.split('.').map(Number)
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b, c] = o
  return (
    a === 0 ||                                   // 0.0.0.0/8, "this network"
    a === 10 ||                                  // 10/8
    (a === 100 && b >= 64 && b <= 127) ||        // 100.64/10, carrier-grade NAT
    a === 127 ||                                 // loopback
    (a === 169 && b === 254) ||                  // link-local, incl. 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) ||         // 172.16/12
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol assignments, TEST-NET-1
    (a === 192 && b === 168) ||                  // 192.168/16
    (a === 198 && (b === 18 || b === 19)) ||     // benchmarking
    (a === 198 && b === 51 && c === 100) ||      // TEST-NET-2
    (a === 203 && b === 0 && c === 113) ||       // TEST-NET-3
    a >= 224                                     // multicast, reserved, broadcast
  )
}

/**
 * True for any address this server must never deliver a webhook to.
 * Unparseable counts as private: a value we cannot classify is not dialled.
 */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip.replace(/%.*$/, ''))
  if (family === 4) return v4Private(ip)
  if (family !== 6) return true
  const g = ipv6Groups(ip)
  if (!g) return true
  const embedded = () => `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`
  if (g.every((x) => x === 0)) return true                                  // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true        // ::1
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return v4Private(embedded()) // ::ffff:a.b.c.d, IPv4-mapped
  if (g.slice(0, 6).every((x) => x === 0)) return true                      // ::a.b.c.d, IPv4-compatible (deprecated)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4Private(embedded()) // NAT64
  if (g[0] === 0x2002) return v4Private(`${g[1] >> 8}.${g[1] & 255}.${g[2] >> 8}.${g[2] & 255}`) // 6to4
  if ((g[0] & 0xffc0) === 0xfe80) return true                               // fe80::/10 link-local
  if ((g[0] & 0xfe00) === 0xfc00) return true                               // fc00::/7 ULA, incl. Fly's fdaa::/16
  if ((g[0] & 0xff00) === 0xff00) return true                               // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true                       // documentation
  if (g[0] === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return true   // discard-only
  return false
}

/** The hostname rules that need no DNS. Returns a reason, or null. */
function hostnameProblem(host: string): string | null {
  const h = host.toLowerCase().replace(/\.$/, '')
  if (!h) return 'the URL has no host'
  if (h === 'localhost' || PRIVATE_SUFFIXES.some((s) => h === s.slice(1) || h.endsWith(s))) {
    return 'the host is a private network name'
  }
  // A single label ("intranet") is resolved through the machine's search
  // domains, which is to say inside our network, not the account's.
  if (isIP(h) === 0 && !h.includes('.')) return 'the host must be a fully qualified public name'
  return null
}

/** URL rules, before any address is looked at. Exported for the OAuth client
 *  metadata fetch (src/lib/mcp-oauth.ts), which holds an outbound URL to the
 *  same rules as a webhook. */
export function urlProblem(raw: string): { url: URL } | { reason: string } {
  let url: URL
  try { url = new URL(raw) } catch { return { reason: 'not a valid URL' } }
  if (url.protocol !== 'https:') return { reason: 'the URL must use https' }
  if (url.username || url.password) return { reason: 'the URL must not carry a username or password' }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const bad = hostnameProblem(host)
  return bad ? { reason: bad } : { url }
}

/**
 * Save-time check: the URL's own rules, then every address its host resolves
 * to. Refused if ANY address is private, so a name with one public and one
 * private record cannot be saved.
 */
export async function checkWebhookUrl(raw: string): Promise<TargetVerdict> {
  const p = urlProblem(raw)
  if ('reason' in p) return { ok: false, reason: p.reason }
  const host = p.url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) return isPrivateAddress(host) ? { ok: false, reason: 'the address is not a public address' } : { ok: true }
  let addrs: LookupAddress[]
  try {
    addrs = await lookup(host, { all: true, verbatim: true })
  } catch {
    return { ok: false, reason: 'the host does not resolve' }
  }
  if (addrs.length === 0) return { ok: false, reason: 'the host does not resolve' }
  if (addrs.some((a) => isPrivateAddress(a.address))) return { ok: false, reason: 'the host resolves to an address that is not public' }
  return { ok: true }
}

/**
 * The resolver the sender dials through. Every address is checked, and the
 * connection is made only to an address that passed, so nothing can change
 * between the check and the connect: this IS the connect's lookup.
 */
type LookupFn = (hostname: string, options: object, cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => void

export const guardedLookup: LookupFn = (hostname, options, cb) => {
  lookupCb(hostname, { ...options, all: true, verbatim: true }, (err, addrs) => {
    if (err) return cb(err, '')
    const list = addrs as unknown as LookupAddress[]
    if (!list.length || list.some((a) => isPrivateAddress(a.address))) {
      const e = new Error(`webhook host ${hostname} resolves to an address that is not public`) as NodeJS.ErrnoException
      e.code = 'EWEBHOOKPRIVATE'
      return cb(e, '')
    }
    const all = (options as { all?: boolean }).all
    if (all) return cb(null, list)
    return cb(null, list[0].address, list[0].family)
  })
}

// ---------------------------------------------------------------------------
// Signing
//
// Each account that saves a URL gets its own signing secret, shown once in the
// response to POST /webhook-config and never again. The database keeps only a
// random nonce: the secret is HMAC(server key, nonce), so a copy of the
// accounts table alone cannot sign or forge a delivery. The server key is
// WEBHOOK_SIGNING_KEY, or derived from APP_SESSION_SECRET or ADMIN_SECRET the
// way the console's session secret is, so there is nothing new to provision.
// Rotating that key invalidates every secret; each account then re-saves its
// URL to get a new one.
// ---------------------------------------------------------------------------

function serverKey(): Buffer | null {
  const base = process.env.WEBHOOK_SIGNING_KEY || process.env.APP_SESSION_SECRET || process.env.ADMIN_SECRET
  if (!base) return null
  return Buffer.from(hkdfSync('sha256', base, 'agentbill-webhook', 'agentbill-webhook-signing-v1', 32))
}

export const webhookSigningReady = (): boolean => serverKey() !== null

/** A fresh nonce for the row. */
export const newWebhookNonce = (): string => randomBytes(24).toString('hex')

/** The account's secret for a nonce, as the account sees it. Null without a server key. */
export function webhookSecretFor(nonce: string): string | null {
  const k = serverKey()
  if (!k) return null
  return 'whsec_' + createHmac('sha256', k).update(nonce).digest('hex')
}

/**
 * X-AgentBill-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">
 * keyed by the account's secret. The timestamp is inside the MAC, so a receiver
 * that refuses an old t cannot be replayed an old delivery.
 */
export function signatureHeader(secret: string, body: string, now = Date.now()): string {
  const t = Math.floor(now / 1000)
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')
  return `t=${t},v1=${v1}`
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export const WEBHOOK_TIMEOUT_MS = 5_000

export type DeliveryResult =
  | { delivered: true; status: number }
  | { delivered: false; reason: string; status?: number }

export interface PostOptions {
  /** The connect-time resolver. Production passes guardedLookup; nothing else. */
  lookup: LookupFn
  /** Extra trust anchors. The harness passes its own test CA; production none. */
  ca?: string | Buffer
  timeoutMs?: number
}

/**
 * One POST, and only one. node:https rather than fetch, because it takes the
 * resolver the socket connects through, which is what ties the address check
 * to the address actually dialled. It never follows a redirect: a 3xx is the
 * answer, recorded as not delivered, and its Location is never requested.
 * Aborted after five seconds whatever the far end is doing.
 */
export function postOnce(url: string, body: string, headers: Record<string, string>, opts: PostOptions): Promise<DeliveryResult> {
  return new Promise((resolve) => {
    let settled = false
    const done = (r: DeliveryResult) => { if (!settled) { settled = true; resolve(r) } }
    let req: ReturnType<typeof httpsRequest>
    try {
      req = httpsRequest(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Length': String(Buffer.byteLength(body)) },
        lookup: opts.lookup as never,
        ca: opts.ca,
        signal: AbortSignal.timeout(opts.timeoutMs ?? WEBHOOK_TIMEOUT_MS),
        // No agent reuse: each delivery resolves and checks its host afresh.
        agent: false,
      }, (res) => {
        const status = res.statusCode ?? 0
        res.resume()
        if (status >= 300 && status < 400) return done({ delivered: false, status, reason: 'redirect not followed' })
        return done(status >= 200 && status < 300 ? { delivered: true, status } : { delivered: false, status, reason: `answered ${status}` })
      })
    } catch (err) {
      return done({ delivered: false, reason: String((err as Error)?.message ?? err).slice(0, 120) })
    }
    req.on('error', (err: NodeJS.ErrnoException) => {
      done({ delivered: false, reason: err.name === 'AbortError' || err.name === 'TimeoutError' ? 'timed out' : (err.code ?? err.message).slice(0, 120) })
    })
    req.end(body)
  })
}

/**
 * The anomaly sender. Checks the URL's rules again (a row saved before these
 * rules existed is held to them too), then posts through the guarded resolver.
 */
export async function deliverWebhook(
  rawUrl: string,
  payload: string,
  headers: Record<string, string>,
  secret: string | null,
): Promise<DeliveryResult> {
  const p = urlProblem(rawUrl)
  if ('reason' in p) return { delivered: false, reason: p.reason }
  const host = p.url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) && isPrivateAddress(host)) return { delivered: false, reason: 'the address is not a public address' }
  const h: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': 'AgentBill-Webhook/1', ...headers }
  if (secret) h['X-AgentBill-Signature'] = signatureHeader(secret, payload)
  return postOnce(p.url.toString(), payload, h, { lookup: guardedLookup })
}

/**
 * One GET for a small JSON document, through the same guarded resolver as a
 * webhook delivery: every address checked, the connection made only to one
 * that passed, no redirect followed, five seconds, and at most `maxBytes` read.
 * Added 2026-09-25 for OAuth Client ID Metadata Documents, where the client_id
 * a stranger sends is a URL this server fetches. Never throws.
 */
export function getJsonOnce(url: string, opts: PostOptions & { maxBytes: number }): Promise<{ ok: true; json: unknown } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    let settled = false
    const done = (r: { ok: true; json: unknown } | { ok: false; reason: string }) => { if (!settled) { settled = true; resolve(r) } }
    let req: ReturnType<typeof httpsRequest>
    try {
      req = httpsRequest(url, {
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': 'AgentBill-OAuth/1' },
        lookup: opts.lookup as never,
        ca: opts.ca,
        signal: AbortSignal.timeout(opts.timeoutMs ?? WEBHOOK_TIMEOUT_MS),
        agent: false,
      }, (res) => {
        const status = res.statusCode ?? 0
        if (status !== 200) { res.resume(); return done({ ok: false, reason: status >= 300 && status < 400 ? 'redirect not followed' : `answered ${status}` }) }
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (c: Buffer) => {
          size += c.length
          if (size > opts.maxBytes) { res.destroy(); return done({ ok: false, reason: `larger than ${opts.maxBytes} bytes` }) }
          chunks.push(c)
        })
        res.on('end', () => {
          try { done({ ok: true, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }) } catch { done({ ok: false, reason: 'not JSON' }) }
        })
        res.on('error', () => done({ ok: false, reason: 'read failed' }))
      })
    } catch (err) {
      return done({ ok: false, reason: String((err as Error)?.message ?? err).slice(0, 120) })
    }
    req.on('error', (err: NodeJS.ErrnoException) => {
      done({ ok: false, reason: err.name === 'AbortError' || err.name === 'TimeoutError' ? 'timed out' : (err.code ?? err.message).slice(0, 120) })
    })
    req.end()
  })
}
