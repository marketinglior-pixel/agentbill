// Fixed-window counters held in this machine's memory, and the three the API
// path uses.
//
// ---------------------------------------------------------------------------
// Why this file changed on 2026-09-25
//
// There was one Map here, keyed by the raw bearer token, written BEFORE the
// token was looked up, and never pruned. So every distinct string anyone sent
// in an Authorization header became a permanent entry, and nothing needed a
// key to send one. Measured in the audit that day: 12k-40k requests with fake
// tokens took the process from about 80MB to about 290-330MB, on a machine that
// has 256MB. That is an outage anybody could cause with curl in a loop.
//
// Three things changed, and each one alone would have been enough to bound it:
//
//   1. auth.ts refuses a token that is not shaped like a key before any
//      counter is touched. Keys have one shape (agb_ and 48 hex characters,
//      register.ts / keys.ts / recover.ts), so a random string costs a regex.
//   2. The per-key counter is keyed by the key's database id, AFTER the key was
//      found. A token that matched nothing never gets a per-key entry. What
//      counts a stranger is the per-network failure counter below, which has
//      one entry per network, not one per string.
//   3. Every counter here evicts expired windows and has a hard ceiling on its
//      size, so no pattern of traffic can grow one without bound.
//
// Same tradeoff as always: per machine, not shared, damage control rather than
// a distributed quota. Two machines means up to twice any number here.
// ---------------------------------------------------------------------------

export interface Verdict {
  allowed: boolean
  remaining: number
  resetAt: number
}

interface Window {
  count: number
  resetAt: number
}

export interface Limiter {
  /** Count one request against `key` and say whether it is inside the limit. */
  hit(key: string): Verdict
  /** Whether `key` is already at its limit, without counting anything. */
  blocked(key: string): Verdict
  /** Entries currently held. For the harness, which proves the ceiling holds. */
  size(): number
  readonly max: number
  readonly maxEntries: number
}

export interface LimiterOptions {
  max: number
  windowMs: number
  /**
   * The most entries this counter will hold. Past it, expired windows are
   * dropped first, and if that is not enough the oldest tenth goes. Dropping a
   * live entry hands that key a fresh window, which is the price of a bound;
   * the ceilings below are set far above anything real traffic produces so
   * that only a flood ever pays it.
   */
  maxEntries: number
}

export function createLimiter({ max, windowMs, maxEntries }: LimiterOptions): Limiter {
  const store = new Map<string, Window>()
  let lastSweep = Date.now()

  // Drop every window that has ended. O(n), so it runs at most once a window
  // on its own, and otherwise only when the ceiling is reached.
  const sweep = (now: number) => {
    lastSweep = now
    for (const [k, w] of store) if (now >= w.resetAt) store.delete(k)
  }

  const makeRoom = (now: number) => {
    if (store.size < maxEntries) return
    sweep(now)
    if (store.size < maxEntries) return
    // Still full of live windows: a flood. Map iteration is insertion order,
    // and a window is re-inserted when it resets, so the head is the oldest.
    const cut = Math.max(1, Math.ceil(maxEntries / 10))
    let i = 0
    for (const k of store.keys()) {
      store.delete(k)
      if (++i >= cut) break
    }
  }

  const current = (key: string, now: number): Window | undefined => {
    const w = store.get(key)
    if (w && now >= w.resetAt) {
      store.delete(key)
      return undefined
    }
    return w
  }

  return {
    max,
    maxEntries,
    size: () => store.size,
    hit(key) {
      const now = Date.now()
      if (now - lastSweep >= windowMs) sweep(now)
      const w = current(key, now)
      if (!w) {
        makeRoom(now)
        const resetAt = now + windowMs
        store.set(key, { count: 1, resetAt })
        return { allowed: 1 <= max, remaining: Math.max(0, max - 1), resetAt }
      }
      w.count++
      return { allowed: w.count <= max, remaining: Math.max(0, max - w.count), resetAt: w.resetAt }
    },
    blocked(key) {
      const now = Date.now()
      const w = current(key, now)
      if (!w) return { allowed: true, remaining: max, resetAt: now + windowMs }
      return { allowed: w.count < max, remaining: Math.max(0, max - w.count), resetAt: w.resetAt }
    },
  }
}

const WINDOW_MS = 60_000
const envInt = (name: string, fallback: number): number => {
  const n = Number(process.env[name])
  return Number.isInteger(n) && n > 0 ? n : fallback
}

// 100 per key per minute in production. Overridable for the preflight harness
// only: on CI's runner the whole suite (~300 gates, ~90 API calls) finishes in
// about thirty seconds, so the harness key trips its own limit at the tail and
// the [start] gates fail with rate_limit_exceeded on a correct server. Locally
// the same run takes four minutes and never notices. The limit is not what the
// harness tests; scripts/preflight/run.sh raises it for the server under test.
export const MAX_REQUESTS = envInt('RATE_LIMIT_PER_MINUTE', 100)

// Per ACCOUNT, across every key it holds. POST /keys/generate has no cap on how
// many keys an account mints, so a per-key limit alone was a limit anyone could
// multiply by minting. Three keys' worth by default, so an account running a
// few keys side by side at full rate is never refused by this, and one that
// minted fifty is still held to the same number as one that minted three.
export const MAX_ACCOUNT_REQUESTS = envInt('RATE_LIMIT_ACCOUNT_PER_MINUTE', MAX_REQUESTS * 3)

// Failed lookups per NETWORK (limiterKey: the IPv4 address, or the IPv6 /64),
// counted before the database is asked about the next one. Only a token that
// is shaped like a key and matched no row counts: a revoked or expired key is
// a known key, and an agent retrying one in a loop is a caller to tell, not an
// attacker to throttle. Thirty a minute is far more than anyone mistyping a key
// produces and far less than a guessing run needs.
export const MAX_AUTH_FAILURES = envInt('AUTH_FAILURES_PER_MINUTE', 30)

const keyLimiter = createLimiter({ max: MAX_REQUESTS, windowMs: WINDOW_MS, maxEntries: 50_000 })
const accountLimiter = createLimiter({ max: MAX_ACCOUNT_REQUESTS, windowMs: WINDOW_MS, maxEntries: 50_000 })
export const authFailureLimiter = createLimiter({ max: MAX_AUTH_FAILURES, windowMs: WINDOW_MS, maxEntries: 20_000 })

/**
 * The per-key bucket. `key` is the key's database id (developer_api_keys.id),
 * never the raw token: the console's writes (src/routes/app.ts) pass the same
 * id, so the console and the API draw on one bucket per key.
 */
export function checkRateLimit(key: string): Verdict {
  return keyLimiter.hit(key)
}

/** The per-account bucket, shared by every key on the account. */
export function checkAccountRateLimit(accountId: string): Verdict {
  return accountLimiter.hit(accountId)
}

/** Sizes of the three counters, for the harness. */
export function limiterSizes(): { key: number; account: number; authFailure: number } {
  return { key: keyLimiter.size(), account: accountLimiter.size(), authFailure: authFailureLimiter.size() }
}
