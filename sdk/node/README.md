# agentbill

Hard budget ceilings for AI agents. Preflight blocks the call before it runs, not after the bill arrives. Cross-provider, tool spend included, no proxy in your request path.

```bash
npm install agentbill
```

## Quick start

The SDK reads `AGENTBILL_API_KEY` from the environment. Get a key at [agentbill.dev/register](https://agentbill.dev/register): free, 1,000 preflight calls a month, no card.

```typescript
import { preflight, record, TaskCeilingExceededError } from 'agentbill'

// Units are yours to define. Here 1 unit = 1 cent: this job dies at $5,
// across every call and tool that shares job-142. A blocked call throws
// TaskCeilingExceededError, so the expensive work never starts.
await preflight({ agentId: 'researcher', taskRef: 'job-142', taskCeiling: 500, estimatedUnits: 12 })

// ... your LLM or tool call ...

// After the call: record what it actually cost
await record({ agentId: 'researcher', taskRef: 'job-142', units: 12 })
```

Every refusal shows up on your receipt at [agentbill.dev/app](https://agentbill.dev/app), with the exact response the SDK received.

## Why AgentBill?

Monthly caps let agents burn through a budget in hours. AgentBill adds a preflight check: the agent asks permission before it runs, not after it has already spent the money.

- A blocked call throws before any work starts
- Task budgets: one hard ceiling across every call and tool a job makes
- Per-request ceiling: block any single call that would cost too much
- Idempotent recording: safe to call from retried or parallel workflows
- Free tier: 1,000 preflight calls a month, no credit card required

## API

Environment: `AGENTBILL_API_KEY` (required), `AGENTBILL_BASE_URL` (optional, defaults to `https://agentbill.fly.dev`; `https://agentbill.dev` works too).

### `preflight(options)`

Check every budget before the call runs. Throws `TaskCeilingExceededError` or `BudgetExhaustedError` on a blocked run, so the expensive call never happens.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `agentId` | string | required | Agent or task type identifier, used for attribution |
| `customerId` | string | `"default"` | Your internal customer ID |
| `estimatedUnits` | number | `1` | Expected units for this call |
| `ceiling` | number | none | Per-request ceiling: block when `estimatedUnits` exceeds it |
| `taskRef` | string | none | Cross-call job budget: many calls, one hard ceiling |
| `taskCeiling` | number | none | Required on the first preflight of a new `taskRef` |

Returns `{ approved, reason, estimatedUnits, remainingUnits, taskRef?, taskRemainingUnits?, upgradeUrl? }`.

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
  // one job, one ceiling: this run dies at 500 units no matter how many calls it makes
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

## Task budgets: "this job dies at $5"

A task groups many calls, across providers and tools, under one hard
cross-call ceiling, blocked before the money is spent.

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
