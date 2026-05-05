-- Fix TOCTOU race condition in preflight.
-- Adds reserved_units so preflight atomically reserves budget before a run starts.
-- Events (record) reconciles: releases the reservation and increments used_units.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS reserved_units INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'customers_reserved_nonnegative'
  ) THEN
    ALTER TABLE customers
      ADD CONSTRAINT customers_reserved_nonnegative CHECK (reserved_units >= 0);
  END IF;
END $$;
