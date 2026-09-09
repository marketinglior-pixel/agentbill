import { FastifyInstance } from 'fastify'
import { docsShell } from '../ui/docs.js'
import { publicRoute } from '../middleware/auth.js'
import { KEY_CTA } from '../ui/chrome.js'
import { byPath, ORIGIN } from '../ui/site.js'
import { softwareLd, sourceLd } from '../ui/ld.js'

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
    'Install the SDK, get an API key, and give one job a ceiling that every call sharing its task_ref is checked against.',
  totalTime: 'PT2M',
  inLanguage: 'en-US',
  isPartOf: { '@id': `${ORIGIN}/docs#techarticle` },
  supply: { '@type': 'HowToSupply', name: 'An AgentBill API key, free, no credit card' },
  tool: { '@type': 'HowToTool', name: 'agentbill-sdk for Python' },
  step: [
    {
      '@type': 'HowToStep',
      position: 1,
      name: 'Step 1, Install',
      text: 'pip install agentbill-sdk',
      url: `${ORIGIN}/docs#step-install`,
    },
    {
      '@type': 'HowToStep',
      position: 2,
      name: 'Step 2, Get your API key',
      text: 'Register at agentbill.dev/register, free, no credit card. Your key starts with agb_.',
      url: `${ORIGIN}/docs#step-api-key`,
    },
    {
      '@type': 'HowToStep',
      position: 3,
      name: 'Step 3, Give the job a ceiling',
      text: 'Pass the same task_ref on every call the job makes. They are all checked against one ceiling, and the first preflight of a new task is the one that fixes it.',
      url: `${ORIGIN}/docs#step-ceiling`,
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
      body: `
  <h1>Documentation</h1>
  <p class="lede">Everything you need to add preflight billing to your agents.</p>

  <h2>Quick Start, 2 minutes</h2>

  <h3 id="step-install">Step 1, Install</h3>
  <div class="code"><pre>pip install agentbill-sdk</pre></div>

  <h3 id="step-api-key">Step 2, Get your API key</h3>
  <p>Register at <a href="/register">agentbill.dev/register</a>, free, no credit card. Your key starts with <span class="inline">agb_</span>.</p>

  <h3 id="step-ceiling">Step 3, Give the job a ceiling</h3>
  <p>Pass the same <span class="inline">task_ref</span> on every call the job makes. They are all
  checked against one ceiling, and the first preflight of a new task is the one that fixes it.</p>
  <div class="code"><pre>
from agentbill import AgentBillClient

client = AgentBillClient(api_key="agb_your_key")

<span class="comment"># 1 unit = 1 cent here, so job-142 has $5 across every call</span>
<span class="comment"># that passes the same task_ref, however many that turns out to be.</span>
client.preflight(agent_id="researcher", task_ref="job-142",
                 task_ceiling=500, estimated_units=12)
<span class="comment"># a refused call raised TaskCeilingExceededError above; nothing to check here</span>

<span class="comment"># ... run your agent here ...</span>
result = run_my_agent()

<span class="comment"># Settle, or the units stay held until the reservation expires</span>
client.record(agent_id="researcher", task_ref="job-142", units=12)
  </pre></div>

  <p class="closer">That is the whole integration. <span class="inline">agent_id</span> is a label the
  console groups by; the ceiling is on the task, not on the agent. The free tier is 1,000 preflight
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
  <p>Consulted before your provider call goes out. If the units already used plus this call's estimate would cross the ceiling, preflight answers <code class="inline">approved: false</code> and the SDK raises. It answers on units you define; it does not read your provider bill and cannot know what the refused call would have cost.</p>

  <h3>Record</h3>
  <p>Logs actual usage after a successful run. Idempotent per <code class="inline">idempotency_key</code>: /events dedupes on it. Both SDKs generate a fresh key for each call, so calling record() again on a retry is a second event; to dedupe a retried job, pass your own key to the endpoint.</p>

  <h3>Per-task ceiling</h3>
  <p>One job, one ceiling, held across every call and every tool that passes the same
  <span class="inline">task_ref</span>. This is the one that is not bound to a calendar month and not
  to an identity, and that is the whole point: a budget that resets tomorrow does not stop the loop
  running tonight.</p>

  <p>Pass <span class="inline">task_ceiling</span> on the first preflight of a new
  <span class="inline">task_ref</span>. A task preflight has never seen must carry one or the call is
  rejected with <span class="inline">task_ceiling_required</span>; later values are ignored, so a
  retry cannot quietly raise the ceiling it was supposed to respect. When the units already used plus
  this call's estimate would cross it, preflight answers <span class="inline">approved: false</span>
  with <span class="inline">task_ceiling_exceeded</span> and the SDK raises.</p>

  <div class="code"><pre>
from agentbill import AgentBillClient, TaskCeilingExceededError

client = AgentBillClient(api_key="agb_your_key")

<span class="comment"># First call of the job opens it and fixes the ceiling at 500.</span>
client.preflight(agent_id="researcher", task_ref="job-142",
                 task_ceiling=500, estimated_units=300)

try:
    <span class="comment"># A different agent, same job: 300 + 250 &gt; 500, refused before it runs.</span>
    client.preflight(agent_id="writer", task_ref="job-142", estimated_units=250)
except TaskCeilingExceededError as e:
    print(f"task {e.task_ref} hit its ceiling")
  </pre></div>

  <p>Note which identifier is doing the work there. <span class="inline">agent_id</span> is a label
  for attribution and carries no budget of its own; two different agents that share a
  <span class="inline">task_ref</span> share one ceiling. The job is what costs money, not the agent.</p>

  <h3>Per-request ceiling</h3>
  <p>Refuse any single call that would consume more than a set number of units. Set <span class="inline">ceiling=N</span> on the client; if <span class="inline">estimated_units</span> exceeds it, the call is refused before it goes out and <span class="inline">CeilingExceededError</span> is raised. This one caps a call, not a job: it is a sanity check on a bad estimate, not the cross-call ceiling above.</p>

  <div class="code"><pre>
<span class="comment"># No single call may cost more than 20 units.</span>
client = AgentBillClient(api_key="agb_your_key", ceiling=20)

client.preflight(
    agent_id="researcher",
    customer_id="user_123",
    estimated_units=50,  <span class="comment"># 50 &gt; 20: raises CeilingExceededError, nothing runs</span>
)
  </pre></div>

  <h2 id="reservation">The reservation</h2>

  <p>Preflight does not read your balance and then decide. It takes the budget in the same
  statement that checks it:</p>

  <div class="code"><pre>
UPDATE customers
SET reserved_units = reserved_units + :units
WHERE account_id = :account
  AND customer_ref = :customer
  AND (limit_units IS NULL
       OR used_units + reserved_units + :units &lt;= limit_units)
  </pre></div>

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
  <span class="inline">record()</span> never arrives, a sweeper reclaims the units. Settling closes
  reservation rows FIFO and decrements by what those rows actually held, not by what you passed, so
  a late settle after a sweep cannot release the same units twice.</p>

  <p>Note which way this fails. An abandoned reservation makes your ceiling <em>tighter</em>, never
  looser. The gate does not open by accident.
  <a href="/blog/how-preflight-avoids-double-billing">Full walkthrough of the concurrency design</a>.</p>

  <h3>What the reservation is not</h3>

  <p>It is not a measurement. AgentBill never sees your provider, your GPU or your tool call. The
  number reserved is the <span class="inline">estimated_units</span> you passed, and
  <span class="inline">record()</span> settles with the number you pass. Units are an integer you
  define.</p>

  <p>What you get is ordering and arithmetic that hold under concurrent load: the ceiling is
  consulted before the work starts, and the total across every call sharing a
  <span class="inline">task_ref</span> cannot exceed it. What you do not get is an opinion about
  what a call was worth. That number is yours.</p>

  <h2>API Reference</h2>

  <h3>preflight()</h3>
  <table>
    <tr><th>Parameter</th><th>Type</th><th>Description</th></tr>
    <tr><td>agent_id</td><td>string</td><td>A label for attribution, not a budget. Every task and every refusal in the console carries it, and nothing is capped by it.</td></tr>
    <tr><td>customer_id</td><td>string <span class="tag">optional</span></td><td>Your internal customer ID. Defaults to "default". A customer starts with no limit; set one with <a href="#put-budget">PUT /budget</a>.</td></tr>
    <tr><td>estimated_units</td><td>int <span class="tag">optional</span></td><td>Expected units for this run. Used for ceiling check. Default: 1.</td></tr>
    <tr><td>ceiling</td><td>int <span class="tag">optional, on AgentBillClient(...)</span></td><td>Set on the client, not per call: every preflight is refused if estimated_units exceeds it.</td></tr>
    <tr><td>task_ref</td><td>string <span class="tag">optional</span></td><td>Groups many calls under one cross-call budget. Pass the same task_ref on every call in the job. See <a href="/docs/task-budgets">task budgets</a>.</td></tr>
    <tr><td>task_ceiling</td><td>int <span class="tag">optional</span></td><td>Total units the whole task may spend. Required on the first preflight of a new task_ref, ignored on later calls.</td></tr>
  </table>

  <p>Every identifier above (agent_id, customer_id, task_ref, and idempotency_key) is 1 to 128 characters and may not contain control characters. A value that breaks either rule is a 422 with <span class="inline">validation_error</span>, never a 500.</p>

  <p>Returns:</p>
  <div class="code"><pre>
{
  "approved": true,
  "remaining_units": 990,
  "estimated_units": 10
}
  </pre></div>

  <p>When refused:</p>
  <div class="code"><pre>
{
  "approved": false,
<span class="comment"># plan_limit_exceeded on a paid plan. budget_exhausted and the</span>
<span class="comment"># ceiling refusals carry no upgrade_url.</span>
  "reason": "free_tier_exceeded",
  "plan": "free",
  "monthly_calls": 1000,
  "plan_limit": 1000,
  "upgrade_url": "https://agentbill.dev/pricing?account_id=acc_..."
}
  </pre></div>

  <p>That is the raw HTTP shape. Both SDKs then apply one rule to it, and it is the same rule in
  Python and Node: they <strong>raise when your own spend rule refused the call</strong>
  (<span class="inline">ceiling_exceeded</span>, <span class="inline">task_ceiling_exceeded</span>,
  <span class="inline">budget_exhausted</span>) and <strong>return the result when the refusal is
  AgentBill's own quota</strong> (<span class="inline">free_tier_exceeded</span>,
  <span class="inline">plan_limit_exceeded</span>), with
  <span class="inline">upgrade_url</span> set. Our quota running out must never crash your agent.</p>

  <h3>record()</h3>
  <table>
    <tr><th>Parameter</th><th>Type</th><th>Description</th></tr>
    <tr><td>agent_id</td><td>string</td><td>The same attribution label you passed to preflight.</td></tr>
    <tr><td>units</td><td>int <span class="tag">optional</span></td><td>Units consumed by this run. Default: 1.</td></tr>
    <tr><td>customer_id</td><td>string <span class="tag">optional</span></td><td>Your internal customer ID. Defaults to "default". A customer starts with no limit; set one with <a href="#put-budget">PUT /budget</a>.</td></tr>
    <tr><td>task_ref</td><td>string <span class="tag">optional</span></td><td>Settles against that task's ceiling. Pass the same one you preflighted with, or the units stay reserved until the reservation expires.</td></tr>
  </table>

  <h3 id="put-budget">PUT /budget</h3>
  <p>Sets one customer's ceiling, and creates that customer if it has never been seen. The per-request
  and per-task ceilings are arguments to <span class="inline">preflight()</span> and have no endpoint;
  this is the only ceiling with one.</p>

  <div class="code"><pre>
curl -X PUT https://agentbill.dev/budget \\
  -H "Authorization: Bearer agb_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{"customer_id":"user_123","limit_units":5000}'

<span class="comment"># {"customer_id":"user_123","customer_created":false,"limit":5000,</span>
<span class="comment">#  "used":1200,"reserved":40,"remaining":3760,"is_blocked":false}</span>
  </pre></div>

  <p><span class="inline">limit_units</span> is required and may be <span class="inline">null</span>,
  which means no limit. It is never optional: a body that left it out would have to mean "change
  nothing", and a write that silently does nothing is how a typo looks like a success.</p>

  <p>It is a ceiling, not a balance, so it may be set <em>below</em> what that customer has already
  used and reserved. Nothing is rewritten to fit, no counter goes negative, and the customer is
  simply refused with <span class="inline">budget_exhausted</span> until the open reservations settle
  or expire. Raising it again releases them on the next call, with no repair step.</p>

  <h2>Node.js</h2>
  <div class="code"><pre>npm install agentbill</pre></div>
  <div class="code"><pre>
<span class="comment">// Reads AGENTBILL_API_KEY from the environment. Units are yours to</span>
<span class="comment">// define; here 1 unit = 1 cent.</span>
import { preflight, record, TaskCeilingExceededError } from 'agentbill'

<span class="comment">// Before each call: 1 unit = 1 cent here, so this job has $5 across</span>
<span class="comment">// every call that shares job-142.</span>
<span class="comment">// A refused call throws TaskCeilingExceededError, so the expensive work never starts.</span>
await preflight({ agentId: 'researcher', taskRef: 'job-142',
                 taskCeiling: 500, estimatedUnits: 12 })

<span class="comment">// ... your LLM or tool call ...</span>

<span class="comment">// After the call: record what it actually cost</span>
await record({ agentId: 'researcher', taskRef: 'job-142', units: 12 })
  </pre></div>

  <h2>What it does NOT do</h2>
  <p>AgentBill does not replace your payment processor: it does not move money, hold a card or charge your end customers, and it is not positioned between you and one that does. Multi-step workflows with state machines or reversal logic are out of scope.</p>

  <h2>Guides</h2>
  <p><a href="/docs/task-budgets">Task budgets, a hard cost ceiling per agent job</a></p>
  <p><a href="/docs/limit-cost-per-agent-run">How to cap what one agent run can spend</a></p>
  <p><a href="/docs/langchain-billing">How to add billing to a LangChain agent</a></p>
  <p><a href="/docs/openai-agent-spend-ceiling">How to add a spend ceiling to an OpenAI agent</a></p>

  <div class="end"><a href="/register" class="btn">${KEY_CTA}</a></div>
`,
    }))
  })
}
