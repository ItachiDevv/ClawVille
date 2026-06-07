# Fidelity-Preserving Performance Spike

Generated from branch `perf/fidelity-spike` off staging commit `cfdc1197`.

## Objective

Improve `/game` performance without reducing play quality. This spike is intentionally measurement-first and rejects the regressions found in the previous merged pass:

- No automatic DPR softening as the primary fix.
- No primitive building replacements in normal play.
- No capsule, cylinder, or block stand-ins for recognizable characters in normal play.
- No engine rewrite before the Three.js asset/runtime bottlenecks are measured.

## Current Baseline

Baseline run: `docs/perf-fidelity-spike/browser-staging-cfdc1197-baseline/summary.md`

- URL: `https://staging.clawville.world/game?perf=1&cb=fidelity-baseline`
- Ready: yes; textures ready: yes.
- HUD/buttons visible: 19 buttons.
- Primitive building proxy meshes: 0.
- Proxy-like named nodes: 0.
- DPR: 0.65.
- Render calls: 356.
- Render triangles: 700,488.
- Long tasks: 37, total 23,130ms, max 9,958ms.
- GLB/VRM resources: 68.

Interpretation: staging is visually preserved after the rollback, but load-time main-thread stalls are still severe. The next pass should target asset decode, VRM parse/normalization, texture upload, and request topology before any visual downgrade.

## Asset Audit

Read-only audit: `docs/perf-fidelity-spike/asset-audit.md`

- Assets scanned: 182.
- Referenced assets detected: 123.
- Total scanned bytes: 123.79 MB.
- Referenced bytes: 58.23 MB.
- Embedded texture bytes: 47.27 MB.
- Decoded triangles across readable assets: 7,039,080.
- Decoded vertices across readable assets: 9,736,382.

Highest-value referenced candidates:

- `/avatars/milady-chibi.vrm`: 5.57 MB, 97,186 tris, 2.25 MB texture.
- `/avatars/eliza-chibi.vrm`: 5.29 MB, 95,712 tris, 2.07 MB texture.
- `/models/cove/cove-interior-cleaned-v1.glb`: 4.81 MB, 196,650 tris, 11 textures.
- `/models/cove/cove-interior.glb`: 4.63 MB, 310,422 tris, 11 textures.
- `/models/sandy-treedome-v3-opt1.glb`: 3.52 MB, 1,129,041 tris.
- `/models/quest-bounty-pavilion.glb`: 2.11 MB, 78,660 tris, 72 textures.

## New Measurement Harness

Commands:

```bash
bun run perf:fidelity:assets
bun run perf:fidelity:browser --label=staging-cfdc1197-baseline "--url=https://staging.clawville.world/game?perf=1&cb=fidelity-baseline" --durationMs=30000
bun run perf:fidelity:variants
```

New browser-run reports capture:

- Renderer calls, triangles, programs, DPR, and quality tier.
- HUD/button visibility.
- Primitive building proxy count and proxy-like scene node names.
- Long tasks, paint, LCP, navigation timing.
- GLB/VRM network resource timing.
- Screenshot.
- Runtime VRM load metrics from `window.__CV_VRM_LOAD_METRICS`.
- Runtime texture upload slice metrics from `window.__CV_TEXTURE_UPLOAD_METRICS`.
- Candidate experiment queues in `variant-plan.md` / `variant-plan.json`.

## Variant Matrix

Generated matrix: `docs/perf-fidelity-spike/variant-plan.md`

- Candidates ranked: 24.
- `toktx` available on this machine: no.
- KTX2 is therefore documented as blocked locally until KTX-Software/toktx is installed or the experiment runs on a machine that has it.
- Runtime assets overwritten: no.
- Sandy Treedome and other merge-risk building geometry stay lab-only until `mergeStaticMeshesByMaterial` compatibility is proven.

## Prototype Order

1. **Measure runtime load phases.** Run the browser harness against this branch after deployment or local equivalent. Compare VRM parse/normalization time and texture upload slice time to the long-task windows.
2. **VRMUtils safe path.** Keep `VRMUtils.removeUnnecessaryVertices`. Do not ship `VRMUtils.combineSkeletons` unless animation regression testing proves Mixamo-retargeted VRMs do not freeze or detach raw humanoid bones.
3. **KTX2 candidates.** Test KTX2/Basis on texture-heavy assets. Compare GPU upload time and visual quality, not just wire bytes.
4. **Meshopt candidates.** Test on isolated assets first. Building GLBs that flow through `mergeStaticMeshesByMaterial` must not be meshopt-quantized until that merge path is proven compatible with mixed accessor types.
5. **Needle progressive loading.** Treat `@needle-tools/gltf-progressive` as an experimental Three.js-compatible prototype. It is interesting for progressive mesh/texture loading, but should be gated behind a lab route or flag until bundle/runtime compatibility is proven.
6. **Engine rewrite candidates.** PlayCanvas and Babylon.js remain real options, but they are larger migrations. Only start that spike if fidelity-preserving Three.js asset/runtime work cannot hold acceptable play quality.

## Acceptance Gates

A candidate optimization is not acceptable unless a browser report shows:

- HUD/buttons remain visible.
- Buildings render as recognizable building models in normal play.
- Characters render as recognizable GLB/VRM characters in normal play.
- Screenshot confirms no blue-screen hold after initial load.
- Long tasks, load duration, or frame stability improve versus baseline.
- Any asset variant has a side-by-side screenshot or visual QA note.
