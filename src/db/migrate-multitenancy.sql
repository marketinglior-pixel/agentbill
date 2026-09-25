-- Multi-tenancy migration
-- Run once: psql $DATABASE_URL -f src/db/migrate-multitenancy.sql

-- Add email + plan to accounts
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS email TEXT UNIQUE;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS name  TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS plan  TEXT NOT NULL DEFAULT 'free';

-- API keys table — one account can have multiple keys
CREATE TABLE IF NOT EXISTS developer_api_keys (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  api_key    TEXT        NOT NULL UNIQUE,
  label      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_key
  ON developer_api_keys (api_key);

-- There was a seed INSERT here until 2026-09-25: a working API key, written
-- out in this public file, attached to the seed account ...0001 under the label
-- 'legacy-hardcoded-key'. Every database built from this chain had it, and it
-- was live on production until it was revoked by hand on 2026-09-25. It is gone
-- from this file, and migration 019 revokes the row wherever an older copy of
-- this file already created it. A fresh schema needs no seed key: accounts get
-- their keys from POST /register.
