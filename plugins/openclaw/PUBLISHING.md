# Developing and publishing @agentbill/openclaw

Maintainer notes. Not shipped in the ClawHub artifact (`package.json` `files`
lists `dist`, the manifest and the README only); the README is what the
listing renders, and it is written for the operator who installs the plugin.

## Development

```bash
npm ci
npm run typecheck
npm test
```

The tests drive the plugin through a fake `api` and a fake `fetch`, and each
one was made to fail before it passed. `npm run plugin:validate` runs
OpenClaw's own manifest check when the `openclaw` CLI is installed (it needs
Node 24).

## Publishing

`dist/` is built, not committed, and `openclaw.extensions` points at
`./dist/index.js`. So publish the npm-pack tarball, which carries `dist/`,
rather than the repository path, which does not:

```bash
npm run build
npm pack
clawhub package publish ./agentbill-openclaw-0.3.0.tgz --family code-plugin \
  --source-repo https://github.com/marketinglior-pixel/agentbill \
  --source-commit "$(git rev-parse HEAD)" --dry-run
clawhub package publish ./agentbill-openclaw-0.3.0.tgz --family code-plugin \
  --source-repo https://github.com/marketinglior-pixel/agentbill \
  --source-commit "$(git rev-parse HEAD)"
```

A code plugin release is pinned to a repository and a commit; ClawHub refuses
the upload without both. Merge to main and push before publishing, so the
pinned commit is a main SHA that exists on GitHub and is the one the tarball
was built from (0.1.0 was pinned to a branch SHA that a rebase then rewrote).
The package name is scoped, so the `@agentbill` publisher had to exist on
ClawHub before the first release (`clawhub publisher create agentbill`, once).
Publishing itself needs `clawhub login`; a new release is held for security
scans before it is public.

ClawHub accepts exactly one `categories` entry on a new release, even though
the Gateway manifest allows up to three; this plugin declares `security`.

`clawhub package validate .` runs ClawHub's plugin inspector. It checks package
and manifest shape against the target OpenClaw; it does not load the plugin,
and it passed a manifest category the Gateway then rejected. The Gateway is the
check that counts:

```bash
openclaw plugins install -l . --force --accept-capabilities
openclaw plugins inspect agentbill --runtime
```

ClawHub requires a GitHub account old enough to pass its upload gate and runs
automated scans on every release.

## Text that other surfaces copy

The `[integrations]` gate in `scripts/preflight/verify.mjs` requires the
README's install line, its config block (the one containing
`"allowConversationAccess": true`), its refusal sample (the fenced block that
starts with `AgentBill refused (`) and its log line (the backticked
`[agentbill] ceiling ...` string) to appear byte for byte on
`/integrations/openclaw`. Change one of those four in the README and change
`src/routes/integrations.ts` in the same PR, or the harness fails.

ClawHub's search indexes the package description (and name and category), not
the README or `keywords`: measured 2026-09-24, a query for a word only in the
README returned nothing, a query for a word in the description returned the
plugin. Put the words an operator searches for in `description`.
