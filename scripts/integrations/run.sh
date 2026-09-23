#!/usr/bin/env bash
# Run every /integrations/* framework sample, as served, to a real refusal.
#
#   BASE=http://localhost:3981 AGENTBILL_API_KEY=agb_... ./scripts/integrations/run.sh
#
# BASE is a running AgentBill server with a database (a local one: the harness
# creates a job ceiling per scenario, so never point this at production), and
# the key is any key on it. PYTHON must be 3.10 to 3.13, because crewai's
# floor and ceiling are both there.
#
# Each framework gets a fresh venv built from the install line its page
# prints, so the pin a reader copies is the pin that ran. Each scenario runs in
# its own process: CrewAI registers hooks for the whole process, and a second
# scenario in the same one would ask AgentBill twice per call.
#
# Not in CI yet: it needs a server with a database and about three minutes of
# installs. scripts/snippets covers the agentbill half of the same blocks on
# every push; this covers the framework half, and is run by hand when a sample
# or a pinned version changes.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
W="${WORK_DIR:-$HERE/.work}"
BASE="${BASE:-http://localhost:3981}"
PY="${PYTHON:-python3}"
: "${AGENTBILL_API_KEY:?AGENTBILL_API_KEY is required}"
export BASE AGENTBILL_API_KEY
mkdir -p "$W"

"$PY" -c 'import sys; v=sys.version_info[:2]; sys.exit(0 if (3,10) <= v < (3,14) else f"PYTHON is {v}: crewai needs 3.10 to 3.13")'

# The words after "pip install" in the page's own install block, one per line.
install_args() {
  curl -sf "$BASE$1" | "$PY" -c '
import html, re, shlex, sys
s = sys.stdin.read()
for b in re.findall(r"<pre[^>]*>([\s\S]*?)</pre>", s):
    line = html.unescape(re.sub(r"<[^>]+>", "", b)).strip()
    if line.startswith("pip install agentbill-sdk "):
        print("\n".join(shlex.split(line)[2:])); break
else:
    sys.exit("no pip install agentbill-sdk line on the page")'
}

venv() { # name, then pip arguments
  local name="$1"; shift
  rm -rf "${W:?}/$name"
  "$PY" -m venv "$W/$name"
  "$W/$name/bin/pip" install -q --upgrade pip >/dev/null
  "$W/$name/bin/pip" install -q "$@"
  printf '  venv %-14s %s\n' "$name" "$("$W/$name/bin/pip" freeze | grep -iE '^(agentbill|langchain|openai-agents|crewai)[-_a-z]*==' | tr '\n' ' ')"
}

for pair in langchain:/integrations/langchain openai-agents:/integrations/openai-agents-sdk crewai:/integrations/crewai; do
  name="${pair%%:*}"; path="${pair#*:}"
  args=(); while IFS= read -r a; do args+=("$a"); done < <(install_args "$path")
  venv "$name" "${args[@]}"
done
# The MCP page's line is "uvx agentbill-mcp", which runs the published package.
venv mcp agentbill-mcp

fail=0
for pair in langchain:raise langchain:finish langchain:async langchain:langgraph \
            openai-agents:raise openai-agents:handoff \
            crewai:raise crewai:cause crewai:no-job crewai:naive crewai:unreachable \
            mcp:settle; do
  name="${pair%%:*}"; scenario="${pair#*:}"
  if out=$("$W/$name/bin/python" "$HERE/samples.py" "$name" "$scenario" 2>&1); then
    printf '  %s\n' "$(printf '%s\n' "$out" | tail -1)"
  else
    printf '  FAIL %s %s\n%s\n' "$name" "$scenario" "$(printf '%s\n' "$out" | tail -15)"; fail=1
  fi
done
exit $fail
