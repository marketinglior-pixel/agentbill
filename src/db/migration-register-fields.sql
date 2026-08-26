-- Register fields migration
-- Adds use_case and stack to accounts for onboarding analytics.
-- Run: psql $DATABASE_URL -f src/db/migration-register-fields.sql

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS use_case TEXT,
  ADD COLUMN IF NOT EXISTS stack    TEXT;
