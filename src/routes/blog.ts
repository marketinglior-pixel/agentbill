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
    description: 'Five parallel tool calls read the same $4.90 on a $5.00 job and all five go out. How preflight reserves in one conditional UPDATE instead, settles to list price, reclaims what never reports back, and the CI test that fires 40 at once.',
    minutes: 7,
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

  <p>An agent that makes one call at a time is easy to budget. Read what the job has spent, compare it with the ceiling, make the call. Most agents don't work that way anymore. A planner hands five tool calls to five workers, the five start within a few milliseconds of each other, and each one asks the same question at the same moment: does this job have room for me?</p>

  <p>If the answer comes from a read, all five get the same answer. This post is about how AgentBill answers with a write instead, what happens to money held for a call that never reports back, and the test in our CI that fires 40 of these at once.</p>


  <h2>The check that reads</h2>

  <p>The obvious preflight check reads the job, adds the estimate, and compares:</p>

  <div class="code"><pre>
<span class="comment"># Read, then decide. Do not use this under concurrency.</span>
def preflight(task_ref, estimated_usd):
    job = db.one("SELECT ceiling_usd, spent_usd FROM jobs WHERE task_ref = %s",
                 task_ref)
    if job.spent_usd + estimated_usd > job.ceiling_usd:
        return {"approved": False}
    return {"approved": True}</pre></div>

  <p>With one worker it works. Now give it five. The job has a $5.00 ceiling and has spent $4.90, and each call estimates $0.10:</p>

  <div class="code"><pre>
worker 1: reads spent = $4.90. 4.90 + 0.10 &lt;= 5.00. approved.
worker 2: reads spent = $4.90. approved.
worker 3: reads spent = $4.90. approved.
worker 4: reads spent = $4.90. approved.
worker 5: reads spent = $4.90. approved.

five calls go out. spent = $5.40 on a $5.00 ceiling.</pre></div>

  <p>Every read happened before any write, so every worker saw $4.90. This is a time-of-check to time-of-use race: the state changed between the check and the spend, and nothing in the check could see it coming. A lock in your own process doesn't help once the workers are separate processes, or separate machines.</p>


  <h2>The check that writes</h2>

  <p>AgentBill's preflight doesn't read the balance and then decide. It tries to reserve the estimate, and the condition is part of the write:</p>

  <div class="code"><pre>
<span class="comment">-- inside POST /preflight, in one transaction (simplified)</span>
UPDATE task_budgets
SET reserved_units = reserved_units + :estimate
WHERE account_id = :account_id
  AND task_ref   = :task_ref
  AND used_units + reserved_units + :estimate &lt;= ceiling_units
RETURNING ceiling_units, used_units, reserved_units</pre></div>

  <p>If the estimate fits, a row comes back, and the reservation is already in <span class="inline">reserved_units</span> where the next worker's UPDATE will see it. If zero rows come back, it didn't fit. The answer is <span class="inline">approved: false</span> with the reason <span class="inline">task_ceiling_exceeded</span>, nothing was reserved, and your code decides what happens next: wait, fall back to a cheaper model, hand the job to a person, or let it end there.</p>

  <p>Postgres takes a row lock for the UPDATE, so the five workers queue on the job's row for the length of one statement each. There's no read-then-write gap left to fall into. On a job in dollars the numbers are micro-dollars, so $5.00 is 5,000,000 and a $0.10 estimate is 100,000. Same five workers:</p>

  <div class="code"><pre>
worker 1: 4,900,000 + 0         + 100,000 &lt;= 5,000,000. reserved. approved.
worker 2: 4,900,000 + 100,000   + 100,000 >  5,000,000. zero rows. approved: false.
worker 3: zero rows. approved: false.
worker 4: zero rows. approved: false.
worker 5: zero rows. approved: false.

one call goes out. the other four hear approved: false before sending anything.</pre></div>

  <p>What the job can still go over by is the gap between one call's estimate and what that call really cost. That's the next section.</p>


  <h2>Settling to what the call cost</h2>

  <p>When the provider answers, <span class="inline">record</span> reports the tokens it used. On a job in dollars the server prices those tokens at the provider's public list price and settles by that amount: the cost goes into <span class="inline">used_units</span>, the whole reservation comes out of <span class="inline">reserved_units</span>, and whatever the call didn't need is free for the next worker right away. A $0.10 reservation for a gpt-4o call of 10,000 input and 2,000 output tokens settles at $0.045.</p>

  <p>So the estimate matters, and you don't have to guess it. Leave <span class="inline">estimated_usd</span> out and the server reserves the job's recent median call, or $0.10 before the job has a priced call. The answer names whose estimate it was in <span class="inline">estimate_source</span>: <span class="inline">caller</span>, <span class="inline">job_median</span> or <span class="inline">default</span>. A call that costs more than its reservation is still charged in full, because the spend happened, and spend that lands past the ceiling is recorded and flagged <span class="inline">task_exceeded</span> rather than dropped. The ceiling holds to within one call's miss, not to the cent. Every dollar figure here is an estimate at list price, not your provider's invoice.</p>


  <h2>A call that never reports back</h2>

  <p>When the provider call throws, <span class="inline">wrap()</span> releases the reservation with a zero-unit record that names it, so the money is back before the exception reaches your code. The harder case is a worker that goes away without a word: the process exits, the machine restarts, the network drops. Nothing will ever settle that reservation.</p>

  <p>So every reservation expires. Each approved preflight returns <span class="inline">reservation_expires_at</span>, 60 minutes out on the hosted service, and a sweeper reclaims the ones that pass it. That needed one change to the shape of the data. <span class="inline">reserved_units</span> is a counter, and a counter can't be swept, because it doesn't know how much of itself is stale. So a reservation is also a row, and the counter is the sum of the open rows:</p>

  <div class="code"><pre>
<span class="comment">-- The invariant every path keeps</span>
task_budgets.reserved_units = SUM(units) of the job's open reservation rows</pre></div>

  <p>Which makes the sweep boring, and boring is the goal here:</p>

  <div class="code"><pre>
<span class="comment">-- The sweeper's claim, trimmed. Expired rows and their</span>
<span class="comment">-- units go back in ONE transaction. SKIP LOCKED because</span>
<span class="comment">-- production runs two machines, and both sweep.</span>
UPDATE reservations SET released_at = now()
WHERE id IN (
  SELECT id FROM reservations
  WHERE released_at IS NULL AND expires_at &lt; now()
  ORDER BY expires_at LIMIT 500
  FOR UPDATE SKIP LOCKED
)
RETURNING id, account_id, task_ref, units</pre></div>


  <h2>The late settle</h2>

  <p>Now two different things can close the same reservation: the sweeper, and a record that arrives late. A queued retry, a slow worker, a caller that held on to the id for an hour. If the record takes its reservation off the counter no matter what, those units come off twice, once by the sweeper and once by the settle. The counter then sits <em>below</em> what's really in flight, and preflight starts approving calls against money another call is still holding. A double release is a double spend.</p>

  <p>So a record doesn't take off what it thinks was reserved. It closes the reservation it names, and takes off what that row was still holding, which is nothing if the sweeper got there already:</p>

  <div class="code"><pre>
<span class="comment">-- record() names the reservation its preflight returned</span>
UPDATE reservations SET released_at = now()
WHERE id = :reservation_id AND released_at IS NULL
RETURNING units                  <span class="comment">-- :returned, or no row (0) if the sweeper took it</span>

<span class="comment">-- then, in the same transaction</span>
UPDATE task_budgets
SET used_units     = used_units + :cost,
    reserved_units = GREATEST(0, reserved_units - :returned)</pre></div>

  <p>The cost always goes in, because the call really ran. The reservation comes out once, whichever of the two got there before the other.</p>


  <h2>The retry that reserved twice</h2>

  <p>One more hole, and it was in the mechanism that exists to prevent waste. <span class="inline">/events</span> has enforced <span class="inline">(account_id, idempotency_key)</span> as unique from the start. <span class="inline">/preflight</span> had nothing, so a client that retried a timed-out preflight reserved a second time, and an eager retry policy could use up a job's ceiling without a single model call behind it.</p>

  <p>preflight takes the same <span class="inline">idempotency_key</span> now. The key is claimed inside the reserving transaction, so a duplicate waits on the unique index instead of racing: same key, same decision, one reservation. A retry that lands while the original is still being decided gets <span class="inline">409 preflight_in_progress</span>, which isn't a refusal and reserves nothing.</p>

  <p>Notice which way all of this fails. A reservation that never settles makes the ceiling tighter for an hour, never looser: the call that gets <span class="inline">approved: false</span> is a later one, until the sweeper gives the money back. Every choice above keeps that direction.</p>


  <h2>The test that runs on every change</h2>

  <p>We don't take the UPDATE's word for it. On every change, CI opens a job with a $1.00 ceiling and fires 40 preflights at it at once, each at the $0.10 default. It passes when exactly 10 are approved, 30 come back <span class="inline">approved: false</span> with <span class="inline">task_ceiling_exceeded</span>, the job's <span class="inline">reserved_units</span> is the ceiling to the micro-dollar, and the open reservation rows add up to the same number. A second job does it again at the caller's own $0.03 estimate and expects 33 approvals, $0.99, never 34.</p>

  <div class="code"><pre>
40 preflights at once on a $1.00 job, $0.10 each

approved                                   10
approved: false (task_ceiling_exceeded)    30
task_budgets.reserved_units         1,000,000   = the ceiling
sum of open reservation rows        1,000,000</pre></div>

  <p>If someone changes that UPDATE into a read and a write, this is the test that goes red.</p>


  <h2>Using it</h2>

  <p>You don't write any of the SQL above. <span class="inline">wrap()</span> puts a preflight in front of each provider call and a record after it, so five parallel workers on one <span class="inline">task_ref</span> draw from one ceiling, in one process or in five.</p>

  <p><strong>Python</strong></p>
  <div class="code"><pre>pip install -U agentbill-sdk openai</pre></div>

  <div class="code"><pre>
from concurrent.futures import ThreadPoolExecutor
from openai import OpenAI
from agentbill import wrap, Refusal

<span class="comment"># Reads AGENTBILL_API_KEY; OpenAI() reads OPENAI_API_KEY.</span>
<span class="comment"># job-142 opens in dollars with a $5.00 ceiling.</span>
llm = wrap(OpenAI(), task_ref="job-142", agent_id="researcher",
           task_ceiling_usd=5)

def look_up(topic):
    reply = llm.chat.completions.create(
        model="gpt-4o-mini",
        max_tokens=300,
        messages=[{"role": "user", "content": f"One line on {topic}."}],
    )
    if isinstance(reply, Refusal):
        <span class="comment"># approved: false. This call was not sent. Your code decides.</span>
        return None
    return reply.choices[0].message.content

topics = ["row locks", "idempotency keys", "reservations",
          "sweepers", "list prices"]
with ThreadPoolExecutor(max_workers=5) as pool:
    print(list(pool.map(look_up, topics)))</pre></div>

  <p><strong>Node.js</strong></p>
  <div class="code"><pre>npm install agentbill openai</pre></div>

  <div class="code"><pre>
import OpenAI from 'openai'
import { wrap, isRefusal } from 'agentbill'

<span class="comment">// Reads AGENTBILL_API_KEY; new OpenAI() reads OPENAI_API_KEY.</span>
<span class="comment">// job-142 opens in dollars with a $5.00 ceiling.</span>
const llm = wrap(new OpenAI(), {
  taskRef: 'job-142', agentId: 'researcher', taskCeilingUsd: 5,
})

const topics = ['row locks', 'idempotency keys', 'reservations',
                'sweepers', 'list prices']
const ask = (topic) => llm.chat.completions.create({
  model: 'gpt-4o-mini', max_tokens: 300,
  messages: [{ role: 'user', content: 'One line on ' + topic + '.' }],
})
const replies = await Promise.all(topics.map(ask))
for (const reply of replies) {
  <span class="comment">// approved: false. This call was not sent. Your code decides.</span>
  if (isRefusal(reply)) console.log(String(reply))
  else console.log(reply.choices[0].message.content)
}</pre></div>

  <p>AgentBill is an SDK inside your process, not a proxy. The call goes from your code to your provider, and AgentBill sees the provider's name, the model, the token counts and the job, never the prompt or the answer.</p>


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
