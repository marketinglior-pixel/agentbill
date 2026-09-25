// What a request looks like in the log.
//
// Fastify's default request serializer writes req.url whole. Two things in a
// URL do not belong in a log that a hosting provider, a log drain or anybody
// debugging can read:
//
//   /recover/<token>   a single-use link that opens an account (recover.ts).
//                      The token is stored hashed in the database precisely so
//                      that a copy of the data cannot be used, and the log was
//                      keeping it in plain text on every click.
//   /auth/email/<token> the email sign-in link (auth.ts, 2026-09-25): single
//                      use, fifteen minutes, and a signed-in console to whoever
//                      holds it. Stored hashed for the same reason.
//   ?query             free text a visitor or a client chose: filters, a
//                      checkout id, whatever a mistyped link carries, and the
//                      OAuth callback's `code` and `state`.
//
// So every logged URL is the path alone, with either token replaced.

/** The URL as it may be logged: no query string, no recovery or sign-in token. */
export function redactUrl(url: string | undefined): string {
  if (!url) return ''
  const q = url.search(/[?#]/)
  const path = q === -1 ? url : url.slice(0, q)
  return path
    .replace(/^(\/recover\/)[^/]+/i, '$1[redacted]')
    .replace(/^(\/+auth\/+email\/+)[^/]+/i, '$1[redacted]')
}

interface ReqLike {
  method?: string
  url?: string
  host?: string
  hostname?: string
  ip?: string
  socket?: { remotePort?: number }
}

/** The `req` serializer: Fastify's default fields, with the URL redacted. */
export function serializeRequest(req: ReqLike): Record<string, unknown> {
  return {
    method: req.method,
    url: redactUrl(req.url),
    host: req.host ?? req.hostname,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  }
}
