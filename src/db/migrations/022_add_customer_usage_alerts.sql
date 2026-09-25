-- 022: customer_usage_alerts. The claim behind the owner's 800-unit alert.
--
-- POST /events mails the owner the moment one customer_id crosses 800 units.
-- A customer_id is whatever string the caller sends, and a new one is created
-- on sight, so until 2026-09-25 one account could mint customer ids and send
-- the owner one mail each, as fast as it could record events, with the id
-- itself interpolated unescaped into the HTML. The id is escaped now; this
-- table is the cap.
--
-- One row per (account, customer) is the claim: INSERT ... ON CONFLICT DO
-- NOTHING, so a customer is announced once however many records cross the
-- line together. The row's own position among the account's rows created
-- earlier the same UTC day (and among everyone's, for a global ceiling) decides
-- whether it is mailed, the same rank argument as src/lib/mail.ts: a property
-- of the row, never a count read at a moment. Additive; apply before the code.

CREATE TABLE IF NOT EXISTS customer_usage_alerts (
  id           BIGSERIAL   PRIMARY KEY,
  account_id   UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  customer_ref TEXT        NOT NULL,
  used_units   BIGINT      NOT NULL,
  emailed      BOOLEAN     NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, customer_ref)
);

CREATE INDEX IF NOT EXISTS idx_customer_usage_alerts_created
  ON customer_usage_alerts (created_at);
