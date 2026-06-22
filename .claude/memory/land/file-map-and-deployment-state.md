---
name: file-map-and-deployment-state
description: "Every land file + what's live on prod vs staging vs the dirty feat/poker-mtt-tournament working tree (which LACKS the land routes/render — read deployed truth from origin/master or origin/staging)."
category: deployment
confidence: 0.9
date: 2026-06-22
---

# Land file map + deployment state

**⚠ The main working tree (`C:/Users/newma/Documents/Crypto/ClawVille`) is usually on
`feat/poker-mtt-tournament`, which LACKS `routes/land.ts`, the land render, the seed, the
modal, and the store** — it only carries the shared constants. Do NOT conclude "land isn't
built" from the working tree. Read the deployed truth from `origin/master` (prod) /
`origin/staging`, or a worktree checked out at one of them. (`cv-cash-poker` sat at
`origin/staging` tip on 2026-06-22 and had all land files.)

## Deployment state (as of 2026-06-22)
- **Phase 0** (schema + 576-tile world re-grow + frozen constants + CI migration gate): LIVE on
  prod + staging. DBs ISOLATED — staging `mtpixvtclsjqjguouxes`, prod `wheuidgiyyccqyoppxoa`.
- **Phase 1 + early Phase 2**: BUILT + on `origin/master` (== `origin/staging` for land files),
  8 commits `4261ca96`→`7fb9c421`: Slice A (seed + read routes + free starter claim + for-sale
  render) → square block-frame layout → founder 8 → priced parcel buy + tier-gated
  buildings/shops place+upgrade (`fc86b15f`) → Codex money-path fixes (`dc8d4716`) → FOR-RENT
  showroom (`284e1371`) → 2-ring big-plot + 3-category for-sale signs + premium showcase.
  The land memory file `project_land_economy_plan.md` that said "all of Phase 1 is missing" is
  STALE — it was true 5 days before this shipped.
- **Phase 3** (agent ACTION surface — buy/place/upgrade via tools.json + `[ACTION:]` whitelist
  + `PROTOCOL_VERSION` bump): NOT done. The HTTP routes ALREADY settle to an agent's own avatar
  via `requireAuthOrAgentSession` (E5), so Phase 3 is discovery-surface only — and it's the
  protected Hatcher surface (Codex pass).

## File map
**Backend** (`origin/master`):
- `apps/api/src/routes/land.ts` — 1501 lines, mounted at `/api/land` in `apps/api/src/index.ts`.
  9 routes: `GET /parcels?tier=&status=` (public, 60s cache, 60/min), `GET /owned/:avatarId`
  (public render seam → `{parcels,structures}`), `GET /me` (auth, uncached), `POST /claim-starter`
  (free, idempotent), `GET /parcels/:id/structure`, `GET /catalog?tier=`, `POST /parcels/:id/buy`
  (priced, parity-bound), `POST /parcels/:id/structure` (free Lv1, tier-gated),
  `POST /structures/:id/upgrade` (priced, idempotency-key REQUIRED). Also a spawn-preference
  body schema (home/town respawn target).
- `apps/api/scripts/seed-land-parcels.ts` — DATA seed (see [[seed-is-manual-data]]).
- `packages/database/src/schema/land.ts` — 8 tables (`land_parcels`, `land_structures`,
  `land_upgrades`, `land_transactions`, …). Migration `packages/database/migrations/0001_land_economy.sql`.

**Shared constants** (`@clawville/shared`, present even on the working tree):
- `land-parcels.ts` → `LAND_PARCELS` (180 parcels, deterministic GEOMETRY: id===parcelCode,
  world `(cx,cz)`, footprint, ring radius; pure/no RNG = multiplayer-safe).
- `land-tiers.ts` → `LandTier` enum (`starter|c|b|a|founder` lowercase), `LAND_TIERS`,
  `PARCEL_TIER_COUNTS`, `parcelCode()`/`parseParcelCode()`, `TOTAL_PARCEL_SUPPLY`.
- `land-economy.ts` → `LAND_TIER_LADDER` (price bands), `CT_BUYABLE_TIERS`, `STRUCTURE_CATALOG`,
  `STRUCTURE_UPGRADE_COSTS`, `MAX_STRUCTURE_LEVEL`, `MAX_PARCELS_PER_AVATAR=5`, `LAND_EVENT_TYPES`,
  tier-structure-rule helpers (`getCatalogEntry`, `getTierStructureRules`, `getTierMaxLevel`,
  `isSkuAllowedForTier`), `REST_BONUS_DAILY_CAP_CT=null` (Phase 2, founder-gated — leave off).

**Web**:
- `apps/web/src/components/game/land/land-office-modal.tsx` — the menu economy (DB-backed).
- `apps/web/src/components/game/sidebar-menu.tsx` — "Land Office" row → `openLandOffice`.
- `apps/web/src/stores/game.ts` — `openLandOffice` / land-office-open flag.
- `apps/web/src/stores/land.ts` — ownership/structure store (see the parity gap — under-used).
- `apps/web/src/lib/three/land-parcels.tsx` — in-world parcels + signs (STATIC, the gap).
- `apps/web/src/lib/three/land-structures.tsx` — owned-build render (self-hydrates current
  player via `getMyLand`).
- `apps/web/src/lib/three/land-showroom.tsx` — FOR-RENT model homes on outer lots.
- All three render groups mounted in `apps/web/src/components/three/World3DCanvas.tsx`
  (`perf:land-parcels` / `perf:land-structures` / `perf:land-showroom`).
- `apps/web/src/lib/api.ts` — `getLandParcels`, `getOwnedLand`, `getMyLand`, `claimStarterPlot`,
  `buyParcel`, `getLandCatalog`, `getParcelStructure`, `placeStructure`, `upgradeStructure`.

**Plans** (git-UNTRACKED, read by absolute path): `.claude/plans/land-economy/` —
`DESIGN.md`, `ROADMAP.md`, `backend-schema.md`, `world-3d.md`, `payments-services.md`,
`gameplay-ux.md`, `PHASE1-KICKOFF.md`, `CONTINUATION.md`, `RECONCILIATION.md`.

Related: [[world-economy-parity-gap]] · [[land-money-contract]] · [[seed-is-manual-data]].
