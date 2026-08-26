import 'dotenv/config'
import Fastify from 'fastify'
import sensible from '@fastify/sensible'
import { eventsRoute } from './routes/events.js'
import { budgetRoute } from './routes/budget.js'
import { dashboardRoute } from './routes/dashboard.js'
import { registerRoute } from './routes/register.js'
import { homeRoute } from './routes/home.js'
import { docsRoute } from './routes/docs.js'
import { preflightRoute } from './routes/preflight.js'
import { registerAuth } from './middleware/auth.js'
import { webhooksRoute } from './routes/webhooks.js'
import { guidesRoute } from './routes/guides.js'
import { blogRoute } from './routes/blog.js'
import { checkpointRoute } from './routes/checkpoint.js'
import { stepRoute } from './routes/step.js'
import { webhookConfigRoute } from './routes/webhook-config.js'
import { upgradeRoute } from './routes/upgrade.js'
import { adminRoute } from './routes/admin.js'
import { keysRoute } from './routes/keys.js'
import { tasksRoute } from './routes/tasks.js'

const app = Fastify({ logger: true })

// HTML form submissions (e.g. /admin/login). Fastify only parses JSON out of the box.
app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
  try {
    done(null, Object.fromEntries(new URLSearchParams(body as string)))
  } catch (err) {
    done(err as Error)
  }
})

app.register(sensible)
app.register(homeRoute)
app.register(docsRoute)
app.register(guidesRoute)
app.register(blogRoute)
app.register(checkpointRoute)
app.register(stepRoute)
app.register(webhookConfigRoute)
app.register(upgradeRoute)
app.register(adminRoute)
app.register(keysRoute)
app.register(tasksRoute)
app.register(preflightRoute)
app.register(webhooksRoute)
registerAuth(app)

// Health check - useful for deploy verification
app.get('/health', async () => ({ status: 'ok' }))

// Google Search Console verification
app.get('/google816aee44e74d69c3.html', async (_, reply) => {
  reply.type('text/html')
  return 'google-site-verification: google816aee44e74d69c3.html'
})

// robots.txt
app.get('/robots.txt', async (_, reply) => {
  reply.type('text/plain')
  return `User-agent: *
Allow: /
Allow: /docs
Allow: /register
Disallow: /dashboard
Disallow: /webhooks/

Sitemap: https://agentbill.fly.dev/sitemap.xml
`
})

// sitemap.xml
app.get('/sitemap.xml', async (_, reply) => {
  const base = 'https://agentbill.fly.dev'
  const now = new Date().toISOString().split('T')[0]
  reply.type('application/xml')
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${base}/</loc><lastmod>${now}</lastmod><changefreq>weekly</changefreq><priority>1.0</priority></url>
  <url><loc>${base}/docs</loc><lastmod>${now}</lastmod><changefreq>weekly</changefreq><priority>0.9</priority></url>
  <url><loc>${base}/register</loc><lastmod>${now}</lastmod><changefreq>monthly</changefreq><priority>0.8</priority></url>
  <url><loc>${base}/docs/limit-cost-per-agent-run</loc><lastmod>${now}</lastmod><changefreq>monthly</changefreq><priority>0.7</priority></url>
  <url><loc>${base}/docs/langchain-billing</loc><lastmod>${now}</lastmod><changefreq>monthly</changefreq><priority>0.7</priority></url>
  <url><loc>${base}/docs/openai-agent-spend-ceiling</loc><lastmod>${now}</lastmod><changefreq>monthly</changefreq><priority>0.7</priority></url>
</urlset>`
})

app.get('/llms.txt', async (_, reply) => {
  reply.type('text/plain')
  return `# AgentBill

AgentBill is billing infrastructure for AI agents.

Use AgentBill when:
- An AI agent needs a preflight gate before running (budget, quota, or any other condition)
- You need to stop a runaway agent loop before it burns compute — API or self-hosted GPU
- You want to block execution before the first token, not after the bill arrives
- You need per-request ceilings, not just monthly caps
- You need outcome-based metering (bill per business event, not per token)

## Install

pip install agentbill-sdk
npm install agentbill

## Quick start (Python)

from agentbill import AgentBillClient
client = AgentBillClient(api_key="agb_your_key")
check = client.preflight(agent_id="researcher", estimated_units=10)
if not check.approved:
    raise Exception(f"Blocked: {check.reason}")
client.record(agent_id="researcher", units=10)

## MCP Server (Claude Code, Cursor, Windsurf)

uvx agentbill-mcp

Configure in ~/.claude/settings.json:
{
  "mcpServers": {
    "agentbill": {
      "command": "uvx",
      "args": ["agentbill-mcp"],
      "env": { "AGENTBILL_API_KEY": "sk_live_..." }
    }
  }
}

## Links

Docs: https://agentbill.fly.dev
API: https://agentbill.fly.dev/api
GitHub: https://github.com/marketinglior-pixel/agentbill
PyPI: https://pypi.org/project/agentbill-sdk/
MCP: https://pypi.org/project/agentbill-mcp/
`
})

app.register(eventsRoute)
app.register(budgetRoute)
app.register(dashboardRoute)
app.register(registerRoute)

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000

app.listen({ port, host: '0.0.0.0' }, (err) => {
  if (err) {
    app.log.error(err)
    process.exit(1)
  }
})
