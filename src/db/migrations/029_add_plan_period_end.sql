-- 029: a canceled plan runs to the end of the period that was paid for
-- (security batch C, S24, 2026-09-25).
--
-- Until now subscription.canceled downgraded the account to free the moment
-- it arrived. Polar sends it when the customer cancels, and says the customer
-- "might still have access until the end of the current period"; access ends
-- with subscription.revoked ("the user loses access immediately"). So a
-- cancel took away days the buyer had already paid for.
--
--   plan_ends_at           When a canceled plan ends: Polar's ends_at, or its
--                          current_period_end. NULL is a plan with no end
--                          scheduled. The plan is read as free from this
--                          moment (compared by the database clock, in the
--                          same statement that reads the plan), and the
--                          sweeper writes the downgrade within one tick.
--   polar_subscription_id  The subscription that bought the current plan.
--                          A cancel, uncancel or revoke for a different
--                          subscription (an old one, after a new purchase)
--                          changes nothing. NULL on accounts upgraded before
--                          this: those accept any subscription's events, as
--                          they did.
--
-- Additive only: two nullable columns, a catalog change, no rewrite. The
-- build before this one never names them and never selects accounts with *
-- inside a transaction (scripts/preflight/alter-under-load.sh,
-- ALTER_MIGRATION=029_add_plan_period_end.sql, rehearses it with that build
-- serving). ORDER: before the code. Re-running it is a no-op. Roll back the
-- code, not this file.

SET lock_timeout = '500ms';

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS plan_ends_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS polar_subscription_id TEXT;

-- The sweeper's one query: accounts whose scheduled end has passed.
CREATE INDEX IF NOT EXISTS idx_accounts_plan_ends_at
  ON accounts (plan_ends_at) WHERE plan_ends_at IS NOT NULL;

-- Verify (expect two rows, and the index):
--   SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'accounts' AND column_name IN ('plan_ends_at', 'polar_subscription_id');
--   SELECT indexname FROM pg_indexes WHERE indexname = 'idx_accounts_plan_ends_at';
