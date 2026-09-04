import { FastifyInstance } from 'fastify'
import { head } from '../ui/theme.js'
import { siteNav, siteFooter, CHROME_CSS } from '../ui/chrome.js'
import { pixelSnippet } from '../lib/pixel.js'

export async function homeRoute(app: FastifyInstance) {
  app.get('/', async (request, reply) => {
    return reply.type('text/html').send(`${head({
      title: 'AgentBill · Hard budget ceilings for AI agents',
      description: 'Hard budget ceilings for AI agents. One ceiling per task. Every call that shares the task ref draws it down, whatever the provider, on units you define. Blocked before the first token. Free tier, API key in 30 seconds.',
      canonical: 'https://agentbill.dev/',
      extraHead: `  <meta name="keywords" content="billing for AI agents, AI agent budget limit, per task budget AI, LLM cost control, agent spend firewall, preflight billing, usage based billing AI, agentbill, langchain billing, AI agent spend" />
  <!-- Open Graph -->
  <meta property="og:type" content="website" />
  <meta property="og:url" content="https://agentbill.dev/" />
  <meta property="og:title" content="AgentBill · Hard budget ceilings for AI agents" />
  <meta property="og:description" content="Block runaway agent spend before compute starts. One hard ceiling per task, consulted by every call in the job. Not a tracker. A guardrail." />
  <meta property="og:site_name" content="AgentBill" />
  <meta property="og:image" content="https://agentbill.dev/og.png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="AgentBill · Hard budget ceilings for AI agents" />
  <meta name="twitter:description" content="Block runaway agent spend before compute starts. One hard ceiling per task, consulted by every call in the job." />
  <meta name="twitter:image" content="https://agentbill.dev/og.png" />
  <!-- Structured data -->
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"SoftwareApplication","name":"AgentBill","applicationCategory":"DeveloperApplication","operatingSystem":"Any","description":"Hard per-task budget ceilings for AI agents. Block runaway spend before compute starts.","url":"https://agentbill.dev","offers":{"@type":"Offer","price":"0","priceCurrency":"USD","description":"Free tier: 1,000 preflight calls/month"}}</script>
  ${pixelSnippet()}`,
      css: `${CHROME_CSS}

    /* .wrap owns the inline axis; every block-axis rule below uses padding-block,
       so neither can wipe the other via the padding shorthand. */
    .wrap { max-width: var(--shell); margin: 0 auto; padding-inline: 24px; }

    /* Hero */
    .hero { padding-block: 88px 40px; }
    h1 { color: var(--white); max-width: 17ch; }
    .sub { font-size: var(--fs-lede); color: var(--muted); margin: 24px 0 32px; max-width: 54ch; }
    .hero-cta { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
    .btn-lg { padding: 14px 26px; font-size: 16px; border-radius: 10px; }
    .btn-ghost { display: inline-block; color: var(--muted); border: 1px solid var(--border-strong);
                 padding: 13px 22px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 15px; }
    .btn-ghost:hover { color: var(--text); border-color: var(--dim); }
    .trust { margin-top: 18px; font-family: 'JetBrains Mono', monospace; font-size: 12.5px; color: var(--dim); }
    .trust b { color: var(--green); font-weight: 500; }

    /* Code */
    .code-block { background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
                  margin: 48px 0 0; overflow: hidden; }
    .code-head { display: flex; gap: 6px; padding: 12px 16px; border-bottom: 1px solid var(--border); background: var(--surface2); }
    .code-head span { width: 11px; height: 11px; border-radius: 50%; background: var(--border2); }
    .code-head span:first-child { background: #3a2a2a; }
    .code-body { padding: 22px 24px; overflow-x: auto; }
    .code-body pre { font-family: 'JetBrains Mono', 'Courier New', monospace; font-size: 13.5px;
                     color: var(--code); line-height: 1.75; }
    @media (max-width: 640px) {
      .code-body { padding: 18px 16px; }
      .code-body pre { font-size: 12px; white-space: pre-wrap; word-break: break-word; }
      .out-blocked { display: block; margin-top: 6px; }
    }
    .cmt { color: #79837c; }
    .out-blocked { color: var(--red); font-weight: 700; }
    .out-dim { color: var(--dim); }

    /* Features */
    section { padding-block: 72px 0; }
    h2 { color: var(--white); margin-bottom: 32px; max-width: 20ch; }
    .features { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }
    .feature { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 24px; }
    .feature h3 { color: var(--white); margin-bottom: 12px; }
    .feature p { font-size: var(--fs-small); color: var(--muted); line-height: 1.7; }

    /* Pricing strip */
    .price-strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
    .price { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 20px; text-align: center; }
    .price.hot { border-color: rgba(34,211,160,0.45); }
    .price .tier { font-family: 'JetBrains Mono', monospace; font-size: 12px; letter-spacing: 1.5px;
                   text-transform: uppercase; color: var(--muted); }
    .price .amount { font-family: var(--display); font-size: 30px; font-weight: 800;
                     letter-spacing: -0.02em; color: var(--white); margin: 8px 0 2px; }
    .price .amount small { font-size: 13px; color: var(--dim); font-weight: 400; }
    .price .inc { font-size: 12.5px; color: var(--dim); }
    .price-links { margin-top: 20px; display: flex; gap: 14px; align-items: center; }

    /* Not-for */
    .not-for ul { list-style: none; }
    .not-for li { color: var(--muted); font-size: var(--fs-small); margin-bottom: 12px; padding-left: 22px; position: relative; }
    .not-for li::before { content: "x"; position: absolute; left: 0; color: var(--red);
                          font-family: 'JetBrains Mono', monospace; font-weight: 700; }

    /* Final CTA */
    .final { text-align: center; padding-block: 88px; }
    .final h2 { margin-bottom: 10px; }
    .final p { color: var(--muted); margin-bottom: 26px; }
`,
    })}
<body>
${siteNav('/')}

  <header class="hero wrap">
    <h1>Your loop won't stop itself.</h1>
    <p class="sub">One hard ceiling per task. Every call in that job checks it before it runs,
    whatever the provider, and you pass what each call is worth. Blocked before the call goes out,
    not after the bill shows up.</p>
    <div class="hero-cta">
      <a class="btn btn-lg" href="/register">Get your API key &rarr;</a>
      <a class="btn-ghost" href="/app?demo=1">See a live console</a>
      <a class="btn-ghost" href="/docs">Read the docs</a>
    </div>
    <p class="trust"><b>free tier</b> · 1,000 preflight calls/mo · no card · key in 30 seconds</p>

    <div class="code-block">
      <div class="code-head"><span></span><span></span><span></span></div>
      <div class="code-body">
        <pre><span class="cmt"># 3 lines. That's it.</span>
from agentbill import AgentBillClient

client = AgentBillClient(api_key="agb_your_key")

<span class="cmt"># Units are yours. Here 1 unit = 1 cent, so this job stops at</span>
<span class="cmt"># 500 units. Every call passing the same task_ref draws it down.</span>
client.preflight(agent_id="researcher", task_ref="job-142",
                 task_ceiling=500, estimated_units=12)

<span class="out-dim">&gt;&gt;&gt; run 42 of the retry loop:</span>
<span class="out-blocked">TaskCeilingExceededError:</span> <span class="out-dim">Task 'job-142' blocked: 492/500 units used, 8 remaining is not enough for this call.</span></pre>
      </div>
    </div>
  </header>

  <section class="wrap">
    <h2>Monthly caps don't stop tonight's loop.</h2>
    <div class="features">
      <div class="feature">
        <h3>Per-task ceilings</h3>
        <p>One job, many calls, one budget. "This task dies at 500 units," and you decide what a
        unit is worth. Provider spend caps stop at monthly org totals. Yours stops the run that's
        burning money right now.</p>
      </div>
      <div class="feature">
        <h3>One ceiling, any provider</h3>
        <p>OpenAI, Anthropic, your own GPU, a tool call. Whatever it is, if it passes the same
        task_ref it draws down the same ceiling, and you decide what it costs in units. We never
        look at your provider bill. Not per vendor, per job, with per-agent attribution.</p>
      </div>
      <div class="feature">
        <h3>No proxy in your request path</h3>
        <p>An SDK call, not a gateway. Nothing to route your traffic through, nothing to deploy,
        nothing to compromise. The ceiling is something your tools consult.</p>
      </div>
    </div>
  </section>

  <section class="wrap">
    <h2>Free to start. Cheap enough to leave on.</h2>
    <div class="price-strip">
      <div class="price"><div class="tier">Free</div><div class="amount">$0</div><div class="inc">1,000 calls/mo</div></div>
      <div class="price"><div class="tier">Builder</div><div class="amount">$29<small>/mo</small></div><div class="inc">50,000 calls/mo</div></div>
      <div class="price hot"><div class="tier">Team</div><div class="amount">$99<small>/mo</small></div><div class="inc">500,000 calls/mo</div></div>
      <div class="price"><div class="tier">Scale</div><div class="amount">$299<small>/mo</small></div><div class="inc">2,000,000 calls/mo</div></div>
    </div>
    <div class="price-links">
      <a class="btn" href="/register">Start free</a>
      <a class="btn-ghost" href="/pricing">Full pricing</a>
    </div>
  </section>

  <section class="wrap not-for">
    <h2>What AgentBill does NOT do</h2>
    <ul>
      <li>Undo a multi-step workflow. We stop calls, we don't unwind them.</li>
      <li>Replace your payment processor. We sit in front of it.</li>
      <li>Give your ops team a no-code dashboard. This is an SDK.</li>
    </ul>
  </section>

  <div class="final wrap">
    <h2>Give one job a ceiling.</h2>
    <p>Free tier. No card. If this page took you longer to read than the integration takes, we did our job.</p>
    <a class="btn btn-lg" href="/register">Get your API key &rarr;</a>
  </div>

${siteFooter()}
</body>
</html>
    `)
  })
}
