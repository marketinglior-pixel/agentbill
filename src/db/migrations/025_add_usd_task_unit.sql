-- 025: a job whose ceiling is in dollars (T3, 2026-09-25).
--
-- task_budgets.unit gains 'usd'. On such a job ceiling_units, used_units and
-- reserved_units are integer MICRO-dollars (1,000,000 = $1.00), and so are
-- the reservations rows its preflights open. The columns are BIGINT since 016,
-- so a $1,000,000 ceiling (1e12) fits, and every number stays an exact
-- integer: the ledger never holds a float.
--
-- What a dollar job counts is the list-price estimate the server computes
-- from the tokens a record reports and the dated price snapshot
-- (src/lib/prices.ts), which it already stores on every priced event
-- (events.list_price_usd, price_version, migration 017). A record that cannot
-- be priced (no model, a model with no list price, usage missing) is NEVER
-- counted as $0 on a dollar job: it is charged the reservation it settles, or
-- with none open the job's estimate, and counted here in unpriced_calls, so a
-- job with charged-at-estimate calls says so on GET /tasks and in the console.
--
-- Additive only. The constraint is swapped NOT VALID and validated second, so
-- inserts are never blocked behind a scan; every existing row is 'unit' or
-- 'token' and validates. The old build never writes 'usd' (its schema refuses
-- it) and never names unpriced_calls, so this is safe to apply while the
-- previous version is serving, and required before the code that writes
-- either. Re-running it is a no-op. lock_timeout so a busy table makes this
-- give up and be retried instead of queueing writes behind it.
--
-- Roll back the code, not this file: a 'usd' row read by the previous build
-- is read as 'unit' (its asTaskUnit), so do not roll the code back past this
-- migration once a dollar job exists.

SET lock_timeout = '2s';

ALTER TABLE task_budgets DROP CONSTRAINT IF EXISTS task_budgets_unit_known;
ALTER TABLE task_budgets
  ADD CONSTRAINT task_budgets_unit_known CHECK (unit IN ('unit', 'token', 'usd')) NOT VALID;
ALTER TABLE task_budgets VALIDATE CONSTRAINT task_budgets_unit_known;

ALTER TABLE task_budgets ADD COLUMN IF NOT EXISTS unpriced_calls INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_budgets_unpriced_nonnegative') THEN
    ALTER TABLE task_budgets
      ADD CONSTRAINT task_budgets_unpriced_nonnegative CHECK (unpriced_calls >= 0);
  END IF;
END $$;
