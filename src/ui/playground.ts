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
const DEFAULT_CEILING = 500

/** What the agent intends to spend, in order. Units are yours to define; here
 *  1 unit = 1 cent. */
const PLAN: ReadonlyArray<readonly [string, number]> = [
  ['search.web', 12], ['fetch.page', 31], ['llm.summarize', 140], ['fetch.page', 28],
  ['llm.extract', 160], ['llm.rerank', 121], ['llm.critique', 180], ['llm.replan', 210],
  ['fetch.page', 26], ['llm.summarize', 150],
]

/** Walk the plan under a ceiling the way preflight() does, and stop where it
 *  would refuse. Nothing is reserved after a refusal, so the walk ends there. */
function firstRefusal(ceiling: number) {
  let used = 0
  for (const [, units] of PLAN) {
    if (used + units > ceiling) return { used, ceiling, remaining: ceiling - used, asked: units }
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
  message:
    `Task '${TASK_REF}' blocked: ${REFUSED.used}/${REFUSED.ceiling} units used, `
    + `${REFUSED.remaining} remaining is not enough for this call.`,
} as const


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
    return `        <div class="pg-row planned" data-i="${i}">` +
      `<span class="ar">&middot;</span>` +
      `<span class="nm">${name}</span>` +
      `<span class="un">${units}</span>` +
      `<span class="cum">${cum.toLocaleString('en-US')}</span></div>`
  }).join('\n')
}

/** The request body for the first call, painted the way the response is. */
function restingRequest(): string {
  const fields: ReadonlyArray<readonly [string, string, string]> = [
    ['agent_id', '"researcher"', 's'],
    ['task_ref', `"${TASK_REF}"`, 's'],
    ['task_ceiling', String(DEFAULT_CEILING), 'n'],
    ['estimated_units', String(PLAN[0][1]), 'n'],
  ]
  return '{\n' + fields.map(([k, v, cls], i) =>
    `  <span class="k">"${k}"</span>: <span class="${cls}">${v}</span>${i < fields.length - 1 ? ',' : ''}`
  ).join('\n') + '\n}'
}

/** Playground CSS. Include once, after theme BASE and the page's .wrap rule. */
export const PLAYGROUND_CSS = `
  .pg-sec { padding-block: 76px 0; }
  .pg-lede { color: var(--muted); font-size: var(--fs-lede); max-width: 62ch; margin-top: 12px; }

  .pg { margin-top: 30px; border: 1px solid var(--border); background: var(--surface);
        border-radius: var(--r-frame); overflow: hidden; }

  .pg-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 24px;
            padding: 16px 20px; border-bottom: 1px solid var(--border); background: var(--surface2); }
  .pg-field { display: flex; align-items: center; gap: 10px; }
  .pg-key { font-family: var(--mono); font-size: 11.5px; letter-spacing: 0.16em;
            text-transform: uppercase; color: var(--dim); }
  .pg-val { font-family: var(--mono); font-size: 15px; color: var(--text); }
  .pg-sl { -webkit-appearance: none; appearance: none; width: 150px; height: 2px;
           background: var(--border2); outline: none; cursor: pointer; }
  .pg-sl::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px;
           border-radius: 50%; background: var(--green); cursor: pointer;
           border: 3px solid var(--bg); box-shadow: 0 0 0 1px var(--green); }
  .pg-sl::-moz-range-thumb { width: 14px; height: 14px; border-radius: 50%;
           background: var(--green); cursor: pointer; border: 3px solid var(--bg);
           box-shadow: 0 0 0 1px var(--green); }
  .pg-sl:disabled { opacity: 0.4; cursor: not-allowed; }
  .pg-actions { margin-left: auto; display: flex; gap: 10px; }
  .pg-btn { font-family: var(--sans); font-size: 14.5px; font-weight: 600; padding: 9px 20px;
            border-radius: var(--r-control); cursor: pointer; border: 1px solid var(--border-strong);
            background: transparent; color: var(--text); transition: border-color 0.15s; }
  .pg-btn:hover:not(:disabled) { border-color: var(--text); }
  .pg-btn.pri { background: var(--green); color: var(--green-ink); border-color: var(--green); }
  .pg-btn.pri:hover:not(:disabled) { filter: brightness(1.09); }
  .pg-btn:disabled { opacity: 0.35; cursor: not-allowed; }

  .pg-split { display: grid; grid-template-columns: 1fr 1fr; }
  .pg-left { border-right: 1px solid var(--border); padding: 20px; }
  .pg-right { padding: 20px; background: var(--bg-deep); display: flex; flex-direction: column; }
  .pg-h { font-family: var(--mono); font-size: 11.5px; letter-spacing: 0.18em;
          text-transform: uppercase; color: var(--dim); display: flex;
          justify-content: space-between; align-items: baseline; margin-bottom: 14px; }

  .pg-budget { margin-bottom: 20px; }
  .pg-nums { display: flex; justify-content: space-between; align-items: baseline;
             font-family: var(--mono); margin-bottom: 9px; }
  .pg-used { font-size: 30px; color: var(--text); transition: color 0.2s; }
  .pg-used.over { color: var(--red); }
  .pg-ceil { font-size: 14px; color: var(--dim); }
  .pg-track { height: 6px; background: var(--border2); position: relative; overflow: hidden; }
  .pg-fill { height: 100%; width: 0; background: var(--green);
             transition: width 0.45s cubic-bezier(0.22,1,0.36,1), background 0.2s; }
  .pg-fill.blocked { background: var(--red); }
  .pg-ghost { position: absolute; top: 0; height: 100%; opacity: 0; transition: opacity 0.25s;
              background: repeating-linear-gradient(45deg, var(--red) 0 3px, transparent 3px 7px); }
  .pg-ghost.on { opacity: 0.85; }

  /* No min-height. It used to reserve 292px whether or not there were rows, so
     the tallest element on the homepage held the height of a run it had not
     done and none of its content: two ~300px voids side by side until someone
     clicked. The rows are server-rendered at rest now, so the content sets the
     height, the height never changes when the run starts, and the section says
     something with JavaScript off. */
  .pg-log { display: flex; flex-direction: column; gap: 1px; }
  .pg-cols { display: grid; grid-template-columns: 24px 1fr auto 68px; gap: 12px;
             font-family: var(--mono); font-size: var(--fs-chip); letter-spacing: .12em;
             text-transform: uppercase; color: var(--dim); padding-bottom: 6px;
             border-bottom: 1px solid var(--border); }
  .pg-cols span:nth-child(3), .pg-cols span:nth-child(4) { text-align: right; }
  .pg-row { display: grid; grid-template-columns: 24px 1fr auto 68px; gap: 12px; align-items: baseline;
            font-family: var(--mono); font-size: 14.5px; padding: 7px 0;
            border-bottom: 1px solid var(--border-soft); }
  /* Only a row that CHANGES state animates. At rest every row is already there,
     so entry animation would be ten rows sliding in for no reason. */
  .pg-row.ran, .pg-row.blocked { animation: pg-slip 0.34s cubic-bezier(0.22,1,0.36,1) both; }
  @keyframes pg-slip { from { opacity: 0; transform: translateX(-12px); } to { opacity: 1; transform: none; } }
  .pg-row .ar { color: var(--green); }
  .pg-row .nm { color: var(--muted); }
  .pg-row .un { color: var(--dim); }
  .pg-row .cum { color: var(--dim); text-align: right; }
  /* At rest the whole row is quiet: this is a plan, not a result. */
  .pg-row.planned { opacity: .55; }
  .pg-row.planned .ar { color: var(--dim); }
  .pg-row.blocked { border-bottom-color: var(--red); opacity: 1; }
  .pg-row.blocked .ar, .pg-row.blocked .nm, .pg-row.blocked .un, .pg-row.blocked .cum { color: var(--red); }
  .pg-ask { font-family: var(--mono); font-size: var(--fs-small); color: var(--dim); margin-top: 10px; }
  .pg-ask b { color: var(--muted); font-weight: 500; }
  .pg-note { font-family: var(--mono); font-size: 13.5px; color: var(--red); padding-top: 11px;
             animation: pg-slip 0.34s cubic-bezier(0.22,1,0.36,1) both; }
  .pg-note.calm { color: var(--dim); }
  .pg-empty { font-family: var(--mono); font-size: 14px; color: var(--dim); padding-top: 8px; }

  .pg-json { font-family: var(--mono); font-size: 14.5px; line-height: 1.75; white-space: pre;
             overflow-x: auto; flex: 1; color: var(--dim); }
  .pg-json .k { color: var(--muted); }
  .pg-json .s, .pg-json .n { color: var(--code); }
  .pg-json .t { color: var(--green); }
  .pg-json .f { color: var(--red); font-weight: 700; }
  .pg-json .nl { color: var(--dim); }
  .pg-status { font-family: var(--mono); font-size: 12px; letter-spacing: 0.14em;
               text-transform: uppercase; padding: 5px 11px; border-radius: var(--r-chip); border: 1px solid; }
  .pg-status.ok { color: var(--green); border-color: var(--held-line); background: var(--held-bg); }
  .pg-status.no { color: var(--red); border-color: var(--fail-line); background: var(--fail-bg); }
  .pg-status.idle { color: var(--dim); border-color: var(--border2); }
  .pg-throw { margin-top: 16px; border: 1px solid var(--red); background: var(--fail-bg);
              padding: 12px 14px; font-family: var(--mono); font-size: 14px; color: var(--red);
              animation: pg-pop 0.3s cubic-bezier(0.22,1,0.36,1) both; }
  @keyframes pg-pop { from { opacity: 0; transform: scale(1.06); } to { opacity: 1; transform: none; } }
  .pg-throw b { display: block; font-weight: 700; margin-bottom: 3px; }
  .pg-throw span { color: var(--muted); font-size: 13px; }

  .pg-foot { border-top: 1px solid var(--border); padding: 15px 20px; display: flex;
             flex-wrap: wrap; gap: 12px 24px; align-items: center; background: var(--surface2); }
  .pg-rule { font-family: var(--mono); font-size: 13px; color: var(--dim); }
  .pg-rule b { color: var(--muted); font-weight: 400; }
  .pg-disc { margin-left: auto; font-family: var(--mono); font-size: 12.5px; color: var(--dim);
             text-align: right; line-height: 1.5; }

  @media (max-width: 820px) {
    .pg-split { grid-template-columns: 1fr; }
    .pg-left { border-right: none; border-bottom: 1px solid var(--border); }
    .pg-actions { margin-left: 0; }
    .pg-disc { margin-left: 0; text-align: left; }
  }`

/** The section markup. Drop it straight after the hero. */
export function playgroundSection(): string {
  return `  <section class="wrap pg-sec">
    <h2>Run an agent into its ceiling.</h2>
    <p class="pg-lede">Set a ceiling for the whole job. Run the agent. The call that would break
    the budget never goes out. You get back the same response body your SDK gets.</p>

    <div class="pg">
      <div class="pg-bar">
        <div class="pg-field"><span class="pg-key">task</span><span class="pg-val">${TASK_REF}</span></div>
        <div class="pg-field">
          <label class="pg-key" for="pg-ceil">ceiling</label>
          <input id="pg-ceil" class="pg-sl" type="range" min="100" max="1500" step="50" value="${DEFAULT_CEILING}"
                 aria-label="Task ceiling in units" />
          <span class="pg-val" id="pg-ceilv">${DEFAULT_CEILING}</span><span class="pg-key">units</span>
        </div>
        <div class="pg-actions">
          <button id="pg-run" class="pg-btn pri" type="button">Run agent</button>
          <button id="pg-reset" class="pg-btn" type="button">Reset</button>
        </div>
      </div>

      <div class="pg-split">
        <div class="pg-left">
          <div class="pg-h"><span>Agent calls</span><span id="pg-count">0 calls</span></div>
          <div class="pg-budget">
            <div class="pg-nums">
              <span class="pg-used" id="pg-used">0</span>
              <span class="pg-ceil">used of <b id="pg-ceil2">${DEFAULT_CEILING}</b> units</span>
            </div>
            <div class="pg-track"><div class="pg-ghost" id="pg-ghost"></div><div class="pg-fill" id="pg-fill"></div></div>
          </div>
          <div class="pg-cols"><span></span><span>the plan</span><span>units</span><span>running</span></div>
          <div class="pg-log" id="pg-log" aria-live="polite">
${plannedRows()}
          </div>
          <div class="pg-ask" id="pg-ask">this plan asks for <b>${PLAN_TOTAL.toLocaleString('en-US')}</b> units.</div>
        </div>

        <div class="pg-right">
          <div class="pg-h"><span id="pg-verb">POST /preflight</span><span class="pg-status idle" id="pg-status">request</span></div>
          <div class="pg-json" id="pg-json">${restingRequest()}</div>
          <div id="pg-throw"></div>
        </div>
      </div>

      <div class="pg-foot">
        <div class="pg-rule">the rule: <b>used + reserved + estimated &lt;= ceiling</b></div>
        <div class="pg-disc">The plan above is what the agent will send. Pressing Run
        executes it in your browser, against no account.<br />
        Same rule and same response body as <a href="/docs">POST /preflight</a>.</div>
      </div>
    </div>
  </section>`
}

/** The behaviour. Put it just before </body>. */
export const PLAYGROUND_JS = `<script>
(function(){
  // Serialised from PLAN in playground.ts. The refusal band renders from the
  // same array, so the page cannot show two versions of this run.
  var PLAN = ${JSON.stringify(PLAN.map(([n, u]) => [n, u]))};
  var TASK_REF = ${JSON.stringify(TASK_REF)};
  var el = function(id){ return document.getElementById('pg-' + id) };
  if (!el('run')) return;

  // A random token for THIS page view. Not a cookie, not localStorage, gone
  // when the tab closes. It exists so the rows can tell ten visitors running
  // once from one visitor running ten times, and it cannot follow anyone
  // between visits.
  var VIEW = (function(){
    try {
      var a = new Uint8Array(12);
      window.crypto.getRandomValues(a);
      var out = '';
      for (var i = 0; i < a.length; i++) out += (a[i] % 36).toString(36);
      return out;
    } catch (e) { return String(Date.now()) + String(Math.random()).slice(2, 8) }
  })();

  // One direction, never blocking, never throwing. The page does not care
  // whether this lands, so nothing here is awaited and nothing is retried.
  function pulse(event, ceiling){
    try {
      var payload = { event: event, view_id: VIEW };
      if (ceiling != null) payload.ceiling = ceiling;
      var body = JSON.stringify(payload);
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/pulse', new Blob([body], { type: 'application/json' }));
        return;
      }
      fetch('/pulse', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: body, keepalive: true }).catch(function(){});
    } catch (e) {}
  }
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
      return { approved:true, reason:null, estimated_units:o.estimatedUnits,
        remaining_units:null,
        reservation_expires_at:new Date(Date.now()+120000).toISOString(),
        task_ref:o.taskRef,
        task_remaining_units: task.ceiling - task.used - task.reserved };
    }
    return { approved:false, reason:'task_ceiling_exceeded',
      estimated_units:o.estimatedUnits, task_ref:o.taskRef,
      task_ceiling:task.ceiling, task_used_units:task.used,
      task_remaining_units: Math.max(0, task.ceiling - task.used - task.reserved) };
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

  function bars(blockedBy){
    var pct = Math.min(100, task.used / task.ceiling * 100);
    el('used').textContent = task.used.toLocaleString('en-US');
    el('fill').style.width = pct + '%';
    if (blockedBy != null) {
      el('ghost').style.left = pct + '%';
      el('ghost').style.width = Math.max(Math.min(100 - pct, blockedBy / task.ceiling * 100), 4) + '%';
      el('ghost').classList.add('on');
      el('fill').classList.add('blocked');
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
    }
    var note = el('log').querySelector('.pg-note');
    if (note) note.parentNode.removeChild(note);
    el('json').innerHTML = REQUEST_HTML;
    el('ask').style.visibility = '';
    el('throw').innerHTML = '';
    el('count').textContent = '0 calls';
    el('status').className = 'pg-status idle'; el('status').textContent = 'request';
    el('fill').style.width = '0'; el('fill').classList.remove('blocked');
    el('ghost').classList.remove('on'); el('ghost').style.width = '0';
    el('used').textContent = '0'; el('used').classList.remove('over');
    el('ceil').disabled = false; el('run').disabled = false; el('run').textContent = 'Run agent';
  }

  function step(){
    if (idx >= PLAN.length) { finish('done. the job stayed inside its budget.'); return }
    var name = PLAN[idx][0], units = PLAN[idx][1];
    var res = preflight({ agentId:'researcher', taskRef:TASK_REF,
                          taskCeiling:task.ceiling, estimatedUnits:units });

    // Convert the row that is already there. No append, no layout shift.
    var row = el('log').querySelector('.pg-row[data-i="' + idx + '"]');
    if (row) {
      row.className = 'pg-row ' + (res.approved ? 'ran' : 'blocked');
      row.querySelector('.ar').innerHTML = res.approved ? '&rarr;' : '&#10005;';
    }
    if (idx === 0) el('ask').style.visibility = 'hidden';
    el('json').innerHTML = paint(res);
    el('count').textContent = (idx+1) + (idx ? ' calls' : ' call');

    if (res.approved) {
      record(units); bars(null);
      el('status').className = 'pg-status ok'; el('status').textContent = '200 approved';
      idx++; timer = setTimeout(step, 620);
      return;
    }

    bars(units);
    el('status').className = 'pg-status no'; el('status').textContent = '200 refused';
    var note = document.createElement('div');
    note.className = 'pg-note';
    note.textContent = res.task_remaining_units + ' units left, this call asked for '
      + units + '. it never ran.';
    el('log').appendChild(note);
    // Rows the run never reached stay planned rather than going blank, so the
    // reader can see what the ceiling stopped as well as what it allowed.
    el('ask').style.visibility = 'hidden';
    el('throw').innerHTML = '<div class="pg-throw"><b>throw TaskCeilingExceededError</b>'
      + '<span>the SDK throws here, so the expensive call never starts</span></div>';
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
    el('ceilv').textContent = this.value;
    el('ceil2').textContent = this.value;
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
</script>`
