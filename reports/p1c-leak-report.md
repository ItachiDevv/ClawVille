# P1c World Stage Leak Hunt Report

**Date:** 2026-07-26  
**Branch:** `feat/world-stage-p1c`  
**Starting commit:** `10eea638`  
**Outcome:** **BLOCKED** at the mandatory 60-loop soak gate

## Instrumentation

The route probe now records one sample after every round trip (or every 10
seconds in dwell mode) in the summary `series`. Each sample includes absolute
heap bytes/MB, textures, geometries, draw calls, history length, and WebGPU
memory categories when available. Forced GC runs every five crossing samples
and at dwell checkpoints.

`sceneInventory()` traverses both registered slot roots independently and
reports object, mesh, geometry-reference, and unique-geometry totals; mesh and
geometry tallies keyed by object/geometry name plus type; and geometry UUID
identities. The summary preserves early/late inventories, their diff, and
inventories captured when renderer counters change.

## Localization experiments

Experiments ran serially against the production build:

| Experiment | Duration / loops | Forced-GC heap | Renderer direction | Inventory direction |
|---|---:|---:|---|---|
| Standard crossing baseline | 20 round trips | 311.89 -> 338.66 MB, +8.58% total / +2.90% second half | textures 283 -> 295; geometries 271 -> 282 | World geometry identities flat; Cove root changed during activation; five unnamed `BoxGeometry` instances churned |
| DWELL-GAME | 101.6 s | 323.65 -> 315.92 MB, -2.39% | textures/geometries constant at 283 / 252 | Flat |
| DWELL-COVE | 101.3 s | 311.41 -> 311.62 MB, +0.07% | textures/geometries constant at 283 / 264 | Flat |

Growth was crossing-correlated, not wall-time-correlated. The inventory diff
localized the primary defect to activation-owned Cove resources. A follow-up
audit found the same lifetime pattern in world lights, which are not visible in
mesh/geometry tallies.

## Exact defects and corrections

1. `CoveInteriorScene` and `InteriorScene` conditionally mounted label roots,
   bank labels, Cove lighting, and five interaction hotspot meshes whenever
   their slot became active. Every crossing reconstructed persistent scene
   resources. They now remain mounted under the persistent hidden slot root;
   only input and scene activity remain gated.
2. `WorldSceneContents`, `CoveBeacon`, and `CoveEntrance` conditionally mounted
   eight lights on scene activation. Those lights now remain mounted under the
   persistent world slot root.
3. After activation churn was removed, route history exposed a secondary
   retention slope: two App Router entries were retained for every round trip,
   growing history from 4 to 122. Stage navigation now pushes the first
   game/Cove pair for browser back/forward adoption and replaces later
   stage-owned entries, holding history at 4.
4. `WorldWarmup` allowed an already-started bulk-VRM compile to finish after
   readiness and compiled only the initial camera frustum. Existing off-frustum
   world/Cove resources could therefore allocate on later crossings. Warmup now
   waits for the active VRM batch, compiles both complete persistent slots with
   frustum culling temporarily disabled, performs the controlled warm draw
   before restoring culling, and only then acknowledges readiness.

A scanner-batch recompilation experiment was reverted because it did not
stabilize renderer cache accounting and increased heap pressure.

## Final serial gate evidence

| Order | Gate | Result |
|---|---|---|
| 1 | root `bun run build` | PASS; 9/9 packages, 38 static web pages |
| 2 | `apps/web: bunx tsc --noEmit` | PASS |
| 3 | touched stage-navigation tests | PASS; 15 tests / 26 assertions |
| 4 | synthetic WebGPU | PASS; 102/102 transitions, heap +1.2365%, counters 9 textures / 15 geometries / 4 draw calls |
| 5 | synthetic WebGL | PASS; 102/102 transitions, heap +1.2320%, counters 9 textures / 15 geometries / 2 draw calls |
| 6 | routes | PASS; 30/30 round trips, heap +8.3273%, history 4 -> 4, both inventories flat |
| 7 | soak | **BLOCKED**; 60/60 round trips, details below |

Final soak:

- heap: 351,520,545 -> 388,888,277 bytes, +10.6303% (passes 15%);
- second half: 373,292,742 -> 388,888,277 bytes, +4.1778% (fails 3%);
- renderer count plateau: PASS, loop 20 and final both 287 textures / 415
  geometries;
- scene inventories: PASS, exact zero diff for both slots;
- history: PASS, 4 -> 4;
- all listener, route, stream, recovery, freeze, mock-transport, and cold-init
  assertions: PASS;
- renderer byte plateau: FAIL, although total bytes decreased by 67,539
  (291,045,055 -> 290,977,516).

The byte delta contains no geometry, index, attribute, or texture change.
Renderer programs change 146 -> 158 while program bytes decrease by 67,827;
one uniform buffer adds 288 bytes. This is renderer-internal WebGPU
program/uniform cache variation, not a growing scene subtree.

## Blocker

The allowed stage/world/Cove scene defects are fixed and their observable
resources plateau. The remaining second-half JS heap failure has no growing
scene inventory, history, listener, network, or renderer resource-count
correlate. The remaining renderer byte failure is exclusively Three/WebGPU
program-cache variation and even represents a net memory decrease.

Changing Three/WebGPU cache semantics or weakening the strict plateau/heap
gates is outside the permitted slice. No threshold, texture-eviction tier, API
code, NPC simulation, room registry, or feature was changed to manufacture a
pass. Per the pre-existing/out-of-scope rule, this slice stops with the
`p1c-leak.blocked` marker.
