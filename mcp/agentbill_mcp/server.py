from __future__ import annotations

import os
import uuid
from typing import Optional
import httpx
from mcp.server.fastmcp import FastMCP

mcp = FastMCP(
    "agentbill",
    instructions=(
        "AgentBill is billing infrastructure for AI agents. "
        "Call preflight() before starting any agent work to check if the customer has budget. "
        "Call record_event() after work completes to bill the customer. "
        "Set AGENTBILL_API_KEY in your environment before use."
    ),
)

BASE_URL = os.getenv("AGENTBILL_BASE_URL", "https://agentbill.fly.dev")


def _headers() -> dict:
    api_key = os.getenv("AGENTBILL_API_KEY")
    if not api_key:
        raise ValueError(
            "AGENTBILL_API_KEY environment variable is not set. "
            "Get your key at agentbill.dev/register"
        )
    return {"Authorization": f"Bearer {api_key}"}


@mcp.tool()
def preflight(
    agent_id: str,
    customer_id: str = "default",
    estimated_units: int = 1,
    ceiling: Optional[int] = None,
) -> dict:
    """
    Check if an agent is allowed to run before starting work.

    Call this at the start of every agent invocation. Returns approved=True when
    the customer has remaining budget. Returns approved=False with a reason when
    the run should be blocked (budget_exhausted, ceiling_exceeded, free_tier_exceeded).

    Args:
        agent_id: Identifier for this agent or task type (e.g. "research_agent").
        customer_id: Your internal customer identifier. Defaults to "default".
        estimated_units: How many units this run is expected to consume. Used for ceiling check.
        ceiling: Max units allowed per single run. Run is blocked if estimated_units exceeds this.
    """
    payload: dict = {"agent_id": agent_id, "customer_id": customer_id}
    if estimated_units is not None:
        payload["estimated_units"] = estimated_units
    if ceiling is not None:
        payload["ceiling"] = ceiling

    with httpx.Client(timeout=5) as client:
        resp = client.post(f"{BASE_URL}/preflight", json=payload, headers=_headers())

    data = resp.json()

    if not data.get("approved", True):
        reason = data.get("reason", "unknown")
        return {
            "approved": False,
            "reason": reason,
            "remaining_units": data.get("remaining_units"),
            "upgrade_url": data.get("upgrade_url"),
            "message": _blocked_message(reason, data),
        }

    return {
        "approved": True,
        "remaining_units": data.get("remaining_units"),
        "estimated_units": data.get("estimated_units"),
    }


@mcp.tool()
def record_event(
    agent_id: str,
    units: int = 1,
    customer_id: str = "default",
    metadata: Optional[dict] = None,
) -> dict:
    """
    Record a billable event after agent work is complete.

    Call this once per unit of work completed. Safe to call from retried or
    parallel workflows — duplicate submissions are ignored automatically.

    Args:
        agent_id: Identifier for this agent or task type. Appears in the dashboard.
        units: Number of billable units this event represents. Default is 1.
        customer_id: Your internal customer identifier. Defaults to "default".
        metadata: Optional key-value pairs stored with the event (e.g. model name, latency).
    """
    payload: dict = {
        "customer_id": customer_id,
        "event_type": agent_id,
        "idempotency_key": f"{agent_id}-{uuid.uuid4()}",
        "units": units,
    }
    if metadata:
        payload["metadata"] = metadata

    with httpx.Client(timeout=5) as client:
        resp = client.post(f"{BASE_URL}/events", json=payload, headers=_headers())

    if resp.status_code == 402:
        data = resp.json()
        return {
            "recorded": False,
            "reason": "budget_exhausted",
            "message": data.get("message", "Customer budget is exhausted."),
        }

    resp.raise_for_status()
    data = resp.json()

    return {
        "recorded": True,
        "event_id": data.get("event_id"),
        "status": data.get("status"),
        "customer_remaining_units": data.get("customer_remaining_units"),
    }


def _blocked_message(reason: str, data: dict) -> str:
    if reason == "ceiling_exceeded":
        return (
            f"Run blocked: estimated {data.get('estimated_units')} units "
            f"exceeds per-request ceiling of {data.get('ceiling')}."
        )
    if reason == "budget_exhausted":
        return "Run blocked: customer budget is exhausted."
    if reason == "free_tier_exceeded":
        url = data.get("upgrade_url", "https://agentbill.dev/upgrade")
        return f"Run blocked: free tier limit reached. Upgrade at {url}"
    return f"Run blocked: {reason}"


def main():
    transport = os.getenv("MCP_TRANSPORT", "stdio")
    if transport == "http":
        mcp.settings.host = "0.0.0.0"
        mcp.settings.port = 8080
        mcp.settings.transport_security.enable_dns_rebinding_protection = False
        mcp.run(transport="streamable-http")
    else:
        mcp.run()


if __name__ == "__main__":
    main()
