-- 034: the setup guide's two remembered facts (2026-09-26).
--
-- The console's setup guide (src/lib/setup.ts) walks a new account through six
-- steps. Five of them are read from the rows the product already writes (a
-- key or an MCP grant, a priced call, a customer_id, a job ceiling, a
-- refusal), so nothing records them. Two things have no row of their own:
--   setup_office_seen_at  the sixth step, "meet the office": set on the
--                         account's first visit to /app?view=office
--   setup_hidden_at       the guide was hidden by its owner; it stays hidden
--
-- Additive, nullable, no default: a catalog change, no rewrite. The build
-- before this one never names either column. Apply before the code; re-running
-- it is a no-op. Roll back the code, not this file.

SET lock_timeout = '500ms';

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS setup_office_seen_at TIMESTAMPTZ;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS setup_hidden_at TIMESTAMPTZ;

-- Verify (expect 2):
--   SELECT count(*) FROM information_schema.columns
--   WHERE table_name = 'accounts' AND column_name IN ('setup_office_seen_at', 'setup_hidden_at');
