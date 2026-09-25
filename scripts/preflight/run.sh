#!/usr/bin/env bash
# Bring up a scratch database, apply the full migration chain, start the server
# against it and assert the preflight gate is still correct.
#
#   ./scripts/preflight/run.sh              # manages a throwaway docker postgres
#   DATABASE_URL=... ./scripts/preflight/run.sh --external   # CI, DB already up
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MODE="${1:-docker}"
PORT="${PORT:-3999}"
ACCOUNT_ID="00000000-0000-0000-0000-0000000000aa"
API_KEY="agb_7e5700000000000000000000000000000000000000000001"
WEBHOOK_SECRET="preflight-verify-webhook-secret"
# ADMIN_SECRET, 2026-09-20. /admin is the only surface that reads site_pulse
# back, so the gate on the tagged-source slice has to authenticate like the
# owner does. Without it that gate fetches a 401 and is red for a reason that
# has nothing to do with the code under test, which is the same as no gate.
ADMIN_SECRET="preflight-verify-admin-secret"

cleanup() {
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
  [ -n "${FAKE_OAUTH_PID:-}" ] && kill "$FAKE_OAUTH_PID" 2>/dev/null || true
  [ -n "${AUTH_TMP:-}" ] && rm -rf "$AUTH_TMP" || true
  [ "$MODE" = "docker" ] && docker rm -f agentbill-preflight-test >/dev/null 2>&1 || true
  [ -n "${WRAP_VENV:-}" ] && rm -rf "$(dirname "$WRAP_VENV")" || true
}
trap cleanup EXIT

if [ "$MODE" = "docker" ]; then
  docker rm -f agentbill-preflight-test >/dev/null 2>&1 || true
  docker run -d --name agentbill-preflight-test -e POSTGRES_PASSWORD=test \
    -e POSTGRES_DB=agentbill -p 55432:5432 postgres:16 >/dev/null
  # pg_isready goes green against the temporary init server, before the
  # POSTGRES_DB database exists. Wait for the database itself.
  for _ in $(seq 1 60); do
    docker exec agentbill-preflight-test psql -U postgres -d agentbill -c 'SELECT 1' >/dev/null 2>&1 && break
    sleep 1
  done
  export DATABASE_URL="postgres://postgres:test@localhost:55432/agentbill"
  psql() { docker exec -i agentbill-preflight-test psql -U postgres -d agentbill -v ON_ERROR_STOP=1 -q; }
else
  : "${DATABASE_URL:?DATABASE_URL is required with --external}"
  psql() { command psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q; }
fi

# Dependency order matters: the numbered migrations build on the loose ones.
# The list lives in schema-files.sh, shared with alter-under-load.sh.
SCHEMA_FILES="$("$ROOT/scripts/preflight/schema-files.sh")"
# A key that exists BEFORE 026, 2026-09-25 (security batch B): seeded in the
# old shape (api_key alone) just before 026 is applied, the way every key in
# production exists when 026 runs, so 026's backfill is what gives it a hash.
# The [keyhash pre] gates then log in with it on every path.
PRE_026_ACCOUNT="00000000-0000-0000-0000-00000000026a"
PRE_026_KEY="agb_026a026a026a026a026a026a026a026a026a026a026a026a"
while IFS= read -r f; do
  if [ "$(basename "$f")" = "026_add_api_key_hash.sql" ]; then
    psql <<SQL >/dev/null
INSERT INTO accounts (id, plan, email, monthly_calls, billing_period_start)
VALUES ('$PRE_026_ACCOUNT', 'free', 'keyhash-before-026@example.invalid', 0, date_trunc('month', CURRENT_DATE)::date)
ON CONFLICT (id) DO NOTHING;
INSERT INTO developer_api_keys (account_id, api_key, label) VALUES ('$PRE_026_ACCOUNT', '$PRE_026_KEY', 'before-026');
SQL
  fi
  psql < "$f" >/dev/null
done <<< "$SCHEMA_FILES"
echo "schema + migrations applied ($(printf '%s\n' "$SCHEMA_FILES" | wc -l | tr -d ' ') files)"

psql <<SQL >/dev/null
INSERT INTO accounts (id, plan, default_budget_units, monthly_calls, billing_period_start)
VALUES ('$ACCOUNT_ID', 'free', NULL, 0, date_trunc('month', CURRENT_DATE)::date)
ON CONFLICT (id) DO UPDATE SET plan='free', monthly_calls=0, default_budget_units=NULL;
INSERT INTO developer_api_keys (account_id, api_key, key_hash, key_prefix, key_last4, label)
VALUES ('$ACCOUNT_ID', '$API_KEY', encode(sha256(convert_to('$API_KEY', 'UTF8')), 'hex'), left('$API_KEY', 8), right('$API_KEY', 4), 'preflight-verify')
ON CONFLICT DO NOTHING;
SQL

# The second pass, 2026-09-25 (security batch B): APPLY_LATER=1 also applies
# src/db/migrations-later/ (027, which scrubs the plaintext api_key), after the
# seed so the seeded row is one 027 has to scrub, and the whole suite runs
# against a table with no plaintext in it. Those files are never part of the
# chain above: each needs its own approval on production.
if [ "${APPLY_LATER:-}" = "1" ]; then
  for f in "$ROOT"/src/db/migrations-later/*.sql; do
    psql < "$f" >/dev/null
  done
  echo "later migrations applied too: $(cd "$ROOT/src/db/migrations-later" && ls *.sql | tr '\n' ' ')"
fi

(cd "$ROOT" && npm run build --silent)

# The [wrap] gates run both SDKs' wrap() against this server: the Node SDK as
# built from sdk/node, and the Python SDK from sdk/python in a throwaway venv
# with its two dependencies. A gate that needed either and found it missing
# fails rather than skips, so neither step here is optional.
[ -d "$ROOT/sdk/node/node_modules" ] || (cd "$ROOT/sdk/node" && npm ci --silent --no-audit --no-fund)
(cd "$ROOT/sdk/node" && npm run build --silent)
WRAP_VENV="$(mktemp -d)/venv"
python3 -m venv "$WRAP_VENV"
"$WRAP_VENV/bin/pip" install -q --disable-pip-version-check "requests>=2.28" "httpx>=0.27"
export WRAP_PYTHON="$WRAP_VENV/bin/python"

# APP_SESSION_SECRET so the console login is real in the harness: without it
# every login answers err=unavailable and the checkout hand-off cannot be tested.
# RATE_LIMIT_PER_MINUTE: the suite makes ~90 API calls on one key and CI runs it in ~30s,
# which is past the production limit of 100/min at the tail. The limit is not under test.
# META_PIXEL_ID: production sets it, so / and /register carry one more inline
# script there than they did in this harness, hashed by src/lib/pixel.ts on a
# path that csp.ts's one-string guarantee does not cover. A synthetic id puts
# that script under the [pulse] CSP gate; the harness only fetches HTML, so
# nothing here talks to Meta.
# The server's log is read by the last gate in verify.mjs (every answer sent once).
SERVER_LOG="${SERVER_LOG:-/tmp/agentbill-verify-server.log}"
# The [auth] gates, 2026-09-25: a local fake of Google's and GitHub's OAuth
# endpoints (fake-oauth.mjs) on an ephemeral port, both providers configured
# against it, and a mail outbox the gates read the sign-in link from. The
# server honours OAUTH_TEST_BASE and MAIL_TEST_OUTBOX only outside production.
AUTH_TMP="$(mktemp -d)"
export GOOGLE_CLIENT_ID=fake-google-client GOOGLE_CLIENT_SECRET=fake-google-secret
export GITHUB_CLIENT_ID=fake-github-client GITHUB_CLIENT_SECRET=fake-github-secret
node "$ROOT/scripts/preflight/fake-oauth.mjs" "$AUTH_TMP/port" >"$AUTH_TMP/fake.log" 2>&1 &
FAKE_OAUTH_PID=$!
for _ in $(seq 1 50); do [ -s "$AUTH_TMP/port" ] && break; sleep 0.1; done
export OAUTH_TEST_BASE="http://127.0.0.1:$(cat "$AUTH_TMP/port")"
export MAIL_TEST_OUTBOX="$AUTH_TMP/outbox.jsonl"
: > "$MAIL_TEST_OUTBOX"
# POLAR_PRODUCT_ID_*: since 2026-09-25 only a configured product upgrades an
# account, so the harness configures three and signs webhooks for them.
# AUTH_FAILURES_PER_MINUTE: raised for the same reason as the rate limit; the
# [secfix] gates start a second server with the production values to test it.
export POLAR_PRODUCT_ID_BUILDER=prod_verify_builder POLAR_PRODUCT_ID_TEAM=prod_verify_team POLAR_PRODUCT_ID_SCALE=prod_verify_scale
# MCP_PUBLIC_ORIGIN, 2026-09-25: the [mcp] gates run the MCP SDK's own OAuth
# client against this server, and a real client refuses metadata whose
# resource is not the URL it dialled. Production ignores it (src/lib/mcp-oauth.ts).
MCP_PUBLIC_ORIGIN="http://localhost:$PORT" AUTH_FAILURES_PER_MINUTE=100000 META_PIXEL_ID=1234567890 RATE_LIMIT_PER_MINUTE=100000 DATABASE_SSL=disable PORT="$PORT" NODE_ENV=test POLAR_WEBHOOK_SECRET="$WEBHOOK_SECRET" APP_SESSION_SECRET="preflight-verify-session-secret" ADMIN_SECRET="$ADMIN_SECRET" node "$ROOT/dist/server.js" >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 30); do
  curl -sf "http://localhost:$PORT/health/db" >/dev/null 2>&1 && break
  sleep 1
done

DATABASE_SSL=disable API_BASE="http://localhost:$PORT" API_KEY="$API_KEY" ACCOUNT_ID="$ACCOUNT_ID" \
  WEBHOOK_SECRET="$WEBHOOK_SECRET" ADMIN_SECRET="$ADMIN_SECRET" SERVER_LOG="$SERVER_LOG" APPLY_LATER="${APPLY_LATER:-}" \
  PRE_026_KEY="$PRE_026_KEY" PRE_026_ACCOUNT="$PRE_026_ACCOUNT" \
  OAUTH_TEST_BASE="$OAUTH_TEST_BASE" MAIL_TEST_OUTBOX="$MAIL_TEST_OUTBOX" \
  node "$ROOT/scripts/preflight/verify.mjs"
