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

# A source file carrying a NUL byte is binary to git (no line diff, no blame)
# and invisible to every grep gate in this file, because grep without -a stops
# at the first NUL and reports nothing. src/lib/ids.ts, the module whose whole
# job is to REJECT NUL bytes, shipped with one in a comment on 2026-09-07 and
# silently exempted itself from the em-dash gate above. Proven by planting an
# em dash in that file: this gate counted 0 while grep -a counted 1.
n=$(node -e "
const fs=require('fs'),path=require('path');
const walk=(d)=>fs.readdirSync(d,{withFileTypes:true}).flatMap((e)=>e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)]);
const bad=walk('src').filter((f)=>/[.](ts|sql|json)$/.test(f)&&fs.readFileSync(f).includes(0));
if (bad.length) process.stderr.write(bad.join('\\n')+'\\n');
process.stdout.write(String(bad.length));
")
gate "no NUL byte in a source file" 0 "$n"

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

# The homepage contributes exactly one executable Python sample and one Node
# sample (the hero's language tabs), and the snippet harness runs both against
# the published SDKs on every push.
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
    const nd = b.filter(x => x.kind === 'node').length;
    process.stdout.write(py + ':' + nd + ':' + b.length);
  });")
gate "home.ts: one python, one node sample, no phantom block" "1:1:2" "$n"

# The console's pre-save first run carries the repo's one executed task_ref-only
# sample as a literal, beside exactly one interpolated pre (the refusal body
# viewer), and nothing else. It moved here from /register#done on 2026-09-11,
# and the same day a comment that spelled the tag name with angle brackets
# swallowed it into a "dynamic" block: python went 38 -> 37 and nothing failed.
# Same trap as home.ts above, same guard.
n=$(node scripts/snippets/extract.mjs 2>/dev/null | node -e "
  let s=''; process.stdin.on('data', d => s += d).on('end', () => {
    const b = JSON.parse(s).filter(x => x.source.endsWith('routes/app.ts'));
    const py = b.filter(x => x.kind === 'python').length;
    const dy = b.filter(x => x.kind === 'dynamic').length;
    process.stdout.write(py + ':' + dy + ':' + b.length);
  });")
gate "app.ts: one python literal, one dynamic pre, no phantom block" "1:1:2" "$n"

# The onboarding sample exists twice on purpose, and this is what stops the two
# copies drifting.
#
# The console's pre-save first run carries it as a literal <pre class="snip">,
# because scripts/snippets only executes a literal: any ${...} inside a pre is
# classified "dynamic" with empty code and leaves the gate in silence. After a
# save the console carries the SAME lines built by taskSnippet() in
# src/ui/steps.ts, with the reader's own job name in them, so that copy cannot
# be a literal. One is executed and the other is the one a reader actually
# pastes, which is the wrong way round to leave unchecked.
#
# Until 2026-09-11 the literal lived on /register#done. It moved when that
# screen stopped teaching the sequence (dogfood run 3 ended there, on "I do
# not understand what I need to do"); the console owns every step now. The
# block was already dropped from CI once, during the commit that added this
# gate: it was written as ${taskSnippet()} and the inventory went from python
# to dynamic with nobody noticing but a hand-run of extract.mjs.
n=$(node -e "
const fs=require('fs');
const src=fs.readFileSync('src/ui/steps.ts','utf8');
const m=src.match(/export function taskSnippet[\s\S]*?return \\\`([\s\S]*?)\\\`\n\}/);
if(!m){process.stderr.write('taskSnippet template not found in src/ui/steps.ts\n');process.stdout.write('1');process.exit(0)}
const agent=(src.match(/export const SAMPLE_AGENT = '([^']*)'/)||[])[1];
const ref=(src.match(/export const SAMPLE_REF = '([^']*)'/)||[])[1];
if(!agent||!ref){process.stderr.write('SAMPLE_AGENT / SAMPLE_REF not found in src/ui/steps.ts\n');process.stdout.write('1');process.exit(0)}
const built=m[1].replace(/\\\$\{agentId\}/g,agent).replace(/\\\$\{taskRef\}/g,ref);
const reg=fs.readFileSync('src/routes/app.ts','utf8').match(/<pre class=\"snip\">([\s\S]*?)<\/pre>/);
if(!reg){process.stderr.write('no literal pre.snip block in src/routes/app.ts\n');process.stdout.write('1');process.exit(0)}
const lit=reg[1];
if(lit.trim()===built.trim()){process.stdout.write('0');process.exit(0)}
process.stderr.write('    app.ts <pre class=snip> and taskSnippet() have drifted:\n');
const a=lit.trim().split('\n'), b=built.trim().split('\n');
for(let i=0;i<Math.max(a.length,b.length);i++) if(a[i]!==b[i]) process.stderr.write('      line '+(i+1)+'\n        register: '+JSON.stringify(a[i])+'\n        steps.ts: '+JSON.stringify(b[i])+'\n');
process.stdout.write('1');
")
gate "console pre-save sample is byte-identical to taskSnippet()" 0 "$n"


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
