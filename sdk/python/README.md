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

## The fix: name the job, give it a ceiling, then ask before each call

Give the job a name and a ceiling in the console at [agentbill.dev/app](https://agentbill.dev/app),
or with `PUT /tasks/:task_ref/ceiling`. Then every call names the job and says what this one call
is worth, and nothing about the budget:

```python
from agentbill import AgentBillClient, TaskCeilingExceededError

client = AgentBillClient(api_key="agb_your_key")

try:
    # job-142 already has its ceiling. Ask, run, settle.
    client.preflight(agent_id="researcher", task_ref="job-142", estimated_units=12)
    result = call_your_llm("quarterly report")
    client.record(agent_id="researcher", task_ref="job-142", units=12)
except TaskCeilingExceededError as refused:
    # approved: false. Your code decides what the job does next.
    print(refused)
```

That's it. On every call AgentBill now:
- Reserves the units **before** your provider call goes out, in the same statement that checks
  them, so ten parallel calls cannot all be approved for the last 8 units
- Refuses with `TaskCeilingExceededError` once the job's total would cross its ceiling
- Settles what the run actually used on `record()`; `record(..., success=False)` releases the
  reservation without billing, and the `gate` decorator further down does both for you

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
checked against the same ceiling. The ceiling itself is set in units you define, in the console or
with `PUT /tasks/:task_ref/ceiling` before the run starts; passing `task_ceiling` on the first
preflight of a new run opens the job from code instead, the alternate. A `task_ceiling` on a later
preflight is not applied, so a retry cannot raise the ceiling it was meant to respect.

```python
from agentbill import AgentBillClient

client = AgentBillClient(api_key="agb_your_key")

# Explicit: preflight before, record after. job-142 already has its ceiling.
client.preflight(agent_id="researcher", task_ref="job-142", estimated_units=12)

result = call_your_llm("quarterly report")

client.record(agent_id="researcher", task_ref="job-142", units=12)
```

```python
# Or let the decorator do both. On an exception it settles with success=False,
# which releases the reservation instead of billing it. task_ceiling here opens
# the job from code, the alternate to the console; once the job exists it is not applied.
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
    # Your code decides: retry later, degrade, alert.
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
carries, and how to read a job's burn-down while it runs. The ceiling is set on the first
preflight; every later call reserves against the same budget, and the call that would cross it is
refused before the money is spent.

```python
from agentbill import AgentBillClient, TaskCeilingExceededError

client = AgentBillClient(api_key="agb_...")

# The alternate to the console: open the job from code, with task_ceiling on its first call
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

**A run that never comes back.** If the process crashes between `preflight()` and `record()`, the units stay reserved: nothing else can spend them, and the remaining budget reads smaller than it is, until a sweeper reclaims them once the reservation passes its TTL, returned on every approved check as `check.reservation_expires_at`.

Note the direction. An abandoned reservation makes the ceiling tighter, never looser. The gate does not open by accident.

Settle every run, including the ones that fail. `record(..., success=False)` releases the reservation without billing, and the `gate` decorator does it for you.

**A reservation bigger than the call.** A record that does not name its reservation settles the oldest reservations of that customer and `task_ref` by the units you pass, and no more: reserve 70,000 and record 8,000, and the other 62,000 stay held until the reservation expires. Every approved check carries `check.reservation_id`. Settle with `check.record(units=actual)`, which carries the agent, customer, `task_ref` and reservation for you, or pass `reservation_id=check.reservation_id` to `client.record(...)`: that reservation closes whole, the actual is what the job spent, and the rest is released at once. `gate` does it for you. Settling the same reservation twice releases it once.

> **Since 0.7.0.** `reservation_id`, `PreflightResult.record()`, and `record()`'s `idempotency_key`, `reservation_id`, `metadata` and `usage_missing` arguments are in 0.7.0 and later, not in 0.6.5 or earlier. They also need an AgentBill API that returns `reservation_id` on preflight; against one that does not, `check.reservation_id` is `None` and records settle as before.

---

## Automatic metering with `wrap()`

> **Since 0.7.0.** `wrap()` is in 0.7.0 and later, not in 0.6.5 or earlier. It needs an AgentBill API that returns `reservation_id` and accepts `unit: "token"`.

Wrap your model client once. Every call it makes through `chat.completions.create` and `responses.create` (OpenAI), `messages.create` (Anthropic) or `models.generate_content` and `generate_content_stream` (google-genai, `aio` included), sync or async, streamed or not, is measured from the usage the provider returned: a preflight on the job in tokens before the call, a record of the reported tokens after it. You pass no estimate and record no number.

```python
from openai import OpenAI
from agentbill import wrap, Refusal

# Reads AGENTBILL_API_KEY. The job is counted in tokens; task_ceiling opens it.
llm = wrap(OpenAI(), task_ref="tokens-1", agent_id="researcher", task_ceiling=50_000)

reply = llm.chat.completions.create(
    model="gpt-4o-mini",
    max_tokens=300,
    messages=[{"role": "user", "content": "Summarize the quarter in one line."}],
)
if isinstance(reply, Refusal):
    # The call that would have passed the ceiling was not sent. Nothing is
    # raised: reply.reason, reply.used, reply.ceiling, reply.remaining.
    print(reply)
else:
    print(reply.choices[0].message.content)
```

- **A refusal is returned, never raised.** The measured call's value is a `Refusal` (`approved=False`, `reason`, `task_ref`, `asked`, `used`, `ceiling`, `remaining`, `upgrade_url` on a quota refusal, and `answer`, the preflight answer whole); `bool()` of it is `False`, and it has no `choices`, `content`, `candidates` or `usage`, so it cannot be read as a provider response. A refused streaming call returns the same `Refusal`, which iterates to nothing (`for` and `async for` run zero times, and a `with` block is a no-op); the one stream that can be refused after it started, a Gemini automatic-function-calling stream whose later round is refused, ends after the earlier round's chunks and sets its `.refusal`. An exception out of a wrapped call is a failure: the provider's own error, or from AgentBill `AuthenticationError` (401), `requests.HTTPError` (any other HTTP error, a 422 `task_unit_mismatch` included) or `requests.ConnectionError`. `preflight()` and `record()` on the plain client are not changed by this: `preflight()` still raises `TaskCeilingExceededError` on a ceiling refusal and returns on the quota.

- **The estimate needs no number from you.** Before the job's first measured call in this process it is `default_estimate` (2,000); after, the job's running average per call, never more than the average prompt plus the call's own `max_tokens` (or `max_completion_tokens`, `max_output_tokens`). The prompt is not counted before the call, and no request is added. A call that uses more than it reserved is still recorded at what it used, so one call can take the job past its ceiling, by at most that call for each caller running at the same moment; the next preflight is refused. That bound holds while preflight checks the ceiling; see the quota below.
- **After the call** the record carries `idempotency_key` = the provider's response id (a random key on a `-compatible` endpoint, whose ids need not be unique), the preflight's `reservation_id`, and metadata: provider, model, tokens by type (`input`, `cache_read`, `cache_write`, `output`, `reasoning`), `duration_ms`, and the `step` you named. No prompt, no answer. For another step of the same job, `wrap(llm, step="review")`.
- **Tokens by type:** OpenAI's `cached_tokens` and `cache_write_tokens` are `cache_read` and `cache_write`; with Gemini's automatic function calling (a Python function in `tools`), each round the SDK sends is its own measured call, because the response it returns carries only the last round's usage.
- **Missing usage is recorded as missing, never as 0.** A provider error releases the reservation. A record that fails after the provider answered warns and still returns the answer. A stream is recorded when it ends, is closed, or a `for` loop over it stops.
- **Each measured call is one preflight**, so it uses one preflight of your account's monthly quota. Once that quota is spent no ceiling can be checked, so by default (`on_quota="refuse"`) the wrapped call returns a `Refusal` with reason `free_tier_exceeded` or `plan_limit_exceeded` and `.upgrade_url`, and is not sent. `wrap(..., on_quota="send")` sends it unchecked and records it, with a warning once per job, and nothing bounds the job until the quota resets or you upgrade.
- **Only wrapped calls are measured.** Another method, an unwrapped client, a tool call or a GPU run counts only if your code records it with the same `task_ref`. A client pointed at another host is recorded as `openai-compatible` (or `anthropic-compatible`) and gets no list price.
- **The job is counted in tokens.** One opened in units answers 422 `task_unit_mismatch`, and the call is not sent.
- **What it cost:** `client.get_task("tokens-1").breakdown` has the job by model and by step, with tokens and `list_price_usd_estimate`, an estimate at public list price from a dated price table. List price, your invoice may differ; a model with no list price is counted in `unpriced_calls`, never as $0.

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
    handleRefusal(e.taskRef)
  }
}
```

---

## Units for outcomes, not tokens

Most usage meters count *events*. They have no concept of "did the task actually succeed?"

AgentBill does. The unit count is a function of the result. You decide what success means:

```python
# Support agent, count units only when the ticket is resolved
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
# Coding agent, count units only when tests pass
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
# Research agent, count by volume processed
@meter(
    event="research_completed",
    customer_id_from="customer_id",
    units=lambda result: result["pages_processed"],
)
async def research(customer_id: str, topic: str) -> dict:
    return await run_research_agent(topic)
    # returns {"summary": "...", "pages_processed": 14}
```

If the units resolve to `0`, no event is recorded and nothing is drawn from that customer's balance.

---

## Why AgentBill?

### 1. The ceiling is bound to a job, not to a month

A usage meter records after the fact, so the number arrives with the invoice. Provider spend caps
are consulted before the call, and they are real. What they are bound to is a project, or an
organization over a calendar month, or one session on that vendor's own harness. A 3-hour research
loop spread across two providers and a scraping tool is none of those.

AgentBill's ceiling is bound to a `task_ref` you choose. If the units already used plus this call's
estimate would cross it, preflight answers `approved: false` and the SDK raises before your provider
call goes out. Your code decides what the job does next.

```
Usage meter:     run → record → the number arrives with the invoice
Monthly cap:     run → run → run → ... → dark until the 1st
AgentBill:       consult this job's ceiling → approved: false → your code decides → settle
```

This matters when a single agent run costs $0.80 on a good day and $43 on a bad one.

### 2. Lives inside your function

Nothing to emit from your infrastructure. AgentBill is a decorator: it wraps your function directly
and handles the preflight, the reservation, the settle, idempotency and error handling.

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
client.preflight(task_ref=...) then client.record(...)   ← or the gate decorator
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
| `task_ceiling` | `int` | none | The run's total, in units you define. Opens a new `task_ref`; required then unless the job was opened first from the console or `PUT /tasks/:task_ref/ceiling`. Not applied once the job exists. |
| `estimated_units` | `int` | `1` | What this one call is worth. This is the amount reserved. |
| `customer_id` | `str` | `"default"` | Your internal customer identifier. Carries its own balance. |
| `idempotency_key` | `str` | none | Stable across retries: same key, same decision, one reservation. |
| `ceiling` | `int` | none | Set on `AgentBillClient(...)`, not per call. Refuses any single call whose `estimated_units` exceed it. |

### `client.record(...)` and `check.record(...)`

`check.record(...)` takes `units`, `success`, `idempotency_key`, `usage_missing` and `metadata`, and reads `agent_id`, `customer_id`, `task_ref` and `reservation_id` from the preflight that made `check`.

| Option | Type | Default | Description |
|---|---|---|---|
| `agent_id` | `str` | required | The same attribution label you passed to preflight. |
| `units` | `int` | `1` | What the call actually used. `0` is allowed: a call that ran and cost nothing records 0. |
| `customer_id` | `str` | `"default"` | The customer the preflight named. |
| `task_ref` | `str` | none | The job the preflight named. Without it the units settle against no job. |
| `reservation_id` | `str` | none | `check.reservation_id`. Closes that reservation whole and releases what it held beyond `units`. Without it the oldest reservations are settled by `units` only. |
| `success` | `bool` | `True` | `False` releases the reservation and bills nothing. |
| `idempotency_key` | `str` | a fresh random key | Same key, one event: a retried record is ignored as a duplicate. Pass something stable, such as your provider's response id. |
| `usage_missing` | `bool` | `False` | Your provider reported no usage for this call. Not read as 0: the call is charged at least the reservation the record settles, the one `reservation_id` names or, without it, the oldest open reservation of this customer and `task_ref`. With no reservation open, `units` is recorded as sent. Either way the job counts it in `usage_missing_calls`. |
| `metadata` | `dict` | none | Stored on the event, never counted. |

`client.preflight(...)` also takes `unit`, `"unit"` (yours, the default) or `"token"`, with a `task_ref`: it is read when the call opens the job and checked on a job that exists, and a different unit is a 422. `client.get_task(...)` returns it as `status.unit`, beside `status.usage_missing_calls`.

### `@meter(event, options)`

Separate tool, for **outcome-based metering** rather than enforcement: it records what a run was
worth after the fact, with `units` as a function of the result.

| Option | Type | Default | Description |
|---|---|---|---|
| `event` | `str` | required | Event label, shown in the console |
| `customer_id` | `str` | none | Fixed customer identifier |
| `customer_id_from` | `str` | none | Name of a function parameter to read customer_id from |
| `units` | `int \| callable` | `1` | Units per call, or a function `(result) -> int` returning 0 to skip billing |
| `task_ref` | `str` | none | Attributes the event to a task budget: a job opened in the console, by `PUT /tasks/:task_ref/ceiling`, or by a first `client.preflight(task_ref=..., task_ceiling=...)` |
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

`preflight()` never raises `FreeTierExceededError` or `PlanLimitExceededError`: AgentBill's own
quota running out returns `approved=False` with `.upgrade_url` instead. Our billing must never crash
your agent. A client made with `wrap()` raises for no refusal at all: every one, the quota included,
is returned as a `Refusal` (once the quota is spent no ceiling can be checked), and `on_quota="send"`
sends the call unchecked instead.

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
- [ ] Webhooks, alerts at 80% and 100% credit usage
- [ ] Multi-signal outcome support
- [ ] Team accounts

---

One ceiling per job, consulted before the call goes out. preflight answers `approved: false`; your
code decides what happens next.
