# Cold-load rung 4 — Slice E spec: early serial boot-core compile (rev 3 — post-Codex-R2)

Date: 2026-08-19 · Session perr4.5 continuation · Branch `perf/cold-load-diet` (base `dc44a10d` = live staging)
Codex xhigh round 1 on rev 1 (width-4 pooled compile): **REVISE — 8 BLOCKING**. Rev 2 changed the
design to serial-early; Codex round 2 on rev 2 + its diff: **REVISE — 8 BLOCKING** (§6b). Rev 3
folds all of R2. §6/§6b are the findings ledgers.

## 1. Problem (measured, slice-D evidence)

Slice-D warmup breakdown (12 authenticated candidates, `docs/perf-data/cold-load-rung4-sliceD-2026-08-17/`):
deps 313ms · scans 84ms · **compile 1279ms** (serial per-group loop) · warm render 5ms → presented
median 3359ms. The compile runs strictly AFTER the dep wait and texture scans, so its full cost sits
on the critical path to BOOT_CORE_PRESENTED.

Rev-1 measurements proved a large share of the compile wall is overlappable waiting, not
irreducible main-thread work (width-4 pooling cut the wall to 643-818ms across lanes) — but
Codex R1 showed concurrent `compileAsync` calls are UNSAFE on r185 (§6 findings 1-3), so the
overlap must come from somewhere other than compile-vs-compile concurrency.

## 2. Design — EXACTLY ONE compileAsync in flight, started EARLY

The win: overlap the serial compile with the OTHER warmup phases (the idle dep wait, the VRM
bulk drain, the texture scans) instead of with itself.

Warmup ordering (World3DCanvas warmup effect; unchanged steps in parentheses):

```
warmupStart → armDecorativeDeadline
            → KICK earlyCompile (async, serial, non-actor boot-core roots)   ← NEW
            → (await deps: clips + boot actor, 8s cap)
            → (vrmBulk drain)
            → (inventory + drift hide)
            → (texture scan/upload loop)
            → AWAIT earlyCompile; stamp scansDone; LATE compile of remaining roots ← NEW
            → stamps
            → (warm draw — now inside the SYNC culling scope, see §2c)
            → armBootCorePresented
```

### 2a-pre. Renderer-wide compile FIFO [R2-1]

A generation's cleanup flips `cancelled` but cannot cancel an in-flight `compileAsync`
tail. Every boot compile phase runs through `chainBootCompile` (module-level strict FIFO in
`boot-core-compile.ts`) so a successor generation's first front waits for the orphan tail;
the deferred-warm (`warmDeferredObject`) and stage-warm (`warmStageSlotRenderer`) compile
paths `awaitBootCompileIdle()` before their first compile. Concurrency across generations
and across the boot/deferred/stage paths is therefore structurally impossible, not merely
unlikely.

### 2a. Compile queue (`boot-core-compile.ts` — serial, abort-on-failure)

- `runBootCoreCompileQueue({ groups, compile, isCancelled, onGroupSettled, stopOnFailure })`
  iterates SERIALLY — width is structurally 1, there is no concurrency parameter. Exactly one
  `compileAsync` in flight process-wide during warmup (deferred-warm streaming only starts
  post-eligibility, which is post-reveal).
- **Abort-on-failure** (`stopOnFailure: true`): the first rejection stops dispatching further
  groups (Codex R1-4 — a front-phase throw leaves renderer state unrestored; do not keep
  compiling against it). The warm draw remains the fail-open: `render()` re-seats
  `_handleObjectFunction`/`_currentRenderContext` at entry (verified r185 Renderer.js:1593) and
  synchronously compiles whatever the aborted queue missed, behind the overlay.
- `onGroupSettled` is invoked inside its own try/catch — an observer throw cannot reject the
  queue or strand workers (R1-12).
- Returns `{ requested, dispatched, settled, failed, aborted }` — settled counts SETTLEMENTS,
  not dispatches (R1-8).

### 2b. Early/late phases + exactly-once (R1-8, R1-15)

- Exactly-once is keyed by **(root uuid → subtree signature)** [R2-2]: the signature is
  the visible-mesh count plus the sorted material-uuid list, captured INSIDE the sync
  compile front. A root that existed EMPTY at the early kick (activity-indicators before
  its SSE data) and gained meshes pre-reveal has a CHANGED signature and is recompiled by
  the late phase — a bare uuid set would skip it forever and silently launder its compile
  cost into the warm draw, outside the measured tail. `bootCoreCompileRenderables` stamps
  the total visible meshes the fronts actually traversed (evaluator requires > 0). The
  boot-actor chunk owns 2 roots; a remounted root gets a new uuid and is legitimately
  re-compiled.
- EARLY phase: at kick time, inventory whitelisted roots (`bootCoreGroups()`), compile them
  serially. The boot-actor roots are typically not mounted yet, so early naturally covers the
  procedural 15-16 roots.
- LATE phase (after the dep gate + scans): re-inventory; compile any root uuid not yet
  compiled (boot-actor roots, any late-mounted whitelisted node). Cumulative `requested` =
  unique roots seen across both phases.
- Root uuid duplicates within one inventory log a console warning (structural assert, R1-15);
  per-root log lines carry `perfChunk` + root uuid.
- Renderer-init guard: before the early loop, if the renderer exposes `init()` and is not yet
  initialized, await it (the compileAsync front is only synchronous when initialized).

### 2c. Atomic culling windows (R1-5)

New SYNC helper `withStageSlotFrustumCullingDisabledSync(sceneId, fn)` in
`resource-ledger.ts` — identical to the async variant but with ZERO awaits between disable,
`fn()`, and restore. Used for:
- **each compile front**: `withSync('world', () => { p = gl.compileAsync(group, camera, scene) })`
  then `await p` OUTSIDE the window. r185's `compileAsync` body runs synchronously through
  `_projectObject` (the only culling reader) up to the tail's first await when the renderer is
  initialized, so the disabled window covers exactly the front and nothing else. The 10s/40s
  stage watchdogs fire from timers and can never observe a disabled world (timers cannot
  preempt a sync window). Cross-generation flag clobbering is impossible for the same reason.
- **the warm draw**: same sync helper around the single `gl.render` (drift stays hidden only
  across that sync window's caller scope, as today).
- WebGL2: `WebGLRenderer.compile()` traverses without frustum culling at all, and runs fully
  synchronously inside the same call shape — the window is harmless there.

### 2d. Generation-guarded side effects (R1-6)

`isCancelled = () => cancelled || (stageWarmup ? stageResumed : livePendingGateResumed())`.
The queue checks it before every dispatch; `onGroupSettled` checks it before
`noteWorldWarmupProgress()` (a cancelled generation never pokes the successor's watchdog);
compile stamps are published ONLY when the generation is still live at stamp time. A
safety-fuse-resumed run stamps nothing new.

### 2e. Stamps (probe-readable; R1-8)

- `bootCoreCompileMode` = `'group-serial-early-1'`
- `bootCoreCompileRequested` / `Dispatched` / `Settled` / `FailedGroups` /
  `Renderables` — the evaluator requires requested === dispatched === settled,
  failed === 0, requested > 0, renderables > 0 [R2-2][R2-4].
- `bootCoreCompileMs` — wall from first kick to last settle (report-only; includes the
  overlapped span).
- `bootCoreCompileTailMs` — max(0, lastSettleAt − scansEndAt): the portion still on the
  critical path after the scans finish. **Feeds both gated compile metrics.**
- `bootCoreCompileEarlyHiddenMs` — overlap accounting; the evaluator asserts
  `wall = hidden + tail` (±1.5ms) and `tail ≤ wall` [R2-4].
- `bootCoreCompileEarlyMs` / `bootCoreCompileLateMs` — per-phase walls (required
  present + nonnegative; report-only magnitudes).

Note on texture accounting: the early compile tail may upload some boot-core textures via its
bindings step before the scan loop sees them; the scan's `initTexture` on an already-resident
texture is idempotent. `scansTextures` therefore counts textures the scan TOUCHED, as today —
semantics recorded here, no probe change.

## 3. Measurement + gate (R1-7, R1-9, R2-3..6, R2-9)

- **New `--slice-e` evaluator** (`evaluateSliceEGate` + `sliceECandidateDefects` in
  `cold-load-paired-gate.mjs`; additive — the frozen `--slice-d` schema is untouched). It runs
  the ENTIRE slice-D fail-closed evaluation first, then per candidate rejects: missing or
  non-finite compile stamps · wrong mode · failed/aborted · count mismatch
  (requested ≠ dispatched ≠ settled or requested = 0), negative durations, non-integer
  counts, `tail > wall`, or `wall ≠ hidden + tail` (±1.5ms) [R2-4]. The evaluator itself
  refuses any lane other than authenticated player-vrm, and the CLI refuses
  `--slice-e --watchdog-lane` [R2-5]. Fail-closed metrics [R2-9, improvement-primary]:
  - **PAIRED improvement**: median of the WITHIN-PAIR `baseline.bootCoreCompileMs −
    candidate.bootCoreCompileTailMs` ≥ **300ms** (median-of-diffs, NOT diff-of-medians
    [R2-3]; the 95% one-sided lower bound is reported alongside);
  - absolute safety ceiling: median candidate `bootCoreCompileTailMs` **< 1000ms**
    (recalibrated from the pre-analysis 800ms handoff guess [R2-9] — the paired bound with
    the 1279ms archive baseline still imposes ~979ms; the ceiling only prevents a
    poisoned-slow baseline from relaxing acceptance).
  Unit tests cover mode/failure/count/negative/fractional/accounting/lane/identity
  counterexamples, including the exact unpaired-medians counterexample from R2.
- **Build identity [R2-6]**: the ab-runner DERIVES both SHAs from the measured worktrees
  itself (`git rev-parse` + `-dirty` when tracked modifications exist; untracked run
  outputs/hook mirrors ignored) and REJECTS an operator override that disagrees.
  `--slice-e` refuses missing, identical, or dirty SHAs — the candidate must be a distinct
  committed clean build. Full artifact-hash identity (tree hash, three version, browser
  build) is DECLARED out of scope and recorded in the ledger.
- Baseline: `dc44a10d` (slice-D tip = live staging), worktree `cv-perf-baseline` on :3011.
- 12 counterbalanced authenticated pairs (landtest1 player-vrm storage-state), local webgpu,
  no builds/tests/codex during the batch.
- Watchdog singles on the FINAL build: guest webgpu · authenticated GLB player (landtest2) ·
  webgl2 guest · cold `/cove` + `/kelp` scene-leak.

## 4. Acceptance

1. `--slice-e` gate VERDICT pass (encompasses the frozen slice-D schema + the compile schema
   + both compile bounds).
2. Watchdog singles green; drift 0 everywhere; `failedGroups` 0 on every run.
3. Suite green, `tsc` 0; new unit tests for the queue (exactly-once, abort-on-failure,
   cancellation, empty inventory, observer-throw non-fatal) and the evaluator.
4. Same-diff docs: `3dStructure.md`, perf ledger slice-E section, `deploy-status.md` on push.
5. Compile-window responsiveness (R1-11): width-1 serial keeps three's own per-object
   `scheduler.yield` pacing — the same yield structure slice D shipped; the overlap with
   deps/scans adds no new unyielded main-thread block. `longtasks.preRevealTotalMs` is
   compared against slice-D values in the evidence analysis (report-only). A dedicated
   compile-window rAF-gap probe lane is DECLARED as a future rig improvement.

## 5. Declared boundaries

- **Width > 1 requires an upstream three change** (a batch compile primitive owning WebGPU
  error scopes + immutable per-item light state + WebGL2 program-handle snapshots — Codex R1
  findings 1-3). Rev-1 measurements (pool width 4: compile wall 643-818ms vs 1279 serial)
  quantify the additional ~300-500ms available to such a primitive. Filed as the rung-4
  post-close follow-up; NOT pursued at app level.
- Concurrency sweep (R1-10) only meaningful after that primitive exists — declared with it.
- The early phase compiles only roots visible at front time (r185 `_projectObject` skips
  `visible === false`); anything it misses is absorbed by the warm draw exactly as in slice D.

## 6. Codex R1 findings ledger (rev 1 → rev 2)

| # | Sev | Resolution in rev 2 |
|---|---|---|
| 1 | BLOCKING | Width structurally 1 — no concurrent pipeline creates, error-scope LIFO never interleaves. Upstream primitive declared (§5). |
| 2 | BLOCKING | Width 1 — one front's light set at a time; no interleaved `setLights` while a tail yields. (The pre-existing duplicate-light collection for light-bearing roots is slice-D shipped behavior, absorbed by the warm draw; noted, unchanged.) |
| 3 | BLOCKING | Width 1 on BOTH lanes — no shared-`currentProgram` races on WebGL2. |
| 4 | BLOCKING | `stopOnFailure` aborts the queue on first rejection; warm draw is the fail-open; `render()` re-seats handler state (verified). No "arbitrary rejection isolation" claim remains. |
| 5 | BLOCKING | Sync culling helper; disabled windows contain zero awaits (fronts + warm draw); watchdog/generation interleaving structurally impossible. |
| 6 | BLOCKING | Generation-guarded settle callbacks + stamps; cancelled/resumed runs are side-effect-free. |
| 7 | BLOCKING | Tested `--slice-e` evaluator, fail-closed on mode/counts/failures/tail bounds; `--slice-d` frozen. |
| 8 | BLOCKING | requested/dispatched/settled/failed stamps + uuid-keyed exactly-once + nonzero-inventory requirement in the evaluator. |
| 9 | SHOULD-FIX | manifest baselineSha/candidateSha (required by `--slice-e`) + paired improvement bound; full artifact identity declared. |
| 10 | SHOULD-FIX | Moot at width 1; sweep declared alongside the upstream primitive. |
| 11 | SHOULD-FIX | §4.5 — same yield structure as shipped slice D; preRevealTotalMs compared in evidence; dedicated rAF-gap lane declared. |
| 12 | SHOULD-FIX | Observer-safe callbacks; NaN/empty/cancellation/abort tests; the generic-pool concurrency tests are replaced by serial-queue contract tests. |
| 13 | SHOULD-FIX | `.env.example` truncation restored from HEAD (tooling artifact, not slice E); spec file inventory corrected (runtime = World3DCanvas.tsx + boot-core-compile.ts + resource-ledger.ts); only slice-E files staged; same-diff docs in §4.4. |
| 14 | INFO | Presented arming unchanged. |
| 15 | INFO | Root-uuid uniqueness warn + root identity in logs. |

## 6b. Codex R2 findings ledger (rev 2 → rev 3)

| # | Sev | Resolution in rev 3 |
|---|---|---|
| 1 | BLOCKING | `chainBootCompile` renderer-wide FIFO + `awaitBootCompileIdle()` in deferred-warm and stage-warm compile paths (§2a-pre); chain unit tests incl. in-flight-predecessor ordering. |
| 2 | BLOCKING | Subtree-signature exactly-once + late-phase recompile on change + `bootCoreCompileRenderables` stamp (§2b). |
| 3 | BLOCKING | PAIRED per-run improvement median ≥ 300ms; 95% lower bound reported; the R2 counterexample is a regression test. |
| 4 | BLOCKING | All advertised stamps required; nonneg durations; integer counts; `tail ≤ wall`; `wall = hidden + tail` (±1.5ms); counterexamples tested. |
| 5 | BLOCKING | CLI refuses `--slice-e --watchdog-lane`; `evaluateSliceEGate` itself refuses any lane ≠ player-vrm. |
| 6 | BLOCKING | Runner derives SHAs (`-dirty` on tracked modifications), rejects disagreeing overrides; gate refuses missing/identical/dirty SHAs — the batch measures a committed candidate. |
| 7 | BLOCKING | `.env.example` truncation ROOT-CAUSED: the itachi-env sync hook was pushing a corrupt 1-line remote v7 into every checkout on session events; fixed at the SOURCE (correct 548-line content pushed as sync v8; the stale `.env.local` v1 that gutted worktree envs replaced by v2). Local files restored; the commit uses an explicit slice-E allowlist; docs land same-diff. |
| 8 | BLOCKING | `land-appearance-options` + `land-proximity` failures REPRODUCED ON PRISTINE `dc44a10d` — pre-existing branch drift from the staging merge (land-domain pin tests vs shipped land constants), NOT slice-E debt. Filed to the land domain per the ownership registry; acceptance §4.3 scopes "suite green" to exclude exactly these two documented pre-existing failures. |
| 9 | SHOULD-FIX | Adopted verbatim: improvement-primary ≥ 300ms paired + 1000ms absolute ceiling + the retained ≤ 5s presented gate. |
| 10 | SHOULD-FIX | Added: chain/generation tests, sync-culling throw/restore tests, negative/fractional/accounting stamp tests, unpaired-counterexample test, identity tests, lane tests. A live same-root-gains-mesh case is exercised by every authenticated batch run (activity-indicators populates pre-reveal). |
| 11 | INFO | R2 independently verified the r185 sync-front claims, render() state re-seat, rejection handling, scansEndAt scoping, and generation-guarded stamps. |

## 7. Revert plan

Single-commit revert restores the slice-D state (`dc44a10d`). Runtime files: `World3DCanvas.tsx`,
`boot-core-compile.ts` (new), `resource-ledger.ts` (additive sync helper). Rig: `cold-load-paired-gate.mjs`
(additive `--slice-e`), `cold-load-ab-runner.sh` (manifest SHA fields), tests. No schema/asset/contract changes.
