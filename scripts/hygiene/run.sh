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

# The homepage contributes exactly one executable Python sample, and the snippet
# harness runs it against the published SDKs on every push.
#
# This is easier to break than it looks. The extractor scans for the code tag by
# name, so writing that tag name inside a COMMENT in home.ts makes it run from
# the comment to the real closing tag, swallow the sample into one "dynamic"
# block, and drop it from CI. The suite still passes, one number lower. That
# happened while writing the comment above .code-out, and the only thing that
# caught it was noticing 33 become 32.
n=$(node scripts/snippets/extract.mjs 2>/dev/null | node -e "
  let s=''; process.stdin.on('data', d => s += d).on('end', () => {
    const b = JSON.parse(s).filter(x => x.source.endsWith('routes/home.ts'));
    const py = b.filter(x => x.kind === 'python').length;
    process.stdout.write(py + ':' + b.length);
  });")
gate "home.ts: one python sample, no phantom block" "1:1" "$n"


# Every inline script the site emits must PARSE.
#
# This exists because /register's script did not, for one deploy. Lifting it
# into a module for the CSP re-escaped backslashes that were already escaped:
# \" became \\", which closes the JS string early. The page returned 200, the
# CSP hash matched, the script tag was present, the handler was in the HTML,
# and the button did nothing. Every check I had at the time passed.
#
# Needs a running server, so it is skipped when there is not one.
B="${HYGIENE_BASE:-http://localhost:3000}"
if curl -sf "$B/health" >/dev/null 2>&1; then
  for path in / /register /pricing /docs /faq; do
    # Any <script> tag, with or without attributes, except JSON-LD data blocks.
    curl -s "$B$path" | perl -0777 -ne 'while(/<script(\s[^>]*)?>(.*?)<\/script>/gs){ next if defined $1 && $1 =~ /ld\+json/; print "$2\n" }' > /tmp/hygiene-inline.js
    if [ -s /tmp/hygiene-inline.js ]; then
      if node --check /tmp/hygiene-inline.js 2>/tmp/hygiene-inline.err; then
        printf "  ok    %-46s inline script parses\n" "$path"
      else
        printf "  FAIL  %-46s %s\n" "$path" "$(tail -2 /tmp/hygiene-inline.err | head -1)"; fail=1
      fi
    else
      # Every page in this list carries one inline script. None found means the
      # extractor missed it or the page lost it, and both are failures.
      printf "  FAIL  %-46s no inline script found\n" "$path"; fail=1
    fi
  done
elif [ -n "${HYGIENE_BASE:-}" ]; then
  # A base was named and is not answering: in CI that is a broken job, not a skip.
  printf "  FAIL  %-46s no server on %s\n" "inline script parse check" "$B"; fail=1
else
  printf "  skip  %-46s no server on %s\n" "inline script parse check" "$B"
fi

exit $fail
