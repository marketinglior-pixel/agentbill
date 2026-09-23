#!/usr/bin/env bash
# Rehearse the production step for an ALTER ... TYPE migration against a server
# that is serving and warm, the way production is when the step runs.
#
#   ./scripts/preflight/alter-under-load.sh                 # throwaway docker postgres (CI)
#   DATABASE_URL=... ./scripts/preflight/alter-under-load.sh --external   # a fresh, empty DB
#
# run.sh cannot see this failure: it applies every migration before the
# server starts, so no connection ever holds a statement prepared against the
# old column types. Here the chain stops before ALTER_MIGRATION (default 016),
# the server starts and is warmed, and the migration is applied UNDER LOAD
# with the window setting the deploy order in 016 prescribes
# (DATABASE_PREPARE=false). Then the window closes (restart with prepared
# statements back on) and the same traffic runs again. Every answer in every
# phase must arrive, and none may be a 5xx.
#
# PLANT_SKIP_WINDOW=1 skips the window: the server keeps prepared statements
# across the ALTER. That is the deploy step as first written, and this gate
# must be red for it. ALTER_WORKERS (default 6) is how many clients keep
# calling while the ALTER runs; the bursts before and after it are 30-way.
#
# The migration is applied with scripts/db/apply-migration.mjs, the runner the
# production step uses, so its retry on a busy lock is rehearsed too.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MODE="${1:-docker}"
PORT="${PORT:-3996}"
ACCOUNT_ID="00000000-0000-0000-0000-0000000000aa"
API_KEY="agb_testkey_local_verification_0001"
ALTER_MIGRATION="${ALTER_MIGRATION:-016_unit_columns_to_bigint.sql}"

cleanup() {
  [ "$MODE" = "docker" ] && docker rm -f agentbill-alter-test >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [ "$MODE" = "docker" ]; then
  docker rm -f agentbill-alter-test >/dev/null 2>&1 || true
  docker run -d --name agentbill-alter-test -e POSTGRES_PASSWORD=test \
    -e POSTGRES_DB=agentbill -p 55433:5432 postgres:16 >/dev/null
  for _ in $(seq 1 60); do
    docker exec agentbill-alter-test psql -U postgres -d agentbill -c 'SELECT 1' >/dev/null 2>&1 && break
    sleep 1
  done
  export DATABASE_URL="postgres://postgres:test@localhost:55433/agentbill"
  psql() { docker exec -i agentbill-alter-test psql -U postgres -d agentbill -v ON_ERROR_STOP=1 -q; }
else
  : "${DATABASE_URL:?DATABASE_URL is required with --external}"
  psql() { command psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q; }
fi

TARGET="$ROOT/src/db/migrations/$ALTER_MIGRATION"
[ -f "$TARGET" ] || { echo "no such migration: $TARGET" >&2; exit 2; }

# Everything before the target, in the order run.sh applies it. The target and
# anything numbered after it are left for the rehearsal.
applied=0
while IFS= read -r f; do
  case "$f" in
    "$ROOT"/src/db/migrations/*) [[ "$(basename "$f")" < "$ALTER_MIGRATION" ]] || continue ;;
  esac
  psql < "$f" >/dev/null
  applied=$((applied + 1))
done <<< "$("$ROOT/scripts/preflight/schema-files.sh")"
echo "schema applied up to, not including, $ALTER_MIGRATION ($applied files)"

psql <<SQL >/dev/null
INSERT INTO accounts (id, plan, default_budget_units, monthly_calls, billing_period_start)
VALUES ('$ACCOUNT_ID', 'paid', NULL, 0, date_trunc('month', CURRENT_DATE)::date)
ON CONFLICT (id) DO UPDATE SET plan='paid', monthly_calls=0, default_budget_units=NULL;
INSERT INTO developer_api_keys (account_id, api_key, label)
VALUES ('$ACCOUNT_ID', '$API_KEY', 'alter-under-load')
ON CONFLICT DO NOTHING;
SQL

(cd "$ROOT" && npm run build --silent)

DATABASE_SSL=disable PORT="$PORT" API_KEY="$API_KEY" ACCOUNT_ID="$ACCOUNT_ID" \
  ALTER_FILE="$TARGET" PLANT_SKIP_WINDOW="${PLANT_SKIP_WINDOW:-}" \
  node "$ROOT/scripts/preflight/alter-under-load.mjs"
