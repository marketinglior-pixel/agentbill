-- 012: site_pulse.source. Which surface sent this page view.
--
-- Why it exists. Until now every row in site_pulse was anonymous as to origin,
-- and so was every row in accounts (id, default_budget_units, created_at). A
-- registration that arrived from a directory listing was indistinguishable, in
-- the data, from one that arrived from the paid campaign. That was tolerable
-- while exactly one channel was running. It stops being tolerable the moment a
-- second one does, because the funnel tiles on /admin are the only read the ad
-- spend buys, and mixed traffic makes that read unrecoverable after the fact.
--
-- What it is NOT. Not a referrer and not a user agent: nothing here is derived
-- from the request. The value is a short opaque label WE put in the link we
-- published, echoed back by the page from ?src= in its own URL. A visitor who
-- strips the parameter is recorded with no source, which is the correct answer
-- and not a gap to be filled by sniffing. Migration 007's privacy posture is
-- unchanged: still no IP, still no user agent, still no cookie.
--
-- Nullable on purpose, and most rows will stay null. Organic traffic carries
-- no src, and neither does the Meta campaign: its creatives are immutable, so
-- the running ads cannot be retagged. Null therefore means "not a surface we
-- tagged", never "unknown". The question this column answers is narrower than
-- full attribution and is the one actually being asked: how much of the funnel
-- is traffic we went out and fetched.

ALTER TABLE site_pulse ADD COLUMN IF NOT EXISTS source TEXT;

-- The read is always "this source, over this window", never a scan for one row.
CREATE INDEX IF NOT EXISTS idx_site_pulse_source_time
  ON site_pulse (source, created_at DESC)
  WHERE source IS NOT NULL;
