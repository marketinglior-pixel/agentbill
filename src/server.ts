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

const app = Fastify({ logger: true })

app.register(sensible)
app.register(homeRoute)
app.register(docsRoute)
app.register(guidesRoute)
app.register(blogRoute)
app.register(checkpointRoute)
app.register(stepRoute)
app.register(webhookConfigRoute)
app.register(upgradeRoute)
app.register(preflightRoute)
app.register(webhooksRoute)
registerAuth(app)

// Health check - useful for deploy verification
app.get('/health', async () => ({ status: 'ok' }))

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
