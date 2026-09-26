import type { FastifyInstance } from 'fastify'
import { head } from '../ui/theme.js'
import { siteNav, siteFooter, CHROME_CSS } from '../ui/chrome.js'
import { publicRoute } from '../middleware/auth.js'
import { byPath } from '../ui/site.js'
import { RETENTION, retentionMode } from '../lib/retention.js'
import { OAUTH_PRUNE_AFTER_EXPIRY } from '../lib/mcp-oauth.js'
import { WRAP_SENDS, WRAP_NEVER, plaintextKeysStored } from '../lib/privacy-facts.js'
import { PIXEL_PATHS, configuredPixels } from '../lib/pixel.js'
import { capiConfigured } from '../lib/capi.js'
import { spikesOn } from '../lib/spike.js'
import { METADATA_MAX_BYTES } from './events.js'

// Terms + Privacy. The register form points here ("you agree to our Terms"),
// and Meta ad review checks destination pages for both. Plain, honest, short.

// Both dates come from the page registry in src/ui/site.ts, which is also what
// the sitemap's lastmod and each page's JSON-LD dateModified read. One source,
// so the line a person reads and the line a crawler reads cannot disagree. They
// did, for about an hour on 2026-09-18: the privacy policy gained a sentence
// (first-party page events disclosed), this file learned the new date as a
// literal, and site.ts still said August. The terms did not move that day.
const updatedOn = (path: string): string => {
  const iso = byPath.get(path)?.updated
  if (!iso) throw new Error(`site.ts has no updated date for ${path}`)
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}
const TERMS_UPDATED = updatedOn('/terms')
const PRIVACY_UPDATED = updatedOn('/privacy')
// hello@ receives since 2026-09-26 (src/routes/inbound-mail.ts): the one public
// contact, on Lior's choice, and a personal address is no longer on any page.
const CONTACT = 'hello@agentbill.dev'

function legalShell(title: string, path: string, body: string): string {
  return `${head({
    title: `${title} · AgentBill`,
    description: `${title} for AgentBill, budget ceilings for AI agents.`,
    path,
    scriptHashes: [],
    // Canvas, 2026-09-23: the column starts on the wordmark's edge (--shell is
    // the nav's width, as on every other page) and reads at the docs' measure;
    // the heading is the docs' h1, each numbered section one rung down at h3,
    // the date in the label register the posts use for a dateline, the prose
    // in --muted at the body size. Four font-size literals went to the scale.
    css: `${CHROME_CSS}
    :root { --shell: var(--chrome-w); }
    .container { max-width: var(--shell); margin: 0 auto;
                  padding-inline: var(--gutter); padding-block: var(--s7) 96px; }
    /* The ink, underlined on a quiet rule that darkens on hover, as in the docs. */
    .container a { color: var(--green); text-underline-offset: 3px; text-decoration-color: var(--border-strong); }
    .container a:hover { text-decoration-color: currentColor; }
    h1 { font-size: var(--fs-h1-sub); color: var(--text); margin-bottom: var(--s3); max-width: 26ch; }
    .updated { font-family: var(--mono); font-size: var(--fs-micro); color: var(--dim); margin-bottom: var(--s7); }
    h2 { font-size: var(--fs-h3); color: var(--text); margin: var(--s7) 0 var(--s3); max-width: 40ch; }
    .updated + h2 { margin-top: 0; }
    p, li { font-size: var(--fs-body); color: var(--muted); line-height: 1.7; margin-bottom: var(--s4); max-width: 62ch; }
    strong { color: var(--text); font-weight: 600; }
    ul { padding-inline-start: 20px; margin-bottom: var(--s4); }
    @media (max-width: 720px) {
      .container { padding-block: var(--s6) var(--s8); }
      h2 { margin-top: var(--s6); }
    }
`,
  })}
<body>
${siteNav('', { sticky: false })}
  <main class="container">
    ${body}
  </main>
${siteFooter()}
</body>
</html>`
}

export async function legalRoute(app: FastifyInstance) {
  app.get('/terms', publicRoute(), async (_, reply) => {
    reply.type('text/html')
    return reply.send(legalShell('Terms of Service', '/terms', `
    <h1>Terms of Service</h1>
    <p class="updated">Last updated: ${TERMS_UPDATED}</p>

    <h2>1. The service</h2>
    <p>AgentBill provides billing governance for AI agents: preflight budget checks, per-task spend
    ceilings, usage metering, and API key security. The service is provided by AgentBill
    ("we", "us") to you, the account holder.</p>

    <h2>2. Accounts and API keys</h2>
    <p>You need a valid email to register. You are responsible for keeping your API keys secret and
    for all activity performed with them. You can revoke or rotate keys at any time via the API.</p>

    <h2>3. Free tier and paid plans</h2>
    <p>The free tier includes 1,000 preflight calls per month at no cost, with no credit card
    required. Paid plans (Builder, Team, Scale) are billed monthly through our payment provider,
    Polar. You can cancel anytime; access continues until the end of the paid period.</p>

    <h2>4. Acceptable use</h2>
    <p>Don't use the service to break the law, to abuse third-party APIs, or to attack the service
    itself (including attempts to bypass rate limits or budget enforcement). We may suspend accounts
    that do.</p>

    <h2>5. Service quality</h2>
    <p>AgentBill is a guardrail, not a guarantee. We work hard to keep enforcement fast and
    available, but the service is provided "as is", without warranties of any kind. You remain
    responsible for the spend limits configured in your provider accounts.</p>

    <h2>6. Liability</h2>
    <p>To the maximum extent permitted by law, our total liability for any claim related to the
    service is limited to the amount you paid us in the three months before the claim arose.</p>

    <h2>7. Termination</h2>
    <p>You can delete your account at any time by emailing us. We may terminate accounts that
    violate these terms, with notice where practical.</p>

    <h2>8. Changes</h2>
    <p>We may update these terms; material changes will be announced on this page with a new date
    above. Continued use after a change means you accept it.</p>

    <h2>9. Contact</h2>
    <p>Questions: <a href="mailto:${CONTACT}">${CONTACT}</a></p>
    `))
  })

  app.get('/privacy', publicRoute(), async (_, reply) => {
    reply.type('text/html')
    return reply.send(legalShell('Privacy Policy', '/privacy', await privacyBody()))
  })
}

const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const codes = (xs: readonly string[]) => xs.map((x) => `<code>${x}</code>`).join(', ')

/**
 * /privacy, rewritten 2026-09-25 (security batch C, S22) to say what the code
 * does and nothing it does not. Every fact that is a property of the code is
 * rendered from where the code keeps it, and the [privacy] gates in
 * scripts/preflight/batchc-gates.mjs check the rest against the running code:
 *   - the retention periods: RETENTION (src/lib/retention.ts) and
 *     OAUTH_PRUNE_AFTER_EXPIRY, labelled "once retention is on" unless this
 *     server runs RETENTION_MODE=enforce;
 *   - what wrap() sends and never sends: WRAP_SENDS / WRAP_NEVER
 *     (src/lib/privacy-facts.ts), gated against both SDKs on the wire;
 *   - the ad pixels: named only when configured, on PIXEL_PATHS only;
 *   - whether keys are still stored in plain text: read from the database.
 */
async function privacyBody(): Promise<string> {
  const enforced = retentionMode() === 'enforce'
  const pixels = configuredPixels()
  const capi = pixels.includes('Meta Pixel') && capiConfigured()
  const plaintext = await plaintextKeysStored()
  const pixelPages = PIXEL_PATHS.map((p) => `<code>${p}</code>`).join(', ')
  const retentionRows = RETENTION.map((c) =>
    `<li><strong>${esc(c.what)}</strong>: ${c.action} ${c.days} days after ${esc(c.from)}.</li>`).join('\n      ')
  const o = OAUTH_PRUNE_AFTER_EXPIRY
  return `
    <h1>Privacy Policy</h1>
    <p class="updated">Last updated: ${PRIVACY_UPDATED}</p>

    <h2>1. What we collect, and why</h2>
    <ul>
      <li><strong>Your account</strong>: your email address, and, if you give them, a name, a use case and a stack.
      If you sign in with Google or GitHub, also the account id that provider gives us for you and the verified
      address it returns: we ask Google for your email and basic profile and GitHub for your profile and email
      addresses, and keep only the id and the one verified address. Used to run your account, sign you in and
      email you (section 5).</li>
      <li><strong>Your API keys</strong>: we look a key up by a SHA-256 hash of it and show only its first and last
      characters. ${plaintext
        ? 'The key itself is also still stored in plain text beside the hash, until a pending database step empties that column.'
        : 'The key itself is not stored.'}
      With each key we keep its label, the address it was last used from, and each network it has been used
      from (for IPv6 the /64, for IPv4 the address itself), to email you when a key is used from a network it has
      not been seen from before.</li>
      <li><strong>What your code sends</strong>: the preflight calls, usage records and steps your integration
      makes, with the ids you choose (agent, customer, job), the numbers (estimates, ceilings, units, tokens) and
      any metadata you attach to a record (at most ${(METADATA_MAX_BYTES / 1024).toLocaleString('en-US')} KB each).
      And the answer each refused call got. This is the service itself: the ceilings, the console and your usage.</li>
      <li><strong>Page events</strong>: our marketing pages record a few page-level events in our own database
      (the demo being run, a click to the demo or through to the sign-up page, the sign-up page loading),
      stored with no cookie, no IP address and no identifier that outlives the tab.</li>
      <li><strong>The request log</strong>: like any web server, ours logs each request with the IP address it
      came from, the path (never the query string, and never a sign-in or recovery token) and the time. The log
      is kept by our host, Fly.io, under its own retention; this service sets none.</li>
      <li><strong>Cookies</strong>: signing in sets a session cookie for the console (<code>/app</code>), and a
      short-lived one while a Google or GitHub sign-in is in progress. The marketing pages set no cookie of their own.${pixels.length ? ' The ad pixels in section 3 set theirs.' : ''}</li>
    </ul>

    <h2>2. What the SDKs' wrap() sends, and never sends</h2>
    <p><code>wrap()</code> in the Python and Node SDKs measures the model calls of a client you wrap. The call
    itself goes from your process straight to your provider. Around it, wrap() sends AgentBill two requests,
    and only these fields:</p>
    <ul>
      <li><strong>Before the call</strong>, a preflight: ${codes(WRAP_SENDS.preflight)}.</li>
      <li><strong>After it</strong>, a record: ${codes(WRAP_SENDS.record)}. The <code>idempotency_key</code> is the
      provider's response id (a hash of it when it is longer than 128 characters, and a random key on a
      compatible endpoint), and <code>units</code> is the token total.</li>
      <li><strong>In the record's metadata</strong>: ${codes(WRAP_SENDS.metadata)}. <code>tokens</code> is the counts
      the provider reported: input, cache reads and writes, output, and reasoning where the provider says.</li>
    </ul>
    <p>It never sends ${WRAP_NEVER.join(', ').replace(/, ([^,]*)$/, ', or $1')}. The requests carry your AgentBill
    key, as every call to the API does.</p>

    <h2>3. Who processes it</h2>
    <ul>
      <li><strong>Fly.io</strong> hosts the service and keeps its request log.</li>
      <li><strong>Supabase</strong> hosts the database.</li>
      <li><strong>Resend</strong> sends the emails in section 5, and receives mail sent to hello@agentbill.dev,
      which is forwarded to our own inbox.</li>
      <li><strong>Polar</strong> takes payments on its own checkout page; we never see card details.</li>
      <li><strong>Google and GitHub</strong>, only if you sign in with them.</li>
      <li><strong>Google Fonts</strong>: our pages load their typefaces from fonts.googleapis.com and
      fonts.gstatic.com, so your browser sends Google its IP address when a page loads.</li>
      ${pixels.length
        ? `<li><strong>${pixels.join(' and ')}</strong>, on ${pixelPages} only, to measure our ads (page views and
      sign-ups), with cookies set by ${pixels.length > 1 ? 'those companies' : 'that company'}. Never inside the console or the API.</li>`
        : ''}
      ${capi
        ? `<li><strong>Meta's Conversions API</strong>: when you create an account in a browser that already carries
      the Meta Pixel's cookie (<code>_fbp</code>, or <code>_fbc</code> after an ad click), our server tells Meta a
      sign-up happened, with a SHA-256 hash of your email address and of your account id, the IP address and
      browser user agent of that request, and those cookie values. If your browser blocked the pixel, the server
      sends nothing.</li>`
        : ''}
      <li><strong>Your own webhook</strong>, if you set one: an anomaly alert for your account is sent to the URL
      you gave.</li>
    </ul>

    <h2>4. How long it is kept</h2>
    <p>${enforced
      ? 'A daily job removes each of these when its period ends:'
      : '<strong>Once retention is on</strong>, a daily job removes each of these when its period ends. It is built and not yet switched on, so until then they are kept:'}</p>
    <ul>
      ${retentionRows}
    </ul>
    <p>Always, already: an MCP connection's authorization request is deleted ${o.requests} after it expires, and its
    codes and tokens ${o.codes} after they expire.</p>
    <p>Kept while your account exists, and deleted with it: the account, your sign-in identities, your live keys and
    the networks they have been used from, your customers, jobs and usage records. Kept on purpose, because they
    are the record of what was bought and paid: the plan and its history with Polar, the payment events Polar sent
    us, and the record of each quota email.</p>

    <h2>5. Email</h2>
    <p>We email you: a welcome when a sign-in creates your account, sign-in links you ask for, recovery links you
    ask for, an alert when one of your keys is used from a new network, and alerts when your account reaches 75%
    and 90% of its monthly quota and when the quota is spent${spikesOn() ? ', and an alert when one of your agents or customers spends three times its usual day, once per agent or customer per day' : ''}. We, the operator, are emailed when an account is
    created (with its address), a periodic summary of accounts and their usage, and a note when one of your
    customer ids passes 800 units.</p>

    <h2>6. Deleting your account, and your rights</h2>
    <p>Email <a href="mailto:${CONTACT}">${CONTACT}</a> from the address on the account and we delete the account
    and everything stored under it: keys, customers, jobs, usage records, refusals, and your sign-in identity.
    Polar keeps its own records of any payment. The database host keeps backups on its own schedule, and a
    deleted account stays in those until they expire.</p>
    <p>You can also ask for a copy of your data or to correct it, the same way. If you are in the EU/EEA or UK,
    these rights are backed by the GDPR.</p>

    <h2>7. Contact</h2>
    <p><a href="mailto:${CONTACT}">${CONTACT}</a></p>
    `
}
