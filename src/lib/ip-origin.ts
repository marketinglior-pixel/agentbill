import { isIP } from 'node:net'

/**
 * The network an address belongs to, which is the unit a "we have not seen you
 * here before" signal is actually about.
 *
 * IPv4 is its own origin. IPv6 collapses to the /64, because that is what an
 * ISP hands a customer and everything inside it is one machine or one LAN. A
 * host does not sit still inside its /64: macOS keeps a stable `secured`
 * address and one or more `temporary` privacy addresses at once, rotates the
 * temporary one daily, and picks between them per connection. Measured on the
 * founder's laptop 2026-09-11, 100 consecutive requests to production:
 *
 *     84  2a00:a041:e327:b500:5033:89cf:1791:b686   temporary
 *     16  2a00:a041:e327:b500:5173:edf9:1a7d:7a95   temporary, deprecated
 *     28 changes between consecutive requests
 *
 * Twenty-eight per cent of requests "changed address" without anything moving.
 * Anything that treats a /128 as an identity — an alert, a rate-limit bucket —
 * is counting that noise.
 *
 * Returns null for something that is not an address, so a caller can tell
 * "no origin" from a real one instead of keying on a garbage string.
 */
export function ipOrigin(ip: string): string | null {
  const family = isIP(ip)
  if (family === 4) return ip
  if (family !== 6) return null

  const h = hextets(ip)
  if (!h) return null

  // ::ffff:203.0.113.9 is an IPv4 client on a v6 socket. Its origin is that
  // IPv4 address; taking the /64 would file every mapped address on earth
  // under one origin, which is the opposite of the point.
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff) {
    return [h[6]! >> 8, h[6]! & 0xff, h[7]! >> 8, h[7]! & 0xff].join('.')
  }

  return h.slice(0, 4).map((n) => n.toString(16)).join(':') + '::/64'
}

/**
 * An IPv6 address as its eight numeric groups, `::` expanded and any dotted
 * IPv4 tail folded into the low two. isIP() has already said this parses, so
 * this is normalisation and not validation — but it returns null rather than
 * guessing, because the result is written to the database and rendered into an
 * email, and a half-parsed address is worse than none.
 */
function hextets(ip: string): number[] | null {
  let s = ip.split('%')[0] ?? ''   // fe80::1%en0 — a zone is not part of the address

  const dotted = /(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(s)
  if (dotted) {
    const o = dotted[1]!.split('.').map(Number)
    if (o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
    // Rewrite in place so the '::' immediately to the left keeps its meaning.
    const keep = dotted.index + (dotted[0]!.startsWith(':') ? 1 : 0)
    s = s.slice(0, keep) +
        (((o[0]! << 8) | o[1]!).toString(16)) + ':' + (((o[2]! << 8) | o[3]!).toString(16))
  }

  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null

  let groups: string[]
  if (tail === null) {
    if (head.length !== 8) return null
    groups = head
  } else {
    const fill = 8 - head.length - tail.length
    if (fill < 0) return null
    groups = [...head, ...Array<string>(fill).fill('0'), ...tail]
  }

  if (!groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null
  return groups.map((g) => parseInt(g, 16))
}
