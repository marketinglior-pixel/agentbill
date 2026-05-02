-- AgentBill MVP Schema
-- Run once: psql $DATABASE_URL -f src/db/schema.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- accounts
-- One row per AgentBill developer account.
-- For MVP: seeded with a single hardcoded test account.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  default_budget_units INTEGER,                        -- NULL = unlimited by default for new customers
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- customers
-- One row per end-user of the developer's agent product.
-- Auto-created (lazy) on first event or budget check.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customers (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  customer_ref TEXT        NOT NULL,                   -- developer's own opaque customer ID
  limit_units  INTEGER,                                -- NULL = unlimited (pay-as-you-go)
  used_units   INTEGER     NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT customers_used_nonnegative CHECK (used_units >= 0),
  CONSTRAINT customers_unique_per_account UNIQUE (account_id, customer_ref)
);

-- Fast lookup by (account, customer_ref) — used on every request
CREATE INDEX IF NOT EXISTS idx_customers_account_ref
  ON customers (account_id, customer_ref);

-- ---------------------------------------------------------------------------
-- events
-- One row per billable agent action.
-- Idempotency enforced at DB level: (account_id, idempotency_key) is UNIQUE.
-- Duplicate inserts are rejected by Postgres; the app returns 200 duplicate_ignored.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  customer_id     UUID        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  event_type      TEXT        NOT NULL,
  units           INTEGER     NOT NULL DEFAULT 1,
  idempotency_key TEXT        NOT NULL,
  metadata        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT events_units_positive      CHECK (units >= 1),
  CONSTRAINT events_event_type_nonempty CHECK (char_length(event_type) > 0),
  CONSTRAINT events_idempotency_nonempty CHECK (char_length(idempotency_key) > 0),
  CONSTRAINT events_idempotency_maxlen   CHECK (char_length(idempotency_key) <= 128),

  -- The core idempotency guarantee: same key = same event, always.
  CONSTRAINT events_idempotency_unique UNIQUE (account_id, idempotency_key)
);

-- Lookup events per customer (dashboard, audit)
CREATE INDEX IF NOT EXISTS idx_events_customer_id
  ON events (customer_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Seed: hardcoded test account for MVP
-- ID matches HARDCODED_ACCOUNT_ID in .env.example
-- ---------------------------------------------------------------------------
INSERT INTO accounts (id, default_budget_units)
VALUES ('00000000-0000-0000-0000-000000000001', 100)
ON CONFLICT (id) DO NOTHING;
