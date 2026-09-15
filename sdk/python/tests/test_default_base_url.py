"""The default host is agentbill.dev, and it is the host a call actually reaches.

Until 0.6.5 both SDK paths defaulted to agentbill.fly.dev while every page,
README and error message said agentbill.dev. Nothing failed, because the two
hostnames serve the same application, so the drift survived four releases and
was found by reading the source during a dogfood run rather than by a gate.
That is what these tests exist to stop: the constant is not the claim, the URL
the request is sent to is the claim.

Both paths stub the transport at the module the SDK calls, so no test opens a
socket.
"""
import importlib
import importlib.util
import json
import uuid

import pytest
import respx
from httpx import Response

import agentbill.client as client_module
from agentbill import AgentBillClient

meter_module = importlib.import_module("agentbill.meter")

DEFAULT_HOST = "https://agentbill.dev"
RETIRED_HOST = "https://agentbill.fly.dev"

# Shaped like a real key and never issued. Built, not typed, so a secret
# scanner does not read a test fixture as a credential.
FAKE_KEY = "agb_" + uuid.uuid4().hex

APPROVED = {
    "approved": True,
    "reason": None,
    "estimated_units": 1,
    "remaining_units": 9,
    "task_ref": "job-1",
    "task_remaining_units": 9,
}


class _Resp:
    def __init__(self, status_code, body):
        self.status_code = status_code
        self._body = body
        self.text = json.dumps(body)

    def json(self):
        return self._body

    def raise_for_status(self):
        return None


def _capture_urls(monkeypatch, body=APPROVED):
    """Record every URL the client sends to, and answer each one the same."""
    urls = []

    def fake(url, *a, **k):
        urls.append(url)
        return _Resp(200, body)

    monkeypatch.setattr(client_module.requests, "post", fake)
    monkeypatch.setattr(client_module.requests, "get", fake)
    return urls


def test_client_preflight_is_sent_to_agentbill_dev(monkeypatch):
    urls = _capture_urls(monkeypatch)

    AgentBillClient(api_key=FAKE_KEY).preflight(agent_id="researcher", task_ref="job-1")

    assert urls == [f"{DEFAULT_HOST}/preflight"]
    assert RETIRED_HOST not in urls[0]


def test_client_record_is_sent_to_agentbill_dev(monkeypatch):
    urls = _capture_urls(monkeypatch, body={"ok": True})

    AgentBillClient(api_key=FAKE_KEY).record(agent_id="researcher", task_ref="job-1", units=1)

    assert urls == [f"{DEFAULT_HOST}/events"]


def test_an_explicit_base_url_still_wins(monkeypatch):
    """The default is a default. Self-hosted callers keep their override."""
    urls = _capture_urls(monkeypatch)

    AgentBillClient(api_key=FAKE_KEY, base_url="https://agentbill.test").preflight(
        agent_id="researcher", task_ref="job-1"
    )

    assert urls == ["https://agentbill.test/preflight"]


@pytest.fixture
def meter_probe(monkeypatch):
    """A second, independent copy of the decorator module, imported with no
    AGENTBILL_BASE_URL set.

    _BASE_URL is read once at import, so the fallback can only be observed by
    importing with the variable absent. importlib.reload() would do that, but it
    rebinds the real module's classes in place and the other test modules hold
    the originals, so a reloaded BudgetExhaustedError stops matching the one
    they imported. Loading a separate module object leaves sys.modules alone.
    """
    monkeypatch.delenv("AGENTBILL_BASE_URL", raising=False)
    spec = importlib.util.spec_from_file_location("_meter_probe", meter_module.__file__)
    probe = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(probe)
    return probe


def test_meter_decorator_calls_agentbill_dev_by_default(meter_probe, monkeypatch):
    assert meter_probe._BASE_URL == DEFAULT_HOST

    monkeypatch.setenv("AGENTBILL_API_KEY", "test-key")

    @meter_probe.meter(event="research_run", customer_id="cust_1", units=2)
    def run_agent():
        return "done"

    # respx answers only this host: a call to any other one raises instead of
    # passing, so what is asserted is the destination and not just the constant.
    with respx.mock(base_url=DEFAULT_HOST) as router:
        route = router.post("/events").mock(return_value=Response(200, json={"ok": True}))
        assert run_agent() == "done"

    assert route.called
    assert str(route.calls[0].request.url) == f"{DEFAULT_HOST}/events"
