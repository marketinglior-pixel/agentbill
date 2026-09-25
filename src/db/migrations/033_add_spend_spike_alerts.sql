-- 033: spend_spike_alerts. One row per agent or customer that spent three
-- times its usual daily amount on one UTC day (src/lib/spike.ts, M2,
-- 2026-09-26).
--
-- The row is the claim: of every machine and every hourly pass that sees the
-- same spike, exactly one inserts it and mails it, so a subject is announced
-- once per day however long the day stays high. It also records what was
-- measured and what happened to the mail and the webhook, so a spike that was
-- claimed and not delivered is visible rather than silent.
--
-- idx_events_created_at: the pass reads every account's events for today and
-- the seven days before it in one statement, by time alone; the existing
-- indexes all lead with account_id or customer_id.
--
-- Additive; apply before the code. Re-running it is a no-op.

SET lock_timeout = '500ms';

CREATE TABLE IF NOT EXISTS spend_spike_alerts (
  account_id   UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  scope        TEXT        NOT NULL CHECK (scope IN ('agent', 'customer')),
  subject      TEXT        NOT NULL,
  day          DATE        NOT NULL,
  metric       TEXT        NOT NULL CHECK (metric IN ('usd', 'calls')),
  today_value  NUMERIC     NOT NULL,
  daily_avg    NUMERIC     NOT NULL,
  emailed      BOOLEAN     NOT NULL DEFAULT false,
  webhook      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, scope, subject, day)
);

CREATE INDEX IF NOT EXISTS idx_events_created_at ON events (created_at);

-- Verify (expect 10 and 1):
--   SELECT count(*) FROM information_schema.columns WHERE table_name = 'spend_spike_alerts';
--   SELECT count(*) FROM pg_indexes WHERE indexname = 'idx_events_created_at';
