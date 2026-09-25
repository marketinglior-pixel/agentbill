-- 023: users, their sign-in identities, and the link from a user to an account.
--
-- Until now the console's only login was the API key itself: /app/session
-- signed a cookie over a key id, and an account was an email nobody had
-- verified plus the keys it held. This adds a person to the model. Additive
-- only: no existing column changes, and nothing here is read by the code that
-- is live before this migration. Apply it BEFORE the code that reads it.
--
-- users
--   One row per person who proved control of an email address, through Google
--   (email_verified === true), GitHub (a primary email with verified: true) or
--   an email sign-in link we mailed. email_verified_at is NOT NULL on purpose:
--   a users row with an unverified address cannot exist, so no code path can
--   treat one as verified by forgetting to check. session_epoch is what logout
--   bumps; every user session carries the epoch it was minted under and dies
--   when the row moves past it.
--
-- user_identities
--   provider in ('google', 'github', 'email'). provider_user_id is Google's
--   `sub`, GitHub's numeric `id` as text, or the lowercased address for an
--   email link. UNIQUE (provider, provider_user_id): one identity belongs to
--   one person. UNIQUE (user_id, provider): one Google, one GitHub, one email
--   per person, which keeps "which account does this sign-in open" a single
--   answer.
--
-- accounts.owner_user_id
--   The user-to-account link. A nullable column with a UNIQUE constraint, not a
--   membership table, because today an account has at most one person and a
--   person at most one account, and a column says exactly that. NULL is the ~45
--   accounts created before this migration: their owner signs in with the key
--   and connects Google or GitHub explicitly from the console. Nothing ever
--   fills this column by matching accounts.email, because no accounts.email was
--   ever verified (anyone could register anyone's address), so an email match
--   is not evidence of ownership. When teams arrive, a membership table is a
--   backfill from this column.
--
-- email_sign_in_tokens
--   The magic link. Only the SHA-256 of the token is stored, like
--   account_recovery_tokens (008). Single use: consumed_at is set by the same
--   UPDATE that checks it. Fifteen minutes, and the CHECK makes that a property
--   of the table rather than of whichever code path inserts: a row cannot be
--   written that lives longer. created_at doubles as the rank and rate record
--   for the mail ceiling in src/lib/mail.ts and the per-address limit in
--   src/routes/auth.ts, so a refused send still counts.
--
-- OAuth needs no table: state, the PKCE verifier and the nonce live in a
-- signed, HttpOnly, ten-minute cookie (src/lib/oauth.ts).

SET lock_timeout = '3s';

BEGIN;

CREATE TABLE IF NOT EXISTS users (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email             TEXT        NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
  email_verified_at TIMESTAMPTZ NOT NULL,
  session_epoch     INTEGER     NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_identities (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         TEXT        NOT NULL CHECK (provider IN ('google', 'github', 'email')),
  provider_user_id TEXT        NOT NULL CHECK (length(provider_user_id) BETWEEN 1 AND 320),
  -- The verified address the provider returned when this identity was linked.
  -- A record, not a key: sign-in looks identities up by provider_user_id.
  email            TEXT        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_user_id),
  UNIQUE (user_id, provider)
);

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_owner_user_id_key') THEN
    ALTER TABLE accounts ADD CONSTRAINT accounts_owner_user_id_key UNIQUE (owner_user_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS email_sign_in_tokens (
  id          BIGSERIAL   PRIMARY KEY,
  email       TEXT        NOT NULL CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
  token_hash  TEXT        NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  -- Where the sign-in lands afterwards, already validated to a same-host path.
  next_path   TEXT        CHECK (next_path IS NULL OR next_path ~ '^/app'),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CONSTRAINT email_sign_in_tokens_fifteen_minutes CHECK (expires_at <= created_at + INTERVAL '15 minutes')
);

-- The per-address count every request makes, and the retirement of an
-- address's older live links when a new one is minted.
CREATE INDEX IF NOT EXISTS idx_email_sign_in_tokens_email
  ON email_sign_in_tokens (email, created_at);
-- The mail ceiling's rank over one UTC hour and day.
CREATE INDEX IF NOT EXISTS idx_email_sign_in_tokens_created
  ON email_sign_in_tokens (created_at);

COMMIT;
