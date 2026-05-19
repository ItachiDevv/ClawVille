# ClawVille — 3D Structure

> **Strict rule:** every code change that touches world dimensions, camera,
> lighting, fog, GPU constraints, animation systems, terrain shaders,
> asset-load pipeline, or activity-room rendering MUST update this doc in the
> same diff. Reverse holds. Mismatch is a bug.
>
> Companions:
> - **`WorldContent.md`** — *what* is in the scene (buildings, NPCs, props). Use that doc when the question is "what renders here".
> - **`ARCHITECTURE.md`** — backend services, routes, schema. Activity sim services live there (§4).
> - **`GameFeatures.md`** — gameplay.
> - **This doc** — *how* the 3D scene is wired: coordinates, camera, lights, GPU budget, animation, asset pipeline.

**Last edit:** 2026-05-19 — Casino interior input+camera triple-fix: (1) Avatar yaw lerp rate 0.15→0.08 in both VRM+GLB branches — A/D press spreads 90° turn over ~35 frames (0.58s) instead of snapping in 3-4 frames. (2) Arrow keys decoupled from WASD movement; separate `_casinoArrowKeys` + `attachCasinoArrowListeners()` for camera perspective-orbit: Left/Right orbit yaw at 1.5 rad/s, Up/Down tilt camera height at 200wu/s, pitch clamped to [-100, +400] wu relative to CAM_ABOVE=190. Mirrors World3DCanvas `ArrowKeyRotationController` convention exactly. (3) Camera AABB clamp via new `room-camera.ts` `clampCameraToRoom()` — constrains desired pos to room halfX=383, Z=[-900,+900], Y=[30,600], margin=50wu before lerp; eliminates void-black viewport when avatar faces a wall. `CASINO_ROOM_BOUNDS` constant added. New `apps/web/src/lib/three/room-camera.ts` reusable for future interior scenes. §10c casino-input entry updated. Prior: 2026-05-19 — World colliders: new `collision/world-colliders.ts` with 19 XZ-plane disc colliders (12 buildings ≈ 190wu + 7 props 50–220wu). Integrated into `player-avatar.tsx` (VRM+GLB), `arena-npcs.tsx` (GLBNpcMesh+VRMNpcMesh), `arena-location-npcs.tsx` (spawn sanity push-out). Zero per-frame allocs. Slide-along-wall semantics. §2h added. Prior: 2026-05-19 — Bio-luminescent label system: Fraunces serif capsule + dashed-cyan tether + pulsing anchor dot replaces plain uppercase wordmarks on all NPC and building labels. See §5d for full spec. Prior: 2026-05-18 — Casino interior bug-fix pass 2: avatar scale override was a no-op (CASINO_VRM_TARGET_HEIGHT was 270 = same as VRM_AVATAR_TARGET_HEIGHT_WU). Dropped to 160wu so cabinet tops (159wu) reach avatar forehead — tall Vegas slot-machine feel. Camera offsets recomputed proportionally: CAM_ABOVE 270→190, CAM_BEHIND 520→450, CAM_LOOK_Y 120→70. _casinoCamYaw module-scope var reset to π on mount in both CasinoVRMAvatarInner and CasinoGLBAvatarInner to prevent catch-up swing on re-entry. §10c updated. Prior: 2026-05-18 — Casino interior bug-fix trio (Bug 1: arrow-key support; Bug 2: chase-camera yaw decoupled via `_casinoCamYaw` module ref + `CAM_YAW_LERP=0.05` slow-lerp applied to BOTH VRM and GLB branches; Bug 3: cabinet heights now world-scale 159wu total vs 270wu avatar = 59% chest-height). `computeVRMAvatarFit` gained optional 3rd param `targetHeightOverride`. §10c slot-cabinet sub-entry updated.

Prior: 2026-05-18 — Phase 6.2.2 building scale + T-pose fixes. MAX_FOOTPRINT 1800→2000wu (Sandy's dome is square XZ≈25.87, hit 1800 cap at 738wu height; 2000wu cap → 820wu, leaves 178wu clearance at R=130 arc). Node name bug fixed: `childScaleOverrides` + `bodyAnchorChild` keys for Squidward + Krusty Krab used underscore-sanitized names (silent no-ops since Three.js GLTFLoader preserves verbatim names). Corrected to literal GLB names: `"Squidward's House"` (apostrophe+space) and `"The Krusty Krab"` (spaces). targetMaxDim bumps: messaging-channels 1000→2500 (Sandy dome effective 820wu), api-integrations 1300→2500 (Salty Spitoon km-scale, effective 1209wu), cron-automation 1300→2200 (Patty Building effective 1513wu), memory-rag 1400→1700 (Squidward +childScale 1.4→1.7). Sandy NPC T-pose fixed: `useGLTF` now passes `extendLoaderWithMeshopt` for `EXT_meshopt_compression` GLBs; `clipAction(idleClip, cloned)` passes cloned as optionalRoot to force track resolution against cloned bone hierarchy; `reset().setLoop(THREE.LoopRepeat, Infinity).play()` chain. §2 slot table + footprint cap doc + childScaleOverrides doc + bodyAnchorChild doc updated. Prior 2026-05-18 — Concern 6.0.5: Walkable casino interior. Self-contained WASD + follow camera in casino-interior.tsx. CasinoPlayerAvatar (VRM/GLB router). 4 primitive slot cabinets on left wall (module-scope BoxGeometry/CylinderGeometry, matrixAutoUpdate=false). Walk-out exit corrected to (2000, 5760). Canvas camera [0,80,250]→[0,55,400]. §10c updated. Prior 2026-05-18 — Body-anchor pass: `bodyAnchorChild` field on `BUILDING_MODELS`. For buildings whose GLB bundles body + pathway/sign, computes body child's bbox center (post-childScaleOverrides) and shifts pivotOffsetX/Z so the BODY center lands at the ring slot — not the full-GLB combined center. Fixes Squidward's house + Krusty Krab placement pushed-back bug. `pivotZBias: 180` removed from memory-rag (superseded). `_bodyBbox`/`_bodyCenter` scratch added. `EditableBuilding` useMemo also updated. Size bumps: code-development 1000→1400, api-integrations 1000→1300, cron-automation 1000→1300. §2 slot table + §2 body-anchor doc updated. Prior 2026-05-18 — Differential child-scale pass (`childScaleOverrides`) for Squidward house and Krusty Krab: building body nodes scaled 1.4–1.5× on top of uniform base scale; pathway/sign unchanged. targetMaxDim raised to 1400 for both buildings. `applyChildScaleOverrides()` helper added to arena-buildings.tsx; runs after strip passes, before mergeStaticMeshesByMaterial so scales are baked into merged vertex positions. §2 slot table rows 2+11, §2 childScaleOverrides doc added. Prior 2026-05-18 — Phase 6.2.1: ring R=160→130 tiles (5120→4160wu — R=160 too spaced out from spawn). Arc spacing 2680→2178wu. Fog near 3800→4500, far 6800→9000, camera.far 6800→10000. All 12 building zone positions updated in tilemap-data.ts, arena-buildings.tsx, npc-definitions.ts, map-locations.ts. §2 slot table, §3 camera.far, §4 fog updated. Prior 2026-05-18 — Concern 6.0.3: Casino walk-in animation + SceneTransition pattern. `SceneTransition.tsx` (new, generic), casino onClick wired to walk-in flow (triggerCasinoWalkIn), avatar exit position = casino door (940, 5760 game-px), spawn fix avatarPositionRef → (5760, 6140). §1 spawn, §10c updated. Prior 2026-05-18 — Phase 6.2: grid 240→360 tiles, ring R=100→160 tiles (3200→5120wu), center tile 120→180, MAP_WIDTH/HEIGHT 7680→11520wu, arc spacing 1675→2680wu. NPC_INSET_WORLD 1000→1300wu (Patrick fix). `computeBuildingScale` switched to max(X,Y,Z) normalization (`targetMaxDim` param replaces `targetHeight`); all per-building values updated. Sandy Treedome DoubleSide fix for transparent materials. DECO_INNER_EXCLUSION_R 1500→800wu. Town-center props spread: bazaar (-600,300), marketplace (800,300), auction dome z=-1000. All building zone positions, NPC home coords, pathfinding COLS/ROWS, and free-roamer radii updated to match. §1, §2, §5e, §7 updated. Prior 2026-05-18 — World-space DOM label redesign: all pills removed; NPC labels now 10px uppercase wordmarks with black text-shadow + no background, opacity 0.65 within 800wu fading to 0 at 3000wu, 10 Hz building-occluder raycast via `_checkOcclusion` in `world-labels-overlay.tsx`; building labels now 11px italic cyan wordmarks with glow text-shadow, opacity 0.40 within 2000wu fading to 0 at 5000wu, CSS hover → opacity 1; OpenClaw chip replaced by 7px green dot. `LabelEntry` gains `fadeNear/fadeFar/fadeBaseOpacity/_prevOpacity/occlude/occludePhase/_occludeResult`; `UseWorldLabelOpts` gains matching opts. §5d WorldLabelsOverlay row updated. Prior prior 2026-05-18 — §6f Animation Shipping Rules added.

---

## 1. World dimensions & coordinate system

Source: `apps/web/src/lib/pixi/tilemap-data.ts:6-10`

| Constant | Value |
|---|---|
| `TILE_SIZE` | 32 px |
| `MAP_COLS`, `MAP_ROWS` | 360 (Phase 6.2 2026-05-18: 240→360; Phase 6.1: 160→240) |
| `MAP_WIDTH`, `MAP_HEIGHT` | 11520 wu (= 360 × 32) |
| `CENTER_TILE` | 180 (= MAP_COLS / 2) |
| `HALF_W`, `HALF_H` | 5760 wu |

**Game-space → 3D world:**
- Game-space (2D pixel plane): `(0..11520, 0..11520)` — origin top-left, +x right, +y down.
- Three.js world (XZ plane): `(-5760..+5760, -5760..+5760)` — origin center.
- Conversion: `worldX = gameX - HALF_W; worldZ = gameY - HALF_H` (`World3DCanvas.tsx:291-293`, `player-avatar.tsx:84-86`, `arena-npcs.tsx:31-33`).
- Village center tile `(180, 180)` → world `(0, 0)`.

| Axis | Meaning |
|---|---|
| `+X` | East |
| `+Y` | Up (toward water surface) |
| `+Z` | South |
| `-Z` | North |

Sand floor sits at `y = -2` (`arena-terrain.tsx:203`). Buildings, NPCs, and decorations ground to this plane.

---

## 2. Building scale + pivot system

Source: `arena-buildings.tsx`. See `WorldContent.md §2` for the building roster + per-building GLB paths.

**Ring geometry — Phase 6.2.1 (2026-05-18):**

Ring tuned R=160→130 tiles (5120→4160wu — R=160 was too spaced out from player spawn at (0,0,1300)). Arc spacing ≈ 2178wu (was 2680wu at R=160). 43-tile border clearance on all sides. Grid stays at 360×360.

**Phase 6.2 history (2026-05-18):** Grid 240→360, ring R=100→160. **Phase 6.1 history (2026-05-18):** Grid 160→240, ring R=72→100. Casino + Patrick's Rock swap to entertainment district. claw-arcade at WSW (2 slots from casino, NOT adjacent — preserved in Phase 6.2/6.2.1).

| Dimension | Value |
|---|---|
| Layout | 12 buildings at 30° angular spacing (true circle) |
| Radius | 130 tiles = 4160 wu from center (180,180) / world (0,0,0) |
| Angular spacing | 30° (π/6 rad) per slot |
| Starting angle | −π/2 (North), clockwise |
| Zone footprint | 14×14 tiles = 448×448 wu |
| Zone upper-left | `(round(cx) − 7, round(cy) − 7)` |
| cx formula | `180 + 130 * cos(−π/2 + slot * π/6)` |
| cy formula | `180 + 130 * sin(−π/2 + slot * π/6)` |

Slot table (clockwise from North, cx/cy in tile coords, Phase 6.2.1):

| Slot | Angle | cx | cy | Building | rotY | targetMaxDim | Notes |
|---|---|---|---|---|---|---|---|
| 0 | N (0°) | 180 | 50 | visual-creation | 0.000 | 1100 | |
| 1 | NNE (30°) | 245 | 67 | code-development | −0.522 | 1400 | 1000→1400; max-dim normalization |
| 2 | ENE (60°) | 293 | 115 | mcp-tool-use | −1.049 | 1400 | childScaleOverrides: "The Krusty Krab" ×1.5; bodyAnchorChild: "The Krusty Krab" (node name literal — no underscore sanitization) |
| 3 | E (90°) | 310 | 180 | messaging-channels | −1.571 | 2500 | 1000→2500; dome square XZ≈25.87wu, MAX_FOOTPRINT=2000 cap → effective 820wu height; rotYOffset +π; DoubleSide fix |
| 4 | ESE (120°) | 293 | 245 | api-integrations | −2.093 | 2500 | 1300→2500; km-scale GLB, after flat-base strip effective 1209wu; rotYOffset −π/2 |
| 5 | SSE (150°) | 245 | 293 | app-publishing | −2.620 | 1000 | rotYOffset +π/2 |
| 6 | S (180°) | 180 | 310 | cron-automation | 3.142 | 2200 | 1300→2200; Patty Building flat hierarchy (Object_N nodes), effective 1513wu; MAX_FOOTPRINT=2000 cap active |
| 7 | SSW (210°) | 115 | 293 | deployment-ops | 2.620 | 1400 | tallest landmark |
| 8 | WSW (240°) | 67 | 245 | claw-arcade | 2.093 | 1100 | 2 slots (60°) from casino — NOT adjacent |
| 9 | W (270°) | 50 | 180 | casino | 1.571 | 1300 | entertainment district; box3Recenter=true |
| 10 | WNW (300°) | 67 | 115 | agent-security | 1.049 | 1100 | adjacent to casino (slot 9) |
| 11 | NNW (330°) | 115 | 67 | memory-rag | 0.522 | 1700 | 1400→1700; childScaleOverrides: "Squidward's House" ×1.7 (was 1.4; literal name — apostrophe+space); bodyAnchorChild: "Squidward's House"; pivotZBias removed |

**rotY formula:** `atan2(180 − cx, 180 − cy)` — each building's +Z axis points toward plaza center (world 0, 0). Values are identical across all ring expansions because atan2 depends only on direction, not magnitude. Model-authored `rotYOffset` values are additive and stay with the building regardless of slot.

**Building scale normalization — Phase 6.2:** `computeBuildingScale` now normalizes to `max(X,Y,Z)` of the bounding box (`targetMaxDim` parameter). Prior `targetHeight` normalized Y-only, causing wide/squat buildings (Chum Bucket, Patrick's Rock) to balloon in XZ while tall/narrow buildings stayed small. Max-dim normalization gives consistent visual cube size across all GLB aspect ratios. `BUILDING_TARGET_HEIGHT = 800 wu` remains as default fallback; per-building `targetMaxDim` in `BUILDING_MODELS` overrides it via `computeBuildingScale(c, config.targetMaxDim ?? BUILDING_TARGET_HEIGHT)`.

**Building pedestals (Phase 6.1):** A flat `CylinderGeometry` stone disc (radius=560wu, height=15wu) is rendered under every building via `BuildingPedestal` component in `arena-buildings.tsx`. Color: warm sandstone (`0x8b7d6b`). Shares one `MeshStandardMaterial` instance across all 12 pedestals. Positioned at `y=-2` (flush with the sand floor). Only the per-building ring pedestals exist — there is NO central plaza disc geometry.

**Authoritative source:** `buildingZones[]` in `apps/web/src/lib/pixi/tilemap-data.ts`. All consumers (arena-buildings.tsx, minimap.tsx, PixiCanvas.tsx, map-locations.ts) derive from it.

**Footprint cap:** `MAX_FOOTPRINT = 2000 wu` (Phase 6.2.2; was 1800). If post-scale `max(sx, sz) > 2000`, scale is reduced. At R=130 (4160wu), arc gap ≈ 2178wu − footprint, so 2000wu footprint leaves ~178wu clearance per side (acceptable; tightest pair confirmed passable). Raised because Sandy's Treedome dome is square (XZ aspect≈1.0) and was hitting 1800 at 738wu visual height — too short at 4.1× avatar. Wide outliers (Sandy dome, Salty Spitoon) hit the cap; most buildings are constrained by targetMaxDim.

**Terrain lerp:** `terrainYRef.current += (ty - terrainYRef.current) * 0.6` (both VRM and GLB paths in `player-avatar.tsx`). Increased from 0.3→0.6 so avatars snap to dune peaks faster and don't visibly sink into bumpy terrain.

**Pivot correction (rotation-aware):** `computeBuildingScale()` returns `{ scale, pivotOffsetX, pivotOffsetY, pivotOffsetZ }` where `pivotOffsetX/Z = bbox_center_XZ * scale` and `pivotOffsetY = bbox.min.y * scale`. Applied via a nested inner group inside the rotating outer group:

```
outer group:  position=(cx, -2 + yOffset, cz), rotation=(0, rotY, 0)
  inner group: position=(-pivotOffsetX, -pivotOffsetY, -pivotOffsetZ + pivotZBias)
    primitive (GLB scene)
```

XZ correction rotates with the geometry because the inner group lives in the outer's local frame. Y correction grounds the geometry floor at `y = -2` for all three authoring cases (`bbox.min.y` positive, zero, or negative).

**pivotZBias** (added 2026-05-18, deprecated for buildings with bodyAnchorChild): optional per-building extra Z offset in the inner group, on top of `-pivotOffsetZ`. Use when foreground geometry (steps, path, decorative base) pulls the bbox center forward, causing the house body to appear too far back. Positive value moves building toward village center. Deprecated for buildings that use `bodyAnchorChild` — the dynamic anchor replaces the magic number. Currently: none active (memory-rag's +180wu was removed).

**childScaleOverrides** (added 2026-05-18): `Record<literalNodeName, multiplier>` applied to named Object3D child nodes AFTER `computeBuildingScale` but BEFORE `mergeStaticMeshesByMaterial`. Keys are **verbatim GLTF node names as preserved by Three.js GLTFLoader** — NOT sanitized (spaces and apostrophes are NOT converted to underscores; Three.js does not sanitize). CRITICAL: Prior implementation used underscore-sanitized keys (`Squidward_s_House`, `The_Krusty_Krab`) — these were silent no-ops for all prior commits. Corrected 2026-05-18 to literal names (`"Squidward's House"`, `"The Krusty Krab"`). The override multiplies the child's local `.scale` so the differential is baked into merged vertex positions. Use when a GLB bundles a large-footprint pathway or sign that compresses the building body via the max-dim normalizer. `targetMaxDim` sets the overall baseline; `childScaleOverrides` lets the building body punch above that baseline independently.

**bodyAnchorChild** (added 2026-05-18): name of the GLB child node whose bbox center should become the building's XZ anchor. When a GLB has a building body + forward-extending pathway/sign, `computeBuildingScale` returns a pivotOffset derived from the full-GLB bbox center (pulled toward the sign). `bodyAnchorChild` corrects this: after `childScaleOverrides` propagate, the body child's bbox center is measured in scene-local coords, the delta from the full-bbox center is computed, and `pivotOffsetX/Z` is adjusted accordingly. Only the XZ offset is corrected; Y grounding remains full-GLB based.

Pipeline ordering (inside useMemo):
1. `stripDecorativeMeshes` + `stripGroundPlanes`
2. `computeBuildingScale` → scale + pivotOffsetX/Z (full-GLB bbox center)
3. `applyChildScaleOverrides` + `updateMatrixWorld`
4. Body anchor pass: measure body child bbox → adjust pivotOffsetX/Z to body center
5. `mergeStaticMeshesByMaterial`

Currently active:
- `memory-rag` (`squidward-house.glb`): `"Squidward's House"` × 1.7 childScaleOverride (was ×1.4 with wrong underscore key — silent no-op); `bodyAnchorChild: "Squidward's House"` — moai head center aligns to slot, steps extend forward.
- `mcp-tool-use` (`krusty-krab-v2.glb`): `"The Krusty Krab"` × 1.5 childScaleOverride (was `The_Krusty_Krab` — silent no-op; corrected to literal name); `bodyAnchorChild: "The Krusty Krab"` — restaurant center aligns to slot, sign/pole extends forward.

**Strip rules** (run in order on every cloned scene):
1. `stripDecorativeMeshes(c)` — mesh-name prefix `Skybox_` AND parent-name match `{Flowers, Path, Skybox, Road, Sand}` + exact-name `BACKDROP_KILL_NAMES` set + material-name `BACKDROP_KILL_MATERIALS` set. Both kill sets currently empty.
2. `stripGroundPlanes(c)` — flat-and-at-bottom geometric test (sy/maxXZ < 0.005 AND bb.max.y < fullMinY + 5%·fullHeight).

`mergeStaticMeshesByMaterial(c)` runs after the strips — buckets same-material submeshes within each building and collapses to one mesh per bucket (`apps/web/src/lib/three/utils/merge-static-meshes.ts`).

### 2g. Canonical floor grounding for new props/stalls/buildings (added 2026-05-19)

**Rule:** ANY new static GLB mounted directly in the world (stall, decoration, building exterior, prop) MUST use `groundedYOffset()` from `apps/web/src/lib/three/utils/ground-prop.ts` to compute its world-Y position. Hard-coded `yOffset` magic numbers are banned — they only work for floor-origin GLBs and break silently when the GLB author placed the origin at the center or apex.

**Why:** GLB authors vary on where they put the mesh origin:
- **Floor-origin** (model extends +Y from origin) — flat `Y = -2` works.
- **Center-origin** (model extends ±Y from origin) — flat `Y = -2` sinks the lower half into the sand.
- **Apex/top-origin** (model extends -Y from origin) — flat `Y = -2` puts the ENTIRE model underground (this is what shipped the bazaar tent half-buried).

**Pattern:**
```ts
import { groundedYOffset } from '@/lib/three/utils/ground-prop';

const cloned = useMemo(() => scene.clone(true), [scene]);
const scale = useMemo(() => computeScale(cloned), [cloned]);
const groundedY = useMemo(() => groundedYOffset(cloned, scale), [cloned, scale]);

return <group position={[X, groundedY, Z]} scale={scale}>{/* … */}</group>;
```

`groundedYOffset(root, scale, clearance = 0)` returns the Y such that the LOWEST scaled vertex sits exactly at `SAND_BASELINE_Y` (currently `-2`). Add a small `clearance` (0.5–2wu) only if you observe z-fighting flicker at the base; for most assets `clearance = 0` is correct.

**Already converted:** `bazaar-stall.tsx`, `marketplace-stall.tsx`. Future stalls/decorations follow this pattern. `arena-buildings.tsx` building ring uses its own terrain-raycast grounding (different system — that one snaps to the actual displaced terrain height per-building, this helper grounds to the flat sand-baseline).

---

## 2h. World colliders (XZ-plane disc collision)

Source: `apps/web/src/lib/three/collision/world-colliders.ts` (new 2026-05-19).

Pure XZ-plane disc collision — no physics engine, no draw calls, zero per-frame allocations. Blocks players and NPCs from walking into buildings and town-center props.

**Architecture:**
- Module-scope collider cache (`getAllColliders()`) — recomputed only when `buildingZones.length` changes (never in practice). Returns `readonly Collider2D[]`.
- `clampMovement2D(fromX, fromZ, toX, toZ)` — called once per entity per frame, after position delta is computed, before writing to the scene graph. Returns `{ x, z, hit }`.
- Scratch vars `_sDx`/`_sDz` at module scope — zero `new Vector3()` or object allocations in the hot path.
- Slide-along-wall semantics: radial push-out from collider boundary, NOT velocity zeroing. Entity slides along curved wall surface naturally.
- Escape hatch: if entity is ALREADY inside a collider (rare — new collider placed on top of existing entity), allow outward motion to prevent permanent trapping.

**Collider counts:**

| Kind | Count | Radius | Source |
|---|---|---|---|
| Building (ring) | 12 | ≈ 190.4 wu | `buildingZones` in `tilemap-data.ts` |
| Prop (town center) | 7 | 50–220 wu each | Hardcoded from each prop's TSX constants |
| **Total** | **19** | | |

**Building radius derivation:**
```
zone tile extent  = 14 × 32 = 448 wu (diameter)
half-extent       = 224 wu
BUILDING_SCALE_FACTOR = 0.85
BUILDING_RADIUS   = 224 × 0.85 ≈ 190.4 wu
```
`scaleFactor = 0.85` gives slight corner clearance (player can brush a corner without hitting an invisible wall) while still blocking interior access. Raise to 0.90–0.95 if corners are still enterable; lower to 0.75–0.80 if the wall feels too far out.

**Prop colliders (positions verified from each TSX's exported constants, 2026-05-19):**

| ID | World XZ | Radius |
|---|---|---|
| auction-podium | (0, −1000) | 180 wu |
| town-directory-sign | (0, −120) | 80 wu |
| bazaar-stall | (−800, 300) | 200 wu |
| marketplace-stall | (800, 300) | 220 wu |
| bounty-board | (50, 0) | 60 wu |
| quest-npc | (−110, −60) | 50 wu |
| town-guide | (0, 240) | 50 wu |

**Integration points:**
- `player-avatar.tsx` — VRM branch (line ≈498) + GLB branch (line ≈936). Both call `clampMovement2D(prevWX, prevWZ, newX − HALF_W, newY − HALF_H)` then convert back to game-px via `+ HALF_W/HALF_H`.
- `arena-npcs.tsx` — `GLBNpcMesh` useFrame + `VRMNpcMesh` useFrame. Clamp applied after entity-interpolation lerp, before writing `simPos.current` + `group.position`.
- `arena-location-npcs.tsx` — Sanity push-out in `ArenaLocationNpcs` useMemo at spawn time: `clampMovement2D(0, 0, worldX, worldZ)`. Origin (0,0) is the village center — guaranteed outside all colliders — so the push direction is always radially outward from any collider the NPC might land inside.

**What is NOT covered (by design):**
- Vertical collision (Y axis) — terrain raycasting handles Y grounding.
- NPC→NPC collision — server simulation owns NPC pathfinding; client only renders.
- Casino interior — separate scene with its own bounds logic.

---

## 3. Camera system

`apps/web/src/components/three/World3DCanvas.tsx`.

Three controllers, mutually exclusive except arrow rotation:

| Controller | Active when | What it does |
|---|---|---|
| `WASDCameraController` | `controlMode === 'explore'` | WASD pans the camera target across the XZ plane (`CAM_PAN_SPEED = 500 wu/s`). |
| `FPSFollowCamera` | `controlMode === 'player' \| 'autonomous'` | Tight 3rd-person follow on the avatar's position via `avatarPositionRef`. |
| `<OrbitControls>` | always mounted | Mouse drag rotates orbit; scroll zooms. minDistance differs per mode. |
| `ArrowKeyRotationController` | always mounted | ↑↓ adjust polar, ←→ adjust azimuth at constant speed. Works in every mode. |

**Canvas initial camera:** `fov=50, near=1, far=10000`, `position = mode==='game' ? [0, 600, 1300] : [0, 560, 1000]`. (camera.far raised from 6800 to 10000 in Phase 6.2.1 to satisfy fog.far=9000 ≤ camera.far constraint.)

**DPR cap:** `dpr={LOW_END_GPU_DETECTED ? [0.55, 0.7] : [0.75, 1]}`. `LOW_END_GPU_DETECTED` is computed once at module load via `WEBGL_debug_renderer_info` — Intel/Iris/UHD/Adreno/Mali/PowerVR/Apple-integrated + `pointer:coarse` mobile. Do NOT call `gl.setPixelRatio()` inside `onCreated` — that overrides the prop and was reverted 2026-04-21.

---

## 4. Lighting + atmosphere

Hard cap: **3 lights** on Iris Xe (uniform limit + shader compile cost).

| Light | Args | Notes |
|---|---|---|
| `hemisphereLight` | `0x66bbdd, 0x223344, intensity 1.8` | Warm sky / cool ground fill. Replaces a separate ambient — no `<ambientLight>`. |
| `directionalLight` (key) | `position [150, 350, 80], intensity 2.0, color 0xffeedd` | Warm key light from upper-right. |
| `directionalLight` (fill) | `position [-100, 200, -60], intensity 0.5, color 0x88aacc` | Cool fill from opposite side for depth. |

**Fog:** `fog(FOG_COLOR=0x0e3458, near=4500, far=9000)` (`World3DCanvas.tsx`). Updated Phase 6.2.1 (2026-05-18): near 3800→4500, far 6800→9000. Rationale: camera at (0,600,1300), ring radius 4160wu (R=130). Near-ring buildings (South, ~2922wu from camera): factor 0.00 — fully clear. Far-ring buildings (North, ~5493wu): factor=(5493−4500)/(9000−4500)=993/4500≈0.22 — 22% fog blend, 78% visible. Prior near=3800/far=6800 at R=130 gave 56% blend toward the very dark FOG_COLOR for far-ring buildings — effectively invisible. fog.far=9000 ≤ camera.far=10000 ✓ constraint preserved. Iris Xe safety: DPR cap [0.55,0.7] unchanged; geometry past 5500wu is sparse sky/terrain. `WorldContent.md §5 MAX_VISIBLE_DIST=3800` still rejects decoration placements (decorations sit below the 4500wu fog.near threshold — all clear).

**Disabled atmosphere effects** (mounted but gated with `{false && <X />}`):
- `<UnderwaterAtmosphere />` — caustic plane + depth backdrop + dust particles. Overdraw on the additive transparent meshes is 8–15 ms/frame on integrated GPUs even when occluded. Last disabled 2026-04-30.
- `<UnderwaterLightRays />` — 7 cone shafts with TSL pulsing opacity. Same overdraw issue.

Both keep their mounts in the bundle so re-enabling is a one-line edit.

---

## 5. GPU constraints + perf budget

Target hardware: **Intel Iris Xe** integrated GPU + WebGPU (WebGL2 fallback). Per CLAUDE.md the browser-verification target is `FPS > 50` on this hardware.

### 5a. Hard rules — violation = silent crash / blank screen

| Rule | Where | Why |
|---|---|---|
| **No `InstancedMesh` + `ShaderMaterial`/`NodeMaterial`** | Seaweed uses merged geometry; particle-system uses `MeshBasicMaterial`. | Silent WebGPU pipeline crash. |
| **No drei `<Text>` or `<Billboard>`** | Every label is a `WorldLabelsOverlay` DOM div projected to screen space. | Kills Iris Xe pipeline. |
| **Max 3 lights** | Hemisphere + 2 directional. | Light uniform limit + shader compile cost. |
| **TSL nodes only** (no raw GLSL / WGSL) | All custom materials route through TSL. | Three.js r182 routes WebGPU + WebGL through TSL. |
| **Dynamic import for WebGPU** | `three/webgpu` imported only inside `createWebGPURenderer()`. | Keeps WebGL-only bundles lean. |

### 5b. Perf HUD (`apps/web/src/components/game/perf-hud.tsx`)

Samples `window.__W3D.gl` at 2 Hz. Reads:
- **FPS** — RAF rolling counter; green ≥45, yellow ≥25, red <25.
- **Frame avg/max ms** — frame timing min/max over the sample window.
- **Long tasks / sec** — `PerformanceObserver` longtask entries.
- **Heap MB** — `performance.memory.usedJSHeapSize` (when available).
- **Draws** — `gl.info.render.drawCalls` (per-frame). 2026-05-11: fixed from `info.calls` (cumulative, always growing).
- **Tris** — `gl.info.render.triangles`.
- **Objs** — live `scene.traverse()` Mesh count.
- **Pipes** — `gl._pipelines.caches.size` (WebGPU) / `gl.info.programs.length` (WebGL). 2026-05-11: fixed from `gl.info.render.pipelines` (doesn't exist on WebGPU). Target ≤120.
- **Backend** — `WebGPU` or `WebGL`.

### 5c. Allocation hygiene

Every hot path uses module-scope `THREE.Vector3 / Matrix4 / Raycaster` scratch objects, not per-frame `new`:

- `World3DCanvas.tsx:80-92` — `_offset, _spherical, _followOffset, _wasdForward, ...`
- `arena-npcs.tsx:44-47` — `_raycaster, _rayOrigin, _rayDir`
- `arena-buildings.tsx:37-40` — `_buildRaycaster, _buildRayOrigin, _buildRayDir`
- `arena-location-npcs.tsx:27-30` — `_locRaycaster, _locRayOrigin, _locRayDir`
- `player-avatar.tsx:94-97` — `_avatarRaycaster, _avatarRayOrigin, _avatarRayDir`
- `click-to-move.tsx:31-33` — `_dotWorldPos, _dotMatrix, _rotMatrix`
- `npc-controller.tsx:45-47` — `_camForward, _camRight, _worldUp`
- `particle-system.tsx:161-164` — `_particleMatrix, _particleScale, _particlePos, _particleQuat`
- `trail-renderer.tsx:8` — `_trailScratch`

### 5d. Throttles + staggers

| Cost | Throttle | Where |
|---|---|---|
| Terrain raycast | Every 3rd frame, offset by `(frame + seed) % 3` per NPC so spikes stagger. | `arena-npcs.tsx`, `arena-location-npcs.tsx`, `player-avatar.tsx` |
| GLB NPC idle animation | 20 Hz (`(frame + seed) % 3 === 0`). | `arena-npcs.tsx` |
| GLB walk animation | Full 60 Hz — 8 rad/s cycle needs Nyquist. | `arena-npcs.tsx` |
| VRM AnimationMixer | Full 60 Hz unconditional (B9 fix 2026-04-24). | `vrm-character-animator.ts:updateMixerOnly` |
| VRM spring bones | Uniform 15 Hz (`springMod = 4`) for all VRM NPCs. Was tiered 10/20 Hz by distance; flattened with the culling removal 2026-05-11. | `arena-npcs.tsx:VRMNpcMesh` |
| WorldLabelsOverlay projection | Full 60 Hz, single root, ResizeObserver-cached canvas size. Per-label: distance-fade opacity (linear, no allocations), 10 Hz building-occluder raycast (staggered by `occludePhase % 6`). **Label rig (bio-luminescent):** Fraunces-serif capsule + 38/56 px dashed-cyan tether + 5 px pulsing anchor dot. Rig uses `translateY(-50%)` so anchor dot lands at projected head point. Two CSS keyframes (`bio-pulse` 2.4 s, `bio-drift` 5.4 s) in `globals.css`; staggered per-label via `--label-phase` CSS var (hash mod 10 / 10). NPC `fadeBaseOpacity` 0.65 → 0.85. Building label: brighter glow (`0 0 22px`), longer tether (56 px), category sub-line. Fraunces loaded via `next/font/google` (`--font-fraunces`). Zero new per-frame allocations. | `world-labels-overlay.tsx`, `arena-buildings.tsx`, `arena-npcs.tsx`, `arena-location-npcs.tsx`, `globals.css`, `layout.tsx` |
| Texture upload | `requestIdleCallback` with 6 ms time budget per slice. 98 textures via rIC = ~352 ms total (down from 8 s rAF-based). | `World3DCanvas.tsx:StaggeredTextureUpload` |

### 5e. Static meshes — `matrixAutoUpdate = false`

Set during clone for every static object so `updateMatrixWorld` skips them:
- All 12 buildings + their cloned children (`arena-buildings.tsx` — Phase 6.0.1: was 10)
- 80 → 30 → 60 decoration groups + their merged children (`arena-terrain.tsx` — 2026-05-13 retune: 60 props in 1500–3800wu visible annulus, was 30 props in 2700–4500wu hidden behind ring buildings)
- 3 underwater atmosphere meshes (when enabled) + 7 light ray cones
- Bounty board (4 meshes), bazaar fish stall, marketplace stall, auction dome, auction podium

### 5f. Pipeline cache budget

`renderer._pipelines.caches.size` is the live count of compiled WebGPU pipelines. Each unique `(material, geometry-attribute-set)` combo adds one. Current scene: ~115–120. Pipelines aren't auto-evicted when meshes go away — replacing a mesh with a normalised-attribute clone permanently bloats the cache.

`PreCompilePipelines` (`World3DCanvas.tsx`) calls `gl.compileAsync(scene, camera)` on the first post-mount RAF — moves the ~274 ms initial compile hitch into the loading spinner. No-op on WebGL.

---

## 6. Animation systems

### 6a. GLB NPCs (lobster, crab, hermit, crayfish, etc.)

Two paths based on species key:

| Species | Animator | Source |
|---|---|---|
| `lobster`, `crayfish` | `LobsterAnimator` — skeletal bone discovery (`lobster-parts.ts`) + procedural squash/stretch (`procedural-animation.ts`) | `lib/three/lobster-animations.ts` |
| Everything else | `createCharacterAnimator(key, scene)` — universal animator over the species' bones | `lib/three/character-animations.ts` |

Switch point: `arena-npcs.tsx:102` — `useNewSystem = key !== 'lobster' && key !== 'crayfish'`.

XZ position smoothing (2026-05-17): **dead reckoning + corrective lerp**. The server publishes positions at 5 Hz (one snapshot per 200 ms / 44 wu step). Each frame, `reckonNpcTarget(d, now, out)` (`arena-npcs.tsx`) projects the target forward at `(d.x − d.prevX) / d.tsDelta · elapsed`, clamped to one tick period. The displayed `currentPos` then lerps toward that projected target at `LERP_SPEED_DR = 8` (`1 − exp(−8·dt)`), giving ~27 wu steady-state lag — well under one step. Replaced the old pure exp-lerp at `LERP_SPEED = 1.5` that pumped visibly every 200 ms because it tracked the stale snapshot, not the moving target. Sentinel `d.ts === 0` (set by `makeDemoNpc` / `spawnPlayerNpc`) bypasses projection for client-only NPCs; `direction === 'idle'` bypasses to prevent jitter around stationary points.

Bob: `sin(t · 4.0 + seed) · 0.6` when moving (`arena-npcs.tsx:172`).

Movement speed (player + NPC controller): `SPEED = 550 wu/s`.

### 6b. VRM avatars (Milady)

Loader: `apps/web/src/lib/three/vrm-loader.ts`. Suspense-compatible, module-cached. Uses `@pixiv/three-vrm@3.5.2` + `@pixiv/three-vrm-animation@3.5.2` (only non-three.js render deps; peer-compatible with three 0.182).

Post-load pipeline (every VRM):
1. `VRMUtils.removeUnnecessaryVertices(vrm.scene)`
2. `VRMUtils.removeUnnecessaryJoints(vrm.scene)` — prunes finger/toe/face bones not driven by Mixamo clips. ~20–40 % bone count reduction.
3. `VRMUtils.combineSkeletons(vrm.scene)`
4. `rotateVRM0(vrm)` — flips VRM 0.x rigs (-Z forward) to VRM 1.0 (+Z forward) convention. NOTE: ClawVille's Milady VRMs are Mixamo-rigged facing -Z natively, so post-rotateVRM0 they face +Z; facing math is `atan2(vx, vz)` with **no negations**.
5. MToon outline pass disabled — `m.outlineWidthMode = 0` on all MToonMaterial instances. Halves draw calls per VRM mesh. Reversible by setting to 1 (World) or 2 (Screen).
6. Wandering VRMs: `vrm.lookAt = undefined; vrm.expressionManager = undefined` so `vrm.update()` skips eye-tracking and morph-target work.

### 6c. Mixamo retarget (`apps/web/src/lib/three/mixamo-retarget.ts`)

Three Mixamo clips loaded once at module level:
- `/avatars/animations/idle.glb`
- `/avatars/animations/walk.glb`
- `/avatars/animations/run.glb`

Per VRM, `VRMCharacterAnimator` retargets `mixamorig:*` bone tracks onto the VRM's VRMHumanBoneName via a canonical map, drives an `AnimationMixer` with 0.3 s idle ↔ walk crossfade. Must `reset().fadeIn().play()` the incoming clip — `crossFadeTo` alone only schedules weights and leaves a non-playing incoming action frozen (see memory `feedback_vrm_crossfade_must_play`).

**Humanoid avatar sizing** (`apps/web/src/lib/three/vrm-avatar-sizing.ts`) — every humanoid VRM (Milady / Hermes / Tekk / future) renders at the same on-screen height regardless of native bbox unit convention. `computeVRMAvatarFit(vrm, speciesOrAnimatorId)` measures the bbox at scale=1, scales to `VRM_AVATAR_TARGET_HEIGHT_WU = 179.2` world units, and returns `offsetY = -box.min.y * scale` so feet land at world Y=0 whether the rig uses VRoid-spec feet-at-origin (Milady) or Mixamo hips-at-origin (Hermes/Tekk). `SPECIES_TARGET_HEIGHT_WU` overrides the target for accessories that legitimately overshoot the body silhouette (Tekk fan-wings: 230 wu). Used by `arena-npcs` (NPCs) **and** `player-avatar` (player). Do NOT use `reg.scale` (=13, picker-only).

**Per-character animation overrides** (`apps/web/src/lib/three/character-anim-overrides.json`) — when a VRM's proportions diverge enough from the generic Mixamo skeleton (chibi vs adult-realistic, female vs male gait), the retargeter produces visible foot-slide / hand-hip clipping. Fix: per-skeleton-class Mixamo bakes downloaded with "Skin: With Skin", retargeted to each character's actual bone lengths. `VRMCharacterAnimator(vrm, animatorId)` looks up `animatorId` → slot → GLB path in the JSON, falling back to the generic clip when no override exists. The JSON is the single source of truth; `agent-model-registry.ts` exposes `animatorId` per `ModelRegistryEntry` so picker / arena-npcs / player-avatar / reef-race all agree.

**Skeleton classes** (`scripts/mixamo/characters.json`):

| Class | Members | Bake strategy |
|---|---|---|
| `mixamo-adult-male` | tekk, hermes-male | Per-character (different proportions: wings vs lean adult) |
| `mixamo-adult-female` | hermes-female | Per-character bake |
| `vrm-milady` | all 8 Milady VRMs | **Shared** — one Mixamo upload powers every Milady; `animatorId='vrm-milady'` on every entry |
| `crustacean` | lobster + future GLB crustaceans | No Mixamo path; hand-animated in Blender |

CLI: `bun scripts/mixamo/save-character.ts <slug> <character_id> <skeletonClass>` registers; `bun scripts/mixamo/add-anim-everywhere.ts <AnimName> <skeletonClass>` fetches the new bake for every character in the class, auto-patches `character-anim-overrides.json` via `patch-overrides.ts`. Smoke test: `bun scripts/mixamo/smoke-patcher.ts` (10 assertions, ~5 s).

**Mixamo In-Place toggle is forced ON.** Without it, Mixamo bakes forward locomotion into the hip bone's Z track (verified empirically on `female-walk.fbx`: hip.Z ramps 0→1.73 across 30 frames while hip.Y oscillates 5cm for the bob). After Blender's Y-up→glTF axis conversion the Z forward drift becomes Y up drift, so the avatar "shoots vertically into the sky" every walk cycle. `fetch-animations.ts` mutates the `In Place` param in `gms_hash.params` before submitting the export job. Override with `--no-inplace` only when you actively want baked root motion (e.g., a one-off cinematic clip). Diagnostic helper: `bun scripts/mixamo/diagnose-fbx-walk.py` via headless Blender dumps the hip translation curves so you can confirm root motion is gone after the bake.

`fadeIn` multiplies the action's current weight by the interpolated fade, so an action whose weight is 0 stays at 0 (memory `feedback_fade_multiplies_weight`). Always start with `enabled = false` (gated by `crossFadeTo`), never `weight = 0`.

### 6d. Verse-Engine skeleton.update batching

`VRMCharacterAnimator` constructor collects one `skeleton.update` fn per unique skeleton, replaces every SkinnedMesh's `skeleton.update` with a no-op, caches originals in `_skeletonUpdateFns[]`. `update()` / `updateMixerOnly()` call `for (const fn of this._skeletonUpdateFns) fn()` once after `mixer.update()`. Eliminates 3–4 redundant `skeleton.update` calls per VRM per frame. `dispose()` restores originals for safe re-construction.

Reference: VerseEngine/three-avatar `avatar.ts:614`.

### 6e. Jump system (`apps/web/src/lib/three/jump-state.ts` + `jump-ticker.tsx`)

Module-scoped state (Zustand deliberately avoided — per-frame `set()` at 60 Hz would re-render every subscriber). Dedicated `<JumpTicker />` mounted **before** any consumer in `World3DCanvas.tsx` so R3F's mount-order useFrame guarantees fresh `heightOffset` for camera/NPC/avatar renders that same frame.

Charge-and-release model. SPACE rising-edge triggers `charging`; release classifies tap vs scaled launch:

| From | Event | To | Notes |
|---|---|---|---|
| `grounded` | SPACE rising edge | `charging` | Avatar on ground, vz = 0, charge bar fills |
| `charging` | release < 200 ms (`JUMP_TAP_THRESHOLD_MS`) | `quick` | `vz = JUMP_QUICK_VZ0 = 120 wu/s` |
| `charging` | release ≥ 200 ms | `launch` | `vz = sqrt(vzMinSq + (vzMaxSq − vzMinSq) · t)`, t = (holdMs−200)/1300. vz² is linearly interpolated so peak altitude is linear in charge. |
| `charging` | `holdMs ≥ 1500` (`JUMP_MAX_HOLD_MS`) still held | `launch` | Auto-launch at max charge; vz = 700 wu/s |
| `quick` / `launch` / `sinking` | SPACE rising edge mid-air | `quicksink` | Fast controlled descent at constant `JUMP_QUICKSINK_VZ = -600 wu/s` |
| `quick` | `vz ≤ 0` natural | `sinking` | Smooth apex, no freeze |
| `launch` | `vz ≤ 0` natural | `sinking` | Smooth apex |
| `sinking` | `heightOffset ≤ 0` | `grounded` | Landing |
| `quicksink` | `heightOffset ≤ 0` | `grounded` | Landing |
| any | `movementFrozen === true` via `enterBuilding()` | `grounded` | Synchronous reset |
| any | `setControlMode / setHasAgent / setAgentConnection / resetStore` | `grounded` | Hard reset on all four controlMode mutation paths |

Per-frame physics (`updateJump(rawDt)`): `dt = min(rawDt, 0.1)`. Gravity: quick = `-220`, launch = `-160`, sinking = `-45` (clamped at vz ≥ `-150`), quicksink = constant `-600`. `heightOffset` integrates `vz·dt`, clamped at 0.

Modes that ignore SPACE: `explore` (no avatar) and `autonomous` (engine-driven).

`playerAltitude` is a persistent swim altitude separate from the jump arc — accumulated by input controllers from camera-forward Y. Both stack at render time. Reset to 0 by `resetJump()`.

**Jump animation pipeline (2026-05-17).** Until 2026-05-17 the avatar translated vertically with no animation drive. New pipeline (`player-avatar.tsx` VRM branch + `arena-npcs.tsx` VRMNpcMesh possessed-player branch):

- `grounded → airborne` (rising `wasAirborneRef` edge): fire `animator.playOneShot('jump')` as a takeoff emote AND `animator.setSurfaceClip(airborneClip)` where `airborneClip = 'flying'` if `animatorId === 'tekk'` else `'swimming'`. The animator's onFinished handler crossfades from the jump one-shot into the new surface clip automatically — single trigger, no manual sequencing.
- While airborne: pass `isMoving = false` to `animator.update()` / `animator.updateMixerOnly()` so the locomotion crossfade lands on `surfaceClip` (swim/fly) regardless of horizontal input. Players using WASD mid-jump don't get "walking in air".
- `airborne → grounded`: restore `setSurfaceClip('idle')`. Next `isMoving=false` frame crossfades to standing idle, not stuck on swim.

Lobster / crayfish GLB avatars don't participate (no swim/fly clip in their procedural animator) — they keep the existing vertical-only behaviour.

### 6f. Animation shipping rules (STRICT — added 2026-05-18)

**Every animation change MUST follow this checklist.** Hard-won across an evening of iteration on emote loading, NPC stutter, and jump pipeline. Skipping any of these reintroduces a class of bug we've already paid for. Same standing as the same-diff doc rule.

**1. Asset delivery — bundle, don't fan out.**
- New emote / one-shot clips go INTO `apps/web/public/avatars/animations/_emotes.glb` via `scripts/build-anim-bundles.mjs`. Single multi-clip GLB per group; runtime picks by name via the `bundle.glb#clipName` syntax in `ANIM_PATHS`.
- Never add 19 individual `.glb` files to the manifest. The hosting cost is fine; the **request count** at mount is what kills cold-load (visible in network panel as the `injected.js` fanout pattern). gltf-transform `dedup()` shrinks the bundle 11 % below the sum of singles anyway.
- Locomotion (idle/walk/run) stays separate per-character — they're SW-precached and must load eagerly, and bundling them would force the 2.2 MB emote payload to load alongside.

**2. Mount-time fetch budget.**
- `preloadMixamoClips()` is locomotion-only. NEVER call `preloadEmoteClips()` from a mount path — it kicks 19 emote fetches via `requestIdleCallback`, which is still 19 round-trips against the Cloudflare edge.
- If a feature genuinely needs a specific set of emotes warm before its trigger (e.g. `EmoteHotbar`'s ≤4 equipped emotes, `ReefRacePlayer`'s wipeout/victory), call `preloadClips(names)` with the EXACT list — never the whole tier.

**3. Service worker matcher.**
- Any new asset path prefix (`/cosmetics/`, `/skins/`, future…) MUST be added to `ASSET_PATH_PREFIXES` in `apps/web/public/sw.js`. The matcher is path-prefix + extension `.glb`/`.vrm`; assets under a missing prefix bypass the cache silently and pay full network cost on every return visit.
- Bump `CACHE_VERSION` whenever sw.js changes — the activate handler reaps the prior cache. Without the bump existing clients keep the old matcher.

**4. SW propagation.**
- `apps/web/src/components/sw-register.tsx` MUST keep `updateViaCache: 'none'` + an explicit `reg.update()` on registration. Without those Chrome HTTP-caches sw.js for the server's max-age and only checks for an updated SW once per 24 h on navigation — sw.js redeploys can take a full day to roll out. Verified rollout via `swVersion` console probe (see CLAUDE.md operational notes).

**5. NPC position smoothing — entity interpolation only.**
- For ANY server-driven NPC position rendered on the client: **render 1 tick behind real-time and lerp between two known snapshots.** Inline pattern, no helper function (allocation-free at 60 × NPC × Hz).
  ```ts
  const alpha = clamp((Date.now() - d.ts) / d.tsDelta, 0, 1);
  renderX = lerp(d.prevX, d.x, alpha);
  ```
- DO NOT extrapolate forward, dead-reckon, or exp-lerp toward `d.x`. We tried all three; each had a failure mode (5 Hz pumping / direction-change drift / network-jitter-amplified velocity). Entity interpolation is the only pattern that handles network jitter without producing wrong-speed motion. AAA standard (Quake/HL/CS lineage).
- Demo / client-only NPCs use `ts === 0` sentinel — interpolation alpha clamps to 1 (snap to current). Idle direction zeros velocity.

**6. VRM skeleton flush at 60 Hz, springs at 15 Hz.**
- `VRMCharacterAnimator.updateMixerOnly()` MUST flush `scene.updateMatrixWorld(true)` + every `_skeletonUpdateFns` value every frame. The cheap part of `vrm.update()` — `vrm.humanoid?.update()` — also runs every frame here.
- `updateSpringOnly()` runs ONLY `vrm.springBoneManager?.update(delta)` + a re-flush. Spring physics is the expensive part; throttle that to 15 Hz, not the whole vrm.update.
- Throttling skeleton flush is the bug that made VRM wanderers chunk forward every 4 frames while GLB NPCs stayed smooth — the SkinnedMesh's `boneMatrices` GPU uniform only refreshes when `skeleton.update()` runs, and we patch the renderer's auto-flush to a no-op for skeleton-batching reasons. The body draws stale bone matrices on every frame the flush is skipped.

**7. Surface-clip pipeline for state transitions.**
- Don't fire `playOneShot()` for animations that should hold for an entire phase (jump ascent, swim, charging squat). Use `setSurfaceClip(name)` — loops the clip via `LoopRepeat` and crossfades on the next call.
- Compute the desired clip every frame from state (`phaseCharging`, `airborne`, etc.) but only call `setSurfaceClip` when it CHANGES (gated by a `lastSurfaceClipRef`). The animator's lazy GLB load + crossfade should only fire on state transitions, not 60 ×/s.
- While in a non-locomotion state (charging, airborne), gate the locomotion crossfade by passing `isMoving = false` to `update()` / `updateMixerOnly()`. Otherwise WASD held mid-leap re-introduces walk.

**8. Per-character sizing has ONE knob.**
- All humanoid VRMs route through `computeVRMAvatarFit()` from `vrm-avatar-sizing.ts` targeting `VRM_AVATAR_TARGET_HEIGHT_WU` (currently 270 wu). Change one number, every humanoid resizes. Per-character overrides go in `SPECIES_TARGET_HEIGHT_WU` keyed by BOTH the species key (NPC) AND the animatorId (player) — those names diverge (`hermes_male` vs `hermes-male`) and both call sites resolve through the same map.
- Don't use `reg.scale` from the model registry — that's picker-thumbnail metadata only, never load-bearing on world render.

---

## 7. Terrain shader

`apps/web/src/lib/three/arena-terrain.tsx:SandFloor()`.

| Spec | Value |
|---|---|
| Plane size | `MAP_WIDTH × 3` × `MAP_HEIGHT × 3` = 34560 × 34560 wu (Phase 6.2: MAP_WIDTH=11520) |
| Segments | 120 × 120 |
| Material | `MeshStandardNodeMaterial` (TSL) |
| Render Y | -2 |

Dune field — summed sin/cos at three frequencies + per-vertex noise, baked into vertex positions:
```
dune1 = sin(x·0.004 + 1.3) · cos(y·0.006 + 0.7) · 14
dune2 = sin(x·0.01  + 3.1) · sin(y·0.013 + 2.4) · 8
dune3 = sin(x·0.025 + 0.5) · cos(y·0.03  + 1.2) · 4
ripple = sin(x·0.08 + y·0.06) · 2 + sin(x·0.12 − y·0.09) · 1
totalHeight = dune1 + dune2 + dune3 + ripple + ripple2 + noise
```

Vertex color ramp (5 stops):
```
SAND_RIDGE  0xfff0d4  bright white-sand peaks
SAND_HIGH   0xe8d0a8  warm sand
SAND_MID    0xc4a878  golden mid-tone
SAND_VALLEY 0x8a7050  dark moody valleys
SAND_DEEP   0x5c4a32  deep brown-black troughs
```
`t = clamp((totalHeight + 28) / 56, 0, 1)`, interpolated through the ramp.

TSL fragment shader (`createSandMaterial()`):
- Position-driven ripple noise (`sin(px·0.07 + py·0.05)`)
- Grain detail (`fract(sin(px·3.7 + py·7.3) · 43.758)`)
- Smoothstep height blend (`smoothstep(-28, 28, h)`) between `warmSand(1.0, 0.91, 0.78)` and `coolDeep(0.25, 0.19, 0.12)`

**Terrain raycast (NPC grounding):** the terrain mesh sets `layers = TERRAIN_LAYER (=1)`. Raycasters subscribed only to layer 1 — saves traversing the rest of the scene.

---

## 8. Seaweed (`apps/web/src/lib/three/merged-seaweed.tsx`)

| Spec | Value |
|---|---|
| Blade count | 3 000 (was 1 200 before merge sweep) |
| Variants | 3 height tiers, color-graded |
| Geometry | One `BufferGeometry` per variant via `mergeGeometries` — all blades baked into vertex positions |
| Material | `MeshStandardNodeMaterial` with TSL wind |
| Wind | Time-varying sin sway driven by `timerLocal()` × position offset per blade |

No `InstancedMesh + ShaderMaterial` — known WebGPU silent crash on Iris Xe. Merged geometry is the only safe path for high-count animated foliage.

---

## 9. Asset compression + loading

### 9a. Loader stack

| Decoder | Init component | What it handles |
|---|---|---|
| `KTX2Loader` | `<KTX2LoaderSetup />` (`ktx2-loader-setup.tsx`) | GPU-compressed textures (BC7 on Iris Xe via WebGPU). Must render before any KTX2-textured GLB loads. |
| `MeshoptDecoder` | `<MeshoptLoaderSetup />` (`meshopt-loader-setup.tsx`) + per-call `extendLoaderWithMeshopt` | `EXT_meshopt_compression` GLBs. Belt-and-suspenders init — building useGLTF calls also pass `extendLoaderWithMeshopt` because the module-scope decoder isn't always registered before the preload fires. |
| `DRACOLoader` | Wired into the shared GLTFLoader on demand | `KHR_draco_mesh_compression`. Used by sandy-treedome-v2 / v3 + several scenery GLBs. |

### 9b. Pre-compile + staggered upload

- `<PreCompilePipelines />` (`World3DCanvas.tsx`) — `gl.compileAsync(scene, camera)` after first RAF. Moves 274 ms hitch into loading spinner. WebGL no-op.
- `<StaggeredTextureUpload />` — `requestIdleCallback` with 6 ms budget per slice (~98 textures in ~352 ms). Safari fallback: rAF batched 4/frame. Was 200 textures × 2/frame = 8 s pre-rIC.
- `<DeferredTerrainPreloads />` (rendered outside the Canvas) — fires `useGLTF.preload()` for all decoration + environment GLBs inside a `requestAnimationFrame` so the preloads land AFTER the first painted frame, not at module evaluation.

### 9d. Mixamo animation GLB load policy (2026-05-17)

22 Mixamo animation GLBs live under `apps/web/public/avatars/animations/` (3 locomotion + 13 emotes + 4 surf clips + swimming/flying/praying). Per-character bakes for Hermes-male / Hermes-female / Tekk add variants under subfolders.

- **Mount-time eager fetch — locomotion only.** `preloadMixamoClips()` in `vrm-character-animator.ts` now calls only `preloadLocomotionClips()` (idle / walk / run). Callers: `player-avatar.tsx`, `arena-npcs.tsx`, `SelectAgentCanvas.tsx`, `ReefRacePlayer.tsx`.
- **Emote tier — on-demand via `playOneShot()`.** First trigger per VRM instance fetches the GLB through `loadRawGltf` and caches it. Players who never emote pay zero.
- **Hotbar warm-up — targeted `preloadClips()`.** `emote-hotbar.tsx` warms the ≤4 currently equipped emote GLBs the moment the equipped list resolves. Overlaps fetches with first interactive frame without fanning out all 22.
- **History.** Pre-2026-05-17 `preloadMixamoClips()` also kicked off `preloadEmoteClips()` (all 19 emotes via `requestIdleCallback`). That fanout was the visible queue of `injected.js`-initiated fetches in the network panel and contributed ~3 s to first-interactive on Cloudflare Falkenstein POPs. `preloadEmoteClips()` is still exported for code that genuinely wants the whole tier.

### 9c. Renderer factory

`createWebGPURenderer(canvas)` (`World3DCanvas.tsx:619-649`):
- Dynamically imports `three/webgpu`
- Falls back to `WebGLRenderer({ canvas, antialias: false, powerPreference: 'low-power' })` on WebGPU init failure
- Async — the Canvas `gl` prop accepts a promise factory

---

## 10. Activity rooms

Each activity ID (`bumper-shells`, `reef-race`) has a dedicated 3D scene component mounted at `/activity/[activityId]/[roomId]`. Open-world scene unmounts when the activity scene mounts and vice versa — they never share GPU resources. See `ARCHITECTURE.md §4` for the server-side sim services that drive them.

### 10a. Bumper Shells (`apps/web/src/lib/three/activities/bumper-shells/`)

| File | Purpose |
|---|---|
| `BumperShellsScene.tsx` | Top-level R3F scene — arena floor, walls, lights, post-process. |
| `BumperShellsPlayer.tsx` | Per-player GLB shell. Still uses `anchorInFrontOfCamera` for camera-cull on its name label (the only remaining consumer of `apps/web/src/lib/three/utils/camera-cull.ts`). |
| `bumper-shells-config.ts` | Visual constants — arena radius 500 wu, knockback FX timings, power-up icon paths. |

### 10b. Reef Race (`apps/web/src/lib/three/activities/reef-race/`)

| File | Purpose |
|---|---|
| `ReefRaceScene.tsx` | Top-level scene — river, sky, cliffs, ramps. |
| `ReefRacePlayer.tsx` | Per-player shell on the bespoke oval. |
| `ReefRaceTrack.tsx` / `ReefRaceCheckpoints.tsx` / `ramps.tsx` / `river-scene.tsx` / `rocky-cliffs.tsx` | Track geometry built procedurally from `reef-race-config` shared constants (`REEF_TRACK_A = 1100`, `REEF_TRACK_B = 700`, `REEF_CHECKPOINT_COUNT = 12`). |

All scenery GLBs (`reef-race/scenery/cliff-rock-{1,2,3}.glb`, `prop-fence.glb`, `prop-rock-{1,2,3}.glb`, `prop-tree-{leafy,pine}.glb`) use meshopt + Draco compression.

### 10c. Casino Interior (`apps/web/src/app/casino/`, Concern 6.0.2)

Route-isolated scene at `/casino`. Canvas `key="casino-interior"` tears down the WebGPU context cleanly on exit.

| File | Purpose |
|---|---|
| `apps/web/src/app/casino/page.tsx` | Next.js route. Dynamically imports `CasinoCanvas` with `ssr:false`. Back to World button uses `triggerTransition({ to: '/game', onMidway })` — mid-fade repositions avatar to casino door `(2000, 5760)` (corrected from 940 — now east-side entrance, not back wall). `<SceneTransition fadeInOnMount />` fades in from black on arrival. Bottom branding label. |
| `apps/web/src/components/transitions/SceneTransition.tsx` | Generic rAF-based fade overlay (Concern 6.0.3). `TRANSITION_FADE_MS=500ms`. `useTransitionStore` (Zustand) exposes `triggerTransition({ to, onMidway? })`. `fadeInOnMount` prop: destination pages start fully black and fade to transparent after first rAF tick. zIndex 9999, `pointerEvents: 'none'` while transparent. |
| `apps/web/src/components/three/CasinoCanvas.tsx` | Route-isolated `<Canvas>`. DPR cap mirrors World3DCanvas (`[0.55,0.7]` low-end, `[0.75,1]` otherwise). `PreCompilePipelines` fires `compileAsync` after first R3F commit. `SceneBackground` sets `scene.background = #0a0015`. Camera initial position `[0, 55, 400]` — behind player spawn, follow-cam overrides on frame 1. |
| `apps/web/src/lib/three/casino-interior.tsx` | Scene component + walkable player system. Loads `casino-interior.glb` (gameready, Draco, ~211k tris, 4.2MB). Auto-falls back to `casino-interior-fallback.glb` (cartoon, 58KB) if avg FPS < 40 in first 5s or `?fallback=1`. Box3 max(X,Y,Z) auto-fit to `INTERIOR_TARGET_HEIGHT=2000wu`. `CasinoPlayerAvatar` routes VRM/GLB based on `avatarModelKey`. WASD at 830wu/s, bounded to `x∈[-383,+383] z∈[-900,+900]`. Follow camera: +190wu above, +450wu behind, exp-decay lerp, `CAM_LOOK_Y=70wu`. `CASINO_VRM_TARGET_HEIGHT=160wu` (cabinet tops 159wu reach avatar forehead — Vegas tall-cabinet feel; avatar/ceiling = 160/400 = 40%). 4 primitive slot cabinets on left wall (x≈-383). `SlotHotspot` on each cabinet face → `useCasinoStore.openSlotScreen`. Module-scope `_casinoCamYaw` reset to π on mount in both VRM + GLB branches (prevents catch-up swing on re-entry). |
| `apps/web/src/components/three/CasinoLighting.tsx` | Neon lighting: ambientLight `#1a0a2e` (6.0), hemisphereLight sky `#4a3a7a` / ground `#6a4a3a` (2.5), 3 point lights (cyan left + magenta right + cyan top). Total 5 light objects — under 7-light Iris Xe context-loss threshold. All `castShadow={false}`. |

**Assets:** `/models/casino/casino-interior.glb` (Draco, 4.2MB, ~211k tris) · `/models/casino/casino-interior-fallback.glb` (no Draco, 58KB, 449 tris, CC-BY-4.0). Draco decoder: Google CDN `https://www.gstatic.com/draco/versioned/decoders/1.5.6/`.

**Iris Xe invariants:** no shadows, no drei Text/Billboard, no InstancedMesh+ShaderMaterial, no per-frame `new Vector3()`, `matrixAutoUpdate=false` on all static meshes after first placement.

**Player spawn:** `(0, 0, 240)` — near front entrance wall (+Z side), facing −Z into the room (rotation π). WASD key state is module-scope (`casinoKeys`) separate from world canvas to avoid cross-canvas contamination.

**Slot cabinets (Concern 6.0.5, updated 2026-05-18 bug-fix):** 4 cabinets at x=−383wu (=−BOUNDS_X), z ≈ −583 / −333 / −83 / +166wu (room-scaled). Each = base (world-scale 16wu tall) + body (world-scale 143wu tall, dark purple) + emissive screen (79wu tall, cyan, emissiveIntensity 1.2) + lever (CylGeo r8 h56wu, red). Width/depth room-scaled (×3.333). Cabinet top = 16+143 = 159wu = 59% of 270wu avatar → chest height. All geometry module-scope. Rotated π/2 (face into room). `matrixAutoUpdate=false`. Draw calls: 16 (4 cabs × 4 meshes).

**Casino input (updated 2026-05-19):**
- **WASD** — avatar movement only (`casinoKeys` w/a/s/d). Single-char guard: `e.key.length === 1 ? e.key.toLowerCase() : null`.
- **Arrow keys** — camera perspective-orbit ONLY; avatar never rotates from arrows (mirrors world `ArrowKeyRotationController`). Implemented via separate `_casinoArrowKeys` + `attachCasinoArrowListeners()`. `ArrowLeft/Right` → horizontal orbit yaw accumulates at `ARROW_YAW_SPEED=1.5 rad/s` (added to `_casinoCamYaw` as `_casinoArrowYawOffset`). `ArrowUp/Down` → camera height offset accumulates at `ARROW_PITCH_SPEED=200 wu/s`, clamped to `[-100, +400]` wu relative to `CAM_ABOVE=190`.
- **Avatar yaw lerp** — `0.08` (was 0.15). At 60fps spreads a 90° turn over ~35 frames (0.58s); prevents visible per-frame snap on A/D press.
- **Camera AABB clamp** — `clampCameraToRoom(_camDesiredPos, CASINO_ROOM_BOUNDS)` applied every frame before position lerp. `CASINO_ROOM_BOUNDS = { halfX:383, zMin:-900, zMax:900, yMin:30, yMax:600, margin:50 }`. Prevents camera clipping outside room walls (black void). Implemented in `apps/web/src/lib/three/room-camera.ts` (reusable utility).

**Casino camera (bug-fix 2026-05-18, updated pass 2):** Module-scope `_casinoCamYaw` (init π, reset to π on mount in both branches) lerps toward avatar `rotRef.current` at `CAM_YAW_LERP=0.05` (vs avatar turn rate 0.15). Both VRM (`CasinoVRMAvatarInner`) and GLB (`CasinoGLBAvatarInner`) branches use `_casinoCamYaw` for behind-position, not the avatar's live yaw — prevents 45° viewport snap on A/D press. `CAM_ABOVE=190wu CAM_BEHIND=450wu CAM_LOOK_Y=70wu` (recomputed proportionally for 160wu avatar: ×1.19 above, ×2.81 behind, ×0.44 look).

**Hotspots:** `GAMEREADY_HOTSPOTS` — 4 invisible boxes at cabinet faces (x=−90, y=37). Click → `openSlotScreen('classic-3x5', 'classic-3x5', avatar.clawTokens)`. `FALLBACK_HOTSPOTS` — 2 boxes at room center for cartoon GLB path.

**Camera:** Canvas fov 65, near 1, far 2000, initial position `[0, 55, 400]`. Follow-cam steady state: 55wu above, 160wu behind avatar. Interior fog: `0x0a0015`, near 400, far 1200. Camera frozen during slot modal (`slotScreenOpen === true`).

**Exit position:** `CASINO_EXIT_PX = (2000, 5760)`. Math: slot 9 W → cx=50 tiles → worldX=−4160wu; exit = −3760wu = game-px x=2000.

**Navigation hook (Concern 6.0.3):** `arena-buildings.tsx` casino onClick calls `triggerCasinoWalkIn()` — a module-scope function (not a hook; uses Zustand `.getState()` directly). In `'player'` / `'npc'` / `'autonomous'` modes: sets a two-point `clickPath` to `CASINO_DOOR_PX = (940, 5760)`, polls `avatarPositionRef` via rAF until within `200wu` or `1500ms` elapsed, then fires `useTransitionStore.triggerTransition({ to: '/casino' })`. In `'explore'` mode: skips walk, fires transition immediately.

**Spawn fix (Concern 6.0.3):** `avatarPositionRef` and `avatarPosition` initial/reset values updated to `(5760, 6140)` — Phase 6.2 world center (5760, 5760) + 380 game-px south offset.

**Out of scope (Concern 6.0.2):** ~~walk-in animation (6.0.3)~~ (shipped), 2D slot screen (6.0.4), backend RNG/wager program (6.1+).

---

## 11. Agent picker scene (`apps/web/src/components/three/SelectAgentCanvas.tsx`)

Replaces `LandingScene` on `/create-agent`. Never run simultaneously on Iris Xe.

| Constraint | Implementation |
|---|---|
| **No `three/webgpu` import, no TSL** | This file uses classic WebGLRenderer-friendly Three. Loading `three/webgpu` would conflict with the open-world Canvas's WebGPU init. |
| Warm-preload all 15 avatars at mount | 7 sea-creature GLBs via `useGLTF.preload`, 8 Milady VRMs via `preloadVRM`. |
| Color-tint only on GLBs | VRMs use MToon pipeline unchanged — `.clone()` breaks toon uniform system. |
| Rotating pedestal | Single `useFrame` rotates a parent group; avatars are children. |
| Camera | Static orthographic. |

---

## 12. Cosmetic render pipeline (Phase 3.3 — 2026-04-28)

`apps/web/src/lib/three/cosmetics/`. Equipment slots that overlay on the player avatar:

| Category | Strategy |
|---|---|
| `hat` | Attached to a head bone (lookup priority: `Head` → `mixamorig:Head` → `head` → `J_Bip_C_Head`). Position offset baked into the asset. |
| `aura` | Particle-emitting GLB attached to the root, not a bone. |
| `trail` | Procedural strip mesh updated each frame from avatar position. |
| `skin` | Material swap on the avatar's primary mesh. |

Component contract: each cosmetic exports `{ Component, slot, supportsContext }`. `supportsContext({ where: 'world' \| 'picker' \| 'activity', mode })` returns boolean so the same cosmetic asset can self-gate based on render context.

Draw-call budget (full equipped set): hat ≤ 1, aura ≤ 4 (instanced particles via MeshBasicMaterial — safe), trail ≤ 1, skin = 0 (material swap, not extra mesh).

---

## 13. Recent material changes

Compact log. Single line per change with commit reference where applicable.

- 2026-05-19 — World colliders: new `collision/world-colliders.ts` (19 disc colliders — 12 buildings ≈190wu + 7 town-center props 50–220wu). `clampMovement2D` radial push-out with slide-along-wall feel + escape hatch for inside-collider spawn. Integrated into player-avatar.tsx (VRM+GLB branches) + arena-npcs.tsx (GLBNpcMesh+VRMNpcMesh useFrame) + arena-location-npcs.tsx (spawn-time sanity push-out). Zero per-frame allocations (module-scope scratch). scaleFactor=0.85. §2h added.
- 2026-05-18 — Phase 6.2.2: MAX_FOOTPRINT 1800→2000wu; node name bug fixed (`The_Krusty_Krab`/`Squidward_s_House` → literal `"The Krusty Krab"`/`"Squidward's House"` — Three.js GLTFLoader preserves verbatim names); targetMaxDim bumps: messaging-channels 1000→2500, api-integrations 1300→2500, cron-automation 1300→2200, memory-rag 1400→1700; memory-rag childScale 1.4→1.7. Sandy NPC T-pose: `extendLoaderWithMeshopt` added to useGLTF + preloads; `clipAction(idleClip, cloned)` with explicit optionalRoot; `reset().setLoop(LoopRepeat).play()` chain. §2 slot table + footprint cap + childScaleOverrides doc + bodyAnchorChild doc updated.
- 2026-05-18 — Bio-luminescent label system: Fraunces capsule + dashed-cyan tether + pulsing anchor dot on all NPC/building labels. `fadeBaseOpacity` 0.65 → 0.85 for NPC labels. Two CSS keyframes in `globals.css`. `--font-fraunces` in `layout.tsx`. §5d WorldLabelsOverlay row updated.
- 2026-05-18 — `childScaleOverrides` differential scaling: Squidward house head ×1.4, Krusty Krab restaurant ×1.5; stepping stones/sign remain at base scale. Both buildings targetMaxDim 1000→1400. `applyChildScaleOverrides()` added to `arena-buildings.tsx`; runs post-strip, pre-merge so scales bake into vertex positions.
- 2026-05-18 — Phase 6.2: grid 240→360 (MAP_WIDTH 7680→11520wu), ring R=100→160 (3200→5120wu), center tile (120,120)→(180,180). `computeBuildingScale` max(X,Y,Z) normalization via `targetMaxDim`. NPC_INSET_WORLD 1000→1300wu (Patrick's Rock clearance). Sandy Treedome DoubleSide transparent-mat fix. DECO_INNER_EXCLUSION_R 1500→800wu. Town-center props spread to 800–1000wu radius. pathfinding COLS/ROWS, npc-simulation ranges, NPC home coords, all 12 building zones, map-locations positionX/Y updated.
- 2026-05-18 — World-space DOM label redesign: pill backgrounds removed; NPC/teacher labels = 10px uppercase wordmark, opacity 0.65→0 over 800–3000wu, 10 Hz occluder raycast; building labels = 11px italic cyan wordmark, opacity 0.40→0 over 2000–5000wu, CSS hover → 1.0; OpenClaw chip → 7px green dot. `LabelEntry` + `UseWorldLabelOpts` extended; `3dStructure.md` §5d updated.
- 2026-05-18 `b1c36b3` — Concern 6.0.5: Walkable casino interior. `casino-interior.tsx` fully rewritten with `CasinoPlayerAvatar` (VRM+GLB routing), module-scope `casinoKeys` WASD state, follow camera (+55wu above, +160wu behind, exp-decay lerp), 4 primitive slot cabinets (x=−115, module-scope BoxGeometry+CylinderGeometry, matrixAutoUpdate=false), hotspots moved onto cabinet faces. `casino/page.tsx` `CASINO_EXIT_PX` corrected to `(2000, 5760)` (was 940 — wrong side). `CasinoCanvas.tsx` initial camera `[0,80,250]→[0,55,400]`. §10c updated.
- 2026-05-18 — Concern 6.0.3: Walk-in animation + SceneTransition pattern. New `SceneTransition.tsx` (generic rAF fade, `useTransitionStore`, `fadeInOnMount`). `triggerCasinoWalkIn()` in `arena-buildings.tsx` replaces bare `window.location.href`. `casino/page.tsx` walk-out uses `triggerTransition` + mid-fade avatar reposition to `(940, 5760)`. `game/page.tsx` mounts `<SceneTransition />`. `avatarPositionRef` spawn coords updated to `(5760, 6140)` (Phase 6.2 center).
- 2026-05-18 — Concern 6.0.2: `/casino` route + casino interior scene. New §10c. 4 new files (`casino/page.tsx`, `CasinoCanvas.tsx`, `casino-interior.tsx`, `CasinoLighting.tsx`). Gameready + fallback GLB auto-fit to 600wu. FPS-fallback (< 40 avg over 5s). Invisible slot hotspots. Casino onClick in `arena-buildings.tsx` wired to `window.location.href = '/casino'` (superseded by 6.0.3).
- 2026-05-17 — Circle revert: `tilemap-data.ts` buildingZones already circular (fixed); `map-locations.ts` fully rewritten to circular positions; `arena-buildings.tsx` BUILDING_MODELS completely reordered with new rotY values for each slot, `computeBuildingScale` gains optional `targetHeight` param, casino gets `targetHeight=1040` (+30%); `minimap.tsx` ring-guide comment corrected; `npc-definitions.ts` wanderer homeX/homeY updated for new ring (patrolRadius 700→500); §2 slot table rewritten as 12-slot circle; §2 note added explaining R=90 tile constraint.
- 2026-05-17 — Entertainment-district swap: `claw-arcade` → E3, `app-publishing` → S3. `tilemap-data.ts` zone ids swapped; `map-locations.ts` positionX/Y swapped; `arena-buildings.tsx` rotY updated; §2 slot table updated.
- 2026-05-17 — Phase 6.0.1: `tilemap-data.ts` buildingZones expanded from 10 circular → 12 square ring; `map-locations.ts` and `building-types.ts` updated; `arena-buildings.tsx` BUILDING_MODELS adds casino + claw-arcade; `minimap.tsx` accent colors + ring guide radius updated; §2 rewritten.
- 2026-05-12 — dead-code cleanup in `arena-npcs.tsx` — removed unused `NPC_CULL_DIST_SQ` / `VRM_NPC_HALF_RATE_DIST_SQ` / `VRM_NPC_CULL_DIST_SQ` constants and the entire `checkLabelOcclusion` / `buildOccluderList` / `invalidateOccluderCache` infra block (5 module-scope variables + 3 functions, all orphaned by the 2026-05-11 culling removal). Also flattened a duplicated spring-throttle comment block. No behavior change.
- 2026-05-12 — `ed1f4a0` / `2728ac6` — Sandy's Treedome swap to `sandy_tree_final.glb` after measuring every candidate via `scripts/read-glb-bbox.mjs`. Vertex-count strip rule attempted then reverted (Object_5 was the building, not a backdrop).
- 2026-05-12 — `3b9d64b` / `c3934a1` — `Skybox_`-prefix mesh-name strip added to `stripDecorativeMeshes` (the actual blue-dome backdrop in Yanez Designs Sketchfab GLBs).
- 2026-05-12 — `9cdaeee` — Krusty Krab + Chum Bucket restored from original Sketchfab GLBs (the Apr-30 meshopt re-compression had degraded geometry). Renamed `-v2.glb` to bust the 1-year browser cache.
- 2026-05-11 — `99afa00` — DPR cap drops to `[0.55, 0.7]` on integrated GPUs / touch devices via `LOW_END_GPU_DETECTED`.
- 2026-05-11 — `93308a9` — PerfHud counter bugs fixed: `pipes` was reading paths that don't exist on WebGPURenderer (real path: `renderer._pipelines.caches.size`); `draws` was reading `info.render.calls` (cumulative) instead of `info.render.drawCalls` (per-frame). VRM spring throttle dropped to uniform 15 Hz.
- 2026-05-11 — `aeb0c98` / `ec9b55c` — All NPC distance/behind-camera/occlusion culling removed (user directive). NPC position mutated in place on stable refs so React never reconciles walking-NPC updates.
- 2026-05-10 — `89714b5` — `WorldLabelsOverlay` single-root architecture replaces 30+ drei `<Html>` portals. ResizeObserver-cached canvas size kills the per-frame `getBoundingClientRect` forced reflow.
- 2026-05-10 — `b51c8fd` — Sandy treedome low-poly swap attempted (commit message said 4 k tris but file actually contained a 1.1 M-tri inner mesh).
- 2026-04-24 — Phase A+B VRM perf fixes: B9 half-rate gate removed, B1 MToon outlines off, B3 `removeUnnecessaryJoints`, B4 `lookAt`/`expressionManager` disabled on wanderers, B2 `skeleton.update` batching, A1 perf-hud pipeline count.
- 2026-04-23 — Decoration geometry merge with 3×3 spatial chunking: ~3000 draws → ~60-90 merged meshes. Throttled idle animation to 20 Hz, VRM spring physics to tiered 15/30 Hz.
- 2026-04-21 — Two-axis pivot system (`pivotOffsetX/Y/Z`) — fixes rotation-shifted building placement (downtown-building.glb at rotY=-1.882 was landing 4856 wu east of target). Charge-and-release jump rewrite.
- 2026-04-21 — Perf sweep over all 14 `lib/three/*` files (`matrixAutoUpdate=false` on static meshes, vector pool recycling, scratch-object hoisting). Est. 4-6 ms/frame saved.
- 2026-04-16 — Building ring expanded 56 → 68 tiles to eliminate overlap. Building target height switched from `max(w,h,d)` → Y-height normalization. `MAX_FOOTPRINT` 1400 → 1000.
- 2026-05-13 — Building ring expanded 68 → 72 tiles (R=2176 → 2304 wu) for inner-band breathing room post decoration retune. All 10 zone coords recomputed in `tilemap-data.ts`.
- 2026-04-10 — Ultrathink decommission: `plugin-anthropic` + `plugin-openai` removed. Gemini providers only.

Older history: `git log apps/web/src/lib/three/ apps/web/src/components/three/`.
