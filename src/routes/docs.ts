import { FastifyInstance } from 'fastify'
import { docsShell } from '../ui/docs.js'
import { publicRoute } from '../middleware/auth.js'
import { KEY_CTA } from '../ui/chrome.js'
import { byPath, ORIGIN } from '../ui/site.js'
import { softwareLd, sourceLd } from '../ui/ld.js'
import { CONTENT_CSS } from '../ui/content.js'
import { HISTORY_JOBS, HISTORY_AGENTS } from '../lib/ceiling-suggest.js'
import { RESERVATION_TTL_MINUTES } from '../lib/reservations.js'
import { CONSOLE_AGENT } from '../lib/task-ceiling.js'

// /docs carried no page-level structured data at all, while every guide under
// it emitted a TechArticle. It is the second-highest priority page in the
// registry and the one an answer engine reads to learn the integration, so the
// gap mattered more here than anywhere else.
//
// dateModified reads PAGES, which is also what the sitemap's lastmod reads, so
// the two cannot claim different things about one page. There is no
// datePublished: the registry has none for this page and inventing one would be
// a date nobody can check.
const docsMeta = byPath.get('/docs')

const docsArticleLd = {
  '@context': 'https://schema.org',
  '@type': 'TechArticle',
  '@id': `${ORIGIN}/docs#techarticle`,
  headline: 'AgentBill documentation',
  description:
    'Add a per-task spend ceiling to an AI agent: preflight before the call, record after, on units you define. Python and Node SDKs.',
  url: `${ORIGIN}/docs`,
  dateModified: docsMeta?.updated,
  inLanguage: 'en-US',
  proficiencyLevel: 'Beginner',
  author: { '@id': `${ORIGIN}/#organization` },
  publisher: { '@id': `${ORIGIN}/#organization` },
  isPartOf: { '@id': `${ORIGIN}/#website` },
  about: { '@id': `${ORIGIN}/#software` },
  hasPart: { '@id': `${ORIGIN}/docs#quickstart` },
}

// The three steps that are already on the page, and nothing else. Every `text`
// below is lifted from the rendered body: step 1 from the pre, steps 2 and 3
// from the paragraph under each heading. Structured steps a reader cannot see
// are a claim the page does not support, so if that copy changes this must
// change in the same commit. totalTime is PT2M because the visible h2 says
// "Quick Start, 2 minutes".
//
// Worth knowing before anyone counts on it: Google retired the HowTo rich
// result in 2023. This buys no carousel. What it buys is a machine-readable
// "here are the three steps" for an answer engine, which is what this page is
// most often read by.
const quickStartLd = {
  '@context': 'https://schema.org',
  '@type': 'HowTo',
  '@id': `${ORIGIN}/docs#quickstart`,
  name: 'Quick Start, 2 minutes',
  description:
    'Get an API key, give one job a ceiling before any code runs, then install the SDK and ask before each call until the job is refused.',
  totalTime: 'PT2M',
  inLanguage: 'en-US',
  isPartOf: { '@id': `${ORIGIN}/docs#techarticle` },
  supply: { '@type': 'HowToSupply', name: 'An AgentBill API key, free, no credit card' },
  tool: { '@type': 'HowToTool', name: 'agentbill-sdk for Python' },
  step: [
    {
      '@type': 'HowToStep',
      position: 1,
      name: 'Step 1, Get your API key',
      text: 'Sign up at agentbill.dev/register with Google, GitHub or an email link, free, no credit card. The console makes your key on its start screen. It starts with agb_, it is shown once and never emailed, and the screen hands you a filled-in export AGENTBILL_API_KEY= line to copy.',
      url: `${ORIGIN}/docs#step-api-key`,
    },
    {
      '@type': 'HowToStep',
      position: 2,
      name: 'Step 2, Give the job a ceiling',
      text: 'Name the job and say what it is worth, on the console start screen or with PUT /tasks/:task_ref/ceiling. No terminal yet: a preflight for a job that has no ceiling is a 422 task_ceiling_required, because there is nothing to check the call against. Every call carrying that name is checked against that one ceiling, whatever agent or tool made it.',
      url: `${ORIGIN}/docs#step-ceiling`,
    },
    {
      '@type': 'HowToStep',
      position: 3,
      name: 'Step 3, Install, then ask',
      text: 'pip install agentbill-sdk, on Python 3.9 or newer. Then call preflight before each expensive call, passing the job name and nothing about the budget, and record after it to settle. The call past the ceiling is refused and the SDK raises TaskCeilingExceededError.',
      url: `${ORIGIN}/docs#step-install`,
    },
  ],
}

export async function docsRoute(app: FastifyInstance) {
  app.get('/docs', publicRoute(), async (request, reply) => {
    return reply.type('text/html').send(docsShell({
      title: 'AgentBill Docs · Preflight Billing for AI Agents',
      description: 'AgentBill documentation. Add a per-task spend ceiling to your AI agent: preflight before the call, record after, on units you define. Python and Node SDKs.',
      path: '/docs',
      // This page used to carry og and twitter tags and no og:image at all, so
      // every share of the docs was a card with no art.
      og: { description: 'Add a per-task spend ceiling to your AI agent. Preflight before the call, record after. Python and Node SDKs.' },
      jsonLd: [docsArticleLd, quickStartLd, softwareLd(), ...sourceLd()],
      mainEntity: `${ORIGIN}/docs#techarticle`,
      // The body's canvas pieces (the plate for the run's printed output and
      // the two response bodies, parameter tables as cards, the Guides rows)
      // are CONTENT_CSS. The one page-local rule: the quick start's closing
      // line, which says "that is the whole integration", is a callout, the
      // homepage's note-that-belongs-to-the-page, so it reads as the end of
      // the sequence rather than as one more paragraph of it.
      css: `${CONTENT_CSS}
  p.closer { background: var(--callout-bg); border: 1px solid var(--callout-line);
             border-radius: var(--r-inner); padding: var(--s4) 20px; margin-block: var(--s5); }
`,
      body: `
  <h1>Documentation</h1>
  <p class="lede">Everything you need to add preflight billing to your agents.</p>

  <h2>Quick Start, 2 minutes</h2>

  <h3 id="step-api-key">Step 1, Get your API key</h3>
  <p>Sign up at <a href="/register">agentbill.dev/register</a> with Google, GitHub or a one-time link
  by email, free, no credit card. Signing in opens <a href="/app">the console</a>, and its start screen
  makes your key: it starts with <span class="inline">agb_</span>, it is shown once and never emailed,
  and the screen hands you a filled-in <span class="inline">export AGENTBILL_API_KEY=</span> line to
  copy. No key is issued before your address is verified.</p>

  <h3 id="step-ceiling">Step 2, Give the job a ceiling</h3>
  <p>Name the job and say what it is worth, on the console's start screen or with
  <a href="#put-task-ceiling">PUT /tasks/:task_ref/ceiling</a>. <strong>No terminal yet, and that
  order is the point:</strong> a preflight for a job that has no ceiling is a
  <span class="inline">422 task_ceiling_required</span>, because there is nothing to check the call
  against. Every call carrying that name is checked against that one ceiling, whatever agent or tool
  made it. It changes only through the console or the endpoint; a
  <span class="inline">task_ceiling</span> on a later preflight is not applied.</p>
  <p><strong>Keep the first ceiling small. Use 3.</strong> The sample below makes one call more than
  the ceiling allows, so its last call is refused, and that refusal is the thing worth seeing.</p>

  <h3 id="step-install">Step 3, Install, then ask</h3>
  <div class="code"><pre>python3 -m venv .venv
source .venv/bin/activate
pip install agentbill-sdk</pre></div>
  <p>Python 3.9 or newer. The last line on its own is enough wherever
  <span class="inline">pip</span> is on your path and the interpreter is not externally managed; all
  three work everywhere, which is why all three are printed here. On Windows the activate line is
  <span class="inline">.venv\\Scripts\\activate</span>.</p>

  <p>Save this as <span class="inline">first_run.py</span> and run it with
  <span class="inline">python3 first_run.py</span>. It reads the key from the environment, so the
  export line from step 1 has to have run in the same shell.</p>
  <div class="code"><pre>
import os
from agentbill import AgentBillClient, TaskCeilingExceededError

key = os.environ["AGENTBILL_API_KEY"]
client = AgentBillClient(api_key=key)

try:
    <span class="comment"># one call more than the ceiling of 3</span>
    for _ in range(4):
        result = client.preflight(
            agent_id="researcher",
            task_ref="job-1",
        )
        print("approved:", result.approved,
              "units left:", result.task_remaining_units)
        <span class="comment"># your model call runs here</span>
        client.record(
            agent_id="researcher",
            task_ref="job-1",
            units=1,
        )
except TaskCeilingExceededError as refused:
    print(refused)</pre></div>

  <p>Three lines approve and count down, and the fourth is the answer this page exists for:</p>
  <pre class="cv-code ct-out">
<span class="out-ok">approved: True units left: 2</span>
<span class="out-ok">approved: True units left: 1</span>
<span class="out-ok">approved: True units left: 0</span>
<span class="out-no">Refused (task_ceiling_exceeded): task 'job-1' is at 3/3 units and 0 remaining is not enough for this call.</span></pre>

  <p>Nothing of ours reached into the run. The SDK raised, your code caught it, and what happens next
  is yours. The refusal is also written down: the console's
  <a href="/app">refusals view</a> carries the literal body your code received.</p>

  <p class="closer">That is the whole integration. <span class="inline">agent_id</span> is a label the
  console groups by; the ceiling is on the task, not on the agent. Run it a second time and the first
  call is refused, because the job spent 3 of 3 and a job ceiling has no clock to reset it: raise the
  ceiling or use a new name. New to it, or something did not run?
  <a href="/docs/first-run">Every setup failure, and its fix</a>. The free tier is 1,000 preflight
  calls per month, per account.</p>

  <p>A call that passes no <span class="inline">customer_id</span> draws on a customer named
  <span class="inline">default</span>. A customer starts with no limit, so until you set one the task
  ceiling is the only thing that refuses, and <span class="inline">remaining_units</span> in the
  preflight body is <span class="inline">null</span>. <a href="#put-budget">PUT /budget</a> gives a
  customer a ceiling in units; past it, preflight refuses with
  <span class="inline">budget_exhausted</span> and the SDK raises
  <span class="inline">BudgetExhaustedError</span>. That balance never resets on its own.</p>

  <h2>Core Concepts</h2>

  <h3>Preflight</h3>
  <p>Consulted before your provider call goes out. If the units already used plus this call's estimate would cross the ceiling, preflight answers <code class="inline">approved: false</code> and the SDK raises. It answers on the units your code sends or, under <a href="#wrap">wrap()</a>, on tokens; it does not read your provider bill and cannot know what the refused call would have cost.</p>

  <h3>Record</h3>
  <p>Logs actual usage after a successful run. Idempotent per <code class="inline">idempotency_key</code>: /events dedupes on it. Both SDKs send a fresh key for each call unless you pass <code class="inline">idempotency_key</code>, so a retried record() without one is a second event: pass the same key on the retry. <a href="#wrap">wrap()</a> passes the provider's response id.</p>

  <h3>Per-task ceiling</h3>
  <p>One job, one ceiling, held across every call and every tool that passes the same
  <span class="inline">task_ref</span>. This is the one that is not bound to a calendar month and not
  to an identity, and that is the whole point: a budget that resets tomorrow refuses nothing the
  loop is doing tonight.</p>

  <p>Give the job its ceiling before the code runs, on the console's task budgets view or with
  <a href="#put-task-ceiling">PUT /tasks/:task_ref/ceiling</a>; after that every call carries
  <span class="inline">task_ref</span> and nothing about the budget. Opening it from code also works,
  as the alternate: pass <span class="inline">task_ceiling</span> on the first preflight of a new
  <span class="inline">task_ref</span>. A preflight for a job that does not exist yet, sent without a ceiling, is rejected with
  <span class="inline">task_ceiling_required</span>. Once the job exists, a
  <span class="inline">task_ceiling</span> on preflight is not applied, so a retry cannot raise the
  ceiling it was supposed to respect; the last save through the console or the endpoint is the
  ceiling in force. An approved answer and a <span class="inline">task_ceiling_exceeded</span> refusal
  carry it as <span class="inline">task_ceiling</span> in the HTTP body (the other refusals are decided
  before the job's row is consulted; the SDK result objects expose it in a later SDK release). When the units already used
  plus this call's estimate would cross it, preflight answers <span class="inline">approved: false</span>
  with <span class="inline">task_ceiling_exceeded</span> and the SDK raises.</p>

  <div class="code"><pre>
from agentbill import AgentBillClient, TaskCeilingExceededError

client = AgentBillClient(api_key="agb_your_key")

<span class="comment"># job-142 has a ceiling of 500, set in the console. Researcher takes 300 of it.</span>
client.preflight(agent_id="researcher", task_ref="job-142", estimated_units=300)

try:
    <span class="comment"># A different agent, same job: 300 + 250 &gt; 500, refused before it runs.</span>
    client.preflight(agent_id="writer", task_ref="job-142", estimated_units=250)
except TaskCeilingExceededError as e:
    print(f"task {e.task_ref} hit its ceiling")</pre></div>

  <p>Note which identifier is doing the work there. <span class="inline">agent_id</span> is a label
  for attribution and carries no budget of its own; two different agents that share a
  <span class="inline">task_ref</span> share one ceiling. The job is what costs money, not the agent.</p>

  <h3 id="ceiling-suggestion">How the suggestion is computed</h3>

  <p>Not sure what a job needs? The task budgets view suggests a ceiling from your own history.
  For at most ${HISTORY_AGENTS} agents, those whose latest finished jobs are the most recent, it
  shows the p50, p90 and max <span class="inline">used_units</span> of each one's ${HISTORY_JOBS}
  most recently updated finished jobs, so every figure is one real job's total. Pick one and
  it goes in the ceiling field with that agent's label, still editable, and nothing is saved until
  you press Set ceiling. Any other agent, including one with no finished job, gets no suggestion.</p>

  <p>Finished means the job has spent units and holds no reservation:
  <span class="inline">used_units</span> above 0 and <span class="inline">reserved_units</span> 0.
  No event marks a job as done, so a job resting between two calls counts, and a call still in
  flight keeps its job out until it records, or, if it never does, until its reservation expires
  after ${RESERVATION_TTL_MINUTES} minutes and a sweep releases it. A job refused at its ceiling
  counts at what it spent. Jobs with the placeholder label
  <span class="inline">${CONSOLE_AGENT}</span>, the one a job carries until an approved call names
  an agent, are left out.</p>

  <h3>Per-request ceiling</h3>
  <p>Refuse any single call that would consume more than a set number of units. Set <span class="inline">ceiling=N</span> on the client; if <span class="inline">estimated_units</span> exceeds it, the call is refused before it goes out and <span class="inline">CeilingExceededError</span> is raised. This one caps a call, not a job: it is a sanity check on a bad estimate, not the cross-call ceiling above.</p>

  <div class="code"><pre>
<span class="comment"># No single call may cost more than 20 units.</span>
client = AgentBillClient(api_key="agb_your_key", ceiling=20)

client.preflight(
    agent_id="researcher",
    customer_id="user_123",
    estimated_units=50,  <span class="comment"># 50 &gt; 20: raises CeilingExceededError, nothing runs</span>
)</pre></div>

  <h2 id="reservation">The reservation</h2>

  <p>Preflight does not read your balance and then decide. It takes the budget in the same
  statement that checks it:</p>

  <div class="code"><pre>
UPDATE customers
SET reserved_units = reserved_units + :units
WHERE account_id = :account
  AND customer_ref = :customer
  AND (limit_units IS NULL
       OR used_units + reserved_units + :units &lt;= limit_units)</pre></div>

  <p>Zero rows back means the budget is gone, and nothing was taken. The task ceiling reserves the
  same way against <span class="inline">task_budgets</span>, scoped to your
  <span class="inline">task_ref</span>. Both happen in one transaction with the monthly quota, so a
  rejected call reserves nothing and burns no quota.</p>

  <p>This matters for one reason. Read the balance, compare it in your process, then act, and ten
  parallel calls read the same remaining number and all ten pass. The budget is already spent by the
  time the eleventh is refused. Putting the condition in the <span class="inline">WHERE</span>
  clause is what makes that impossible.</p>

  <p>So the counter cannot go below zero. Not "usually", not "we alert you". The database refuses
  the write.</p>

  <p><strong>A ceiling that can go negative is not a ceiling.</strong> It is an invoice line you
  read afterwards. On the revenue side an overage is billable, so letting a balance overshoot is a
  reasonable design. On your side the overage is money already spent, and there is nobody to bill
  it to.</p>

  <h3>Reservations expire</h3>

  <p>Each reservation is a row with a TTL, returned to you as
  <span class="inline">reservation_expires_at</span> on every approved preflight. Default is 60
  minutes, set <span class="inline">RESERVATION_TTL_MINUTES</span> to change it. If
  <span class="inline">record()</span> never arrives, a sweeper reclaims the units. Every approved
  preflight also returns <span class="inline">reservation_id</span>: a record over HTTP that passes it
  back closes that reservation whole and releases what it held beyond the units recorded. Without it,
  settling closes reservation rows FIFO by the units passed. Both decrement by what the closed rows
  actually held, not by what you passed, so a late settle after a sweep cannot release the same units
  twice.</p>

  <p>Note which way this fails. An abandoned reservation makes your ceiling <em>tighter</em>, never
  looser. The gate does not open by accident.
  <a href="/blog/how-preflight-avoids-double-billing">Full walkthrough of the concurrency design</a>.</p>

  <h3>What the reservation is not</h3>

  <p>It is not a measurement. The number reserved is an estimate made before the call: the
  <span class="inline">estimated_units</span> you passed or, under <a href="#wrap">wrap()</a>, the
  job's running average in tokens. <span class="inline">record()</span> settles with what the call
  used: the number you pass or, under <span class="inline">wrap()</span>, the token count your
  provider reported on the response your process received. AgentBill's server never calls your
  provider and holds no credential for it, and it never sees your GPU or your tool calls: those
  count only if your code records them. In a job counted in units, a unit is an integer you
  define.</p>

  <p>What you get is ordering and arithmetic that hold under concurrent load: the ceiling is
  consulted before the work starts, and what is reserved across every call sharing a
  <span class="inline">task_ref</span> cannot exceed it. A call that used more than it reserved
  still records what it used, so a job can land past its ceiling by that call, and the record
  says so with <span class="inline">task_exceeded</span>. What you do not get is an opinion about
  what a call was worth. That number is yours, or your provider's.</p>

  <h2 id="wrap">Automatic metering with wrap()</h2>

  <p>Wrap your model client once, and every call it makes through the methods below is measured
  from the usage your provider already returned on the response: before the call it asks the job
  whether it still has room, after it records the tokens. You pass no estimate and record no
  number. The call still goes from your process straight to your provider: no proxy, no base URL
  to change, and AgentBill never sees your prompt, the answer or your provider account. What it
  receives is the provider's name, the model, the token counts, how long the call took and the
  step you named.</p>

  <h3 id="wrap-python">Python</h3>
  <div class="code"><pre>pip install -U agentbill-sdk openai</pre></div>
  <div class="code"><pre>
from openai import OpenAI
from agentbill import wrap, Refusal

<span class="comment"># Reads AGENTBILL_API_KEY; OpenAI() reads OPENAI_API_KEY. The job is counted</span>
<span class="comment"># in tokens, and task_ceiling opens it on the call that creates it.</span>
llm = wrap(OpenAI(), task_ref="tokens-1", agent_id="researcher",
           task_ceiling=50_000)

questions = ["What is a job ceiling?", "Name one use for it.", "And one limit."]
for q in questions:
    reply = llm.chat.completions.create(
        model="gpt-4o-mini",
        max_tokens=300,
        messages=[{"role": "user", "content": q}],
    )
    if isinstance(reply, Refusal):
        <span class="comment"># The call that would have passed the ceiling was not sent. Nothing</span>
        <span class="comment"># is raised: reply.reason, reply.used, reply.ceiling, reply.remaining.</span>
        print(reply)
        break
    print(reply.choices[0].message.content)
  </pre></div>

  <p>The same job across providers, one step each. <span class="inline">wrap()</span> on a
  wrapped client gives another view of it with a different step, sharing the job's running
  average:</p>
  <div class="code"><pre>
from anthropic import Anthropic
from google import genai
from agentbill import wrap

claude = wrap(Anthropic(), task_ref="tokens-1", agent_id="writer", step="draft")
gemini = wrap(genai.Client(), task_ref="tokens-1", agent_id="checker", step="check")

draft = claude.messages.create(model="claude-sonnet-4-5", max_tokens=500,
                               messages=[{"role": "user", "content": "One line on job ceilings."}])
check = gemini.models.generate_content(model="gemini-2.5-flash",
                                       contents="Is this clear? " + draft.content[0].text)
print(check.text)
  </pre></div>

  <h3 id="wrap-node">Node</h3>
  <div class="code"><pre>npm install agentbill openai</pre></div>
  <div class="code"><pre>
import OpenAI from 'openai'
import { wrap, isRefusal } from 'agentbill'

<span class="comment">// Reads AGENTBILL_API_KEY; new OpenAI() reads OPENAI_API_KEY.</span>
const llm = wrap(new OpenAI(), { taskRef: 'tokens-1', agentId: 'researcher', taskCeiling: 50_000 })

const stream = await llm.chat.completions.create({
  model: 'gpt-4o-mini', max_tokens: 300, stream: true,
  messages: [{ role: 'user', content: 'What is a job ceiling?' }],
})
if (isRefusal(stream)) {
  <span class="comment">// The call was not sent, and nothing is thrown: stream.reason, stream.used,</span>
  <span class="comment">// stream.ceiling, stream.remaining. A refused stream iterates to nothing.</span>
  console.log(String(stream))
} else {
  for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? '')
}
  </pre></div>

  <h3 id="wrap-what">What is measured, and what is not</h3>
  <table>
    <tr><th>Provider</th><th>Measured methods</th><th>Usage read from the response</th></tr>
    <tr><td>OpenAI</td><td>chat.completions.create, responses.create</td><td>input (cache reads and cache writes apart), output, reasoning. A streamed Chat Completions call gets <span class="inline">stream_options.include_usage</span> turned on, and the usage-only chunk that adds is kept out of your loop. One you set yourself is left as you set it.</td></tr>
    <tr><td>Anthropic</td><td>messages.create</td><td>input, cache reads, cache writes (five-minute and one-hour apart), output.</td></tr>
    <tr><td>Gemini (google-genai)</td><td>models.generate_content, models.generate_content_stream; in Python also aio.models</td><td>prompt (cached apart), candidates plus thoughts as output: Gemini reports thinking outside candidates. With automatic function calling (a Python function or a CallableTool in <span class="inline">tools</span>) one call sends a model request per round and returns only the last round's usage, so each round is measured as its own call, with its own preflight and record.</td></tr>
  </table>

  <ul>
    <li><strong>Only wrapped calls are measured.</strong> A call through a client you did not wrap,
    or through a method not in the table (a stream helper, a raw-response call), is not counted.
    A tool call, a GPU run or a vector search counts only if your code records it with the same
    <span class="inline">task_ref</span>.</li>
    <li><strong>The estimate.</strong> Before the first measured call of the job in your process,
    preflight reserves <span class="inline">default_estimate</span> (2,000 tokens unless you set
    it); after, the job's running average per call, and never more than the average prompt plus
    the call's own <span class="inline">max_tokens</span> when it sets one. The prompt is not
    counted before the call, and no request is added. The record then charges what the provider reported, so one call can pass the
    ceiling when the estimate was low: at most that one call for each caller running at the same
    moment, and the next preflight is refused. That bound holds while preflight checks the ceiling;
    see the quota below for the one state where it does not.</li>
    <li><strong>Missing usage is recorded as missing, never as 0.</strong> The call is charged at
    least what it reserved, and counted in <span class="inline">usage_missing_calls</span>.</li>
    <li><strong>The job is counted in tokens.</strong> Open it with
    <span class="inline">task_ceiling</span> on <span class="inline">wrap()</span>, or with
    <a href="#put-task-ceiling">PUT /tasks/:task_ref/ceiling</a> and
    <span class="inline">"unit": "token"</span>. A job opened in units answers
    <span class="inline">422 task_unit_mismatch</span>, and the call is not sent. A customer limit
    set with <a href="#put-budget">PUT /budget</a> counts whatever that customer's calls send, so
    under <span class="inline">wrap()</span> it counts tokens.</li>
    <li><strong>A refusal is returned, and your code decides.</strong> The measured call's value
    is a <span class="inline">Refusal</span> (Python: <span class="inline">isinstance(reply, Refusal)</span>,
    Node: <span class="inline">isRefusal(reply)</span>) with <span class="inline">approved</span>
    false, <span class="inline">reason</span>, <span class="inline">task_ref</span>,
    <span class="inline">asked</span>, <span class="inline">used</span>,
    <span class="inline">ceiling</span>, <span class="inline">remaining</span> and
    <span class="inline">answer</span>, the preflight answer whole. It is not shaped like a provider
    response: no <span class="inline">choices</span>, <span class="inline">content</span>,
    <span class="inline">candidates</span> or <span class="inline">usage</span>. A refused streaming
    call returns the same <span class="inline">Refusal</span>, which iterates to nothing; the one
    stream that can be refused after it started, a Gemini automatic-function-calling stream whose
    later round is refused, ends after the earlier round's chunks and sets its
    <span class="inline">refusal</span>. Nothing is raised for a refusal. An exception out of a
    wrapped call is a failure: the provider's own error, or from AgentBill a network error, a 401
    or a 5xx. A provider error releases the call's reservation. A record that fails after the
    provider answered never loses the answer. <span class="inline">preflight()</span> and
    <span class="inline">record()</span> on the plain client are not changed by this:
    <span class="inline">preflight()</span> still raises
    <span class="inline">TaskCeilingExceededError</span> on a ceiling refusal and returns on the
    quota.</li>
    <li><strong>Each measured call is one preflight</strong>, so it uses one preflight of your
    account's monthly quota. Once that quota is spent, preflight answers before it looks at the job
    and no ceiling can be checked. So by default the wrapped call returns a
    <span class="inline">Refusal</span> with reason
    <span class="inline">free_tier_exceeded</span> or
    <span class="inline">plan_limit_exceeded</span> and the upgrade link, and is not sent. With
    <span class="inline">on_quota="send"</span> (Node: <span class="inline">onQuota: 'send'</span>)
    it is sent unchecked and recorded, with a warning once per job, and nothing bounds the job
    until the quota resets or you upgrade.</li>
    <li>A client pointed at another host (Azure, a proxy, an OpenAI-compatible server) is
    recorded as <span class="inline">openai-compatible</span> and gets no list price. Its records
    are keyed by a random key, not the response id, because such a server's ids need not be
    unique. In Node the
    wrapped create returns a plain Promise, without the SDK's <span class="inline">withResponse()</span>.</li>
  </ul>

  <h3 id="wrap-breakdown">What the job cost, by model and by step</h3>
  <p><span class="inline">GET /tasks/:task_ref</span> carries a <span class="inline">breakdown</span>
  beside the job's numbers (the SDKs' <span class="inline">get_task</span> and
  <span class="inline">getTask</span> return it as it is):</p>
  <div class="code"><pre>
{
  "calls": 4, "units": 4100, "unattributed_units": 0,
  "list_price_usd_estimate": 0.00066,
  "priced_calls": 3, "unpriced_calls": 1,
  "price_versions": ["litellm-ccee9e7-2026-09-23"],
  "by_model": [
    { "provider": "openai", "model": "gpt-4o-mini-2024-07-18", "calls": 3, "units": 2900,
      "tokens": { "input": 2400, "cache_read": 0, "cache_write": 0, "cache_write_1h": 0, "output": 500, "reasoning": 0 },
      "list_price_usd_estimate": 0.00066, "unpriced_calls": 0, "unpriced_reasons": [] },
    { "provider": "openai", "model": "my-finetune", "calls": 1, "units": 1200,
      "list_price_usd_estimate": null, "unpriced_calls": 1,
      "unpriced_reasons": ["no list price for my-finetune"] }
  ],
  "by_step": [ { "step": "draft", "calls": 4, "units": 4100, "list_price_usd_estimate": 0.00066,
                "unpriced_calls": 1 } ]
}
  </pre></div>
  <p><span class="inline">list_price_usd_estimate</span> is an estimate at public list price, from
  a dated snapshot of the LiteLLM price table that <span class="inline">price_versions</span>
  names, priced per token type, with the long-context and service-tier rates where the table has
  them. List price, your invoice may differ: contract discounts, batch and regional pricing, and
  server-side tool fees are not in it. A call with no list price says why in
  <span class="inline">unpriced_reasons</span> and is left out of the estimate; it is never counted
  as $0, and a row where nothing is priced shows <span class="inline">null</span>. The ceiling
  itself is in tokens. <span class="inline">unattributed_units</span> is what the job spent
  through records made before events carried the job's name.</p>

  <h2>API Reference</h2>

  <h3>preflight()</h3>
  <table>
    <tr><th>Parameter</th><th>Type</th><th>Description</th></tr>
    <tr><td>agent_id</td><td>string</td><td>A label for attribution, not a budget. Every task and every refusal in the console carries it, and nothing is capped by it.</td></tr>
    <tr><td>customer_id</td><td>string <span class="tag">optional</span></td><td>Your internal customer ID. Defaults to "default". A customer starts with no limit; set one with <a href="#put-budget">PUT /budget</a>.</td></tr>
    <tr><td>estimated_units</td><td>int <span class="tag">optional</span></td><td>Expected units for this run. Used for ceiling check. Default: 1.</td></tr>
    <tr><td>ceiling</td><td>int <span class="tag">optional, on AgentBillClient(...)</span></td><td>Set on the client, not per call: every preflight is refused if estimated_units exceeds it.</td></tr>
    <tr><td>task_ref</td><td>string <span class="tag">optional</span></td><td>Groups many calls under one cross-call budget. Pass the same task_ref on every call in the job. See <a href="/docs/task-budgets">task budgets</a>.</td></tr>
    <tr><td>task_ceiling</td><td>int <span class="tag">optional</span></td><td>The alternate way to open a job: a first preflight of a new task_ref that carries task_ceiling opens it with that ceiling. The default is to open the job first in the console or with <a href="#put-task-ceiling">PUT /tasks/:task_ref/ceiling</a>, after which the call needs task_ref only. Not applied once the job exists; an approved answer and a task_ceiling_exceeded refusal carry the ceiling in force as task_ceiling.</td></tr>
  </table>

  <p>Every identifier above (agent_id, customer_id, task_ref, and idempotency_key) is 1 to 128 characters and may not contain control characters. A value that breaks either rule is a 422 with <span class="inline">validation_error</span>, never a 500.</p>

  <p>Returns, for a call on a job that has a ceiling:</p>
  <pre class="cv-code ct-out">
{
  "approved": true,
  "reason": null,
  "estimated_units": 12,
  "remaining_units": null,
  "reservation_expires_at": "2026-09-11T12:00:00.000Z",
  "reservation_id": "3f1c2b7a-8d4e-4b1a-9c2d-5e6f7a8b9c0d",
  "task_ref": "job-142",
  "task_ceiling": 500,
  "task_remaining_units": 488
}</pre>

  <p><strong>Two scopes, two names.</strong> <span class="inline">remaining_units</span> is the
  customer's balance, and it is <span class="inline">null</span> while the customer has no limit,
  which is the default. <span class="inline">task_remaining_units</span> is the job's, and it is the
  one that counts down under a task ceiling. On <span class="inline">GET /tasks</span> the job's own
  balance is called <span class="inline">remaining_units</span>, because that endpoint has only the one
  scope, and <span class="inline">exceeded</span> there is true only when a record landed past the
  ceiling after the fact: a job at its ceiling with nothing leaked reads
  <span class="inline">remaining_units: 0</span> and <span class="inline">exceeded: false</span>, and
  its next preflight is refused.</p>

  <p>When refused:</p>
  <pre class="cv-code ct-out">
{
  <span class="no">"approved": false</span>,
<span class="comment"># plan_limit_exceeded on a paid plan. budget_exhausted and the</span>
<span class="comment"># ceiling refusals carry no upgrade_url.</span>
  "reason": "free_tier_exceeded",
  "plan": "free",
  "monthly_calls": 1000,
  "plan_limit": 1000,
  "upgrade_url": "https://agentbill.dev/pricing?account_id=acc_..."
}</pre>

  <p>That is the raw HTTP shape. Both SDKs then apply one rule to it, and it is the same rule in
  Python and Node: they <strong>raise when your own spend rule refused the call</strong>
  (<span class="inline">ceiling_exceeded</span>, <span class="inline">task_ceiling_exceeded</span>,
  <span class="inline">budget_exhausted</span>) and <strong>return the result when the refusal is
  AgentBill's own quota</strong> (<span class="inline">free_tier_exceeded</span>,
  <span class="inline">plan_limit_exceeded</span>), with
  <span class="inline">upgrade_url</span> set. Our quota running out must never crash your agent.
  Under <a href="#wrap">wrap()</a> nothing is raised for a refusal: every one, the quota included,
  comes back as a returned <span class="inline">Refusal</span>, because once the quota is spent no
  ceiling can be checked; <span class="inline">on_quota="send"</span> sends the call unchecked
  instead. <span class="inline">preflight()</span> itself is unchanged.</p>

  <h3>record()</h3>
  <table>
    <tr><th>Parameter</th><th>Type</th><th>Description</th></tr>
    <tr><td>agent_id</td><td>string</td><td>The same attribution label you passed to preflight.</td></tr>
    <tr><td>units</td><td>int <span class="tag">optional</span></td><td>Units consumed by this run. Default: 1. 0 is allowed: a call that ran and cost nothing.</td></tr>
    <tr><td>customer_id</td><td>string <span class="tag">optional</span></td><td>Your internal customer ID. Defaults to "default". A customer starts with no limit; set one with <a href="#put-budget">PUT /budget</a>.</td></tr>
    <tr><td>task_ref</td><td>string <span class="tag">optional</span></td><td>Settles against that task's ceiling. Pass the same one you preflighted with, or the units stay reserved until the reservation expires.</td></tr>
    <tr><td>success</td><td>bool <span class="tag">optional</span></td><td>false releases the preflight reservation without billing. Default: true.</td></tr>
    <tr><td>reservation_id</td><td>string <span class="tag">optional</span></td><td>The one preflight returned. That reservation closes whole: units is what was spent, and the rest it held is released now. Without it, the record closes the oldest reservations of this customer and task FIFO by units. result.record(...) passes it for you.</td></tr>
    <tr><td>idempotency_key</td><td>string <span class="tag">optional</span></td><td>Same key, one event. A fresh one is sent when you leave it out.</td></tr>
    <tr><td>metadata</td><td>object <span class="tag">optional</span></td><td>Stored on the event, never counted. At most 8 KB as JSON and 32 keys; more is a 422. provider, model and tokens in the shape <a href="#wrap">wrap()</a> writes are priced at list price for the job's <a href="#wrap-breakdown">breakdown</a>.</td></tr>
    <tr><td>usage_missing</td><td>bool <span class="tag">optional</span></td><td>The provider reported no usage. Not read as 0: the call is charged at least the reservation it settles, and counted in usage_missing_calls.</td></tr>
  </table>

  <h3 id="put-task-ceiling">PUT /tasks/:task_ref/ceiling</h3>
  <p>Opens a job with a ceiling, or changes the ceiling of one that exists. The same write the
  console's task budgets view makes. The last save through the endpoint or the console is the ceiling in force; a task_ceiling sent on a later preflight is not applied. An approved
  answer and a <span class="inline">task_ceiling_exceeded</span> refusal carry the ceiling in force as
  <span class="inline">task_ceiling</span>.</p>

  <div class="code"><pre>
curl -X PUT https://agentbill.dev/tasks/job-142/ceiling \\
  -H "Authorization: Bearer agb_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{"ceiling_units":500,"agent_id":"researcher"}'

<span class="comment"># {"task_ref":"job-142","agent_id":"researcher","ceiling_units":500,"used_units":0,</span>
<span class="comment">#  "reserved_units":0,"remaining_units":500,"exceeded":false,...,"task_created":true}</span></pre></div>

  <p><span class="inline">ceiling_units</span> is a positive integer and is required.
  <span class="inline">agent_id</span> is optional and is read only when this call opens the job; an
  existing job keeps the agent that opened it.</p>

  <p>A ceiling cannot go under what the job has already spent plus what is reserved by calls in
  flight. That answers <span class="inline">409 ceiling_below_committed</span> with
  <span class="inline">minimum_ceiling_units</span>, the smallest value that would be accepted.
  Nothing is clamped and nothing in flight is rewritten: each reservation settles through
  <span class="inline">record()</span> or expires, and the next preflight reads the new ceiling.</p>

  <h3 id="get-tasks">GET /tasks</h3>
  <p>Lists this account's jobs, each with the fields <span class="inline">GET /tasks/:task_ref</span>
  returns: <span class="inline">ceiling_units</span>, <span class="inline">used_units</span>,
  <span class="inline">reserved_units</span>, <span class="inline">remaining_units</span>,
  <span class="inline">exceeded</span>, <span class="inline">created_at</span> and
  <span class="inline">updated_at</span>.</p>
  <table>
    <tr><th>Parameter</th><th>Type</th><th>Description</th></tr>
    <tr><td>agent_id</td><td>string <span class="tag">optional</span></td><td>Only the jobs that carry this agent label.</td></tr>
    <tr><td>limit</td><td>int <span class="tag">optional</span></td><td>1 to 200. Default: 50.</td></tr>
    <tr><td>sort</td><td>string <span class="tag">optional</span></td><td><span class="inline">created</span> (the default): newest job first. <span class="inline">used</span>: the most <span class="inline">used_units</span> first, ties newest first, in the units your code reported. Any other value is a 422.</td></tr>
  </table>

  <div class="code"><pre>
curl "https://agentbill.dev/tasks?sort=used&amp;limit=5" \\
  -H "Authorization: Bearer agb_your_key"
  </pre></div>

  <h3 id="get-usage">GET /usage</h3>
  <p>The units your code recorded over a window, split by the <span class="inline">event_type</span>
  each record carried, heaviest first. It counts the units your code reported and nothing else.
  <span class="inline">record()</span> in both SDKs sends its <span class="inline">agent_id</span> as
  the <span class="inline">event_type</span>, so for those calls this is a split by agent;
  <span class="inline">meter()</span> and a direct <span class="inline">POST /events</span> carry the
  event name your code passed. The console's activity view shows the same split.</p>
  <table>
    <tr><th>Parameter</th><th>Type</th><th>Description</th></tr>
    <tr><td>by</td><td>string</td><td>Required. <span class="inline">event_type</span>, the one split there is.</td></tr>
    <tr><td>days</td><td>int <span class="tag">optional</span></td><td>1 to 90 calendar days, today included. Default: 30.</td></tr>
    <tr><td>limit</td><td>int <span class="tag">optional</span></td><td>1 to 200 groups. Default: 50. The totals always cover the whole window.</td></tr>
  </table>

  <div class="code"><pre>
curl "https://agentbill.dev/usage?by=event_type&amp;days=7" \\
  -H "Authorization: Bearer agb_your_key"

<span class="comment"># {"by":"event_type","days":7,"since":"2026-09-17",</span>
<span class="comment">#  "total_units":1200,"total_events":41,"group_count":3,"groups":[</span>
<span class="comment">#   {"event_type":"crawler","units":600,"events":12,"share":0.5},</span>
<span class="comment">#   {"event_type":"researcher","units":360,"events":9,"share":0.3},</span>
<span class="comment">#   {"event_type":"summarizer","units":240,"events":20,"share":0.2}]}</span>
  </pre></div>

  <p><span class="inline">share</span> is a fraction of <span class="inline">total_units</span>, to four
  places. <span class="inline">group_count</span> is how many event_types the window holds, so a
  response with fewer groups than that was cut by <span class="inline">limit</span>.</p>

  <h3 id="put-budget">PUT /budget</h3>
  <p>Sets one customer's ceiling, and creates that customer if it has never been seen. The per-request
  ceiling is an argument to <span class="inline">preflight()</span> and has no endpoint.</p>

  <div class="code"><pre>
curl -X PUT https://agentbill.dev/budget \\
  -H "Authorization: Bearer agb_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{"customer_id":"user_123","limit_units":5000}'

<span class="comment"># {"customer_id":"user_123","customer_created":false,"limit":5000,</span>
<span class="comment">#  "used":1200,"reserved":40,"remaining":3760,"is_blocked":false}</span></pre></div>

  <p><span class="inline">limit_units</span> is required and may be <span class="inline">null</span>,
  which means no limit. It is never optional: a body that left it out would have to mean "change
  nothing", and a write that silently does nothing is how a typo looks like a success.</p>

  <p>It is a ceiling, not a balance, so it may be set <em>below</em> what that customer has already
  used and reserved. Nothing is rewritten to fit, no counter goes negative, and the customer is
  simply refused with <span class="inline">budget_exhausted</span> until the open reservations settle
  or expire. Raising it again releases them on the next call, with no repair step.</p>

  <h3 id="webhook-config">POST /webhook-config</h3>
  <p>Sets the one URL this account's anomaly alerts go to. <span class="inline">POST /step</span>
  flags a step whose units are more than twice the average of that agent_id and step_name, and
  posts an <span class="inline">anomaly.detected</span> payload to this URL.</p>

  <div class="code"><pre>
curl -X POST https://agentbill.dev/webhook-config \\
  -H "Authorization: Bearer agb_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://hooks.example.com/agentbill"}'

<span class="comment"># {"webhook_url":"https://hooks.example.com/agentbill",</span>
<span class="comment">#  "signing_secret":"whsec_...","signature_header":"X-AgentBill-Signature"}</span></pre></div>

  <p>The URL must be <span class="inline">https</span> on a public address. It is refused with
  <span class="inline">422 webhook_url_refused</span> when its host is, or resolves to, a loopback,
  private, link-local, carrier-grade NAT or unique-local address, or is a name like
  <span class="inline">localhost</span> or one ending in <span class="inline">.internal</span> or
  <span class="inline">.local</span>. The same check runs again on the address actually dialled at
  send time. A delivery is one POST with a five-second timeout; a redirect is not followed.</p>

  <p><span class="inline">signing_secret</span> is shown once, in this response. Saving the URL again
  issues a new one. Every delivery carries
  <span class="inline">X-AgentBill-Signature: t=&lt;unix seconds&gt;,v1=&lt;hex&gt;</span>, where the
  hex is the HMAC-SHA256 of <span class="inline">&lt;t&gt;.&lt;raw body&gt;</span> keyed by that secret.
  Check it against the raw body before you parse it, and refuse an old <span class="inline">t</span>:</p>

  <div class="code"><pre>
import { createHmac, timingSafeEqual } from 'node:crypto'

<span class="comment">// header: the X-AgentBill-Signature value. body: the raw request body, as a string.</span>
export function verifyAgentBill(header: string, body: string, secret: string, maxAgeSeconds = 300): boolean {
  const m = /^t=(\\d+),v1=([0-9a-f]{64})$/.exec(header)
  if (!m) return false
  if (Math.abs(Date.now() / 1000 - Number(m[1])) > maxAgeSeconds) return false
  const expected = createHmac('sha256', secret).update(m[1] + '.' + body).digest('hex')
  return timingSafeEqual(Buffer.from(expected), Buffer.from(m[2]))
}</pre></div>

  <p>A URL saved before signing existed has no secret, and its deliveries go out unsigned until it
  is saved again.</p>

  <h2 id="security">Security</h2>
  <p>How to report a vulnerability, what the SDKs send and what they never send, and how to revoke
  a key that leaked: <a href="/security">agentbill.dev/security</a>.</p>

  <h2>Node.js</h2>
  <div class="code"><pre>npm install agentbill</pre></div>
  <p>The package is ESM and the sample below uses a top-level
  <span class="inline">await</span>, which is the caller's file, not the dependency: saved as
  <span class="inline">.js</span> in a project with no module type it fails with
  <span class="inline">Cannot use import statement outside a module</span> before any of it runs.
  Save it as <span class="inline">first-run.mjs</span>, or put
  <span class="inline">"type": "module"</span> in your package.json. The key is read from
  <span class="inline">AGENTBILL_API_KEY</span> and there is no argument for it: the Node SDK exports
  functions rather than a client object, so on a host with no shell, set the variable in the
  platform's own config or call the endpoint with an
  <span class="inline">Authorization: Bearer</span> header.</p>
  <div class="code"><pre>
<span class="comment">// Reads AGENTBILL_API_KEY from the environment. Units are yours to define.</span>
import { preflight, record, TaskCeilingExceededError } from 'agentbill'

<span class="comment">// job-142 already has its ceiling, set in the console. Before each call,</span>
<span class="comment">// name the job and what this call is worth, and nothing about the budget.</span>
<span class="comment">// A refused call throws TaskCeilingExceededError, so the expensive work never starts.</span>
await preflight({ agentId: 'researcher', taskRef: 'job-142', estimatedUnits: 12 })

<span class="comment">// ... your LLM or tool call ...</span>

<span class="comment">// After the call: record what it actually cost</span>
await record({ agentId: 'researcher', taskRef: 'job-142', units: 12 })</pre></div>

  <h2>What it does NOT do</h2>
  <p>AgentBill does not replace your payment processor: it does not move money, hold a card or charge your end customers, and it is not positioned between you and one that does. Multi-step workflows with state machines or reversal logic are out of scope.</p>

  <h2>Guides</h2>
  <div class="ct-links">
    <a href="/docs/task-budgets">Task budgets, a hard cost ceiling per agent job</a>
    <a href="/docs/limit-cost-per-agent-run">How to cap what one agent run can spend</a>
    <a href="/docs/first-run">Every setup failure, and its fix</a>
  </div>

  <h2>Integrations</h2>
  <div class="ct-links">
    <a href="/integrations">Everything AgentBill publishes, and where to install it</a>
    <a href="/integrations/openclaw">OpenClaw, one ceiling per session, as a ClawHub plugin</a>
    <a href="/integrations/langchain">LangChain, one ceiling per job in middleware</a>
    <a href="/integrations/openai-agents-sdk">OpenAI Agents SDK, one ceiling per job in RunHooks</a>
    <a href="/integrations/crewai">CrewAI, one ceiling per crew run in model-call hooks</a>
    <a href="/integrations/mcp">MCP server, a ceiling the agent can consult</a>
  </div>

  <div class="end"><a href="/register" class="btn btn-lg">${KEY_CTA}</a></div>
`,
    }))
  })
}
