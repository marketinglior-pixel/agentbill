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
# The entity form too, 2026-09-22: &mdash; renders the same dash and three of
# them sat on / (a figure label, the plate label, the thesis) while this gate
# read 0, because it grepped for the character and not for what the browser
# draws. Checked against a deliberate violation: an &mdash; planted in
# home.ts makes this gate read 1.
# A <blockquote> line is exempt: the blog quotes third parties byte for byte
# and five [blog] gates hold those quotes to their source, so a dash inside
# one is theirs to keep and not ours to edit.
n=$(grep -rn '—\|&mdash;' src/ui src/routes src/lib 2>/dev/null | grep -v '<blockquote>' | wc -l | tr -d ' ')
gate "no em dash on a rendered surface, literal or &mdash;" 0 "$n" "$(grep -rn '—\|&mdash;' src/ui src/routes src/lib 2>/dev/null | grep -v '<blockquote>' | head -5)"

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

# One module sends mail, because a ceiling can only live somewhere every sender
# has to pass through. Until 2026-09-12 there were nine Resend clients in src,
# one per sender, each with the same three copy-pasted env reads, and the tenth
# sender would have been written the same way with nothing to say otherwise.
# src/lib/mail.ts owns the client and the two doors: mailOwner has no ceiling
# (one address, ours, cannot bounce), mailUser carries the daily ceiling on the
# one send whose recipient a stranger picks freely.
#
# Checked against a deliberate violation: a `new Resend(` planted in
# src/routes/register.ts makes this gate read 1.
n=$(grep -rn 'new Resend(' src --include=*.ts 2>/dev/null | grep -v 'src/lib/mail.ts' | wc -l | tr -d ' ')
gate "only mail.ts builds a mailer" 0 "$n" "$(grep -rn 'new Resend(' src --include=*.ts 2>/dev/null | grep -v 'src/lib/mail.ts' | head -3)"
#
# `\.emails`, not `emails\.send(`. webhook-alert.ts split its call across two
# lines (`void resend.emails` then `.send({`), so a single-line grep for
# `emails.send(` counted nine sites where there were ten, and the tenth was
# the one whose whole comment is about a branch that told nobody. A gate that
# a line break defeats is not a gate.
n=$(grep -rn '\.emails' src --include=*.ts 2>/dev/null | grep -v 'src/lib/mail.ts' | wc -l | tr -d ' ')
gate "and only mail.ts calls the mailer" 0 "$n" "$(grep -rn '\.emails' src --include=*.ts 2>/dev/null | grep -v 'src/lib/mail.ts' | head -3)"
n=$(grep -rn "from 'resend'" src --include=*.ts 2>/dev/null | grep -v 'src/lib/mail.ts' | wc -l | tr -d ' ')
gate "and only mail.ts imports the mailer" 0 "$n" "$(grep -rn "from 'resend'" src --include=*.ts 2>/dev/null | grep -v 'src/lib/mail.ts' | head -3)"

# The mark is one drawing. A second <span class="dot"> is a second drawing.
# The sweeper that reclaims abandoned reservations is an in-process timer, so
# it exists only if server.ts starts it after listen. A function that is
# defined and never called is the 2026-09-15 finding this guards against:
# production held 7 reserved units with no row behind them, and the sweeper
# cannot see those; it could just as easily hold rows it never sweeps.
# Anchored to a line that is a bare call, so a commented-out call counts as
# absent: the first version of this gate counted the string and stayed green
# with the call behind '//'.
n=$(grep -cE '^[[:space:]]*startReservationSweeper\(\)' src/server.ts 2>/dev/null | tr -d ' ')
gate "server.ts starts the reservation sweeper exactly once" 1 "$n" "$(grep -n 'startReservationSweeper' src/server.ts | head -3)"

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

# The console's start screen carries two executed samples as literals, the
# Python and the Node wrap() path (2026-09-25), beside exactly one interpolated
# pre (the refusal body viewer), and nothing else. Until 2026-09-25 it carried
# the task_ref-only record(units=1) sample, and on 2026-09-11 a comment that
# spelled the tag name with angle brackets swallowed it into a "dynamic" block:
# python went 38 -> 37 and nothing failed. Same trap as home.ts above, same guard.
n=$(node scripts/snippets/extract.mjs 2>/dev/null | node -e "
  let s=''; process.stdin.on('data', d => s += d).on('end', () => {
    const b = JSON.parse(s).filter(x => x.source.endsWith('routes/app.ts'));
    const py = b.filter(x => x.kind === 'python').length;
    const nd = b.filter(x => x.kind === 'node').length;
    const dy = b.filter(x => x.kind === 'dynamic').length;
    process.stdout.write(py + ':' + nd + ':' + dy + ':' + b.length);
  });")
gate "app.ts: one python, one node literal, one dynamic pre, no phantom" "1:1:1:3" "$n"

# The start screen's prose says what one run does: job first-call, a ceiling of
# 20,000 tokens, wrap(). The two samples are literals (the harvester executes
# only a literal), so nothing ties them to that sentence but this gate: both
# samples must open the job steps.ts names, with its agent and its ceiling,
# through wrap(), and the sentence must carry the same name and number.
n=$(node scripts/hygiene/start-samples.mjs)
gate "start samples open the job the start screen describes" 0 "$n"


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
