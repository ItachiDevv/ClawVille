# ClawVille — World Content Manifest

> **Strict rule:** every code change that adds, removes, repositions, rescales,
> recolors, or otherwise changes a rendered thing in the open-world scene MUST
> update this doc in the same diff. Reverse holds: changes to this doc require
> the corresponding code change. Mismatch is a bug.
>
> If you're an agent: the answer to "what's in the scene?" lives HERE, not in
> grep results. Update this when you touch any file listed in the "Source"
> column. Update the affected file when you change a row here.

**Last edit:** 2026-05-13 — decoration scatter retune (user-reported invisible decos): TARGET 30→60, DECO_INNER_EXCLUSION_R 2700→1500, MAX_VISIBLE_DIST 4500→3800, EXTENT 1.76→1.4. The old constants pushed every prop outside the then-R=2176 building ring (~800wu tall) where the ring occluded them and fog hid the rest. New constants land all 60 props in the 1500–3800wu visible annulus. Same diff: sand bumpFreq 0.15→1.5 + bumpAmp 0.04→0.08 (visible grain at gameplay distance); seaweed sparse-band acceptance 0.25→0.5; removed dead atmosphere/light-rays imports + duplicate TownDirectorySign mount + orphan trail-renderer.tsx. Building ring expanded 2176 → 2304wu (68 → 72 tiles) on follow-up for inner-band breathing room.

---

## 1. Top-level scene tree

Composes the entire R3F scene. Mounted by `SceneContents` in `apps/web/src/components/three/World3DCanvas.tsx`.

| Group | Component | What renders | Source |
|---|---|---|---|
| **Lighting** | inline JSX | 1 hemisphere + 2 directional + fog (1200→6400wu) | `World3DCanvas.tsx` ~778 |
| **Terrain** | `<ArenaTerrain>` | sand floor + decorations + (disabled landmarks) | `lib/three/arena-terrain.tsx` |
| **Buildings** | `<ArenaBuildings>` | 10 themed building GLBs on a ring | `lib/three/arena-buildings.tsx` |
| **Wandering NPCs** | `<ArenaNpcs>` | 18 NPCs (5 VRM + 13 GLB), SSE-driven positions | `lib/three/arena-npcs.tsx` |
| **Building residents** | `<ArenaLocationNpcs>` | 10 character NPCs, one per building | `lib/three/arena-location-npcs.tsx` |
| **Ground cover** | `<MergedSeaweed>` | TSL-animated seaweed, single merged mesh | `lib/three/merged-seaweed.tsx` |
| **Town center props** | 5 components | quest NPC, town guide, bazaar, marketplace, auction, directory sign | listed in §6 |
| **NPC overlays** | 3 components | speech bubbles, activity indicators, floating texts | listed in §7 |
| **Player avatar** | `<PlayerAvatar>` | conditional — player / autonomous mode only | `lib/three/player-avatar.tsx` |
| **Camera + input** | OrbitControls + 3 controllers | OrbitControls, WASD, FPS-follow, arrow-key rotation | `World3DCanvas.tsx` |
| **Invisible mounts** | 7 components | pipeline pre-compile, texture upload, KTX2/meshopt setup, jump ticker, label overlay mount, minimap tracker | `World3DCanvas.tsx` |

---

## 2. Buildings (10)

Loaded by `<ArenaBuildings>`. Each is a single GLB clone placed on a ring at radius 2304wu (= 72 tiles × 32) around (0,0,0). Config table is `BUILDING_MODELS` in `lib/three/arena-buildings.tsx`. Ring expanded 2176 → 2304 on 2026-05-13.

| Zone id | GLB | Renders | Notes |
|---|---|---|---|
| `visual-creation` | `pineapple-house.glb` | SpongeBob's pineapple house |  |
| `memory-rag` | `squidward-house.glb` | Easter-Island moai head (Squidward's house) |  |
| `api-integrations` | `salty-spitoon.glb` | Bar |  |
| `cron-automation` | `patty-building.glb` | Pearl's downtown |  |
| `app-publishing` | `boating-school.glb` | Mrs. Puff's classroom |  |
| `deployment-ops` | `building-lighthouse.glb` | Lighthouse |  |
| `mcp-tool-use` | `krusty-krab-v2.glb` | Ship-restaurant | 2026-05-12 swap from re-compressed glb |
| `code-development` | `chum-bucket-v2.glb` | Bucket | 2026-05-12 swap |
| `messaging-channels` | `sandy-treedome-v3.glb` | Tree platform + glass dome | 2026-05-12 swap to `sandy_tree_final.glb` |
| `agent-security` | `patricks-rock-v2.glb` | Patrick's rock | 2026-05-12 swap |

**Strip rules** (run on every cloned building scene, `stripDecorativeMeshes` in `arena-buildings.tsx`):
- Prefix match `Skybox_` → strip (kills the blue hemisphere baked into Yanez assets)
- `BACKDROP_KILL_NAMES` set — currently empty
- `BACKDROP_KILL_MATERIALS` set — currently empty
- `DECORATIVE_PARENT_NAMES` parent match — `Flowers`, `Path`, `Skybox`, `Road`, `Sand`
- `stripGroundPlanes()` — geometric "flat at bottom 5%" check

---

## 3. NPC roster

### 3a. Wandering NPCs — 18 total

5 Milady VRMs + 13 GLB sea creatures. Server-driven positions via SSE; client smooths them. Code: `lib/three/arena-npcs.tsx`. Definitions: `packages/shared/src/constants/npc-definitions.ts` (or the demo NPCs in `stores/npc.ts` when SSE is disconnected).

| Species | Count | Asset |
|---|---|---|
| Milady VRM | 5 | `milady-official-{2,3,4,7,8}.vrm` (one per NPC, must be distinct paths — shared paths cause T-pose collisions) |
| Lobster GLB | 8 | `models/lobster.glb` |
| Sweet crab | 1 | `models/sweet_crab.glb` |
| Hermit crab | 1 | `models/hermitcrab.glb` |
| Crayfish | 3 | scattered (Marlin/Driftwood/Riptide use `lobster` species, not crayfish prop) |

> **Hermes VRM scaffold (Mira/Tekk) is wired but unused.** `MODEL_REGISTRY` carries `hermes_female` + `hermes_male`, `arena-npcs.tsx` preloads both VRMs and routes `characterId` through `VRMCharacterAnimator`, but the wanderer roster reverted from Mira/Tekk to Maple/Ash on 2026-05-12 because shared `VRM_NPC_SCALE=112` blows the Hermes meshes up massively. Add a per-species scale override in `arena-npcs.tsx` before reinstating them.

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
