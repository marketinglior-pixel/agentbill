-- 018: the one lookup GET /tasks/:task_ref's breakdown makes, indexed.
--
-- Its own file, and the only statement in it, because CREATE INDEX
-- CONCURRENTLY cannot run inside a transaction block, and a file with more
-- than one statement is run as one (psql -f runs it statement by statement;
-- scripts/db/apply-migration.mjs sends the file as one query). CONCURRENTLY
-- because a plain CREATE INDEX holds a lock that blocks every insert into
-- events for as long as the build takes, and every record() is an insert.
--
-- Partial: only rows written from 017 on carry a task_ref, so the rows before
-- it cost nothing here. Apply after 017; the code that reads it works without
-- it, only slower on an account with many events.
--
-- If a build is interrupted it leaves an INVALID index behind, and IF NOT
-- EXISTS then skips it. Check before relying on it:
--   SELECT indisvalid FROM pg_index WHERE indexrelid = 'idx_events_account_task'::regclass;
-- false: DROP INDEX CONCURRENTLY idx_events_account_task; and run this file again.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_account_task
  ON events (account_id, task_ref)
  WHERE task_ref IS NOT NULL;
