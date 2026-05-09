import type { FastifyInstance } from 'fastify'
import { getCheckoutUrl } from '../integrations/polar.js'

export async function upgradeRoute(app: FastifyInstance) {
  app.get('/upgrade', async (request, reply) => {
    const accountId = (request.query as any).account_id ?? ''
    const checkoutUrl = accountId ? getCheckoutUrl(accountId) : 'https://polar.sh'

    reply.type('text/html')
    return reply.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AgentBill — Upgrade to Paid</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'SF Mono', 'Fira Code', monospace; background: #0d0d0d; color: #e2e8f0;
           min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .card { background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 40px; width: 100%; max-width: 480px; }
    .logo { color: #a78bfa; font-size: 20px; font-weight: 700; margin-bottom: 6px; }
    .tagline { color: #4b5563; font-size: 12px; margin-bottom: 32px; }
    h2 { font-size: 18px; color: #e2e8f0; margin-bottom: 12px; }
    p { font-size: 13px; color: #9ca3af; line-height: 1.6; margin-bottom: 24px; }
    .limit-box { background: #0d0d0d; border: 1px solid #374151; border-radius: 8px; padding: 16px; margin-bottom: 28px; }
    .limit-box .label { font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 8px; }
    .limit-box .value { font-size: 13px; color: #f87171; }
    .cta { display: block; width: 100%; background: #7c3aed; border: none; border-radius: 6px; color: #fff;
           font-family: inherit; font-size: 14px; font-weight: 600; padding: 14px; cursor: pointer;
           text-decoration: none; text-align: center; }
    .cta:hover { background: #6d28d9; }
    .pricing { margin-top: 20px; font-size: 11px; color: #4b5563; text-align: center; }
    .pricing strong { color: #9ca3af; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">AgentBill</div>
    <div class="tagline">Preflight billing for AI agents</div>

    <h2>Free tier limit reached</h2>
    <p>Your account has used all 1,000 free preflight calls this month. Upgrade to keep your agents running without interruption.</p>

    <div class="limit-box">
      <div class="label">What happens if you don't upgrade</div>
      <div class="value">All preflight calls will be blocked until the next billing cycle.</div>
    </div>

    <a href="${checkoutUrl}" class="cta">Upgrade now →</a>

    <div class="pricing">
      <strong>$0.001 per call</strong> above the free tier. No monthly minimum.
    </div>
  </div>
</body>
</html>`)
  })
}
