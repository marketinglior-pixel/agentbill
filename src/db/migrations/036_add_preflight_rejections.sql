-- 036: a daily count of the preflights answered 422 (2026-09-27).
--
-- Of 50 accounts, 49 made a key and 20 recorded a call. One suspect for the
-- gap is a preflight for a new job sent without a ceiling, which the server
-- answers 422 task_ceiling_required and stores nowhere: no reservation, no
-- decision row (a 422 is a call the server could not decide, not a refusal,
-- and preflight_decisions feeds the refusals view and the setup guide). So
-- nobody could say how often it happens. This counts it, with the other 422s
-- (task_unit_mismatch, validation_error), per account, per reason, per UTC day.
--
--   n         how many times that day
--   first_at  the first one that day, last_at the latest
--
-- Nothing of the request is stored: not the body, the task_ref or the key.
-- A new table, so nothing already running reads or writes it. Apply before the
-- code; re-running it is a no-op. Roll back the code, not this file.

SET lock_timeout = '500ms';

CREATE TABLE IF NOT EXISTS preflight_rejections (
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  reason      TEXT NOT NULL CHECK (reason ~ '^[a-z_]{1,40}$'),
  day         DATE NOT NULL,
  n           INTEGER NOT NULL DEFAULT 1 CHECK (n > 0),
  first_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, reason, day)
);

-- Verify (expect 6):
--   SELECT count(*) FROM information_schema.columns WHERE table_name = 'preflight_rejections';
