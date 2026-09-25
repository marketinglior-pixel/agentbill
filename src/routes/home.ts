import { HEADLINE, INSTALL_PY, ORIGIN } from '../ui/site.js'
import { FastifyInstance } from 'fastify'
import { head, BP } from '../ui/theme.js'
import { siteNav, siteFooter, CHROME_CSS, KEY_CTA } from '../ui/chrome.js'
import { PLAYGROUND_CSS, PLAYGROUND_JS, PLAYGROUND_HASH, playgroundSection, REFUSAL, RUN } from '../ui/playground.js'
import { ESTIMATOR_CSS, ESTIMATOR_JS, ESTIMATOR_HASH, estimatorSection } from '../ui/estimator.js'
import { pixelSnippet } from '../lib/pixel.js'
import { PLAN_LIMITS } from '../integrations/polar.js'
import { RESERVATION_TTL_MINUTES } from '../lib/reservations.js'
import { COPY_CSS, COPY_JS, COPY_HASH, copyPill } from '../ui/copy.js'
import { TABS_CSS, TABS_JS, TABS_HASH, langTabs } from '../ui/tabs.js'
import { TIERS_CSS, tierCards, SAME_FEATURES } from '../ui/tiers.js'
import { publicRoute } from '../middleware/auth.js'
import { softwareLd } from '../ui/ld.js'
import { pixelHashes, pixelExtra } from '../lib/pixel.js'

// The homepage, rebuilt 2026-09-23 from the approved Figma file (T1 and T2 of
// the 2026-09-23 value pack; Figma uMcr4L26RQYChYmpykVGRQ, Lior's FIGMA GO the
// same evening). Craft reference: x.ai/bot, read for the white canvas, the
// centred hero with two pill actions, the large rounded product frame under it,
// the split statement panel, the card grid and the two-column FAQ; nothing of
// its product, palette or claims. The earlier references stay recorded in
// design.md: pressplaced.com on 2026-09-12 (air, one demo, one action) and the
// paper identity of 2026-09-16, which is still in theme.ts and is what a revert
// of this file alone brings back.
//
// Order: hero (pill, h1, the locked sub, two actions, the agent's-log frame),
// the statement, the estimator, the demo, how it works, the ICP chips, the
// evidence band, pricing, questions, the close. What left, and why it is not
// coming back by accident: the film and Fig. 1 (the frame and the statement
// carry the same numbers in text, from the same walk of PLAN), the request-path
// row (its two samples moved under the demo's wire, where the harness still
// executes them), the hero's text link to the demo (retired on Lior's decision
// 6; the second action is now a pill to #estimate), and the Gemini evidence
// line (the ticket asked for one strong public cite).
//
// Numbers are rendered, never typed: the frame, the statement's meter and the
// playground all read RUN / REFUSAL from ui/playground.ts, the tiers read
// polar.ts, and the estimator renders its example through the same estimate()
// its script runs. Where something is sample data it says so inside its own
// frame, so a screenshot carries the label with it. Nothing here is a logo
// wall, a count or a testimonial.

const num = (n: number) => n.toLocaleString('en-US')

/**
 * The month meter in the statement, as a share of a window. A percentage and
 * not a count on purpose: this product has no month meter to read, and a
 * number of units or dollars on that row would be a claim about a meter we do
 * not run. The figure says "sample" in its own frame.
 */
const MONTH_SAMPLE_PCT = 4

/**
 * The fold's product frame: the agent's own log of job-142, from RUN.
 *
 * Titled as the agent's log and not as the console on purpose: preflight takes
 * no call name, so the step names are what the agent knows about itself, and a
 * reader who signs up looking for this view in /app would not find it. The
 * earlier approved steps fold into one row so the refused call sits inside the
 * first screen at 1440x900. The right-hand plate is the refusal on the wire
 * and the exception it becomes in your process.
 */
function logFrame(): string {
  const a = RUN.approved
  const early = a.slice(0, -2)
  const last2 = a.slice(-2)
  const row = (name: string, units: string, total: string, answer: string, cls = '') =>
    `<div class="lg-row${cls}"><span class="lg-c">${name}</span><span class="lg-u">${units}</span><span class="lg-t">${total}</span><span class="lg-a">${answer}</span></div>`
  const ok = '<span class="chip-ok">approved</span>'
  const fill = Math.round((RUN.used / RUN.ceiling) * 1000) / 10
  return `<figure class="frame" aria-label="Sample: an agent's log for ${RUN.taskRef}, ${num(RUN.used)} of ${num(RUN.ceiling)} units used, the next call answered approved false">
      <div class="fr-win">
        <div class="fr-bar">
          <span class="fr-title"><span class="tag tag-id">${RUN.taskRef}</span><span class="fr-t">your agent&rsquo;s log &middot; ceiling ${num(RUN.ceiling)} units</span></span>
          <span class="tag">sample</span>
        </div>
        <div class="fr-body">
          <div class="fr-log">
            <div class="lg-row lg-head"><span class="lg-c">call</span><span class="lg-u">units</span><span class="lg-t">total</span><span class="lg-a">answer</span></div>
            ${row(`${early.length} earlier calls`, `+${num(early[early.length - 1].cum)}`, num(early[early.length - 1].cum), ok, ' lg-dim')}
            ${last2.map((s) => row(s.name, `+${num(s.units)}`, num(s.cum), ok)).join('\n            ')}
            ${row(RUN.refused.name, `asks ${num(RUN.refused.asked)}<span class="ph"> &middot; ${num(RUN.remaining)} left</span>`, `${num(RUN.used + RUN.refused.asked)} &gt; ${num(RUN.ceiling)}`, '<span class="chip-no">approved: false</span>', ' lg-no')}
            <div class="fr-decide">
              <span class="fr-k">Your code decides what happens next</span>
              <div class="fr-picks"><span>Return what you have</span><span>Skip this step</span><span>Replan</span></div>
            </div>
          </div>
          <div class="fr-side">
            <span class="fr-k">this job</span>
            <div class="fr-stat"><b>${num(RUN.used)}</b> <span>/ ${num(RUN.ceiling)} units</span></div>
            <div class="fr-meter" aria-hidden="true"><i style="width:${fill}%"></i><u></u></div>
            <p class="fr-next">next call asks ${num(RUN.refused.asked)}, ${num(RUN.remaining)} left</p>
            <div class="fr-plate">
              <span class="pl-dim">POST /preflight &nbsp;200</span>
              <span class="pl-no">"approved": false</span>
              <span>"reason": "task_ceiling_exceeded"</span>
              <span>${REFUSAL.name}<br />raised in your process</span>
            </div>
          </div>
        </div>
      </div>
    </figure>`
}

/** The statement's figure: the same account in the same minute, a month meter with room beside this job at its ceiling. */
function statementFigure(): string {
  return `<figure class="st-fig">
        <figcaption class="st-top"><span class="fr-k">same account, <span class="nb">same minute</span></span><span class="tag">sample</span></figcaption>
        <div class="st-m">
          <div class="st-l"><span class="st-n">Org &middot; month cap</span><span class="st-v">${MONTH_SAMPLE_PCT}% used</span></div>
          <div class="st-bar"><i style="width:${MONTH_SAMPLE_PCT}%"></i></div>
          <span class="st-s">under the cap</span>
        </div>
        <div class="st-m st-lit">
          <div class="st-l"><span class="st-n">${RUN.taskRef}</span><span class="st-v">${num(RUN.used)} / ${num(RUN.ceiling)}</span></div>
          <div class="st-bar"><i style="width:${Math.round((RUN.used / RUN.ceiling) * 1000) / 10}%"></i><u></u></div>
          <span class="st-s"><span class="st-ceil">ceiling ${num(RUN.ceiling)} &middot; </span>next call asks ${num(RUN.refused.asked)} &middot; refused</span>
        </div>
      </figure>`
}

/**
 * Your code, under the demo's wire. Two literal samples, Python and Node, on
 * the language tabs. They live in this file and not in ui/playground.ts
 * because scripts/snippets reads routes/*.ts only: here they are harvested,
 * typechecked and executed against the SDKs in CI, which is the only reason a
 * sample on this page can be trusted to run. Both handle the two ways
 * preflight says no: a ceiling refusal raises, and a refusal from our own
 * quota comes back as approved false, on purpose. No interpolation inside
 * either block: the harvester would mark it dynamic and drop it from CI.
 */
function codeFrame(): string {
  return `        <div class="code-card">
          <div class="code-head">${langTabs([['python', 'Python'], ['node', 'Node']], 'python', 'Language of the sample')}<span>your code</span></div>
          <div class="code-body">
            <pre id="code-python" role="tabpanel" aria-labelledby="tab-python" data-lang="python">import os
from agentbill import (
    AgentBillClient, TaskCeilingExceededError)

client = AgentBillClient(
    api_key=os.environ["AGENTBILL_API_KEY"])

def critique(draft):
    try:
        r = client.preflight(
            agent_id="researcher",
            task_ref="job-142",
            estimated_units=180)
    except TaskCeilingExceededError:
        return draft  <span class="cmt"># your code decides</span>
    <span class="cmt"># our quota ran out, not your ceiling</span>
    if not r.approved:
        return draft
    <span class="cmt"># approved: call your provider, then record</span></pre>
            <pre id="code-node" role="tabpanel" aria-labelledby="tab-node" data-lang="node" hidden>import { preflight, TaskCeilingExceededError }
  from 'agentbill'

<span class="cmt">// Reads AGENTBILL_API_KEY from env.</span>
async function critique(draft) {
  try {
    const r = await preflight({
      agentId: 'researcher',
      taskRef: 'job-142',
      estimatedUnits: 180 })
    <span class="cmt">// our quota ran out, not your ceiling</span>
    if (!r.approved) return draft
  } catch (e) {
    <span class="cmt">// your code decides</span>
    if (e instanceof TaskCeilingExceededError) return draft
    throw e
  }
  <span class="cmt">// approved: call your provider, then record</span>
}</pre>
          </div>
        </div>`
}

/** The seven collapsed answers. New copy for this page, checked against the code; faq.ts carries two lines this page must not repeat. */
const QUESTIONS: ReadonlyArray<readonly [q: string, a: string]> = [
  ['What is a unit?',
    'An integer you define and pass. AgentBill counts units and compares them to a ceiling; it never converts them to money and never reads your provider bill. If one unit is one cent for you, a ceiling of 500 is five dollars. If one unit is one document, a ceiling of 500 is five hundred documents. The meaning is yours and the arithmetic is ours.'],
  ['Does AgentBill see my provider bill?',
    'No. It never has access to your OpenAI, Anthropic or cloud account, and it does not read, estimate or reconcile against your invoice. It knows what your code told it a call was worth. That is a deliberate limit and it is why a unit is whatever you say it is.'],
  ['How is a job ceiling different from a monthly spend cap?',
    'A monthly cap meters an organization or a project over the month, and some platforms also cap one session inside their own runtime. A job ceiling is a name your code passes: a call is checked against it only if it asks preflight with that name, from any process and for any provider, and the number has no reset.'],
  ['Does AgentBill sit in my request path?',
    'No. It is an endpoint your code calls before it calls a provider, not a gateway your traffic routes through. Nothing to point your base URL at and no third party holding your provider keys. If AgentBill is unreachable, preflight raises in your process after its timeout, and your code decides whether to call the provider anyway.'],
  ['What happens if a job crashes with units still reserved?',
    `Preflight reserves the units it approves, so two calls racing cannot both be told there is room for one. A reservation that is never settled expires after ${RESERVATION_TTL_MINUTES} minutes and is swept back to the budget every five minutes. Nothing is held forever because a process crashed, and nothing is released before its ${RESERVATION_TTL_MINUTES} minutes are up, however slow the process.`],
  [`What happens when I reach the free tier's ${num(PLAN_LIMITS.free)} calls?`,
    'Preflight starts answering approved: false with reason free_tier_exceeded (plan_limit_exceeded on a paid plan) and an upgrade_url. The SDK returns that answer instead of raising, so check result.approved. A refused call reserves nothing and is not counted.'],
  ['Can I show the ceiling in dollars?',
    'Yes, on a job opened in dollars: set $5 for the job in the console or with ceiling_usd. The figure is an estimate at public list price of the tokens each call reports, from a dated price table, not your invoice, and a call with no list price is charged its reservation, never $0. In units you decide what a unit is worth, the way the estimator above does with your cost per call.'],
]

export async function homeRoute(app: FastifyInstance) {
  app.get('/', publicRoute(), async (request, reply) => {
    return reply.type('text/html').send(`${head({
      title: `AgentBill · ${HEADLINE}`,
      description: `${HEADLINE}. One call before the work asks whether this job has units left, and preflight is that call. Your code decides what happens next. Free tier, no card.`,
      path: '/',
      // Canvas is head()'s default for every page since 2026-09-23 (Lior's
      // instruction to carry this page's design to every screen, the console
      // included). Named here anyway: this page is the system's reference.
      theme: 'canvas',
      og: {
        description: `${HEADLINE}. One call before the work asks whether this job has units left, and preflight is that call. Your code decides what happens next.`,
      },
      // The product entity lives in ui/ld.ts and is emitted identically here
      // and on /pricing under one @id.
      jsonLd: softwareLd(),
      mainEntity: `${ORIGIN}/#software`,
      extraHead: pixelSnippet(),
      scriptHashes: [PLAYGROUND_HASH, ESTIMATOR_HASH, COPY_HASH, TABS_HASH, ...pixelHashes()],
      scriptOrigins: pixelExtra(),
      css: `${CHROME_CSS}${PLAYGROUND_CSS}${ESTIMATOR_CSS}${COPY_CSS}${TABS_CSS}${TIERS_CSS}
    /* Hallmark · genre: modern-minimal · macrostructure: centred canvas
     * theme: canvas (theme.ts) · design-system: design.md · designed-as-app
     * nav: N1b, unchanged · footer: Ft2, unchanged · enrichment: none, real product panels
     * order: hero (pill, h1, locked sub, two actions, the agent's-log frame), statement, estimate,
     *        demo, how it works, ICP chips, evidence band, pricing, questions, the close
     * craft reference 2026-09-23: x.ai/bot, for the canvas, the centred hero, pill actions and
     *        soft-cornered frames; nothing of its product, palette or claims */

    /* Page-local values. --band-hi and --band-lo are read by nothing on this
       page any more but stay defined so a shared partial never meets an
       undefined property. --cmt is a comment inside a code sample. */
    :root { --shell: 1072px; --band-hi: var(--surface2); --band-lo: var(--surface2); --cmt: var(--dim); }

    .wrap { max-width: var(--shell); margin: 0 auto; padding-inline: var(--gutter); }
    h1, h2, h3 { overflow-wrap: anywhere; min-width: 0; }
    /* Geist at 500 is every heading's weight now, from BASE (--fw-h1..3 in
       TOKENS_CANVAS); the tighter set of this page's two display rungs stays here. */
    h1 { color: var(--white); letter-spacing: -0.03em; line-height: 1.02; }
    h2 { color: var(--white); letter-spacing: -0.02em; line-height: 1.1; }

    /* .eyebrow, .mono-in, the chips, the tags, the pill and every button live
       in src/ui/kit.ts since 2026-09-23 (through CHROME_CSS), lifted from here
       with their values, so the rest of the site renders the same objects. */
    .lead { color: var(--muted); font-size: var(--fs-lede); line-height: 1.55; max-width: 62ch; margin-top: var(--s3); }
    .sec { padding-block: 128px 0; }
    .sec-head { text-align: center; }
    .sec-head .lead, .sec-head .pg-lede { margin-inline: auto; }

    /* The plan buttons on this page are 42 tall, 10px of padding over a 1px
       border, as they shipped with the redesign; the kit's .btn-ghost is 40,
       the Figma M. Held here so this page renders as approved; the system
       value is the kit's. */
    .pricing .tier-card .btn-ghost { padding: 10px 20px; }

    /* Hero: centred, the reference's order. The block padding is the page's
       largest on purpose; the frame under the actions is the one picture. */
    .hero { padding-block: 56px 0; text-align: center; display: flex; flex-direction: column; align-items: center; }
    .hero h1 { margin-top: 24px; max-width: 880px; }
    .sub { font-size: var(--fs-lede); color: var(--muted); margin-top: var(--s5); max-width: 42rem; line-height: 1.55;
           text-wrap: pretty; }
    /* A phrase the line break must not cut. The sub is a locked sentence, so
       the words cannot move; only where the line ends can. The two spans are
       held by a browser gate in scripts/shots.mjs (PR #70). A span and not an
       entity, because the gate that holds the sentence byte for byte strips
       tags and would read the entity as literal characters. */
    .nb { white-space: nowrap; }
    .hero-cta { display: flex; align-items: center; justify-content: center; gap: 12px; flex-wrap: wrap; margin-top: 36px; }
    .trust { margin-top: 16px; font-size: var(--fs-small); color: var(--dim); }
    /* The MCP entry, 2026-09-25: one line under the three steps, where a reader
       who works in Claude or Cursor asks "and without code?". Not in the hero,
       which holds two actions and no third (the [fold] gate). */
    .how-mcp { margin-top: var(--s6); text-align: center; color: var(--muted); font-size: var(--fs-body); }
    .how-mcp a { color: var(--text); font-weight: 500; text-underline-offset: 3px; text-decoration-color: var(--border-strong); }
    .how-mcp a:hover { text-decoration-color: currentColor; }

    /* The frame: the agent's log, on the reference's large soft-cornered panel. */
    .frame { margin: 36px 0 0; width: 100%; background: var(--surface2); border-radius: var(--r-card); padding: 24px; text-align: left; }
    .fr-win { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-inner); overflow: hidden; }
    .fr-bar { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 20px;
              border-bottom: 1px solid var(--border); }
    .fr-title { display: flex; align-items: center; gap: 10px; font-size: var(--fs-small); color: var(--muted); min-width: 0; }
    .fr-body { display: grid; grid-template-columns: minmax(0, 1fr) 360px; }
    .fr-log { padding: 12px 20px 20px; min-width: 0; }
    .lg-row { display: grid; grid-template-columns: minmax(0, 1fr) 96px 84px 150px; gap: 12px; align-items: center;
              padding: 9px 10px; border-radius: 10px; font-family: var(--mono); font-size: var(--fs-small); color: var(--text); }
    .lg-row .lg-u, .lg-row .lg-t { text-align: right; font-variant-numeric: tabular-nums; }
    .lg-row .lg-u { color: var(--muted); }
    .lg-head { font-size: var(--fs-chip); letter-spacing: .08em; text-transform: uppercase; color: var(--dim); padding-block: 6px; }
    .lg-head .lg-u { color: var(--dim); }
    .lg-dim .lg-c { color: var(--muted); }
    .lg-no { background: var(--fail-bg); }
    .lg-no .lg-c, .lg-no .lg-u, .lg-no .lg-t { color: var(--signal); }
    .fr-decide { margin-top: 16px; padding: 0 10px; display: grid; gap: 10px; }
    .fr-k { font-family: var(--mono); font-size: var(--fs-chip); letter-spacing: .08em; text-transform: uppercase; color: var(--dim); }
    .fr-picks { display: flex; flex-wrap: wrap; gap: 8px; }
    .fr-picks span { font-size: var(--fs-small); padding: 6px 12px; border-radius: var(--r-pill);
                     border: 1px solid var(--border2); background: var(--surface); }
    .fr-side { background: var(--surface2); border-left: 1px solid var(--border); padding: 24px; display: grid;
               gap: 14px; align-content: start; }
    .fr-stat b { font-family: var(--display); font-size: var(--fs-stat); font-weight: 500; letter-spacing: -0.02em;
                 font-variant-numeric: tabular-nums; }
    .fr-stat span { color: var(--muted); }
    .fr-meter { position: relative; height: 10px; background: var(--surface3); border-radius: var(--r-pill); }
    .fr-meter i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--text); border-radius: var(--r-pill); }
    .fr-meter u { position: absolute; right: -1px; top: -8px; width: 2px; height: 26px; background: var(--signal); }
    .fr-next { font-size: var(--fs-small); color: var(--signal); }
    .fr-plate { background: var(--plate); border-radius: 12px; padding: 14px 16px; display: grid; gap: 6px;
                font-family: var(--mono); font-size: var(--fs-micro); color: var(--plate-ink); line-height: 1.5; }
    .pl-dim { color: var(--plate-dim); }
    .pl-no { color: var(--plate-signal); font-size: var(--fs-small); }

    /* Statement: copy left, the figure right, on the panel ground. */
    .st { background: var(--surface2); border-radius: var(--r-card); padding: 48px 32px 48px 48px;
          display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 452px); gap: 40px; align-items: center; }
    .st-copy { display: grid; gap: 20px; }
    .st-copy p { color: var(--muted); line-height: 1.6; }
    .st-copy .st-line { color: var(--text); font-weight: 500; }
    .st-fig { margin: 0; background: var(--surface); border: 1px solid var(--border); border-radius: 20px; padding: 28px;
              display: grid; gap: 26px; }
    .st-top { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
    .st-m { display: grid; gap: 10px; }
    .st-l { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
    .st-n { font-family: var(--mono); font-size: var(--fs-small); }
    .st-v { font-size: var(--fs-h3); font-weight: 500; font-variant-numeric: tabular-nums; }
    .st-bar { position: relative; height: 36px; background: var(--surface2); border-radius: 12px; }
    .st-bar i { position: absolute; left: 0; top: 0; bottom: 0; min-width: 14px; background: var(--border2);
                border-radius: 12px 2px 2px 12px; }
    .st-lit .st-bar i { background: var(--text); border-radius: 12px; }
    .st-bar u { position: absolute; right: -2px; top: -4px; bottom: -4px; width: 3px; background: var(--signal); }
    .st-s { font-size: var(--fs-small); color: var(--dim); }
    .st-lit .st-v, .st-lit .st-s { color: var(--signal); }

    /* How it works. */
    .how h2 { text-align: center; }
    .steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin-top: 40px; }
    .step { background: var(--surface2); border-radius: var(--r-card); padding: 24px; display: grid; gap: 20px; align-content: start; }
    .step-ill { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-inner); padding: 16px;
                min-height: 142px; display: grid; gap: 8px; align-content: start; font-family: var(--mono);
                font-size: var(--fs-micro); line-height: 1.6; white-space: pre; overflow-x: auto; }
    .step-ill .res { display: flex; gap: 8px; align-items: center; white-space: normal; color: var(--muted); }
    .step-ill .fld { display: block; border: 1px solid var(--border-strong); border-radius: 10px; padding: 8px 12px;
                     font-size: var(--fs-small); white-space: normal; }
    .step-ill .lbl { font-family: var(--sans); font-size: var(--fs-small); color: var(--muted); white-space: normal; }
    .step h3 { display: flex; align-items: center; gap: 10px; font-size: var(--fs-h3); }
    .step h3 i { font-style: normal; display: inline-grid; place-items: center; width: 24px; height: 24px; border-radius: 50%;
                 background: var(--text); color: var(--green-ink); font-size: var(--fs-small); font-weight: 500; flex: none; }
    .step p { color: var(--muted); line-height: 1.6; }

    /* ICP chips. */
    .icp { text-align: center; }
    .icp h3 { font-size: var(--fs-h3); }
    .chips { list-style: none; display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; margin-top: 20px; }
    .chips li { padding: 10px 18px; border-radius: var(--r-pill); background: var(--surface2); border: 1px solid var(--border); }
    .icp-note { margin-top: 16px; font-size: var(--fs-small); color: var(--dim); }

    /* The evidence band: one public incident, a sentence, its attribution and
       the link, never a screenshot. The markup shape is held by the [band]
       gates: the exact section class, one div per line, the link href first. */
    .band { padding-block: 128px 0; }
    .evid { border: 1px solid var(--border); border-radius: var(--r-card); padding: 40px 48px; display: grid; gap: 14px; }
    .evid-s { font-size: var(--fs-h3); line-height: 1.45; color: var(--text); letter-spacing: -0.01em; }
    .evid-a { font-size: var(--fs-small); color: var(--dim); }
    .evid a { font-family: var(--mono); font-size: var(--fs-small); color: var(--muted); text-decoration: underline;
              text-underline-offset: 3px; overflow-wrap: anywhere; }
    .evid a:hover { color: var(--text); }

    /* Pricing: the four cards /pricing renders, from ui/tiers.ts, on this
       page's ground. Free keeps the one dark button; Team is marked by its
       border and chip and never by a second fill (decision 7). */
    /* The cards' canvas look is TIERS_CSS's own since 2026-09-23.
       Plan buttons hug their label, as the frames draw them; /pricing keeps
       its own full-width ones because this rule is scoped to this page. */
    .pricing .tier-card .btn, .pricing .tier-card .btn-ghost { display: inline-flex; width: auto; align-self: flex-start; }
    .price-links { margin-top: var(--s5); display: flex; justify-content: center; }
    .more-link { font-size: var(--fs-small); font-weight: 500; color: var(--text); text-decoration: none; }
    .more-link:hover { text-decoration: underline; }

    /* Questions: the two-column accordion. Native details, no script. The
       first item is the not-list, open, and it is the [home] gate's slice. */
    .faq-grid { display: grid; grid-template-columns: minmax(0, 320px) minmax(0, 1fr); gap: 32px; align-items: start; }
    .faq-head { display: grid; gap: 12px; }
    .faq-head p { color: var(--muted); }
    .faq-head a { font-size: var(--fs-small); font-weight: 500; color: var(--text); }
    .faq-list { border-bottom: 1px solid var(--border); }
    .faq-list details { border-top: 1px solid var(--border); padding: 20px 0; }
    .faq-list summary { list-style: none; cursor: pointer; display: flex; justify-content: space-between; gap: 16px;
                        font-weight: 500; color: var(--text); }
    .faq-list summary::-webkit-details-marker { display: none; }
    .faq-list summary::after { content: "+"; color: var(--muted); font-size: var(--fs-h3); line-height: 1; }
    .faq-list details[open] summary::after { content: "\\2212"; }
    .faq-list details p { color: var(--muted); line-height: 1.6; margin-top: 12px; }
    .nots { list-style: none; display: grid; gap: 14px; margin-top: 14px; }
    .nots li { color: var(--muted); line-height: 1.6; }
    .nots li b { color: var(--text); font-weight: 500; }

    /* The close. On a phone the sticky bar is the primary, so .end stands the
       button down (chrome.ts). */
    .final { padding-block: 128px 0; }
    .final-band { background: var(--surface2); border-radius: var(--r-card); padding: 80px 48px; text-align: center;
                  display: grid; justify-items: center; gap: 14px; }
    .final-band p { color: var(--muted); font-size: var(--fs-lede); }
    .final-row { display: flex; align-items: center; justify-content: center; gap: 12px; flex-wrap: wrap; margin-top: 16px; }
    /* Body copy at the text styles' own line heights (16/24, 14/20). */
    .st-copy p, .step p, .faq-list details p, .nots li { line-height: 1.5; }
    .trust, .icp-note, .evid-a { line-height: 20px; }
    #estimate .sec-head .lead { max-width: 48rem; }
    .pg-lede { max-width: 51rem; }
    .ph { display: none; }

    /* Your code, under the demo's wire. */
    .code-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-inner); min-width: 0; }
    .code-head { display: flex; align-items: center; justify-content: space-between; gap: var(--s4); padding: 0 16px;
                 min-height: 44px; border-bottom: 1px solid var(--border); font-family: var(--mono);
                 font-size: var(--fs-label); color: var(--dim); }
    .code-head > span { white-space: nowrap; }
    .code-body { padding: 14px 18px; overflow-x: auto; }
    .code-body pre { font-family: var(--mono); font-size: var(--fs-micro); line-height: 1.7; color: var(--text); }
    .cmt { color: var(--cmt); }
    #playground { scroll-margin-top: calc(var(--banner-height) + var(--s4)); }

    @media (max-width: ${BP.lg}px) {
      .sec, .band, .final { padding-block: 88px 0; }
      .fr-body { grid-template-columns: minmax(0, 1fr); }
      .fr-side { border-left: none; border-top: 1px solid var(--border); }
      .st { grid-template-columns: minmax(0, 1fr); padding: 32px; }
      .steps { grid-template-columns: minmax(0, 1fr); }
      .faq-grid { grid-template-columns: minmax(0, 1fr); }
    }
    @media (max-width: ${BP.md}px) {
      /* The 16px phone gutter is every page's now (ROLES in theme.ts).
         The phone frames (Figma 5:2): heads and chips set left, the hero alone centred. */
      .sec-head, .how h2, .icp { text-align: left; }
      .sec-head .lead, .pg-lede { margin-inline: 0; }
      .chips { justify-content: flex-start; gap: 8px; }
      .chips li { padding: 9px 15px; font-size: var(--fs-small); }
      .pill { padding: 7px 13px; gap: .28em; }
      .pill-tag { font: inherit; letter-spacing: normal; text-transform: none; background: none; border: 0; padding: 0; }
      /* The hero frame as the phone frame draws it (5:22): the meter first, the
         last two approved calls and the refused one, and the line under them. */
      .fr-body { display: flex; flex-direction: column; }
      .fr-side { order: -1; background: none; border: 0; padding: 14px 14px 0; gap: 8px; }
      .fr-side > .fr-k, .fr-next, .fr-plate { display: none; }
      .lg-head, .lg-dim, .fr-picks { display: none; }
      .fr-decide { margin-top: 10px; }
      .fr-decide .fr-k { font-family: var(--sans); font-size: var(--fs-small); letter-spacing: 0; text-transform: none; color: var(--text); }
      .lg-row.lg-no { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; column-gap: 8px; row-gap: 4px; padding-block: 8px; }
      .lg-row.lg-no .lg-c { white-space: nowrap; }
      .lg-row.lg-no .lg-t { display: none; }
      .lg-row.lg-no .lg-u { order: 3; flex-basis: 100%; text-align: left; }
      .ph { display: inline; }
      .st-ceil { display: none; }
      .st-v { font-size: var(--fs-body); white-space: nowrap; }
      .st-n { white-space: nowrap; }
      /* The phone frames keep the samples and the illustrations off the phone;
         both stay in the served HTML, so the harvester and the gates still read them. */
      .code-card, .step-ill { display: none; }
      .sec, .band, .final { padding-block: 72px 0; }
      .hero { padding-block: 24px 0; }
      .hero h1 { margin-top: 16px; }
      .sub { font-size: var(--fs-body); margin-top: 14px; }
      .hero-cta { margin-top: 20px; }
      .trust { margin-top: 10px; }
      .frame { margin-top: 20px; }
      .fr-title .fr-t { display: none; }
      .frame { padding: 12px; border-radius: 20px; }
      .fr-bar { padding: 10px 12px; }
      .fr-log { padding: 8px 8px 14px; }
      .lg-row { grid-template-columns: minmax(0, 1fr) 72px 64px; gap: 8px; padding-inline: 6px; }
      .lg-row .lg-a { grid-column: 1 / -1; }
      /* On a phone only the refusal keeps its chip; an approved row is already
         said by its running total. */
      .lg-row:not(.lg-no) .lg-a { display: none; }
      .fr-side { padding: 16px; }
      .st { padding: 24px 20px; }
      .st-fig { padding: 18px; }
      .evid { padding: 24px 20px; }
      .final-band { padding: 48px 20px; }
    }
    @media (max-width: ${BP.sm}px) {
      .fr-title { flex-wrap: wrap; }
      .code-head > span { display: none; }
    }
    /* At 320 the install pill is wider than the close band, so the Copy button
       drops under the command instead of being cut by the band's edge. */
    @media (max-width: ${BP.xs}px) {
      .final-row .cp { flex-wrap: wrap; justify-content: center; padding: 8px 12px; row-gap: 8px; }
      .final-band { padding-inline: 16px; }
    }
`,
    })}
<body>
${siteNav('/')}
<main>

  <header class="hero wrap">
    <p class="pill"><span class="pill-tag">For builders</span>who run agents unattended</p>
    <h1>${HEADLINE}</h1>
    <p class="sub">AgentBill is a per-task spending ceiling for autonomous
    <span class="nb">AI agents.</span> Before the next
    model call, preflight returns <span class="mono-in">approved: false</span> when this
    <span class="mono-in">task_ref</span> is out of units. <span class="nb">Your code</span>
    decides whether to stop, skip, or replan.</p>
    <div class="hero-cta">
      <a class="btn btn-lg" href="/register">${KEY_CTA}</a>
      <a class="btn-alt" href="#estimate">Estimate a run</a>
    </div>
    <p class="trust">Start free &middot; ${num(PLAN_LIMITS.free)} preflight calls/mo, no card</p>
    ${logFrame()}
  </header>

  <section class="wrap sec statement">
    <div class="st">
      <div class="st-copy">
        <h2>Unattended agents need a job ceiling</h2>
        <p>Month caps, org caps, and session or window budgets are real. They meter an account, a clock, or
        one session. A job ceiling meters one job, across processes and providers, with no reset: a call
        is checked against it only if it asks preflight with the job&rsquo;s name, and the call that would
        cross it gets <span class="mono-in">approved: false</span>.</p>
        <p class="st-line">An org cap is monthly: either tonight&rsquo;s loop fits under it, or every agent in
        the org is refused until the cap resets or someone raises it.</p>
      </div>
      ${statementFigure()}
    </div>
  </section>

${estimatorSection(KEY_CTA)}

${playgroundSection(codeFrame())}

  <section class="wrap sec how">
    <h2>Three steps, no proxy</h2>
    <div class="steps">
      <div class="step">
        <div class="step-ill"><span class="lbl">Job name</span><span class="fld">${RUN.taskRef}</span><span class="res"><span class="lbl">Ceiling</span> ${num(RUN.ceiling)} units</span></div>
        <h3><i>1</i> Give the job a ceiling</h3>
        <p>Name the job and set its ceiling in the console. In code, that name is the
        <span class="mono-in">task_ref</span>, and <span class="mono-in">PUT /tasks/:task_ref/ceiling</span> with
        <span class="mono-in">ceiling_units</span> in the body sets the same number.</p>
      </div>
      <div class="step">
        <div class="step-ill">client.preflight(
    agent_id="researcher",
    task_ref="${RUN.taskRef}",
    estimated_units=12)<span class="res">&rarr; <span class="chip-ok">approved</span> 12 reserved</span></div>
        <h3><i>2</i> Ask before each call</h3>
        <p>Call preflight with the same <span class="mono-in">task_ref</span> before your provider call. An
        approved call reserves its units, so two calls racing cannot both take the last room.</p>
      </div>
      <div class="step">
        <div class="step-ill">client.record(
    agent_id="researcher",
    task_ref="${RUN.taskRef}",
    units=12)<span class="res">&rarr; settled &middot; 12 used</span></div>
        <h3><i>3</i> Record what it used</h3>
        <p>Call record after the provider call to settle the units. No base URL to change, no provider
        traffic through us, no provider keys held. If we are unreachable, the SDK raises in your process and
        your code decides.</p>
      </div>
    </div>
    <p class="how-mcp">Working in Claude, ChatGPT, Cursor or Codex? <a href="/integrations/mcp" id="home-mcp">Connect via MCP &rarr;</a> One URL, and preflight is a tool your agent can call.</p>
  </section>

  <section class="wrap sec icp">
    <h3>Built for agent loops you own and leave running</h3>
    <ul class="chips">
      <li>Coding agents you built</li>
      <li>Overnight research jobs</li>
      <li>Scheduled agent runs</li>
      <li>Retry loops you wrote</li>
      <li>Batch pipelines</li>
    </ul>
    <p class="icp-note">Examples, not integrations or customers. A call is checked only when your code asks preflight.</p>
  </section>

  <section class="band">
    <div class="wrap">
      <div class="evid">
        <span class="eyebrow">From a public issue</span>
        <p class="evid-s">~$300 of unintended API usage over one unattended weekend, under a $3,000/month
        Enterprise limit. The limit is a month. The incident was a weekend.</p>
        <p class="evid-a">claude-code issue 64744, opened June 2, 2026. Open, labelled bug and area:cost; a
        workaround is posted in its comments.</p>
        <a href="https://github.com/anthropics/claude-code/issues/64744" rel="nofollow noopener"
           target="_blank">github.com/anthropics/claude-code/issues/64744</a>
      </div>
    </div>
  </section>

  <section class="wrap sec pricing" id="pricing">
    <div class="sec-head">
      <p class="eyebrow">Pricing</p>
      <h2>Free to start. Cheap enough to leave on.</h2>
      <p class="lead">${SAME_FEATURES}</p>
    </div>
    ${tierCards((tier) => `/app/upgrade/${tier}`)}
    <div class="price-links">
      <a class="more-link" href="/pricing">Full pricing &rarr;</a>
    </div>
  </section>

  <section class="wrap sec faq" id="faq">
    <div class="faq-grid">
      <div class="faq-head">
        <h2>Questions</h2>
        <p>Start with what AgentBill does not do.</p>
        <a href="/faq">All questions &rarr;</a>
      </div>
      <div class="faq-list">
        <details open>
          <summary>What AgentBill does not do</summary>
          <ul class="nots">
      <li><b>Sit in your request path.</b> No proxy, no base URL to change, no provider keys held. A call
      that never asks preflight, or a retry buried in a library, is never checked against the ceiling
      before it runs. If it records, its units still count.</li>
      <li><b>Read your provider bill.</b> No invoice access. A dollar figure appears only as an estimate at
      public list price, on calls wrap() measured. The estimator above is your rate times your count, run
      in your browser. Units are yours to define, and units refused is not money.</li>
      <li><b>Reach into a running job.</b> Preflight answers <span class="mono-in">approved: false</span>, and
      on a ceiling refusal the SDK raises. Your code decides what happens next.</li>
      <li><b>Undo what already ran.</b> Calls are refused, not reversed, and the ceiling is keyed on
      <span class="mono-in">(account_id, task_ref)</span>: a loop that opens a new
      <span class="mono-in">task_ref</span> gets a new ceiling.</li>
          </ul>
        </details>
${QUESTIONS.map(([q, a]) => `        <details>
          <summary>${q}</summary>
          <p>${a}</p>
        </details>`).join('\n')}
      </div>
    </div>
  </section>

  <section class="wrap final end">
    <div class="final-band">
      <h2>Give one job a ceiling.</h2>
      <p>Free tier, no card, ${num(PLAN_LIMITS.free)} preflight calls a month.</p>
      <div class="final-row">
        <a class="btn btn-lg" href="/register">${KEY_CTA}</a>
        <div data-lang="python">${copyPill('install-py-2', INSTALL_PY)}</div>
        <div data-lang="node" hidden>${copyPill('install-node-2', 'npm install agentbill')}</div>
      </div>
    </div>
  </section>

</main>
${siteFooter()}
${PLAYGROUND_JS}${ESTIMATOR_JS}${COPY_JS}${TABS_JS}
</body>
</html>
    `)
  })
}
