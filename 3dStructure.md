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

**Last edit:** 2026-05-12 — restructured into a tight manifest (was 2430 lines / 200 KB with 14 stacked audit entries). Content unchanged except for the recap log; this is purely a readability + binding pass.

---

## 1. World dimensions & coordinate system

Source: `apps/web/src/lib/pixi/tilemap-data.ts:6-10`

| Constant | Value |
|---|---|
| `TILE_SIZE` | 32 px |
| `MAP_COLS`, `MAP_ROWS` | 160 |
| `MAP_WIDTH`, `MAP_HEIGHT` | 5120 wu (= 160 × 32) |
| `HALF_W`, `HALF_H` | 2560 wu |

**Game-space → 3D world:**
- Game-space (2D pixel plane): `(0..5120, 0..5120)` — origin top-left, +x right, +y down.
- Three.js world (XZ plane): `(-2560..+2560, -2560..+2560)` — origin center.
- Conversion: `worldX = gameX - HALF_W; worldZ = gameY - HALF_H` (`World3DCanvas.tsx:291-293`, `player-avatar.tsx:84-86`, `arena-npcs.tsx:31-33`).
- Village center tile `(80, 80)` → world `(0, 0)`.

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

**Ring geometry:**
- Radius: **2304 wu** (= 72 tiles × 32). Expanded 56→68 tiles 2026-04-16 (eliminate building overlap) then 68→72 tiles 2026-05-13 (give inner band breathing room after decoration retune). Practical max — R=73 puts deployment-ops zone end at row 160 (off-map).
- Angular spacing 36° (π/5). Start angle −π/2 (north). 10 slots, clockwise.
- Position formula: `cx = round(80 + 68·cos(θ_i))`, `cy = round(80 + 68·sin(θ_i))` where `θ_i = −π/2 + i·(π/5)`.
- Zone footprint: 14×14 tiles = 448×448 wu. Upper-left = `(cx−7, cy−7)`.

**Building height target:** `BUILDING_TARGET_HEIGHT = 800 wu` (`arena-buildings.tsx:44`). Each GLB is measured and scaled so its **Y-height** = 800. Changed from `max(w,h,d)` normalization 2026-04-16 — wide/squat buildings had their width > height under the old approach.

**Footprint cap:** `MAX_FOOTPRINT = 1000 wu`. If post-scale `max(sx, sz) > 1000`, scale is reduced. Tightened from 1400→1000 same date.

**Pivot correction (rotation-aware):** `computeBuildingScale()` returns `{ scale, pivotOffsetX, pivotOffsetY, pivotOffsetZ }` where `pivotOffsetX/Z = bbox_center_XZ * scale` and `pivotOffsetY = bbox.min.y * scale`. Applied via a nested inner group inside the rotating outer group:

```
outer group:  position=(cx, -2 + yOffset, cz), rotation=(0, rotY, 0)
  inner group: position=(-pivotOffsetX, -pivotOffsetY, -pivotOffsetZ)
    primitive (GLB scene)
```

XZ correction rotates with the geometry because the inner group lives in the outer's local frame. Y correction grounds the geometry floor at `y = -2` for all three authoring cases (`bbox.min.y` positive, zero, or negative).

**Strip rules** (run in order on every cloned scene):
1. `stripDecorativeMeshes(c)` — mesh-name prefix `Skybox_` AND parent-name match `{Flowers, Path, Skybox, Road, Sand}` + exact-name `BACKDROP_KILL_NAMES` set + material-name `BACKDROP_KILL_MATERIALS` set. Both kill sets currently empty.
2. `stripGroundPlanes(c)` — flat-and-at-bottom geometric test (sy/maxXZ < 0.005 AND bb.max.y < fullMinY + 5%·fullHeight).

`mergeStaticMeshesByMaterial(c)` runs after the strips — buckets same-material submeshes within each building and collapses to one mesh per bucket (`apps/web/src/lib/three/utils/merge-static-meshes.ts`).

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

**Canvas initial camera:** `fov=50, near=1, far=6800`, `position = mode==='game' ? [0, 600, 1300] : [0, 560, 1000]`.

**DPR cap:** `dpr={LOW_END_GPU_DETECTED ? [0.55, 0.7] : [0.75, 1]}`. `LOW_END_GPU_DETECTED` is computed once at module load via `WEBGL_debug_renderer_info` — Intel/Iris/UHD/Adreno/Mali/PowerVR/Apple-integrated + `pointer:coarse` mobile. Do NOT call `gl.setPixelRatio()` inside `onCreated` — that overrides the prop and was reverted 2026-04-21.

---

## 4. Lighting + atmosphere

Hard cap: **3 lights** on Iris Xe (uniform limit + shader compile cost).

| Light | Args | Notes |
|---|---|---|
| `hemisphereLight` | `0x66bbdd, 0x223344, intensity 1.8` | Warm sky / cool ground fill. Replaces a separate ambient — no `<ambientLight>`. |
| `directionalLight` (key) | `position [150, 350, 80], intensity 2.0, color 0xffeedd` | Warm key light from upper-right. |
| `directionalLight` (fill) | `position [-100, 200, -60], intensity 0.5, color 0x88aacc` | Cool fill from opposite side for depth. |

**Fog:** `fog(FOG_COLOR, 1200, 6400)` (`World3DCanvas.tsx:789`). Calibrated for Iris Xe — pushing far past 6400 wastes GPU on fragments the camera-far (6800) is about to clip anyway. `WorldContent.md §5 MAX_VISIBLE_DIST=3800` rejects decoration placements past the perceptual fog cutoff so we don't ship invisible draws (cut from 4500 on 2026-05-13).

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
| WorldLabelsOverlay projection | Full 60 Hz, single root, ResizeObserver-cached canvas size (kills the per-frame `getBoundingClientRect` forced reflow). | `world-labels-overlay.tsx` |
| Texture upload | `requestIdleCallback` with 6 ms time budget per slice. 98 textures via rIC = ~352 ms total (down from 8 s rAF-based). | `World3DCanvas.tsx:StaggeredTextureUpload` |

### 5e. Static meshes — `matrixAutoUpdate = false`

Set during clone for every static object so `updateMatrixWorld` skips them:
- All 10 buildings + their cloned children (`arena-buildings.tsx`)
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

XZ lerp: `LERP_SPEED = 1.5` → `1 - exp(-1.5·dt)` (`arena-npcs.tsx:44`). Server-driven positions at 5 Hz; client smooths.

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

---

## 7. Terrain shader

`apps/web/src/lib/three/arena-terrain.tsx:SandFloor()`.

| Spec | Value |
|---|---|
| Plane size | `MAP_WIDTH × 3` × `MAP_HEIGHT × 3` = 15360 × 15360 wu |
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
