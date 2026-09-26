# AgentBill for OpenClaw

Give every OpenClaw session a spend budget, in tokens or in calls. Before each
model turn and each tool call, the plugin asks AgentBill whether the session
still has room. When it does not, the call is refused and the session says so,
in one sentence that names the session, the count and the ceiling. A console
lists what each session spent and, if you ask for it, which sender or channel
spent it.

That budget is the session's ceiling, the `ceilingUnits` you set. It has no
clock. It does not refill at the top of an hour or a month: a session that has
spent it is refused until you raise it in the console or start a new session.
A subagent draws on its parent's ceiling when OpenClaw reports which session
spawned it, so a fan-out draws one number down.

Model turns are asked on OpenClaw's embedded and CLI runners, where OpenClaw
runs `before_agent_run`. On the Codex and Copilot harnesses that hook does not
run, so there only tool calls are asked.

## Install

```bash
openclaw plugins install clawhub:@agentbill/openclaw
```

The package is `@agentbill/openclaw` on ClawHub. Its plugin id, and its key
under `plugins.entries` in your OpenClaw config, is `agentbill`.

Then give it an AgentBill key. Create a free one at https://agentbill.dev/register
(1,000 preflight calls a month, no card). Put it in the plugin config as
`apiKey`, or in the Gateway environment as `AGENTBILL_API_KEY` and leave
`apiKey` out. `agb_...` below stands for your key.

```json
{
  "plugins": {
    "entries": {
      "agentbill": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true },
        "config": {
          "apiKey": "agb_...",
          "ceilingUnits": 500000
        }
      }
    }
  }
}
```

`ceilingUnits` is each session's ceiling, in the unit described below. The
default is 500,000 tokens.

### Set allowConversationAccess, or model turns go unasked

The `hooks.allowConversationAccess` line is not optional. OpenClaw registers
`before_agent_run` and `llm_output` for a plugin it does not bundle only when
the operator has set it. Without it the Gateway registers the other five hooks
without saying so: tool calls are asked about, model turns are not, and in
tokens mode nothing is recorded, so the ceiling never moves. The plugin checks
the flag when it loads and, when it is missing, logs an error naming the
command to run:

```bash
openclaw config set plugins.entries.agentbill.hooks.allowConversationAccess true
```

Restart the Gateway, then list the typed hooks the host accepted:

```bash
openclaw plugins inspect agentbill --runtime
```

The log line `[agentbill] ceiling 500000 tokens per session, ... conversation hooks allowed`
means it is on.

`openclaw plugins uninstall agentbill` removes the whole `plugins.entries.agentbill`
entry, the flag with it, so set it again after a reinstall.

## What one unit is

`units: "tokens"` is the default. After a model turn runs, the plugin records
the usage total OpenClaw reports for it in `llm_output`, which covers every
model call in the turn. Before a call it reserves an estimate: `estimateUnits`
for the session's opening call, then the session's running average of what the
reports came to. Tool calls record nothing in tokens mode unless you set
`toolCallUnits`; the model calls around them are what cost. A ceiling of
`500000` is half a million tokens for the session.

`units: "calls"` counts one unit for each `llm_output` report and one for each
tool call. OpenClaw's embedded runner reports once per model turn (once per
attempt, if it retries one), however many model calls the turn made, so a
ceiling of `40` is forty turns and tool calls together.

The plugin measures no provider and no tool itself. It records what OpenClaw
already counts, and refuses when the running total plus the next call's
estimate would pass the ceiling. The model calls inside a turn are recorded
after they run, so a turn can end past the ceiling; the next tool call is then
refused, and so is the next turn wherever turns are asked.

A turn OpenClaw reports with no usage is recorded as `usage_missing`, not as 0.
The server charges it at least what its preflight reserved, and the session's
job counts it as a call with no usage reported.

## What a refusal looks like

Before a model turn, OpenClaw does not send the prompt to the model, and the
session shows this sentence inside a notice of OpenClaw's own:

```
AgentBill refused (task_ceiling_exceeded): openclaw:agent:main:discord:1234 is at 501200/500000 tokens. Raise the ceiling at https://agentbill.dev/app or start a new session.
```

Before a tool call, the tool does not run, and the model receives the same
sentence as the tool's result.

Nothing is ended. The session stays open, the next inbound message starts a new
turn, and that turn asks again: raise the ceiling in the console and it goes
through, or start a new session, which has a ceiling of its own.

## What you see in the console

Each session is a job in the console at https://agentbill.dev/app, named
`openclaw:` plus the session key (`taskRefPrefix` changes the prefix).

- **Tasks** lists the jobs, newest or most used at the top, each with its used
  units against its ceiling, and the ceiling can be raised or lowered there.
- **A ceiling suggested from your own sessions.** The Tasks view lists, per
  agent, the p50, p90 and max usage of up to 20 recent jobs that have usage and
  nothing in flight. For `openclaw` those jobs are your sessions, and a click
  puts one of the figures in the ceiling field, still editable.
- **Refusals** lists every refused call with the literal body the plugin
  received.
- **Customers.** With `customerFrom: "sender"` or `"channel"`, each session's
  usage is also attributed to that OpenClaw sender or channel id as an AgentBill
  customer, and the Customers view ranks them by usage.
- **By model, on the API.** `GET /tasks/openclaw:<session key>` returns the
  session's calls and units by model, from the provider and model names
  OpenClaw reports.

**What each session cost, at list price.** Each model call is recorded with the
per-type token counts OpenClaw reports (input, cache reads, cache writes,
output), so AgentBill prices it at public list price, and the console shows what
each session, agent and customer cost in dollars. It is an estimate, not your
invoice. OpenAI, Anthropic and Google Gemini calls are priced; a provider the
price table does not cover (OpenRouter, for example) or a model it does not
list is shown as unpriced, never as $0. OpenClaw reports one cache-write count
with no 5-minute or 1-hour split, so cache writes are priced at the 5-minute
rate, which is under Anthropic's price for a 1-hour cache write. The ceiling
stays in the unit you chose.

## Options

| Key | Default | What it does |
|---|---|---|
| `apiKey` | `AGENTBILL_API_KEY` from the environment | The key. Without one, nothing is enforced and the plugin says so at load. |
| `baseUrl` | `https://agentbill.dev` | Where to ask. Must be `https`, or plain `http` to `localhost`, `127.0.0.1` or `[::1]`. Anything else is a config error: logged at startup, nothing is sent, and every call is decided by `failMode`. |
| `ceilingUnits` | `500000` | Ceiling per session. Applied when the session's job is opened; later changes are made in the console. |
| `units` | `tokens` | `tokens` or `calls`, see above. |
| `estimateUnits` | `2000` tokens / `1` call | Reserved before a call whose cost is unknown. In tokens mode the session's running average takes over after its opening model call. |
| `toolCallUnits` | `0` tokens / `1` call | Units recorded per tool call. |
| `taskRefPrefix` | `openclaw:` | The job name is this plus the session key. |
| `agentId` | `openclaw` | The agent the sessions are attributed to in the console. |
| `customerFrom` | `none` | `sender` or `channel`, to attribute usage per customer in the console. |
| `failMode` | `closed` | When AgentBill cannot be reached: `closed` refuses and says why, `open` lets the call run and logs it. |
| `timeoutMs` | `5000` | Per request, 100 to 14000. OpenClaw's own gate budget is 15 seconds. |

## How it maps onto OpenClaw's hooks

| Hook | Kind | The plugin |
|---|---|---|
| `session_start` | observe | opens the job `<prefix><sessionKey>` |
| `subagent_spawned` | observe | links the child session to the parent's job |
| `before_agent_run` | gate | `POST /preflight`; refused returns `{ outcome: "block", message }` |
| `before_tool_call` | gate | `POST /preflight`; refused returns `{ block: true, blockReason }` |
| `llm_output` | observe | `POST /events` with the usage total (or `usage_missing` when the host sent none), the provider and model, and the turn's `reservation_id` when there is one |
| `after_tool_call` | observe | `POST /events` with `toolCallUnits` when above zero, and at 0 when the call's preflight returned a `reservation_id`, to settle it |
| `session_end` | observe | forgets the session |

Hook names and kinds are from `docs/plugins/hooks/reference.md` in openclaw
2026.9.4. The child-to-parent link uses `requesterSessionKey` from the
`subagent_spawned` context; when OpenClaw does not report it, the child session
gets a ceiling of its own rather than none. Each record settles the reservation
its own preflight made, so what the estimate held beyond what was used is
released at once rather than at the server's 60 minute expiry.

## When something fails

- **AgentBill cannot be reached.** With `failMode: "closed"`, the default, the
  call is refused and the sentence says why: `AgentBill could not be reached (...), and this plugin is set to refuse rather than guess.`
  With `failMode: "open"` the call runs and a warning is logged. A 5xx from
  AgentBill is unreachable, never a refusal. OpenClaw fails its two gate hooks
  closed on a thrown error or a 15 second timeout; the plugin's own timeout is
  shorter so a refusal carries a reason instead of a timeout.
- **A record fails.** Its reservation stays open until the server releases it,
  within 60 minutes. The ceiling still holds; the console is briefly behind.
- **AgentBill's own quota runs out.** The free tier is 1,000 preflight calls a
  month, and each model turn and each tool call is one. When that is spent the
  server answers `free_tier_exceeded`. That is our quota, not your ceiling, so
  the plugin lets the call run and logs one warning per session with the
  upgrade link. An AgentBill billing state never refuses your agent's call.
- **No key.** The plugin logs an error at load and enforces nothing.

## What it does not do

- It does not price anything in dollars. Usage is in tokens or calls, as
  OpenClaw counts them.
- It does not sit in the request path. The model call goes from OpenClaw to
  your provider as before; the plugin adds one request to agentbill.dev before
  each gated call and a record after it.
- It does not end a session or a run, and it does not change your model. A
  refused call is refused; the session continues on the next message.
- It does not measure tool spend. A tool call counts `toolCallUnits`, which is
  0 in tokens mode unless you set it.
- It does not ask about model turns on the Codex and Copilot harnesses, where
  OpenClaw does not run `before_agent_run`. Only tool calls are asked there.
- It does not send your prompts or answers anywhere. What leaves the Gateway is
  the session key as the job name, the counts, the provider and model names
  OpenClaw reports, tool names, and the sender or channel id when
  `customerFrom` is set.

## Source

The plugin is `plugins/openclaw` in
https://github.com/marketinglior-pixel/agentbill, MIT. Development and release
notes are in `PUBLISHING.md` beside it in the repository.
