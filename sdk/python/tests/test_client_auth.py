"""A wrong API key must read as a wrong API key.

Until 0.6.3 every 401 surfaced as requests' own `HTTPError: 401 Client Error`,
and the server's {"error": "unauthorized", "message": "Invalid API key."} was
dropped by raise_for_status(). The first run with a mis-pasted key is the most
common failure there is, and it was the one with no sentence of its own.

Everything here stubs `requests` at the module the client calls (or httpx via
respx for the decorator path), so no test opens a socket.
"""
import json
import uuid

import pytest
import requests
import respx
from httpx import Response

import agentbill.client as client_module
from agentbill import AgentBillClient, AgentBillError, AuthenticationError, meter

# Keys shaped like real ones and never issued. Built, not typed, so a secret
# scanner does not read a test fixture as a credential.
FAKE_KEY = "agb_" + uuid.uuid4().hex
DOUBLE_PREFIX_KEY = "agb_" + FAKE_KEY          # a paste over an agb_ placeholder
NON_ASCII_KEY = "agb_" + "".join(chr(c) for c in (0x5D4, 0x5D3, 0x5D1, 0x5E7))   # a Hebrew placeholder, pasted through
BLANK_KEY = " " * 3

SERVER_401 = {"error": "unauthorized", "message": "Invalid API key."}
SERVER_REVOKED = {
    "error": "key_revoked",
    "message": "This API key has been revoked. Generate a new one with POST /keys/generate.",
}


class _Resp:
    def __init__(self, status_code, body=None, text=None):
        self.status_code = status_code
        self._body = body
        self.text = text if text is not None else json.dumps(body)

    def json(self):
        if self._body is None:
            raise ValueError("no JSON")
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"{self.status_code} Client Error: Unauthorized for url: x")


def _stub(monkeypatch, resp):
    calls = []

    def fake(url, *a, **k):
        calls.append(url)
        return resp

    monkeypatch.setattr(client_module.requests, "post", fake)
    monkeypatch.setattr(client_module.requests, "get", fake)
    return calls


def test_invalid_key_raises_authentication_error_with_the_servers_message(monkeypatch):
    _stub(monkeypatch, _Resp(401, SERVER_401))
    client = AgentBillClient(api_key=DOUBLE_PREFIX_KEY)

    with pytest.raises(AuthenticationError) as exc_info:
        client.preflight(agent_id="first-run", task_ref="job-1", task_ceiling=10, estimated_units=3)

    e = exc_info.value
    assert e.error == "unauthorized"
    assert e.message == "Invalid API key."
    assert e.status_code == 401
    text = str(e)
    assert "Invalid API key." in text            # the server's sentence, verbatim
    assert "(unauthorized)" in text              # the server's reason enum
    assert "agb_" in text                        # what a real key looks like
    assert "agentbill.dev/register" in text      # where it was shown
    assert "agentbill.dev/recover" in text       # the way back in
    assert isinstance(e, AgentBillError)         # an existing except clause still catches it
    assert "blocked" not in text and "Refused" not in text   # a 401 is not a refusal


def test_revoked_key_keeps_the_servers_reason_and_adds_no_register_hint(monkeypatch):
    _stub(monkeypatch, _Resp(401, SERVER_REVOKED))
    client = AgentBillClient(api_key=FAKE_KEY)

    with pytest.raises(AuthenticationError) as exc_info:
        client.get_task("job-1")

    e = exc_info.value
    assert e.error == "key_revoked"
    assert SERVER_REVOKED["message"] in str(e)
    assert "recover" not in str(e)   # the server already said what to do next


def test_401_without_a_json_body_still_reads_as_authentication(monkeypatch):
    _stub(monkeypatch, _Resp(401, body=None, text="Unauthorized"))
    client = AgentBillClient(api_key=FAKE_KEY)

    with pytest.raises(AuthenticationError) as exc_info:
        client.record(agent_id="a", units=1)

    assert exc_info.value.error == "unauthorized"
    assert exc_info.value.message == "Unauthorized"


@pytest.mark.parametrize("call", [
    lambda c: c.preflight(agent_id="a", task_ref="t", task_ceiling=5, estimated_units=1),
    lambda c: c.record(agent_id="a", units=1),
    lambda c: c.get_task("t"),
    lambda c: c.checkpoint(agent_id="a", units_so_far=1),
    lambda c: c.record_step(agent_id="a", step_name="s", units=1),
])
def test_every_call_path_raises_the_same_error(monkeypatch, call):
    _stub(monkeypatch, _Resp(401, SERVER_401))
    with pytest.raises(AuthenticationError):
        call(AgentBillClient(api_key=FAKE_KEY))


def test_other_statuses_still_raise_requests_http_error(monkeypatch):
    # Only the 401 path changed. A 500 keeps surfacing exactly as before.
    _stub(monkeypatch, _Resp(500, {"error": "internal_error"}))
    with pytest.raises(requests.HTTPError):
        AgentBillClient(api_key=FAKE_KEY).record(agent_id="a", units=1)


def test_non_ascii_key_is_rejected_before_any_request(monkeypatch):
    calls = _stub(monkeypatch, _Resp(401, SERVER_401))

    with pytest.raises(ValueError) as exc_info:
        AgentBillClient(api_key=NON_ASCII_KEY)

    assert "non-ASCII" in str(exc_info.value)
    assert "agb_" in str(exc_info.value)
    assert calls == []


def test_empty_key_message_is_unchanged():
    with pytest.raises(ValueError) as exc_info:
        AgentBillClient(api_key=BLANK_KEY)
    assert "missing" in str(exc_info.value)


def test_meter_decorator_preflight_401_raises_authentication_error(monkeypatch):
    import importlib
    meter_module = importlib.import_module("agentbill.meter")
    monkeypatch.setenv("AGENTBILL_API_KEY", FAKE_KEY)
    monkeypatch.setattr(meter_module, "_BASE_URL", "https://agentbill.test")
    ran = 0

    @meter(event="research_run", customer_id="cust_1", preflight=True)
    def run_agent():
        nonlocal ran
        ran += 1
        return "should not run"

    with respx.mock(base_url="https://agentbill.test") as router:
        router.get("/budget").mock(return_value=Response(401, json=SERVER_401))
        with pytest.raises(AuthenticationError) as exc_info:
            run_agent()

    assert exc_info.value.message == "Invalid API key."
    assert ran == 0


def test_meter_decorator_record_401_raises_authentication_error(monkeypatch):
    import importlib
    meter_module = importlib.import_module("agentbill.meter")
    monkeypatch.setenv("AGENTBILL_API_KEY", FAKE_KEY)
    monkeypatch.setattr(meter_module, "_BASE_URL", "https://agentbill.test")

    @meter(event="research_run", customer_id="cust_1", units=2)
    def run_agent():
        return "ran"

    with respx.mock(base_url="https://agentbill.test") as router:
        router.post("/events").mock(return_value=Response(401, json=SERVER_401))
        with pytest.raises(AuthenticationError) as exc_info:
            run_agent()

    assert exc_info.value.error == "unauthorized"
