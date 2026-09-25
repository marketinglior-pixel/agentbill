# Security Policy

AgentBill is a hosted API (agentbill.dev) plus the open-source clients in this
repository. This file says how to report a problem, what is in scope, and what
the clients send. The same policy, in plainer words, is at
https://agentbill.dev/security.

## Reporting a vulnerability

Please report privately. Do not open a public GitHub issue.

- Email **hello@agentbill.dev** with what you found, how to reproduce it, and
  what you think the impact is.
- Or use GitHub's **private vulnerability reporting** on this repository
  (Security tab, "Report a vulnerability").

You will get a reply within 48 hours. We will tell you whether we can
reproduce it, what we plan to do, and when it is fixed. If you want credit, say
how you would like to be named once the fix is live.

## Supported versions

| Component | Supported |
|---|---|
| The hosted service at agentbill.dev | Yes, always the deployed version |
| `agentbill-sdk` (Python, PyPI) | 0.7.x |
| `agentbill` (Node, npm) | 0.5.x |
| `agentbill-mcp` (MCP server, PyPI) | 0.2.x |
| `@agentbill/openclaw` (OpenClaw plugin) | 0.2.x |

Older client versions keep working against the API, but fixes land only in the
versions above. Upgrade to get them.

## Scope

In scope:

- The API and the pages at agentbill.dev, including the console at /app.
- The remote MCP server at https://agentbill.dev/mcp and the OAuth endpoints
  behind it (/.well-known/oauth-*, /oauth/*, /app/oauth/authorize).
- The clients in this repository: `sdk/python`, `sdk/node`, `mcp`,
  `plugins/openclaw`.

Out of scope:

- Denial of service, load testing, or anything that degrades the service for
  other people. Please do not run volume tests against agentbill.dev.
- Social engineering, and physical attacks.
- Third parties we use (Fly.io, Supabase, Polar, Resend). Report those to them.
- Findings that need an already compromised device or browser.

## Safe harbor

If you test in good faith, only against an account you created yourself, and
stop and report as soon as you can reach data that is not yours, we will not
pursue or support legal action against you for that testing. Do not access,
change or delete other people's data, and do not keep data you came across.
Give us a reasonable time to fix a problem before you publish it.

## If your API key leaks

Revoke it. From the next request on, the key no longer authenticates:

```bash
curl -X POST https://agentbill.dev/keys/revoke \
  -H "Authorization: Bearer <a key on the same account>" \
  -H "Content-Type: application/json" \
  -d '{"key_prefix":"<the leading 8 or more characters of the leaked key>"}'
```

Or open the console at https://agentbill.dev/app, where the keys view lists
every key on the account. If you have lost every key, https://agentbill.dev/recover
sends a single-use link to the account's email address.

`POST /keys/rotate` issues a new key and keeps the old one working for 24 hours,
which is for planned rotation. For a leak, revoke.

## What the clients send

Every request carries your AgentBill API key in the `Authorization` header, over
HTTPS. The clients in this repository refuse a base URL that is not `https://`,
except `localhost`, `127.0.0.1` and `[::1]` for local testing; the releases up
to `agentbill-sdk` 0.7.0, `agentbill` 0.5.0, `agentbill-mcp` 0.2.2 and
`@agentbill/openclaw` 0.2.0 do not check this yet, so keep the default base URL.

- **`preflight()` / `record()` / `meter()`** send what you pass them: `agent_id`,
  `task_ref`, `customer_id`, the units you estimate or report, an
  `idempotency_key`, and any `metadata` you choose to attach.
- **`wrap()`**, around an OpenAI, Anthropic or Gemini client, additionally sends,
  per model call: the provider name, the model, the token counts the provider
  reported, the call's duration, the `step` you named, the `requested_model`
  when it differs from the model that answered, the `service_tier` when the
  provider reports one, whether the call was streamed (`stream`), and the
  provider's response id (as the idempotency key, so a retried record is
  counted once).
- `wrap()` **never** sends your prompts, the model's responses, or your provider
  API keys. They stay between your process and the provider.
- **The MCP server** sends the same fields as `preflight()` and `record()` for the
  tools an agent calls. In this repository its HTTP mode listens on `127.0.0.1`
  by default, with DNS-rebinding protection on (0.2.2 and earlier bind
  `0.0.0.0`; prefer the default stdio mode with those).
- **The OpenClaw plugin** sends a preflight before each model turn and each
  tool call, and a record after, with the session's `task_ref`, the token total
  the host reports, the provider and model names for a model call, the tool's
  name for a tool call, and, only if you configure `customerFrom`, the sender or
  channel id as `customer_id`. It does not send the conversation or any tool's
  arguments or output.
