import { ORIGIN, abs, indexable } from '../ui/site.js'
import { PLAN_ORDER, PLAN_PRICES, PLAN_LIMITS } from '../integrations/polar.js'

// /llms.txt and /llms-full.txt: the two surfaces written to be read by an
// answer engine rather than by a person.
//
// They live here, and not in a public/ directory, because there is no public/
// directory: the Dockerfile's runtime stage copies dist/ and nothing else,
// which is the same reason og.png and the icons are compiled Buffers. A file
// dropped in public/ would 404 in production and pass locally.
//
// What this file is FOR. An engine that reads a page and then answers a
// question about it will drift toward the nearest familiar category unless the
// text refuses it: "billing for AI agents" reads as Stripe for agents, and
// "spend control" reads as a gateway. So the entity paragraph names the
// mechanism (a ceiling bound to a task_ref, consulted by a call your own code
// makes) and the "What AgentBill is not" section names the three categories it
// keeps being mistaken for. Both are load-bearing; do not trim them for length.
//
// Voice rule, and it is the one most easily lost in an edit: preflight ANSWERS
// and the SDK RAISES. It does not stop, kill or block a run. Nothing here is in
// our process and nothing here can end it. The one place the word "blocked"
// may appear is inside a quoted SDK message, because that string is what the
// caller actually sees.
//
// Every number and identifier below was read from source, not from the
// marketing copy. Where the two disagree, source wins and the copy is the bug.

const num = (n: number) => n.toLocaleString('en-US')

/** Published package versions. Checked against the registries, not the repo:
 *  pyproject.toml can say 0.6.1 while PyPI still serves 0.6.0, and a version in
 *  a machine-readable file that is ahead of the registry describes something no
 *  reader can install. Bump in the same commit as the publish or delete the line. */
export const SDK_VERSIONS = {
  python: '0.6.4', // pypi.org/pypi/agentbill-sdk/0.6.3/json, published and checked 2026-09-09
  node: '0.4.1',   // registry.npmjs.org/agentbill, published and checked 2026-09-09
  mcp: '0.2.1',    // pypi.org/pypi/agentbill-mcp/0.2.1/json, published and checked 2026-09-09
} as const

/** The one-paragraph definition. Shared by both files so an engine that reads
 *  either one gets the same entity, and so a correction lands in both. */
const SUMMARY =
  'AgentBill is an SDK and HTTP API that puts a spend ceiling on one agent task. ' +
  'Your code calls preflight before it does expensive work; preflight atomically reserves ' +
  'the integer units you estimate against a ceiling identified by a task_ref you choose, and ' +
  'when the reservation would cross that ceiling it refuses, answering approved: false or ' +
  'raising a typed error, after which your own code decides what happens next. Every process, ' +
  'machine, provider and agent that passes the same task_ref draws on the same ceiling. Units ' +
  'are integers you define; AgentBill never converts them to money and never reads your ' +
  'provider bill. Python and Node SDKs and an MCP server. Free tier: ' +
  `${num(PLAN_LIMITS.free)} preflight calls a month.`

const NOT_A = `## What AgentBill is not

- **Not a proxy or a gateway.** No base URL to change, no traffic routed through us, no provider
  credentials held by us. Your model calls stay direct. AgentBill sees one HTTPS call, made by
  your code, to our API.
- **Not a reader of your provider bill.** No invoice ingestion, no token counting, no currency
  field anywhere in the API. Every quantity is an integer unit you defined and sent, so the
  ceiling is exactly as tight as your estimate.
- **Not a per-agent budget.** agent_id is an attribution label. It is stored on tasks, steps and
  refusals and can be filtered on, and nothing is capped by it. Two agents sharing a task_ref
  share one ceiling.
- **Not automatic metering.** Nothing is counted unless your code calls preflight or record. A
  tool call, a GPU run or a vector search counts against a task ceiling if you instrument it with
  the same task_ref, and is invisible if you do not. (record_step is a third call your code can
  make, and it feeds the anomaly baseline only: it takes no task_ref and moves no budget.) A task ceiling is enforced only by preflight
  calls carrying that task_ref; POST /events with that task_ref moves the task's used_units but
  never refuses on it, and cannot create a task.
- **Not billing for your end customers.** AgentBill does not charge your users, hold their cards
  or issue them credit. Stripe Connect is not shipped. The per-customer limit_units balance is an
  internal ceiling you set for your own accounting, not an invoice. (AgentBill's own subscription
  runs on Polar: that is us charging you, not you charging anyone.)
- **Not observability.** No traces, no spans, no prompt capture, no after-the-fact cost report.
  GET /decisions stores spend decisions, not conversations.
- **Not a process supervisor.** Nothing here can terminate a run. preflight answers and the SDK
  raises; the except or catch block is what ends the job.`

const REFUSALS = `## The refusal contract

One rule: when YOUR spend rule refuses, the SDK raises. When AGENTBILL'S OWN monthly quota
refuses, the SDK returns a result carrying approved: false and an upgrade_url, so our billing
state cannot crash your agent. Every one of these is HTTP 200 with approved: false; none of them
is an error status.

| reason | Python | Node |
|---|---|---|
| task_ceiling_exceeded | raises TaskCeilingExceededError | throws TaskCeilingExceededError |
| budget_exhausted (that customer's balance) | raises BudgetExhaustedError | throws BudgetExhaustedError |
| ceiling_exceeded (this one call's estimate) | raises CeilingExceededError | throws CeilingExceededError |
| free_tier_exceeded (plan is free) | returned, with .upgrade_url | returned, with .upgradeUrl |
| plan_limit_exceeded (any paid plan) | returned, with .upgrade_url | returned, with .upgradeUrl |

Two shapes that are errors rather than refusals: a task_ref preflight has never seen, arriving
without a task_ceiling, is 422 task_ceiling_required (Python raises TaskCeilingRequiredError, Node
throws AgentBillError); a retried preflight whose idempotency_key is still being decided is 409
preflight_in_progress (Python raises PreflightInProgressError, Node throws AgentBillError).

TaskCeilingExceededError carries task_ref, task_ceiling, task_used_units and task_remaining_units,
so the handler can choose between degrading, queueing and stopping without a second call.

FreeTierExceededError and PlanLimitExceededError are still importable from the Python package for
compatibility, and nothing has raised them since 0.6.0.

One exception to the rule above, and it is in our code rather than in the docs. @client.gate calls
preflight() internally, so the three typed spend errors still propagate out of the decorated
function unchanged. What gate changes is the other half: the two quota reasons preflight() would
have RETURNED become a bare Exception instead. Use the explicit preflight/record pair where a quota
refusal has to stay non-fatal.

preflight is not the only endpoint that can refuse, though it is the only one that enforces a task
ceiling. POST /events answers 402 budget_exhausted when the customer's own limit_units would be
crossed, and writes no event row in that case.`

const PRICING = `## Pricing

${PLAN_ORDER.map((t) =>
  `- ${t[0].toUpperCase() + t.slice(1)}: $${PLAN_PRICES[t]}/month, ${num(PLAN_LIMITS[t])} preflight calls per month.`
).join('\n')}

The quota counts POST /preflight calls, and the counter is incremented inside the same transaction
that reserves, so a refused call rolls it back and burns no quota; a call refused on the per-call
ceiling never reaches the database at all. The period rolls on the first preflight after the calendar
month turns. Crossing the quota answers approved: false with free_tier_exceeded or plan_limit_exceeded
and an upgrade_url, and does not raise, so running out of our quota degrades your spend control rather
than crashing your agent.
No feature is gated by plan; the tiers sell headroom. Billing runs on Polar.`

/** The link sections. Built from the page registry rather than typed, so a page
 *  that reaches the sitemap cannot be missing here.
 *
 *  `self` says which of the two files is rendering, because the last line points
 *  at the other one. Shared without it, llms-full.txt linked to llms-full.txt
 *  and described it as a fuller document than itself. */
function links(self: 'short' | 'full'): string {
  const seen = new Set(indexable().map((p) => p.path))
  const has = (p: string) => seen.has(p)
  const line = (p: string, text: string) => (has(p) ? `- [${text.split('|')[0]}](${abs(p)}): ${text.split('|')[1]}\n` : '')
  return `## Docs

${line('/docs', 'Documentation index|The SDK quick start, the core concepts, and the HTTP reference.')}${line('/docs/task-budgets', 'Task budgets, a hard cost ceiling per agent job|How one task_ref carries one ceiling across every call in a job.')}${line('/docs/limit-cost-per-agent-run', 'How to cap what one agent run can spend|The preflight-and-record pair applied to a single run.')}${line('/docs/langchain-billing', 'How to add billing to a LangChain agent|Wrapping a chain with preflight and record.')}${line('/docs/openai-agent-spend-ceiling', 'How to add a spend ceiling to an OpenAI agent|The same pair around an OpenAI call.')}${line('/faq', 'Questions|What the product does and does not do, answered against the source.')}
## Packages

- [agentbill-sdk on PyPI](https://pypi.org/project/agentbill-sdk/): Python SDK ${SDK_VERSIONS.python}. AgentBillClient with preflight, record, gate, get_task, checkpoint, record_step.
- [agentbill on npm](https://www.npmjs.com/package/agentbill): Node SDK ${SDK_VERSIONS.node}, ESM. Exports preflight, record, getTask, meter.
- [agentbill-mcp on PyPI](https://pypi.org/project/agentbill-mcp/): MCP server ${SDK_VERSIONS.mcp}, exposing the preflight and record_event tools to an agent host.
- [Source repository](https://github.com/marketinglior-pixel/agentbill): The API, this site, and both SDKs. MIT.

## Optional

${line('/pricing', 'Pricing|The four plans and the monthly preflight-call limit each includes.')}${line('/register', 'Get an API key|Email in, one agb_ key out. Free plan, no card.')}${line('/blog/monthly-caps-wont-save-you', "Why monthly caps don't protect you from one bad LLM run|Why a calendar month is the wrong unit for a single run.")}${line('/blog/how-preflight-avoids-double-billing', 'How preflight avoids double-billing under concurrent load|Reservations, idempotency keys and concurrent settlement.')}${line('/about', 'About|Who builds this, and what it deliberately is not.')}${line('/status', 'Status|Service status.')}${line('/he/cost-per-client', 'כמה כל לקוח עולה לך|Hebrew, for n8n and Make operators: working out what one client costs to run.')}${line('/terms', 'Terms|Terms of service.')}${line('/privacy', 'Privacy|Privacy policy.')}- [Console](${ORIGIN}/app): Your tasks, refusals and keys. Sample data at /app?demo=1, no account needed.
${self === 'short'
  ? `- [llms-full.txt](${ORIGIN}/llms-full.txt): The same product with the whole HTTP contract, the reservation lifecycle and a worked cross-process example.`
  : `- [llms.txt](${ORIGIN}/llms.txt): The same product in short: the summary, the quick starts and the link lists.`}`

}

/** https://llmstxt.org: H1, a blockquote summary, prose, then H2 link lists. */
export function llmsTxt(): string {
  return `# AgentBill

> ${SUMMARY}

The unit of enforcement is the task: not the calendar month, not the project, not the API key, not
the agent. One job, a batch or a run or a customer request, gets one task_ref and one task_ceiling,
and the ceiling travels with that string, so a job spread across three workers and two providers
still consults one number.

Integration is two calls. preflight before the work, which reserves and returns a decision, and
record after it, which settles what the run used or releases the reservation if it failed. Three
calls carry the whole product: preflight() decides, record() settles, get_task() reads the live
burn-down.

**AgentBill refuses. Your code decides what happens next**: return a partial result, retry with a
smaller estimate, drop to a cheaper model, escalate to a human, or stop. There is no kill switch on
our side, because there is no proxy on our side.

A unit is an integer you define and pass. The common convention is 1 unit = 1 cent, so "this job
stops at $5" is task_ceiling=500, and nothing in the system knows that: AgentBill compares units to
a ceiling and never converts them to currency.

## Install

\`\`\`
pip install agentbill-sdk
npm install agentbill
\`\`\`

Get a key at ${ORIGIN}/register. Free, no card, and the key is shown once.

## Quick start, Python

\`\`\`python
from agentbill import AgentBillClient, TaskCeilingExceededError

client = AgentBillClient(api_key="agb_your_key")

# job-142 already has its ceiling, set in the console at agentbill.dev/app or
# with PUT /tasks/job-142/ceiling. The call names the job and what this one
# call is worth, and nothing about the budget.
client.preflight(agent_id="researcher", task_ref="job-142", estimated_units=12)

# ... your provider call goes here ...

# Settle, or the units stay held until the reservation expires.
client.record(agent_id="researcher", task_ref="job-142", units=12)
\`\`\`

Every later call in the run passes task_ref and nothing else about the budget. It does not need to
know the ceiling or what the calls before it spent:

\`\`\`python
try:
    # A different agent, the same job, the same ceiling.
    client.preflight(agent_id="writer", task_ref="job-142", estimated_units=250)
except TaskCeilingExceededError as e:
    # e.task_ref, e.task_ceiling, e.task_used_units, e.task_remaining_units
    handle_it(e)
\`\`\`

Or let the decorator do both. It records on return and, on an exception, records success=False,
which releases the reservation without spending it:

\`\`\`python
# task_ceiling here opens the job from code, the alternate to the console;
# once the job exists it is not applied.
@client.gate(agent_id="researcher", task_ref="job-142",
             task_ceiling=500, estimated_units=12)
def run_agent(topic: str) -> str:
    return call_your_llm(topic)
\`\`\`

## Quick start, Node

\`\`\`typescript
import { preflight, record, TaskCeilingExceededError } from 'agentbill'

// Reads AGENTBILL_API_KEY from the environment. There is no client object.
// job-142 already has its ceiling, set in the console or with PUT /tasks/job-142/ceiling.
await preflight({ agentId: 'researcher', taskRef: 'job-142', estimatedUnits: 12 })

// ... your provider call goes here ...

await record({ agentId: 'researcher', taskRef: 'job-142', units: 12 })
\`\`\`

Python names everything in snake_case and takes api_key as an argument; Node names everything in
camelCase and reads AGENTBILL_API_KEY only. There is no gate decorator in the Node SDK: the
explicit pair above is the Node integration path.

## MCP server

\`\`\`
uvx agentbill-mcp
\`\`\`

\`\`\`json
{
  "mcpServers": {
    "agentbill": {
      "command": "uvx",
      "args": ["agentbill-mcp"],
      "env": { "AGENTBILL_API_KEY": "agb_..." }
    }
  }
}
\`\`\`

Two tools. preflight takes agent_id, customer_id, estimated_units, ceiling, task_ref, task_ceiling
and idempotency_key. record_event takes agent_id, units, customer_id and metadata, and has no
task_ref parameter, so an MCP-only integration can open a task budget with preflight but cannot
settle its reservation; the sweeper reclaims it when it expires. Settle from the Python or Node SDK.

## How a task budget behaves

- A job is opened with its ceiling either by the first preflight carrying a task_ref with a
  task_ceiling, or by PUT /tasks/:task_ref/ceiling (the console's task budgets view makes the same
  write). A preflight for a job that does not exist, sent without a ceiling, is 422
  task_ceiling_required.
- Once the job exists, a task_ceiling from code is not applied, so a retry cannot raise the ceiling
  it was meant to respect. The last save through the endpoint or the console is the ceiling in force.
  An approved answer and a task_ceiling_exceeded refusal carry the ceiling that decided them as
  task_ceiling; the other refusals are decided before the job's row is consulted.
- The row is unique on (account_id, task_ref), which is why processes, machines, providers and
  agent_ids converge on one ceiling by sending one string.
- The check and the reservation are one conditional UPDATE, so two calls arriving together cannot
  both be approved against the last of the budget.
- An approved preflight holds a reservation with an expiry, 60 minutes by default and returned as
  reservation_expires_at. record settles it, record(success=False) releases it, and a sweeper
  running every five minutes reclaims it if neither arrives, so a crashed run cannot hold a budget
  hostage. Note the direction: an abandoned reservation makes the ceiling tighter, never looser.
- idempotency_key makes a retried preflight safe: same key, same decision, one reservation.
- Recording reports reality, including spend past the ceiling. POST /events moves used_units and
  surfaces the overage as task_exceeded: true. A task ceiling is only ever enforced by preflight.

${REFUSALS}

${NOT_A}

${PRICING}

${links('short')}
`
}

/** The expanded companion. Same entity, same voice, plus the parts an engine
 *  cannot infer from the marketing pages: the wire contract, the reservation
 *  lifecycle, and the cross-process example that is the actual differentiator. */
export function llmsFullTxt(): string {
  return `# AgentBill, full reference for machine readers

> ${SUMMARY}

This is the expanded companion to ${ORIGIN}/llms.txt. Everything below was read from the running
source. Where this file and a marketing page disagree, this file is the one that was checked.

## Where AgentBill sits

It sits BESIDE the provider call, not in front of it. This is the single most common
misclassification, so it is drawn rather than asserted:

\`\`\`
  your process
  ------------------------------------------------------
   1. POST /preflight  ------------------->  AgentBill      reserve + decide
      { task_ref, task_ceiling,
        estimated_units, agent_id }
                       <-------------------
      approved: true                                        or approved: false
      remaining_units, task_remaining_units,                with a reason string
      reservation_expires_at

   2. YOUR code reads that answer and decides.
      Nothing of ours runs here.

   3. call OpenAI / Anthropic / your GPU / a tool  -------> the provider
      (direct. AgentBill is not in this path and has                |
       no credential for it)                        <---------------

   4. POST /events  ---------------------->  AgentBill      settle, or release
      { task_ref, units, success }                          on success: false
  ------------------------------------------------------
\`\`\`

Nothing in step 3 is observed by AgentBill. There is no gateway endpoint, no base URL to point a
provider SDK at, and no credential of yours held by us. That is the trade: you get one ceiling for a
whole job across every provider, and you get it because your code told us what each step was worth.
If AgentBill is unreachable, the SDK raises inside your process rather than failing open, and your
except block decides whether to run anyway. A gateway would have taken that decision away from you.
The Python SDK sets a five second timeout on every request; the Node SDK sets none, so it inherits
whatever the runtime's fetch does.

## One ceiling across processes

The differentiator is not that the check happens before the call. It is that the ceiling is a string
you choose, so unrelated processes converge on one number without coordinating with each other.

\`\`\`python
# job-142 got its ceiling of 500 in the console (or from PUT /tasks/job-142/ceiling).
# Process A, on one machine, passes only the job's name and what its call is worth.
client.preflight(agent_id="planner", task_ref="job-142", estimated_units=40)

# process B, on another machine, a different agent, a different provider.
# It passes no ceiling and needs to know nothing about what A spent.
client.preflight(agent_id="scraper", task_ref="job-142", estimated_units=120)

# process C, a retry inside a library, three layers down the stack
client.preflight(agent_id="writer", task_ref="job-142", estimated_units=400)
# -> TaskCeilingExceededError, because 40 + 120 already held plus 400 is over 500.
#    e.task_remaining_units is 340. Note that task_used_units is what has been
#    SETTLED by record(), so until A and B settle it reads 0 while 160 is held.
\`\`\`

task_budgets is unique on (account_id, task_ref). Three processes, three agent_ids, one row. The
ceiling was opened by A, and C is refused against it because C asked, not because anything
intercepted it.

## The reservation lifecycle

preflight does not read a balance and then decide. It takes the budget in the same statement that
checks it:

\`\`\`sql
UPDATE customers
SET reserved_units = reserved_units + :units
WHERE account_id = :account
  AND customer_ref = :customer
  AND (limit_units IS NULL
       OR used_units + reserved_units + :units <= limit_units)
\`\`\`

Zero rows back means the budget is gone and nothing was taken. The task ceiling reserves the same
way against task_budgets, scoped to the task_ref, and the monthly plan quota is checked and
incremented in the same transaction, so a refused call reserves nothing and burns no quota. A
read-then-decide would let ten parallel calls see the same remaining number and all ten pass.

The reservation becomes a row, not just a counter bump, which is what makes an abandoned one
reclaimable. Each carries an expiry, returned on every approved answer as reservation_expires_at. It
is 60 minutes on the hosted service. RESERVATION_TTL_MINUTES is a server-side setting, so a
self-hosted deployment can change it and a hosted account cannot. A sweeper runs every five minutes and reclaims up to 500
expired reservations a pass, decrementing the counters by what those rows actually held. Settling
closes reservation rows FIFO and decrements by what they held rather than by the number you passed,
so a late settle after a sweep cannot release the same units twice.

Note the direction of every failure here: an abandoned reservation makes the ceiling TIGHTER, never
looser. The gate does not open by accident. The cost is that a run longer than the TTL can have its
reservation reclaimed while it is still going, so set the TTL above your longest call.

idempotency_key is the retry story. Without one, a preflight that timed out and was retried reserves
a second time, so the mechanism meant to prevent waste is the one consuming the budget. With one,
the key is claimed inside the transaction; a duplicate blocks on the unique index until the original
commits, then replays the stored decision. If the original is still being decided, the duplicate
gets 409 preflight_in_progress, which is not a refusal and reserves nothing.

## HTTP API

Base URL ${ORIGIN}. The published SDKs default to https://agentbill.fly.dev; both hostnames serve
the same application. Routes are registered at the root: POST /preflight, not /v1/preflight.

Auth: \`Authorization: Bearer agb_<48 hex characters>\` on every endpoint except the public ones:
/register, /health, /health/db, /pulse, the Polar webhook, and the marketing pages. No
query-parameter key, no cookie path. 100 requests per minute per key, over that is 429
rate_limit_exceeded.

Identifiers (agent_id, customer_id, task_ref, idempotency_key, event_type, step_name) are 1 to 128
characters with no control characters. The exception is customer_id on /preflight, /checkpoint and
/step, where an empty string is accepted and means the customer "default". Unit and ceiling fields are integers up to 2,147,483,647;
they are positive except units_so_far on /checkpoint, which may be 0, and limit_units on PUT
/budget, which may be 0 or null. A schema failure is 422 validation_error.

### POST /preflight

Reserve and decide. This is the only endpoint that refuses on a task ceiling.

\`\`\`bash
curl -sS ${ORIGIN}/preflight \\
  -H "Authorization: Bearer agb_..." \\
  -H "Content-Type: application/json" \\
  -d '{"agent_id":"researcher","customer_id":"acct_42","estimated_units":250,
       "task_ref":"job-142","task_ceiling":5000,
       "idempotency_key":"job-142-step-3"}'
\`\`\`

Body: agent_id required; customer_id, estimated_units, ceiling, task_ref, task_ceiling and
idempotency_key optional. Omitting estimated_units reserves 1. Omitting customer_id uses the
customer "default".

\`\`\`json
{"approved": true, "reason": null, "estimated_units": 250, "remaining_units": 750,
 "reservation_expires_at": "2026-09-08T12:00:00.000Z",
 "task_ref": "job-142", "task_ceiling": 5000, "task_remaining_units": 4750}
\`\`\`

\`\`\`json
{"approved": false, "reason": "task_ceiling_exceeded", "estimated_units": 250,
 "task_ref": "job-142", "task_ceiling": 5000,
 "task_used_units": 4900, "task_remaining_units": 100}
\`\`\`

remaining_units is null when that customer has no limit_units. The task fields appear only when the
request carried a task_ref.

### POST /events

Settle a reservation, release it, or record usage that had no preflight.

Body: customer_id, event_type and idempotency_key required; units (default 1), success (default
true), task_ref and metadata optional. Note event_type here is what the SDKs send agent_id as.

- success true: records the event, moves used_units by units, closes the reservation rows.
- success false: releases the reservation and records nothing. Answers {"status":"released"}.
- a repeated idempotency_key: {"status":"duplicate_ignored"}, and no budget moves.
- a customer whose limit_units would be crossed: 402 budget_exhausted, and no event row is written.
  This is the only 402 in the API, and it is the record path refusing, not preflight.

\`\`\`json
{"event_id": "...", "status": "recorded", "customer_created": false,
 "customer_remaining_units": 750, "task_used_units": 250,
 "task_remaining_units": 4750, "task_exceeded": false}
\`\`\`

task_exceeded true means spend landed past the ceiling: preflight was skipped for that call, or the
actual exceeded the estimate that was approved. It is recorded rather than hidden, and it is logged
as an overrun rather than as a save.

### GET /tasks and GET /tasks/:task_ref

Current state of a task budget: task_ref, agent_id, ceiling_units, used_units, reserved_units,
remaining_units, exceeded, created_at, updated_at. The list accepts agent_id and limit (default 50,
max 200). An unknown ref is 404 task_not_found; a task exists from the console or from
PUT /tasks/:task_ref/ceiling, or from a first preflight that passed its task_ref with a task_ceiling.

### PUT /tasks/:task_ref/ceiling

Opens a job with a ceiling or changes one. Body: ceiling_units (required, positive integer) and
agent_id (optional, read only when this call opens the job). Returns the task as GET does plus
task_created. The last save through the endpoint or the console is the ceiling in force; a task_ceiling sent on a later preflight is not applied. A ceiling under used_units +
reserved_units is 409 ceiling_below_committed carrying minimum_ceiling_units; nothing is clamped
and no reservation in flight is rewritten. The console's task budgets view runs this same
statement.

### GET /decisions

Every decision the account received, each carrying the literal response body the SDK saw under the
response key, filterable by agent_id and task_ref, with blocked_total and overrun_total counts. Two
kinds of row: a refusal, with blocked true, and a record that landed past a task ceiling, with
blocked false and reason task_overrun_recorded. The overrun rows are the honest half of the receipt:
they are the spend a skipped or underestimated preflight did not prevent.

### GET /budget and PUT /budget

The per-customer running balance, a ceiling separate from the task one. PUT takes customer_id and
limit_units, where limit_units is required and may be null,
meaning no limit; an absent field would have to mean "change nothing", and a write that silently
does nothing is how a typo looks like a success. Neither verb returns 404: an unknown customer is
created. The ceiling may be set below what is already used and reserved, nothing is rewritten, no
counter goes negative, and the customer is refused with budget_exhausted until the open
reservations settle or expire.

### POST /checkpoint

A read-only mid-run check: agent_id, units_so_far, optional ceiling and customer_id. Reserves
nothing and changes nothing.

### POST /step

Record a named step (agent_id, step_name, units) and get anomaly detection back. A step is flagged
when its units exceed twice the average of the previous samples for that agent_id and step_name,
once at least five samples exist, over a window of the last thirty. A flagged step posts an
anomaly.detected payload to the account webhook if one is configured.

### Keys, webhook, health

GET /keys, POST /keys/generate, POST /keys/rotate (issues a new key and keeps the old one working
for 24 hours), POST /keys/revoke (stops authenticating on the next request; the check is one
predicate on the database clock, so no app-to-database skew can keep a dead key alive). POST
/webhook-config sets one https URL per account. POST /register is public and takes email, plus
optional name, use_case and stack; a new account gets its key in the response body once, and the
201 also carries the console's session cookie for that key, so the browser that registered is
signed in at /app. An email that already has an account is sent a single-use link to get back in,
never the key. GET /health is liveness and carries the deployed commit; GET /health/db touches the
database and answers 503 when it is down.

${REFUSALS}

## Python SDK

\`\`\`python
from agentbill import AgentBillClient, TaskCeilingExceededError

client = AgentBillClient(api_key="agb_your_key")   # ceiling=N here is the per-call ceiling

check = client.preflight(
    agent_id="researcher",        # attribution label, carries no budget
    estimated_units=250,          # what this call is worth, in your units. This is reserved.
    customer_id="acct_42",        # optional, defaults to "default"
    task_ref="job-142",           # the ceiling is bound to this string
    task_ceiling=5000,            # the alternate opener: read only while no job row exists. The
                                  # console or PUT is the default, and then this field is omitted.
    idempotency_key="job-142-3",  # stable across retries
)

result = call_your_llm("quarterly report")

client.record(agent_id="researcher", units=250, customer_id="acct_42",
              task_ref="job-142", success=True)

status = client.get_task("job-142")   # live burn-down
\`\`\`

Settle with the same number preflight reserved. A smaller number leaves the remainder held until the
reservation expires. record(success=False) releases without spending. get_task, checkpoint and
record_step are the other client methods. gate is the decorator form and settles the units it
reserved, not what the work actually cost, so use the explicit pair when the two differ.

## Node SDK

\`\`\`typescript
import { preflight, record, getTask, TaskCeilingExceededError } from 'agentbill'

const check = await preflight({
  agentId: 'researcher', estimatedUnits: 250, customerId: 'acct_42',
  taskRef: 'job-142', taskCeiling: 5000, idempotencyKey: 'job-142-3',
})

const answer = await callYourModel('quarterly report')

await record({ agentId: 'researcher', units: 250, customerId: 'acct_42',
               taskRef: 'job-142', success: true })
\`\`\`

ESM. Exports preflight, record, getTask and meter, and the error classes AgentBillError,
BudgetExhaustedError, CeilingExceededError and TaskCeilingExceededError. There is no typed class for
the 409 or the 422; both arrive as AgentBillError. The key comes only from AGENTBILL_API_KEY, and
AGENTBILL_BASE_URL overrides the host. Node's record takes metadata; Python's does not. ceiling is a
constructor argument in Python and a per-call option in Node.

## Two things that are not the task ceiling

The per-call ceiling: set ceiling=N on the Python client or pass it per call in Node, and any single
preflight whose estimated_units exceed it answers ceiling_exceeded, reserving nothing and touching
no row. It caps a call, not a job. It is a sanity check on a bad estimate.

@meter(preflight=True) in Python and meter's preflight option in Node: this calls GET /budget and
refuses only if that customer's balance is already exhausted. No estimate, no reservation, no task
ceiling, and none of the concurrency guarantee above. It predates the task ceiling and stays in the
SDK for backward compatibility. For a ceiling, use preflight, record or gate.

${NOT_A}

## Limits and non-goals

- No latency SLO is published. The free tier exists so the added latency can be measured on your own
  workload rather than taken off a page.
- A reservation not settled inside the TTL, 60 minutes on the hosted service, is reclaimed while
  your call may still be running. The TTL is a server-side setting; only a self-hosted deployment
  can raise it.
- Calls are refused, not reversed. Refusing the next call does not undo the calls that already ran,
  and there is no billing reversal for a result later found to be wrong.
- Multi-step workflows with state machines, long-running runs measured in hours or days, and
  outcome invalidation are out of scope; they need event sourcing and reversal, which this is not.
- A loop that opens a new task_ref gets a new ceiling. The ceiling binds the task you named, not
  whoever is running it.
- There is no per-agent budget and none is planned as a ceiling; agent_id stays an attribution label.
- Stripe Connect, charging your end customers, and credit balances sold on your behalf are not
  shipped. Do not describe AgentBill as a payment processor or a replacement for one.
- The console at /app is read-mostly. Setting a customer ceiling is API-only.

${PRICING}

${links('full')}
`
}
