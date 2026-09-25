import { sessionSecret, hmacHex, safeEqual, readCookie } from './session-secret.js'

// The user session: a browser signed in as a PERSON (a users row), not as a key.
//
// The key session in src/routes/app.ts signs a key id, so it ends when the key
// is revoked and not before, and logging out only asked the browser to forget
// the cookie: a copy taken before logout kept working for the rest of its seven
// days (S17 in the 2026-09-25 audit). This one carries the user's
// session_epoch, and POST /app/logout moves the epoch on in the database, so a
// copied cookie dies server-side the moment its owner signs out, on every
// device at once.
//
//   value   <userId>.<epoch>.<exp>.<mac>
//   mac     HMAC-SHA256(secret, "agentbill-user-session-v1." + <userId>.<epoch>.<exp>)
//
// The purpose prefix is what keeps this apart from the key session, which
// signs "<keyId>.<exp>" with the same secret: neither can ever verify as the
// other. HttpOnly, Secure, SameSite=Lax, and Path=/app like the key session,
// because /app is the only place that reads it. The routes under /auth set it
// with an explicit Path=/app; a response may set a cookie for any path on its
// own host.

export const USER_COOKIE = 'agentbill_user'
export const USER_MAX_AGE = 7 * 24 * 3_600
const PURPOSE = 'agentbill-user-session-v1'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const COOKIE_ATTRS = 'HttpOnly; Secure; SameSite=Lax; Path=/app'

/** The Set-Cookie value for a user session, or null when no secret is configured. */
export function userSessionCookie(userId: string, epoch: number): string | null {
  const secret = sessionSecret()
  if (!secret || !UUID_RE.test(userId) || !Number.isInteger(epoch) || epoch < 0) return null
  const exp = Math.floor(Date.now() / 1000) + USER_MAX_AGE
  const payload = `${userId}.${epoch}.${exp}`
  return `${USER_COOKIE}=${payload}.${hmacHex(secret, `${PURPOSE}.${payload}`)}; ${COOKIE_ATTRS}; Max-Age=${USER_MAX_AGE}`
}

export const CLEAR_USER_COOKIE = `${USER_COOKIE}=; ${COOKIE_ATTRS}; Max-Age=0`

/** What a user cookie claims, when its signature and expiry hold. The epoch is
 *  checked against the database by the caller, which is the part logout moves. */
export function readUserSession(cookieHeader: string | undefined): { userId: string; epoch: number } | null {
  const secret = sessionSecret()
  if (!secret) return null
  const token = readCookie(cookieHeader ?? '', USER_COOKIE)
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 4) return null
  const [userId, epochStr, expStr, mac] = parts
  if (!UUID_RE.test(userId) || !/^[0-9]{1,9}$/.test(epochStr) || !/^[0-9]{10}$/.test(expStr)) return null
  if (Number(expStr) < Date.now() / 1000) return null
  if (!/^[0-9a-f]{64}$/.test(mac) || !safeEqual(mac, hmacHex(secret, `${PURPOSE}.${userId}.${epochStr}.${expStr}`))) return null
  return { userId, epoch: Number(epochStr) }
}
