from __future__ import annotations

import os
import sys
import uuid
from typing import Optional
import httpx
from mcp.server.fastmcp import FastMCP

mcp = FastMCP(
    "agentbill",
    instructions=(
        "AgentBill is one spend ceiling per agent job, consulted before the call goes out. "
        "Call preflight() before starting any agent work to check if the job and the customer have units left. "
        "Call record_event() after work completes to record what it used against that customer's balance. "
        "Set AGENTBILL_API_KEY in your environment before use."
    ),
)

BASE_URL = os.getenv("AGENTBILL_BASE_URL", "https://agentbill.dev")


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
    the run has budget. Returns approved=False with a reason when preflight refused
    the call (budget_exhausted, ceiling_exceeded, free_tier_exceeded,
    task_ceiling_exceeded). Nothing is stopped by this server; the host decides.

    A unit is an integer you define and pass. AgentBill reserves the number you send
    and never converts those units into money, so the ceiling is only as tight as
    your estimate. The common convention is 1 unit = 1 cent. (Model calls recorded
    through the Python or Node SDK's wrap() are counted in tokens instead.)

    Args:
        agent_id: Identifier for this agent or task type (e.g. "research_agent").
        customer_id: Your internal customer identifier. Defaults to "default".
        estimated_units: How many units you expect this run to consume. This is the
            number reserved against every budget below.
        ceiling: Max units allowed per single call. The call is refused if estimated_units exceeds this.
        task_ref: Groups many calls under one cross-call budget, so one job spanning
            several providers and tools shares a single ceiling. Pass the same
            task_ref on every call in the job.
        task_ceiling: Total units the whole task may spend. Required on the first
            preflight of a new task_ref, or open the job first in the console; not
            applied on later calls.
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
    if not isinstance(data, dict):
        data = {}

    # Approved only on an explicit JSON true. A 200 without "approved" (a proxy
    # page, a truncated body, a future shape) is not a verdict, so it is
    # reported as refused rather than read as permission.
    if data.get("approved") is not True:
        reason = data.get("reason", "unknown")
        refused = {
            "approved": False,
            "reason": reason,
            "remaining_units": data.get("remaining_units"),
            "upgrade_url": data.get("upgrade_url"),
            "message": _refusal_message(reason, data),
        }
        if data.get("task_ref"):
            refused["task_ref"] = data.get("task_ref")
            refused["task_remaining_units"] = data.get("task_remaining_units")
        return refused

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


def _refusal_message(reason: str, data: dict) -> str:
    # The sentence a host shows beside approved=False. Same voice as the SDKs:
    # preflight refused the call; nothing was stopped, and the host decides.
    if reason == "ceiling_exceeded":
        return (
            f"Refused (ceiling_exceeded): estimated {data.get('estimated_units')} units "
            f"exceeds the per-request ceiling of {data.get('ceiling')}."
        )
    if reason == "task_ceiling_exceeded":
        return (
            f"Refused (task_ceiling_exceeded): task {data.get('task_ref')!r} is at "
            f"{data.get('task_used_units')}/{data.get('task_ceiling')} units and "
            f"{data.get('task_remaining_units')} remaining is not enough for this call."
        )
    if reason == "task_ceiling_required":
        return (
            "Refused (task_ceiling_required): this task_ref is unknown. Pass task_ceiling "
            "on the first preflight of a new task, or open the job first in the console."
        )
    if reason == "budget_exhausted":
        return "Refused (budget_exhausted): this customer's balance is spent."
    if reason == "free_tier_exceeded":
        url = data.get("upgrade_url", "https://agentbill.dev/pricing")
        return f"Refused (free_tier_exceeded): this month's free preflight calls are used up. Upgrade at {url}"
    return f"Refused ({reason})."


# HTTP mode (MCP_TRANSPORT=http) listens on loopback only, with DNS-rebinding
# protection on. A browser tab can reach 127.0.0.1, so without the Host and
# Origin checks any web page could drive this server's tools with the API key
# in its environment. Binding elsewhere is an explicit choice made through the
# environment:
#
#   AGENTBILL_MCP_HOST             interface to bind (default 127.0.0.1)
#   AGENTBILL_MCP_PORT             port (default 8080)
#   AGENTBILL_MCP_ALLOWED_HOSTS    extra Host header values to accept,
#                                  comma separated ("mcp.example.com,
#                                  10.0.0.5:*"); loopback is always allowed
#   AGENTBILL_MCP_ALLOWED_ORIGINS  extra Origin values, comma separated
#
# There is no switch that turns the protection off. A server bound to a public
# interface answers only the host names listed in AGENTBILL_MCP_ALLOWED_HOSTS.
DEFAULT_HTTP_HOST = "127.0.0.1"
DEFAULT_HTTP_PORT = 8080
_LOOPBACK_HOSTS = ["127.0.0.1", "127.0.0.1:*", "localhost", "localhost:*", "[::1]", "[::1]:*"]
_LOOPBACK_ORIGINS = ["http://127.0.0.1:*", "http://localhost:*", "http://[::1]:*"]
_LOOPBACK_BINDS = ("127.0.0.1", "localhost", "::1")


def _csv(value: Optional[str]) -> list:
    return [part.strip() for part in (value or "").split(",") if part.strip()]


def configure_http(server: FastMCP, env: Optional[dict] = None) -> FastMCP:
    """Apply the HTTP-mode bind address and transport security to `server`."""
    # Imported here, not at module load: stdio mode never needs it.
    from mcp.server.transport_security import TransportSecuritySettings

    env = os.environ if env is None else env
    host = (env.get("AGENTBILL_MCP_HOST") or "").strip() or DEFAULT_HTTP_HOST
    port_raw = (env.get("AGENTBILL_MCP_PORT") or "").strip()
    port = int(port_raw) if port_raw else DEFAULT_HTTP_PORT
    extra_hosts = _csv(env.get("AGENTBILL_MCP_ALLOWED_HOSTS"))
    extra_origins = _csv(env.get("AGENTBILL_MCP_ALLOWED_ORIGINS"))

    server.settings.host = host
    server.settings.port = port
    server.settings.transport_security = TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=_LOOPBACK_HOSTS + extra_hosts,
        allowed_origins=_LOOPBACK_ORIGINS + extra_origins,
    )
    if host not in _LOOPBACK_BINDS and not extra_hosts:
        print(
            f"agentbill-mcp: bound to {host}:{port}, but AGENTBILL_MCP_ALLOWED_HOSTS is empty, "
            "so only requests with a loopback Host header are answered.",
            file=sys.stderr,
        )
    return server


def main():
    transport = os.getenv("MCP_TRANSPORT", "stdio")
    if transport == "http":
        configure_http(mcp)
        mcp.run(transport="streamable-http")
    else:
        mcp.run()


if __name__ == "__main__":
    main()
