# AgentBill for OpenClaw

One spend ceiling per OpenClaw session. Every model turn and every tool call
consults it before it runs. When the ceiling is spent, the call is refused and
the session says so. Subagents and tool loops spawned from a session draw down
the same number, so a fan-out cannot spend past the ceiling one hop at a time.

The ceiling is bound to the session, not to a rolling window and not to a
calendar month. A budget that resets in an hour does not stop the loop that is
running now.

## Install

```bash
openclaw plugins install clawhub:agentbill
```

Then give it a key. Create a free one at https://agentbill.dev/register (1,000
preflight calls a month, no card), and put it in the plugin config or in the
Gateway environment as `AGENTBILL_API_KEY`.

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

The `hooks.allowConversationAccess` line is not optional. OpenClaw registers
`before_agent_run` and `llm_output` for a non-bundled plugin only when the
operator has set it; without it the Gateway silently registers the other five
hooks, so model turns would not be gated and, in tokens mode, nothing would be
recorded. The plugin checks for the flag at load and logs an error naming the
exact `openclaw config set` command if it is missing. `openclaw plugins inspect
agentbill --runtime` lists which typed hooks the host accepted.

Restart the Gateway. The log line `[agentbill] ceiling 500000 tokens per
session, ... conversation hooks allowed` means it is on.

## What one unit is

`units: "tokens"` (default). Every model call records the usage total OpenClaw
reports in its `llm_output` hook. Tool calls record nothing on their own; the
model call around them is what costs. A ceiling of `500000` is half a million
tokens for the session.

`units: "calls"`. Every model call and every tool call is one unit. A ceiling
of `40` is forty calls.

The plugin measures no provider and no tool itself. It records what OpenClaw
already counts, and refuses when the running total plus the next call's
estimate would cross the ceiling.

## What a refusal looks like

Before the model turn, the run stops before the prompt reaches the model, and
the user sees:

```
AgentBill refused (task_ceiling_exceeded): openclaw:agent:main:discord:1234 is at 501200/500000 tokens. Raise the ceiling at https://agentbill.dev/app or start a new session.
```

Before a tool call, the tool does not execute and the model gets the same
sentence as the tool result.

Nothing of yours is killed. The next inbound message starts a new turn, and the
ceiling can be raised from the console at any time.

## Options

| Key | Default | What it does |
|---|---|---|
| `apiKey` | `AGENTBILL_API_KEY` from the environment | The key. Required for anything to be enforced. |
| `baseUrl` | `https://agentbill.dev` | Where to ask. |
| `ceilingUnits` | `500000` | Ceiling per session. Applied when the session's task is opened; later changes are made in the console. |
| `units` | `tokens` | `tokens` or `calls`, see above. |
| `estimateUnits` | `2000` tokens / `1` call | Reserved before a call whose cost is unknown. After the first model call the plugin uses the session's running average instead. |
| `toolCallUnits` | `0` tokens / `1` call | Units per tool call. |
| `taskRefPrefix` | `openclaw:` | The task_ref is this plus the session key. |
| `agentId` | `openclaw` | What the events are attributed to. |
| `customerFrom` | `none` | `sender` or `channel` to attribute spend per customer in the console. |
| `failMode` | `closed` | When AgentBill cannot be reached: `closed` refuses and says why, `open` lets the call run and logs it. |
| `timeoutMs` | `5000` | Per request. OpenClaw's own gate budget is 15 seconds. |

## How it maps onto OpenClaw's hooks

| Hook | Kind | The plugin |
|---|---|---|
| `session_start` | observe | opens `task_ref = <prefix><sessionKey>` |
| `subagent_spawned` | observe | links the child session to the parent's task_ref |
| `before_agent_run` | gate | `POST /preflight`; refused returns `{ outcome: "block", message }` |
| `before_tool_call` | gate | `POST /preflight`; refused returns `{ block: true, blockReason }` |
| `llm_output` | observe | `POST /events` with the usage total |
| `after_tool_call` | observe | `POST /events` with `toolCallUnits`, when above zero |
| `session_end` | observe | forgets the session |

Hook names and kinds are from `docs/plugins/hooks/reference.md` in openclaw
2026.9.4. The child-to-parent link uses `requesterSessionKey` from the
`subagent_spawned` context; when OpenClaw does not report it, the child session
gets a ceiling of its own rather than none. OpenClaw fails the two gate hooks closed on a thrown error or a 15
second timeout; the plugin's own timeout is shorter so a refusal carries a
reason instead of a timeout.

## When AgentBill's own quota runs out

The free tier is 1,000 preflight calls a month. When that is spent the server
answers `approved: false` with `free_tier_exceeded`. That is our quota, not
your ceiling, so the plugin lets the call run and logs one warning per session
with the upgrade link. An AgentBill billing state never stops your agent.

## Development

```bash
npm ci
npm run typecheck
npm test
```

The tests drive the plugin through a fake `api` and a fake `fetch`, and each
one was first made to fail. `npm run plugin:validate` runs OpenClaw's own
manifest check when the `openclaw` CLI is installed (it needs Node 24).

## Publishing

`dist/` is built, not committed, and `openclaw.extensions` points at
`./dist/index.js`. So publish the npm-pack tarball, which carries `dist/`,
rather than the repository path, which does not:

```bash
npm run build
npm pack
clawhub package publish ./agentbill-openclaw-0.1.0.tgz --family code-plugin --dry-run
clawhub package publish ./agentbill-openclaw-0.1.0.tgz --family code-plugin
```

`clawhub package validate .` runs ClawHub's plugin inspector. It checks
package and manifest shape against the target OpenClaw; it does not load the
plugin, and it passed a manifest category the Gateway then rejected. The
Gateway is the check that counts:

```bash
openclaw plugins install -l . --force --accept-capabilities
openclaw plugins inspect agentbill --runtime
```

ClawHub requires a GitHub account old enough to pass its upload gate and runs
automated scans on every release.
