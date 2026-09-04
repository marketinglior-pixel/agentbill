# AgentBill

**Usage-based billing for AI agents. 3-line integration.**

Stop charging flat monthly fees for agents whose costs swing between $2 and $40 per run.  
Stop losing money when a rogue agent loops for 45 minutes at your expense.

---

## The problem

You built an AI agent. It does something valuable. You charge $99/month flat.

- A 3-second run costs you $0.80. You made $98.20.
- A 45-minute recursive loop costs you $140. You lost $41.

And you don't find out until your OpenAI invoice arrives.

## The fix: 3 lines

```python
from agentbill import meter

@meter(event="research_run", customer_id_from="customer_id", preflight=True)
async def run_agent(customer_id: str, topic: str) -> str:
    result = await call_your_llm(topic)
    return result
```

That's it. AgentBill now:
- Checks the customer's credit balance **before** the LLM call (`preflight=True`)
- Records the credit usage **after** the function succeeds
- Blocks the call with `BudgetExhaustedError` the moment the customer runs out. No surprise overages

---

## Install

```bash
pip install agentbill-sdk
```

```bash
npm install agentbill
```

---

## Quick start (5 minutes)

### 1. Get an API key

```
AGENTBILL_API_KEY=your_key_here
```

### 2. Decorate your agent

```python
from agentbill import meter, BudgetExhaustedError

# Charge 1 credit per run
@meter(event="research_run", customer_id_from="customer_id")
async def run_agent(customer_id: str, topic: str) -> str:
    ...

# Pre-flight: block BEFORE the LLM call if the customer is out of credits
@meter(event="research_run", customer_id_from="customer_id", preflight=True)
async def run_agent_safe(customer_id: str, topic: str) -> str:
    ...

# Outcome-based: charge credits only if the task succeeded
@meter(
    event="ticket_resolved",
    customer_id_from="customer_id",
    units=lambda result: 5 if result["resolved"] else 0,
)
async def resolve_ticket(customer_id: str, ticket_id: str) -> dict:
    ...
```

### 3. Handle credit exhaustion

```python
try:
    result = await run_agent(customer_id="cust_123", topic="quarterly report")
except BudgetExhaustedError as e:
    # Show paywall, send upgrade email, pause the agent, your call
    show_paywall(e.customer_id)
```

**One rule, identical in the Node SDK: it raises when your spend rule stopped the run, and returns a result when AgentBill's own billing did.**

| Refusal | What you get |
|---|---|
| `ceiling_exceeded` | raises `CeilingExceededError` |
| `task_ceiling_exceeded` | raises `TaskCeilingExceededError` |
| `budget_exhausted` | raises `BudgetExhaustedError` |
| `free_tier_exceeded` | returns `approved=False` with `.upgrade_url` |
| `plan_limit_exceeded` | returns `approved=False` with `.upgrade_url` |

The last two mean *our* quota ran out, not that your budget did. AgentBill running out of quota must never crash your agent, so those come back as a result you can degrade on rather than an exception that takes the process down.

```python
check = client.preflight("researcher", estimated_units=5)
if not check.approved:
    # only free_tier_exceeded / plan_limit_exceeded reach here; the rest raised
    alert_ops(f"AgentBill quota: {check.reason}", check.upgrade_url)
```

> **Changed in 0.6.0.** `free_tier_exceeded` and `plan_limit_exceeded` used to raise
> `FreeTierExceededError` / `PlanLimitExceededError`. They now return a result. Both classes are
> still exported so your imports keep working, but nothing raises them any more — if you were
> catching them, check `result.approved` instead. The other three are unchanged.

### 4. Watch your dashboard

Open `https://agentbill.dev/app` and paste your API key to see live task budgets, every refusal, and each customer's credit usage:

- Credit usage bar (turns red at 80%)
- Remaining credits
- BLOCKED badge when limit is hit

---

## Node.js

```typescript
import { meter, BudgetExhaustedError } from 'agentbill'

const runAgent = meter(
  async ({ customerId, topic }: { customerId: string; topic: string }) => {
    const result = await callLLM(topic)
    return result
  },
  {
    event: 'research_run',
    customerIdFrom: 'customerId',
    preflight: true,
  }
)

try {
  await runAgent({ customerId: 'cust_123', topic: 'quarterly report' })
} catch (e) {
  if (e instanceof BudgetExhaustedError) {
    showPaywall(e.customerId)
  }
}
```

---

## Pricing for outcomes, not tokens

Most billing tools count *events*. They have no concept of "did the task actually succeed?"

AgentBill does. The credit count is a function of the result. You decide what success means:

```python
# Support agent, charge credits only when the ticket is resolved
@meter(
    event="ticket_resolved",
    customer_id_from="customer_id",
    units=lambda result: 5 if result["resolved"] else 0,
)
async def resolve_ticket(customer_id: str, ticket_id: str) -> dict:
    resolution = await run_support_agent(ticket_id)
    return resolution  # {"resolved": True, "summary": "..."}
```

```python
# Coding agent, charge credits only when tests pass
@meter(
    event="code_generated",
    customer_id_from="customer_id",
    units=lambda result: 10 if result["tests_passed"] else 0,
)
async def generate_code(customer_id: str, spec: str) -> dict:
    code = await run_coding_agent(spec)
    passed = run_tests(code)
    return {"code": code, "tests_passed": passed}
```

```python
# Research agent, charge by volume processed
@meter(
    event="research_completed",
    customer_id_from="customer_id",
    units=lambda result: result["pages_processed"],
)
async def research(customer_id: str, topic: str) -> dict:
    return await run_research_agent(topic)
    # returns {"summary": "...", "pages_processed": 14}
```

If credits resolve to `0`, no event is recorded. The customer is not charged. Your margins stay intact.

---

## Why AgentBill? (vs. Metronome / Orb / Stripe)

**Metronome and Orb** are excellent for SaaS products. They're built around usage records, pricing tiers, and invoicing. If you're building a database or an API with predictable units, use them.

AgentBill is different in two ways:

### 1. Pre-flight enforcement

Metronome and Orb record usage *after the fact*. They have no way to stop an expensive operation before it starts.

AgentBill checks the customer's credit balance **before** the LLM call runs. If they're out, the function never executes. No API call is made. No money is spent.

```
Metronome/Orb:   run → bill → (oops, over budget)
AgentBill:       check → [blocked if over budget] → run → bill
```

This matters when a single agent run costs $0.80 on a good day and $43 on a bad one.

### 2. Lives inside your function

Metronome requires you to emit events from your infrastructure. AgentBill is a decorator: it wraps your function directly and handles everything: pre-flight check, credit deduction, idempotency, error handling.

No event pipelines. No webhooks to configure. One line.

---

## Current scope: what AgentBill solves today

AgentBill is designed for **atomic, short-running agent tasks**: functions that complete in a single execution and return a deterministic result.

**Works well for:**
- Research runs, report generation, document processing
- Support ticket resolution (single attempt)
- Code generation with test validation
- Any agent function that runs once and returns a clear result

**Not yet supported:**
- **Multi-signal outcomes**, tasks where success is determined by multiple events over time (e.g., a ticket that gets reopened 3 days later)
- **Long-running workflows**, agents that run for hours or days across multiple steps
- **Outcome invalidation**, billing reversal when a previously "successful" result is later undone

These are real problems. They require a different architecture: event sourcing, state machines, reversal logic. If you're building at that level of complexity, AgentBill's current version isn't the right tool yet.

For atomic tasks, it's 3 lines.

---

## How it works

```text
Your agent code
     │
     ▼
@meter decorator
     │
     ├─ [preflight=true] GET /budget → is_blocked? → raise BudgetExhaustedError
     │
     ├─ Run your function (LLM call happens here)
     │
     ├─ [function succeeded] POST /events → record credits used
     │
     └─ Return result
```

Credits are recorded **after success only**. If your agent throws, the customer is not charged.

---

## API reference

### `@meter(event, options)`

| Option | Type | Default | Description |
|---|---|---|---|
| `event` | `str` | required | Event label, shown in dashboard |
| `customer_id` | `str` | none | Fixed customer identifier |
| `customer_id_from` | `str` | none | Name of a function parameter to read customer_id from |
| `units` | `int \| callable` | `1` | Credits per call, or a function `(result) -> int` returning 0 to skip billing |
| `preflight` | `bool` | `False` | Check credit balance before running. Blocks immediately if exhausted. |
| `metadata` | `dict` | none | Static key-value pairs attached to every event |

### Exceptions

| Exception | When |
|---|---|
| `BudgetExhaustedError` | Customer has 0 remaining credits (HTTP 402) |
| `AgentBillError` | Network error or unexpected server response |

---

## Self-hosting

```bash
git clone https://github.com/marketinglior-pixel/agentbill
cd agentbill
cp .env.example .env   # add your DATABASE_URL and AGENTBILL_API_KEY
npm install
npm run dev
```

Requires: Node 20+, PostgreSQL 14+

---

## Roadmap

- [x] Core metering (`POST /events`)
- [x] Credit balance enforcement (HTTP 402)
- [x] Pre-flight guardrails (`preflight=True`)
- [x] Outcome-based billing (`units=lambda`)
- [x] Live dashboard
- [ ] Stripe Connect, bill your customers directly
- [ ] Webhooks, alerts at 80% and 100% credit usage
- [ ] Multi-signal outcome support
- [ ] Team accounts

---

## Why not Stripe directly?

Stripe's metered billing requires: a product, a price, a customer, a subscription, a subscription item, and then a usage record per event. That's 6 API calls and 47 pages of documentation to charge someone $2.

Stripe also has no concept of "did the task succeed?" or "stop before it starts."

AgentBill handles all of that behind a single decorator.

---

Built for developers who ship agents and want to get paid fairly for what they actually deliver.

## Task budgets: "this job dies at $5"

A task groups many calls, across providers and tools, under one hard
cross-call ceiling. The ceiling is fixed on the first preflight; every later
call reserves against the same budget, and the run that would cross it is
blocked before the money is spent.

```python
from agentbill import AgentBillClient, TaskCeilingExceededError

client = AgentBillClient(api_key="agb_...")

# First call creates the task with its ceiling
client.preflight("researcher", estimated_units=2,
                 task_ref="job-42", task_ceiling=50)

# ... run your LLM / tool call, then record what actually happened
client.record("researcher", units=2, task_ref="job-42")

# Every later call just names the task
try:
    client.preflight("researcher", estimated_units=10, task_ref="job-42")
except TaskCeilingExceededError as e:
    print(f"job-42 is done: {e.task_used_units}/{e.task_ceiling} units spent")

# Live burn-down
status = client.get_task("job-42")
print(status.used_units, "/", status.ceiling_units)
```

Or wrap the whole thing with the gate decorator: preflight before, record
after, reservation released automatically when the function raises:

```python
@client.gate("researcher", estimated_units=2,
             task_ref="job-42", task_ceiling=50)
def run_step(query: str) -> str:
    return call_llm(query)
```

## Retries and abandoned runs

A reservation is placed by `preflight()` and released by `record()`. Two things can go wrong between them, and both are handled explicitly.

**A retried preflight.** Without an idempotency key, retrying a timed-out check reserves the budget a second time, so the mechanism meant to prevent waste is the one consuming it. Pass a key that is stable across retries:

```python
from agentbill import AgentBillClient, PreflightInProgressError

client = AgentBillClient(api_key="agb_...")

try:
    check = client.preflight(
        "researcher", estimated_units=12,
        task_ref="job-142", task_ceiling=500,
        idempotency_key="job-142:summarize",   # stable across retries
    )
except PreflightInProgressError:
    ...  # the original is still being decided. Not a block, nothing reserved.
```

Same key, same decision, one reservation.

**A run that never comes back.** If the process dies between `preflight()` and `record()`, the units stay reserved: nothing else can spend them, and the remaining budget looks smaller than it is. A sweeper reclaims them once the reservation passes its TTL, returned on every approved check as `check.reservation_expires_at`.

Note the direction. An abandoned reservation makes the ceiling tighter, never looser. The gate does not open by accident.

Settle every run, including the ones that fail. `record(..., success=False)` releases the reservation without billing, and the `gate` decorator does it for you.
