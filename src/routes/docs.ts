import { FastifyInstance } from 'fastify'
import { docsShell } from '../ui/docs.js'
import { publicRoute } from '../middleware/auth.js'

export async function docsRoute(app: FastifyInstance) {
  app.get('/docs', publicRoute(), async (request, reply) => {
    return reply.type('text/html').send(docsShell({
      title: 'AgentBill Docs · Preflight Billing for AI Agents',
      description: 'AgentBill documentation. Add preflight billing to your AI agent in 3 lines of Python. Block runaway spend, enforce per-request ceilings, meter usage per customer.',
      path: '/docs',
      // This page used to carry og and twitter tags and no og:image at all, so
      // every share of the docs was a card with no art.
      og: { description: 'Add preflight billing to your AI agent in 3 lines. Block runaway spend before compute starts. Python and Node.js SDK.' },
      body: `
  <h1>Documentation</h1>
  <p class="lede">Everything you need to add preflight billing to your agents.</p>

  <h2>Quick Start, 2 minutes</h2>

  <h3>Step 1, Install</h3>
  <div class="code"><pre>pip install agentbill-sdk</pre></div>

  <h3>Step 2, Get your API key</h3>
  <p>Register at <a href="/register">agentbill.dev/register</a>, free, no credit card. Your key starts with <span class="inline">agb_</span>.</p>

  <h3>Step 3, Add 3 lines to your agent</h3>
  <div class="code"><pre>
from agentbill import AgentBillClient

client = AgentBillClient(api_key="agb_your_key")

<span class="comment"># Before the run: check if the customer has budget</span>
check = client.preflight(agent_id="researcher", customer_id="user_123", estimated_units=10)
<span class="comment"># a blocked run raised BudgetExhaustedError / CeilingExceededError above; nothing to check here</span>

<span class="comment"># ... run your agent here ...</span>
result = run_my_agent()

<span class="comment"># After the run: record what was actually used</span>
client.record(agent_id="researcher", customer_id="user_123", units=10)
  </pre></div>

  <p class="ok">That's it. The free tier is 1,000 preflight calls per month, per account.</p>

  <h2>Core Concepts</h2>

  <h3>Preflight</h3>
  <p>Checks budget before compute is consumed. If the customer is out of units, the run is blocked immediately, before any tokens are spent.</p>

  <h3>Record</h3>
  <p>Logs actual usage after a successful run. Idempotent per <code class="inline">idempotency_key</code>: /events dedupes on it. Both SDKs generate a fresh key for each call, so calling record() again on a retry is a second event; to dedupe a retried job, pass your own key to the endpoint.</p>

  <h3>Per-request ceiling</h3>
  <p>Block any single run that would consume more than a set number of units. Set <span class="inline">ceiling=N</span> on the client; if <span class="inline">estimated_units</span> exceeds it, the run is blocked before it starts and <span class="inline">CeilingExceededError</span> is raised.</p>

  <div class="code"><pre>
client = AgentBillClient(api_key="agb_your_key", ceiling=20)  <span class="comment"># no single run may cost more than 20 units</span>

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
    <tr><td>agent_id</td><td>string</td><td>Identifier for this agent. Appears in the dashboard.</td></tr>
    <tr><td>customer_id</td><td>string <span class="tag">optional</span></td><td>Your internal customer ID. Defaults to "default".</td></tr>
    <tr><td>estimated_units</td><td>int <span class="tag">optional</span></td><td>Expected units for this run. Used for ceiling check. Default: 1.</td></tr>
    <tr><td>ceiling</td><td>int <span class="tag">optional, on AgentBillClient(...)</span></td><td>Set on the client, not per call: every preflight is blocked if estimated_units exceeds it.</td></tr>
    <tr><td>task_ref</td><td>string <span class="tag">optional</span></td><td>Groups many calls under one cross-call budget. Pass the same task_ref on every call in the job. See <a href="/docs/task-budgets">task budgets</a>.</td></tr>
    <tr><td>task_ceiling</td><td>int <span class="tag">optional</span></td><td>Total units the whole task may spend. Required on the first preflight of a new task_ref, ignored on later calls.</td></tr>
  </table>

  <p>Returns:</p>
  <div class="code"><pre>
{
  "approved": true,
  "remaining_units": 990,
  "estimated_units": 10
}
  </pre></div>

  <p>When blocked:</p>
  <div class="code"><pre>
{
  "approved": false,
  "reason": "free_tier_exceeded",  <span class="comment"># plan_limit_exceeded on a paid plan; budget_exhausted and ceiling refusals carry no upgrade_url</span>
  "plan": "free",
  "monthly_calls": 1000,
  "plan_limit": 1000,
  "upgrade_url": "https://agentbill.dev/pricing?account_id=acc_..."
}
  </pre></div>

  <p>That is the raw HTTP shape. Both SDKs then apply one rule to it, and it is the same rule in
  Python and Node: they <strong>raise when your spend rule stopped the run</strong>
  (<span class="inline">ceiling_exceeded</span>, <span class="inline">task_ceiling_exceeded</span>,
  <span class="inline">budget_exhausted</span>) and <strong>return the result when AgentBill's own
  billing stopped it</strong> (<span class="inline">free_tier_exceeded</span>,
  <span class="inline">plan_limit_exceeded</span>), with
  <span class="inline">upgrade_url</span> set. Our quota running out must never crash your agent.</p>

  <h3>record()</h3>
  <table>
    <tr><th>Parameter</th><th>Type</th><th>Description</th></tr>
    <tr><td>agent_id</td><td>string</td><td>Identifier for this agent or task type.</td></tr>
    <tr><td>units</td><td>int <span class="tag">optional</span></td><td>Units consumed by this run. Default: 1.</td></tr>
    <tr><td>customer_id</td><td>string <span class="tag">optional</span></td><td>Your internal customer ID. Defaults to "default".</td></tr>
  </table>

  <h2>Node.js</h2>
  <div class="code"><pre>npm install agentbill</pre></div>
  <div class="code"><pre>
<span class="comment">// Reads AGENTBILL_API_KEY from the environment. Units are yours to define; here 1 unit = 1 cent.</span>
import { preflight, record, TaskCeilingExceededError } from 'agentbill'

<span class="comment">// Before each call: this job dies at $5 across every call that shares job-142.</span>
<span class="comment">// A blocked call throws TaskCeilingExceededError, so the expensive work never starts.</span>
await preflight({ agentId: 'researcher', taskRef: 'job-142', taskCeiling: 500, estimatedUnits: 12 })

<span class="comment">// ... your LLM or tool call ...</span>

<span class="comment">// After the call: record what it actually cost</span>
await record({ agentId: 'researcher', taskRef: 'job-142', units: 12 })
  </pre></div>

  <h2>What it does NOT do</h2>
  <p>AgentBill does not replace your payment processor, it sits in front of it. Multi-step workflows with state machines or reversal logic are out of scope.</p>

  <h2>Guides</h2>
  <p><a href="/docs/task-budgets">Task budgets, a hard cost ceiling per agent job</a></p>
  <p><a href="/docs/limit-cost-per-agent-run">How to limit cost per agent run</a></p>
  <p><a href="/docs/langchain-billing">How to add billing to a LangChain agent</a></p>
  <p><a href="/docs/openai-agent-spend-ceiling">How to add a spend ceiling to an OpenAI agent</a></p>

  <div class="end"><a href="/register" class="btn">Get your API key</a></div>
`,
    }))
  })
}
