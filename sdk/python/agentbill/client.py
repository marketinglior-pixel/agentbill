import functools
import weakref
import requests
from .meter import BudgetExhaustedError, AgentBillError, AuthenticationError, _raise_if_unauthorized, _checked_base_url
from dataclasses import dataclass
from typing import Optional

BASE_URL = "https://agentbill.dev"

# What result.record() needs from the preflight that made a PreflightResult:
# the client and the agent, customer and task it was made with. Kept here,
# keyed by id(result), and NOT on the result. On the instance it lived in
# __dict__, so the client and its api_key travelled with the result:
# pickle.dumps(result) carried the key (multiprocessing return values,
# pickle-based caches), copy.deepcopy kept it, and json.dumps(vars(result)),
# a common way to log a result, raised on the client object. The entry is
# removed when the result is garbage collected, so an id is never reused while
# its entry is still here. A copy or an unpickled result has no entry: record
# on it with client.record(..., reservation_id=result.reservation_id).
_BINDINGS: dict = {}


def _bind(result: "PreflightResult", call: tuple) -> None:
    key = id(result)
    _BINDINGS[key] = call
    weakref.finalize(result, _BINDINGS.pop, key, None)


def _answer_of(result: "PreflightResult") -> Optional[dict]:
    """The preflight answer as the server sent it, for a result preflight()
    returned in this process; None for a copy. Kept in the same table as the
    call, and for the same reason: not on the result. wrap() reads it to build
    a Refusal that carries the raw answer."""
    bound = _BINDINGS.get(id(result))
    return bound[4] if bound is not None and len(bound) > 4 else None

@dataclass
class PreflightResult:
    approved: bool
    reason: Optional[str]
    estimated_units: Optional[int]
    remaining_units: Optional[int]
    upgrade_url: Optional[str] = None
    task_ref: Optional[str] = None
    task_remaining_units: Optional[int] = None
    # Settle before this or the sweeper reclaims the reservation and the units
    # stop being held. ISO 8601, or None when nothing was reserved.
    reservation_expires_at: Optional[str] = None
    # The handle of the reservation this preflight made. Hand it back to
    # record() (result.record(...) does it for you) and the record settles
    # THIS reservation whole: the actual moves the job's used units and the
    # unused rest is released at once, instead of being held until the
    # reservation expires. None when nothing was reserved, or when the server
    # predates reservation_id; record() then settles the way it always has.
    reservation_id: Optional[str] = None

    def record(
        self,
        units: int = 1,
        success: bool = True,
        idempotency_key: Optional[str] = None,
        metadata: Optional[dict] = None,
        usage_missing: bool = False,
    ) -> dict:
        """Record what this call actually used, against this preflight's own reservation.

        Carries the agent_id, customer_id, task_ref and reservation_id this
        preflight was made with, so the record settles exactly the reservation
        it opened: `units` is what the job spent, and whatever the reservation
        held beyond that is released now. See AgentBillClient.record for the
        other arguments.
        """
        bound = _BINDINGS.get(id(self))
        if bound is None:
            raise AgentBillError(
                "This PreflightResult was not returned by AgentBillClient.preflight() in this process "
                "(a copy or an unpickled result carries no client), so it has no call to record "
                "against. Use client.record(..., reservation_id=result.reservation_id)."
            )
        client, agent_id, customer_id, task_ref = bound[:4]
        return client.record(
            agent_id,
            units=units,
            customer_id=customer_id,
            success=success,
            task_ref=task_ref,
            idempotency_key=idempotency_key,
            reservation_id=self.reservation_id,
            metadata=metadata,
            usage_missing=usage_missing,
        )


@dataclass
class TaskStatus:
    task_ref: str
    agent_id: str
    ceiling_units: int
    used_units: int
    reserved_units: int
    remaining_units: int
    exceeded: bool
    # What the numbers count: "unit" (yours) or "token". Fixed when the job opens.
    unit: str = "unit"
    # Calls recorded with usage_missing=True, charged at least the reservation
    # they settled (at the units sent when none was open).
    usage_missing_calls: int = 0
    # The job's recorded calls by model and by step, with tokens and an
    # estimate at public list price (list price, your invoice may differ), as
    # GET /tasks/<task_ref> returns it. None from a server that predates it.
    breakdown: Optional[dict] = None

@dataclass
class StepResult:
    recorded: bool
    anomaly: bool
    baseline_units: Optional[int]
    deviation_pct: Optional[int]

@dataclass
class CheckpointResult:
    approved: bool
    reason: Optional[str]
    units_so_far: int
    remaining_units: Optional[int]

class CeilingExceededError(Exception):
    """This one call's estimate exceeds the per-call ceiling set on the client.
    Raised by preflight(). A client made with wrap() returns it as a Refusal
    with reason "ceiling_exceeded" instead."""
    def __init__(self, message: str = "", answer: Optional[dict] = None):
        # The preflight answer as the server sent it, when preflight() raised this.
        self.answer = answer
        super().__init__(message)


class PreflightInProgressError(Exception):
    """Another preflight with this idempotency_key is still being decided.

    Retry in a moment. This is never a refusal, and nothing was reserved for
    this call: it means the original request holds the key and its decision
    is one write away.
    """
    def __init__(self, idempotency_key: str):
        self.idempotency_key = idempotency_key
        super().__init__(
            f"A preflight with idempotency_key {idempotency_key!r} is still being decided. Retry in a moment."
        )

class FreeTierExceededError(Exception):
    """Not raised by preflight() as of 0.6.0, which returns
    `approved=False, reason="free_tier_exceeded"` with `.upgrade_url` set:
    check `result.approved` there. Running out of AgentBill's free tier is our
    billing state, not your spend rule, and preflight() must not be able to
    crash your agent over it.

    A client made with wrap() does not raise it either: a measured call returns
    a Refusal with reason "free_tier_exceeded" and upgrade_url, and the model
    call is not sent (on_quota="refuse", the default), because once the quota
    is spent no ceiling can be checked. wrap(..., on_quota="send") sends the
    call unchecked instead.
    """
    def __init__(self, upgrade_url: Optional[str] = None, message: Optional[str] = None):
        self.upgrade_url = upgrade_url
        super().__init__(message or "Free tier limit reached. Upgrade to continue.")

class PlanLimitExceededError(Exception):
    """Not raised by preflight() as of 0.6.0, which returns
    `approved=False, reason="plan_limit_exceeded"` with `.upgrade_url` set.
    A client made with wrap() returns a Refusal, as for FreeTierExceededError.
    """
    def __init__(self, plan: Optional[str] = None, upgrade_url: Optional[str] = None,
                 message: Optional[str] = None):
        self.plan = plan
        self.upgrade_url = upgrade_url
        super().__init__(message or f"Monthly quota for plan '{plan}' reached. Upgrade to continue.")

class TaskCeilingExceededError(Exception):
    """The cross-call ceiling for this task is spent: preflight refused this
    call before it ran. Nothing of yours was stopped; your code decides what
    the job does next. Catch it to end the job cleanly:

        try:
            client.preflight("researcher", estimated_units=2,
                             task_ref="job-42", task_ceiling=50)
        except TaskCeilingExceededError as e:
            log.info(f"task {e.task_ref} hit its ceiling "
                     f"({e.task_used_units}/{e.task_ceiling})")
            return partial_result

    A client made with wrap() does not raise it: the measured call returns a
    Refusal with reason "task_ceiling_exceeded" instead (see agentbill.wrap).
    """
    def __init__(self, task_ref: str, task_ceiling: Optional[int],
                 task_used_units: Optional[int], task_remaining_units: Optional[int],
                 answer: Optional[dict] = None):
        self.task_ref = task_ref
        self.task_ceiling = task_ceiling
        self.task_used_units = task_used_units
        self.task_remaining_units = task_remaining_units
        # The preflight answer as the server sent it, when preflight() raised this.
        self.answer = answer
        super().__init__(
            f"Refused (task_ceiling_exceeded): task {task_ref!r} is at "
            f"{task_used_units}/{task_ceiling} units and {task_remaining_units} remaining "
            f"is not enough for this call."
        )

class TaskCeilingRequiredError(Exception):
    """A task_ref that has not been opened yet needs task_ceiling on its first
    preflight (or open it first from the console / PUT /tasks/:task_ref/ceiling)."""


def _raise_for_status(resp: requests.Response) -> None:
    """resp.raise_for_status(), except that a 401 keeps the server's message.

    requests' own HTTPError says "401 Client Error: Unauthorized for url: ..."
    and drops the body, which is where {"error": "unauthorized", "message":
    "Invalid API key."} was. A wrong key is the common first-run failure, and
    it was the one failure in this file with no sentence of its own.
    """
    _raise_if_unauthorized(resp.status_code, resp.text)
    resp.raise_for_status()


class AgentBillClient:
    def __init__(self, api_key: str, ceiling: Optional[int] = None, base_url: str = BASE_URL):
        if not api_key or not api_key.strip():
            raise ValueError(
                "AgentBill API key is missing.\n"
                "Get your free key (1,000 calls/month) at: https://agentbill.dev/register"
            )
        # A key with a non-ASCII character in it cannot be an AgentBill key and
        # cannot be sent: the Authorization header is latin-1, and the failure
        # surfaced twelve frames deep in http.client as a UnicodeEncodeError
        # (2026-09-09, a placeholder pasted through). Say so here instead.
        if not api_key.isascii():
            raise ValueError(
                "AgentBill API key contains a non-ASCII character, so it cannot be sent as an "
                "Authorization header. Keys are ASCII and start with agb_. Check what was pasted, "
                "quotes and placeholders included."
            )
        self.api_key = api_key
        self.ceiling = ceiling
        # Checked here (and on every later assignment), so a client that would
        # send its key over plain http to another host is never made.
        self.base_url = base_url

    @property
    def base_url(self) -> str:
        return self._base_url

    @base_url.setter
    def base_url(self, value: str) -> None:
        self._base_url = _checked_base_url(value, name="base_url")

    def preflight(
        self,
        agent_id: str,
        estimated_units: Optional[int] = None,
        customer_id: Optional[str] = None,
        task_ref: Optional[str] = None,
        task_ceiling: Optional[int] = None,
        idempotency_key: Optional[str] = None,
        unit: Optional[str] = None,
    ) -> PreflightResult:
        """Check every budget BEFORE the call runs.

        task_ref groups many calls (across providers and tools) under one hard
        cross-call ceiling: "this job gets 50 units, across every call". Give the job its
        ceiling first, in the console or with PUT /tasks/:task_ref/ceiling; every call then
        passes task_ref and nothing about the budget. Passing task_ceiling on the first call of
        a new task_ref opens the job from code instead, the alternate; on later calls it is not
        applied.

        idempotency_key makes a retried preflight safe. Without it a retry
        reserves a second time, so the mechanism meant to prevent waste is the
        one consuming the budget. Same key, same decision, one reservation.
        Raises PreflightInProgressError if the original is still being decided.

        unit says what the job's numbers count, "unit" (yours, the default) or
        "token". It needs task_ref. It is read when this call opens the job and
        checked on a job that exists: a different unit is a 422, raised here as
        an HTTPError, never a relabel.

        The result carries reservation_id. Settle with result.record(units=...)
        and the reservation this call made is closed whole.
        """
        payload = {"agent_id": agent_id}
        if estimated_units is not None:
            payload["estimated_units"] = estimated_units
        if self.ceiling is not None:
            payload["ceiling"] = self.ceiling
        if customer_id is not None:
            payload["customer_id"] = customer_id
        if task_ref is not None:
            payload["task_ref"] = task_ref
        if task_ceiling is not None:
            payload["task_ceiling"] = task_ceiling
        if idempotency_key is not None:
            payload["idempotency_key"] = idempotency_key
        if unit is not None:
            payload["unit"] = unit

        resp = requests.post(
            f"{self.base_url}/preflight",
            json=payload,
            headers={"Authorization": f"Bearer {self.api_key}"},
            timeout=5,
        )
        if resp.status_code == 422:
            data = resp.json()
            if data.get("error") == "task_ceiling_required":
                raise TaskCeilingRequiredError(data.get("message", "task_ceiling required for a new task_ref"))
            if data.get("error") == "task_unit_mismatch":
                # Still an HTTPError, as documented, but carrying the server's
                # sentence: which unit the job is counted in and what to send.
                raise requests.HTTPError(f"422 task_unit_mismatch: {data.get('message', '')}", response=resp)
        if resp.status_code == 409:
            raise PreflightInProgressError(idempotency_key or "")
        _raise_for_status(resp)
        data = resp.json()

        result = PreflightResult(
            approved=data["approved"],
            reason=data.get("reason"),
            estimated_units=data.get("estimated_units"),
            remaining_units=data.get("remaining_units"),
            upgrade_url=data.get("upgrade_url"),
            task_ref=data.get("task_ref"),
            task_remaining_units=data.get("task_remaining_units"),
            reservation_expires_at=data.get("reservation_expires_at"),
            reservation_id=data.get("reservation_id"),
        )
        # Not a dataclass field and not an attribute, on purpose: asdict(),
        # repr(), vars(), pickle and deepcopy of the result stay what they
        # were, and the client (which holds the API key) ends up in none of
        # them. See _BINDINGS.
        _bind(result, (self, agent_id, customer_id, task_ref, data))

        # One rule, and it is the same in both SDKs as of 0.6.0 / 0.4.0:
        # raise when YOUR spend rule refused the call, return a result when
        # AGENTBILL'S OWN BILLING did.
        #
        # free_tier_exceeded and plan_limit_exceeded mean our quota ran out,
        # not that your budget did. Raising on those would let an AgentBill
        # billing state crash your production agent, which would make us a
        # single point of failure in your critical path, the opposite of what
        # "no proxy in your request path" is supposed to mean. They come back
        # as approved=False with .upgrade_url set, so you can degrade, alert,
        # or route a human to upgrade, and keep running.
        #
        # Each raised error carries the answer as the server sent it (.answer),
        # which is how wrap() turns the same refusal into a returned Refusal.
        if not result.approved:
            if result.reason == "ceiling_exceeded":
                raise CeilingExceededError(
                    f"Refused (ceiling_exceeded): estimated {estimated_units} units exceeds "
                    f"the per-request ceiling of {self.ceiling}.", answer=data,
                )
            if result.reason == "budget_exhausted":
                raise BudgetExhaustedError(customer_id or "default", "Refused (budget_exhausted): this customer's balance is spent.",
                                           answer=data)
            if result.reason == "task_ceiling_exceeded":
                raise TaskCeilingExceededError(
                    task_ref=data.get("task_ref") or task_ref or "",
                    task_ceiling=data.get("task_ceiling"),
                    task_used_units=data.get("task_used_units"),
                    task_remaining_units=data.get("task_remaining_units"),
                    answer=data,
                )

        return result

    def record(
        self,
        agent_id: str,
        units: int = 1,
        customer_id: Optional[str] = None,
        success: bool = True,
        task_ref: Optional[str] = None,
        idempotency_key: Optional[str] = None,
        reservation_id: Optional[str] = None,
        metadata: Optional[dict] = None,
        usage_missing: bool = False,
    ) -> dict:
        """Record what a call actually used, or release its reservation.

        units may be 0: a call that ran and cost nothing records 0.

        idempotency_key makes a retried record safe: same key, one event. When
        it is None a fresh random key is sent, which is what every version
        before this one always did.

        reservation_id (from PreflightResult.reservation_id) settles that
        reservation whole: units is what was spent, and the unused rest of the
        reservation is released now instead of being held until it expires.
        Without it the record closes the oldest reservations of this customer
        and task_ref by `units` only, as before.

        usage_missing=True says the provider reported no usage for this call.
        It is not read as 0: the server charges at least the reservation the
        record settles (the one reservation_id names or, without it, the
        oldest open one of this customer and task_ref; with none open, units
        as sent) and counts the call on the job as usage_missing_calls.

        metadata is stored on the event and never counted.
        """
        payload = {
            "customer_id": customer_id or "default",
            "event_type": agent_id,
            "idempotency_key": idempotency_key if idempotency_key is not None else f"{agent_id}-{__import__('uuid').uuid4()}",
            "units": units,
            "success": success,
        }
        if task_ref is not None:
            payload["task_ref"] = task_ref
        if reservation_id is not None:
            payload["reservation_id"] = reservation_id
        if metadata is not None:
            payload["metadata"] = metadata
        if usage_missing:
            payload["usage_missing"] = True
        resp = requests.post(
            f"{self.base_url}/events",
            json=payload,
            headers={"Authorization": f"Bearer {self.api_key}"},
            timeout=5,
        )
        _raise_for_status(resp)
        return resp.json()

    def get_task(self, task_ref: str) -> TaskStatus:
        """Live burn-down of one job's budget."""
        resp = requests.get(
            f"{self.base_url}/tasks/{task_ref}",
            headers={"Authorization": f"Bearer {self.api_key}"},
            timeout=5,
        )
        _raise_for_status(resp)
        data = resp.json()
        return TaskStatus(
            task_ref=data["task_ref"],
            agent_id=data["agent_id"],
            ceiling_units=data["ceiling_units"],
            used_units=data["used_units"],
            reserved_units=data["reserved_units"],
            remaining_units=data["remaining_units"],
            exceeded=data["exceeded"],
            unit=data.get("unit", "unit"),
            usage_missing_calls=data.get("usage_missing_calls", 0),
            breakdown=data.get("breakdown"),
        )

    def checkpoint(
        self,
        agent_id: str,
        units_so_far: int,
        ceiling: Optional[int] = None,
        customer_id: Optional[str] = None,
    ) -> CheckpointResult:
        payload: dict = {"agent_id": agent_id, "units_so_far": units_so_far}
        if ceiling is not None:
            payload["ceiling"] = ceiling
        if customer_id is not None:
            payload["customer_id"] = customer_id

        resp = requests.post(
            f"{self.base_url}/checkpoint",
            json=payload,
            headers={"Authorization": f"Bearer {self.api_key}"},
            timeout=5,
        )
        _raise_for_status(resp)
        data = resp.json()

        return CheckpointResult(
            approved=data["approved"],
            reason=data.get("reason"),
            units_so_far=data["units_so_far"],
            remaining_units=data.get("remaining_units"),
        )

    def record_step(
        self,
        agent_id: str,
        step_name: str,
        units: int,
        customer_id: Optional[str] = None,
    ) -> StepResult:
        payload: dict = {"agent_id": agent_id, "step_name": step_name, "units": units}
        if customer_id is not None:
            payload["customer_id"] = customer_id

        resp = requests.post(
            f"{self.base_url}/step",
            json=payload,
            headers={"Authorization": f"Bearer {self.api_key}"},
            timeout=5,
        )
        _raise_for_status(resp)
        data = resp.json()

        return StepResult(
            recorded=data["recorded"],
            anomaly=data["anomaly"],
            baseline_units=data.get("baseline_units"),
            deviation_pct=data.get("deviation_pct"),
        )

    def gate(
        self,
        agent_id: str,
        estimated_units: Optional[int] = None,
        customer_id: Optional[str] = None,
        task_ref: Optional[str] = None,
        task_ceiling: Optional[int] = None,
    ):
        def decorator(func):
            @functools.wraps(func)
            def wrapper(*args, **kwargs):
                check = self.preflight(
                    agent_id=agent_id,
                    estimated_units=estimated_units,
                    customer_id=customer_id,
                    task_ref=task_ref,
                    task_ceiling=task_ceiling,
                )
                if not check.approved:
                    raise Exception(f"Refused ({check.reason}): preflight did not approve this call.")
                reserved = check.estimated_units or 1
                try:
                    result = func(*args, **kwargs)
                    self.record(
                        agent_id=agent_id,
                        units=reserved,
                        customer_id=customer_id,
                        success=True,
                        task_ref=task_ref,
                        reservation_id=check.reservation_id,
                    )
                    return result
                except Exception:
                    # success=False releases the preflight reservation without
                    # billing. With reservation_id the server releases that
                    # reservation whole; against a server that predates it,
                    # units must equal what preflight reserved, or the
                    # remainder stays held until the reservation expires.
                    self.record(
                        agent_id=agent_id,
                        units=reserved,
                        customer_id=customer_id,
                        success=False,
                        task_ref=task_ref,
                        reservation_id=check.reservation_id,
                    )
                    raise
            return wrapper
        return decorator
