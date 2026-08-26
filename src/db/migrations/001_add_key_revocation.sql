-- Migration 001: Add API key revocation support
-- Run once against the production database before deploying the new code.

ALTER TABLE developer_api_keys
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;

-- Index speeds up the auth middleware lookup which now reads revoked_at on every request
CREATE INDEX IF NOT EXISTS idx_developer_api_keys_api_key_revoked
  ON developer_api_keys (api_key)
  WHERE revoked_at IS NULL;
