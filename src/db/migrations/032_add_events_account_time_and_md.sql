-- 032: what the console's dashboard reads events by (M2, 2026-09-26).
--
-- 1. idx_events_account_time (account_id, created_at DESC). Every windowed
--    read of events (the dashboard's cards, /usage, the console's series)
--    filters on account_id and a created_at range, and no index was keyed on
--    both: the planner used the account_id prefix of the idempotency unique
--    index, or scanned. events is small today, so this is a plain CREATE
--    INDEX under a short lock_timeout (apply-migration.mjs retries), not
--    CONCURRENTLY, which cannot run in the migration's transaction.
--
-- 2. agentbill_event_md(jsonb): an event's metadata as an object, whatever
--    shape it was stored in. Records written before 2026-09-23 hold a JSON
--    STRING whose text is the object (src/routes/events.ts), so
--    metadata->>'model' is NULL for them and (metadata #>> '{}')::jsonb is the
--    object. A cast that fails (a string that is not JSON) returns NULL
--    instead of failing the page: one old malformed record must not turn the
--    dashboard into a 500. IMMUTABLE, so it can be indexed later if needed.
--
-- Additive; apply before the code. Re-running it is a no-op. Roll back the
-- code, not this file.

SET lock_timeout = '500ms';

CREATE INDEX IF NOT EXISTS idx_events_account_time ON events (account_id, created_at DESC);

CREATE OR REPLACE FUNCTION agentbill_event_md(m jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  IF m IS NULL THEN RETURN NULL; END IF;
  IF jsonb_typeof(m) = 'object' THEN RETURN m; END IF;
  IF jsonb_typeof(m) = 'string' THEN
    BEGIN
      m := (m #>> '{}')::jsonb;
    EXCEPTION WHEN others THEN
      RETURN NULL;
    END;
    IF jsonb_typeof(m) = 'object' THEN RETURN m; END IF;
  END IF;
  RETURN NULL;
END
$$;

-- Verify (expect 1 and {"model": "x"}):
--   SELECT count(*) FROM pg_indexes WHERE indexname = 'idx_events_account_time';
--   SELECT agentbill_event_md('"{\"model\": \"x\"}"'::jsonb);
