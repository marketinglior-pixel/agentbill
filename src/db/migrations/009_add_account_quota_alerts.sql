-- 009: account_quota_alerts. The record that a customer was told.
--
-- Until now nobody was warned about the monthly plan quota. The one alert in
-- the codebase (events.ts, 800 units) went to the OWNER, and it measured units
-- rather than the quota, which counts preflight calls. Crossing the quota
-- returns approved: false and does not raise, on purpose, so the agent degrades
-- quietly and the developer finds out from logs, later.
--
-- This table is the idempotency guard for the warning mails, and it is a table
-- rather than an in-memory tally for two reasons the webhook alert did not
-- have: the signal is monthly, so a restart mid-month would re-send, and there
-- are two machines, so each would send. UNIQUE on (account, threshold, period)
-- makes an INSERT ... ON CONFLICT DO NOTHING the only claim that can win, from
-- any machine, once per billing period.
--
-- monthly_calls is the count at the moment the threshold was crossed, kept so
-- a row explains itself. emailed is set only after Resend accepted the send;
-- a row with emailed = false is a claim that was won and then could not be
-- delivered, which is visible rather than silent.

CREATE TABLE IF NOT EXISTS account_quota_alerts (
  id                   BIGSERIAL   PRIMARY KEY,
  account_id           UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  threshold            SMALLINT    NOT NULL,
  billing_period_start DATE        NOT NULL,
  monthly_calls        INTEGER     NOT NULL,
  emailed              BOOLEAN     NOT NULL DEFAULT false,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, threshold, billing_period_start)
);
