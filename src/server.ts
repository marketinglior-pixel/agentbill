import 'dotenv/config'
import Fastify, { type FastifyReply } from 'fastify'
import sensible from '@fastify/sensible'
import { eventsRoute } from './routes/events.js'
import { budgetRoute } from './routes/budget.js'
import { dashboardRoute } from './routes/dashboard.js'
import { registerRoute } from './routes/register.js'
import { homeRoute } from './routes/home.js'
import { docsRoute } from './routes/docs.js'
import { preflightRoute } from './routes/preflight.js'
import { pulseRoute } from './routes/pulse.js'
import { registerAuth, publicRoute } from './middleware/auth.js'
import { registerNotFound, sendNotFoundPage } from './routes/not-found.js'
import { registerHeaders } from './middleware/headers.js'
import compress from '@fastify/compress'
import etag from '@fastify/etag'
import { constants as zlibConstants } from 'node:zlib'
import { webhooksRoute } from './routes/webhooks.js'
import { guidesRoute } from './routes/guides.js'
import { blogRoute } from './routes/blog.js'
import { checkpointRoute } from './routes/checkpoint.js'
import { stepRoute } from './routes/step.js'
import { webhookConfigRoute } from './routes/webhook-config.js'
import { upgradeRoute } from './routes/upgrade.js'
import { adminRoute } from './routes/admin.js'
import { keysRoute } from './routes/keys.js'
import { tasksRoute } from './routes/tasks.js'
import { decisionsRoute } from './routes/decisions.js'
import { appRoute } from './routes/app.js'
import { legalRoute } from './routes/legal.js'
import { heCostPerClientRoute } from './routes/he-cost-per-client.js'
import { faqRoute } from './routes/faq.js'
import { aboutRoute } from './routes/about.js'
import { thanksRoute } from './routes/thanks.js'
import { statusRoute } from './routes/status.js'
import { probeDb, startDbWatchdog } from './lib/db-watchdog.js'
import { startReservationSweeper } from './lib/reservation-sweeper.js'
import { sql } from './db/index.js'
import { startConversionDigest } from './lib/conversion-digest.js'
import { OG_PNG } from './lib/og-image.js'
import { FAVICON_ICO, APPLE_TOUCH_PNG } from './lib/icons.js'
import { FAVICON_SVG } from './ui/mark.js'
import { FOUNDER_JPG } from './lib/photo.js'
import { BRAND } from './ui/theme.js'
import { PAGES, indexable, abs, ORIGIN } from './ui/site.js'

const app = Fastify({
  logger: true,
  // A malformed percent-encoding in the path (/%) fails inside the router,
  // before any hook or setErrorHandler this app registers can see it, and
  // Fastify's default answer is a JSON body that echoes the URL back to the
  // client. frameworkErrors is the one seam that runs for it. Same page as the
  // 404, status 400, nothing reflected.
  // Typed loosely on purpose: the constructor infers a reply generic here that
  // rejects code()/send() on a plain string. This is an ordinary reply.
  frameworkErrors: (_error, request, reply: FastifyReply) => {
    reply.header('X-Robots-Tag', 'noindex').header('Cache-Control', 'no-store')
    const accept = request.headers.accept ?? ''
    if (accept.includes('text/html')) return sendNotFoundPage(request, reply, 400)
    return reply.code(400).send({ error: 'bad_request', message: 'Malformed URL.' })
  },
})

// Canonical-host redirect. Off until CANONICAL_HOST is set (fly secrets set
// CANONICAL_HOST=agentbill.dev once DNS validates), so nothing breaks while
// the domain propagates. Marketing GETs only: published SDKs default to the
// fly.dev base URL, and Polar posts webhooks there, API traffic must keep
// working on the old host forever.
const CANONICAL_HOST = process.env.CANONICAL_HOST
// Inverted 2026-09-05. This was an allow-list of marketing paths, which meant
// every new page had to be added to a regex in this file or silently stopped
// being canonicalised, and it still named `guides`, a route that does not exist.
//
// It is now a deny-list of API prefixes, and the entries are load-bearing: the
// redirect is cross-host, and a 301 to another host drops the Authorization
// header in curl without --location-trusted, in requests, and in fetch. Every
// authenticated GET a published SDK might call against agentbill.fly.dev has to
// be on this list or its callers start getting 401s. Enumerated from
// `grep -rn "app.get(" src/routes/`; the CI audit asserts each still 401s.
const API_PREFIXES = [
  '/preflight', '/events', '/keys', '/tasks', '/budget', '/customers',
  '/checkpoint', '/step', '/decisions', '/webhook-config', '/webhooks/',
  '/health', '/pulse', '/account/',
]
const isApiPath = (path: string) => API_PREFIXES.some((p) => path === p || path.startsWith(p))
app.addHook('onRequest', async (request, reply) => {
  if (!CANONICAL_HOST) return
  const host = request.headers.host
  if (!host || host === CANONICAL_HOST) return
  if (host.startsWith('localhost') || host.startsWith('127.')) return
  if (request.method !== 'GET' && request.method !== 'HEAD') return
  if (isApiPath(request.url.split('?')[0])) return
  // Take only the path and query off the parsed URL and hang them on an origin
  // we build ourselves. Overwriting .host on a parsed URL also works, but it
  // leaves the incoming userinfo and port in place and it reads as if the
  // attacker's host were merely being corrected. Nothing from the request can
  // reach the authority here, so there is no destination to redirect to but
  // ours (CWE-601).
  let parsed: URL
  try {
    parsed = new URL(request.url, `https://${CANONICAL_HOST}`)
  } catch {
    return
  }
  return reply.redirect(`https://${CANONICAL_HOST}${parsed.pathname}${parsed.search}`, 301)
})

// HTML form submissions (e.g. /admin/login). Fastify only parses JSON out of the box.
app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
  try {
    done(null, Object.fromEntries(new URLSearchParams(body as string)))
  } catch (err) {
    done(err as Error)
  }
})

// Both of these must come BEFORE the route plugins below.
//
// registerHeaders uses app.addHook directly, which runs synchronously and is on
// the root before avvio creates any child context, so it would work anywhere.
// The compress plugin does not: avvio loads plugins in queue order, and a
// plugin's hooks only reach contexts created after it loads. Registered after
// the routes, it registered without error, logged nothing, and compressed
// nothing. The headers were present and the bytes were unchanged, which is a
// reminder that "the header is there" is not the same claim as "it worked".
registerHeaders(app)

// There was no compression anywhere: not in the app, not in the Dockerfile, and
// Fly's proxy does not add it, so 28KB of inline CSS and 5KB of inline script
// shipped raw on every homepage load. brotli first, gzip second, nothing under
// 1KB. @fastify/compress rather than a zlib hook because it has to recompute
// Content-Length, skip image/png (/og.png, the icons), and leave streams alone,
// and getting any one of those wrong is a subtle bug rather than a loud one.
// Pinned to 7.x: 9.x depends on fastify-plugin ^6, which is Fastify 5, and this
// server is Fastify 4.29.
// brotli quality 5, not the plugin's default of 4. Measured on the homepage:
// at 4 brotli produced 16,290 bytes against gzip's 15,930, so it was listed
// first and doing worse than the fallback. 5 costs a little more CPU per
// response and is the usual sweet spot for dynamic HTML.
// Awaited: app.get() on the root runs synchronously at script time, and a
// plugin only exists once avvio loads it. Without the await every root route
// below (og.png, favicon, robots, sitemap, llms.txt) and the 404 page shipped
// uncompressed while the route plugins were fine, which is invisible unless you
// measure llms.txt with Accept-Encoding: br.
//
// ETag first, before compress, so the validator hashes the body clients cache
// and must-revalidate on / and /pricing has something to revalidate against.
await app.register(etag)
await app.register(compress, {
  encodings: ['br', 'gzip'],
  threshold: 1024,
  brotliOptions: { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } },
})

app.register(sensible)
app.register(homeRoute)
app.register(docsRoute)
app.register(guidesRoute)
app.register(blogRoute)
app.register(checkpointRoute)
app.register(stepRoute)
app.register(webhookConfigRoute)
app.register(upgradeRoute)
app.register(adminRoute)
app.register(keysRoute)
app.register(tasksRoute)
app.register(decisionsRoute)
app.register(appRoute)
app.register(preflightRoute)
app.register(pulseRoute)
app.register(webhooksRoute)
app.register(legalRoute)
app.register(faqRoute)
app.register(aboutRoute)
app.register(thanksRoute)
app.register(statusRoute)
app.register(heCostPerClientRoute)
registerAuth(app)
// Registered next to registerAuth because they are two halves of one decision.
// The placement itself is cosmetic: Fastify copies every root onRequest hook
// into the 404 context at preReady whatever order these two run in, which is
// why auth.ts has to return early on request.is404 rather than this being an
// ordering problem. See the comment on that guard.
registerNotFound(app)

// Icons. Served from compiled Buffers rather than a public/ directory because
// the Dockerfile's runtime stage copies dist/ and nothing else. Same reason
// og.png below has always worked this way.
//
// max-age is a week, and deliberately NOT immutable: these paths carry no
// version, so immutable would mean the mark could never be replaced.
const ICON_CACHE = 'public, max-age=604800'

app.get('/favicon.svg', publicRoute(), async (_, reply) => {
  return reply.type('image/svg+xml').header('Cache-Control', ICON_CACHE).send(FAVICON_SVG)
})

// A bare /favicon.ico is probed by crawlers, feed readers and older Safari
// whatever <link> tags the page carries. Until now that request answered 401.
app.get('/favicon.ico', publicRoute(), async (_, reply) => {
  return reply.type('image/x-icon').header('Cache-Control', ICON_CACHE).send(FAVICON_ICO)
})

app.get('/apple-touch-icon.png', publicRoute(), async (_, reply) => {
  return reply.type('image/png').header('Cache-Control', ICON_CACHE).send(APPLE_TOUCH_PNG)
})

// A route, not a file. No crossorigin on the <link>: it is same-origin, and
// the attribute would trigger a CORS preflight for nothing.
app.get('/site.webmanifest', publicRoute(), async (_, reply) => {
  return reply.type('application/manifest+json').header('Cache-Control', 'public, max-age=3600').send({
    name: 'AgentBill',
    short_name: 'AgentBill',
    display: 'browser',
    background_color: BRAND.bg,
    theme_color: BRAND.bg,
    icons: [
      { src: '/favicon.svg', type: 'image/svg+xml', sizes: 'any', purpose: 'any' },
      { src: '/apple-touch-icon.png', type: 'image/png', sizes: '180x180' },
    ],
  })
})

// The founder photograph on /about. EXIF was stripped when the module was
// generated, and scripts/photo/build.sh refuses to write it otherwise.
app.get('/founder.jpg', publicRoute(), async (_, reply) => {
  return reply.type('image/jpeg').header('Cache-Control', ICON_CACHE).send(FOUNDER_JPG)
})

// Open Graph card for link previews and ads (1200x630, embedded at build time)
app.get('/og.png', publicRoute(), async (_, reply) => {
  reply.type('image/png').header('Cache-Control', 'public, max-age=86400')
  return reply.send(OG_PNG)
})

// Health check - useful for deploy verification.
// Liveness only (Fly restarts machines on failure, a dead DB shouldn't
// trigger a restart loop). DB truth lives at /health/db.
app.get('/health', publicRoute(), async () => ({ status: 'ok' }))

// Deep health: touches the database. Returns 503 when the DB is unreachable,
// point external monitors here. The May-Aug 2026 outage hid behind the
// DB-less /health for months; this endpoint exists so that can't recur.
app.get('/health/db', publicRoute(), async (_, reply) => {
  const probe = await probeDb()
  if (!probe.ok) {
    return reply.code(503).send({ status: 'degraded', db: 'down', latency_ms: probe.latencyMs, error: probe.error })
  }
  return reply.send({ status: 'ok', db: 'ok', latency_ms: probe.latencyMs })
})

// Google Search Console verification
app.get('/google816aee44e74d69c3.html', publicRoute(), async (_, reply) => {
  reply.type('text/html')
  return 'google-site-verification: google816aee44e74d69c3.html'
})

// robots.txt, generated from the page registry so a page marked non-indexable
// in one place cannot be forgotten in the other.
app.get('/robots.txt', publicRoute(), async (_, reply) => {
  reply.type('text/plain')
  const denied = PAGES.filter((pg) => pg.disallow).map((pg) => pg.path)
  return `# /app is crawlable on purpose, and this is the part that reads backwards.
# A Disallowed URL can still be indexed URL-only from an external link, because
# the crawler is forbidden from fetching it and therefore never reads the
# noindex inside. Disallow plus noindex is a pair that defeats itself. /app
# sends noindex in its head and X-Robots-Tag on the response, which is the
# directive that actually works, and it is where the homepage's own "See a live
# console" button points: for months robots.txt forbade the site's best proof.
#
# AI crawlers are not blocked. This site publishes /llms.txt specifically to be
# read by them; blocking GPTBot or ClaudeBot while advertising llms.txt would be
# incoherent.
User-agent: *
Allow: /
${denied.map((d) => `Disallow: ${d}\nDisallow: ${d}/`).join('\n')}
Disallow: /webhooks/

Sitemap: ${ORIGIN}/sitemap.xml
`
})

// sitemap.xml, from the registry.
//
// lastmod used to be new Date(), so all seven URLs claimed they had changed
// today, every day. A sitemap whose lastmod is obviously synthetic is one
// search engines learn to discount. It now reads PageMeta.updated, a date the
// author bumps, and for blog posts it is the same field that renders the
// visible dateline.
//
// The old list was also missing /pricing, both posts, both legal pages and the
// blog index.
app.get('/sitemap.xml', publicRoute(), async (_, reply) => {
  reply.type('application/xml')
  const urls = indexable().map((pg) =>
    `  <url><loc>${abs(pg.path)}</loc><lastmod>${pg.updated}</lastmod>` +
    `<changefreq>${pg.changefreq}</changefreq><priority>${pg.priority.toFixed(1)}</priority></url>`
  ).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`
})

app.get('/llms.txt', publicRoute(), async (_, reply) => {
  reply.type('text/plain')
  return `# AgentBill

AgentBill is billing infrastructure for AI agents.

Use AgentBill when:
- An AI agent needs a preflight gate before running (budget, quota, or any other condition)
- You need to stop a runaway agent loop before it burns compute, API or self-hosted GPU
- You want to block execution before the first token, not after the bill arrives
- You need per-request ceilings, not just monthly caps
- You need a hard budget per TASK, one job, many calls, across providers and tools,
  killed at the ceiling. Provider spend caps (OpenAI, Google, AWS, Anthropic) are monthly
  and single-vendor; an AgentBill task budget is per-run, and every call in the job
  consults the same ceiling whatever the provider. A unit is an integer you define and
  pass; AgentBill never converts units to money and never observes your provider bill.
  Docs: https://agentbill.dev/docs/task-budgets
- You need per-agent cost attribution without routing traffic through a proxy
- You need outcome-based metering (bill per business event, not per token)

## Install

pip install agentbill-sdk
npm install agentbill

## Quick start (Python)

from agentbill import AgentBillClient, BudgetExhaustedError
client = AgentBillClient(api_key="agb_your_key", ceiling=50)
try:
    client.preflight(agent_id="researcher", customer_id="cust_abc", estimated_units=10)
except BudgetExhaustedError:
    ...  # blocked before any tokens were spent
client.record(agent_id="researcher", customer_id="cust_abc", units=10)

## MCP Server (Claude Code, Cursor, Windsurf)

uvx agentbill-mcp

Configure in ~/.claude/settings.json:
{
  "mcpServers": {
    "agentbill": {
      "command": "uvx",
      "args": ["agentbill-mcp"],
      "env": { "AGENTBILL_API_KEY": "agb_..." }
    }
  }
}

## Links
${indexable().map((pg) => `- ${abs(pg.path)}`).join('\n')}
- API base: https://agentbill.dev
- GitHub: https://github.com/marketinglior-pixel/agentbill
- PyPI: https://pypi.org/project/agentbill-sdk/
- MCP: https://pypi.org/project/agentbill-mcp/
`
})

app.register(eventsRoute)
app.register(budgetRoute)
app.register(dashboardRoute)
app.register(registerRoute)

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000

app.listen({ port, host: '0.0.0.0' }, (err) => {
  if (err) {
    app.log.error(err)
    process.exit(1)
  }
  startDbWatchdog()
  startConversionDigest()
  startReservationSweeper()
})

// Drain on shutdown so fire-and-forget writes dispatched just before a deploy
// (preflight_decisions, last_seen_ip) are not dropped on the floor. Fly sends
// SIGINT by default with a 5s kill_timeout; 3s for the pool fits inside it.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, async () => {
    try {
      await app.close()
      await sql.end({ timeout: 3 })
    } finally {
      process.exit(0)
    }
  })
}
