# codex-D5 — 3D / RENDER / PERF / FRONTEND — Forensic Audit

## Summary

The render layer contains two BLOCKER-class failure paths: renderer fallback can draw into a detached canvas, and the camera far plane no longer covers the expanded world.
The production world-label system also relies on NDC-z culling that is unsafe with reversed-Z and incomplete even under conventional depth.
The Cove’s primary interior asset is 18.8 MB, exceeds the service-worker per-file limit, and is compiled before Suspense guarantees it exists.
Touch-device classification is inconsistent across the shared mobile hook, renderer quality selection, and camera controls.
One activity bypasses canonical VRM sizing and foot-offset logic.
Headline count: **2 BLOCKER, 2 HIGH, 4 MEDIUM**.
No banned drei `<Text>`/`<Billboard>` or `InstancedMesh + ShaderMaterial` production pairing was found.

## Findings

### [BLOCKER] Renderer failure fallback draws into a detached canvas  —  apps/web/src/components/three/World3DCanvas.tsx:2207

- What the code does: If `createWebGPURenderer()` throws, the catch path creates a new `document.createElement('canvas')`, constructs the fallback renderer against that new canvas, and returns it to the existing R3F `<Canvas>` root. The replacement canvas is never inserted into the DOM or substituted for `defaultProps.canvas` (`apps/web/src/components/three/World3DCanvas.tsx:2207`, `apps/web/src/components/three/World3DCanvas.tsx:2210`, `apps/web/src/components/three/World3DCanvas.tsx:2220`).
- Why it's wrong/risky: R3F’s visible DOM canvas remains `defaultProps.canvas`, while the renderer presents frames to `fallbackCanvas`. The recovery path therefore converts an initialization failure into a persistent blank world.
- Failure scenario (concrete inputs -> bad outcome): A browser exposes `navigator.gpu`, but adapter/device initialization fails or WebGPU initialization throws. The catch succeeds with forced WebGL, yet every frame is rendered into the detached canvas and the user sees only the unchanged visible canvas.
- Fix: Reuse `defaultProps.canvas` after disposing any partially initialized renderer/context, or explicitly replace the visible canvas and reconnect R3F events, sizing, and lifecycle to it. Add a forced-init-failure browser test asserting that the renderer’s `domElement` is the actual mounted canvas and that a non-background pixel is presented.

### [BLOCKER] Camera far plane is stale relative to the 22,528-wu world  —  apps/web/src/components/three/World3DCanvas.tsx:2263

- What the code does: The map is now 704×704 tiles, or 22,528×22,528 wu (`apps/web/src/lib/pixi/tilemap-data.ts:20`, `apps/web/src/lib/pixi/tilemap-data.ts:22`). The main camera still uses `far: 11500`, with comments describing the older 576×576 expansion (`apps/web/src/components/three/World3DCanvas.tsx:2257`, `apps/web/src/components/three/World3DCanvas.tsx:2263`). Fog becomes fully opaque at 10,500 wu (`apps/web/src/components/three/World3DCanvas.tsx:1759`).
- Why it's wrong/risky: The half-world diagonal is approximately 15,930 wu, and the initial camera’s offset makes the farthest corners farther still. This violates the audit’s camera-coverage invariant. The clip transition is additionally not color-continuous: fog is `0x0e3458`, while the scene clear/background is `0x0a2a4a` despite the comment saying they match (`apps/web/src/components/three/World3DCanvas.tsx:113`, `apps/web/src/components/three/World3DCanvas.tsx:128`).
- Failure scenario (concrete inputs -> bad outcome): From the initial camera near world center, geometry toward an outer corner exceeds 11,500 wu and is hard-clipped. Fully fogged geometry then transitions to a differently colored background, producing a visible horizon/seam or void instead of continuous haze.
- Fix: Recalculate the far plane from the current world dimensions and maximum permitted camera position, or formally partition/cull the world into local chunks while proving no reachable view exposes the clip boundary. Make fog and clear colors identical at the terminal plane and add a corner-view screenshot test on the Iris Xe profile.

### [HIGH] Production world labels use NDC-z as a behind-camera test  —  apps/web/src/lib/three/world-labels-overlay.tsx:666

- What the code does: The shared production label overlay projects its anchor and hides it when `_scratchPos.z > 1` (`apps/web/src/lib/three/world-labels-overlay.tsx:666`, `apps/web/src/lib/three/world-labels-overlay.tsx:670`). The generic projection helper repeats the same design and claims both NDC bounds matter while implementing only `z <= 1` (`apps/web/src/lib/three/activities/shared/world-to-screen.ts:52`, `apps/web/src/lib/three/activities/shared/world-to-screen.ts:53`).
- Why it's wrong/risky: NDC depth conventions change with renderer coordinate system and reversed-Z. Even under conventional depth, `worldToScreen()` does not reject `z < -1` as its own comment promises. The main world uses `WebGPURenderer` where available and WebGL fallback elsewhere, so an NDC-depth heuristic is not backend-stable (`apps/web/src/components/three/World3DCanvas.tsx:2121`, `apps/web/src/components/three/World3DCanvas.tsx:2129`).
- Failure scenario (concrete inputs -> bad outcome): A label crosses the camera or near plane on a reversed-depth WebGPU device. Its projected z does not obey the assumed conventional test, so the label either disappears while in front or remains visible behind the camera as a ghost DOM label.
- Fix: Determine front/behind status in camera/view space before projection, using `camera.matrixWorldInverse` or a camera-forward dot product. Use NDC only for x/y viewport bounds. Add identical front, behind, near-plane, and far-plane cases under WebGPU, forced-WebGL, and reversed-depth-capable adapters.

### [HIGH] The Cove’s 18.8 MB primary asset is excluded from the service-worker asset cache  —  apps/web/src/lib/three/cove-interior.tsx:66

- What the code does: The Cove selects `cove-interior-cleaned-v1-ktx.glb?v=5` as its primary interior and preloads it (`apps/web/src/lib/three/cove-interior.tsx:66`, `apps/web/src/lib/three/cove-interior.tsx:349`). The tracked binary is 18,832,136 bytes, while the service worker refuses individual assets above 10 MB (`apps/web/public/sw.js:60`, `apps/web/public/sw.js:255`).
- Why it's wrong/risky: The largest interactive-room payload bypasses the cache system intended for GLB/VRM assets. It cannot participate in the service worker’s offline path, and its 18.8 MB transfer/parse cost is especially damaging on the direct-web critical path.
- Failure scenario (concrete inputs -> bad outcome): A user opens the Cove once, later reconnects without network, and the service worker has no cached primary GLB. `cacheFirstGlb()` misses, its fetch fails, and it returns the explicit 503 response (`apps/web/public/sw.js:244`, `apps/web/public/sw.js:274`). On a cold mobile connection, the same oversized payload delays scene availability and parsing.
- Fix: Produce a materially smaller KTX2/meshopt-compatible asset or split the room into cacheable chunks. If the larger file is intentionally retained, raise the individual limit with a revised total-budget analysis and an offline test. Any replacement must keep the versioned URL and bump both the query and service-worker cache version.

### [MEDIUM] Cove pipeline compilation races ahead of the suspended interior  —  apps/web/src/components/three/CoveCanvas.tsx:146

- What the code does: `PreCompilePipelines` schedules exactly one `compileAsync(scene, camera)` on the next animation frame after its own commit (`apps/web/src/components/three/CoveCanvas.tsx:51`, `apps/web/src/components/three/CoveCanvas.tsx:53`). The actual interior is mounted separately inside Suspense (`apps/web/src/components/three/CoveCanvas.tsx:146`, `apps/web/src/components/three/CoveCanvas.tsx:148`), where `useGLTF` can still be suspended on the 18.8 MB asset (`apps/web/src/lib/three/cove-interior.tsx:1583`, `apps/web/src/lib/three/cove-interior.tsx:1584`).
- Why it's wrong/risky: There is no readiness dependency between GLB resolution and compilation. On a cold load, `compileAsync` can compile only the empty/setup scene, leaving the room’s real materials to compile during first presentation.
- Failure scenario (concrete inputs -> bad outcome): With an uncached interior GLB, the next-frame compiler runs while Suspense renders `null`. Once the room resolves, its pipelines compile on the first visible frame, causing the exact entry hitch the precompiler is meant to prevent.
- Fix: Trigger and await compilation after the interior has mounted and compressed textures have uploaded, then reveal/resume the room. Use the ordered readiness pattern already implemented for the main world rather than a one-RAF assumption.

### [MEDIUM] Renderer and camera touch detection omit the canonical iPad signals  —  apps/web/src/lib/three/gpu-tier.ts:114

- What the code does: The canonical mobile hook checks coarse pointer, width, `navigator.maxTouchPoints > 1`, and touch-event support (`apps/web/src/hooks/use-is-mobile.ts:20`, `apps/web/src/hooks/use-is-mobile.ts:25`, `apps/web/src/hooks/use-is-mobile.ts:28`). Initial GPU quality checks only `(pointer: coarse)` (`apps/web/src/lib/three/gpu-tier.ts:114`, `apps/web/src/lib/three/gpu-tier.ts:119`), while main-world controls use coarse pointer or width and are fixed at module load (`apps/web/src/components/three/World3DCanvas.tsx:1620`, `apps/web/src/components/three/World3DCanvas.tsx:1622`). Cove repeats the coarse-pointer-only quality test (`apps/web/src/components/three/CoveCanvas.tsx:38`).
- Why it's wrong/risky: The source itself documents that landscape iPads with keyboards/trackpads can report a fine pointer and desktop-sized viewport, with `maxTouchPoints` being the reliable signal (`apps/web/src/hooks/use-is-mobile.ts:7`, `apps/web/src/hooks/use-is-mobile.ts:10`). Different subsystems can therefore classify the same device differently.
- Failure scenario (concrete inputs -> bad outcome): An iPad in landscape with an attached trackpad reports `pointer:fine`, width ≥768, and `maxTouchPoints=5`. Mobile HUD components render, but the renderer selects the higher DPR range and world controls enable desktop pan/speeds, increasing GPU cost and creating conflicting touch/camera behavior.
- Fix: Move synchronous capability detection into one shared utility containing the same signals as `useIsMobile()`, use it for renderer bootstrap, and subscribe controls to changes rather than freezing the result at module evaluation.

### [MEDIUM] Reef Race bypasses canonical VRM fit and foot-grounding  —  apps/web/src/lib/three/activities/reef-race/ReefRacePlayer.tsx:383

- What the code does: The rider loads a per-avatar VRM instance, then applies a fixed local scale of `5.6` and no computed vertical offset (`apps/web/src/lib/three/activities/reef-race/ReefRacePlayer.tsx:343`, `apps/web/src/lib/three/activities/reef-race/ReefRacePlayer.tsx:383`). The constant is derived from assumed parent and avatar scales rather than measured geometry (`apps/web/src/lib/three/activities/reef-race/ReefRacePlayer.tsx:160`, `apps/web/src/lib/three/activities/reef-race/ReefRacePlayer.tsx:162`).
- Why it's wrong/risky: Other player and room render sites call `computeVRMAvatarFit()` to normalize exporter units and place feet correctly (`apps/web/src/lib/three/player-avatar.tsx:282`, `apps/web/src/lib/three/cove-interior.tsx:1172`). Reef Race silently depends on all official Milady files retaining identical bounds and foot origin.
- Failure scenario (concrete inputs -> bad outcome): An official rider VRM is re-exported with centimeter units, a shifted root, or different shoes/hair bounds. The open world remains correctly fitted, but the same avatar becomes oversized, undersized, or floats/sinks on its board in Reef Race.
- Fix: Call `computeVRMAvatarFit()` for the loaded instance, convert both returned scale and offset into `riderMountRef` local space, and add a multi-avatar bounding-height/foot-position test.

### [MEDIUM] Service-worker eviction repeatedly materializes the entire asset cache  —  apps/web/public/sw.js:153

- What the code does: `cacheByteSize()` calls `cache.matchAll()` and converts every cached response into an `ArrayBuffer` (`apps/web/public/sw.js:143`, `apps/web/public/sw.js:147`). `evictOldest()` invokes that full-cache scan once for every candidate key until the cache falls below 60 MB (`apps/web/public/sw.js:156`, `apps/web/public/sw.js:158`), and it runs after every cached asset write (`apps/web/public/sw.js:265`, `apps/web/public/sw.js:267`).
- Why it's wrong/risky: Evicting multiple entries is quadratic in cached bytes/entry count and repeatedly allocates buffers approaching the full 60 MB budget. This adds avoidable I/O and memory pressure on the same mobile/integrated-GPU devices whose performance is the top constraint.
- Failure scenario (concrete inputs -> bad outcome): A 65 MB cache needs several old entries removed. Each deletion iteration rereads and materializes nearly the entire remaining cache, causing repeated tens-of-megabytes scans instead of one accounting pass.
- Fix: Compute entry sizes once per eviction run and maintain a decrementing total, or store size/age metadata when inserting. Never reread all response bodies after each deletion.

## Governing invariants

- WHEN renderer initialization falls back, the fallback renderer MUST present to the currently mounted R3F canvas, and a forced-failure browser test MUST prove a visible frame (`apps/web/src/components/three/World3DCanvas.tsx:2207`).
- WHEN world dimensions or permitted camera travel change, camera far, fog far, fog color, and clear color MUST be recomputed and corner-view verified together (`apps/web/src/lib/pixi/tilemap-data.ts:20`, `apps/web/src/components/three/World3DCanvas.tsx:1759`).
- WHEN projecting a world anchor for DOM/HUD placement, front/behind classification MUST use view-space z or camera-forward dot product; NDC z MUST NOT determine visibility (`apps/web/src/lib/three/world-labels-overlay.tsx:666`).
- WHEN a GLB/VRM is added to an interactive critical path, its encoded size MUST fit the documented service-worker per-entry and total-cache budgets, or the same change MUST revise those budgets with offline and memory evidence (`apps/web/public/sw.js:60`, `apps/web/public/sw.js:63`).
- WHEN an existing static GLB/VRM/cosmetic asset changes, every runtime, preload, shared-registry, and service-worker reference MUST receive the same bumped `?v=N`, and `CACHE_VERSION` MUST be bumped when the precache roster changes (`apps/web/public/sw.js:55`, `apps/web/public/sw.js:69`).
- WHEN a scene uses Suspense-loaded geometry or materials, `compileAsync` MUST run only after those objects are mounted and texture upload readiness is established (`apps/web/src/components/three/CoveCanvas.tsx:148`).
- WHEN a VRM is rendered at any player, NPC, activity, preview, or room site, the site MUST use `computeVRMAvatarFit()` and apply both scale and foot offset in the correct parent space (`apps/web/src/lib/three/vrm-avatar-sizing.ts:123`).
- WHEN multiple visible entities use the same VRM path, each entity MUST provide a unique stable `instanceId`; parsed VRM scenes, skeletons, mixers, expressions, and spring state MUST never be shared (`apps/web/src/lib/three/vrm-loader.ts:645`, `apps/web/src/lib/three/vrm-loader.ts:649`).
- WHEN device class affects controls, DPR, renderer backend, NPC limits, or visual features, all consumers MUST use one shared touch-capability detector including `maxTouchPoints`, and reactive consumers MUST handle pointer/viewport changes (`apps/web/src/hooks/use-is-mobile.ts:20`, `apps/web/src/hooks/use-is-mobile.ts:25`).
- WHEN adding `useFrame` logic, the change MUST allocate no `Vector3`, matrices, colors, arrays, or transient objects in the hot loop and MUST not emit unguarded React/Zustand updates at frame rate.
- WHEN adding world lighting, the simultaneously mounted scene MUST remain below seven point lights and preserve the documented Iris Xe light budget (`apps/web/src/lib/three/cove-entrance.tsx:513`, `apps/web/src/lib/three/cove-beacon.tsx:311`).
- WHEN using instancing, the material MUST remain a built-in/node-safe material; `InstancedMesh + ShaderMaterial` is prohibited. World scenes MUST likewise prohibit drei `<Text>` and `<Billboard>`.

## Doc drift

- `3dStructure.md` contains contradictory camera contracts: one section says `camera.far=10000` and requires exact equality with fog (`3dStructure.md:407`), while a later section documents live `fog.far=10500` and `camera.far=11500` (`3dStructure.md:427`). Live code matches the latter (`apps/web/src/components/three/World3DCanvas.tsx:1759`, `apps/web/src/components/three/World3DCanvas.tsx:2263`).
- The Cove cache-bust section says `INTERIOR_GLB` is currently `?v=2` (`3dStructure.md:912`), while live code uses `?v=5` (`apps/web/src/lib/three/cove-interior.tsx:66`).
- `arena-npcs.tsx` warns that the loader caches exactly one VRM per path and forbids duplicate paths (`apps/web/src/lib/three/arena-npcs.tsx:950`), but the live loader explicitly keys by `path#instanceId` and returns distinct instances for distinct IDs (`apps/web/src/lib/three/vrm-loader.ts:649`, `apps/web/src/lib/three/vrm-loader.ts:658`).
- The r185 scope reports approximately 56 FPS on a capable production test device but explicitly says the Iris Xe delta was not measured (`docs/threejs-r185-upgrade-scope-2026-07-07.md:8`, `docs/threejs-r185-upgrade-scope-2026-07-07.md:10`). The older audit’s only cited Iris Xe baseline remains 40–45 FPS (`docs/perf-audit-2026-05-22.md:4`), so current compliance with the 60 FPS floor is unverified.
- UNVERIFIED: the requested `docs/perf-audit-r185-2026-07-07.md` was not present in this `origin/master` checkout; no `file:line` citation exists for an absent path.

## Coverage note

This was a static, read-only audit of the specified Three/R3F, game UI, stores, service worker, asset references, and canonical performance documents. I did not build or launch the application because that would create build artifacts, and I did not run browser/GPU captures; actual Iris Xe FPS, draw calls, texture residency, reversed-depth behavior, and viewport overlap remain runtime-verification work. I did not decode and visually inspect every binary GLB/VRM/texture or exhaustively audit unrelated landing/preview-only routes.