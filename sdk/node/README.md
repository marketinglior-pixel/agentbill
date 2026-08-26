# agentbill

Usage-based billing for AI agents — preflight budget guardrails in 3 lines.

```bash
npm install agentbill
```

## Quick start

```typescript
import { AgentBill } from 'agentbill'

const bill = new AgentBill({ apiKey: process.env.AGENTBILL_API_KEY })

// Before running the agent — check if the customer has budget
const check = await bill.preflight({ customerId: 'user_123', agentId: 'research', estimatedUnits: 10 })
if (!check.approved) {
  throw new Error('Budget exceeded')
}

// After the agent finishes — record what was used
await bill.record({ customerId: 'user_123', agentId: 'research', units: 8 })
```

## Why AgentBill?

Monthly caps let agents burn through a budget in hours. AgentBill adds a **preflight check** — the agent asks permission before it runs, not after it's already spent the money.

- Preflight blocks the run before it starts if the customer is over budget
- Per-request ceiling: block any single run that would cost too much
- Idempotent recording: safe to call from retried or parallel workflows
- Free tier: 1,000 units/customer, no credit card required

## API

### `new AgentBill({ apiKey })`

Get your API key at [agentbill.fly.dev/register](https://agentbill.fly.dev/register).

### `bill.preflight(options)`

Check if a customer has budget before starting work.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `customerId` | string | `"default"` | Your internal customer ID |
| `agentId` | string | required | Agent or task type identifier |
| `estimatedUnits` | number | `1` | Expected units for this run |
| `ceiling` | number | — | Block run if estimatedUnits exceeds this |

Returns `{ approved: boolean, remainingUnits: number \| null }`.

### `bill.record(options)`

Record a billable event after work completes.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `customerId` | string | `"default"` | Your internal customer ID |
| `agentId` | string | required | Agent or task type identifier |
| `units` | number | `1` | Units consumed |
| `metadata` | object | — | Key-value pairs stored with the event |

Returns `{ recorded: boolean, eventId: string, remainingUnits: number \| null }`.

## LangChain integration

```typescript
import { AgentBill } from 'agentbill'
import { ChatAnthropic } from '@langchain/anthropic'
import { createReactAgent } from '@langchain/langgraph/prebuilt'

const bill = new AgentBill({ apiKey: process.env.AGENTBILL_API_KEY })

async function runAgent(customerId: string, input: string) {
  const check = await bill.preflight({ customerId, agentId: 'assistant', estimatedUnits: 5 })
  if (!check.approved) throw new Error(`Blocked: ${check.remainingUnits} units remaining`)

  const agent = createReactAgent({ llm: new ChatAnthropic({ model: 'claude-3-5-haiku-latest' }), tools: [] })
  const result = await agent.invoke({ messages: [{ role: 'user', content: input }] })

  await bill.record({ customerId, agentId: 'assistant', units: 5 })
  return result
}
```

## Links

- [Dashboard](https://agentbill.fly.dev/dashboard)
- [Full docs](https://agentbill.fly.dev/docs)
- [GitHub](https://github.com/marketinglior-pixel/agentbill)
- [Python SDK (PyPI)](https://pypi.org/project/agentbill/)
