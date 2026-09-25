-- 028: accounts.monthly_events, the counter behind the records-and-steps
-- allowance (security batch C, S7, 2026-09-25).
--
-- Until now POST /events and POST /step counted against nothing, so a free
-- account could store as many events as it could send. Each plan now
-- includes a monthly allowance of stored records and steps: three per
-- preflight call the plan includes (src/lib/event-quota.ts). This column is
-- the count, checked and incremented in one conditional UPDATE, in the same
-- billing period as monthly_calls: whichever counter rolls the period first
-- zeroes the other one, so the two always describe the same month.
--
-- Additive only. ADD COLUMN with a constant default is a catalog change on
-- Postgres 11 and later, no table rewrite. The build before this one never
-- names the column and never selects accounts with *, so its prepared
-- statements survive it; scripts/preflight/alter-under-load.sh rehearses
-- exactly that (ALTER_MIGRATION=028_add_monthly_events.sql), with the previous
-- build serving and prepared statements on.
--
-- ORDER: BEFORE the code. The build that counts events reads and writes this
-- column on every record and step. lock_timeout so a busy accounts row makes
-- this give up, change nothing, and be retried by
-- scripts/db/apply-migration.mjs, instead of queueing every preflight behind
-- it. Re-running it is a no-op. Roll back the code, not this file.

SET lock_timeout = '500ms';

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS monthly_events INTEGER NOT NULL DEFAULT 0;

-- Verify (expect one row, integer, NO, 0):
--   SELECT data_type, is_nullable, column_default FROM information_schema.columns
--   WHERE table_name = 'accounts' AND column_name = 'monthly_events';
