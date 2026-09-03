<!-- mcp-name: io.github.marketinglior-pixel/agentbill-mcp -->

# agentbill-mcp

AgentBill MCP server. Add spend controls and usage billing to any AI agent in 3 lines.

## What it does

Exposes two tools to any MCP-compatible agent host (Claude Code, Cursor, Windsurf, etc.):

- `preflight(agent_id, customer_id, estimated_units, ceiling, task_ref, task_ceiling, idempotency_key)`. Check budget before starting work, blocks if exhausted. Pass `task_ref` with a `task_ceiling` to give one job a single cross-call budget that every later call in the job consults, and `idempotency_key` so a retried check cannot reserve the budget twice.
- `record_event(agent_id, units, customer_id, metadata)`. Bill a customer after work completes. Idempotent.

## Install

```bash
uvx agentbill-mcp
```

No install needed. `uvx` runs it directly.

## Configure

### Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "agentbill": {
      "command": "uvx",
      "args": ["agentbill-mcp"],
      "env": {
        "AGENTBILL_API_KEY": "agb_your_key_here"
      }
    }
  }
}
```

### Cursor / Windsurf / other MCP clients

Add to your MCP config:

```json
{
  "agentbill": {
    "command": "uvx",
    "args": ["agentbill-mcp"],
    "env": {
      "AGENTBILL_API_KEY": "agb_your_key_here"
    }
  }
}
```

Get your API key at [agentbill.dev/register](https://agentbill.dev/register).

## Usage

Once configured, any agent using this MCP server can:

```
# Before running a task:
preflight(agent_id="research_agent", customer_id="user_123", estimated_units=5)

# After completing the task:
record_event(agent_id="research_agent", units=5, customer_id="user_123")
```

The server blocks the run if the customer has no remaining budget. No code changes needed in your agent.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `AGENTBILL_API_KEY` | Yes | none | Your AgentBill API key |
| `AGENTBILL_BASE_URL` | No | `https://agentbill.fly.dev` | Override for self-hosted |

## Links

- Docs: [agentbill.dev](https://agentbill.dev)
- Python SDK: `pip install agentbill-sdk`
- GitHub: [github.com/marketinglior-pixel/agentbill](https://github.com/marketinglior-pixel/agentbill)
