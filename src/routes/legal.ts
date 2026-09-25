import type { FastifyInstance } from 'fastify'
import { head } from '../ui/theme.js'
import { siteNav, siteFooter, CHROME_CSS } from '../ui/chrome.js'
import { publicRoute } from '../middleware/auth.js'
import { byPath } from '../ui/site.js'

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
const CONTACT = 'marketinglior@gmail.com'

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
    return reply.send(legalShell('Privacy Policy', '/privacy', `
    <h1>Privacy Policy</h1>
    <p class="updated">Last updated: ${PRIVACY_UPDATED}</p>

    <h2>1. What we collect</h2>
    <ul>
      <li><strong>Account data</strong>: email, optional name, optional answers about your use case
      and stack, collected when you register. If you sign in with Google or GitHub, also the account
      id that provider gives us for you and the verified email address it returns; we ask Google for
      your email and basic profile and GitHub for your profile and email addresses, and keep only the
      id and the one verified address.</li>
      <li><strong>Usage data</strong>: API calls your integration makes to AgentBill (agent ids,
      budgets, costs, timestamps, and the IP address a key is used from, used for security
      alerts).</li>
      <li><strong>Site analytics</strong>: our marketing pages may use the Meta Pixel to measure ad
      performance (page views and registrations). This involves cookies set by Meta. We do not run
      the pixel inside the product dashboard or API. Our marketing pages also record a few
      page-level events in our own database (the demo being run, a click to the demo or through
      to the sign-up page, the sign-up page loading), with no cookie, no IP address and no identifier that
      outlives the tab.</li>
    </ul>

    <h2>2. What we use it for</h2>
    <p>Running the service (metering, budget enforcement, key security), emailing you
    security alerts about your own keys, and measuring whether our marketing works. We do not sell
    your data, and we do not send marketing email.</p>

    <h2>3. Who processes it</h2>
    <p>Infrastructure and subprocessors: Fly.io (hosting), Supabase (database), Resend
    (transactional email), Polar (payments, we never see your card details), and Meta (pixel
    analytics on marketing pages only).</p>

    <h2>4. Retention and deletion</h2>
    <p>We keep account and usage data while your account is active. Email us to delete your account
    and its data: <a href="mailto:${CONTACT}">${CONTACT}</a>. Backups roll off within 30 days.</p>

    <h2>5. Your rights</h2>
    <p>You can request a copy of your data, correct it, or delete it at any time by emailing us. If
    you are in the EU/EEA or UK, these rights are backed by GDPR.</p>

    <h2>6. Contact</h2>
    <p><a href="mailto:${CONTACT}">${CONTACT}</a></p>
    `))
  })
}
