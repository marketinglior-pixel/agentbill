-- 027: the plaintext API key leaves the database (security batch B, S3).
--
-- ============================================================================
-- NOT PART OF THE CHAIN. DO NOT APPLY WITH 026. NEEDS LIOR'S SEPARATE GO.
-- ============================================================================
-- This file lives in src/db/migrations-later/ so that nothing that applies
-- src/db/migrations/*.sql (scripts/preflight/schema-files.sh, run.sh, a
-- hand-run loop) picks it up. It is the destructive half of 026 and it is a
-- point of no return: after it, the release before the key-hashing build
-- cannot authenticate anybody (it looks keys up by api_key), so a rollback
-- past that build is no longer possible. Apply it only when:
--
--   1. 026 is applied and verified on production, and
--   2. the build that looks keys up by key_hash has served production for a
--      while (days, not minutes) with no rollback, and
--   3. Lior has said go for THIS file, separately from 026 and the deploy.
--
-- The harness applies it on a scratch database in its second pass
-- (APPLY_LATER=1 ./scripts/preflight/run.sh --external) and every gate must
-- still be green there: the build does not depend on api_key being present.
--
-- WHAT IT DOES
--   * Refuses to run if any row's key_hash is not the hash of its api_key, or
--     any row has no hash: 026 must have held, or this would destroy the only
--     copy of a key the build can find.
--   * Drops 026's fill trigger: with the plaintext gone there is nothing to
--     fill from, and every INSERT from the build writes the hash itself.
--   * NULLs api_key on every row, drops its NOT NULL, its UNIQUE constraint
--     and the old lookup index.
--   * Installs a scrub trigger and a CHECK. The build still WRITES api_key
--     during the transition (src/lib/api-keys.ts, insertKey, so that a
--     rollback before this file keeps working), and from here on that value
--     is set to NULL before the row is stored, and the CHECK makes a stored
--     plaintext impossible whatever writes it. A raw INSERT that carries only
--     api_key (the previous build's shape) now fails on key_hash NOT NULL:
--     after this file, only code that hashes can mint a key.
--
-- NOT NULL vs DROP COLUMN. The column stays, NULL everywhere, because the
-- build writes it. The release after this one removes that write, and 028
-- then drops the column and the scrub trigger:
--   ALTER TABLE developer_api_keys DROP COLUMN api_key;   -- drops the CHECK with it
--   DROP FUNCTION developer_api_keys_scrub_plaintext();   -- after the trigger goes with the column
--
-- AFTER IT COMMITS
--   * UPDATE leaves the old row versions, with the plaintext, in the heap
--     until they are vacuumed, and a plain VACUUM marks the space reusable
--     without rewriting it. Run, as its own statement (it cannot run in a
--     transaction; the table is a few hundred rows, so the lock is brief):
--       VACUUM (FULL, ANALYZE) developer_api_keys;
--   * Backups and point-in-time recovery taken before this file still hold
--     every key that existed then, in plain text, until they age out of the
--     provider's retention. Keys created after this file never reach one.
--     A key that must not survive in an old backup has to be revoked; this
--     file cannot reach into a backup.
--
-- LOCKS. As 026: one table, locked first with a short lock_timeout, retried
-- by scripts/db/apply-migration.mjs. The build never selects api_key, so no
-- prepared statement of the build names a column this changes.

SET lock_timeout = '500ms';

BEGIN;

LOCK TABLE developer_api_keys IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM developer_api_keys
    WHERE key_hash IS NULL
       OR (api_key IS NOT NULL AND key_hash <> encode(sha256(convert_to(api_key, 'UTF8')), 'hex'))
  ) THEN
    RAISE EXCEPTION '027 refused: a row has no key_hash, or one that is not the hash of its api_key. 026 did not hold; nothing was changed.';
  END IF;
END
$$;

DROP TRIGGER IF EXISTS developer_api_keys_fill_hash ON developer_api_keys;
DROP FUNCTION IF EXISTS developer_api_keys_fill_hash();

ALTER TABLE developer_api_keys ALTER COLUMN api_key DROP NOT NULL;
ALTER TABLE developer_api_keys DROP CONSTRAINT IF EXISTS developer_api_keys_api_key_key;
DROP INDEX IF EXISTS idx_api_keys_key;

UPDATE developer_api_keys SET api_key = NULL WHERE api_key IS NOT NULL;

CREATE OR REPLACE FUNCTION developer_api_keys_scrub_plaintext() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.api_key := NULL;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS developer_api_keys_scrub_plaintext ON developer_api_keys;
CREATE TRIGGER developer_api_keys_scrub_plaintext
  BEFORE INSERT OR UPDATE ON developer_api_keys
  FOR EACH ROW EXECUTE FUNCTION developer_api_keys_scrub_plaintext();

ALTER TABLE developer_api_keys DROP CONSTRAINT IF EXISTS developer_api_keys_no_plaintext;
ALTER TABLE developer_api_keys ADD CONSTRAINT developer_api_keys_no_plaintext CHECK (api_key IS NULL);

COMMIT;

-- Verify (expect plaintext = 0, fill = 0, scrub = 1):
--   SELECT count(*) FILTER (WHERE api_key IS NOT NULL) AS plaintext,
--          (SELECT count(*) FROM pg_trigger WHERE tgname = 'developer_api_keys_fill_hash') AS fill,
--          (SELECT count(*) FROM pg_trigger WHERE tgname = 'developer_api_keys_scrub_plaintext') AS scrub
--   FROM developer_api_keys;
