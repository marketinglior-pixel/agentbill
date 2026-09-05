#!/usr/bin/env bash
# Grep gates. Ten seconds, no build, no database.
#
# Each of these stands behind a sentence design.md states and nothing enforced.
# A gate must be able to fail: every pattern here was checked against a
# deliberate violation before it was trusted to pass.
set -uo pipefail
cd "$(dirname "$0")/../.."
fail=0
gate() { # name  expected_count  actual_count  detail
  if [ "$2" = "$3" ]; then printf "  ok    %-46s %s\n" "$1" "$3"
  else printf "  FAIL  %-46s got %s want %s\n" "$1" "$3" "$2"; [ -n "${4:-}" ] && printf '%s\n' "$4"; fail=1; fi
}

# design.md: "No em dash. Anywhere. Grep before shipping."
n=$(grep -rn '—' src/ui src/routes src/lib 2>/dev/null | wc -l | tr -d ' ')
gate "no em dash on a rendered surface" 0 "$n" "$(grep -rn '—' src/ui src/routes src/lib 2>/dev/null | head -5)"

# The public boundary is declared at the route, never in a list.
n=$(grep -rn 'PUBLIC_PATHS' src 2>/dev/null | wc -l | tr -d ' ')
gate "PUBLIC_PATHS stays deleted" 0 "$n"

# One head builds every <head>. A page hand-writing these is how /docs ended up
# with og tags and no og:image while six other pages had neither.
for tag in 'rel="canonical"' 'rel="icon"' 'name="theme-color"' 'name="color-scheme"' 'property="og:' 'name="twitter:' 'application/ld+json' 'name="robots"'; do
  n=$(grep -rn -- "$tag" src --include=*.ts 2>/dev/null | grep -v 'src/ui/theme.ts' | wc -l | tr -d ' ')
  gate "only theme.ts emits $tag" 0 "$n" "$(grep -rn -- "$tag" src --include=*.ts 2>/dev/null | grep -v 'src/ui/theme.ts' | head -3)"
done

# The mark is one drawing. A second <span class="dot"> is a second drawing.
n=$(grep -rn 'class="dot"' src 2>/dev/null | wc -l | tr -d ' ')
gate "no second copy of the mark" 0 "$n"

exit $fail
