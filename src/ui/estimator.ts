import { inlineScript } from '../lib/csp.js'

// The estimator on `/`, #estimate. Added 2026-09-23 (T2 of the value pack).
//
// What it is: the visitor's own arithmetic, shown back to them. Calls in one
// run times their own cost per call is what one unattended job could cost; a
// ceiling in units, at one unit per call, is where preflight would start
// answering approved: false. Every dollar on this card is the visitor's number
// multiplied by the visitor's number. AgentBill measures no dollars anywhere,
// and the card says so inside its own frame, so a screenshot carries it.
//
// Why "1 unit = 1 call": it is the product's own default, not a mapping this
// card invents. preflight reserves `estimated_units ?? 1` (src/routes/preflight.ts)
// and record defaults `units` to 1 in both SDKs, so a caller who passes no
// estimate is counting calls.
//
// No network. This script never calls fetch, sendBeacon or XMLHttpRequest, and
// a gate in verify.mjs holds that. The page's one pulse client lives in the
// playground script, which counts that the estimator was used, never what was
// typed into it.
//
// With JavaScript off the card still renders the example, labelled as one, and
// a line says the inputs need JavaScript. It adds no second link: the card's
// one /register anchor is the same with or without the script.

/** The example the card opens on. Labelled "example" until the visitor edits. */
export const EST_DEFAULTS = { calls: 2000, costPerCall: 0.05, ceiling: 500 } as const

const usd = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const int = (n: number) => n.toLocaleString('en-US')

/** The arithmetic, once. The server renders the example with it and the script re-runs the same rule. */
export function estimate(calls: number, costPerCall: number, ceiling: number) {
  const total = calls * costPerCall
  const fits = calls <= ceiling
  const approvedCalls = fits ? calls : ceiling
  return { total, fits, approvedCalls, firstRefused: fits ? null : ceiling + 1, approvedCost: approvedCalls * costPerCall }
}

export const ESTIMATOR_CSS = `
  /* #estimate. The visitor's arithmetic on the panel ground: inputs on the
     left, the result on a white card on the right. The result card carries an
     "example" chip until an input changes, because the first render is our
     numbers, not the visitor's. */
  #estimate { scroll-margin-top: calc(var(--banner-height) + var(--s4)); }
  .est { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--s5);
         background: var(--surface2); border-radius: var(--r-card); padding: var(--s5); margin-top: var(--s6); }
  .est-in { display: grid; gap: 20px; padding: var(--s4); align-content: start; }
  .est-f { display: grid; gap: var(--s2); }
  .est-f label { font-size: var(--fs-small); font-weight: 500; color: var(--muted); }
  .est-f input { font-family: var(--mono); font-size: var(--fs-lede); color: var(--text); background: var(--surface);
                 border: 1px solid var(--border-strong); border-radius: var(--r-field); padding: 12px 16px;
                 width: 100%; min-width: 0; }
  .est-f input:focus { outline: none; border-color: var(--text); box-shadow: 0 0 0 1px var(--text); }
  .est-rule { height: 1px; background: var(--border); }
  .est-note { font-size: var(--fs-small); color: var(--dim); line-height: 1.5; }
  .est-out { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-inner);
             padding: 28px; display: grid; gap: 10px; align-content: start; }
  .est-head { display: flex; justify-content: space-between; align-items: center; gap: var(--s3); }
  .est-k { font-size: var(--fs-small); font-weight: 500; color: var(--muted); }
  .est-total { font-family: var(--display); font-size: var(--fs-stat); font-weight: 500; letter-spacing: -0.015em;
               line-height: 1.1; color: var(--text); font-variant-numeric: tabular-nums; }
  .est-cap { font-size: var(--fs-small); color: var(--dim); line-height: 1.5; }
  .est-line { height: 1px; background: var(--border); margin-block: 6px; }
  .est-ceil { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; color: var(--text); }
  .est-out .btn { justify-self: start; margin-top: var(--s2); }
  .est-js { font-size: var(--fs-small); color: var(--dim); }
  .est.live .est-js { display: none; }
  @media (max-width: 820px) {
    .est { grid-template-columns: minmax(0, 1fr); padding: var(--s4); }
    .est-in { padding: 0; }
  }`

/** The section. The numbers are rendered from EST_DEFAULTS through estimate(). */
export function estimatorSection(cta: string): string {
  const d = EST_DEFAULTS
  const r = estimate(d.calls, d.costPerCall, d.ceiling)
  return `  <section class="wrap sec est-sec" id="estimate">
    <div class="sec-head">
      <p class="eyebrow">Estimate a run</p>
      <h2>What could one unattended job cost you?</h2>
      <p class="lead">Start from our example, then put in your numbers. No signup. The math runs in your browser.</p>
    </div>
    <div class="est" id="est">
      <div class="est-in">
        <div class="est-f"><label for="est-calls">Calls in one run</label>
          <input id="est-calls" type="text" inputmode="numeric" autocomplete="off" value="${int(d.calls)}" /></div>
        <div class="est-f"><label for="est-cost">Your cost per call (USD)</label>
          <input id="est-cost" type="text" inputmode="decimal" autocomplete="off" value="${usd(d.costPerCall)}" /></div>
        <div class="est-rule"></div>
        <div class="est-f"><label for="est-ceil">Try a job ceiling (units)</label>
          <input id="est-ceil" type="text" inputmode="numeric" autocomplete="off" value="${int(d.ceiling)}" /></div>
        <p class="est-note" id="est-rate">Here 1 unit = 1 call, the default when you pass no estimate. At your rate that is ${usd(d.costPerCall)} a unit. AgentBill counts units, not dollars.</p>
        <p class="est-js">The inputs need JavaScript. The math is calls in one run &times; your cost per call.</p>
      </div>
      <div class="est-out" aria-live="polite">
        <div class="est-head"><span class="est-k">One run, no job ceiling</span><span class="tag" id="est-ex">example</span></div>
        <div class="est-total" id="est-total">${usd(r.total)}</div>
        <p class="est-cap" id="est-cap">${int(d.calls)} calls &times; ${usd(d.costPerCall)}: example inputs until you change them. An estimate, not a measurement.</p>
        <div class="est-line"></div>
        <div class="est-ceil" id="est-ceil-line">Call ${int(r.firstRefused ?? 0)} gets <span class="chip-no">approved: false</span></div>
        <p class="est-cap" id="est-after">The ${int(r.approvedCalls)} approved calls: about ${usd(r.approvedCost)} at your rate. What runs after that is your code&rsquo;s decision.</p>
        <a class="btn btn-lg" href="/register">${cta}</a>
      </div>
    </div>
  </section>`
}

const ESTIMATOR_SRC = `
(function(){
  var root = document.getElementById('est');
  if (!root) return;
  root.className += ' live';
  var $ = function(id){ return document.getElementById('est-' + id) };
  var MAX = 100000000;
  function num(s){
    var v = parseFloat(String(s).replace(/[$,\\s]/g, ''));
    return isFinite(v) && v >= 0 ? Math.min(v, MAX) : null;
  }
  function usd(n){ return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }
  function int(n){ return Math.floor(n).toLocaleString('en-US') }
  var edited = false;
  function run(){
    var calls = num($('calls').value), cost = num($('cost').value), ceil = num($('ceil').value);
    if (calls === null || cost === null || ceil === null) {
      $('total').textContent = 'enter a number';
      $('cap').textContent = 'Calls, cost per call and the ceiling each need a number of 0 or more.';
      return;
    }
    calls = Math.floor(calls); ceil = Math.floor(ceil);
    var total = calls * cost, fits = calls <= ceil, ok = fits ? calls : ceil;
    $('total').textContent = usd(total);
    $('cap').textContent = int(calls) + ' calls \\u00d7 ' + usd(cost)
      + (edited ? '.' : ': example inputs until you change them.') + ' An estimate, not a measurement.';
    $('rate').textContent = 'Here 1 unit = 1 call, the default when you pass no estimate. At your rate that is '
      + usd(cost) + ' a unit. AgentBill counts units, not dollars.';
    if (fits) {
      $('ceil-line').textContent = 'Every call fits under a ceiling of ' + int(ceil) + '.';
      $('after').textContent = 'The job never reaches its ceiling, so preflight approves all ' + int(calls) + ' calls.';
    } else {
      $('ceil-line').innerHTML = 'Call ' + int(ceil + 1) + ' gets <span class="chip-no">approved: false</span>';
      $('after').textContent = 'The ' + int(ok) + ' approved calls: about ' + usd(ok * cost)
        + ' at your rate. What runs after that is your code\\u2019s decision.';
    }
  }
  ['calls', 'cost', 'ceil'].forEach(function(k){
    $(k).addEventListener('input', function(){
      if (!edited) { edited = true; var ex = $('ex'); if (ex) ex.parentNode.removeChild(ex); }
      run();
    });
  });
})();
`

const est = inlineScript(ESTIMATOR_SRC)
export const ESTIMATOR_JS = est.html
export const ESTIMATOR_HASH = est.hash
/** The raw script, so a gate can prove it makes no network call. */
export const ESTIMATOR_SOURCE = ESTIMATOR_SRC
