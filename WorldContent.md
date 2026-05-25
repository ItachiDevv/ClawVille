# ClawVille — World Content Manifest

> **Strict rule:** every code change that adds, removes, repositions, rescales,
> recolors, or otherwise changes a rendered thing in the open-world scene MUST
> update this doc in the same diff. Reverse holds: changes to this doc require
> the corresponding code change. Mismatch is a bug.
>
> If you're an agent: the answer to "what's in the scene?" lives HERE, not in
> grep results. Update this when you touch any file listed in the "Source"
> column. Update the affected file when you change a row here.

**Last edit:** 2026-05-25 — §18a.f blackjack interactive-shell fix documented in GameFeatures.md. Prior: 2026-05-25 — Krusty Krab runtime GLTFLoader node key corrected to `The_Krusty_Krab` for both `childScaleOverrides` and `bodyAnchorChild`; the prior `"The Krusty Krab"` key was a no-op. Prior 2026-05-18 — Phase 6.2.2: MAX_FOOTPRINT 1800→2000wu. Node name bug fixed: `childScaleOverrides` + `bodyAnchorChild` keys for Squidward + Krusty Krab used underscore-sanitized names (silent no-ops — Three.js GLTFLoader does NOT sanitize); corrected to literal GLB names `"Squidward's House"` and `"The Krusty Krab"`. targetMaxDim bumps: messaging-channels 1000→2500 (Sandy dome ~820wu), api-integrations 1300→2500 (Salty Spitoon ~1209wu), cron-automation 1300→2200 (Patty Building ~1513wu), memory-rag 1400→1700 (childScale also 1.4→1.7). Sandy NPC T-pose fixed in `arena-location-npcs.tsx`. §2 slot table rows 2+3+4+6+11 updated. Prior 2026-05-18 — Body-anchor system: `bodyAnchorChild` field added; Squidward's House + Krusty Krab now anchor their building body's bbox center at the ring slot (fixes placement pushed-back bug from sign/pathway dominating full-GLB center). `pivotZBias: 180` removed from memory-rag (superseded by dynamic anchor). Size bumps: code-development 1000→1400, api-integrations 1000→1300, cron-automation 1000→1300. §2 slot table rows 1+2+4+6+11 updated. Prior 2026-05-18 — Differential child-scale: Squidward house body ×1.4, Krusty Krab restaurant ×1.5 vs stepping stones/sign. Both targetMaxDim 1000→1400. §2 slot table rows 2+11 updated. Prior 2026-05-18 — Phase 6.2.1: ring R=160→130 tiles (5120→4160wu — R=160 too spaced out). Arc spacing 2680→2178wu. All 12 building slot positions updated. §2 slot table updated. Prior 2026-05-18 — Phase 6.2: ring R=100→160 tiles (5120wu), grid 240→360 (11520wu). All 12 building slot positions updated. `targetMaxDim` normalization (max-dim) replaces `targetHeight` (Y-only) — uniform visual size across wide/squat and tall/narrow GLBs. NPC_INSET_WORLD 1000→1300wu (Patrick fix). Sandy Treedome DoubleSide transparent-mat fix. Town-center props spread to 800–1000wu ring: BazaarStall (-800,-2,300), MarketplaceStall (800,4,300), AuctionPodium (0,200,-1000). DECO_INNER_EXCLUSION_R 1500→800wu (scatter fills central plaza area). §2 slot table updated. Prior 2026-05-18 — Pass 3 fixes: MAX_FOOTPRINT 1500→1800; NPC_INSET_WORLD 600→1000; targetHeights bumped; Patrick's Rock ↔ Arcade City swap. Prior prior 2026-05-18: Phase 6.1 grid+ring expand, pedestal discs.

---

## 1. Top-level scene tree

Composes the entire R3F scene. Mounted by `SceneContents` in `apps/web/src/components/three/World3DCanvas.tsx`.

| Group | Component | What renders | Source |
|---|---|---|---|
| **Lighting** | inline JSX | 1 hemisphere + 2 directional + fog (4500→9000wu) | `World3DCanvas.tsx` ~778 |
| **Terrain** | `<ArenaTerrain>` | sand floor + decorations + (disabled landmarks) | `lib/three/arena-terrain.tsx` |
| **Buildings** | `<ArenaBuildings>` | 12 themed building GLBs on a circular ring (R=130 tiles = 4160wu, 30° spacing; Phase 6.2.1 2026-05-18) | `lib/three/arena-buildings.tsx` |
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

Loaded by `<ArenaBuildings>`. Each is a single GLB clone placed on a **true circular ring** — 12 buildings at 30° angular spacing, radius 130 tiles (4160wu) from center (0,0,0). Arc spacing ≈2178wu. Config: `BUILDING_MODELS` in `lib/three/arena-buildings.tsx`. Authoritative positions: `buildingZones[]` in `tilemap-data.ts`. Ring history: 56→68 tiles (2026-04-16) → 68→72 tiles (2026-05-13) → briefly square (2026-05-17 Phase 6.0.1) → true circle revert R=72 (2026-05-17) → Phase 6.1 R=100 on 240×240 grid (2026-05-18) → Phase 6.2 R=160 on 360×360 grid (2026-05-18) → Phase 6.2.1 R=130 on 360×360 grid (2026-05-18, R=160 too far from spawn).

Scale normalization: `computeBuildingScale` uses max(X,Y,Z) (`targetMaxDim`) — consistent visual cube size regardless of GLB aspect ratio. All buildings normalized to 1000–1400wu max-dim range.

Each building has a flat **stone pedestal disc** (radius=560wu, 15wu thick, color `0x8b7d6b`) rendered at y=−2 by `BuildingPedestal` in `arena-buildings.tsx`.

Phase 6.2.1 slot table (R=130 tiles, center tile (180,180)):
Slot geometry: cx=180+130×cos(θ), cy=180+130×sin(θ), θ=−π/2+slot×(π/6). Zone=(round(cx)−7, round(cy)−7), 14×14 tiles.

| Slot | Angle | cx,cy (tiles) | Zone id | GLB path | Renders | targetMaxDim | Notes |
|---|---|---|---|---|---|---|---|
| 0 | N | 180,50 | `visual-creation` | `pineapple-house.glb` | SpongeBob's pineapple house | 1100 | |
| 1 | NNE | 245,67 | `code-development` | `chum-bucket-v2.glb` | Bucket | 1400 | 1000→1400 (+40%); max-dim norm |
| 2 | ENE | 293,115 | `mcp-tool-use` | `krusty-krab-v2.glb` | Ship-restaurant | 1400 | childScaleOverrides: `The_Krusty_Krab` ×1.5 (runtime node name); bodyAnchorChild: `The_Krusty_Krab` (restaurant centers at slot, sign extends forward) |
| 3 | E | 310,180 | `messaging-channels` | `sandy-treedome-v3.glb` | Tree platform + glass dome | 2500 | 1000→2500; dome square XZ≈25.87, MAX_FOOTPRINT=2000 cap → ~820wu height; rotYOffset +π; DoubleSide transparent-mat fix |
| 4 | ESE | 293,245 | `api-integrations` | `salty-spitoon.glb` | Bar | 2500 | 1300→2500; km-scale GLB, after flat-base strip ~1209wu; rotYOffset -π/2 |
| 5 | SSE | 245,293 | `app-publishing` | `boating-school.glb` | Mrs. Puff's classroom | 1000 | rotYOffset +π/2 |
| 6 | S | 180,310 | `cron-automation` | `patty-building.glb` | Pearl's downtown | 2200 | 1300→2200; flat Object_N hierarchy, ~1513wu with MAX_FOOTPRINT=2000 cap |
| 7 | SSW | 115,293 | `deployment-ops` | `building-lighthouse.glb` | Lighthouse | 1400 | tallest landmark |
| 8 | WSW | 67,245 | `claw-arcade` | `arcade/claw-arcade-exterior.glb` | Arcade City — domed building | 1100 | 2 slots (60°) from casino — NOT adjacent. Interior / crane game: Phase 6.3. |
| 9 | W | 50,180 | `casino` | `casino/casino-exterior-cove.glb` | Predictive Gaming Cove — Mayan step-pyramid | 1300 | Entertainment district. box3Recenter=true. Interior: **6.0.2 SHIPPED** — `/casino` route. |
| 10 | WNW | 67,115 | `agent-security` | `patricks-rock-v2.glb` | Patrick's rock | 1100 | Adjacent to casino (slot 9). Max-dim prevents dome over-inflation. |
| 11 | NNW | 115,67 | `memory-rag` | `squidward-house.glb` | Easter-Island moai head | 1700 | 1400→1700; childScaleOverrides: "Squidward's House" ×1.7 (was ×1.4 with wrong underscore key — now literal name); bodyAnchorChild: "Squidward's House"; pivotZBias removed |

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
| Lobster GLB | 1 | `models/lobster.glb` (Driftwood) — homeX 3348, homeY 5112, W inner (Phase 6.2 scaled ×1.5 from Phase 6.1) |
| Sweet crab | 1 | `models/sweet_crab.glb` (Marlin) — homeX 7650, homeY 6300, E inner |
| Hermit crab | 1 | `models/hermitcrab.glb` (Riptide) — homeX 4275, homeY 7200, SW inner |

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

**Current state (Phase 6.2 2026-05-18):**
- `TARGET_COUNT = 60`
- `EXTENT_X = MAP_WIDTH * 1.4` half-range (scales with MAP_WIDTH; now 11520×1.4=16128wu half-range)
- `MAX_VISIBLE_DIST = 3800` — hard distance gate
- `DECO_INNER_EXCLUSION_R = 800wu` — reduced 1500→800 (Phase 6.2). The 1500wu clear area at center appeared as a "grey disc" of clean lighter sand. 800wu lets scatter fill the central plaza zone (town-center props are now at 800–1000wu radius so they coexist with decos). Ring buildings are at R=5120wu so decos at 800–3800wu band sit well inside the ring.
- 24 cluster centres, 280wu triangular-distribution radius per cluster
- Stable seed (`12345`) — positions don't change between reloads

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

Phase 6.2 positions (spread from original ≤600wu cluster to 800–1000wu ring):

| Component | What it renders | World position | Source |
|---|---|---|---|
| `<QuestNpc>` | Quest-giver NPC standee | (-110, -2, -60) — near center | `lib/three/quest-npc.tsx` |
| `<TownGuide>` | Nori the town-guide NPC | (0, -2, 240) — near center | `lib/three/town-guide.tsx` |
| `<TownDirectorySign>` | Wooden signboard | center (0, y, 0) — currently rendered TWICE in `World3DCanvas.tsx`; L773 diagnostic should be removed | `lib/three/town-directory-sign.tsx` |
| `<BazaarStall>` | `models/bazaar-fish-stall.glb` (400wu tall) | **(-800, -2, 300)** — west plaza ring | `lib/three/bazaar-stall.tsx` |
| `<MarketplaceStall>` | `models/marketplace-food-stall.glb` (450wu tall) | **(800, 4, 300)** — east plaza ring | `lib/three/marketplace-stall.tsx` |
| `<AuctionPodium>` | `models/auction-dome.glb` (380wu tall) + floating `jellyfish.glb` | **(0, 200, -1000)** — north plaza anchor | `lib/three/auction-podium.tsx` |
| `<BountyBoardObject>` | Bounty board (imported but only mounted by some flows) | varies | `lib/three/bounty-board-object.tsx` |

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

- 2026-05-25 — Phase 6.4.0 interactive-shell fix documented in `GameFeatures.md` §18a.f (no scene/manifest changes here — blackjack is cove-interior, not world ring).
- 2026-05-25 — Krusty Krab runtime node key corrected to `The_Krusty_Krab` for `childScaleOverrides` + `bodyAnchorChild`; prior `"The Krusty Krab"` key did not match the loaded GLB node.
- 2026-05-18 — Phase 6.2.2: MAX_FOOTPRINT 1800→2000wu; node name bug (`The_Krusty_Krab`/`Squidward_s_House` → literal `"The Krusty Krab"`/`"Squidward's House"`) corrected — Three.js GLTFLoader does NOT sanitize, prior keys were silent no-ops; targetMaxDim messaging-channels 1000→2500, api-integrations 1300→2500, cron-automation 1300→2200, memory-rag 1400→1700; memory-rag childScale 1.4→1.7. Sandy NPC T-pose fixed (meshopt loader + explicit clipAction optionalRoot). §2 rows 2+3+4+6+11 updated.
- 2026-05-18 — Differential child-scale pass for Squidward house (`Squidward_s_House` ×1.4) and Krusty Krab (`The_Krusty_Krab` ×1.5). Both targetMaxDim 1000→1400. Stepping stones and Krusty Krab sign/pole remain at base scale. §2 rows 2+11 updated.
- 2026-05-18 — Phase 6.2: ring R=100→160 (5120wu), grid 240→360 (11520wu). All 12 building positions recomputed. `targetMaxDim` replaces `targetHeight` (max-dim vs Y-only normalization). NPC_INSET_WORLD 1000→1300wu. Sandy DoubleSide fix. DECO_INNER_EXCLUSION_R 1500→800wu. Town-center props spread to 800–1000wu ring. NPC home coords rescaled to Phase 6.2 world.
- 2026-05-18 — Concern 6.0.2: Casino interior scene shipped. No new open-world objects. Casino building onClick in `arena-buildings.tsx` now navigates to `/casino`. §2 casino row updated (interior status SHIPPED).
- 2026-05-18 — Phase 6.1: ring expanded R=72→100 tiles on 240×240 grid. BuildingPedestal stone disc added under each building. All 12 building cx/cy updated in slot table. NPC home coords scaled ×1.5.
- 2026-05-17 — Circle revert + Phase 6.0.1 casino+claw-arcade additions. Ring R=72 on 160×160, then square ring attempted + reverted.
- 2026-05-13 — Ring 68→72 tiles. Decoration retune: TARGET_COUNT 30→60, DECO_INNER_EXCLUSION_R 2700→1500.
- 2026-05-12 — Sandy's Treedome swapped to `sandy_tree_final.glb`. Krusty Krab + Chum Bucket restored from original GLBs (renamed -v2 to bust cache).
- 2026-05-12 — `WorldContent.md` created as new canonical doc (split from 3dStructure.md).
