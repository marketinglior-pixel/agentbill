#!/usr/bin/env python3
"""Prove every published Python sample is honest about the SDK it documents.

Two layers, both hermetic:
  1. Contract: every `from agentbill import X` exists; every call to an SDK
     class, method or decorator binds to its real inspect.signature (this is
     the check that would have caught preflight(budget=5.00)); attributes read
     from SDK result objects exist on that dataclass.
  2. Execution: blocks that are self-contained run for real with the network
     stubbed. An exception raised by the SDK itself is the documented outcome
     and passes; TypeError / AttributeError / ImportError in the block fails.
     Any attempt to open a real socket fails the block.
"""
import ast, asyncio, builtins, inspect, json, os, re, signal, socket, sys, types, typing

# The inventory is produced by extract.mjs from tracked repo files and must live
# inside this harness's work dir; nothing else is accepted as input. The blocks
# it contains are executed on purpose: that is what a sample runner does.
_WORK = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.work')
_inv = os.path.realpath(sys.argv[1])
if os.path.commonpath([_inv, _WORK]) != _WORK:
    sys.exit(f"refusing inventory outside {_WORK}: {_inv}")
inventory = json.load(open(_inv))
import agentbill  # noqa: E402

failures, warnings, checked = [], [], 0
SDK_CLASSES = {n: getattr(agentbill, n) for n in dir(agentbill) if inspect.isclass(getattr(agentbill, n))}
SDK_FUNCS = {n: getattr(agentbill, n) for n in dir(agentbill) if inspect.isfunction(getattr(agentbill, n))}
# Public methods of the client: a call to one of these on a receiver the block
# never binds (`client` made on an earlier block of the same page) is still a
# call on AgentBillClient and is checked as one.
CLIENT_METHODS = {n for n, v in vars(agentbill.AgentBillClient).items() if not n.startswith('_') and callable(v)}

def fail(s, msg): failures.append(f"{s['source']}:{s['line']} (block {s['index']}) {msg}")
def warn(s, msg): warnings.append(f"{s['source']}:{s['line']} (block {s['index']}) {msg}")

def bind(s, fn, call, label, self_placeholder=False):
    """Bind the call's arguments to fn's real signature; report a TypeError."""
    if any(isinstance(a, ast.Starred) for a in call.args) or any(k.arg is None for k in call.keywords):
        return
    args = [object()] * len(call.args)
    if self_placeholder:
        args = [object()] + args
    kwargs = {k.arg: object() for k in call.keywords}
    try:
        inspect.signature(fn).bind(*args, **kwargs)
    except TypeError as e:
        fail(s, f"{label}: {e}")

def return_type(fn):
    try:
        return typing.get_type_hints(fn).get('return')
    except Exception:
        return None

def instance_attrs(cls):
    """Names an instance can carry: class attributes, dataclass fields, and
    every `self.<x> =` in an __init__ up the MRO (exception classes)."""
    names = set(dir(cls)) | set(getattr(cls, '__dataclass_fields__', {}))
    for k in cls.__mro__:
        init = k.__dict__.get('__init__')
        if init is None:
            continue
        try:
            names |= set(re.findall(r'\bself\.(\w+)\s*=', inspect.getsource(init)))
        except (OSError, TypeError):
            pass
    return names

def contract(s, tree):
    var_types = {}   # variable name -> SDK class or result dataclass
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            tops = [a.name.split('.')[0] for a in node.names] if isinstance(node, ast.Import) else [(node.module or '').split('.')[0]]
            for top in tops:
                # agentbill_sdk / agent_bill: the PyPI name is agentbill-sdk, the module is agentbill
                if re.fullmatch(r'agent[-_]?bill\w*', top) and top != 'agentbill':
                    fail(s, f"imports `{top}`: the module is `agentbill` (pip install agentbill-sdk)")
        if isinstance(node, ast.ImportFrom) and node.module and node.module.split('.')[0] == 'agentbill':
            mod = __import__(node.module, fromlist=['*'])
            for a in node.names:
                if a.name != '*' and not hasattr(mod, a.name):
                    fail(s, f"`from {node.module} import {a.name}`: {node.module} has no `{a.name}`")
    # statement order matters for variable typing, so walk the body in order
    def visit_call(call):
        f = call.func
        if isinstance(f, ast.Name) and f.id in SDK_CLASSES:
            bind(s, SDK_CLASSES[f.id], call, f"{f.id}(...)")
            return SDK_CLASSES[f.id]
        if isinstance(f, ast.Name) and f.id in SDK_FUNCS:
            bind(s, SDK_FUNCS[f.id], call, f"{f.id}(...)")
            return None
        if isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name) and f.value.id in var_types:
            cls = var_types[f.value.id]
            if not inspect.isclass(cls):
                return None
            if not hasattr(cls, f.attr):
                fail(s, f"`{f.value.id}.{f.attr}(...)`: {cls.__name__} has no method `{f.attr}`")
                return None
            method = getattr(cls, f.attr)
            bind(s, method, call, f"{cls.__name__}.{f.attr}(...)", self_placeholder=True)
            return return_type(method)
        if isinstance(f, ast.Attribute) and (f.attr in CLIENT_METHODS or (isinstance(f.value, ast.Name) and f.value.id == 'client')):
            # `client` bound on an earlier block of the same page (or self.client)
            # is still an AgentBillClient: this is the check that would have
            # caught client.preflight(budget=2.00) on a page-level client.
            if not hasattr(agentbill.AgentBillClient, f.attr):
                fail(s, f"`client.{f.attr}(...)`: AgentBillClient has no method `{f.attr}`")
                return None
            method = getattr(agentbill.AgentBillClient, f.attr)
            bind(s, method, call, f"AgentBillClient.{f.attr}(...)", self_placeholder=True)
            return return_type(method)
        return None

    class V(ast.NodeVisitor):
        def visit_Assign(self, node):
            t = visit_call(node.value) if isinstance(node.value, ast.Call) else None
            if t is not None and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
                var_types[node.targets[0].id] = t
            self.generic_visit(node.value)
        def visit_Call(self, node):
            visit_call(node)
            self.generic_visit(node)
        # (no visit_FunctionDef: generic_visit already reaches decorator calls;
        #  an override made every decorator failure print twice)
        def visit_ExceptHandler(self, node):
            if node.name and isinstance(node.type, ast.Name) and node.type.id in SDK_CLASSES:
                var_types[node.name] = SDK_CLASSES[node.type.id]
            self.generic_visit(node)
        def visit_Attribute(self, node):
            if isinstance(node.value, ast.Name) and node.value.id in var_types and isinstance(node.ctx, ast.Load):
                t = var_types[node.value.id]
                if inspect.isclass(t) and (hasattr(t, '__dataclass_fields__') or issubclass(t, BaseException)):
                    if node.attr not in instance_attrs(t):
                        fail(s, f"`{node.value.id}.{node.attr}`: {t.__name__} has no field `{node.attr}`")
            self.generic_visit(node)
    V().visit(tree)

# ---------------------------------------------------------------- execution
CANNED = {
    '/preflight': {"approved": True, "reason": None, "estimated_units": 1, "remaining_units": 999,
                   "task_ref": "job-142", "task_remaining_units": 488},
    '/events': {"event_id": "evt_ci", "status": "recorded", "customer_created": False,
                "customer_remaining_units": 999, "task_used_units": 12, "task_remaining_units": 488, "task_exceeded": False},
    '/budget': {"customer_id": "default", "limit": 1000, "used": 1, "remaining": 999, "is_blocked": False},
    '/tasks': {"task_ref": "job-142", "agent_id": "researcher", "ceiling_units": 500, "used_units": 12,
               "reserved_units": 0, "remaining_units": 488, "exceeded": False},
    '/step': {"recorded": True, "anomaly": False, "baseline_units": None, "deviation_pct": None},
    '/checkpoint': {"approved": True, "reason": None, "units_so_far": 1, "remaining_units": 999},
}
class FakeResponse:
    status_code = 200
    def __init__(self, url):
        path = '/' + url.split('//', 1)[-1].split('/', 1)[-1].split('?')[0]
        key = next((k for k in CANNED if path.startswith(k)), '/preflight')
        self._data = CANNED[key]
        self.text = json.dumps(self._data)
    def json(self): return self._data
    def raise_for_status(self): pass
    @property
    def is_success(self): return True

def stub_network():
    import requests
    requests.post = lambda url, *a, **k: FakeResponse(url)
    requests.get = lambda url, *a, **k: FakeResponse(url)
    try:
        import httpx
        httpx.post = lambda url, *a, **k: FakeResponse(url)
        httpx.get = lambda url, *a, **k: FakeResponse(url)
        httpx.Client.post = lambda self, url, *a, **k: FakeResponse(url)
        httpx.Client.get = lambda self, url, *a, **k: FakeResponse(url)
        async def apost(self, url, *a, **k): return FakeResponse(url)
        httpx.AsyncClient.post = apost
        httpx.AsyncClient.get = apost
    except ImportError:
        pass
    def no_socket(*a, **k): raise RuntimeError("snippet tried to open a real network socket")
    # Block connections, not the socket class: asyncio's event loop needs
    # socket.socketpair() for its self-pipe and would die under a class patch.
    socket.socket.connect = no_socket
    socket.socket.connect_ex = no_socket
    socket.create_connection = no_socket

def free_names(tree):
    """Names loaded but never bound in the block (a fragment of a larger page)."""
    bound = set(dir(builtins))
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            for a in node.names: bound.add((a.asname or a.name).split('.')[0])
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            bound.add(node.name)
            if hasattr(node, 'args'):
                for a in node.args.args + node.args.kwonlyargs + getattr(node.args, 'posonlyargs', []): bound.add(a.arg)
                if node.args.vararg: bound.add(node.args.vararg.arg)
                if node.args.kwarg: bound.add(node.args.kwarg.arg)
        elif isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            bound.add(node.id)
        elif isinstance(node, ast.ExceptHandler) and node.name:
            bound.add(node.name)
        elif isinstance(node, ast.arg):
            bound.add(node.arg)
    return sorted({n.id for n in ast.walk(tree) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load) and n.id not in bound})

def execute(s, tree):
    free = free_names(tree)
    if free:
        warn(s, f"fragment, not executed (unbound: {', '.join(free[:5])})")
        return
    g = {'__name__': '__snippet__'}
    import contextlib, io
    def _timeout(*_): raise TimeoutError("timed out after 30s")
    signal.signal(signal.SIGALRM, _timeout); signal.alarm(30)
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            code = compile(tree, f"{s['source']}#{s['index']}", 'exec', flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
            r = eval(code, g)
            if inspect.iscoroutine(r):   # the block used top-level await
                asyncio.run(r)
    except Exception as e:  # noqa: BLE001
        mod = type(e).__module__ or ''
        if mod.startswith('agentbill'):
            return  # a block the SDK refused on purpose: that is the documented behaviour
        if isinstance(e, ImportError) and 'agentbill' not in str(e):
            warn(s, f"needs a third-party package, not executed: {e}")
            return
        fail(s, f"execution: {type(e).__name__}: {e}")
    finally:
        signal.alarm(0)

stub_network()
for s in inventory:
    if s['kind'] != 'python':
        continue
    checked += 1
    try:
        tree = ast.parse(s['code'])
    except SyntaxError as e:
        fail(s, f"does not parse: {e.msg} (line {e.lineno})")
        continue
    contract(s, tree)
    execute(s, tree)

print(f"python: {checked} blocks checked, {len(failures)} failures, {len(warnings)} warnings")
for w in warnings: print("  warn:", w)
for f in failures: print("  FAIL:", f)
sys.exit(1 if failures else 0)
