CREATE TABLE IF NOT EXISTS step_costs (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  agent_id   TEXT        NOT NULL,
  step_name  TEXT        NOT NULL,
  units      INTEGER     NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_step_costs_agent_step
  ON step_costs (account_id, agent_id, step_name, created_at DESC);
