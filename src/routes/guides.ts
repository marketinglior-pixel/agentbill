import { FastifyInstance } from 'fastify'
import { docsShell } from '../ui/docs.js'
import { publicRoute } from '../middleware/auth.js'
import { byPath } from '../ui/site.js'
import { KEY_CTA } from '../ui/chrome.js'

// Guides render through the shared content shell in src/ui/docs.ts: one copy
// of the docs CSS, and an "On this page" rail built from each guide's <h2>s.
// The guide copy below is untouched. Two frame-level things changed inside the
// bodies: the closing CTA is the site's .btn instead of a white .cta of its
// own, and its label is short enough to stay on one line at 320px.
function page(path: string, title: string, description: string, body: string) {
  const meta = byPath.get(path)
  return docsShell({
    title: `${title} · AgentBill`,
    description,
    path,
    // A guide is a technical article. datePublished and dateModified come from
    // the registry, which is also what the sitemap's lastmod reads, so the two
    // cannot claim different things about the same page.
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'TechArticle',
      headline: title,
      description,
      url: `https://agentbill.dev${path}`,
      datePublished: meta?.published ?? meta?.updated,
      dateModified: meta?.updated,
      inLanguage: 'en-US',
      author: { '@id': 'https://agentbill.dev/#organization' },
      publisher: { '@id': 'https://agentbill.dev/#organization' },
      isPartOf: { '@id': 'https://agentbill.dev/#website' },
    },
    body: `${body}
  <div class="also">
    <p>Related guides</p>
    <a href="/docs/task-budgets">Task budgets, a hard cost ceiling per agent job</a>
    <a href="/docs/langchain-billing">How to add billing to a LangChain agent</a>
    <a href="/docs/openai-agent-spend-ceiling">How to add a spend ceiling to an OpenAI agent</a>
    <a href="/docs/limit-cost-per-agent-run">How to cap what one agent run can spend</a>
  </div>`,
  })
}

export async function guidesRoute(app: FastifyInstance) {

  app.get('/docs/task-budgets', publicRoute(), async (_, reply) => {
    return reply.type('text/html').send(page(
      '/docs/task-budgets',
      'Task budgets, a hard cost ceiling per agent job',
      'Cap what one AI agent job can spend, in units you define, across every call that passes the same task_ref. Cross-call budget ceilings with per-agent attribution, the per-run cap that OpenAI, Google, AWS and Anthropic spend limits do not give you.',
      `
  <h1>Task budgets, the job dies at your number</h1>
  <p>Provider spend caps stop at monthly totals for one vendor: no per-run ceiling, no
  cross-provider budget, and tool spend isn't counted at all. A <b>task budget</b> is the number
  that actually matters, what <i>this job</i> is allowed to spend, across every call that passes
  the same <span class="inline">task_ref</span>. Instrument a tool with that same
  <span class="inline">task_ref</span> and it draws down the same ceiling. Enforced <i>before</i>
  the call runs.</p>

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
  cross the ceiling is <b>refused before it runs</b>.<br>
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
  the reservation. A refused call returns
  <span class="inline">reason: "task_ceiling_exceeded"</span>; a new task_ref without a ceiling
  returns <span class="inline">422 task_ceiling_required</span>. A refused call reserves nothing
  and burns no plan quota: every rejection rolls the whole transaction back.</p>
  <h3>POST /events, extra field</h3>
  <p><span class="inline">task_ref</span>, attributes the spend to the task.
  <span class="inline">success: false</span> releases the reservation without billing.
  Responses include <span class="inline">task_used_units</span>,
  <span class="inline">task_remaining_units</span> and <span class="inline">task_exceeded</span>.</p>
  <h3>GET /tasks and GET /tasks/:task_ref</h3>
  <p>Per-agent cost attribution: every job's ceiling, spend, live reservations and overage flag.
  Filter with <span class="inline">?agent_id=</span>.</p>

  <p class="end"><a class="btn" href="/register">${KEY_CTA}</a></p>
`
    ))
  })

  app.get('/docs/limit-cost-per-agent-run', publicRoute(), async (_, reply) => {
    return reply.type('text/html').send(page(
      '/docs/limit-cost-per-agent-run',
      'How to cap what one agent run can spend',
      'Put a hard spend ceiling on a single agent run with task_ref and task_ceiling. Every call in the job is checked against one ceiling, before it goes out, on units you define.',
      `
      <h1>How to cap what one agent run can spend</h1>
      <span class="badge">Python</span><span class="badge">Node.js</span>
      <p>A provider spend cap is bound to a project, or to an organization over a calendar month. A single 3-hour research loop is neither. AgentBill's ceiling is bound to a <span class="inline">task_ref</span>, consulted before each call, on units you define.</p>

      <h2>What a monthly cap is bound to</h2>
      <p>Provider spend caps are real and they fire. What they are bound to is a project, or an organization over a calendar month. So either the run is too small to move a monthly number, or the number low enough to catch it takes every agent in the organization down with it until the 1st. AgentBill's ceiling is bound to one task instead: if the units already used plus this call's estimate would cross it, preflight answers <span class="inline">approved: false</span> and the SDK raises before your provider call goes out.</p>

      <h2>Install</h2>
      <div class="code"><pre>pip install agentbill-sdk</pre></div>

      <h2>Give the run an id, and give that id a ceiling</h2>
      <p>Two parameters do the work. <span class="inline">task_ref</span> is your name for this run,
      and every call that passes it is checked against the same ceiling.
      <span class="inline">task_ceiling</span> is that ceiling, in units you define, and it is fixed
      by the first preflight of a new run; later values are ignored, so a retry cannot raise the
      ceiling it was meant to respect.</p>
      <div class="code"><pre>
from agentbill import AgentBillClient

client = AgentBillClient(api_key="agb_your_key")

<span class="comment"># 1 unit = 1 cent here, so this run dies at $5 no matter how many</span>
<span class="comment"># calls, tools or retries it turns into.</span>
client.preflight(
    agent_id="researcher",     <span class="comment"># a label for attribution, not a budget</span>
    task_ref="job-142",        <span class="comment"># your name for this run</span>
    task_ceiling=500,          <span class="comment"># the whole run dies here</span>
    estimated_units=12,        <span class="comment"># what this one call is worth</span>
)

<span class="comment"># a refused call raised TaskCeilingExceededError above; nothing to check here</span>
result = run_agent()

<span class="comment"># Settle, or the units stay held until the reservation expires</span>
client.record(agent_id="researcher", task_ref="job-142", units=12)
      </pre></div>

      <p>Every later call in the same run passes <span class="inline">task_ref</span> and nothing
      else about the budget. It does not need to know the ceiling, or what the calls before it
      spent.</p>
      <div class="code"><pre>
<span class="comment"># A different agent, a different tool, the same run and the same ceiling.</span>
client.preflight(agent_id="writer", task_ref="job-142", estimated_units=40)
      </pre></div>

      <h2>Use the @gate decorator (shortest path)</h2>
      <p>The <span class="inline">@client.gate()</span> decorator does the preflight before the body
      and the record after it, and it takes the same two parameters. On an exception it settles with
      <span class="inline">success=False</span>, which releases the reservation instead of billing
      it.</p>
      <div class="code"><pre>
@client.gate(agent_id="researcher", task_ref="job-142",
             task_ceiling=500, estimated_units=12)
def run_agent(task: str) -> str:
    <span class="comment"># preflight runs before this body, record runs after it</span>
    return do_the_work(task)
      </pre></div>

      <h2>Handle the refusal</h2>
      <p>The exception carries the numbers, so the handler can say what happened without a second
      call.</p>
      <div class="code"><pre>
from agentbill import TaskCeilingExceededError

try:
    result = run_agent("analyze this")
except TaskCeilingExceededError as e:
    return {"error": f"run {e.task_ref} hit its ceiling of {e.task_ceiling} units"}
      </pre></div>

      <h2>What a per-request ceiling is, and is not</h2>
      <p>There is a second, narrower ceiling: <span class="inline">ceiling</span> on the client
      refuses any <em>single</em> call whose <span class="inline">estimated_units</span> exceed it.
      It is a sanity check on one bad estimate. It is not the cross-call ceiling above, and on its
      own it will not stop a loop that makes two hundred individually reasonable calls.</p>
      <div class="code"><pre>
<span class="comment"># No single call may cost more than 50 units. The run still needs a task_ceiling.</span>
client = AgentBillClient(api_key="agb_your_key", ceiling=50)
      </pre></div>

      <p>And note what is <em>not</em> on this list. <span class="inline">agent_id</span> is a label
      the console groups tasks and refusals by; it carries no budget of its own. Ceilings are bound
      to a run, a customer, or a single call, never to an agent name.</p>

      <h2>Node.js</h2>
      <div class="code"><pre>
import { preflight, record } from 'agentbill'  <span class="comment">// reads AGENTBILL_API_KEY</span>

<span class="comment">// The run dies at 500 units across every call that passes job-142.</span>
<span class="comment">// A refused call throws, so nothing expensive can happen by forgetting a check.</span>
await preflight({ agentId: 'researcher', taskRef: 'job-142',
                  taskCeiling: 500, estimatedUnits: 12 })

const result = await runAgent()

await record({ agentId: 'researcher', taskRef: 'job-142', units: 12 })
      </pre></div>

      <p class="end"><a href="/register" class="btn">${KEY_CTA}</a></p>
      `
    ))
  })

  app.get('/docs/langchain-billing', publicRoute(), async (_, reply) => {
    return reply.type('text/html').send(page(
      '/docs/langchain-billing',
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
    <span class="comment"># 1. Preflight, consulted before the provider call goes out</span>
    check = client.preflight(
        agent_id="research_chain",
        estimated_units=10,
        customer_id=customer_id
    )
    <span class="comment"># a refused call raised BudgetExhaustedError / CeilingExceededError above; nothing to check here</span>

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
      <p>For agents that run many steps, use <span class="inline">checkpoint()</span> to enforce a ceiling mid-run. The call is refused if the task has already recorded too many units.</p>
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

      <p class="end"><a href="/register" class="btn">${KEY_CTA}</a></p>
      `
    ))
  })

  app.get('/docs/openai-agent-spend-ceiling', publicRoute(), async (_, reply) => {
    return reply.type('text/html').send(page(
      '/docs/openai-agent-spend-ceiling',
      'How to add a spend ceiling to an OpenAI agent',
      'A spend ceiling bound to one OpenAI agent task, consulted before each call, on units you define. Not a project and not a calendar month.',
      `
      <h1>How to add a spend ceiling to an OpenAI agent</h1>
      <span class="badge">Python</span><span class="badge">Node.js</span><span class="badge">OpenAI</span>
      <p>OpenAI ships hard spend limits, and they fire: past one, the API returns <span class="inline">429 project_spend_limit_exceeded</span>. What they are bound to is a project or the organization. AgentBill adds a ceiling bound to one task, consulted before each call.</p>

      <h2>Use OpenAI's spend limits. This is a different scope.</h2>
      <p>Turn them on and keep them on. Their enforcement boundary is the project or the organization, and their own documentation notes that enforcement &ldquo;is not instantaneous, so recorded spend can slightly exceed the configured amount&rdquo;. AgentBill's ceiling is bound to a <span class="inline">task_ref</span>, consulted before each call, on units you define. It never reads your provider bill and it cannot tell you what a refused call would have cost.</p>

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
    <span class="comment"># a refused call raised BudgetExhaustedError / CeilingExceededError above; nothing to check here</span>

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
  <span class="comment">// A refused call throws before this line returns, so no OpenAI call is made.</span>
  await preflight({ agentId: 'openai_assistant', estimatedUnits: 10, ceiling: 100, customerId })

  const res = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: task }]
  })

  await record({ agentId: 'openai_assistant', units: 10, customerId })
  return res.choices[0].message.content ?? ''
}
      </pre></div>

      <p class="end"><a href="/register" class="btn">${KEY_CTA}</a></p>
      `
    ))
  })
}
