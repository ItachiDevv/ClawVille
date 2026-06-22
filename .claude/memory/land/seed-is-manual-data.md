---
name: seed-is-manual-data
description: "Parcel seed is a one-off DATA script (not the migrate-ci gate), run per-isolated-DB; empty land_parcels = a disconnect (modal empty, world shows 180 static lots); EXPLICIT-URL env hazard (Bun auto-loads .env.local → once wrote prod)."
category: deployment
confidence: 0.85
date: 2026-06-22
---

# The parcel seed is manual DATA — verify it ran per-DB

`apps/api/scripts/seed-land-parcels.ts` enumerates `LAND_PARCELS`, idempotent
`ON CONFLICT (parcel_code) DO NOTHING`, and STAMPS `price_ct` per row by interpolating
`LAND_TIER_LADDER` over the in-tier index (starter free / founder NULL). It is a one-off DATA
script — **NOT** part of the `migrate-ci.ts` DDL gate. So a deploy does NOT seed parcels; the
seed must be run **once per isolated DB** (staging `mtpixvtclsjqjguouxes`, prod
`wheuidgiyyccqyoppxoa`).

**Empty `land_parcels` is itself a disconnect:** the Land Office modal reads the DB
(`getLandParcels`) so it shows NOTHING for sale, while the in-world render draws 180 lots from
the static `LAND_PARCELS` constant regardless. So "world full of for-sale lots, menu says
nothing for sale" can mean the seed never ran on that DB — ALWAYS check seed/row state before
assuming a render or route bug. (Verify: count rows on the STAGING DB with an explicit URL.)

**ENV HAZARD (caused a real prod write 2026-06-16):** Bun auto-loads `<cwd>/.env.local`. A seed
that relies on the auto-loaded `DATABASE_URL` can silently hit PROD. The seed MUST take an
EXPLICIT URL env var (e.g. `SEED_DATABASE_URL`); keep every local `.env.local` staging-only.
See `feedback_no_prod_url_in_env_bun_autoload`. Run per-DB, deliberately, never both at once.

`land.ts` SCHEMA changes (new tables/columns) DO go through the gate: add
`packages/database/migrations/000N_*.sql` (idempotent, NAMED constraints — drizzle names all
constraints; unnamed inline ones drift forever) → it auto-applies to staging then prod via the
`migrate→deploy` job.

Related: [[file-map-and-deployment-state]] · [[world-economy-parity-gap]].
