import { FastifyInstance } from 'fastify'

const CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0a0a0a; color: #e8ebe9; font-family: 'Inter', system-ui, sans-serif;
         -webkit-font-smoothing: antialiased; }
  .container { max-width: 720px; margin: 0 auto; padding: 60px 24px; }
  h1, h2, h3 { font-family: 'JetBrains Mono', ui-monospace, 'SF Mono', monospace; letter-spacing: -.01em; }
    h1 { font-size: 24px; font-weight: 700; color: #fff; margin-bottom: 8px; }
  h2 { font-size: 18px; font-weight: 700; color: #fff; margin: 40px 0 12px; }
  h3 { font-size: 15px; font-weight: 700; color: #fff; margin: 28px 0 10px; }
  p { font-size: 15px; color: #a0a8a3; line-height: 1.7; margin-bottom: 16px; }
  .nav { font-size: 13px; color: #868e88; margin-bottom: 48px; }
  .nav a { color: #868e88; text-decoration: none; margin-right: 16px; }
  .nav a:hover { color: #a0a8a3; }
  .code { background: #111; border: 1px solid #1e1e1e; border-radius: 6px; padding: 20px; margin: 16px 0; overflow-x: auto; }
  .code pre { font-size: 13px; color: #a8ff78; line-height: 1.7; }
  .comment { color: #868e88; }
  .inline { background: #1a1a1a; padding: 2px 8px; border-radius: 4px; font-size: 13px; color: #a8ff78; }
  hr { border: none; border-top: 1px solid #1a1a1a; margin: 40px 0; }
  .cta { display: inline-block; background: #fff; color: #000; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 700; font-size: 14px; margin-top: 8px; }
  .also { margin-top: 48px; padding-top: 32px; border-top: 1px solid #1a1a1a; }
  .also p { font-size: 13px; color: #868e88; margin-bottom: 8px; }
  .also a { color: #a8ff78; text-decoration: none; font-size: 14px; display: block; margin-bottom: 6px; }
  .badge { display: inline-block; background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 4px; padding: 2px 8px; font-size: 12px; color: #868e88; margin-right: 6px; margin-bottom: 12px; }
`

function page(title: string, description: string, body: string) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet" />
  <title>${title} · AgentBill</title>
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
    <a href="/docs/task-budgets">Task budgets, a hard cost ceiling per agent job</a>
    <a href="/docs/langchain-billing">How to add billing to a LangChain agent</a>
    <a href="/docs/openai-agent-spend-ceiling">How to add a spend ceiling to an OpenAI agent</a>
    <a href="/docs/limit-cost-per-agent-run">How to limit cost per agent run</a>
  </div>
</div>
</body>
</html>`
}

export async function guidesRoute(app: FastifyInstance) {

  app.get('/docs/task-budgets', async (_, reply) => {
    return reply.type('text/html').send(page(
      'Task budgets, a hard cost ceiling per agent job',
      'Cap what one AI agent job can spend across every provider and tool it touches. Cross-call budget ceilings with per-agent attribution, the per-run cap that OpenAI, Google, AWS and Anthropic spend limits do not give you.',
      `
  <h1>Task budgets, the job dies at $5</h1>
  <p>Provider spend caps stop at monthly totals for one vendor: no per-run ceiling, no
  cross-provider budget, and tool spend isn't counted. A <b>task budget</b> is the number that
  actually matters, what <i>this job</i> is allowed to cost, across every model and tool it
  touches, enforced <i>before</i> the money is spent.</p>

  <h2>What a unit is</h2>
  <p>A unit is an integer you define. AgentBill counts units; it never converts them to money.
  The common convention is <b>1 unit = 1 cent</b>, so "the job dies at $5" is
  <span class="inline">task_ceiling=500</span> and a call you expect to cost 12 cents is
  <span class="inline">estimated_units=12</span>. Tokens, requests or tool calls work just as well,
  as long as every call under the same task uses the same unit.</p>

  <h2>How it works</h2>
  <p>A task groups many calls under one hard ceiling. Three rules:</p>
  <p>1, The first preflight that names a <span class="inline">task_ref</span> creates the task
  and fixes its <span class="inline">task_ceiling</span>.<br>
  2, Every later preflight atomically reserves against the same budget; the call that would
  cross the ceiling is <b>blocked before it runs</b>.<br>
  3, Records report reality: a failed run releases its reservation, and spend that lands past
  the ceiling is still recorded and flagged <span class="inline">task_exceeded</span>, never
  silently dropped.</p>

  <h2>Quick start, curl</h2>
  <div class="code"><pre><span class="comment"># First call creates the task: this job dies at 50 units</span>
curl -X POST https://agentbill.dev/preflight \\
  -H "Authorization: Bearer agb_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{"agent_id":"researcher","estimated_units":2,
       "task_ref":"job-42","task_ceiling":50}'

<span class="comment"># ... run the LLM / tool call, then record what actually happened</span>
curl -X POST https://agentbill.dev/events \\
  -H "Authorization: Bearer agb_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{"customer_id":"default","event_type":"llm_call",
       "idempotency_key":"job-42-step-1","units":2,"task_ref":"job-42"}'

<span class="comment"># The call that would cross the ceiling is refused:</span>
<span class="comment"># {"approved":false,"reason":"task_ceiling_exceeded",</span>
<span class="comment">#  "task_used_units":48,"task_remaining_units":2}</span></pre></div>

  <h2>Python</h2>
  <div class="code"><pre>pip install agentbill-sdk  <span class="comment"># >= 0.4.0</span></pre></div>
  <div class="code"><pre>from agentbill import AgentBillClient, TaskCeilingExceededError

client = AgentBillClient(api_key="agb_your_key")

<span class="comment"># preflight before, record after, or wrap it all with the gate decorator:</span>
@client.gate("researcher", estimated_units=2,
             task_ref="job-42", task_ceiling=50)
def run_step(query: str) -> str:
    return call_llm(query)

<span class="comment"># the run that would cross 50 units raises TaskCeilingExceededError</span>
<span class="comment"># a run that throws releases its reservation automatically</span></pre></div>

  <h2>Node.js</h2>
  <div class="code"><pre>npm install agentbill  <span class="comment"># >= 0.2.0</span></pre></div>
  <div class="code"><pre>import { preflight, record, getTask } from 'agentbill'

await preflight({ agentId: 'researcher', estimatedUnits: 2,
                  taskRef: 'job-42', taskCeiling: 50 })
<span class="comment">// ... run the call ...</span>
await record({ agentId: 'researcher', units: 2, taskRef: 'job-42' })

const t = await getTask('job-42')  <span class="comment">// live burn-down</span>
console.log(t.usedUnits, '/', t.ceilingUnits)</pre></div>

  <h2>End to end: one job, many calls, everything that can go wrong</h2>

  <p>Every other example on this page is a fragment. This one is the whole loop, because the
  parts that matter are the ones a three line snippet leaves out: what a retry does to a
  reservation, what a crash does to it, and which call releases it.</p>

  <div class="code"><pre>import time
from agentbill import (
    AgentBillClient, TaskCeilingExceededError, PreflightInProgressError,
)

client = AgentBillClient(api_key="agb_your_key")

TASK     = "job-142"   <span class="comment"># one job. Every call below shares this budget.</span>
CUSTOMER = "cust_abc"
CEILING  = 500         <span class="comment"># 1 unit = 1 cent here, so this job dies at 5 dollars</span>


def guarded(step: str, units: int, work):
    <span class="comment"># Reserve, run, settle. Safe to retry, safe to crash.</span>
    for _ in range(3):
        try:
            client.preflight(
                agent_id="researcher",
                customer_id=CUSTOMER,
                task_ref=TASK,
                task_ceiling=CEILING,             <span class="comment"># fixed on the first call, ignored after</span>
                estimated_units=units,
                idempotency_key=f"{TASK}:{step}", <span class="comment"># stable across retries: one reservation</span>
            )
            break
        except PreflightInProgressError:
            time.sleep(0.2)                       <span class="comment"># another attempt holds the key</span>
    else:
        raise RuntimeError(f"{step}: preflight never settled")

    try:
        result = work()
    except Exception:
        <span class="comment"># Release the reservation, bill nothing. units must equal what</span>
        <span class="comment"># preflight reserved, or the difference stays held until the TTL.</span>
        client.record(agent_id="researcher", customer_id=CUSTOMER,
                      units=units, task_ref=TASK, success=False)
        raise

    client.record(agent_id="researcher", customer_id=CUSTOMER,
                  units=units, task_ref=TASK, success=True)
    return result</pre></div>

  <p>Now the job itself. A model call and a tool call, different providers, one ceiling between
  them. The retry loop is the failure this whole product exists for:</p>

  <div class="code"><pre><span class="comment"># Different providers, same budget. AgentBill never sees either one,</span>
<span class="comment"># it sees the units you decided each is worth.</span>
notes  = guarded("summarize",    12, lambda: call_model(prompt))
prices = guarded("fetch-prices",  3, lambda: call_tool("prices"))

<span class="comment"># The loop that used to run until morning:</span>
try:
    for page in range(1, 200):
        guarded(f"crawl-{page}", 4, lambda: call_tool("crawl"))
except TaskCeilingExceededError as e:
    <span class="comment"># Not an error to swallow. This is the product working.</span>
    print(f"stopped at {e.task_used_units}/{e.task_ceiling} units")</pre></div>

  <h3>Two workers on the same task</h3>
  <p>Nothing above changes when two processes share a <span class="inline">task_ref</span>. The
  reserve is a single conditional UPDATE, so when eight units remain and both workers ask for
  eight, exactly one is approved and the other gets
  <span class="inline">task_ceiling_exceeded</span>. There is no window where both read the same
  remaining balance, and no application level lock to get wrong.</p>

  <div class="code"><pre>from concurrent.futures import ThreadPoolExecutor

<span class="comment"># Same task, same last 8 units, two workers. One wins.</span>
with ThreadPoolExecutor(max_workers=2) as pool:
    for future in [pool.submit(guarded, f"final-{i}", 8, work) for i in range(2)]:
        try:
            future.result()
        except TaskCeilingExceededError:
            print("blocked, the other worker took the last units")</pre></div>

  <h3>What happens if the process dies</h3>
  <p>If it dies between <span class="inline">preflight()</span> and
  <span class="inline">record()</span>, the units stay reserved: nothing else can spend them, and
  the job's remaining budget looks smaller than it is. A sweeper reclaims them once the
  reservation passes its TTL, which approved responses return as
  <span class="inline">reservation_expires_at</span> (default 60 minutes, set
  <span class="inline">RESERVATION_TTL_MINUTES</span> if your runs are longer). Note the
  direction: an abandoned reservation makes the ceiling tighter, never looser. The gate does not
  open by accident.</p>

  <h2>API reference</h2>
  <h3>POST /preflight, extra fields</h3>
  <p><span class="inline">task_ref</span>, job identifier (1-128 chars). Same ref = same budget.<br>
  <span class="inline">task_ceiling</span>, required on the first preflight of a new task_ref;
  fixed at creation, ignored afterwards.<br>
  <span class="inline">idempotency_key</span>, optional (1-128 chars). Same key = same decision,
  one reservation, so a retried preflight cannot reserve twice. A retry that arrives while the
  original is still being decided gets <span class="inline">409 preflight_in_progress</span>,
  which is not a block and reserves nothing.<br>
  Approved responses include <span class="inline">task_remaining_units</span> and
  <span class="inline">reservation_expires_at</span>, the point after which the sweeper reclaims
  the reservation. A blocked run returns
  <span class="inline">reason: "task_ceiling_exceeded"</span>; a new task_ref without a ceiling
  returns <span class="inline">422 task_ceiling_required</span>. A blocked run reserves nothing
  and burns no plan quota: every rejection rolls the whole transaction back.</p>
  <h3>POST /events, extra field</h3>
  <p><span class="inline">task_ref</span>, attributes the spend to the task.
  <span class="inline">success: false</span> releases the reservation without billing.
  Responses include <span class="inline">task_used_units</span>,
  <span class="inline">task_remaining_units</span> and <span class="inline">task_exceeded</span>.</p>
  <h3>GET /tasks and GET /tasks/:task_ref</h3>
  <p>Per-agent cost attribution: every job's ceiling, spend, live reservations and overage flag.
  Filter with <span class="inline">?agent_id=</span>.</p>

  <p><a class="cta" href="/register">Get a free API key →</a></p>
`
    ))
  })

  app.get('/docs/limit-cost-per-agent-run', async (_, reply) => {
    return reply.type('text/html').send(page(
      'How to limit cost per agent run',
      'Set a per-request spend ceiling on any AI agent. Block the run before compute is consumed if the budget is exceeded.',
      `
      <h1>How to limit cost per agent run</h1>
      <span class="badge">Python</span><span class="badge">Node.js</span>
      <p>Monthly caps don't protect you from a single bad run. One 3-hour research loop can exhaust your budget before the cap triggers. AgentBill enforces a ceiling at the invocation level, before any tokens are consumed.</p>

      <h2>The problem with monthly caps</h2>
      <p>A monthly cap fires after the damage is done. By the time you get the alert, the run already happened. AgentBill checks the budget <em>before</em> the run starts. If the estimated units exceed your ceiling, the call is blocked immediately, no compute, no cost.</p>

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

<span class="comment"># a blocked run raised BudgetExhaustedError / CeilingExceededError above; nothing to check here</span>

<span class="comment"># Your agent runs here, budget is confirmed</span>
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
import { preflight, record } from 'agentbill'  <span class="comment">// reads AGENTBILL_API_KEY</span>

<span class="comment">// ceiling is per call: block any single run expected to cost more than 50 units.</span>
<span class="comment">// budget_exhausted throws BudgetExhaustedError; ceiling_exceeded comes back as approved: false.</span>
const check = await preflight({ agentId: 'my_agent', estimatedUnits: 10, ceiling: 50 })
if (!check.approved) throw new Error(check.reason ?? 'blocked')  <span class="comment">// nothing expensive has run yet</span>

const result = await runAgent()

await record({ agentId: 'my_agent', units: 10 })
      </pre></div>

      <hr>
      <a href="/register" class="cta">Get your API key, free tier, no credit card</a>
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
      <p>Adding billing to a LangChain agent takes two calls: one before the chain runs, one after. No middleware, no monkey-patching. Works with any LangChain component, LCEL chains, AgentExecutor, RetrievalQA, or custom runnables.</p>

      <h2>Install</h2>
      <div class="code"><pre>pip install agentbill-sdk langchain-openai langchain-core</pre></div>

      <h2>Pattern 1, Manual preflight + record</h2>
      <p>The explicit pattern. Check budget before the chain runs, record units after it completes.</p>
      <div class="code"><pre>
from langchain_openai import ChatOpenAI
from langchain_core.prompts import ChatPromptTemplate
from agentbill import AgentBillClient

<span class="comment"># ceiling=50: block any run estimated at more than 50 units</span>
client = AgentBillClient(api_key="agb_your_key", ceiling=50)

def run_research_agent(customer_id: str, topic: str) -> str:
    <span class="comment"># 1. Preflight, block before any tokens are consumed</span>
    check = client.preflight(
        agent_id="research_chain",
        estimated_units=10,
        customer_id=customer_id
    )
    <span class="comment"># a blocked run raised BudgetExhaustedError / CeilingExceededError above; nothing to check here</span>

    <span class="comment"># 2. Run the LangChain chain normally (LCEL syntax)</span>
    llm = ChatOpenAI(model="gpt-4o")
    prompt = ChatPromptTemplate.from_template("Research this topic in depth: {topic}")
    chain = prompt | llm
    result = chain.invoke({"topic": topic})

    <span class="comment"># 3. Record units used</span>
    client.record(agent_id="research_chain", units=10, customer_id=customer_id)
    return result.content
      </pre></div>

      <h2>Pattern 2, @gate decorator (cleanest)</h2>
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

<span class="comment"># preflight runs before, record runs after, automatically</span>
result = run_research_agent("quantum computing")
      </pre></div>

      <h2>Pattern 3, Mid-run checkpoint for long chains</h2>
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

        <span class="comment"># Check mid-run, stop if ceiling is hit</span>
        cp = client.checkpoint(
            agent_id="multi_step",
            units_so_far=i + 1,
            ceiling=20,
            customer_id=customer_id
        )
        if not cp.approved:
            break  <span class="comment"># stopped early, no runaway cost</span>

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
    return {"error": "customer budget exhausted, top up to continue"}
except FreeTierExceededError as e:
    return {"error": "free tier limit reached", "upgrade_url": e.upgrade_url}
      </pre></div>

      <h2>Works with any LangChain component</h2>
      <p>AgentBill wraps at the invocation level, it doesn't care what's inside the chain. Use it with:</p>
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
<span class="comment"># Different customers, isolated budgets</span>
check_alice = client.preflight(agent_id="research", estimated_units=10, customer_id="alice")
check_bob   = client.preflight(agent_id="research", estimated_units=10, customer_id="bob")
      </pre></div>

      <h2>LangGraph support</h2>
      <p>For LangGraph workflows, call <span class="inline">preflight()</span> before entering the graph and <span class="inline">record()</span> after the final node completes. Use <span class="inline">checkpoint()</span> inside nodes to enforce ceilings mid-graph.</p>

      <hr>
      <a href="/register" class="cta">Get your API key, free tier, no credit card</a>
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
      <p>OpenAI's usage limits fire after the fact. AgentBill adds a preflight check, the run is blocked before the first API call if the budget says so.</p>

      <h2>Why not just use OpenAI's spend limits?</h2>
      <p>OpenAI's account-level limits are monthly caps, they don't protect you from a single expensive run. AgentBill enforces a ceiling <em>per invocation, per customer</em>, before the run starts. If the estimated units exceed your ceiling, the call is blocked with no tokens consumed.</p>

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
    <span class="comment"># a blocked run raised BudgetExhaustedError / CeilingExceededError above; nothing to check here</span>

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
import { preflight, record } from 'agentbill'  <span class="comment">// reads AGENTBILL_API_KEY</span>

const openai = new OpenAI()

async function runAgent(customerId: string, task: string): Promise&lt;string&gt; {
  <span class="comment">// budget_exhausted throws here; ceiling_exceeded returns approved: false. Either way, no OpenAI call is made.</span>
  const check = await preflight({ agentId: 'openai_assistant', estimatedUnits: 10, ceiling: 100, customerId })
  if (!check.approved) throw new Error(check.reason ?? 'blocked')

  const res = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: task }]
  })

  await record({ agentId: 'openai_assistant', units: 10, customerId })
  return res.choices[0].message.content ?? ''
}
      </pre></div>

      <hr>
      <a href="/register" class="cta">Get your API key, free tier, no credit card</a>
      `
    ))
  })
}
