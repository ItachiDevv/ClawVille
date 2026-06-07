# Perf Integration Change Ledger - 2026-06-07

Purpose: document every performance change currently combined from `perf2`
and `feat/perf-cpu-framebudget`, with enough detail to remove quality-reducing
features later without guessing.

Integration branch: `perf/combined-cpu-adaptive`

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
it makes the scene look pixelated/soft. Treat DPR clamp as a likely removal or
retune candidate.

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
| P3 | perf2 | `World3DCanvas.tsx` | Low-end DPR range changed to `[0.5, 0.65]`; tier 4 forces renderer DPR to `0.4`. | Fragment/pixel workload. | High. User dislikes DPR softness/pixelation. | Strong rollback/retune candidate. |
| P4 | perf2 | `game/page.tsx` | Tier 4 or `?fast=1` collapses heavy HUD chrome while preserving core canvas/modals/chat. | DOM/layout/compositing overhead. | High. Reduces game UI and perceived completeness. | Rollback candidate unless only kept for diagnostic `?fast=1`. |
| P5 | perf2 | `arena-buildings.tsx`, `World3DCanvas.tsx` | Tier 4 renders shared primitive building proxies instead of full building GLBs. | Draw calls, triangles, GLB load/runtime. | High. Reduces landmark fidelity and inspection quality. | Rollback candidate for normal play; acceptable for emergency mode only. |
| P6 | perf2 | `arena-location-npcs.tsx` | Tier 4 proxies far resident NPCs, remounting full detail near camera. | Resident draw calls/triangles. | Medium-high. Can pop detail near threshold. | Keep only if transition is visually acceptable. |
| P7 | perf2 | `lod-orchestrator.tsx` | Tier 4 reduces moving full-detail NPC/remote-player budget to 2. | VRM/GLB animation and draw cost. | High. Makes world feel less alive and detailed. | Rollback/raise cap candidate. |
| P8 | perf2 | `World3DCanvas.tsx` | Tier 1 disables `MergedSeaweed`; tier 2 disables activity/reward FX; tier 3 disables world labels. | Progressive visual/UI workload cuts. | Medium-high. Labels and FX are gameplay affordances. | Tune carefully; labels likely should stay longer. |
| P9 | perf2 | `World3DCanvas.tsx` | `?fast=1` locks tier 4 for deterministic perf measurement. | Repeatable benchmark path. | Low if query-only. | Keep as diagnostic. |
| R1 | integration | `arena-npcs.tsx` | Conflict resolution keeps CPU cache and keeps `!d.isRemotePlayer` push-out guard. | Preserve both CPU perf and multiplayer correctness. | Low. Needs syntax/runtime verification. | Keep. |
| R2 | integration | `3dStructure.md`, this file | Conflict resolution keeps both load-bearing doc histories and adds rollback ledger. | Maintain traceability. | Low. | Keep. |

## Recommended Removal Order If Quality Feels Worse

1. **Disable tier-4 DPR clamp first.**
   File: `World3DCanvas.tsx`, component `AdaptiveRendererDpr`.
   Remove or raise `tier >= 4 ? 0.4 : ...`.
   Lower visual damage than reverting the full governor.

2. **Keep `?fast=1` diagnostic but stop automatic HUD collapse.**
   File: `game/page.tsx`, `hudPerfMode`.
   Gate HUD collapse only on explicit `?fast=1`, not adaptive tier 4.

3. **Raise tier-4 moving full cap.**
   File: `lod-orchestrator.tsx`, `ADAPTIVE_TIER4_FULL_CAP`.
   Try `4` or `8` before removing the adaptive system.

4. **Keep resident/building proxies query-only.**
   Files: `World3DCanvas.tsx`, `arena-buildings.tsx`,
   `arena-location-npcs.tsx`.
   Apply `buildingDetail=false` and `residentDetail=false` only for
   `?fast=1` or an explicit low-quality setting.

5. **Retune tier order.**
   File: `World3DCanvas.tsx`, `applyQualityTier()`.
   Suggested quality-preserving order:
   seaweed -> activity FX -> far residents -> moving cap -> labels -> buildings
   -> DPR.

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

## Known Constraints

- Current staging includes perf2 already because it was pushed before this
  integration. This integration branch is based on that staging state.
- `feat/perf-cpu-framebudget` had dirty docs/context files in its worktree.
  Only committed branch changes are merged here.
- Building GLBs that go through `mergeStaticMeshesByMaterial` must remain
  texture-only compressed. Meshopt quantization broke runtime geometry merge by
  mixing UV array component types.
