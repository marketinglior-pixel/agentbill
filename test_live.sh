#!/bin/bash
# Final smoke test against the live Fly.io server.
# Usage: ./test_live.sh https://agentbill.fly.dev sk-your-api-key

BASE_URL="${1:-https://agentbill.fly.dev}"
API_KEY="${2:-$AGENTBILL_API_KEY}"

if [ -z "$API_KEY" ]; then
  echo "Usage: ./test_live.sh <base_url> <api_key>"
  echo "   or: export AGENTBILL_API_KEY=... && ./test_live.sh <base_url>"
  exit 1
fi

OK=0
FAIL=0

check() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  ✅  $label"
    OK=$((OK+1))
  else
    echo "  ❌  $label (expected $expected, got $actual)"
    FAIL=$((FAIL+1))
  fi
}

echo ""
echo "AgentBill live smoke test"
echo "Target: $BASE_URL"
echo "========================================"

# 1. Health check (no auth required)
echo ""
echo "1. Health check"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/health")
check "GET /health → 200" "200" "$STATUS"

# 2. Reject request without API key
echo ""
echo "2. Auth guard — reject missing key"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$BASE_URL/events" \
  -H "Content-Type: application/json" \
  -d '{"customer_id":"x","event_type":"x","idempotency_key":"x"}')
check "POST /events (no key) → 401" "401" "$STATUS"

# 3. Budget check with valid key (lazy-creates customer)
echo ""
echo "3. Budget check — lazy customer creation"
BODY=$(curl -s "$BASE_URL/budget?customer_id=smoke_test_$(date +%s)" \
  -H "Authorization: Bearer $API_KEY")
IS_BLOCKED=$(echo "$BODY" | grep -o '"is_blocked":false')
check "GET /budget → is_blocked:false" '"is_blocked":false' "$IS_BLOCKED"

# 4. Record a billable event
echo ""
echo "4. Record event"
IDEM="smoke_$(date +%s%N)"
BODY=$(curl -s -X POST "$BASE_URL/events" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d "{\"customer_id\":\"smoke_customer\",\"event_type\":\"smoke_test\",\"units\":1,\"idempotency_key\":\"$IDEM\"}")
STATUS_VAL=$(echo "$BODY" | grep -o '"status":"recorded"')
check "POST /events → recorded" '"status":"recorded"' "$STATUS_VAL"

# 5. Dashboard is publicly accessible
echo ""
echo "5. Dashboard public access"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/dashboard")
check "GET /dashboard → 200" "200" "$STATUS"

# Summary
echo ""
echo "========================================"
echo "Results: $OK passed, $FAIL failed"
echo ""
if [ $FAIL -eq 0 ]; then
  echo "  Server is live and healthy. Ready to launch."
else
  echo "  Fix the failures above before going public."
fi
echo ""
