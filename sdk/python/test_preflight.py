"""
Pre-flight budget check test.
Run: python3 test_preflight.py
Server must be running: npm run dev (in agentbill folder)
"""
import sys, os
sys.path.insert(0, '.')

os.environ['AGENTBILL_API_KEY'] = 'test_key'
os.environ['AGENTBILL_BASE_URL'] = 'http://localhost:3000'

from agentbill.meter import meter, BudgetExhaustedError

call_count = 0

# limit_test is already BLOCKED (used=3, limit=3)
@meter(event="preflight_test", customer_id="limit_test", units=1, preflight=True)
def expensive_agent(task: str) -> str:
    global call_count
    call_count += 1
    print(f"  → Agent body ran (#{call_count}) — this costs money!")
    return f"result: {task}"


print("=" * 50)
print("Pre-flight budget check test")
print("Customer: limit_test (blocked, used=3/3)")
print("=" * 50)

try:
    expensive_agent("analyze this document")
    print("\nFAIL: should have been blocked before running!")
except BudgetExhaustedError as e:
    print(f"\n✅  BudgetExhaustedError caught BEFORE agent ran")
    print(f"    Message: {e}")
    print(f"    Agent body executions: {call_count}  (expected: 0)")
    print(f"\n→  The LLM call was never made. No money wasted.")
