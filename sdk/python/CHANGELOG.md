# Changelog: agentbill-sdk

Versions published to PyPI as `agentbill-sdk`. Earlier releases are described
in the commit history of this repository.

## 0.8.0 (unreleased)

### Breaking

- **The base URL must be `https`.** Plain `http` is accepted only for
  `localhost`, `127.0.0.1` and `[::1]` (any port). Any other value raises
  `AgentBillError` before a request is sent, because every request carries
  your API key: `AgentBillClient(base_url=...)` raises when the client is made
  (and when `base_url` is assigned), `wrap()` when it is called without
  `agentbill_client`, and `@meter` on each request. If you set
  `AGENTBILL_BASE_URL` to plain `http` on a host other than this machine,
  switch it to `https` before upgrading. The default, `https://agentbill.dev`,
  is unaffected.
- **`approved` is `True` only when the server's answer is JSON `true`.**
  `preflight()` and `checkpoint()` used to pass the value through as it came,
  so `"yes"` or `1` read as approved, and an answer without `approved` raised
  `KeyError`. Anything other than `true` is now `approved=False` with no
  reason, and a wrapped call returns a `Refusal` and is not sent.

### Added

- **Ceilings in dollars** (needs the AgentBill API from 2026-09-25 or later).
  - `wrap(..., task_ceiling_usd=...)` opens the job with a ceiling in dollars
    at public list price, and `wrap(..., unit="usd")` meters a dollar job
    opened in the console. `task_ceiling_usd` cannot be combined with
    `task_ceiling` or `unit="token"` (`ValueError`).
  - `AgentBillClient.preflight()` takes `task_ceiling_usd`, `estimated_usd`
    and `unit="usd"`.
  - `PreflightResult` has `task_unit`, `estimated_usd`, `task_remaining_usd`
    and `estimate_source` (`"caller"`, `"job_median"` or `"default"`), set on
    a dollar job and `None` otherwise.
  - `Refusal.unit` is `"usd"` on a dollar job, and `TaskCeilingExceededError`
    has `task_unit`. Both messages then say dollars:
    `Refused (task_ceiling_exceeded): ... is at $X of $Y at list price, and $Z remaining is not enough for the $E this call asked to reserve.`

### Changed

- The 401 hint on `AuthenticationError` no longer says the key was shown at
  `/register`. It now reads: the key "was shown once, when it was made. Your
  console is at https://agentbill.dev/login. Lost the key?
  https://agentbill.dev/recover gets you back in."
