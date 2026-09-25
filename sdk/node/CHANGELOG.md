# Changelog: agentbill (npm)

Versions published to npm as `agentbill`. Earlier releases are described in
the commit history of this repository.

## 0.6.0 (unreleased)

### Breaking

- **The base URL must be `https`.** Plain `http` is accepted only for
  `localhost`, `127.0.0.1` and `[::1]` (any port). Any other
  `AGENTBILL_BASE_URL` makes each call throw `AgentBillError` before a request
  is sent, because every request carries your API key. The check runs per
  request, not at import. If you point the SDK at plain `http` on a host other
  than this machine, switch it to `https` before upgrading. The default,
  `https://agentbill.dev`, is unaffected.
- **`approved` is `true` only when the server's answer is JSON `true`.**
  0.5.0 read any truthy value (`"yes"`, `1`, an object) as approved. Anything
  else is now `approved: false` with no reason, and a wrapped call resolves
  to a `Refusal` and is not sent.
- **Each request to the AgentBill API is aborted after 10 seconds**, and the
  call rejects with a `TimeoutError`. 0.5.0 had no timeout.

### Added

- **Ceilings in dollars** (needs the AgentBill API from 2026-09-25 or later).
  - `wrap(client, { taskCeilingUsd })` opens the job with a ceiling in
    dollars at public list price, and `wrap(client, { unit: 'usd' })` meters a
    dollar job opened in the console. `taskCeilingUsd` cannot be combined with
    `taskCeiling` or `unit: 'token'` (`TypeError`).
  - `preflight()` takes `taskCeilingUsd`, `estimatedUsd` and `unit: 'usd'`.
  - On a dollar job the result has `taskUnit: 'usd'`, `estimatedUsd`,
    `taskRemainingUsd` and `estimateSource` (`'caller'`, `'job_median'` or
    `'default'`).
  - `Refusal.unit` is `'usd'` on a dollar job, and `TaskCeilingExceededError`
    has `taskUnit`. Both messages then say dollars:
    `Refused (task_ceiling_exceeded): ... is at $X of $Y at list price, and $Z remaining is not enough for the $E this call asked to reserve.`
  - `getTask()` on a dollar job reports `unit: 'usd'` and carries
    `ceilingUsd`, `usedUsd`, `reservedUsd`, `remainingUsd`, `unpricedCalls`
    and `listPriceLabel`. Its `*Units` fields are micro-dollars there.

### Fixed

- `getTask()` read every unit other than `'token'` as `'unit'`, so a job in
  dollars came back as `unit: 'unit'` with its numbers in micro-dollars.

### Package

- `files` allowlist: the tarball ships `dist/`, `README.md` and this
  changelog. 0.5.0 also shipped `src/`, `test/` and `tsconfig.json`.
- `undici` floor raised from `^6.0.0` to `^6.28.1`.
