-- 017: an event says which job it belongs to, and what it cost at list price.
--
-- task_ref. Until now an events row did not say which job it was recorded
-- for: task_ref moved task_budgets.used_units and was then dropped, so
-- "which model, which step, how many tokens" could not be asked of a job at
-- all. GET /tasks/:task_ref reads its breakdown from this column. Rows
-- written before it are NULL and are not in any breakdown; the breakdown says
-- how many of the job's units it could not attribute.
--
-- price_version, list_price_usd, price_note. For a record whose metadata
-- names a model call (the shape wrap() writes: provider, model, tokens), the
-- server prices the tokens at public list price from the snapshot in
-- src/lib/price-snapshot.ts and stores the figure beside the name of that
-- snapshot. It is an estimate, and every surface that shows it says so: list
-- price, not the invoice. A call it cannot price keeps list_price_usd NULL
-- and says why in price_note ("no list price for <model>"). NULL is never
-- read as 0: a reader counts it as unpriced. NUMERIC because the figure is
-- exact to the picodollar (src/lib/prices.ts) and a sum of NUMERIC is exact.
--
-- Nullable, no default, no constraint: four catalog changes, no table
-- rewrite and no scan. The running build names its columns on every events
-- INSERT and never selects * from events, so it neither writes nor reads
-- these, and a prepared statement of its survives the change: safe to apply
-- while the previous version is serving, and required before the code that
-- writes them. lock_timeout so a busy table makes this give up and be retried
-- (scripts/db/apply-migration.mjs does that) instead of queueing writes behind
-- it. Re-running it is a no-op.

SET lock_timeout = '2s';

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS task_ref       TEXT,
  ADD COLUMN IF NOT EXISTS price_version  TEXT,
  ADD COLUMN IF NOT EXISTS list_price_usd NUMERIC,
  ADD COLUMN IF NOT EXISTS price_note     TEXT;
