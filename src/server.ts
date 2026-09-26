import 'dotenv/config'
import { STATUS_CODES } from 'node:http'
import { ID_MAX } from './lib/ids.js'
import Fastify, { type FastifyReply } from 'fastify'
import { eventsRoute } from './routes/events.js'
import { budgetRoute } from './routes/budget.js'
import { dashboardRoute } from './routes/dashboard.js'
import { registerRoute } from './routes/register.js'
import { homeRoute } from './routes/home.js'
import { docsRoute } from './routes/docs.js'
import { preflightRoute } from './routes/preflight.js'
import { pulseRoute } from './routes/pulse.js'
import { registerAuth, publicRoute } from './middleware/auth.js'
import { COMMIT } from './lib/version.js'
import { registerNotFound, sendNotFoundPage } from './routes/not-found.js'
import { registerHeaders, applySecurityHeaders } from './middleware/headers.js'
import compress from '@fastify/compress'
import etag from '@fastify/etag'
import { constants as zlibConstants } from 'node:zlib'
import { webhooksRoute } from './routes/webhooks.js'
import { inboundMailRoute } from './routes/inbound-mail.js'
import { guidesRoute } from './routes/guides.js'
import { integrationsRoute } from './routes/integrations.js'
import { blogRoute } from './routes/blog.js'
import { checkpointRoute } from './routes/checkpoint.js'
import { stepRoute } from './routes/step.js'
import { webhookConfigRoute } from './routes/webhook-config.js'
import { upgradeRoute } from './routes/upgrade.js'
import { adminRoute } from './routes/admin.js'
import { keysRoute } from './routes/keys.js'
import { tasksRoute } from './routes/tasks.js'
import { decisionsRoute } from './routes/decisions.js'
import { usageRoute } from './routes/usage.js'
import { appRoute } from './routes/app.js'
import { legalRoute } from './routes/legal.js'
import { heCostPerClientRoute } from './routes/he-cost-per-client.js'
import { faqRoute } from './routes/faq.js'
import { shareRoute } from './routes/share.js'
import { aboutRoute } from './routes/about.js'
import { thanksRoute } from './routes/thanks.js'
import { recoverRoute } from './routes/recover.js'
import { authRoute } from './routes/auth.js'
import { statusRoute } from './routes/status.js'
import { securityRoute } from './routes/security.js'
import { oauthRoute } from './routes/oauth.js'
import { mcpRoute } from './routes/mcp.js'
import { startOAuthPruner } from './lib/mcp-oauth.js'
import { startRetention } from './lib/retention.js'
import { startSpikes } from './lib/spike.js'
import { probeDb, startDbWatchdog } from './lib/db-watchdog.js'
import { startReservationSweeper } from './lib/reservation-sweeper.js'
import { sql } from './db/index.js'
import { startConversionDigest } from './lib/conversion-digest.js'
import { OG_PNG, OG_VERSION } from './lib/og-image.js'
import { FAVICON_ICO, APPLE_TOUCH_PNG } from './lib/icons.js'
import { FAVICON_SVG } from './ui/mark.js'
import { FOUNDER_JPG } from './lib/photo.js'
import { HERO_LOOP_MP4, HERO_POSTER_JPG } from './lib/hero-video.js'
import { BRAND } from './ui/theme.js'
import { PAGES, indexable, abs, ORIGIN } from './ui/site.js'
import { llmsTxt, llmsFullTxt } from './lib/llms.js'
import { redactUrl, serializeRequest, redactingStream } from './lib/log-redact.js'
import { assertProductionSecrets } from './lib/secrets.js'

// Refuses to start in production with a session or admin secret short enough
// to guess. Before anything listens. See ./lib/secrets.ts.
assertProductionSecrets()

const app = Fastify({
  // The request line in every log entry is the path alone, with a recovery
  // token replaced (./lib/log-redact.ts). The default wrote req.url whole,
  // so each click on a recovery link left a live token in the log.
  // Every line also passes redactingStream, which replaces anything shaped
  // like an API key (security batch B, 2026-09-25).
  logger: { serializers: { req: serializeRequest as never }, stream: redactingStream },
  // A malformed percent-encoding in the path (/%) fails inside the router,
  // before any hook or setErrorHandler this app registers can see it, and
  // Fastify's default answer is a JSON body that echoes the URL back to the
  // client. frameworkErrors is the one seam that runs for it. Same page as the
  // 404, status 400, nothing reflected.
  // Typed loosely on purpose: the constructor infers a reply generic here that
  // rejects code()/send() on a plain string. This is an ordinary reply.
  // A task_ref may be 128 characters (src/lib/ids.ts) and Fastify's default
  // ceiling on a path segment is 100, so GET /tasks/:task_ref answered 404 for
  // a task that exists and that POST /preflight was happy to create.
  //
  // Nested under routerOptions because Fastify 5 deprecated reading it from the
  // top level (FSTDEP022) and removes that reading in 6. It warned on every
  // boot and the warning was the only notice anyone would get.
  routerOptions: { maxParamLength: ID_MAX },
  frameworkErrors: (error, request, reply: FastifyReply) => {
    // This reply never reaches the onSend hook, so it applies that hook's
    // security headers itself. Under Fastify 4 nothing arrived here except a
    // malformed URL, and it went out bare; Fastify 5 sends an over-long path
    // segment here too, so the gap was worth closing rather than preserving.
    applySecurityHeaders(reply)
    reply.header('X-Robots-Tag', 'noindex').header('Cache-Control', 'no-store')

    // The framework's own status, not a flat 400. /% is FST_ERR_BAD_URL at 400
    // and a 129-character path segment is FST_ERR_MAX_PARAM_LENGTH at 414, and
    // answering both 400 would say the URL was malformed when it was merely
    // too long. Only 4xx is honoured: a 5xx here is ours to own, not to relay.
    // The message is never relayed either — Fastify's echoes the URL back.
    const raw = (error as { statusCode?: number } | null)?.statusCode
    const status = raw === 414 ? 414 : 400
    const accept = request.headers.accept ?? ''
    if (accept.includes('text/html')) return sendNotFoundPage(request, reply, status)
    return status === 414
      ? reply.code(414).send({
          error: 'uri_too_long',
          message: `A path segment is longer than ${ID_MAX} characters.`,
        })
      : reply.code(400).send({ error: 'bad_request', message: 'Malformed URL.' })
  },
})

// Nothing that reaches a client carries a database message.
//
// There was no error handler at all, so an exception inside a route fell to
// Fastify's default, which serialises error.message into the response body.
// Postgres answers a NUL byte in a text parameter with 22021, "invalid byte
// sequence for encoding UTF8: 0x00", and that sentence WAS the body of the 500
// on GET /decisions?task_ref=%00. Every id is validated now, but validation is
// a promise each route makes one at a time, and this is the single place that
// can keep it for all of them, including the routes nobody has written yet: a
// 5xx says nothing about the database, the query, or the schema.
//
// An error that carries its own status below 500 is the framework's own (404,
// 415, a body over the limit). Those pass through in the shape Fastify would
// have sent, because the smoke tests and the SDKs already read that shape.
app.setErrorHandler((error, request, reply) => {
  // Fastify 5 types this parameter as `unknown`, and that is the truth rather
  // than a nuisance: a handler can throw anything, and under v4's FastifyError
  // typing a thrown string would have read .message as undefined. Narrow once,
  // here, instead of casting at each use.
  const status = (error as { statusCode?: number } | null)?.statusCode ?? 500
  const code = (error as { code?: string } | null)?.code
  const message = error instanceof Error ? error.message : String(error)
  if (status < 500) {
    // Fastify's own 4xx bodies carry a `code` (FST_ERR_CTP_INVALID_MEDIA_TYPE
    // and friends) and its default handler logs them. Dropping either would
    // make the comment above this function false.
    request.log.warn({ err: error, url: redactUrl(request.url) }, 'request error')
    return reply.code(status).send({
      statusCode: status,
      error: STATUS_CODES[status] ?? 'Error',
      message,
      ...(code ? { code } : {}),
    })
  }
  request.log.error({ err: error, url: redactUrl(request.url) }, 'unhandled error')
  return reply.code(500).send({ error: 'internal_error', message: 'Unexpected server error' })
})

// Canonical-host redirect. Off until CANONICAL_HOST is set (fly secrets set
// CANONICAL_HOST=agentbill.dev once DNS validates), so nothing breaks while
// the domain propagates. Marketing GETs only: Polar posts webhooks to the
// fly.dev host, and every SDK published before 2026-09-15 defaults to it, so
// API traffic must keep working on the old host forever. The SDKs in this repo
// now default to agentbill.dev and never meet this redirect; the copies already
// installed in the wild still call fly.dev, which is why none of this retires.
const CANONICAL_HOST = process.env.CANONICAL_HOST
// Inverted 2026-09-05. This was an allow-list of marketing paths, which meant
// every new page had to be added to a regex in this file or silently stopped
// being canonicalised, and it still named `guides`, a route that does not exist.
//
// It is now a deny-list of API prefixes, and the entries are load-bearing: the
// redirect is cross-host, and a 301 to another host drops the Authorization
// header in curl without --location-trusted, in requests, and in fetch. Every
// authenticated GET a published SDK might call against agentbill.fly.dev has to
// be on this list or its callers start getting 401s. Moving the SDK default to
// agentbill.dev does NOT shrink this list: an installed SDK keeps calling the
// host it was published with, for as long as it stays installed. Enumerated from
// `grep -rn "app.get(" src/routes/`; the CI audit asserts each still 401s.
const API_PREFIXES = [
  '/preflight', '/events', '/keys', '/tasks', '/budget', '/customers',
  '/checkpoint', '/step', '/decisions', '/webhook-config', '/webhooks/',
  '/health', '/pulse', '/account/', '/usage',
  // 2026-09-25: the remote MCP endpoint and its OAuth server. /mcp carries a
  // Bearer on GET like any API path; the metadata and token endpoints are
  // read by clients that follow no cross-host redirect with a body.
  '/mcp', '/oauth/', '/.well-known/',
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
// 9.x, which requires Fastify 5. It also computes a syncThreshold from the
// core count and compresses anything smaller in one call instead of through a
// stream. Fly gives this app one shared vCPU, where that threshold is 65536.
// Measured rather than feared: the homepage is 97,650 bytes, so it still
// streams, and a full synchronous brotli-5 pass over it costs 1.5ms, which is
// the ceiling on what any smaller page could block the loop for.
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

app.register(homeRoute)
app.register(docsRoute)
app.register(guidesRoute)
app.register(integrationsRoute)
app.register(blogRoute)
app.register(checkpointRoute)
app.register(stepRoute)
app.register(webhookConfigRoute)
app.register(upgradeRoute)
app.register(adminRoute)
app.register(keysRoute)
app.register(tasksRoute)
app.register(decisionsRoute)
app.register(usageRoute)
app.register(appRoute)
app.register(preflightRoute)
app.register(pulseRoute)
app.register(webhooksRoute)
app.register(inboundMailRoute)
app.register(legalRoute)
app.register(faqRoute)
app.register(shareRoute)
app.register(aboutRoute)
app.register(thanksRoute)
app.register(recoverRoute)
app.register(authRoute)
app.register(statusRoute)
app.register(securityRoute)
app.register(oauthRoute)
app.register(mcpRoute)
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

// The homepage hero loop: 3.8s, 1280x720, no audio stream, cut from the brand
// film by scripts/hero-video/build.sh. Immutable is wrong here for the same
// reason it is wrong for the icons — the path carries no version — but a day is
// safe, because the poster is what a cold visitor sees first and the loop only
// has to arrive before they scroll.
const HERO_CACHE = 'public, max-age=86400'

app.get('/hero-loop.mp4', publicRoute(), async (_, reply) => {
  return reply.type('video/mp4').header('Cache-Control', HERO_CACHE).send(HERO_LOOP_MP4)
})

app.get('/hero-poster.jpg', publicRoute(), async (_, reply) => {
  return reply.type('image/jpeg').header('Cache-Control', HERO_CACHE).send(HERO_POSTER_JPG)
})

// Open Graph card for link previews and ads (1200x630, embedded at build time).
//
// Every head names it as /og.png?v=<OG_VERSION>, a hash of these bytes (see
// ui/og.ts), so a chat app that cached the old card by URL fetches the new one.
// That exact URL can never serve different bytes, so it is immutable for a
// year. Anything else, the bare /og.png an old share or an ad still carries
// and a stale ?v= from a page cached before a rebuild, gets the current card
// on the old one-day policy: it has no version to promise, so it must not.
app.get('/og.png', publicRoute(), async (request, reply) => {
  const v = (request.query as { v?: unknown } | undefined)?.v
  reply.type('image/png').header('Cache-Control', v === OG_VERSION ? 'public, max-age=31536000, immutable' : 'public, max-age=86400')
  return reply.send(OG_PNG)
})

// Health check - useful for deploy verification.
// Liveness only (Fly restarts machines on failure, a dead DB shouldn't
// trigger a restart loop). DB truth lives at /health/db.
// Liveness only, no database: /health/db below is the deep one. `commit` is
// the one addition, and it is what lets a running image be tied to a commit
// from outside; it is a constant read at boot, so this stays a pure function.
//
// This route sends an ETag and no Cache-Control, which is what it did before
// and is deliberately left alone. It means the one field that changes between
// deploys sits on the only surface with no explicit freshness rule, so read it
// through a cache with that in mind; /status carries the same value under
// Cache-Control: no-store.
app.get('/health', publicRoute(), async () => ({ status: 'ok', commit: COMMIT }))

// Deep health: touches the database. Returns 503 when the DB is unreachable,
// point external monitors here. The May-Aug 2026 outage hid behind the
// DB-less /health for months; this endpoint exists so that can't recur.
//
// The driver's message goes to the log, not the body: it named the host, the
// port and the reason (ECONNREFUSED 10.x.x.x:5432, a TLS error, a password
// failure), and this route is public.
app.get('/health/db', publicRoute(), async (request, reply) => {
  const probe = await probeDb()
  if (!probe.ok) {
    request.log.error({ dbError: probe.error, latencyMs: probe.latencyMs }, '/health/db: database probe failed')
    return reply.code(503).send({ status: 'down', db: 'down', latency_ms: probe.latencyMs })
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
# AI crawlers are not blocked. This site publishes /llms.txt and /llms-full.txt
# specifically to be read by them; blocking GPTBot or ClaudeBot while advertising
# llms.txt would be incoherent.
#
# The two are named here rather than only in a comment because a crawler that
# reads robots.txt first has no other way to learn they exist: neither is HTML,
# so neither can be in the sitemap and neither can carry a link tag.
User-agent: *
Allow: /
${denied.map((d) => `Disallow: ${d}\nDisallow: ${d}/`).join('\n')}
Disallow: /webhooks/

Sitemap: ${ORIGIN}/sitemap.xml

# ${ORIGIN}/llms.txt
# ${ORIGIN}/llms-full.txt
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

// llms.txt and llms-full.txt, the two surfaces written for an answer engine
// rather than for a person. Bodies live in lib/llms.ts, beside the comment
// explaining what each paragraph is load-bearing for.
//
// max-age matches the prose pages in middleware/headers.ts. That hook only
// sets Cache-Control on text/html, so these two sent none at all and every
// crawler refetched them cold.
const LLMS_CACHE = 'public, max-age=600'

app.get('/llms.txt', publicRoute(), async (_, reply) => {
  return reply.type('text/plain').header('Cache-Control', LLMS_CACHE).send(llmsTxt())
})

app.get('/llms-full.txt', publicRoute(), async (_, reply) => {
  return reply.type('text/plain').header('Cache-Control', LLMS_CACHE).send(llmsFullTxt())
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
  startOAuthPruner(app.log)
  // Data retention (src/lib/retention.ts): RETENTION_MODE off (the default),
  // report or enforce. Off starts nothing.
  startRetention()
  startSpikes(app.log)
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
