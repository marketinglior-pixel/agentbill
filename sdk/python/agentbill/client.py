import functools
import requests
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

class BudgetExhaustedError(Exception):
    pass

class FreeTierExceededError(Exception):
    def __init__(self, upgrade_url: Optional[str] = None):
        self.upgrade_url = upgrade_url
        super().__init__("Free tier limit reached. Upgrade to continue.")

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

    def preflight(self, agent_id: str, estimated_units: Optional[int] = None, customer_id: Optional[str] = None) -> PreflightResult:
        payload = {"agent_id": agent_id}
        if estimated_units is not None:
            payload["estimated_units"] = estimated_units
        if self.ceiling is not None:
            payload["ceiling"] = self.ceiling
        if customer_id is not None:
            payload["customer_id"] = customer_id

        resp = requests.post(
            f"{self.base_url}/preflight",
            json=payload,
            headers={"Authorization": f"Bearer {self.api_key}"},
            timeout=5,
        )
        resp.raise_for_status()
        data = resp.json()

        result = PreflightResult(
            approved=data["approved"],
            reason=data.get("reason"),
            estimated_units=data.get("estimated_units"),
            remaining_units=data.get("remaining_units"),
            upgrade_url=data.get("upgrade_url"),
        )

        if not result.approved:
            if result.reason == "ceiling_exceeded":
                raise CeilingExceededError(
                    f"Run blocked: estimated {estimated_units} units exceeds ceiling of {self.ceiling}"
                )
            if result.reason == "budget_exhausted":
                raise BudgetExhaustedError("Run blocked: customer budget exhausted")
            if result.reason == "free_tier_exceeded":
                raise FreeTierExceededError(upgrade_url=data.get("upgrade_url"))

        return result

    def record(self, agent_id: str, units: int = 1, customer_id: Optional[str] = None, success: bool = True) -> dict:
        payload = {
            "customer_id": customer_id or "default",
            "event_type": agent_id,
            "idempotency_key": f"{agent_id}-{__import__('uuid').uuid4()}",
            "units": units,
            "success": success,
        }
        resp = requests.post(
            f"{self.base_url}/events",
            json=payload,
            headers={"Authorization": f"Bearer {self.api_key}"},
            timeout=5,
        )
        resp.raise_for_status()
        return resp.json()

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
    ):
        def decorator(func):
            @functools.wraps(func)
            def wrapper(*args, **kwargs):
                check = self.preflight(
                    agent_id=agent_id,
                    estimated_units=estimated_units,
                    customer_id=customer_id,
                )
                if not check.approved:
                    raise Exception(f"Agent blocked: {check.reason}")
                try:
                    result = func(*args, **kwargs)
                    self.record(
                        agent_id=agent_id,
                        units=check.estimated_units or 1,
                        customer_id=customer_id,
                        success=True,
                    )
                    return result
                except Exception:
                    self.record(
                        agent_id=agent_id,
                        units=0,
                        customer_id=customer_id,
                        success=False,
                    )
                    raise
            return wrapper
        return decorator
