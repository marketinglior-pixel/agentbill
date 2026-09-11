# agentbill

One spend ceiling per agent job, consulted before the call goes out. Bound to a task_ref, not to a calendar month: every call that shares the task_ref consults the same ceiling, on units you define, with no proxy in your request path.

```bash
npm install agentbill
```

## Quick start

The SDK reads `AGENTBILL_API_KEY` from the environment. Get a key at [agentbill.dev/register](https://agentbill.dev/register): free, 1,000 preflight calls a month, no card.

Give the job its ceiling first, in the console at [agentbill.dev/app](https://agentbill.dev/app) or with `PUT /tasks/:task_ref/ceiling`. Then the code names the job and nothing about the budget:

```typescript
import { preflight, record, TaskCeilingExceededError } from 'agentbill'

// Units are yours to define. job-142 already has its ceiling, set in the
// console; every call and tool that shares the taskRef draws on it. A refused
// call throws TaskCeilingExceededError before the expensive work starts.
await preflight({ agentId: 'researcher', taskRef: 'job-142', estimatedUnits: 12 })

// ... your LLM or tool call ...

// After the call: record what it actually cost
await record({ agentId: 'researcher', taskRef: 'job-142', units: 12 })
```

`taskCeiling` on a first preflight opens the job from code instead; once the job exists it is not applied, and the ceiling changes only through the console or the endpoint.

Every refusal shows up on your receipt at [agentbill.dev/app](https://agentbill.dev/app), with the exact response the SDK received.

## Why AgentBill?

Monthly caps let agents burn through a budget in hours. AgentBill adds a preflight check: the agent asks permission before it runs, not after it has already spent the money.

- A refused call throws before any work starts
- Task budgets: one hard ceiling across every call and tool a job makes
- Per-request ceiling: refuse any single call whose estimate exceeds it
- Idempotent recording: safe to call from retried or parallel workflows
- Free tier: 1,000 preflight calls a month, no credit card required

## API

Environment: `AGENTBILL_API_KEY` (required), `AGENTBILL_BASE_URL` (optional, defaults to `https://agentbill.fly.dev`; `https://agentbill.dev` works too).

### `preflight(options)`

Check every budget before the call runs, so the expensive call never happens.

**One rule, identical in the Python SDK: it throws when your spend rule refused the call, and returns a result when AgentBill's own billing did.**

| Refusal | What you get |
|---|---|
| `ceiling_exceeded` | throws `CeilingExceededError` |
| `task_ceiling_exceeded` | throws `TaskCeilingExceededError` |
| `budget_exhausted` | throws `BudgetExhaustedError` |
| `free_tier_exceeded` | returns `approved: false` with `upgradeUrl` |
| `plan_limit_exceeded` | returns `approved: false` with `upgradeUrl` |

The last two mean *our* quota ran out, not that your budget did. AgentBill running out of quota must never crash your agent, so those come back as a result you can degrade on rather than an exception that takes the process down.

> **Changed in 0.4.0.** `ceiling_exceeded` used to return `approved: false` and now throws `CeilingExceededError`. If you were checking `if (!check.approved)` to catch it, that branch no longer fires. Wrap the call in `try/catch` instead. The other four are unchanged.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `agentId` | string | required | Agent or task type identifier, used for attribution |
| `customerId` | string | `"default"` | Your internal customer ID |
| `estimatedUnits` | number | `1` | Expected units for this call |
| `ceiling` | number | none | Per-request ceiling: refuse when `estimatedUnits` exceeds it |
| `taskRef` | string | none | Cross-call job budget: many calls, one hard ceiling |
| `taskCeiling` | number | none | Opens a new `taskRef`; required then unless the job was opened first from the console or `PUT /tasks/:task_ref/ceiling`. Not applied once the job exists |
| `idempotencyKey` | string | none | Same key, same decision, one reservation. Without it a retry reserves a second time |

Returns `{ approved, reason, estimatedUnits, remainingUnits, reservationExpiresAt?, taskRef?, taskRemainingUnits?, upgradeUrl? }`.

### `record(options)`

Record what actually happened. The idempotency key is generated per call.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `agentId` | string | required | Agent or task type identifier |
| `customerId` | string | `"default"` | Your internal customer ID |
| `units` | number | `1` | Units consumed |
| `success` | boolean | `true` | `false` releases the preflight reservation without billing |
| `taskRef` | string | none | Attribute the spend to a task |
| `metadata` | object | none | Key-value pairs stored with the event |

### `meter(fn, options)`

Wraps an async function so preflight runs before it and record after it. See `MeterOptions` in the type definitions.

## LangChain integration

```typescript
import { preflight, record, TaskCeilingExceededError } from 'agentbill'
import { ChatAnthropic } from '@langchain/anthropic'
import { createReactAgent } from '@langchain/langgraph/prebuilt'

async function runAgent(customerId: string, input: string) {
  // one job, one ceiling: this run gets 500 units no matter how many calls it makes
  await preflight({ customerId, agentId: 'assistant', taskRef: `job-${customerId}`, taskCeiling: 500, estimatedUnits: 5 })

  const agent = createReactAgent({ llm: new ChatAnthropic({ model: 'claude-3-5-haiku-latest' }), tools: [] })
  const result = await agent.invoke({ messages: [{ role: 'user', content: input }] })

  await record({ customerId, agentId: 'assistant', taskRef: `job-${customerId}`, units: 5 })
  return result
}
```

## Links

- [Your receipt](https://agentbill.dev/app)
- [Full docs](https://agentbill.dev/docs)
- [GitHub](https://github.com/marketinglior-pixel/agentbill)
- [Python SDK (PyPI)](https://pypi.org/project/agentbill-sdk/)

## Task budgets: "this job gets 500 units"

A task groups many calls, across providers and tools, under one hard
cross-call ceiling, consulted before the call goes out.

```ts
import { preflight, record, getTask, TaskCeilingExceededError } from 'agentbill'

// First call creates the task with its ceiling
await preflight({ agentId: 'researcher', estimatedUnits: 2,
                  taskRef: 'job-42', taskCeiling: 50 })

// ... run your LLM / tool call, then record what actually happened
await record({ agentId: 'researcher', units: 2, taskRef: 'job-42' })

// Every later call just names the task
try {
  await preflight({ agentId: 'researcher', estimatedUnits: 10, taskRef: 'job-42' })
} catch (e) {
  if (e instanceof TaskCeilingExceededError) {
    console.log(`job-42 is done: ${e.taskUsedUnits}/${e.taskCeiling} units spent`)
  }
}

// Live burn-down
const status = await getTask('job-42')
console.log(status.usedUnits, '/', status.ceilingUnits)
```

## Retries and abandoned runs

A reservation is placed by `preflight` and released by `record`. Two things can go wrong between them, and both are handled explicitly.

**A retried preflight.** Without an idempotency key, retrying a timed-out check reserves the budget a second time, so the mechanism meant to prevent waste is the one consuming it. Pass a key that is stable across retries:

```ts
import { preflight } from 'agentbill'

await preflight({
  agentId: 'researcher', estimatedUnits: 12,
  taskRef: 'job-142', taskCeiling: 500,
  idempotencyKey: 'job-142:summarize',   // stable across retries
})
```

Same key, same decision, one reservation. A retry that lands while the original is still being decided throws with `preflight_in_progress`, which is not a refusal and reserves nothing: wait a moment and try again.

**A run that never comes back.** If the process dies between `preflight` and `record`, the units stay reserved: nothing else can spend them, and the remaining budget looks smaller than it is. A sweeper reclaims them once the reservation passes its TTL, returned on every approved check as `reservationExpiresAt`.

Note the direction. An abandoned reservation makes the ceiling tighter, never looser. The gate does not open by accident.
