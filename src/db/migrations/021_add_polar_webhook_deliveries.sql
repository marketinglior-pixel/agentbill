-- 021: polar_webhook_deliveries. One row per Polar delivery this server acted on.
--
-- Standard Webhooks (which Polar uses) refuses a signature older than five
-- minutes, and that was the only replay protection /webhooks/polar had: a
-- captured delivery could be posted again, verified, inside that window, and
-- acted on twice. Every delivery carries a webhook-id that Polar keeps the same
-- across its own retries, so it is the natural idempotency key.
--
-- The claim is an INSERT ... ON CONFLICT DO NOTHING in the SAME transaction as
-- the plan change it guards (src/routes/webhooks.ts), so of N copies of one
-- delivery exactly one changes anything, and a delivery whose change failed
-- rolls its claim back with it and can be retried. Additive; apply before the
-- code. Rows are tiny and a handful a month; nothing needs to prune them.

CREATE TABLE IF NOT EXISTS polar_webhook_deliveries (
  webhook_id  TEXT        PRIMARY KEY,
  event_type  TEXT        NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
