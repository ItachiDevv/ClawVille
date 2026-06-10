# Perf-Fidelity-Spike Cleanup Ledger — 2026-06-10

Authoritative record of the Fable re-review + cleanup pass on `perf/fidelity-spike`
(commit `23eb733e`). Companion to `steady-state-vrm-performance-handoff.md` (which now
opens with a current-implementation-state annotation) and
`perf-integration-change-ledger-2026-06-07.md`.

## Why this pass existed

A 34-agent re-review (workflow `wf_2390dad5-ce8`) of the Codex spike found four
confirmed ship-blockers and a stale handoff plan:

| # | Finding | Status |
|---|---|---|
| 1 | `lib/api.ts` `request()` made same-origin (d8ecb50c) — 9 live endpoints (guest signup, password reset, NPC chat, shop, username, avatar, location chat) had NO Next route → 404 on prod | **FIXED** — restored `NEXT_PUBLIC_API_URL` prefix; same-origin now opt-in `NEXT_PUBLIC_API_SAME_ORIGIN=1` (local-dev only) |
| 2 | Adaptive governor (pre-spike `bfd35a3e`) hid ALL world labels at tier 3; recovery needed 90 FPS = unreachable on 60Hz = one-way ratchet; Iris Xe floor reached tier 3 in ~15s | **FIXED** — governor capped to groundCover-only (`QUALITY_MAX_TIER=1`), recovery 59 FPS ×3 samples, anti-flap latch; `?fast=1` is the only label-hiding path (opt-in debug) |
| 3 | Resident streaming thresholds 2600/3200wu < the 4160wu building ring → ZERO teachers visible from spawn | **FIXED** — 4600/5200wu; full ring mounts from town center; real `useRef` frame counters |
| 4 | "Restore demo HUD" (d8ecb50c) was NEW feature work mislabeled as a restore | **KEPT, flagged** — functionally intact; user visually signed off 2026-06-10; mobile/iPad sweep still owed |

Plus: texture-upload hard 4-cap (no `deadline.timeRemaining()`) had doubled
time-to-ready 10.8s→20.5s → **deadline-aware slicing restored**.
`LOW_END_DPR_RANGE` `[0.5,0.65]` → `[0.55,0.7]` (master values).

## Deletions (dead degradation scaffolding, zero live imports)

- `apps/web/src/lib/three/lod-orchestrator.tsx` (288 LOC, never mounted)
- `apps/web/src/stores/lod.ts` (`useLodStore`, zero readers)
- `apps/web/src/lib/three/remote-player-proxy.tsx` (299 LOC, never imported)
- `hudPerfMode` constant + 14 HUD gates in `game/page.tsx`
- `WorldPerfFlags.residentDetail` (dead since 15d4eff6) — `/perf` suite now A–F

## VRM parse queue hardening (`vrm-loader.ts`)

- **Generation-counter cancellation** (`VRM_LOAD_GEN`): dispose-during-parse no longer
  resurrects an orphaned resolved VRM (the ~19s race window the queue had opened);
  stale parses are deep-disposed; dispose-then-remount gets a fresh generation and a
  working avatar. Contract documented in `3dStructure.md §9f`.
- **Priority lane**: `instanceId === 'player-avatar'` unshifts to the queue front —
  the local player no longer waits behind 12+ NPC parses (measured 19s worst case).
- **Metrics gating**: `VRM_METRICS_ENABLED` (exported) — the double
  `collectVRMSceneCounts` traversal and `__CV_VRM_LOAD_METRICS` /
  `__CV_TEXTURE_UPLOAD_METRICS` window writes only run with `?perf=1` or
  `__CV_PERF_HARNESS__` (harness injects it pre-script).

## What was kept from the spike

- VRM parse queue concept (76cf532f) — the one evidenced win (Ready no→yes,
  long-task total −36%).
- GLB recompressions already on staging (~17.7MB→8.7MB across 8 buildings).
- The four perf scripts (`perf-fidelity-browser/asset-audit/variant-plan`,
  `compress-glb-targeted`) as dev tooling.
- All measurement docs (annotated where stale).

## Handoff-plan reality check (do not re-implement)

`combineSkeletons` = tried-and-reverted (T-pose, `314bd1ca`);
`removeUnnecessaryVertices` = already shipped; spring/mixer/expression budgets = ~80%
shipped; MToonNodeMaterial = Turbopack-blocked + low payoff; instance cache = built.
Genuinely new levers: steady-state per-frame instrumentation, narrowing per-VRM
`updateMatrixWorld(true)`, material/pipeline consolidation, prop instancing.
Full annotation at the top of `steady-state-vrm-performance-handoff.md`.

## Quality gates passed

1. 3 parallel implementers (disjoint file ownership) → spec/regression/adversary
   audit: CLEAN (2 minors fixed by orchestrator).
2. Codex paired review (Rule E3) over the full diff: **NO FINDINGS**.
3. `next build` exit 0.
4. Live browser verify (fresh isolated guest, prod bundle :3100):
   ready+texturesReady, tier 1 with 15 labels + 20 buttons visible, 9 residents +
   Nori from spawn, `?perf=1` metrics on, `?fast=1` labels off + HUD intact.
   Screenshot: `verify-cleanup-local-3100.png`.

## Still open after this pass

- Steady-state benchmark (ready-gated RAF sampler + per-frame VRM timing) — in
  progress as the follow-up commit; ALL prior runs were load-phase only
  (`__FIDELITY_FRAME_SAMPLES__` was read but never written).
- Demo HUD mobile/iPad viewport sweep (`docs/mobile-ipad-verification.md`).
- Minor: streamed-in VRM/GLB textures bypass the one-shot `StaggeredTextureUpload`
  snapshot → synchronous upload hitch on NPC pop-in (documented, not fixed).
- Minor: `useVRMInstance` catch can write a ghost `rejected` entry for a key deleted
  by dispose (harmless, re-throws on next render).
