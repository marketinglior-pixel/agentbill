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
-- AND NO CONNECTION MAY HOLD A PREPARED STATEMENT ACROSS IT. postgres.js
-- prepares each statement once per connection and keeps it. After ALTER ...
-- TYPE those kept statements fail: Postgres answers 0A000 "cached plan must
-- not change result type", which inside sql.begin aborts the transaction, and
-- a review rehearsal on 2026-09-23 also saw the int8 parser handed UUIDs and
-- IPs, TypeErrors on missing rows, and requests that never answered.
-- scripts/preflight/alter-under-load.sh with the window below skipped: at 6
-- workers, 130 of 5,109 requests made during the ALTER answered 500; at 30,
-- 122 of 1,290 failed (5xx, or left open) and afterwards the same pool
-- answered none of the next 180, every one timed out. The harness (run.sh)
-- cannot see this, because it applies every migration before the server
-- starts. So the production step is a window:
--
--   1. The int8-parser build is live and verified (GET /health names it).
--   2. flyctl secrets set DATABASE_PREPARE=false -a agentbill
--      Fly restarts the machines, one at a time. Each logs, at start,
--      "[db] prepared statements OFF (DATABASE_PREPARE=false)". Check both
--      machines say it (flyctl logs -a agentbill) before going on. With
--      prepared statements off, every statement is parsed fresh, inside the
--      same implicit transaction as its execution, so no plan outlives the
--      ALTER.
--   3. Apply this file from inside a machine with
--      scripts/db/apply-migration.mjs, which retries while the locks are
--      busy (below), then verify every column below reads bigint.
--   4. flyctl secrets unset DATABASE_PREPARE -a agentbill
--      The machines restart with prepared statements back on, now prepared
--      against the new types. Verify /health and one preflight + record.
-- If downtime is acceptable instead, stopping the app (no machine running,
-- so no pool) across step 3 is equally safe. What is NOT safe: applying this
-- while a machine serves with prepared statements and restarting afterwards;
-- the requests caught in between fail or hang.
-- scripts/preflight/alter-under-load.sh rehearses steps 2 to 4 against a warm
-- server under load, and is red with step 2 skipped. The same holds for any
-- future ALTER ... TYPE: rehearse it there first.
--
-- LOCKS. Every table is locked first, all six in one statement, with a short
-- lock_timeout, and only then altered. The app does not take these locks in
-- one order: an /events transaction holds its customers row and then, for the
-- foreign key on events.account_id, needs a share lock on accounts. Altering
-- table by table held accounts while waiting for customers, and the
-- rehearsal deadlocked (40P01) on exactly that. Taking all six before any
-- work means the migration never waits while it is doing work, and a
-- lock_timeout (200ms) well under deadlock_timeout (1s by default) means that
-- if it does meet a cycle while acquiring, it is the one that gives up, not a
-- request. A lock_timeout failure changes nothing; apply-migration.mjs tries
-- again. Once all six are held the ALTERs run and requests queue behind them
-- for as long as the rewrite takes.
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
-- ALTER ... TYPE rewrites each table under an ACCESS EXCLUSIVE lock, and every
-- request that touches one of them waits for the whole rewrite. One
-- transaction, so it is all or nothing. Check sizes first:
--   SELECT relname, pg_size_pretty(pg_total_relation_size(oid)) FROM pg_class
--   WHERE relname IN ('accounts','customers','task_budgets','reservations','events','step_costs');
-- Every constraint, default and index on these columns survives the change.
-- Re-running is harmless: altering a BIGINT column to BIGINT is a no-op.

BEGIN;
SET LOCAL lock_timeout = '200ms';

LOCK TABLE accounts, customers, task_budgets, reservations, events, step_costs
  IN ACCESS EXCLUSIVE MODE;

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
