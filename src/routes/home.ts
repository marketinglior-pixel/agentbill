import { FastifyInstance } from 'fastify'
import { head, BP } from '../ui/theme.js'
import { siteNav, siteFooter, CHROME_CSS } from '../ui/chrome.js'
import { PLAYGROUND_CSS, PLAYGROUND_JS, PLAYGROUND_HASH, playgroundSection, REFUSAL } from '../ui/playground.js'
import { pixelSnippet } from '../lib/pixel.js'
import { demoConsole } from './app.js'
import { PLAN_LIMITS, PLAN_PRICES, PLAN_ORDER } from '../integrations/polar.js'
import { PANEL_CSS, requestPanel } from '../ui/panels.js'
import { publicRoute } from '../middleware/auth.js'
import { pixelHashes, pixelExtra } from '../lib/pixel.js'

// The page is a Split Studio: every claim below the fold sits beside a panel
// that shows the product doing the thing the claim describes. The panels are
// not mockups. They render the same sample rows the demo console renders,
// through the same rule the console applies, so the homepage cannot show a
// number the console would disagree with. Where a panel is sample data it
// says so inside its own frame, so a screenshot carries the label with it.

const esc = (s: unknown) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const num = (n: number) => n.toLocaleString('en-US')

// Limits, prices and order all come from polar.ts, the same tables preflight
// enforces and /pricing renders, so no number here can drift from either.
const RECOMMENDED = 'team'

/** Task budgets burning down: the first three rows of the demo console. */
function taskPanel(): string {
  const rows = demoConsole().tasks.slice(0, 3).map((t) => {
    // Same two tests the console applies in app.ts: the chip reads the settled
    // number, the bar colour reads settled plus in-flight. Keep them identical.
    const ratio = (t.usedUnits + t.reservedUnits) / t.ceilingUnits
    const held = t.usedUnits >= t.ceilingUnits
    const chip = held
      ? '<span class="chip held">ceiling hit</span>'
      : ratio >= 0.8 ? '<span class="chip near">close</span>' : '<span class="chip flow">running</span>'
    const barCls = ratio >= 1 ? ' held' : ratio >= 0.8 ? ' near' : ''
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
            t.reservedUnits ? ` <span class="dimtxt">· ${num(t.reservedUnits)} reserved</span>` : ''}</div>
        </div>`
  }).join('')
  return `<div class="panel">
        <div class="panel-h"><span>Task budgets</span><span>one job, many calls, one ceiling</span></div>
        ${rows}
        <div class="panel-f">Sample rows, the same ones the demo console shows. Units are an integer you define.</div>
      </div>`
}

/** Three refusals from three agents, with the literal body each one got back. */
function refusalPanel(): string {
  const rows = demoConsole().decisions.filter((d) => d.blocked && d.taskRef).slice(0, 3).map((d) => {
    const body = JSON.parse(d.snapshot) as { message?: string }
    return `
        <div class="ref-row">
          <div class="ref-top">
            <span class="agent">${esc(d.agentId ?? '')}</span>
            <span class="ref">${esc(d.taskRef ?? '')}</span>
            <span class="chip held">blocked</span>
            <span class="ask">asked ${num(d.estimatedUnits ?? 0)}</span>
          </div>
          <div class="ref-msg">${esc(body.message ?? d.reason)}</div>
        </div>`
  }).join('')
  return `<div class="panel">
        <div class="panel-h"><span>Refusals</span><span>what the agent got back</span></div>
        ${rows}
        <div class="panel-f">Sample rows. Three agents, three tasks, one rule. "Asked" is units, not a dollar figure.</div>
      </div>`
}

function pricingStrip(): string {
  const rows = PLAN_ORDER.map((tier) => `
        <tr class="${tier === RECOMMENDED ? 'rec' : ''}">
          <th scope="row" class="tier">${tier}</th>
          <td class="calls">${num(PLAN_LIMITS[tier])}<span class="dimtxt"> calls / mo</span></td>
          <td class="amount">$${PLAN_PRICES[tier]}${tier === 'free' ? '' : '<span class="dimtxt"> / mo</span>'}</td>
        </tr>`).join('')
  return `<table class="tiers">
        <tbody>${rows}
        </tbody>
      </table>`
}

export async function homeRoute(app: FastifyInstance) {
  app.get('/', publicRoute(), async (request, reply) => {
    return reply.type('text/html').send(`${head({
      title: 'AgentBill · Hard budget ceilings for AI agents',
      description: 'Hard budget ceilings for AI agents. One ceiling per task. Every call that shares the task ref draws it down, whatever the provider, on units you define. Blocked before the first token. Free tier, API key in 30 seconds.',
      path: '/',
      og: {
        description: 'Block runaway agent spend before compute starts. One hard ceiling per task, consulted by every call in the job. Not a tracker. A guardrail.',
      },
      // Offers render from PLAN_ORDER / PLAN_PRICES / PLAN_LIMITS rather than
      // being typed here. A price written twice is a price that will disagree
      // with itself, and this one would disagree with the table 200px below it.
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        '@id': 'https://agentbill.dev/#software',
        name: 'AgentBill',
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Any',
        description: 'Hard per-task budget ceilings for AI agents. Block runaway spend before compute starts.',
        url: 'https://agentbill.dev',
        provider: { '@id': 'https://agentbill.dev/#organization' },
        offers: PLAN_ORDER.map((tier) => ({
          '@type': 'Offer',
          name: tier[0].toUpperCase() + tier.slice(1),
          price: String(PLAN_PRICES[tier]),
          priceCurrency: 'USD',
          description: `${PLAN_LIMITS[tier].toLocaleString('en-US')} preflight calls/month`,
        })),
      },
      // meta keywords has been ignored by every major engine since 2009. It was
      // 300 bytes on the most-fetched page of the site.
      extraHead: pixelSnippet(),
      scriptHashes: [PLAYGROUND_HASH, ...pixelHashes()],
      scriptOrigins: pixelExtra(),
      css: `${CHROME_CSS}${PLAYGROUND_CSS}${PANEL_CSS}
    /* Hallmark · genre: modern-minimal · macrostructure: Split Studio
     * theme: studied-DNA (source: url, structure only; paper, type and accent are theme.ts)
     * nav: N1b, unchanged · footer: Ft2, unchanged · enrichment: none, real product panels
     * pre-emit critique: P4 H4 E4 S5 R5 V4 */

    :root { --shell: 1080px;
            /* Page-local: the refusal band's ground and the code-comment ink.
               The console colours the panels use (--flow, --res, the chip
               grounds) live in theme.ts, one copy for every page. */
            --band-hi: #121212; --band-lo: #0c0c0c;
            --cmt: #79837c; }

    /* .wrap owns the inline axis; every block-axis rule below uses padding-block,
       so neither can wipe the other via the padding shorthand. */
    .wrap { max-width: var(--shell); margin: 0 auto; padding-inline: 24px; }

    /* Hero: a diptych. Type on the left, the whole integration on the right.
       The right half used to be empty at desktop; the code sample was too wide
       to sit there, so it got shorter, not the column wider. */
    .hero { padding-block: 64px 88px; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
            gap: var(--gap); align-items: start; }
    h1, h2 { overflow-wrap: anywhere; min-width: 0; }
    h1 { color: var(--white); max-width: 14ch; }
    .sub { font-size: var(--fs-lede); color: var(--muted); margin: 24px 0 32px; max-width: 46ch; }
    .hero-cta { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
    /* The hero pair runs one size up from the site's buttons. The ghost gives
       back the pixel its border adds so the two sit at one height. */
    .btn-lg { padding: 14px 26px; font-size: 16px; border-radius: 10px; }
    .btn-ghost.btn-lg { padding: 13px 25px; }
    .chip-link:active { transform: translateY(1px); }
    /* 1080 shell minus 48px of gutter minus the 56px gap, halved, is 488px per
       column. This line is 66 characters of mono at 12.5px, about 495px at a
       measured 0.6em advance: it overflowed by seven pixels, orphaned one word,
       and the break moved as the webfont loaded. Four spans and a flex wrap put
       the break where the content is instead. */
    .trust { margin-top: 18px; font-family: var(--mono); font-size: 12.5px; color: var(--dim);
             display: flex; flex-wrap: wrap; gap: 0 var(--s3); }
    .trust > span:not(:last-child)::after { content: "\\00b7"; margin-left: var(--s3); color: var(--border2); }
    .trust b { color: var(--green); font-weight: 500; }

    .code-head span { white-space: nowrap; }
    /* The sample used to end on ">>> run 42 of the retry loop:" and nothing
       after it, a dangling colon in the most looked-at element on the page.
       This is the answer, and it sits OUTSIDE the code element on purpose: the
       snippet harness executes every one of those against the SDKs, and an
       interpolation inside one marks the whole block dynamic and silently drops
       it from CI.
       Never write that tag's name in a comment in this file. The extractor
       scans for it and will run from the comment to the real closing tag,
       swallowing the sample into a phantom block. The suite still passes, one
       number lower. It happened once while writing this very comment. */
    .code-out { border-top: 1px solid var(--border); padding: 14px 20px;
                font-family: var(--mono); font-size: var(--fs-micro); line-height: 1.65;
                color: var(--red); background: var(--fail-bg); }
    .code-out b { font-weight: 700; }
    .code-block { background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
                  overflow: hidden; min-width: 0; }
    .code-head { display: flex; align-items: center; justify-content: space-between; gap: 16px;
                 padding: 11px 16px; border-bottom: 1px solid var(--border); background: var(--surface2);
                 font-family: var(--mono); font-size: 11.5px; letter-spacing: 1.1px; color: var(--dim); }
    .code-head b { color: var(--muted); font-weight: 500; }
    .code-body { padding: 22px 24px; overflow-x: auto; }
    .code-body pre { font-family: var(--mono); font-size: 13.5px; color: var(--code); line-height: 1.75; }
    .cmt { color: var(--cmt); }
    .out-dim { color: var(--dim); }

    /* The refusal band. Every other section on this page is a 1080px column of
       left-aligned type; this one is full bleed with its own ground, because it
       carries the one string the whole product exists to produce. Breaking the
       grid once is what stops the page reading as a template. */
    .refusal { padding-block: 0;
               background: linear-gradient(180deg, var(--band-hi), var(--band-lo) 72%);
               border-block: 1px solid var(--border2); box-shadow: var(--edge); }
    /* The note used to sit under the message at max-width 56ch with a
       border-top that stopped at 56ch, leaving about 570px of empty ground and
       a rule ending in the middle of nowhere. That truncated rule is what made
       the band read as an accident. A gloss beside a statement is a real
       typographic form; an orphan is not. */
    .refusal .wrap { padding-block: 60px 56px; display: grid;
                     grid-template-columns: minmax(0, 7fr) minmax(0, 5fr);
                     gap: var(--gap); align-items: start; }
    .refusal-head { min-width: 0; }
    .refusal-name, .refusal-msg { font-family: var(--mono); }
    /* One unbreakable 24-character token, so the floor of this clamp is not a
       taste call: at 0.585em of measured mono advance, 24 chars need 14.04em,
       and 320px minus the 48px gutter leaves 272px. 17px fits; 21px does not. */
    .refusal-name { font-size: clamp(17px, 5.6vw, 40px); font-weight: 700; color: var(--red);
                    letter-spacing: -0.015em; line-height: 1.1; }
    .refusal-msg { font-size: clamp(13px, 1.5vw, 17px); color: var(--muted); line-height: 1.6;
                   margin-top: 14px; max-width: 62ch; white-space: pre-wrap; }
    .refusal-note { font-size: var(--fs-small); color: var(--dim); margin-top: 6px; max-width: none;
                    padding-top: 22px; border-top: 1px solid var(--border); }
    .refusal-note b { color: var(--muted); font-weight: 600; }

    /* Diptychs. Text on one side, the product on the other, direction alternating.
       A gutter, no rule: the two halves are one argument, not two cards. Padding
       is uneven on purpose, generous above the first and tight between the rest,
       so the three read as a sequence rather than three stamped sections. */
    section { padding-block: 72px 0; }
    /* align-items: center is WHY the three of these disagreed: it centred text
       blocks of three, four and three lines against panels of three different
       heights, so each landed at a different offset. One rule, visibly the same
       rule three times: text top aligns with panel top. The nudge is optical,
       putting the h2's cap-height on the panel's label bar. */
    /* The row is CLOSED. All three fill about half their panel's height and left
       134px, 123px and 80px of empty ground under the short column, with no
       bottom edge, so each read as an unfinished column rather than a finished
       row. The void is not the defect: Stripe's pricing ships a row filling 39%
       with 115px under it and nobody notices, because a hairline closes it. Of
       fourteen reference captures, none leaves an open-bottomed unequal row on
       flat ground. This is the same device \`.tiers th, .tiers td\` already uses
       to close the plan rows ninety lines below, on this page.
       align-items: start and the recorded 0, 0, 0 offsets are untouched. */
    .dip { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); gap: var(--gap);
           align-items: start; padding-block: 40px 40px; }
    .dip-text { padding-top: 4px; }
    .dip + .dip { padding-block: 48px 40px; }
    .dip:last-of-type { border-bottom: 0; }
    .dip.flip .dip-text { order: 2; }
    /* A sub-claim is not a section. These three measured the identical 22px of
       ink as the section head that governs all three, so the page had no fourth
       rung and the hierarchy flattened everywhere below the hero. */
    .dip h3 { font-size: var(--fs-h3); color: var(--white); margin-bottom: 16px; max-width: 16ch; }
    .dip p { color: var(--muted); line-height: 1.7; max-width: 46ch; }
    .chip-link { display: inline-flex; align-items: center; gap: 0.5em; margin-top: 22px; min-height: 44px;
                 padding: 0 18px; border: 1px solid var(--border-strong); border-radius: 8px;
                 color: var(--text); text-decoration: none; font-weight: 600; font-size: 14.5px;
                 white-space: nowrap; transition: border-color .15s; }
    .chip-link:hover { border-color: var(--text); }
    .lead-h2 { color: var(--white); margin-bottom: 8px; max-width: 22ch; }
    .lead-p { color: var(--muted); max-width: 58ch; }

    /* Panel contents. The frame (.panel) comes from ui/panels.ts; what goes
       inside is this page's, in the console's own vocabulary. */
    .task { padding: 16px 18px; border-bottom: 1px solid var(--border-soft); }
    .task:last-of-type { border-bottom: 0; }
    .task-top, .ref-top { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
    .ref { font-family: var(--mono); font-size: 14px; color: var(--text); }
    .agent { font-family: var(--mono); font-size: 12px; color: var(--dim); }
    .task-nums { font-family: var(--mono); font-size: 13px; color: var(--muted); margin-top: 8px;
                 font-variant-numeric: tabular-nums; }
    .task-nums b { color: var(--text); font-weight: 500; }
    .dimtxt { color: var(--dim); }
    .track { height: 8px; background: var(--surface3); border-radius: 999px; overflow: hidden; display: flex; }
    .track i { display: block; height: 100%; }
    .track i.used { background: var(--flow); }
    .track i.used.near { background: var(--amber); }
    .track i.used.held { background: var(--green); }
    .track i.res { background: var(--res); }
    .chip { font-family: var(--mono); font-size: 11px; letter-spacing: .08em; text-transform: uppercase;
            padding: 3px 9px; border-radius: 4px; border: 1px solid; margin-left: auto; }
    .chip.held { color: var(--green); border-color: var(--held-line); background: var(--held-bg); }
    .chip.near { color: var(--amber); border-color: var(--near-line); background: var(--near-bg); }
    .chip.flow { color: var(--muted); border-color: var(--border2); background: var(--surface3); }
    .ask { font-family: var(--mono); font-size: 12px; color: var(--dim); font-variant-numeric: tabular-nums; }
    .ref-row { padding: 14px 18px; border-bottom: 1px solid var(--border-soft); }
    .ref-row:last-of-type { border-bottom: 0; }
    .ref-row .chip { margin-left: 0; }
    .ref-msg { font-family: var(--mono); font-size: 13px; color: var(--muted); line-height: 1.6; }

    /* Pricing: a spec sheet, not four cards. The recommended tier carries weight
       through type, and the numbers line up because they are a table. */
    .tiers { width: 100%; border-collapse: collapse; margin-top: 28px; font-variant-numeric: tabular-nums; }
    .tiers th { font-weight: inherit; text-align: left; }
    .tiers th, .tiers td { padding: 16px 0; border-bottom: 1px solid var(--border); color: var(--muted); font-size: 15.5px; }
    /* \`> *\`, not \`td\`: the first cell of each row is a th, so a td-only selector
       left the opening rule short of the FREE label. */
    .tiers tr:first-child > * { border-top: 1px solid var(--border); }
    .tiers .tier { font-family: var(--mono); text-transform: uppercase; letter-spacing: .12em; font-size: 12.5px;
                   color: var(--dim); width: 18%; }
    .tiers .amount { text-align: right; font-family: var(--display); font-size: 22px; font-weight: 700;
                     color: var(--text); letter-spacing: -0.02em; }
    .tiers tr.rec .tier { color: var(--green); }
    .tiers tr.rec .calls, .tiers tr.rec .amount { color: var(--white); }
    .price-links { margin-top: 26px; display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }

    .not-for ul { list-style: none; max-width: 60ch; }
    .not-for li { color: var(--muted); font-size: var(--fs-small); margin-bottom: 12px; padding-left: 22px; position: relative; }
    /* Was a typed lowercase "x" in mono, which at 13.5px is ambiguous with a
       glyph that failed to load. A short rule reads as negation, needs no icon
       set, and speaks the mark's own vocabulary: a line that stops something. */
    .not-for li::before { content: ""; position: absolute; left: 0; top: 0.62em;
                          width: 11px; height: 1.5px; background: var(--red); }

    .final { padding-block: 88px 24px; }
    .final h2 { color: var(--white); margin-bottom: 10px; }
    .final p { color: var(--muted); margin-bottom: 26px; max-width: 54ch; }

    @media (max-width: ${BP.lg}px) {
      .hero, .dip, .refusal .wrap { grid-template-columns: minmax(0, 1fr); gap: 32px; }
      .refusal .wrap { gap: 26px; }
      .refusal-note { border-top: 1px solid var(--border); padding-top: 22px; }
      .dip.flip .dip-text { order: 0; }
      .dip-text { padding-top: 0; }
      .hero { padding-block: 48px 64px; }
      .sub { max-width: 54ch; }
      section { padding-block: 56px 0; }
    }
    @media (max-width: ${BP.sm}px) {
      /* The subhead ran five lines and pushed the CTA to about 590px, below the
         fold on a small phone. The rule above WIDENS it to 54ch, which is the
         wrong direction once there is one column. Copy is untouched; this is
         type size and block padding only. */
      .sub { max-width: none; font-size: var(--fs-body); margin: 18px 0 26px; }
      .hero { padding-block: 32px 48px; }
      /* Two buttons at their content widths stack ragged, 176px above 162px.
         Full width and centred: a left-aligned label in a full-width button
         reads as broken. Sanctioned exception, recorded in design.md. */
      .hero-cta { display: grid; grid-template-columns: 1fr; gap: var(--s3); }
      .hero-cta > a { text-align: center; }
      .code-body { padding: 18px 16px; }
      /* No pre-wrap. It preserved the deep source indent on some lines and broke
         others flush to the gutter, so the panel captioned "the whole integration"
         showed code that read as a paste that failed. \`.code-body\` already scrolls
         (overflow-x: auto), which is what design.md specifies for a code frame. */
      .code-body pre { font-size: 12px; }
      /* The label bar is typographic, and at 390px both nowrap spans overflowed a
         space-between flex, so \`overflow: hidden\` guillotined the second one mid
         glyph. The meaning is carried by "python · the whole integration"; the
         package name repeats the \`from agentbill import\` line right beneath it. */
      .code-head span:last-child { display: none; }
      .tiers .amount { font-size: 19px; }
      .tiers td { font-size: 14.5px; }
      /* 18% of a 342px table is 61.6px; BUILDER at 12.5px mono with .12em tracking
         needs ~63px, and the neighbouring cell has no inline padding to absorb it,
         so one row of four rendered as "BUILDER50,000". */
      .tiers .tier { width: auto; padding-right: var(--s4); letter-spacing: .06em; }
    }
`,
    })}
<body>
${siteNav('/')}
<main>

  <header class="hero wrap">
    <div>
      <h1>Your loop won't stop itself.</h1>
      <p class="sub">One hard ceiling per task. Every call in that job checks it before it runs,
      whatever the provider, and you pass what each call is worth. Blocked before the call goes out,
      not after the bill shows up.</p>
      <div class="hero-cta">
        <a class="btn btn-lg" href="/register">Get your API key &rarr;</a>
        <a class="btn-ghost btn-lg" href="/app?demo=1">See a live console</a>
      </div>
      <p class="trust"><span><b>free tier</b></span><span>${num(PLAN_LIMITS.free)} preflight calls/mo</span><span>no card</span><span>key in 30 seconds</span></p>
    </div>

    <div class="code-block">
      <div class="code-head"><span>python <b>&middot;</b> the whole integration</span><span>agentbill-sdk</span></div>
      <div class="code-body">
        <pre>from agentbill import AgentBillClient

client = AgentBillClient(
    api_key="agb_your_key")

<span class="cmt"># 1 unit = 1 cent here. job-142 dies</span>
<span class="cmt"># at 500 units, across every call</span>
<span class="cmt"># that passes the same task_ref.</span>
client.preflight(agent_id="researcher",
                 task_ref="job-142",
                 task_ceiling=500,
                 estimated_units=12)

<span class="out-dim">&gt;&gt;&gt; run 42 of the retry loop:</span></pre>
      </div>
      <div class="code-out"><b>${REFUSAL.name}:</b> ${REFUSAL.message}</div>
    </div>
  </header>

  <section class="refusal">
    <div class="wrap">
      <div class="refusal-head">
        <div class="refusal-name">${REFUSAL.name}</div>
        <div class="refusal-msg">${REFUSAL.message}</div>
      </div>
      <p class="refusal-note">That is the exception your code catches, raised the moment the ceiling
      is checked and before the call goes out, not a log line written after the fact. <b>The call
      never ran.</b> The response body it was built from is below, and you can produce it yourself.</p>
    </div>
  </section>

${playgroundSection()}

  <section class="wrap">
    <h2 class="lead-h2">Monthly caps don't stop tonight's loop.</h2>
    <p class="lead-p">Provider spend caps stop at monthly org totals. These three things stop the run
    that is burning money right now.</p>

    <div class="dip row-close">
      <div class="dip-text">
        <h3>Per-task ceilings</h3>
        <p>One job, many calls, one budget. "This task dies at 500 units," and you decide what a
        unit is worth. The ceiling is consulted before each call, and the total across the whole
        job cannot pass it.</p>
        <a class="chip-link" href="/app?demo=1#tasks">Watch budgets burn down &rarr;</a>
      </div>
      ${taskPanel()}
    </div>

    <div class="dip flip row-close">
      <div class="dip-text">
        <h3>One ceiling, any provider</h3>
        <p>OpenAI, Anthropic, your own GPU, a tool call. Whatever it is, if it passes the same
        task_ref it draws down the same ceiling, and you decide what it costs in units. We never
        look at your provider bill. Per job, with per-agent attribution.</p>
        <a class="chip-link" href="/app?demo=1#refusals">See the refusals &rarr;</a>
      </div>
      ${refusalPanel()}
    </div>

    <div class="dip row-close">
      <div class="dip-text">
        <h3>No proxy in your request path</h3>
        <p>An SDK call, not a gateway. Nothing to route your traffic through, nothing to deploy,
        nothing to compromise. The ceiling is something your tools consult, and the reservation
        it takes is atomic.</p>
        <a class="chip-link" href="/docs#reservation">How the reservation works &rarr;</a>
      </div>
      ${requestPanel()}
    </div>
  </section>

  <section class="wrap">
    <h2 class="lead-h2">Free to start. Cheap enough to leave on.</h2>
    ${pricingStrip()}
    <div class="price-links">
      <a class="btn" href="/register">Start free</a>
      <a class="btn-ghost" href="/pricing">Full pricing</a>
    </div>
  </section>

  <section class="wrap not-for">
    <h2 class="lead-h2">What AgentBill does NOT do</h2>
    <ul>
      <li>Undo a multi-step workflow. We stop calls, we don't unwind them.</li>
      <li>Replace your payment processor. We sit in front of it.</li>
      <li>Give your ops team a no-code dashboard. This is an SDK.</li>
    </ul>
  </section>

  <div class="final wrap">
    <h2>Give one job a ceiling.</h2>
    <p>Free tier. No card. If this page took you longer to read than the integration takes, we did our job.</p>
    <a class="btn btn-lg" href="/register">Get your API key &rarr;</a>
  </div>

</main>
${siteFooter()}
${PLAYGROUND_JS}
</body>
</html>
    `)
  })
}
