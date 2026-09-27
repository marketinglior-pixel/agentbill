-- 037: the campaign label an account was created under (2026-09-27).
--
-- site_pulse has counted page loads and /register loads per ?src= label since
-- migration 012, but the account itself never kept the label, so "did the
-- Meta campaign bring a signup?" could only be guessed from timestamps. Now
-- the label rides from /register?src=X to the account:
--
--   accounts.signup_source         the label, written ONCE, when the account
--                                  is created; never changed by a later sign-in
--   email_sign_in_tokens.source    the label carried by an emailed sign-in link
--                                  until the link is spent (the Google/GitHub
--                                  path carries it in the signed flow cookie)
--
-- It is our own label from our own links (src/lib/source.ts), never a referrer
-- and never anything a visitor typed; the CHECK is that same shape. NULL means
-- untagged, which is most accounts and every account made before this.
-- Additive and nullable: code that does not know these columns is unaffected.
-- Apply before the code; re-running it is a no-op.

SET lock_timeout = '500ms';

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS signup_source TEXT
  CHECK (signup_source ~ '^[a-z0-9][a-z0-9_-]{0,23}$');

ALTER TABLE email_sign_in_tokens ADD COLUMN IF NOT EXISTS source TEXT
  CHECK (source ~ '^[a-z0-9][a-z0-9_-]{0,23}$');

-- Verify (expect 2):
--   SELECT count(*) FROM information_schema.columns
--   WHERE (table_name, column_name) IN (('accounts','signup_source'), ('email_sign_in_tokens','source'));
