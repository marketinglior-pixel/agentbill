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

Environment: `AGENTBILL_API_KEY` (required), `AGENTBILL_BASE_URL` (optional, defaults to `https://agentbill.dev`; `https://agentbill.fly.dev` serves the same application and keeps working). The base URL must be `https`, or plain `http` to `localhost`, `127.0.0.1` or `[::1]`; any other value makes each call throw `AgentBillError` before a request is sent. Each request is aborted after 10 seconds.

### `preflight(options)`

Consult every ceiling before the call runs. A refusal arrives before the expensive call is made; your code decides what happens next.

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
| `unit` | `'unit' \| 'token'` | none | What the job's numbers count, with a `taskRef`. Read when this call opens the job, checked on one that exists; a different unit is a 422 |

Returns `{ approved, reason, estimatedUnits, remainingUnits, reservationExpiresAt?, reservationId?, taskRef?, taskRemainingUnits?, upgradeUrl? }`, plus a `record(options)` method bound to this call. The method is not an enumerable property, so `JSON.stringify` and spread see only the data.

### `record(options)`

Record what actually happened.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `agentId` | string | required | Agent or task type identifier |
| `customerId` | string | `"default"` | Your internal customer ID |
| `units` | number | `1` | Units consumed. `0` is allowed: a call that ran and cost nothing records 0 |
| `success` | boolean | `true` | `false` releases the preflight reservation without billing |
| `taskRef` | string | none | Attribute the spend to a task |
| `metadata` | object | none | Key-value pairs stored with the event |
| `reservationId` | string | none | The preflight's `reservationId`. Closes that reservation whole and releases what it held beyond `units`. Without it the oldest reservations of this customer and `taskRef` are settled by `units` only |
| `idempotencyKey` | string | a fresh random key | Same key, one event: a retried record is ignored as a duplicate. Pass something stable, such as your provider's response id |
| `usageMissing` | boolean | `false` | Your provider reported no usage. Not read as 0: the call is charged at least the reservation the record settles, the one `reservationId` names or, without it, the oldest open reservation of this customer and `taskRef`. With no reservation open, `units` is recorded as sent. Either way the job counts it |

The result of `preflight()` has the same method, `result.record({ units, success?, idempotencyKey?, metadata?, usageMissing? })`, which carries `agentId`, `customerId`, `taskRef` and `reservationId` from the preflight that made it.

> **Since 0.5.0.** `reservationId`, `result.record()`, `unit`, and `record`'s `idempotencyKey`, `reservationId` and `usageMissing` are in 0.5.0 and later, not in 0.4.1 or earlier. They also need an AgentBill API that returns `reservation_id`; against one that does not, `reservationId` is absent and records settle as before.

### `wrap(client, options)`

> **Since 0.5.0.** `wrap()` is in 0.5.0 and later, not in 0.4.1 or earlier. It needs an AgentBill API that returns `reservation_id` and accepts `unit: "token"`.

Automatic metering for a model client. Every call through `chat.completions.create` and `responses.create` (openai), `messages.create` (@anthropic-ai/sdk) or `models.generateContent` and `generateContentStream` (@google/genai), streamed or not, is measured from the usage the provider returned: a preflight on the job in tokens before the call, a record of the reported tokens after it.

```typescript
import Anthropic from '@anthropic-ai/sdk'
import { wrap, isRefusal } from 'agentbill'

// Reads AGENTBILL_API_KEY. The job is counted in tokens; taskCeiling opens it.
const llm = wrap(new Anthropic(), { taskRef: 'tokens-1', agentId: 'writer', step: 'draft', taskCeiling: 50_000 })

const msg = await llm.messages.create({
  model: 'claude-sonnet-4-5', max_tokens: 400,
  messages: [{ role: 'user', content: 'One line on job ceilings.' }],
})
if (isRefusal(msg)) {
  // The call was not sent, and nothing is thrown: msg.reason, msg.used, msg.ceiling, msg.remaining.
  console.log(String(msg))
} else {
  console.log(msg.content[0].type === 'text' ? msg.content[0].text : '')
}
```

The estimate is the job's running average per call in this process (`defaultEstimate`, 2,000, before the job's opening call), never more than the average prompt plus the call's own `max_tokens`. A refusal is returned before the provider call is sent, as a `Refusal` (`approved: false`, `reason`, `taskRef`, `asked`, `used`, `ceiling`, `remaining`, `upgradeUrl` on a quota refusal, and `answer`, the preflight answer whole), never thrown; `isRefusal(x)` is the check, and the wrapped client is typed `Wrapped<T>` so each measured method resolves to `T | Refusal`. It is not shaped like a provider response: no `choices`, `content`, `candidates` or `usage`. A refused streaming call resolves to the same `Refusal`, which iterates to nothing; a Gemini automatic-function-calling stream refused on a later round ends after the earlier round's chunks and sets its `refusal`. A rejection out of a wrapped call is a failure (the provider's own error, or `AgentBillError` for a network error, a 401 or a 5xx). `preflight()` and `record()` are not changed by this: `preflight()` still throws `TaskCeilingExceededError` on a ceiling refusal and returns on the quota. After it, the record carries the provider's response id as `idempotencyKey`, the preflight's `reservationId`, and metadata (provider, model, tokens by type, `duration_ms`, `step`), never the prompt or the answer. Missing usage is recorded as missing, never as 0. OpenAI's `cache_write_tokens` are recorded as `cache_write`. With Gemini's automatic function calling (a `CallableTool` in `tools`) each round the SDK sends is its own measured call, because the response carries only the last round's usage. A client on another host is recorded as `openai-compatible` (or `anthropic-compatible`), unpriced, and keyed by a random key, since such a server's ids need not be unique. Each measured call is one preflight, so it uses one preflight of your account's monthly quota; once that quota is spent no ceiling can be checked, so by default (`onQuota: 'refuse'`) the wrapped call resolves to a `Refusal` with reason `free_tier_exceeded` or `plan_limit_exceeded` and `upgradeUrl`, and is not sent, and `onQuota: 'send'` sends it unchecked, with a warning once per job, and nothing bounds the job until the quota resets or you upgrade. A streamed call is recorded when its loop ends; a Chat Completions stream gets `stream_options.include_usage` when you did not set it, and the usage-only chunk that adds stays out of your loop. Only wrapped calls are measured. The wrapped `create` returns a plain Promise, without the SDK's `withResponse()`. `getTask('tokens-1')` returns the job's `breakdown` by model and by step, with `list_price_usd_estimate`, an estimate at public list price: list price, your invoice may differ.

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

**A reservation bigger than the call.** A record that does not name its reservation settles by the units you pass and no more: reserve 70,000 and record 8,000, and the other 62,000 stay held until the reservation expires. Settle with `result.record({ units })`, or pass `reservationId` to `record`, and that reservation closes whole: the actual is what the job spent, and the rest is released at once. Settling the same reservation twice releases it once.

Note the direction. An abandoned reservation makes the ceiling tighter, never looser. The gate does not open by accident.
