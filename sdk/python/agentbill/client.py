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

class CeilingExceededError(Exception):
    pass

class BudgetExhaustedError(Exception):
    pass

class AgentBillClient:
    def __init__(self, api_key: str, ceiling: Optional[int] = None, base_url: str = BASE_URL):
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
        )

        if not result.approved:
            if result.reason == "ceiling_exceeded":
                raise CeilingExceededError(
                    f"Run blocked: estimated {estimated_units} units exceeds ceiling of {self.ceiling}"
                )
            if result.reason == "budget_exhausted":
                raise BudgetExhaustedError("Run blocked: customer budget exhausted")

        return result

    def record(self, agent_id: str, units: int = 1, customer_id: Optional[str] = None) -> dict:
        payload = {
            "customer_id": customer_id or "default",
            "event_type": agent_id,
            "idempotency_key": f"{agent_id}-{__import__('uuid').uuid4()}",
            "units": units,
        }
        resp = requests.post(
            f"{self.base_url}/events",
            json=payload,
            headers={"Authorization": f"Bearer {self.api_key}"},
            timeout=5,
        )
        resp.raise_for_status()
        return resp.json()
