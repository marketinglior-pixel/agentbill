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
