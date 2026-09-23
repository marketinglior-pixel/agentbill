-- 014: task_budgets.unit. What the numbers on a job count.
--
-- Until now a job's ceiling, used and reserved were bare integers, and two
-- jobs could be counted in different things with nothing in the row to say so.
-- The OpenClaw plugin records tokens; every SDK sample records units a
-- developer chose. A list sorted by used_units, or an average across jobs,
-- then mixes the two without a word.
--
-- The value is declared, never inferred: 'unit' (the developer's own unit,
-- the default and what every existing row is) or 'token' (a count the
-- caller's provider reported). AgentBill still counts nothing itself; the
-- column labels the number the caller sends, and GET /tasks and the console
-- print it next to that number.
--
-- It is fixed when the job opens. A later preflight or PUT that declares a
-- different unit for the same task_ref is a 422 task_unit_mismatch, never a
-- silent relabel, because relabelling a job halfway through would turn every
-- number already in it into a different quantity.
--
-- ADD COLUMN with a constant default is a catalog change, no rewrite. The old
-- code never names the column, so it keeps writing 'unit' by default: safe to
-- apply while the previous version is serving, and required before the code
-- that selects it.

ALTER TABLE task_budgets ADD COLUMN IF NOT EXISTS unit TEXT NOT NULL DEFAULT 'unit';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_budgets_unit_known') THEN
    ALTER TABLE task_budgets
      ADD CONSTRAINT task_budgets_unit_known CHECK (unit IN ('unit', 'token'));
  END IF;
END $$;
