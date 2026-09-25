-- 030: developer_api_keys.session_epoch, so logging out of a key session
-- ends it on the server (security batch C, S17, 2026-09-25).
--
-- A console session signed in with a key was a cookie over the key id and an
-- expiry, and nothing on the server remembered it. POST /app/logout cleared
-- the cookie in that browser only, so a copy of it (another device, a stolen
-- cookie jar) kept opening the console for the rest of its seven days.
-- A person's session already had this (users.session_epoch, migration 023).
--
-- Every key session cookie now carries the epoch it was minted under, and
-- loadSession compares it with this column; logout moves the column on, so
-- every cookie minted before it is dead on its next request. The epoch is
-- per key: logging out of a key session ends every console session opened
-- with that key, on every device.
--
-- Additive only, a constant default: a catalog change, no rewrite. The build
-- before this one never names the column and selects developer_api_keys by
-- explicit columns only (scripts/preflight/alter-under-load.sh,
-- ALTER_MIGRATION=030_add_key_session_epoch.sql, rehearses it with that build
-- serving and prepared statements on). ORDER: before the code. Re-running it
-- is a no-op. Roll back the code, not this file.

SET lock_timeout = '500ms';

ALTER TABLE developer_api_keys ADD COLUMN IF NOT EXISTS session_epoch INTEGER NOT NULL DEFAULT 0;

-- Verify (expect one row, integer, NO):
--   SELECT data_type, is_nullable FROM information_schema.columns
--   WHERE table_name = 'developer_api_keys' AND column_name = 'session_epoch';
