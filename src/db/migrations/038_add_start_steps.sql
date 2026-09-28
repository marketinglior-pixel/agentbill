-- 038: which steps of the console's start screen an account reached (2026-09-28).
--
-- Six external accounts, six keys, and not one key ever used: no request, no
-- call, no 422, from any of them. Two of them said so the same day ("I don't
-- understand anything"; "I'm stuck at step 2, I don't understand what the
-- mechanism expects"). Between "key created" and "nothing happened" the
-- server knew nothing: not which way in they chose, not whether they copied a
-- sample. This counts it, per account and per step:
--
--   step      from a closed set in src/lib/start-steps.ts: the start screen
--             shown, a card chosen (via:claude-code, via:python, ...), a client
--             named on the Claude Code path, a sample or key copied (copy:<id>)
--   n         how many times; first_at, last_at the first and latest
--
-- Nothing typed is stored: not the client name, not what was copied. The
-- account's own console, read by us to see where setup stops. Additive: code
-- that does not know this table is unaffected. Apply before the code.

SET lock_timeout = '500ms';

CREATE TABLE IF NOT EXISTS start_steps (
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  step        TEXT NOT NULL CHECK (step ~ '^[a-z][a-z0-9_:-]{0,47}$'),
  n           INTEGER NOT NULL DEFAULT 1 CHECK (n > 0),
  first_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, step)
);

-- Verify (expect 5):
--   SELECT count(*) FROM information_schema.columns WHERE table_name = 'start_steps';
