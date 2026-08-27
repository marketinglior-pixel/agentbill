// In-memory abuse guards for the public /register endpoint.
// Same tradeoff as the per-key rate limiter (2026-05-15): no Redis, per-machine
// counters — damage control, not perfect distribution. Two guards:
//   - per-IP request cap (stops signup floods / email enumeration sweeps)
//   - per-email recovery-mail cooldown (stops mail-bombing a victim's inbox)

const ipHits = new Map<string, number[]>()
const emailSends = new Map<string, number>()

const IP_LIMIT = 5
const IP_WINDOW_MS = 60 * 60 * 1000
const EMAIL_COOLDOWN_MS = 60 * 60 * 1000
const MAX_ENTRIES = 10_000

function prune(map: Map<string, unknown>) {
  if (map.size <= MAX_ENTRIES) return
  // Cheap pressure valve: drop the oldest half of the keys.
  let i = 0
  const cut = Math.floor(map.size / 2)
  for (const key of map.keys()) {
    map.delete(key)
    if (++i >= cut) break
  }
}

export function allowRegisterAttempt(ip: string): boolean {
  const now = Date.now()
  const hits = (ipHits.get(ip) ?? []).filter((t) => now - t < IP_WINDOW_MS)
  if (hits.length >= IP_LIMIT) {
    ipHits.set(ip, hits)
    return false
  }
  hits.push(now)
  ipHits.set(ip, hits)
  prune(ipHits)
  return true
}

// Cooldown is only armed by markRecoverySent — a failed send must not block
// the next attempt (or claim an email that never went out).
export function recoveryInCooldown(email: string): boolean {
  const last = emailSends.get(email)
  return !!last && Date.now() - last < EMAIL_COOLDOWN_MS
}

export function markRecoverySent(email: string): void {
  emailSends.set(email, Date.now())
  prune(emailSends)
}
