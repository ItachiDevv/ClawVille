# ClawVille — World Content Manifest

> **Strict rule:** every code change that adds, removes, repositions, rescales,
> recolors, or otherwise changes a rendered thing in the open-world scene MUST
> update this doc in the same diff. Reverse holds: changes to this doc require
> the corresponding code change. Mismatch is a bug.
>
> If you're an agent: the answer to "what's in the scene?" lives HERE, not in
> grep results. Update this when you touch any file listed in the "Source"
> column. Update the affected file when you change a row here.

**Last edit:** 2026-05-18 — Concern 6.1 regression fix: MAX_FOOTPRINT 1000→1500, per-building targetHeights updated (slots 2/3/4/5/6/11 raised), pivotZBias on memory-rag, fog near/far updated. §2 building table updated. Prior 2026-05-18: Casino interior scene at `/casino`. Prior 2026-05-18: Phase 6.1 grid+ring expand, pedestal discs.

---

## 1. Top-level scene tree

Composes the entire R3F scene. Mounted by `SceneContents` in `apps/web/src/components/three/World3DCanvas.tsx`.

| Group | Component | What renders | Source |
|---|---|---|---|
| **Lighting** | inline JSX | 1 hemisphere + 2 directional + fog (2500→6800wu) | `World3DCanvas.tsx` ~778 |
| **Terrain** | `<ArenaTerrain>` | sand floor + decorations + (disabled landmarks) | `lib/three/arena-terrain.tsx` |
| **Buildings** | `<ArenaBuildings>` | 12 themed building GLBs on a circular ring (R=100 tiles, 30° spacing; Phase 6.1 2026-05-18) | `lib/three/arena-buildings.tsx` |
| **Wandering NPCs** | `<ArenaNpcs>` | 18 NPCs (5 VRM + 13 GLB), SSE-driven positions | `lib/three/arena-npcs.tsx` |
| **Building residents** | `<ArenaLocationNpcs>` | 10 character NPCs, one per building | `lib/three/arena-location-npcs.tsx` |
| **Ground cover** | `<MergedSeaweed>` | TSL-animated seaweed, single merged mesh | `lib/three/merged-seaweed.tsx` |
| **Town center props** | 5 components | quest NPC, town guide, bazaar, marketplace, auction, directory sign | listed in §6 |
| **NPC overlays** | 3 components | speech bubbles, activity indicators, floating texts | listed in §7 |
| **Player avatar** | `<PlayerAvatar>` | conditional — player / autonomous mode only | `lib/three/player-avatar.tsx` |
| **Camera + input** | OrbitControls + 3 controllers | OrbitControls, WASD, FPS-follow, arrow-key rotation | `World3DCanvas.tsx` |
| **Invisible mounts** | 7 components | pipeline pre-compile, texture upload, KTX2/meshopt setup, jump ticker, label overlay mount, minimap tracker | `World3DCanvas.tsx` |

---

## 2. Buildings (12)

Loaded by `<ArenaBuildings>`. Each is a single GLB clone placed on a **true circular ring** — 12 buildings at 30° angular spacing, radius 100 tiles (3200 wu) from center (0,0,0). Config: `BUILDING_MODELS` in `lib/three/arena-buildings.tsx`. Authoritative positions: `buildingZones[]` in `tilemap-data.ts`. Ring history: 56→68 tiles (2026-04-16) → 68→72 tiles (2026-05-13) → briefly square (2026-05-17 Phase 6.0.1) → true circle revert R=72 (2026-05-17) → Phase 6.1 R=100 on 240×240 grid (2026-05-18).

Each building has a flat **stone pedestal disc** (radius=560wu, 15wu thick, color `0x8b7d6b`) rendered at y=−2 by `BuildingPedestal` in `arena-buildings.tsx`.

| Slot | Angle | Zone id | GLB path | Renders | targetHeight | Notes |
|---|---|---|---|---|---|---|
| 0 | N | `visual-creation` | `pineapple-house.glb` | SpongeBob's pineapple house | 1100 | |
| 1 | NNE | `code-development` | `chum-bucket-v2.glb` | Bucket | 900 | 2026-05-12 swap |
| 2 | ENE | `mcp-tool-use` | `krusty-krab-v2.glb` | Ship-restaurant | 1200 | raised from 1000 (footprint-cap fix 2026-05-18); 2026-05-12 swap |
| 3 | E | `messaging-channels` | `sandy-treedome-v3.glb` | Tree platform + glass dome | 1300 | raised from 1000; 2026-05-12 swap; rotYOffset +π |
| 4 | ESE | `api-integrations` | `salty-spitoon.glb` | Bar | 1200 | raised from 1000; rotYOffset -π/2 |
| 5 | SSE | `app-publishing` | `boating-school.glb` | Mrs. Puff's classroom | 1100 | raised from 950; rotYOffset +π/2 |
| 6 | S | `cron-automation` | `patty-building.glb` | Pearl's downtown | 1400 | raised from 1200 |
| 7 | SSW | `deployment-ops` | `building-lighthouse.glb` | Lighthouse | 1500 | tallest landmark |
| 8 | WSW | `agent-security` | `patricks-rock-v2.glb` | Patrick's rock | 900 | 2026-05-12 swap |
| 9 | W | `casino` | `casino/casino-exterior.glb` | Predictive Gaming Cove — Mayan step-pyramid | 1040 | Entertainment district. box3Recenter=true. Interior: **6.0.2 SHIPPED** — `/casino` route, `casino-interior.glb` (Draco 4.2MB) + fallback (58KB). onClick → `window.location.href = '/casino'`. |
| 10 | WNW | `claw-arcade` | `arcade/claw-arcade-exterior.glb` | Arcade City — domed building | 900 | Entertainment district (slot 9+10 adjacent). Interior / crane game: Phase 6.3. |
| 11 | NNW | `memory-rag` | `squidward-house.glb` | Easter-Island moai head | 1300 | raised from 1100; pivotZBias=+180wu (step offset compensation) |

**Strip rules** (run on every cloned building scene, `stripDecorativeMeshes` in `arena-buildings.tsx`):
- Prefix match `Skybox_` → strip (kills the blue hemisphere baked into Yanez assets)
- `BACKDROP_KILL_NAMES` set — currently empty
- `BACKDROP_KILL_MATERIALS` set — currently empty
- `DECORATIVE_PARENT_NAMES` parent match — `Flowers`, `Path`, `Skybox`, `Road`, `Sand`
- `stripGroundPlanes()` — geometric "flat at bottom 5%" check

---

## 3. NPC roster

### 3a. Wandering NPCs — 9 total

3 Milady VRMs + 3 Hermes/Tekk VRMs + 3 GLB sea creatures. Server-driven positions via SSE; client smooths them. Code: `lib/three/arena-npcs.tsx`. Definitions: `packages/shared/src/constants/npc-definitions.ts` (or the demo NPCs in `stores/npc.ts` when SSE is disconnected). All VRM sizing is handled by `computeVRMAvatarFit()` from `lib/three/vrm-avatar-sizing.ts` — every humanoid renders at `VRM_AVATAR_TARGET_HEIGHT_WU = 179.2` regardless of native bbox unit convention.

| Species | Count | Asset |
|---|---|---|
| Milady VRM | 3 | `milady-official-{2,7,8}.vrm` (Vivi / Miu / Kyoko — distinct paths required, shared paths cause T-pose collisions) |
| Hermes VRM | 2 | `hermes-female.vrm` (Mira), `hermes-male.vrm` (Cyrus) |
| Tekk VRM | 1 | `tekk.vrm` — uses `SPECIES_TARGET_HEIGHT_WU.tekk = 230` so wings can overshoot the body silhouette |
| Lobster GLB | 1 | `models/lobster.glb` (Driftwood) — homeX 2232, homeY 3408, W inner near entertainment district (casino+arcade) |
| Sweet crab | 1 | `models/sweet_crab.glb` (Marlin) — homeX 5100, homeY 4200, E inner near messaging-channels+api-integrations |
| Hermit crab | 1 | `models/hermitcrab.glb` (Riptide) — homeX 2850, homeY 4800, SW inner near deployment-ops+agent-security |

### 3b. Building residents — 10 total

One per building, named after the SpongeBob cast. Code: `lib/three/arena-location-npcs.tsx`. Models live under `apps/web/public/models/characters/`.

`spongebob, squidward, sandy, mr-krabs, plankton, patrick, larry, mrs-puff, pearl, flying-dutchman`

### 3c. Player avatar
Renders only in `controlMode === 'player' | 'autonomous'`. Single VRM/GLB driven by your account's selected model. Code: `lib/three/player-avatar.tsx`.

---

## 4. Terrain

Code: `lib/three/arena-terrain.tsx`.

| Item | Config | Code |
|---|---|---|
| Sand floor | `MAP_WIDTH × 3` × `MAP_HEIGHT × 3` = 15360² wu plane, 120×120 segs, TSL height-blend shader | `SandFloor` |
| Sand color ramp | 5-stop: ridge / high / mid / valley / deep | constants ~31 |
| Dune field | summed sin/cos waves + per-vertex noise | `createSandGeometry` |

---

## 5. Ground decorations (procedural scatter)

**Current state (2026-05-13 retune):**
- `TARGET_COUNT = 60` (was 30; doubled to fill the wider visible band created by the closer exclusion radius)
- `EXTENT_X = MAP_WIDTH * 1.4 = 7168wu` half-range (was 1.76 = 9000; further narrowed so cluster centres land inside the visible annulus)
- `MAX_VISIBLE_DIST = 3800` — hard distance gate (was 4500)
- `DECO_INNER_EXCLUSION_R = 1500wu` — was 2700 which pushed every prop outside the ring buildings (then R=2176, ~800wu tall) where they were occluded; 1500 places decos between town plaza and the ring (ring now R=2304 since 2026-05-13)
- 24 cluster centres, 280wu triangular-distribution radius per cluster
- Stable seed (`12345`) — positions don't change between reloads
- Audit: `node scripts/audit-decorations.mjs` confirms 60/60 props land in 1500–3800wu band

Code: `MergedDecorationsInner` + `generateDecorations` in `arena-terrain.tsx`.

**Asset list** (`DECO_TYPES`, weighted random):
| Model | Weight | Scale range |
|---|---|---|
| coral-reef1.glb | 3 | 4–15 |
| coral-reef2.glb | 3 | 3–13 |
| coral-reef3.glb | 3 | 3–12 |
| kelp.glb | 3 | 6–15 |
| building-shell.glb | 5 | 2–12 |
| building-seashell.glb | 5 | 2–12 |
| building-anchor.glb | 4 | 3–14 |
| building-barrel.glb | 4 | 3–10 |
| building-chest.glb | 4 | 3–12 |
| building-lantern.glb | 3 | 4–12 |
| crayfish.glb | 3 | 3–10 |
| building-tower2.glb | 2 | 4–14 |

**Render strategy:** all entries → bucketed by `(3×3 grid cell, material UUID)` → `mergeGeometries` per bucket → one Mesh per bucket. Static, `matrixAutoUpdate=false`, default frustum-cull (tight per-bucket AABB).

---

## 6. Town center props (fixed at world origin)

| Component | What it renders | Source |
|---|---|---|
| `<QuestNpc>` | Quest-giver NPC standee | `lib/three/quest-npc.tsx` |
| `<TownGuide>` | Nori the town-guide NPC | `lib/three/town-guide.tsx` |
| `<BazaarStall>` | `models/bazaar-fish-stall.glb` | `lib/three/bazaar-stall.tsx` |
| `<MarketplaceStall>` | `models/marketplace-stall.glb` | `lib/three/marketplace-stall.tsx` |
| `<AuctionPodium>` | `models/auction-dome.glb` (the glass dome at 0, 200, -500) + floating `jellyfish.glb` | `lib/three/auction-podium.tsx` |
| `<TownDirectorySign>` | Wooden signboard — currently rendered TWICE in `World3DCanvas.tsx` (lines 773 and 832); the L773 instance is a diagnostic that should be removed. | `lib/three/town-directory-sign.tsx` |
| `<BountyBoardObject>` | Bounty board (imported but only mounted by some flows) | `lib/three/bounty-board-object.tsx` |

---

## 7. NPC overlays (DOM, screen-projected)

| Component | What it renders | Source |
|---|---|---|
| `<NpcSpeechBubbles>` | Chat bubble divs above NPCs from SSE event stream | `lib/three/npc-speech-bubbles.tsx` |
| `<ActivityIndicators>` | Pulsing spheres above NPCs in combat/conversation/dead | `lib/three/activity-indicators.tsx` |
| `<FloatingTexts3D>` | Token-earn float-ups | `lib/three/floating-text-3d.tsx` |
| `<WorldLabelsOverlayMount>` | The single-root projection useFrame that drives every label div above any anchor | `lib/three/world-labels-overlay.tsx` |

---

## 8. Disabled features (kept in the bundle, currently off)

These mount points exist but render nothing because of `{false && <X />}` gates.

| Component | Why disabled | Code |
|---|---|---|
| `<UnderwaterAtmosphere>` | Overdraw caustic plane — 8–15ms/frame on integrated GPUs even when occluded by other geometry. | `lib/three/underwater-atmosphere.tsx` |
| `<UnderwaterLightRays>` | 7 cone-shaft additive meshes — same overdraw issue. | `lib/three/underwater-light-rays.tsx` |
| `<UnderwaterDecorationsGlb>` | Authored for the old 2560² map; in the 5120² world it appears as a massive floating silhouette. | `arena-terrain.tsx` |
| `<FixedLandmarks>` | Submarine + shipwreck — same issue as UnderwaterDecorationsGlb. | `arena-terrain.tsx` |

To re-enable, flip the `{false && ...}` gates in `World3DCanvas.tsx` / `arena-terrain.tsx`. Each gated thing has a reason — read the comment before re-enabling.

---

## 9. Outstanding cleanups

Tracked here so they don't get lost across sessions:

- [ ] **Duplicate `<TownDirectorySign>` render** — `World3DCanvas.tsx` L773 was added as a diagnostic and should be removed. Net cost: 1 extra mesh tree.
- [ ] **`<BountyBoardObject>` import path** — verify it's actually mounted by any production flow; if not, drop the import.
- [x] **Decoration density per zone** — 2026-05-13: TARGET_COUNT 30→60, annulus 1500–3800wu. Audit script (`scripts/audit-decorations.mjs`) verifies placement.

---

## 10. Recent material changes

Compact log. Single line per change.

- 2026-05-18 — Concern 6.0.2: Casino interior scene shipped. No new open-world objects. Casino building onClick in `arena-buildings.tsx` now navigates to `/casino`. §2 casino row updated (interior status SHIPPED).
- 2026-05-18 — Phase 6.1: ring expanded R=72→100 tiles on 240×240 grid. BuildingPedestal stone disc added under each building. All 12 building cx/cy updated in slot table. NPC home coords scaled ×1.5.
- 2026-05-17 — Circle revert + Phase 6.0.1 casino+claw-arcade additions. Ring R=72 on 160×160, then square ring attempted + reverted.
- 2026-05-13 — Ring 68→72 tiles. Decoration retune: TARGET_COUNT 30→60, DECO_INNER_EXCLUSION_R 2700→1500.
- 2026-05-12 — Sandy's Treedome swapped to `sandy_tree_final.glb`. Krusty Krab + Chum Bucket restored from original GLBs (renamed -v2 to bust cache).
- 2026-05-12 — `WorldContent.md` created as new canonical doc (split from 3dStructure.md).
