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

**Last edit:** 2026-05-26 — SeaLoadingScreen dismissal re-gated on `window.__W3D_READY` (canvas first-frame AND `StaggeredTextureUpload` completion) instead of `window.__W3D` (canvas first-frame only). The first-frame-only signal was dismissing the overlay before WebGPU texture uploads finished, leaving the user staring at a blue/blank world under the UI. The `__W3D_READY` two-gate flag was added in `43a9000d` then reverted in `1ffc40a8`; this re-applies it on the loader side only — World3DCanvas already sets both `__W3D_CANVAS_READY` + `__W3D_TEXTURES_READY` and ANDs them into `__W3D_READY`. **Prior Last edit:** 2026-05-25 — Phase 6.4.0: blackjack table click hotspot added to cove interior. `BlackjackTableHotspot` component at `_BJ_HOTSPOT_POS = [307, 100, 0]` (dealer station right wall). Invisible `boxGeometry` 200×200×150 wu + `meshBasicMaterial visible={false}`. `onClick` → `useCoveStore.openBlackjackTable()`. Green `BankBanner` ("BLACKJACK", `#22dd88`) at Y=280wu. `BlackjackModal` mounted in `/cove/page.tsx` alongside `SlotScreenModal`. Mock route `POST /api/cove/blackjack/play-mock-hand` registered in `apps/api/src/index.ts`. Connection SKILL.md + hosted-agent skill memory deferred to Phase 6.4.2 per plan. See §10c. **Prior Last edit:** 2026-05-23 — Phase A LOD hierarchy added to meshlet rasterizer. `geometryToMeshletAsset()` in `nanite-rasterizer.ts` now builds up to 7 LOD levels using `MeshoptSimplifier.simplify()` (~50% tri reduction per step, error thresholds doubling: 0/0.01/0.02/0.04/0.08/0.15/0.25). All LODs share the same vertex pool (meshoptimizer preserves original vertex indices). `computeFrustum` TSL compute shader upgraded from hardcoded `uint(0)` to JS-unrolled cascading `If/ElseIf` chain (coarsest-to-finest) selecting the coarsest LOD whose projected screen-space error ≤ `pixelErrorThreshold=4.0px`. Projected error formula: `lodError × instanceScale × cotHalfFov × (screenH/2) / distToCamera`. `MeshletAsset` extended with `lodErrors: Float32Array` and `lodTriCounts: number[]`. `geometryToMeshletAssetAsync()` async wrapper added. Overlay updates: `/preview/meshlet-spike` shows LOD count + coarsest-LOD reduction pct; `/preview/meshlet-spike-all-12` shows "Coarsest LOD tris" + "LOD reduction %" header rows and per-building `×NLODs` suffix. Goal: from 7 FPS (12 buildings, sandy-treedome 1.13M tris, 0 LOD) to 60+ FPS (LOD selection selecting ~4× fewer chunks at typical 5000wu camera distance). **Prior Last edit:** 2026-05-23 — Phase A meshlet spike extended to all 12 buildings. New route `/preview/meshlet-spike-all-12` (`apps/web/src/app/preview/meshlet-spike-all-12/page.tsx`). Loads all 12 building GLBs in parallel via `Promise.all` + `GLTFLoader.setMeshoptDecoder(MeshoptDecoder)`, merges each building's sub-meshes into one `BufferGeometry` (world-transform applied), calls `geometryToMeshletAsset()`, then instantiates **12 separate `NaniteRasterizer` instances** (one per building at its ring-slot position, scale=1.0). Design rationale: `NaniteRasterizer` bakes geometry data into TSL `StorageBufferAttribute` nodes at `_buildPipelines()` time; `staticInstanceData` is `vec4(posX,posY,posZ,scale)` with no per-instance mesh selector — heterogeneous meshes in one rasterizer would require a new compute stage (out of scope for Phase A). Camera: `position=[0,2000,5000]` looking at origin, `far=20000`. FPS overlay shows per-building tri count + total. Phase A measurement only — no production file edits. **Prior Last edit:** 2026-05-22 — Phase 1 + Phase 2 perf merged. **Phase 1 (Win G frustum culling correctness):** `applyFattenedFrustumCulling(root, factor=1.6)` exported from `vrm-loader.ts`. Replaces 7 defensive `traverse((o) => { o.frustumCulled = false })` calls across `arena-npcs.tsx` (×2), `arena-location-npcs.tsx`, `player-avatar.tsx`, `town-guide.tsx`, `quest-npc.tsx`, `cosmetic-loader.tsx` (×1) — all of which were overwriting the Wave 3 bind-sphere fattening that ran inside `normaliseVRM`. Helper is idempotent via `_fattenedBy` geometry tag; `normaliseVRM` now delegates to it. Three `frustumCulled = false` sites in `cosmetic-loader.tsx` are intentionally preserved (two are `THREE.Group` wrappers, one is a module-scope shared aura geometry). §6f rule 10 added. **Phase 2 (Strategy 2A material dedup):** `scripts/dedup-buildings.mjs` run on all 12 building GLBs. Outputs `*-opt1.glb` variants. `gltf-transform dedup` + custom untextured material consolidation. 142→133 materials (9 saved). Sandy-treedome: 15→11 (4 untextured vertex-color consolidated). Arcade: 34→30 (4 solid-color exact-match merged). Cove: 5→4 (1 duplicate baseColor+emissive texture deduped). Total file size: −809 KB (sandy-treedome: −662 KB). All 12 BUILDING_MODELS paths in `arena-buildings.tsx` updated to `*-opt1.glb?v=2` (`patricks-rock` + `squidward` bumped to `?v=3`). `asset-preload-manifest.ts` BUILDING_GLBS updated. `sw.js` PRECACHE_GLBS updated to current 12-building roster + version bumped to `v5`. `BuildingVisitVignette.tsx` BLDG_PATH updated. AABB extents in `world-colliders.ts` unchanged (dedup does not modify vertex geometry). Strategy 2B (atlas) excluded: 41/142 materials have UV outside [0,1] (boating-school 19/25 with max up to 65535, salty-spitoon all 3 with max ≥60000). See `docs/perf-phase2-recon-2026-05-22.md`.

**Prior Last edit (Wave 2):** 2026-05-22 — Wave 2 perf pass: (D) Dead `BuildingPedestal` + `_pedestalMaterial` code removed from `arena-buildings.tsx` — pedestals were removed 2026-05-21, dead declarations now gone. (E) `MergedDecorationsInner` in `arena-terrain.tsx` already merges all 12 decoration models × 80 instances by (spatialCell, materialUUID) — confirmed already live, no code change needed. (F) Lazy chibi VRM loading: `CHIBI_VRM_PATHS` extracted from `PLAYER_VRM_PATHS` in `asset-preload-manifest.ts`; chibis excluded from unconditional tier-2 preload loop; new `preloadChibiVrm(modelKey)` export; `game/page.tsx` fires it on mount when `avatar.modelKey` is `'eliza_chibi'` or `'milady_chibi'` — saves 10.8 MB unconditional fetch + estimated 150–400 ms VRM parse time on Iris Xe for non-chibi users (≈98% of players). §9 asset-load tier table updated.

**Prior Last edit (Wave 1):** 2026-05-22 — WIN A/B/C perf pass: (A) `LOW_END_NPC_CAP=6` cap in `ArenaNpcs` — when `LOW_END_GPU_DETECTED`, sort wandering NPCs by XZ distance to player and render nearest 6 only; building residents (`ArenaLocationNpcs`) unaffected. (B) Spring-bone distance LOD in `VRMNpcMesh` — replaced uniform `springMod=4` (15Hz) with distance-tiered: <2500wu→mod=2 (30Hz), 2500–6000wu→mod=4 (15Hz), ≥6000wu→mod=8 (~7.5Hz); module-scope `_springLodCamPos` scratch (zero per-frame allocs). (C) `fog.far` 15000→16000 to match `camera.far` — eliminates the 1000wu over-draw band where geometry was vertex-processed + rasterised at 100% fog opacity before depth clip. §4 fog table + §5d spring-bone throttle row updated. Prior: 2026-05-22 — §10c Cove hotspots canonicalized as GLB BANK-DISCOVERY procedure. Replaces hardcoded `GAMEREADY_HOTSPOTS` cabinet centroids with runtime-discovered bank cluster: filter cluster meshes by bbox heuristic (h∈[1,200] w∈[400,1000] d∈[250,500] yMid∈[30,200] vol≤30M), union into one bank bbox, split along X at midpoint, emit two `SlotHotspot` boxes sized `halfW * 0.92` (Phase 6.1.16 seam-gap to prevent overlap eating bonus clicks), render two `BankBanner` labels at Y=280wu. This is the **standard procedure for future multi-paytable game rooms** — re-use as written. `cove-interior.glb` swap also requires `?v=N` cache-bust on `INTERIOR_GLB`. Prior: 2026-05-22 — Per-building GLB-measured AABB extents: replaced uniform BUILDING_HALF≈206wu with `BUILDING_EXTENTS` table (12 entries, 303–850 wu halfX/halfZ per building) in `world-colliders.ts` and mirrored to `world-colliders-data.ts`. Method: gltf-transform bbox inspection applying recursive TRS world transforms + targetMaxDim scale + 2000wu footprint cap + 0.85 tighten. §2h building extents table added. Prior: 2026-05-22 — Per-GLB collision rework + walkable surfaces: `Collider2D` gains `walkable`/`topY`; `clampMovement2D` returns `groundY`; player/NPC Y-lift via `effectiveFloorY = Math.max(terrainY, walkableY)`. Shisha-oasis split to two zones (walkable outer approach halfX=348/halfZ=340/topY=38 + solid inner kiosk halfX=200/halfZ=195) at corrected mesh center (1178,−240). All call sites pass entity half-width. Total: 19→20 colliders. `packages/shared` `ServerCollider2D` gains `walkable`/`topY`. §2h updated.

**Last edit:** 2026-05-22 — NPC speech-bubble occlusion fix: `BUBBLE_Y` raised 20→150 wu in `npc-speech-bubbles.tsx`. Root cause: at Y=20 the camera→anchor ray struck the BASE of structures (shisha-oasis platform, stall counters) from above; those triangles have +Y normals, so the ray hit their back face; `material.side === FrontSide` causes Three.js Raycaster to skip back-face hits → zero intersections returned → bubble rendered over the structure. At Y=150 the anchor sits in the wall/canopy zone of every structure (all ≥500wu tall) where wall triangles have outward-facing normals that the ray hits front-on → correctly occluded. Visual bonus: bubble floats above NPC head (convention for speech bubbles in games). Prior: `npc-speech-bubbles.tsx` adds `occlude: true` to `useWorldLabel` (same 10 Hz staggered raycast against `userData.isOccluder` meshes that name tags use). Proximity fade tightened 4000/10000 → 1800/5000 wu.

**Prior Last edit:** 2026-05-21 — World collision overhaul Phases 2–4: (1) `world-colliders.ts` AABB cutover complete — BUILDING_SCALE_FACTOR 0.85→0.92, disc radius table replaced with halfX/halfZ table, mandatory structure-on-map rule added to §2h. (2) New `packages/shared/src/constants/world-colliders-data.ts` with `clampPosition2D(worldX, worldZ, entityHalf?)` and `WORLD_COLLIDER_MAP_HALF` — server-usable AABB collision without browser deps. (3) `npc-simulation.ts` now imports `clampPosition2D`/`WORLD_COLLIDER_MAP_HALF`; collision clamp applied to all three NPC motion paths: pathfinding waypoint step (was already done + path-abort on hit), combat approach branch, `moveTowardTarget`. (4) NPC-vs-NPC post-movement push-out: `resolveNpcNpcOverlaps()` (half-symmetric push-out, world mode only, after `moveNpcs()`). (5) Client Phase 4: `arena-npcs.tsx` GLBNpcMesh + VRMNpcMesh useFrame add inline player-vs-NPC push-out against `avatarPositionRef`; `ENTITY_HALF_CHIBI=25` / `ENTITY_HALF_HUMANOID=50` exported from `world-colliders.ts`; `clampEntityMovement2D` available for combined world+entity clamping. Prior 2026-05-21 — Town-center reflow pass 2: (1) `TownDirectorySign` geometry bumped ×1.4 (posts 14→20×280→392×14→20, spacing 280→392, plank 380→532×190→266, backing 6→8) — sign reads 40% larger from spawn. (2) Nori `GUIDE_Z` 240 → 400 (further south from the bigger sign). (3) Player spawn `avatarPosition.y` 6140 → 6300 (world Z 380 → 540) — keeps the 140 wu south-of-Nori gap. (4) `MarketplaceStall` (the Exchange anchor) GLB swapped from `marketplace-food-stall.glb` to `shisha-oasis.glb` (1.6 MB, DAE bazaar — shisha oasis, gltf-transform resize 1024 + webp from 2.1 MB). (5) Bazaar + Marketplace `STALL_Z` 450 → −120 — both stalls now align on the same Z axis as the sign, flanking it east/west at x=±1273. Collider entries updated to (±1273, −120). (6) Pavilion `FLOOR_NUDGE_Y = -60` added — pulls the whole pavilion down so the wooden interior floor reads flush with the sand (GLB had below-floor trim that confused canonical groundedYOffset). Prior 2026-05-21 — Quest+Bounty Pavilion: new `quest-bounty-pavilion.tsx` mounts an octagonal pavilion GLB at (0, groundedY, −1220), TARGET_HEIGHT_WU=1080 (matches stalls after their 15% reduction: 1020 / 1105). Replaces standalone `bounty-board-object.tsx` (deleted). Left half-zone → `openQuestBoard()`, right half-zone → `openBountyBoard()`. Bio-luminescent cyan "Quests" + amber "Bounties" labels via WorldLabel. World3DCanvas mount swapped; collider `bounty-board` removed, `quest-bounty-pavilion` (0, −1220) r=320 added. Prior 2026-05-21 — Stall size reduction: bazaar `TARGET_HEIGHT_WU` 1200→1020 (×0.85), marketplace 1300→1105 (×0.85). Sets size budget matching the new quest/bounty pavilion landmark. Prior 2026-05-21 — Plaza cleanup: (1) `BuildingPedestal` `matrixAutoUpdate={false}` prop dropped — R3F with matrixAutoUpdate=false never pushes JSX position into the matrix, causing all 9 pedestals to stack at world origin; dropping it lets R3F update the matrix normally (9 static matrix recalculates/frame is negligible). Gotcha saved to `.claude/memory/threejs/gotchas/r3f-matrixautoupdate-false-strips-position-prop.md`. (2) Bazaar+marketplace stalls moved from r≈855wu to r≈1350wu (STALL_X: ±1273, STALL_Z: 450). (3) Squidward lookup key: straight U+0027 apostrophe + underscore (`Squidward’s_House`), 17 chars. Prior 2026-05-21 — Squidward body-anchor key corrected to `"Squidward’s_House"` (straight U+0027 + underscore-not-space). CDP live traversal (Chrome 148, prod) confirmed this is the actual Three.js runtime node name — prior commit abea970 had set it to U+2019 curly apostrophe based on a flawed hex-dump, which was still a silent no-op. CDP is now canonical for all GLB node names. Prior 2026-05-21 — React #418 hydration fix: `DeferredTerrainPreloads` and `DeferredNpcPreloads` in `game/page.tsx` converted from static imports to `dynamic({ ssr: false })`. `arena-terrain.tsx` evaluates `FORCE_WEBGL_TERRAIN` at module scope from `navigator.userAgent` — this ran on the server (where navigator is undefined → false) and then again on the client (where it may be true for non-WebGPU browsers), producing a different material type from `SandFloor.useMemo`, causing React to tear down and rebuild the client tree ("loaded twice" symptom). Safe to ssr:false because both components only fire `useGLTF.preload()` in useEffect. Prior 2026-05-21 — Squidward body-anchor U+2019 (reverted — was wrong, see above). Prior 2026-05-21 — Critical crash fix: `createWebGPURenderer` and glFactory catch block now use `THREE.WebGPURenderer` from the static top-level `import * as THREE from 'three/webgpu'` instead of `await import('three/webgpu')`. Dynamic import of `three/webgpu` inside the renderer factory caused webpack to create a second chunk with a separate module instance — `IndexNode` and other Three.js singletons from that second instance were different objects from those used by materials registered via `extend(THREE)`. When a material from instance A was compiled by a renderer from instance B, `IndexNode.VERTEX` appeared `undefined` → `SES_UNCAUGHT_EXCEPTION: TypeError: can't access property "VERTEX", yb is undefined` on Chrome/Brave/any browser without `navigator.gpu`, first-time visitors (cold cache) only. Root cause: two module instances of `three/webgpu` in the same page. Fix: use the same static import namespace throughout. Prior: 2026-05-20 — iOS Safari black-scene fix: `createWebGPURenderer` now detects iOS Safari + any browser without `navigator.gpu` and passes `forceWebGL:true` to `WebGPURenderer`. This skips the `navigator.gpu.requestAdapter()` call (which throws TypeError on iOS because `navigator.gpu` is undefined) and boots the WebGL2 backend directly. TSL node materials (`MeshBasicNodeMaterial`, `PointsNodeMaterial`, `MeshStandardNodeMaterial`) compile to GLSL via `GLSLNodeBuilder` on the WebGL2 backend — same visual output as the desktop WebGPU path. Module-scope `IOS_SAFARI` + `WEBGPU_ABSENT` + `FORCE_WEBGL` constants logged to console on init. Prior: 2026-05-19 — §10d Slot Modal R3F Reel Rig: new `SlotReels3D.tsx` + `SlotReelsCanvas.tsx`; `SlotScreenModal.tsx` replaces 2D `SlotReels` with `SlotReelsCanvas`. 5 `CylinderGeometry` drums (r=STRIP_LEN×CELL_WU/2π, h=3wu, 84 radial × 3 height segments). Per-reel `CanvasTexture` (84×128×3×128px, built once in `useMemo`). Spin phases: ACCEL 200ms→STEADY→DECEL 600ms (easeOutCubic, staggered DECEL_AT=[2000..3600ms])→POP 120ms. Blur: `texture.repeat.y=0.35` during ACCEL/STEADY, restored to 1 on DECEL. Deterministic landing via `findStripPosition`. `spinTrigger` counter drives animation start. `frameloop='demand'`; DPR-capped. `compileAsync` on mount. All Iris Xe invariants. Prior: 2026-05-19 — §10c bonus cabinet differentiation + §10e WinCascadeOverlay3D: 4 slot cabinets split 2 classic / 2 bonus; `HotspotDef` gains `paytableId: MachineSlug` + `isBonus: boolean`; `SlotHotspot` click handler now routes `openSlotScreen(def.machineSlug, def.paytableId, ...)` (was hardcoded `'classic-3x5'`); bonus bodies use `CABINET_BODY_BONUS_MAT` (gold tint, emissive 0.18); BONUS badge: 120×30wu `PlaneGeometry` + `MeshBasicMaterial` with canvas-texture pill (built once at module scope, lazy-init guard for SSR), positioned at Y=194wu above floor; `SlotCabinets` now accepts `hotspots: HotspotDef[]` prop. New `WinCascadeOverlay3D.tsx`: R3F component, additive-blend glow planes + torus rings per winning cell, 200ms stagger in reel order, per-instance material clones to prevent shared-material opacity bleed (max 30 material instances during animation), wild-multiplier cells get brighter magenta glow + DOM label via `createPortal(document.body)` + camera projection (30Hz throttle), `active` prop triggers cascade, `onCascadeComplete` fires after last cell + 800ms hold, all geometry+template materials at module scope. Iris Xe: no drei Text/Billboard, no per-frame allocs, MeshBasicMaterial only. Prior: 2026-05-19 — Casino interior input+camera triple-fix: (1) Avatar yaw lerp rate 0.15→0.08 in both VRM+GLB branches — A/D press spreads 90° turn over ~35 frames (0.58s) instead of snapping in 3-4 frames. (2) Arrow keys decoupled from WASD movement; separate `_casinoArrowKeys` + `attachCasinoArrowListeners()` for camera perspective-orbit: Left/Right orbit yaw at 1.5 rad/s, Up/Down tilt camera height at 200wu/s, pitch clamped to [-100, +400] wu relative to CAM_ABOVE=190. Mirrors World3DCanvas `ArrowKeyRotationController` convention exactly. (3) Camera AABB clamp via new `room-camera.ts` `clampCameraToRoom()` — constrains desired pos to room halfX=383, Z=[-900,+900], Y=[30,600], margin=50wu before lerp; eliminates void-black viewport when avatar faces a wall. `CASINO_ROOM_BOUNDS` constant added. New `apps/web/src/lib/three/room-camera.ts` reusable for future interior scenes. §10c casino-input entry updated. Prior: 2026-05-19 — World colliders: new `collision/world-colliders.ts` with 19 XZ-plane disc colliders (12 buildings ≈ 190wu + 7 props 50–220wu). Integrated into `player-avatar.tsx` (VRM+GLB), `arena-npcs.tsx` (GLBNpcMesh+VRMNpcMesh), `arena-location-npcs.tsx` (spawn sanity push-out). Zero per-frame allocs. Slide-along-wall semantics. §2h added. Prior: 2026-05-19 — Bio-luminescent label system: Fraunces serif capsule + dashed-cyan tether + pulsing anchor dot replaces plain uppercase wordmarks on all NPC and building labels. See §5d for full spec. Prior: 2026-05-18 — Casino interior bug-fix pass 2: avatar scale override was a no-op (CASINO_VRM_TARGET_HEIGHT was 270 = same as VRM_AVATAR_TARGET_HEIGHT_WU). Dropped to 160wu so cabinet tops (159wu) reach avatar forehead — tall Vegas slot-machine feel. Camera offsets recomputed proportionally: CAM_ABOVE 270→190, CAM_BEHIND 520→450, CAM_LOOK_Y 120→70. _casinoCamYaw module-scope var reset to π on mount in both CasinoVRMAvatarInner and CasinoGLBAvatarInner to prevent catch-up swing on re-entry. §10c updated. Prior: 2026-05-18 — Casino interior bug-fix trio (Bug 1: arrow-key support; Bug 2: chase-camera yaw decoupled via `_casinoCamYaw` module ref + `CAM_YAW_LERP=0.05` slow-lerp applied to BOTH VRM and GLB branches; Bug 3: cabinet heights now world-scale 159wu total vs 270wu avatar = 59% chest-height). `computeVRMAvatarFit` gained optional 3rd param `targetHeightOverride`. §10c slot-cabinet sub-entry updated.

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
| 11 | NNW (330°) | 115 | 67 | memory-rag | 0.522 | 1700 | 1400→1700; childScaleOverrides: "Squidward's_House" ×1.7 (straight U+0027 + underscore — CDP-verified node name); bodyAnchorChild: "Squidward's_House"; pivotZBias removed |

**rotY formula:** `atan2(180 − cx, 180 − cy)` — each building's +Z axis points toward plaza center (world 0, 0). Values are identical across all ring expansions because atan2 depends only on direction, not magnitude. Model-authored `rotYOffset` values are additive and stay with the building regardless of slot.

**Building scale normalization — Phase 6.2:** `computeBuildingScale` now normalizes to `max(X,Y,Z)` of the bounding box (`targetMaxDim` parameter). Prior `targetHeight` normalized Y-only, causing wide/squat buildings (Chum Bucket, Patrick's Rock) to balloon in XZ while tall/narrow buildings stayed small. Max-dim normalization gives consistent visual cube size across all GLB aspect ratios. `BUILDING_TARGET_HEIGHT = 800 wu` remains as default fallback; per-building `targetMaxDim` in `BUILDING_MODELS` overrides it via `computeBuildingScale(c, config.targetMaxDim ?? BUILDING_TARGET_HEIGHT)`.

**Building pedestals (Phase 6.1):** A flat `CylinderGeometry` stone disc (radius=560wu, height=15wu) is rendered under every building via `BuildingPedestal` component in `arena-buildings.tsx`. Color: warm sandstone (`0x8b7d6b`). Shares one `MeshStandardMaterial` instance across all 12 pedestals. Positioned at `y=-2` (flush with the sand floor). Only the per-building ring pedestals exist — there is NO central plaza disc geometry. **Gotcha (2026-05-21):** `matrixAutoUpdate={false}` as a JSX prop silently prevents R3F from writing the `position` prop into the matrix — all pedestals stacked at origin. Fixed by removing the prop; R3F handles the matrix update automatically for static placement.

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
- `memory-rag` (`squidward-house.glb`): `"Squidward's_House"` × 1.7 childScaleOverride (straight U+0027 + underscore — CDP-verified; prior commits used space or U+2019, both silent no-ops); `bodyAnchorChild: "Squidward's_House"` — moai head center aligns to slot, steps extend forward.
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

## 2h. World colliders (XZ-plane AABB collision)

Source: `apps/web/src/lib/three/collision/world-colliders.ts` (AABB cutover 2026-05-21; original disc 2026-05-19).

> **§6g — MANDATORY RULE: Building/prop spatial registration (2026-05-21)**
> Adding, moving, or removing ANY building / prop / town-center furniture on the
> world map REQUIRES a matching AABB entry update in BOTH:
> 1. `apps/web/src/lib/three/collision/world-colliders.ts` (client — `PROPS` array and/or building derivation)
> 2. `packages/shared/src/constants/world-colliders-data.ts` (server — `PROP_COLLIDERS` array; buildings auto-derive from `BUILDING_TILE_ZONES`)
>
> Both files in the SAME diff. A structure without a collider entry is a walk-through ghost. A stale collider at a removed structure creates an invisible wall.

Pure XZ-plane AABB (axis-aligned bounding box) collision — no physics engine, no draw calls, zero per-frame allocations. Blocks players AND NPCs from walking into buildings and town-center props. AABB chosen over disc: buildings are 14×14 tile squares; disc over-covers diagonals or leaves corners enterable. AABB gives geometrically correct wall feel at every edge. Minimum-translation-vector (MTV) push-out gives natural wall-sliding.

**Walkable colliders (added 2026-05-22):**
`Collider2D` has `walkable?: boolean` and `topY?: number`. When `walkable === true`, the collider does NOT block XZ movement — instead, `clampMovement2D` sets `result.groundY = col.topY` so the caller can raise the entity's Y to ride the surface. The schema and entity-Y wiring (player + NPC `effectiveFloorY = max(terrainY, walkableY)`) are in place but no walkable collider is currently registered — see ROUND 2 note below for why the shisha-oasis walkable was reverted to pure-solid.

**Architecture:**
- Module-scope collider cache (`getAllColliders()`) — recomputed only when `buildingZones.length` changes (never in practice). Returns `readonly Collider2D[]`.
- `clampMovement2D(fromX, fromZ, toX, toZ, entityHalf?)` — called once per entity per frame. Returns `{ x, z, hit, groundY }`. `entityHalf` defaults to 0 (point entity); typical: `ENTITY_HALF_CHIBI=25` wu for chibi NPCs, `ENTITY_HALF_HUMANOID=50` wu for adult humanoids. `groundY` is -2 (sand floor) unless entity overlaps a walkable zone.
- Module-scope scratch scalars `_sCx`/`_sCz`/`_sGroundY` — zero `new Vector3()` or object allocations in the hot path.
- MTV push-out semantics: push along the axis of SMALLER overlap — entity slides along walls naturally.
- **Entity constants** exported from `world-colliders.ts`: `ENTITY_HALF_CHIBI = 25`, `ENTITY_HALF_HUMANOID = 50`.
- Server counterpart: `clampPosition2D(worldX, worldZ, entityHalf?)` in `packages/shared/src/constants/world-colliders-data.ts`. Accepts Three.js world-space coords (convert: `worldX = npc.x − MAP_HALF`). Both client and server derive building AABBs from the same `BUILDING_TILE_ZONES` source in `@clawville/shared`.

**Collider counts:**

| Kind | Count | Half-extents | Source |
|---|---|---|---|
| Building (ring) | 12 | Per-building (303–850 wu) | `BUILDING_EXTENTS` table in `world-colliders.ts` (GLB-measured 2026-05-22) |
| Prop (town center) | 7 | 40–420 wu (anisotropic) | Hardcoded from each prop's TSX constants |
| **Total** | **19** | | |

**Building half-extent derivation (2026-05-22 — per-building GLB measurement):**

The old uniform `BUILDING_HALF ≈ 206 wu` (0.92 × 224 wu) was too small for most buildings and too large for small ones. Replaced with per-building measured AABBs via `scripts/inspect-building-bboxes.mjs` + inline Node.js for Draco-compressed GLBs.

Method:
1. Measure native GLB bbox via gltf-transform, applying recursive TRS world transforms (required for GLBs with non-identity root quaternions, e.g. patty-building has `(-0.5,-0.5,-0.5,0.5)` quaternion).
2. Apply `arena-buildings.tsx` `targetMaxDim` scale: `worldX = nativeSizeX × (targetMaxDim / nativeMaxDim)`, capped by `MAX_FOOTPRINT = 2000 wu`.
3. Tighten by `TIGHTEN = 0.85` to exclude eaves and overhang: `halfX = worldX / 2 × 0.85`.
4. AABB center = tile-zone world center (no additional offset). `computeBuildingScale()` applies `pivotOffsetX/Z = bboxCenter × scale` correction so the visual mesh center == tile-zone world center. The AABB center must match.

Special cases:
- `cove`: uses `box3Recenter=true` — arena-buildings.tsx re-centers geometry to (0,0,0) after load, so center = tile-zone center always.
- `messaging-channels`, `api-integrations`: `targetMaxDim=2500` exceeds `MAX_FOOTPRINT=2000`; both axes capped to 2000 wu.
- `cron-automation` (patty-building): X axis capped to 2000 wu; Z axis measured naturally.
- `pineapple-house` (visual-creation), `sandy-treedome-v3` (messaging-channels): Draco-compressed GLBs; required `draco3d` npm package to read vertex data.

**Per-building AABB extents (BUILDING_EXTENTS table, 2026-05-22):**

| Building ID | GLB file | targetMaxDim | worldX × worldZ wu | halfX × halfZ wu |
|---|---|---|---|---|
| visual-creation | pineapple-house.glb | 1100 | 1100 × 841 | 468 × 357 |
| code-development | chum-bucket-v2.glb | 1400 | 1392 × 1400 | 591 × 595 |
| mcp-tool-use | krusty-krab-v2.glb | 1400 | 1386 × 1400 | 589 × 595 |
| messaging-channels | sandy-treedome-v3.glb | 2500 | 2000 × 2000 (cap) | 850 × 850 |
| api-integrations | salty-spitoon.glb | 2500 | 2000 × 2000 (cap) | 850 × 850 |
| app-publishing | boating-school.glb | 1000 | 1000 × 995 | 425 × 423 |
| cron-automation | patty-building.glb | 2200 | 2000 × 1173 (X cap) | 850 × 498 |
| deployment-ops | building-lighthouse.glb | 1400 | 714 × 776 | 303 × 330 |
| claw-arcade | claw-arcade-exterior.glb | 1100 | 1100 × 1058 | 468 × 450 |
| cove | cove-exterior.glb | 1300 | 1284 × 1300 | 546 × 553 |
| agent-security | patricks-rock-v2.glb | 1100 | 1082 × 1100 | 460 × 468 |
| memory-rag | squidward-house.glb | 1700 | 1700 × 1700 | 722 × 723 |

Fallback `BUILDING_HALF ≈ 206 wu` (0.92 × 224) retained in code for any unknown zone ID (defensive only — all 12 are covered).

**Prop colliders (2026-05-22 ROUND 2 — shisha-oasis pure-solid):**

| ID | World XZ | halfX × halfZ | Kind | Notes |
|---|---|---|---|---|
| auction-podium | (0, −1000) | 160 × 160 wu | solid | |
| town-directory-sign | (0, −120) | 70 × 40 wu | solid | |
| bazaar-stall | (−1273, −120) | 180 × 140 wu | solid | |
| **marketplace-stall** | **(1178, −240)** | **420 × 410 wu** | **solid** | **shisha-oasis full footprint; ROUND 1 walkable zone reverted — see below** |
| quest-bounty-pavilion | (0, −1220) | 280 × 280 wu | solid | |
| quest-npc | (−110, −60) | 40 × 40 wu | solid | |
| town-guide | (0, 240) | 40 × 40 wu | solid | |

**Shisha-oasis GLB bbox math (2026-05-22, verified via Node.js binary parse):**
```
GLB scene bbox (Three.js scale=1, after 0.01 FBX node scale):
  min: (−0.04972, 0.00183, −0.05097)
  max: (+0.03383, 0.07189, +0.03076)
  maxDim = X = 0.08355

Applied scale (TARGET_HEIGHT_WU=994): 994 / 0.08355 ≈ 11,897
World dimensions: X=994 wu, Y=833 wu, Z=972 wu

GLB mesh center offset from group origin (STALL_X=1273, STALL_Z=−120):
  X_offset = (0.03383 − 0.04972)/2 × 11897 = −94.6 wu → worldX = 1178
  Z_offset = (0.03076 − 0.05097)/2 × 11897 = −120.2 wu → worldZ = −240

groupY ≈ −53.8 wu (groundedYOffset + FLOOR_NUDGE_Y −30)
Step topY = groupY + ~90 wu structural height ≈ 36 wu → SHISHA_STEP_TOP_Y = 38 wu
```
GLB is a single merged mesh (3 primitives — main body, canopy, lantern emission). No separate stair/platform nodes. Per-step precision requires asset-level node separation; until then the structure is a pure-solid AABB blocker.

**ROUND 2 revert (2026-05-22 same day):** the initial fix added a walkable outer ring (halfX=348 halfZ=340 topY=38) covering most of the footprint plus a solid inner kiosk (halfX=200 halfZ=195). User reported NPCs spawning inside the mesh and the player walking into the visible structure — the 38 wu Y lift was only ~21% of avatar height, so crossing the visible wall produced "phasing through the wall" rather than "climbing a step". Reverted to a single solid AABB covering the full visible footprint. Walkable schema retained for future stair work after Blender-level per-step measurement.

**NPC spawn-clamp (added 2026-05-22 ROUND 2):** `npc-simulation.ts` `initNpcs()` and `registerOpenClaw()` now run `clampPosition2D()` on the spawn position (`homeX/homeY`, restored `lastX/lastY`) before writing it to the NPC record. Without this, NPCs whose home position overlapped the new larger AABB would visibly spawn inside the building mesh. Conversion: world = game_px − MAP_HALF.

(Removed 2026-05-21: `bounty-board` at (50, 0) — superseded by the QuestBountyPavilion.)
(Updated 2026-05-22 ROUND 1: `marketplace-stall` two-zone system, walkable outer + solid inner.)
(Updated 2026-05-22 ROUND 2: walkable reverted; pure-solid 420×410 wu at corrected mesh center (1178, −240).)

**Integration points:**
- `player-avatar.tsx` — VRM branch + GLB branch. Both call `clampMovement2D(..., ENTITY_HALF_CHIBI)`, store `clamped.groundY` in `walkableYRef`, and use `effectiveFloorY = Math.max(terrainYRef.current, walkableYRef.current)` for `group.position.y`.
- `arena-npcs.tsx` — `GLBNpcMesh` useFrame + `VRMNpcMesh` useFrame. Same pattern: per-NPC `entityHalf` (CHIBI vs HUMANOID based on npc.id prefix), `npcGroundY`/`vrmNpcGroundY` from clamped result, `effectiveFloorY = Math.max(currentTerrainY.current, groundY)` in Y position.
- `arena-location-npcs.tsx` — Sanity push-out at spawn time: `clampMovement2D(0, 0, worldX, worldZ)`.
- `npc-simulation.ts` (server) — `clampPosition2D()` from `@clawville/shared` applied to all NPC movement paths: pathfinding waypoint steps (path-following abandoned on wall-hit so NPC re-plans), combat approach, and `moveTowardTarget`. `resolveNpcNpcOverlaps()` runs after `moveNpcs()` each world-mode tick: O(n²) pairwise push-out, half-widths 25wu (Milady chibi) / 50wu (adult humanoid/crustacean), symmetric impulse.

**What is NOT covered (by design):**
- Vertical collision (Y axis) — terrain raycasting handles Y grounding (walkable colliders add a surface-Y layer on top of this).
- Casino interior — separate scene with its own `clampCameraToRoom()` bounds logic.
- Entity-vs-entity collision — `clampEntityMovement2D(fromX, fromZ, toX, toZ, entityHalf, otherEntities, otherHalf?)` in `world-colliders.ts` handles player↔visible-NPC push-out (client-side). NPC↔NPC server-side push-out: `resolveNpcNpcOverlaps()` in `npc-simulation.ts` after `moveNpcs()` each world-mode tick.
- NPC vs player collision (server) — deferred; would require client to send player position each tick.
- Walkable Y lift (server-side NPC simulation) — server-side NPCs don't track 3D Y; walkable flag is present in `ServerCollider2D` for schema parity but `clampPosition2D` currently treats walkable zones as passable ground (does not enforce topY). NPC visual Y is set by client-side terrain raycast.

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

**Canvas initial camera:** `fov=50, near=1, far=16000`, `position = mode==='game' ? [0, 600, 1300] : [0, 560, 1000]`. (camera.far raised from 6800→10000 in Phase 6.2.1, then 10000→16000 in Phase 6.2.3. Invariant: fog.far MUST equal camera.far — currently both 16000.)

**DPR cap:** `dpr={LOW_END_GPU_DETECTED ? [0.5, 0.65] : [0.75, 1]}`. `LOW_END_GPU_DETECTED` is computed once at module load via `WEBGL_debug_renderer_info` — Intel/Iris/UHD/Adreno/Mali/PowerVR/Apple-integrated + `pointer:coarse` mobile. Do NOT call `gl.setPixelRatio()` inside `onCreated` — that overrides the prop and was reverted 2026-04-21. Floor lowered 0.55 → 0.5 on 2026-05-22 (Wave 3) after scene became less fragment-bound from Wave 1 NPC cap + pavilion VRAM relief.

**Adaptive DPR feedback loop (2026-05-22, Wave 3 — `AdaptiveDprMonitor` in `World3DCanvas.tsx`):** runtime DPR adjuster that drops DPR by 0.05 when rolling-avg frame time > 18 ms (=55 FPS budget) and raises by 0.05 when < 12 ms (=83 FPS budget). 30-frame ring-buffer sampling; 1-second cooldown between adjustments. Bounded by Iris-Xe `[0.4, 0.7]` / desktop `[0.6, 1.0]`. Uses R3F `setDpr()` (not `gl.setPixelRatio()` directly) to reconcile canvas backing-store + camera aspect cleanly. Zero per-frame allocations — ring buffer is pre-allocated at mount. The system always converges toward the 80 FPS target — if scene complexity rises (more NPCs / decorations added later), DPR drops automatically to maintain the floor.

---

## 4. Lighting + atmosphere

Hard cap: **3 lights** on Iris Xe (uniform limit + shader compile cost).

| Light | Args | Notes |
|---|---|---|
| `hemisphereLight` | `0x66bbdd, 0x223344, intensity 1.8` | Warm sky / cool ground fill. Replaces a separate ambient — no `<ambientLight>`. |
| `directionalLight` (key) | `position [150, 350, 80], intensity 2.0, color 0xffeedd` | Warm key light from upper-right. |
| `directionalLight` (fill) | `position [-100, 200, -60], intensity 0.5, color 0x88aacc` | Cool fill from opposite side for depth. |

**Fog:** `fog(FOG_COLOR=0x0e3458, near=6000, far=16000)` (`World3DCanvas.tsx`). Updated 2026-05-22 (WIN C — perf-audit-2026-05-22): `far` raised from 15000→16000 to match `camera.far=16000` exactly. The 1000wu gap (15000–16000wu) was a over-draw band where geometry was vertex-processed + rasterised at full fog opacity before the depth clip — no visual change (geometry there was 100% fog-coloured already), only wasted GPU cycles eliminated. Invariant: `fog.far` MUST always equal `camera.far`. Prior: near=4500→6000, far=6800→9000→15000 (Phase 6.2.1 then Phase 6.2.3). Current fog factor at ring-edge (~5493wu from camera): factor=(5493−6000)/(16000−6000)=0 — fully clear (ring buildings fully lit, fog starts beyond them). Iris Xe safety: DPR cap [0.55,0.7] unchanged; `WorldContent.md §5 MAX_VISIBLE_DIST=3800` still rejects decoration placements.

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
| **Iris Xe wandering NPC cap** | `LOW_END_NPC_CAP=6`: when `LOW_END_GPU_DETECTED`, `ArenaNpcs` sorts wanderers by XZ distance to player (game-px coords via `avatarPositionRef`) and renders the nearest 6 only. Building residents (`ArenaLocationNpcs`) are never capped. Server keeps full roster. (WIN A — 2026-05-22) | `arena-npcs.tsx:ArenaNpcs` |
| Terrain raycast | Every 3rd frame, offset by `(frame + seed) % 3` per NPC so spikes stagger. | `arena-npcs.tsx`, `arena-location-npcs.tsx`, `player-avatar.tsx` |
| GLB NPC idle animation | 20 Hz (`(frame + seed) % 3 === 0`). | `arena-npcs.tsx` |
| GLB walk animation | Full 60 Hz — 8 rad/s cycle needs Nyquist. | `arena-npcs.tsx` |
| VRM AnimationMixer | Full 60 Hz unconditional (B9 fix 2026-04-24). | `vrm-character-animator.ts:updateMixerOnly` |
| VRM spring bones | Distance-LOD (WIN B — 2026-05-22): <2500wu→mod=2 (30Hz), 2500–6000wu→mod=4 (15Hz), ≥6000wu→mod=8 (~7.5Hz). Uses `camera.getWorldPosition(_springLodCamPos)` on module-scope scratch (zero per-frame allocs). Was uniform 15Hz (`springMod=4`); flattened from tiered 10/20Hz with culling removal 2026-05-11. | `arena-npcs.tsx:VRMNpcMesh` |
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

**9. Asset cache-bust on content change (MANDATORY).**
- When you ship a NEW BINARY for an existing asset path (`/avatars/<name>.vrm`, `/avatars/animations/<dir>/<slot>.glb`, `/cosmetics/<x>.glb`, …), you MUST bump a `?v=N` query in every URL referencing it. Cloudflare's edge serves `Cache-Control: public, max-age=604800` (1-week TTL) and **our deploy token lacks `cache_purge` scope** — we cannot invalidate via API. Bumping the query is the only no-token-required invalidator (CF + the SW `cacheFirstGlb` both key on full URL including query).
- Symptom of skipping this: prod still serves the OLD binary even though `git push` shipped + Coolify deployed. `curl` with `?cache_bust=$(date +%s)` returns the new file; bare URL returns the stale one. Verified pattern 2026-05-21 after chibi VRM textures landed on origin but Cloudflare kept serving the 3.4 MB textureless response for 1 week.
- Existing patterns: `EMOTE_BUNDLE_VERSION` in `vrm-character-animator.ts` (emote bundle), `?v=2` on `eliza_chibi` + `milady_chibi` paths in `agent-model-registry.ts` (chibi VRM textures, 2026-05-21).
- **When to bump**: any time you commit a new `.vrm`/`.glb`/`.png` binary at a path that's referenced elsewhere with a stable string. Greenfield assets (first time at a new path) don't need a version; only mutations of an existing URL do.
- Mid-term fix: the deploy script should auto-bump these via a content hash. Not implemented yet — manual bump required.

**10. SkinnedMesh frustum culling — use `applyFattenedFrustumCulling`, never bare `frustumCulled = false` (Win G — 2026-05-22).**
- Three.js computes SkinnedMesh bounding spheres from the T-pose (bind pose). Walk/run/jump animation extends geometry outside that sphere → Three.js incorrectly culls the mesh as the animated character approaches the camera frustum edge.
- Fix: after cloning a GLB or attaching a VRM scene, call `applyFattenedFrustumCulling(root)` (exported from `vrm-loader.ts`). It traverses all SkinnedMeshes, enlarges each `geometry.boundingSphere.radius` by 1.6×, then sets `frustumCulled = true`. The 1.6× factor clears the animated envelope for all walk/run cycles measured in ClawVille.
- The helper is **idempotent**: a `_fattenedBy` property tag on each `BufferGeometry` prevents repeated calls from compounding sphere inflation. Safe to call in `normaliseVRM` AND in consumer `useMemo`/`useEffect`s.
- **Never write `obj.frustumCulled = false` in a clone/attach path.** That pattern was the root cause of 41 SkinnedMeshes rendering without any culling (CDP probe 2026-05-22). It saves zero GPU on the current frame and permanently disables culling for the mesh's lifetime.
- **Exceptions (document them when you add one):** `THREE.Group` containers may keep `frustumCulled = false` — Three.js derives the Group's AABB from its children, but the children's culling flags are what matter. Module-scope shared geometry (e.g. the aura sphere in `cosmetic-loader.tsx`) must not be tagged because the tag would affect every consumer of that geometry.

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

### 9e. World boot preload tiers (`asset-preload-manifest.ts`)

Called from `game/page.tsx` via `useEffect(() => { preloadWorldAssets(); }, [])` — fires before the dynamic `World3DCanvas` chunk downloads.

| Tier | When | Assets | Notes |
|---|---|---|---|
| **1 — critical** | Immediately | 12 building GLBs, 3 locomotion GLBs, 8 wandering NPC GLBs, 4 town-prop GLBs, 6 wandering VRM bytes | Parallel with canvas chunk download |
| **2 — deferred** | `setTimeout(0)` | 11 player VRM bytes (Milady×8 + Hermes×2 + Tekk) | Avoids contending with tier-1 HTTP/2 slots |
| **2-lazy — chibi** | On `avatar.modelKey` | `eliza-chibi.vrm?v=2` (5.3 MB) + `milady-chibi.vrm?v=2` (5.6 MB) via `preloadChibiVrm()` | Only fetched when user's avatar IS a chibi (≈2% of players). Avatar picker also warms these on open. |
| **3 — post-paint** | `rAF` via `DeferredTerrainPreloads` / `DeferredNpcPreloads` | 12 location NPC GLBs, 12 decoration GLBs | Handled by existing deferred hooks in `game/page.tsx` |

**WIN F rationale (2026-05-22):** eliza-chibi + milady-chibi were previously in the unconditional tier-2 loop — 10.8 MB fetched for every user on every page load. On Iris Xe the parse cost per VRM is estimated 150–400 ms at this file size. Moving them to the lazy tier saves these resources for non-chibi players (~98%).

**SW cache manifest:** `WORLD_PRELOAD_MANIFEST` still includes `CHIBI_VRM_PATHS` so the service worker precaches them on first install — lazy fetches hit disk, not the network.

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

**Slot cabinets (Concern 6.0.5, updated 2026-05-19 bonus differentiation):** 4 cabinets at x=−383wu (=−BOUNDS_X), z ≈ −583 / −333 / −83 / +166wu (room-scaled). Each = base (world-scale 16wu tall) + body (world-scale 143wu tall) + emissive screen (79wu tall, cyan, emissiveIntensity 1.2) + lever (CylGeo r8 h56wu, red). Width/depth room-scaled (×3.333). Cabinet top = 16+143 = 159wu = 59% of 270wu avatar → chest height. All geometry module-scope. Rotated π/2 (face into room). `matrixAutoUpdate=false`. **Cabinet differentiation (2026-05-19):** cabinets 0+1 (z≈−583,−333) = classic (`CABINET_BODY_MAT` dark purple, `machineSlug:'classic-3x5'`). Cabinets 2+3 (z≈−83,+166) = bonus (`CABINET_BODY_BONUS_MAT` gold-tinted, emissiveIntensity 0.18, `machineSlug:'classic-3x5-bonus'`). Bonus cabinets also render a 120×30wu BONUS badge plane (canvas texture with pill + "💎 BONUS" text, built once at module scope) at Y=194wu. Draw calls: 18 (4 cabs × 4 meshes + 2 bonus badges).

**Casino input (updated 2026-05-19):**
- **WASD** — avatar movement only (`casinoKeys` w/a/s/d). Single-char guard: `e.key.length === 1 ? e.key.toLowerCase() : null`.
- **Arrow keys** — camera perspective-orbit ONLY; avatar never rotates from arrows (mirrors world `ArrowKeyRotationController`). Implemented via separate `_casinoArrowKeys` + `attachCasinoArrowListeners()`. `ArrowLeft/Right` → horizontal orbit yaw accumulates at `ARROW_YAW_SPEED=1.5 rad/s` (added to `_casinoCamYaw` as `_casinoArrowYawOffset`). `ArrowUp/Down` → camera height offset accumulates at `ARROW_PITCH_SPEED=200 wu/s`, clamped to `[-100, +400]` wu relative to `CAM_ABOVE=190`.
- **Avatar yaw lerp** — `0.08` (was 0.15). At 60fps spreads a 90° turn over ~35 frames (0.58s); prevents visible per-frame snap on A/D press.
- **Camera AABB clamp** — `clampCameraToRoom(_camDesiredPos, CASINO_ROOM_BOUNDS)` applied every frame before position lerp. `CASINO_ROOM_BOUNDS = { halfX:383, zMin:-900, zMax:900, yMin:30, yMax:600, margin:50 }`. Prevents camera clipping outside room walls (black void). Implemented in `apps/web/src/lib/three/room-camera.ts` (reusable utility).

**Casino camera (bug-fix 2026-05-18, updated pass 2):** Module-scope `_casinoCamYaw` (init π, reset to π on mount in both branches) lerps toward avatar `rotRef.current` at `CAM_YAW_LERP=0.05` (vs avatar turn rate 0.15). Both VRM (`CasinoVRMAvatarInner`) and GLB (`CasinoGLBAvatarInner`) branches use `_casinoCamYaw` for behind-position, not the avatar's live yaw — prevents 45° viewport snap on A/D press. `CAM_ABOVE=190wu CAM_BEHIND=450wu CAM_LOOK_Y=70wu` (recomputed proportionally for 160wu avatar: ×1.19 above, ×2.81 behind, ×0.44 look).

**Hotspots — GLB BANK-DISCOVERY (canonical procedure, added 2026-05-22):**

Slot-machine hotspots are discovered at runtime from the GLB instead of being hardcoded. This is the **standard procedure for any interior with a multi-paytable slot bank** going forward — re-use it for new game rooms.

**Why discovery over hardcoded boxes:** the GLB gets edited (artifact cleanup, table moves, cabinet swaps) and any hardcoded cabinet centroids drift out of date silently. Discovery re-derives positions from the current GLB on every load, so a Blender edit ships without a code change.

**Pipeline:**

1. **Filter for bank-row meshes** — scene-traverse all `THREE.Mesh` (skip skinned), build per-mesh bbox. Keep meshes that match ALL:
   - `h ∈ [1, 200]` wu (flat-ish — cabinet bases / tops are thin)
   - `w ∈ [400, 1000]` wu (one bank-row wide)
   - `d ∈ [250, 500]` wu (one row deep)
   - `yMid ∈ [30, 200]` wu (floor-level)
   - `volume ≤ 30M wu³` (rejects the room shell — which spans 485×400×1999 = 388M)
   Diagnostic log every skip with the failing axis: `skipped (h=400,d=1999,vol=388M)`.
2. **Union into one bank bbox** — `(minX, maxX, minY, maxY, minZ, maxZ)` across all matched cluster meshes.
3. **Split along X** at `splitX = (minX+maxX)/2`. Left half → classic. Right half → bonus.
4. **Emit TWO `HotspotDef`** records (one per half):
   ```ts
   { position: centroid,                  // (cx ± halfW/2, clickCenterY=110, cz)
     size:     [halfHotspotW, clickHeight, depth + reach],
     machineSlug + paytableId: 'classic-3x5' (left) or 'classic-3x5-bonus' (right),
     isBonus:  false / true }
   ```
   `halfHotspotW = halfW * 0.92` — 4% seam gap at the split prevents both hotspots double-hitting a click on the exact center line. The Phase 6.1.16 bug (`halfW + reach`) had the boxes overlapping the full bank width; the array-first (classic) hotspot then always won the raycast, so bonus clicks opened classic.
5. **Always render TWO `BankBanner` labels** (procedural `THREE.CanvasTexture` + `PlaneGeometry`) at `(classicCentroid[0], 280, classicCentroid[2])` and `(bonusCentroid[0], 280, bonusCentroid[2])`. Banner Y is **pinned to 280wu** (just above cabinet tops, below ceiling) — never computed from bbox centroid + offset, since floor decals + ceiling trim in the same material can drag the centroid out of view.
6. **Fall back to `GAMEREADY_HOTSPOTS`** (hardcoded by tile-zone) if no cluster mesh matches. Last-resort `FALLBACK_HOTSPOTS` is for the cartoon GLB path.

**`HotspotDef` shape:** `{ position: [x,y,z], size: [w,h,d], machineSlug: MachineSlug, paytableId: MachineSlug, isBonus: boolean }`.

**`SlotHotspot` component:** invisible `boxGeometry` + `MeshBasicMaterial visible={false}` at `def.position`. `onPointerOver` sets `document.body.style.cursor = 'pointer'`. `onClick` → `openSlotScreen(def.machineSlug, def.paytableId, avatar.clawTokens ?? 60)`. `e.stopPropagation()` on every pointer event to prevent the wrapper group from claiming hits.

**E-key proximity (still hardcoded constants — pending sync to discovery):** `CLASSIC_BANK_CENTROID_X/Z` + `BONUS_BANK_CENTROID_X/Z` at module scope; `BANK_INTERACT_ARM=200` wu. The arm logic doesn't yet read from discovered centroids — fix forthcoming, until then E-key may not arm if the GLB shifts.

**Phase 6.4.0 — Blackjack table hotspot (right wall, dealer station):** `BlackjackTableHotspot` component in `cove-interior.tsx`. Invisible `boxGeometry` (200×200×150 wu) at `_BJ_HOTSPOT_POS = [307, 100, 0]` (derived from `_DEALER_CENTER_X=367` minus 60wu reach-into-room offset, same Z as dealer-station AABB centre). `onClick` → `useCoveStore.openBlackjackTable(avatar.clawTokens ?? 0)`. `onPointerOver` sets cursor pointer. A green `BankBanner` label ("BLACKJACK", `#22dd88`) is pinned at Y=280wu above the hotspot — same banner style as Classic/Bonus slot labels. The blackjack table mesh in the GLB has the dealer station AABB collision box already registered (solid `halfX=100, halfZ=100`) so players cannot walk through the table. Connection SKILL.md endpoint + hosted-agent skill memory for blackjack intentionally deferred to Phase 6.4.2 per `cove-blackjack.md` plan.

**Cache-bust on GLB swap:** every replacement of `cove-interior.glb` MUST bump `?v=N` in the `INTERIOR_GLB` URL (currently `?v=2`). Cloudflare edge cache TTL is 7 days, deploy token has no `cache_purge` scope. See §6f rule 9.

**Camera:** Canvas fov 65, near 1, far 2000, initial position `[0, 55, 400]`. Follow-cam steady state: 55wu above, 160wu behind avatar. Interior fog: `0x0a0015`, near 400, far 1200. Camera frozen during slot modal (`slotScreenOpen === true`).

**Exit position:** `CASINO_EXIT_PX = (2000, 5760)`. Math: slot 9 W → cx=50 tiles → worldX=−4160wu; exit = −3760wu = game-px x=2000.

**Navigation hook (Concern 6.0.3):** `arena-buildings.tsx` casino onClick calls `triggerCasinoWalkIn()` — a module-scope function (not a hook; uses Zustand `.getState()` directly). In `'player'` / `'npc'` / `'autonomous'` modes: sets a two-point `clickPath` to `CASINO_DOOR_PX = (940, 5760)`, polls `avatarPositionRef` via rAF until within `200wu` or `1500ms` elapsed, then fires `useTransitionStore.triggerTransition({ to: '/casino' })`. In `'explore'` mode: skips walk, fires transition immediately.

**Spawn fix (Concern 6.0.3):** `avatarPositionRef` and `avatarPosition` initial/reset values updated to `(5760, 6140)` — Phase 6.2 world center (5760, 5760) + 380 game-px south offset.

**Out of scope (Concern 6.0.2):** ~~walk-in animation (6.0.3)~~ (shipped), 2D slot screen (6.0.4), backend RNG/wager program (6.1+).

### 10d. Slot Modal R3F Reel Rig (`apps/web/src/components/casino/SlotReels3D.tsx` + `SlotReelsCanvas.tsx`)

Added Phase 6.1.6, rewritten Phase 6.1.7→6.1.8 (per-cell-plane drum wheel).

**Files:**
- `SlotReels3D.tsx` — R3F scene content (must be inside `<Canvas>`).
- `SlotReelsCanvas.tsx` — `<Canvas>` wrapper, `width:100% height:100%` flex child, `frameloop='always'`, DPR `[0.55,0.7]` low-end / `[0.75,1]` desktop, `preserveDrawingBuffer:true`. OrthographicCamera `left=-8.5, right=8.5, top=2.2, bottom=-2.2, near=0.1, far=30, position=[0,0,10]`.
- `SlotScreenModal.tsx` — mounts `SlotReelsCanvas` in a `flex:1 minHeight:50vh` reel area, with `SlotHUD section="top"` and `section="bottom"` strips sandwiching it. `spinTrigger` counter drives animation.

**Reel geometry (per-cell-plane drum wheel — Phase 6.1.8):**
- `PLANES_PER_DRUM = 12` quads arranged in a circle around the X-axis (horizontal drum axle) at `DRUM_RADIUS = 1.5wu`. Step angle = 30°.
- Each plane: `CELL_WU = 0.76wu` square. Face k at local position `[0, 1.5×sin(k×30°), 1.5×cos(k×30°)]` with `rotation.x = k×30°` so its normal faces radially outward.
- `REEL_SPACING = 3.2wu` (> 2×DRUM_RADIUS = 3wu). 5 reel centres at `x = (r-2) × 3.2`, outermost edges ±7.9wu — fits ortho bounds ±8.5wu.
- Camera at +Z: face 0 (angle=0) faces viewer directly (mid symbol). Faces ±1 (±30°) show top/bot symbols slightly angled. Side faces (±2 to ±5) visible at progressively steeper angles — gives mechanical drum curvature.
- `RingGeometry(1.45, 1.65, 64)` bezel rings at `y = ±(DRUM_RADIUS×sin(30°) + CELL_WU/2 + 0.06) ≈ ±1.19wu`, `rotation.x = −π/2`. 2 bezels × 5 drums = 10 ring meshes.

**Textures:** `~11` unique symbol textures (`TILE_PX = 192×192px`) — one per symbol ID. Built once per unique symbol, shared across all 60 plane materials. Purple `#6b3aa0` rounded-corner card, emoji centred, label at bottom. Distinct emojis per BAR tier: BAR=`1️⃣`, BAR×2=`2️⃣`, BAR×3=`3️⃣` (previously all three used `🎰` — indistinguishable at display size). GPU memory: ~2.1MB (11 textures × 192² × 4B × 1.33 mipmap overhead). Per-face `MeshBasicMaterial` holds a pointer to one symbol texture. On spin, faces cycling through the back (angle≈π) get their `.map` pointer swapped to the next strip symbol — zero texture rebuilding, only JS reference update + `mat.needsUpdate = true`.

**Spin phases per reel (group.rotation.x):**
- ACCEL (200ms): 0 → `MAX_RAD_PER_SEC = 2 × 2π ≈ 12.6 rad/s`, easeInQuad. (2 RPS cap — 4 RPS produced 1.6 planes/frame at 30fps = wagon-wheel strobe on Iris Xe.)
- STEADY: hold MAX_RAD_PER_SEC until `DECEL_AT[r]` and `targetSet`.
- DECEL (600ms, stagger 1800/2200/2600/3000/3400ms L→R): tween `rotation.x` → `targetRot`, easeOutCubic.
- POP (120ms): overshoot `STEP/3` then spring back. Fires `onReelsSettled` after last reel.

**Deterministic landing:** `findStripPosition(strip, top, mid, bot)` → strip position `p`. `stripPosToAngle(p)` maps p → drum stop via `round(p × 12 / 84)` → `targetRot = rotation + forward_delta_to_stop`. At landing, face at drum stop is front-facing; texture was assigned during spin's back-crossing swaps. `anim.targetSet` flag prevents double-computation; no `isSpinning` guard (deadlock fix from 6.1.5).

**Iris Xe invariants:** 60 plane meshes + 10 bezel rings = 70 meshes total. 2 shared geometries (PlaneGeometry, RingGeometry). `~11` symbol textures + 1 shared bezel material. No per-frame allocations — only pointer swap (`mat.map = ref`) + `rotation.x` scalar mutation. No drei Text/Billboard. `MeshBasicMaterial` only (DoubleSide — prevents hollow-drum void visible through side planes), no shadows, no ShaderMaterial. `compileAsync` fired once on mount.

---

### 10e. Win Cascade Overlay 3D (`apps/web/src/components/casino/WinCascadeOverlay3D.tsx`)

R3F component used by impl-1's `SlotReels3D` to highlight winning cells after stop-pop completes.

| Prop | Purpose |
|---|---|
| `winningCells: WinCell[]` | `{reel:0..4, row:0..2}[]` derived from `SpinResult.winningLines` — deduplicated by caller |
| `wildMultipliers?: WildMultiplier[]` | Wild-multiplier cells get brighter magenta glow + DOM label |
| `active: boolean` | Flip `true` after `onStopComplete`; `false` clears cascade |
| `onCascadeComplete?: () => void` | Fires after last cell + 800ms hold |
| `originX/Y/Z`, `reelSpacingX/Y`, `glowNormalZ` | Cylinder coordinate system from impl-1 (defaults: origin=0, spacing=90wu, normalZ=+1) |
| `canvasRect?: DOMRect\|null` | `gl.domElement.getBoundingClientRect()` — required for wild-label DOM projection |

**3D geometry:** `GLOW_PLANE_GEO` 80×80wu `PlaneGeometry` + `RING_GEO` torus (r=38, tube=2.5). Template materials at module scope; each `CellGlow` clones 2 materials on mount to avoid shared-material opacity bleed across concurrent glows (max 30 material instances during animation). `MeshBasicMaterial` + `AdditiveBlending` + `depthWrite:false` — Iris Xe safe.

**Stagger:** 200ms per cell in reel order (reel asc, row asc). `onCascadeComplete` at `(nCells−1)×200 + 800ms`.

**Wild labels:** `createPortal(…, document.body)` DOM overlay with `position:fixed` chips positioned via `camera.project()` at 30Hz. Falls back to no labels if `canvasRect=null`.

**Iris Xe invariants:** no drei Text/Billboard, no per-frame allocs (module-scope scratch only), `MeshBasicMaterial` only, `group.visible` toggling instead of conditional render to avoid mount/dispose churn.

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

- 2026-05-21 — Quest+Bounty Pavilion: new `quest-bounty-pavilion.tsx` mounts the `Can You Dig It?` octagonal pavilion GLB (8.7 MB optimized from 35 MB raw via gltf-transform dedup→metalrough→resize 1024→webp). Position (0, groundedY, −1220) i.e. 1100 wu behind town-directory-sign. Size 1080 wu (matches stalls after their 15% reduction: 1020 / 1105). Left half-zone → `openQuestBoard()`, right half-zone → `openBountyBoard()`. Two bio-luminescent labels (cyan "Quests", amber "Bounties") above each half via WorldLabel rig. Standalone `bounty-board-object.tsx` removed; collider `bounty-board` (50, 0) → `quest-bounty-pavilion` (0, −1220) radius 320. World3DCanvas mount swapped. §2h prop colliders table updated.
- 2026-05-19 — Phase 6.1.8 adversarial pass (3da-impl-2): MAX_RPS 4→2 (4 RPS = 1.6 planes/frame at 30fps = wagon-wheel strobe on Iris Xe); faceMaterials FrontSide→DoubleSide (prevents hollow-drum void visible through side planes). §10d spin phases + Iris Xe invariants updated.
- 2026-05-19 — Phase 6.1.8 reconciler (3da-impl-2): BAR/BAR×2/BAR×3 emojis disambiguated (1️⃣/2️⃣/3️⃣ — were all identical 🎰); TILE_PX 128→192 for sharper mipmap steps (~2.1MB GPU). §10d textures entry updated.
- 2026-05-19 — Phase 6.1.8: per-cell-plane drum wheel. 12 PlaneGeometry quads per reel orbiting X-axis at DRUM_RADIUS=1.5wu. ~11 shared 128×128 symbol textures. Ortho camera left=-8.5/right=8.5/top=2.2/bot=-2.2. Texture-swap at back-crossing = zero rebuild cost. §10d rewritten.
- 2026-05-19 — Slot reel camera fix (Phase 6.1.7b): camera `z=120 fov=60` → `z=45 fov=50`, far 200 preserved. Geometry decoupled: `RADIUS=8wu HEIGHT=15wu SPACING=18wu` (frisbee 13.37×3 replaced). Bezels `RingGeometry(7.85,8.15,64)`. Drums now fill 36% vertical / 93% horizontal at prod 2.32 aspect. §10d updated.
- 2026-05-19 `812fea9` — Slot reels `frameloop='demand'`→`'always'`: demand mode with no `invalidate()` call kept the GL canvas transparent-black on mount (no first frame ever committed). Modal-scoped continuous loop is acceptable. Added `[SlotReels3D]` mount + texture-build diagnostic `console.log`s (not prod-gated; remove before tagging 6.1.6). §10d updated.
- 2026-05-19 `65b860e` — Slot reels CylinderGeometry → PlaneGeometry refactor: cylinder radius `13.4wu` had camera (`z=5`) sitting INSIDE the drum surface → zero pixels. Replaced with 5 × `PlaneGeometry(1wu × 3wu)` panels, vertical-strip texture (1 col × 84 rows × 128px), scroll via `texture.offset.y` instead of mesh rotation. Motion blur via `texture.repeat.y` v-compression. Same `findStripPosition` deterministic landing logic. §10d rewritten.
- 2026-05-19 — Slot modal R3F reel rig (initial): new `SlotReels3D.tsx` + `SlotReelsCanvas.tsx` (Canvas wrapper, DPR-capped, `compileAsync`). `SlotScreenModal` integrates via `spinTrigger` + `winningCells3D`. `CLASSIC_LINES` import added. §10d added.
- 2026-05-19 — Cabinet differentiation + WinCascadeOverlay3D: `HotspotDef` gains `paytableId` + `isBonus`; cabinets 0+1 classic, 2+3 bonus (gold tint + canvas BONUS badge at Y=194wu); click handler now routes `def.paytableId`. New `WinCascadeOverlay3D.tsx`: additive glow+ring cascade (200ms stagger), per-instance material clones, wild-label DOM portal via camera projection. §10c + §10e updated.
- 2026-05-22 — Wave 3 perf (Win G): `applyFattenedFrustumCulling` exported from `vrm-loader.ts`; 7 defensive `frustumCulled = false` traversals replaced across `arena-npcs.tsx` (×2), `arena-location-npcs.tsx`, `player-avatar.tsx`, `town-guide.tsx`, `quest-npc.tsx`, `cosmetic-loader.tsx` (×1). §6f rule 10 added.
- 2026-05-22 — Wave 2 perf: (D) dead `BuildingPedestal` + `_pedestalMaterial` declarations removed from `arena-buildings.tsx` (pedestals removed 2026-05-21, dead code now cleaned). (E) `MergedDecorationsInner` confirmed live in `arena-terrain.tsx` — decoration merge already implemented. (F) `CHIBI_VRM_PATHS` split from `PLAYER_VRM_PATHS`; tier-2 preload loop now skips chibis; `preloadChibiVrm(modelKey)` exported and wired in `game/page.tsx` on `avatar.modelKey` check. Saves 10.8 MB + ~150–400ms parse for non-chibi users. §9e added.
- 2026-05-22 — Wave 1 perf: `LOW_END_NPC_CAP=6`, spring-bone distance LOD (mod=2/4/8 tiered), `fog.far` 15000→16000. Commit `173097bb`.
- 2026-05-22 — Per-GLB collision rework + walkable surfaces: `Collider2D` gains `walkable`/`topY`; `clampMovement2D` returns `groundY`; player-avatar.tsx (VRM+GLB) + arena-npcs.tsx (GLBNpcMesh+VRMNpcMesh) consume `groundY` via `effectiveFloorY = Math.max(terrainY, walkableY)`; all call sites pass `ENTITY_HALF_CHIBI`/`ENTITY_HALF_HUMANOID`. Shisha-oasis collider reworked: wrong (1273,−120) single AABB → two-zone (1178,−240): `shisha-approach` walkable halfX=348 halfZ=340 topY=38, `marketplace-stall` solid halfX=200 halfZ=195. Server sync: `world-colliders-data.ts` `ServerCollider2D` gains `walkable`/`topY` fields + same shisha entries. Total colliders: 19 → 20. §2h updated.
- 2026-05-19 — World colliders: new `collision/world-colliders.ts` (19 disc colliders — 12 buildings ≈190wu + 7 town-center props 50–220wu). `clampMovement2D` radial push-out with slide-along-wall feel + escape hatch for inside-collider spawn. Integrated into player-avatar.tsx (VRM+GLB branches) + arena-npcs.tsx (GLBNpcMesh+VRMNpcMesh useFrame) + arena-location-npcs.tsx (spawn-time sanity push-out). Zero per-frame allocations (module-scope scratch). scaleFactor=0.85. §2h added.
- 2026-05-18 — Phase 6.2.2: MAX_FOOTPRINT 1800→2000wu; node name bug fixed (`The_Krusty_Krab`/`Squidward_s_House` → literal `"The Krusty Krab"`/`"Squidward's House"` — Three.js GLTFLoader preserves verbatim names); targetMaxDim bumps: messaging-channels 1000→2500, api-integrations 1300→2500, cron-automation 1300→2200, memory-rag 1400→1700; memory-rag childScale 1.4→1.7. Sandy NPC T-pose: `extendLoaderWithMeshopt` added to useGLTF + preloads; `clipAction(idleClip, cloned)` with explicit optionalRoot; `reset().setLoop(LoopRepeat).play()` chain. §2 slot table + footprint cap + childScaleOverrides doc + bodyAnchorChild doc updated.
- 2026-05-18 — Bio-luminescent label system: Fraunces capsule + dashed-cyan tether + pulsing anchor dot on all NPC/building labels. `fadeBaseOpacity` 0.65 → 0.85 for NPC labels. Two CSS keyframes in `globals.css`. `--font-fraunces` in `layout.tsx`. §5d WorldLabelsOverlay row updated.
- 2026-05-18 — `childScaleOverrides` differential scaling: Squidward house head ×1.4, Krusty Krab restaurant ×1.5; stepping stones/sign remain at base scale. Both buildings targetMaxDim 1000→1400. `applyChildScaleOverrides()` added to `arena-buildings.tsx`; runs post-strip, pre-merge so scales bake into vertex positions.
- 2026-05-18 — Phase 6.2: grid 240→360 (MAP_WIDTH 7680→11520wu), ring R=100→160 (3200→5120wu), center tile (120,120)→(180,180). `computeBuildingScale` max(X,Y,Z) normalization via `targetMaxDim`. NPC_INSET_WORLD 1000→1300wu (Patrick's Rock clearance). Sandy Treedome DoubleSide transparent-mat fix. DECO_INNER_EXCLUSION_R 1500→800wu. Town-center props spread to 800–1000wu radius. pathfinding COLS/ROWS, npc-simulation ranges, NPC home coords, all 12 building zones, map-locations positionX/Y updated.
- 2026-05-22 — NPC speech-bubble occlusion fix: `BUBBLE_Y` 20→150 wu (`npc-speech-bubbles.tsx`). At Y=20 the camera→anchor ray struck base-platform triangles from above (+Y normals = back-face hit); FrontSide materials cause Three.js Raycaster to skip back-face hits → 0 intersections → bubble showed over structure. At Y=150 the ray hits wall/canopy front-face triangles → correctly hidden. Also: `occlude: true` added to `useWorldLabel` + proximity fade tightened 4000/10000 → 1800/5000 wu.
- 2026-05-22 (prior) — NPC speech-bubble parity with name tags: `npc-speech-bubbles.tsx` adds `occlude: true` to `useWorldLabel` (same 10 Hz staggered raycast against `userData.isOccluder` meshes that name tags use) — bubbles now hidden behind buildings, shisha-oasis, bazaar/marketplace stalls, auction podium, quest pavilion, town-directory sign, Nori. Proximity fade tightened 4000/10000 → 1800/5000 wu (off-ring chatter was cluttering the screen). No infra change in `world-labels-overlay.tsx` — feature was already shipped, just unused for bubbles.
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

- 2026-05-23 — **Experimental: Nanite-style GPU rasterizer spike** (worktree `perf/meshlet-integration` only, NOT on master). Two new files: `apps/web/src/lib/three/experimental/nanite-rasterizer.ts` (exports `NaniteRasterizer`, `geometryToMeshletAsset`, `MeshletAsset`, `RasterizerOptions` — 5-pass compute pipeline: Clear→Frustum→Dispatch→Rasterize→HWArgs, visibility buffer, SW barycentric rasterizer, HW fallback scene) and `apps/web/src/app/preview/meshlet-spike/page.tsx` (loads `building-lighthouse.glb`, single instance, DOM FPS overlay, WebGPU-only — blank/error if `navigator.gpu` absent). Route: `/preview/meshlet-spike`. No production-rendering files touched; spike is fully isolated.

Older history: `git log apps/web/src/lib/three/ apps/web/src/components/three/`.
