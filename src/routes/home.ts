import { HEADLINE, INSTALL_PY, ORIGIN } from '../ui/site.js'
import { FastifyInstance } from 'fastify'
import { head, BP } from '../ui/theme.js'
import { siteNav, siteFooter, CHROME_CSS, KEY_CTA } from '../ui/chrome.js'
import { PLAYGROUND_CSS, PLAYGROUND_JS, PLAYGROUND_HASH, playgroundSection, REFUSAL, heroRefusalBody } from '../ui/playground.js'
import { pixelSnippet } from '../lib/pixel.js'
import { demoConsole, decisionLine } from './app.js'
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
// the provider-cap argument is three sourced cards instead of an essay; each
// benefit row is an eyebrow, a head, two sentences and a panel; the tiers
// are the same four cards /pricing renders; and the list of what the product
// does not do is kept, compressed to one line per item. The keys row and the
// console-overview row came out the same day: a reader on the cold path
// meets a dashboard after a refusal, not before one.
// Nothing here is a logo wall, a count or a testimonial: there is nobody to
// name yet.

const esc = (s: unknown) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const num = (n: number) => n.toLocaleString('en-US')

/** Task budgets burning down: the first three rows of the demo console. */
function taskPanel(): string {
  const rows = demoConsole().tasks.slice(0, 3).map((t) => {
    // Same two tests the console applies in app.ts: the chip reads the settled
    // number, the bar colour reads settled plus in-flight. Keep them identical.
    const ratio = (t.usedUnits + t.reservedUnits) / t.ceilingUnits
    const leaked = t.usedUnits > t.ceilingUnits
    const held = t.usedUnits >= t.ceilingUnits
    const chip = leaked
      ? '<span class="chip fail">leaked</span>'
      : held
        ? '<span class="chip held">ceiling hit</span>'
        : ratio >= 0.8 ? '<span class="chip near">close</span>' : '<span class="chip flow">running</span>'
    const barCls = leaked ? ' fail' : ratio >= 1 ? ' held' : ratio >= 0.8 ? ' near' : ''
    const usedPct = Math.min(100, (t.usedUnits / t.ceilingUnits) * 100)
    const resPct = Math.min(100 - usedPct, (t.reservedUnits / t.ceilingUnits) * 100)
    return `
        <div class="task">
          <div class="task-top">
            <span class="ref">${esc(t.taskRef)}</span>
            <span class="agent">${esc(t.agentId)}</span>
            ${chip}
          </div>
          <div class="track" aria-hidden="true">
            <i class="used${barCls}" style="width:${usedPct.toFixed(1)}%"></i>
            <i class="res" style="width:${resPct.toFixed(1)}%"></i>
          </div>
          <div class="task-nums"><b>${num(t.usedUnits)}</b> / ${num(t.ceilingUnits)} units${
            t.reservedUnits ? ` <span class="dimtxt">&middot; ${num(t.reservedUnits)} reserved</span>` : ''}</div>
        </div>`
  }).join('')
  return `<div class="panel">
        <div class="panel-h"><span>Task budgets</span><span>one job, many calls, one ceiling</span></div>
        ${rows}
        <div class="panel-f">Sample rows, the same ones the demo console shows. Units are an integer you define.</div>
      </div>`
}

/**
 * Three refusals from three agents. The sentence on each row is composed by
 * the console's own decisionLine() from the columns the refusal carries, so
 * this panel and the console's refusals view read the same words.
 */
function refusalPanel(): string {
  const rows = demoConsole().decisions.filter((d) => d.blocked && d.taskRef).slice(0, 3).map((d) => `
        <div class="ref-row">
          <div class="ref-top">
            <span class="agent">${esc(d.agentId ?? '')}</span>
            <span class="ref">${esc(d.taskRef ?? '')}</span>
            <span class="chip held">refused</span>
            <span class="ask">asked ${num(d.estimatedUnits ?? 0)}</span>
          </div>
          <div class="ref-msg">${esc(decisionLine(d))}</div>
        </div>`).join('')
  return `<div class="panel">
        <div class="panel-h"><span>Refusals</span><span>what the agent got back</span></div>
        ${rows}
        <div class="panel-f">Sample rows. Three agents, three tasks, one rule. "Asked" is units, not a dollar figure.</div>
      </div>`
}

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
 * The month-window sample on the fold's first card, as a share of a window.
 * A percentage and not a count, on purpose: this product has no month meter
 * to read, and a number of units or dollars on that card would be a claim
 * about a meter we do not run. The card says "sample" in its own frame.
 */
const MONTH_SAMPLE_PCT = 4

/**
 * The fold's one demo: two meters on one account at one moment. The month
 * window has room and nothing fires. This job is out, and the body under it
 * is what POST /preflight answered, from heroRefusalBody(). The two cards are
 * the whole argument of the page in the time it takes to read two chips:
 * a ceiling on this job, not on the month.
 *
 * The caption under it says what the ceiling is and is not, and stops there.
 * It does not say nobody else has one; a session or run ceiling can be
 * built by hand on any gateway, and the claims rules do not allow the word
 * "only" on a surface nobody can check.
 */
function dualState(): string {
  const body = heroRefusalBody()
  const used = Number(body.task_used_units ?? 0)
  const ceil = Number(body.task_ceiling ?? 1)
  const ask = Number(body.estimated_units ?? 1)
  const pct = Math.min(100, (used / ceil) * 100)
  return `<figure class="demo">
      <div class="dcard month">
        <div class="dhead"><span>Month window &middot; the organization</span><span class="dtag">sample</span></div>
        <div class="dbody">
          <div class="dline"><b>${MONTH_SAMPLE_PCT}%</b> of the month used</div>
          <div class="track" aria-hidden="true"><i class="used" style="width:${MONTH_SAMPLE_PCT}%"></i></div>
          <div class="dfoot"><span class="chip flow">still under the cap</span><span class="dwhen">resets on the 1st</span></div>
        </div>
      </div>
      <div class="dlink"><span>same account, same minute</span></div>
      <div class="dcard job">
        <div class="dhead"><span>This job</span><span class="dref">task_ref <b>${esc(String(body.task_ref))}</b></span></div>
        <div class="dbody">
          <div class="dline"><b>${num(used)}</b> of ${num(ceil)} units &middot; this call asks ${num(ask)}</div>
          <div class="track" aria-hidden="true"><i class="used held" style="width:${pct.toFixed(1)}%"></i></div>
          <div class="dfoot"><span class="chip held">refused</span><span class="dwhen">out of units &middot; <b>approved: false</b></span></div>
          <code class="co-json">${heroAnswer()}</code>
        </div>
      </div>
      <figcaption class="dcap">job ceiling &middot; not a month window &middot; not a proxy</figcaption>
    </figure>`
}

/**
 * The provider-cap argument, as evidence rather than prose. Three sources,
 * each read at the URL beside it on 2026-09-07. The claim on the page is only
 * what each ceiling is BOUND to; nothing here says a provider lacks a cap,
 * because the first card is a provider's cap firing.
 */
function sourceCards(): string {
  return `<div class="src-grid">
        <div class="src">
          <span class="src-l">OpenAI &middot; spend limits</span>
          <p>A hard limit answers <b class="mono-in">429 project_spend_limit_exceeded</b>, and enforcement
          &ldquo;is not instantaneous, so recorded spend can slightly exceed the configured amount.&rdquo;
          The boundary is the project or the organization.</p>
          <a href="https://developers.openai.com/api/docs/guides/spend-limits" rel="nofollow noopener">developers.openai.com</a>
        </div>
        <div class="src">
          <span class="src-l">Anthropic &middot; rate limits</span>
          <p>A tier spend cap pauses API usage &ldquo;until 00:00 UTC on the first day of the next month.&rdquo;
          The boundary is the organization, and the clock is the calendar.</p>
          <a href="https://platform.claude.com/docs/en/api/rate-limits" rel="nofollow noopener">platform.claude.com</a>
        </div>
        <div class="src">
          <span class="src-l">claude-code &middot; issue 64744, open</span>
          <p>Enterprise plan, <b>$3,000/month limit</b>: &ldquo;~$300 of unintended API usage over a single
          weekend with no way to detect or stop it from the CLI.&rdquo; The limit is a month. The incident
          was a weekend.</p>
          <a href="https://github.com/anthropics/claude-code/issues/64744" rel="nofollow noopener">github.com</a>
        </div>
      </div>`
}

export async function homeRoute(app: FastifyInstance) {
  app.get('/', publicRoute(), async (request, reply) => {
    return reply.type('text/html').send(`${head({
      title: `AgentBill · ${HEADLINE}`,
      description: 'A ceiling on this job, not on the month. One call before the work asks whether this job has units left, and preflight is that call. Your code decides what next. Free tier, API key in 30 seconds, no card.',
      path: '/',
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
     * order: hero (copy beside the dual-state demo), playground band, three sourced cards,
     *        three rows (ceilings, the request path with the code frame, the receipt),
     *        four tier cards, the not-list, the close · one grid break, the playground band
     * craft reference 2026-09-12: pressplaced.com, for air, one demo and one action; nothing of its
     *        product, palette or claims · pre-emit critique: P5 H5 E4 S5 R5 V4 */

    :root { --shell: 1080px;
            /* Page-local: the playground band's ground and the code-comment ink.
               The console colours the panels use (--flow, --res, the chip
               grounds) live in theme.ts, one copy for every page. */
            --band-hi: #121212; --band-lo: #0c0c0c;
            --cmt: #79837c; }

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
    /* One primary action on the fold, one size up from the site's buttons. */
    .btn-lg { padding: 15px 28px; font-size: var(--fs-body); border-radius: 10px; }
    .trust { margin-top: 18px; font-family: var(--mono); font-size: var(--fs-micro); color: var(--dim);
             display: flex; flex-wrap: wrap; gap: 0 var(--s3); }
    .trust > span:not(:last-child)::after { content: "\\00b7"; margin-left: var(--s3); color: var(--border2); }
    .trust b { color: var(--muted); font-weight: 500; }

    /* The dual-state demo. Two cards on the panel frame every product surface
       uses, staggered the way the reference stacks its pair: the month card
       narrower and quieter, the job card wider, lower and carrying the
       answer. The stagger is width and margin, not a transform, so nothing
       moves and nothing is drawn over anything. */
    .demo { margin: 0; min-width: 0; display: grid; }
    .dcard { background: var(--surface); border: 1px solid var(--border); border-top-color: var(--border2);
             border-radius: var(--r-frame); box-shadow: var(--edge), var(--lift); overflow: hidden; min-width: 0; }
    .dcard.month { width: 82%; }
    .dcard.job { width: 94%; margin-inline-start: auto; }
    .dhead { display: flex; justify-content: space-between; align-items: baseline; gap: var(--s3); padding: 10px 16px;
             border-bottom: 1px solid var(--border); background: var(--surface2); box-shadow: var(--edge);
             font-family: var(--mono); font-size: var(--fs-label); letter-spacing: .12em; text-transform: uppercase; color: var(--dim); }
    .dhead .dref { text-transform: none; letter-spacing: 0; }
    .dhead .dref b { color: var(--text); font-weight: 500; }
    /* "sample" at the chip register, inside the frame, so a screenshot of the
       card carries the label with it. */
    .dtag { font-size: var(--fs-chip); letter-spacing: .1em; border: 1px solid var(--border2); border-radius: var(--r-chip);
            padding: 1px 6px; color: var(--dim); }
    .dbody { padding: 16px 16px 18px; display: grid; gap: 10px; }
    .dline { font-family: var(--mono); font-size: var(--fs-small); color: var(--muted); font-variant-numeric: tabular-nums; }
    .dline b { color: var(--text); font-weight: 500; }
    .dfoot { display: flex; align-items: center; gap: var(--s3); flex-wrap: wrap; }
    .dfoot .chip { margin-left: 0; }
    .dwhen { font-family: var(--mono); font-size: var(--fs-micro); color: var(--dim); }
    .dwhen b { color: var(--red); font-weight: 700; }
    .demo .co-json { margin-top: 4px; padding: 12px 14px; background: var(--bg-deep); border: 1px solid var(--border);
                     border-radius: var(--r-control); font-family: var(--mono); font-size: var(--fs-micro); line-height: 1.65; }
    /* Between the cards: the one fact that makes them one picture. A tick, then
       the label, at the month card's left edge. */
    .dlink { display: flex; align-items: center; gap: var(--s3); padding: 8px 0 8px 18px;
             font-family: var(--mono); font-size: var(--fs-micro); letter-spacing: .08em; text-transform: uppercase; color: var(--dim); }
    .dlink::before { content: ""; width: 1px; height: 22px; background: var(--border-strong); }
    .dcap { margin-top: 14px; font-family: var(--mono); font-size: var(--fs-micro); color: var(--dim); text-align: right;
            letter-spacing: .02em; }

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
    .why h2 { color: var(--white); max-width: 22ch; margin-bottom: var(--s4); }
    .lead-p { color: var(--muted); max-width: 62ch; line-height: 1.7; }
    .src-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--s4); margin-top: var(--s6); }
    .src { min-width: 0; display: flex; flex-direction: column; gap: var(--s3);
           background: var(--surface); border: 1px solid var(--border); border-top-color: var(--border2);
           border-radius: var(--r-frame); box-shadow: var(--edge), var(--lift); padding: var(--s4) var(--s5) var(--s5); }
    .src-l { font-family: var(--mono); font-size: var(--fs-chip); letter-spacing: .12em; text-transform: uppercase; color: var(--dim); }
    .src p { color: var(--muted); font-size: var(--fs-small); line-height: 1.65; flex: 1; }
    .src p b { color: var(--text); font-weight: 600; }
    /* Source links at the citation register: --muted and underlined, the way
       .proof a used to be, because the claim carries the page and the link
       carries the claim. */
    .src a { font-family: var(--mono); font-size: var(--fs-micro); color: var(--muted); text-decoration: underline;
             text-underline-offset: 2px; text-decoration-color: var(--border-strong); }
    .src a:hover { color: var(--text); text-decoration-color: var(--text); }
    .src-note { margin-top: var(--s4); font-family: var(--mono); font-size: var(--fs-micro); color: var(--dim); max-width: 70ch; }

    /* Rows. Text on one side, the product on the other, direction alternating.
       A gutter, no rule: the two halves are one argument, not two cards. Every
       row is closed by a hairline (.row-close), because an open-bottomed unequal
       row reads as an unfinished column; text top aligns with panel top, with a
       4px optical nudge putting the head's cap height on the panel's label bar. */
    .dip { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); gap: var(--gap);
           align-items: start; padding-block: 48px 48px; }
    .dip-text { padding-top: 4px; }
    /* order: 2 reorders the DOM item but not the track, so the flipped row
       mirrors its tracks too, or its panel lands 161px narrower than its siblings.
       Two classes outrank one: the collapse rule under --lg names .dip.flip as
       well, or this row keeps its two tracks on a phone. It did, in production,
       and the refusals panel rendered 150px wide beside its own paragraph. */
    .dip.flip { grid-template-columns: minmax(0, 7fr) minmax(0, 5fr); }
    .dip.flip .dip-text { order: 2; }
    .dip h2 { color: var(--white); margin-bottom: var(--s4); max-width: 14ch; }
    .dip p { color: var(--muted); line-height: 1.7; max-width: 44ch; }
    .chip-link { display: inline-flex; align-items: center; gap: 0.5em; margin-top: 22px; min-height: 44px;
                 padding: 0 18px; border: 1px solid var(--border-strong); border-radius: var(--r-control);
                 color: var(--text); text-decoration: none; font-weight: 600; font-size: var(--fs-small);
                 white-space: nowrap; transition: border-color .15s; }
    .chip-link:hover { border-color: var(--text); }
    .chip-link:active { transform: translateY(1px); }

    /* Panel contents. The frame (.panel) comes from ui/panels.ts; what goes
       inside is this page's, in the console's own vocabulary. */
    .task { padding: 16px 18px; border-bottom: 1px solid var(--border-soft); }
    .task:last-of-type { border-bottom: 0; }
    .task-top, .ref-top { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
    .ref { font-family: var(--mono); font-size: var(--fs-small); color: var(--text); }
    .agent { font-family: var(--mono); font-size: var(--fs-micro); color: var(--dim); }
    .task-nums { font-family: var(--mono); font-size: var(--fs-small); color: var(--muted);
                 font-variant-numeric: tabular-nums; }
    .task-nums { margin-top: 8px; }
    .task-nums b { color: var(--text); font-weight: 500; }
    .dimtxt { color: var(--dim); }
    .track { height: 8px; background: var(--surface3); border-radius: var(--r-pill); overflow: hidden; display: flex; }
    .track i { display: block; height: 100%; }
    .track i.used { background: var(--flow); }
    .track i.used.near { background: var(--amber); }
    .track i.used.held { background: var(--green); }
    .track i.used.fail { background: var(--red); }
    .track i.res { background: var(--res); }
    .chip { font-family: var(--mono); font-size: var(--fs-chip); letter-spacing: .08em; text-transform: uppercase;
            padding: 3px 9px; border-radius: var(--r-chip); border: 1px solid; margin-left: auto; }
    .chip.held { color: var(--green); border-color: var(--held-line); background: var(--held-bg); }
    .chip.fail { color: var(--fail-ink); border-color: var(--fail-line); background: var(--fail-bg); }
    .chip.near { color: var(--amber); border-color: var(--near-line); background: var(--near-bg); }
    .chip.flow { color: var(--muted); border-color: var(--border2); background: var(--surface3); }
    .ask { font-family: var(--mono); font-size: var(--fs-micro); color: var(--dim); font-variant-numeric: tabular-nums; }
    .ref-row { padding: 14px 18px; border-bottom: 1px solid var(--border-soft); }
    .ref-row:last-of-type { border-bottom: 0; }
    .ref-row .chip { margin-left: 0; }
    .ref-msg { font-family: var(--mono); font-size: var(--fs-small); color: var(--muted); line-height: 1.6; }

    /* Pricing: the four cards /pricing renders, from ui/tiers.ts. */
    .pricing h2 { color: var(--white); margin-bottom: var(--s2); max-width: 22ch; }
    .price-links { margin-top: var(--s5); display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }

    /* What it does not do: one line per item, two columns, on hairlines. The
       list is the honest substitute for the proof this page cannot show, so it
       stays; one line per item keeps it to a glance instead of a scroll. */
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
      .hero, .dip, .dip.flip { grid-template-columns: minmax(0, 1fr); gap: 40px; }
      .hero { align-items: start; padding-block: var(--s7) var(--s7); }
      /* One column: the stagger has no second column to play against. */
      .dcard.month, .dcard.job { width: 100%; margin-inline-start: 0; }
      .dip.flip .dip-text { order: 0; }
      .dip-text { padding-top: 0; }
      .dip { padding-block: 36px 36px; }
      section { padding-block: 64px 0; }
      .rows { padding-block: 16px 0; }
      .pricing { padding-block: 80px 0; }
      .sub { max-width: 54ch; }
      .src-grid { grid-template-columns: minmax(0, 1fr); }
    }
    @media (max-width: ${BP.md}px) {
      .nots { grid-template-columns: minmax(0, 1fr); }
    }
    @media (max-width: ${BP.sm}px) {
      /* One column: the subhead takes the column's width at body size, and the
         two hero buttons go full width and centred, the sanctioned exception
         recorded in design.md. */
      .sub { max-width: none; font-size: var(--fs-body); margin: 18px 0 26px; }
      .hero { padding-block: var(--s6) var(--s7); }
      .hero-cta { display: grid; grid-template-columns: 1fr; gap: var(--s3); }
      .hero-cta > a { text-align: center; }
      .cp { max-width: none; }
      .code-body { padding: 18px 16px; }
      .code-body pre { font-size: var(--fs-micro); }
      /* The caption in the label bar yields to the tabs at 390px; the tabs
         carry the meaning and the caption repeats the section under it. */
      .code-head > span { display: none; }
      .dhead { flex-direction: column; gap: 2px; }
      .final-row { display: grid; grid-template-columns: minmax(0, 1fr); }
    }
`,
    })}
<body>
${siteNav('/')}
<main>

  <header class="hero wrap">
    <div class="hero-copy">
      <h1>${HEADLINE}.</h1>
      <p class="sub">One call before the work asks whether this job has units left, and
      preflight is that call. When this job is out, the answer is no and your code
      decides what next.</p>
      <div class="hero-cta">
        <a class="btn btn-lg" href="/register">${KEY_CTA}</a>
      </div>
      <p class="trust"><span><b>free tier</b></span><span>${num(PLAN_LIMITS.free)} preflight calls/mo</span><span>no card</span><span>key in 30 seconds</span></p>
    </div>
    ${dualState()}
  </header>

${playgroundSection()}

  <section class="wrap why">
    <p class="eyebrow">Why a task, not a month</p>
    <h2>Your job is not an account, and it does not last a month.</h2>
    <p class="lead-p">The provider cap is real and it fires. It is bound to a project, to an organization
    over a calendar month, or to one session on the vendor's own harness. A run too small to move a
    monthly number never trips it. A number low enough to catch that run stops every agent in the
    organization until the month turns.</p>
    ${sourceCards()}
    <p class="src-note">Read at source on 2026-09-07. What differs is not whether a cap fires. It is what
    the cap is bound to.</p>
  </section>

  <section class="wrap rows">
    <div class="dip row-close">
      <div class="dip-text">
        <p class="eyebrow">Per-task ceilings</p>
        <h2>One job, many calls, one ceiling.</h2>
        <p>Give the job a ceiling in the console, or pass <span class="mono-in">task_ceiling</span> on
        its first call, and the same <span class="mono-in">task_ref</span> on every call after it.
        Every call is checked against that one number, in units you define. Once the job exists a
        <span class="mono-in">task_ceiling</span> on a later call is not applied; the ceiling changes only
        in the console or through <span class="mono-in">PUT /tasks/:task_ref/ceiling</span>.</p>
        <a class="chip-link" href="/app?demo=1&amp;view=tasks">Watch budgets burn down &rarr;</a>
      </div>
      ${taskPanel()}
    </div>

    <div class="dip flip row-close">
      <div class="dip-text">
        <p class="eyebrow">No proxy</p>
        <h2>Two calls. Nothing in your request path.</h2>
        <p><span class="mono-in">preflight</span> before your provider call,
        <span class="mono-in">record</span> after it. No base URL to change, no traffic routed through
        us, no provider keys held. If we are unreachable, the SDK raises inside your process and your
        code decides.</p>
        <a class="chip-link" href="/docs#reservation">How the reservation works &rarr;</a>
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

    <div class="dip row-close">
      <div class="dip-text">
        <p class="eyebrow">The receipt</p>
        <h2>Every refusal is written down.</h2>
        <p>Each <span class="mono-in">approved: false</span> is persisted with the body the agent
        received, per agent and per task. A record that lands past a ceiling because preflight was
        skipped is kept as a leak, not hidden.</p>
        <a class="chip-link" href="/app?demo=1&amp;view=refusals">See the refusals &rarr;</a>
      </div>
      ${refusalPanel()}
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
      <li><b>Stop your run.</b> Preflight answers <span class="mono-in">approved: false</span> and the
      SDK raises. Your code decides what happens next.</li>
      <li><b>Read your provider bill.</b> No access to your provider account, no invoice, no dollar
      estimate. Units are yours to define, and units refused is not money.</li>
      <li><b>See a call that never asks.</b> No proxy, so an uninstrumented tool or a retry buried in a
      library is invisible to the ceiling.</li>
      <li><b>Bind a caller.</b> The ceiling is keyed on
      <span class="mono-in">(account_id, task_ref)</span>. A loop that opens a new
      <span class="mono-in">task_ref</span> gets a new ceiling.</li>
      <li><b>Unwind a workflow.</b> Calls are refused, not reversed. Refusing the next call does not
      undo the ones that already ran.</li>
      <li><b>Guarantee the TTL fits your job.</b> A reservation not settled inside 60 minutes is
      reclaimed by a sweeper while your call may still be running.</li>
      <li><b>Publish a latency SLO.</b> There is none. The free tier is ${num(PLAN_LIMITS.free)} calls
      with no card, enough to measure the added latency on your own workload.</li>
      <li><b>Replace observability or payments.</b> No tracing, no invoices, no money moved. Polar bills
      you for AgentBill; nothing bills anyone on your behalf.</li>
      <li><b>Give your ops team a no-code dashboard.</b> There is a console. The product is an SDK and
      one endpoint.</li>
      <li><b>Show a logo wall or a testimonial.</b> Nobody has agreed to be named yet. The install line,
      the free tier and the response bodies above are what is checkable.</li>
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
