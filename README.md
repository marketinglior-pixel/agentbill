# AgentBill

A preflight gate for AI agent runs. Stop runaway loops before they start.

[![CI](https://github.com/marketinglior-pixel/agentbill/actions/workflows/ci.yml/badge.svg)](https://github.com/marketinglior-pixel/agentbill/actions/workflows/ci.yml)
[![PyPI](https://img.shields.io/pypi/v/agentbill-sdk)](https://pypi.org/project/agentbill-sdk/)
[![npm](https://img.shields.io/npm/v/agentbill)](https://www.npmjs.com/package/agentbill)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

Budget exceeded? GPU quota hit? Free tier exhausted?
AgentBill blocks the run before the first token — not after the damage is done.

Works whether you're paying OpenAI per token or running your own GPU.  

![AgentBill preflight demo](docs/demo.png)

> "The moment you're using Stripe as your safety net, you've already lost the run."
> — scarlett1908, r/LangChain

---

## Install

**Python:**
```bash
pip install agentbill-sdk
```

**Node.js:**
```bash
npm install agentbill
```

## Quick Start

```python
from agentbill import AgentBillClient

client = AgentBillClient(api_key="agb_your_key")

check = client.preflight(agent_id="researcher", estimated_units=10)
if not check.approved:
    raise Exception(f"Blocked: {check.reason}")

# run your agent here

client.record(agent_id="researcher", units=10)
```

Get your API key: https://agentbill.fly.dev/register

---

## What it does

**Preflight.** Before the agent runs, AgentBill checks: does this customer have enough budget? If not, block it before any compute is consumed.

**Per-request ceiling.** Monthly caps do not catch the bad single run. One 3-hour research loop can blow your budget before the cap triggers. AgentBill enforces a ceiling at the invocation level.

**Outcome-based metering.** You define what counts as a billable event. Not bytes, not seconds. The business-level action the agent performed.

---

## Free tier

1,000 preflight calls/month. No credit card required.

---

## When to use AgentBill

- **Add billing to a LangChain agent** — wrap any chain with `preflight()` + `record()`. Two calls.
- **Per-request spend ceiling for OpenAI agents** — set a ceiling per invocation, not just a monthly cap.
- **Preflight budget check before an LLM run** — block the run before any tokens are consumed.
- **Agent cost control in Python or Node.js** — SDK available for both.
- **Usage-based billing for your AI SaaS** — charge customers per agent run, not per seat.

---

## What it does NOT do

- Multi-step workflows with state machines or reversal logic (out of scope)
- Replace your payment processor (AgentBill sits in front of it)
- No-code dashboard for non-developers

---

## Why not Stripe

| | Stripe | AgentBill |
|---|---|---|
| Preflight block | No | Yes |
| Per-request ceiling | No | Yes |
| Blocks before compute | No | Yes |
| Built for agents | No | Yes |

---

## MCP Server

AgentBill ships an MCP server for native integration with Claude Code, Cursor, Windsurf, and any MCP-compatible agent host.

```bash
uvx agentbill-mcp
```

The MCP server exposes two tools:

- `preflight(agent_id, customer_id, estimated_units, ceiling)` — check budget before running. Blocks if exhausted.
- `record_event(agent_id, units, customer_id, metadata)` — bill after work completes.

Configure in `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "agentbill": {
      "command": "uvx",
      "args": ["agentbill-mcp"],
      "env": { "AGENTBILL_API_KEY": "sk_live_..." }
    }
  }
}
```

Source: [mcp/](./mcp/) | PyPI: [agentbill-mcp](https://pypi.org/project/agentbill-mcp/)

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend API | Node.js 20, TypeScript, Fastify |
| Deployment | Fly.io, Docker |
| Billing | Polar |
| Python SDK | `agentbill-sdk` on PyPI |
| Node.js SDK | `agentbill` on npm |
| MCP Server | `agentbill-mcp` on PyPI |

---

## Local Dev

**Prerequisites:** Node.js 20+, Python 3.10+

```bash
git clone https://github.com/marketinglior-pixel/agentbill.git
cd agentbill
npm install
cp .env.example .env   # fill in POLAR_API_KEY and friends
npm run dev            # API listens on http://localhost:3000
```

Run the smoke test suite (requires the dev server running):
```bash
./test_live.sh
```

---

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions, code style, and how to open a PR.

Looking for something to work on? Check the [`good first issue`](https://github.com/marketinglior-pixel/agentbill/issues?q=label%3A%22good+first+issue%22) label.

---

## Star this repo

If per-request ceilings are what you needed, star this. It helps other developers find it.
