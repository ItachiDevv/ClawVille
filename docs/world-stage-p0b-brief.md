# P0b IMPLEMENTATION BRIEF — compat spikes + resource ledger + probe harness

Phase P0b of `C:/Users/itachi/documents/crypto/clawville/docs/persistent-world-canvas-plan-2026-07-24.md`
(v2.1, you reviewed + approved). P0a is merged on this branch (`feat/world-stage-p0a`,
commit `6e95b9dc`) and browser-verified: canvas remount stayed 1, hidden slots
froze, rapid-click storm settled clean. Build on the P0a stage module
(`apps/web/src/components/three/world-stage/`). Same isolation rule: **zero
behavior change to any live route** — everything stays behind `/perf/stage`
(plus optional siblings under `/perf/stage/*` with the same `?stage=1` guard).

## Deliverable 1 — Cove-on-WebGPU compat SPIKE

Cove content today renders in a plain-WebGL R3F canvas (`CoveCanvas.tsx` passes
`gl={{...}}` config). Under the stage it will render in a `WebGPURenderer`
(WebGPU backend on capable GPUs, forceWebGL elsewhere). Prove or disprove
compatibility:

- Add a third stage scene `cove-spike` to the proof page that mounts the REAL
  cove interior content (`apps/web/src/lib/three/cove-interior.tsx`) — or, if
  its store/HUD imports make a full mount unreasonable inside the dev route, a
  representative subset that covers every MATERIAL/TEXTURE/LIGHT class the cove
  uses (document exactly what was excluded and why). Reuse its existing assets.
- Drive it under BOTH backends locally: default (WebGPU on this dev box) and
  `?webgl=1`. Record console errors/warnings, visual result, and any
  material/shader fixes needed.
- Findings go in the notes doc: VERDICT (compatible / fixable-with-X / blocked)
  + the exact fix list for P1. This is a spike — do NOT refactor cove-interior
  beyond what mounting it requires.

## Deliverable 2 — renderer health-policy consolidation (kelp parity)

`KelpRealmCanvas.tsx` carries the strongest recovery machinery (init timeout,
uncaptured-error detection, session WebGL fallback, device-loss handling,
canvas-adoption watchdog). The P0a stage only has an init timeout + same-canvas
WebGL retry. Consolidate INTO THE STAGE:

- WebGPU device-loss handler (`device.lost`) + repeated uncaptured-error
  detection → bounded recovery: attempt one in-place renderer recreation on the
  SAME canvas element; if that fails, session-sticky forceWebGL fallback
  (mirror kelp's sessionStorage pattern); never an unbounded reload loop.
- WebGL `webglcontextlost`/`webglcontextrestored` handling for the forceWebGL
  path.
- `visibilitychange`/`pageshow` handling: clear input state, clamp the next
  frame delta, resync size/camera, one invalidation (guard against the
  background-tab rAF-throttle class).
- Surface recovery events on the proof-page panel (count + last reason) via
  the stage store.
- Write a short comparison table in the notes doc: which kelp/world behaviors
  were adopted, adapted, or intentionally dropped, so P3 kelp migration can
  delete its local copy against this record.

## Deliverable 3 — byte-accurate resource ledger

`renderer.info.memory.textures` is a count, not bytes (your own finding C9).
Implement `world-stage/resource-ledger.ts`:

- Walk a scene slot's graph and estimate GPU bytes: textures (width × height ×
  bytes-per-texel by format incl. compressed KTX2/meshopt cases + mip chain
  ×1.33), geometry (attribute arrays + index), render targets if any. Return
  `{ texturesBytes, geometryBytes, total, counts }` per slot.
- Per-slot readout on the proof panel (MB, 1 decimal) + a window-exposed
  `__WORLD_STAGE_LEDGER()` returning the JSON for scripted collection.
- Accuracy note in the notes doc: what is estimated vs exact, and the known
  error sources. This ledger is the Phase-1 VRAM gate instrument — it must be
  honest, not flattering.

## Deliverable 4 — automated 100-transition probe harness

Harden P0a's counters into the release-gate probe (plan contract 3):

- `apps/web/scripts/world-stage-probe.mjs` (or `apps/web/src/app/perf/stage`
  embedded runner — your choice, document it): drives ≥100 alpha↔beta(↔cove-spike)
  transitions against a running `bun run start` server, then asserts: canvas
  remount count === 1; hidden-slot frame invocations frozen during every
  inactive window; stage-owned listener delta === 0; zero transition `error`
  phases; JS heap growth after the run < 15% over the post-warmup baseline
  (collect via `performance.memory` where available; report if unavailable).
- Exit code 0/1 + a machine-readable JSON summary written next to the script
  output. Run it yourself and include the passing summary in the notes doc.
  If it fails, fix the stage until it passes — a red probe is not a deliverable.

## Cleanups folded in (review notes from P0a)

1. Frame counters: stop writing the Zustand store every frame. Count in module
   refs; sample into the store at ≤4 Hz for the panel. The probe reads the
   refs via a window hook, not the store.
2. GPU detection: import/share the project's canonical detector
   (`apps/web/src/lib/three/gpu-tier.ts`) instead of the stage-local duplicate,
   IF that import is clean client-side; otherwise document why not.

## Constraints (unchanged)

Iris Xe bans (no drei Text/Billboard, no InstancedMesh+ShaderMaterial, no
per-frame allocations in hot paths); all Three imports from `three/webgpu`;
TS strict; no new deps; do not touch live routes, `SceneTransition.tsx`,
`sea-loading-screen.tsx`, `use-world-stream.ts`.

## Definition of done

1. `bun run build` green from repo root; `bunx tsc --noEmit` green in apps/web.
2. Probe harness run PASSING against the local prod bundle (include JSON summary).
3. `docs/world-stage-p0b-notes.md`: cove-spike verdict + fix list, health-policy
   comparison table, ledger accuracy notes, probe results, deviations.
4. Update `3dStructure.md` world-stage section same-diff (append P0b state).
5. Commit on `feat/world-stage-p0a` branch:
   `feat(3d): P0b world-stage compat spikes + resource ledger + probe harness (plan v2.1)`.
   Do NOT push.

Browser/visual verification of the cove-spike scene is done by the reviewer
(Fable) after you finish; your own local runs + probe output are your evidence.
