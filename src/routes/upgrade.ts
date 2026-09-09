import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { checkoutPath, createCheckoutSession, isPolarCheckoutUrl, PLAN_LIMITS, PLAN_PRICES, PLAN_ORDER } from '../integrations/polar.js'
import { TIERS_CSS, tierCards, SAME_FEATURES } from '../ui/tiers.js'
import { isUuid } from '../lib/ids.js'
import { pixelSnippet } from '../lib/pixel.js'
import { softwareLd } from '../ui/ld.js'
import { ORIGIN, HEADLINE } from '../ui/site.js'
import { head } from '../ui/theme.js'
import { siteNav, siteFooter, CHROME_CSS } from '../ui/chrome.js'
import { PANEL_CSS } from '../ui/panels.js'
import { publicRoute } from '../middleware/auth.js'
import { inlineScript } from '../lib/csp.js'
import { pixelHashes, pixelExtra } from '../lib/pixel.js'

const num = (n: number) => n.toLocaleString('en-US')


// Lifted out of the page template so its hash matches the string emitted.
const upg = inlineScript(`    document.getElementById('keybtn').addEventListener('click', async function () {
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
    })`)
const UPGRADE_JS = upg.html
export const UPGRADE_HASH = upg.hash

export async function upgradeRoute(app: FastifyInstance) {
  // Served at both /upgrade (in-product links) and /pricing (what ad clickers
  // type; used to 401 because the auth allowlist knew no such path).
  const pricingPage = async (request: FastifyRequest, reply: FastifyReply) => {
    const accountId = ((request.query as any).account_id as string) ?? ''

    // With ?account_id (preflight's upgrade_url, the console's "raise the
    // ceiling" link) the button is a real checkout session for that account.
    // Without it, the button goes to /app/upgrade/:tier, which can see the
    // console session this page cannot (the cookie is scoped to /app) and
    // either hands a signed-in buyer straight to Polar or asks for the key
    // once. It used to go to /register, which sent a buyer who already had an
    // account off to sign up again.
    const cta = (tier: string) =>
      accountId ? checkoutPath(tier, accountId) : `/app/upgrade/${tier}`

    const paidSummary = PLAN_ORDER.filter((t) => t !== 'free')
      .map((t) => `${t[0].toUpperCase()}${t.slice(1)} $${PLAN_PRICES[t]}`).join('. ')

    // sticky: false. design.md says the mobile primary MOVES rather than being
    // duplicated, and on every other page the bar IS the only primary on a phone.
    // Here the page's whole purpose is the tier buttons, so the bar put a second
    // green fill on screen beside the one the reader came to press.
    reply.type('text/html')
    return reply.send(`${head({
      title: 'AgentBill · Pricing',
      description: `${HEADLINE}. Free tier with ${num(PLAN_LIMITS.free)} preflight calls/month, paid plans from $${PLAN_PRICES.builder}/month. No credit card to start.`,
      // Both /pricing and /upgrade render this, and both canonicalise to
      // /pricing, which is the registry's only entry for the page.
      path: '/pricing',
      og: { description: `Free: ${num(PLAN_LIMITS.free)} preflight calls/month. ${paidSummary}. Hard per-task ceilings, cross-provider, no proxy.` },
      jsonLd: softwareLd(),
      mainEntity: `${ORIGIN}/#software`,
      extraHead: pixelSnippet(),
      scriptHashes: [UPGRADE_HASH, ...pixelHashes()],
      scriptOrigins: pixelExtra(),
      css: `${CHROME_CSS}${PANEL_CSS}${TIERS_CSS}
    /* Hallmark · genre: modern-minimal · macrostructure: Split Studio family, pricing page
     * design-system: design.md · designed-as-app · nav: N1b shared · footer: Ft2 shared
     * enrichment: none, the four tier cards (ui/tiers.ts, shared with /) are the product surface */

    :root { --shell: 1080px; }
    .wrap { max-width: var(--shell); margin: 0 auto; padding-inline: 24px; padding-block: 56px 88px; }

    /* A two-sentence headline on a secondary page is not a hero: it steps down
       a rung rather than inheriting the display clamp's hero maximum. */
    h1 { font-size: var(--fs-h1-sub); color: var(--white); max-width: 30ch; overflow-wrap: anywhere; min-width: 0; }
    .sub { color: var(--muted); font-size: var(--fs-lede); margin-top: 16px; max-width: 58ch; line-height: 1.6; }

    .lead { margin-top: var(--s5); }

    /* What every plan includes. Two columns of plain text on hairlines, not
       a card per tier repeating "everything in the tier before". */
    h2 { color: var(--white); margin: 64px 0 18px; }
    .incl { list-style: none; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 0 40px; max-width: 72ch; }
    .incl li { padding: 12px 0; border-bottom: 1px solid var(--border-soft); color: var(--muted); font-size: var(--fs-small);
               line-height: 1.6; }
    .incl li b { color: var(--text); font-weight: 600; }

    /* Already have a key: the same frame as every other product panel. */
    /* No width cap. At 640px in a 1080 shell this left about 390px of empty
       ground to its right, and it is the last object on the page, so the final
       impression was a truncated card floating in black. The panel is a label
       bar, an input and a button, which is a shape that has no short side at
       full width: the input grows and the button stays right-aligned. */
    .havekey { margin-top: 48px; }
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
      .incl { grid-template-columns: minmax(0, 1fr); }
    }
`,
    })}
<body>
${siteNav('/pricing', { sticky: false })}
<main>
  <div class="wrap">

    <h1>One ceiling per task. Priced by preflight calls.</h1>
    <p class="sub">Every call sharing a task_ref consults the same ceiling before it runs, in units you
    define. Your provider's cap is bound to a project or an organization over a calendar month; this one
    is bound to the job. The plans differ only in how many preflight calls a month they include.</p>

    ${tierCards(cta)}
    <p class="tiers-note">${SAME_FEATURES}</p>

    <h2>Every plan includes</h2>
    <ul class="incl row-close">
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
${UPGRADE_JS}`}
    <p class="note">One runaway retry loop costs more than a year of Builder.
    No key yet? <a href="/register">Create a free API key</a> in 30 seconds.</p>
  </div>
</main>
${siteFooter()}
</body>
</html>`)
  }

  app.get('/pricing', publicRoute(), pricingPage)

  // /upgrade served byte-identical HTML to /pricing from this same handler, and
  // only /pricing was canonicalised. Two URLs for one page is a duplicate that
  // a canonical papers over rather than fixes. 301, permanently.
  //
  // Buy buttons point at /checkout/:tier (see below), which mints a real Polar
  // session with the account id as metadata; a bare checkout link would drop it.
  // Forward the query. Until 2026-09-06 this dropped it, and preflight's
  // quota refusals hand agents /upgrade?account_id=<id>: the redirect landed
  // them on the anonymous /pricing, where every paid button says /register.
  app.get('/upgrade', publicRoute(), async (request, reply) => {
    const q = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : ''
    return reply.redirect(`/pricing${q}`, 301)
  })

  // Authenticated helper for the pricing page's "already have a key?" box:
  // turns a bearer key into checkout links carrying the account metadata, so
  // existing users can upgrade before they hit a limit. (Auth middleware
  // resolves the key. This route deliberately carries no publicRoute(), which
  // is why it sits three lines below two routes that do.)
  app.get('/account/upgrade-url', async (request, reply) => {
    const accountId = (request as any).accountId
    return reply.send({
      checkout: {
        builder: checkoutPath('builder', accountId),
        team: checkoutPath('team', accountId),
        scale: checkoutPath('scale', accountId),
      },
    })
  })

  // The buy button lands here, not on buy.polar.sh, so the account id can be
  // attached to a real checkout SESSION as metadata (a checkout LINK drops it).
  // Public: it is a plain navigation from the pricing page, the account id is
  // in the query, and the worst a stranger can do is start a checkout attributed
  // to an id they already knew. Any failure is a redirect, never a 500 to a
  // buyer, because a broken buy button on a slow-Polar day should still land
  // somewhere sensible.
  app.get('/checkout/:tier', publicRoute(), async (request, reply) => {
    const tier = (request.params as { tier: string }).tier
    const accountId = ((request.query as { account_id?: string }).account_id) ?? ''
    if (!isUuid(accountId)) return reply.redirect('/register', 302)
    const url = await createCheckoutSession(tier, accountId)
    // createCheckoutSession already refuses anything off polar.sh; the check is
    // repeated at the sink so the redirect never depends on a caller upstream
    // remembering to. Off-list means /pricing, the same as a failed call.
    return reply.redirect(isPolarCheckoutUrl(url) ? url : '/pricing', 302)
  })
}
