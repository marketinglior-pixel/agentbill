import { FastifyInstance } from 'fastify'
import { docsShell } from '../ui/docs.js'
import { PLAN_LIMITS } from '../integrations/polar.js'
import { publicRoute } from '../middleware/auth.js'
import { byPath, monthYear } from '../ui/site.js'
import { KEY_CTA } from '../ui/chrome.js'

// Posts render through the shared content shell in src/ui/docs.ts: one copy of
// the content CSS, and an "On this page" rail built from each post's <h2>s.
// Post copy is untouched; only the frame and the closing CTA changed.
const free = PLAN_LIMITS.free.toLocaleString('en-US')


// One definition per post. The title, the description, the reading time and the
// dateline were each written twice: once in the head and once in the markup a
// few lines below it. The index added a third copy of every one of them, so it
// is built from this instead.
//
// Dates live in the page registry beside the sitemap's lastmod, so a post
// cannot tell a reader one date and a crawler another.
type Post = {
  path: '/blog/how-preflight-avoids-double-billing' | '/blog/monthly-caps-wont-save-you'
  title: string
  description: string
  minutes: number
}

const POSTS: readonly Post[] = [
  {
    path: '/blog/monthly-caps-wont-save-you',
    title: "Why monthly caps don't protect you from one bad LLM run",
    description: 'Monthly spend caps fire after the damage is done. One overnight agent loop can exhaust your budget before the cap triggers. Here\'s the pattern that actually works.',
    minutes: 5,
  },
  {
    path: '/blog/how-preflight-avoids-double-billing',
    title: 'How preflight avoids double-billing under concurrent load',
    description: 'The naive read-check-approve pattern has a race condition. Here\'s how AgentBill uses an atomic reserve to guarantee consistency between the preflight check and the final settlement.',
    minutes: 6,
  },
]

const post = (path: Post['path']): Post => POSTS.find((x) => x.path === path)!

/** Dateline and reading time, from the two places that define them. */
const dateline = (path: Post['path']): string =>
  `${monthYear(byPath.get(path)!.published!)} · ${post(path).minutes} min read`

/** BlogPosting for one post. datePublished is the value the dateline renders. */
const postLd = (path: Post['path']) => ({
  '@context': 'https://schema.org',
  '@type': 'BlogPosting',
  headline: post(path).title,
  description: post(path).description,
  url: `https://agentbill.dev${path}`,
  datePublished: byPath.get(path)!.published,
  dateModified: byPath.get(path)!.updated,
  inLanguage: 'en-US',
  author: { '@id': 'https://agentbill.dev/#organization' },
  publisher: { '@id': 'https://agentbill.dev/#organization' },
  isPartOf: { '@id': 'https://agentbill.dev/#website' },
})

export async function blogRoute(app: FastifyInstance) {

  app.get('/blog/how-preflight-avoids-double-billing', publicRoute(), async (_, reply) => {
    return reply.type('text/html').send(docsShell({
      path: '/blog/how-preflight-avoids-double-billing',
      title: `${post('/blog/how-preflight-avoids-double-billing').title} · AgentBill`,
      description: post('/blog/how-preflight-avoids-double-billing').description,
      jsonLd: postLd('/blog/how-preflight-avoids-double-billing'),
      og: { type: 'article' },
      current: '',
      body: `

  <h1>How preflight avoids double-billing under concurrent load</h1>
  <div class="meta">${dateline('/blog/how-preflight-avoids-double-billing')}</div>

  <p>A developer on Reddit asked a sharp question about AgentBill's checkpoint pattern: <em>"Most checkpoint patterns I've seen either re-meter or skip metering and lose accuracy. How does the read-only check stay consistent with the final settlement?"</em></p>

  <p>It's the right question. The naive implementation of a preflight check has a race condition that causes exactly this problem. Here's how AgentBill solves it.</p>


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


  <h2>What happens when a run fails</h2>

  <p>A reservation is released in exactly one place: <span class="inline">record()</span>. Call it with <span class="inline">success=false</span> and the reserved units go back without billing anything.</p>

  <div class="code"><pre>
<span class="comment"># The run failed. Release the reservation, bill nothing.</span>
<span class="comment"># units must match what preflight reserved.</span>
client.record(agent_id="researcher", units=200, success=False)
  </pre></div>

  <p>The SDK decorator does this for you: it wraps the call in try/except and releases on the way out of a failed run.</p>

  <p><strong>If <span class="inline">record()</span> never arrives at all, the units stay reserved until they expire.</strong> Each reservation carries a TTL, returned to the caller as <span class="inline">reservation_expires_at</span> on every approved preflight, and a sweeper reclaims the ones that pass it.</p>

  <p>Getting that sweeper right needed one change to the shape of the data. <span class="inline">reserved_units</span> is a counter, and a counter cannot be swept, because it does not know how much of itself is stale. So a reservation is a row, and the counter is the sum of the open rows:</p>

  <div class="code"><pre>
<span class="comment">-- The invariant every path maintains</span>
customers.reserved_units    = SUM(units) of open rows for that customer
task_budgets.reserved_units = SUM(units) of open rows for that task
  </pre></div>

  <p>Which turns the sweep into something boring, and boring is the goal on this path:</p>

  <div class="code"><pre>
<span class="comment">-- Claim expired rows and release their units, in ONE transaction.</span>
<span class="comment">-- SKIP LOCKED because production runs more than one machine.</span>
UPDATE reservations SET released_at = now()
WHERE id IN (
  SELECT id FROM reservations
  WHERE released_at IS NULL AND expires_at &lt; now()
  ORDER BY expires_at LIMIT 500
  FOR UPDATE SKIP LOCKED
)
RETURNING customer_id, task_ref, units
  </pre></div>

  <h2>The bug this design exists to prevent</h2>

  <p>Now that two different things can release the same reservation, the sweeper and a late <span class="inline">record()</span>, the obvious implementation is wrong in the dangerous direction.</p>

  <p>Consider a run that dies, gets swept an hour later, and then, somehow, settles: a queued retry, a delayed worker, a caller that kept the id. If <span class="inline">record()</span> decrements <span class="inline">reserved_units</span> by its <span class="inline">units</span> argument, those units come off twice, once from the sweeper and once from the settle. The counter now sits <em>below</em> the units genuinely in flight, and the gate starts approving runs against budget that another run is already holding. A double release is a double spend.</p>

  <p>So the settle path does not decrement by what the caller sent. It closes reservation rows FIFO, counts what those rows were actually holding, and decrements by <em>that</em>:</p>

  <div class="code"><pre>
<span class="comment"># units always moves: the spend really happened.</span>
<span class="comment"># reserved moves by what the closed rows held, which is 0</span>
<span class="comment"># if the sweeper already reclaimed them.</span>
consumed = consume_reservations(customer_id, task_ref, units)

UPDATE customers
SET used_units     = used_units + :units,
    reserved_units = GREATEST(0, reserved_units - :consumed)
  </pre></div>

  <p>A settle for a reservation that no longer exists finds nothing to close, gets <span class="inline">consumed = 0</span>, and leaves the counter alone. Same code path covers <span class="inline">record()</span> calls that never had a preflight at all.</p>

  <h2>The retry that reserved twice</h2>

  <p>One more hole worth naming, because it was in the mechanism meant to prevent waste. <span class="inline">/events</span> has enforced <span class="inline">(account_id, idempotency_key)</span> UNIQUE since the beginning. <span class="inline">/preflight</span> had nothing, so a client that retried a timed-out preflight reserved a second time, and an aggressive retry policy could exhaust a budget without a single model call behind it.</p>

  <p>preflight now takes the same <span class="inline">idempotency_key</span>. The key is claimed inside the reserving transaction, so a duplicate blocks on the unique index rather than racing: same key, same decision, one reservation. A retry that lands while the original is still being decided gets <span class="inline">409 preflight_in_progress</span>, which is not a block and reserves nothing.</p>

  <p>Note which way all of this fails. An abandoned reservation makes the ceiling <em>tighter</em>, never looser: the run that gets blocked is a later one, not an expensive one that should have been stopped. Every correctness choice above preserves that direction. The gate does not open by accident.</p>


  <h2>Why this matters for metering accuracy</h2>

  <p>The developer's question was specifically about consistency between the check and the settlement. The reservation pattern guarantees this in three ways:</p>

  <p><strong>1. No double-approval.</strong> The atomic UPDATE ensures only one concurrent run can claim a given unit of budget. The database is the lock.</p>

  <p><strong>2. No phantom budget.</strong> Every approved run immediately reduces the available budget visible to subsequent runs. There's no window where the same units appear available twice.</p>

  <p><strong>3. Accurate settlement.</strong> The <span class="inline">record()</span> call replaces estimated with actual. The reservation was a claim, not a charge. The charge happens at settlement with the real number.</p>


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


  <h2>Add preflight to your agents</h2>
  <p>Free tier: ${free} preflight calls/month. No credit card required.</p>
  <p class="end"><a href="/register" class="btn">${KEY_CTA}</a></p>

  <div class="also">
    <p>Related</p>
    <a href="/blog/monthly-caps-wont-save-you">Why monthly caps don't protect you from one bad LLM run</a>
    <a href="/docs/limit-cost-per-agent-run">How to limit cost per agent run</a>
  </div>

`,
    }))
  })

  app.get('/blog/monthly-caps-wont-save-you', publicRoute(), async (_, reply) => {
    return reply.type('text/html').send(docsShell({
      path: '/blog/monthly-caps-wont-save-you',
      title: `${post('/blog/monthly-caps-wont-save-you').title} · AgentBill`,
      description: post('/blog/monthly-caps-wont-save-you').description,
      jsonLd: postLd('/blog/monthly-caps-wont-save-you'),
      og: { type: 'article' },
      current: '',
      body: `

  <h1>Why monthly caps don't protect you from one bad LLM run</h1>
  <div class="meta">${dateline('/blog/monthly-caps-wont-save-you')}</div>

  <p>An agent starts a task at night. A retry loop gets stuck. By morning the bill is many times the monthly cap that was supposed to prevent exactly this.</p>

  <p>The cap didn't fire. The bill did.</p>

  <p>This is not a bug. It's how monthly caps work. And if you're building AI agents in production, it will happen to you too, unless you change the pattern.</p>


  <h2>The timeline of a bad run</h2>

  <p>The shape of the failure is always the same:</p>

  <p>11:30pm, agent starts a research task. Fetches a URL. Gets a timeout. Retries. Gets another timeout. The retry logic calls the LLM to decide what to do next. The LLM decides to retry again. This repeats.</p>

  <p>The monthly cap is passed somewhere around midnight. But the cap check runs on a billing cycle, not on each request, so nothing stops. The agent keeps looping until someone wakes up and kills it, thousands of calls later.</p>

  <p>Monthly caps are accounting tools. They tell you what happened. They don't stop anything from happening.</p>


  <h2>Why the cap didn't fire</h2>

  <p>Most billing systems, OpenAI's included, check spend limits asynchronously. The request goes through first. The ledger updates after. By the time the cap logic runs, hundreds more requests have already been processed.</p>

  <p>This is a fundamental property of post-hoc billing, not a bug you can patch. The cap will always lag behind the actual spend, especially during a loop that fires hundreds of requests per minute.</p>

  <p>A monthly cap and a bill many times its size can coexist. They operate at different time scales.</p>


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


  <h2>Monthly caps vs. per-request ceilings</h2>

  <p>These solve different problems. A monthly cap is useful for overall budget visibility, you want to know your AI costs didn't triple this month. Fine.</p>

  <p>A per-request ceiling is what protects you from a single bad run. It operates at the invocation level, before compute is consumed, with no lag between the check and the block.</p>

  <p>You need both. The monthly cap catches drift. The preflight ceiling catches catastrophe.</p>


  <h2>The same run, replayed with preflight</h2>

  <p>Same agent. Same retry bug. Same overnight run.</p>

  <p>First invocation: preflight checks the task budget. Approved, units remain. Agent runs. Finishes. Cost recorded.</p>

  <p>Second invocation (the retry loop): preflight checks again. Previous run already consumed the budget for this session. Blocked. Agent never starts.</p>

  <p>The run stops at the ceiling you set, not at whatever the loop reaches by morning.</p>

  <p>The retry bug still exists. But it can't compound into a runaway loop when each invocation requires a budget check to proceed.</p>


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


  <h2>Summary</h2>

  <p>Monthly caps are accounting. Preflight checks are protection. One tells you what happened; the other prevents it from happening.</p>

  <p>If you're running AI agents in production, especially agents that loop, retry, or run unattended, you need a check that fires before the first token, not after the last one.</p>

  <h2>Add preflight to your agents</h2>
  <p>Free tier: ${free} preflight calls/month. No credit card required.</p>
  <p class="end"><a href="/register" class="btn">${KEY_CTA}</a></p>

  <div class="also">
    <p>Related guides</p>
    <a href="/docs/limit-cost-per-agent-run">How to limit cost per agent run</a>
    <a href="/docs/langchain-billing">How to add billing to a LangChain agent</a>
    <a href="/docs/openai-agent-spend-ceiling">How to add a spend ceiling to an OpenAI agent</a>
  </div>

`,
    }))
  })


  // The blog index did not exist. Both posts linked to /blog and so did the
  // docs, and /blog answered 401 to the public because it was never added to
  // the allowlist that used to guard every page. It was redesigned in 280f24e
  // while nobody outside could load it.
  app.get('/blog', publicRoute(), async (_, reply) => {
    return reply.type('text/html').send(docsShell({
      path: '/blog',
      title: 'Blog · AgentBill',
      description: 'Notes on budget ceilings for AI agents: why monthly caps fire too late, and how an atomic reserve keeps a preflight check consistent with settlement.',
      current: '',
      // No rail: on an index the h2s are the content, so a rail listing them
      // would be the same two titles printed twice on one screen.
      rail: false,
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'Blog',
        '@id': 'https://agentbill.dev/blog#blog',
        url: 'https://agentbill.dev/blog',
        name: 'AgentBill',
        inLanguage: 'en-US',
        publisher: { '@id': 'https://agentbill.dev/#organization' },
        blogPost: POSTS.map((x) => ({
          '@type': 'BlogPosting',
          headline: x.title,
          url: `https://agentbill.dev${x.path}`,
          datePublished: byPath.get(x.path)!.published,
        })),
      },
      body: `
  <h1>Blog</h1>
  <p class="lede">Two posts, both about the same thing: a ceiling that fires while the run is still going.</p>
${POSTS.map((x) => `
  <h2><a href="${x.path}">${x.title}</a></h2>
  <div class="meta">${dateline(x.path)}</div>
  <p>${x.description}</p>`).join('')}
`,
    }))
  })
}
