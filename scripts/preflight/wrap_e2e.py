#!/usr/bin/env python3
"""The Python wrap() against a real AgentBill server, with fake provider clients.

Run by scripts/preflight/verify.mjs ([wrap] gates), which starts the server,
mints the key and reads this script's one line of JSON output. The fakes are
shaped like the provider SDKs' responses; everything on the AgentBill side is
real: the preflight that refuses, the record that settles, the price the
server computes, the breakdown GET /tasks/:task_ref returns.

  AGENTBILL_BASE_URL=http://localhost:3976 AGENTBILL_API_KEY=agb_... \
    PYTHONPATH=sdk/python python3 scripts/preflight/wrap_e2e.py <job suffix>

Scenario A, sync Anthropic, loop until refused. Ceiling 4,000 tokens, opened
by the first call. Every call uses 700 input + 100 cache read + 200 cache
write + 300 output = 1,300 tokens, with max_tokens 400 and default_estimate
1,000, so the estimates are 400 (min(1000, 0 + 400)), then 1,300 (the mean,
under 1,000 + 400), and the fourth call (3,900 + 1,300 > 4,000) is refused
before the fake is called: three calls sent.

Scenario B, async OpenAI stream on a second job: include_usage is turned on
for the caller, the usage-only chunk is hidden, and the call is recorded.

Scenario C, the account's own monthly quota spent (the key in
AGENTBILL_QUOTA_KEY belongs to an account verify.mjs planted at 1,000 of
1,000): wrap() raises FreeTierExceededError and the fake is sent nothing.

Scenario D, a sync stream whose for loop breaks, with no close() and no
with-block: it is recorded (usage missing) and nothing stays reserved.

Scenario E, an OpenAI-compatible endpoint that returns one response id for
every call: three calls, three records.

Scenario F, a google-genai-shaped Models whose generate_content runs three
rounds of automatic function calling: each round is preflighted and recorded.
"""
import asyncio
import json
import os
import sys
from types import SimpleNamespace as NS

import agentbill
from agentbill import AgentBillClient, FreeTierExceededError, TaskCeilingExceededError

suffix = sys.argv[1] if len(sys.argv) > 1 else "x"
out = {}


class FakeAnthropic:
    def __init__(self):
        self.sent = 0
        outer = self

        class Messages:
            def create(self, **kw):
                outer.sent += 1
                usage = NS(input_tokens=700, output_tokens=300, cache_read_input_tokens=100,
                           cache_creation_input_tokens=200, service_tier="standard")
                return NS(id=f"msg_e2e_{suffix}_{outer.sent}", model="claude-sonnet-4-5-20250929", usage=usage,
                          content=[NS(type="text", text="ok")])

        self.messages = Messages()
        self.base_url = "https://api.anthropic.com"


ant = FakeAnthropic()
llm = agentbill.wrap(ant, task_ref=f"wrap-py-{suffix}", agent_id="py-e2e", step="draft",
                     task_ceiling=4000, default_estimate=1000)
refused = None
for i in range(10):
    try:
        llm.messages.create(model="claude-sonnet-4-5", max_tokens=400, messages=[{"role": "user", "content": "x"}])
    except TaskCeilingExceededError as e:
        refused = {"at_call": i + 1, "remaining": e.task_remaining_units, "used": e.task_used_units}
        break
out["sync"] = {"sent": ant.sent, "refused": refused}


class AsyncStream:
    def __init__(self, items):
        self.items = items

    async def __aiter__(self):
        for i in self.items:
            yield i


def chunk(text=None, usage=None):
    return NS(id=f"chatcmpl-e2e-{suffix}", model="gpt-4o-mini-2024-07-18", service_tier="default",
              choices=[] if text is None else [NS(delta=NS(content=text))], usage=usage)


class AsyncCompletions:
    def __init__(self):
        self.kwargs = None

    async def create(self, **kw):
        self.kwargs = kw
        items = [chunk("he"), chunk("llo")]
        if (kw.get("stream_options") or {}).get("include_usage"):
            items.append(chunk(None, NS(prompt_tokens=60, completion_tokens=9,
                                         prompt_tokens_details=NS(cached_tokens=0),
                                         completion_tokens_details=NS(reasoning_tokens=0))))
        return AsyncStream(items)


class FakeAsyncOpenAI:
    def __init__(self):
        self.chat = NS(completions=AsyncCompletions())
        self.base_url = "https://api.openai.com/v1/"


async def scenario_b():
    oa = FakeAsyncOpenAI()
    alm = agentbill.wrap(oa, task_ref=f"wrap-py-stream-{suffix}", agent_id="py-e2e", task_ceiling=10_000)
    stream = await alm.chat.completions.create(model="gpt-4o-mini", messages=[], stream=True)
    texts = [c.choices[0].delta.content async for c in stream]
    return {"texts": texts, "include_usage": (oa.chat.completions.kwargs.get("stream_options") or {}).get("include_usage")}


out["async_stream"] = asyncio.run(scenario_b())


# ---- C: the quota spent
quota_key = os.environ.get("AGENTBILL_QUOTA_KEY")
if quota_key:
    qa = FakeAnthropic()
    qc = AgentBillClient(api_key=quota_key, base_url=os.environ["AGENTBILL_BASE_URL"])
    ql = agentbill.wrap(qa, task_ref=f"wrap-py-quota-{suffix}", agent_id="py-e2e", agentbill_client=qc)
    try:
        ql.messages.create(model="claude-sonnet-4-5", max_tokens=400, messages=[])
        out["quota"] = {"raised": None, "sent": qa.sent}
    except FreeTierExceededError as e:
        out["quota"] = {"raised": type(e).__name__, "upgrade_url": e.upgrade_url, "sent": qa.sent}


# ---- D: a for loop that breaks
class SyncStream:
    def __init__(self, items):
        self.items = items

    def __iter__(self):
        return iter(self.items)


class BreakCompletions:
    def create(self, **kw):
        return SyncStream([chunk("a"), chunk("b"), chunk(None, NS(prompt_tokens=30, completion_tokens=3))])


dl = agentbill.wrap(NS(chat=NS(completions=BreakCompletions()), base_url="https://api.openai.com/v1/"),
                    task_ref=f"wrap-py-break-{suffix}", agent_id="py-e2e", task_ceiling=10_000, default_estimate=700,
                    provider="openai")
for c in dl.chat.completions.create(model="gpt-4o-mini", messages=[], stream=True):
    break


# ---- E: a compatible endpoint with one id for every call
class SameIdCompletions:
    def __init__(self):
        self.sent = 0

    def create(self, **kw):
        self.sent += 1
        return NS(id="chatcmpl-7", model="llama3", choices=[], usage=NS(prompt_tokens=1000, completion_tokens=200))


same = SameIdCompletions()
el = agentbill.wrap(NS(chat=NS(completions=same), base_url="http://localhost:11434/v1/"),
                    task_ref=f"wrap-py-compatible-{suffix}", agent_id="py-e2e", task_ceiling=50_000, provider="openai")
for _ in range(3):
    el.chat.completions.create(model="llama3", messages=[])
out["compatible"] = {"sent": same.sent}


# ---- F: google-genai-shaped automatic function calling
class LoopingModels:
    def __init__(self):
        self.sent = 0

    def _generate_content(self, *, model, contents, config=None):
        i = self.sent
        self.sent += 1
        return NS(response_id=f"gem-py-afc-{suffix}-{i}", model_version="gemini-2.5-flash", calls_tool=i < 2,
                  usage_metadata=NS(prompt_token_count=1000 + 100 * i, candidates_token_count=50))

    def generate_content(self, *, model, contents, config=None):
        r = None
        for _ in range(3):
            r = self._generate_content(model=model, contents=contents, config=config)
            if not r.calls_tool:
                break
        return r


gm = LoopingModels()
fl = agentbill.wrap(NS(models=gm), task_ref=f"wrap-py-afc-{suffix}", agent_id="py-e2e", task_ceiling=50_000,
                    provider="gemini")
last = fl.models.generate_content(model="gemini-2.5-flash", contents="x")
out["afc"] = {"sent": gm.sent, "last": last.response_id}
print(json.dumps(out))
