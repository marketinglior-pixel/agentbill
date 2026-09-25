-- 031: inbound_mail_deliveries. One row per mail to hello@agentbill.dev that
-- Resend delivered to /webhooks/resend (src/routes/inbound-mail.ts), 2026-09-25.
--
-- hello@agentbill.dev is the contact on /security, /about, /privacy and
-- SECURITY.md, and until this migration the domain had no MX record: every
-- mail to it bounced. Resend now receives for the domain and posts one
-- email.received webhook per message; the route forwards it to the owner.
--
-- The row is two things.
--   The claim: Resend signs with Svix and retries a delivery it thinks failed,
--   keeping the same svix-id, so the id is the idempotency key and N copies of
--   one delivery forward once. A forward that fails deletes its claim so the
--   retry can land.
--   The rank: the daily forward ceilings count rows created earlier the same
--   UTC day, in total and per sender. A rank, not a count read at a moment,
--   so a race can overshoot a ceiling by a few and can never refuse a mail
--   that had room.
--
-- No address, subject or body is stored here: the message itself stays in
-- Resend. sender_hash is a SHA-256 of the lowercased sender address, which is
-- what the per-sender ceiling needs and nothing more. Additive; apply
-- before the code. Re-running it is a no-op. Roll back the code, not this file.

SET lock_timeout = '500ms';

CREATE TABLE IF NOT EXISTS inbound_mail_deliveries (
  webhook_id  TEXT        PRIMARY KEY,
  email_id    TEXT        NOT NULL,
  sender_hash TEXT        NOT NULL,
  outcome     TEXT        NOT NULL DEFAULT 'pending',
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inbound_mail_deliveries_received_at ON inbound_mail_deliveries (received_at);

-- Verify (expect 5):
--   SELECT count(*) FROM information_schema.columns WHERE table_name = 'inbound_mail_deliveries';
