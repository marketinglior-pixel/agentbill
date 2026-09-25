#!/usr/bin/env bash
# Rehearse the production step for an ALTER ... TYPE migration against a server
# that is serving and warm, the way production is when the step runs.
#
#   ./scripts/preflight/alter-under-load.sh                 # throwaway docker postgres (CI)
#   DATABASE_URL=... ./scripts/preflight/alter-under-load.sh --external   # a fresh, empty DB
#
# run.sh cannot see this failure: it applies every migration before the
# server starts, so no connection ever holds a statement prepared against the
# old column types. Here the chain is applied except ALTER_MIGRATION (default
# 016), the server starts and is warmed, and the migration is applied UNDER LOAD
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
#
# ALTER_MIGRATION=026_add_api_key_hash.sql (2026-09-25) rehearses the key-hash
# migration instead: the PREVIOUS build serves (with prepared statements ON,
# production's setting, because 026 claims it needs no window) and keeps
# minting keys while 026 runs; then the new build is started as the deploy and
# every key the old build ever minted must authenticate on it.
# PLANT_NO_TRIGGER=1 applies 026 without its fill trigger, and must be red: a
# key the old build mints after the migration would have no hash.
#
# ALTER_MIGRATION=028_*, 029_* or 030_* (security batch C, 2026-09-25): the
# additive columns of batch C (accounts.monthly_events, accounts.plan_ends_at
# and polar_subscription_id, developer_api_keys.session_epoch). Same shape as
# 026: the previous build serves with prepared statements ON while the ADD
# COLUMN runs, then the new build is started as the deploy. PLANT_SELECT_STAR=1
# makes the previous build's quota UPDATE return * inside the preflight
# transaction, which a prepared statement cannot survive an ADD COLUMN under,
# and must be red.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MODE="${1:-docker}"
PORT="${PORT:-3996}"
ACCOUNT_ID="00000000-0000-0000-0000-0000000000aa"
API_KEY="agb_7e5700000000000000000000000000000000000000000001"
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

# Everything except the target, in the order run.sh applies it. The target is
# left for the rehearsal. Migrations numbered after it are applied first,
# because they are additive and the code under test needs them: 017 adds the
# events columns every record now writes, so leaving it out would rehearse a
# deploy that production never runs (the code before its own migration) and
# fail on that instead of on the ALTER. None of them touches a column type.
applied=0
while IFS= read -r f; do
  case "$f" in
    "$ROOT"/src/db/migrations/*) [ "$(basename "$f")" != "$ALTER_MIGRATION" ] || continue ;;
  esac
  psql < "$f" >/dev/null
  applied=$((applied + 1))
done <<< "$("$ROOT/scripts/preflight/schema-files.sh")"
echo "schema applied except $ALTER_MIGRATION ($applied files)"

psql <<SQL >/dev/null
INSERT INTO accounts (id, plan, default_budget_units, monthly_calls, billing_period_start)
VALUES ('$ACCOUNT_ID', 'paid', NULL, 0, date_trunc('month', CURRENT_DATE)::date)
ON CONFLICT (id) DO UPDATE SET plan='paid', monthly_calls=0, default_budget_units=NULL;
INSERT INTO developer_api_keys (account_id, api_key, label)
VALUES ('$ACCOUNT_ID', '$API_KEY', 'alter-under-load')
ON CONFLICT DO NOTHING;
SQL

(cd "$ROOT" && npm run build --silent)

# 026 (API key hashing, 2026-09-25) is applied BEFORE its code, so what is
# serving while it runs is the PREVIOUS build, and that is what the rehearsal
# must run: compiled from OLD_REF (default origin/main, production's build)
# into .rehearsal/old, where node finds this checkout's node_modules by walking
# up. The new build is only started afterwards, as the deploy.
OLD_SERVER_JS="${OLD_SERVER_JS:-}"
case "$ALTER_MIGRATION" in
  026_*|028_*|029_*|030_*)
    if [ -z "$OLD_SERVER_JS" ]; then
      OLD_REF="${OLD_REF:-origin/main}"
      OLD_DIR="$ROOT/.rehearsal/old"
      rm -rf "$OLD_DIR" && mkdir -p "$OLD_DIR"
      git -C "$ROOT" archive "$OLD_REF" src tsconfig.json package.json | tar -x -C "$OLD_DIR"
      if [ "${PLANT_SELECT_STAR:-}" = "1" ]; then
        # The planted break: the previous build's quota UPDATE, inside the
        # preflight transaction, returns *. Outside a transaction postgres.js
        # re-prepares a statement whose result type changed (its
        # RevalidateCachedQuery retry); inside one the error aborts the
        # transaction first, so this is the shape an ADD COLUMN can break.
        perl -0pi -e 's/RETURNING monthly_calls\n/RETURNING *\n/' "$OLD_DIR/src/routes/preflight.ts"
        grep -q 'RETURNING \*' "$OLD_DIR/src/routes/preflight.ts" || { echo "PLANT_SELECT_STAR found nothing to plant" >&2; exit 2; }
      fi
      (cd "$OLD_DIR" && "$ROOT/node_modules/.bin/tsc" -p tsconfig.json)
      OLD_SERVER_JS="$OLD_DIR/dist/server.js"
      echo "previous build: $OLD_REF ($(git -C "$ROOT" rev-parse --short "$OLD_REF")) at $OLD_SERVER_JS"
    fi
    ;;
esac

DATABASE_SSL=disable PORT="$PORT" API_KEY="$API_KEY" ACCOUNT_ID="$ACCOUNT_ID" \
  ALTER_FILE="$TARGET" PLANT_SKIP_WINDOW="${PLANT_SKIP_WINDOW:-}" \
  OLD_SERVER_JS="$OLD_SERVER_JS" PLANT_NO_TRIGGER="${PLANT_NO_TRIGGER:-}" \
  PLANT_SELECT_STAR="${PLANT_SELECT_STAR:-}" \
  node "$ROOT/scripts/preflight/alter-under-load.mjs"
