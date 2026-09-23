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
API_KEY="agb_testkey_local_verification_0001"
WEBHOOK_SECRET="preflight-verify-webhook-secret"
# ADMIN_SECRET, 2026-09-20. /admin is the only surface that reads site_pulse
# back, so the gate on the tagged-source slice has to authenticate like the
# owner does. Without it that gate fetches a 401 and is red for a reason that
# has nothing to do with the code under test, which is the same as no gate.
ADMIN_SECRET="preflight-verify-admin-secret"

cleanup() {
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
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
while IFS= read -r f; do
  psql < "$f" >/dev/null
done <<< "$SCHEMA_FILES"
echo "schema + migrations applied ($(printf '%s\n' "$SCHEMA_FILES" | wc -l | tr -d ' ') files)"

psql <<SQL >/dev/null
INSERT INTO accounts (id, plan, default_budget_units, monthly_calls, billing_period_start)
VALUES ('$ACCOUNT_ID', 'free', NULL, 0, date_trunc('month', CURRENT_DATE)::date)
ON CONFLICT (id) DO UPDATE SET plan='free', monthly_calls=0, default_budget_units=NULL;
INSERT INTO developer_api_keys (account_id, api_key, label)
VALUES ('$ACCOUNT_ID', '$API_KEY', 'preflight-verify')
ON CONFLICT DO NOTHING;
SQL

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
META_PIXEL_ID=1234567890 RATE_LIMIT_PER_MINUTE=100000 DATABASE_SSL=disable PORT="$PORT" NODE_ENV=test POLAR_WEBHOOK_SECRET="$WEBHOOK_SECRET" APP_SESSION_SECRET="preflight-verify-session-secret" ADMIN_SECRET="$ADMIN_SECRET" node "$ROOT/dist/server.js" >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 30); do
  curl -sf "http://localhost:$PORT/health/db" >/dev/null 2>&1 && break
  sleep 1
done

DATABASE_SSL=disable API_BASE="http://localhost:$PORT" API_KEY="$API_KEY" ACCOUNT_ID="$ACCOUNT_ID" \
  WEBHOOK_SECRET="$WEBHOOK_SECRET" ADMIN_SECRET="$ADMIN_SECRET" SERVER_LOG="$SERVER_LOG" \
  node "$ROOT/scripts/preflight/verify.mjs"
