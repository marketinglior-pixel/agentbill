-- 019: revoke the key that migrate-multitenancy.sql used to seed.
--
-- Until 2026-09-25 that file ended with an INSERT of a working API key, in
-- plain text, in a public repository, on the seed account ...0001 with the
-- label 'legacy-hardcoded-key'. Every database built from the chain had the
-- row. Production's copy was revoked by hand on 2026-09-25 and read back
-- (revoked_at set, a live request answered key_revoked); the INSERT is gone
-- from the file in the same change as this migration.
--
-- This closes it wherever else the row exists: a staging copy, a restored
-- backup, a laptop database built from an older checkout. It matches the row
-- two ways, so a copy that was relabelled is still caught: by the label, and
-- by the SHA-256 of the key itself. The hash is here instead of the key so
-- that this file does not publish the credential a second time.
--
-- Idempotent and additive. A row already revoked in the past is left exactly
-- as it is (its revoked_at is the record of when it was closed); a row with no
-- revoked_at, or one parked in a future grace window by /keys/rotate, is
-- revoked now. Running it twice changes nothing the second time. Safe to apply
-- before or after the code in the same deploy: nothing reads the label.

UPDATE developer_api_keys
SET revoked_at = NOW()
WHERE (label = 'legacy-hardcoded-key'
       OR encode(sha256(convert_to(api_key, 'UTF8')), 'hex') = 'aa759fef4307b14170837d3c226ac284414ff2c7c7e41ce8a2194faa5a2c8b42')
  AND (revoked_at IS NULL OR revoked_at > NOW());
