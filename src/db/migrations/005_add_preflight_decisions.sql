-- Migration 005: persist refusals.
-- The refusal IS the product and until now it left no trace: every
-- approved:false path returned JSON and wrote nothing, and the
-- task_ceiling_exceeded path throws inside sql.begin() on purpose so the
-- rollback discarded the fact along with the reservation. A user who got
-- saved four times last month had no way to know it.
--
-- One row per decision that matters: a block (blocked = true) or, from the
-- record path, spend that landed past a task ceiling anyway, because preflight
-- was skipped or the actual exceeded the estimate it approved (blocked = false,
-- reason task_overrun_recorded). Approvals are not stored; at 2M calls/mo they
-- would drown the signal.
--
-- snapshot is JSON, not JSONB, on purpose: JSON stores the text verbatim, so
-- the read path can return byte-identical bodies. Nothing indexes or filters it.
-- Unit columns are BIGINT: the API bounds them with positive() only, and a
-- lost row on an out-of-range value would be a silent hole in the receipt.

CREATE TABLE IF NOT EXISTS preflight_decisions (
  id              BIGSERIAL   PRIMARY KEY,
  account_id      UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  agent_id        TEXT,                                   -- NULL when the caller did not name one
  customer_ref    TEXT,
  task_ref        TEXT,
  reason          TEXT        NOT NULL,                   -- the raw API reason string, greppable
  source          TEXT        NOT NULL DEFAULT 'preflight',   -- 'preflight' | 'events'
  blocked         BOOLEAN     NOT NULL DEFAULT true,      -- false = spend got through (a leak, not a save)
  estimated_units BIGINT,
  ceiling_units   BIGINT,
  used_units      BIGINT,
  snapshot        JSON        NOT NULL,                   -- the exact body the SDK received, verbatim
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT pd_reason_nonempty CHECK (char_length(reason) > 0),
  CONSTRAINT pd_source_known    CHECK (source IN ('preflight', 'events'))
);

-- "what happened to my account lately", newest first
CREATE INDEX IF NOT EXISTS idx_pd_account_time
  ON preflight_decisions (account_id, created_at DESC);

-- "what happened to this job"
CREATE INDEX IF NOT EXISTS idx_pd_account_task
  ON preflight_decisions (account_id, task_ref, created_at DESC)
  WHERE task_ref IS NOT NULL;
