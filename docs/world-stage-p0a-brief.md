# P0a IMPLEMENTATION BRIEF — Persistent World Stage (synthetic proof)

You are implementing Phase P0a of the approved plan
`C:/Users/itachi/documents/crypto/clawville/docs/persistent-world-canvas-plan-2026-07-24.md`
(v2.1 — you reviewed it in two rounds; your APPROVE-WITH-CHANGES edits are
applied). Re-read it first. This brief is the bounded P0a slice ONLY.

## Hard scope boundary (your own round-2 condition)

P0a runs behind a development-only synthetic route and MUST NOT mount the
persistent stage alongside any live route-owned Canvas. **Zero behavior change
to `/game`, `/cove`, `/kelp`, `/arena`, `/activity/**`.** The only permitted
touch to existing code is the OPTIONAL pure extraction of
`createWebGPURenderer` from `apps/web/src/components/three/World3DCanvas.tsx`
(~L2230–2320) into `apps/web/src/lib/three/webgpu-renderer-factory.ts` with
World3DCanvas importing it — byte-identical behavior, tsc-proven. If the
extraction is not cleanly zero-risk, duplicate the factory inside the stage
module instead and note it for P1 consolidation.

## Deliverables

### 1. `apps/web/src/components/three/world-stage/` module

- **`WorldStageCanvas.tsx`** — ONE R3F v9 Canvas with the async WebGPU gl
  factory (WebGL2 fallback), mounted once, NEVER key-remounted, canvas element
  never re-parented (known trap: async gl factory double-invokes; canvas swap
  = orphaned-canvas void). `frameloop="always"` at creation (async factory is
  skipped entirely under `frameloop="never"` — documented in World3DCanvas
  ~L2464), pause via the live store after creation.
- **`stage-store.ts`** — Zustand slice: scene slot registry. Per slot:
  `status: 'unrequested'|'loading'|'warming'|'ready'|'resident'|'evicted'|'error'`,
  `generation: number`. Actions: `requestScene(sceneId)` (bumps generation,
  cancels stale), `ackReady(sceneId, generation)` (ignored if generation
  mismatch — generation-tokened readiness), `activeScene`.
- **`stage-camera.ts`** — camera coordinator: persistent per-scene
  `PerspectiveCamera` objects; installs the active camera via
  `state.set({ camera })` while the transition overlay is opaque; updates
  aspect on resize; preserves each camera's pose across swaps. Exactly ONE
  camera installed at a time; no `makeDefault` components.
- **`StageTransition.tsx`** — the layout-owned transition state machine:
  `idle → fadingOut → awaiting (scene generation ready AND camera installed
  AND first controlled frame rendered) → fadingIn → idle`, with a hard
  timeout (default 20s → error state + on-screen message, never an infinite
  black screen) and stale-request cancellation (a second request during
  awaiting supersedes cleanly).
- **`use-scene-frame.ts`** — `useSceneFrame(sceneId, callback)`: registers
  the callback with a stage scheduler that runs ONLY the active slot's
  callbacks from a single `useFrame` root. Hidden slots get ZERO invocations.
  Per-slot invocation counters exposed on the store for instrumentation.

### 2. Synthetic dev route `apps/web/src/app/perf/stage/page.tsx`

- Guarded: renders `null` (or a notice) unless `process.env.NODE_ENV ===
  'development'` OR query `?stage=1` is present (so we can also probe it on a
  prod-bundle localhost run — `bun run build && bun run start` is the
  standard local test path; pure NODE_ENV gating would make it untestable).
  It must NOT appear in any nav/UI.
- Mounts `WorldStageCanvas` with TWO dummy scenes: `alpha` (e.g. rotating
  teal boxes, camera at one pose) and `beta` (e.g. orange spheres, distinct
  camera pose). Each scene's animation runs via `useSceneFrame` only.
- DOM buttons "Go alpha" / "Go beta" driving `requestScene` through the full
  StageTransition machine. Rapid double-clicks must not wedge (stale-request
  test). Include an artificial 1s "warming" delay on each first activation so
  the awaiting phase is actually exercised.
- On-page instrumentation panel (plain DOM, NOT drei Text): per-slot frame
  callback counts (must show hidden slot frozen), current slot status +
  generation, transition state, canvas remount counter (a `useEffect` mount
  counter on the Canvas — MUST stay 1 across all swaps), window listener
  count delta.

### 3. Constraints (kill-the-build invariants — violating any is a rejected diff)

- Iris Xe: NO drei `<Text>`/`<Billboard>`; NO `InstancedMesh + ShaderMaterial`;
  NO per-frame `new Vector3()` (allocate refs once).
- All Three imports from `three/webgpu` (`import * as THREE from
  'three/webgpu'`) — never mix plain `three` module instances with node
  materials (two-instance `.replace()` crash).
- TypeScript strict; kebab-case files; no new deps.
- Do not touch `SceneTransition.tsx` (live), `sea-loading-screen.tsx`,
  `use-world-stream.ts`, or any route outside `/perf/stage`.

### 4. Definition of done (run these yourself before finishing)

1. `bun run build` green from repo root (this worktree has node_modules).
2. `bunx tsc --noEmit` green in `apps/web` (or the repo's typecheck task).
3. A short WHAT-CHANGED summary written to `docs/world-stage-p0a-notes.md`:
   files added, extraction done or deferred (and why), any deviation from
   this brief with reasoning, and exactly how to drive the proof page.
4. Commit everything on the current branch `feat/world-stage-p0a` with message
   `feat(3d): P0a persistent world stage — synthetic proof route (plan v2.1)`.
   Do NOT push.

Browser verification is done by the reviewer (Fable) after you finish — you do
not need a browser.
