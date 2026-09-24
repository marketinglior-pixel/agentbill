#!/usr/bin/env bash
# Regenerate src/lib/og-image.ts from the card in scripts/og/build.mts.
#
# The card used to import the console module, which opens the database client
# at import time, so this set a throwaway DATABASE_URL. Since 2026-09-24 it
# reads the homepage's RUN (ui/playground.ts), which opens nothing, and no
# database variable is needed.
set -euo pipefail
cd "$(dirname "$0")/../.."
node_modules/.bin/tsx scripts/og/build.mts
