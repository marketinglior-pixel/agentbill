import functools
import requests
from .meter import BudgetExhaustedError, AgentBillError  # one class for both code paths
from dataclasses import dataclass
from typing import Optional

BASE_URL = "https://agentbill.fly.dev"

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


@dataclass
class TaskStatus:
    task_ref: str
    agent_id: str
    ceiling_units: int
    used_units: int
    reserved_units: int
    remaining_units: int
    exceeded: bool

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
    pass


class PreflightInProgressError(Exception):
    """Another preflight with this idempotency_key is still being decided.

    Retry in a moment. This is never a block, and nothing was reserved for
    this call: it means the original request holds the key and its decision
    is one write away.
    """
    def __init__(self, idempotency_key: str):
        self.idempotency_key = idempotency_key
        super().__init__(
            f"A preflight with idempotency_key {idempotency_key!r} is still being decided. Retry in a moment."
        )

class FreeTierExceededError(Exception):
    def __init__(self, upgrade_url: Optional[str] = None):
        self.upgrade_url = upgrade_url
        super().__init__("Free tier limit reached. Upgrade to continue.")

class PlanLimitExceededError(Exception):
    """The account hit its plan's monthly call quota."""
    def __init__(self, plan: Optional[str] = None, upgrade_url: Optional[str] = None):
        self.plan = plan
        self.upgrade_url = upgrade_url
        super().__init__(f"Monthly quota for plan '{plan}' reached. Upgrade to continue.")

class TaskCeilingExceededError(Exception):
    """The cross-call budget for this task is spent — the job dies here.

    Catch this to stop the run cleanly:

        try:
            client.preflight("researcher", estimated_units=2,
                             task_ref="job-42", task_ceiling=50)
        except TaskCeilingExceededError as e:
            log.info(f"task {e.task_ref} hit its ceiling "
                     f"({e.task_used_units}/{e.task_ceiling})")
            return partial_result
    """
    def __init__(self, task_ref: str, task_ceiling: Optional[int],
                 task_used_units: Optional[int], task_remaining_units: Optional[int]):
        self.task_ref = task_ref
        self.task_ceiling = task_ceiling
        self.task_used_units = task_used_units
        self.task_remaining_units = task_remaining_units
        super().__init__(
            f"Task {task_ref!r} blocked: {task_used_units}/{task_ceiling} units used, "
            f"{task_remaining_units} remaining is not enough for this call."
        )

class TaskCeilingRequiredError(Exception):
    """A new task_ref needs task_ceiling on its first preflight."""

class AgentBillClient:
    def __init__(self, api_key: str, ceiling: Optional[int] = None, base_url: str = BASE_URL):
        if not api_key or not api_key.strip():
            raise ValueError(
                "AgentBill API key is missing.\n"
                "Get your free key (1,000 calls/month) at: https://agentbill.fly.dev/register"
            )
        self.api_key = api_key
        self.ceiling = ceiling
        self.base_url = base_url

    def preflight(
        self,
        agent_id: str,
        estimated_units: Optional[int] = None,
        customer_id: Optional[str] = None,
        task_ref: Optional[str] = None,
        task_ceiling: Optional[int] = None,
        idempotency_key: Optional[str] = None,
    ) -> PreflightResult:
        """Check every budget BEFORE the call runs.

        task_ref groups many calls (across providers and tools) under one hard
        cross-call ceiling, "this job dies at 50 units". Pass task_ceiling on
        the first call for a new task_ref; later calls only need task_ref.

        idempotency_key makes a retried preflight safe. Without it a retry
        reserves a second time, so the mechanism meant to prevent waste is the
        one consuming the budget. Same key, same decision, one reservation.
        Raises PreflightInProgressError if the original is still being decided.
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
        if resp.status_code == 409:
            raise PreflightInProgressError(idempotency_key or "")
        resp.raise_for_status()
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
        )

        if not result.approved:
            if result.reason == "ceiling_exceeded":
                raise CeilingExceededError(
                    f"Run blocked: estimated {estimated_units} units exceeds ceiling of {self.ceiling}"
                )
            if result.reason == "budget_exhausted":
                raise BudgetExhaustedError(customer_id or "default", "Run blocked: customer budget exhausted")
            if result.reason == "free_tier_exceeded":
                raise FreeTierExceededError(upgrade_url=data.get("upgrade_url"))
            if result.reason == "plan_limit_exceeded":
                raise PlanLimitExceededError(plan=data.get("plan"), upgrade_url=data.get("upgrade_url"))
            if result.reason == "task_ceiling_exceeded":
                raise TaskCeilingExceededError(
                    task_ref=data.get("task_ref") or task_ref or "",
                    task_ceiling=data.get("task_ceiling"),
                    task_used_units=data.get("task_used_units"),
                    task_remaining_units=data.get("task_remaining_units"),
                )

        return result

    def record(
        self,
        agent_id: str,
        units: int = 1,
        customer_id: Optional[str] = None,
        success: bool = True,
        task_ref: Optional[str] = None,
    ) -> dict:
        payload = {
            "customer_id": customer_id or "default",
            "event_type": agent_id,
            "idempotency_key": f"{agent_id}-{__import__('uuid').uuid4()}",
            "units": units,
            "success": success,
        }
        if task_ref is not None:
            payload["task_ref"] = task_ref
        resp = requests.post(
            f"{self.base_url}/events",
            json=payload,
            headers={"Authorization": f"Bearer {self.api_key}"},
            timeout=5,
        )
        resp.raise_for_status()
        return resp.json()

    def get_task(self, task_ref: str) -> TaskStatus:
        """Live burn-down of one job's budget."""
        resp = requests.get(
            f"{self.base_url}/tasks/{task_ref}",
            headers={"Authorization": f"Bearer {self.api_key}"},
            timeout=5,
        )
        resp.raise_for_status()
        data = resp.json()
        return TaskStatus(
            task_ref=data["task_ref"],
            agent_id=data["agent_id"],
            ceiling_units=data["ceiling_units"],
            used_units=data["used_units"],
            reserved_units=data["reserved_units"],
            remaining_units=data["remaining_units"],
            exceeded=data["exceeded"],
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
        resp.raise_for_status()
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
        resp.raise_for_status()
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
                    raise Exception(f"Agent blocked: {check.reason}")
                reserved = check.estimated_units or 1
                try:
                    result = func(*args, **kwargs)
                    self.record(
                        agent_id=agent_id,
                        units=reserved,
                        customer_id=customer_id,
                        success=True,
                        task_ref=task_ref,
                    )
                    return result
                except Exception:
                    # success=False releases the preflight reservation without
                    # billing — units must equal what preflight reserved, or the
                    # reservation leaks and eats the budget forever.
                    self.record(
                        agent_id=agent_id,
                        units=reserved,
                        customer_id=customer_id,
                        success=False,
                        task_ref=task_ref,
                    )
                    raise
            return wrapper
        return decorator
