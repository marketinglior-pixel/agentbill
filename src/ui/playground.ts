import { inlineScript } from '../lib/csp.js'
import { PULSE_CLIENT_SRC } from './pulse-client.js'
import { RESERVATION_TTL_MINUTES } from '../lib/reservations.js'
import { LIST_PRICE_LABEL } from '../lib/prices.js'
// The homepage playground: a preflight you can run yourself.
//
// The refusal band above states the outcome, and it now renders from the run
// defined in this file rather than restating it. A reader has to take that band
// on faith; this section lets them produce the same line themselves in about
// five seconds, which is the difference between reading a claim and watching it
// happen.
//
// Why it matters here specifically: this product has had two external signups,
// ever, and neither has made a call. The account table shows 13 rows and eleven
// of them are our own aliases and test accounts, so the problem is not that
// registered users fail to activate. It is that almost nobody gets far enough
// to register. This is the cheapest place to let a visitor watch the product
// work before being asked for an email.
//
// HONESTY. preflight() below is a port of the task-budget branch of
// src/routes/preflight.ts, not a mock: same rule, same field names, same
// response bodies. It runs in the browser and touches no account, and the panel
// says so inside its own frame, so a screenshot of it carries the label. It
// cannot be a real call because a real call needs an API key, and putting one in
// a public page would be worse than the imprecision.
//
// If this port and preflight.ts ever disagree, preflight.ts is right and this
// file is a bug. The two facts to keep in sync are the rule
// (used + reserved + estimated <= ceiling) and the refusal body's field names.
//
// CSP. Unlike /app, the homepage sends no Content-Security-Policy, so the inline
// <script> below runs. Adding a CSP to `/` means giving this script a nonce or a
// hash, or the section goes silently dead.

/* ---------------------------------------------------------------------------
   The run, defined once.

   design.md: "A value typed into a second file, even with a comment saying it
   matches, is a copy that will drift." The refusal band in home.ts used to
   hardcode "492/500 units used, 8 remaining" while the plan that produces those
   numbers lived down here, and the default ceiling was typed four more times
   into the markup. Six copies of two facts, held together by a comment.

   Now the plan and the ceiling are the only inputs. The band, the slider, its
   two labels and the browser script all render from them, so editing a single
   line of PLAN moves every number on the page at once or breaks the build.
   --------------------------------------------------------------------------- */

const TASK_REF = 'job-142'
/** The job's ceiling, in cents: $5.00. Since 2026-09-26 the demo is a job
 *  opened in dollars (task_ceiling_usd), the product's own unit on the console,
 *  not units you define. Cents keep the arithmetic exact; everything a reader
 *  sees is dollars, and the wire is micro-dollars as the server's is. */
const DEFAULT_CEILING = 500

/** Cents as the page prints them: $4.92. */
export const usdCents = (c: number): string => `$${(c / 100).toFixed(2)}`
/** Cents as the server's JSON carries dollars (usdOf): 4.92, 5, 0.08. */
const usdJson = (c: number): number => Math.round(c) / 100
/** Cents as micro-dollars, the unit a dollar job's *_units fields count in. */
const micros = (c: number): number => Math.round(c) * 10_000

/** What each call costs at list price, in cents, in order. */
const PLAN: ReadonlyArray<readonly [string, number]> = [
  ['search.web', 12], ['fetch.page', 31], ['llm.summarize', 140], ['fetch.page', 28],
  ['llm.extract', 160], ['llm.rerank', 121], ['llm.critique', 180], ['llm.replan', 210],
  ['fetch.page', 26], ['llm.summarize', 150],
]

/** Walk the plan under a ceiling the way preflight() does, and stop where it
 *  would refuse. Nothing is reserved after a refusal, so the walk ends there. */
function firstRefusal(ceiling: number) {
  let used = 0
  for (let at = 0; at < PLAN.length; at++) {
    const units = PLAN[at][1]
    if (used + units > ceiling) return { used, ceiling, remaining: ceiling - used, asked: units, at }
    used += units
  }
  return null
}

const REFUSED = firstRefusal(DEFAULT_CEILING)
if (!REFUSED) {
  // A plan that never hits the ceiling would leave the band with nothing true to
  // say, so this is a build-time failure rather than a page that ships silent.
  throw new Error(
    `playground: PLAN never reaches the default ceiling of ${DEFAULT_CEILING}; the refusal band has no numbers to render`,
  )
}

/** The exception the SDK raises, reproduced from the template it builds the
 *  message with (sdk/python/agentbill/client.py). Rendered by the refusal band
 *  in home.ts so the band and the playground cannot disagree. */
export const REFUSAL = {
  name: 'TaskCeilingExceededError',
  // The dollar-job template of sdk/python/agentbill/client.py, filled with the
  // JSON numbers the server sends (4.92, 5, 0.08, 1.8), as Python prints them.
  message:
    `Refused (task_ceiling_exceeded): task '${TASK_REF}' is at $${usdJson(REFUSED.used)} of $${usdJson(REFUSED.ceiling)} at list price, `
    + `and $${usdJson(REFUSED.remaining)} remaining is not enough for the $${usdJson(REFUSED.asked)} this call asked to reserve.`,
  taskRef: TASK_REF,
  used: REFUSED.used,
  ceiling: REFUSED.ceiling,
  remaining: REFUSED.remaining,
} as const

/**
 * The run the homepage draws above the playground, 2026-09-23: the fold's
 * agent's-log frame and the Statement's meter. Walked from PLAN under the
 * default ceiling by the same firstRefusal() the band uses, so the fold, the
 * Statement and a press of Run cannot show three versions of one job. The
 * refused call here is the one the playground refuses (the seventh step, asking
 * for its own units), not HERO_BODY's call below, which asks for the first
 * step's 12.
 */
export const RUN = (() => {
  let cum = 0
  const approved = PLAN.slice(0, REFUSED.at).map(([name, units]) => ({ name, units, cum: (cum += units) }))
  return {
    taskRef: TASK_REF,
    ceiling: REFUSED.ceiling,
    used: REFUSED.used,
    remaining: REFUSED.remaining,
    approved,
    refused: { name: PLAN[REFUSED.at][0], asked: REFUSED.asked },
    notAsked: PLAN.length - REFUSED.at - 1,
  } as const
})()

/**
 * The body POST /preflight answers when the hero's own call is refused.
 *
 * The hero sample asks for the plan's first call (PLAN[0], 12 units) and the
 * frame shows what that call gets back on the iteration where 8 units remain.
 * Field names and order mirror the task_ceiling_exceeded branch of
 * src/routes/preflight.ts: approved, reason, estimated_units, task_ref, then
 * the detail (task_ceiling, task_used_units, task_remaining_units). There is no
 * message field on the wire; the SDK builds its exception text client-side.
 * If this and preflight.ts ever disagree, preflight.ts is right.
 */
const HERO_BODY = {
  approved: false,
  reason: 'task_ceiling_exceeded',
  estimated_units: micros(PLAN[0][1]),
  task_ref: TASK_REF,
  task_ceiling: micros(REFUSED.ceiling),
  task_used_units: micros(REFUSED.used),
  task_remaining_units: micros(REFUSED.remaining),
  task_unit: 'usd',
  estimate_source: 'caller',
  estimated_usd: usdJson(PLAN[0][1]),
  task_ceiling_usd: usdJson(REFUSED.ceiling),
  task_used_usd: usdJson(REFUSED.used),
  task_remaining_usd: usdJson(REFUSED.remaining),
  list_price_label: LIST_PRICE_LABEL,
} as const
export function heroRefusalBody(): Record<string, unknown> {
  return { ...HERO_BODY }
}


/** Total the plan asks for. Rendered, never typed: it is sum(PLAN). */
const PLAN_TOTAL = PLAN.reduce((n, [, u]) => n + u, 0)

/**
 * The resting state: the plan, not the run.
 *
 * Showing the finished run here was the obvious alternative and it is wrong.
 * The refusal band sits directly above with the same string at 40px, so the
 * outcome twice in one scroll deflates both, and it removes the reason to press
 * the button. The plan sets up the section without asserting anything happened:
 * the reader watches the running total arrive at the wall before clicking.
 *
 * Rendered from the same PLAN the run walks, so the two cannot disagree.
 */
function plannedRows(): string {
  let cum = 0
  return PLAN.map(([name, units], i) => {
    cum += units
    return `        <div class="pg-row planned" data-i="${i}" data-u="${usdCents(units)}" data-c="${usdCents(cum)}">` +
      `<span class="ar">&middot;</span>` +
      `<span class="nm">${name}</span>` +
      `<span class="un">${usdCents(units)}</span>` +
      `<span class="cum">${usdCents(cum)}</span>` +
      `<span class="an"></span></div>`
  }).join('\n')
}

/**
 * The request body for the first call, painted the way the response is.
 *
 * No task_ceiling, and that is not an omission. The slider above this panel is
 * this section's console: the reader sets the ceiling there before pressing
 * Run, and reset() disables it for the duration, so the ceiling is set before
 * the code runs exactly as it is on /app. A task_ceiling in this body would
 * say the call carries its own budget, contradicting the slider a few pixels
 * above it, /register's step 3, and the hero.
 *
 * It was also dead on the wire in this very file: preflight() below decides on
 * `task.ceiling`, the value the slider wrote, and never reads o.taskCeiling.
 * The argument was passed and ignored, which is what preflight.ts does once
 * the job exists, but here it happened by accident rather than by design.
 *
 * The ceiling is still shown, twice: on the slider, and in every response body
 * as the server's own statement of the ceiling in force.
 */
function restingRequest(): string {
  const fields: ReadonlyArray<readonly [string, string, string]> = [
    ['agent_id', '"researcher"', 's'],
    ['task_ref', `"${TASK_REF}"`, 's'],
    ['estimated_usd', String(usdJson(PLAN[0][1])), 'n'],
  ]
  return '{\n' + fields.map(([k, v, cls], i) =>
    `  <span class="k">"${k}"</span>: <span class="${cls}">${v}</span>${i < fields.length - 1 ? ',' : ''}`
  ).join('\n') + '\n}'
}

/** Playground CSS. Include once, after theme BASE and the page's .wrap rule. */
export const PLAYGROUND_CSS = `
  /* The demo on /, restyled 2026-09-23 to the canvas theme (x.ai/bot craft,
     layout only). One panel on the warm-gray ground holds two cards: the run on
     white on the left, the wire and your code on the right. Every id and every
     class the script writes is the one it wrote before; reset() and step()
     replace className wholesale, so a row or status can carry no extra class. */
  .pg-sec h2 { color: var(--white); }
  .pg-lede { color: var(--muted); font-size: var(--fs-lede); max-width: 60ch; margin: var(--s3) auto 0; }

  .pg { margin-top: var(--s6); background: var(--surface2); border-radius: var(--r-card); padding: var(--s5);
        display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 420px); gap: var(--s5); align-items: start; }
  .pg-left { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-inner);
             padding: 20px; min-width: 0; }
  .pg-right { display: grid; gap: var(--s4); min-width: 0; }

  .pg-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 18px; margin-bottom: 18px; }
  .pg-actions { display: flex; gap: 8px; }
  .pg-btn { font-family: var(--sans); font-size: var(--fs-small); font-weight: 500; padding: 10px 20px; min-height: 40px;
            border-radius: var(--r-control); cursor: pointer; border: 1px solid transparent;
            background: var(--surface3); color: var(--text); transition: background .15s; }
  .pg-btn:hover:not(:disabled) { background: var(--border); }
  .pg-btn.pri { background: var(--surface3); }
  .pg-btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .pg-field { display: flex; align-items: center; gap: 10px; margin-left: auto; }
  .pg-key { font-family: var(--mono); font-size: var(--fs-label); letter-spacing: 0.08em;
            text-transform: uppercase; color: var(--dim); }
  .pg-val { font-family: var(--mono); font-size: var(--fs-small); color: var(--text); }
  .pg-sl { -webkit-appearance: none; appearance: none; width: 120px; height: 2px;
           background: var(--border2); outline: none; cursor: pointer; }
  .pg-sl::-webkit-slider-thumb { -webkit-appearance: none; width: 16px; height: 16px;
           border-radius: 50%; background: var(--text); cursor: pointer; border: 3px solid var(--surface); }
  .pg-sl::-moz-range-thumb { width: 16px; height: 16px; border-radius: 50%;
           background: var(--text); cursor: pointer; border: 3px solid var(--surface); }
  .pg-sl:focus-visible { outline: 2px solid var(--text); outline-offset: 4px; }
  .pg-sl:disabled { opacity: 0.4; cursor: not-allowed; }

  .pg-h { font-family: var(--mono); font-size: var(--fs-label); letter-spacing: 0.08em;
          text-transform: uppercase; color: var(--dim); display: flex; flex-wrap: wrap; gap: 4px 12px;
          justify-content: space-between; align-items: baseline; margin-bottom: 10px; }
  .pg-budget { margin-bottom: 18px; }
  .pg-nums { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 8px; }
  .pg-used { font-family: var(--display); font-size: var(--fs-figure); font-weight: 500; letter-spacing: -0.02em;
             color: var(--text); font-variant-numeric: tabular-nums; transition: color 0.2s; }
  .pg-used.over { color: var(--signal); }
  .pg-ceil { font-size: var(--fs-small); color: var(--muted); }
  .pg-ceil b { font-weight: 500; color: var(--text); }
  .pg-track { height: 8px; background: var(--surface3); border-radius: var(--r-pill); position: relative; overflow: hidden; }
  .pg-fill { height: 100%; width: 0; background: var(--text); border-radius: var(--r-pill);
             transition: width 0.45s cubic-bezier(0.22,1,0.36,1), background 0.2s; }
  .pg-fill.refused { background: var(--text); }
  .pg-ghost { position: absolute; top: 0; height: 100%; opacity: 0; transition: opacity 0.25s;
              background: repeating-linear-gradient(45deg, var(--signal) 0 3px, transparent 3px 7px); }
  .pg-ghost.on { opacity: 0.85; }

  .pg-log { display: flex; flex-direction: column; gap: 2px; }
  .pg-cols { display: grid; grid-template-columns: 20px minmax(0, 1fr) 64px 72px 128px; gap: 12px;
             font-family: var(--mono); font-size: var(--fs-chip); letter-spacing: .08em;
             text-transform: uppercase; color: var(--dim); padding: 0 10px 6px; }
  .pg-cols span:nth-child(3), .pg-cols span:nth-child(4) { text-align: right; }
  .pg-row { display: grid; grid-template-columns: 20px minmax(0, 1fr) 84px 88px 144px; gap: 12px; align-items: center;
            font-family: var(--mono); font-size: var(--fs-small); padding: 7px 10px; border-radius: 10px; }
  .pg-row.ran, .pg-row.refused { animation: pg-slip 0.34s cubic-bezier(0.22,1,0.36,1) both; }
  @keyframes pg-slip { from { opacity: 0; transform: translateX(-8px); } to { opacity: 1; transform: none; } }
  .pg-row .ar { color: var(--dim); }
  .pg-row .nm { color: var(--text); min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pg-row .un { color: var(--muted); text-align: right; }
  .pg-row .cum { color: var(--text); text-align: right; font-variant-numeric: tabular-nums; }
  .pg-row.planned .nm, .pg-row.planned .un, .pg-row.planned .cum { color: var(--dim); }
  .pg-row.refused { background: var(--fail-bg); }
  .pg-row.refused .ar, .pg-row.refused .nm, .pg-row.refused .un, .pg-row.refused .cum { color: var(--signal); }
  /* The calls the run never reached, after a refusal: named, never asked. */
  .pg-row.na .nm, .pg-row.na .un, .pg-row.na .an { color: var(--dim); }
  .pg-row .an { font-size: var(--fs-micro); }
  .pg-more { display: none; font-family: var(--mono); font-size: var(--fs-small); color: var(--dim); padding: 8px 10px 0; }
  .pg-ask { font-family: var(--mono); font-size: var(--fs-small); color: var(--dim); margin-top: 10px; padding-inline: 10px; }
  .pg-ask b { color: var(--muted); font-weight: 500; }
  .pg-note { font-family: var(--mono); font-size: var(--fs-small); color: var(--signal); padding: 10px 10px 0;
             animation: pg-slip 0.34s cubic-bezier(0.22,1,0.36,1) both; }
  .pg-note.calm { color: var(--dim); }

  /* The decision under the run: what your code does with approved: false. */
  .pg-decide { margin-top: 20px; padding: 16px 10px 0; border-top: 1px solid var(--border); display: grid; gap: 10px; }
  .pg-decide .pg-key { display: block; }
  .pg-picks { display: flex; flex-wrap: wrap; gap: 8px; }
  .pg-picks span { font-size: var(--fs-small); color: var(--text); padding: 7px 14px; border-radius: var(--r-pill);
                   border: 1px solid var(--border2); background: var(--surface); }
  .pg-decide p { font-size: var(--fs-small); color: var(--dim); line-height: 1.5; }
  .pg-foot { margin-top: 16px; padding: 14px 10px 0; border-top: 1px solid var(--border); display: grid; gap: 4px; }
  .pg-rule { font-family: var(--mono); font-size: var(--fs-micro); color: var(--dim); }
  .pg-rule b { color: var(--muted); font-weight: 400; }
  .pg-disc { font-size: var(--fs-small); color: var(--dim); line-height: 1.5; }
  .pg-disc a { color: var(--muted); }

  /* The wire: the machine's answer on the dark plate. */
  .pg-wire { background: var(--plate); border-radius: var(--r-inner); padding: 18px 20px; min-width: 0; }
  .pg-wire .pg-h { color: var(--plate-dim); }
  .pg-json { font-family: var(--mono); font-size: var(--fs-small); line-height: 1.7; white-space: pre;
             overflow-x: auto; color: var(--plate-ink); }
  .pg-json .k { color: var(--plate-ink); }
  .pg-json .s, .pg-json .n, .pg-json .t { color: var(--plate-ink); }
  .pg-json .f { color: var(--plate-signal); font-weight: 500; }
  .pg-json .nl { color: var(--plate-dim); }
  .pg-status { font-family: var(--mono); font-size: var(--fs-chip); letter-spacing: 0.08em; text-transform: uppercase;
               padding: 4px 10px; border-radius: var(--r-pill); border: 1px solid; }
  .pg-status.ok { color: var(--plate-ink); border-color: var(--plate-dim); }
  .pg-status.no { color: var(--plate-signal); border-color: var(--plate-signal); }
  .pg-status.idle { color: var(--plate-dim); border-color: var(--plate-dim); }

  @media (max-width: 900px) {
    .pg { grid-template-columns: minmax(0, 1fr); padding: var(--s3); }
    .pg-field { margin-left: 0; }
  }
  /* The phone frame (Figma 6:120): the rows that ran carry their total, the
     refused one carries its answer on a second line, and the calls never asked
     fold into one line. */
  @media (max-width: 720px) {
    .pg-cols { display: none; }
    .pg-row { grid-template-columns: 14px minmax(0, 1fr) 48px 56px; gap: 8px; padding-inline: 6px; }
    .pg-row .an { display: none; }
    .pg-row.refused .an { display: block; }
    /* In dollars the refused row's ask and remainder ("asks $1.80", "$0.08
       left") outgrow the shared columns and broke onto two lines each. This
       row sets its own two lines instead: the call and its ask, then the
       answer and what is left, each figure whole. */
    .pg-row.refused { grid-template-columns: 14px minmax(0, 1fr) auto; row-gap: 6px; }
    .pg-row.refused .un, .pg-row.refused .cum { white-space: nowrap; }
    .pg-row.refused .cum { grid-column: 3; grid-row: 2; }
    .pg-row.refused .an { grid-column: 2; grid-row: 2; }
    .pg-row.na { display: none; }
    .pg-more.on { display: block; }
  }
  /* At 320px the row is 20 + 64 + 64 of fixed columns plus three gaps before the
     call name gets anything, and the frame clips what does not fit. The
     gutters tighten first and the fixed columns narrow second, so the running
     total stays inside the card; losing a line break is recoverable, losing a
     digit is not. */
  @media (max-width: 480px) {
    .pg-left { padding: 14px; }
    .pg-wire { padding: 14px; }
    .pg-sl { width: auto; flex: 1 1 48px; min-width: 48px; }
    .pg-field { min-width: 0; flex: 1 1 auto; }
  }
  /* At 320px the answer chip and "$0.08 left" do not fit one line: the chip
     takes a third. */
  @media (max-width: 360px) {
    .pg-row.refused .an { grid-column: 2 / -1; grid-row: 3; }
  }`

/**
 * The section markup. `code` is the frame of your own code under the wire; the
 * homepage passes it in because its two samples live in routes/home.ts, the
 * only place the snippet harness reads and executes them.
 */
export function playgroundSection(code = ''): string {
  return `  <section class="wrap sec pg-sec" id="playground">
    <div class="sec-head">
      <p class="eyebrow">Demo &middot; runs in your browser</p>
      <h2>Watch one job reach its ceiling</h2>
      <p class="pg-lede">A ten-call plan shares ${TASK_REF} and a ceiling of ${usdCents(DEFAULT_CEILING)}. Each call
      asks for what it costs at list price.</p>
    </div>

    <div class="pg">
      <div class="pg-left">
        <div class="pg-bar">
          <div class="pg-actions">
            <button id="pg-run" class="pg-btn pri" type="button">Run the job</button>
            <button id="pg-reset" class="pg-btn" type="button">Reset</button>
          </div>
          <div class="pg-field">
            <label class="pg-key" for="pg-ceil">ceiling</label>
            <input id="pg-ceil" class="pg-sl" type="range" min="100" max="1500" step="50" value="${DEFAULT_CEILING}"
                   aria-label="Task ceiling in dollars" />
            <span class="pg-val" id="pg-ceilv">${usdCents(DEFAULT_CEILING)}</span>
          </div>
        </div>
        <div class="pg-budget">
          <div class="pg-nums">
            <span class="pg-used" id="pg-used">$0.00</span>
            <span class="pg-ceil">used of <b id="pg-ceil2">${usdCents(DEFAULT_CEILING)}</b> &middot; ${TASK_REF}</span>
          </div>
          <div class="pg-track"><div class="pg-ghost" id="pg-ghost"></div><div class="pg-fill" id="pg-fill"></div></div>
        </div>
        <div class="pg-h"><span>Agent calls</span><span id="pg-count">0 calls</span></div>
        <div class="pg-cols"><span></span><span>the plan</span><span>cost</span><span>running</span><span>answer</span></div>
        <div class="pg-log" id="pg-log" aria-live="polite">
${plannedRows()}
        </div>
        <div class="pg-more" id="pg-more"></div>
        <div class="pg-ask" id="pg-ask">this plan asks for <b>${usdCents(PLAN_TOTAL)}</b> at list price.</div>
        <div class="pg-decide">
          <span class="pg-key">Your code decides</span>
          <div class="pg-picks"><span>Return what you have</span><span>Skip this step</span><span>Replan with a cheaper model</span></div>
          <p>On a ceiling refusal the SDK raises in your process, and the branch you wrote picks one.</p>
        </div>
        <div class="pg-foot">
          <div class="pg-rule">the rule: <b>used + reserved + estimated &lt;= ceiling</b></div>
          <p class="pg-disc">Runs in your browser, against no account. Same rule as
          <a href="/docs#api-reference">POST /preflight</a> on a job in dollars, and its dollar fields; the real
          answer carries a few more.</p>
        </div>
      </div>

      <div class="pg-right">
        <div class="pg-wire">
          <div class="pg-h"><span id="pg-verb">POST /preflight</span><span class="pg-status idle" id="pg-status">request</span></div>
          <div class="pg-json" id="pg-json">${restingRequest()}</div>
          <div id="pg-throw"></div>
        </div>
${code}
      </div>
    </div>
  </section>`
}

/** The behaviour. Put it just before </body>. */
const PLAYGROUND_SRC = `
(function(){
  // Serialised from PLAN in playground.ts. The refusal band renders from the
  // same array, so the page cannot show two versions of this run.
  var PLAN = ${JSON.stringify(PLAN.map(([n, u]) => [n, u]))};
  var TASK_REF = ${JSON.stringify(TASK_REF)};
  // The reservation lifetime the server itself uses (lib/reservations.ts), so
  // the approved body's reservation_expires_at is the same distance away as a
  // real one. It was a fixed two minutes until 2026-09-23, beside a page that
  // says sixty.
  var TTL_MS = ${JSON.stringify(RESERVATION_TTL_MINUTES * 60000)};
  var el = function(id){ return document.getElementById('pg-' + id) };
  // Cents in, the page's dollars out; and the wire's own shapes: JSON dollars
  // (usdOf) and micro-dollars for a dollar job's *_units fields.
  function money(c){ return '$' + (c / 100).toFixed(2) }
  function usdJ(c){ return Math.round(c) / 100 }
  function mic(c){ return Math.round(c) * 10000 }
  ${PULSE_CLIENT_SRC}
  // Every link to /register on this page, wherever it sits: the nav, the hero,
  // the pricing row, the close, the footer. Added 2026-09-18, the first day
  // the site had paid traffic: Meta counted 40 landing page views, accounts
  // gained 0 rows, and no row anywhere said whether one of the 40 had pressed
  // the one button the page asks for. The listener adds nothing to the click;
  // the beacon is queued and the navigation goes ahead. Above the playground
  // guard on purpose: this is a page fact, not a playground fact.
  // Exact, or exact followed by a query string. Not a prefix match: '^=' would
  // also claim any future /register-anything. The second half of the selector
  // exists because of ?src= (lib/source.ts): on a tagged visit the homepage
  // renders these links as /register?src=x, and an exact-only selector matches
  // nothing on precisely the traffic the tag was added to measure. That is the
  // shape where a guard is dead in the one case it was written for, so it has
  // its own gate in verify.mjs and the gate was red before it was green.
  var CTA_LINKS = document.querySelectorAll('a[href="/register"], a[href^="/register?"]');
  for (var ci = 0; ci < CTA_LINKS.length; ci++) {
    CTA_LINKS[ci].addEventListener('click', function(){ pulse('cta_click'); });
  }
  // The hero's second action, 2026-09-23: a pill to the estimator. It replaced
  // the 2026-09-18 text link to the demo (try_click), which Lior retired with
  // the redesign; try_click stays on the server's list for its history, and
  // nothing on the page sends it any more. It scrolls, it does not navigate, so
  // the beacon has all the time it needs. Read beside cta_click the same way:
  // a page where estimate_click runs well ahead of cta_click is a page whose
  // visitors want the arithmetic before the key.
  var EST_LINKS = document.querySelectorAll('a[href="#estimate"]');
  for (var ei = 0; ei < EST_LINKS.length; ei++) {
    EST_LINKS[ei].addEventListener('click', function(){ pulse('estimate_click'); });
  }
  // The estimator was used: once per page load, on the first keystroke into
  // any of its inputs, never on load. Only that it happened is sent. What the
  // visitor typed never leaves the page; the estimator's own script makes no
  // network call at all.
  var EST_INPUTS = document.querySelectorAll('#est input');
  var estUsed = false;
  for (var ej = 0; ej < EST_INPUTS.length; ej++) {
    EST_INPUTS[ej].addEventListener('input', function(){
      if (estUsed) return;
      estUsed = true;
      pulse('estimate_use');
    });
  }
  // This page loaded, in our own rows, 2026-09-22. Meta's pixel is a
  // third-party script and desktop browsers block it: between 20.09 and 22.09
  // the campaign counted 40 desktop link clicks and the pixel saw seven landing
  // page views, so the funnel had no first step of its own. This beacon goes
  // from our script to our origin, once per load, and carries the ?src= label
  // like every other event, which is what lets /admin read the funnel per
  // surface from the landing onward. Above the playground guard on purpose: a
  // page fact, not a playground fact.
  pulse('page_view');
  if (!el('run')) return;

  var task = null, timer = null, running = false, idx = 0;
  // Captured from the server-rendered markup rather than duplicated in this
  // script, so the resting request has exactly one definition.
  var REQUEST_HTML = el('json').innerHTML;

  // Ported from the task-budget branch of src/routes/preflight.ts. preflight()
  // reserves; record() settles the reservation into used.
  function preflight(o){
    var reserve = o.estimatedUnits == null ? 1 : o.estimatedUnits;
    if (task.used + task.reserved + reserve <= task.ceiling) {
      task.reserved += reserve;
      var left = task.ceiling - task.used - task.reserved;
      return { approved:true, reason:null, estimated_units:mic(reserve),
        remaining_units:null,
        reservation_expires_at:new Date(Date.now()+TTL_MS).toISOString(),
        task_ref:o.taskRef,
        task_ceiling: mic(task.ceiling),
        task_remaining_units: mic(left),
        task_unit:'usd', estimate_source:'caller', estimated_usd:usdJ(reserve),
        task_ceiling_usd:usdJ(task.ceiling), task_used_usd:usdJ(task.used), task_remaining_usd:usdJ(left) };
    }
    var rem = Math.max(0, task.ceiling - task.used - task.reserved);
    return { approved:false, reason:'task_ceiling_exceeded',
      estimated_units:mic(reserve), task_ref:o.taskRef,
      task_ceiling:mic(task.ceiling), task_used_units:mic(task.used),
      task_remaining_units: mic(rem),
      task_unit:'usd', estimate_source:'caller', estimated_usd:usdJ(reserve),
      task_ceiling_usd:usdJ(task.ceiling), task_used_usd:usdJ(task.used), task_remaining_usd:usdJ(rem) };
  }
  function record(units){ task.reserved -= units; task.used += units; }

  function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;') }
  function paint(obj){
    var keys = Object.keys(obj), out = '{\\n';
    keys.forEach(function(k,i){
      var v = obj[k], cls = 'n', txt;
      if (v === null) { cls='nl'; txt='null' }
      else if (v === true) { cls='t'; txt='true' }
      else if (v === false) { cls='f'; txt='false' }
      else if (typeof v === 'string') { cls='s'; txt='"'+v+'"' }
      else { txt = String(v) }
      out += '  <span class="k">"'+esc(k)+'"</span>: <span class="'+cls+'">'+esc(txt)+'</span>'
           + (i < keys.length-1 ? ',' : '') + '\\n';
    });
    return out + '}';
  }

  function bars(refusedBy){
    var pct = Math.min(100, task.used / task.ceiling * 100);
    el('used').textContent = money(task.used);
    el('fill').style.width = pct + '%';
    if (refusedBy != null) {
      el('ghost').style.left = pct + '%';
      el('ghost').style.width = Math.max(Math.min(100 - pct, refusedBy / task.ceiling * 100), 4) + '%';
      el('ghost').classList.add('on');
      el('fill').classList.add('refused');
      el('used').classList.add('over');
    }
  }

  function reset(){
    clearTimeout(timer); running = false; idx = 0;
    task = { ceiling: parseInt(el('ceil').value,10), used:0, reserved:0 };
    // The rows are server-rendered and stay put: reset returns them to the
    // planned state instead of rebuilding the list. Nothing is added or removed
    // at any point in a run, so the panel's height never changes.
    var rows = el('log').querySelectorAll('.pg-row');
    for (var i = 0; i < rows.length; i++) {
      rows[i].className = 'pg-row planned';
      rows[i].querySelector('.ar').innerHTML = '&middot;';
      rows[i].querySelector('.un').textContent = rows[i].getAttribute('data-u');
      rows[i].querySelector('.cum').textContent = rows[i].getAttribute('data-c');
      rows[i].querySelector('.an').innerHTML = '';
    }
    var note = el('log').querySelector('.pg-note');
    if (note) note.parentNode.removeChild(note);
    el('more').className = 'pg-more'; el('more').textContent = '';
    el('json').innerHTML = REQUEST_HTML;
    el('ask').style.visibility = '';
    el('throw').innerHTML = '';
    el('count').textContent = '0 calls';
    el('status').className = 'pg-status idle'; el('status').textContent = 'request';
    el('fill').style.width = '0'; el('fill').classList.remove('refused');
    el('ghost').classList.remove('on'); el('ghost').style.width = '0';
    el('used').textContent = '$0.00'; el('used').classList.remove('over');
    el('ceil').disabled = false; el('run').disabled = false; el('run').textContent = 'Run the job';
  }

  function step(){
    if (idx >= PLAN.length) { finish('done. the job stayed inside its budget.'); return }
    var name = PLAN[idx][0], units = PLAN[idx][1];
    // No taskCeiling: the slider set it before the run, so the call names the
    // job and says nothing about the budget. preflight() decides on
    // task.ceiling and never read this argument anyway.
    var res = preflight({ agentId:'researcher', taskRef:TASK_REF,
                          estimatedUnits:units });

    // Convert the row that is already there. No append, no layout shift.
    var row = el('log').querySelector('.pg-row[data-i="' + idx + '"]');
    if (row) {
      row.className = 'pg-row ' + (res.approved ? 'ran' : 'refused');
      row.querySelector('.ar').innerHTML = res.approved ? '&rarr;' : '&#10005;';
    }
    if (idx === 0) el('ask').style.visibility = 'hidden';
    el('json').innerHTML = paint(res);
    el('count').textContent = (idx+1) + (idx ? ' calls' : ' call');

    if (res.approved) {
      if (row) row.querySelector('.an').innerHTML = '<span class="chip-ok">approved</span>';
      record(units); bars(null);
      el('status').className = 'pg-status ok'; el('status').textContent = '200 approved';
      idx++; timer = setTimeout(step, 620);
      return;
    }

    bars(units);
    el('status').className = 'pg-status no'; el('status').textContent = '200 refused';
    // The row says what happened, the way Figma's refused state (C2) draws
    // it: what the call asked, what was left, and the answer. 2026-09-23: the
    // note and the "the SDK throws here, so the expensive call never starts"
    // panel that used to be inserted here came out, because whether the call
    // runs is decided by the branch the developer wrote, which the caption in
    // the same card says.
    if (row) {
      row.querySelector('.un').textContent = 'asks ' + money(units);
      row.querySelector('.cum').textContent = money(Math.max(0, task.ceiling - task.used - task.reserved)) + ' left';
      row.querySelector('.an').innerHTML = '<span class="chip-no">approved: false</span>';
    }
    // The calls the run never reached: named, not asked, no running total.
    var rest = 0;
    for (var j = idx + 1; j < PLAN.length; j++) {
      var later = el('log').querySelector('.pg-row[data-i="' + j + '"]');
      if (!later) continue;
      later.className = 'pg-row na';
      later.querySelector('.cum').textContent = '';
      later.querySelector('.an').textContent = 'not asked';
      rest++;
    }
    if (rest) { el('more').textContent = rest + (rest === 1 ? ' more call' : ' more calls') + ' in the plan, not asked'; el('more').className = 'pg-more on'; }
    el('ask').style.visibility = 'hidden';
    // The event NAME keeps its old spelling on purpose: it is the key /pulse
    // has stored since the playground shipped, and renaming it would split one
    // series into two. Nothing a reader sees carries the word; the row and
    // bar classes say "refused", like every other surface.
    pulse('playground_blocked', task.ceiling);
    finish(null);
  }

  function finish(msg){
    running = false;
    el('run').disabled = false; el('run').textContent = 'Run again';
    el('ceil').disabled = false;
    if (msg) {
      pulse('playground_completed', task.ceiling);
      el('status').className = 'pg-status ok'; el('status').textContent = 'job complete';
      var d = document.createElement('div');
      d.className = 'pg-note calm'; d.textContent = msg;
      el('log').appendChild(d);
      el('ask').style.visibility = 'hidden';
    }
  }

  el('ceil').addEventListener('input', function(){
    el('ceilv').textContent = money(parseInt(this.value, 10));
    el('ceil2').textContent = money(parseInt(this.value, 10));
    if (!running) reset();
  });
  el('run').addEventListener('click', function(){
    if (running) return;
    reset(); running = true; this.disabled = true; this.textContent = 'Running';
    el('ceil').disabled = true;
    pulse('playground_run', task.ceiling);
    timer = setTimeout(step, 220);
  });
  el('reset').addEventListener('click', reset);
  reset();
})();
`

const pg = inlineScript(PLAYGROUND_SRC)
export const PLAYGROUND_JS = pg.html
export const PLAYGROUND_HASH = pg.hash
