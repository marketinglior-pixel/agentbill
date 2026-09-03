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

cleanup() {
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
  [ "$MODE" = "docker" ] && docker rm -f agentbill-preflight-test >/dev/null 2>&1 || true
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
for f in \
  "$ROOT/src/db/schema.sql" \
  "$ROOT/src/db/migrate-multitenancy.sql" \
  "$ROOT/src/db/migration-reserved-units.sql" \
  "$ROOT/src/db/migration-step-costs.sql" \
  "$ROOT/src/db/migration-webhook.sql" \
  "$ROOT/src/db/polar-migration.sql" \
  "$ROOT/src/db/migration-register-fields.sql" \
  "$ROOT"/src/db/migrations/*.sql
do
  psql < "$f" >/dev/null
done
echo "schema + migrations applied"

psql <<SQL >/dev/null
INSERT INTO accounts (id, plan, default_budget_units, monthly_calls, billing_period_start)
VALUES ('$ACCOUNT_ID', 'free', NULL, 0, date_trunc('month', CURRENT_DATE)::date)
ON CONFLICT (id) DO UPDATE SET plan='free', monthly_calls=0, default_budget_units=NULL;
INSERT INTO developer_api_keys (account_id, api_key, label)
VALUES ('$ACCOUNT_ID', '$API_KEY', 'preflight-verify')
ON CONFLICT DO NOTHING;
SQL

(cd "$ROOT" && npm run build --silent)

DATABASE_SSL=disable PORT="$PORT" NODE_ENV=test node "$ROOT/dist/server.js" >/tmp/agentbill-verify-server.log 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 30); do
  curl -sf "http://localhost:$PORT/health/db" >/dev/null 2>&1 && break
  sleep 1
done

DATABASE_SSL=disable API_BASE="http://localhost:$PORT" API_KEY="$API_KEY" ACCOUNT_ID="$ACCOUNT_ID" \
  node "$ROOT/scripts/preflight/verify.mjs"
