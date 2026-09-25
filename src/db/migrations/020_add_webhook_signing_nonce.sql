-- 020: accounts.webhook_secret_nonce. What the anomaly webhook is signed with.
--
-- Until 2026-09-25 a delivery from POST /step carried no signature, so a
-- receiver had no way to tell our POST from anybody's. Each account that saves
-- a webhook URL now gets a signing secret, returned once by POST
-- /webhook-config and never stored: this column holds a random nonce, and the
-- secret is HMAC(server key, nonce), recomputed at send time (see
-- src/lib/webhook-target.ts). A copy of this table alone cannot sign anything.
--
-- NULL for every row saved before this migration, and those deliveries go out
-- unsigned exactly as they did before, so nothing that receives one today
-- breaks. Re-saving the URL issues a secret. Additive; apply before the code.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS webhook_secret_nonce TEXT;
