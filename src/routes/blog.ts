import { FastifyInstance } from 'fastify'
import { docsShell } from '../ui/docs.js'
import { PLAN_LIMITS } from '../integrations/polar.js'
import { publicRoute } from '../middleware/auth.js'
import { byPath, monthYear } from '../ui/site.js'
import { KEY_CTA } from '../ui/chrome.js'
import { CONTENT_CSS } from '../ui/content.js'

// Posts render through the shared content shell in src/ui/docs.ts: one copy of
// the content CSS, and an "On this page" rail built from each post's <h2>s.
// Post copy is untouched; only the frame and the closing CTA changed.
const free = PLAN_LIMITS.free.toLocaleString('en-US')

// The canvas pieces a post adds to the content pages' recipe (CONTENT_CSS),
// 2026-09-23.
//
// A quote and the line that sources it are one card, the homepage's evidence
// frame: white, the card hairline, --r-card corners, the quote in the ink at
// the lede size and upright, the attribution and its link under it in the
// mono. Drawn on the two siblings the post already writes (a <blockquote> and
// the p.meta after it) rather than on a wrapper, because the em-dash gate
// exempts a line by its literal <blockquote> tag and five [blog] gates read
// these quotes against their sources: neither tag moves.
//
// The closing "Add preflight to your agents" section is a warm-grey panel, the
// homepage's band, so a post ends on one frame instead of on a heading, a
// sentence and a button that happen to be adjacent.
const POST_CSS = `${CONTENT_CSS}
  .container blockquote { max-width: none; margin: var(--s5) 0 0; padding: var(--s6) var(--s6) var(--s4);
                          background: var(--card-bg); border: 1px solid var(--card-line); border-bottom: 0;
                          border-radius: var(--r-card) var(--r-card) 0 0; }
  .container blockquote p { font-style: normal; color: var(--text); font-size: var(--fs-lede); line-height: 1.55;
                            max-width: 60ch; }
  .container blockquote p:last-child { margin-bottom: 0; }
  .container blockquote + .meta { max-width: none; margin: 0 0 var(--s5); padding: 0 var(--s6) var(--s6);
                                  background: var(--card-bg); border: 1px solid var(--card-line); border-top: 0;
                                  border-radius: 0 0 var(--r-card) var(--r-card); line-height: 1.6; }
  .container blockquote + .meta a { color: var(--text); }
  .ct-cta { background: var(--panel-bg); border-radius: var(--r-card); padding: var(--s7) var(--s6);
            margin-top: var(--s8); }
  .ct-cta h2 { margin: 0 0 var(--s3); }
  .ct-cta p { margin-bottom: 0; }
  .ct-cta .end { margin-top: var(--s5); }
  @media (max-width: 720px) {
    .container blockquote { padding: var(--s5) var(--s4) var(--s3); border-radius: var(--r-card-sm) var(--r-card-sm) 0 0; }
    .container blockquote p { font-size: var(--fs-body); }
    .container blockquote + .meta { padding: 0 var(--s4) var(--s5); border-radius: 0 0 var(--r-card-sm) var(--r-card-sm); }
    .ct-cta { padding: var(--s6) var(--s4); border-radius: var(--r-card-sm); }
  }
`

// The index: each post is a warm-grey card, its dateline in the label voice
// above the title, the whole card the link (the title's own anchor, stretched),
// two across on a desktop and one column on a phone.
const INDEX_CSS = `${CONTENT_CSS}
  .ct-posts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--s4); margin-top: var(--s7); }
  .ct-post { position: relative; display: flex; flex-direction: column; gap: var(--s3); min-width: 0;
             background: var(--panel-bg); border-radius: var(--r-card); padding: var(--s6); }
  .ct-post .meta { margin: 0; }
  .ct-post h2 { font-size: var(--fs-h3); line-height: 1.3; margin: 0; }
  .ct-post h2 a::after { content: ""; position: absolute; inset: 0; border-radius: inherit; }
  .ct-post p { margin: 0; font-size: var(--fs-small); max-width: none; }
  @media (max-width: 960px) {
    .ct-posts { grid-template-columns: minmax(0, 1fr); margin-top: var(--s6); }
  }
  @media (max-width: 720px) {
    .ct-post { padding: var(--s5) var(--s4); border-radius: var(--r-card-sm); }
  }
`


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
    description: 'Four reported runs, four caps that were in force, and what each cap is bound to, in the vendors\' own words. Then the pattern that binds the ceiling to the job: preflight, approved: false, your code decides.',
    minutes: 8,
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
  '@id': `https://agentbill.dev${path}#post`,
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
      mainEntity: 'https://agentbill.dev/blog/how-preflight-avoids-double-billing#post',
      og: { type: 'article' },
      current: '',
      css: POST_CSS,
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

    return {"approved": True}</pre></div>

  <p>This reads the current balance, checks if the run fits, and returns a decision. Under a single serial workload it works fine.</p>

  <p>Under concurrent load it breaks. Consider two agent runs starting at the same millisecond for the same customer who has 10 units remaining, each estimating 8 units:</p>

  <div class="code"><pre>
Thread A: reads remaining = 10. 8 &lt;= 10. Approved.
Thread B: reads remaining = 10. 8 &lt;= 10. Approved.

Thread A runs. Uses 8 units. Used = 8.
Thread B runs. Uses 8 units. Used = 16. Limit exceeded.</pre></div>

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
RETURNING limit_units, used_units, reserved_units</pre></div>

  <p>If budget is available, the UPDATE succeeds and returns the updated row. The reservation is now reflected in <span class="inline">reserved_units</span>, visible to every subsequent transaction.</p>

  <p>If budget is exhausted, the WHERE clause matches 0 rows. The UPDATE returns nothing. The run is blocked. No budget was consumed.</p>

  <p>Replaying the concurrent scenario:</p>

  <div class="code"><pre>
Thread A: UPDATE adds 8 to reserved_units. reserved = 8. Succeeds.
Thread B: UPDATE tries to add 8. used + reserved + 8 = 16 > 10. WHERE fails. Blocked.

Thread A runs. Completes. record() converts reserved → used.</pre></div>

  <p>The database handles the serialization. No application-level locking required.</p>


  <h2>Settlement: converting reserved to used</h2>

  <p>After the agent run completes, <span class="inline">record()</span> settles the reservation:</p>

  <div class="code"><pre>
UPDATE customers
SET used_units     = used_units + :actual_units,
    reserved_units = reserved_units - :estimated_units
WHERE account_id = :account_id
  AND customer_ref = :customer_ref</pre></div>

  <p>The reserved units come out. The actual units go in. The net balance reflects reality.</p>

  <p>If <span class="inline">actual_units</span> differs from <span class="inline">estimated_units</span>, say you estimated 10 but the run used 7, the difference is released back into available budget. No manual adjustment needed.</p>


  <h2>What happens when a run fails</h2>

  <p>A reservation is released in exactly one place: <span class="inline">record()</span>. Call it with <span class="inline">success=false</span> and the reserved units go back without billing anything.</p>

  <div class="code"><pre>
<span class="comment"># The run failed. Release the reservation, bill nothing.</span>
<span class="comment"># units must match what preflight reserved.</span>
client.record(agent_id="researcher", units=200, success=False)</pre></div>

  <p>The SDK decorator does this for you: it wraps the call in try/except and releases on the way out of a failed run.</p>

  <p><strong>If <span class="inline">record()</span> never arrives at all, the units stay reserved until they expire.</strong> Each reservation carries a TTL, returned to the caller as <span class="inline">reservation_expires_at</span> on every approved preflight, and a sweeper reclaims the ones that pass it.</p>

  <p>Getting that sweeper right needed one change to the shape of the data. <span class="inline">reserved_units</span> is a counter, and a counter cannot be swept, because it does not know how much of itself is stale. So a reservation is a row, and the counter is the sum of the open rows:</p>

  <div class="code"><pre>
<span class="comment">-- The invariant every path maintains</span>
customers.reserved_units    = SUM(units) of open rows for that customer
task_budgets.reserved_units = SUM(units) of open rows for that task</pre></div>

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
RETURNING customer_id, task_ref, units</pre></div>

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
    reserved_units = GREATEST(0, reserved_units - :consumed)</pre></div>

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
  → net: 7 charged, 3 released</pre></div>

  <p>If two runs start simultaneously, only one can atomically claim the budget. The other is blocked at the database level before any compute runs.</p>


  <section class="ct-cta">
  <h2>Add preflight to your agents</h2>
  <p>Free tier: ${free} preflight calls/month. No credit card required.</p>
  <p class="end"><a href="/register" class="btn btn-lg">${KEY_CTA}</a></p>
  </section>

  <div class="also">
    <p>Related</p>
    <a href="/blog/monthly-caps-wont-save-you">Why monthly caps don't protect you from one bad LLM run</a>
    <a href="/docs/limit-cost-per-agent-run">How to cap what one agent run can spend</a>
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
      mainEntity: 'https://agentbill.dev/blog/monthly-caps-wont-save-you#post',
      og: { type: 'article' },
      current: '',
      css: POST_CSS,
      body: `

  <h1>Why monthly caps don't protect you from one bad LLM run</h1>
  <div class="meta">${dateline('/blog/monthly-caps-wont-save-you')}</div>

  <p>Four people had a spend cap in force when a run went wrong. The caps held. The bills came anyway. Each report below is one or two sentences in the reporter's own words, with the link, the date and the state of the thread, so you can read the rest yourself and disagree with what we make of it.</p>

  <p>None of the four caps had a bug. Each did what it is bound to do. This post is about what that is.</p>


  <h2>Four runs, four caps that were in force</h2>

  <p><strong>A $3,000 monthly limit. One weekend.</strong></p>
  <blockquote><p>&ldquo;~$300 of unintended API usage over a single weekend&rdquo; on an &ldquo;Enterprise plan ($3,000/month limit)&rdquo;.</p></blockquote>
  <p class="meta">claude-code issue 64744, opened June 2, 2026. Open, labelled bug and area:cost. <a href="https://github.com/anthropics/claude-code/issues/64744" rel="nofollow noopener">github.com/anthropics/claude-code/issues/64744</a></p>
  <p>The limit is a month. The incident was a weekend, and $300 never came near $3,000: there was nothing to cross. The loop ran inside the tool's own daemon and made its own provider calls, which matters further down. A ceiling governs a call where the call asks.</p>

  <p><strong>A weekly plan allowance and a spending cap. One evening.</strong></p>
  <blockquote><p>&ldquo;My Codex run consumed the remainder of my weekly pro plan allowance (80%+) and +$700 of additional usage credits before my spending cap finally stopped it. Effectively zero work was done.&rdquo;</p></blockquote>
  <p class="meta">OpenAI Developer Community, July 30, 2026. One user's report, not confirmed by OpenAI; the thread is open and its two replies argue with it. <a href="https://community.openai.com/t/1388493" rel="nofollow noopener">community.openai.com/t/1388493</a></p>
  <p>The cap fired. It fired when the account crossed its threshold, which is what an account cap is for, and by then the run had spent the plan and $700 on top of it.</p>

  <p><strong>A $600 organization spend limit. One day.</strong></p>
  <blockquote><p>&ldquo;One session hit its ChatGPT subscription usage limit and, instead of stopping, wrote batch runner scripts that called the metered API directly.&rdquo;</p>
  <p>&ldquo;The billing export confirmed 1,917 requests and 62.2 million tokens in a single UTC day (July 19), roughly $453 of metered usage, three automatic card recharges, and a July bill of $812.47 against a configured $600 organization spend limit.&rdquo;</p></blockquote>
  <p class="meta">OpenAI Developer Community, August 4, 2026. One user's report; OpenAI Support closed the thread on August 13, 2026 while an internal review was open. <a href="https://community.openai.com/t/1389087" rel="nofollow noopener">community.openai.com/t/1389087</a></p>
  <p>The reporter says the keys sat in a <code>.env</code> file in the working directory, and the thread's own verdict is that the setup was at fault, not the platform. It is here for a narrower reason. The subscription limit was bound to the session, the spend limit to the organization and the month, and the runner that did the spending answered to neither. A ceiling on a job governs the calls that pass through its check. A script that calls the provider directly never asks, so it is never refused.</p>

  <p><strong>A session window. Two runs.</strong></p>
  <blockquote><p>&ldquo;Once an agent dies with <code>You've hit your session limit &middot; resets &lt;time&gt;</code>, that error is terminal for the whole window &mdash; every subsequent spawn will hit it too. The orchestrator treats it as a per-agent failure instead, and keeps feeding the queue.&rdquo;</p></blockquote>
  <p class="meta">claude-code issue 94012, opened September 13, 2026. Open, labelled bug and has repro, no maintainer reply yet; one user's report, counted in tokens and agents rather than dollars. <a href="https://github.com/anthropics/claude-code/issues/94012" rel="nofollow noopener">github.com/anthropics/claude-code/issues/94012</a></p>
  <p>Here the cap is bound to a clock. The window refused every agent, and the harness kept spawning into it, because a refusal tied to a reset time says nothing about the job that is asking.</p>


  <h2>What each cap is bound to</h2>

  <p>The vendors say it themselves. The sentences below are quoted, not summarised, so the boundary each one names is theirs.</p>

  <p><strong>OpenAI</strong></p>
  <blockquote><p>&ldquo;Enforcement is not instantaneous. The API Platform can process a small amount of extra usage while the limit state propagates, so recorded spend can slightly exceed the configured amount.&rdquo;</p>
  <p>&ldquo;An organization hard limit applies to API traffic across all projects in the organization.&rdquo;</p></blockquote>
  <p class="meta">OpenAI, Spend limits, developer documentation. <a href="https://developers.openai.com/api/docs/guides/spend-limits" rel="nofollow noopener">developers.openai.com/api/docs/guides/spend-limits</a></p>

  <p><strong>Anthropic</strong></p>
  <blockquote><p>&ldquo;Once you reach your tier's spend cap, API usage pauses until 00:00 UTC on the first day of the next month, unless you request a higher limit sooner.&rdquo;</p>
  <p>&ldquo;Retrying, including the SDKs' automatic retries, fails until access resumes.&rdquo;</p></blockquote>
  <p class="meta">Anthropic, Rate limits, developer documentation. <a href="https://platform.claude.com/docs/en/api/rate-limits" rel="nofollow noopener">platform.claude.com/docs/en/api/rate-limits</a></p>

  <p><strong>Google</strong></p>
  <blockquote><p>&ldquo;Long-running tasks like batch mode completions and agent sessions may incur overages beyond your project spend cap.&rdquo;</p>
  <p>&ldquo;Billing data processing times can be delayed in AI Studio, up to around 10 minutes.&rdquo;</p></blockquote>
  <p class="meta">Google, Gemini API billing. <a href="https://ai.google.dev/gemini-api/docs/billing" rel="nofollow noopener">ai.google.dev/gemini-api/docs/billing</a></p>

  <p>Three vendors, one shape. The boundary is the organization, the project or the billing account. The unit is a calendar month, or the minutes a billing pipeline needs to catch up. The enforcement lags the spend by design, and each page says so. None of that is a defect. A cap bound to an account over a month has nothing to cross at the scale one runaway job operates on, and when a job does push the account across, the whole account waits for the reset, retries included.</p>

  <p>OpenAI's own Cookbook draws the conclusion in one sentence:</p>
  <blockquote><p>&ldquo;Organization and project spending limits cover overall usage, but they cannot tell you whether that task can afford its next request.&rdquo;</p></blockquote>
  <p class="meta">OpenAI Cookbook, Build a per-run spending controller with the Responses API, August 17, 2026. <a href="https://developers.openai.com/cookbook/articles/per_run_spending_controller_responses_api" rel="nofollow noopener">developers.openai.com/cookbook/articles/per_run_spending_controller_responses_api</a></p>


  <h2>A ceiling on the job</h2>

  <p>AgentBill binds the ceiling to the job. You name the job with a <code>task_ref</code> and set its ceiling once, in the console or with <code>PUT /tasks/:task_ref/ceiling</code> and <code>ceiling_units</code> in the body. From then on every call that passes that <code>task_ref</code> draws from the same ceiling: different processes, different providers, same job. Before each provider call, <code>preflight</code> asks whether this job has units left for this one. When it does not, the answer is <code>approved: false</code> with the reason <code>task_ceiling_exceeded</code>, the SDK raises, and your code decides what happens next: wait and retry, fall back to something cheaper, hand the job to a person, or let it end there. AgentBill is an SDK inside your process, not a proxy. No base URL changes, no traffic routed through us, no provider keys held. If we are unreachable, the SDK raises inside your process and, again, your code decides.</p>

  <p>What this does not govern, because two of the four reports above turn on it: a call that never passes through preflight. A script that calls the provider with keys from a <code>.env</code> file does not ask. A loop inside a tool's own daemon does not ask. The ceiling covers the calls your code routes through it and nothing else. That is a smaller promise than a cap on the account, and it is the one a runaway job actually tests.</p>


  <h2>The same run, with a task_ref</h2>

  <p>Take the weekend loop. The job is <code>job-142</code>, its ceiling is 500 units, set in the console before the run starts. Run 1: preflight asks, the answer is approved, the provider call goes out, the units are recorded. Run 2, the retry: preflight asks against the same <code>task_ref</code>, approved, units remain. This continues while units remain. Run 42: the job is at 492 of 500 and this call asks for 12. Preflight answers <code>approved: false</code>, the SDK raises <code>TaskCeilingExceededError</code>, and your code decides.</p>

  <p>The retry bug is still there. What it can no longer do is compound. Every call of the job asks the same ceiling, and the ceiling was set before the night began, not read off the bill in the morning.</p>


  <h2>Where the recipe leaves off</h2>

  <p>The Cookbook article quoted above is a working recipe for the same idea: give each run a budget, reserve before the call, settle after it. Its closing section says what it leaves out. The lock &ldquo;protects one Python process&rdquo;, and for several workers it points you to &ldquo;a shared store that checks and reserves the budget in one operation&rdquo;. That shared, atomic reservation is the part that is hard to get right under concurrency, and it is what the preflight endpoint is. How it avoids reserving twice for one retry, and why settlement is by the recorded amount, is in <a href="/blog/how-preflight-avoids-double-billing">the post on double-billing under concurrent load</a>.</p>


  <h2>Implementing it</h2>

  <p>The pattern is the same whatever runs inside the agent: LangChain, the OpenAI Agents SDK, AutoGen, a hand-written loop. You are wrapping the provider call, not the internals. Set the ceiling in the console, then the code names the job and nothing about its budget.</p>

  <p><strong>Python</strong></p>
  <div class="code"><pre>pip install agentbill-sdk</pre></div>

  <div class="code"><pre>
from agentbill import AgentBillClient, TaskCeilingExceededError

client = AgentBillClient(api_key="agb_your_key")

<span class="comment"># job-142 has a ceiling of 500 units, set in the console.</span>
<span class="comment"># Every call that passes this task_ref draws from the same one.</span>
try:
    client.preflight(agent_id="researcher", task_ref="job-142", estimated_units=12)
except TaskCeilingExceededError:
    <span class="comment"># approved: false. The job is out of units. Your code decides:</span>
    <span class="comment"># wait, fall back, hand off, or let the job end here.</span>
    raise

<span class="comment"># your provider call goes here</span>

<span class="comment"># settle, or the units stay held until the reservation expires</span>
client.record(agent_id="researcher", task_ref="job-142", units=12)</pre></div>

  <p><strong>Node.js</strong></p>
  <div class="code"><pre>npm install agentbill</pre></div>

  <div class="code"><pre>
import { preflight, record, TaskCeilingExceededError } from 'agentbill'  <span class="comment">// reads AGENTBILL_API_KEY</span>

<span class="comment">// job-142 has a ceiling of 500 units, set in the console.</span>
<span class="comment">// Every call that passes this taskRef draws from the same one.</span>
try {
  await preflight({ agentId: 'researcher', taskRef: 'job-142', estimatedUnits: 12 })
} catch (e) {
  if (e instanceof TaskCeilingExceededError) {
    <span class="comment">// approved: false. The job is out of units. Your code decides.</span>
  }
  throw e
}

<span class="comment">// your provider call goes here</span>

<span class="comment">// settle, or the units stay held until the reservation expires</span>
await record({ agentId: 'researcher', taskRef: 'job-142', units: 12 })</pre></div>


  <h2>Summary</h2>

  <p>A monthly cap fires on a calendar, over an account, and the vendors document the lag. A preflight check answers before one call goes out, on a ceiling you named for this job, and your code decides what to do with the answer. They are bound to different things. Keep the account cap for drift. Give the job a ceiling for the night you are not watching.</p>

  <p>If you are running agents that loop, retry or run unattended, the check that matters is the one that answers before the next call, not the statement that arrives after the last one.</p>

  <section class="ct-cta">
  <h2>Add preflight to your agents</h2>
  <p>Free tier: ${free} preflight calls/month. No credit card required.</p>
  <p class="end"><a href="/register" class="btn btn-lg">${KEY_CTA}</a></p>
  </section>

  <div class="also">
    <p>Related guides</p>
    <a href="/docs/limit-cost-per-agent-run">How to cap what one agent run can spend</a>
    <a href="/integrations/langchain">LangChain, one ceiling per job in middleware</a>
    <a href="/integrations/openai-agents-sdk">OpenAI Agents SDK, one ceiling per job in RunHooks</a>
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
      mainEntity: 'https://agentbill.dev/blog#blog',
      css: INDEX_CSS,
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
  <div class="ct-posts">${POSTS.map((x) => `
    <article class="ct-post">
      <div class="meta">${dateline(x.path)}</div>
      <h2><a href="${x.path}">${x.title}</a></h2>
      <p>${x.description}</p>
    </article>`).join('')}
  </div>
`,
    }))
  })
}
