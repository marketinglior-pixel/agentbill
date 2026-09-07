#!/usr/bin/env bash
# Regenerate src/lib/og-image.ts from the card in scripts/og/build.mts.
#
# The console module the card imports opens the database client at import
# time, which requires DATABASE_URL to be set. The card never queries, so any
# value will do and no connection is made.
set -euo pipefail
cd "$(dirname "$0")/../.."
DATABASE_URL="${DATABASE_URL:-postgres://og-build@127.0.0.1/none}" node_modules/.bin/tsx scripts/og/build.mts
