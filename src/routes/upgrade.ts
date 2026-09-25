import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { PLAN_LIMITS, PLAN_PRICES, PLAN_ORDER } from '../integrations/polar.js'
import { TIERS_CSS, tierCards, SAME_FEATURES } from '../ui/tiers.js'
import { EVENTS_PER_PREFLIGHT_CALL, eventLimitFor } from '../lib/event-quota.js'
import { pixelSnippet } from '../lib/pixel.js'
import { softwareLd } from '../ui/ld.js'
import { ORIGIN, HEADLINE } from '../ui/site.js'
import { head, BP } from '../ui/theme.js'
import { siteNav, siteFooter, CHROME_CSS } from '../ui/chrome.js'
import { publicRoute } from '../middleware/auth.js'
import { pixelHashes, pixelExtra } from '../lib/pixel.js'

const num = (n: number) => n.toLocaleString('en-US')


// The "Already have an API key?" box and its script were removed on
// 2026-09-25 (S24). It fetched /account/upgrade-url with a pasted key and
// rewrote the buy buttons into checkout links carrying the account id, on a
// page that also runs the ad pixels (S12). The buttons go to /app/upgrade/:tier
// now, which signs the buyer in (with a key too) and mints the checkout for
// that session's account.

export async function upgradeRoute(app: FastifyInstance) {
  // Served at both /upgrade (in-product links) and /pricing (what ad clickers
  // type; used to 401 because the auth allowlist knew no such path).
  const pricingPage = async (request: FastifyRequest, reply: FastifyReply) => {
    // Every paid button goes to /app/upgrade/:tier, which can see the console
    // session this page cannot (the cookie is scoped to /app) and either hands
    // a signed-in buyer to checkout for THAT session's account or signs them
    // in first. An ?account_id= on this page (older quota refusals and console
    // links carried one) is ignored: until 2026-09-25 (S24) it turned every
    // button into a checkout for whichever account the query named, with no
    // session at all.
    const cta = (tier: string) => `/app/upgrade/${tier}`

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
      scriptHashes: [...pixelHashes()],
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
  // Buy buttons point at /app/upgrade/:tier, which signs in and then mints a real Polar
  // session with the account id as metadata; a bare checkout link would drop it.
  // Forward the query. Until 2026-09-06 this dropped it, and preflight's
  // quota refusals hand agents /upgrade?account_id=<id>: the redirect landed
  // them on the anonymous /pricing, where every paid button says /register.
  app.get('/upgrade', publicRoute(), async (request, reply) => {
    const q = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : ''
    return reply.redirect(`/pricing${q}`, 301)
  })

  // Kept for any client that still calls it (the /pricing box that did was
  // removed on 2026-09-25). Bearer-authenticated as before, and it now answers
  // the paths a browser signs in through: a checkout is minted only for a
  // console session, never for a URL (S24).
  app.get('/account/upgrade-url', async (_request, reply) => {
    return reply.send({
      checkout: {
        builder: '/app/upgrade/builder',
        team: '/app/upgrade/team',
        scale: '/app/upgrade/scale',
      },
    })
  })

  // The old buy-button target. Until 2026-09-25 (S24) it minted a Polar
  // checkout for the ?account_id= in its query, public and with no session,
  // so a link could start a purchase that landed on somebody else's account;
  // "the worst a stranger can do" was exactly that. It mints nothing now: it
  // sends the browser to /app/upgrade/:tier, which signs the buyer in and
  // checks out the signed-in account (checkoutPath, src/integrations/polar.ts).
  // The account id in an old link is dropped.
  app.get('/checkout/:tier', publicRoute(), async (request, reply) => {
    const tier = (request.params as { tier: string }).tier
    const known = tier === 'builder' || tier === 'team' || tier === 'scale'
    return reply.redirect(known ? `/app/upgrade/${tier}` : '/pricing', 302)
  })
}
