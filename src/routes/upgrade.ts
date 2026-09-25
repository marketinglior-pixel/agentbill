import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { checkoutPath, createCheckoutSession, isPolarCheckoutUrl, PLAN_LIMITS, PLAN_PRICES, PLAN_ORDER } from '../integrations/polar.js'
import { TIERS_CSS, tierCards, SAME_FEATURES } from '../ui/tiers.js'
import { isUuid } from '../lib/ids.js'
import { EVENTS_PER_PREFLIGHT_CALL, eventLimitFor } from '../lib/event-quota.js'
import { pixelSnippet } from '../lib/pixel.js'
import { softwareLd } from '../ui/ld.js'
import { ORIGIN, HEADLINE } from '../ui/site.js'
import { head, BP } from '../ui/theme.js'
import { siteNav, siteFooter, CHROME_CSS } from '../ui/chrome.js'
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
      css: `${CHROME_CSS}${TIERS_CSS}
    /* Hallmark · genre: modern-minimal · macrostructure: Split Studio family, pricing page
     * design-system: design.md, "The canvas system" · designed-as-app · nav: N1b shared · footer: Ft2 shared
     * enrichment: none, the four tier cards (ui/tiers.ts, shared with /) are the product surface */

    /* Canvas, 2026-09-23, on Lior's instruction to put every screen in the
       homepage's design language. The page reads as the homepage's pricing
       section grown into a page: a centred head, the same four cards, the
       questions layout for what every plan includes, and the key box as a
       frame (a white card on the warm-grey panel) instead of a bordered strip.
       --shell is the nav's width, so the column starts on the wordmark's edge;
       it was 1080 against the nav's 1072, 4px off on each side. */
    :root { --shell: var(--chrome-w); }
    .wrap { max-width: var(--shell); margin: 0 auto; padding-inline: var(--gutter); padding-block: 56px var(--s9); }

    /* The head, centred the way the homepage sets a section head, and set
       left on a phone the way the homepage's phone frames do. A two-sentence
       headline on a secondary page is not a hero: it takes the page rung
       (--fs-h1-sub), not the display clamp. */
    .pr-head { text-align: center; display: grid; justify-items: center; }
    h1 { font-size: var(--fs-h1-sub); color: var(--white); letter-spacing: -0.03em; line-height: 1.02;
         max-width: 22ch; overflow-wrap: anywhere; min-width: 0; }
    .sub { color: var(--muted); font-size: var(--fs-lede); margin-top: var(--s5); max-width: 58ch; line-height: 1.55;
           text-wrap: pretty; }

    /* What every plan includes, in the homepage's questions layout: the head
       in a narrow left column, the list on hairlines to its right. Two
       columns of plain text, not a card per tier repeating "everything in the
       tier before". */
    /* The one sentence under the cards, centred under them as on /. */
    .wrap > .tiers-note { margin-inline: auto; text-align: center; }

    .incl-sec { padding-top: var(--s9); display: grid; grid-template-columns: minmax(0, 320px) minmax(0, 1fr);
                gap: var(--s6); align-items: start; }
    h2 { color: var(--white); letter-spacing: -0.02em; line-height: 1.1; }
    .incl { list-style: none; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 0 var(--s6); }
    .incl li { padding: 18px 0; border-top: 1px solid var(--border); color: var(--muted); font-size: var(--fs-small);
               line-height: 1.55; }
    .incl li b { color: var(--text); font-weight: 500; }

    /* Already have a key: the frame, a white card on the warm-grey panel,
       with the question in its bar. Full width, because it is the last object
       on the page and a short card floating beside empty ground read as a
       truncated one (at 640 in the old shell it left about 390px of it). The field
       is the kit's, mono because a key is an id; the button is the light
       fill at the field's own 44, since the fold's one ink fill is the Free
       card above. */
    .havekey { margin-top: var(--s9); }
    .havekey .cv-bar-t b { color: var(--text); font-weight: 500; }
    .hk-aside { font-size: var(--fs-small); color: var(--dim); text-align: right; }
    .hk-row { display: flex; flex-wrap: wrap; gap: var(--s3); padding: 20px; align-items: center; }
    .hk-row .cv-field { flex: 1; min-width: 200px; width: auto; font-size: var(--fs-small); }
    /* The answer to the button, under the row. It reserves no height: the
       button is above it, so nothing the reader is aiming at moves, and an
       empty reserved line was a blank band inside the card. */
    .msg-slot { padding-inline: 20px; }
    .msg { font-size: var(--fs-small); line-height: 1.5; color: var(--green); display: none; margin-top: -6px; padding-bottom: 18px; }

    .note { margin-top: var(--s5); font-size: var(--fs-small); color: var(--muted); line-height: 1.6; max-width: 60ch; }
    .note a { color: var(--text); text-underline-offset: 3px; text-decoration-color: var(--border-strong); }
    .note a:hover { text-decoration-color: currentColor; }

    @media (max-width: ${BP.lg}px) {
      .incl-sec { grid-template-columns: minmax(0, 1fr); gap: var(--s5); }
    }
    @media (max-width: ${BP.md}px) {
      .wrap { padding-block: var(--s6) var(--s8); }
      .pr-head { text-align: left; justify-items: start; }
      .wrap > .tiers-note { margin-inline: 0; text-align: left; }
      .sub { font-size: var(--fs-body); margin-top: 14px; }
      .incl-sec, .havekey { padding-top: 0; margin-top: var(--s8); }
      .incl { grid-template-columns: minmax(0, 1fr); }
      .hk-aside { display: none; }
      .hk-row { padding: 14px 12px; }
      .hk-row .btn-alt { flex: 1 1 100%; }
      .msg-slot { padding-inline: 12px; }
    }
`,
    })}
<body>
${siteNav('/pricing', { sticky: false })}
<main>
  <div class="wrap">

    <header class="pr-head">
      <h1>One ceiling per task. Priced by preflight calls.</h1>
      <p class="sub">Every call sharing a task_ref consults the same ceiling before it runs, in units you
      define. Your provider's cap is bound to a project or an organization over a calendar month; this one
      is bound to the job. The plans differ only in how many preflight calls a month they include.</p>
    </header>

    ${tierCards(cta)}
    <p class="tiers-note">${SAME_FEATURES}</p>

    <section class="incl-sec">
      <h2>Every plan includes</h2>
      <ul class="incl row-close">
        <li><b>Preflight budget checks.</b> The ceiling is consulted before the call goes out, not after the bill.</li>
        <li><b>Per-task hard ceilings.</b> One budget across every call that passes the same task_ref, reserved atomically.</li>
        <li><b>Per-agent attribution.</b> Every task and every refusal carries the agent that asked.</li>
        <li><b>Key security.</b> Revoke, rotate, expiry and rate limiting on every API key.</li>
        <li><b>New-address alert.</b> An email when a key is used from an address it has not been seen from.</li>
        <li><b>Idempotent usage records.</b> Safe to call from retried or parallel workflows. A record that settles its own preflight is part of that call. Other records and steps: ${EVENTS_PER_PREFLIGHT_CALL} a month for every preflight call a plan includes (${num(eventLimitFor('free') ?? 0)} on Free).</li>
        <li><b>Units you define.</b> We count an integer you choose; we never read your provider bill.</li>
        <li><b>The console.</b> Live task budgets, every refusal with the literal response, key health.</li>
      </ul>
    </section>

    ${accountId ? '' : `
    <div class="cv-panel havekey">
      <div class="cv-card">
        <div class="cv-bar"><span class="cv-bar-t"><b>Already have an API key?</b></span><span class="hk-aside">unlock checkout for your account</span></div>
        <div class="hk-row">
          <input id="keyin" class="cv-field m" type="password" placeholder="agb_..." autocomplete="off" spellcheck="false" aria-label="API key" />
          <button id="keybtn" type="button" class="btn-alt">Unlock checkout</button>
        </div>
        <div class="msg-slot"><span class="msg" id="keymsg" aria-live="polite"></span></div>
      </div>
    </div>
${UPGRADE_JS}`}
    <!-- The line that used to open this note said "One runaway retry loop costs more than a
         year of Builder." It is a claim about what a run would have cost, and this product
         cannot know that: it meters units the developer defines and never reads a provider
         invoice. Four other surfaces say so in as many words (/ "units refused is not money",
         /about, /docs, /faq), so the sentence directly under the checkout box contradicted
         the rest of the site. Retired 2026-09-14. Do not replace it with another dollar line. -->
    <p class="note">No key yet? <a href="/register">Create a free account</a>: sign up, and the console makes your key.</p>
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
