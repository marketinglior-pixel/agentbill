import { FastifyInstance } from 'fastify'

const CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0a0a0a; color: #e8ebe9; font-family: 'Inter', system-ui, sans-serif;
         -webkit-font-smoothing: antialiased; }
  .container { max-width: 720px; margin: 0 auto; padding: 60px 24px; }
  .nav { font-size: 13px; color: #868e88; margin-bottom: 48px; }
  .nav a { color: #868e88; text-decoration: none; margin-right: 16px; }
  .nav a:hover { color: #a0a8a3; }
  h1, h2, h3 { font-family: 'JetBrains Mono', ui-monospace, 'SF Mono', monospace; letter-spacing: -.01em; }
    h1 { font-size: 26px; font-weight: 700; color: #fff; line-height: 1.3; margin-bottom: 16px; }
  .meta { font-size: 13px; color: #868e88; margin-bottom: 48px; }
  h2 { font-size: 18px; font-weight: 700; color: #fff; margin: 48px 0 12px; }
  p { font-size: 15px; color: #a0a8a3; line-height: 1.8; margin-bottom: 20px; }
  .code { background: #111; border: 1px solid #1e1e1e; border-radius: 6px; padding: 20px; margin: 24px 0; overflow-x: auto; }
  .code pre { font-size: 13px; color: #a8ff78; line-height: 1.7; }
  .comment { color: #868e88; }
  .inline { background: #1a1a1a; padding: 2px 8px; border-radius: 4px; font-size: 13px; color: #a8ff78; }
  blockquote { border-left: 2px solid #333; padding-left: 20px; margin: 24px 0; }
  blockquote p { color: #666; font-style: italic; }
  hr { border: none; border-top: 1px solid #1a1a1a; margin: 48px 0; }
  .cta-box { background: #111; border: 1px solid #1e1e1e; border-radius: 8px; padding: 32px; margin-top: 48px; }
  .cta-box h2 { margin-top: 0; }
  .cta-box p { margin-bottom: 20px; }
  .cta { display: inline-block; background: #fff; color: #000; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 700; font-size: 14px; }
  .also { margin-top: 48px; padding-top: 32px; border-top: 1px solid #1a1a1a; }
  .also p { font-size: 13px; color: #868e88; margin-bottom: 8px; }
  .also a { color: #a8ff78; text-decoration: none; font-size: 14px; display: block; margin-bottom: 6px; }
`

export async function blogRoute(app: FastifyInstance) {

  app.get('/blog/how-preflight-avoids-double-billing', async (_, reply) => {
    return reply.type('text/html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet" />
  <title>How preflight avoids double-billing under concurrent load · AgentBill</title>
  <meta name="description" content="The naive read-check-approve pattern has a race condition. Here's how AgentBill uses an atomic reserve to guarantee consistency between the preflight check and the final settlement.">
  <style>${CSS}</style>
</head>
<body>
<div class="container">

  <div class="nav">
    <a href="/">AgentBill</a>
    <a href="/docs">Docs</a>
    <a href="/register">Get API key</a>
  </div>

  <h1>How preflight avoids double-billing under concurrent load</h1>
  <div class="meta">May 2026 · 6 min read</div>

  <p>A developer on Reddit asked a sharp question about AgentBill's checkpoint pattern: <em>"Most checkpoint patterns I've seen either re-meter or skip metering and lose accuracy. How does the read-only check stay consistent with the final settlement?"</em></p>

  <p>It's the right question. The naive implementation of a preflight check has a race condition that causes exactly this problem. Here's how AgentBill solves it.</p>

  <hr>

  <h2>The problem: read-check-approve is broken under concurrency</h2>

  <p>The obvious implementation of a preflight check looks like this:</p>

  <div class="code"><pre>
<span class="comment"># Naive implementation, DO NOT use in production</span>
def preflight(customer_id, estimated_units):
    customer = db.query("SELECT used_units, limit_units FROM customers WHERE id = ?", customer_id)
    remaining = customer.limit_units - customer.used_units

    if estimated_units > remaining:
        return {"approved": False}

    return {"approved": True}
  </pre></div>

  <p>This reads the current balance, checks if the run fits, and returns a decision. Under a single serial workload it works fine.</p>

  <p>Under concurrent load it breaks. Consider two agent runs starting at the same millisecond for the same customer who has 10 units remaining, each estimating 8 units:</p>

  <div class="code"><pre>
Thread A: reads remaining = 10. 8 &lt;= 10. Approved.
Thread B: reads remaining = 10. 8 &lt;= 10. Approved.

Thread A runs. Uses 8 units. Used = 8.
Thread B runs. Uses 8 units. Used = 16. Limit exceeded.
  </pre></div>

  <p>Both reads happen before either write. Both see the same balance. Both get approved. The customer burns 16 units against a 10-unit budget. The check was useless.</p>

  <p>This is a classic TOCTOU race: Time Of Check, Time Of Use. The check and the use happen at different times, and the state can change between them.</p>

  <hr>

  <h2>The fix: atomic reservation</h2>

  <p>AgentBill doesn't just read the balance, it reserves units atomically inside a transaction. The preflight <span class="inline">UPDATE</span> only succeeds when there's enough budget remaining:</p>

  <div class="code"><pre>
<span class="comment">-- This is what happens inside AgentBill's preflight</span>
UPDATE customers
SET reserved_units = reserved_units + :estimated_units
WHERE account_id = :account_id
  AND customer_ref = :customer_ref
  AND (
    limit_units IS NULL
    OR used_units + reserved_units + :estimated_units &lt;= limit_units
  )
RETURNING limit_units, used_units, reserved_units
  </pre></div>

  <p>If budget is available, the UPDATE succeeds and returns the updated row. The reservation is now reflected in <span class="inline">reserved_units</span>, visible to every subsequent transaction.</p>

  <p>If budget is exhausted, the WHERE clause matches 0 rows. The UPDATE returns nothing. The run is blocked. No budget was consumed.</p>

  <p>Replaying the concurrent scenario:</p>

  <div class="code"><pre>
Thread A: UPDATE adds 8 to reserved_units. reserved = 8. Succeeds.
Thread B: UPDATE tries to add 8. used + reserved + 8 = 16 > 10. WHERE fails. Blocked.

Thread A runs. Completes. record() converts reserved → used.
  </pre></div>

  <p>The database handles the serialization. No application-level locking required.</p>

  <hr>

  <h2>Settlement: converting reserved to used</h2>

  <p>After the agent run completes, <span class="inline">record()</span> settles the reservation:</p>

  <div class="code"><pre>
UPDATE customers
SET used_units     = used_units + :actual_units,
    reserved_units = reserved_units - :estimated_units
WHERE account_id = :account_id
  AND customer_ref = :customer_ref
  </pre></div>

  <p>The reserved units come out. The actual units go in. The net balance reflects reality.</p>

  <p>If <span class="inline">actual_units</span> differs from <span class="inline">estimated_units</span>, say you estimated 10 but the run used 7, the difference is released back into available budget. No manual adjustment needed.</p>

  <hr>

  <h2>What happens when a run fails</h2>

  <p>If the agent crashes or the caller never calls <span class="inline">record()</span>, the reserved units stay reserved indefinitely. That would permanently lock budget, a leak.</p>

  <p>AgentBill handles this with a reservation expiry. Each reservation carries a timestamp. On the next preflight call for that customer, expired reservations are cleared before the budget check runs:</p>

  <div class="code"><pre>
<span class="comment">-- Clear stale reservations before checking budget</span>
UPDATE customers
SET reserved_units = 0
WHERE account_id = :account_id
  AND customer_ref = :customer_ref
  AND reservation_expires_at &lt; NOW()
  </pre></div>

  <p>This means a crashed run releases its reserved budget on the next invocation. The customer isn't permanently locked out because a single run failed to settle.</p>

  <hr>

  <h2>Why this matters for metering accuracy</h2>

  <p>The developer's question was specifically about consistency between the check and the settlement. The reservation pattern guarantees this in three ways:</p>

  <p><strong>1. No double-approval.</strong> The atomic UPDATE ensures only one concurrent run can claim a given unit of budget. The database is the lock.</p>

  <p><strong>2. No phantom budget.</strong> Every approved run immediately reduces the available budget visible to subsequent runs. There's no window where the same units appear available twice.</p>

  <p><strong>3. Accurate settlement.</strong> The <span class="inline">record()</span> call replaces estimated with actual. The reservation was a claim, not a charge. The charge happens at settlement with the real number.</p>

  <hr>

  <h2>The full flow</h2>

  <div class="code"><pre>
preflight(estimated_units=10)
  → atomic UPDATE reserves 10 units
  → returns approved=true, remaining_units=N

agent runs (actual cost: 7 units)

record(units=7)
  → used_units += 7
  → reserved_units -= 10
  → net: 7 charged, 3 released
  </pre></div>

  <p>If two runs start simultaneously, only one can atomically claim the budget. The other is blocked at the database level before any compute runs.</p>

  <hr>

  <div class="cta-box">
    <h2>Add preflight to your agents</h2>
    <p>Free tier: 1,000 preflight calls/month. No credit card required.</p>
    <a href="/register" class="cta">Get your API key</a>
  </div>

  <div class="also">
    <p>Related</p>
    <a href="/blog/monthly-caps-wont-save-you">Why monthly caps don't protect you from one bad LLM run</a>
    <a href="/docs/limit-cost-per-agent-run">How to limit cost per agent run</a>
  </div>

</div>
</body>
</html>`)
  })

  app.get('/blog/monthly-caps-wont-save-you', async (_, reply) => {
    return reply.type('text/html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet" />
  <title>Why monthly caps don't protect you from one bad LLM run · AgentBill</title>
  <meta name="description" content="Monthly spend caps fire after the damage is done. One overnight agent loop can exhaust your budget before the cap triggers. Here's the pattern that actually works.">
  <style>${CSS}</style>
</head>
<body>
<div class="container">

  <div class="nav">
    <a href="/">AgentBill</a>
    <a href="/docs">Docs</a>
    <a href="/register">Get API key</a>
  </div>

  <h1>Why monthly caps don't protect you from one bad LLM run</h1>
  <div class="meta">May 2026 · 5 min read</div>

  <p>A developer on r/SaaS posted this last week: <em>"My AI agent ran overnight. Woke up to this."</em> The screenshot showed a $498 API bill. He had a monthly cap set at $50.</p>

  <p>The cap didn't fire. The bill did.</p>

  <p>This is not a bug. It's how monthly caps work. And if you're building AI agents in production, it will happen to you too, unless you change the pattern.</p>

  <hr>

  <h2>The timeline of a bad run</h2>

  <p>Here's what happened in that $498 incident, reconstructed from what he described:</p>

  <p>11:30pm, agent starts a research task. Fetches a URL. Gets a timeout. Retries. Gets another timeout. The retry logic calls the LLM to decide what to do next. The LLM decides to retry again. This repeats.</p>

  <p>The monthly cap was $50. By midnight he'd burned through it. But the cap check runs on a billing cycle, not on each request. The agent kept running. By 7am it had made 4,800 API calls.</p>

  <blockquote>
    <p>"The moment you're using Stripe as your safety net, you've already lost the run."</p>
  </blockquote>

  <p>Monthly caps are accounting tools. They tell you what happened. They don't stop anything from happening.</p>

  <hr>

  <h2>Why the cap didn't fire</h2>

  <p>Most billing systems, OpenAI's included, check spend limits asynchronously. The request goes through first. The ledger updates after. By the time the cap logic runs, hundreds more requests have already been processed.</p>

  <p>This is a fundamental property of post-hoc billing, not a bug you can patch. The cap will always lag behind the actual spend, especially during a loop that fires hundreds of requests per minute.</p>

  <p>A $50/month cap and a $500 bill can coexist. They operate at different time scales.</p>

  <hr>

  <h2>The pattern that actually works: preflight</h2>

  <p>The fix is to check budget <em>before</em> the run starts, not after it finishes. This is called a preflight check.</p>

  <p>Before your agent makes a single API call, you ask: does this customer have budget for this run? If not, you block it. The agent never starts. No tokens consumed. No bill generated.</p>

  <div class="code"><pre>
from agentbill import AgentBillClient

client = AgentBillClient(api_key="agb_your_key")

<span class="comment"># Before the agent runs: reserve the units this run expects to cost.</span>
<span class="comment"># A blocked run raises here, before anything expensive happens.</span>
client.preflight(agent_id="researcher", estimated_units=200)

<span class="comment"># Agent only runs if budget is confirmed</span>
result = run_my_agent()

<span class="comment"># Record the run: the same units preflight reserved (the server settles by the recorded amount)</span>
client.record(agent_id="researcher", units=200)
  </pre></div>

  <p>Two calls. The agent either runs with a confirmed budget or it doesn't run at all. No overnight surprises.</p>

  <hr>

  <h2>Monthly caps vs. per-request ceilings</h2>

  <p>These solve different problems. A monthly cap is useful for overall budget visibility, you want to know your AI costs didn't triple this month. Fine.</p>

  <p>A per-request ceiling is what protects you from a single bad run. It operates at the invocation level, before compute is consumed, with no lag between the check and the block.</p>

  <p>You need both. The monthly cap catches drift. The preflight ceiling catches catastrophe.</p>

  <hr>

  <h2>The $498 run, replayed with preflight</h2>

  <p>Same agent. Same retry bug. Same overnight run.</p>

  <p>First invocation: preflight checks budget. $2.00 ceiling. Approved, budget exists. Agent runs. Finishes. Cost recorded.</p>

  <p>Second invocation (the retry loop): preflight checks again. Previous run already consumed the budget for this session. Blocked. Agent never starts.</p>

  <p>Total bill: $2.00. Not $498.</p>

  <p>The retry bug still exists. But it can't compound into a runaway loop when each invocation requires a budget check to proceed.</p>

  <hr>

  <h2>Implementing preflight in your stack</h2>

  <p>The pattern works regardless of what's inside your agent, LangChain, OpenAI Agents SDK, AutoGen, custom chains. You're wrapping the invocation, not the internals.</p>

  <p><strong>Python:</strong></p>
  <div class="code"><pre>pip install agentbill-sdk</pre></div>

  <div class="code"><pre>
from agentbill import AgentBillClient, BudgetExhaustedError

client = AgentBillClient(api_key="agb_your_key")

def run_agent_safely(customer_id: str, task: str):
    try:
        client.preflight(agent_id="my_agent", estimated_units=200, customer_id=customer_id)
    except BudgetExhaustedError as e:
        return {"blocked": True, "reason": str(e)}

    result = run_my_agent(task)
    client.record(agent_id="my_agent", units=200, customer_id=customer_id)
    return result
  </pre></div>

  <p><strong>Node.js:</strong></p>
  <div class="code"><pre>npm install agentbill</pre></div>

  <div class="code"><pre>
import { preflight, record, BudgetExhaustedError } from 'agentbill'  <span class="comment">// reads AGENTBILL_API_KEY</span>

async function runAgentSafely(customerId: string, task: string) {
  try {
    await preflight({ agentId: 'my_agent', estimatedUnits: 200, customerId })
  } catch (e) {
    if (e instanceof BudgetExhaustedError) return { blocked: true, reason: e.message }
    throw e
  }

  const result = await runMyAgent(task)
  await record({ agentId: 'my_agent', units: 200, customerId })
  return result
}
  </pre></div>

  <hr>

  <h2>Summary</h2>

  <p>Monthly caps are accounting. Preflight checks are protection. One tells you what happened; the other prevents it from happening.</p>

  <p>If you're running AI agents in production, especially agents that loop, retry, or run unattended, you need a check that fires before the first token, not after the last one.</p>

  <div class="cta-box">
    <h2>Add preflight to your agents</h2>
    <p>Free tier: 1,000 preflight calls/month. No credit card required.</p>
    <a href="/register" class="cta">Get your API key</a>
  </div>

  <div class="also">
    <p>Related guides</p>
    <a href="/docs/limit-cost-per-agent-run">How to limit cost per agent run</a>
    <a href="/docs/langchain-billing">How to add billing to a LangChain agent</a>
    <a href="/docs/openai-agent-spend-ceiling">How to add a spend ceiling to an OpenAI agent</a>
  </div>

</div>
</body>
</html>`)
  })

}
