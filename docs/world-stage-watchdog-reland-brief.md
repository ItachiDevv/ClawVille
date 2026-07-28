# World-Stage Watchdog RE-LAND — Frozen Brief v2 (2026-07-27)

**Status: FROZEN v2 after Codex critique round 1 (VERDICT: REJECT — all findings
folded).** Author: Fable (planner/reviewer). Executor: Codex via /copus-max.
Branch: `feat/watchdog-reland` off `staging` (worktree
`C:/Users/itachi/Documents/Crypto/cv-covefreeze`, staging = `89b6daac`).
v1 is in git history; v2 SUPERSEDES it entirely.

## Root-cause CORRECTION (folded from critique round 1 — read first)

The v1 narrative ("silent retry orphans the parked adopted navigation — the
exact revert cause") is **not reachable under production timings**:

- A parked navigation is committed and cleared at the 250 ms opaque midpoint
  (`WorldStageRoot.tsx:207-229` is the OPAQUE-midpoint handler, not a
  completion handler; completion is `stage-store.ts:304-329`).
- A v3 watchdog retry cannot fire before ~75 s visible (45 s timeout + 30 s
  stall window). By then no parked ref exists.
- `ADOPT` is only possible during `fadingOut` (250 ms window)
  (`stage-navigation-ownership.ts:24-36`); after the midpoint, same-scene
  navigation is `EXECUTE_NOW`.
- `/kelp` never touches the stage-navigation bridge at all — its exit is the
  generic `SceneTransition` → `router.push` (`app/kelp/page.tsx:135-156`).

**Revised incident hypothesis (drives priority):** the live prod wedge
(input-blocking opaque overlay; kelp portal click that never changed the URL)
is most consistent with the **cove compile dedupe wedge** — a watchdog retry
mints a new generation whose warmup `await`s the SAME never-settling
`compileAsync` promise forever → overlay stays opaque + input-blocking
indefinitely. Fix C is therefore **P0**, and Fix A is DOWNGRADED to
**defensive hardening** contingent on a reproduction attempt (Fix A0).
The plan-doc INCIDENT LEDGER root-cause entry must be corrected in the same
diff as this work (see Docs section).

## Fix C — bounded cove compile await (P0 — probable real revert cause)

**Bug:** `StageHostedCoveScene.tsx:20-21,77-99` — module-level
`inflightCoveCompile` keyed by renderer; cleanup only in the compile promise's
`.finally`. A never-settling `compileAsync` wedges every later generation
(including watchdog-retry generations) forever.

**Required design (exact semantics from critique):**
- Renderer-keyed entry `{ compilePromise, timedOut, settled }`.
- Per-generation wait = `Promise.race(compilePromise, sentinel timer 20 s)`.
  The timeout **resolves a sentinel — never rejects** (no unhandled-rejection
  path).
- Cleanup + rejection handling attach to the ORIGINAL compile promise, never
  the race (a race-attached `.finally` would clear the entry while
  `compileAsync` still runs → double-compile).
- On timeout: set `timedOut = true`, `console.warn`, and CONTINUE through the
  direct `gl.render` warm + ack path (the current `catch` placement at
  :101-111 must not skip the direct warm on timeout — restructure so timeout
  is not an exception path).
- `timedOut` entry = renderer TOMBSTONE: retained until renderer replacement
  (`gl` identity change). Later generations seeing a tombstone bypass compile
  entirely and proceed to direct render — never re-issue `compileAsync` on
  that renderer, even after late settlement of the original promise.
- Late settlement AFTER timeout: original-promise handlers must not clear the
  tombstone in a way that lets a later remount start a second compile on the
  same renderer; late REJECTION must land in an attached handler.

**Proof required:** unit tests (extract the entry-management into a testable
seam if needed) covering: late resolve, late reject, timeout→bypass on next
generation, generation supersession mid-wait, renderer replacement clears the
tombstone. Plus synthetic lane still 30/30.

## Fix B — verdict-machine watchdog with budgets + activity classes (P0)

Replaces v3's inline tick logic. Extract a PURE REDUCER
(`stage-watchdog-machine.ts`, mirroring `world-stream-machine.ts`): state
INCLUDES request identity, phase/terminal status, visible-elapsed clocks,
per-attempt activity high-water marks, attempt index, and chain budget. A
terminal request always returns `none`; a new request identity initializes
fresh state. (v1's stateless signature could not enforce Fix D — corrected.)

**Budgets (explicit contract — replaces v1's rejected 240s-per-attempt):**
- `SOFT_TIMEOUT_MS = 45_000` (prod default, prop-driven as today): soft
  trigger = elapsed ≥ timeout AND no activity of ANY class for
  `STALL_WINDOW_MS = 30_000`.
- `HARD_CEILING_MS = 90_000` per attempt: fires only if no GENUINE progress
  in the trailing `STALL_WINDOW_MS`; genuine progress may extend the attempt
  past 90 s…
- …up to `ATTEMPT_MAX_MS = 150_000` per attempt (absolute, no extension), and
- `CHAIN_MAX_MS = 240_000` absolute visible-time across the WHOLE attempt
  chain (both attempts + retry). At chain-max: fail immediately — do NOT
  spend a retry that cannot fit.
- Exactly ONE silent retry per scene (latch semantics unchanged from v3).
- Worst-case time-to-card = 240 s visible (vs v1's rejected 480 s; vs prod's
  45 s false-failure on genuinely progressing boots — the incident class).
  Hidden time still pauses all clocks (visible-time semantics + 2× cadence
  clamp preserved verbatim from v3).

**Activity classes (with high-water semantics — v1's per-tick comparison is
BANNED, it misreads the loader's bridge re-zero as progress):**
- GENUINE (extends hard ceiling, world-scene requests ONLY):
  `__W3D_TEXTURE_UPLOAD_DONE` exceeding the attempt's historical MAXIMUM
  while `TOTAL > 0`; `__W3D_CANVAS_READY` / `__W3D_TEXTURES_READY` false→true
  at most ONE genuine edge per attempt (never re-fires after
  true→false→true). Decreases/resets never lower the high-water. Seed the
  machine from the first snapshot.
- NOISE (defers soft trigger only — exactly v3's semantics): everything else,
  INCLUDING `__W3D_PROGRESS` movement (it is the GLOBAL
  DefaultLoadingManager ratio, non-monotonic across drain/refill, and can
  reflect unrelated loads — critique MAJOR 4), slot status transitions,
  recovery count changes.
- COVE requests get NO genuine-class signals (the bridge writers are
  world-scoped: `World3DCanvas.tsx:1416-1511`; `StageHostedCoveScene` writes
  none; late world post-ready scans run up to 60 s and must never extend a
  cove attempt — critique MAJOR 4). Cove relies on slot lifecycle (noise
  class) + Fix C's bounded compile, so a cove wedge escapes at ~20 s via the
  compile sentinel and the watchdog card lands at v3-equivalent timings.

**Proof required:** reducer unit tests: upload crawling 1-file/10s past 90 s →
no retry until attempt-max; upload frozen 30 s past soft window → retry;
noise-only churn → hard at 90 s (v3 preserved); bridge re-zero mid-attempt →
NOT genuine; boolean re-assert → no second edge; chain-max → immediate fail
with no wasted retry; terminal state → `none` forever; new request identity →
fresh state. Fix D lives here as assertions (v3's guards
`StageTransition.tsx:121-127,166-180` + `stage-store.ts:331-355` verified
airtight in critique — preserve them and pin with tests).

## Fix A0 — deterministic reproduction attempt (before any lineage code)

Write a regression test (jsdom/unit against WorldStageRoot + stage-store +
ownership modules) that attempts to reproduce a parked `navigationRef`
surviving past the opaque midpoint under PRODUCTION timings (250 ms fade,
45 s timeout — no test-only timing that fires the watchdog before the
midpoint; that would manufacture a race prod cannot reach). Record outcome
honestly in the notes doc:
- If reproducible → Fix A upgrades back to a root-cause fix; ledger entry
  updated with the exact sequence.
- If NOT reproducible → Fix A ships as defensive hardening; the plan-doc
  INCIDENT LEDGER is corrected to name Fix C's class as the probable cause
  and the orphan narrative as unconfirmed.

## Fix A — retry lineage (defensive hardening; exact rules from critique)

Implement ONLY with the following semantics (critique MAJOR 6 state matrix is
BINDING — reproduce it in the notes doc with each row's disposition):
- Lineage is an OPTIONAL FIELD on the pending request
  (`retryOfRequestId?: number`) minted by a new store action
  `retryStageScene(previous: StageRequest)` — atomic, records the direct
  parent id. NOT a separate map (separate maps outlive resets:
  `resetStage` zeroes id minting on every stage-root mount,
  `stage-store.ts:93-110,410-420` + `WorldStageRoot.tsx:89-93`, so a map
  could match a reused id).
- StageTransition's silent retry calls `retryStageScene`; a stale watchdog
  calling it after supersession is a NO-OP (identity revalidated in the
  action).
- WorldStageRoot's parked-ref matching: match exact requestId OR exact
  `retryOfRequestId` chain to the parked id; commit once and clear. Re-key
  via compare-and-swap only — a new ADOPT during the retry's `fadingOut`
  overwrites the ref under the retry id and must not be clobbered.
- Different-scene supersession overwrites the parked ref (existing
  `WorldStageRoot.tsx:196-203` behavior); stale retry callbacks fail identity
  validation.
- Lifecycle clearing: completion clears via `pendingRequest: null`
  (`stage-store.ts:304-327`); failure retains `pendingRequest` — lineage goes
  with it on supersede/reset; stage unmount mid-request: specify and
  implement `navigationRef` cleanup on unmount (today
  `markWorldStageUnmounted` only flips a boolean, `stage-navigation.ts:75-81`
  — the parked ref must not survive a remount).

## New MANDATORY probe gate lanes (mechanics from critique — adopt verbatim)

Parser: extend the lane whitelist (`world-stage-probe.mjs:24-30`); each new
lane gets a DISTINCT output summary file (defaults at :83-90 must not
overwrite the routes/synthetic summaries). Real-route lanes start the API
stub exactly like `routes`.

- **Lane `loader`:** `page.goto('/')` → install a same-document
  MutationObserver → click the real homepage `a[href="/game"]` Link
  (`app/page.tsx:209-221`) → assert: `[aria-label="Loading ClawVille"]`
  appeared while `__W3D_READY !== true`; topmost via
  `document.elementFromPoint(center)?.closest('.claw-loading-overlay') ===
  overlay` (loader is body-portaled + pointer-blocking:
  `sea-loading-screen.tsx:308-315,397-408,725-727`); max `aria-valuenow > 0`;
  loader disappearance requires GENUINE `__W3D_READY === true` (the 45 s
  force-dismiss must not false-pass).
- **Lane `kelp-exit`:** boot `/game` → set
  `window.__CV_STORES__` gameStore `nearLocation` to the kelp portal
  (`World3DCanvas.tsx:1427-1432`, `location-hud.tsx:43-45,66-80,100-104`) →
  click the REAL HUD portal button (production `SceneTransition` path — no
  test code on /game) → assert URL `/kelp` + kelp canvas painted
  (`app/kelp/page.tsx:123-133,158-167`) → click the real "Back to the Reef"
  exit with a MutationObserver armed → assert: client-side navigation (window
  sentinel survives — this is `router.push`, NOT a document reload; only the
  `(world)` layout/stage unmounts+remounts), URL `/game`, fresh
  `__WORLD_STAGE_PROBE__` installed, loader observed while not ready,
  `__W3D_READY === true`, loader absent, `data-stage-transition="idle"`,
  `elementFromPoint` over an unobstructed point = the stage canvas.
- **Lane `retry-adoption`:** runs on `/perf/stage` (proof route). Wedge the
  FIRST generation's ack via a proof-route-only knob in `useSyntheticWarmup`
  (`stage-proof.tsx:43-71`) + tiny thresholds via the existing
  `transitionTimeoutMs` plumbing (`WorldStageCanvas.tsx:655-662,1033-1037`)
  → assert the silent retry completes to idle. SCOPE HONESTY (critique
  MAJOR 7): the proof route has NO WorldStageRoot/navigationRef — this lane
  covers watchdog retry + store lineage only; `navigationRef` re-key coverage
  comes from the Fix A0/Fix A unit tests. State exactly that in the notes.
  No test-only code reachable from `/game`.

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

Port-preflight kill any zombie :3000/:4000 holders before lanes. Soak
thresholds per the v4.1 calibration (P1c brief) — unchanged.

## Docs (same diff)

- This brief (v2) committed; execution-ledger entry in
  `docs/persistent-world-canvas-plan-2026-07-24.md` INCLUDING the
  root-cause correction to the 2026-07-28 INCIDENT LEDGER (orphan narrative
  → unconfirmed/downgraded; compile-wedge → probable cause; final wording
  depends on Fix A0's outcome).
- Notes doc `docs/world-stage-watchdog-reland-notes.md`: Fix A0 outcome, the
  MAJOR-6 state matrix with dispositions, lane scope-honesty statement,
  worst-case timing table (fast-fail / noise-only / genuine-slow /
  wedge, vs v3 and prod).
- `deploy-status.md` on the staging push (Fable's step, not Codex's).

## Hard constraints (unchanged from v1)

- Visible-time clock semantics (hidden pauses; 2× cadence clamp).
- ONE silent retry per scene; latch clears on idle.
- Iris Xe rules (no drei Text/Billboard, no InstancedMesh+ShaderMaterial, no
  per-frame allocations).
- No test-only code reachable from `/game`.
- No staging push by Codex — Fable reviews + runs gates first. Never master.
