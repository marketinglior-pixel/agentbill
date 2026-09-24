-- 015: a call that cost 0, and a call whose cost nobody reported.
--
-- Two different facts that used to be the same 422.
--
-- A provider can report 0 tokens for a call, and a tool call in a tokens job
-- costs 0 of them on its own. POST /events required units >= 1 and the table
-- agreed (CHECK units >= 1), so the only way to say "this ran and cost
-- nothing" was not to call record at all, which left that call's reservation
-- held until the sweeper took it. events.units may now be 0.
--
-- A provider can also report nothing: no usage object, a stream opened
-- without usage, a host event without the counts. Recording that as 0 would
-- make the job look cheaper than it was, which is the one direction a ceiling
-- must never drift. So it is a separate flag on the request, usage_missing,
-- and the record path charges the call at least the reservation it settles
-- (the caller's own worst-case estimate, made before the call): the one
-- reservation_id names, or without one that is found, the oldest open
-- reservation of that customer and task_ref. With no reservation open the
-- units sent are recorded. Either way it stamps usage_missing: true into
-- events.metadata and counts the call here, so a job with unmeasured calls
-- says so on GET /tasks and in the console instead of reading as a clean
-- total.
--
-- The constraint swap is NOT VALID first and validated second: VALIDATE takes
-- a lock that does not block inserts, so events keeps accepting writes while
-- the existing rows are checked. Every existing row has units >= 1, so it
-- validates. The old code's schema still refuses 0, so this is safe to apply
-- while the previous version is serving, and required before the code that
-- accepts 0.

ALTER TABLE events DROP CONSTRAINT IF EXISTS events_units_positive;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'events_units_nonnegative') THEN
    ALTER TABLE events
      ADD CONSTRAINT events_units_nonnegative CHECK (units >= 0) NOT VALID;
  END IF;
END $$;

ALTER TABLE events VALIDATE CONSTRAINT events_units_nonnegative;

ALTER TABLE task_budgets ADD COLUMN IF NOT EXISTS usage_missing_calls INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_budgets_usage_missing_nonnegative') THEN
    ALTER TABLE task_budgets
      ADD CONSTRAINT task_budgets_usage_missing_nonnegative CHECK (usage_missing_calls >= 0);
  END IF;
END $$;
