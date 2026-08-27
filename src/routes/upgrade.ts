import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { getTierCheckoutUrl } from '../integrations/polar.js'
import { pixelSnippet } from '../lib/pixel.js'

export async function upgradeRoute(app: FastifyInstance) {
  // Served at both /upgrade (in-product links) and /pricing (what ad clickers
  // type; used to 401 because the auth allowlist knew no such path).
  const pricingPage = async (request: FastifyRequest, reply: FastifyReply) => {
    const accountId = ((request.query as any).account_id as string) ?? ''

    const cta = (tier: string) =>
      accountId ? getTierCheckoutUrl(tier, accountId) : '/register'

    reply.type('text/html')
    return reply.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AgentBill — Pricing</title>
  <meta name="description" content="Hard budget ceilings for AI agents. Free tier with 1,000 preflight calls/month, paid plans from $29/month. No credit card to start." />
  <link rel="canonical" href="https://agentbill.dev/pricing" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="https://agentbill.dev/pricing" />
  <meta property="og:title" content="AgentBill — Pricing" />
  <meta property="og:description" content="Free: 1,000 preflight calls/month. Builder $29. Team $99. Scale $299. Hard per-task ceilings, cross-provider, no proxy." />
  <meta property="og:image" content="https://agentbill.dev/og.png" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:image" content="https://agentbill.dev/og.png" />
  ${pixelSnippet()}
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'SF Mono', 'Fira Code', monospace; background: #0d0d0d; color: #e2e8f0;
           min-height: 100vh; padding: 48px 24px; }
    .wrap { max-width: 1040px; margin: 0 auto; }
    .logo { color: #a78bfa; font-size: 20px; font-weight: 700; }
    .tagline { color: #4b5563; font-size: 12px; margin-top: 4px; }
    h1 { font-size: 26px; margin-top: 36px; line-height: 1.35; }
    .sub { color: #9ca3af; font-size: 14px; margin-top: 10px; max-width: 640px; line-height: 1.6; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 16px; margin-top: 40px; }
    .card { background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 28px 24px;
            display: flex; flex-direction: column; }
    .card.hot { border-color: #7c3aed; position: relative; }
    .badge { position: absolute; top: -10px; right: 16px; background: #7c3aed; color: #fff;
             font-size: 10px; font-weight: 700; padding: 3px 10px; border-radius: 10px;
             text-transform: uppercase; letter-spacing: .06em; }
    .tier { font-size: 13px; color: #9ca3af; text-transform: uppercase; letter-spacing: .08em; }
    .price { font-size: 30px; font-weight: 700; margin-top: 10px; }
    .price span { font-size: 13px; color: #6b7280; font-weight: 400; }
    ul { list-style: none; margin: 20px 0 24px; flex: 1; }
    li { font-size: 12.5px; color: #cbd5e1; line-height: 1.55; padding: 5px 0 5px 18px; position: relative; }
    li::before { content: '✓'; color: #22d3a0; position: absolute; left: 0; }
    .cta { display: block; background: #7c3aed; border-radius: 6px; color: #fff; font-family: inherit;
           font-size: 13.5px; font-weight: 600; padding: 12px; text-decoration: none; text-align: center; }
    .cta:hover { background: #6d28d9; }
    .cta.ghost { background: transparent; border: 1px solid #374151; color: #cbd5e1; }
    .cta.ghost:hover { border-color: #6b7280; }
    .note { margin-top: 28px; font-size: 12px; color: #4b5563; line-height: 1.6; }
    .note a { color: #a78bfa; text-decoration: none; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="logo">AgentBill</div>
    <div class="tagline">Hard budget ceilings for AI agents</div>

    <h1>Your agents get a hard budget.<br>Per task. Cross-provider. Tools included.</h1>
    <p class="sub">Provider spend caps stop at monthly totals for one vendor. AgentBill enforces the number
    that actually matters: what this job is allowed to cost — across every model and tool it touches,
    blocked before the money is spent.</p>

    <div class="grid">
      <div class="card">
        <div class="tier">Free</div>
        <div class="price">$0 <span>/ month</span></div>
        <ul>
          <li>1,000 calls / month</li>
          <li>Preflight budget checks</li>
          <li>Per-task hard ceilings</li>
          <li>Idempotent usage records</li>
        </ul>
        <a class="cta ghost" href="/register">Start free</a>
      </div>

      <div class="card">
        <div class="tier">Builder</div>
        <div class="price">$29 <span>/ month</span></div>
        <ul>
          <li>50,000 calls / month</li>
          <li>Everything in Free</li>
          <li>Key security: revoke, rotate, rate-limit</li>
          <li>Email alerts on anomalies</li>
        </ul>
        <a class="cta" href="${cta('builder')}">Get Builder</a>
      </div>

      <div class="card hot">
        <div class="badge">Most popular</div>
        <div class="tier">Team</div>
        <div class="price">$99 <span>/ month</span></div>
        <ul>
          <li>500,000 calls / month</li>
          <li>Everything in Builder</li>
          <li>Per-agent cost attribution</li>
          <li>Priority support</li>
        </ul>
        <a class="cta" href="${cta('team')}">Get Team</a>
      </div>

      <div class="card">
        <div class="tier">Scale</div>
        <div class="price">$299 <span>/ month</span></div>
        <ul>
          <li>2,000,000 calls / month</li>
          <li>Everything in Team</li>
          <li>Direct line to the founder</li>
        </ul>
        <a class="cta" href="${cta('scale')}">Get Scale</a>
      </div>
    </div>

    <p class="note">One runaway retry loop costs more than a year of Builder.
    ${accountId ? '' : 'Have an account? Open this page from your dashboard so checkout links to your account, or '}
    <a href="/register">create a free API key</a> in 30 seconds.</p>
  </div>
</body>
</html>`)
  }

  app.get('/upgrade', pricingPage)
  app.get('/pricing', pricingPage)
}
