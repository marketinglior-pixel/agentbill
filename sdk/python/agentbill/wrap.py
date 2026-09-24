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
          with an estimate this module works out (see _Average). A refusal is
          RETURNED, as a Refusal, BEFORE the provider call is sent: the wrapped
          call does not go out, and your code decides what happens next (see
          Refusal). Nothing is raised for a refusal; an exception out of a
          measured call is a failure: the provider's own error, or from
          AgentBill a network error, a 401 (AuthenticationError), a 5xx
          (AgentBillError), a 422 task_unit_mismatch (requests.HTTPError).
  after   POST /events with the usage the provider reported on the response
          your process received: input, cache reads, cache writes, output
          (reasoning included, and counted separately where the provider says
          how much of it was reasoning), with the reservation_id preflight
          returned, so the record settles that reservation whole, and an
          idempotency_key (see _idempotency_key). metadata carries provider,
          model, the token breakdown, duration_ms and step. Nothing else: no
          prompt, no answer, no header, no key.

Measured methods:
  OpenAI     chat.completions.create, responses.create
  Anthropic  messages.create
  Gemini     models.generate_content, models.generate_content_stream,
             aio.models.generate_content, aio.models.generate_content_stream
             (the google-genai client). With automatic function calling one
             of these sends a model request per round; each round is its own
             measured call (see _GEMINI_ROUNDS).
sync and async clients alike, streaming included. Any other method, or a
client you did not wrap, is not measured. That is the honest limit of this
module, and the docs say so.

Each measured call is one preflight, so it uses one preflight of the
account's monthly quota.

Missing usage is recorded as missing, never as 0: the record carries
usage_missing=True and the server charges the call at least its reservation.
A provider error before any response releases the reservation (success=False).
A failure to record, after the provider answered, never loses the answer: it is
returned and a RuntimeWarning says the record failed; the reservation then
stays held until it expires, which keeps the ceiling tighter, not looser.

AgentBill's own quota (free_tier_exceeded, plan_limit_exceeded): once it is
spent, preflight answers before it looks at the job, so no ceiling can be
checked. By default (on_quota="refuse") the measured call returns a Refusal
with that reason and upgrade_url, and the call is not sent: a ceiling that
silently stopped being checked is the failure a ceiling exists to prevent.
With on_quota="send" the call is sent unchecked and recorded, with a
RuntimeWarning once per job, and nothing bounds the job until the quota resets
or the plan is upgraded.

The plain client is not changed by any of this: AgentBillClient.preflight()
still raises TaskCeilingExceededError, CeilingExceededError and
BudgetExhaustedError, and returns approved=False on the quota.
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
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Callable, Dict, Iterator, Optional, Tuple, TypeVar
from urllib.parse import urlparse

from .client import (BASE_URL, AgentBillClient, CeilingExceededError,
                     TaskCeilingExceededError, _answer_of)
from .meter import BudgetExhaustedError

T = TypeVar("T")

__all__ = ["wrap", "Refusal"]


# ---------------------------------------------------------------- the refusal

@dataclass(frozen=True)
class Refusal:
    """What a measured call returns, instead of the provider's response, when
    preflight refused it. The provider call was not sent and nothing was
    recorded. A refusal is an expected state of a job with a ceiling, not a
    failure, so it is returned, and your code decides: stop, skip, or replan.

        reply = llm.chat.completions.create(model="gpt-4o-mini", messages=msgs)
        if isinstance(reply, Refusal):
            log.info("job %s: %s", reply.task_ref, reply)
            return partial_result

    It is not shaped like a provider response and cannot be mistaken for one:
    bool(refusal) is False, and it has no choices, content, candidates, text
    or usage. For a streaming call the same object is returned; iterating it
    (for, async for) yields nothing, and it is a no-op context manager, so a
    loop written for the provider's stream runs zero times and the check is
    the same isinstance after it. There is no other stream shape for a call
    refused before anything was sent. One stream, and only one, can be
    refused after it started: a Gemini automatic-function-calling stream whose
    later round is refused ends after the earlier round's chunks, and the
    stream's .refusal is set (None on every other stream wrap() returns).

    approved     always False
    reason       task_ceiling_exceeded (the job's ceiling), ceiling_exceeded
                 (the per-call ceiling set on the AgentBillClient),
                 budget_exhausted (that customer's balance),
                 free_tier_exceeded or plan_limit_exceeded (this account's
                 monthly preflight quota, so the ceiling was not checked)
    task_ref     the job
    asked        the estimate this call asked preflight to reserve, in tokens
    used         the job's used tokens (task_ceiling_exceeded), else None
    ceiling      the job's ceiling, or on ceiling_exceeded the per-call one
    remaining    what is left: of the job, or of the customer's balance
    upgrade_url  set on a quota refusal
    answer       the preflight answer as the server sent it, whole
    str(refusal) one sentence naming the reason and the numbers
    """
    reason: str
    task_ref: Optional[str] = None
    asked: Optional[int] = None
    used: Optional[int] = None
    ceiling: Optional[int] = None
    remaining: Optional[int] = None
    upgrade_url: Optional[str] = None
    answer: Dict[str, Any] = field(default_factory=dict)
    approved: bool = field(default=False, init=False)

    def __bool__(self) -> bool:
        return False

    def __str__(self) -> str:
        r = self.reason
        if r == "task_ceiling_exceeded":
            return (f"Refused (task_ceiling_exceeded): job {self.task_ref!r} is at {self.used}/{self.ceiling} tokens "
                    f"and {self.remaining} remaining is not enough for the {self.asked} this call asked for. "
                    f"The call was not sent.")
        if r == "ceiling_exceeded":
            return (f"Refused (ceiling_exceeded): this call asked for {self.asked} tokens, over the per-call ceiling "
                    f"of {self.ceiling}. The call was not sent.")
        if r == "budget_exhausted":
            return (f"Refused (budget_exhausted): this customer's balance is spent ({self.remaining} remaining), so "
                    f"job {self.task_ref!r} cannot continue on it. The call was not sent.")
        return (f"Refused ({r}): this account's monthly preflight quota is spent, so the ceiling of job "
                f"{self.task_ref!r} cannot be checked, and the call was not sent. Upgrade: {self.upgrade_url} "
                f"(or wrap(..., on_quota=\"send\") to send calls unchecked).")

    # A refused streaming call: nothing to iterate, nothing to close.
    def __iter__(self) -> Iterator[Any]:
        return iter(())

    async def __aiter__(self) -> AsyncIterator[Any]:
        return
        yield  # pragma: no cover - makes this an async generator that yields nothing

    def __enter__(self) -> "Refusal":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None

    async def __aenter__(self) -> "Refusal":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None


class _Refused(Exception):
    """Carries a Refusal out of a measured per-round Gemini method, through
    the provider SDK's own automatic-function-calling loop, to the public
    method's wrapper, which returns it. Never leaves this module."""

    def __init__(self, refusal: Refusal):
        self.refusal = refusal
        super().__init__(str(refusal))

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
        # The one-request methods behind the four above (see _GEMINI_ROUNDS).
        ("models", "_generate_content"): "gemini",
        ("models", "_generate_content_stream"): "gemini_stream",
        ("aio", "models", "_generate_content"): "gemini",
        ("aio", "models", "_generate_content_stream"): "gemini_stream",
    },
}

# google-genai's generate_content runs automatic function calling (on by
# default when Python callables are passed as tools): a loop that sends one
# model request per round and returns only the LAST response, whose
# usage_metadata is that last request's. Measured at the public method, every
# earlier round would be sent unpreflighted and never recorded: an undercount,
# the direction a ceiling must never drift. So the public method is run with
# the wrapped resource as self, and the one-request method it calls each round
# (Models._generate_content, _generate_content_stream, and the AsyncModels
# twins) is the measured one: one preflight and one record per round, and a
# refusal on a later round raises out of generate_content with the earlier
# rounds recorded. When the resource has no such method (a stand-in, or a
# version that renamed it), the public method is measured and a call that
# would loop is refused before it is sent (_would_loop).
_GEMINI_ROUNDS = {"generate_content": "_generate_content",
                  "generate_content_stream": "_generate_content_stream"}

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

def _openai_prompt_split(prompt: int, details: Any) -> Tuple[int, int, int]:
    """(input, cache_read, cache_write) of an OpenAI prompt count. Both APIs
    report the prompt whole and say inside it how much was read from the cache
    (cached_tokens) and how much was written to it (cache_write_tokens), and
    the price table prices a cache write at its own rate, above plain input
    on the models that charge for it. Clamped so the three add up to prompt."""
    cached = min(_count(details, "cached_tokens") or 0, prompt)
    written = min(_count(details, "cache_write_tokens") or 0, prompt - cached)
    return prompt - cached - written, cached, written


def _usage_openai_chat(u: Any) -> Optional[Dict[str, int]]:
    prompt, completion = _count(u, "prompt_tokens"), _count(u, "completion_tokens")
    if prompt is None and completion is None:
        return None
    prompt, completion = prompt or 0, completion or 0
    pd, cd = _get(u, "prompt_tokens_details"), _get(u, "completion_tokens_details")
    inp, cached, written = _openai_prompt_split(prompt, pd)
    return _tokens(input=inp, cache_read=cached, cache_write=written, output=completion,
                   reasoning=_count(cd, "reasoning_tokens") or 0,
                   audio_input=_count(pd, "audio_tokens") or 0, audio_output=_count(cd, "audio_tokens") or 0)


def _usage_openai_responses(u: Any) -> Optional[Dict[str, int]]:
    inp, out = _count(u, "input_tokens"), _count(u, "output_tokens")
    if inp is None and out is None:
        return None
    inp, out = inp or 0, out or 0
    uncached, cached, written = _openai_prompt_split(inp, _get(u, "input_tokens_details"))
    return _tokens(input=uncached, cache_read=cached, cache_write=written, output=out,
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
    The prompt is not counted and no request is added: the estimate is known
    before the call from what the job already did. It is an estimate, not a bound: a
    call with a prompt far bigger than the job's usual one uses more than it
    reserved. The record charges what the provider reported, so such a call
    can take the job past its ceiling, by at most that one call for each
    caller running at the same moment; the next preflight is refused. That
    bound needs preflight to check the ceiling: with on_quota="send" and the
    account's monthly quota spent, nothing is checked and nothing bounds the
    job until the quota resets or the plan is upgraded.
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

def _random_key(agent_id: str) -> str:
    return f"{agent_id}-{uuid.uuid4()}"


def _idempotency_key(response_id: Any, agent_id: str, endpoint: str) -> str:
    """The record's idempotency key.

    On the provider's own API, its response id: unique per response there,
    so a retried record of the same response is one event (a digest when the
    id is longer than the API's 128 characters). On a "<provider>-compatible"
    endpoint the id is not the provider's and need not be unique: Ollama's
    compatibility layer, for one, issues chatcmpl-<0..998>, and a repeated key
    is a duplicate the server ignores, so that call's usage would never count
    and its reservation would stay held. There, and whenever the id is
    missing, a random key made once for this record. wrap() never retries a
    record, so a random key loses nothing."""
    if endpoint.endswith("-compatible"):
        return _random_key(agent_id)
    if isinstance(response_id, str) and response_id and response_id.isprintable():
        if len(response_id) <= 128:
            return response_id
        return "resp-" + hashlib.sha256(response_id.encode()).hexdigest()[:40]
    return _random_key(agent_id)


_ON_QUOTA = ("refuse", "send")

# The three refusals preflight() raises for. wrap() catches exactly these and
# returns them as a Refusal; every other exception is a failure and passes.
_REFUSALS = (TaskCeilingExceededError, CeilingExceededError, BudgetExhaustedError)


class _Meter:
    def __init__(self, *, ab: AgentBillClient, provider: str, endpoint: str, task_ref: str, agent_id: str,
                 customer_id: Optional[str], step: Optional[str], task_ceiling: Optional[int],
                 default_estimate: int, on_quota: str, averages: Dict[str, _Average], lock: threading.Lock,
                 warned: Dict[str, bool]):
        self.ab, self.provider, self.endpoint = ab, provider, endpoint
        self.task_ref, self.agent_id, self.customer_id, self.step = task_ref, agent_id, customer_id, step
        self.task_ceiling, self.default_estimate, self.on_quota = task_ceiling, default_estimate, on_quota
        self._averages, self._lock, self._warned = averages, lock, warned

    def replace(self, **changes: Any) -> "_Meter":
        fields = dict(ab=self.ab, provider=self.provider, endpoint=self.endpoint, task_ref=self.task_ref,
                      agent_id=self.agent_id, customer_id=self.customer_id, step=self.step,
                      task_ceiling=self.task_ceiling, default_estimate=self.default_estimate,
                      on_quota=self.on_quota, averages=self._averages, lock=self._lock, warned=self._warned)
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
        """The PreflightResult when approved (or sent unchecked), else a Refusal."""
        estimate = self.average.estimate(self.default_estimate, _max_tokens(kind, kwargs))
        try:
            result = self.ab.preflight(self.agent_id, estimated_units=estimate, customer_id=self.customer_id,
                                       task_ref=self.task_ref, task_ceiling=self.task_ceiling, unit="token")
        except _REFUSALS as refused:
            # Your spend rule refused the call: preflight() raises, and here
            # the same refusal is a value. Nothing was reserved.
            return self._refusal(refused, estimate)
        if result.approved:
            return result
        # Only AgentBill's own quota comes back unraised. The server answers
        # it before it looks at the job, so this call's ceiling was not
        # checked and nothing was reserved.
        if self.on_quota == "refuse":
            return Refusal(reason=str(result.reason), task_ref=self.task_ref, asked=estimate,
                           upgrade_url=result.upgrade_url, answer=_answer_of(result) or {})
        # on_quota="send": sent unchecked. Once per job, and the job is in the
        # message, so Python's once-per-text warning filter shows it for each.
        key = f"quota:{self.task_ref}"
        with self._lock:
            first = not self._warned.get(key)
            self._warned[key] = True
        if first:
            warnings.warn(
                f"AgentBill preflight answered {result.reason}: this account's monthly preflight quota is spent, "
                f"so no ceiling is checked for job {self.task_ref!r}. Its calls are sent (on_quota=\"send\") and "
                f"recorded, and nothing bounds the job until the quota resets or you upgrade: {result.upgrade_url}",
                RuntimeWarning, stacklevel=4)
        return result

    def _refusal(self, e: Exception, estimate: int) -> Refusal:
        answer = getattr(e, "answer", None)
        answer = answer if isinstance(answer, dict) else {}
        asked = answer.get("estimated_units")
        asked = asked if isinstance(asked, int) and not isinstance(asked, bool) else estimate
        if isinstance(e, TaskCeilingExceededError):
            return Refusal(reason="task_ceiling_exceeded", task_ref=e.task_ref or self.task_ref, asked=asked,
                           used=e.task_used_units, ceiling=e.task_ceiling, remaining=e.task_remaining_units,
                           answer=answer)
        if isinstance(e, CeilingExceededError):
            return Refusal(reason="ceiling_exceeded", task_ref=self.task_ref, asked=asked,
                           ceiling=answer.get("ceiling", self.ab.ceiling), answer=answer)
        return Refusal(reason="budget_exhausted", task_ref=self.task_ref, asked=asked,
                       remaining=answer.get("remaining_units"), answer=answer)

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

        def send(key: str) -> Any:
            return self.ab.record(self.agent_id, units=min(units, _INT4_MAX), customer_id=self.customer_id,
                                  task_ref=self.task_ref, idempotency_key=key,
                                  reservation_id=pre.reservation_id if pre.approved else None,
                                  metadata=metadata, usage_missing=tokens is None)

        key = _idempotency_key(facts.get("id"), self.agent_id, self.endpoint)
        try:
            answer = send(key)
            if isinstance(answer, dict) and answer.get("status") == "duplicate_ignored":
                # wrap() sends each record once, so a duplicate here is another
                # response that carried the same id: a collision, not a retry.
                # Ignored, its usage would never count and its reservation
                # would stay held, so it is recorded again under a key of its own.
                warnings.warn(
                    f"AgentBill already had a record keyed {key!r}, so the provider reused a response id. "
                    f"This call is recorded again under a random key.", RuntimeWarning, stacklevel=4)
                send(_random_key(self.agent_id))
        except Exception as e:  # noqa: BLE001 - the answer is already paid for; never lose it
            warnings.warn(
                f"AgentBill could not record this call ({e}). The response is returned; the call's reservation "
                f"stays held until it expires.", RuntimeWarning, stacklevel=4)
        if tokens is not None:
            self.average.observe(tokens)

    # -- the wrapped method

    def method(self, fn: Callable, kind: str, owner: Any, whole_loop: bool = False, signal: bool = False) -> Callable:
        """fn measured as one model request. whole_loop: fn is a public Gemini
        method measured as a whole because the per-round method behind it was
        not found, so a call that would loop over rounds is refused here.
        signal: fn is the per-round method the provider SDK's own loop calls,
        so a refusal cannot be returned through that loop; it is raised as
        _Refused and the public method's wrapper (see _Wrapped) returns it."""
        is_async = _is_async(fn, owner)
        meter = self

        def refused(pre: Any) -> bool:
            if not isinstance(pre, Refusal):
                return False
            if signal:
                raise _Refused(pre)
            return True

        def prepare(kwargs: Dict[str, Any]) -> Tuple[Dict[str, Any], bool, bool]:
            if whole_loop and _would_loop(kwargs.get("config")):
                raise TypeError(
                    "agentbill.wrap() cannot measure each round of automatic function calling on this client: "
                    "the response carries only the last round's usage. Pass config with "
                    "automatic_function_calling={'disable': True} and run the tool loop yourself, so each "
                    "round is a measured call. The call was not sent.")
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
                if refused(pre):
                    return pre
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
                if refused(pre):
                    return pre
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


def _would_loop(config: Any) -> bool:
    """Whether google-genai would run automatic function calling for this
    config: a tool that is a Python callable (or an MCP session), and AFC not
    turned off. Mirrors _extra_utils.should_disable_afc."""
    afc = _get(config, "automatic_function_calling", "automaticFunctionCalling")
    if _get(afc, "disable") is True:
        return False
    most = _get(afc, "maximum_remote_calls", "maximumRemoteCalls")
    if isinstance(most, int) and not isinstance(most, bool) and most <= 0:
        return False
    tools = _get(config, "tools")
    if not isinstance(tools, (list, tuple)):
        return False
    return any(callable(t) or type(t).__name__ == "ClientSession" for t in tools)


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
    # Every stream wrap() returns has .refusal. It is None here, always: a
    # stream this class wraps was approved before it was sent. Only a Gemini
    # automatic-function-calling stream (_RoundsStream) can be refused later.
    refusal: Optional[Refusal] = None

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

    It is recorded when iteration finishes, when it is closed, when its
    with-block exits, or when a for loop over it stops early (break, return,
    an exception in the loop body): iter() hands out a generator whose finally
    records, and CPython closes an abandoned generator as soon as the loop
    lets go of it. One that ended before its usage arrived is recorded as
    usage missing. Only next() called by hand on a stream that is then
    dropped, without close() or a with-block, is not recorded; its
    reservation stays held until it expires, which keeps the ceiling tighter."""

    _it = None

    def __iter__(self) -> Iterator[Any]:
        try:
            while True:
                try:
                    item = self.__next__()
                except StopIteration:
                    return
                yield item
        finally:
            # A no-op when __next__ already recorded (end, or an error).
            self._finish()

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
    """The async twin of _Stream. An async for that stops early abandons the
    async generator __aiter__ handed out, and the event loop closes it (asyncio
    schedules aclose() for an abandoned one, and asyncio.run closes the rest
    before it returns), which runs its finally and records."""

    _ait = None

    async def __aiter__(self) -> AsyncIterator[Any]:
        try:
            while True:
                try:
                    item = await self.__anext__()
                except StopAsyncIteration:
                    return
                yield item
        finally:
            await self._finish()

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


class _RoundsStream:
    """A Gemini automatic-function-calling stream (the SDK's own generator,
    running over measured per-round methods), primed by one read so a refusal
    of the FIRST round is returned as the Refusal itself, before anything was
    sent. A refusal of a LATER round arrives mid-stream, as _Refused out of
    the generator: the stream ends there, after the earlier round's chunks,
    and .refusal is set. The earlier rounds are recorded."""

    def __init__(self, gen: Iterator[Any], head: Tuple[Any, ...]):
        self._gen, self._head = gen, list(head)
        self.refusal: Optional[Refusal] = None

    @classmethod
    def prime(cls, gen: Iterator[Any]) -> Any:
        try:
            first = next(gen)
        except _Refused as r:
            return r.refusal
        except StopIteration:
            return cls(gen, ())
        return cls(gen, (first,))

    def __iter__(self) -> "_RoundsStream":
        return self

    def __next__(self) -> Any:
        if self._head:
            return self._head.pop(0)
        try:
            return next(self._gen)
        except _Refused as r:
            self.refusal = r.refusal
            raise StopIteration

    def close(self) -> None:
        close = getattr(self._gen, "close", None)
        if callable(close):
            close()

    def __enter__(self) -> "_RoundsStream":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


class _AsyncRoundsStream:
    """The async twin of _RoundsStream."""

    def __init__(self, agen: AsyncIterator[Any], head: Tuple[Any, ...]):
        self._agen, self._head = agen, list(head)
        self.refusal: Optional[Refusal] = None

    @classmethod
    async def prime(cls, agen: AsyncIterator[Any]) -> Any:
        try:
            first = await agen.__anext__()
        except _Refused as r:
            return r.refusal
        except StopAsyncIteration:
            return cls(agen, ())
        return cls(agen, (first,))

    def __aiter__(self) -> "_AsyncRoundsStream":
        return self

    async def __anext__(self) -> Any:
        if self._head:
            return self._head.pop(0)
        try:
            return await self._agen.__anext__()
        except _Refused as r:
            self.refusal = r.refusal
            raise StopAsyncIteration

    async def aclose(self) -> None:
        close = getattr(self._agen, "aclose", None)
        if callable(close):
            await close()

    close = aclose

    async def __aenter__(self) -> "_AsyncRoundsStream":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.aclose()


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
        if meter.provider == "gemini" and name in _GEMINI_ROUNDS and path in methods:
            public = getattr(type(target), name, None)
            if inspect.isfunction(public) and callable(getattr(target, _GEMINI_ROUNDS[name], None)):
                # The public method, run with this wrapped resource as self:
                # each round it sends goes through self._generate_content*,
                # which this proxy measures (see _GEMINI_ROUNDS) and which
                # raises _Refused on a refusal, since the SDK's own loop sits
                # between it and the caller. Caught here and returned. A
                # stream is primed by one read (see _RoundsStream) so a
                # first-round refusal is the Refusal itself.
                resource = self
                streamed = name == "generate_content_stream"

                # Primed through iter()/__aiter__(), never next() on the object:
                # when the SDK hands back the measured round's own stream
                # (automatic function calling off), that is what records it.
                if _is_async(public, target):
                    async def rounds(*args: Any, **kwargs: Any) -> Any:
                        try:
                            out = await public(resource, *args, **kwargs)
                            return await _AsyncRoundsStream.prime(out.__aiter__()) if streamed else out
                        except _Refused as r:
                            return r.refusal
                else:
                    def rounds(*args: Any, **kwargs: Any) -> Any:
                        try:
                            out = public(resource, *args, **kwargs)
                            return _RoundsStream.prime(iter(out)) if streamed else out
                        except _Refused as r:
                            return r.refusal
                rounds.__name__, rounds.__doc__ = name, getattr(public, "__doc__", None)
                rounds.__wrapped__ = attr  # type: ignore[attr-defined]
                return rounds
            return meter.method(attr, methods[path], owner=target, whole_loop=True)
        if path in methods:
            # The per-round methods (a leading underscore) are called by the
            # SDK's own loop, never by the caller: their refusal is a signal.
            return meter.method(attr, methods[path], owner=target, signal=name.startswith("_"))
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
         provider: Optional[str] = None, on_quota: Optional[str] = None) -> T:
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
    on_quota: what a measured call does once this account's monthly preflight
        quota is spent (each measured call is one preflight), when no ceiling
        can be checked. "refuse", the default: the call returns a Refusal with
        reason free_tier_exceeded or plan_limit_exceeded and upgrade_url, and
        is not sent. "send": the call is sent unchecked and recorded, with a
        RuntimeWarning once per job, and nothing bounds the job until the
        quota resets.

    Returns the client, wrapped. The original is untouched and unmeasured.
    Each measured method returns what it always did, or a Refusal (see
    Refusal): check isinstance(reply, Refusal) before reading the response.
    """
    if on_quota is not None and on_quota not in _ON_QUOTA:
        raise ValueError('on_quota is "refuse" or "send".')
    if isinstance(client, _Wrapped):
        target = object.__getattribute__(client, "_agentbill_target")
        base: _Meter = object.__getattribute__(client, "_agentbill_meter")
        if object.__getattribute__(client, "_agentbill_path"):
            raise TypeError("agentbill.wrap() takes the client itself, not one of its resources.")
        if agentbill_client is not None or provider is not None:
            raise TypeError("A wrapped client keeps its AgentBill client and provider; wrap the original to change them.")
        return _Wrapped(target, base.replace(task_ref=task_ref, agent_id=agent_id, step=step,
                                             customer_id=customer_id, task_ceiling=task_ceiling,
                                             default_estimate=default_estimate,
                                             on_quota=on_quota))  # type: ignore[return-value]

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
                   default_estimate=default_estimate or DEFAULT_ESTIMATE, on_quota=on_quota or "refuse",
                   averages={}, lock=threading.Lock(), warned={})
    return _Wrapped(client, meter)  # type: ignore[return-value]
