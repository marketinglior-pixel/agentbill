# AgentBill

Usage-based billing for AI agents. Preflight. Per-request ceiling. No Stripe.

---

Stripe tells you how much you spent. Too late.
AgentBill blocks the run before it starts if the budget says so.

> "The moment you're using Stripe as your safety net, you've already lost the run."
> — scarlett1908, r/LangChain

---

## Install

pip install agentbill-sdk

## Quick Start

from agentbill import AgentBillClient

client = AgentBillClient(api_key="agb_your_key")

check = client.preflight(agent_id="researcher", budget=5.00)
if not check.approved:
    raise Exception("Budget exceeded")

client.record(agent_id="researcher", cost=check.estimated_cost)

Get your API key: https://agentbill.fly.dev/register

---

## What it does

Preflight. Before the agent runs, AgentBill checks: does this customer have enough budget? If not, block it before any compute is consumed.

Per-request ceiling. Monthly caps do not catch the bad single run. One 3-hour research loop can blow your budget before the cap triggers. AgentBill enforces a ceiling at the invocation level.

Outcome-based metering. You define what counts as a billable event. Not bytes, not seconds. The business-level action the agent performed.

---

## Free tier

1,000 preflight calls/month. No credit card required.

---

## What it does NOT do

- Multi-step workflows with state machines or reversal logic (out of scope)
- Replace your payment processor (AgentBill sits in front of it)
- No-code dashboard for non-developers

---

## Node.js

npm install agentbill

---

## Why not Stripe

Stripe | AgentBill
Preflight block: No | Yes
Per-request ceiling: No | Yes
Blocks before compute: No | Yes
Built for agents: No | Yes

---

## Star this repo

If per-request ceilings are what you needed, star this. It helps other developers find it.
