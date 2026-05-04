import { FastifyInstance } from 'fastify'

export async function homeRoute(app: FastifyInstance) {
  app.get('/', async (request, reply) => {
    return reply.type('text/html').send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AgentBill — Stop runaway AI agents before they start</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0a0a0a; color: #e5e5e5; font-family: 'Courier New', monospace; }
    .container { max-width: 720px; margin: 0 auto; padding: 80px 24px; }
    h1 { font-size: 28px; font-weight: 700; color: #ffffff; margin-bottom: 16px; line-height: 1.3; }
    .sub { font-size: 16px; color: #888; margin-bottom: 48px; line-height: 1.6; }
    .code-block { background: #111; border: 1px solid #222; border-radius: 8px; padding: 24px; margin-bottom: 48px; overflow-x: auto; }
    .code-block pre { font-size: 14px; color: #a8ff78; line-height: 1.7; }
    .comment { color: #555; }
    .quote-block { border-left: 2px solid #333; padding-left: 20px; margin-bottom: 48px; }
    .quote { font-size: 15px; color: #aaa; font-style: italic; margin-bottom: 8px; }
    .quote-author { font-size: 13px; color: #555; }
    .cta { display: inline-block; background: #ffffff; color: #000000; padding: 14px 28px; border-radius: 6px; text-decoration: none; font-weight: 700; font-size: 15px; }
    .cta:hover { background: #e5e5e5; }
    .not-for { margin-top: 64px; border-top: 1px solid #1a1a1a; padding-top: 48px; }
    .not-for h2 { font-size: 16px; color: #555; margin-bottom: 16px; }
    .not-for ul { list-style: none; }
    .not-for li { color: #555; font-size: 14px; margin-bottom: 8px; padding-left: 16px; }
    .not-for li::before { content: "x  "; color: #333; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Stop runaway AI agents<br>before they start.</h1>
    <p class="sub">
      A preflight gate for every agent run.<br>
      Budget exceeded? GPU quota hit? Free tier exhausted?<br>
      Block it before the first token — not after the bill arrives.
    </p>
    <div class="code-block">
      <pre>
<span class="comment"># 3 lines. That's it.</span>
from agentbill import AgentBillClient

client = AgentBillClient(api_key="agb_your_key")

<span class="comment"># Block before the run starts</span>
check = client.preflight(agent_id="researcher", budget=5.00)
if not check.approved:
    raise Exception("Budget exceeded")

<span class="comment"># Record the outcome</span>
client.record(agent_id="researcher", cost=check.estimated_cost)
      </pre>
    </div>
    <div class="quote-block">
      <p class="quote">"The moment you're using Stripe as your safety net, you've already lost the run."</p>
      <p class="quote-author">— scarlett1908, r/LangChain</p>
    </div>
    <div class="quote-block">
      <p class="quote">"Works whether you're paying OpenAI $0.01/token or burning your own GPU at 3am."</p>
      <p class="quote-author">— the point</p>
    </div>
    <a href="/register" class="cta">Get your API key</a>
    <div class="not-for">
      <h2>What AgentBill does NOT do</h2>
      <ul>
        <li>Multi-step workflows with reversal logic (out of scope)</li>
        <li>Replace your payment processor (we sit in front of it)</li>
        <li>No-code dashboard for non-developers</li>
      </ul>
    </div>
  </div>
</body>
</html>
    `)
  })
}
