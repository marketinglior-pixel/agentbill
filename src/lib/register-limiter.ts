// In-memory abuse guards for the public /register and /recover endpoints.
// Same tradeoff as the per-key rate limiter (2026-05-15): no Redis, per-machine
// counters, damage control, not perfect distribution. Three guards:
//   - per-IP request cap on /register (stops signup floods / enumeration sweeps)
//   - per-IP request cap on /recover, counted separately so that being locked
//     out of an account is not made worse by having also tried to register
//   - per-email recovery-mail cooldown, SHARED by both endpoints, because both
//     now send the same recovery link to the same address and the thing being
//     protected is the mailbox, not the route

const ipHits = new Map<string, number[]>()
const recoverIpHits = new Map<string, number[]>()
const emailSends = new Map<string, number>()

const IP_LIMIT = 5
const RECOVER_IP_LIMIT = 10
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

/**
 * Per-IP cap on /recover, on its own counters. Deliberately more generous than
 * the register cap: the person hitting this is already locked out, and a typo
 * in their own address costs them an attempt.
 */
export function allowRecoverAttempt(ip: string): boolean {
  const now = Date.now()
  const hits = (recoverIpHits.get(ip) ?? []).filter((t) => now - t < IP_WINDOW_MS)
  if (hits.length >= RECOVER_IP_LIMIT) {
    recoverIpHits.set(ip, hits)
    return false
  }
  hits.push(now)
  recoverIpHits.set(ip, hits)
  prune(recoverIpHits)
  return true
}

// Cooldown is only armed by markRecoverySent, a failed send must not block
// the next attempt (or claim an email that never went out).
export function recoveryInCooldown(email: string): boolean {
  const last = emailSends.get(email)
  return !!last && Date.now() - last < EMAIL_COOLDOWN_MS
}

export function markRecoverySent(email: string): void {
  emailSends.set(email, Date.now())
  prune(emailSends)
}
