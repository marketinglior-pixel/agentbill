-- 035: public links to an account's office (2026-09-26).
--
-- The office's payroll card (#97) was drawn in the browser and never left it.
-- A public link needs a page anyone can open and an image a feed can preview,
-- so a share is stored: what the owner chose to show, frozen when they made it.
--
--   token        the link's secret: 24 url-safe characters from 18 random
--                bytes. Stored as it is, not hashed, because the page it
--                opens is public by the owner's choice and the console lists
--                the link back to them; a hash would protect nothing the link
--                itself does not already hand to whoever holds it.
--   show_names   the owner chose to show agent names; otherwise the snapshot
--                holds "agent 1", "agent 2", ... and no name anywhere
--   show_usd     the owner chose to show dollars; otherwise the snapshot holds
--                no salary, no payroll and no amount anywhere
--   snapshot     the office as the public page draws it (src/lib/share.ts
--                snapshotOf): built on the server from the account's rows with
--                the two choices already applied, never taken from the browser
--   card_png     the 1200x630 card the owner's browser drew with the same two
--                choices, checked (src/lib/share.ts checkCardPng) before it is
--                stored; NULL when it was made without JavaScript
--   stopped_at   the owner stopped sharing: the page and the image answer 404
--
-- A new table, so nothing already running reads or writes it. Apply before the
-- code; re-running it is a no-op. Roll back the code, not this file.

SET lock_timeout = '500ms';

CREATE TABLE IF NOT EXISTS office_shares (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token       TEXT NOT NULL UNIQUE CHECK (token ~ '^[A-Za-z0-9_-]{24}$'),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  month       TEXT NOT NULL CHECK (month ~ '^[0-9]{4}-[0-9]{2}$'),
  show_names  BOOLEAN NOT NULL,
  show_usd    BOOLEAN NOT NULL,
  snapshot    JSONB NOT NULL,
  card_png    BYTEA CHECK (card_png IS NULL OR octet_length(card_png) <= 1048576),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  stopped_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_office_shares_account ON office_shares (account_id, created_at DESC);

-- Verify (expect 10 columns and the index):
--   SELECT count(*) FROM information_schema.columns WHERE table_name = 'office_shares';
--   SELECT indexname FROM pg_indexes WHERE tablename = 'office_shares';
