# opus-D5 — 3D / RENDER / PERF / FRONTEND — Forensic Audit

## Summary
The render + client layer is the most mature, disciplined subsystem I audited. Every hard Iris-Xe crash ban is respected in production code: **no drei `<Text>`/`<Billboard>` in any world scene** (all labels are DOM `<Html>`/`WorldLabelsOverlay`), **no `InstancedMesh + ShaderMaterial`** (every `<instancedMesh>` uses `MeshBasicMaterial`; seaweed is merged-geometry + TSL, not instanced), **`camera.far` (11500) ≥ `fog.far` (10500)**, world point-light count ≤5, and scratch-vector discipline in `useFrame` is pervasive and explicitly documented. VRM sizing/facing/spring-bone/cache invariants all hold. `camera-cull.ts` uses a view-space dot product (not NDC-z), so the reversed-Z label regression stays fixed.

Worst issue: a **latent unbounded memory leak + dead cosmetic feature** — the `particle`-variant cosmetic emits into a module-level `pendingRequests[]` queue that nothing ever drains because `<ParticleSystem>` is mounted nowhere. No BLOCKERs or crash-ban violations found in the render layer.

Headline count: **0 BLOCKER · 0 HIGH · 2 MEDIUM · 4 LOW.**

## Findings

### [MEDIUM] Particle-cosmetic VFX is dead + unbounded queue leak — apps/web/src/lib/three/particle-system.tsx:149-154 + cosmetic-loader.tsx:736
- What the code does: `emitParticles()` pushes a `ParticleRequest` onto a module-scope array `const pendingRequests: ParticleRequest[] = []` (particle-system.tsx:149-154). The ONLY code that drains that array is `ParticleSystem`'s `useFrame` (`pendingRequests.shift()`, line 211). `<ParticleSystem>` is imported/exported but **mounted nowhere** (`grep '<ParticleSystem'` → 0 hits). Meanwhile `ParticleRenderer` (cosmetic-loader.tsx:711-746) — mounted whenever a player has an equipped `particle`-type cosmetic — calls `emitParticles({...})` at `emitRate` (default **2/sec**) inside its own `useFrame`.
- Why it's wrong/risky: (1) The queue is never consumed → `pendingRequests` grows forever for the whole session. (2) The particle cosmetic renders **nothing** — it is a purchasable/equippable CT cosmetic that produces zero visual output (scaffolding theater per CLAUDE.md "no fake feedback loop"; also a soft economy defect — paid SKU, no effect).
- Failure scenario: a player equips a `particle` cosmetic and roams for 60 min → `pendingRequests` accumulates ~7,200 never-freed objects (×N for every particle-cosmetic avatar in view). Steady leak, no upper bound, no visual payoff.
- Fix: either mount `<ParticleSystem />` inside the R3F world tree (so `pendingRequests` is drained and particles actually render), or gate `ParticleRenderer`/`emitParticles` behind a check that no-ops (and clears the queue) when no sink is mounted. If the feature is deferred, add a `FEATURE_GATE` block and stop `ParticleRenderer` from pushing. At minimum, cap/clear `pendingRequests` when it exceeds a bound.

### [MEDIUM] Apple M-series desktop is force-routed to WebGL2 + low DPR, contradicting stated WebGPU intent — apps/web/src/lib/three/gpu-tier.ts:33 vs components/three/World3DCanvas.tsx:2041-2064
- What the code does: `INTEL_PATTERNS` includes `/apple gpu/i` (gpu-tier.ts:33). `detectLowEndGpuClass()` (gpu-tier.ts:101-123) returns `true` for any renderer string matching that list, and `World3DCanvas` feeds `LOW_END_GPU_DETECTED` into `FORCE_WEBGL` (line 2062-2064) AND into the low DPR cap `[0.5,0.65]` (line 2246). Desktop Safari on Apple Silicon commonly reports the masked renderer string `"Apple GPU"`.
- Why it's wrong/risky: `World3DCanvas.tsx:2043` explicitly states "Dedicated desktop GPUs (NVIDIA / AMD / **Apple M-series**) still get WebGPU." But `"Apple GPU"` → `looksIntel=true` → `FORCE_WEBGL=true` + low-end DPR floor. So M-series Macs on Safari get the WebGL2 fallback and a softer 0.5–0.65 DPR, the opposite of the documented intent. This is a perf/quality regression on a capable class, and an intent/doc contradiction.
- Failure scenario: user on an M2 MacBook in Safari loads `/game` → classified low-end → WebGL2 + 0.5 DPR, when WebGPU + full DPR was intended for that class.
- Fix: decide the intent. If Apple Silicon should get WebGPU (per the comment), drop `/apple gpu/i` from `INTEL_PATTERNS` or split it into a separate "mobile/iOS-only" bucket (iOS already forces WebGL via `IOS_SAFARI`). If forcing WebGL2 on desktop Safari is deliberate (Safari WebGPU maturity), fix the `World3DCanvas.tsx:2043` comment to say so. Either way, reconcile code and comment in the same diff.

### [LOW] `useFrame` allocates a fresh array via `.filter()` every frame — apps/web/src/lib/three/particle-system.tsx:258
- What the code does: inside `ParticleSystem`'s `useFrame`, `const currentActive = pool.filter((p) => p.active)` runs every frame; the comment (256-257) claims it "avoids calling pool.filter() in the render body every frame" but the filter now runs in the frame body.
- Why it's wrong/risky: `.filter()` allocates a new array each frame = GC pressure, the exact category the Iris-Xe "no per-frame allocation" ban targets. Currently **moot** because `<ParticleSystem>` is never mounted (see MEDIUM above), but it becomes live the moment that component is mounted to fix the leak.
- Failure scenario: after mounting `<ParticleSystem>` to fix Finding 1, this allocates one array/frame (bounded by pool size) → minor sustained GC churn on Iris Xe.
- Fix: track active count with a counter mutated in the update loop instead of `pool.filter()`; only rebuild the render list when the count changes (which the `[...currentActive]` guard already tries to do).

### [LOW] `new THREE.Color()` inside a world-scene `useFrame` — apps/web/src/lib/three/floating-text-3d.tsx:63
- What the code does: `FloatingTexts3D` (mounted in the main world under `showActivityFx`) allocates `new THREE.Color(color)` inside `useFrame` when draining pending floating-text requests (line 63).
- Why it's wrong/risky: technically a per-frame-path allocation. In practice it only fires when `consumeFloatingTexts()` returns items (token-earn events, rare), not every steady-state frame, so real GC impact is negligible — but it violates the letter of the "no allocation in useFrame" invariant and is the kind of thing that drifts.
- Failure scenario: a burst of reward events allocates a handful of `Color` objects; harmless today, but sets a precedent.
- Fix: parse the color into a pre-allocated scratch `THREE.Color` via `.set(color)` reused across the pending loop, or precompute the `THREE.Color` at the call site that enqueues the floating text.

### [LOW] Stale in-file comment: `VRM_AVATAR_TARGET_HEIGHT_WU` — apps/web/src/lib/three/vrm-avatar-sizing.ts:17
- What the code does: the module JSDoc (line 17) says avatars render at "`VRM_AVATAR_TARGET_HEIGHT_WU = 179.2 world units tall`", but the exported constant is `270` (line 47), and the constant's own JSDoc (33-46) correctly documents the 179.2→270 iteration.
- Why it's wrong/risky: contradictory documentation in the same file; a future reader trusting line 17 would mis-size a new VRM render site.
- Fix: update line 17 to `= 270`.

### [LOW] Verify "total scene point lights = 5" comment stays true — apps/web/src/components/three/World3DCanvas.tsx:1920
- What the code does: the `CoveEntrance` comment asserts "Component owns 2 point lights ... total scene point lights = 5." The world scene itself adds `hemisphereLight` + 2 `directionalLight` (1727-1730, not point lights) and no other `<pointLight>` in the main tree; `CoveEntrance` adds 2. So the point-light total is ~2, well under the 7-light Iris-Xe crash ceiling.
- Why it's worth noting: the "= 5" figure is a hand-maintained count with no mechanical guard; if a future decoration adds point lights, nothing enforces the ceiling. Not a violation today.
- Fix: none required now; consider a dev-mode assertion that counts `PointLight` instances in the world scene against the Iris-Xe budget.

## Governing invariants (enforceable rules for this subsystem)
- **WHEN** adding any 3D text/label to a game/world scene, the change MUST use a DOM overlay (`WorldLabelsOverlay` or drei `<Html>`), NEVER drei `<Text>`/`<Billboard>` — those hard-crash Iris Xe. (Verified clean; keep it that way.)
- **WHEN** rendering many-of-something via `<instancedMesh>`, the material MUST be a plain non-shader material (`MeshBasicMaterial`/`MeshStandardMaterial`); `InstancedMesh + ShaderMaterial`/TSL-node-material silently crashes WebGPU. For animated fields use merged `BufferGeometry` + a TSL `positionNode` on a single mesh (the `merged-seaweed.tsx` pattern), not instancing.
- **WHEN** changing `fog.far` or `camera.far`, the change MUST preserve `fog.far ≤ camera.far` (geometry fully fades to fog before the far-plane cull → no pop) AND keep `camera.far` ≥ the visible building-ring diagonal.
- **WHEN** writing any `useFrame` body, the change MUST NOT allocate (`new THREE.*`, `.clone()`, `.filter()`/`.map()`/`.slice()` that build arrays); reuse module-scope or `useMemo` scratch objects. Enqueue-path allocations (event-driven, not per-frame) are tolerated only if provably not steady-state.
- **WHEN** culling a world-space label by camera position, the change MUST use a view-space test (camera-forward · to-anchor), NEVER NDC-z — NDC-z projection emits ghost labels for anchors behind the near plane (the reversed-Z regression).
- **WHEN** any code calls a module-level emit/enqueue helper (`emitParticles`), the diff MUST guarantee a mounted consumer drains the queue, or the helper MUST no-op/bound the queue when no sink exists — an undrained module array is a session-lifetime leak.
- **WHEN** rendering a humanoid VRM at any site, the change MUST size it via `computeVRMAvatarFit()` (never a flat scale) and face it via `atan2(vx, vz)` (2D-game-y maps to world-z), matching the empirically-verified ClawVille convention.
- **WHEN** idle NPC VRMs are on screen, spring bones MUST be throttled (the `updateSpringBonesOnly(accumulatedDelta)` 15/30Hz path), not driven at full `vrm.update()` every frame; every cloned `SkinnedMesh` MUST have `frustumCulled=false`.
- **WHEN** a static asset at a stable URL (`/models|/avatars|/cosmetics|/skins/*.glb|.vrm`) is mutated, the diff MUST bump a `?v=N` query at EVERY reference AND bump `sw.js CACHE_VERSION` if it is precached — the service worker is cache-FIRST for these paths, so a mutation without a URL change is stale until `CACHE_VERSION` bumps (on top of Cloudflare's 7-day edge TTL).
- **WHEN** gating UI by touch/mobile, the change MUST use the canonical `useIsMobile()` hook (`maxTouchPoints > 1` + coarse-pointer), NEVER a bare `md:`/`max-width` media query (misses iPad Air/Pro/landscape).
- **WHEN** classifying a GPU as low-end (which forces WebGL2 + low DPR), the pattern list MUST match the documented device-class intent in `World3DCanvas` (integrated Intel + touch/mobile), and code + comment MUST agree in the same diff.

## Doc drift (canonical doc vs live code)
- **CLAUDE.md / 3dStructure.md — FPS floor:** CLAUDE.md/brief state "FPS floor 60" (target 80); `World3DCanvas.tsx` governor uses `QUALITY_FPS_DOWN = 58` / `QUALITY_FPS_UP = 59` (line 133-136) — the auto-degrade trigger is 58, not 60. Not a defect (58 is a deliberate hysteresis band under vsync), but the "floor 60" phrasing and the 58 trigger should be reconciled in whichever doc claims the floor.
- **World3DCanvas.tsx:2043 comment vs gpu-tier.ts:** the "Apple M-series still get WebGPU" comment is contradicted by `/apple gpu/i` in `INTEL_PATTERNS` (see MEDIUM finding #2). Code wins; fix the comment or the pattern.
- **vrm-avatar-sizing.ts:17** stale "179.2" vs live `270` (LOW finding #5).
- No drift found between `sw.js` `CACHE_VERSION`/`PRECACHE_GLBS` and the KTX2 asset naming described in its own changelog; the `?v=` scheme is internally consistent.

## Coverage note (what I did NOT fully get to — for the other fleet)
- **Experimental meshlet/nanite path** (`lib/three/experimental/nanite-rasterizer.ts`, `meshlet/*`, `/preview/meshlet-spike*`): only skimmed. It is gated behind `?meshlets=1` (implies WebGPU, uses WGSL atomic compute) so it is NOT the default prod path, but its TSL/compute + any InstancedMesh usage there was not line-audited. Codex fleet should verify it can't crash a curious user who appends `?meshlets=1` on an Iris Xe (the `FORCE_WEBGPU_OVERRIDE` deliberately drops the low-end WebGL guard for that query → potential deliberate WebGPU crash surface on integrated GPUs).
- **Reef-race + bumper-shells activity scenes** (`lib/three/activities/**`): spot-checked the instancedMesh materials (all plain), the shader-material factories (drei `shaderMaterial()`, not paired with instancing), and the "no drei Text" header comments — but did NOT exhaustively read every `useFrame` in those ~30 files for allocations. They are route-isolated activity scenes, lower blast radius than `/game`.
- **Cove interior VRM/lighting** (`cove-interior.tsx`, ~1500 lines): verified 0 `<pointLight>` (cove lights live in `CoveLighting.tsx`, 3 point lights) and `computeVRMAvatarFit` usage; did not fully audit its per-frame bodies.
- **Actual asset-mutation `?v=` compliance:** I verified the `sw.js` mechanism and the invariant, but cannot statically confirm every recently-mutated VRM/animation GLB actually bumped its `?v=` — that requires a git-history diff of `public/` against reference changes (recommend the other fleet diff `public/avatars/**` + `public/models/**` mtimes vs the last few asset commits).
- **Landing/vignette scenes** (`components/landing/*Vignette.tsx`, `LandingScene.tsx`): these DO use drei `<Text>`/`<Billboard>` (grep hits) but are landing/marketing routes, not the `/game` world scene — I treated them as out-of-scope for the Iris-Xe world-scene ban. Worth a second look to confirm none are reachable inside the WebGPU game canvas.
