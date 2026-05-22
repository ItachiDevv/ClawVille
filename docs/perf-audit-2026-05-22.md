# ClawVille 3D Performance Audit — 2026-05-22

**Auditor:** 3DA (team manager) — static analysis only, no runtime profiling  
**Baseline:** Intel Iris Xe, 40–45 FPS sustained, target 80 FPS (floor 60 under load)  
**Scope:** World3DCanvas open-world scene + loading pipeline  
**Constraints honoured:** no source edits during audit, no `bun run dev`, no web research

---

## Section A — Stack Inventory

### Renderer

| Item | Value | Source |
|---|---|---|
| Three.js build | `three/webgpu` r182 | `World3DCanvas.tsx:6` |
| Renderer type | `WebGPURenderer` on capable GPUs; WebGL2 fallback | `World3DCanvas.tsx:966–976` |
| `FORCE_WEBGL` path | `IOS_SAFARI \|\| WEBGPU_ABSENT \|\| LOW_END_GPU_DETECTED` | `World3DCanvas.tsx:909–915` |
| `LOW_END_GPU_DETECTED` probe | Synchronous `WEBGL_debug_renderer_info` read at module scope | `World3DCanvas.tsx:73–100` |
| Iris Xe routing | `LOW_END_GPU_DETECTED=true` → `FORCE_WEBGL=true` → WebGL2 path | confirmed by probe logic |
| R3F frameloop | `"always"` — renders every rAF tick unconditionally | `World3DCanvas.tsx` (Canvas props) |
| Antialias | `false` | `World3DCanvas.tsx:966` |
| DPR cap (low-end) | `[0.55, 0.7]` | `World3DCanvas.tsx` (DPR block) |
| DPR cap (dedicated) | `[0.75, 1.0]` | same |
| Shader language | TSL (Three.js Shading Language) node materials; WGSL on WebGPU path | `arena-terrain.tsx:5–11` |

### Scene mount order (`SceneContents` — `World3DCanvas.tsx:676–833`)

PreCompilePipelines → StaggeredTextureUpload → KTX2LoaderSetup → MeshoptLoaderSetup → JumpTicker → WorldLabelsOverlayMount → camera controllers (OrbitControls / WASDCameraController / FPSFollowCamera / ArrowKeyRotationController) → 3 lights → fog → ArenaTerrain → ArenaBuildings → ArenaNpcs → ArenaLocationNpcs → MergedSeaweed (gated `!FORCE_WEBGL`) → NpcController → MinimapPositionTracker → QuestNpc → TownGuide → BazaarStall → MarketplaceStall → AuctionPodium → QuestBountyPavilion → TownDirectorySign → NpcSpeechBubbles → ActivityIndicators → FloatingTexts3D → ClickToMove → PlayerAvatar

### Camera

| Item | Value | Source |
|---|---|---|
| fov | 50 | `3dStructure.md §3` |
| near | 1 | same |
| far | 16 000 wu | same |
| Controllers active simultaneously | Up to 4 (WASD + FPS follow + Orbit + ArrowKey) | `World3DCanvas.tsx:676–833` |

### Lighting

3 lights — at or near the Iris Xe practical limit of 3 before per-fragment cost becomes significant:

1. `hemisphereLight(0x66bbdd, 0x223344, 1.8)` — `World3DCanvas.tsx:759`
2. `directionalLight(0xfff5dd, 2.0)` — `World3DCanvas.tsx:760`
3. `directionalLight(0xaaccff, 0.5)` — `World3DCanvas.tsx:761`

No shadow maps. Correct.

### Fog

`THREE.Fog` — near=6000, far=15000, camera.far=16000 (`World3DCanvas.tsx:777`). The 1000 wu gap between fog.far (15000) and camera.far (16000) means a thin band of fully-opaque-fog geometry still gets vertex-processed and rasterised before the depth clip discards it. Not a large cost but zero benefit.

---

## Section B — Asset Inventory

### Building GLBs (12 active, from `asset-preload-manifest.ts:85–98`)

| GLB | Size (bytes) |
|---|---|
| quest-bounty-pavilion.glb | 9 105 716 |
| sandy-treedome-v3.glb | 4 373 340 |
| squidward-house.glb | 3 931 260 |
| patricks-rock-v2.glb | 3 888 404 |
| sandy-treedome-v2.glb | 3 557 256 (inactive — v3 supersedes) |
| bazaar-merchant-stand.glb | 2 451 184 |
| chum-bucket-v2.glb | 1 845 924 |
| shisha-oasis.glb | 1 609 128 |
| krusty-krab-v2.glb | 1 587 808 |
| pineapple-house.glb | 556 860 |
| patty-building.glb | 506 364 |
| salty-spitoon.glb | 386 308 |
| boating-school.glb | 188 868 |
| building-lighthouse.glb | 59 148 |

**Dominant outlier:** `quest-bounty-pavilion.glb` at 8.7 MB — 2× the second-largest building. This is the single biggest uncompressed network payload for the scene. KTX2/meshopt compression status unknown without a hex-dump; if the embedded textures are raw PNG/JPG rather than Basis/KTX2 this is likely 60–80% compressible.

**Stale asset:** `sandy-treedome-v2.glb` (3.4 MB) still exists on disk. Verify it is not referenced anywhere — if unused it wastes 3.4 MB of build artifact.

### Wandering NPC GLBs (8 species)

| GLB | Size (bytes) |
|---|---|
| lobster_plush.glb | 570 200 |
| sweet_crab_sketchfabweekly.glb | 383 800 |
| hermitcrab.glb | 214 104 |
| lobster.glb | 199 708 |
| sea_horse.glb | 179 316 |
| octopus_toy.glb | 158 840 |
| jellyfish.glb | 88 952 |
| crayfish.glb | 7 696 |

Small models, low priority for compression. Total: ~1.8 MB.

### VRM avatars (13 selectable + 6 wandering)

| VRM | Size (bytes) |
|---|---|
| milady-chibi.vrm | 5 843 140 |
| eliza-chibi.vrm | 5 547 172 |
| tekk.vrm | 2 045 416 |
| hermes-female.vrm | 1 701 640 |
| hermes-male.vrm | 1 346 296 |
| milady-official-5.vrm | 658 476 |
| milady-official-8.vrm | 335 104 |
| milady-official-4.vrm | 291 964 |
| milady-official-7.vrm | 288 688 |
| milady-official-1.vrm | 242 228 |
| milady-official-3.vrm | 239 636 |
| milady-official-6.vrm | 222 104 |
| milady-official-2.vrm | 170 344 |

**Chibi VRMs are outsized:** milady-chibi (5.6 MB) and eliza-chibi (5.3 MB) are 3–10× the size of standard Milady VRMs. Both embed high-resolution textures that almost certainly aren't KTX2/Basis compressed. These are in the player VRM pool — `preloadVRMBytes` fires fetches for them on every page load even for users who will never select a chibi. At 10.8 MB combined on first visit, they are the largest single-session VRM payload.

### Animation GLBs

| GLB | Size (bytes) |
|---|---|
| _emotes.glb | 2 313 172 |
| cheering.glb | 293 988 |
| wipeout.glb | 200 344 |
| idle.glb | 88 600 |
| run.glb | 92 192 |
| skateboarding.glb | 84 948 |
| walk.glb | 63 268 |

`_emotes.glb` at 2.2 MB is the third-largest single fetch behind the two chibi VRMs.

### Terrain decoration GLBs (12 models)

All small (97 KB down to 4 KB). Total: ~580 KB. Negligible. Correctly deferred to `DeferredTerrainPreloads`.

### Inactive / orphaned assets found on disk

- `sandy-treedome-v2.glb` (3.4 MB) — superseded by v3; verify no reference
- `guide-rigged.glb` (926 KB) — `guide.glb` is the active asset per BUILDING_MODELS; rigged variant may be unused
- `chum-bucket.glb` / `krusty-krab.glb` / `patricks-rock.glb` (v1 variants, 300–412 KB) — v2 variants active; verify no reference to v1
- `underwater-decorations.glb` (961 KB) — UnderwaterAtmosphere is disabled (`3dStructure.md` §disabled); verify not still referenced
- `shisha-oasis.glb` (1.6 MB) — not present in `BUILDING_GLBS` in `asset-preload-manifest.ts` or `3dStructure.md` building roster; likely orphaned

---

## Section C — Per-frame Allocation Audit

### Confirmed zero-allocation scratch objects (module scope)

**`World3DCanvas.tsx:141–152`** — 7 module-scope scratch vectors used by camera controllers:
`_offset`, `_spherical`, `_followTarget`, `_wasdForward`, `_wasdRight`, `_wasdFlatForward`, `_wasdWorldUp`

**`arena-npcs.tsx:121–123`** — `_npcBbox`, `_npcMeshBbox` (Box3), `_raycaster`, `_rayOrigin`, `_rayDir` — module-scope, never inside useFrame

**`player-avatar.tsx:212–221`** — `_playerCamForward`, `_playerCamRight`, `_playerWorldUp` (Vector3), `_avatarRaycaster`, `_avatarRayOrigin`, `_avatarRayDir` — module-scope

### Confirmed allocations INSIDE useFrame (bugs)

**`arena-npcs.tsx:191`** — `new THREE.Box3().setFromObject(scene)` — this is inside a useMemo dependency (not useFrame directly) but IS called at mount and on every `scene` change. Acceptable if `scene` is stable (it is, per Suspense cache).

**`arena-npcs.tsx:463`** — `new THREE.Color(npc.color)` — inside a `useEffect` keyed on `[npc.color]`. Not a per-frame allocation. Acceptable.

**`player-avatar.tsx:717`** — `new THREE.Color(COLOR_TINTS[avatarColor] ?? 0xffffff)` — inside a `useMemo` keyed on `[avatarColor]`. Not a per-frame allocation. Acceptable.

**`arena-npcs.tsx:442`** — `useRef(new THREE.Vector3(...mapToWorld(npc.x, npc.y)))` — `useRef` initial value only evaluated once. Not a per-frame allocation.

**`arena-npcs.tsx:904`** — same pattern for VRM NPC simPos. Not a per-frame allocation.

### Per-frame allocation verdict

**No `new THREE.*` allocations detected inside useFrame bodies.** Module-scope scratch pattern is correctly applied throughout. The GC thrash invariant is honoured.

### Zustand store read inside useFrame (hot path overhead)

Both `GLBNpcMesh.useFrame` (`arena-npcs.tsx:611–613`) and `VRMNpcMesh.useFrame` (`arena-npcs.tsx:1024–1026`) call `useGameStore.getState()` on every frame to read `controlMode`. With 10–20 active NPC instances this is 10–20 synchronous Zustand `.getState()` calls per frame. Zustand `.getState()` is O(1) and returns a cached reference — negligible per call, but if each NPC does it independently the pattern scales linearly with NPC count. At 20 NPCs = 20 calls/frame = 1200 calls/second. Not currently a bottleneck but worth noting.

---

## Section D — Draw Call Inventory (estimated)

Draw calls are estimated from geometry topology. A PerfHUD runtime read is needed for exact numbers (`gl.info.render.drawCalls` as documented in `3dStructure.md §5b`).

### Buildings (ArenaBuildings)

`mergeStaticMeshesByMaterial()` is applied at load (`arena-buildings.tsx`). This batches submeshes of each building by material, so a building with 3 materials becomes 3 draw calls instead of N-submesh calls. Estimated draw calls after merge: **~24–36** (12 buildings × avg 2–3 materials each). Each building is a separate merged object — 12 separate Three.js Objects remain in the scene graph even if their submeshes are merged.

Pedestals: not instanced. Each building has a pedestal mesh as a separate `<mesh>` — adding 12 more draw calls for what is geometrically identical geometry sharing a single material. Using `InstancedMesh` for pedestals would collapse these 12 calls to 1. `MeshStandardMaterial` (used by pedestals) is safe with InstancedMesh on WebGPU path.

### Wandering NPCs (ArenaGLBNpcs + ArenaVRMNpcs)

GLB NPCs: 8 species × up to 5 instances each = up to 40 GLB NPC instances. Each GLB NPC is a cloned scene — cloning does NOT share draw calls (each clone is a separate Object3D tree). Estimated: **~40–80 draw calls** depending on GLB complexity.

VRM NPCs: Up to 6 wandering VRM NPCs. Each VRM has 2–6 materials (body + hair + MToon outline per material group). MToon outline draw calls add 1 extra call per material group. Per VRM: estimated 4–8 draw calls. Total: **~24–48 draw calls**.

### Player Avatar

GLB path (lobster): 1–2 draw calls per the file comment (`player-avatar.tsx:44`).  
VRM path: 4–8 draw calls (same estimate as VRM NPCs).

### Location NPCs (ArenaLocationNpcs)

12 SpongeBob character GLBs. Characters are not merged — each is a separate GLTF scene load. Estimated: **~24–48 draw calls** (2–4 per character).

### Terrain

- Sand plane (`PlaneGeometry` 120×120 segments with TSL node material): **1 draw call**
- Decorations (`MergedDecorationsInner` — all 12 models merged into one geometry per the comment at `arena-terrain.tsx:542–563`): estimated **3–6 draw calls** after mergeGeometries (TSL multi-material)

### Other scene objects

- TownGuide, BazaarStall, MarketplaceStall, AuctionPodium, QuestBountyPavilion, TownDirectorySign: each is a loaded GLB, estimated 1–4 draw calls each → **~6–24 total**
- MergedSeaweed (DISABLED on `FORCE_WEBGL` path — Iris Xe): **0 draw calls on Iris Xe**
- ActivityIndicators (2 useFrame hooks, `activity-indicators.tsx:74,125`): lightweight mesh instances, ~2–4 draw calls
- FloatingTexts3D, ClickToMove, NpcSpeechBubbles: ~1–4 draw calls each

### Draw call total estimate (Iris Xe — WebGL2 path)

| Subsystem | Estimated draw calls |
|---|---|
| Buildings (merged) | 24–36 |
| Building pedestals (uninstanced) | 12 |
| Wandering GLB NPCs | 40–80 |
| Wandering VRM NPCs | 24–48 |
| Player avatar (VRM) | 4–8 |
| Location NPCs (SpongeBob) | 24–48 |
| Terrain sand + decorations | 4–7 |
| Town props (6 GLBs) | 6–24 |
| HUD meshes | 4–8 |
| **Total** | **142–271** |

This is very high for Iris Xe. The GPU's shared memory architecture becomes bandwidth-bound above ~80–100 draw calls in a frame at 60 Hz. A realistic target for 60+ FPS on Iris Xe is **50–80 draw calls max**.

---

## Section E — Top 10 Wins, Ranked by Estimated FPS Impact

### Win #1 — Call `preloadWorldAssets()` in `game/page.tsx` (loading screen fix)

**Impact: loading bar is live and fills during actual download; estimated TTI reduction 800–1500 ms**

Root cause: `World3DCanvas` is a `dynamic()` import with `ssr:false` (`game/page.tsx:74–78`). The `THREE.DefaultLoadingManager.onProgress` hook that writes `window.__W3D_PROGRESS` is module-scope inside `World3DCanvas.tsx:51–59` — it doesn't install until that chunk finishes downloading AND executing. Until then the loading bar shows 0% and appears frozen.

`preloadWorldAssets()` already exists and is comprehensive (`asset-preload-manifest.ts:228–274`). It has a `_preloadCalled` idempotency guard. It is **never called from `game/page.tsx`**.

Fix: add to `game/page.tsx` inside a `useEffect` that fires on first render (after the `mounted` gate at line 372):

```tsx
// At top of GamePage() component — after the useEffect(() => setMounted(true), [])
useEffect(() => {
  preloadWorldAssets();
}, []); // eslint-disable-line react-hooks/exhaustive-deps
```

With corresponding import at the top of the file:

```tsx
import { preloadWorldAssets } from '@/lib/three/asset-preload-manifest';
```

This must go in the first `useEffect` that fires (the `mounted` setter effect at line 195 fires on mount — add another `useEffect(() => { preloadWorldAssets(); }, [])` beside it). The browser will start fetching all tier-1 assets (12 building GLBs, 3 locomotion GLBs, 8 wandering NPC GLBs, 6 wandering VRM bytes) in parallel with the World3DCanvas chunk download, hiding the longest network legs.

**IMPORTANT:** `preloadWorldAssets()` calls `useGLTF.preload()` outside of a React component — this is legal via drei's module-level cache API and is already the pattern used by `arena-buildings.tsx:643`. The `_preloadCalled` guard in the function makes double-calling safe.

Note: The loading bar will now move because `DefaultLoadingManager.onProgress` fires as GLBs are fetched. However the bar fills from asset fetches started BEFORE the canvas installs its hook. This means progress events emitted before the hook installs are lost. Full fix requires also bridging `DefaultLoadingManager.onProgress` at the page level (or installing it in a separate module imported by both page and canvas), but that is an architecture change beyond audit scope. The current fix (preloading earlier) at minimum reduces the frozen-bar window from "entire loading screen duration" to "time to download World3DCanvas chunk" (~300–600 ms on fast connections).

### Win #2 — Instance building pedestals (12 → 1 draw call)

**Impact: -11 draw calls, ~5–8 FPS recovered on Iris Xe**

12 buildings each have an identical pedestal mesh rendered as a separate `<mesh>` with `MeshStandardMaterial`. These are geometrically identical (same geometry, same material) — a textbook case for `InstancedMesh`. `InstancedMesh + MeshStandardMaterial` is safe on WebGPU (only `ShaderMaterial` is the crash vector — `gotchas/webgpu-instancedmesh-shadermaterial.md`).

Confirm pedestal material and geometry are truly shared across all 12 before implementing. If pedestal geometry/material is per-building-type, LOD grouping by type (e.g. 2–3 pedestal variants instanced separately) still reduces from 12 to 2–3.

### Win #3 — NPC culling re-evaluation (comment at `arena-npcs.tsx:633–641`)

**Impact: depends on NPC count visible; potentially -20–40 draw calls when camera faces away**

All NPC culling was removed 2026-05-11 per user directive ("remove all the culling completely it ruins the game"). With culling disabled, every NPC is processed in every frame regardless of camera facing. On Iris Xe at DPR 0.55–0.7 this means rasterising NPCs behind the camera at full cost.

Frustum culling (Three.js built-in — sets `object.visible` based on `camera.frustum.intersectsObject()`) is distinct from the custom distance/occlusion culling that was removed. The comment at `arena-npcs.tsx:641` sets `group.visible = true` unconditionally — this BYPASSES Three.js's built-in frustum culler for NPCs.

A minimum-viable re-enable: remove the unconditional `group.visible = true` lines and let Three.js frustum-cull NPCs automatically. This does not re-introduce the per-NPC raycasting or distance-pop bugs the user objected to — it only gates rasterisation on basic camera frustum intersection, which is invisible to the user when NPCs are genuinely off-screen.

File locations: `arena-npcs.tsx:641` (GLB path), `arena-npcs.tsx:1049` (VRM path).

### Win #4 — `quest-bounty-pavilion.glb` texture compression

**Impact: -7 MB network payload, loading screen time reduction ~1–2 s on a 10 Mbps connection**

At 8.7 MB, `quest-bounty-pavilion.glb` is the single largest asset in the scene — larger than all 8 wandering NPC GLBs combined. If its embedded textures are uncompressed PNG/JPG, KTX2/Basis transcoding would compress them 70–80%, bringing the payload to ~2–3 MB. This requires running the asset through `gltf-transform` with `@gltf-transform/extensions` and the Basis CLI, then bumping the cache-bust query (`?v=N`) on every reference.

This is the highest-leverage single-asset compression opportunity.

### Win #5 — Chibi VRM lazy loading (player pool selective preload)

**Impact: -10.8 MB initial fetch for non-chibi users (most users)**

`preloadWorldAssets()` calls `preloadVRMBytes()` for all 13 player VRMs including `milady-chibi.vrm` (5.6 MB) and `eliza-chibi.vrm` (5.3 MB). Together they are 10.8 MB fetched for every user on every page load, even if the user's avatar uses a standard Milady or Hermes VRM.

Fix: move chibi VRM preloads to a separate function called only when the player's current `avatarModelKey` is a chibi, or defer them entirely (skip from tier-2 preload). The player's VRM choice is known from `avatar.modelKey` available in `game/page.tsx` — use it to skip chibi fetches for non-chibi users.

### Win #6 — Reduce NPC instance count on Iris Xe / low-end

**Impact: -20–40 draw calls, estimated 10–15 FPS recovered**

The wandering NPC system spawns up to ~20 NPCs (GLB + VRM combined). On Iris Xe, each VRM NPC is 4–8 draw calls and each GLB NPC is 2–4 draw calls. 20 NPCs = 60–160 draw calls — on its own likely exceeding the Iris Xe budget.

No `LOW_END_GPU_DETECTED`-gated NPC count cap currently exists. Adding `if (LOW_END_GPU_DETECTED) { maxWanderingNpcs = 8 }` (or similar) directly in the NPC spawn logic would halve the NPC-related draw call budget. The `LOW_END_GPU_DETECTED` boolean is already computed at module scope in `World3DCanvas.tsx:73–100` and can be exported.

### Win #7 — fog.far = camera.far (eliminate thin over-draw band)

**Impact: marginal (~1–2 FPS), zero-risk, 1-line change**

`fog.far=15000`, `camera.far=16000`. The 1000 wu gap means geometry between 15000 and 16000 wu is fully fog-opaque but still vertex-processed and rasterised before the clip discards it. Setting `fog.far = camera.far = 15000` (or `camera.far = 15001`) eliminates this band at no visual cost.

Source: `World3DCanvas.tsx:777` (fog) vs `3dStructure.md §3` (camera.far).

### Win #8 — Shared MToon outline disable for VRM NPCs

**Impact: halves VRM NPC draw calls (from ~6 to ~3 per NPC); estimated -15–20 draw calls**

MToon materials add an outline pass per material group, doubling draw calls per VRM. The outline is a cosmetic silhouette — at Iris Xe DPR 0.55–0.7 it may not even be visible (outline width is typically 0.002–0.004 in screen space, which at DPR 0.55 maps to sub-pixel thickness). Disabling it on `LOW_END_GPU_DETECTED` at VRM load time via `VRMUtils` or by setting `material.outlineWidthMode = 'none'` is a known technique already listed in `performance/vrm-draw-call-reductions.md`.

### Win #9 — `sandy-treedome-v2.glb` and other stale assets

**Impact: -3.4 MB build artifact; no FPS impact, but avoids accidentally loading them**

Five stale GLBs confirmed on disk (see Section B). Verify no code reference remains, then delete. Eliminates dead weight from the deploy artifact and prevents future confusion.

### Win #10 — Parallel camera controller redundancy on Iris Xe

**Impact: -1–2 useFrame iterations per controller that is inactive; minor**

Four camera controllers can be simultaneously mounted and running useFrame:
- `OrbitControls` (always mounted when not in FPS-follow mode)
- `WASDCameraController` (always mounted)
- `FPSFollowCamera` (mounted when `controlMode === 'player'`)
- `ArrowKeyRotationController` (always mounted)

In explore/NPC mode where no player avatar exists, `FPSFollowCamera` is mounted but returns early from useFrame. However `WASDCameraController` and `OrbitControls` both process input every frame even in autonomous mode where user input is irrelevant. Gate each controller on the mode it services.

---

## Section F — Open Questions for Research

1. **Are GLBs using EXT_meshopt_compression?** The `extendLoaderWithMeshopt` call in `arena-buildings.tsx:692,1063` passes `meshoptDecoder` to `useGLTF` — but if the GLBs were exported without meshopt compression the extension has no effect. Confirm with `gltf-transform inspect <file>` on the top 5 GLBs by size.

2. **What is the texture format inside `quest-bounty-pavilion.glb`?** A hex inspection (`gltf-transform inspect --verbose`) would confirm whether textures are PNG/JPG or KTX2/Basis. If PNG/JPG, this is the single highest-ROI compression target.

3. **What is the actual draw call count at runtime?** The PerfHUD (`3dStructure.md §5b`) reads `gl.info.render.drawCalls` — enabling PerfHUD and taking a screenshot with the browser DevTools FPS panel open would give ground truth. Section D estimates are static only.

4. **Is `location_npc_glbs` (the 12 SpongeBob characters) using `mergeStaticMeshesByMaterial`?** ArenaBuildings applies the merge, but `arena-location-npcs.tsx` may not — if location NPC submeshes are unmerged, they are 24–48 unoptimised draw calls.

5. **Are wandering GLB NPC instances actually separate `clone()` calls, or is there geometry instancing?** The code path at `arena-npcs.tsx:452–465` calls `scene.clone()` per NPC — each clone is a full Object3D tree duplication with separate draw calls. If the 8 species each have 5 instances, that is 40 full scene-graph clones. `InstancedMesh` per mesh within the GLB (same species sharing geometry) would collapse per-species draw calls from 5× to 1×.

6. **Does `DeferredTerrainPreloads` fire BEFORE or AFTER `preloadWorldAssets()` would fire?** Both are in `game/page.tsx`. `DeferredTerrainPreloads` fires via `requestAnimationFrame` inside its `useEffect` — meaning it fires after first paint. `preloadWorldAssets()` would fire in a `useEffect` at the same lifecycle stage. The tier ordering inside `preloadWorldAssets()` (tier-1 immediate, tier-2 setTimeout(0), tier-3 via the deferred components) avoids conflict, but confirm no double-preload for the 12 decoration GLBs.

7. **What does `shisha-oasis.glb` (1.6 MB) render in the scene?** Not found in `BUILDING_GLBS` in the manifest, not in `3dStructure.md` building roster. Either it is loaded via a direct `useGLTF` call somewhere in the codebase, or it is a pure orphan. Worth a project-wide `grep shisha` to confirm.

8. **What is the `preloadMixamoClips()` implementation?** Referenced in `asset-preload-manifest.ts:247` — confirm it calls `useGLTF.preload()` for `idle.glb`, `walk.glb`, `run.glb` (not just fetches the bytes without populating the Suspense cache).

9. **Can the MergedSeaweed path be conditionally enabled on low-end at reduced instance count?** Currently disabled entirely on `FORCE_WEBGL`. A low-count seaweed (10% of full density) might be possible at acceptable GPU cost and would improve visual quality on Iris Xe.

10. **Is `compileAsync` (`World3DCanvas.tsx:502–521`) called after the first build-phase commit that includes building materials?** If it fires before buildings are in the scene graph, the compiled pipelines won't cover building materials and there will still be a pipeline compile spike when ArenaBuildings first commits.

---

## Summary Table

| # | Win | Subsystem | Estimated impact | Effort |
|---|---|---|---|---|
| 1 | Wire `preloadWorldAssets()` in `game/page.tsx` | Loading pipeline | Loading bar live; -800–1500 ms TTI | 2 lines |
| 2 | Instance building pedestals | Draw calls | -11 draw calls, ~5–8 FPS | Low |
| 3 | Re-enable Three.js frustum culling for NPCs | Draw calls | -20–40 draw calls off-screen | Low |
| 4 | Compress `quest-bounty-pavilion.glb` (textures) | Network/parse | -6 MB payload, -1–2 s load time | Medium |
| 5 | Lazy-load chibi VRMs for non-chibi users | Network | -10.8 MB initial fetch | Low |
| 6 | Cap NPC count on `LOW_END_GPU_DETECTED` | Draw calls | -20–40 draw calls, 10–15 FPS | Low |
| 7 | Set `fog.far = camera.far` | Rasteriser | ~1–2 FPS, zero visual change | 1 line |
| 8 | MToon outline disable on low-end VRMs | Draw calls | -15–20 draw calls | Low |
| 9 | Delete stale GLBs from disk | Build artifact | -3.4 MB artifact, safety | Low |
| 10 | Gate camera controllers on active mode | CPU | Minor useFrame savings | Low |

**Highest priority:** Win #1 (loading screen fix, 2-line change) and Win #6 (NPC count cap on low-end) deliver the most user-visible improvement for the least code change.

**Highest ROI for FPS:** Wins #2 + #3 + #6 + #8 together would reduce draw calls from ~142–271 to approximately **~75–150**, potentially crossing the Iris Xe 80+ FPS threshold.

---

*Audit written 2026-05-22. Static analysis only — runtime PerfHUD readings needed to confirm draw call estimates.*
