# World-Stage Watchdog RE-LAND — Frozen Brief v3 (2026-07-27)

**Status: FROZEN v3 after Codex critique rounds 1 (REJECT) + 2 (REJECT) — all
findings folded.** Author: Fable (planner/reviewer). Executor: Codex via
/copus-max. Branch: `feat/watchdog-reland` off `staging` (worktree
`C:/Users/itachi/Documents/Crypto/cv-covefreeze`, staging = `89b6daac`).
v1/v2 in git history; v3 SUPERSEDES both. Round-2 report:
`CODEX-REPORT-watchdog-reland-round2.md` (repo root; delete before merge).

## Root-cause status (PROVISIONAL — corrected per R1 + R2 MINOR 1)

- The v1 "silent retry orphans the parked adopted navigation" ordering is NOT
  production-reachable: parked navigation commits/clears at the 250 ms opaque
  midpoint (`WorldStageRoot.tsx:207-226`); a v3 retry cannot fire before
  ~75 s; ADOPT exists only during `fadingOut`
  (`stage-navigation-ownership.ts:19-36`); `/kelp` never touches the stage
  bridge (`app/kelp/page.tsx:147-156` → generic `SceneTransition`).
- **Provisional hypothesis** for the prod wedge: the cove compile-dedupe wedge
  (a never-settling `compileAsync` blocks every generation's warmup await).
  NOTE (R2 MINOR 1): with a responsive event loop, v3's watchdog still bounds
  the overlay (retry → card ~180 s) — the promise is indefinite, the overlay
  is not necessarily so. A synchronous renderer/main-thread hang is outside an
  interval watchdog's recoverable model. Keep "probable cause" provisional
  until Fix A0 + a targeted compile-wedge reproduction provide evidence; the
  plan-doc INCIDENT LEDGER correction must carry this provisional wording.

## Fix C — bounded, renderer-scoped cove warmup (P0)

Current: `StageHostedCoveScene.tsx` — module singleton `{gl, promise}`
(:13-21), cleared only by promise `.finally` (:78-97), every generation awaits
it (:99); `try` encloses compile AND direct warm (:75-109) so a compile
rejection skips the direct render; component-local `warmedOnceRef<boolean>`
(:40-42) is renderer-AGNOSTIC.

Required design:
1. Renderer-keyed entry `{ compilePromise, timedOut, settled }`. Per-generation
   wait = `Promise.race(compilePromise, 20 s sentinel)`. **The sentinel
   RESOLVES — never rejects.** Cleanup + rejection handling attach to the
   ORIGINAL compile promise, never the race (race-attached `.finally` would
   clear the entry while `compileAsync` still runs → double-compile).
2. On timeout: `timedOut = true`, `console.warn`, continue. `timedOut` entry =
   renderer TOMBSTONE retained until renderer replacement (`gl` identity
   change); later generations bypass compile entirely — never re-issue
   `compileAsync` on that renderer, even after late settlement. Late rejection
   lands in an attached handler (no unhandled rejection).
3. **Direct warm is unconditional and separately guarded (R2 MAJOR 3):**
   whether compile settles, times out, or REJECTS, a still-current generation
   proceeds to ONE separately guarded direct `gl.render` warm attempt. Compile
   rejection is logged, not control flow around the direct warm.
   Direct-render failure is caught separately; after direct-render success OR
   handled failure, re-check current generation before unpausing and acking.
4. **Renderer-scoped completion (R2 BLOCKER 3):** replace
   `warmedOnceRef<boolean>` with `warmedRendererRef: { gl: unknown } | null`.
   Skip warmup only when `warmedRendererRef.current?.gl === gl`. Renderer
   recovery replaces `gl` IN-PLACE without remounting
   (`WorldStageCanvas.tsx:350-371,417-427`) — the replacement renderer must
   run its own compile-or-direct-warm path. Set the warmed renderer only after
   the direct warm attempt completes for the current generation.

Proof: unit tests at the entry seam (late resolve, late reject,
timeout→bypass, supersession mid-wait, renderer replacement clears tombstone)
PLUS component-level coverage proving an in-place `gl` replacement executes
warmup once on the replacement renderer (entry-seam tests alone can pass while
the component bypasses the seam). Synthetic lane still 30/30.

## Fix B — pure reducer watchdog with chain budgets (P0)

New module `stage-watchdog-machine.ts` (pattern: `world-stream-machine.ts`).
An ADAPTER in StageTransition reads store/window ONCE per tick and passes a
plain sample; the reducer reads no globals/store (sampling outside the reducer
is not impurity; consulting them inside is).

**Explicit types (R2 MAJOR 1 — define in code exactly):**
- `WatchdogSample`: request identity + lineage (`requestId`,
  `retryOfRequestId`), scene kind (`world | cove`), transition phase, terminal
  flag, full readiness tuple for the current generation (slot `ready` +
  camera ack match + first-controlled-frame match), slot status, recovery
  count, load progress, upload total/done, canvas-ready, textures-ready,
  hidden flag, clamped visible delta (≤ 2× cadence).
- `WatchdogState`: `chainRootRequestId`, `currentRequestId`, chain/attempt
  clocks, last-any-activity time, last-genuine time, upload high-water,
  boolean-edge latches (canvas seen / textures seen), attempt index, terminal
  verdict.
- `reduceWatchdog(state, sample, config) → { state, verdict }`, verdict ∈
  `none | silent-retry | fail-card`.

**Chain identity (R2 BLOCKER 1 — verbatim contract):** every chain has a
stable `chainRootRequestId` distinct from the current generation's
`requestId`. An unrelated request identity initializes a NEW chain. A request
whose `retryOfRequestId` exactly equals the machine's current request
CONTINUES the chain: preserve `chainElapsedMs`, increment `attemptIndex`,
reset only per-attempt clocks/high-waters/edge latches, replace
`currentRequestId`. Any other new identity starts fresh. Chain + attempt
clocks start when the request is MINTED (includes `fadingOut` — matches v3's
accrual; do not leave the origins inferable).

**Budgets:** `SOFT_TIMEOUT_MS` 45 000 (prop-driven as today) ·
`STALL_WINDOW_MS` 30 000 · `HARD_CEILING_MS` 90 000 · `ATTEMPT_MAX_MS`
150 000 · `CHAIN_MAX_MS` 240 000. A retry is allowed iff
`chainElapsedMs < CHAIN_MAX_MS`; its effective attempt budget is
`min(ATTEMPT_MAX_MS, CHAIN_MAX_MS − chainElapsedMs)` (a retry minted at chain
200 s gets a 40 s truncated attempt). At `chainElapsedMs ≥ CHAIN_MAX_MS`:
fail-card immediately, never mint an unfittable retry. Exactly ONE silent
retry per scene (latch unchanged). Worst-case time-to-card = 240 s visible.

**Tick pipeline + precedence (R2 MAJOR 2 — verbatim contract):** on each
visible tick: (1) identity/terminal/readiness guards — a satisfied
current-generation readiness tuple, `fadingIn`, `idle`, or terminal error
returns `none` BEFORE charging clocks or evaluating any ceiling (pins v3's
ready-at-ceiling race, `StageTransition.tsx:130-139`); (2) apply the clamped
delta; (3) classify and record the current sample; (4) evaluate ceilings in
deterministic precedence `chain-max > attempt-max > hard-stall > soft-stall`.
Stall = `elapsedMs − lastObservedMs ≥ STALL_WINDOW_MS` (half-open trailing
interval `(elapsed − window, elapsed]`): a genuine increase first observed ON
the 90 s sample defers the 90 s hard verdict; one last observed at 60 s does
not. Soft trigger = elapsed ≥ soft-timeout AND any-activity stall. Hard
trigger = elapsed ≥ hard-ceiling AND genuine stall.

**Activity classes (high-water semantics; per-tick comparison BANNED):**
- GENUINE (world requests ONLY): `__W3D_TEXTURE_UPLOAD_DONE` exceeding the
  attempt's historical MAXIMUM while `TOTAL > 0`; canvas/textures-ready
  false→true, at most ONE edge per attempt (never re-fires after
  true→false→true). Decreases/resets never lower high-water. Seed from first
  snapshot. (Loader re-zeroes the bridge on mount,
  `sea-loading-screen.tsx:140-168` — must not read as progress.)
- NOISE (defers soft only — v3 semantics): everything else INCLUDING
  `__W3D_PROGRESS` (global non-monotonic manager ratio), slot status
  transitions, recovery count.
- COVE requests: NO genuine class (bridge writers are world-scoped,
  `World3DCanvas.tsx:1416-1511`; late world post-ready scans run up to 60 s,
  `:1691-1707`, and must never extend a cove attempt). Cove recovery is
  Fix C's sentinel (~20 s escape → direct warm + ack normally SUCCEEDS, no
  card); only if the fallback cannot complete does the normal contract lead
  to retry/card.

**Reducer tests (minimum):** upload crawling 1-file/10 s past 90 s → no
verdict until attempt-max; upload frozen 30 s past soft window → retry;
noise-only churn → hard at 90 s; mixed: genuine at 65 s then silence → ONE
named verdict at 95 s (precedence pinned); bridge re-zero mid-attempt → not
genuine; boolean re-assert → no second edge; retry continuation preserves
chain clock (retry at 200 s → 40 s truncated attempt → chain card at 240 s);
chain-max → immediate fail, no retry mint; terminal → `none` forever; new
unrelated identity → fresh chain; readiness-tuple satisfied at ceiling tick →
`none`; hidden ticks charge nothing. Fix D (no post-fail verdicts) is pinned
here: v3's guards (`StageTransition.tsx:121-139,166-180`,
`stage-store.ts:331-355`) are verified airtight — preserve them AND assert in
the reducer.

## Fix A0 — deterministic reproduction attempt (before any lineage code)

Unit/jsdom regression against WorldStageRoot + stage-store + ownership
modules attempting to reproduce a parked `navigationRef` surviving past the
opaque midpoint under PRODUCTION timings (250 ms fade, 45 s soft — no
test-only timing that fires the watchdog before the midpoint). Also attempt a
targeted compile-wedge reproduction (wedged `compileAsync` + v3 watchdog →
observe whether the overlay is bounded by the card). Record outcomes honestly
in the notes doc; ledger wording depends on them (reproducible → root-cause
fix; not → defensive hardening + provisional narrative).

## Fix A — retry lineage (defensive hardening)

- Lineage = OPTIONAL FIELD on the pending request (`retryOfRequestId?:
  number`) minted atomically by new store action
  `retryStageScene(previous: StageRequest)`; identity revalidated inside (a
  stale watchdog calling after supersession is a NO-OP). NOT a side map
  (request ids are REUSABLE across mounts: `resetStage` zeroes
  `requestSequence`, `stage-store.ts:93-110,410-420`, and the root resets on
  mount, `WorldStageRoot.tsx:89-93`).
- StageTransition's silent retry calls `retryStageScene`.
- Parked-ref matching in WorldStageRoot: exact `requestId` OR exact
  `retryOfRequestId` == parked id; commit once and clear; re-key via
  compare-and-swap only (a new ADOPT during the retry's `fadingOut` overwrites
  the ref under the retry id and must not be clobbered). Different-scene
  supersession overwrites the parked ref (existing behavior).
- Lifecycle: completion clears via `pendingRequest: null`; failure retains
  `pendingRequest` (lineage goes with it on supersede/reset); stage unmount
  mid-request MUST clear `navigationRef` (today `markWorldStageUnmounted` only
  flips a boolean, `stage-navigation.ts:75-81` — the parked ref must not
  survive a remount).
- The R1 MAJOR-6 state matrix is BINDING — reproduce in the notes doc with
  each row's disposition.

## Probe gate lanes (mechanics per R2 — BLOCKER 2 + MAJORs 4/5 folded)

Parser: extend the lane whitelist (`world-stage-probe.mjs:24-30`); each new
lane gets a DISTINCT output file (defaults `:83-90` must not overwrite
routes/synthetic summaries). `loader` + `kelp-exit` start the API stub like
`routes`; `retry-adoption` is proof-route (synthetic-style).

- **Lane `loader`:** `page.goto('/')` → same-document MutationObserver →
  click the real `a[href="/game"]` (`app/page.tsx:209-221`) → assert:
  `[aria-label="Loading ClawVille"]` appeared while `__W3D_READY !== true`;
  topmost via `document.elementFromPoint(viewport center)?.closest('.claw-loading-overlay') === overlay`
  (body-portaled + pointer-blocking,
  `sea-loading-screen.tsx:308-315,397-408,725-727`); max `aria-valuenow > 0`
  (`:645-649`); loader disappearance requires GENUINE `__W3D_READY === true`
  (the REAL force-dismiss is 45 s, `:75,177-187` — must not false-pass).
- **Lane `kelp-exit` (R2 BLOCKER 2 fixture contract):** install deterministic
  route-stub fixtures for `GET /api/avatars/me` (valid avatar) + the matching
  auth/session response BEFORE `page.goto('/game')` (LocationHUD renders only
  when `hasAvatar`, `app/(world)/game/page.tsx:542-545,662-664`, and returns
  null in explore mode, `location-hud.tsx:26-45`). After world readiness set
  BOTH `controlMode: 'player'` AND `nearLocation: 'kelp-forest-portal'` via
  `window.__CV_STORES__.useGameStore`, wait for
  `button[aria-label="Walk through to enter the Kelp Forest"]`
  (`location-hud.tsx:100-104`), click the REAL button (production
  `SceneTransition` path). Record these stub endpoints separately from
  unexpected-stub traffic. Assert: URL `/kelp`; **kelp paint predicate (R2
  MAJOR 5):** after the kelp loading overlay is absent, screenshot a fixed
  rectangle and require minimum non-background color variance PLUS a
  connected canvas with non-default backing dimensions (finding `<canvas>` is
  NOT paint). Then click the real "Back to the Reef"
  (`app/kelp/page.tsx:168-185`) with an observer armed → assert: SPA
  navigation (window sentinel survives — `router.push`, not a document
  reload), URL `/game`, fresh `__WORLD_STAGE_PROBE__`
  (`WorldStageRoot.tsx:231-277`), loader observed while not ready,
  `__W3D_READY === true`, loader absent, `data-stage-transition="idle"`
  (`StageTransition.tsx:242-250`), and hit-test: `elementFromPoint(viewport
  center)` = the `.world-stage-root canvas` element (or its documented
  wrapper) — numeric point, exact element.
- **Lane `retry-adoption` (R2 MAJOR 4 option A):** add a PROOF-ROUTE-ONLY
  `watchdogConfig` prop plumbed through `WorldStageCanvas` → `StageTransition`
  (tick, soft, stall, hard, attempt-max, chain-max; the `/game` call site
  supplies NO test config — absence = production constants). Wedge the FIRST
  generation's ack via a proof-route-only knob in `useSyntheticWarmup`
  (`stage-proof.tsx:43-71`). Assert silent retry completes to idle. Dedicated
  deadline — do NOT reuse `waitForSettled`'s 30 s
  (`world-stage-probe.mjs:361-381`). SCOPE HONESTY: covers watchdog retry +
  store lineage only; `navigationRef` re-key coverage comes from Fix A0/A
  unit tests — state exactly that in the notes. No test-only code reachable
  from `/game`.

## Acceptance gates (Fable re-runs every one personally; commands verbatim)

```text
bun run build
bun run typecheck
bun test apps/web
bun run --filter @clawville/web start   # :3000 prod bundle; NEVER bun run dev
bun apps/web/scripts/world-stage-probe.mjs --lane=synthetic
bun apps/web/scripts/world-stage-probe.mjs --lane=routes
bun apps/web/scripts/world-stage-probe.mjs --lane=loader
bun apps/web/scripts/world-stage-probe.mjs --lane=kelp-exit
bun apps/web/scripts/world-stage-probe.mjs --lane=retry-adoption
bun apps/web/scripts/world-stage-probe.mjs --lane=soak --loops=60
```

Port-preflight kill any zombie :3000/:4000 holders first. Soak thresholds per
v4.1 calibration — unchanged.

## Docs (same diff)

- This brief committed; execution-ledger entry in
  `docs/persistent-world-canvas-plan-2026-07-24.md` INCLUDING the PROVISIONAL
  root-cause correction to the 2026-07-28 INCIDENT LEDGER (orphan narrative
  unreachable as stated; compile-wedge provisional pending Fix A0 evidence;
  overlay bounded by watchdog under responsive event loop).
- Notes doc `docs/world-stage-watchdog-reland-notes.md`: Fix A0 + wedge-repro
  outcomes, the R1 MAJOR-6 matrix with dispositions, lane scope-honesty,
  worst-case timing table (fast-fail 90 s / noise-only 180 s / genuine-slow
  240 s / cove-wedge ~20 s recovery) vs v3 and prod-blind-timer.
- Delete `CODEX-REPORT-watchdog-reland-round2.md` from the repo root (it was
  written by the R2 critique session; archive content lives in the scratchpad
  report).
- `deploy-status.md` on the staging push (Fable's step).

## Hard constraints (unchanged)

- Visible-time semantics (hidden pauses; 2× cadence clamp). ONE silent retry
  per scene; latch clears on idle. Iris Xe rules. No test-only code reachable
  from `/game`. No staging push by Codex — Fable reviews + runs gates first.
  Never master.
