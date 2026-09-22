import { HEADLINE, INSTALL_PY, ORIGIN } from '../ui/site.js'
import { FastifyInstance } from 'fastify'
import { head, BP } from '../ui/theme.js'
import { siteNav, siteFooter, CHROME_CSS, KEY_CTA } from '../ui/chrome.js'
import { PLAYGROUND_CSS, PLAYGROUND_JS, PLAYGROUND_HASH, playgroundSection, REFUSAL, heroRefusalBody } from '../ui/playground.js'
import { pixelSnippet } from '../lib/pixel.js'
import { PLAN_LIMITS } from '../integrations/polar.js'
import { PANEL_CSS } from '../ui/panels.js'
import { COPY_CSS, COPY_JS, COPY_HASH, copyPill } from '../ui/copy.js'
import { TABS_CSS, TABS_JS, TABS_HASH, langTabs } from '../ui/tabs.js'
import { TIERS_CSS, tierCards, SAME_FEATURES } from '../ui/tiers.js'
import { publicRoute } from '../middleware/auth.js'
import { softwareLd } from '../ui/ld.js'
import { pixelHashes, pixelExtra } from '../lib/pixel.js'

// The page is a Split Studio: every claim below the fold sits beside a panel
// that shows the product doing the thing the claim describes. The panels are
// not mockups. They render the same sample rows the demo console renders,
// through the same rule the console applies, so the homepage cannot show a
// number the console would disagree with. Where a panel is sample data it
// says so inside its own frame, so a screenshot carries the label with it.
//
// Restructured 2026-09-09 for scan speed, measured against a stopwatch and
// not against taste: problem, demo, benefits, pricing, close, in that order,
// and each stop is a short head beside a product surface rather than an
// argument. The fold was rebuilt 2026-09-12 with pressplaced.com as the craft
// reference: the hero is the headline, the locked sentence under it, one
// button, and ONE explanatory demo (dualState below) in the place a code
// frame used to be. The frame moved one screen down, into the request-path
// row, where a reader who has understood the demo meets the integration. The
// playground sits directly under the hero as the page's one full-bleed band;
// the provider-cap argument is two evidence lines, a sentence and a link each,
// under the thesis band (the three sourced cards went out with the essay on
// 2026-09-16; the lines came back one at a time, each read at source: issue 64744
// through the issue's comments API, and Google's billing page by direct fetch,
// both on 2026-09-18; a provider may be named, it is the substrate, and the
// sentence is quoted so one click checks it. Notes like this one stay up here:
// an HTML comment inside the template is sent with every response, and the
// one that sat under the second line cost ~330 bytes on the most-fetched page
// until it moved); ONE
// row carries the integration, the code frame beside the console-first order
// the ceiling is set in; the tiers are the same four cards /pricing renders;
// and the list of what the product does not do is four lines. The keys row
// and the console-overview row came out on 2026-09-12; the task-budgets row
// and the refusals row followed the same day, after the full-team dogfood
// read everything under the demo as a second brochure. A reader on the cold
// path meets those panels in the console, after a refusal, not before one.
// Nothing here is a logo wall, a count or a testimonial, and the page does
// not say why: a sentence about who has agreed to what is a claim about
// other people, and the claims rules have no way to check it.

const esc = (s: unknown) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const num = (n: number) => n.toLocaleString('en-US')

/**
 * The wire body POST /preflight sends when the sample's own call is refused,
 * painted the way the playground paints a response. Under the code frame and
 * inside the fold's job card, from one object: playground.ts owns the run's
 * numbers, so the two places and the playground cannot disagree.
 */
function heroAnswer(): string {
  const body = heroRefusalBody()
  const fields = Object.entries(body).map(([k, v]) => {
    const val = v === false
      ? '<span class="f">false</span>'
      : typeof v === 'string' ? `<span class="s">"${esc(v)}"</span>` : `<span class="n">${esc(String(v))}</span>`
    return `<span class="k">"${k}"</span>: ${val}`
  })
  return `{ ${fields.join(', ')} }`
}

/**
 * The month-window sample, as a share of a window. A percentage and not a count,
 * on purpose: this product has no month meter to read, and a number of units or
 * dollars on that row would be a claim about a meter we do not run. Fig. 1 says
 * "sample" in its own frame.
 */
const MONTH_SAMPLE_PCT = 4

/**
 * FIG. 1: the argument, drawn.
 *
 * Four meters in one account in one minute. Three are real mechanisms that other
 * products ship and all three still say yes; the fourth is this task_ref and it
 * is out. The ceiling is ONE vertical line crossing all four, so "a ceiling on
 * this job" is a thing on the page rather than a phrase in the headline.
 *
 * The fourth row's numbers come from heroRefusalBody(), the same source the code
 * frame's answer and the playground read, so the figure cannot disagree with the
 * wire. The first three are illustrative and the frame says SAMPLE, once.
 *
 * The bar geometry is percentages of the bar column, and the bar column stops AT
 * the ceiling line. Nothing can be drawn past it by accident; the only thing in
 * the zone beyond is the dashed block for the units this call asked for.
 */
function ceilingFigure(): string {
  const body = heroRefusalBody()
  const used = Number(body.task_used_units)
  const ceil = Number(body.task_ceiling)
  const ask = Number(body.estimated_units)
  const rows: ReadonlyArray<readonly [label: string, value: string, state: string, pct: number, lit: boolean]> = [
    ['Wall clock', '34 min', 'still running', 34, false],
    ['Org &middot; month', `${MONTH_SAMPLE_PCT}% used`, 'under the cap', MONTH_SAMPLE_PCT, false],
    ['USD window &middot; 1h', '$1.60 / $5', 'under the cap', 32, false],
    [`task_ref ${esc(String(body.task_ref))}`, `${num(used)} / ${num(ceil)}`, 'refused', 100, true],
  ]
  return `<figure class="fig">
      <figcaption class="fig-head">
        <span class="fig-n">Fig. 1 &middot; four meters, one account, one minute</span>
        <span class="fig-tag">sample</span>
      </figcaption>
      <div class="plot">
        <div class="ceil" aria-hidden="true"><span>ceiling &middot; ${num(ceil)}</span></div>
        ${rows.map(([label, value, state, pct, lit]) => `<div class="mrow${lit ? ' lit' : ''}">
          <span class="m-l">${label}</span>
          <span class="m-v">${value}</span>
          <span class="m-t" aria-hidden="true"><i style="width:${pct}%"></i>${lit ? `<u title="this call asks ${num(ask)}"></u>` : ''}</span>
          <span class="m-s">${state}</span>
        </div>`).join('\n        ')}
      </div>
      <p class="fig-cap">Clock / month / window &nbsp;&ne;&nbsp; a ceiling on this
      <span class="mono-in">task_ref</span>.</p>
    </figure>`
}

/**
 * PLATE 1: the film, and only the part of it that is the product.
 *
 * 3.8 seconds cut from the 30s brand film at 16.6: the console's counter climbing
 * to 492 of 500, `researcher needs 12` turning red, and the refusal body. Its
 * numbers are the figure's numbers.
 *
 * The first ~11 seconds of the master are a blue analytics dashboard that is not
 * this product and not any real one, recorded in the vault as an open defect.
 * They are not on this page, and this is the comment that says so out loud so a
 * future edit that "restores the full film" has to argue with it first.
 *
 * `poster` carries the frame before a byte of video arrives, `preload="none"`
 * means a phone on a cellular connection pays for the 41KB still and nothing
 * else, and the loop is muted with no audio STREAM at all rather than muted by
 * attribute, which is what keeps autoplay out of browser policy entirely.
 */
function videoPlate(): string {
  return `<figure class="plate">
      <figcaption class="plate-head">
        <span>Plate 1 &middot; job-142 burns down</span>
        <span class="plate-meta">0:04 loop &middot; muted</span>
      </figcaption>
      <video class="plate-v" poster="/hero-poster.jpg" preload="none" muted playsinline loop autoplay
             width="1280" height="720" aria-label="The AgentBill console counting job-142 up to its 500-unit ceiling and refusing the next call.">
        <source src="/hero-loop.mp4" type="video/mp4" />
      </video>
      <div class="plate-foot">
        <span>${num(Number(heroRefusalBody().task_used_units))} of ${num(Number(heroRefusalBody().task_ceiling))} units &middot; researcher asks ${num(Number(heroRefusalBody().estimated_units))} &middot; refused</span>
      </div>
    </figure>`
}

export async function homeRoute(app: FastifyInstance) {
  app.get('/', publicRoute(), async (request, reply) => {
    return reply.type('text/html').send(`${head({
      title: `AgentBill · ${HEADLINE}`,
      description: 'A ceiling on this job, not on the month. One call before the work asks whether this job has units left, and preflight is that call. Your code decides what next. Free tier, API key in 30 seconds, no card.',
      path: '/',
      // The one page on the paper theme. /app, /docs, /register and the rest stay
      // dark: the console's --held green is semantics, not decoration, and a
      // marketing decision must not reach it. See TOKENS_PAPER in theme.ts.
      theme: 'paper',
      og: {
        description: 'A ceiling on this job, not on the month. One call before the work asks whether this job has units left, and preflight is that call. Your code decides what next.',
      },
      // The product entity lives in ui/ld.ts and is emitted identically here
      // and on /pricing under one @id. It used to be typed in both files and
      // the two copies had already drifted apart.
      jsonLd: softwareLd(),
      mainEntity: `${ORIGIN}/#software`,
      // meta keywords has been ignored by every major engine since 2009. It was
      // 300 bytes on the most-fetched page of the site.
      extraHead: pixelSnippet(),
      scriptHashes: [PLAYGROUND_HASH, COPY_HASH, TABS_HASH, ...pixelHashes()],
      scriptOrigins: pixelExtra(),
      css: `${CHROME_CSS}${PLAYGROUND_CSS}${PANEL_CSS}${COPY_CSS}${TABS_CSS}${TIERS_CSS}
    /* Hallmark · genre: modern-minimal · macrostructure: Split Studio
     * theme: design.md (paper, type and accent are theme.ts) · design-system: design.md · designed-as-app
     * nav: N1b, unchanged · footer: Ft2, unchanged · enrichment: none, real product panels
     * order: hero (copy beside the dual-state demo), Fig. 1, the thesis band with two evidence lines, playground band,
     *        one row (the request path with the code frame, console-first),
     *        four tier cards, a four-line not-list, the close · one grid break, the playground band
     * craft reference 2026-09-12: pressplaced.com, for air, one demo and one action (and, since 2026-09-18,
     *        one text link to the demo, measured as try_click before any reorder); nothing of its
     *        product, palette or claims · pre-emit critique: P5 H5 E4 S5 R5 V4 */

    /* Page-local values. These were three hex literals and they were the only
       colours on the page that did NOT follow the token block, so when the
       route moved to the paper theme the playground band stayed near-black and
       looked like a bug on a white page. They are now derived, which is the
       whole reason a token block exists. --cmt is a comment on a DARK code
       plate, so it takes the plate's dim ink and not the page's. */
    :root { --shell: 1080px;
            --band-hi: var(--surface2); --band-lo: var(--surface2);
            --cmt: var(--plate-dim); }

    /* .wrap owns the inline axis; every block-axis rule below uses padding-block,
       so neither can wipe the other via the padding shorthand. */
    .wrap { max-width: var(--shell); margin: 0 auto; padding-inline: var(--gutter); }
    h1, h2, h3 { overflow-wrap: anywhere; min-width: 0; }

    /* The label over a section or a row. Tracked mono, the same register as a
       panel's label bar, so the eye reads it as a tag and not as a sentence. */
    .eyebrow { font-family: var(--mono); font-size: var(--fs-label); letter-spacing: .14em;
               text-transform: uppercase; color: var(--dim); margin-bottom: var(--s3); }

    /* An identifier inside prose. The mono face is the third register in the
       system and it is what makes task_ref read as a thing in the code rather
       than as a word in a sentence. No chip ground: this is body copy. */
    .mono-in { font-family: var(--mono); font-size: .92em; color: var(--text); font-weight: 500; }

    /* Hero: a diptych. One line of what it is, one sentence of how it works
       and one button on the left; the dual-state demo on the right. Centred
       against each other because this is one row, not a sibling of other
       rows; the diptychs below align start, per design.md. The block padding
       is the page's largest on purpose: the reference reads because of what
       is NOT next to its headline. */
    .hero { padding-block: 96px 104px; display: grid; grid-template-columns: minmax(0, 11fr) minmax(0, 10fr);
            gap: 80px; align-items: center; }
    h1 { color: var(--white); max-width: 12ch; }
    .sub { font-size: var(--fs-lede); color: var(--muted); margin: var(--s5) 0 var(--s6); max-width: 40ch; line-height: 1.55; }
    .hero-cta { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
    /* One text link beside the one button, 2026-09-18. The demo sits about two
       screens down on a desktop and three on a phone, and none of the first 40
       paid visits reached it. The measured alternative to moving it: a link,
       counted as try_click, so the data decides whether the demo moves. A link
       and not a second button, which the [fold] gates keep true. Type and
       weight follow .chip-link; the ink rests muted and darkens on hover like
       the evidence links and the nav, so beside the one primary it is quiet
       at rest and answers the pointer the way everything else here does. */
    .hero-try { font-size: var(--fs-small); font-weight: 600; color: var(--muted);
                text-decoration: underline; text-underline-offset: .2em; }
    .hero-try:hover { color: var(--text); }
    /* One primary action on the fold, one size up from the site's buttons. */
    .btn-lg { padding: 15px 28px; font-size: var(--fs-body); border-radius: 10px; }
    /* One line, not a row of dotted spans: the locked copy is a sentence. */
    .trust { margin-top: 16px; font-family: var(--mono); font-size: var(--fs-micro); color: var(--dim);
             display: flex; flex-wrap: wrap; gap: 0 var(--s3); }

    /* The dual-state demo. Two cards on the panel frame every product surface
       uses, staggered the way the reference stacks its pair: the month card
       narrower and quieter, the job card wider, lower and carrying the
       answer. The stagger is width and margin, not a transform, so nothing
       moves and nothing is drawn over anything. */
    /* PLATE 1: the film.
       A dark rectangle on paper is not a clash: it is how a technical document
       embeds a photograph, and it is the rule the code frames follow too. Hard
       edges, a rule above, a caption below, and no play chrome of our own: the
       loop is 3.8s and silent, so a play button would be furniture. */
    .plate { margin: 0; min-width: 0; display: grid; gap: 12px; align-content: start; padding-top: 6px; }
    .plate-head { display: flex; justify-content: space-between; align-items: baseline; gap: var(--s3);
                  font-family: var(--mono); font-size: var(--fs-label); letter-spacing: .1em;
                  text-transform: uppercase; color: var(--text); }
    /* The meta never wraps; the label is the half that gives way. Measured: at
       1440 the plate column is 454px and the two together wanted 483. */
    .plate-meta { color: var(--dim); white-space: nowrap; }
    /* aspect-ratio, not a fixed height: poster and loop are both 16:9, so the
       box cannot shift when the video swaps in. Without it the poster arrives,
       lays out, and the page jumps under the reader. */
    .plate-v { display: block; width: 100%; height: auto; aspect-ratio: 16 / 9;
               background: var(--plate); border: 1px solid var(--text); object-fit: cover; }
    .plate-foot { display: flex; justify-content: space-between; align-items: baseline; gap: var(--s3);
                  flex-wrap: wrap; font-family: var(--mono); font-size: var(--fs-micro); color: var(--muted); }

    /* FIG. 1: the meters.
       A four-column grid: label, value, the bar column, the callout. The bar
       column ends exactly where the ceiling line is drawn, so a bar cannot
       overrun it and the zone past it belongs to the refused request alone. */
    .fig-sec { padding-block: 0 88px; }
    .fig { margin: 0; --barL: 300px; --barW: calc(100% - 300px - 160px); }
    .fig-head { display: flex; justify-content: space-between; align-items: baseline; gap: var(--s3);
                font-family: var(--mono); font-size: var(--fs-label); letter-spacing: .1em;
                text-transform: uppercase; color: var(--text); padding-bottom: 10px;
                border-bottom: 1px solid var(--text); }
    .fig-tag { color: var(--dim); }
    .plot { position: relative; padding-block: 26px 10px; }
    /* One line, drawn once, crossing every meter. It is the figure's whole
       argument, so it is an element rather than a border on some row. */
    .ceil { position: absolute; top: 0; bottom: 6px; left: calc(var(--barL) + var(--barW));
            width: 2px; background: var(--text); }
    .ceil span { position: absolute; top: 0; left: 12px; white-space: nowrap;
                 font-family: var(--mono); font-size: var(--fs-chip); letter-spacing: .1em;
                 text-transform: uppercase; color: var(--text); }
    .mrow { display: grid; grid-template-columns: 190px 100px var(--barW) 1fr; align-items: center;
            column-gap: 10px; padding-block: 15px; }
    .m-l { font-family: var(--mono); font-size: var(--fs-small); letter-spacing: .06em;
           text-transform: uppercase; color: var(--muted); min-width: 0; overflow-wrap: anywhere; }
    .m-v { font-family: var(--mono); font-size: var(--fs-micro); color: var(--dim); text-align: right;
           font-variant-numeric: tabular-nums; }
    .m-t { position: relative; display: block; height: 9px; border-bottom: 1px solid var(--border);
           margin-left: 10px; }
    .m-t i { position: absolute; left: 0; bottom: 0; height: 9px; background: var(--dim); opacity: .5; }
    /* The units this call asked for, past the line: dashed, because they were
       never spent. */
    .m-t u { position: absolute; left: 100%; bottom: 0; width: 28px; height: 100%;
             border: 1px dashed var(--signal); background: var(--held-bg); }
    .m-s { font-family: var(--mono); font-size: var(--fs-chip); letter-spacing: .08em;
           text-transform: uppercase; color: var(--dim); padding-left: 16px; }
    .mrow.lit .m-l, .mrow.lit .m-v { color: var(--text); font-weight: 500; }
    .mrow.lit .m-t { height: 15px; }
    .mrow.lit .m-t i { height: 15px; background: var(--signal); opacity: 1; }
    /* --signal-deep, not --signal: this callout sits beside the signal's own
       tint, where the paper value measures 3.94 against a 4.5 floor. */
    .mrow.lit .m-s { color: var(--signal-deep); font-weight: 500; }
    .fig-cap { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border);
               font-family: var(--mono); font-size: var(--fs-small); color: var(--muted); }

    /* The thesis band. The concession is --muted and the claim is --text: the
       page concedes in grey and claims in ink, which is an argument made with
       weight instead of with an adverb. */
    .band { background: var(--surface2); border-block: 1px solid var(--border); padding-block: 88px; }
    .thesis { font-size: clamp(20px, 2.2vw, 27px); line-height: 1.5; letter-spacing: -.015em;
              color: var(--text); max-width: min(960px, 100%); }
    .thesis .concede { color: var(--muted); }
    .thesis .sig { color: var(--signal); font-size: .9em; }
    .evid { margin-top: 52px; padding-left: 20px; border-left: 2px solid var(--signal); max-width: 900px; }
    .evid p { color: var(--muted); line-height: 1.6; }
    .evid a { display: inline-block; margin-top: 10px; font-family: var(--mono); font-size: var(--fs-micro);
              letter-spacing: .08em; text-transform: uppercase; color: var(--dim); text-decoration: underline;
              text-underline-offset: 3px; }
    .evid a:hover { color: var(--text); }
    .evid + .evid { margin-top: var(--s6); }

    /* The code frame. Its label bar carries the language tabs on the left and
       the caption on the right; the bar keeps the 44px floor every control on
       the site clears, and the selected tab is a bar on the hairline, the same
       device the nav uses for the current page.
       The answer sits OUTSIDE the code element on purpose: the snippet harness
       executes every one of those against the SDKs, and an interpolation inside
       one marks the whole block dynamic and silently drops it from CI. Never
       write that tag's name in a comment in this file: the extractor scans for
       it and would run from the comment to the real closing tag. */
    .code-block { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-frame);
                  border-top-color: var(--border2); overflow: hidden; min-width: 0; box-shadow: var(--edge), var(--lift); }
    .code-head { display: flex; align-items: center; justify-content: space-between; gap: var(--s4);
                 padding: 0 var(--s4); min-height: 44px; border-bottom: 1px solid var(--border); background: var(--surface2);
                 box-shadow: var(--edge);
                 font-family: var(--mono); font-size: var(--fs-label); letter-spacing: 1.1px; color: var(--dim); }
    .code-head > span { white-space: nowrap; }
    .code-body { padding: 20px 24px; overflow-x: auto; }
    .code-body pre { font-family: var(--mono); font-size: var(--fs-small); color: var(--code-ink); line-height: 1.7; }
    .cmt { color: var(--cmt); }
    .out-dim { color: var(--dim); }
    /* The answer: the wire body the sample's call gets back on the run where
       8 units remain, then the exception the SDK raises from it. Body first,
       because the body is what is checkable against POST /preflight. */
    .code-out { border-top: 1px solid var(--border); padding: 14px 20px 16px; background: var(--bg-deep);
                font-family: var(--mono); font-size: var(--fs-micro); line-height: 1.65; }
    .co-l { display: flex; justify-content: space-between; gap: var(--s3); font-size: var(--fs-chip);
            letter-spacing: .12em; text-transform: uppercase; color: var(--dim); margin-bottom: 6px; }
    .co-l .no { color: var(--red); }
    .co-json { display: block; color: var(--code-ink); white-space: pre-wrap; overflow-wrap: anywhere; }
    .co-json .k { color: var(--muted); }
    .co-json .s, .co-json .n { color: var(--code); }
    .co-json .f { color: var(--red); font-weight: 700; }
    .co-n { margin-top: 8px; color: var(--dim); }
    .co-n b { color: var(--muted); font-weight: 500; }
    /* The install line, under the request-path row's text, following the
       language tab in the frame beside it so the pill and the sample always
       name the same package. */
    .row-install { margin-top: 22px; }

    /* The playground is one scroll down and the nav is sticky, so the anchor
       lands beneath it rather than under it. */
    #playground { scroll-margin-top: calc(var(--banner-height) + var(--s4)); }

    /* Sections. Uneven on purpose: the argument opens generously, the rows sit
       closer to each other than to the sections that frame them, and pricing
       opens wide because it changes subject. */
    section { padding-block: 88px 0; }
    .rows { padding-block: 24px 0; }
    .pricing { padding-block: 104px 0; }
    .not-for { padding-block: 88px 0; }

    /* The why. One head, one paragraph, three cards of evidence. */
    /* .lead-p survives the sourced-card removal: the pricing head and the
       playground lede both use it. */
    .lead-p { color: var(--muted); max-width: 62ch; line-height: 1.7; }

    /* The row. Text on one side, the product on the other. One row since
       2026-09-12, and still written as a row recipe so a second one, if it
       ever earns its place, is not a new component. A gutter, no rule: the two
       halves are one argument, not two cards. The row is closed by a hairline
       (.row-close), because an open-bottomed unequal row reads as an
       unfinished column; text top aligns with panel top, with a 4px optical
       nudge putting the head's cap height on the panel's label bar. */
    .dip { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); gap: var(--gap);
           align-items: start; padding-block: 48px 48px; }
    .dip-text { padding-top: 4px; }
    .dip h2 { color: var(--white); margin-bottom: var(--s4); max-width: 14ch; }
    .dip p { color: var(--muted); line-height: 1.7; max-width: 44ch; }
    .chip-link { display: inline-flex; align-items: center; gap: 0.5em; margin-top: 22px; min-height: 44px;
                 padding: 0 18px; border: 1px solid var(--border-strong); border-radius: var(--r-control);
                 color: var(--text); text-decoration: none; font-weight: 600; font-size: var(--fs-small);
                 white-space: nowrap; transition: border-color .15s; }
    .chip-link:hover { border-color: var(--text); }
    .chip-link:active { transform: translateY(1px); }

    /* The demo's meter and chips, in the console's own vocabulary: the same
       class names and the same colour tests app.ts applies, so the fold cannot
       paint a state the console would not. Two states are all the fold shows,
       a month with room and a job that is out; the near/fail/reserved states
       left with the task-budgets and refusals panels on 2026-09-12. */
    .track { height: 8px; background: var(--surface3); border-radius: var(--r-pill); overflow: hidden; display: flex; }
    .track i { display: block; height: 100%; }
    .track i.used { background: var(--flow); }
    .track i.used.held { background: var(--green); }
    .chip { font-family: var(--mono); font-size: var(--fs-chip); letter-spacing: .08em; text-transform: uppercase;
            padding: 3px 9px; border-radius: var(--r-chip); border: 1px solid; margin-left: auto; }
    .chip.held { color: var(--green); border-color: var(--held-line); background: var(--held-bg); }
    .chip.flow { color: var(--muted); border-color: var(--border2); background: var(--surface3); }

    /* Pricing: the four cards /pricing renders, from ui/tiers.ts. */
    .pricing h2 { color: var(--white); margin-bottom: var(--s2); max-width: 22ch; }
    .price-links { margin-top: var(--s5); display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }

    /* What it does not do: four items, one line each, two columns, on
       hairlines. Cut from ten on 2026-09-12. The four that stay are the ones a
       reader can check against this page (no proxy, no dollars, approved:
       false, refused not reversed); the rest are in the README and on /about,
       and a line about who has agreed to be named is gone for good: it was a
       sentence about other people. */
    .not-for h2 { color: var(--white); margin-bottom: var(--s2); }
    .nots { list-style: none; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 var(--gap);
            margin-top: var(--s5); }
    .nots li { color: var(--muted); font-size: var(--fs-small); line-height: 1.6; padding: 12px 0 12px 22px;
               border-bottom: 1px solid var(--border-soft); position: relative; }
    .nots li b { color: var(--text); font-weight: 600; }
    /* A short rule reads as negation, needs no icon set, and speaks the mark's
       own vocabulary: a line that stops something. */
    .nots li::before { content: ""; position: absolute; left: 0; top: calc(12px + 0.62em);
                       width: 11px; height: 1.5px; background: var(--red); }

    /* The close. Calm: a head, one line, the button and the install line. On a
       phone the sticky bar is the primary, so .end stands the button down. */
    .final { padding-block: var(--s9) var(--s5); }
    .final h2 { color: var(--white); margin-bottom: 10px; }
    .final p { color: var(--muted); margin-bottom: var(--s5); max-width: 54ch; }
    .final-row { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }

    @media (max-width: ${BP.lg}px) {
      .hero, .dip { grid-template-columns: minmax(0, 1fr); gap: 40px; }
      .hero { align-items: start; padding-block: var(--s7) var(--s7); }
      /* One column: the stagger has no second column to play against. */
      .dip-text { padding-top: 0; }
      .dip { padding-block: 36px 36px; }
      section { padding-block: 64px 0; }
      .rows { padding-block: 16px 0; }
      .pricing { padding-block: 80px 0; }
      .sub { max-width: 54ch; }
      /* The figure's four columns do not survive one column of page. The label
         and value keep their row, the bar takes the rest, and the callout moves
         under the bar rather than being squeezed off the edge, which is what
         it did, silently, until scripts/shots.mjs measured the clip. */
      .fig { --barL: 150px; --barW: calc(100% - 150px - 130px); }
      .mrow { grid-template-columns: 120px 1fr var(--barW) 130px; }
      .m-l { font-size: var(--fs-micro); }
    }
    @media (max-width: ${BP.md}px) {
      .nots { grid-template-columns: minmax(0, 1fr); }
      /* Two rows per meter: label and value on the first, the bar on the
         second, the callout in the strip past the ceiling. --barW is written
         against the SAME expression the .ceil line reads, so the line and the
         end of the bar column cannot drift apart at any width. */
      .fig { --barL: 0px; --barW: calc(100% - 104px); }
      .mrow { grid-template-columns: 1fr auto; grid-template-areas: "l v" "t t"; row-gap: 9px;
              padding-block: 13px; }
      .m-l { grid-area: l; font-size: var(--fs-micro); }
      .m-v { grid-area: v; }
      .m-t { grid-area: t; margin-left: 0; }
      /* The callout no longer has a column, so it is positioned into the strip
         the ceiling line opens. */
      .m-s { position: absolute; left: calc(var(--barW) + 12px); padding-left: 0;
             font-size: var(--fs-tick); max-width: 92px; line-height: 1.25; }
      .mrow { position: relative; }
      .ceil span { font-size: var(--fs-tick); left: auto; right: calc(100% + 8px); }
    }
    @media (max-width: ${BP.sm}px) {
      /* The full-width exception in design.md was written when the fold carried
         TWO hero buttons. It carries one, and chrome.ts already puts a
         full-width sticky bar at the bottom of the same phone screen, so
         honouring it here paints two identical ink slabs 600px apart, the
         defect this redesign started from. The hero button stays inline: the
         sticky bar is the full-width primary on a phone, and the hero's is the
         one you meet first. */
      .sub { max-width: none; font-size: var(--fs-body); margin: 18px 0 26px; }
      .hero { padding-block: var(--s6) var(--s7); }
      .hero-cta > a { display: inline-block; }
      .cp { max-width: none; }
      .code-body { padding: 18px 16px; }
      .code-body pre { font-size: var(--fs-micro); }
      /* The caption in the label bar yields to the tabs at 390px; the tabs
         carry the meaning and the caption repeats the section under it. */
      .code-head > span { display: none; }
      .final-row { display: grid; grid-template-columns: minmax(0, 1fr); }
      .fig { --barW: calc(100% - 96px); }
      .m-s { max-width: 84px; }
      .plate-head { flex-direction: column; gap: 4px; align-items: flex-start; }
      .plate-foot { flex-direction: column; gap: 4px; }
      .thesis { font-size: var(--fs-lede); }
      .band { padding-block: 56px; }
      .fig-sec { padding-block: 0 56px; }
    }
`,
    })}
<body>
${siteNav('/')}
<main>

  <header class="hero wrap">
    <div class="hero-copy">
      <h1>${HEADLINE}</h1>
      <p class="sub">AgentBill is a per-task spending ceiling for autonomous AI agents. Before the next
      model call, preflight returns <span class="mono-in">approved: false</span> when this
      <span class="mono-in">task_ref</span> is out of units. Your code decides whether to stop, skip,
      or replan.</p>
      <div class="hero-cta">
        <a class="btn btn-lg" href="/register">${KEY_CTA}</a>
        <a class="hero-try" href="#playground">Try it in your browser &rarr;</a>
      </div>
      <p class="trust">Start free &middot; ${num(PLAN_LIMITS.free)} preflight calls/mo, no card</p>
    </div>
    ${videoPlate()}
  </header>

  <section class="wrap fig-sec">
    ${ceilingFigure()}
  </section>

  <section class="band">
    <div class="wrap">
      <p class="thesis"><span class="concede">Wall-clock timeouts, org-month meters, and window budgets
      (e.g. ClawGuard USD windows) are real. They meter a clock or an account.</span> A
      <span class="mono-in sig">task_ref</span> ceiling meters this job: preflight can return
      <span class="mono-in sig">approved: false</span> before the next call; your code decides what next.</p>
      <div class="evid">
        <p>~$300 of unintended API usage over one unattended weekend, under a $3,000/month Enterprise
        limit. The limit is a month. The incident was a weekend.</p>
        <a href="https://github.com/anthropics/claude-code/issues/64744" rel="nofollow noopener"
           target="_blank">github.com/anthropics/claude-code/issues/64744</a>
      </div>
      <div class="evid">
        <p>Google, on the Gemini API billing page: &ldquo;Long-running tasks like batch mode completions and
        agent sessions may incur overages beyond your project spend cap.&rdquo;</p>
        <a href="https://ai.google.dev/gemini-api/docs/billing" rel="nofollow noopener"
           target="_blank">ai.google.dev/gemini-api/docs/billing</a>
      </div>
    </div>
  </section>

${playgroundSection()}

  <section class="wrap rows">
    <div class="dip row-close">
      <div class="dip-text">
        <p class="eyebrow">No proxy</p>
        <h2>Two calls. Nothing in your request path.</h2>
        <p>Set the job's ceiling once, in the console or with
        <span class="mono-in">PUT /tasks/:task_ref/ceiling</span> and
        <span class="mono-in">ceiling_units</span> in the body. Then the code names the job and nothing
        about its budget: <span class="mono-in">preflight</span> with the same
        <span class="mono-in">task_ref</span> before your provider call, <span class="mono-in">record</span>
        after it. No base URL to change, no traffic routed through us, no provider keys held. If we are
        unreachable, the SDK raises inside your process and your code decides.</p>
        <a class="chip-link" href="/app?demo=1&amp;view=tasks">Watch a job burn down &rarr;</a>
        <!-- The step that needs no account, following the language tab in the
             frame beside it so the pill and the sample always name the same
             package. -->
        <div class="row-install">
          <div data-lang="python">${copyPill('install-py', INSTALL_PY)}</div>
          <div data-lang="node" hidden>${copyPill('install-node', 'npm install agentbill')}</div>
        </div>
      </div>

      <!-- Neither sample passes task_ceiling, and that is not an omission.
           The frame's last line is "run 42 of the retry loop", so job-142
           already exists, and preflight.ts does not apply a task_ceiling once
           it does: the field would be read by a visitor as the way a ceiling is
           set while doing nothing at all. It is also the order the onboarding
           replaced. The comment names where the 500 came from, and the answer
           below still shows task_ceiling because the server really sends it.
           Opening a job from code keeps its documentation in /docs. -->
      <div class="code-block">
        <div class="code-head">${langTabs([['python', 'Python'], ['node', 'Node']], 'python', 'Language of the sample')}<span>the whole integration</span></div>
        <div class="code-body">
          <pre id="code-python" role="tabpanel" aria-labelledby="tab-python" data-lang="python">from agentbill import AgentBillClient

client = AgentBillClient(
    api_key="agb_your_key")

<span class="cmt"># You decide what a unit is worth.</span>
<span class="cmt"># job-142 has a ceiling of 500, set</span>
<span class="cmt"># in the console. Every call passing</span>
<span class="cmt"># this task_ref burns the same one.</span>
client.preflight(agent_id="researcher",
                 task_ref="job-142",
                 estimated_units=12)

<span class="cmt"># your provider call goes here</span>

<span class="cmt"># settle, or the units stay held</span>
<span class="cmt"># until the reservation expires.</span>
client.record(agent_id="researcher",
              task_ref="job-142",
              units=12)

<span class="out-dim">&gt;&gt;&gt; run 42 of the retry loop:</span></pre>
          <pre id="code-node" role="tabpanel" aria-labelledby="tab-node" data-lang="node" hidden>import { preflight, record }
  from 'agentbill'

<span class="cmt">// Reads AGENTBILL_API_KEY from env.</span>
<span class="cmt">// You decide what a unit is worth.</span>
<span class="cmt">// job-142 has a ceiling of 500, set</span>
<span class="cmt">// in the console. Every call passing</span>
<span class="cmt">// this taskRef burns the same one.</span>
await preflight({ agentId: 'researcher',
                  taskRef: 'job-142',
                  estimatedUnits: 12 })

<span class="cmt">// your provider call goes here</span>

<span class="cmt">// settle, or the units stay held</span>
<span class="cmt">// until the reservation expires.</span>
await record({ agentId: 'researcher',
               taskRef: 'job-142',
               units: 12 })

<span class="out-dim">// run 42 of the retry loop:</span></pre>
        </div>
        <div class="code-out">
          <div class="co-l"><span>POST /preflight</span><span class="no">200 &middot; refused</span></div>
          <code class="co-json">${heroAnswer()}</code>
          <p class="co-n">The SDK raises <b>${REFUSAL.name}</b>. Your code decides what happens next.</p>
        </div>
      </div>
    </div>

  </section>

  <section class="wrap pricing" id="pricing">
    <p class="eyebrow">Pricing</p>
    <h2>Free to start. Cheap enough to leave on.</h2>
    <p class="lead-p">${SAME_FEATURES}</p>
    ${tierCards((tier) => `/app/upgrade/${tier}`)}
    <div class="price-links">
      <a class="btn-ghost" href="/pricing">Full pricing &rarr;</a>
    </div>
  </section>

  <section class="wrap not-for">
    <h2>What AgentBill does not do</h2>
    <ul class="nots">
      <li><b>Sit in your request path.</b> No proxy, no base URL to change, no provider keys held. A call
      that never asks, or a retry buried in a library, is invisible to the ceiling.</li>
      <li><b>Read your provider bill.</b> No invoice, no dollar estimate. Units are yours to define, and
      units refused is not money.</li>
      <li><b>Reach into a running job.</b> Preflight answers <span class="mono-in">approved: false</span>
      and the SDK raises. Your code decides what happens next.</li>
      <li><b>Undo what already ran.</b> Calls are refused, not reversed, and the ceiling is keyed on
      <span class="mono-in">(account_id, task_ref)</span>: a loop that opens a new
      <span class="mono-in">task_ref</span> gets a new ceiling.</li>
    </ul>
  </section>

  <section class="wrap final end">
    <h2>Give one job a ceiling.</h2>
    <p>Free tier, no card, ${num(PLAN_LIMITS.free)} preflight calls a month. If this page took longer to
    read than the integration takes, we did our job.</p>
    <div class="final-row">
      <a class="btn btn-lg" href="/register">${KEY_CTA}</a>
      <div data-lang="python">${copyPill('install-py-2', INSTALL_PY)}</div>
      <div data-lang="node" hidden>${copyPill('install-node-2', 'npm install agentbill')}</div>
    </div>
  </section>

</main>
${siteFooter()}
${PLAYGROUND_JS}${COPY_JS}${TABS_JS}
</body>
</html>
    `)
  })
}
