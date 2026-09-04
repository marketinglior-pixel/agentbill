import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { getTierCheckoutUrl } from '../integrations/polar.js'
import { pixelSnippet } from '../lib/pixel.js'
import { head } from '../ui/theme.js'
import { siteNav, siteFooter, CHROME_CSS } from '../ui/chrome.js'

export async function upgradeRoute(app: FastifyInstance) {
  // Served at both /upgrade (in-product links) and /pricing (what ad clickers
  // type; used to 401 because the auth allowlist knew no such path).
  const pricingPage = async (request: FastifyRequest, reply: FastifyReply) => {
    const accountId = ((request.query as any).account_id as string) ?? ''

    const cta = (tier: string) =>
      accountId ? getTierCheckoutUrl(tier, accountId) : '/register'

    reply.type('text/html')
    return reply.send(`${head({
      title: 'AgentBill · Pricing',
      description: 'Hard budget ceilings for AI agents. Free tier with 1,000 preflight calls/month, paid plans from $29/month. No credit card to start.',
      canonical: 'https://agentbill.dev/pricing',
      extraHead: `  <meta property="og:type" content="website" />
  <meta property="og:url" content="https://agentbill.dev/pricing" />
  <meta property="og:title" content="AgentBill · Pricing" />
  <meta property="og:description" content="Free: 1,000 preflight calls/month. Builder $29. Team $99. Scale $299. Hard per-task ceilings, cross-provider, no proxy." />
  <meta property="og:image" content="https://agentbill.dev/og.png" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:image" content="https://agentbill.dev/og.png" />
  ${pixelSnippet()}`,
      css: `${CHROME_CSS}

    :root { --shell: 1040px; }
    body { min-height: 100vh; }
    /* .tier is a data label and stays mono; the headline and the figures
       are display type. */
    .tier { font-family: var(--mono); }
    .price { font-family: var(--display); font-weight: 800; letter-spacing: -0.02em; }
    .wrap { max-width: var(--shell); margin: 0 auto; padding: 48px 24px 0; }
    /* A two-sentence headline on a secondary page is not a hero: it steps down
       a rung rather than inheriting the display clamp's hero maximum. */
    h1 { font-size: clamp(28px, 3.6vw, 40px); margin-top: 40px; max-width: 30ch; }
    .sub { color: var(--muted); font-size: 14px; margin-top: 10px; max-width: 640px; line-height: 1.6; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 16px; margin-top: 40px; }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 28px 24px;
            display: flex; flex-direction: column; }
    .card.hot { border-color: rgba(34,211,160,.45); position: relative; }
    .badge { position: absolute; top: -10px; right: 16px; background: var(--green); color: var(--green-ink);
             font-size: 10px; font-weight: 700; padding: 3px 10px; border-radius: 10px;
             text-transform: uppercase; letter-spacing: .06em; }
    .tier { font-size: 13px; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; }
    .price { font-size: 30px; font-weight: 700; margin-top: 10px; }
    .price span { font-size: 13px; color: var(--dim); font-weight: 400; }
    ul { list-style: none; margin: 20px 0 24px; flex: 1; }
    li { font-size: 12.5px; color: var(--muted); line-height: 1.55; padding: 5px 0 5px 18px; position: relative; }
    li::before { content: '✓'; color: var(--green); position: absolute; left: 0; }
    .cta { display: block; background: var(--green); border-radius: 6px; color: var(--green-ink); font-family: inherit;
           font-size: 13.5px; font-weight: 600; padding: 12px; text-decoration: none; text-align: center; }
    .cta:hover { filter: brightness(1.08); }
    .cta.ghost { background: transparent; border: 1px solid var(--border-strong); color: var(--muted); }
    .cta.ghost:hover { border-color: var(--dim); }
    .note { margin-top: 28px; font-size: 12px; color: var(--dim); line-height: 1.6; }
    .note a { color: var(--green); text-decoration: none; }
    .havekey { margin-top: 32px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
               padding: 18px 20px; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
    .havekey label { font-size: 13px; color: var(--muted); }
    .havekey input { background: var(--surface); border: 1px solid var(--border-strong); border-radius: 6px; color: var(--text);
                     font-family: inherit; font-size: 13px; padding: 9px 12px; flex: 1; min-width: 220px; }
    .havekey input:focus { outline: none; border-color: var(--green); }
    .havekey button { background: transparent; border: 1px solid var(--green); border-radius: 6px; color: var(--green);
                      font-family: inherit; font-size: 13px; font-weight: 600; padding: 9px 16px; cursor: pointer; }
    .havekey button:hover { background: var(--green); color: var(--green-ink); }
    .havekey .msg { font-size: 12px; color: var(--green); width: 100%; display: none; }
`,
    })}
<body>
${siteNav('/pricing')}
  <div class="wrap">

    <h1>Your agents get a hard budget.<br>Per task. One ceiling, any provider.</h1>
    <p class="sub">Provider spend caps stop at monthly totals for one vendor. AgentBill enforces the number
    that actually matters: what this job is allowed to cost, across every model and tool it touches,
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
        <a class="cta" data-tier="builder" href="${cta('builder')}">Get Builder</a>
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
        <a class="cta" data-tier="team" href="${cta('team')}">Get Team</a>
      </div>

      <div class="card">
        <div class="tier">Scale</div>
        <div class="price">$299 <span>/ month</span></div>
        <ul>
          <li>2,000,000 calls / month</li>
          <li>Everything in Team</li>
          <li>Direct line to the founder</li>
        </ul>
        <a class="cta" data-tier="scale" href="${cta('scale')}">Get Scale</a>
      </div>
    </div>

    ${accountId ? '' : `
    <div class="havekey">
      <label for="keyin">Already have an API key?</label>
      <input id="keyin" type="password" placeholder="agb_..." autocomplete="off" spellcheck="false" />
      <button id="keybtn" type="button">Unlock checkout</button>
      <span class="msg" id="keymsg"></span>
    </div>
    <script>
    document.getElementById('keybtn').addEventListener('click', async function () {
      var k = document.getElementById('keyin').value.trim()
      var msg = document.getElementById('keymsg')
      msg.style.display = 'block'
      if (!k) { msg.style.color = 'var(--red)'; msg.textContent = 'Paste your API key first.'; return }
      try {
        var r = await fetch('/account/upgrade-url', { headers: { Authorization: 'Bearer ' + k } })
        if (!r.ok) { msg.style.color = 'var(--red)'; msg.textContent = 'Key not recognized. Check it and try again.'; return }
        var d = await r.json()
        document.querySelectorAll('[data-tier]').forEach(function (a) {
          var t = a.getAttribute('data-tier')
          if (d.checkout && d.checkout[t]) a.setAttribute('href', d.checkout[t])
        })
        msg.style.color = 'var(--green)'
        msg.textContent = 'Checkout unlocked for your account. Pick a plan above.'
      } catch (e) {
        msg.style.color = 'var(--red)'
        msg.textContent = 'Network error. Try again.'
      }
    })
    </script>`}
    <p class="note">One runaway retry loop costs more than a year of Builder.
    No key yet? <a href="/register">Create a free API key</a> in 30 seconds.</p>
  </div>
${siteFooter()}
</body>
</html>`)
  }

  app.get('/upgrade', pricingPage)
  app.get('/pricing', pricingPage)

  // Authenticated helper for the pricing page's "already have a key?" box:
  // turns a bearer key into checkout links carrying the account metadata, so
  // existing users can upgrade before they hit a limit. (Auth middleware
  // resolves the key, this path is deliberately NOT in PUBLIC_PATHS.)
  app.get('/account/upgrade-url', async (request, reply) => {
    const accountId = (request as any).accountId
    return reply.send({
      checkout: {
        builder: getTierCheckoutUrl('builder', accountId),
        team: getTierCheckoutUrl('team', accountId),
        scale: getTierCheckoutUrl('scale', accountId),
      },
    })
  })
}
