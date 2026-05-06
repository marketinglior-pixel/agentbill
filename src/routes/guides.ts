import { FastifyInstance } from 'fastify'

const CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0a0a0a; color: #e5e5e5; font-family: 'Courier New', monospace; }
  .container { max-width: 720px; margin: 0 auto; padding: 60px 24px; }
  h1 { font-size: 24px; font-weight: 700; color: #fff; margin-bottom: 8px; }
  h2 { font-size: 18px; font-weight: 700; color: #fff; margin: 40px 0 12px; }
  p { font-size: 15px; color: #aaa; line-height: 1.7; margin-bottom: 16px; }
  .nav { font-size: 13px; color: #555; margin-bottom: 48px; }
  .nav a { color: #555; text-decoration: none; margin-right: 16px; }
  .nav a:hover { color: #aaa; }
  .code { background: #111; border: 1px solid #1e1e1e; border-radius: 6px; padding: 20px; margin: 16px 0; overflow-x: auto; }
  .code pre { font-size: 13px; color: #a8ff78; line-height: 1.7; }
  .comment { color: #555; }
  .inline { background: #1a1a1a; padding: 2px 8px; border-radius: 4px; font-size: 13px; color: #a8ff78; }
  hr { border: none; border-top: 1px solid #1a1a1a; margin: 40px 0; }
  .cta { display: inline-block; background: #fff; color: #000; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 700; font-size: 14px; margin-top: 8px; }
  .also { margin-top: 48px; padding-top: 32px; border-top: 1px solid #1a1a1a; }
  .also p { font-size: 13px; color: #555; margin-bottom: 8px; }
  .also a { color: #a8ff78; text-decoration: none; font-size: 14px; display: block; margin-bottom: 6px; }
`

function page(title: string, description: string, body: string) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — AgentBill</title>
  <meta name="description" content="${description}">
  <style>${CSS}</style>
</head>
<body>
<div class="container">
  <div class="nav">
    <a href="/">AgentBill</a>
    <a href="/docs">Docs</a>
    <a href="/register">Get API key</a>
  </div>
  ${body}
  <div class="also">
    <p>Related guides</p>
    <a href="/docs/langchain-billing">How to add billing to a LangChain agent</a>
    <a href="/docs/openai-agent-spend-ceiling">How to add a spend ceiling to an OpenAI agent</a>
    <a href="/docs/limit-cost-per-agent-run">How to limit cost per agent run</a>
  </div>
</div>
</body>
</html>`
}

export async function guidesRoute(app: FastifyInstance) {

  app.get('/docs/limit-cost-per-agent-run', async (_, reply) => {
    return reply.type('text/html').send(page(
      'How to limit cost per agent run',
      'Set a per-request spend ceiling on any AI agent. Block the run before compute is consumed if the budget is exceeded.',
      `
      <h1>How to limit cost per agent run</h1>
      <p>Monthly caps don't protect you from a single bad run. One 3-hour research loop can exhaust your budget before the cap triggers. AgentBill enforces a ceiling at the invocation level — before any tokens are consumed.</p>

      <h2>The problem with monthly caps</h2>
      <p>A monthly cap fires after the damage is done. By the time you get the alert, the run already happened. AgentBill checks the budget <em>before</em> the run starts. If the customer is out of credits, the call is blocked immediately — no compute, no cost.</p>

      <h2>Install</h2>
      <div class="code"><pre>pip install agentbill-sdk</pre></div>

      <h2>Add a per-run ceiling in Python</h2>
      <div class="code"><pre>
from agentbill import AgentBillClient

client = AgentBillClient(api_key="agb_your_key")

<span class="comment"># Set ceiling to $2.00 per run</span>
check = client.preflight(agent_id="my_agent", budget=2.00)

if not check.approved:
    raise Exception(f"Run blocked: {check.reason}")

<span class="comment"># Your agent runs here</span>
result = run_agent()

<span class="comment"># Record actual cost after completion</span>
client.record(agent_id="my_agent", cost=check.estimated_cost)
      </pre></div>

      <h2>Per-customer ceilings</h2>
      <p>Pass a <span class="inline">customer_id</span> to enforce separate budgets per user:</p>
      <div class="code"><pre>
check = client.preflight(
    agent_id="my_agent",
    budget=2.00,
    customer_id="user_123"
)
      </pre></div>

      <h2>Node.js</h2>
      <div class="code"><pre>
import { AgentBillClient } from 'agentbill'

const client = new AgentBillClient({ apiKey: 'agb_your_key' })

const check = await client.preflight({ agentId: 'my_agent', budget: 2.00 })
if (!check.approved) throw new Error(check.reason)

await client.record({ agentId: 'my_agent', cost: check.estimatedCost })
      </pre></div>

      <hr>
      <a href="/register" class="cta">Get your API key — free tier, no credit card</a>
      `
    ))
  })

  app.get('/docs/langchain-billing', async (_, reply) => {
    return reply.type('text/html').send(page(
      'How to add billing to a LangChain agent',
      'Add preflight spend checks and usage billing to any LangChain agent in Python. Two calls — preflight before, record after.',
      `
      <h1>How to add billing to a LangChain agent</h1>
      <p>Adding billing to a LangChain agent takes two calls: one before the chain runs, one after. No middleware, no monkey-patching.</p>

      <h2>Install</h2>
      <div class="code"><pre>pip install agentbill-sdk langchain</pre></div>

      <h2>Wrap any LangChain chain</h2>
      <div class="code"><pre>
from langchain.chains import LLMChain
from langchain.llms import OpenAI
from agentbill import AgentBillClient

client = AgentBillClient(api_key="agb_your_key")

def run_research_agent(customer_id: str, prompt: str):
    <span class="comment"># 1. Check budget before anything runs</span>
    check = client.preflight(
        agent_id="research_chain",
        budget=3.00,
        customer_id=customer_id
    )
    if not check.approved:
        raise Exception(f"Budget exceeded for {customer_id}")

    <span class="comment"># 2. Run your LangChain chain normally</span>
    llm = OpenAI(temperature=0)
    chain = LLMChain(llm=llm, prompt=prompt)
    result = chain.run(prompt)

    <span class="comment"># 3. Record usage after completion</span>
    client.record(
        agent_id="research_chain",
        cost=check.estimated_cost,
        customer_id=customer_id
    )
    return result
      </pre></div>

      <h2>Works with any LangChain component</h2>
      <p>AgentBill wraps at the invocation level — it doesn't care what's inside. Works with <span class="inline">LLMChain</span>, <span class="inline">AgentExecutor</span>, <span class="inline">RetrievalQA</span>, custom chains, or any callable.</p>

      <h2>Multi-tenant: per-customer billing</h2>
      <p>Pass <span class="inline">customer_id</span> to track and enforce budgets per user. Each customer has their own usage counters.</p>

      <hr>
      <a href="/register" class="cta">Get your API key — free tier, no credit card</a>
      `
    ))
  })

  app.get('/docs/openai-agent-spend-ceiling', async (_, reply) => {
    return reply.type('text/html').send(page(
      'How to add a spend ceiling to an OpenAI agent',
      'Block OpenAI agent runs before they start if the budget is exceeded. Per-request ceiling, not just a monthly cap.',
      `
      <h1>How to add a spend ceiling to an OpenAI agent</h1>
      <p>OpenAI's usage limits fire after the fact. AgentBill adds a preflight check — the run is blocked before the first API call if the budget says so.</p>

      <h2>The pattern</h2>
      <p>Preflight before any OpenAI call. Record after. The agent never runs if the budget is exhausted.</p>

      <h2>Install</h2>
      <div class="code"><pre>pip install agentbill-sdk openai</pre></div>

      <h2>OpenAI Agents SDK</h2>
      <div class="code"><pre>
from openai import OpenAI
from agentbill import AgentBillClient

agentbill = AgentBillClient(api_key="agb_your_key")
openai = OpenAI()

def run_agent(customer_id: str, task: str):
    <span class="comment"># Block before any OpenAI tokens are consumed</span>
    check = agentbill.preflight(
        agent_id="openai_assistant",
        budget=5.00,
        customer_id=customer_id
    )
    if not check.approved:
        return {"error": "budget_exceeded", "reason": check.reason}

    response = openai.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": task}]
    )

    agentbill.record(
        agent_id="openai_assistant",
        cost=check.estimated_cost,
        customer_id=customer_id
    )
    return response.choices[0].message.content
      </pre></div>

      <h2>Why not just use OpenAI's spend limits?</h2>
      <p>OpenAI's account-level limits are monthly caps — they don't protect you from a single expensive run. AgentBill enforces a ceiling per invocation, per customer, before the run starts.</p>

      <h2>Node.js</h2>
      <div class="code"><pre>
import OpenAI from 'openai'
import { AgentBillClient } from 'agentbill'

const openai = new OpenAI()
const agentbill = new AgentBillClient({ apiKey: 'agb_your_key' })

async function runAgent(customerId: string, task: string) {
  const check = await agentbill.preflight({
    agentId: 'openai_assistant',
    budget: 5.00,
    customerId
  })
  if (!check.approved) throw new Error(check.reason)

  const res = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: task }]
  })

  await agentbill.record({ agentId: 'openai_assistant', cost: check.estimatedCost, customerId })
  return res.choices[0].message.content
}
      </pre></div>

      <hr>
      <a href="/register" class="cta">Get your API key — free tier, no credit card</a>
      `
    ))
  })
}
