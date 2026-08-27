import { FastifyInstance } from 'fastify'
import { pixelSnippet } from '../lib/pixel.js'

export async function homeRoute(app: FastifyInstance) {
  app.get('/', async (request, reply) => {
    return reply.type('text/html').send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AgentBill · Billing Governance for AI Agents</title>
  <meta name="description" content="Hard budget ceilings for AI agents. Per-task, cross-provider, tool spend included, no proxy. Blocked before the first token. Free tier, API key in 30 seconds." />
  <meta name="keywords" content="billing for AI agents, AI agent budget limit, per task budget AI, LLM cost control, agent spend firewall, preflight billing, usage based billing AI, agentbill, langchain billing, AI agent spend" />
  <link rel="canonical" href="https://agentbill.dev/" />
  <!-- Open Graph -->
  <meta property="og:type" content="website" />
  <meta property="og:url" content="https://agentbill.dev/" />
  <meta property="og:title" content="AgentBill · Billing Governance for AI Agents" />
  <meta property="og:description" content="Block runaway agent spend before compute starts. Hard per-task ceilings, cross-provider, tools included. Not a tracker. A guardrail." />
  <meta property="og:site_name" content="AgentBill" />
  <meta property="og:image" content="https://agentbill.dev/og.png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="AgentBill · Billing Governance for AI Agents" />
  <meta name="twitter:description" content="Block runaway agent spend before compute starts. Hard per-task ceilings, cross-provider, tools included." />
  <meta name="twitter:image" content="https://agentbill.dev/og.png" />
  <!-- Structured data -->
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"SoftwareApplication","name":"AgentBill","applicationCategory":"DeveloperApplication","operatingSystem":"Any","description":"Hard per-task budget ceilings for AI agents. Block runaway spend before compute starts.","url":"https://agentbill.dev","offers":{"@type":"Offer","price":"0","priceCurrency":"USD","description":"Free tier: 1,000 preflight calls/month"}}</script>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --bg: #0a0a0a; --surface: #111111; --surface2: #161616;
      --border: #232323; --text: #e8ebe9; --muted: #a0a8a3; --dim: #6b736e;
      --green: #22d3a0; --code: #a8ff78; --red: #ff5757;
    }
    html { scroll-behavior: smooth; }
    @media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } * { transition: none !important; } }
    body { background: var(--bg); color: var(--text); font-family: 'Inter', system-ui, sans-serif;
           font-size: 16px; line-height: 1.65; -webkit-font-smoothing: antialiased; }
    .mono { font-family: 'JetBrains Mono', 'Courier New', monospace; }
    a { color: var(--green); }
    .wrap { max-width: 960px; margin: 0 auto; padding: 0 24px; }

    /* Nav */
    nav { position: sticky; top: 0; z-index: 10; background: rgba(10,10,10,0.88); backdrop-filter: blur(14px);
          border-bottom: 1px solid var(--border); }
    .nav-inner { max-width: 960px; margin: 0 auto; padding: 0 24px; height: 60px;
                 display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    .logo { display: flex; align-items: center; gap: 9px; font-family: 'JetBrains Mono', monospace;
            font-weight: 700; font-size: 16px; color: var(--text); text-decoration: none; }
    .dot { width: 8px; height: 8px; background: var(--green); border-radius: 50%;
           box-shadow: 0 0 10px rgba(34,211,160,0.7); }
    .nav-links { display: flex; align-items: center; gap: 22px; }
    .nav-links a { color: var(--muted); text-decoration: none; font-size: 14px; font-weight: 500; }
    .nav-links a:hover { color: var(--text); }
    .btn { display: inline-block; background: var(--green); color: #05130e; padding: 10px 18px;
           border-radius: 8px; text-decoration: none; font-weight: 700; font-size: 14px;
           transition: transform .15s, box-shadow .15s; }
    .btn:hover { transform: translateY(-1px); box-shadow: 0 6px 18px rgba(34,211,160,0.25); }
    @media (max-width: 640px) { .nav-links a:not(.btn) { display: none; } }

    /* Hero */
    .hero { padding: 88px 0 40px; }
    h1 { font-family: 'JetBrains Mono', 'Courier New', monospace; font-size: clamp(30px, 5.4vw, 46px);
         font-weight: 700; color: #ffffff; line-height: 1.22; letter-spacing: -0.5px; max-width: 21ch; }
    .sub { font-size: 18px; color: var(--muted); margin: 22px 0 30px; max-width: 56ch; }
    .hero-cta { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
    .btn-lg { padding: 14px 26px; font-size: 16px; border-radius: 10px; }
    .btn-ghost { display: inline-block; color: var(--muted); border: 1px solid var(--border);
                 padding: 13px 22px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 15px; }
    .btn-ghost:hover { color: var(--text); border-color: var(--dim); }
    .trust { margin-top: 18px; font-family: 'JetBrains Mono', monospace; font-size: 12.5px; color: var(--dim); }
    .trust b { color: var(--green); font-weight: 500; }

    /* Code */
    .code-block { background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
                  margin: 48px 0 0; overflow: hidden; }
    .code-head { display: flex; gap: 6px; padding: 12px 16px; border-bottom: 1px solid var(--border); background: var(--surface2); }
    .code-head span { width: 11px; height: 11px; border-radius: 50%; background: #2c2c2c; }
    .code-head span:first-child { background: #3a2a2a; }
    .code-body { padding: 22px 24px; overflow-x: auto; }
    .code-body pre { font-family: 'JetBrains Mono', 'Courier New', monospace; font-size: 13.5px;
                     color: var(--code); line-height: 1.75; }
    .cmt { color: #5a635d; }
    .out-blocked { color: var(--red); font-weight: 700; }
    .out-dim { color: var(--dim); }

    /* Quotes */
    .quotes { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; margin: 64px 0 0; }
    .quote { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 20px 22px; }
    .quote p { font-size: 14.5px; color: var(--muted); line-height: 1.6; }
    .quote span { display: block; margin-top: 12px; font-family: 'JetBrains Mono', monospace;
                  font-size: 11.5px; color: var(--dim); }

    /* Features */
    section { padding: 72px 0 0; }
    .eyebrow { font-family: 'JetBrains Mono', monospace; font-size: 12px; font-weight: 700;
               letter-spacing: 2px; text-transform: uppercase; color: var(--green); margin-bottom: 14px; }
    h2 { font-family: 'JetBrains Mono', monospace; font-size: 26px; color: #fff; letter-spacing: -0.3px; margin-bottom: 28px; }
    .features { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }
    .feature { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 24px; }
    .feature h3 { font-family: 'JetBrains Mono', monospace; font-size: 15.5px; color: var(--text); margin-bottom: 10px; }
    .feature h3::before { content: "▸ "; color: var(--green); }
    .feature p { font-size: 14px; color: var(--muted); line-height: 1.65; }

    /* Pricing strip */
    .price-strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
    .price { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 20px; text-align: center; }
    .price.hot { border-color: rgba(34,211,160,0.45); }
    .price .tier { font-family: 'JetBrains Mono', monospace; font-size: 12px; letter-spacing: 1.5px;
                   text-transform: uppercase; color: var(--muted); }
    .price .amount { font-size: 26px; font-weight: 800; color: #fff; margin: 8px 0 2px; }
    .price .amount small { font-size: 13px; color: var(--dim); font-weight: 400; }
    .price .inc { font-size: 12.5px; color: var(--dim); }
    .price-links { margin-top: 20px; display: flex; gap: 14px; align-items: center; }

    /* Not-for */
    .not-for ul { list-style: none; }
    .not-for li { color: var(--muted); font-size: 14.5px; margin-bottom: 10px; padding-left: 22px; position: relative; }
    .not-for li::before { content: "x"; position: absolute; left: 0; color: var(--red);
                          font-family: 'JetBrains Mono', monospace; font-weight: 700; }

    /* Final CTA + footer */
    .final { text-align: center; padding: 88px 0; }
    .final h2 { margin-bottom: 10px; }
    .final p { color: var(--muted); margin-bottom: 26px; }
    footer { border-top: 1px solid var(--border); padding: 28px 0 48px; }
    .foot-inner { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; }
    .foot-links a { color: var(--dim); text-decoration: none; font-size: 13.5px; margin-right: 18px; }
    .foot-links a:hover { color: var(--text); }
    .foot-brand { font-family: 'JetBrains Mono', monospace; font-size: 12.5px; color: var(--dim); }
  </style>
  ${pixelSnippet()}
</head>
<body>
  <nav>
    <div class="nav-inner">
      <a class="logo" href="/"><span class="dot"></span>AgentBill</a>
      <div class="nav-links">
        <a href="/docs">Docs</a>
        <a href="/pricing">Pricing</a>
        <a href="https://github.com/marketinglior-pixel/agentbill">GitHub</a>
        <a class="btn" href="/register">Get API key</a>
      </div>
    </div>
  </nav>

  <header class="hero wrap">
    <h1>Stop runaway AI agents before they start.</h1>
    <p class="sub">A hard budget ceiling for every agent task. Cross-provider, tool spend included,
    no proxy in your request path. Blocked before the first token, not after the bill arrives.</p>
    <div class="hero-cta">
      <a class="btn btn-lg" href="/register">Get your API key &rarr;</a>
      <a class="btn-ghost" href="/docs">Read the docs</a>
    </div>
    <p class="trust"><b>free tier</b> · 1,000 preflight calls/mo · no card · key in 30 seconds</p>

    <div class="code-block">
      <div class="code-head"><span></span><span></span><span></span></div>
      <div class="code-body">
        <pre><span class="cmt"># 3 lines. That's it.</span>
from agentbill import AgentBillClient

client = AgentBillClient(api_key="agb_your_key")

<span class="cmt"># This job dies at $5, across every call and tool it makes</span>
check = client.preflight(agent_id="researcher", task_ref="job-142", budget=5.00)
if not check.approved:
    raise Exception(check.reason)

<span class="out-dim">&gt;&gt;&gt; run 47 of the retry loop:</span>
<span class="out-blocked">blocked: task_ceiling_exceeded</span> <span class="out-dim">($5.00 ceiling)</span></pre>
      </div>
    </div>

    <div class="quotes">
      <div class="quote">
        <p>"The moment you're using Stripe as your safety net, you've already lost the run."</p>
        <span>scarlett1908, r/LangChain</span>
      </div>
      <div class="quote">
        <p>"Hard spend caps and kill switches need to be table stakes, not edge cases."</p>
        <span>r/AI_Agents</span>
      </div>
      <div class="quote">
        <p>"Agents fail quietly. By spending your money while you sleep."</p>
        <span>r/AI_Agents, 268&uarr; thread</span>
      </div>
    </div>
  </header>

  <section class="wrap">
    <div class="eyebrow">The gap providers admit</div>
    <h2>Monthly caps don't stop tonight's loop.</h2>
    <div class="features">
      <div class="feature">
        <h3>Per-task ceilings</h3>
        <p>One job, many calls, one budget. "This task dies at $5." Provider spend caps stop at
        monthly org totals; your ceiling stops the run that's burning money right now.</p>
      </div>
      <div class="feature">
        <h3>Cross-provider, tools included</h3>
        <p>One ceiling across OpenAI, Anthropic, your own GPU, and every tool call in the run.
        Not per vendor. Per job. With per-agent attribution for every dollar.</p>
      </div>
      <div class="feature">
        <h3>No proxy in your request path</h3>
        <p>An SDK call, not a gateway. Nothing to route your traffic through, nothing to deploy,
        nothing to compromise. The ceiling is something your tools consult.</p>
      </div>
    </div>
  </section>

  <section class="wrap">
    <div class="eyebrow">Pricing</div>
    <h2>Free to start. Insurance-cheap to scale.</h2>
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
    <div class="eyebrow">Honesty section</div>
    <h2>What AgentBill does NOT do</h2>
    <ul>
      <li>Multi-step workflows with reversal logic (out of scope)</li>
      <li>Replace your payment processor (we sit in front of it)</li>
      <li>No-code dashboard for non-developers</li>
    </ul>
  </section>

  <div class="final wrap">
    <h2>Your agent gets a budget now.</h2>
    <p>Free tier. No card. If this page took you longer to read than the integration takes, we did our job.</p>
    <a class="btn btn-lg" href="/register">Get your API key &rarr;</a>
  </div>

  <footer>
    <div class="wrap foot-inner">
      <div class="foot-links">
        <a href="/docs">Docs</a><a href="/pricing">Pricing</a><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="https://github.com/marketinglior-pixel/agentbill">GitHub</a>
      </div>
      <div class="foot-brand">agentbill.dev · what counts, who pays, what's blocked.</div>
    </div>
  </footer>
</body>
</html>
    `)
  })
}
