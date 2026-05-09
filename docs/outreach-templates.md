# Reddit DM Outreach Templates

Use these when someone posts about bill shock, runaway costs, or agent spend problems.
Send as a DM, not a reply with a link (links get auto-removed by AutoModerator on most subs).

---

## Template 1 — Classic bill shock complaint

**Trigger:** Someone posts about an unexpected OpenAI/Claude bill from an agent run.

> Hey, saw your post about the $X bill. That's exactly the problem I built AgentBill for.
>
> It's a preflight gate — 3 lines of code, checks budget before the agent starts. If the budget is exceeded, it blocks the run entirely. The agent never starts, no tokens consumed.
>
> Different from Stripe metered billing which only tracks after the damage is done.
>
> Free tier is 1,000 calls/month. If you want to try it: agentbill.fly.dev/register
>
> Happy to answer questions if you run into anything.

---

## Template 2 — "Monthly cap isn't enough" conversation

**Trigger:** Developer mentions monthly caps don't help because a single run blew the budget.

> That's exactly the gap — monthly caps don't catch the bad single run.
>
> I built a per-request ceiling for this. Before the agent fires, you declare how many units it's allowed to use. If it would exceed that, it's blocked at the invocation level, not tracked after.
>
> Two lines in Python:
> ```python
> check = client.preflight(agent_id="researcher", estimated_units=10, ceiling=50)
> if not check.approved: raise Exception("Blocked")
> ```
>
> If this sounds useful: agentbill.fly.dev/register — free tier, no card needed.

---

## Template 3 — LangChain / agent framework user

**Trigger:** Someone asking how to add billing or cost controls to a LangChain agent.

> For LangChain specifically, the pattern I use is wrapping the chain call with a preflight check:
>
> ```python
> check = client.preflight(agent_id="chain_name", estimated_units=5)
> if not check.approved:
>     return {"error": check.reason}
> result = chain.invoke(inputs)
> client.record(agent_id="chain_name", units=5)
> ```
>
> Blocks before any LLM call happens. Works with any chain, no LangChain-specific hooks needed.
>
> I built AgentBill for exactly this use case. agentbill.fly.dev/register if you want to try it.

---

## Template 4 — Multi-tenant / SaaS developer

**Trigger:** Someone building a product where their customers trigger agent runs and they want per-customer billing.

> For multi-tenant this is where it gets interesting. You pass a customer_id to the preflight check and each customer has their own budget tracked separately:
>
> ```python
> check = client.preflight(
>     agent_id="researcher",
>     customer_id=user.id,
>     estimated_units=10
> )
> ```
>
> When a customer hits their limit, only that customer gets blocked. Everyone else keeps running.
>
> That's what AgentBill handles. agentbill.fly.dev/register — first 1,000 calls free per account.

---

## Template 5 — MCP / Claude Code user

**Trigger:** Someone using Claude Code, Cursor, or Windsurf and mentioning cost concerns with MCP tools.

> AgentBill has an MCP server for this. Adds preflight + billing as native tools in Claude Code, Cursor, Windsurf.
>
> ```bash
> uvx agentbill-mcp
> ```
>
> Then in ~/.claude/settings.json:
> ```json
> {
>   "mcpServers": {
>     "agentbill": {
>       "command": "uvx",
>       "args": ["agentbill-mcp"],
>       "env": { "AGENTBILL_API_KEY": "your_key" }
>     }
>   }
> }
> ```
>
> The agent can then call preflight before any expensive tool use. Blocks at the MCP level before compute runs.
>
> Key at agentbill.fly.dev/register, free tier no card needed.

---

## Where to find targets

- r/LangChain — search "bill", "cost", "expensive", "budget"
- r/SaaS — search "OpenAI cost", "agent billing", "metered"
- r/LocalLLaMA — search "runaway", "GPU cost", "vram"
- r/MachineLearning — search "API cost", "token limit"
- r/ClaudeAI — search "cost", "billing", "expensive"

## Rules

- Never post links in comments until you have 5+ sub-karma on that sub
- DM first, offer the link in the DM
- Admit product gaps honestly if they ask — builds more trust than overselling
- Answer with code when possible — gets upvotes, signals legitimacy
