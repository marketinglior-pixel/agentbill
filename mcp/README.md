<!-- mcp-name: io.github.marketinglior-pixel/agentbill-mcp -->

# agentbill-mcp

One spend ceiling for one agent job, exposed as MCP tools. Bound to a `task_ref` you pass, not to a calendar month.

## Remote or local

This package is the **local** server: it runs on your machine over stdio, with your API key in its
environment. There is also a **remote** server at `https://agentbill.dev/mcp`, with a sign-in
instead of a key for Claude, ChatGPT and other clients, and three more tools. Setup for each client
is at [agentbill.dev/integrations/mcp](https://agentbill.dev/integrations/mcp). The package's HTTP
mode is for your own machine only; the hosted copy that once ran it was taken down on 2026-09-25.

## What it does

Exposes two tools to any MCP-compatible agent host (Claude Code, Cursor, Windsurf, etc.):

- `preflight(agent_id, customer_id, estimated_units, ceiling, task_ref, task_ceiling, idempotency_key)`. Check budget before starting work; answers approved=False with a reason when a ceiling or balance is spent. Pass `task_ref` with a `task_ceiling` to give one job a single cross-call budget that every later call in the job consults, and `idempotency_key` so a retried check cannot reserve the budget twice.
- `record_event(agent_id, units, customer_id, metadata)`. Record what the work used against that customer's balance, after it completes. Idempotent.

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

The server answers approved=False when the customer has no remaining balance, and the agent host decides what happens next. No code changes needed in your agent.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `AGENTBILL_API_KEY` | Yes | none | Your AgentBill API key |
| `AGENTBILL_BASE_URL` | No | `https://agentbill.dev` | Override for self-hosted. Must be `https`, or plain `http` to `localhost`, `127.0.0.1` or `[::1]` (since 0.3.0); anything else fails the tool call before a request is sent |
| `MCP_TRANSPORT` | No | `stdio` | Set to `http` to serve streamable HTTP at `/mcp` instead of stdio |
| `AGENTBILL_MCP_HOST` | No | `127.0.0.1` | HTTP mode only. Interface to bind |
| `AGENTBILL_MCP_PORT` | No | `8080` | HTTP mode only. Port to bind |
| `AGENTBILL_MCP_ALLOWED_HOSTS` | No | none | HTTP mode only. Extra `Host` header values to accept, comma separated (`mcp.example.com,10.0.0.5:*`) |
| `AGENTBILL_MCP_ALLOWED_ORIGINS` | No | none | HTTP mode only. Extra `Origin` values to accept, comma separated |

## HTTP mode

```bash
MCP_TRANSPORT=http AGENTBILL_API_KEY=agb_your_key_here uvx agentbill-mcp
```

The server listens on `127.0.0.1:8080` and checks the `Host` and `Origin` headers of every request (DNS-rebinding protection). A web page open in your browser can reach loopback addresses, and this server holds your API key, so both defaults stay on unless you change them on purpose.

To serve on another interface, set the bind address and name the host names clients will use. Requests carrying any other `Host` header are answered with 421:

```bash
MCP_TRANSPORT=http \
AGENTBILL_MCP_HOST=0.0.0.0 \
AGENTBILL_MCP_ALLOWED_HOSTS=mcp.example.com \
AGENTBILL_API_KEY=agb_your_key_here \
uvx agentbill-mcp
```

Loopback host names are always accepted. There is no setting that turns the header checks off. Anyone who can reach an exposed port can spend the key in its environment, so put it behind your own authentication.

## Links

- Docs: [agentbill.dev](https://agentbill.dev)
- Python SDK: `pip install agentbill-sdk`
- GitHub: [github.com/marketinglior-pixel/agentbill](https://github.com/marketinglior-pixel/agentbill)
