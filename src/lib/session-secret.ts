import { createHmac, timingSafeEqual } from 'crypto'

// The one secret every browser session on this site is signed with: the key
// session (src/routes/app.ts), the user session and the OAuth flow cookie
// (src/lib/user-session.ts, src/lib/oauth.ts). Lifted out of app.ts on
// 2026-09-25 so three signers read one source. Each signer prefixes its own
// purpose string, so a value minted for one can never verify as another.
export function sessionSecret(): string {
  const explicit = process.env.APP_SESSION_SECRET
  if (explicit) return explicit
  const admin = process.env.ADMIN_SECRET
  if (!admin) return ''
  // Derived, so no new secret to provision; rotating ADMIN_SECRET logs everyone out.
  return createHmac('sha256', admin).update('agentbill-app-session-v1').digest('hex')
}

export function hmacHex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex')
}

export function safeEqual(a: string, b: string): boolean {
  const A = Buffer.from(a)
  const B = Buffer.from(b)
  return A.length === B.length && timingSafeEqual(A, B)
}

/** One cookie's value out of a Cookie header, or '' when it is absent. */
export function readCookie(header: string, name: string): string {
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return ''
}
