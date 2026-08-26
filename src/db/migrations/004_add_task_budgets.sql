-- Migration 004: Cross-call task budgets — "this job dies at $5"
-- A task groups many preflight/record calls (across providers and tools)
-- under one hard ceiling with atomic reserve/reconcile, mirroring the
-- customer-level pattern.

CREATE TABLE IF NOT EXISTS task_budgets (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  agent_id       TEXT        NOT NULL,
  task_ref       TEXT        NOT NULL,
  ceiling_units  INTEGER     NOT NULL,
  used_units     INTEGER     NOT NULL DEFAULT 0,
  reserved_units INTEGER     NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT task_budgets_unique_per_account  UNIQUE (account_id, task_ref),
  CONSTRAINT task_budgets_ceiling_positive    CHECK (ceiling_units > 0),
  CONSTRAINT task_budgets_used_nonnegative    CHECK (used_units >= 0),
  CONSTRAINT task_budgets_reserved_nonnegative CHECK (reserved_units >= 0)
);

-- Attribution queries: "what did agent X's jobs cost lately"
CREATE INDEX IF NOT EXISTS idx_task_budgets_account_agent
  ON task_budgets (account_id, agent_id, created_at DESC);
