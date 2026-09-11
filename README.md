# AgentBill

One spend ceiling for one agent job, consulted before each call. Bound to a `task_ref` you pass, not to a calendar month, a project or an API key.

[![CI](https://github.com/marketinglior-pixel/agentbill/actions/workflows/ci.yml/badge.svg)](https://github.com/marketinglior-pixel/agentbill/actions/workflows/ci.yml)
[![PyPI](https://img.shields.io/pypi/v/agentbill-sdk)](https://pypi.org/project/agentbill-sdk/)
[![npm](https://img.shields.io/npm/v/agentbill)](https://www.npmjs.com/package/agentbill)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

A long agent run is many calls, often across several processes and more than one provider. A cap bound to a project, an organization or a calendar month is measured over that period. A per-call limit only ever sees one call. Neither of them is bound to the job.

AgentBill gives the job its own ceiling. Every call that passes the same `task_ref` draws against that one number, wherever it runs. Before the expensive call your code asks; AgentBill reserves and answers; your code decides what happens next.

It is an SDK and an HTTP API, not a proxy. Nothing sits in your request path.

<div align="center">

![A refused preflight response: approved false, reason ceiling_exceeded](docs/demo.png)

</div>

That is the whole contract. `preflight()` returns a decision or raises for you to catch, and your `except` block chooses whether to degrade, retry smaller, or return what you already have.

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

Get an API key: https://agentbill.dev/register. Free, no card. Both SDKs default to `https://agentbill.fly.dev`, which serves the same application as `agentbill.dev`.

## Quick Start

The ceiling belongs to the job, and it is set before the code runs: in the console at [agentbill.dev/app](https://agentbill.dev/app) (three steps from a new key to a first refusal) or with `PUT /tasks/:task_ref/ceiling`. The code then names the job and nothing about the budget. A `task_ceiling` on the first preflight of a new `task_ref` opens the job from code instead; once the job exists it is not applied, so a retry cannot quietly raise the ceiling it was meant to respect, and the last save through the endpoint or the console is the one in force.

```python
from agentbill import AgentBillClient, TaskCeilingExceededError

client = AgentBillClient(api_key="agb_your_key")

def research_step(query):
    try:
        client.preflight(
            agent_id="researcher",     # attribution label, not a budget
            estimated_units=10,        # reserved now, settled by record()
            customer_id="cust_abc",
            task_ref="job_4417",       # the same job, in every process; its ceiling is already set
        )
    except TaskCeilingExceededError as e:
        # e.task_ref, e.task_ceiling, e.task_used_units, e.task_remaining_units
        return partial_result()        # your code decides what happens next

    answer = call_the_expensive_model(query)   # your work, direct to your provider

    client.record(
        agent_id="researcher",
        units=10,                      # settle what preflight reserved
        customer_id="cust_abc",
        task_ref="job_4417",
        success=True,                  # False releases the hold, bills nothing
    )
    return answer
```

Every call in the run passes `task_ref` and nothing else about the budget. It does not need to know the ceiling or what the calls before it spent, which is what lets a second agent in a second process share one number:

```python
client.preflight(agent_id="writer", task_ref="job_4417", estimated_units=250)
```

**Node** has no client object. The key comes from `AGENTBILL_API_KEY` in the environment and the option keys are camelCase:

```typescript
import { preflight, record, TaskCeilingExceededError } from 'agentbill'

export async function researchStep(query: string) {
  try {
    await preflight({ agentId: 'researcher', estimatedUnits: 10, taskRef: 'job_4417' })
  } catch (e) {
    if (e instanceof TaskCeilingExceededError) return partialResult()
    throw e
  }

  const answer = await callTheExpensiveModel(query)
  await record({ agentId: 'researcher', units: 10, taskRef: 'job_4417' })
  return answer
}
```

### The decorator

`@client.gate` wraps a function with the same preflight and settles it for you: `record(success=True)` on a clean return, `record(success=False)` on an exception, then it re-raises.

```python
@client.gate(agent_id="researcher", estimated_units=10,
             task_ref="job_4417")       # the job's ceiling is already set
def summarize(doc):
    return call_the_expensive_model(doc)
```

Two things `gate` does not do: it takes no `idempotency_key`, and it raises a bare `Exception` for **any** non-approved result, including the two that `preflight()` deliberately returns instead of raising. Use `preflight()` directly when you need to tell those apart. It also settles the units it reserved rather than what the work actually cost, so use the explicit pair when the two differ.

### What raises, what comes back

The rule: **your** spend rule refusing raises. **AgentBill's own quota** refusing returns a result, because our billing state must not be able to crash your agent. All five are HTTP 200 with `approved: false`; none is an error status.

| Refusal | Python | Node |
|---|---|---|
| `ceiling_exceeded` | raises `CeilingExceededError` | throws `CeilingExceededError` |
| `budget_exhausted` | raises `BudgetExhaustedError` | throws `BudgetExhaustedError` |
| `task_ceiling_exceeded` | raises `TaskCeilingExceededError` | throws `TaskCeilingExceededError` |
| `free_tier_exceeded` | returns `approved=False`, `.upgrade_url` set | returns `approved: false`, `upgradeUrl` set |
| `plan_limit_exceeded` | returns `approved=False`, `.upgrade_url` set | returns `approved: false`, `upgradeUrl` set |

In Python, `FreeTierExceededError` and `PlanLimitExceededError` are still importable so existing `except` clauses keep working, but **nothing has raised them since 0.6.0**. Check `result.approved` and read `result.upgrade_url` instead. The Node SDK never had either class; it exports only `AgentBillError`, `BudgetExhaustedError`, `CeilingExceededError` and `TaskCeilingExceededError`.

Two more on the Python side: `TaskCeilingRequiredError` when a `task_ref` is new and arrived without a `task_ceiling` (422), and `PreflightInProgressError` when a preflight with the same `idempotency_key` is still being decided (409). Node surfaces both as `AgentBillError`. The exception sets are not symmetric.

### Reservations

An approved preflight holds `estimated_units` and returns `reservation_expires_at`. Settle it with `record()`. If you never do, a sweeper reclaims the reservation once it expires, 60 minutes by default, so an abandoned run cannot hold the job's budget forever. Note the direction: an unsettled reservation makes the ceiling tighter, never looser.

`idempotency_key` on `preflight()` makes a retry safe. Same key, same decision, one reservation. Without it a retried preflight reserves a second time, so the mechanism meant to prevent waste is the one consuming the budget.

---

## What it does

**Per-task spend ceiling.** One job spans many calls, several models and more than one process. Every call that passes the same `task_ref` draws against one ceiling, which is keyed on `(account_id, task_ref)`, so two workers on one job share one number without coordinating.

**Preflight reservation.** The check and the reservation are one conditional `UPDATE`, so two concurrent calls on the same job cannot both be approved against the last of the budget.

**Units you define.** A unit is an integer you pass. AgentBill reserves the number you send and never converts units to money. `1 unit = 1 cent` is a common convention, not a rule.

**Per-job ceilings from outside the code.** `PUT /tasks/:task_ref/ceiling` opens a job with a ceiling or changes one; a ceiling under the job's spent plus reserved units is refused with the smallest value that would be accepted.

**Per-customer ceilings.** `PUT /budget` sets one customer's `limit_units`, a ceiling separate from the task one.

**Read-back.** `GET /tasks` for live burn-down per job. `GET /decisions` for every refusal, each carrying the literal response body your SDK received.

---

## Pricing

| Tier | Calls/month | Price |
|---|---|---|
| Free | 1,000 | $0, no card |
| Builder | 50,000 | $29 / month |
| Team | 500,000 | $99 / month |
| Scale | 2,000,000 | $299 / month |

A call is one `POST /preflight`. The counter resets on the 1st of each calendar month. When you run out, the response carries `upgrade_url`, so your agent never needs a browser. No feature is gated by plan; the tiers sell headroom. Billing runs on [Polar](https://polar.sh).

---

## When to use AgentBill

- **One job, many calls, one ceiling.** A research loop, a batch, a multi-agent chain. Pass the same `task_ref` from every process working on it.
- **A ceiling that is not a calendar month.** A task budget is consulted on every preflight that names the task, rather than totalled at the end of a period.
- **Agent billing governance you can audit.** Every refusal is written down and readable through `GET /decisions`.
- **Units that match your business.** Cents, tokens, documents, minutes: whatever integer you choose to count.
- **Python, Node.js, or any MCP host.** One API underneath.

---

## What it does NOT do

Read this section before the pitch, not after.

- **It does not stop your run.** `preflight()` answers `approved: false` or raises. Your code decides what happens next. Nothing here can terminate a process it never sat in front of.
- **It is not a proxy or a gateway.** No base URL to change, no traffic routed through us, no provider credentials held by us.
- **No automatic metering.** Tokens, tool calls and GPU time are invisible to AgentBill. Units move only when your code calls `/preflight`, `/events` or `/step`, and they count against a job only when the call carries the same `task_ref`.
- **It never reads a provider invoice** and never turns units into dollars. There is no currency field anywhere in the API.
- **The ceiling is only as tight as your estimate.** Preflight reserves the number you send. Send 1, spend 100, and 99 of it was never seen.
- **No per-agent budget.** `agent_id` is an attribution label. Nothing is capped by it; ceilings live on a `task_ref`, a customer, or a single call.
- **It is not a payment processor.** It does not move money, hold cards or charge your end customers. Polar bills you for AgentBill; nothing bills anyone on your behalf. Stripe Connect is not shipped.
- **Not observability.** No traces, no spans, no prompt capture, no after-the-fact cost report.
- **No no-code dashboard.** There is a console; setting a customer's ceiling is API-only, deliberately.
- **No workflow engine.** No state machines, no reversal or compensation logic. Calls are refused, not reversed.
- **Recording is not enforcement.** `POST /events` records what happened even past the ceiling, because the spend already happened, and surfaces it as `task_exceeded`. A task ceiling is only ever enforced by preflight. (`POST /events` can refuse on a *customer* limit, with `402 budget_exhausted`.)

---

## MCP Server

AgentBill ships an MCP server for Claude Code, Cursor, Windsurf, and any MCP-compatible host.

```bash
uvx agentbill-mcp
```

Two tools:

- `preflight(agent_id, customer_id="default", estimated_units=1, ceiling=None, task_ref=None, task_ceiling=None, idempotency_key=None)`. Asks before the work starts. A refusal comes back as a dict with `approved: false` and a `reason` rather than as an exception, so the host agent can read it and decide.
- `record_event(agent_id, units=1, customer_id="default", metadata=None)`. Records what happened. Note it takes **no** `task_ref`, so an MCP-recorded event cannot settle or attribute to a task budget. Settle those through the SDK or `POST /events`.

Register it with your host. In Claude Code:

```bash
claude mcp add agentbill --env AGENTBILL_API_KEY=agb_... -- uvx agentbill-mcp
```

Hosts that take a JSON server map want this shape:

```json
{
  "mcpServers": {
    "agentbill": {
      "command": "uvx",
      "args": ["agentbill-mcp"],
      "env": { "AGENTBILL_API_KEY": "agb_..." }
    }
  }
}
```

If `uvx agentbill-mcp` fails on import you are on 0.1.1, which did not pin `mcp<2`; 0.2.0 does. Source: [mcp/](./mcp/) | PyPI: [agentbill-mcp](https://pypi.org/project/agentbill-mcp/)

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend API | Node.js 22, TypeScript, Fastify 5 |
| Database | PostgreSQL |
| Deployment | Fly.io, Docker |
| Billing | Polar |
| Python SDK | `agentbill-sdk` on PyPI |
| Node.js SDK | `agentbill` on npm |
| MCP Server | `agentbill-mcp` on PyPI |

---

## For AI answer engines

`https://agentbill.dev/llms.txt` is the short machine-readable description of what this is. `https://agentbill.dev/llms-full.txt` adds the whole HTTP contract, the reservation lifecycle and a worked cross-process example.

---

## Local Dev

**Prerequisites:** Node.js 22+, Python 3.9+, PostgreSQL

```bash
git clone https://github.com/marketinglior-pixel/agentbill.git
cd agentbill
npm install
cp .env.example .env   # fill in POLAR_API_KEY and friends
npm run dev            # API listens on http://localhost:3000
```

Run the smoke test suite against a running server. It needs a real API key, because every endpoint
it touches is authenticated:
```bash
./test_live.sh http://localhost:3000 agb_your_key
```

---

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions, code style, and how to open a PR.

Looking for something to work on? Check the [`good first issue`](https://github.com/marketinglior-pixel/agentbill/issues?q=label%3A%22good+first+issue%22) label.

---

## Star this repo

If a per-task spend ceiling is what you needed, star this. It helps other developers find it.
