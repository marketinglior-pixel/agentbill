-- 016: every unit column becomes BIGINT.
--
-- ORDER: this is the one migration in the chain that goes AFTER its code, not
-- before it. Apply it only once the build carrying src/db/int8.ts is live and
-- verified. postgres.js returns BIGINT as a string by default, and the code
-- before that build does ledger arithmetic on these columns in JavaScript:
-- `locked.usedUnits + units > locked.limitUnits` (events.ts) becomes string
-- CONCATENATION, "100" + 5 = "1005", and the task comparisons become string
-- comparisons. With the parser live, a BIGINT arrives as an exact number or
-- as a loud error past 2^53 - 1, and nothing here changes behaviour.
--
-- Why at all. customers.used_units is a lifetime counter. Counted in tokens it
-- fills INTEGER (2,147,483,647) in a couple of billion tokens, and then every
-- record for that customer is Postgres 22003 and a 500. The same holds for a
-- long-lived task counted in tokens.
--
-- The API's own bounds stay at INT4_MAX (src/lib/ids.ts) in the same deploy:
-- a single call, estimate or ceiling still cannot exceed 2,147,483,647. Only
-- the running totals get the room. Raising the per-request bounds is a later,
-- separate deploy, after this migration is applied and verified, because a
-- bound raised while the columns are still INTEGER turns a 422 into a 500.
--
-- preflight_decisions is already BIGINT (005). site_pulse.ceiling (the landing
-- page slider) and the monthly_calls counters are not unit ledgers and stay.
--
-- ALTER ... TYPE rewrites each table under an ACCESS EXCLUSIVE lock. One
-- transaction, so it is all or nothing, and lock_timeout so it gives up rather
-- than queueing every request behind a long transaction. Check sizes first:
--   SELECT relname, pg_size_pretty(pg_total_relation_size(oid)) FROM pg_class
--   WHERE relname IN ('accounts','customers','task_budgets','reservations','events','step_costs');
-- Every constraint, default and index on these columns survives the change.
-- Re-running is harmless: altering a BIGINT column to BIGINT is a no-op.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE accounts
  ALTER COLUMN default_budget_units TYPE BIGINT;

ALTER TABLE customers
  ALTER COLUMN limit_units    TYPE BIGINT,
  ALTER COLUMN used_units     TYPE BIGINT,
  ALTER COLUMN reserved_units TYPE BIGINT;

ALTER TABLE task_budgets
  ALTER COLUMN ceiling_units  TYPE BIGINT,
  ALTER COLUMN used_units     TYPE BIGINT,
  ALTER COLUMN reserved_units TYPE BIGINT;

ALTER TABLE reservations
  ALTER COLUMN units TYPE BIGINT;

ALTER TABLE events
  ALTER COLUMN units TYPE BIGINT;

ALTER TABLE step_costs
  ALTER COLUMN units TYPE BIGINT;

COMMIT;
