# World-Stage Watchdog RE-LAND — Frozen Brief v1 (2026-07-27)

**Status: FROZEN for /copus-max critique round 1.** Author: Fable (planner/reviewer).
Executor: Codex via /copus-max. Branch: `feat/watchdog-reland` off `staging`
(worktree `C:/Users/itachi/Documents/Crypto/cv-covefreeze`, staging = `89b6daac`).

## Context — read first

The progress-aware readiness watchdog (v3) shipped to prod in PR #253 and was
**emergency-reverted** (`e19d040f` on master) the same night: it fixed the founder's
mobile 45s "transition failed" card but introduced a worse failure (kelp portal exit
→ stuck opaque input-blocking overlay). Root causes were pinned by a diff audit and
recorded in `docs/persistent-world-canvas-plan-2026-07-24.md` (INCIDENT LEDGER
2026-07-28). Prod today = master `5db3a134`: the ORIGINAL blind 45s timer (the open
incident) + the loader-portal hotfix #254. **Staging still carries watchdog v3** —
this re-land fixes v3 in place on staging; staging→master promotion is BLOCKED until
this lands and gates pass.

Current v3 code: `apps/web/src/components/three/world-stage/StageTransition.tsx`
(watchdog effect ~lines 81–187). Companion files:
`WorldStageRoot.tsx` (navigationRef parking :73–76, ADOPT/park :183–204, complete
handler :206–229), `StageHostedCoveScene.tsx` (module-level `inflightCoveCompile`
dedupe :20–99), `stage-store.ts` (`requestStageScene` :415), probe
`apps/web/scripts/world-stage-probe.mjs` (lanes synthetic/routes/soak).

The loader-visibility root cause (#1 in the ledger) is ALREADY FIXED on both prod
(#254) and staging (`f42fe97b` — SeaLoadingScreen portaled to body). NOT in scope
to re-fix; IS in scope to gate (Lane A below).

## Fix A — orphaned adopted navigation on silent retry (P0, the revert cause)

**Bug:** watchdog's silent retry calls `requestStageScene(request.sceneId)`, minting
a NEW `pendingRequest` with a new `requestId`. WorldStageRoot's parked
`navigationRef` (`{requestId, navigation}`) is keyed to the OLD requestId. When the
retry completes, the complete handler (`WorldStageRoot.tsx:218-226`) sees
`pendingNavigation.requestId !== request.requestId` → returns early → the adopted
navigation (e.g. the cove exit the user clicked) is NEVER committed → overlay stuck
opaque + input-blocking. This is the exact live wedge I hit and the kelp black
screen the founder hit.

**Required fix (exact chain, no sceneId heuristics):** add a store-level
`retryStageScene(previous: StageRequest)` action that mints the fresh
generation/requestId AND records the lineage (e.g. `retryOfRequestId` on the new
pendingRequest, or a store-level `retryChain` map). StageTransition's silent retry
calls THIS instead of bare `requestStageScene`. WorldStageRoot re-keys its parked
`navigationRef` when the pendingRequest it is keyed to is superseded by a retry of
that same requestId (subscribe or check in the complete handler — either works, but
the match must be exact lineage, never "same sceneId", because a genuinely new
navigation to the same scene must not resurrect a stale parked navigation).

**Proof required:** unit test on the re-key path (stage-navigation-ownership tests
pattern) + the end-to-end lane (Lane C).

## Fix B — attempt ceiling blind to the GPU texture-upload phase (P0, the incident's discard class)

**Bug:** v3's `ATTEMPT_CEILING_MS` (90s visible) fires "regardless of activity."
During the world boot's dominant phase — GPU texture upload — ALL of v3's activity
signals freeze: `__W3D_PROGRESS` sits at 1.0 (LoadingManager drained), slot status
static, no recoveries. A slow mobile device 95% done uploading at 90s gets its boot
DISCARDED and restarted (retry #1), then the card. The ceiling punishes exactly the
users it was built for.

**Fact found in recon:** the needed signals ALREADY EXIST on the window bridge
(written by StaggeredTextureUpload / World3DCanvas, consumed by
`sea-loading-screen.tsx:154-167`): `__W3D_TEXTURE_UPLOAD_TOTAL`,
`__W3D_TEXTURE_UPLOAD_DONE`, `__W3D_CANVAS_READY`, `__W3D_TEXTURES_READY`. No new
instrumentation is required — the watchdog just never reads them.

**Required fix — two activity classes:**
- **GENUINE FORWARD PROGRESS** = monotonic movement: `__W3D_PROGRESS` strictly
  increasing, `__W3D_TEXTURE_UPLOAD_DONE` strictly increasing while `TOTAL > 0`,
  `__W3D_CANVAS_READY`/`__W3D_TEXTURES_READY` false→true flips, slot status forward
  transitions. Genuine progress defers the soft trigger AND extends the hard
  ceiling.
- **NOISE** = everything else v3 counted (recovery count changes, non-monotonic
  progress writes). Defers the SOFT trigger only, exactly as v3 (Codex finding 2
  stands: noise must never postpone the card forever).
- **Absolute backstop:** a genuine-progress-extended attempt still hard-fails at
  `ATTEMPT_MAX_MS` (propose 240s visible) no matter what — the card can never be
  postponed indefinitely. This also bounds the v3 review-3 P2 residual (repeated
  60s freezes stretching the ceiling).

**Proof required:** extract the per-tick decision into a PURE module
(`stage-watchdog-machine.ts` or similar — mirror `world-stream-machine.ts`):
inputs (visible elapsed, signal snapshot, thresholds) → verdict
(`none | soft-stall | hard-ceiling | backstop`). Unit tests must cover: upload
crawling at 1 file/10s past 90s → NO retry; upload frozen 30s+ past soft window →
retry; noise-only churn past ceiling → retry (v3 behavior preserved); backstop
fires at MAX regardless.

## Fix C — cove compile dedupe wedge on never-settling promise (P1)

**Bug:** `StageHostedCoveScene.tsx` module-level `inflightCoveCompile` — if a
`compileAsync` never settles (wedged GPU/driver), `.finally` never runs, the entry
never clears, and EVERY later generation `await`s it forever → all subsequent cove
entries wedge silently (renderer-keying only helps if the renderer was replaced).

**Required fix:** bound the per-generation wait — `Promise.race` the shared promise
against a timer (propose 20s). On timeout: mark the entry `timedOut`, log a
console.warn, and proceed WITHOUT the compile warm (the direct `gl.render` warm +
ack path continues; first-frame hitch is the graceful degradation). Later
generations seeing a `timedOut` entry must NOT re-await it; they proceed directly
(do NOT issue a second `compileAsync` on the same renderer — a wedged compile means
a wedged renderer, and recovery replaces `gl`, which already re-keys the entry).
Review the `.finally`/`isCurrent` interplay while in there (review-3 flagged it).

**Proof required:** unit-level coverage if the seam allows; otherwise a
code-review-level walkthrough in the notes doc + the synthetic lane must still pass
30/30.

## Fix D — verify, don't trust: no watchdog-after-fail spam

v3 appears to handle this (early return on `phase === 'error'`,
StageTransition.tsx:122-127, + clearInterval before failTransition). VERIFY it
survives your refactor; add a unit assertion in the pure-module tests (verdict
machine never fires after a terminal fail for the same request).

## New MANDATORY gate lanes (the blind spot that let #253 ship)

The existing lanes only covered game↔cove. Add to `world-stage-probe.mjs`:

- **Lane A — `loader`:** fresh context → open `/` (homepage) → client-navigate to
  `/game` → DURING boot (while `__W3D_READY` is falsy), assert SeaLoadingScreen is
  mounted AND topmost (`document.elementFromPoint(viewport center)` resolves inside
  the loader overlay) AND the progress bar shows nonzero width in at least one
  sample; assert the loader dismisses after ready. This pins #254/`f42fe97b`
  forever.
- **Lane B — `kelp-exit`:** boot `/game` → programmatic navigation to `/kelp` (same
  router path the portal uses) → assert URL changed + kelp page painted → navigate
  back to `/game` → assert the return completes to a playable world: loader visible
  during the return boot, `data-stage-transition` reaches `idle` within budget, NO
  stuck opaque overlay, no input-blocking残留 (elementFromPoint over the canvas hits
  the canvas). Kelp is NOT on the stage yet (P3) — the reload is expected; the lane
  asserts the return is CLEAN, which is the incident path.
- **Lane C — retry-adoption (synthetic):** exercise Fix A end-to-end: force the
  first attempt to exhaust (test-only knob on the `/perf/stage` proof route ONLY —
  e.g. query-driven tiny watchdog timings + a wedge-first-ack-once hook; NOTHING
  test-only on the /game path) → watchdog silently retries → assert the retry
  completes AND a parked/adopted navigation still commits (overlay reaches idle,
  navigation executed). If a browser-lane wedge hook is genuinely infeasible
  without polluting prod paths, the fallback is exhaustive unit coverage of the
  retry-lineage re-key + the verdict machine — but say so explicitly in the notes,
  don't silently downgrade.

## Acceptance gates (Fable re-runs every one personally before staging push)

1. `bun run build` + tsc clean + full `bun test` (web workspace) green.
2. New unit tests green (verdict machine + retry lineage re-key).
3. Probe lanes: `synthetic` PASS, `routes` 30/30 PASS, `loader` PASS, `kelp-exit`
   PASS, Lane C PASS (or documented unit-fallback).
4. One full `soak` 60/60 PASS (the retry/generation flow touches scene lifecycle —
   the leak gates must stay green; thresholds per the v4.1 calibration in the P1c
   brief, unchanged).
5. Local-first: everything runs against `bun run build && bun run start` on :3000
   (NEVER `bun run dev`). Port-preflight kill any zombie :3000/:4000 holders before
   lanes (the environmental class that burned us repeatedly).
6. Same-diff docs: this brief committed; execution-ledger entry appended to
   `docs/persistent-world-canvas-plan-2026-07-24.md`; `deploy-status.md` entry on
   the staging push. `3dStructure.md`/`GameFeatures.md` untouched unless behavior
   visible to players changes beyond the error-card timing (it shouldn't).

## Hard constraints (non-negotiable, from CLAUDE.md + incident ledger)

- Visible-time clock semantics stay (hidden tab pauses the budget; per-tick delta
  clamped ≤ 2× cadence).
- Exactly ONE silent retry per scene before any card; latch clears on idle.
- No drei `<Text>`/`<Billboard>`, no `InstancedMesh + ShaderMaterial`, no per-frame
  allocations (Iris Xe rules).
- No test-only code reachable from `/game`.
- Prod stays untouched until a separate, deliberate staging→master promotion AFTER
  founder-visible verification; do NOT bundle unrelated staging deltas into that
  promotion decision (staging is deliberately ahead).
- Push flow: feature branch → my review → staging. Never master.
