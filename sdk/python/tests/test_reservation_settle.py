"""A record can settle the call's own reservation, and record() says what it sends.

Before reservation_id, record(units=actual) closed the oldest reservations of
the customer and task_ref by `actual` only, and whatever a reservation held
beyond that stayed held until it expired. A caller reserving the worst case
(input plus max_tokens) and recording real usage was refused long before its
ceiling. The server half is gated in scripts/preflight/verify.mjs [meter];
this file holds the SDK half: the handle is carried, the old payload is
unchanged when nothing new is asked for, and the new arguments go out as sent.

Every test stubs `requests` at the module the client calls, so no socket opens.
"""
import copy
import dataclasses
import gc
import json
import pickle
import re
import uuid

import pytest
import requests

import agentbill.client as client_module
from agentbill import AgentBillClient, AgentBillError, PreflightResult

FAKE_KEY = "agb_" + uuid.uuid4().hex
RID = "3f1c2b7a-8d4e-4b1a-9c2d-5e6f7a8b9c0d"

APPROVED = {
    "approved": True, "reason": None, "estimated_units": 70000, "remaining_units": None,
    "reservation_expires_at": "2026-09-23T12:00:00.000Z", "reservation_id": RID,
    "task_ref": "job-142", "task_ceiling": 500000, "task_remaining_units": 430000,
}
RECORDED = {"event_id": "e1", "status": "recorded", "customer_created": False, "customer_remaining_units": None}


class _Resp:
    def __init__(self, status_code, body):
        self.status_code = status_code
        self._body = body
        self.text = json.dumps(body)

    def json(self):
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"{self.status_code} error")


def _server(monkeypatch, preflight_body=APPROVED):
    """Answers /preflight with preflight_body and /events with RECORDED; keeps every request."""
    sent = []

    def fake_post(url, json=None, headers=None, timeout=None):
        sent.append((url.rsplit("/", 1)[-1], json))
        return _Resp(200, preflight_body if url.endswith("/preflight") else RECORDED)

    monkeypatch.setattr(client_module.requests, "post", fake_post)
    return sent


def _events(sent):
    return [body for path, body in sent if path == "events"]


def test_preflight_exposes_the_reservation_id(monkeypatch):
    _server(monkeypatch)
    result = AgentBillClient(api_key=FAKE_KEY).preflight("researcher", estimated_units=70000, task_ref="job-142")
    assert result.reservation_id == RID


def test_result_record_carries_agent_customer_task_and_reservation(monkeypatch):
    sent = _server(monkeypatch)
    client = AgentBillClient(api_key=FAKE_KEY)
    result = client.preflight("researcher", estimated_units=70000, customer_id="acct_42", task_ref="job-142")
    result.record(units=8000)
    (body,) = _events(sent)
    assert body["reservation_id"] == RID
    assert body["event_type"] == "researcher"
    assert body["customer_id"] == "acct_42"
    assert body["task_ref"] == "job-142"
    assert body["units"] == 8000
    assert body["success"] is True


def test_result_record_on_failure_releases_the_same_reservation(monkeypatch):
    sent = _server(monkeypatch)
    result = AgentBillClient(api_key=FAKE_KEY).preflight("researcher", estimated_units=70000, task_ref="job-142")
    result.record(units=0, success=False)
    (body,) = _events(sent)
    assert body["reservation_id"] == RID and body["success"] is False


def test_record_without_new_arguments_sends_exactly_the_old_payload(monkeypatch):
    sent = _server(monkeypatch)
    AgentBillClient(api_key=FAKE_KEY).record("researcher", units=12, task_ref="job-142")
    (body,) = _events(sent)
    assert sorted(body) == ["customer_id", "event_type", "idempotency_key", "success", "task_ref", "units"]
    # The generated key keeps its old shape: <agent_id>-<uuid4>.
    assert re.fullmatch(r"researcher-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", body["idempotency_key"])


def test_record_passes_an_idempotency_key_through(monkeypatch):
    sent = _server(monkeypatch)
    client = AgentBillClient(api_key=FAKE_KEY)
    client.record("researcher", units=12, idempotency_key="resp_abc123")
    result = client.preflight("researcher", estimated_units=5, task_ref="job-142")
    result.record(units=5, idempotency_key="resp_def456")
    assert [b["idempotency_key"] for b in _events(sent)] == ["resp_abc123", "resp_def456"]


def test_two_records_without_a_key_get_two_different_keys(monkeypatch):
    sent = _server(monkeypatch)
    client = AgentBillClient(api_key=FAKE_KEY)
    client.record("researcher", units=1)
    client.record("researcher", units=1)
    a, b = _events(sent)
    assert a["idempotency_key"] != b["idempotency_key"]


def test_record_zero_units_is_sent_as_zero(monkeypatch):
    sent = _server(monkeypatch)
    AgentBillClient(api_key=FAKE_KEY).record("researcher", units=0, reservation_id=RID)
    (body,) = _events(sent)
    assert body["units"] == 0 and body["reservation_id"] == RID


def test_usage_missing_and_metadata_go_out_as_sent(monkeypatch):
    sent = _server(monkeypatch)
    AgentBillClient(api_key=FAKE_KEY).record(
        "researcher", units=0, usage_missing=True, metadata={"model": "gpt-4o", "step": "draft"})
    (body,) = _events(sent)
    assert body["usage_missing"] is True
    assert body["metadata"] == {"model": "gpt-4o", "step": "draft"}


def test_usage_missing_false_is_not_sent(monkeypatch):
    sent = _server(monkeypatch)
    AgentBillClient(api_key=FAKE_KEY).record("researcher", units=3)
    (body,) = _events(sent)
    assert "usage_missing" not in body and "metadata" not in body and "reservation_id" not in body


def test_against_a_server_without_reservation_id_the_record_settles_the_old_way(monkeypatch):
    old = {k: v for k, v in APPROVED.items() if k != "reservation_id"}
    sent = _server(monkeypatch, preflight_body=old)
    result = AgentBillClient(api_key=FAKE_KEY).preflight("researcher", estimated_units=70000, task_ref="job-142")
    assert result.reservation_id is None
    result.record(units=8000)
    (body,) = _events(sent)
    assert "reservation_id" not in body


def test_a_hand_built_result_cannot_record_and_says_what_to_do():
    result = PreflightResult(approved=True, reason=None, estimated_units=1, remaining_units=None, reservation_id=RID)
    with pytest.raises(AgentBillError) as exc_info:
        result.record(units=1)
    assert "reservation_id=result.reservation_id" in str(exc_info.value)


def test_the_result_does_not_carry_the_client_into_asdict_or_repr(monkeypatch):
    _server(monkeypatch)
    result = AgentBillClient(api_key=FAKE_KEY).preflight("researcher", estimated_units=5, task_ref="job-142")
    as_dict = dataclasses.asdict(result)
    assert FAKE_KEY not in repr(result) and FAKE_KEY not in json.dumps(as_dict, default=str)
    assert sorted(as_dict) == sorted(f.name for f in dataclasses.fields(PreflightResult))
    # And a result still compares equal to the same data, as before.
    assert result == PreflightResult(**as_dict)


def test_the_result_carries_no_key_into_pickle_vars_or_deepcopy_and_still_records(monkeypatch):
    # The binding used to live in result.__dict__: pickle.dumps(result)
    # carried the api_key, deepcopy kept the client, and
    # json.dumps(vars(result)) raised on it.
    sent = _server(monkeypatch)
    result = AgentBillClient(api_key=FAKE_KEY).preflight("researcher", estimated_units=5, task_ref="job-142")
    assert FAKE_KEY.encode() not in pickle.dumps(result)
    assert pickle.loads(pickle.dumps(result)) == result
    logged = json.dumps(vars(result))
    assert FAKE_KEY not in logged and json.loads(logged)["reservation_id"] == RID
    clone = copy.deepcopy(result)
    assert clone == result and FAKE_KEY.encode() not in pickle.dumps(clone)
    # The original still records against its own reservation.
    result.record(units=3)
    (event,) = _events(sent)
    assert event["reservation_id"] == RID and event["task_ref"] == "job-142" and event["units"] == 3


def test_a_copy_or_an_unpickled_result_cannot_record_and_says_what_to_do(monkeypatch):
    _server(monkeypatch)
    result = AgentBillClient(api_key=FAKE_KEY).preflight("researcher", estimated_units=5, task_ref="job-142")
    for other in (copy.copy(result), copy.deepcopy(result), pickle.loads(pickle.dumps(result))):
        with pytest.raises(AgentBillError) as exc_info:
            other.record(units=1)
        assert "reservation_id=result.reservation_id" in str(exc_info.value)


def test_the_binding_goes_away_with_the_result(monkeypatch):
    _server(monkeypatch)
    client = AgentBillClient(api_key=FAKE_KEY)
    gc.collect()  # results of earlier tests, so they are not counted as ours
    before = len(client_module._BINDINGS)
    results = [client.preflight("researcher", estimated_units=5) for _ in range(5)]
    assert len(client_module._BINDINGS) == before + 5
    del results
    gc.collect()
    assert len(client_module._BINDINGS) == before


def test_gate_settles_the_reservation_it_opened(monkeypatch):
    sent = _server(monkeypatch)
    client = AgentBillClient(api_key=FAKE_KEY)

    @client.gate(agent_id="researcher", task_ref="job-142", estimated_units=12)
    def ok():
        return "done"

    @client.gate(agent_id="researcher", task_ref="job-142", estimated_units=12)
    def boom():
        raise RuntimeError("provider down")

    assert ok() == "done"
    with pytest.raises(RuntimeError):
        boom()
    success, failure = _events(sent)
    # gate records what preflight said it reserved, as it always has.
    assert success["reservation_id"] == RID and success["success"] is True and success["units"] == APPROVED["estimated_units"]
    assert failure["reservation_id"] == RID and failure["success"] is False


def test_preflight_sends_unit_only_when_given(monkeypatch):
    sent = _server(monkeypatch)
    client = AgentBillClient(api_key=FAKE_KEY)
    client.preflight("researcher", estimated_units=5, task_ref="job-142", task_ceiling=500000, unit="token")
    client.preflight("researcher", estimated_units=5, task_ref="job-142")
    first, second = [b for p, b in sent if p == "preflight"]
    assert first["unit"] == "token"
    assert "unit" not in second


def test_get_task_reads_unit_and_usage_missing_calls_and_defaults_them_for_an_old_server(monkeypatch):
    new = {"task_ref": "job-142", "agent_id": "r", "ceiling_units": 500000, "used_units": 8000, "reserved_units": 0,
           "remaining_units": 492000, "exceeded": False, "unit": "token", "usage_missing_calls": 2}
    old = {k: v for k, v in new.items() if k not in ("unit", "usage_missing_calls")}
    answers = [new, old]
    monkeypatch.setattr(client_module.requests, "get", lambda url, headers=None, timeout=None: _Resp(200, answers.pop(0)))
    client = AgentBillClient(api_key=FAKE_KEY)
    a = client.get_task("job-142")
    b = client.get_task("job-142")
    assert (a.unit, a.usage_missing_calls) == ("token", 2)
    assert (b.unit, b.usage_missing_calls) == ("unit", 0)


# S19 follow-up, 2026-09-25: approved is read as a boolean, never as a truthy
# value. A 200 whose approved is the string "true", "yes", 1, an object or
# absent (a proxy page, a truncated body, a future shape) is not a verdict, so
# preflight() and checkpoint() answer approved=False. Before this, both passed
# data["approved"] through as it came, so "yes" was approved, and a missing
# key raised KeyError.
@pytest.mark.parametrize("approved", ["true", "yes", 1, {"x": 1}, [1], None, "missing"])
def test_approved_is_true_only_on_a_json_true(monkeypatch, approved):
    body = dict(APPROVED)
    if approved == "missing":
        del body["approved"]
    else:
        body["approved"] = approved
    _server(monkeypatch, preflight_body=body)
    result = AgentBillClient(api_key=FAKE_KEY).preflight("researcher", estimated_units=5, task_ref="job-142")
    assert result.approved is False


def test_approved_true_is_still_approved(monkeypatch):
    _server(monkeypatch)
    assert AgentBillClient(api_key=FAKE_KEY).preflight("researcher", estimated_units=5, task_ref="job-142").approved is True


@pytest.mark.parametrize("approved,expected", [(True, True), ("true", False), (1, False), (False, False)])
def test_checkpoint_approved_is_true_only_on_a_json_true(monkeypatch, approved, expected):
    def fake_post(url, json=None, headers=None, timeout=None):
        return _Resp(200, {"approved": approved, "reason": None, "units_so_far": 3, "remaining_units": 7})

    monkeypatch.setattr(client_module.requests, "post", fake_post)
    assert AgentBillClient(api_key=FAKE_KEY).checkpoint("researcher", units_so_far=3).approved is expected
