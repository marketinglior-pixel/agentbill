-- Polar integration migration
-- Run: psql $DATABASE_URL -f src/db/polar-migration.sql

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS polar_customer_id    TEXT,
  ADD COLUMN IF NOT EXISTS monthly_calls        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS billing_period_start DATE    NOT NULL DEFAULT date_trunc('month', CURRENT_DATE)::DATE;
