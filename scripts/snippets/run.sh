#!/usr/bin/env bash
# Run every published code sample against the SDKs.
#   ./scripts/snippets/run.sh            # against the SDKs in this repo (the CI gate)
#   ./scripts/snippets/run.sh published  # against what PyPI and npm currently serve
set -euo pipefail
MODE="${1:-repo}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/scripts/snippets"
W="$HERE/.work"
rm -rf "$W"; mkdir -p "$W/node/node_modules" "$W/py"

node "$HERE/extract.mjs" > "$W/inventory.json"
node -e "const i=require('$W/inventory.json');const c={};for(const s of i)c[s.kind]=(c[s.kind]||0)+1;console.log('inventory:',i.length,'blocks',JSON.stringify(c))"

if [ "$MODE" = "repo" ]; then
  (cd "$ROOT/sdk/node" && npm ci --silent --no-audit --no-fund && npm run build --silent)
  ln -s "$ROOT/sdk/node" "$W/node/node_modules/agentbill"
  python3 -m venv "$W/py/venv"
  "$W/py/venv/bin/pip" install -q --upgrade pip >/dev/null
  "$W/py/venv/bin/pip" install -q "$ROOT/sdk/python"
else
  (cd "$W/node" && npm init -y >/dev/null && npm install --silent --no-audit --no-fund agentbill)
  python3 -m venv "$W/py/venv"
  "$W/py/venv/bin/pip" install -q --upgrade pip >/dev/null
  "$W/py/venv/bin/pip" install -q agentbill-sdk
fi

status=0
node "$HERE/check-node.mjs" "$W/inventory.json" "$MODE" || status=1
"$W/py/venv/bin/python" "$HERE/check_python.py" "$W/inventory.json" || status=1
exit $status
