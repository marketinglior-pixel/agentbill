-- 013: reservations.public_id. The handle preflight gives back so record() can
-- settle the call's OWN reservation.
--
-- Why it is needed. record(units=actual) closes reservation rows FIFO until
-- `actual` units are covered, and a reservation bigger than the actual is only
-- SHRUNK: the difference stays held until the 60-minute sweeper takes it. A
-- caller that reserves the worst case (input plus max_tokens) and records the
-- real usage therefore strands most of every reservation. Estimate 70,000,
-- use 8,000, against a ceiling of 500,000, and the job is refused on the 8th
-- call with 56,000 spent. Nothing surfaced it before because every published
-- sample records exactly the number it reserved.
--
-- Why not reservations.id. It is a global BIGSERIAL, and handing it to callers
-- would let any account read everyone's preflight volume off two consecutive
-- ids; GET /decisions leaves its own BIGSERIAL out of the payload for the same
-- reason. public_id is random and says nothing about anyone else.
--
-- Nullable, no backfill. The default fills every row inserted from now on,
-- including rows the OLD code inserts, so this is safe to apply while the
-- previous version is serving. A row from before this migration has no handle
-- and is settled the old way; none of them outlives the reservation TTL.
-- ADD COLUMN without a default and SET DEFAULT afterwards is two catalog
-- changes and no table rewrite (a volatile default in ADD COLUMN would rewrite).
--
-- Apply BEFORE deploying the code that returns reservation_id: that code
-- reads public_id in the INSERT ... RETURNING on every approved preflight.

ALTER TABLE reservations ADD COLUMN IF NOT EXISTS public_id UUID;
ALTER TABLE reservations ALTER COLUMN public_id SET DEFAULT gen_random_uuid();

-- The settle path's only lookup. Partial, so the pre-migration NULLs cost nothing.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reservations_public_id
  ON reservations (public_id)
  WHERE public_id IS NOT NULL;
