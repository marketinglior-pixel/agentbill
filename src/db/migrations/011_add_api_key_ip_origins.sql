-- 011: api_key_ip_origins. The record of which networks a key has been used from.
--
-- The IP alert used to compare the request against ONE column,
-- developer_api_keys.last_seen_ip, and mail the owner whenever they differed.
-- That is a one-slot memory: two addresses in rotation alert on every single
-- request, forever, because each one is always "not the last one".
--
-- They do rotate. macOS holds a stable `secured` IPv6 address and one or more
-- `temporary` privacy addresses on the same /64 at the same time, and chooses
-- between them per connection. Measured on the founder's laptop 2026-09-11,
-- 100 consecutive requests to production: 28 changes, nothing moved. A dogfood
-- watcher left polling /tasks/runaway-1 for 56 hours turned that into roughly
-- eleven mails a minute to one account owner for two days. The account was
-- never compromised; the alert had no way to say so.
--
-- So the row is per ORIGIN (the /64, or the IPv4 address; src/lib/ip-origin.ts)
-- and UNIQUE on it, which makes INSERT ... ON CONFLICT DO NOTHING the only
-- claim that can win. Same shape as account_quota_alerts (009) and for the same
-- two reasons: there are two machines, and a restart must not re-send.
--
-- alerted_at is set BEFORE Resend is called, not after, so a burst of genuinely
-- new origins cannot each read a 24h count that excludes the others. A row with
-- alerted_at NULL is therefore one of three honest things: the first origin a
-- key was ever used from (never an alert, it is not a change), one suppressed
-- by the daily cap, or one whose send was attempted and lost. last_ip keeps the
-- exact address that opened the origin, because the /64 alone does not let you
-- go and look at a log.
--
-- Deliberately NOT backfilled from last_seen_ip. An empty table means the first
-- request each live key makes claims its first origin and alerts nobody, so
-- deploying this mails no one. last_seen_ip stays exactly as it is: the console's
-- keys view reads it, and it no longer decides anything.

CREATE TABLE IF NOT EXISTS api_key_ip_origins (
  id            BIGSERIAL   PRIMARY KEY,
  api_key_id    UUID        NOT NULL REFERENCES developer_api_keys(id) ON DELETE CASCADE,
  origin        VARCHAR(45) NOT NULL,
  last_ip       VARCHAR(45),
  alerted_at    TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (api_key_id, origin)
);

-- The read on the hot path is "how many origins does this key have, and how
-- many alerted in the last day", both scoped to one key.
CREATE INDEX IF NOT EXISTS idx_ip_origins_key
  ON api_key_ip_origins (api_key_id);
