import type { FastifyInstance } from 'fastify'

// Response headers the site sent none of.
//
// Measured before this existed: no Strict-Transport-Security, no
// X-Content-Type-Options, no Referrer-Policy outside /app, and no Cache-Control
// on any HTML at all. /admin in particular lists every customer email and plan
// and was cacheable by any intermediary that felt like it.
//
// Every header is set only if the route has not set it itself, so /app's
// stricter Referrer-Policy and its own CSP are never clobbered by this hook.

const HTML_CACHE: ReadonlyArray<readonly [test: (p: string) => boolean, value: string]> = [
  // Both render PLAN_LIMITS and PLAN_PRICES. Ten minutes of stale pricing is
  // not a trade this site should make: the whole argument of the page is that
  // a number you can check is worth more than a number you are told.
  [(p) => p === '/' || p === '/pricing', 'public, max-age=0, must-revalidate'],
  // Prose. Nothing on these pages is derived from live state.
  [(p) => p.startsWith('/docs') || p.startsWith('/blog') || p === '/faq' ||
          p === '/about' || p === '/terms' || p === '/privacy', 'public, max-age=600'],
]

export function registerHeaders(app: FastifyInstance) {
  app.addHook('onSend', async (request, reply, payload) => {
    const set = (name: string, value: string) => {
      if (!reply.hasHeader(name)) reply.header(name, value)
    }

    // No `preload`. Preloading is effectively irreversible: removal takes months
    // to propagate through browser releases. includeSubDomains is wanted and is
    // reversible. fly.toml already forces https, so this is defence in depth
    // against a first-visit downgrade rather than a fix for something broken.
    set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    set('X-Content-Type-Options', 'nosniff')
    set('Referrer-Policy', 'strict-origin-when-cross-origin')
    set('X-Frame-Options', 'DENY')
    set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
    set('Cross-Origin-Opener-Policy', 'same-origin')

    const path = request.url.split('?')[0]
    const type = String(reply.getHeader('content-type') ?? '')
    if (type.startsWith('text/html')) {
      const match = HTML_CACHE.find(([test]) => test(path))
      // Anything not named above holds a key, a session or a form: no-store.
      set('Cache-Control', match ? match[1] : 'no-store')
    }
    return payload
  })
}
