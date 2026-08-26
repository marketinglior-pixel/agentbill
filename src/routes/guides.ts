import { FastifyInstance } from 'fastify'

const CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0a0a0a; color: #e5e5e5; font-family: 'Courier New', monospace; }
  .container { max-width: 720px; margin: 0 auto; padding: 60px 24px; }
  h1 { font-size: 24px; font-weight: 700; color: #fff; margin-bottom: 8px; }
  h2 { font-size: 18px; font-weight: 700; color: #fff; margin: 40px 0 12px; }
  h3 { font-size: 15px; font-weight: 700; color: #fff; margin: 28px 0 10px; }
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
  .badge { display: inline-block; background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 4px; padding: 2px 8px; font-size: 12px; color: #555; margin-right: 6px; margin-bottom: 12px; }
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
      <span class="badge">Python</span><span class="badge">Node.js</span>
      <p>Monthly caps don't protect you from a single bad run. One 3-hour research loop can exhaust your budget before the cap triggers. AgentBill enforces a ceiling at the invocation level — before any tokens are consumed.</p>

      <h2>The problem with monthly caps</h2>
      <p>A monthly cap fires after the damage is done. By the time you get the alert, the run already happened. AgentBill checks the budget <em>before</em> the run starts. If the estimated units exceed your ceiling, the call is blocked immediately — no compute, no cost.</p>

      <h2>Install</h2>
      <div class="code"><pre>pip install agentbill-sdk</pre></div>

      <h2>Set a ceiling at client initialization</h2>
      <p>Pass <span class="inline">ceiling</span> when creating the client. Every <span class="inline">preflight()</span> call will be blocked if <span class="inline">estimated_units</span> exceeds this value.</p>
      <div class="code"><pre>
from agentbill import AgentBillClient

<span class="comment"># Block any run estimated at more than 50 units</span>
client = AgentBillClient(api_key="agb_your_key", ceiling=50)
      </pre></div>

      <h2>Run the preflight check</h2>
      <div class="code"><pre>
check = client.preflight(
    agent_id="my_agent",
    estimated_units=10,        <span class="comment"># how many units this run is expected to use</span>
    customer_id="user_123"     <span class="comment"># optional: per-customer enforcement</span>
)

if not check.approved:
    raise Exception(f"Run blocked: {check.reason}")

<span class="comment"># Your agent runs here — budget is confirmed</span>
result = run_agent()

<span class="comment"># Record actual units used</span>
client.record(agent_id="my_agent", units=10, customer_id="user_123")
      </pre></div>

      <h2>Use the @gate decorator (shortest path)</h2>
      <p>The <span class="inline">@client.gate()</span> decorator handles preflight and record automatically. No boilerplate.</p>
      <div class="code"><pre>
@client.gate(agent_id="my_agent", estimated_units=10, customer_id="user_123")
def run_agent(task: str) -> str:
    <span class="comment"># preflight runs before this body</span>
    <span class="comment"># record runs after this body completes</span>
    return do_the_work(task)
      </pre></div>

      <h2>Handle blocking errors</h2>
      <div class="code"><pre>
from agentbill import AgentBillClient, BudgetExhaustedError, CeilingExceededError

try:
    result = run_agent("analyze this")
except CeilingExceededError:
    return {"error": "run exceeds per-request ceiling"}
except BudgetExhaustedError:
    return {"error": "customer budget exhausted"}
      </pre></div>

      <h2>Node.js</h2>
      <div class="code"><pre>
import { AgentBillClient } from 'agentbill'

const client = new AgentBillClient({ apiKey: 'agb_your_key', ceiling: 50 })

const check = await client.preflight({ agentId: 'my_agent', estimatedUnits: 10 })
if (!check.approved) throw new Error(check.reason)

const result = await runAgent()

await client.record({ agentId: 'my_agent', units: 10 })
      </pre></div>

      <hr>
      <a href="/register" class="cta">Get your API key — free tier, no credit card</a>
      `
    ))
  })

  app.get('/docs/langchain-billing', async (_, reply) => {
    return reply.type('text/html').send(page(
      'How to add billing to a LangChain agent',
      'Add preflight spend checks and usage billing to any LangChain agent in Python. Works with LCEL chains, AgentExecutor, RetrievalQA, and LangGraph.',
      `
      <h1>How to add billing to a LangChain agent</h1>
      <span class="badge">Python</span><span class="badge">LangChain</span><span class="badge">LCEL</span>
      <p>Adding billing to a LangChain agent takes two calls: one before the chain runs, one after. No middleware, no monkey-patching. Works with any LangChain component — LCEL chains, AgentExecutor, RetrievalQA, or custom runnables.</p>

      <h2>Install</h2>
      <div class="code"><pre>pip install agentbill-sdk langchain-openai langchain-core</pre></div>

      <h2>Pattern 1 — Manual preflight + record</h2>
      <p>The explicit pattern. Check budget before the chain runs, record units after it completes.</p>
      <div class="code"><pre>
from langchain_openai import ChatOpenAI
from langchain_core.prompts import ChatPromptTemplate
from agentbill import AgentBillClient

<span class="comment"># ceiling=50: block any run estimated at more than 50 units</span>
client = AgentBillClient(api_key="agb_your_key", ceiling=50)

def run_research_agent(customer_id: str, topic: str) -> str:
    <span class="comment"># 1. Preflight — block before any tokens are consumed</span>
    check = client.preflight(
        agent_id="research_chain",
        estimated_units=10,
        customer_id=customer_id
    )
    if not check.approved:
        raise Exception(f"Blocked for {customer_id}: {check.reason}")

    <span class="comment"># 2. Run the LangChain chain normally (LCEL syntax)</span>
    llm = ChatOpenAI(model="gpt-4o")
    prompt = ChatPromptTemplate.from_template("Research this topic in depth: {topic}")
    chain = prompt | llm
    result = chain.invoke({"topic": topic})

    <span class="comment"># 3. Record units used</span>
    client.record(agent_id="research_chain", units=10, customer_id=customer_id)
    return result.content
      </pre></div>

      <h2>Pattern 2 — @gate decorator (cleanest)</h2>
      <p>The <span class="inline">@client.gate()</span> decorator handles preflight and record automatically. Zero boilerplate inside the function.</p>
      <div class="code"><pre>
from langchain_openai import ChatOpenAI
from langchain_core.prompts import ChatPromptTemplate
from agentbill import AgentBillClient

client = AgentBillClient(api_key="agb_your_key", ceiling=50)

@client.gate(agent_id="research_chain", estimated_units=10, customer_id="user_123")
def run_research_agent(topic: str) -> str:
    llm = ChatOpenAI(model="gpt-4o")
    prompt = ChatPromptTemplate.from_template("Research: {topic}")
    chain = prompt | llm
    return chain.invoke({"topic": topic}).content

<span class="comment"># preflight runs before, record runs after — automatically</span>
result = run_research_agent("quantum computing")
      </pre></div>

      <h2>Pattern 3 — Mid-run checkpoint for long chains</h2>
      <p>For agents that run many steps, use <span class="inline">checkpoint()</span> to enforce a ceiling mid-run. The agent is blocked if it has already consumed too many units.</p>
      <div class="code"><pre>
from agentbill import AgentBillClient

client = AgentBillClient(api_key="agb_your_key")

def run_multi_step_agent(customer_id: str, tasks: list) -> list:
    client.preflight(agent_id="multi_step", estimated_units=len(tasks), customer_id=customer_id)

    results = []
    for i, task in enumerate(tasks):
        result = run_single_task(task)
        results.append(result)

        <span class="comment"># Check mid-run — stop if ceiling is hit</span>
        cp = client.checkpoint(
            agent_id="multi_step",
            units_so_far=i + 1,
            ceiling=20,
            customer_id=customer_id
        )
        if not cp.approved:
            break  <span class="comment"># stopped early — no runaway cost</span>

    client.record(agent_id="multi_step", units=len(results), customer_id=customer_id)
    return results
      </pre></div>

      <h2>Error handling</h2>
      <div class="code"><pre>
from agentbill import AgentBillClient, BudgetExhaustedError, CeilingExceededError, FreeTierExceededError

try:
    result = run_research_agent("user_123", "quantum computing")
except CeilingExceededError:
    return {"error": "run exceeds your per-request ceiling"}
except BudgetExhaustedError:
    return {"error": "customer budget exhausted — top up to continue"}
except FreeTierExceededError as e:
    return {"error": "free tier limit reached", "upgrade_url": e.upgrade_url}
      </pre></div>

      <h2>Works with any LangChain component</h2>
      <p>AgentBill wraps at the invocation level — it doesn't care what's inside the chain. Use it with:</p>
      <p>
        <span class="inline">LLMChain</span> &nbsp;
        <span class="inline">AgentExecutor</span> &nbsp;
        <span class="inline">RetrievalQA</span> &nbsp;
        <span class="inline">ConversationalChain</span> &nbsp;
        <span class="inline">LangGraph</span>
      </p>

      <h2>Per-customer billing</h2>
      <p>Pass <span class="inline">customer_id</span> to enforce separate budgets per user. Each customer has their own usage counters and free tier allowance.</p>
      <div class="code"><pre>
<span class="comment"># Different customers — isolated budgets</span>
check_alice = client.preflight(agent_id="research", estimated_units=10, customer_id="alice")
check_bob   = client.preflight(agent_id="research", estimated_units=10, customer_id="bob")
      </pre></div>

      <h2>LangGraph support</h2>
      <p>For LangGraph workflows, call <span class="inline">preflight()</span> before entering the graph and <span class="inline">record()</span> after the final node completes. Use <span class="inline">checkpoint()</span> inside nodes to enforce ceilings mid-graph.</p>

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
      <span class="badge">Python</span><span class="badge">Node.js</span><span class="badge">OpenAI</span>
      <p>OpenAI's usage limits fire after the fact. AgentBill adds a preflight check — the run is blocked before the first API call if the budget says so.</p>

      <h2>Why not just use OpenAI's spend limits?</h2>
      <p>OpenAI's account-level limits are monthly caps — they don't protect you from a single expensive run. AgentBill enforces a ceiling <em>per invocation, per customer</em>, before the run starts. If the estimated units exceed your ceiling, the call is blocked with no tokens consumed.</p>

      <h2>Install</h2>
      <div class="code"><pre>pip install agentbill-sdk openai</pre></div>

      <h2>Add a preflight check to any OpenAI call</h2>
      <div class="code"><pre>
from openai import OpenAI
from agentbill import AgentBillClient

<span class="comment"># ceiling=100: block any run estimated at more than 100 units</span>
agentbill = AgentBillClient(api_key="agb_your_key", ceiling=100)
openai_client = OpenAI()

def run_agent(customer_id: str, task: str) -> str:
    <span class="comment"># Block before any OpenAI tokens are consumed</span>
    check = agentbill.preflight(
        agent_id="openai_assistant",
        estimated_units=10,
        customer_id=customer_id
    )
    if not check.approved:
        return {"error": "budget_exceeded", "reason": check.reason}

    response = openai_client.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": task}]
    )

    agentbill.record(
        agent_id="openai_assistant",
        units=10,
        customer_id=customer_id
    )
    return response.choices[0].message.content
      </pre></div>

      <h2>Use the @gate decorator</h2>
      <p>The <span class="inline">@client.gate()</span> decorator wraps the function with preflight + record automatically.</p>
      <div class="code"><pre>
from openai import OpenAI
from agentbill import AgentBillClient

agentbill = AgentBillClient(api_key="agb_your_key", ceiling=100)
openai_client = OpenAI()

@agentbill.gate(agent_id="openai_assistant", estimated_units=10, customer_id="user_123")
def run_agent(task: str) -> str:
    response = openai_client.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": task}]
    )
    return response.choices[0].message.content
      </pre></div>

      <h2>Handle blocking errors</h2>
      <div class="code"><pre>
from agentbill import AgentBillClient, BudgetExhaustedError, CeilingExceededError

try:
    result = run_agent("user_123", "summarize this document")
except CeilingExceededError:
    return {"error": "run exceeds per-request ceiling"}
except BudgetExhaustedError:
    return {"error": "customer budget exhausted"}
      </pre></div>

      <h2>Node.js</h2>
      <div class="code"><pre>
import OpenAI from 'openai'
import { AgentBillClient } from 'agentbill'

const openai = new OpenAI()
const agentbill = new AgentBillClient({ apiKey: 'agb_your_key', ceiling: 100 })

async function runAgent(customerId: string, task: string): Promise&lt;string&gt; {
  const check = await agentbill.preflight({
    agentId: 'openai_assistant',
    estimatedUnits: 10,
    customerId
  })
  if (!check.approved) throw new Error(check.reason)

  const res = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: task }]
  })

  await agentbill.record({ agentId: 'openai_assistant', units: 10, customerId })
  return res.choices[0].message.content ?? ''
}
      </pre></div>

      <hr>
      <a href="/register" class="cta">Get your API key — free tier, no credit card</a>
      `
    ))
  })
}
