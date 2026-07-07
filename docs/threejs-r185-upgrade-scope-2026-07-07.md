# Three.js r182 → r185 Upgrade Scope (2026-07-07)

Status: EXECUTED 2026-07-07 on branch `feat/three-r185-upgrade` (worktree). Outcome vs this scope:
- three 0.185.1 + @types/three 0.185.0 landed; prod build green.
- `positionLocal`→`positionGeometry` applied in merged-seaweed + underwater-atmosphere per the migration guide's recommendation. **Codex source-diff correction:** NodeMaterial's `positionLocal.assign(positionNode)` mechanism is byte-identical 0.170→0.185 — for our non-skinned/non-instanced meshes the swap is a no-op clarity change, NOT a behavioral fix; the migration note's scenario doesn't arise here. nanite-rasterizer positionNode reads storage buffers (NOT positionLocal) — no change needed, verified live.
- BONUS: root `overrides: {"@types/three": "^0.185.0"}` unified the dual-types clash (slot-playground pinned 0.170) — apps/web tsc 464→11 errors, all 11 pre-existing non-three.
- r185 types quirk found: `attribute()` widens its node type to `string` unless the generic is explicit — use `attribute<'float'>(…)`.
- Browser-verified on prod bundle: /game (WebGPU, ~56 FPS, 0 errors), ?meshlets=1 + meshlet-spike-bare (rasterizer OK), cove interior, reef-race-v2, landing (T-pose turntable == prod baseline).
- Fiber emits a `THREE.Clock` deprecation warning under r183+ (upstream, harmless).
- Iris-Xe-floor perf delta NOT yet measured (dev box has capable GPU) — measure on staging/founder hardware.

## Current state

- `apps/web`: `three@0.182.0`, `@types/three@0.182.0`, `@react-three/fiber@9.5.0`, `@react-three/drei@10.7.7`, `@pixiv/three-vrm@3.5.2` (+ animation/mtoon), `three-stdlib@2.36.1`.
- Latest release: **r185 (2026-07-01)**. Three releases between us and latest: r183, r184, r185.
- `apps/slot-playground` is a standalone Vite playground on three 0.170 / fiber 8 — NOT in the deployed product path. Leave it out of scope.

## Why upgrade (perf — maps directly to Priority #1)

We run **WebGPURenderer + TSL** as the primary renderer (`World3DCanvas` imports `three/webgpu`), and r183–r185's biggest wins are exactly there:

- r185: WebGPU descriptor **caching + pooling** (less GC), optimized `submit()` + render-pipeline management, pooled per-uniform update-range objects, UBO update GC reduction, NodeBuilder fast path, node collections Array→Set, FrustumArray optimization, merged update ranges.
- r185: **ClusteredLighting (Forward+)** landed (TiledLighting removed). Not currently used, but relevant to future light budgets.
- r183: improved WebGPU shadow implementation.
- These target per-frame CPU overhead + GC churn — our exact bottleneck class on the Iris Xe floor (40–45 FPS vs 60 floor / 80 target).

Expectation setting: incremental frame-time/GC improvements, not a magic 2×. Measure with the perf-audit methodology (`docs/perf-audit-2026-05-22.md`) before/after.

## Confirmed breaking-change impact in OUR code

Full migration guide: https://github.com/mrdoob/three.js/wiki/Migration-Guide (r182→r183→r184→r185).

### 1. TSL `positionLocal` behavior change (r185) — 3 hit sites, 2 in the live world
> "positionLocal does not update internal vertex transformations in material.positionNode. Use positionGeometry for pre-transformed geometry vertices."

- `apps/web/src/lib/three/merged-seaweed.tsx:446` — `mat.positionNode = positionLocal.add(...)` (seaweed sway, visible everywhere)
- `apps/web/src/lib/three/underwater-atmosphere.tsx:252` — `mat.positionNode = vec3(positionLocal.x.add(swayX), ...)` (particle drift)
- `apps/web/src/lib/three/experimental/nanite-rasterizer.ts:1492` — `hwMaterial.positionNode = Fn(() => {...})` (review whether positionLocal is read inside)

Likely fix: swap `positionLocal` → `positionGeometry` where the intent is "the raw geometry vertex". Must be visually verified (sway amplitude/origin can shift).

### 2. Meshlet rasterizer — HIGHEST RISK, in the live path
`World3DCanvas` → `meshlet/meshlet-buildings-r3f.tsx` → `experimental/nanite-rasterizer.ts` (raw WGSL, compute, TSL `Fn`). r183–r185 churned WebGPU internals (pipeline management, NodeBuilder, descriptor lifecycle). No documented break matches it, but this file exercises undocumented internals. Rule E3 applies: Claude↔Codex collaboration + 3da, with browser verification per iteration.

### 3. `Object3D.updateWorldMatrix()` honors `matrixWorldNeedsUpdate` (r185)
We use `matrixAutoUpdate = false` in ~25+ files (Iris Xe rule). **Audit result: LOW RISK** — every site calls `updateMatrix()` (which sets the flag); grep found **zero** direct `.matrix.copy/compose/multiply` writes. Re-grep at execution time in case new code landed.

### 4. r185 removed bundled decoder libraries (DRACO/KTX2/Lottie) from the package
- Runtime unaffected: basis transcoder already committed at `apps/web/public/basis/` (`basis_transcoder.js/.wasm`); DRACO decoders load from gstatic CDN (`cove-interior.tsx:337`, `CoveVignette.tsx`).
- The compress-ktx2 script comment says it copies from `node_modules/three/examples/jsm/libs/basis/` — that source may vanish after upgrade. Verify post-bump; if gone, keep the committed copy as canonical or vendor from the three.js repo.
- `DRACOLoader.setDecoderConfig()` deprecated (future WASM-only) — check if we call it.

### 5. Clean scan — NO hits on any of these (r183–r185 renames/removals)
`PostProcessing→RenderPipeline`, `Clock→Timer`, `Sky/SkyMesh` gamma, `MeshPostProcessingMaterial`, `WebGLCubeRenderTarget`-on-WebGPU, `GTAONode`, `SSAAPassNode`, `AnamorphicNode`, `TiledLighting`, `Matrix3.translate/scale/rotate`, `onBeforeCompile`, `BatchedMesh`, `FirstPersonControls`, FBX/VTK/LWO/PLY loaders, `RoomEnvironment`/PMREM, `shadow.bias` tuning.

### 6. Visual-drift (not API-break) risks — need eyes, per-scene
- r183 WebGPU shadow improvements: we have `castShadow/receiveShadow` in ~25 files (Cove, reef-race, bumper-shells, landing). Shadows may shift subtly.
- r185 WebGPU premultiplied-alpha change: "blending issues → configure opaque background via Scene.background". We set scene backgrounds; check underwater fog/atmosphere blending + landing vignettes.

## Ecosystem compatibility

| Package | Verdict |
|---|---|
| `@react-three/fiber@9.5.0` | peer `three >=0.156` — OK; check for a patch release day-of |
| `@react-three/drei@10.7.7` | peer `three >=0.159` — OK; drei's internal `three-stdlib` can lag — we import addons from `three/addons` directly (correct per blend007 rule), so exposure is limited to the drei components we actually use |
| `@pixiv/three-vrm@3.5.2` | latest; peer `three >=0.137`; actively published (animation pkg updated ~June 2026). MToon via `MToonMaterialLoaderPlugin` (`vrm-loader.ts:138`) — verify avatars render + springbones after bump |
| `three-stdlib@2.36.1` (root) | peer `three >=0.128` — OK |
| `@types/three` | bump to `0.185.x` in lockstep |

## Recommended execution plan (1 focused session, isolated worktree)

1. **Branch/worktree** off staging; bump `three` + `@types/three` to 0.185 in `apps/web`; `bun install`; `tsc` sweep for type breaks (r183–r185 type churn will surface here first).
2. **Fix the 3 `positionLocal` sites** (→ `positionGeometry` where correct).
3. **Meshlet rasterizer pass** under Rule E3 (Claude↔Codex + 3da co-review) — run the 3 `/preview/meshlet-spike*` pages plus the live world.
4. **Browser verify** against the prod bundle (`bun run build && bun run start`): main world (seaweed sway, atmosphere particles, light rays, quest NPC), Cove interior (shadows/blending), reef-race, bumper-shells, landing (`CoveVignette`, `LandingScene`, `MiladyAvatarShowcase`), VRM avatars + animation, KTX2/DRACO asset loads. Mobile/iPad sweep per CLAUDE.md.
5. **Perf measurement** before/after on the Iris Xe floor methodology — the whole justification is Priority #1; capture numbers in `docs/perf-audit-*`.
6. Staging push → sign-off → PR staging→master. Update `3dStructure.md` (r-version + any visual deltas) same diff.

Fallback: if the meshlet rasterizer fights the new internals, land the upgrade with meshlet path temporarily feature-flagged off ONLY with founder sign-off (it's a live-world perf feature) — otherwise hold the whole upgrade.

## Sources
- https://github.com/mrdoob/three.js/releases (r185, 2026-07-01)
- https://github.com/mrdoob/three.js/wiki/Migration-Guide
- https://github.com/mrdoob/three.js/releases/tag/r185
- https://github.com/pixiv/three-vrm/releases
