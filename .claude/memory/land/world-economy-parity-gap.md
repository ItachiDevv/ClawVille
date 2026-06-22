---
name: world-economy-parity-gap
description: "Land Office modal is a full DB economy but the in-world 3D land is a static diorama that never reflects it — no ownership branch, no click-to-buy, no update-on-buy. The founding defect that created the land agent."
category: gotcha
confidence: 0.9
date: 2026-06-22
---

# World ↔ Economy parity gap (the founding land defect) — OPEN

**Symptom (founder, 2026-06-22):** "there is a disconnect with the land menu in sidebar
options and gameplay that should never happen."

**Diagnosis (verified by reading deployed code on `origin/staging` via the `cv-cash-poker`
worktree):**

The land economy is built in three places that DON'T agree:

1. **Land Office modal** `apps/web/src/components/game/land/land-office-modal.tsx` — a
   FULLY-WORKING DB economy. Calls `api.getLandParcels({status:'available'})` (browse),
   `claimStarterPlot`, `buyParcel`, `getLandCatalog`, `getParcelStructure`, `placeStructure`,
   `upgradeStructure`, `getOwnedLand`, `getMyLand`. Opened from the sidebar "Land Office" row
   (`sidebar-menu.tsx` → `openLandOffice` store action).

2. **In-world parcel render** `apps/web/src/lib/three/land-parcels.tsx` — a STATIC diorama.
   Draws all 180 parcels + for-sale signs purely from the frozen `LAND_PARCELS` shared
   constant. It does **NOT** import `useLandStore`, has **NO** ownership/status branch, and
   has **NO** click/pointer handler. Comment even says "only run once" (frozen). So it shows
   every lot as for-sale forever, regardless of DB ownership.

3. **The store** `apps/web/src/stores/land.ts` — `parcels: Map` of ownership state. Its own
   doc says "the gameplay turn (GET /api/land/owned) will hydrate this … the render reads this
   store." But: `setParcels` is called ONLY by the modal (`land-office-modal.tsx` ~L966), and
   **NOTHING in the 3D world reads `useLandStore.parcels`**. So the ownership map is
   effectively write-only — a dead path for the world. Only `land-structures.tsx` reflects DB
   state, and only the CURRENT player's OWN placed buildings (`api.getMyLand()` self-hydration);
   for-sale/owned status of lots and OTHER players' ownership are invisible in-world.

4. **No in-world → economy bridge** — zero hits for a parcel/sign click that opens the Land
   Office or buy flow (grep `openLandOffice|selectParcel|land-office` in `lib/three/` +
   `components/three/` = nothing). You can ONLY transact via the sidebar menu, never by
   interacting with the world.

**Net:** buy a parcel in the menu → its in-world sign still says "for sale"; you can't walk to
a lot and buy it; other players' ownership doesn't render. Menu (real economy) and gameplay
(static decoration) are two universes that don't talk.

**Fix shape (for the land agent's first job — full team + 3da):**
- `land-parcels.tsx` reads real status/ownership: hydrate `useLandStore.parcels` from
  `/api/land/parcels` (for-sale pool) + `/owned/:avatarId` (multiplayer ownership render
  seam), branch the per-parcel material/sign on `available` vs `owned` (foreign vs mine).
  Keep `LAND_PARCELS` as GEOMETRY only; layer STATE on top. Respect Iris-Xe budget (merged
  BufferGeometry, no InstancedMesh+ShaderMaterial, no drei `<Text>`).
- Add an in-world → economy bridge: walk-near / click a for-sale sign → opens the Land Office
  (or a parcel buy card). Mirror the cove walk-in/`E` pattern.
- Buy/claim/place/upgrade via the modal updates the world live (store hydration / cache bust);
  and the in-world action routes back through the SAME authed `/api/land/*` path (E5 parity).
- Verify in the browser (a bought parcel flips in-world) + FPS at full-ownership state on Iris Xe.

**ALSO verify first:** is `land_parcels` even seeded on the target DB? An empty table makes the
gap worse (modal empty, world full of static lots). See [[seed-is-manual-data]].

Related: [[file-map-and-deployment-state]] · [[land-money-contract]] · [[seed-is-manual-data]].
