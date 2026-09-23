#!/usr/bin/env python3
"""Run the framework half of each /integrations/* sample, as served, to a real refusal.

scripts/snippets checks the agentbill half of every sample against the SDK. It
does not install LangChain, the OpenAI Agents SDK or CrewAI, so it cannot see
whether a hook fires before the model call, whether the framework lets our
exception through, or whether it swallows it. CrewAI swallows it: its hooks are
fail-open, and a sample that let TaskCeilingExceededError escape a hook would
have been refused by AgentBill and run anyway. This is the check for that half.

Each scenario fetches its page from BASE, takes the <pre> blocks the page
serves (not a copy kept here), puts a stub model or LLM where the page says
"model", "tools", "agent" or "crew", renames job-142 to a fresh task_ref, gives
that job a ceiling of 50, and runs. With 12 units a call the fifth call is the
one that would pass 50, so every scenario expects four model calls, then the
refusal handed back by the framework, then the server's own record of it:
GET /decisions has the approved:false row, and GET /tasks shows 48 used and
nothing left reserved.

  python samples.py <framework> <scenario>     one scenario, in this interpreter
  run.sh                                       every scenario, each in its own venv and process

Needs BASE (a running AgentBill server) and AGENTBILL_API_KEY for an account on it.
"""
import html
import json
import os
import re
import sys
import urllib.request
import uuid

BASE = os.environ.get("BASE", "http://localhost:3981").rstrip("/")
KEY = os.environ["AGENTBILL_API_KEY"]
CEILING, UNITS, APPROVED = 50, 12, 4  # the fifth call of 12 would pass 50


def api(method, path, body=None):
    req = urllib.request.Request(f"{BASE}{path}", method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        return json.load(r)


def page_blocks(path):
    """The <pre> blocks inside <main>, as a reader would copy them. Lines marked
    as rendered output (class="out-*") are dropped, the same rule as extract.mjs."""
    raw = urllib.request.urlopen(f"{BASE}{path}").read().decode()
    main = raw[raw.index('<main class="container">'):raw.index("</main>")]
    out = []
    for m in re.finditer(r"<pre[^>]*>([\s\S]*?)</pre>", main):
        kept = "\n".join(l for l in m.group(1).split("\n") if 'class="out-' not in l)
        out.append(html.unescape(re.sub(r"<[^>]+>", "", kept)))
    return out


def python_blocks(path):
    return [b for b in page_blocks(path) if re.search(r"^(from|import) \w", b, re.M) or "JOB.set(" in b]


def fresh_job(label):
    ref = f"samples-{label}-{uuid.uuid4().hex[:8]}"
    api("PUT", f"/tasks/{ref}/ceiling", {"ceiling_units": CEILING})
    return ref


def with_job(code, ref):
    assert '"job-142"' in code, "the sample no longer names job-142; update this harness with it"
    return code.replace('"job-142"', f'"{ref}"')


def point_sdk_at_base():
    # The pages construct AgentBillClient(api_key=...) with the default host.
    import agentbill
    agentbill.AgentBillClient.__init__.__defaults__ = (None, BASE)


def server_saw_refusal(ref, agent_id=None):
    d = api("GET", f"/decisions?task_ref={ref}")["decisions"]
    rows = [r for r in d if r["blocked"] and r["response"].get("approved") is False
            and r["reason"] == "task_ceiling_exceeded"]
    assert rows, f"no approved:false row for {ref}: {d}"
    if agent_id:
        assert rows[0]["agent_id"] == agent_id, f"refused agent {rows[0]['agent_id']!r}, expected {agent_id!r}"
    t = api("GET", f"/tasks/{ref}")
    assert (t["used_units"], t["reserved_units"]) == (APPROVED * UNITS, 0), f"task after the run: {t}"
    return rows[0]["response"]


def run(code, ns=None):
    ns = ns if ns is not None else {"__name__": "__sample__"}
    exec(compile(code, "<page sample>", "exec"), ns)
    return ns


# ---------------------------------------------------------------- LangChain
def langchain(scenario):
    import asyncio
    import itertools
    from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
    from langchain_core.messages import AIMessage
    from langchain_core.tools import tool

    calls = {"n": 0}

    class LoopingModel(GenericFakeChatModel):
        """Asks for a tool on every turn, so the agent loops until something refuses."""
        def bind_tools(self, tools, **kw):
            return self

    def replies():
        for i in itertools.count():
            calls["n"] += 1
            yield AIMessage(content="", tool_calls=[{"name": "search", "args": {"q": str(i)}, "id": f"c{i}"}])

    @tool
    def search(q: str) -> str:
        """Search."""
        return "a result"

    point_sdk_at_base()
    from agentbill import TaskCeilingExceededError
    blocks = python_blocks("/integrations/langchain")
    assert len(blocks) == 5, f"expected 5 python blocks on /integrations/langchain, found {len(blocks)}"
    middleware, invoke, finish, asynch, graph = blocks
    ref = fresh_job(f"lc-{scenario}")
    ns = {"__name__": "__sample__", "model": LoopingModel(messages=replies()), "tools": [search]}
    run(middleware, ns)

    if scenario == "raise":
        from io import StringIO
        import contextlib
        buf = StringIO()
        with contextlib.redirect_stdout(buf):
            run(with_job(invoke, ref), ns)
        assert f"{ref} was refused at {APPROVED * UNITS}/{CEILING} units" in buf.getvalue(), buf.getvalue()
    elif scenario == "finish":
        run(finish, ns)
        agent = ns["create_agent"](ns["model"], tools=[search], middleware=[ns["agentbill_ceiling_or_finish"]], context_schema=ns["Job"])
        result = agent.invoke({"messages": [{"role": "user", "content": "go"}]}, context=ns["Job"](task_ref=ref))
        last = result["messages"][-1].content
        assert last == f"Refused at {APPROVED * UNITS}/{CEILING} units for {ref}.", last
    elif scenario == "async":
        run(asynch, ns)
        agent = ns["create_agent"](ns["model"], tools=[search], middleware=[ns["agentbill_ceiling_async"]], context_schema=ns["Job"])
        try:
            asyncio.run(agent.ainvoke({"messages": [{"role": "user", "content": "go"}]}, context=ns["Job"](task_ref=ref)))
            raise AssertionError("ainvoke returned; expected TaskCeilingExceededError")
        except TaskCeilingExceededError:
            pass
    elif scenario == "langgraph":
        run(with_job(graph, ref), ns)  # the block's own invoke is call 1
        for _ in range(APPROVED - 1):
            ns["graph"].invoke({"messages": [{"role": "user", "content": "go"}]}, config={"configurable": {"task_ref": ref}})
        try:
            ns["graph"].invoke({"messages": [{"role": "user", "content": "go"}]}, config={"configurable": {"task_ref": ref}})
            raise AssertionError("graph.invoke returned; expected TaskCeilingExceededError")
        except TaskCeilingExceededError:
            pass
    else:
        raise SystemExit(f"unknown langchain scenario {scenario}")
    assert calls["n"] == APPROVED, f"model calls: {calls['n']}, expected {APPROVED}"
    return ref


# ---------------------------------------------------------------- OpenAI Agents SDK
def openai_agents(scenario):
    import agents
    from agents import function_tool
    from agents.items import ModelResponse
    from agents.models.interface import Model
    from agents.usage import Usage
    from openai.types.responses import ResponseFunctionToolCall

    agents.set_tracing_disabled(True)  # nothing here should reach OpenAI
    calls = {}

    class StubModel(Model):
        """Answers every turn with one function call, so the run loops."""
        def __init__(self, name, tool_name):
            self.name, self.tool_name = name, tool_name

        async def get_response(self, *a, **k):
            calls[self.name] = calls.get(self.name, 0) + 1
            n = sum(calls.values())
            return ModelResponse(output=[ResponseFunctionToolCall(type="function_call", name=self.tool_name, arguments="{}",
                                                                  call_id=f"c{n}", id=f"fc{n}")],
                                 usage=Usage(), response_id=None)

        def stream_response(self, *a, **k):
            raise NotImplementedError

    @function_tool
    def search() -> str:
        """Search."""
        return "a result"

    # The page builds Agent(name=..., instructions=..., tools=tools) with the
    # default model. Here the default is the stub.
    real_agent = agents.Agent
    agents.Agent = lambda *a, **k: real_agent(*a, **{"model": StubModel(k.get("name", "agent"), "search"), **k})

    point_sdk_at_base()
    blocks = python_blocks("/integrations/openai-agents-sdk")
    assert len(blocks) == 2, f"expected 2 python blocks on /integrations/openai-agents-sdk, found {len(blocks)}"
    hooks, runner = blocks
    ref = fresh_job(f"oa-{scenario}")
    ns = run(hooks, {"__name__": "__sample__", "tools": [search]})

    if scenario == "raise":
        from io import StringIO
        import contextlib
        buf = StringIO()
        with contextlib.redirect_stdout(buf):
            run(with_job(runner, ref), ns)
        assert f"{ref} was refused at {APPROVED * UNITS}/{CEILING} units" in buf.getvalue(), buf.getvalue()
        assert sum(calls.values()) == APPROVED, calls
        server_saw_refusal(ref, "researcher")
    elif scenario == "handoff":
        import asyncio
        from agentbill import TaskCeilingExceededError
        writer = real_agent(name="writer", tools=[search], model=StubModel("writer", "search"))
        triage = real_agent(name="triage", handoffs=[writer], model=StubModel("triage", "transfer_to_writer"))
        try:
            asyncio.run(agents.Runner.run(triage, "go", hooks=ns["AgentBillCeiling"](ref)))
            raise AssertionError("Runner.run returned; expected TaskCeilingExceededError")
        except TaskCeilingExceededError:
            pass
        # The triage call counted against the job, and the writer it handed off
        # to asked the same ceiling: it is the one refused, one call early.
        assert calls == {"triage": 1, "writer": APPROVED - 1}, calls
        server_saw_refusal(ref, "writer")
    else:
        raise SystemExit(f"unknown openai-agents scenario {scenario}")
    return ref


# ---------------------------------------------------------------- CrewAI
def crewai(scenario):
    os.environ.setdefault("CREWAI_TELEMETRY_OPT_OUT", "true")
    os.environ.setdefault("OTEL_SDK_DISABLED", "true")
    from crewai import Agent, BaseLLM, Crew, Task
    from crewai.tools import tool

    calls = {"n": 0}

    class LoopingLLM(BaseLLM):
        """Asks for a tool in every answer, so the agent loops until something refuses."""
        def call(self, messages, tools=None, callbacks=None, available_functions=None,
                 from_task=None, from_agent=None, response_model=None, **kw):
            calls["n"] += 1
            return 'Thought: I need more.\nAction: search\nAction Input: {"q": "more"}'

        def supports_function_calling(self):
            return False

    @tool("search")
    def search(q: str) -> str:
        """Search the web."""
        return "a result"

    def make_crew(max_iter=40):
        a = Agent(role="researcher", goal="Research", backstory="Researches.", llm=LoopingLLM(model="stub"),
                  tools=[search], max_iter=max_iter, verbose=False)
        return Crew(agents=[a], tasks=[Task(description="Research.", expected_output="A summary.", agent=a)], verbose=False)

    blocks = python_blocks("/integrations/crewai")
    assert len(blocks) == 2, f"expected 2 python blocks on /integrations/crewai, found {len(blocks)}"
    hooks, kickoff = blocks

    if scenario == "unreachable":
        # AgentBill down: the hook's network error is an ordinary exception, and
        # CrewAI makes the call anyway. The page says so; this is the proof.
        import agentbill
        agentbill.AgentBillClient.__init__.__defaults__ = (None, "http://127.0.0.1:9")
        ns = run(hooks, {"__name__": "__sample__"})
        ns["JOB"].set("samples-unreachable")
        try:
            make_crew(max_iter=2).kickoff()
        except Exception:
            pass
        assert calls["n"] >= 1, "no model call was made while AgentBill was unreachable"
        return None

    point_sdk_at_base()
    from agentbill import TaskCeilingExceededError
    from crewai.hooks import HookAborted
    ref = fresh_job(f"cr-{scenario}")

    if scenario == "raise":
        from io import StringIO
        import contextlib
        ns = run(hooks, {"__name__": "__sample__", "crew": make_crew()})
        buf = StringIO()
        with contextlib.redirect_stdout(buf):
            run(with_job(kickoff, ref), ns)
        assert f"Refused (task_ceiling_exceeded): task '{ref}' is at {APPROVED * UNITS}/{CEILING} units" in buf.getvalue(), buf.getvalue()
    elif scenario == "cause":
        ns = run(hooks, {"__name__": "__sample__"})
        ns["JOB"].set(ref)
        try:
            make_crew().kickoff()
            raise AssertionError("kickoff returned; expected HookAborted")
        except HookAborted as e:
            assert isinstance(e.__cause__, TaskCeilingExceededError), repr(e.__cause__)
            assert e.__cause__.task_used_units == APPROVED * UNITS, e.__cause__.task_used_units
    elif scenario == "no-job":
        ns = run(hooks, {"__name__": "__sample__"})
        try:
            make_crew().kickoff()
            raise AssertionError("kickoff returned with no job set; expected HookAborted")
        except HookAborted as e:
            assert "no AgentBill task_ref" in e.reason, e.reason
        assert calls["n"] == 0, f"model calls with no job set: {calls['n']}"
        return None
    elif scenario == "naive":
        # The version of the hook the page warns against: the refusal left to
        # escape. CrewAI swallows it and keeps calling the model past the ceiling.
        naive = hooks.replace(
            "    try:\n        client.preflight(agent_id=role, task_ref=job, estimated_units=UNITS)\n"
            "    except TaskCeilingExceededError as e:\n        raise HookAborted(reason=str(e), source=\"agentbill\") from e\n",
            "    client.preflight(agent_id=role, task_ref=job, estimated_units=UNITS)\n")
        assert naive != hooks, "the page's hook no longer has the try/except this scenario removes"
        ns = run(naive, {"__name__": "__sample__"})
        ns["JOB"].set(ref)
        try:
            make_crew(max_iter=8).kickoff()
        except Exception:
            pass
        assert calls["n"] > APPROVED, f"model calls {calls['n']}: the swallowed refusal did not let calls through"
        return ref
    else:
        raise SystemExit(f"unknown crewai scenario {scenario}")
    assert calls["n"] == APPROVED, f"model calls: {calls['n']}, expected {APPROVED}"
    return ref


# ---------------------------------------------------------------- MCP
def mcp(scenario):
    """The MCP page's claim: record_event cannot settle a task reservation, and
    the page's own POST /events body, with the job's task_ref, does."""
    os.environ["AGENTBILL_BASE_URL"] = BASE
    from agentbill_mcp import server as s
    ref = fresh_job("mcp")
    body = next(b for b in page_blocks("/integrations/mcp") if "POST https://agentbill.dev/events" in b)
    payload = json.loads(re.search(r"-d '(\{.*\})'", body).group(1))
    assert s.preflight(agent_id="researcher", estimated_units=UNITS, task_ref=ref)["approved"] is True
    s.record_event(agent_id="researcher", units=UNITS)
    t = api("GET", f"/tasks/{ref}")
    assert (t["used_units"], t["reserved_units"]) == (0, UNITS), f"record_event settled a task reservation: {t}"
    payload = {**payload, "task_ref": ref, "idempotency_key": f"{ref}-settle", "units": UNITS}
    api("POST", "/events", payload)
    t = api("GET", f"/tasks/{ref}")
    assert (t["used_units"], t["reserved_units"]) == (UNITS, 0), f"POST /events did not settle: {t}"
    return None


SCENARIOS = {
    "langchain": ["raise", "finish", "async", "langgraph"],
    "openai-agents": ["raise", "handoff"],
    "crewai": ["raise", "cause", "no-job", "naive", "unreachable"],
    "mcp": ["settle"],
}

if __name__ == "__main__":
    framework, scenario = sys.argv[1], sys.argv[2]
    ref = {"langchain": langchain, "openai-agents": openai_agents, "crewai": crewai, "mcp": mcp}[framework](scenario)
    if ref and not (framework == "crewai" and scenario == "naive"):
        server_saw_refusal(ref)
    print(f"ok {framework} {scenario}{f' ({ref})' if ref else ''}")
