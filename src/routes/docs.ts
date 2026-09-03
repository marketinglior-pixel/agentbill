import { FastifyInstance } from 'fastify'
import { head } from '../ui/theme.js'
import { siteNav, siteFooter, CHROME_CSS } from '../ui/chrome.js'

export async function docsRoute(app: FastifyInstance) {
  app.get('/docs', async (request, reply) => {
    return reply.type('text/html').send(`${head({
      title: 'AgentBill Docs · Preflight Billing for AI Agents',
      description: 'AgentBill documentation. Add preflight billing to your AI agent in 3 lines of Python. Block runaway spend, enforce per-request ceilings, meter usage per customer.',
      canonical: 'https://agentbill.dev/docs',
      extraHead: `  <meta property="og:type" content="website" />
  <meta property="og:url" content="https://agentbill.dev/docs" />
  <meta property="og:title" content="AgentBill Docs · Preflight Billing for AI Agents" />
  <meta property="og:description" content="Add preflight billing to your AI agent in 3 lines. Block runaway spend before compute starts. Python and Node.js SDK." />
  <meta property="og:site_name" content="AgentBill" />
  <meta name="twitter:card" content="summary" />
  <meta name="twitter:title" content="AgentBill Docs · Preflight Billing for AI Agents" />
  <meta name="twitter:description" content="Add preflight billing to your AI agent in 3 lines of Python. Block runaway spend before compute starts." />`,
      css: `${CHROME_CSS}

    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: var(--bg); color: var(--text); font-family: 'Inter', system-ui, sans-serif;
         -webkit-font-smoothing: antialiased; }
    .container { max-width: 720px; margin: 0 auto; padding: 60px 24px; }
    h1, h2, h3 { font-family: 'JetBrains Mono', ui-monospace, 'SF Mono', monospace; letter-spacing: -.01em; }
    h1 { font-size: 24px; font-weight: 700; color: var(--white); margin-bottom: 8px; }
    h2 { font-size: 18px; font-weight: 700; color: var(--white); margin: 48px 0 16px; }
    h3 { font-size: 14px; font-weight: 700; color: var(--muted); margin: 32px 0 8px; text-transform: uppercase; letter-spacing: 1px; }
    p { font-size: 15px; color: var(--muted); line-height: 1.7; margin-bottom: 16px; }
    .nav { font-size: 13px; color: var(--dim); margin-bottom: 48px; }
    .nav a { color: var(--dim); text-decoration: none; margin-right: 16px; }
    .nav a:hover { color: var(--muted); }
    .code { background: var(--surface); border: 1px solid var(--border-soft); border-radius: 6px; padding: 20px; margin: 16px 0; overflow-x: auto; }
    .code pre { font-size: 13px; color: var(--code); line-height: 1.7; }
    .comment { color: var(--dim); }
    .inline { background: var(--surface3); padding: 2px 8px; border-radius: 4px; font-size: 13px; color: var(--code); }
    table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 14px; }
    th { text-align: left; color: var(--dim); font-weight: normal; padding: 8px 12px; border-bottom: 1px solid var(--surface3); }
    td { padding: 10px 12px; border-bottom: 1px solid var(--surface); color: var(--muted); vertical-align: top; }
    td:first-child { color: var(--code); white-space: nowrap; }
    .tag { display: inline-block; background: var(--surface3); color: var(--dim); font-size: 11px; padding: 2px 8px; border-radius: 4px; margin-left: 8px; }
    .cta { display: inline-block; background: var(--white); color: #000; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 700; font-size: 14px; margin-top: 8px; }
    hr { border: none; border-top: 1px solid var(--surface3); margin: 48px 0; }
`,
    })}
<body>
${siteNav('/docs')}
<div class="container">

  <h1>Documentation</h1>
  <p>Everything you need to add preflight billing to your agents.</p>

  <hr>

  <h2>Quick Start, 2 minutes</h2>

  <h3>Step 1, Install</h3>
  <div class="code"><pre>pip install agentbill-sdk</pre></div>

  <h3>Step 2, Get your API key</h3>
  <p>Register at <a href="/register" style="color:var(--code)">agentbill.dev/register</a>, free, no credit card. Your key starts with <span class="inline">agb_</span>.</p>

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

  <p style="color:#4ade80; margin-top: 8px;">That's it. The free tier is 1,000 preflight calls per month, per account.</p>

  <hr>

  <h2>Core Concepts</h2>

  <h3>Preflight</h3>
  <p>Checks budget before compute is consumed. If the customer is out of units, the run is blocked immediately, before any tokens are spent.</p>

  <h3>Record</h3>
  <p>Logs actual usage after a successful run. Idempotent, safe to call from retried or parallel workflows.</p>

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

  <hr>

  <h2>API Reference</h2>

  <h3>preflight()</h3>
  <table>
    <tr><th>Parameter</th><th>Type</th><th>Description</th></tr>
    <tr><td>agent_id</td><td>string</td><td>Identifier for this agent. Appears in the dashboard.</td></tr>
    <tr><td>customer_id</td><td>string <span class="tag">optional</span></td><td>Your internal customer ID. Defaults to "default".</td></tr>
    <tr><td>estimated_units</td><td>int <span class="tag">optional</span></td><td>Expected units for this run. Used for ceiling check. Default: 1.</td></tr>
    <tr><td>ceiling</td><td>int <span class="tag">optional, on AgentBillClient(...)</span></td><td>Set on the client, not per call: every preflight is blocked if estimated_units exceeds it.</td></tr>
    <tr><td>task_ref</td><td>string <span class="tag">optional</span></td><td>Groups many calls under one cross-call budget. Pass the same task_ref on every call in the job. See <a href="/docs/task-budgets" style="color:var(--code)">task budgets</a>.</td></tr>
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
  "reason": "free_tier_exceeded",  <span class="comment"># or budget_exhausted / ceiling_exceeded (no upgrade_url for those)</span>
  "remaining_units": 0,
  "upgrade_url": "https://agentbill.dev/upgrade"
}
  </pre></div>

  <h3>record()</h3>
  <table>
    <tr><th>Parameter</th><th>Type</th><th>Description</th></tr>
    <tr><td>agent_id</td><td>string</td><td>Identifier for this agent or task type.</td></tr>
    <tr><td>units</td><td>int <span class="tag">optional</span></td><td>Units consumed by this run. Default: 1.</td></tr>
    <tr><td>customer_id</td><td>string <span class="tag">optional</span></td><td>Your internal customer ID. Defaults to "default".</td></tr>
  </table>

  <hr>

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

  <hr>

  <h2>What it does NOT do</h2>
  <p>AgentBill does not replace your payment processor, it sits in front of it. Multi-step workflows with state machines or reversal logic are out of scope.</p>

  <hr>

  <h2>Guides</h2>
  <p><a href="/docs/task-budgets" style="color:var(--code)">Task budgets, a hard cost ceiling per agent job</a></p>
  <p><a href="/docs/limit-cost-per-agent-run" style="color:var(--code)">How to limit cost per agent run</a></p>
  <p><a href="/docs/langchain-billing" style="color:var(--code)">How to add billing to a LangChain agent</a></p>
  <p><a href="/docs/openai-agent-spend-ceiling" style="color:var(--code)">How to add a spend ceiling to an OpenAI agent</a></p>

  <hr>

  <a href="/register" class="cta">Get your API key</a>

</div>
${siteFooter()}
</body>
</html>
    `)
  })
}
