const WINDOW_MS = 60_000
// 100 per key per minute in production. Overridable for the preflight harness
// only: on CI's runner the whole suite (~300 gates, ~90 API calls) finishes in
// about thirty seconds, so the harness key trips its own limit at the tail and
// the [start] gates fail with rate_limit_exceeded on a correct server. Locally
// the same run takes four minutes and never notices. The limit is not what the
// harness tests; scripts/preflight/run.sh raises it for the server under test.
const MAX_REQUESTS = Number(process.env.RATE_LIMIT_PER_MINUTE ?? 100)

interface Window {
  count: number
  resetAt: number
}

const store = new Map<string, Window>()

export function checkRateLimit(key: string): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now()
  const entry = store.get(key)

  if (!entry || now >= entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + WINDOW_MS })
    return { allowed: true, remaining: MAX_REQUESTS - 1, resetAt: now + WINDOW_MS }
  }

  entry.count++

  if (entry.count > MAX_REQUESTS) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt }
  }

  return { allowed: true, remaining: MAX_REQUESTS - entry.count, resetAt: entry.resetAt }
}
