# AgentBill

**One spend ceiling per job, enforced before the call goes out.**

Your provider's cap is bound to a project, to an organization over a calendar month, or to one
session on that vendor's own harness. This one is bound to `job-142`.

---

## The problem

You built an AI agent. It does something valuable. You charge $99/month flat.

- A 3-second run costs you $0.80. You made $98.20.
- A 45-minute recursive loop costs you $140. You lost $41.

A monthly cap does not catch that, because a loop that burns $140 over one weekend is too small to
move a monthly number, and a monthly number low enough to catch it takes every agent you run down
with it until the 1st.

## The fix: name the job, give it a ceiling

```python
from agentbill import AgentBillClient

client = AgentBillClient(api_key="agb_your_key")

# You decide what a unit is worth. This job gets 500 units across every
# call, tool and retry that passes the same task_ref; the call that would
# cross that ceiling is refused before it runs.
@client.gate(agent_id="researcher", task_ref="job-142",
             task_ceiling=500, estimated_units=12)
def run_agent(topic: str) -> str:
    return call_your_llm(topic)
```

That's it. On every call AgentBill now:
- Reserves the units **before** your provider call goes out, in the same statement that checks
  them, so ten parallel calls cannot all be approved for the last 8 units
- Refuses with `TaskCeilingExceededError` once the job's total would cross its ceiling
- Records what the run actually used, and releases the reservation without billing if it raised

`task_ref` is the whole idea: a second agent, a different tool and a retried step all pass the same
one, and they are all checked against a single ceiling. `agent_id` is a label for attribution and
carries no budget of its own.

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

### 2. Put the ceiling on the job

Two parameters do the work. `task_ref` is your name for this run, and every call that passes it is
checked against the same ceiling. `task_ceiling` is that ceiling, in units you define, fixed by the
first preflight of a new run; later values are ignored, so a retry cannot raise the ceiling it was
meant to respect.

```python
from agentbill import AgentBillClient

client = AgentBillClient(api_key="agb_your_key")

# Explicit: preflight before, record after.
client.preflight(agent_id="researcher", task_ref="job-142",
                 task_ceiling=500, estimated_units=12)

result = call_your_llm("quarterly report")

client.record(agent_id="researcher", task_ref="job-142", units=12)
```

```python
# Or let the decorator do both. On an exception it settles with success=False,
# which releases the reservation instead of billing it.
@client.gate(agent_id="researcher", task_ref="job-142",
             task_ceiling=500, estimated_units=12)
def run_agent(topic: str) -> str:
    return call_your_llm(topic)
```

Every later call in the same run passes `task_ref` and nothing else about the budget. It does not
need to know the ceiling, or what the calls before it spent:

```python
# A different agent, a different tool, the same run and the same ceiling.
client.preflight(agent_id="writer", task_ref="job-142", estimated_units=40)
```

### 3. Handle the refusal

The exception carries the numbers, so the handler can say what happened without a second call.

```python
from agentbill import TaskCeilingExceededError

try:
    result = run_agent("quarterly report")
except TaskCeilingExceededError as e:
    # Stop the loop, alert, degrade, your call.
    alert_ops(f"run {e.task_ref} hit its ceiling of {e.task_ceiling} units")
```

**One rule, identical in the Node SDK: it raises when your spend rule refused the call, and returns a result when AgentBill's own billing did.**

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
> still exported so your imports keep working, but nothing raises them any more. If you were
> catching them, check `result.approved` instead. The other three are unchanged.

A wrong key is neither a refusal nor a quota state. The server answers 401 and every call in the
SDK raises `AuthenticationError`, which carries the server's `error` (`unauthorized`,
`key_revoked` or `key_expired`) and its `message`, verbatim, followed by where the key came from
and how to get back in. It subclasses `AgentBillError`.

> **Added in 0.6.3.** Until then a 401 surfaced as a bare `requests` `HTTPError: 401 Client
> Error` with the server's sentence dropped, and a key with a non-ASCII character in it died as a
> `UnicodeEncodeError` inside `http.client`. The client now rejects the second at construction,
> before any request is made.

### 4. Watch the console

Open `https://agentbill.dev/app` and paste your API key:

- Live task burn-down: each job's ceiling, what it has spent, and what is still reserved
- Every refusal, with the reason your code got back
- Per-customer balances, key health, and this month's plan quota
- What refuses a call on your account today, in the order preflight checks it

There is no signup wall on the sample: `https://agentbill.dev/app?demo=1` is the same page with
invented data.

---

## Task budgets: "this job gets 500 units"

The same mechanism as the Quick start, with the two pieces that section left out: what the refusal
carries, and how to read a job's burn-down while it runs. The ceiling is fixed on the first
preflight; every later call reserves against the same budget, and the call that would cross it is
refused before the money is spent.

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

---

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
    ...  # the original is still being decided. Not a refusal, nothing reserved.
```

Same key, same decision, one reservation.

**A run that never comes back.** If the process dies between `preflight()` and `record()`, the units stay reserved: nothing else can spend them, and the remaining budget looks smaller than it is. A sweeper reclaims them once the reservation passes its TTL, returned on every approved check as `check.reservation_expires_at`.

Note the direction. An abandoned reservation makes the ceiling tighter, never looser. The gate does not open by accident.

Settle every run, including the ones that fail. `record(..., success=False)` releases the reservation without billing, and the `gate` decorator does it for you.

---

## Node.js

```typescript
import { preflight, record, TaskCeilingExceededError } from 'agentbill'

// Reads AGENTBILL_API_KEY. job-142 gets 500 units across every call
// that passes it, however many that turns out to be.
try {
  await preflight({ agentId: 'researcher', taskRef: 'job-142',
                    taskCeiling: 500, estimatedUnits: 12 })

  const result = await callLLM('quarterly report')

  await record({ agentId: 'researcher', taskRef: 'job-142', units: 12 })
} catch (e) {
  if (e instanceof TaskCeilingExceededError) {
    // e.taskRef, e.taskCeiling, e.taskUsedUnits
    stopTheLoop(e.taskRef)
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

### 1. The ceiling is bound to a job, not to a month

Metronome and Orb record usage *after the fact*. They have no way to stop an expensive operation
before it starts.

Provider spend caps do stop things, and they are real. What they are bound to is a project, or an
organization over a calendar month, or one session on that vendor's own harness. A 3-hour research
loop spread across two providers and a scraping tool is none of those.

AgentBill's ceiling is bound to a `task_ref` you choose. If the units already used plus this call's
estimate would cross it, preflight answers `approved: false` and the SDK raises before your provider
call goes out.

```
Metronome/Orb:   run → bill → (oops, over budget)
Monthly cap:     run → run → run → ... → dark until the 1st
AgentBill:       check this job's total → [refused] → run → settle
```

This matters when a single agent run costs $0.80 on a good day and $43 on a bad one.

### 2. Lives inside your function

Metronome requires you to emit events from your infrastructure. AgentBill is a decorator: it wraps
your function directly and handles the preflight, the reservation, the settle, idempotency and error
handling.

And there is no proxy in your request path. Your provider call is still yours; AgentBill answers a
separate allow/deny question next to it.

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

For atomic tasks, it is one decorator.

---

## How it works

```text
Your agent code
     │
     ▼
client.gate(task_ref=..., task_ceiling=...)   ← or preflight()/record() by hand
     │
     ├─ POST /preflight → reserve the units in the same statement that checks them
     │     │
     │     ├─ over the task ceiling  → raise TaskCeilingExceededError, nothing reserved
     │     ├─ over the per-call ceiling → raise CeilingExceededError
     │     ├─ customer out of budget → raise BudgetExhaustedError
     │     └─ our own quota gone    → return approved=False with .upgrade_url, never raise
     │
     ├─ Run your function (LLM or tool call happens here)
     │
     ├─ [succeeded] POST /events → settle the reservation with what it really used
     │
     └─ [raised]    POST /events success=False → release the reservation, bill nothing
```

Nothing is billed for a run that raised. And note which way an abandoned run fails: the units stay
reserved until the sweeper reclaims them, so the ceiling gets **tighter**, never looser.

---

## API reference

### `client.preflight(...)` and `@client.gate(...)`

| Option | Type | Default | Description |
|---|---|---|---|
| `agent_id` | `str` | required | A label for attribution, not a budget. Nothing is capped by it. |
| `task_ref` | `str` | none | Your name for this run. Every call passing it shares one ceiling. |
| `task_ceiling` | `int` | none | The run's total, in units you define. Required on the first preflight of a new `task_ref`; ignored after. |
| `estimated_units` | `int` | `1` | What this one call is worth. This is the amount reserved. |
| `customer_id` | `str` | `"default"` | Your internal customer identifier. Carries its own balance. |
| `idempotency_key` | `str` | none | Stable across retries: same key, same decision, one reservation. |
| `ceiling` | `int` | none | Set on `AgentBillClient(...)`, not per call. Refuses any single call whose `estimated_units` exceed it. |

### `@meter(event, options)`

Separate tool, for **outcome-based metering** rather than enforcement: it records what a run was
worth after the fact, with `units` as a function of the result.

| Option | Type | Default | Description |
|---|---|---|---|
| `event` | `str` | required | Event label, shown in the console |
| `customer_id` | `str` | none | Fixed customer identifier |
| `customer_id_from` | `str` | none | Name of a function parameter to read customer_id from |
| `units` | `int \| callable` | `1` | Units per call, or a function `(result) -> int` returning 0 to skip billing |
| `task_ref` | `str` | none | Attributes the event to a task budget opened by `client.preflight(task_ref=..., task_ceiling=...)` |
| `metadata` | `dict` | none | Static key-value pairs attached to every event |

> **`preflight=True` on `@meter` is not the task ceiling.** It calls `GET /budget` and refuses only
> if that customer's balance is already exhausted: no estimate, no per-call ceiling, no task
> ceiling, and no reservation, so it gives you none of the concurrency guarantee above. Use
> `@client.gate(...)` or `client.preflight(...)` for a ceiling. The option is kept for the accounts
> that already depend on it.

### Exceptions

| Exception | When |
|---|---|
| `TaskCeilingExceededError` | The run's total would cross its `task_ceiling`. Carries `.task_ref`, `.task_ceiling`, `.task_used_units`, `.task_remaining_units` |
| `TaskCeilingRequiredError` | A `task_ref` preflight has never seen arrived without a `task_ceiling` |
| `CeilingExceededError` | `estimated_units` exceed the per-call `ceiling` set on the client |
| `BudgetExhaustedError` | That customer's balance is gone |
| `PreflightInProgressError` | A preflight with the same `idempotency_key` is still being decided |
| `AgentBillError` | Network error or unexpected server response |

`FreeTierExceededError` and `PlanLimitExceededError` are still exported but nothing raises them:
AgentBill's own quota running out returns `approved=False` with `.upgrade_url` instead. Our billing
must never crash your agent.

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

- [x] Core metering (`POST /events`), idempotent per `idempotency_key`
- [x] Cross-call task ceilings (`task_ref` + `task_ceiling`), reserved atomically
- [x] Per-call ceiling and per-customer balances
- [x] Outcome-based metering (`units=lambda`)
- [x] Live console at `/app`
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
