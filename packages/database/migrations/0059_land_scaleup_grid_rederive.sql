-- 0059_land_scaleup_grid_rederive.sql
-- ============================================================================
-- Land scale-up (2026-08-10): re-derive land_parcels.grid_x / grid_y for the
-- 56 render-backed parcels after the geometry change in
-- packages/shared/src/constants/land-parcels.ts (founder/starter footprints
-- 38 -> 52 t; rings moved to half-sides 192 / 257 / 322 t; corner-inset
-- per-side distribution replaced the even arc-length walk).
--
-- WHY A MIGRATION: apps/api/scripts/seed-land-parcels.ts stamps grid_x/grid_y
-- once with `ON CONFLICT (parcel_code) DO NOTHING`, so existing rows NEVER
-- pick up moved centers. Every parcel center moved in this change, so any DB
-- that already ran the seed carries stale tile coords (consumed by the spawn
-- path, the world-map modal markers, and every /api/land parcel payload).
--
-- DERIVATION (byte-identical to the seed script):
--   grid_x = floor((slot.cx + 11264) / 32)
--   grid_y = floor((slot.cz + 11264) / 32)
-- with slot.cx/cz from the NEW LAND_PARCELS generator. The VALUES list below
-- was generated programmatically from that generator — 56 rows, all cells
-- unique, all within [0, 704).
--
-- SCOPE GUARD: this touches ONLY land_parcels.grid_x/grid_y (world tile
-- coords). land_structure_pieces.grid_x/grid_y is the 0-15 PARCEL-RELATIVE
-- kit grid and is deliberately untouched — kit placements slide with their
-- parcel by construction.
--
-- TWO-PHASE UPDATE, AND WHY: land_parcels_grid_unique is a non-deferrable
-- UNIQUE index on (grid_x, grid_y). A single multi-row UPDATE checks the
-- index per row, so if any parcel's NEW cell equals another parcel's CURRENT
-- (old-layout) cell, the statement can fail transiently depending on row
-- order — and deployed DBs may hold coords from ANY historical layout, so
-- disjointness cannot be assumed. Phase A parks every out-of-date row at the
-- NEGATIVE of its target (+1), a namespace real tiles never occupy (real
-- cells are >= 0) and which is internally unique because the targets are.
-- Phase B lands the parked rows on their targets. Both phases skip rows
-- already at target, so a re-run is a clean no-op (idempotent), and a partial
-- failure self-heals on the next run. The whole file executes as one implicit
-- transaction under scripts/migrate-ci.ts regardless.
--
-- Rows not present (unseeded DBs) are simply skipped; a later seed run stamps
-- the new coords directly from the constants.
-- ============================================================================

SELECT pg_advisory_xact_lock(510020260810);

CREATE TEMP TABLE land_scaleup_grid_targets (
  parcel_code text PRIMARY KEY,
  new_grid_x  integer NOT NULL,
  new_grid_y  integer NOT NULL
) ON COMMIT DROP;

INSERT INTO land_scaleup_grid_targets (parcel_code, new_grid_x, new_grid_y) VALUES
  ('parcel-founder-00', 224, 160),
  ('parcel-founder-01', 352, 160),
  ('parcel-founder-02', 480, 160),
  ('parcel-founder-03', 544, 224),
  ('parcel-founder-04', 544, 352),
  ('parcel-founder-05', 544, 480),
  ('parcel-founder-06', 480, 544),
  ('parcel-founder-07', 224, 544),
  ('parcel-founder-08', 160, 480),
  ('parcel-founder-09', 160, 224),
  ('parcel-c-00', 94, 30),
  ('parcel-c-01', 223, 30),
  ('parcel-c-02', 352, 30),
  ('parcel-c-03', 481, 30),
  ('parcel-c-04', 610, 30),
  ('parcel-c-05', 674, 94),
  ('parcel-c-06', 674, 223),
  ('parcel-c-07', 674, 352),
  ('parcel-c-08', 674, 481),
  ('parcel-c-09', 674, 610),
  ('parcel-c-10', 610, 674),
  ('parcel-c-11', 481, 674),
  ('parcel-c-12', 352, 674),
  ('parcel-c-13', 223, 674),
  ('parcel-c-14', 94, 674),
  ('parcel-c-15', 30, 610),
  ('parcel-c-16', 30, 481),
  ('parcel-c-17', 30, 352),
  ('parcel-c-18', 30, 223),
  ('parcel-c-19', 30, 94),
  ('parcel-starter-00', 159, 95),
  ('parcel-starter-01', 223, 95),
  ('parcel-starter-02', 287, 95),
  ('parcel-starter-03', 352, 95),
  ('parcel-starter-04', 416, 95),
  ('parcel-starter-05', 480, 95),
  ('parcel-starter-06', 545, 95),
  ('parcel-starter-07', 609, 159),
  ('parcel-starter-08', 609, 223),
  ('parcel-starter-09', 609, 287),
  ('parcel-starter-10', 609, 352),
  ('parcel-starter-11', 609, 416),
  ('parcel-starter-12', 609, 480),
  ('parcel-starter-13', 609, 545),
  ('parcel-starter-14', 545, 609),
  ('parcel-starter-15', 467, 609),
  ('parcel-starter-16', 390, 609),
  ('parcel-starter-17', 313, 609),
  ('parcel-starter-18', 236, 609),
  ('parcel-starter-19', 159, 609),
  ('parcel-starter-20', 95, 545),
  ('parcel-starter-21', 95, 467),
  ('parcel-starter-22', 95, 390),
  ('parcel-starter-23', 95, 313),
  ('parcel-starter-24', 95, 236),
  ('parcel-starter-25', 95, 159);

-- Phase A: park every out-of-date row in the negative namespace. Parking
-- values are -(target + 1): unique (targets are unique), never a real cell
-- (real cells are >= 0), and stable across re-runs (a re-run of a partially
-- parked state re-parks to the identical value, which is a no-op write).
UPDATE land_parcels AS lp
SET grid_x = -(t.new_grid_x + 1),
    grid_y = -(t.new_grid_y + 1),
    updated_at = now()
FROM land_scaleup_grid_targets AS t
WHERE lp.parcel_code = t.parcel_code
  AND (lp.grid_x, lp.grid_y) IS DISTINCT FROM (t.new_grid_x, t.new_grid_y);

-- Phase B: land parked rows on their targets. After Phase A every listed row
-- is either already at target (skipped here) or parked negative, so no row's
-- new cell can transiently collide with another row's current cell.
UPDATE land_parcels AS lp
SET grid_x = t.new_grid_x,
    grid_y = t.new_grid_y,
    updated_at = now()
FROM land_scaleup_grid_targets AS t
WHERE lp.parcel_code = t.parcel_code
  AND (lp.grid_x, lp.grid_y) IS DISTINCT FROM (t.new_grid_x, t.new_grid_y);
