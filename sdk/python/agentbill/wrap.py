"""agentbill.wrap: automatic metering for an OpenAI, Anthropic or Gemini client.

    import agentbill
    from openai import OpenAI

    llm = agentbill.wrap(OpenAI(), task_ref="job-7", agent_id="researcher",
                         task_ceiling=200_000)
    reply = llm.chat.completions.create(model="gpt-4o-mini", max_tokens=300,
                                        messages=[{"role": "user", "content": "..."}])

The wrapped client is the same client: every attribute and method is the
original one, and the call still goes from this process straight to the
provider. Around the methods listed below, and only those, wrap() adds two
calls to AgentBill:

  before  POST /preflight on the job, in tokens (the job's unit is "token"),
          with an estimate this module works out (see _Average). A refusal
          raises TaskCeilingExceededError BEFORE the provider call is sent: the
          wrapped call does not go out, and your code decides what happens next.
  after   POST /events with the usage the provider reported on the response
          your process received: input, cache reads, cache writes, output
          (reasoning included, and counted separately where the provider says
          how much of it was reasoning), with idempotency_key = the provider's
          response id and the reservation_id preflight returned, so the record
          settles that reservation whole. metadata carries provider, model, the
          token breakdown, duration_ms and step. Nothing else: no prompt, no
          answer, no header, no key.

Measured methods:
  OpenAI     chat.completions.create, responses.create
  Anthropic  messages.create
  Gemini     models.generate_content, models.generate_content_stream,
             aio.models.generate_content, aio.models.generate_content_stream
             (the google-genai client)
sync and async clients alike, streaming included. Any other method, or a
client you did not wrap, is not measured. That is the honest limit of this
module, and the docs say so.

Missing usage is recorded as missing, never as 0: the record carries
usage_missing=True and the server charges the call at least its reservation.
A provider error before any response releases the reservation (success=False).
A failure to record, after the provider answered, never loses the answer: it is
returned and a RuntimeWarning says the record failed; the reservation then
stays held until it expires, which keeps the ceiling tighter, not looser.

AgentBill's own quota (free_tier_exceeded, plan_limit_exceeded) never stops
your call: it goes out, is recorded, and a RuntimeWarning carries upgrade_url.
Same rule as preflight(): your spend rule raises, our billing state does not.
"""
from __future__ import annotations

import asyncio
import hashlib
import inspect
import math
import os
import threading
import time
import uuid
import warnings
from typing import Any, Callable, Dict, Optional, Tuple, TypeVar
from urllib.parse import urlparse

from .client import BASE_URL, AgentBillClient

T = TypeVar("T")

__all__ = ["wrap"]

# The largest estimate POST /preflight accepts (INT4, see src/lib/ids.ts).
_INT4_MAX = 2_147_483_647

# What an estimate is before the job has a single measured call, when wrap()
# is not given default_estimate. The same starting figure the OpenClaw plugin
# uses. It only matters for the first call of a job in this process.
DEFAULT_ESTIMATE = 2_000

# path of attribute names from the client -> which response shape it returns
_METHODS: Dict[str, Dict[Tuple[str, ...], str]] = {
    "openai": {
        ("chat", "completions", "create"): "openai_chat",
        ("responses", "create"): "openai_responses",
    },
    "anthropic": {
        ("messages", "create"): "anthropic",
    },
    "gemini": {
        ("models", "generate_content"): "gemini",
        ("models", "generate_content_stream"): "gemini_stream",
        ("aio", "models", "generate_content"): "gemini",
        ("aio", "models", "generate_content_stream"): "gemini_stream",
    },
}

# A copy of the client (with_options, copy) is the same client with other
# request settings, so it stays wrapped with the same meter.
_COPIES = {"openai": ("with_options", "copy"), "anthropic": ("with_options", "copy"), "gemini": ()}

_OFFICIAL_HOST = {"openai": "api.openai.com", "anthropic": "api.anthropic.com"}


# ---------------------------------------------------------------- field access

def _get(obj: Any, *names: str) -> Any:
    """The first of names that obj has and is not None; dicts and objects alike."""
    if obj is None:
        return None
    for n in names:
        v = obj.get(n) if isinstance(obj, dict) else getattr(obj, n, None)
        if v is not None:
            return v
    return None


def _count(obj: Any, *names: str) -> Optional[int]:
    """A token count: a whole number of zero or more, or None."""
    v = _get(obj, *names)
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v if v >= 0 else None
    if isinstance(v, float) and v.is_integer() and v >= 0:
        return int(v)
    return None


def _tokens(input=0, cache_read=0, cache_write=0, cache_write_1h=0, output=0, reasoning=0,
            audio_input=0, audio_output=0) -> Dict[str, int]:
    t = {"input": input, "cache_read": cache_read, "cache_write": cache_write, "output": output,
         "reasoning": min(reasoning, output)}
    # Present only when there is something to say, so the common record stays small.
    if cache_write_1h:
        t["cache_write_1h"] = cache_write_1h
    if audio_input:
        t["audio_input"] = min(audio_input, input + cache_read)
    if audio_output:
        t["audio_output"] = min(audio_output, output)
    return t


def _total(t: Dict[str, int]) -> int:
    return t["input"] + t["cache_read"] + t["cache_write"] + t.get("cache_write_1h", 0) + t["output"]


def _prompt(t: Dict[str, int]) -> int:
    return t["input"] + t["cache_read"] + t["cache_write"] + t.get("cache_write_1h", 0)


# ---------------------------------------------------------------- usage, per provider
#
# Each returns the normalised token dict, or None when the provider reported
# no usage. None is recorded as usage_missing, never as 0.

def _usage_openai_chat(u: Any) -> Optional[Dict[str, int]]:
    prompt, completion = _count(u, "prompt_tokens"), _count(u, "completion_tokens")
    if prompt is None and completion is None:
        return None
    prompt, completion = prompt or 0, completion or 0
    pd, cd = _get(u, "prompt_tokens_details"), _get(u, "completion_tokens_details")
    cached = min(_count(pd, "cached_tokens") or 0, prompt)
    return _tokens(input=prompt - cached, cache_read=cached, output=completion,
                   reasoning=_count(cd, "reasoning_tokens") or 0,
                   audio_input=_count(pd, "audio_tokens") or 0, audio_output=_count(cd, "audio_tokens") or 0)


def _usage_openai_responses(u: Any) -> Optional[Dict[str, int]]:
    inp, out = _count(u, "input_tokens"), _count(u, "output_tokens")
    if inp is None and out is None:
        return None
    inp, out = inp or 0, out or 0
    cached = min(_count(_get(u, "input_tokens_details"), "cached_tokens") or 0, inp)
    return _tokens(input=inp - cached, cache_read=cached, output=out,
                   reasoning=_count(_get(u, "output_tokens_details"), "reasoning_tokens") or 0)


def _usage_anthropic(u: Any) -> Optional[Dict[str, int]]:
    # input_tokens excludes cache reads and cache writes on this API; the three
    # are reported side by side and each is billed at its own rate.
    inp, out = _count(u, "input_tokens"), _count(u, "output_tokens")
    if inp is None and out is None:
        return None
    written = _count(u, "cache_creation_input_tokens")
    split = _get(u, "cache_creation")
    one_hour = _count(split, "ephemeral_1h_input_tokens") or 0
    if written is None:
        written = (_count(split, "ephemeral_5m_input_tokens") or 0) + one_hour
    one_hour = min(one_hour, written)
    return _tokens(input=inp or 0, cache_read=_count(u, "cache_read_input_tokens") or 0,
                   cache_write=written - one_hour, cache_write_1h=one_hour, output=out or 0,
                   reasoning=_count(_get(u, "output_tokens_details"), "thinking_tokens") or 0)


def _modality(details: Any, want: str) -> int:
    n = 0
    for d in details or []:
        if str(_get(d, "modality") or "").upper().endswith(want):
            n += _count(d, "token_count", "tokenCount") or 0
    return n


def _usage_gemini(u: Any) -> Optional[Dict[str, int]]:
    # Gemini reports thinking OUTSIDE candidates: total = prompt + candidates +
    # thoughts (+ tool-use prompt). Output here is candidates + thoughts, so a
    # thinking call is not priced as if it only wrote its answer.
    prompt = _count(u, "prompt_token_count", "promptTokenCount")
    cand = _count(u, "candidates_token_count", "candidatesTokenCount")
    thoughts = _count(u, "thoughts_token_count", "thoughtsTokenCount")
    if prompt is None and cand is None and thoughts is None:
        return None
    prompt = prompt or 0
    cached = min(_count(u, "cached_content_token_count", "cachedContentTokenCount") or 0, prompt)
    tool = _count(u, "tool_use_prompt_token_count", "toolUsePromptTokenCount") or 0
    return _tokens(input=prompt - cached + tool, cache_read=cached, output=(cand or 0) + (thoughts or 0),
                   reasoning=thoughts or 0,
                   audio_input=_modality(_get(u, "prompt_tokens_details", "promptTokensDetails"), "AUDIO"),
                   audio_output=_modality(_get(u, "candidates_tokens_details", "candidatesTokensDetails"), "AUDIO"))


def _facts(kind: str, resp: Any) -> Dict[str, Any]:
    """id, model, service tier and usage of a whole (non-streamed) response."""
    if kind == "openai_chat":
        return {"id": _get(resp, "id"), "model": _get(resp, "model"), "tier": _get(resp, "service_tier"),
                "tokens": _usage_openai_chat(_get(resp, "usage"))}
    if kind == "openai_responses":
        return {"id": _get(resp, "id"), "model": _get(resp, "model"), "tier": _get(resp, "service_tier"),
                "tokens": _usage_openai_responses(_get(resp, "usage"))}
    if kind == "anthropic":
        u = _get(resp, "usage")
        return {"id": _get(resp, "id"), "model": _get(resp, "model"), "tier": _get(u, "service_tier"),
                "tokens": _usage_anthropic(u)}
    return {"id": _get(resp, "response_id", "responseId"), "model": _get(resp, "model_version", "modelVersion"),
            "tier": None, "tokens": _usage_gemini(_get(resp, "usage_metadata", "usageMetadata"))}


class _StreamFacts:
    """What a stream has said so far about the call: id, model, tier, usage."""

    def __init__(self, kind: str, swallow_usage_chunk: bool):
        self.kind = kind
        self.swallow = swallow_usage_chunk
        self.id = self.model = self.tier = None
        self.usage: Any = None
        self.anthropic: Dict[str, Any] = {}

    def see(self, item: Any) -> bool:
        """Observe one item. True when it must not reach the caller."""
        k = self.kind
        if k == "openai_chat":
            self.id = self.id or _get(item, "id")
            self.model = self.model or _get(item, "model")
            self.tier = _get(item, "service_tier") or self.tier
            u = _get(item, "usage")
            if u is not None:
                self.usage = u
                # The chunk include_usage adds: no choices, only usage. Hidden
                # when wrap() turned include_usage on, so the caller's loop
                # sees exactly the chunks it would have seen without us.
                return self.swallow and not _get(item, "choices")
            return False
        if k == "openai_responses":
            r = _get(item, "response")
            if r is not None:
                self.id = self.id or _get(r, "id")
                self.model = self.model or _get(r, "model")
                self.tier = _get(r, "service_tier") or self.tier
                if _get(r, "usage") is not None:
                    self.usage = _get(r, "usage")
            return False
        if k == "anthropic":
            t = _get(item, "type")
            if t == "message_start":
                m = _get(item, "message")
                self.id, self.model = _get(m, "id"), _get(m, "model")
                self._merge(_get(m, "usage"))
            elif t == "message_delta":
                self._merge(_get(item, "usage"))
            return False
        # gemini: every chunk is a GenerateContentResponse; the last usage wins.
        self.id = self.id or _get(item, "response_id", "responseId")
        self.model = self.model or _get(item, "model_version", "modelVersion")
        u = _get(item, "usage_metadata", "usageMetadata")
        if u is not None:
            self.usage = u
        return False

    def _merge(self, u: Any) -> None:
        if u is None:
            return
        for f in ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens",
                  "cache_creation", "service_tier", "output_tokens_details"):
            v = _get(u, f)
            if v is not None:
                self.anthropic[f] = v
        self.usage = self.anthropic

    def facts(self) -> Dict[str, Any]:
        k = self.kind
        if k == "openai_chat":
            tokens = _usage_openai_chat(self.usage) if self.usage is not None else None
        elif k == "openai_responses":
            tokens = _usage_openai_responses(self.usage) if self.usage is not None else None
        elif k == "anthropic":
            tokens = _usage_anthropic(self.usage) if self.usage is not None else None
            self.tier = _get(self.usage, "service_tier")
        else:
            tokens = _usage_gemini(self.usage) if self.usage is not None else None
        return {"id": self.id, "model": self.model, "tier": self.tier, "tokens": tokens}


# ---------------------------------------------------------------- the estimate

def _max_tokens(kind: str, kwargs: Dict[str, Any]) -> Optional[int]:
    def whole(v: Any) -> Optional[int]:
        return v if isinstance(v, int) and not isinstance(v, bool) and v > 0 else None
    if kind == "openai_chat":
        return whole(kwargs.get("max_completion_tokens")) or whole(kwargs.get("max_tokens"))
    if kind == "openai_responses":
        return whole(kwargs.get("max_output_tokens"))
    if kind == "anthropic":
        return whole(kwargs.get("max_tokens"))
    return whole(_get(kwargs.get("config"), "max_output_tokens", "maxOutputTokens"))


class _Average:
    """The job's running average, in this process: the estimate preflight reserves.

    The choice, and why it needs no calculation from you:
      - Before the job has a measured call here, the estimate is
        default_estimate (DEFAULT_ESTIMATE unless you pass one).
      - After, it is the running mean of the total tokens of this job's
        measured calls through wrapped clients in this process.
      - When the call sets a maximum output (max_tokens, max_completion_tokens,
        max_output_tokens, or Gemini's config.max_output_tokens), the estimate
        is never more than the running mean of the prompt plus that maximum:
        the call cannot write more than it asked for.
    No token counting and no extra request: the estimate is known before the
    call from what the job already did. It is an estimate, not a bound: a
    call with a prompt far bigger than the job's usual one uses more than it
    reserved. The record charges what the provider reported, so such a call
    can take the job past its ceiling, by at most that one call for each
    caller running at the same moment; the next preflight is refused.
    A call with no usage reported does not move the average.
    """

    def __init__(self) -> None:
        self.n = 0
        self.total = 0.0
        self.prompt = 0.0
        self.lock = threading.Lock()

    def estimate(self, default: int, max_tokens: Optional[int]) -> int:
        with self.lock:
            n, total, prompt = self.n, self.total, self.prompt
        est = total if n else float(default)
        if max_tokens is not None:
            est = min(est, (prompt if n else 0.0) + max_tokens)
        return max(1, min(_INT4_MAX, int(math.ceil(est))))

    def observe(self, tokens: Dict[str, int]) -> None:
        with self.lock:
            self.n += 1
            self.total += (_total(tokens) - self.total) / self.n
            self.prompt += (_prompt(tokens) - self.prompt) / self.n


# ---------------------------------------------------------------- the meter

def _idempotency_key(response_id: Any, agent_id: str) -> str:
    """The provider's response id, as the record's idempotency key: a retried
    record of the same response is one event. A random key when the provider
    gave no id; a digest when the id is longer than the API's 128 characters."""
    if isinstance(response_id, str) and response_id and response_id.isprintable():
        if len(response_id) <= 128:
            return response_id
        return "resp-" + hashlib.sha256(response_id.encode()).hexdigest()[:40]
    return f"{agent_id}-{uuid.uuid4()}"


class _Meter:
    def __init__(self, *, ab: AgentBillClient, provider: str, endpoint: str, task_ref: str, agent_id: str,
                 customer_id: Optional[str], step: Optional[str], task_ceiling: Optional[int],
                 default_estimate: int, averages: Dict[str, _Average], lock: threading.Lock,
                 warned: Dict[str, bool]):
        self.ab, self.provider, self.endpoint = ab, provider, endpoint
        self.task_ref, self.agent_id, self.customer_id, self.step = task_ref, agent_id, customer_id, step
        self.task_ceiling, self.default_estimate = task_ceiling, default_estimate
        self._averages, self._lock, self._warned = averages, lock, warned

    def replace(self, **changes: Any) -> "_Meter":
        fields = dict(ab=self.ab, provider=self.provider, endpoint=self.endpoint, task_ref=self.task_ref,
                      agent_id=self.agent_id, customer_id=self.customer_id, step=self.step,
                      task_ceiling=self.task_ceiling, default_estimate=self.default_estimate,
                      averages=self._averages, lock=self._lock, warned=self._warned)
        fields.update({k: v for k, v in changes.items() if v is not None})
        return _Meter(**fields)

    @property
    def average(self) -> _Average:
        with self._lock:
            a = self._averages.get(self.task_ref)
            if a is None:
                a = self._averages[self.task_ref] = _Average()
            return a

    # -- the two AgentBill calls, as blocking functions (the async path runs
    #    them in a thread, so both paths send exactly the same requests)

    def preflight(self, kind: str, kwargs: Dict[str, Any]):
        estimate = self.average.estimate(self.default_estimate, _max_tokens(kind, kwargs))
        result = self.ab.preflight(self.agent_id, estimated_units=estimate, customer_id=self.customer_id,
                                   task_ref=self.task_ref, task_ceiling=self.task_ceiling, unit="token")
        if not result.approved and not self._warned.get("quota"):
            # Only AgentBill's own quota comes back unraised (your spend rules
            # raise inside preflight()). The call still goes out.
            self._warned["quota"] = True
            warnings.warn(
                f"AgentBill preflight answered {result.reason}: this account's own monthly quota is spent, "
                f"so the job's ceiling was not checked for this call and the call is sent anyway. "
                f"Upgrade: {result.upgrade_url}", RuntimeWarning, stacklevel=4)
        return result

    def release(self, pre: Any) -> None:
        if not pre.approved:
            return
        try:
            self.ab.record(self.agent_id, units=0, customer_id=self.customer_id, success=False,
                           task_ref=self.task_ref, reservation_id=pre.reservation_id)
        except Exception as e:  # noqa: BLE001 - the provider's own error is what the caller must see
            warnings.warn(f"AgentBill could not release this call's reservation ({e}); it stays held until it expires.",
                          RuntimeWarning, stacklevel=4)

    def settle(self, pre: Any, facts: Dict[str, Any], requested_model: Any, started: float, streamed: bool) -> None:
        tokens = facts.get("tokens")
        model = facts.get("model") or requested_model
        metadata: Dict[str, Any] = {"provider": self.endpoint, "model": str(model) if model else "unknown",
                                    "duration_ms": int(round((time.monotonic() - started) * 1000))}
        if requested_model and str(requested_model) != metadata["model"]:
            metadata["requested_model"] = str(requested_model)
        if tokens is not None:
            metadata["tokens"] = tokens
        if self.step:
            metadata["step"] = self.step
        if streamed:
            metadata["stream"] = True
        if facts.get("tier"):
            metadata["service_tier"] = str(facts["tier"])
        units = _total(tokens) if tokens is not None else 0
        try:
            self.ab.record(self.agent_id, units=min(units, _INT4_MAX), customer_id=self.customer_id,
                           task_ref=self.task_ref, idempotency_key=_idempotency_key(facts.get("id"), self.agent_id),
                           reservation_id=pre.reservation_id if pre.approved else None,
                           metadata=metadata, usage_missing=tokens is None)
        except Exception as e:  # noqa: BLE001 - the answer is already paid for; never lose it
            warnings.warn(
                f"AgentBill could not record this call ({e}). The response is returned; the call's reservation "
                f"stays held until it expires.", RuntimeWarning, stacklevel=4)
        if tokens is not None:
            self.average.observe(tokens)

    # -- the wrapped method

    def method(self, fn: Callable, kind: str, owner: Any) -> Callable:
        is_async = _is_async(fn, owner)
        meter = self

        def prepare(kwargs: Dict[str, Any]) -> Tuple[Dict[str, Any], bool, bool]:
            streamed = kind == "gemini_stream" or kwargs.get("stream") is True
            swallow = False
            if kind == "openai_chat" and streamed:
                opts = kwargs.get("stream_options")
                if not isinstance(opts, dict) or "include_usage" not in opts:
                    # Chat Completions streams report usage only when asked.
                    # Asked for here, and the extra chunk is hidden (see
                    # _StreamFacts.see). An include_usage you set yourself is
                    # left as you set it; False means no usage, recorded as missing.
                    kwargs = {**kwargs, "stream_options": {**(opts if isinstance(opts, dict) else {}), "include_usage": True}}
                    swallow = True
            return kwargs, streamed, swallow

        shape = "gemini" if kind == "gemini_stream" else kind

        if not is_async:
            def wrapped(*args: Any, **kwargs: Any) -> Any:
                kwargs, streamed, swallow = prepare(kwargs)
                pre = meter.preflight(shape, kwargs)
                started = time.monotonic()
                try:
                    resp = fn(*args, **kwargs)
                except BaseException:
                    meter.release(pre)
                    raise
                if streamed:
                    return _Stream(resp, meter, pre, _StreamFacts(shape, swallow), kwargs.get("model"), started,
                                   sent=kind != "gemini_stream")
                meter.settle(pre, _facts(shape, resp), kwargs.get("model"), started, streamed=False)
                return resp
        else:
            async def wrapped(*args: Any, **kwargs: Any) -> Any:
                kwargs, streamed, swallow = prepare(kwargs)
                pre = await asyncio.to_thread(meter.preflight, shape, kwargs)
                started = time.monotonic()
                try:
                    resp = await fn(*args, **kwargs)
                except BaseException:
                    await asyncio.to_thread(meter.release, pre)
                    raise
                if streamed:
                    return _AsyncStream(resp, meter, pre, _StreamFacts(shape, swallow), kwargs.get("model"), started,
                                        sent=kind != "gemini_stream")
                await asyncio.to_thread(meter.settle, pre, _facts(shape, resp), kwargs.get("model"), started, False)
                return resp

        try:
            wrapped.__name__ = getattr(fn, "__name__", "create")
            wrapped.__doc__ = getattr(fn, "__doc__", None)
            wrapped.__wrapped__ = fn  # type: ignore[attr-defined]
        except (AttributeError, TypeError):
            pass
        return wrapped


def _is_async(fn: Callable, owner: Any) -> bool:
    # The provider SDKs decorate their async methods with plain wrappers, so
    # iscoroutinefunction on the bound method can read False; the function
    # behind __wrapped__ tells the truth, and so does the resource's class name.
    try:
        inner = inspect.unwrap(fn)
    except ValueError:
        inner = fn
    return (inspect.iscoroutinefunction(fn) or inspect.iscoroutinefunction(inner)
            or type(owner).__name__.startswith("Async"))


# ---------------------------------------------------------------- streams

class _StreamBase:
    def __init__(self, inner: Any, meter: _Meter, pre: Any, facts: _StreamFacts, requested_model: Any,
                 started: float, sent: bool):
        self._inner, self._meter, self._pre, self._facts = inner, meter, pre, facts
        self._model, self._started = requested_model, started
        # Whether the request already left when the method returned. True for
        # OpenAI and Anthropic (create sends it); False for a Gemini stream,
        # which is a generator that sends nothing until it is first read.
        self._sent = sent
        self._done = False

    def _outcome(self) -> Optional[Dict[str, Any]]:
        """None: release (nothing was sent). A dict: settle with these facts;
        tokens None there means the usage never arrived, recorded as missing."""
        if self._done:
            return None
        self._done = True
        if not self._sent:
            return None
        return self._facts.facts()

    def __getattr__(self, name: str) -> Any:
        # Everything the provider's stream object has (response, close on an
        # async one, controller, ...) is still there. Read from __dict__ so a
        # half-built instance cannot recurse into itself.
        inner = self.__dict__.get("_inner")
        if inner is None:
            raise AttributeError(name)
        return getattr(inner, name)


class _Stream(_StreamBase):
    """A provider stream, unchanged for the caller, that records when it ends.

    It is recorded when iteration finishes, when it is closed, or when its
    with-block exits. A stream dropped half-read without either keeps its
    reservation until the reservation expires, and one that ended before its
    usage arrived is recorded as usage missing."""

    _it = None

    def __iter__(self) -> "_Stream":
        return self

    def __next__(self) -> Any:
        if self._it is None:
            self._it = iter(self._inner)
        while True:
            try:
                item = next(self._it)
            except StopIteration:
                self._finish()
                raise
            except BaseException:
                self._finish()
                raise
            self._sent = True
            if not self._facts.see(item):
                return item

    def _finish(self) -> None:
        was_done = self._done
        facts = self._outcome()
        if facts is not None:
            self._meter.settle(self._pre, facts, self._model, self._started, streamed=True)
        elif not was_done:
            self._meter.release(self._pre)

    def close(self) -> None:
        try:
            close = getattr(self._inner, "close", None)
            if callable(close):
                close()
        finally:
            self._finish()

    def __enter__(self) -> "_Stream":
        enter = getattr(self._inner, "__enter__", None)
        if callable(enter):
            enter()
        return self

    def __exit__(self, *exc: Any) -> Any:
        try:
            exit_ = getattr(self._inner, "__exit__", None)
            return exit_(*exc) if callable(exit_) else None
        finally:
            self._finish()


class _AsyncStream(_StreamBase):
    """The async twin of _Stream."""

    _ait = None

    def __aiter__(self) -> "_AsyncStream":
        return self

    async def __anext__(self) -> Any:
        if self._ait is None:
            self._ait = self._inner.__aiter__()
        while True:
            try:
                item = await self._ait.__anext__()
            except StopAsyncIteration:
                await self._finish()
                raise
            except BaseException:
                await self._finish()
                raise
            self._sent = True
            if not self._facts.see(item):
                return item

    async def _finish(self) -> None:
        was_done = self._done
        facts = self._outcome()
        if facts is not None:
            await asyncio.to_thread(self._meter.settle, self._pre, facts, self._model, self._started, True)
        elif not was_done:
            await asyncio.to_thread(self._meter.release, self._pre)

    async def close(self) -> None:
        try:
            close = getattr(self._inner, "close", None) or getattr(self._inner, "aclose", None)
            if callable(close):
                r = close()
                if inspect.isawaitable(r):
                    await r
        finally:
            await self._finish()

    aclose = close

    async def __aenter__(self) -> "_AsyncStream":
        enter = getattr(self._inner, "__aenter__", None)
        if callable(enter):
            await enter()
        return self

    async def __aexit__(self, *exc: Any) -> Any:
        try:
            exit_ = getattr(self._inner, "__aexit__", None)
            return (await exit_(*exc)) if callable(exit_) else None
        finally:
            await self._finish()


# ---------------------------------------------------------------- the proxy

class _Wrapped:
    """The client, or one of its resources, with the measured methods wrapped
    and everything else handed through untouched."""

    __slots__ = ("_agentbill_target", "_agentbill_meter", "_agentbill_path")

    def __init__(self, target: Any, meter: _Meter, path: Tuple[str, ...] = ()):
        object.__setattr__(self, "_agentbill_target", target)
        object.__setattr__(self, "_agentbill_meter", meter)
        object.__setattr__(self, "_agentbill_path", path)

    def __getattr__(self, name: str) -> Any:
        target = object.__getattribute__(self, "_agentbill_target")
        meter: _Meter = object.__getattribute__(self, "_agentbill_meter")
        path = object.__getattribute__(self, "_agentbill_path") + (name,)
        attr = getattr(target, name)
        methods = _METHODS[meter.provider]
        if path in methods:
            return meter.method(attr, methods[path], owner=target)
        if len(path) == 1 and name in _COPIES[meter.provider] and callable(attr):
            def copy(*args: Any, **kwargs: Any) -> Any:
                return _Wrapped(attr(*args, **kwargs), meter)
            return copy
        if any(p[:len(path)] == path for p in methods):
            return _Wrapped(attr, meter, path)
        return attr

    def __setattr__(self, name: str, value: Any) -> None:
        setattr(object.__getattribute__(self, "_agentbill_target"), name, value)

    def __dir__(self) -> list:
        return dir(object.__getattribute__(self, "_agentbill_target"))

    def __repr__(self) -> str:
        return f"<agentbill.wrap of {object.__getattribute__(self, '_agentbill_target')!r}>"


# ---------------------------------------------------------------- detection

def _has(obj: Any, *path: str) -> bool:
    for name in path:
        try:
            obj = getattr(obj, name)
        except Exception:  # noqa: BLE001 - a lazy property that fails is simply not there
            return False
    return callable(obj)


def _provider(client: Any) -> Optional[str]:
    mod = (type(client).__module__ or "").split(".")
    if mod[0] == "openai":
        return "openai"
    if mod[0] == "anthropic":
        return "anthropic"
    if mod[:2] == ["google", "genai"]:
        return "gemini"
    if _has(client, "chat", "completions", "create") or _has(client, "responses", "create"):
        return "openai"
    if _has(client, "models", "generate_content"):
        return "gemini"
    if _has(client, "messages", "create"):
        return "anthropic"
    return None


def _endpoint(client: Any, provider: str) -> str:
    """The provider as recorded. A client pointed at another host (Azure, a
    proxy, an OpenAI-compatible server) is recorded as "<provider>-compatible",
    and the server does not price it: another host's prices are not this
    provider's list prices. A Gemini client on Vertex AI is "gemini-vertex"."""
    if provider in _OFFICIAL_HOST:
        base = getattr(client, "base_url", None)
        host = urlparse(str(base)).hostname if base else None
        if host and host != _OFFICIAL_HOST[provider]:
            return f"{provider}-compatible"
    if provider == "gemini":
        vertex = getattr(client, "vertexai", None)
        if vertex is None:
            vertex = getattr(getattr(client, "_api_client", None), "vertexai", None)
        if vertex is True:
            return "gemini-vertex"
    return provider


def wrap(client: T, *, task_ref: Optional[str] = None, agent_id: Optional[str] = None,
         step: Optional[str] = None, customer_id: Optional[str] = None, task_ceiling: Optional[int] = None,
         default_estimate: Optional[int] = None, agentbill_client: Optional[AgentBillClient] = None,
         provider: Optional[str] = None) -> T:
    """Meter every call a model client makes through its create methods, in tokens.

    task_ref: the job every call is counted against. The job is counted in
        tokens: it is opened with unit "token" by the first call when you pass
        task_ceiling, or open it first with PUT /tasks/<task_ref>/ceiling and
        {"ceiling_units": N, "unit": "token"}. A job opened in units is a 422
        task_unit_mismatch here, never a relabel.
    agent_id: the attribution label, as on preflight().
    step: an optional label for this part of the job, stored on each record and
        broken out by GET /tasks/<task_ref>. For another step, wrap the wrapped
        client again: wrap(llm, step="summarize") shares the running average.
    customer_id: as on preflight(); "default" when omitted.
    task_ceiling: opens the job with this ceiling, in tokens, if it does not
        exist yet. Not applied once it exists.
    default_estimate: the estimate before the job's first measured call in this
        process. See _Average for the whole rule.
    agentbill_client: the AgentBillClient to call. By default one is made from
        AGENTBILL_API_KEY (and AGENTBILL_BASE_URL, when set).
    provider: "openai", "anthropic" or "gemini", when detection from the
        client cannot tell.

    Returns the client, wrapped. The original is untouched and unmeasured.
    """
    if isinstance(client, _Wrapped):
        target = object.__getattribute__(client, "_agentbill_target")
        base: _Meter = object.__getattribute__(client, "_agentbill_meter")
        if object.__getattribute__(client, "_agentbill_path"):
            raise TypeError("agentbill.wrap() takes the client itself, not one of its resources.")
        if agentbill_client is not None or provider is not None:
            raise TypeError("A wrapped client keeps its AgentBill client and provider; wrap the original to change them.")
        return _Wrapped(target, base.replace(task_ref=task_ref, agent_id=agent_id, step=step,
                                             customer_id=customer_id, task_ceiling=task_ceiling,
                                             default_estimate=default_estimate))  # type: ignore[return-value]

    if not task_ref or not agent_id:
        raise TypeError("agentbill.wrap() needs task_ref and agent_id: the job to count against, and the label.")
    kind = provider or _provider(client)
    if kind not in _METHODS:
        raise TypeError(
            "agentbill.wrap() recognises an OpenAI, Anthropic or google-genai client "
            f"and could not tell what {type(client).__name__} is. Pass provider=\"openai\", \"anthropic\" or \"gemini\".")
    if default_estimate is not None and (not isinstance(default_estimate, int) or default_estimate < 1):
        raise ValueError("default_estimate is a whole number of tokens, 1 or more.")
    if agentbill_client is None:
        agentbill_client = AgentBillClient(api_key=os.environ.get("AGENTBILL_API_KEY", ""),
                                           base_url=os.environ.get("AGENTBILL_BASE_URL") or BASE_URL)
    meter = _Meter(ab=agentbill_client, provider=kind, endpoint=_endpoint(client, kind), task_ref=task_ref,
                   agent_id=agent_id, customer_id=customer_id, step=step, task_ceiling=task_ceiling,
                   default_estimate=default_estimate or DEFAULT_ESTIMATE, averages={}, lock=threading.Lock(),
                   warned={})
    return _Wrapped(client, meter)  # type: ignore[return-value]
