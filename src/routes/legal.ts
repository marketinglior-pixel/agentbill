import type { FastifyInstance } from 'fastify'

// Terms + Privacy. The register form points here ("you agree to our Terms"),
// and Meta ad review checks destination pages for both. Plain, honest, short.

const LAST_UPDATED = 'August 27, 2026'
const CONTACT = 'marketinglior@gmail.com'

function legalShell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet" />
  <title>${title} · AgentBill</title>
  <meta name="robots" content="noindex" />
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0a0a0a; color: #e8ebe9; font-family: 'Inter', system-ui, sans-serif;
           line-height: 1.7; -webkit-font-smoothing: antialiased; }
    .container { max-width: 720px; margin: 0 auto; padding: 64px 24px; }
    a { color: #a8ff78; }
    h1 { color: #fff; font-size: 24px; margin-bottom: 8px; }
    .updated { color: #868e88; font-size: 13px; margin-bottom: 40px; }
    h2 { color: #fff; font-size: 16px; margin: 32px 0 10px; }
    p, li { font-size: 14px; margin-bottom: 12px; }
    ul { padding-left: 20px; margin-bottom: 12px; }
    .home { display: inline-block; margin-bottom: 32px; color: #a0a8a3; text-decoration: none; font-size: 13px; }
    .home:hover { color: #fff; }
  </style>
</head>
<body>
  <div class="container">
    <a class="home" href="/">&larr; agentbill.dev</a>
    ${body}
  </div>
</body>
</html>`
}

export async function legalRoute(app: FastifyInstance) {
  app.get('/terms', async (_, reply) => {
    reply.type('text/html')
    return reply.send(legalShell('Terms of Service', `
    <h1>Terms of Service</h1>
    <p class="updated">Last updated: ${LAST_UPDATED}</p>

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

  app.get('/privacy', async (_, reply) => {
    reply.type('text/html')
    return reply.send(legalShell('Privacy Policy', `
    <h1>Privacy Policy</h1>
    <p class="updated">Last updated: ${LAST_UPDATED}</p>

    <h2>1. What we collect</h2>
    <ul>
      <li><strong>Account data</strong>: email, optional name, optional answers about your use case
      and stack, collected when you register.</li>
      <li><strong>Usage data</strong>: API calls your integration makes to AgentBill (agent ids,
      budgets, costs, timestamps, and the IP address a key is used from, used for security
      alerts).</li>
      <li><strong>Site analytics</strong>: our marketing pages may use the Meta Pixel to measure ad
      performance (page views and registrations). This involves cookies set by Meta. We do not run
      the pixel inside the product dashboard or API.</li>
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
