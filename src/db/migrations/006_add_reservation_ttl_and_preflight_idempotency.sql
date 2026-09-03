-- Migration 006: make preflight correct under abandonment, retry and concurrency.
--
-- Three defects this closes, all of them on the money path:
--
-- 1. ABANDONED RESERVATIONS. reserved_units was a bare counter with nothing
--    behind it. preflight incremented it, record() decremented it, and a run
--    that died in between left its units claimed forever with no expiry and no
--    sweeper. The counter alone cannot be swept, because it does not know how
--    much of itself is stale. So reservations become rows, and the counter
--    becomes their sum. The invariant every path now maintains:
--
--        customers.reserved_units    == SUM(units) of open rows for that customer
--        task_budgets.reserved_units == SUM(units) of open rows for that task
--
--    Every path changes a counter by exactly the units of the rows it closes,
--    which is what makes double-release impossible: a reservation the sweeper
--    already reclaimed has no open row left for record() to consume, so the
--    late record() adjusts used_units and leaves reserved_units alone.
--
-- 2. PREFLIGHT WAS NOT IDEMPOTENT. /events has enforced (account_id,
--    idempotency_key) UNIQUE since the beginning. preflight had nothing, so
--    every retry of the same logical call reserved units again and the
--    mechanism meant to prevent waste was the one consuming the budget.
--    preflight_requests gives it the same guarantee: same key, same decision,
--    one reservation.
--
-- 3. (no schema needed) The monthly plan quota was read, checked and
--    incremented in three separate unlocked statements, so N concurrent calls
--    at the limit all passed. That is fixed in code, in preflight.ts, by
--    folding the check and the increment into one conditional UPDATE inside
--    the same transaction as the reservation.
--
-- Ordering note: apply this before deploying the matching code. The new code
-- reads both tables on every preflight; the old code ignores them, so the
-- migration is safe to apply while the previous version is still serving.

-- ---------------------------------------------------------------------------
-- reservations
-- One row per preflight that reserved units, open until settled or swept.
-- task_ref is NULL for a reservation with no task budget, and rows are matched
-- on settle with IS NOT DISTINCT FROM so a NULL task_ref matches a NULL one.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reservations (
  id          BIGSERIAL   PRIMARY KEY,
  account_id  UUID        NOT NULL REFERENCES accounts(id)  ON DELETE CASCADE,
  customer_id UUID        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  task_ref    TEXT,
  units       INTEGER     NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,                        -- NULL = still holding budget
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT reservations_units_positive CHECK (units > 0)
);

-- The settle path: oldest open rows for one (customer, task), FIFO.
CREATE INDEX IF NOT EXISTS idx_reservations_open_customer
  ON reservations (customer_id, created_at, id)
  WHERE released_at IS NULL;

-- The sweeper's only query: open rows past their expiry, oldest first.
CREATE INDEX IF NOT EXISTS idx_reservations_open_expired
  ON reservations (expires_at)
  WHERE released_at IS NULL;

-- ---------------------------------------------------------------------------
-- preflight_requests
-- Same contract as events.idempotency_key: same key = same decision, always.
-- response is NULL only in the window between the deciding transaction
-- committing and the body being written; a retry that lands inside that window
-- is answered 409 preflight_in_progress rather than being allowed to reserve
-- a second time. JSON, not JSONB, so a replay returns the body verbatim.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS preflight_requests (
  id              BIGSERIAL   PRIMARY KEY,
  account_id      UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  idempotency_key TEXT        NOT NULL,
  response        JSON,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT pr_key_nonempty CHECK (char_length(idempotency_key) > 0),
  CONSTRAINT pr_key_maxlen   CHECK (char_length(idempotency_key) <= 128),
  CONSTRAINT pr_key_unique   UNIQUE (account_id, idempotency_key)
);
