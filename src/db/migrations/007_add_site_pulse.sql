-- 007: site_pulse. What visitors do on the public pages, recorded in our own
-- database rather than someone else's.
--
-- Why not a pixel. META_PIXEL_ID has never been set, so fbq does not exist on
-- any page; the only live pixel is Reddit's, for a channel killed 2026-09-03.
-- Beyond that, the ICP is developers, which is the population most likely to
-- block an ad pixel, so a pixel would under-count exactly the people this is
-- meant to measure. voice-dna: prefer the metric the platform cannot revise.
--
-- What a row is NOT: a person. view_id is a random token minted in the page at
-- load and held in a JS variable. It is never written to a cookie or to
-- localStorage and it dies with the tab, so it separates "ten visitors ran it
-- once" from "one visitor ran it ten times" and cannot follow anyone between
-- visits. No IP address and no user agent is stored on the row; the IP is used
-- only in memory, for rate limiting, and never persisted.

CREATE TABLE IF NOT EXISTS site_pulse (
  id         BIGSERIAL PRIMARY KEY,
  event      TEXT NOT NULL,
  view_id    TEXT,
  ceiling    INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_site_pulse_event_time ON site_pulse (event, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_site_pulse_view ON site_pulse (view_id);
