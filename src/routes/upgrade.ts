import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { getTierCheckoutUrl, PLAN_LIMITS, PLAN_PRICES, PLAN_ORDER } from '../integrations/polar.js'
import { pixelSnippet } from '../lib/pixel.js'
import { head } from '../ui/theme.js'
import { siteNav, siteFooter, CHROME_CSS } from '../ui/chrome.js'
import { PANEL_CSS } from '../ui/panels.js'
import { publicRoute } from '../middleware/auth.js'

const num = (n: number) => n.toLocaleString('en-US')
const RECOMMENDED = 'team'

// What a paid tier adds that is not code. Everything that IS code ships on
// every plan (nothing in the codebase gates a feature by plan; only
// PLAN_LIMITS is read), so these are the only per-tier lines the page may
// carry, and they are labelled as service, not as features.
const SERVICE: Record<string, string> = {
  team: 'priority support',
  scale: 'direct line to the founder',
}

export async function upgradeRoute(app: FastifyInstance) {
  // Served at both /upgrade (in-product links) and /pricing (what ad clickers
  // type; used to 401 because the auth allowlist knew no such path).
  const pricingPage = async (request: FastifyRequest, reply: FastifyReply) => {
    const accountId = ((request.query as any).account_id as string) ?? ''

    const cta = (tier: string) =>
      accountId ? getTierCheckoutUrl(tier, accountId) : '/register'

    const paidSummary = PLAN_ORDER.filter((t) => t !== 'free')
      .map((t) => `${t[0].toUpperCase()}${t.slice(1)} $${PLAN_PRICES[t]}`).join('. ')

    const rows = PLAN_ORDER.map((tier) => {
      const free = tier === 'free'
      const button = free
        ? `<a class="btn-ghost" href="/register">Start free</a>`
        : `<a class="btn" data-tier="${tier}" href="${cta(tier)}">Get ${tier[0].toUpperCase()}${tier.slice(1)}</a>`
      return `
        <tr class="${tier === RECOMMENDED ? 'rec' : ''}">
          <td class="tier">${tier}${SERVICE[tier] ? `<span class="svc">${SERVICE[tier]}</span>` : ''}</td>
          <td class="calls">${num(PLAN_LIMITS[tier])}<span class="dimtxt"> calls / mo</span></td>
          <td class="amount">$${PLAN_PRICES[tier]}${free ? '' : '<span class="dimtxt"> / mo</span>'}</td>
          <td class="act">${button}</td>
        </tr>`
    }).join('')

    reply.type('text/html')
    return reply.send(`${head({
      title: 'AgentBill · Pricing',
      description: `Hard budget ceilings for AI agents. Free tier with ${num(PLAN_LIMITS.free)} preflight calls/month, paid plans from $${PLAN_PRICES.builder}/month. No credit card to start.`,
      canonical: 'https://agentbill.dev/pricing',
      extraHead: `  <meta property="og:type" content="website" />
  <meta property="og:url" content="https://agentbill.dev/pricing" />
  <meta property="og:title" content="AgentBill · Pricing" />
  <meta property="og:description" content="Free: ${num(PLAN_LIMITS.free)} preflight calls/month. ${paidSummary}. Hard per-task ceilings, cross-provider, no proxy." />
  <meta property="og:image" content="https://agentbill.dev/og.png" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:image" content="https://agentbill.dev/og.png" />
  ${pixelSnippet()}`,
      css: `${CHROME_CSS}${PANEL_CSS}
    /* Hallmark · genre: modern-minimal · macrostructure: Split Studio family, spec-sheet page (F3)
     * design-system: design.md · designed-as-app · nav: N1b shared · footer: Ft2 shared
     * enrichment: none, the table is the product surface */

    :root { --shell: 1080px; }
    .wrap { max-width: var(--shell); margin: 0 auto; padding-inline: 24px; padding-block: 56px 88px; }

    /* A two-sentence headline on a secondary page is not a hero: it steps down
       a rung rather than inheriting the display clamp's hero maximum. */
    h1 { font-size: clamp(28px, 3.6vw, 40px); color: var(--white); max-width: 30ch; overflow-wrap: anywhere; min-width: 0; }
    .sub { color: var(--muted); font-size: var(--fs-lede); margin-top: 16px; max-width: 58ch; line-height: 1.6; }

    /* The tiers as a spec sheet: one row each, the numbers in columns that line
       up because they are a table. The recommended tier carries weight through
       type, not through a tinted border and a floating badge. */
    .tiers { width: 100%; border-collapse: collapse; margin-top: 44px; font-variant-numeric: tabular-nums; }
    .tiers td { padding: 18px 0; border-bottom: 1px solid var(--border); color: var(--muted); font-size: 15.5px;
                vertical-align: middle; }
    .tiers tr:first-child td { border-top: 1px solid var(--border); }
    .tiers .tier { font-family: var(--mono); text-transform: uppercase; letter-spacing: .12em; font-size: 12.5px;
                   color: var(--dim); width: 22%; }
    .tiers .svc { display: block; text-transform: none; letter-spacing: 0; font-size: 11.5px; color: var(--dim);
                  margin-top: 4px; }
    .tiers .amount { font-family: var(--display); font-size: 24px; font-weight: 700; color: var(--text);
                     letter-spacing: -0.02em; white-space: nowrap; }
    .tiers .act { text-align: right; white-space: nowrap; padding-left: 16px; }
    .tiers tr.rec .tier { color: var(--green); }
    .tiers tr.rec .calls, .tiers tr.rec .amount { color: var(--white); }
    .dimtxt { color: var(--dim); }
    .same { margin-top: 14px; font-family: var(--mono); font-size: 12.5px; color: var(--dim); max-width: 70ch; line-height: 1.6; }

    /* What every plan includes. Two columns of plain text on hairlines, not
       a card per tier repeating "everything in the tier before". */
    h2 { color: var(--white); margin: 64px 0 18px; }
    .incl { list-style: none; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 0 40px; max-width: 72ch; }
    .incl li { padding: 12px 0; border-bottom: 1px solid var(--border-soft); color: var(--muted); font-size: var(--fs-small);
               line-height: 1.6; }
    .incl li b { color: var(--text); font-weight: 600; }

    /* Already have a key: the same frame as every other product panel. */
    .havekey { margin-top: 48px; max-width: 640px; }
    .hk-row { display: flex; flex-wrap: wrap; gap: 10px; padding: 16px 18px; align-items: center; }
    .hk-row input { flex: 1; min-width: 200px; min-height: 44px; background: var(--bg); color: var(--text);
                    border: 1px solid var(--border-strong); border-radius: 8px; padding: 0 14px;
                    font-family: var(--mono); font-size: 13.5px; outline: 2px solid transparent; outline-offset: 1px;
                    transition: border-color .15s; }
    .hk-row input::placeholder { color: var(--dim); }
    .hk-row input:focus-visible { outline-color: var(--green); }
    .hk-row button { min-height: 44px; }
    .hk-row button.btn-ghost { font-family: var(--sans); cursor: pointer; background: transparent; }
    .msg-slot { min-height: 1lh; padding: 0 18px 12px; }
    .msg { font-size: 12.5px; color: var(--green); display: none; }

    .note { margin-top: 36px; font-size: var(--fs-small); color: var(--dim); line-height: 1.6; max-width: 60ch; }

    @media (max-width: 720px) {
      .wrap { padding-block: 40px 64px; }
      .tiers, .tiers tbody, .tiers tr { display: block; }
      .tiers tr { padding: 16px 0; border-bottom: 1px solid var(--border);
                  display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 16px; align-items: center; }
      .tiers tr:first-child { border-top: 1px solid var(--border); }
      .tiers td { display: block; padding: 0; border: 0; }
      .tiers .tier { width: auto; grid-column: 1; }
      .tiers .amount { grid-column: 2; grid-row: 1; text-align: right; }
      .tiers .calls { grid-column: 1; }
      .tiers .act { grid-column: 2; grid-row: 2; text-align: right; padding-left: 0; }
      .incl { grid-template-columns: minmax(0, 1fr); }
    }
`,
    })}
<body>
${siteNav('/pricing')}
  <div class="wrap">

    <h1>Your agents get a hard budget. Per task. One ceiling, any provider.</h1>
    <p class="sub">Provider spend caps stop at monthly totals for one vendor. AgentBill enforces the number
    that actually matters: what this job is allowed to spend, in units you define, across every call
    that passes the same task_ref. Blocked before the call goes out.</p>

    <table class="tiers">
      <tbody>${rows}
      </tbody>
    </table>
    <p class="same">Every plan has every feature. The tiers differ in how many preflight calls a month
    they include, and in who answers when you write in.</p>

    <h2>Every plan includes</h2>
    <ul class="incl">
      <li><b>Preflight budget checks.</b> The ceiling is consulted before the call goes out, not after the bill.</li>
      <li><b>Per-task hard ceilings.</b> One budget across every call that passes the same task_ref, reserved atomically.</li>
      <li><b>Per-agent attribution.</b> Every task and every refusal carries the agent that asked.</li>
      <li><b>Key security.</b> Revoke, rotate, expiry and rate limiting on every API key.</li>
      <li><b>New-address alert.</b> An email when a key is used from an address it has not been seen from.</li>
      <li><b>Idempotent usage records.</b> Safe to call from retried or parallel workflows.</li>
      <li><b>Units you define.</b> We count an integer you choose; we never read your provider bill.</li>
      <li><b>The console.</b> Live task budgets, every refusal with the literal response, key health.</li>
    </ul>

    ${accountId ? '' : `
    <div class="panel havekey">
      <div class="panel-h"><span>Already have an API key?</span><span>unlock checkout for your account</span></div>
      <div class="hk-row">
        <input id="keyin" type="password" placeholder="agb_..." autocomplete="off" spellcheck="false" aria-label="API key" />
        <button id="keybtn" type="button" class="btn-ghost">Unlock checkout</button>
      </div>
      <div class="msg-slot"><span class="msg" id="keymsg" aria-live="polite"></span></div>
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

  app.get('/upgrade', publicRoute(), pricingPage)
  app.get('/pricing', publicRoute(), pricingPage)

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
