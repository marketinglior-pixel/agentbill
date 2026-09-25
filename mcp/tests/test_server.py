"""Unit tests for the MCP server. No network: httpx is given a MockTransport.

Run: pip install -e "mcp[dev]" && python -m pytest mcp/tests -q
"""

from __future__ import annotations

import json

import httpx
import pytest
from mcp.server.fastmcp import FastMCP

from agentbill_mcp import server

HTTP_ENV = (
    "AGENTBILL_MCP_HOST",
    "AGENTBILL_MCP_PORT",
    "AGENTBILL_MCP_ALLOWED_HOSTS",
    "AGENTBILL_MCP_ALLOWED_ORIGINS",
)


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("AGENTBILL_API_KEY", "agb_test")
    for name in HTTP_ENV:
        monkeypatch.delenv(name, raising=False)


def _answer(monkeypatch, status: int, body):
    """Make every httpx.Client in server.py answer `status` with `body`."""
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(status, content=json.dumps(body).encode(),
                              headers={"content-type": "application/json"})

    real_client = httpx.Client

    def fake_client(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real_client(*args, **kwargs)

    monkeypatch.setattr(server.httpx, "Client", fake_client)
    return seen


# preflight: approved only on an explicit true -------------------------------

def test_preflight_200_without_approved_is_not_approved(monkeypatch):
    seen = _answer(monkeypatch, 200, {"remaining_units": 50})
    result = server.preflight(agent_id="a", estimated_units=1)
    assert len(seen) == 1
    assert result["approved"] is False


@pytest.mark.parametrize("value", ["true", 1, "yes", None])
def test_preflight_truthy_non_boolean_is_not_approved(monkeypatch, value):
    _answer(monkeypatch, 200, {"approved": value, "remaining_units": 50})
    assert server.preflight(agent_id="a")["approved"] is False


def test_preflight_non_object_body_is_not_approved(monkeypatch):
    _answer(monkeypatch, 200, ["approved"])
    assert server.preflight(agent_id="a")["approved"] is False


def test_preflight_explicit_true_is_approved(monkeypatch):
    _answer(monkeypatch, 200, {"approved": True, "remaining_units": 49, "estimated_units": 1})
    result = server.preflight(agent_id="a")
    assert result == {"approved": True, "remaining_units": 49, "estimated_units": 1}


def test_preflight_explicit_refusal_keeps_its_reason(monkeypatch):
    _answer(monkeypatch, 200, {"approved": False, "reason": "budget_exhausted", "remaining_units": 0})
    result = server.preflight(agent_id="a")
    assert result["approved"] is False
    assert result["reason"] == "budget_exhausted"


# HTTP mode: loopback bind, DNS-rebinding protection on ----------------------

def test_http_defaults_bind_loopback_with_rebinding_protection():
    s = server.configure_http(FastMCP("t"), env={})
    assert s.settings.host == "127.0.0.1"
    assert s.settings.port == 8080
    ts = s.settings.transport_security
    assert ts is not None
    assert ts.enable_dns_rebinding_protection is True
    assert "127.0.0.1:*" in ts.allowed_hosts
    assert all(h.startswith(("127.0.0.1", "localhost", "[::1]")) for h in ts.allowed_hosts)


def test_main_http_mode_applies_the_safe_defaults(monkeypatch):
    monkeypatch.setenv("MCP_TRANSPORT", "http")
    ran = {}

    def fake_run(transport="stdio", **kwargs):
        ran["transport"] = transport
        ran["host"] = server.mcp.settings.host
        ran["port"] = server.mcp.settings.port
        ran["protection"] = server.mcp.settings.transport_security.enable_dns_rebinding_protection

    monkeypatch.setattr(server.mcp, "run", fake_run)
    server.main()
    assert ran == {"transport": "streamable-http", "host": "127.0.0.1", "port": 8080, "protection": True}


def test_http_override_is_explicit_and_keeps_protection_on():
    env = {
        "AGENTBILL_MCP_HOST": "0.0.0.0",
        "AGENTBILL_MCP_PORT": "9000",
        "AGENTBILL_MCP_ALLOWED_HOSTS": "mcp.example.com, 10.0.0.5:*",
        "AGENTBILL_MCP_ALLOWED_ORIGINS": "https://app.example.com",
    }
    s = server.configure_http(FastMCP("t"), env=env)
    ts = s.settings.transport_security
    assert (s.settings.host, s.settings.port) == ("0.0.0.0", 9000)
    assert ts.enable_dns_rebinding_protection is True
    assert "mcp.example.com" in ts.allowed_hosts and "10.0.0.5:*" in ts.allowed_hosts
    assert "https://app.example.com" in ts.allowed_origins


def test_http_app_refuses_a_foreign_host_header():
    from starlette.testclient import TestClient

    app = server.configure_http(FastMCP("t"), env={}).streamable_http_app()
    body = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                       "clientInfo": {"name": "t", "version": "0"}}}
    headers = {"content-type": "application/json",
               "accept": "application/json, text/event-stream"}
    with TestClient(app) as client:
        evil = client.post("/mcp", json=body, headers={**headers, "host": "evil.example"})
        assert evil.status_code == 421
        bad_origin = client.post("/mcp", json=body,
                                 headers={**headers, "host": "127.0.0.1:8080", "origin": "https://evil.example"})
        assert bad_origin.status_code == 403
        local = client.post("/mcp", json=body, headers={**headers, "host": "127.0.0.1:8080"})
        assert local.status_code == 200
