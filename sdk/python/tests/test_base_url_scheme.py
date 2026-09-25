"""Where the SDK is willing to send the API key.

Every request carries the key, so the base URL has to be https, or plain http
to this machine (localhost, 127.0.0.1, [::1], any port). Anything else is
refused with AgentBillError before a request is sent: at construction for
AgentBillClient (and so for wrap(), which builds one), at call time for the
@meter decorator, and never at import.

The transport is stubbed at the module the SDK calls, so no test opens a socket.
"""
import importlib
import importlib.util
import json
import uuid
from types import SimpleNamespace as NS

import pytest
import respx
from httpx import Response

import agentbill
import agentbill.client as client_module
from agentbill import AgentBillClient, AgentBillError

meter_module = importlib.import_module("agentbill.meter")

FAKE_KEY = "agb_" + uuid.uuid4().hex
APPROVED = {"approved": True, "reason": None, "estimated_units": 1, "remaining_units": 9,
            "task_ref": "job-1", "task_remaining_units": 9}

ACCEPTED = ["https://agentbill.test", "http://localhost:3999", "http://127.0.0.1:3999", "http://[::1]:3999"]
REFUSED = ["http://example.com", "http://localhost.example.com", "http://user:pw@example.com",
           "ftp://agentbill.test", "not a url", "https://"]


class _Resp:
    def __init__(self, body):
        self.status_code = 200
        self._body = body
        self.text = json.dumps(body)

    def json(self):
        return self._body

    def raise_for_status(self):
        return None


@pytest.fixture
def sent(monkeypatch):
    urls = []

    def fake(url, *a, **k):
        urls.append(url)
        return _Resp(APPROVED)

    monkeypatch.setattr(client_module.requests, "post", fake)
    monkeypatch.setattr(client_module.requests, "get", fake)
    return urls


# AgentBillClient -------------------------------------------------------------

@pytest.mark.parametrize("base", ACCEPTED)
def test_client_accepts_https_and_loopback_http(sent, base):
    AgentBillClient(api_key=FAKE_KEY, base_url=base).preflight(agent_id="a", task_ref="job-1")
    assert sent == [f"{base}/preflight"]


@pytest.mark.parametrize("base", REFUSED)
def test_client_refuses_anything_else_and_sends_nothing(sent, base):
    with pytest.raises(AgentBillError, match="base_url must be an https URL"):
        AgentBillClient(api_key=FAKE_KEY, base_url=base)
    assert sent == []


def test_refusal_never_echoes_credentials_in_the_url():
    with pytest.raises(AgentBillError) as e:
        AgentBillClient(api_key=FAKE_KEY, base_url="http://user:pw@example.com")
    assert "pw" not in str(e.value) and "example.com" in str(e.value)


def test_reassigning_base_url_is_checked_too(sent):
    c = AgentBillClient(api_key=FAKE_KEY, base_url="https://agentbill.test")
    with pytest.raises(AgentBillError):
        c.base_url = "http://example.com"
    c.preflight(agent_id="a", task_ref="job-1")
    assert sent == ["https://agentbill.test/preflight"]


# wrap() ---------------------------------------------------------------------

class _FakeOpenAI:
    def __init__(self):
        self.sent = []
        outer = self

        class Completions:
            def create(self, **kw):
                outer.sent.append(kw)
                usage = NS(prompt_tokens=3, completion_tokens=2, total_tokens=5,
                           prompt_tokens_details=NS(cached_tokens=0, audio_tokens=0),
                           completion_tokens_details=NS(reasoning_tokens=0, audio_tokens=0))
                return NS(id="c1", model=kw.get("model"), service_tier="default", usage=usage,
                          choices=[NS(message=NS(role="assistant", content="ok"))])

        self.chat = NS(completions=Completions())
        self.base_url = "https://api.openai.com/v1/"


def test_wrap_accepts_loopback_http_from_the_env(sent, monkeypatch):
    monkeypatch.setenv("AGENTBILL_API_KEY", FAKE_KEY)
    monkeypatch.setenv("AGENTBILL_BASE_URL", "http://localhost:3999")
    llm = _FakeOpenAI()
    wrapped = agentbill.wrap(llm, task_ref="job-1", agent_id="a", provider="openai")
    wrapped.chat.completions.create(model="gpt-4o-mini", messages=[{"role": "user", "content": "hi"}])
    assert sent and sent[0] == "http://localhost:3999/preflight"
    assert all(u.startswith("http://localhost:3999/") for u in sent)


def test_wrap_refuses_plain_http_elsewhere_and_sends_nothing(sent, monkeypatch):
    monkeypatch.setenv("AGENTBILL_API_KEY", FAKE_KEY)
    monkeypatch.setenv("AGENTBILL_BASE_URL", "http://example.com")
    llm = _FakeOpenAI()
    with pytest.raises(AgentBillError, match="AGENTBILL_BASE_URL must be an https URL"):
        agentbill.wrap(llm, task_ref="job-1", agent_id="a", provider="openai")
    assert sent == [] and llm.sent == []


# @meter ---------------------------------------------------------------------

def _meter_at(monkeypatch, base):
    """A separate copy of agentbill.meter imported with AGENTBILL_BASE_URL=base
    (see test_default_base_url.meter_probe for why not importlib.reload)."""
    monkeypatch.setenv("AGENTBILL_BASE_URL", base)
    monkeypatch.setenv("AGENTBILL_API_KEY", FAKE_KEY)
    spec = importlib.util.spec_from_file_location("_meter_scheme_probe", meter_module.__file__)
    probe = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(probe)  # a bad URL must not raise here
    return probe


@pytest.mark.parametrize("base", ["https://agentbill.test", "http://localhost:3999"])
def test_meter_accepts_https_and_loopback_http(monkeypatch, base):
    probe = _meter_at(monkeypatch, base)

    @probe.meter(event="run", customer_id="c1", units=1, preflight=True)
    def job():
        return "done"

    with respx.mock(assert_all_called=True) as router:
        budget = router.get(f"{base}/budget").mock(return_value=Response(200, json={"is_blocked": False}))
        events = router.post(f"{base}/events").mock(return_value=Response(200, json={"ok": True}))
        assert job() == "done"
    assert budget.call_count == 1 and events.call_count == 1


@pytest.mark.parametrize("preflight", [True, False])
def test_meter_refuses_plain_http_elsewhere_at_call_time(monkeypatch, preflight):
    probe = _meter_at(monkeypatch, "http://example.com")
    ran = []

    @probe.meter(event="run", customer_id="c1", units=1, preflight=preflight)
    def job():
        ran.append(1)
        return "done"

    with respx.mock(assert_all_called=False) as router:
        anything = router.route(host="example.com").mock(return_value=Response(200, json={}))
        with pytest.raises(probe.AgentBillError, match="AGENTBILL_BASE_URL must be an https URL"):
            job()
    assert anything.call_count == 0
    assert ran == ([] if preflight else [1])


@pytest.mark.parametrize("preflight", [True, False])
def test_meter_async_refuses_plain_http_elsewhere(monkeypatch, preflight):
    import asyncio

    probe = _meter_at(monkeypatch, "http://example.com")

    @probe.meter(event="run", customer_id="c1", units=1, preflight=preflight)
    async def job():
        return "done"

    with respx.mock(assert_all_called=False) as router:
        anything = router.route(host="example.com").mock(return_value=Response(200, json={}))
        with pytest.raises(probe.AgentBillError):
            asyncio.run(job())
    assert anything.call_count == 0
