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
- Checks the customer's budget **before** the LLM call (`preflight=True`)
- Records the event **after** the function succeeds
- Blocks the call with `BudgetExhaustedError` the moment the customer runs out — no surprise overages

---

## Install

```bash
pip install agentbill
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

# Bill 1 unit per call
@meter(event="research_run", customer_id_from="customer_id")
async def run_agent(customer_id: str, topic: str) -> str:
    ...

# Block BEFORE the LLM call if the customer is out of budget
@meter(event="research_run", customer_id_from="customer_id", preflight=True)
async def run_agent_safe(customer_id: str, topic: str) -> str:
    ...

# Outcome-based: only charge if the task succeeded
@meter(
    event="ticket_resolved",
    customer_id_from="customer_id",
    units=lambda result: 5 if result["resolved"] else 0,
)
async def resolve_ticket(customer_id: str, ticket_id: str) -> dict:
    ...
```

### 3. Handle budget exhaustion

```python
try:
    result = await run_agent(customer_id="cust_123", topic="quarterly report")
except BudgetExhaustedError as e:
    # Show paywall, send upgrade email, pause the agent — your call
    show_paywall(e.customer_id)
```

### 4. Watch your dashboard

Open `https://your-instance/dashboard` to see every customer's usage in real time:

- Usage bar (turns red at 80%)
- Remaining units
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

## How it works

```
Your agent code
     │
     ▼
@meter decorator
     │
     ├─ [preflight=true] GET /budget → is_blocked? → raise BudgetExhaustedError
     │
     ├─ Run your function (LLM call happens here)
     │
     ├─ [function succeeded] POST /events → record units
     │
     └─ Return result
```

Events are recorded **after success only**. If your agent throws, the customer is not billed.

---

## API reference

### `@meter(event, options)`

| Option | Type | Default | Description |
|---|---|---|---|
| `event` | `str` | required | Event label, shown in dashboard |
| `customer_id` | `str` | — | Fixed customer identifier |
| `customer_id_from` | `str` | — | Name of a function parameter to read customer_id from |
| `units` | `int \| callable` | `1` | Units per call, or a function `(result) -> int` |
| `preflight` | `bool` | `False` | Check budget before running. Blocks immediately if exhausted. |
| `metadata` | `dict` | — | Static key-value pairs attached to every event |

### Exceptions

| Exception | When |
|---|---|
| `BudgetExhaustedError` | Customer has 0 remaining units (HTTP 402) |
| `AgentBillError` | Network error or unexpected server response |

---

## Self-hosting

```bash
git clone https://github.com/your-org/agentbill
cd agentbill
cp .env.example .env   # add your DATABASE_URL
npm install
npm run dev
```

Requires: Node 20+, PostgreSQL 14+

---

## Roadmap

- [x] Core metering (`POST /events`)
- [x] Budget enforcement (HTTP 402)
- [x] Pre-flight guardrails (`preflight=True`)
- [x] Outcome-based billing (`units=lambda`)
- [x] Dashboard
- [ ] Stripe Connect — bill your customers directly
- [ ] Webhooks — get notified when a customer hits 80% or 100%
- [ ] Team accounts

---

## Pricing for outcomes, not tokens

Stripe, Metronome, and most billing tools count *events*. They have no concept of "did the task actually succeed?"

AgentBill does. The unit count is a function of the result — you decide what success means:

```python
# Support agent — charge only when the ticket is resolved
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
# Coding agent — charge only when tests pass
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
# Research agent — charge by pages processed
@meter(
    event="research_completed",
    customer_id_from="customer_id",
    units=lambda result: result["pages_processed"],
)
async def research(customer_id: str, topic: str) -> dict:
    return await run_research_agent(topic)
    # returns {"summary": "...", "pages_processed": 14}
```

If `units` resolves to `0` — no event is recorded. The customer is not charged. Your margins stay intact.

This is what Sequoia and YC mean when they say "charge for the work, not the software." AgentBill is the layer that makes it possible in 3 lines.

---

## Why not Stripe directly?

Stripe's metered billing requires: a product, a price, a customer, a subscription, a subscription item, and then a usage record per event. That's 6 API calls and 47 pages of documentation to charge someone $2.

Stripe also has no concept of "did the task succeed?" — you'd need to build that logic yourself.

AgentBill does all of that behind a single decorator.

---

Built for developers who ship agents and want to get paid fairly for what they actually deliver.
