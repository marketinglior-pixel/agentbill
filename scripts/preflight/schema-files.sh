#!/usr/bin/env bash
# The schema files a fresh database needs, one per line, in the order they
# apply. Dependency order matters: the numbered migrations build on the loose
# ones. run.sh applies all of them; alter-under-load.sh applies the ones before
# the migration it rehearses. One list, so the two cannot drift.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
printf '%s\n' \
  "$ROOT/src/db/schema.sql" \
  "$ROOT/src/db/migrate-multitenancy.sql" \
  "$ROOT/src/db/migration-reserved-units.sql" \
  "$ROOT/src/db/migration-step-costs.sql" \
  "$ROOT/src/db/migration-webhook.sql" \
  "$ROOT/src/db/polar-migration.sql" \
  "$ROOT/src/db/migration-register-fields.sql" \
  "$ROOT"/src/db/migrations/*.sql
