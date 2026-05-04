import { FastifyInstance } from 'fastify'

export async function docsRoute(app: FastifyInstance) {
  app.get('/docs', async (request, reply) => {
    return reply.type('text/html').send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AgentBill Docs</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0a0a0a; color: #e5e5e5; font-family: 'Courier New', monospace; }
    .container { max-width: 720px; margin: 0 auto; padding: 60px 24px; }
    h1 { font-size: 24px; font-weight: 700; color: #fff; margin-bottom: 8px; }
    h2 { font-size: 18px; font-weight: 700; color: #fff; margin: 48px 0 16px; }
    h3 { font-size: 14px; font-weight: 700; color: #888; margin: 32px 0 8px; text-transform: uppercase; letter-spacing: 1px; }
    p { font-size: 15px; color: #aaa; line-height: 1.7; margin-bottom: 16px; }
    .nav { font-size: 13px; color: #555; margin-bottom: 48px; }
    .nav a { color: #555; text-decoration: none; margin-right: 16px; }
    .nav a:hover { color: #aaa; }
    .code { background: #111; border: 1px solid #1e1e1e; border-radius: 6px; padding: 20px; margin: 16px 0; overflow-x: auto; }
    .code pre { font-size: 13px; color: #a8ff78; line-height: 1.7; }
    .comment { color: #555; }
    .inline { background: #1a1a1a; padding: 2px 8px; border-radius: 4px; font-size: 13px; color: #a8ff78; }
    table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 14px; }
    th { text-align: left; color: #555; font-weight: normal; padding: 8px 12px; border-bottom: 1px solid #1a1a1a; }
    td { padding: 10px 12px; border-bottom: 1px solid #111; color: #aaa; vertical-align: top; }
    td:first-child { color: #a8ff78; white-space: nowrap; }
    .tag { display: inline-block; background: #1a1a1a; color: #555; font-size: 11px; padding: 2px 8px; border-radius: 4px; margin-left: 8px; }
    .cta { display: inline-block; background: #fff; color: #000; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 700; font-size: 14px; margin-top: 8px; }
    hr { border: none; border-top: 1px solid #1a1a1a; margin: 48px 0; }
  </style>
</head>
<body>
<div class="container">

  <div class="nav">
    <a href="/">AgentBill</a>
    <a href="/docs">Docs</a>
    <a href="/register">Get API key</a>
  </div>

  <h1>Documentation</h1>
  <p>Everything you need to add preflight billing to your agents.</p>

  <hr>

  <h2>Quick Start</h2>
  <p>5 minutes. No credit card.</p>

  <h3>1. Install</h3>
  <div class="code"><pre>pip install agentbill-sdk</pre></div>

  <h3>2. Get your API key</h3>
  <p>Register at <a href="/register" style="color:#a8ff78">agentbill.fly.dev/register</a>. Your key starts with <span class="inline">agb_</span>.</p>

  <h3>3. Add to your agent</h3>
  <div class="code"><pre>
from agentbill import AgentBillClient

client = AgentBillClient(api_key="agb_your_key")

<span class="comment"># Before the run: check budget</span>
check = client.preflight(agent_id="researcher", budget=5.00)
if not check.approved:
    raise Exception(f"Blocked: {check.reason}")

<span class="comment"># Run your agent here</span>
result = run_my_agent()

<span class="comment"># After the run: record cost</span>
client.record(agent_id="researcher", cost=check.estimated_cost)
  </pre></div>

  <hr>

  <h2>Core Concepts</h2>

  <h3>Preflight</h3>
  <p>Checks budget before compute is consumed. If the customer is out of credits, the run is blocked immediately. Nothing runs. Nothing is charged.</p>

  <h3>Record</h3>
  <p>Logs the actual cost after a successful run. This is how AgentBill tracks usage per agent and per customer.</p>

  <h3>Per-request ceiling</h3>
  <p>Coming in v0.2.0. Set a max cost per invocation. If a single run is projected to exceed the ceiling, it is blocked at the call level before any compute starts.</p>

  <hr>

  <h2>API Reference</h2>

  <h3>preflight()</h3>
  <table>
    <tr><th>Parameter</th><th>Type</th><th>Description</th></tr>
    <tr><td>agent_id</td><td>string</td><td>Identifier for this agent. Used for usage tracking.</td></tr>
    <tr><td>budget</td><td>float</td><td>Maximum cost allowed for this run (in USD).</td></tr>
    <tr><td>customer_id</td><td>string <span class="tag">optional</span></td><td>Your customer's ID. For multi-tenant setups.</td></tr>
  </table>

  <p>Returns:</p>
  <div class="code"><pre>
{
  "approved": true,
  "reason": null,
  "estimated_cost": 0.42,
  "remaining_budget": 4.58
}
  </pre></div>

  <h3>record()</h3>
  <table>
    <tr><th>Parameter</th><th>Type</th><th>Description</th></tr>
    <tr><td>agent_id</td><td>string</td><td>Must match the agent_id used in preflight().</td></tr>
    <tr><td>cost</td><td>float</td><td>Actual cost of the run (in USD).</td></tr>
    <tr><td>customer_id</td><td>string <span class="tag">optional</span></td><td>Your customer's ID.</td></tr>
  </table>

  <hr>

  <h2>What it does NOT do</h2>
  <p>Multi-step workflows with state machines or reversal logic are out of scope. AgentBill works on atomic single-call functions. If your agent runs a single task and returns a result, you are in scope.</p>
  <p>AgentBill does not replace your payment processor. It sits in front of it.</p>

  <hr>

  <h2>Node.js</h2>
  <div class="code"><pre>npm install agentbill</pre></div>
  <div class="code"><pre>
import { AgentBillClient } from 'agentbill'

const client = new AgentBillClient({ apiKey: 'agb_your_key' })

const check = await client.preflight({ agentId: 'researcher', budget: 5.00 })
if (!check.approved) throw new Error(check.reason)

await client.record({ agentId: 'researcher', cost: check.estimatedCost })
  </pre></div>

  <hr>

  <a href="/register" class="cta">Get your API key</a>

</div>
</body>
</html>
    `)
  })
}
