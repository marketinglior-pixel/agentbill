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

-- Seed: migrate existing hardcoded key to the DB
-- so the current setup keeps working after migration
INSERT INTO developer_api_keys (account_id, api_key, label)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'df9b76cf2027fa0850fa5328f19acd7b7bcbbf09a988727e2eddcf7a4f53e0c6',
  'legacy-hardcoded-key'
)
ON CONFLICT (api_key) DO NOTHING;
