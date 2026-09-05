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

# robots.txt must NOT disallow /app.
#
# A Disallowed URL can still be indexed URL-only from an external link, because
# the crawler is forbidden from fetching it and therefore never reads the
# noindex inside. Disallow plus noindex defeats itself, and /app is where the
# homepage's own "See a live console" button points.
#
# This gate exists because the first version of the robots generator derived its
# Disallow lines from `index: false` and so re-added `Disallow: /app`, the exact
# line the change was written to remove. It shipped, and the commit message
# claimed the opposite.
robots=$(curl -s "$B/robots.txt")
if printf '%s' "$robots" | grep -qE '^Disallow: /app'; then
  printf '  FAIL %-46s robots.txt disallows the demo console\n' "/robots.txt"; fail=1
else
  printf '  ok   %-46s /app crawlable, /admin disallowed\n' "/robots.txt"
fi
if ! printf '%s' "$robots" | grep -qE '^Disallow: /admin'; then
  printf '  FAIL %-46s /admin is not disallowed\n' "/robots.txt"; fail=1
fi

exit $fail
