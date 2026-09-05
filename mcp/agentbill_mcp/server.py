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
    task_ref: Optional[str] = None,
    task_ceiling: Optional[int] = None,
    idempotency_key: Optional[str] = None,
) -> dict:
    """
    Check if an agent is allowed to run before starting work.

    Call this at the start of every agent invocation. Returns approved=True when
    the run has budget. Returns approved=False with a reason when the run should be
    blocked (budget_exhausted, ceiling_exceeded, free_tier_exceeded,
    task_ceiling_exceeded).

    A unit is an integer you define and pass. AgentBill reserves the number you send
    and never converts units to money, so the ceiling is only as tight as your
    estimate. The common convention is 1 unit = 1 cent.

    Args:
        agent_id: Identifier for this agent or task type (e.g. "research_agent").
        customer_id: Your internal customer identifier. Defaults to "default".
        estimated_units: How many units you expect this run to consume. This is the
            number reserved against every budget below.
        ceiling: Max units allowed per single run. Run is blocked if estimated_units exceeds this.
        task_ref: Groups many calls under one cross-call budget, so one job spanning
            several providers and tools shares a single ceiling. Pass the same
            task_ref on every call in the job.
        task_ceiling: Total units the whole task may spend. Required on the first
            preflight of a new task_ref, ignored on later calls.
        idempotency_key: Makes a retried preflight safe. Without it a retry
            reserves a second time. Same key, same decision, one reservation.
    """
    payload: dict = {"agent_id": agent_id, "customer_id": customer_id}
    if estimated_units is not None:
        payload["estimated_units"] = estimated_units
    if ceiling is not None:
        payload["ceiling"] = ceiling
    if task_ref is not None:
        payload["task_ref"] = task_ref
    if task_ceiling is not None:
        payload["task_ceiling"] = task_ceiling
    if idempotency_key is not None:
        payload["idempotency_key"] = idempotency_key

    with httpx.Client(timeout=5) as client:
        resp = client.post(f"{BASE_URL}/preflight", json=payload, headers=_headers())

    # A rejected request carries no "approved" key. Never fall through to the
    # success path on an error response: a gate that approves when it cannot
    # reach a verdict is worse than no gate.
    if resp.status_code == 409:
        data = resp.json()
        return {
            "approved": False,
            "reason": "preflight_in_progress",
            "message": data.get("message")
            or "Another preflight with this idempotency_key is still being decided. Retry in a moment.",
        }

    if resp.status_code == 422:
        data = resp.json()
        return {
            "approved": False,
            "reason": data.get("error", "validation_error"),
            "message": data.get("message")
            or "Preflight was rejected as invalid. The run did not start.",
        }

    resp.raise_for_status()
    data = resp.json()

    if not data.get("approved", True):
        reason = data.get("reason", "unknown")
        blocked = {
            "approved": False,
            "reason": reason,
            "remaining_units": data.get("remaining_units"),
            "upgrade_url": data.get("upgrade_url"),
            "message": _blocked_message(reason, data),
        }
        if data.get("task_ref"):
            blocked["task_ref"] = data.get("task_ref")
            blocked["task_remaining_units"] = data.get("task_remaining_units")
        return blocked

    result = {
        "approved": True,
        "remaining_units": data.get("remaining_units"),
        "estimated_units": data.get("estimated_units"),
    }
    if data.get("task_ref"):
        result["task_ref"] = data.get("task_ref")
        result["task_remaining_units"] = data.get("task_remaining_units")
    return result


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
    parallel workflows, duplicate submissions are ignored automatically.

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
    if reason == "task_ceiling_exceeded":
        return (
            f"Run blocked: task {data.get('task_ref')!r} has spent "
            f"{data.get('task_used_units')}/{data.get('task_ceiling')} units, "
            f"{data.get('task_remaining_units')} remaining is not enough for this call."
        )
    if reason == "task_ceiling_required":
        return (
            "Run blocked: this task_ref is unknown. Pass task_ceiling on the first "
            "preflight of a new task."
        )
    if reason == "budget_exhausted":
        return "Run blocked: customer budget is exhausted."
    if reason == "free_tier_exceeded":
        url = data.get("upgrade_url", "https://agentbill.dev/pricing")
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
