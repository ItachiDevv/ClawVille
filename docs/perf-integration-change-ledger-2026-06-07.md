# Perf Integration Change Ledger - 2026-06-07

Purpose: document every performance change currently combined from `perf2`
and `feat/perf-cpu-framebudget`, with enough detail to remove quality-reducing
features later without guessing.

Integration branch: `perf/combined-cpu-adaptive`

Current recovery branch: `perf/fidelity-spike`

Base at integration start: `origin/staging` = `892880d1`

Merged branch: `feat/perf-cpu-framebudget` = `8014f9a6`

## Decision Summary

The two perf branches solve different problems:

- `feat/perf-cpu-framebudget` is mostly quality-preserving CPU and asset work.
  These changes should be kept unless visual verification finds an asset
  regression.
- `perf2` is a runtime adaptive degradation system. It reaches high FPS by
  progressively removing visual/UI detail. These changes need individual
  rollback switches because several of them reduce play quality.

User preference noted 2026-06-07: DPR reduction is especially suspect because
it makes the scene look pixelated/soft. Live staging verification confirmed
normal `/game` hit tier 4 and renderer DPR `0.4`, producing a visibly soft
scene. The automatic tier-4 DPR clamp was removed in the follow-up retune.
Follow-up playable rollback removed the unacceptable player-facing degradations:
HUD collapse, building primitive proxies, resident detail shutdown, and moving
NPC/remote-player capsule/cylinder proxies are no longer active in `/game`.

2026-06-08 recovery update: staging still shows the blue-screen/readiness
failure after the proxy rollback (`ready=false`, `texturesReady=false`). Local
production testing on port 3010 is fixed by queueing VRM parses one-at-a-time:
the browser harness reaches `ready=true`, `texturesReady=true`, 19 visible
buttons, 0 primitive building proxies, and 0 proxy-like named nodes. This fix is
not pushed to staging until explicitly approved.

## Combined Changes

| ID | Source | Files | What changed | Perf target | Quality risk | Keep? |
|---|---|---|---|---|---|---|
| C1 | CPU branch | `arena-npcs.tsx` | Added `getNpcFrameShared()` cache so all GLB/VRM NPC `useFrame` calls share one `controlMode` read and one camera-position copy per frame. | CPU main-thread overhead from repeated store/camera reads. | Low. No visual behavior intended. | Keep. |
| C2 | CPU branch | `vrm-character-animator.ts` | Removed redundant full `vrm.scene.updateMatrixWorld(true)` from `updateSpringOnly()` after spring manager updates. | CPU skeletal/world-matrix recomposition. | Medium-low. Depends on spring manager continuing to flush its own joints. Verify VRM hair/accessory motion. | Keep if VRM motion looks correct. |
| C3 | CPU branch | `bazaar-merchant-stand.glb`, `bazaar-stall.tsx`, `asset-preload-manifest.ts`, `sw.js` | Recompressed bazaar stand with meshopt/WebP and bumped cache refs. | Asset transfer/load. | Medium. GLB visual could regress if texture/mesh compression artifacts are visible. | Keep if visual check passes. |
| C4 | CPU branch | 6 building GLBs, `arena-buildings.tsx`, `asset-preload-manifest.ts`, `sw.js` | Recompressed 6 live building GLBs texture-only. Meshopt was reverted for these because it broke `mergeStaticMeshesByMaterial`. | Asset transfer/load without draw-call regression. | Medium. Texture compression artifacts possible. | Keep if buildings look acceptable. |
| C5 | CPU branch | `quest-bounty-pavilion.glb`, `quest-bounty-pavilion.tsx`, `asset-preload-manifest.ts`, `sw.js` | Meshopt/dedup compression for quest-bounty pavilion. | Asset transfer/load. | Medium. Needs visual/pixel verification. | Keep if pavilion looks correct. |
| C6 | CPU branch | `sw.js` | Removed unused `underwater-decorations.glb` from service-worker precache and bumped cache version. | Avoid dead install-time fetch. | Low. Only risky if dead asset becomes live without adding it back. | Keep. |
| P1 | perf2 | `World3DCanvas.tsx`, `PerfAudit.ts`, `/perf` | Added `WorldPerfFlags` split: `groundCover`, `activityFx`, `residentDetail`, `buildingDetail`, `uiOverlay`; `/perf` can toggle/audit them. | Measurement and granular degradation. | Low by itself. | Keep instrumentation. |
| P2 | perf2 | `World3DCanvas.tsx`, `gpu-tier.ts` | Added adaptive quality governor. Tiers step down after low RAF FPS and recover only after sustained high FPS. | Runtime FPS recovery on low-end devices. | Medium. If thresholds are too aggressive, quality drops during normal play. | Keep only if defaults feel good. |
| P3 | perf2 + retune | `World3DCanvas.tsx` | Low-end DPR range remains `[0.5, 0.65]`, but the automatic tier-4 renderer DPR clamp to `0.4` was removed after staging showed normal `/game` entering tier 4 and looking soft. | Fragment/pixel workload. | Medium-high. Low-end/touch DPR cap can still soften rendering; automatic tier-4 clamp is no longer active. | Keep retuned; revisit low-end DPR separately if it still hurts play quality. |
| P4 | perf2 + rollback | `game/page.tsx` | Tier 4 or `?fast=1` collapsed heavy HUD chrome while preserving core canvas/modals/chat; rollback now forces `hudPerfMode=false`. | DOM/layout/compositing overhead. | High. Removed visible controls and made the game unplayable. | Removed from `/game`; do not restore without an explicit diagnostics-only route. |
| P5 | perf2 + rollback | `arena-buildings.tsx`, `World3DCanvas.tsx` | Tier 4 rendered shared primitive building proxies instead of full building GLBs; rollback keeps `buildingDetail` unchanged at every adaptive tier. | Draw calls, triangles, GLB load/runtime. | High. Replaced recognizable landmarks with random block/triangle stand-ins. | Rejected for normal play. |
| P6 | perf2 + rollback | `arena-location-npcs.tsx`, `World3DCanvas.tsx` | Tier 4 proxied far resident NPCs; rollback keeps `residentDetail` unchanged at every adaptive tier. | Resident draw calls/triangles. | Medium-high. Visible character downgrade/popping. | Rejected for normal play. |
| P7 | perf2 + rollback | `lod-orchestrator.tsx`, `arena-npcs.tsx`, `remote-players.tsx`, `World3DCanvas.tsx` | Tier 4 reduced moving full-detail NPC/remote-player budget to 2 and demoted the rest to capsule/cylinder proxies; rollback unmounts the orchestrator from `/game` and renders visible NPC/remote players as real GLB/VRM models. | VRM/GLB animation and draw cost. | High. Made a 3D world game show far characters as cylinders. | Removed from `/game`; future LOD must preserve silhouettes/identity. |
| P8 | perf2 | `World3DCanvas.tsx` | Tier 1 disables `MergedSeaweed`; tier 2 disables activity/reward FX; tier 3 disables world labels. | Progressive visual/UI workload cuts. | Medium-high. Labels and FX are gameplay affordances. | Tune carefully; labels likely should stay longer. |
| P9 | perf2 | `World3DCanvas.tsx` | `?fast=1` locks tier 4 for deterministic perf measurement. | Repeatable benchmark path. | Low if query-only. | Keep as diagnostic. |
| R1 | integration | `arena-npcs.tsx` | Conflict resolution keeps CPU cache and keeps `!d.isRemotePlayer` push-out guard. | Preserve both CPU perf and multiplayer correctness. | Low. Needs syntax/runtime verification. | Keep. |
| R2 | integration | `3dStructure.md`, this file | Conflict resolution keeps both load-bearing doc histories and adds rollback ledger. | Maintain traceability. | Low. | Keep. |
| F1 | fidelity spike + recovery | `vrm-loader.ts` | Fetches can still start concurrently, but GLTFLoader VRM parses now run through a concurrency-1 queue. Metrics separate `queueWaitMs` from real `parseMs`. | Restore `/game` readiness by letting RAF/requestIdleCallback and staggered texture upload keep running during first mount. | Low-medium. Avatars stream in progressively instead of all parsing at once; no fake proxies or DPR loss. | Keep locally; deploy to staging only after review. |

## Recommended Removal Order If Quality Feels Worse

1. **Tier-4 DPR clamp is already disabled.**
   File: `World3DCanvas.tsx`, component `AdaptiveRendererDpr`.
   The next DPR rollback candidate is the remaining low-end/touch cap
   `[0.5, 0.65]`, which should be tested on real integrated-GPU hardware
   before removal.

2. **HUD collapse is already removed from `/game`.**
   File: `game/page.tsx`, `hudPerfMode`.
   Future UI performance work must preserve all core screen buttons and game
   controls in normal play.

3. **Moving capsule/cylinder proxies are already removed from `/game`.**
   Files: `World3DCanvas.tsx`, `arena-npcs.tsx`, `remote-players.tsx`,
   `lod-orchestrator.tsx`.
   Future moving-entity LOD must preserve character silhouettes and identity,
   for example optimized impostors or reduced animation work, not visible
   cylinder stand-ins.

4. **Resident/building proxies are already removed from adaptive `/game`.**
   Files: `World3DCanvas.tsx`, `arena-buildings.tsx`,
   `arena-location-npcs.tsx`.
   Primitive blocks are rejected for normal play. If a benchmark path needs
   them, it should be an explicit diagnostic route with no ambiguity.

5. **Retune tier order.**
   File: `World3DCanvas.tsx`, `applyQualityTier()`.
   Suggested quality-preserving order:
   seaweed -> activity FX -> optional label density -> animation tick rate ->
   asset streaming/compression. Avoid DPR and visible identity loss unless the
   player explicitly chooses a low-quality mode.

6. **Keep CPU/assets work unless it visually breaks.**
   CPU cache, redundant spring-matrix removal, SW dead-precache removal, and
   texture-only compression should be lower risk than runtime visual
   degradation.

## Verification Requirements

Before promoting beyond staging:

- Browser-verify `/game` without `?fast=1`.
- Browser-verify `/game?fast=1` to confirm emergency tier still works.
- Inspect full building ring visually for texture artifacts.
- Inspect bazaar stall and quest-bounty pavilion for compression artifacts.
- Watch at least one close VRM and one far VRM for spring/hair/accessory motion.
- Confirm remote players/NPCs do not push away from local avatars differently per
  client. The integration intentionally kept `!d.isRemotePlayer`.
- Record renderer counters for each run: RAF FPS, DPR, draw calls, triangles,
  top chunks, and body text/HUD presence.
- Compare the paired reports:
  `docs/perf-fidelity-spike/browser-staging-recheck-20260608/summary.md`
  versus
  `docs/perf-fidelity-spike/browser-local-vrm-queue-3010/summary.md`.

## Known Constraints

- Current staging includes perf2 already because it was pushed before this
  integration. This integration branch is based on that staging state.
- `feat/perf-cpu-framebudget` had dirty docs/context files in its worktree.
  Only committed branch changes are merged here.
- Building GLBs that go through `mergeStaticMeshesByMaterial` must remain
  texture-only compressed. Meshopt quantization broke runtime geometry merge by
  mixing UV array component types.
