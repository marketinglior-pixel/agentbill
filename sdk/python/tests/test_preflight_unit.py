import importlib

import pytest
import respx
from httpx import Response

from agentbill.meter import BudgetExhaustedError, meter

meter_module = importlib.import_module("agentbill.meter")


def test_preflight_blocks_before_running_when_budget_is_exhausted(monkeypatch):
    monkeypatch.setenv("AGENTBILL_API_KEY", "test-key")
    monkeypatch.setattr(meter_module, "_BASE_URL", "https://agentbill.test")
    calls = 0

    @meter(event="research_run", customer_id="cust_blocked", preflight=True)
    def run_agent():
        nonlocal calls
        calls += 1
        return "should not run"

    with respx.mock(base_url="https://agentbill.test") as router:
        router.get("/budget").mock(return_value=Response(200, json={"is_blocked": True}))

        with pytest.raises(BudgetExhaustedError) as exc_info:
            run_agent()

    assert exc_info.value.customer_id == "cust_blocked"
    assert calls == 0


def test_preflight_allows_and_records_when_budget_is_available(monkeypatch):
    monkeypatch.setenv("AGENTBILL_API_KEY", "test-key")
    monkeypatch.setattr(meter_module, "_BASE_URL", "https://agentbill.test")
    calls = 0

    @meter(event="research_run", customer_id="cust_active", units=3, preflight=True)
    def run_agent():
        nonlocal calls
        calls += 1
        return "ok"

    with respx.mock(base_url="https://agentbill.test") as router:
        budget_route = router.get("/budget").mock(
            return_value=Response(200, json={"is_blocked": False})
        )
        events_route = router.post("/events").mock(return_value=Response(200, json={"ok": True}))

        assert run_agent() == "ok"

    assert calls == 1
    assert budget_route.called
    assert events_route.called
