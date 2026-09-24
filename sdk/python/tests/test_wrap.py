"""agentbill.wrap(): what it sends before and after a model call, per provider.

Every test uses fake provider clients shaped like the real SDKs' responses
(OpenAI chat completions and responses, Anthropic messages, google-genai
generate_content), sync, async and streamed, and stubs `requests` at the
module the AgentBill client calls, so no socket opens. The server half
(pricing, the breakdown) is gated in scripts/preflight/verify.mjs [wrap].
"""
import asyncio
import json
import uuid
import warnings
from types import SimpleNamespace as NS

import pytest
import requests

import agentbill.client as client_module
from agentbill import (AgentBillClient, AuthenticationError, BudgetExhaustedError, CeilingExceededError,
                       Refusal, TaskCeilingExceededError, wrap)
from agentbill.wrap import DEFAULT_ESTIMATE

FAKE_KEY = "agb_" + uuid.uuid4().hex
RID = "3f1c2b7a-8d4e-4b1a-9c2d-5e6f7a8b9c0d"
APPROVED = {"approved": True, "reason": None, "estimated_units": 1, "remaining_units": None,
            "reservation_expires_at": "2026-09-24T12:00:00.000Z", "reservation_id": RID,
            "task_ref": "job-7", "task_ceiling": 100000, "task_remaining_units": 99000}
REFUSED = {"approved": False, "reason": "task_ceiling_exceeded", "estimated_units": 2000,
           "task_ref": "job-7", "task_ceiling": 1000, "task_used_units": 990, "task_remaining_units": 10}
QUOTA = {"approved": False, "reason": "free_tier_exceeded", "plan": "free", "monthly_calls": 1000,
         "plan_limit": 1000, "upgrade_url": "https://agentbill.dev/pricing?account_id=x"}
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


@pytest.fixture
def server(monkeypatch):
    """Answers /preflight with state['preflight'] and /events with RECORDED (or
    state['events_status']); keeps every request as (endpoint, body)."""
    state = {"preflight": APPROVED, "preflight_status": 200, "events_status": 200, "sent": []}

    def fake_post(url, json=None, headers=None, timeout=None):
        path = url.rsplit("/", 1)[-1]
        state["sent"].append((path, json))
        if path == "preflight":
            answer = state["preflight"]
            return _Resp(state["preflight_status"], answer() if callable(answer) else answer)
        if "events_body" in state:        # a callable of the request body
            return _Resp(200, state["events_body"](json))
        return _Resp(state["events_status"], RECORDED if state["events_status"] == 200 else {"error": "boom"})

    monkeypatch.setattr(client_module.requests, "post", fake_post)
    state["preflights"] = lambda: [b for p, b in state["sent"] if p == "preflight"]
    state["events"] = lambda: [b for p, b in state["sent"] if p == "events"]
    return state


AB = AgentBillClient(api_key=FAKE_KEY, base_url="https://agentbill.test")


def run(coro):
    return asyncio.run(coro)


# ---------------------------------------------------------------- fake providers

def chat_completion(prompt=812, cached=0, completion=96, reasoning=0, id="chatcmpl-abc123", model="gpt-4o-mini-2024-07-18", usage=True):
    u = NS(prompt_tokens=prompt, completion_tokens=completion, total_tokens=prompt + completion,
           prompt_tokens_details=NS(cached_tokens=cached, audio_tokens=0),
           completion_tokens_details=NS(reasoning_tokens=reasoning, audio_tokens=0)) if usage else None
    return NS(id=id, model=model, service_tier="default", usage=u,
              choices=[NS(message=NS(role="assistant", content="three uses"))])


class FakeOpenAI:
    """chat.completions.create and responses.create, sync. Counts every call it was sent."""

    def __init__(self, reply=None, chunks=None, response=None, events=None, raises=None):
        self.sent = []
        outer = self

        class Completions:
            def create(self, **kw):
                outer.sent.append(kw)
                if raises:
                    raise raises
                if kw.get("stream"):
                    items = list(chunks(kw) if callable(chunks) else chunks)
                    return FakeStream(items)
                return reply or chat_completion()

        class Responses:
            def create(self, **kw):
                outer.sent.append(kw)
                if kw.get("stream"):
                    return FakeStream(list(events))
                return response

        self.chat = NS(completions=Completions())
        self.responses = Responses()
        self.base_url = "https://api.openai.com/v1/"
        self.models = NS(list=lambda: ["gpt-4o-mini"])  # an unmeasured method, handed through


class FakeStream:
    """Iterable and a context manager, like openai.Stream / anthropic.Stream."""

    def __init__(self, items):
        self.items = items
        self.closed = False
        self.response = NS(status_code=200)

    def __iter__(self):
        return iter(self.items)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.closed = True

    def close(self):
        self.closed = True


class FakeAsyncStream:
    def __init__(self, items):
        self.items = items
        self.closed = False

    async def __aiter__(self):
        for i in self.items:
            yield i

    async def close(self):
        self.closed = True


class AsyncCompletions:
    def __init__(self, outer):
        self.outer = outer

    async def create(self, **kw):
        self.outer.sent.append(kw)
        if kw.get("stream"):
            return FakeAsyncStream(list(self.outer.chunks))
        return chat_completion()


class FakeAsyncOpenAI:
    def __init__(self, chunks=()):
        self.sent = []
        self.chunks = chunks
        self.chat = NS(completions=AsyncCompletions(self))
        self.base_url = "https://api.openai.com/v1/"


def anthropic_message(inp=1200, out=300, cache_read=0, cache_write=0, one_hour=0, usage=True):
    u = NS(input_tokens=inp, output_tokens=out, cache_read_input_tokens=cache_read,
           cache_creation_input_tokens=cache_write,
           cache_creation=NS(ephemeral_5m_input_tokens=cache_write - one_hour, ephemeral_1h_input_tokens=one_hour),
           service_tier="standard") if usage else None
    return NS(id="msg_01abc", model="claude-sonnet-4-5-20250929", usage=u, content=[NS(type="text", text="ok")])


class FakeAnthropic:
    def __init__(self, reply=None, events=None):
        self.sent = []
        outer = self

        class Messages:
            def create(self, **kw):
                outer.sent.append(kw)
                if kw.get("stream"):
                    return FakeStream(list(events))
                return reply or anthropic_message()

        self.messages = Messages()
        self.base_url = "https://api.anthropic.com"


class FakeAsyncAnthropic:
    def __init__(self):
        self.sent = []
        outer = self

        class AsyncMessages:
            async def create(self, **kw):
                outer.sent.append(kw)
                return anthropic_message()

        self.messages = AsyncMessages()


def gemini_response(prompt=900, cand=120, thoughts=0, cached=0, usage=True, id="gem-resp-1"):
    u = NS(prompt_token_count=prompt, candidates_token_count=cand, thoughts_token_count=thoughts,
           cached_content_token_count=cached, total_token_count=prompt + cand + thoughts) if usage else None
    return NS(response_id=id, model_version="gemini-2.5-flash", usage_metadata=u, text="ok")


class FakeGenAI:
    """google-genai's Client: client.models and client.aio.models."""

    def __init__(self, reply=None, chunks=()):
        self.sent = []
        outer = self

        class Models:
            def generate_content(self, *, model, contents, config=None):
                outer.sent.append({"model": model, "config": config})
                return reply or gemini_response()

            def generate_content_stream(self, *, model, contents, config=None):
                def gen():
                    outer.sent.append({"model": model, "config": config, "stream": True})
                    yield from chunks
                return gen()

        class AsyncModels:
            async def generate_content(self, *, model, contents, config=None):
                outer.sent.append({"model": model, "config": config})
                return reply or gemini_response()

            async def generate_content_stream(self, *, model, contents, config=None):
                async def agen():
                    outer.sent.append({"model": model, "config": config, "stream": True})
                    for c in chunks:
                        yield c
                return agen()

        self.models = Models()
        self.aio = NS(models=AsyncModels())


# ---------------------------------------------------------------- the round trip

def test_openai_chat_preflights_in_tokens_then_records_the_reported_usage(server):
    oa = FakeOpenAI(reply=chat_completion(prompt=812, cached=200, completion=96, reasoning=10))
    llm = wrap(oa, task_ref="job-7", agent_id="researcher", step="plan", agentbill_client=AB)
    reply = llm.chat.completions.create(model="gpt-4o-mini", messages=[{"role": "user", "content": "hi"}])
    assert reply.choices[0].message.content == "three uses"   # the caller's answer, untouched

    [pf] = server["preflights"]()
    assert pf["unit"] == "token" and pf["task_ref"] == "job-7" and pf["agent_id"] == "researcher"
    assert pf["estimated_units"] == DEFAULT_ESTIMATE        # first call, no max_tokens: the default

    [ev] = server["events"]()
    assert ev["units"] == 812 + 96                          # prompt (cached included) + completion
    assert ev["idempotency_key"] == "chatcmpl-abc123"       # the provider's response id
    assert ev["reservation_id"] == RID
    assert ev["task_ref"] == "job-7" and ev["event_type"] == "researcher"
    m = ev["metadata"]
    assert m["provider"] == "openai" and m["model"] == "gpt-4o-mini-2024-07-18"
    assert m["requested_model"] == "gpt-4o-mini" and m["step"] == "plan" and m["service_tier"] == "default"
    assert m["tokens"] == {"input": 612, "cache_read": 200, "cache_write": 0, "output": 96, "reasoning": 10}
    assert isinstance(m["duration_ms"], int) and m["duration_ms"] >= 0
    assert "usage_missing" not in ev
    # Nothing of the conversation leaves the process.
    assert "hi" not in json.dumps(server["sent"]) and "three uses" not in json.dumps(server["sent"])


def test_a_refusal_is_returned_before_the_provider_call_is_sent(server):
    server["preflight"] = REFUSED
    oa = FakeOpenAI()
    llm = wrap(oa, task_ref="job-7", agent_id="researcher", agentbill_client=AB)
    r = llm.chat.completions.create(model="gpt-4o-mini", messages=[])   # nothing raised
    assert isinstance(r, Refusal) and r.approved is False and not r
    assert r.reason == "task_ceiling_exceeded" and r.task_ref == "job-7"
    assert (r.used, r.ceiling, r.remaining, r.asked) == (990, 1000, 10, 2000)
    assert r.answer == REFUSED                              # the server's answer, whole
    assert oa.sent == []                                    # the wrapped call did not go out
    assert server["events"]() == []                         # and nothing was recorded
    assert "990/1000" in str(r) and "not sent" in str(r)
    # Not a provider response, and nothing on it pretends to be one.
    for name in ("choices", "content", "candidates", "text", "usage", "message", "output", "id"):
        assert not hasattr(r, name), name
    # The plain client is not changed: preflight() still raises.
    with pytest.raises(TaskCeilingExceededError) as raised:
        AB.preflight("researcher", estimated_units=2000, task_ref="job-7")
    assert raised.value.answer == REFUSED and raised.value.task_remaining_units == 10


def test_the_per_call_ceiling_and_a_spent_customer_balance_are_refusals_too(server):
    ab = AgentBillClient(api_key=FAKE_KEY, base_url="https://agentbill.test", ceiling=500)
    oa = FakeOpenAI()
    llm = wrap(oa, task_ref="job-7", agent_id="r", agentbill_client=ab)
    server["preflight"] = {"approved": False, "reason": "ceiling_exceeded", "estimated_units": 2000, "ceiling": 500,
                           "remaining_units": None}
    r = llm.chat.completions.create(model="gpt-4o-mini", messages=[])
    assert isinstance(r, Refusal) and r.reason == "ceiling_exceeded"
    assert (r.asked, r.ceiling, r.used, r.remaining) == (2000, 500, None, None)
    assert "per-call ceiling of 500" in str(r)
    server["preflight"] = {"approved": False, "reason": "budget_exhausted", "estimated_units": 2000, "remaining_units": 0}
    r = llm.chat.completions.create(model="gpt-4o-mini", messages=[])
    assert isinstance(r, Refusal) and r.reason == "budget_exhausted" and r.remaining == 0 and r.ceiling is None
    assert oa.sent == [] and server["events"]() == []
    with pytest.raises(BudgetExhaustedError):               # preflight() itself: unchanged
        ab.preflight("r", estimated_units=1, task_ref="job-7")
    server["preflight"] = {"approved": False, "reason": "ceiling_exceeded", "estimated_units": 2000, "ceiling": 500}
    with pytest.raises(CeilingExceededError):
        ab.preflight("r", estimated_units=2000, task_ref="job-7")


def test_a_refused_stream_is_the_refusal_and_iterates_to_nothing(server):
    server["preflight"] = REFUSED
    oa = FakeOpenAI(chunks=[_chunk("never")])
    llm = wrap(oa, task_ref="job-7", agent_id="r", agentbill_client=AB)
    s = llm.chat.completions.create(model="gpt-4o-mini", messages=[], stream=True)
    assert isinstance(s, Refusal)
    assert list(s) == []                                    # a loop written for the stream runs zero times
    with s as inside:                                       # and a with-block is a no-op
        assert inside is s and [c for c in inside] == []
    assert oa.sent == [] and server["events"]() == []
    # The same on a Gemini stream (a generator that would have sent nothing yet)
    g = FakeGenAI(chunks=[gemini_response()])
    gs = wrap(g, task_ref="job-7", agent_id="r", agentbill_client=AB).models.generate_content_stream(
        model="gemini-2.5-flash", contents="x")
    assert isinstance(gs, Refusal) and list(gs) == [] and g.sent == []
    # An approved stream carries .refusal, and it is None.
    server["preflight"] = APPROVED
    ok = llm.chat.completions.create(model="gpt-4o-mini", messages=[], stream=True)
    assert not isinstance(ok, Refusal) and ok.refusal is None


def test_a_refused_async_stream_iterates_to_nothing(server):
    server["preflight"] = REFUSED
    oa = FakeAsyncOpenAI(chunks=[_chunk("never")])
    llm = wrap(oa, task_ref="job-7", agent_id="r", agentbill_client=AB)

    async def go():
        s = await llm.chat.completions.create(model="gpt-4o-mini", messages=[], stream=True)
        assert isinstance(s, Refusal)
        async with s as inside:
            return [c async for c in inside]

    assert run(go()) == [] and oa.sent == []


def test_real_failures_still_raise(server):
    # A refusal is a value; a failure is an exception, the same ones preflight() raises.
    oa = FakeOpenAI()
    llm = wrap(oa, task_ref="job-7", agent_id="r", agentbill_client=AB)
    server["preflight_status"], server["preflight"] = 401, {"error": "unauthorized", "message": "Invalid API key."}
    with pytest.raises(AuthenticationError):
        llm.chat.completions.create(model="gpt-4o-mini", messages=[])
    server["preflight_status"], server["preflight"] = 500, {"error": "boom"}
    with pytest.raises(requests.HTTPError):
        llm.chat.completions.create(model="gpt-4o-mini", messages=[])

    def down():
        raise requests.ConnectionError("connection refused")
    server["preflight_status"], server["preflight"] = 200, down
    with pytest.raises(requests.ConnectionError):
        llm.chat.completions.create(model="gpt-4o-mini", messages=[])
    server["preflight_status"], server["preflight"] = 422, {"error": "task_unit_mismatch", "message": "job-7 is counted in unit"}
    with pytest.raises(requests.HTTPError, match="task_unit_mismatch"):
        llm.chat.completions.create(model="gpt-4o-mini", messages=[])
    assert oa.sent == [] and server["events"]() == []


def test_missing_usage_is_recorded_as_missing_never_as_zero(server):
    oa = FakeOpenAI(reply=chat_completion(usage=False))
    llm = wrap(oa, task_ref="job-7", agent_id="researcher", agentbill_client=AB)
    llm.chat.completions.create(model="gpt-4o-mini", messages=[])
    [ev] = server["events"]()
    assert ev["usage_missing"] is True
    assert "tokens" not in ev["metadata"]
    assert ev["reservation_id"] == RID                      # the server floors it at this reservation


def test_a_provider_error_releases_the_reservation_and_is_raised_unchanged(server):
    boom = RuntimeError("429 from the provider")
    llm = wrap(FakeOpenAI(raises=boom), task_ref="job-7", agent_id="researcher", agentbill_client=AB)
    with pytest.raises(RuntimeError) as e:
        llm.chat.completions.create(model="gpt-4o-mini", messages=[])
    assert e.value is boom
    [ev] = server["events"]()
    assert ev["success"] is False and ev["reservation_id"] == RID and ev["units"] == 0


def test_a_failed_record_never_loses_the_answer(server):
    server["events_status"] = 500
    llm = wrap(FakeOpenAI(), task_ref="job-7", agent_id="researcher", agentbill_client=AB)
    with pytest.warns(RuntimeWarning, match="could not record"):
        reply = llm.chat.completions.create(model="gpt-4o-mini", messages=[])
    assert reply.id == "chatcmpl-abc123"


def test_a_spent_quota_is_refused_by_default_and_the_call_is_not_sent(server):
    # Once the account's monthly quota is spent, preflight answers before it
    # looks at the job: no ceiling is checked. Sending anyway would turn the
    # ceiling off without a word, so the default refuses, and preflight()
    # itself still returns approved=False rather than raising.
    server["preflight"] = QUOTA
    oa = FakeOpenAI()
    llm = wrap(oa, task_ref="job-7", agent_id="researcher", agentbill_client=AB)
    spent = llm.chat.completions.create(model="gpt-4o-mini", messages=[])
    assert isinstance(spent, Refusal) and spent.reason == "free_tier_exceeded" and not spent
    assert oa.sent == [] and server["events"]() == []
    assert spent.upgrade_url == QUOTA["upgrade_url"] and spent.answer == QUOTA and spent.task_ref == "job-7"
    assert (spent.used, spent.ceiling, spent.remaining) == (None, None, None)   # the job was not looked at
    assert "'job-7'" in str(spent) and "not sent" in str(spent) and 'on_quota="send"' in str(spent)
    server["preflight"] = {**QUOTA, "reason": "plan_limit_exceeded", "plan": "starter"}
    plan = llm.chat.completions.create(model="gpt-4o-mini", messages=[])
    assert isinstance(plan, Refusal) and plan.reason == "plan_limit_exceeded" and plan.answer["plan"] == "starter"
    assert oa.sent == []
    assert AB.preflight("researcher", estimated_units=1, task_ref="job-7").approved is False


def test_on_quota_send_sends_unchecked_and_warns_once_per_job(server):
    server["preflight"] = QUOTA
    oa = FakeOpenAI()
    llm = wrap(oa, task_ref="job-7", agent_id="researcher", agentbill_client=AB, on_quota="send")
    other = wrap(llm, task_ref="job-8")                     # a view of it: on_quota carries over
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        for _ in range(3):
            llm.chat.completions.create(model="gpt-4o-mini", messages=[])
        other.chat.completions.create(model="gpt-4o-mini", messages=[])
    quota = [str(w.message) for w in caught if "quota" in str(w.message)]
    assert len(quota) == 2 and "'job-7'" in quota[0] and "'job-8'" in quota[1]
    assert "nothing bounds the job" in quota[0] and QUOTA["upgrade_url"] in quota[0]
    assert len(oa.sent) == 4
    assert all("reservation_id" not in ev for ev in server["events"]())   # nothing was reserved


def test_on_quota_takes_refuse_or_send():
    for bad in ("ignore", "raise"):                         # "raise" was the name before refusals were values
        with pytest.raises(ValueError, match="on_quota"):
            wrap(FakeOpenAI(), task_ref="job-7", agent_id="r", agentbill_client=AB, on_quota=bad)
    wrap(FakeOpenAI(), task_ref="job-7", agent_id="r", agentbill_client=AB, on_quota="refuse")


# ---------------------------------------------------------------- the estimate

def test_the_estimate_is_the_running_average_capped_by_max_tokens(server):
    oa = FakeOpenAI(reply=chat_completion(prompt=1000, completion=500))
    llm = wrap(oa, task_ref="job-7", agent_id="r", default_estimate=3000, agentbill_client=AB)
    llm.chat.completions.create(model="gpt-4o-mini", messages=[], max_tokens=200)   # before any history
    llm.chat.completions.create(model="gpt-4o-mini", messages=[])                   # after one: 1,500
    llm.chat.completions.create(model="gpt-4o-mini", messages=[], max_completion_tokens=100)
    est = [p["estimated_units"] for p in server["preflights"]()]
    assert est == [200, 1500, 1100]   # min(3000, 0 + 200); the mean; min(1500, 1000 prompt + 100)


def test_a_rewrap_for_another_step_shares_the_job_average(server):
    base = wrap(FakeOpenAI(reply=chat_completion(prompt=700, completion=300)), task_ref="job-7",
                agent_id="r", step="plan", agentbill_client=AB)
    base.chat.completions.create(model="gpt-4o-mini", messages=[])
    summarize = wrap(base, step="summarize")
    summarize.chat.completions.create(model="gpt-4o-mini", messages=[])
    assert server["preflights"]()[1]["estimated_units"] == 1000
    assert [e["metadata"]["step"] for e in server["events"]()] == ["plan", "summarize"]


# ---------------------------------------------------------------- streaming

def _chunk(text=None, usage=None):
    return NS(id="chatcmpl-s1", model="gpt-4o-mini-2024-07-18", service_tier="default",
              choices=[] if text is None else [NS(delta=NS(content=text))], usage=usage)


def test_openai_stream_turns_on_usage_and_hides_the_chunk_it_added(server):
    def chunks(kw):
        yield _chunk("Hel")
        yield _chunk("lo")
        if (kw.get("stream_options") or {}).get("include_usage"):
            yield _chunk(None, NS(prompt_tokens=50, completion_tokens=7,
                                  prompt_tokens_details=NS(cached_tokens=0), completion_tokens_details=NS(reasoning_tokens=0)))
    oa = FakeOpenAI(chunks=chunks)
    llm = wrap(oa, task_ref="job-7", agent_id="r", agentbill_client=AB)
    stream = llm.chat.completions.create(model="gpt-4o-mini", messages=[], stream=True)
    texts = [c.choices[0].delta.content for c in stream]    # would IndexError on the usage chunk
    assert texts == ["Hel", "lo"]
    assert oa.sent[0]["stream_options"] == {"include_usage": True}
    [ev] = server["events"]()
    assert ev["units"] == 57 and ev["idempotency_key"] == "chatcmpl-s1" and ev["metadata"]["stream"] is True


def test_an_include_usage_the_caller_set_is_left_alone(server):
    def chunks(kw):
        yield _chunk("x")
    oa = FakeOpenAI(chunks=chunks)
    llm = wrap(oa, task_ref="job-7", agent_id="r", agentbill_client=AB)
    list(llm.chat.completions.create(model="gpt-4o-mini", messages=[], stream=True,
                                     stream_options={"include_usage": False}))
    assert oa.sent[0]["stream_options"] == {"include_usage": False}
    [ev] = server["events"]()
    assert ev["usage_missing"] is True                      # asked for none, so none arrived


def test_a_stream_used_as_a_context_manager_is_recorded_on_exit(server):
    def chunks(kw):
        yield _chunk("a")
        yield _chunk(None, NS(prompt_tokens=10, completion_tokens=2))
    llm = wrap(FakeOpenAI(chunks=chunks), task_ref="job-7", agent_id="r", agentbill_client=AB)
    with llm.chat.completions.create(model="gpt-4o-mini", messages=[], stream=True) as s:
        first = next(iter(s))
        assert first.choices[0].delta.content == "a"
        assert s.response.status_code == 200                # the stream's own attributes are there
    [ev] = server["events"]()
    assert ev["usage_missing"] is True                      # left before the usage chunk arrived


def test_openai_responses_plain_and_streamed(server):
    usage = NS(input_tokens=400, output_tokens=80, input_tokens_details=NS(cached_tokens=100),
               output_tokens_details=NS(reasoning_tokens=30))
    done = NS(id="resp_9", model="gpt-5-mini-2025-08-07", service_tier="flex", usage=usage)
    events = [NS(type="response.created", response=NS(id="resp_9", model="gpt-5-mini-2025-08-07", usage=None)),
              NS(type="response.output_text.delta", delta="hi"),
              NS(type="response.completed", response=done)]
    llm = wrap(FakeOpenAI(response=done, events=events), task_ref="job-7", agent_id="r", agentbill_client=AB)
    llm.responses.create(model="gpt-5-mini", input="hi", max_output_tokens=50)
    assert [e.type for e in llm.responses.create(model="gpt-5-mini", input="hi", stream=True)] == \
        ["response.created", "response.output_text.delta", "response.completed"]
    a, b = server["events"]()
    for ev in (a, b):
        assert ev["units"] == 480 and ev["idempotency_key"] == "resp_9"
        assert ev["metadata"]["tokens"] == {"input": 300, "cache_read": 100, "cache_write": 0, "output": 80, "reasoning": 30}
        assert ev["metadata"]["service_tier"] == "flex"
    assert server["preflights"]()[0]["estimated_units"] == 50   # min(default, 0 + max_output_tokens)


def test_anthropic_counts_cache_reads_and_both_cache_writes(server):
    msg = anthropic_message(inp=1200, out=300, cache_read=5000, cache_write=800, one_hour=300)
    llm = wrap(FakeAnthropic(reply=msg), task_ref="job-7", agent_id="r", agentbill_client=AB)
    llm.messages.create(model="claude-sonnet-4-5", max_tokens=1024, messages=[])
    [ev] = server["events"]()
    assert ev["units"] == 1200 + 5000 + 800 + 300
    assert ev["metadata"]["tokens"] == {"input": 1200, "cache_read": 5000, "cache_write": 500,
                                        "cache_write_1h": 300, "output": 300, "reasoning": 0}
    assert ev["metadata"]["service_tier"] == "standard" and ev["idempotency_key"] == "msg_01abc"
    assert server["preflights"]()[0]["estimated_units"] == 1024


def test_anthropic_stream_merges_message_start_and_the_last_delta(server):
    events = [
        NS(type="message_start", message=NS(id="msg_s", model="claude-sonnet-4-5-20250929",
                                            usage=NS(input_tokens=900, output_tokens=1, cache_read_input_tokens=0,
                                                     cache_creation_input_tokens=0))),
        NS(type="content_block_delta", delta=NS(text="hi")),
        NS(type="message_delta", usage=NS(output_tokens=40)),
        NS(type="message_delta", usage=NS(output_tokens=75)),
        NS(type="message_stop"),
    ]
    llm = wrap(FakeAnthropic(events=events), task_ref="job-7", agent_id="r", agentbill_client=AB)
    assert len(list(llm.messages.create(model="claude-sonnet-4-5", max_tokens=100, messages=[], stream=True))) == 5
    [ev] = server["events"]()
    assert ev["units"] == 975 and ev["metadata"]["tokens"]["output"] == 75 and ev["idempotency_key"] == "msg_s"


def test_gemini_counts_thoughts_as_output_outside_candidates(server):
    reply = gemini_response(prompt=900, cand=120, thoughts=600, cached=300)
    llm = wrap(FakeGenAI(reply=reply), task_ref="job-7", agent_id="r", agentbill_client=AB)
    llm.models.generate_content(model="gemini-2.5-flash", contents="hi", config={"max_output_tokens": 800})
    [ev] = server["events"]()
    assert ev["units"] == 900 + 120 + 600                   # totalTokenCount, thoughts included
    assert ev["metadata"]["tokens"] == {"input": 600, "cache_read": 300, "cache_write": 0, "output": 720, "reasoning": 600}
    assert ev["idempotency_key"] == "gem-resp-1" and ev["metadata"]["model"] == "gemini-2.5-flash"
    assert server["preflights"]()[0]["estimated_units"] == 800


def test_gemini_stream_takes_the_last_usage_and_sends_nothing_until_read(server):
    chunks = [gemini_response(prompt=50, cand=3, id="g-s"), gemini_response(prompt=50, cand=11, id="g-s")]
    g = FakeGenAI(chunks=chunks)
    llm = wrap(g, task_ref="job-7", agent_id="r", agentbill_client=AB)
    stream = llm.models.generate_content_stream(model="gemini-2.5-flash", contents="hi")
    assert g.sent == []                                     # a generator: nothing sent yet
    assert len(list(stream)) == 2
    [ev] = server["events"]()
    assert ev["units"] == 61 and ev["idempotency_key"] == "g-s"


def test_a_gemini_stream_closed_before_it_was_read_releases(server):
    llm = wrap(FakeGenAI(chunks=[gemini_response()]), task_ref="job-7", agent_id="r", agentbill_client=AB)
    llm.models.generate_content_stream(model="gemini-2.5-flash", contents="hi").close()
    [ev] = server["events"]()
    assert ev["success"] is False and ev["reservation_id"] == RID


# ---------------------------------------------------------------- async

def test_async_openai_plain_and_streamed(server):
    chunks = [_chunk("a"), _chunk(None, NS(prompt_tokens=20, completion_tokens=5))]
    oa = FakeAsyncOpenAI(chunks=chunks)
    llm = wrap(oa, task_ref="job-7", agent_id="r", agentbill_client=AB)

    async def go():
        await llm.chat.completions.create(model="gpt-4o-mini", messages=[])
        stream = await llm.chat.completions.create(model="gpt-4o-mini", messages=[], stream=True)
        return [c async for c in stream]

    got = run(go())
    assert [c.choices[0].delta.content for c in got] == ["a"]
    a, b = server["events"]()
    assert a["units"] == 908 and b["units"] == 25


def test_async_anthropic_and_gemini(server):
    ant = wrap(FakeAsyncAnthropic(), task_ref="job-7", agent_id="r", agentbill_client=AB)
    gem = wrap(FakeGenAI(chunks=[gemini_response(prompt=10, cand=4, id="g-a")]), task_ref="job-7",
               agent_id="r", agentbill_client=AB)

    async def go():
        await ant.messages.create(model="claude-sonnet-4-5", max_tokens=10, messages=[])
        await gem.aio.models.generate_content(model="gemini-2.5-flash", contents="x")
        stream = await gem.aio.models.generate_content_stream(model="gemini-2.5-flash", contents="x")
        return [c async for c in stream]

    assert len(run(go())) == 1
    units = [e["units"] for e in server["events"]()]
    assert units == [1500, 1020, 14]


def test_async_refusal_is_returned_before_the_call(server):
    server["preflight"] = REFUSED
    oa = FakeAsyncOpenAI()
    llm = wrap(oa, task_ref="job-7", agent_id="r", agentbill_client=AB)
    r = run(llm.chat.completions.create(model="gpt-4o-mini", messages=[]))
    assert isinstance(r, Refusal) and r.reason == "task_ceiling_exceeded" and r.remaining == 10
    assert oa.sent == []


# ---------------------------------------------------------------- the client stays the client

def test_unmeasured_attributes_are_handed_through(server):
    oa = FakeOpenAI()
    llm = wrap(oa, task_ref="job-7", agent_id="r", agentbill_client=AB)
    assert llm.models.list() == ["gpt-4o-mini"]
    assert llm.base_url == oa.base_url
    assert server["sent"] == []                             # nothing measured, nothing sent
    oa.chat.completions.create(model="gpt-4o-mini", messages=[])   # the original is not wrapped
    assert server["sent"] == []


def test_a_client_on_another_host_is_recorded_as_compatible(server):
    oa = FakeOpenAI()
    oa.base_url = "https://my-proxy.example.com/v1"
    llm = wrap(oa, task_ref="job-7", agent_id="r", agentbill_client=AB)
    llm.chat.completions.create(model="gpt-4o-mini", messages=[])
    assert server["events"]()[0]["metadata"]["provider"] == "openai-compatible"


def test_with_options_stays_wrapped(server):
    oa = FakeOpenAI()
    oa.with_options = lambda **kw: oa
    llm = wrap(oa, task_ref="job-7", agent_id="r", agentbill_client=AB)
    llm.with_options(timeout=5).chat.completions.create(model="gpt-4o-mini", messages=[])
    assert len(server["events"]()) == 1


def test_wrap_needs_a_job_and_a_recognisable_client():
    with pytest.raises(TypeError, match="task_ref and agent_id"):
        wrap(FakeOpenAI(), task_ref="job-7", agentbill_client=AB)
    with pytest.raises(TypeError, match="could not tell"):
        wrap(object(), task_ref="job-7", agent_id="r", agentbill_client=AB)


def test_the_default_client_reads_the_key_from_the_environment(monkeypatch):
    monkeypatch.delenv("AGENTBILL_API_KEY", raising=False)
    with pytest.raises(ValueError, match="API key is missing"):
        wrap(FakeOpenAI(), task_ref="job-7", agent_id="r")
    monkeypatch.setenv("AGENTBILL_API_KEY", FAKE_KEY)
    monkeypatch.setenv("AGENTBILL_BASE_URL", "https://agentbill.test")
    llm = wrap(FakeOpenAI(), task_ref="job-7", agent_id="r")
    meter = object.__getattribute__(llm, "_agentbill_meter")
    assert meter.ab.base_url == "https://agentbill.test" and meter.ab.api_key == FAKE_KEY


def test_a_long_or_absent_response_id_still_makes_a_valid_key(server):
    llm = wrap(FakeOpenAI(reply=chat_completion(id="x" * 300)), task_ref="job-7", agent_id="r", agentbill_client=AB)
    llm.chat.completions.create(model="gpt-4o-mini", messages=[])
    llm2 = wrap(FakeOpenAI(reply=chat_completion(id=None)), task_ref="job-7", agent_id="r", agentbill_client=AB)
    llm2.chat.completions.create(model="gpt-4o-mini", messages=[])
    a, b = [e["idempotency_key"] for e in server["events"]()]
    assert a.startswith("resp-") and len(a) <= 128
    assert b.startswith("r-") and len(b) <= 128


# ---------------------------------------------------------------- the record's key

def test_a_compatible_endpoint_gets_a_random_key_even_when_its_ids_repeat(server):
    # Ollama's OpenAI compatibility layer issues chatcmpl-<0..998>: ids repeat.
    # Keyed by them, the second call would be a duplicate the server ignores.
    oa = FakeOpenAI(reply=chat_completion(id="chatcmpl-7"))
    oa.base_url = "http://localhost:11434/v1/"
    llm = wrap(oa, task_ref="job-7", agent_id="r", agentbill_client=AB)
    for _ in range(3):
        llm.chat.completions.create(model="llama3", messages=[])
    keys = [e["idempotency_key"] for e in server["events"]()]
    assert len(set(keys)) == 3 and all(k.startswith("r-") for k in keys)
    assert all(e["metadata"]["provider"] == "openai-compatible" for e in server["events"]())


def test_a_duplicate_answer_is_a_collision_and_the_call_is_recorded_again(server):
    seen = []

    def events(body):
        seen.append(body["idempotency_key"])
        dup = body["idempotency_key"] == "chatcmpl-abc123"
        return {"event_id": None, "status": "duplicate_ignored"} if dup else RECORDED
    server["events_body"] = events
    llm = wrap(FakeOpenAI(), task_ref="job-7", agent_id="r", agentbill_client=AB)
    with pytest.warns(RuntimeWarning, match="reused a response id"):
        llm.chat.completions.create(model="gpt-4o-mini", messages=[])
    first, again = server["events"]()
    assert first["idempotency_key"] == "chatcmpl-abc123" and again["idempotency_key"].startswith("r-")
    assert again["reservation_id"] == first["reservation_id"] == RID
    assert again["units"] == first["units"] == 908 and again["metadata"] == first["metadata"]


# ---------------------------------------------------------------- OpenAI cache writes

def test_openai_cache_writes_are_their_own_token_type(server):
    # Both APIs report the prompt whole, with cached_tokens and
    # cache_write_tokens inside it; the price table prices a write above input.
    u = NS(prompt_tokens=50_000, completion_tokens=400, prompt_tokens_details=NS(cached_tokens=8_000, cache_write_tokens=40_400),
           completion_tokens_details=NS(reasoning_tokens=0))
    reply = NS(id="chatcmpl-cw", model="gpt-5.6", service_tier="default", usage=u, choices=[])
    usage = NS(input_tokens=50_000, output_tokens=400,
               input_tokens_details=NS(cached_tokens=8_000, cache_write_tokens=40_400), output_tokens_details=NS(reasoning_tokens=0))
    done = NS(id="resp_cw", model="gpt-5.6", service_tier="default", usage=usage)

    def chunks(kw):
        yield _chunk("a")
        yield _chunk(None, u)
    events = [NS(type="response.completed", response=done)]
    llm = wrap(FakeOpenAI(reply=reply, chunks=chunks, response=done, events=events), task_ref="job-7", agent_id="r",
               agentbill_client=AB)
    llm.chat.completions.create(model="gpt-5.6", messages=[])
    list(llm.chat.completions.create(model="gpt-5.6", messages=[], stream=True))
    llm.responses.create(model="gpt-5.6", input="x")
    list(llm.responses.create(model="gpt-5.6", input="x", stream=True))
    evs = server["events"]()
    assert len(evs) == 4
    for ev in evs:
        assert ev["metadata"]["tokens"] == {"input": 1_600, "cache_read": 8_000, "cache_write": 40_400,
                                            "output": 400, "reasoning": 0}
        assert ev["units"] == 50_400


def test_cache_writes_never_make_input_negative(server):
    u = NS(prompt_tokens=100, completion_tokens=1, prompt_tokens_details=NS(cached_tokens=70, cache_write_tokens=90))
    llm = wrap(FakeOpenAI(reply=NS(id="c", model="gpt-5.6", usage=u, choices=[])), task_ref="job-7", agent_id="r",
               agentbill_client=AB)
    llm.chat.completions.create(model="gpt-5.6", messages=[])
    t = server["events"]()[0]["metadata"]["tokens"]
    assert (t["input"], t["cache_read"], t["cache_write"]) == (0, 70, 30)


# ---------------------------------------------------------------- a loop that stops early

def test_a_for_loop_that_breaks_is_recorded_without_close_or_with(server):
    def chunks(kw):
        yield _chunk("a")
        yield _chunk("b")
        yield _chunk(None, NS(prompt_tokens=10, completion_tokens=2))
    llm = wrap(FakeOpenAI(chunks=chunks), task_ref="job-7", agent_id="r", agentbill_client=AB)
    stream = llm.chat.completions.create(model="gpt-4o-mini", messages=[], stream=True)
    for c in stream:
        break
    [ev] = server["events"]()                               # recorded when the loop let go
    assert ev["usage_missing"] is True and ev["reservation_id"] == RID

    def stop(s):
        for c in s:
            return c.choices[0].delta.content
    assert stop(llm.chat.completions.create(model="gpt-4o-mini", messages=[], stream=True)) == "a"
    assert len(server["events"]()) == 2


def test_an_async_for_that_breaks_is_recorded(server):
    chunks = [_chunk("a"), _chunk("b"), _chunk(None, NS(prompt_tokens=20, completion_tokens=5))]
    llm = wrap(FakeAsyncOpenAI(chunks=chunks), task_ref="job-7", agent_id="r", agentbill_client=AB)

    async def go():
        stream = await llm.chat.completions.create(model="gpt-4o-mini", messages=[], stream=True)
        async for c in stream:
            break
        await asyncio.sleep(0.05)                           # the loop closes the abandoned generator
        return len(server["events"]())

    assert run(go()) == 1
    [ev] = server["events"]()
    assert ev["usage_missing"] is True and ev["reservation_id"] == RID


# ---------------------------------------------------------------- Gemini automatic function calling

def _gem_round(i, calls_tool):
    r = gemini_response(prompt=1000 + 100 * i, cand=50, id=f"gem-round-{i}")
    r.calls_tool = calls_tool
    return r


class LoopingModels:
    """Shaped like google-genai's Models: generate_content loops over rounds of
    automatic function calling, one self._generate_content per round, and
    returns only the last response. So does the stream, per round."""

    def __init__(self, rounds):
        self.rounds, self.sent = rounds, []

    def _next_round(self, model):
        self.sent.append(model)
        return self.rounds[(len(self.sent) - 1) % len(self.rounds)]

    def _generate_content(self, *, model, contents, config=None):
        return self._next_round(model)

    def generate_content(self, *, model, contents, config=None):
        response = None
        for _ in self.rounds:
            response = self._generate_content(model=model, contents=contents, config=config)
            if not response.calls_tool:
                break
        return response

    def _generate_content_stream(self, *, model, contents, config=None):
        yield self._next_round(model)

    def generate_content_stream(self, *, model, contents, config=None):
        for _ in self.rounds:
            last = None
            for chunk in self._generate_content_stream(model=model, contents=contents, config=config):
                last = chunk
                yield chunk
            if not last.calls_tool:
                return


class AsyncLoopingModels(LoopingModels):
    async def _generate_content(self, *, model, contents, config=None):
        return self._next_round(model)

    async def generate_content(self, *, model, contents, config=None):
        response = None
        for _ in self.rounds:
            response = await self._generate_content(model=model, contents=contents, config=config)
            if not response.calls_tool:
                break
        return response

    async def _generate_content_stream(self, *, model, contents, config=None):
        this = self._next_round(model)

        async def one():
            yield this
        return one()

    async def generate_content_stream(self, *, model, contents, config=None):
        async def agen():
            for _ in self.rounds:
                last = None
                async for chunk in await self._generate_content_stream(model=model, contents=contents, config=config):
                    last = chunk
                    yield chunk
                if not last.calls_tool:
                    return
        return agen()


def _looping_client(n=3):
    rounds = [_gem_round(i, calls_tool=i < n - 1) for i in range(n)]
    return NS(models=LoopingModels(rounds), aio=NS(models=AsyncLoopingModels(rounds)))


def test_each_round_of_automatic_function_calling_is_a_measured_call(server):
    g = _looping_client(3)
    llm = wrap(g, task_ref="job-7", agent_id="r", agentbill_client=AB, provider="gemini")
    reply = llm.models.generate_content(model="gemini-2.5-flash", contents="use the tool")
    assert reply.response_id == "gem-round-2"               # the caller still gets the last response
    assert len(g.models.sent) == 3
    assert len(server["preflights"]()) == 3                 # one preflight per round sent
    assert [e["idempotency_key"] for e in server["events"]()] == ["gem-round-0", "gem-round-1", "gem-round-2"]
    assert [e["units"] for e in server["events"]()] == [1050, 1150, 1250]


def test_a_refusal_on_a_later_round_is_returned_with_the_earlier_rounds_recorded(server):
    answers = iter([APPROVED, REFUSED])
    server["preflight"] = lambda: next(answers)
    g = _looping_client(3)
    llm = wrap(g, task_ref="job-7", agent_id="r", agentbill_client=AB, provider="gemini")
    r = llm.models.generate_content(model="gemini-2.5-flash", contents="use the tool")   # nothing raised
    assert isinstance(r, Refusal) and r.reason == "task_ceiling_exceeded"
    assert len(g.models.sent) == 1                          # round 2 was not sent
    assert [e["idempotency_key"] for e in server["events"]()] == ["gem-round-0"]
    # The same through the async resource.
    answers = iter([APPROVED, REFUSED])
    r = run(llm.aio.models.generate_content(model="gemini-2.5-flash", contents="use the tool"))
    assert isinstance(r, Refusal) and len(g.aio.models.sent) == 1


def test_a_rounds_stream_refused_on_its_first_round_is_the_refusal(server):
    server["preflight"] = REFUSED
    g = _looping_client(3)
    llm = wrap(g, task_ref="job-7", agent_id="r", agentbill_client=AB, provider="gemini")
    s = llm.models.generate_content_stream(model="gemini-2.5-flash", contents="x")
    assert isinstance(s, Refusal) and list(s) == [] and g.models.sent == []

    async def go():
        s = await llm.aio.models.generate_content_stream(model="gemini-2.5-flash", contents="x")
        assert isinstance(s, Refusal)
        return [c async for c in s]

    assert run(go()) == [] and g.aio.models.sent == [] and server["events"]() == []


def test_a_rounds_stream_refused_on_a_later_round_ends_and_exposes_the_refusal(server):
    # The one stream that can be refused after it started: the SDK's own loop
    # asks for another round mid-stream. The caller saw round 0, the stream
    # ends, .refusal says why, and round 0 is recorded.
    answers = iter([APPROVED, REFUSED])
    server["preflight"] = lambda: next(answers)
    g = _looping_client(3)
    llm = wrap(g, task_ref="job-7", agent_id="r", agentbill_client=AB, provider="gemini")
    s = llm.models.generate_content_stream(model="gemini-2.5-flash", contents="x")
    assert not isinstance(s, Refusal) and s.refusal is None
    assert [c.response_id for c in s] == ["gem-round-0"]
    assert isinstance(s.refusal, Refusal) and s.refusal.reason == "task_ceiling_exceeded"
    assert len(g.models.sent) == 1
    assert [e["idempotency_key"] for e in server["events"]()] == ["gem-round-0"]

    answers = iter([APPROVED, REFUSED])

    async def go():
        s = await llm.aio.models.generate_content_stream(model="gemini-2.5-flash", contents="x")
        assert s.refusal is None
        ids = [c.response_id async for c in s]
        return ids, s.refusal

    ids, refusal = run(go())
    assert ids == ["gem-round-0"] and isinstance(refusal, Refusal) and len(g.aio.models.sent) == 1


def test_each_round_is_measured_streamed_and_async_too(server):
    g = _looping_client(2)
    llm = wrap(g, task_ref="job-7", agent_id="r", agentbill_client=AB, provider="gemini")
    assert [c.response_id for c in llm.models.generate_content_stream(model="gemini-2.5-flash", contents="x")] == \
        ["gem-round-0", "gem-round-1"]

    async def go():
        await llm.aio.models.generate_content(model="gemini-2.5-flash", contents="x")
        stream = await llm.aio.models.generate_content_stream(model="gemini-2.5-flash", contents="x")
        return [c.response_id async for c in stream]

    assert run(go()) == ["gem-round-0", "gem-round-1"]
    keys = [e["idempotency_key"] for e in server["events"]()]
    assert keys == ["gem-round-0", "gem-round-1"] * 3
    assert len(server["preflights"]()) == 6


def test_a_gemini_client_without_the_per_round_method_refuses_a_call_that_would_loop(server):
    g = FakeGenAI()
    llm = wrap(g, task_ref="job-7", agent_id="r", agentbill_client=AB)

    def get_weather(city: str) -> str:
        return "sunny"
    with pytest.raises(TypeError, match="automatic_function_calling"):
        llm.models.generate_content(model="gemini-2.5-flash", contents="x", config={"tools": [get_weather]})
    assert g.sent == [] and server["sent"] == []            # not sent, not even preflighted
    llm.models.generate_content(model="gemini-2.5-flash", contents="x",
                                config={"tools": [get_weather], "automatic_function_calling": {"disable": True}})
    llm.models.generate_content(model="gemini-2.5-flash", contents="x", config={"tools": [{"function_declarations": []}]})
    assert len(g.sent) == 2 and len(server["events"]()) == 2
