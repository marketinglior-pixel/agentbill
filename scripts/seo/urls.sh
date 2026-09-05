#!/usr/bin/env bash
# Every URL in the sitemap must be reachable and self-canonical.
#
# The sitemap listed /blog before /blog had a route, and before that it omitted
# /pricing and both posts entirely. Neither is catchable by reading the file;
# both are caught by fetching every entry.
set -uo pipefail
B="${1:-http://localhost:3000}"
fail=0
for u in $(curl -s "$B/sitemap.xml" | grep -o '<loc>[^<]*</loc>' | sed 's/<[^>]*>//g'); do
  p="${u#https://agentbill.dev}"; [ -z "$p" ] && p=/
  code=$(curl -s -o /dev/null -w '%{http_code}' "$B$p")
  canon=$(curl -s "$B$p" | grep -o 'rel="canonical" href="[^"]*"' | sed 's/.*href="//;s/"//')
  if [ "$code" != 200 ]; then printf '  FAIL %-46s %s\n' "$p" "$code"; fail=1
  elif [ "$canon" != "$u" ]; then printf '  FAIL %-46s canonical %s != %s\n' "$p" "$canon" "$u"; fail=1
  else printf '  ok   %-46s 200, self-canonical\n' "$p"; fi
done
exit $fail
