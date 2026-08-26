"""agentbill.meter
~~~~~~~~~~~~~~~

A decorator that records billable agent events.

    from agentbill import meter

    @meter(event="research_run", customer_id_from="customer_id")
    async def run_agent(customer_id: str, topic: str) -> str:
        ...

Environment variables
---------------------
AGENTBILL_API_KEY     Required. Your API key from agentbill.fly.dev/register.
AGENTBILL_BASE_URL    Optional. Defaults to https://agentbill.fly.dev
AGENTBILL_CUSTOMER_ID Optional. Fallback customer_id when not passed per-call.
"""

from __future__ import annotations

import asyncio
import functools
import inspect
import os
import uuid
from typing import Any, Callable, Optional, TypeVar, Union

import httpx

F = TypeVar("F", bound=Callable[..., Any])
UnitsResolver = Union[int, Callable[[Any], int]]

_BASE_URL = os.environ.get("AGENTBILL_BASE_URL", "https://agentbill.fly.dev")


# ---------------------------------------------------------------------------
# Public exceptions — import and handle these in your agent code
# ---------------------------------------------------------------------------

class BudgetExhaustedError(Exception):
    """The customer has 0 remaining units (HTTP 402).

    Catch this to show the user a paywall or pause the agent gracefully.

        try:
            result = await run_agent(customer_id="cust_123", topic="...")
        except BudgetExhaustedError as e:
            print(f"Customer {e.customer_id} is out of budget.")
    """
    def __init__(self, customer_id: str, message: str = "") -> None:
        self.customer_id = customer_id
        super().__init__(message or f"Customer {customer_id!r} has no remaining budget.")


class AgentBillError(Exception):
    """Unexpected AgentBill error (network failure, 5xx response).

    By default the decorator raises this so your agent doesn't bill
    silently on server errors. Override this by wrapping the call.
    """


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _api_key() -> str:
    key = os.environ.get("AGENTBILL_API_KEY", "")
    if not key:
        raise AgentBillError(
            "AGENTBILL_API_KEY is not set. "
            "Get your key at agentbill.fly.dev/register."
        )
    return key


def _resolve_customer_id(
    customer_id: str | None,
    customer_id_from: str | None,
    func: Callable,
    args: tuple,
    kwargs: dict,
) -> str:
    # Priority: explicit kwarg > function param > env var
    if customer_id is not None:
        return customer_id

    if customer_id_from is not None:
        sig = inspect.signature(func)
        bound = sig.bind(*args, **kwargs)
        bound.apply_defaults()
        value = bound.arguments.get(customer_id_from)
        if value is None:
            raise AgentBillError(
                f"customer_id_from={customer_id_from!r} was not found in "
                f"the arguments of {func.__name__}(). "
                f"Available: {list(bound.arguments)}"
            )
        return str(value)

    env_id = os.environ.get("AGENTBILL_CUSTOMER_ID", "")
    if env_id:
        return env_id

    raise AgentBillError(
        "No customer_id resolved. Use one of:\n"
        "  @meter(event=..., customer_id='fixed_id')\n"
        "  @meter(event=..., customer_id_from='param_name')\n"
        "  export AGENTBILL_CUSTOMER_ID=..."
    )


def _build_payload(customer_id: str, event: str, units: int, metadata: dict | None, task_ref: str | None = None) -> dict:
    payload: dict = {
        "customer_id": customer_id,
        "event_type": event,
        "units": units,
        # Auto-generated — unique per invocation, safe for retries
        "idempotency_key": f"{event}_{uuid.uuid4().hex}",
    }
    if metadata:
        payload["metadata"] = metadata
    if task_ref:
        payload["task_ref"] = task_ref
    return payload


def _handle_response(resp: httpx.Response, customer_id: str) -> None:
    if resp.status_code == 200:
        return
    if resp.status_code == 402:
        data = resp.json()
        raise BudgetExhaustedError(customer_id, data.get("message", ""))
    raise AgentBillError(
        f"AgentBill returned unexpected status {resp.status_code}: {resp.text[:200]}"
    )


def _resolve_units(units: UnitsResolver, result: Any) -> int:
    if callable(units):
        resolved = units(result)
        if not isinstance(resolved, int) or resolved < 0:
            raise AgentBillError(
                f"units callable must return a non-negative int, got {resolved!r}"
            )
        return resolved
    return units


def _preflight_sync(customer_id: str) -> None:
    """Raise BudgetExhaustedError before the agent runs if the customer is blocked."""
    with httpx.Client() as client:
        resp = client.get(
            f"{_BASE_URL}/budget",
            params={"customer_id": customer_id},
            headers={"Authorization": f"Bearer {_api_key()}"},
            timeout=5.0,
        )
    if resp.status_code != 200:
        raise AgentBillError(f"AgentBill /budget returned {resp.status_code}: {resp.text[:200]}")
    data = resp.json()
    if data.get("is_blocked"):
        raise BudgetExhaustedError(customer_id)


async def _preflight_async(customer_id: str) -> None:
    """Async version of _preflight_sync."""
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{_BASE_URL}/budget",
            params={"customer_id": customer_id},
            headers={"Authorization": f"Bearer {_api_key()}"},
            timeout=5.0,
        )
    if resp.status_code != 200:
        raise AgentBillError(f"AgentBill /budget returned {resp.status_code}: {resp.text[:200]}")
    data = resp.json()
    if data.get("is_blocked"):
        raise BudgetExhaustedError(customer_id)


def _submit_sync(customer_id: str, event: str, units: int, metadata: dict | None, task_ref: str | None = None) -> None:
    with httpx.Client() as client:
        resp = client.post(
            f"{_BASE_URL}/events",
            json=_build_payload(customer_id, event, units, metadata, task_ref),
            headers={"Authorization": f"Bearer {_api_key()}"},
            timeout=5.0,
        )
    _handle_response(resp, customer_id)


async def _submit_async(customer_id: str, event: str, units: int, metadata: dict | None, task_ref: str | None = None) -> None:
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{_BASE_URL}/events",
            json=_build_payload(customer_id, event, units, metadata, task_ref),
            headers={"Authorization": f"Bearer {_api_key()}"},
            timeout=5.0,
        )
    _handle_response(resp, customer_id)


# ---------------------------------------------------------------------------
# Public decorator
# ---------------------------------------------------------------------------

def meter(
    event: str,
    *,
    units: UnitsResolver = 1,
    customer_id: str | None = None,
    customer_id_from: str | None = None,
    metadata: dict | None = None,
    preflight: bool = False,
    task_ref: str | None = None,
) -> Callable[[F], F]:
    """Decorator that records a billable event after the wrapped function returns.

    The event is submitted AFTER the function succeeds. If the function raises,
    no event is recorded and your customer is not billed.

    Args:
        event:            Event type label (snake_case). Shown in dashboard and Stripe.
        units:            Billable units per call. Default 1.
        customer_id:      Fixed customer identifier.
        customer_id_from: Name of a function parameter to read customer_id from.
        metadata:         Static key-value pairs attached to every event (not billed).
        preflight:        If True, check budget BEFORE running the function. Raises
                          BudgetExhaustedError immediately if the customer is blocked,
                          preventing any expensive LLM calls from being made.
        task_ref:         Attribute this event to a cross-call task budget created
                          via AgentBillClient.preflight(task_ref=..., task_ceiling=...).

    Raises:
        BudgetExhaustedError: Customer has 0 remaining units (HTTP 402).
        AgentBillError:       Network error or unexpected server response.

    Examples::

        # Async agent — reads customer_id from function param
        @meter(event="research_run", customer_id_from="customer_id")
        async def run_agent(customer_id: str, topic: str) -> str:
            ...

        # Sync function — fixed customer
        @meter(event="report_generated", customer_id="internal_ops", units=1)
        def generate_report(date: str) -> bytes:
            ...

        # Batch: bill by volume (e.g. pages processed)
        @meter(event="pages_processed", customer_id_from="customer_id", units=10)
        async def process_document(customer_id: str, path: str) -> list:
            ...
    """
    def decorator(func: F) -> F:
        if asyncio.iscoroutinefunction(func):
            @functools.wraps(func)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                cid = _resolve_customer_id(customer_id, customer_id_from, func, args, kwargs)
                if preflight:
                    await _preflight_async(cid)
                result = await func(*args, **kwargs)
                actual_units = _resolve_units(units, result)
                if actual_units > 0:
                    await _submit_async(cid, event, actual_units, metadata, task_ref)
                return result
            return async_wrapper  # type: ignore[return-value]
        else:
            @functools.wraps(func)
            def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
                cid = _resolve_customer_id(customer_id, customer_id_from, func, args, kwargs)
                if preflight:
                    _preflight_sync(cid)
                result = func(*args, **kwargs)
                actual_units = _resolve_units(units, result)
                if actual_units > 0:
                    _submit_sync(cid, event, actual_units, metadata, task_ref)
                return result
            return sync_wrapper  # type: ignore[return-value]

    return decorator  # type: ignore[return-value]
