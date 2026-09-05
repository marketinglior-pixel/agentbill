import type { FastifyInstance } from 'fastify'
import { head } from '../ui/theme.js'
import { siteNav, siteFooter, CHROME_CSS } from '../ui/chrome.js'

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

function notFoundPage(): string {
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

export function registerNotFound(app: FastifyInstance) {
  app.setNotFoundHandler((request, reply) => {
    reply.header('X-Robots-Tag', 'noindex')
    reply.header('Cache-Control', 'no-store')

    // A browser gets the page; anything else gets a small fixed body. Scripted
    // probes send Accept: */*, so they cost ~100 bytes rather than a full page.
    const accept = request.headers.accept ?? ''
    if (accept.includes('text/html')) {
      return reply.code(404).type('text/html').send(notFoundPage())
    }
    return reply.code(404).send({
      error: 'not_found',
      message: 'No such endpoint. See https://agentbill.dev/docs',
    })
  })
}
