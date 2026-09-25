-- 026: API keys are looked up by a hash (security batch B, S3, 2026-09-25).
--
-- Adds three columns to developer_api_keys and fills them for every row:
--
--   key_hash    SHA-256 of the whole key, hex. UNIQUE. The only thing the code
--               after this looks a key up by (src/lib/api-keys.ts).
--   key_prefix  agb_ and the first 4 hex characters.
--   key_last4   the last 4 characters.
--               Together the two are what every surface shows: agb_1234…abcd.
--
-- The expression is the one migration 019 already uses to find a key by its
-- hash, so the two agree byte for byte: encode(sha256(convert_to(api_key,
-- 'UTF8')), 'hex').
--
-- ORDER: BEFORE the code. Apply this, verify it (the query at the end), then
-- deploy the build that looks keys up by key_hash. The build before this one
-- never names the new columns, and selects developer_api_keys by explicit
-- columns only (no SELECT *), so its prepared statements survive the ADD
-- COLUMN; scripts/preflight/alter-under-load.sh rehearses exactly that, with
-- the previous build serving and prepared statements ON.
--
-- THE ROLLOUT WINDOW. Between this migration and the deploy, the previous
-- build is still minting keys (POST /keys/generate, /keys/rotate, /recover,
-- the console's first key), and it writes only api_key. The trigger below
-- fills all three columns from api_key on every INSERT and UPDATE while
-- api_key is present, so a key minted in that window has a hash the moment
-- it exists and the new build finds it. It also keeps the three columns
-- honest while both are written: whatever a caller sends, the hash stored is
-- the hash of the api_key stored.
--
-- NOT NULL, here rather than in 027. Inside one transaction, with the table
-- locked, every existing row is backfilled and every new row goes through the
-- trigger, so no row can reach the constraint without its hash: it cannot
-- fail on live traffic, and adding it now means a broken trigger is a loud
-- error on the very next INSERT instead of a key that silently cannot log in
-- after the deploy. 027 then has nothing to verify but the plaintext.
--
-- LOCKS. developer_api_keys is locked first, alone, with a short
-- lock_timeout, and only then altered. The migration touches no other table,
-- so it cannot be part of a deadlock cycle; the timeout is for a busy table:
-- it gives up, changes nothing, and scripts/db/apply-migration.mjs tries
-- again. While it holds the lock, every request that authenticates waits for
-- it, for as long as the backfill and the index build take. That is one row
-- per key, a few hundred in production: milliseconds. Check first:
--   SELECT count(*), pg_size_pretty(pg_total_relation_size('developer_api_keys')) FROM developer_api_keys;
-- The index is built inside the transaction, not CONCURRENTLY, because
-- CONCURRENTLY cannot run in a transaction and the index, the backfill and
-- NOT NULL must commit together.
--
-- Additive and idempotent: re-running it changes nothing. Roll back the code,
-- not this file: the previous build ignores the three columns, and keeps
-- working with them in place.

SET lock_timeout = '500ms';

BEGIN;

LOCK TABLE developer_api_keys IN ACCESS EXCLUSIVE MODE;

ALTER TABLE developer_api_keys
  ADD COLUMN IF NOT EXISTS key_hash   TEXT,
  ADD COLUMN IF NOT EXISTS key_prefix TEXT,
  ADD COLUMN IF NOT EXISTS key_last4  TEXT;

CREATE OR REPLACE FUNCTION developer_api_keys_fill_hash() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.api_key IS NOT NULL THEN
    NEW.key_hash   := encode(sha256(convert_to(NEW.api_key, 'UTF8')), 'hex');
    NEW.key_prefix := left(NEW.api_key, 8);
    NEW.key_last4  := right(NEW.api_key, 4);
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS developer_api_keys_fill_hash ON developer_api_keys;
CREATE TRIGGER developer_api_keys_fill_hash
  BEFORE INSERT OR UPDATE ON developer_api_keys
  FOR EACH ROW EXECUTE FUNCTION developer_api_keys_fill_hash();

-- The backfill. Written out rather than left to the trigger, so this file says
-- what it computes; the trigger computes the same thing on the way through.
UPDATE developer_api_keys
SET key_hash   = encode(sha256(convert_to(api_key, 'UTF8')), 'hex'),
    key_prefix = left(api_key, 8),
    key_last4  = right(api_key, 4)
WHERE api_key IS NOT NULL
  AND (key_hash IS DISTINCT FROM encode(sha256(convert_to(api_key, 'UTF8')), 'hex')
       OR key_prefix IS DISTINCT FROM left(api_key, 8)
       OR key_last4 IS DISTINCT FROM right(api_key, 4));

CREATE UNIQUE INDEX IF NOT EXISTS developer_api_keys_key_hash_key ON developer_api_keys (key_hash);

ALTER TABLE developer_api_keys
  ALTER COLUMN key_hash   SET NOT NULL,
  ALTER COLUMN key_prefix SET NOT NULL,
  ALTER COLUMN key_last4  SET NOT NULL;

ALTER TABLE developer_api_keys DROP CONSTRAINT IF EXISTS developer_api_keys_key_hash_shape;
ALTER TABLE developer_api_keys ADD CONSTRAINT developer_api_keys_key_hash_shape CHECK (key_hash ~ '^[0-9a-f]{64}$');

COMMIT;

-- Verify (expect missing = 0, mismatched = 0, trigger = 1):
--   SELECT count(*) FILTER (WHERE key_hash IS NULL OR key_prefix IS NULL OR key_last4 IS NULL) AS missing,
--          count(*) FILTER (WHERE key_hash <> encode(sha256(convert_to(api_key, 'UTF8')), 'hex')) AS mismatched,
--          (SELECT count(*) FROM pg_trigger WHERE tgname = 'developer_api_keys_fill_hash') AS trigger
--   FROM developer_api_keys;
