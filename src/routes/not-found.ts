import type { FastifyInstance } from 'fastify'
import { head } from '../ui/theme.js'
import { siteNav, siteFooter, CHROME_CSS } from '../ui/chrome.js'
import { brotliCompressSync, gzipSync, constants as Z } from 'node:zlib'
import type { FastifyReply, FastifyRequest } from 'fastify'

// Until this file existed, every unmatched URL on agentbill.dev answered
//
//   401 {"error":"unauthorized","message":"Missing API key..."}
//
// because the root onRequest hook in src/middleware/auth.ts ran ahead of
// routing's failure. Every typo, every stale inbound link and every crawler
// probe got an API error for a page. The hook now returns early on
// request.is404; this is what it falls through to.
//
// The page never repeats the URL that was asked for. Reflecting request.url
// into the body would hand anyone probing the site a free echo endpoint, and
// it tells the reader nothing they did not just type.

const DESTINATIONS: ReadonlyArray<readonly [label: string, href: string]> = [
  ['Docs', '/docs'],
  ['Pricing', '/pricing'],
  ['Live console', '/app?demo=1'],
  ['Get an API key', '/register'],
]

const CSS = `${CHROME_CSS}
    .nf { max-width: var(--shell); margin: 0 auto; padding-inline: 24px;
          padding-block: 96px 120px; }
    .nf-code { font-family: var(--mono); font-size: var(--fs-micro); letter-spacing: .18em;
               text-transform: uppercase; color: var(--dim); margin-bottom: 14px; }
    .nf h1 { color: var(--white); max-width: 18ch; margin-bottom: 16px; }
    .nf p { color: var(--muted); font-size: var(--fs-lede); max-width: 52ch;
            margin-bottom: 36px; }
    .nf-go { display: flex; flex-wrap: wrap; gap: 12px; }
`

export function notFoundPage(): string {
  return `${head({
    title: 'Page not found · AgentBill',
    description: 'That page is not on agentbill.dev.',
    // Not in the page registry, because it is not a page. noindex is explicit.
    noindex: true,
    scriptHashes: [],
    css: CSS,
  })}
<body>
${siteNav()}
  <main class="nf">
    <div class="nf-code">404</div>
    <h1>That page is not here.</h1>
    <p>Nothing is served at that address. It may have moved, or the link that
       brought you here may be old. These are the four places worth going.</p>
    <div class="nf-go">
      ${DESTINATIONS.map(([label, href]) => `<a class="btn-ghost" href="${href}">${label}</a>`).join('\n      ')}
    </div>
  </main>
${siteFooter()}
</body>
</html>`
}


/**
 * The page, compressed once.
 *
 * @fastify/compress assigns reply.compress per route from a hook, and the
 * not-found handler is not a route, so on this reply the decorator is null:
 * calling it threw, and Fastify answered every mistyped URL with its default
 * 404 JSON carrying the TypeError text. That shipped to the working tree and
 * not further. The page has no per-request data, so it is encoded here at
 * module load, three ways, and the request picks one.
 */
const PAGE = notFoundPage()
const ENCODED = {
  identity: Buffer.from(PAGE, 'utf8'),
  gzip: gzipSync(PAGE),
  br: brotliCompressSync(PAGE, { params: { [Z.BROTLI_PARAM_QUALITY]: 5 } }),
}

export function sendNotFoundPage(request: FastifyRequest, reply: FastifyReply, code: 400 | 404) {
  const ae = String(request.headers['accept-encoding'] ?? '')
  const enc = /\bbr\b/.test(ae) ? 'br' : /\bgzip\b/.test(ae) ? 'gzip' : 'identity'
  reply.code(code).type('text/html; charset=utf-8').header('Vary', 'Accept-Encoding')
  if (enc !== 'identity') reply.header('Content-Encoding', enc)
  return reply.send(ENCODED[enc])
}

export function registerNotFound(app: FastifyInstance) {
  app.setNotFoundHandler((request, reply) => {
    // /docs/ is /docs. Only /app/ had a redirect and it dropped the query; every
    // other page 404'd on a trailing slash, which is how links get typed.
    const qi = request.url.indexOf('?')
    const path = qi === -1 ? request.url : request.url.slice(0, qi)
    const query = qi === -1 ? '' : request.url.slice(qi)
    if (path.length > 1 && path.endsWith('/')) {
      return reply.redirect(path.replace(/\/+$/, '') + query, 301)
    }
    reply.header('X-Robots-Tag', 'noindex')
    reply.header('Cache-Control', 'no-store')

    // A browser gets the page; anything else gets a small fixed body. Scripted
    // probes send Accept: */*, so they cost ~100 bytes rather than a full page.
    const accept = request.headers.accept ?? ''
    if (accept.includes('text/html')) {
      return sendNotFoundPage(request, reply, 404)
    }
    return reply.code(404).send({
      error: 'not_found',
      message: 'No such endpoint. See https://agentbill.dev/docs',
    })
  })
}
