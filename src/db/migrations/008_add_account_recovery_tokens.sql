-- 008: account_recovery_tokens. A way back in for someone who closed the tab.
--
-- The API key is shown once, in the browser, and it is also the console
-- password: /app authenticates by pasting it. So losing the key loses the
-- account, and until now the only route back was mailing a human.
--
-- What this table is NOT: a second secret model. There is still exactly one
-- credential on an account, the API key. A row here is a short-lived, single
-- use claim that whoever holds the mailbox may see or replace that key. It
-- authenticates nothing else and it grants no API access of its own.
--
-- Only the HASH is stored. A token is 32 random bytes, handed out once in a
-- link and never written down anywhere else, so a dump of this table cannot be
-- replayed into an account. consumed_at is set inside the same UPDATE that
-- checks it, which is what makes a token single use under concurrency, and
-- expiry is compared by the database clock for the same reason every other
-- deadline in this schema is: an app-side comparison turns clock skew into a
-- window where a dead token still opens.

CREATE TABLE IF NOT EXISTS account_recovery_tokens (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash  TEXT        NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

-- The lookup every request on this path makes.
CREATE INDEX IF NOT EXISTS idx_recovery_token_hash
  ON account_recovery_tokens (token_hash);

-- Used to retire an account's older outstanding tokens when a new one is
-- minted, so a stack of live links cannot accumulate in a mailbox.
CREATE INDEX IF NOT EXISTS idx_recovery_account_live
  ON account_recovery_tokens (account_id) WHERE consumed_at IS NULL;
