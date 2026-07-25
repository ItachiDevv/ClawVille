# P1a IMPLEMENTATION BRIEF — the world onto the persistent stage (parity cutover)

Phase P1a of `docs/persistent-world-canvas-plan-2026-07-24.md` (v2.1 + execution
ledger — the plan doc is now IN THIS REPO; read it first). P0a `6e95b9dc` and
P0b `3e01cac6` are on this branch. This is the **production manifest cutover**
your round-2 review required to be atomic with the first real scene migration:
`/game` stops rendering through `World3DCanvas`'s own Canvas and renders through
the persistent stage. **This is a parity slice: the bar is "the world plays
IDENTICALLY to today", not "returns are fast" (that arrives in P1b when cove
joins the group).**

## Scope

### 1. Route group `app/(world)/`

- Create `apps/web/src/app/(world)/layout.tsx` (client boundary as needed) and
  MOVE `app/game/` → `app/(world)/game/`. URLs unchanged. NOTHING else moves in
  this slice (`/cove` stays route-owned until P1b).
- `game/layout.tsx`'s `force-dynamic` Cloudflare-cache guard is LOAD-BEARING
  (stale-HTML incident 2026-04-26, documented in that file). Preserve it —
  either keep the nested game layout or promote the export to the group layout;
  prove the response still carries non-cacheable headers (curl the local server,
  record the Cache-Control header in the notes doc).
- The group layout mounts `WorldStageRoot` (new thin wrapper over
  `WorldStageCanvas`) as the persistent background layer, plus `{children}`
  above it. The canvas layer must sit visually and interactively EXACTLY where
  today's canvas sits: absolute inset-0 behind the HUD, HUD clicks that used to
  reach the canvas (click-to-move raycasts, building clicks, NPC clicks) must
  still reach it. Audit pointer-events on every wrapper you introduce.

### 2. World scene into the stage

- Extract the world scene subtree from `World3DCanvas.tsx` (the `SceneContents`
  component and its sibling scene-level elements: lights, fog, background,
  labels overlay bridge, click-to-move, meshlet/VRM-metrics glue as applicable)
  into a SHARED export — do NOT fork it. `World3DCanvas` keeps its default
  export working UNCHANGED for `/arena` (`Arena3DCanvas` imports it; `/arena`
  and `/activity/**` are untouched until P2/P4).
- Register scene `world` in the stage with the world's camera definition
  (fov 50, near 1, far 11500, game-mode position `[0, 600, 1300]`). The world's
  in-scene follow/chase camera logic mutates `state.camera` per frame — the
  stage-installed camera IS `state.camera`, so this keeps working; verify it.
- The world's many internal `useFrame` owners STAY as plain `useFrame` in this
  slice — the world is the only registered scene on `/game` and is always
  active. The `useSceneFrame` conversion sweep is P1b work (when the world can
  be hidden). State this in the notes doc so it isn't mistaken for an oversight.

### 3. Renderer/frameloop reconciliation (single-owner rule)

- The stage owns the Canvas, the gl factory, and the frameloop. Reconcile the
  two factories: adopt into the stage factory the world's
  `USE_REVERSED_DEPTH_BUFFER` constant, `SKY_COLOR` clear color for the world
  scene (P0b's clear color becomes per-slot state), and the `_roots` captured-
  entry StrictMode guard from World3DCanvas's factory (~L2404). Keep P0b's
  health policy (device-loss recovery, session WebGL fallback, watchdogs)
  — it supersedes World3DCanvas's weaker `reason==='unknown'` reload handler
  for the /game path.
- Adopt World3DCanvas's DPR ranges exactly (`LOW_END_DPR_RANGE` [0.5, 0.65] /
  standard [0.75, 1]) — P0b's [0.55, 0.7] would be a fragment-cost regression
  on Iris Xe.
- `WorldWarmup` (~L1366) is the load/warm pipeline (asset preload, progressive
  upload, compileAsync, progress flags, pause/resume). Reuse it, parameterized,
  as the world slot's `loading→warming→ready` implementation:
  - Its frameloop pause/resume calls MUST route through the stage
    (`setRenderPaused`), never `setFrameloop` directly — one frameloop owner.
  - On completion it acks the slot generation (`ackReady`) AND keeps setting
    the legacy `__W3D_*` flags + `__W3D_PROGRESS` — `SeaLoadingScreen` stays
    UNCHANGED this slice and still dismisses off `__W3D_READY`. The `3f0dd4c3`
    watchdog stays. Generation-keying the loader is P1b.
- Disposition table REQUIRED in the notes doc: for every canvas-level feature
  in World3DCanvas (VRM metrics, PerfAudit hooks, meshlet experimental glue,
  labels overlay, resize handling, webgpu/webgl query overrides, device-loss
  fallback component, anything else you find) — ADOPTED into stage / STAYS in
  World3DCanvas for arena / DROPPED for /game with reasoning. No silent drops.

### 4. `/perf/stage` coexistence

The proof route and the group layout share the module-level stage store.
Navigating `/game` → `/perf/stage` must not wedge either (reset/namespace the
store per stage mount as needed). The probe harness must still pass unchanged.

## Constraints

- Iris Xe bans (drei Text/Billboard, InstancedMesh+ShaderMaterial, per-frame
  allocations); `three/webgpu` namespace only; TS strict; no new deps.
- DO NOT touch: `/cove`, `/kelp`, `/arena`, `/activity/**` behavior;
  `SceneTransition.tsx`; `sea-loading-screen.tsx`; `use-world-stream.ts`
  (streams move in P1c); any server/API code.
- 2D/PixiJS fallback paths: `/game` mounts World3DCanvas unconditionally today
  — mirror that exactly (stage mounts unconditionally under the group). Do not
  invent new gating.

## Definition of done

1. Root `bun run build` green; `apps/web` `bunx tsc --noEmit` green.
2. `node apps/web/scripts/world-stage-probe.mjs` still PASSING (both backends)
   against the rebuilt bundle — include fresh JSON summaries.
3. Local prod server: `curl -sI localhost:3000/game` shows non-edge-cacheable
   Cache-Control (the force-dynamic guard survived). Record it.
4. `docs/world-stage-p1a-notes.md`: what moved, the disposition table, the
   Cache-Control evidence, probe summaries, deviations, and exactly what the
   reviewer should verify in the browser.
5. Same-diff doc updates: `3dStructure.md` world-stage section (world now
   stage-hosted on /game; arena still legacy), `ARCHITECTURE.md` frontend
   section (route group + canvas ownership), plan doc execution ledger row
   P1a → "implemented, awaiting reviewer verification".
6. Commit on `feat/world-stage-p0a`:
   `feat(3d): P1a world scene onto persistent stage — (world) route group parity cutover (plan v2.1)`.
   Do NOT push. Then write `docs/world-stage-p1a.done` containing the commit
   sha (the done-marker the orchestrator polls).

Reviewer (Fable) then drives the REAL `/game` in a browser on the Iris Xe floor:
first-boot loading screen, guest spawn, walk/click-to-move, NPCs animating,
building interactions, FPS vs the ~40-45 baseline, `/arena` smoke, console
clean. Your evidence is build/probe/curl; the browser verdict is the reviewer's.
