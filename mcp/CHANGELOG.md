# Changelog: agentbill-mcp

Versions published to PyPI as `agentbill-mcp`. Earlier releases are described
in the commit history of this repository.

## 0.3.0 (unreleased)

### Breaking

- **HTTP mode (`MCP_TRANSPORT=http`) binds `127.0.0.1:8080` with DNS-rebinding
  protection on.** 0.2.2 bound `0.0.0.0` with the protection off, so any web
  page open in a browser on the same machine could drive the tools with the
  API key in the server's environment. Requests with a `Host` header outside
  the allowed list are answered with 421. To serve on another interface, set
  `AGENTBILL_MCP_HOST` and name the host names clients use in
  `AGENTBILL_MCP_ALLOWED_HOSTS` (and `AGENTBILL_MCP_ALLOWED_ORIGINS` for
  browser origins). `AGENTBILL_MCP_PORT` sets the port. There is no setting
  that turns the checks off. stdio mode, the default, is unchanged.
- **`preflight` approves only on an explicit JSON `true`.** 0.2.2 read an
  answer without `approved` (a proxy page, a truncated body) as approved. Any
  other value, or a body that is not an object, now returns
  `approved: False`.
- The `mcp` dependency floor is now `>=1.10.0,<2` (was `>=1.0.0,<2`): HTTP
  mode needs `TransportSecuritySettings`, added in 1.10.0.

### Changed

- The README and `server.json` point at the remote server,
  `https://agentbill.dev/mcp` (OAuth sign-in, or an API key as
  `Authorization: Bearer`), and at the setup page,
  `https://agentbill.dev/integrations/mcp`. This package remains the local
  stdio server.
- The server instructions and the `preflight` tool description say what the
  product does (one spend ceiling per agent job) instead of "billing
  infrastructure": `record_event` records what the work used against the
  customer's balance.
