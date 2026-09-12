import { ipOrigin } from './ip-origin.js'

// Behind fly-proxy request.ip is the proxy itself, one address for every
// visitor on earth. Fly sets fly-client-ip authoritatively (it overwrites any
// client-supplied value); x-forwarded-for is the fallback off Fly, then the
// socket address for local dev.
export function clientIp(request: { headers: Record<string, unknown>; ip: string }): string {
  const fly = request.headers['fly-client-ip']
  if (typeof fly === 'string' && fly.trim()) return fly.trim()
  const xff = request.headers['x-forwarded-for']
  const first = typeof xff === 'string' ? xff.split(',')[0]?.trim() : ''
  return first || request.ip
}

/**
 * The key an abuse counter should bucket by.
 *
 * Not the same thing as clientIp(). clientIp() answers "who sent this request",
 * which is the exact address, and that is right for a log line, for
 * last_seen_ip, and for anything a human will go and look up. A rate limit asks
 * a different question: "how much has this ORIGIN done lately", and on IPv6 the
 * address is not the origin. A host holds a stable `secured` address plus one
 * or more rotating `temporary` privacy addresses on one /64 and picks between
 * them per connection, so a per-address bucket hands the same machine a fresh
 * allowance every time it switches, without the caller intending anything.
 *
 * That made these counters quietly weaker on IPv6 than the number in their
 * constant suggests. It also made them inconsistent with themselves: the
 * comment on IP_LIMIT already reasons about "a team behind one office NAT" as
 * one bucket, which is exactly what an IPv6 /64 is. IPv4 has always been
 * bucketed per customer; IPv6 was being bucketed per address by accident.
 *
 * Falls back to the raw address when there is no parseable origin, so an
 * unparseable value is still counted rather than sharing one bucket with every
 * other unparseable value.
 */
export function limiterKey(request: { headers: Record<string, unknown>; ip: string }): string {
  const ip = clientIp(request)
  return ipOrigin(ip) ?? ip
}
