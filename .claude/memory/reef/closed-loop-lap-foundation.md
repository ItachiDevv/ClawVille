---
name: closed-loop-lap-foundation
description: "Phase 1a-BACKEND — the curvy CLOSED-LOOP LAP foundation: what was wired, the bugs found + fixed, and the invariants the render pass must honor"
category: solution
confidence: high
date: 2026-06-23
---

## Phase 1a-BACKEND — CLOSED-LOOP curvy LAP foundation (FIXED, built — needs verification)

Branch `feat/reef-race-rebuild` (worktree `cv-reef`). NOT pushed, NOT deployed.
Built on top of the already-committed `0693e8a8` (periodic `{closed:true}` ReefSpline)
+ the uncommitted track-layout closed-ring rewrite the prior agent left.

### What the prior agent left half-done (the trap)
`track-layout.ts` was rewritten to a 20-CP closed ring with a doc-comment claiming
verified numbers — but **every consumer still built `new ReefSpline(REEF_RACE_DEFAULT_TRACK)`
WITHOUT `{ closed: true }`** (sim, bot, anti-cheat, web `reef-race-spline-instance`).
So they all built an OPEN spline over closed-loop CPs → the closing chord CP19→CP0
didn't exist (phantom-reflected endpoints instead). The track numbers ARE real (verified
by driving the closed spline: arc 30 434, +2π sweep, min R 304, 4 reversals, min self-dist
432) — NOT scaffolding theater. The gap was purely the missing `{closed:true}` at the
construction sites + the lap/finish machinery + anti-cheat that assumed the old open z-track.

### The lap model (the core of this phase)
- Per-body `lap` (completed-lap count, 0-based), within-lap `progress` (0..1, WRAPS at the
  seam), `startCrossed` (first forward seam cross = the START GUN, NOT a lap), `lastLapAt`,
  `progressInitialized` (seed progress from the spawn projection on the first tick so the
  0→0.99 spawn isn't read as a wrap).
- **Forward seam crossing** = `prev > 0.7 && newProgress < 0.3`. Unambiguous on a 30k-wu loop
  (a body moves ≤ ~0.0006 of the loop per tick, so it can NEVER legitimately jump 0.7→0.3
  except by wrapping). Bodies spawn BEHIND the line (project to t≈0.99); the first forward
  cross sets `startCrossed` (lap stays 0 = now on lap 1); each later cross `lap++`; finish
  when `lap` reaches `REEF_RACE_LAPS` (=3, alias of `REEF_LAPS`) and crosses the seam.
- Ordering metric = `totalProgress(lap, progress) = lap + progress`. Live position =
  (lap desc, within-lap progress desc; finishers by time; DNF last). NOT within-lap progress
  alone (a lap-2 leader at 0.1 beats a lap-1 racer at 0.9).
- `totalProgress` is NON-monotonic exactly ONCE — at the start gun (0.99→0.01, lap stays 0).
  Harmless for relative ordering (all racers cross the gun together). In the integration test
  the regression detector treats a totalProgress drop > 0.5 as a forward wrap (lap/gun), not
  a regression — the same trick the anti-cheat's wrap-adjust uses.

### Bugs FOUND + FIXED this phase (not just wiring)
1. **SPAWN off-track (critical).** The grid was anchored to world origin (0,0) — fine on the
   old open track where CP[0]≈origin, but the new CP[0] is at (-1600,-4300), so every kart
   spawned ~3290 wu off-track in the ISLAND CENTRE (projecting to a random t≈0.56). Fixed:
   anchor the grid at `centerlineAt(0)` (+ `-tangent*backZ` behind the line, `±normal*90`
   lateral). Now spawns project to t≈0.996-0.999, in-corridor, behind the line → first cross
   is the gun. **Lesson: any spawn/placement formula that offsets from a tangent/normal MUST
   add the centerline ANCHOR position; the old code only worked because CP[0] was near origin.**
2. **Timeouts didn't scale with laps.** `REEF_SOFT_TIMEOUT_MS=90s` ≈ ONE loop, but a race is
   3 laps (~277s) → everyone DNF'd mid-lap-2. Added `REEF_RACE_LOOP_SOFT_TIMEOUT_MS =
   REEF_SOFT_TIMEOUT_MS × REEF_RACE_LAPS` (+ hard) used ONLY by the spline sim (ellipse keeps
   the single-loop caps).
3. **Anti-cheat `buildSegmentTRanges` read `seg.zStart`/`zEnd`** (gone on the new t-range
   segments → compile error) AND its z-bisection is invalid (z non-monotonic on a loop).
   Rewrote to read `tStart`/`tEnd` directly + derive `minSegmentMs` from segment ARC LENGTH
   on the closed spline.
4. **`validateProgressMonotonic` flagged every lap wrap** (0.99→0.01). Wrap-adjust: a drop
   > 0.5 is a forward seam crossing, add 1.0 before judging.
5. **Bot lookahead `Math.min(1, tSelf+0.03)` clamped at the seam** → bot stalled at the
   start/finish line every lap. Changed to `(tSelf+0.03) % 1` (wrap). Same for the curvature
   sample. Bot view `lap` was `Math.floor(progress)` (always 0) → now real `b.lap`.

### Wire-type additions (render pass needs these)
`@clawville/shared/activities/protocol.ts`: `EntityDelta.changed` + `WorldState.scores[]` +
`ScoreDelta` gained `lap` / `position` / `totalLaps`. `event.lap_completed` now emitted by the
closed-loop sim too (real `splitMs`+`totalMs`+`totalLaps`); `event.crossed_finish` gained `lap`.
Keyframe `scores[].score` = `totalProgress` (whole-race), not within-lap progress.

### Synced countdown (salvaged from un-merged d490501f)
`activity-room-manager.ensureSyncedCountdown(roomId)` re-anchors a soon-to-expire 3-2-1 on WS
connect (`activity-ws-hub` calls it before `sendInit`). Sim-agnostic, idempotent, no-op on a
healthy window or a non-countdown/unknown room. Pre-existing sweeper test "aborts COUNTDOWN
rooms with no connected players" was STALE (expected immediate abort; the sweeper has a 10s
connect-grace) — fixed the test to age `countdownStartedAt` past the grace.

### Verification (built — needs verification)
- All reef + countdown suites: **324 pass / 0 fail / 1 skip** (12 files), incl. a full 8-body
  3-lap integration smoke that completes end-to-end (1 finisher, match_ended, zero regression,
  ~9300 ticks / ~8.5s wall — raised the per-test timeout to 30s).
- `bun run build` 9/9 tasks ✓.
- 3 pre-existing `BumperShellsBot` failures are UNRELATED (different activity, fail on baseline).

### Still OPEN (NOT this phase)
- 3D ribbon still renders the OPEN-era shape → a VISIBLE SEAM at the start/finish until the
  render pass builds the ribbon from the closed spline (web `clientSpline` is already
  `{closed:true}`, so the corridor MATH matches — it's the ribbon geometry/closure that's
  the render task).
- Responsive client prediction (fixed-timestep), surf-carving feel + drift-carve mini-turbo,
  water, surfer stance = Phase 1b–d.
- Founder real-keyboard playtest (synthetic MCP keys ignored) + staging deploy = the gate.

### Render-pass parity invariants (do NOT break)
- The 3D track ribbon MUST derive from `new ReefSpline(REEF_RACE_DEFAULT_TRACK, { closed: true })`
  (the web `clientSpline` singleton) — never a hand-authored parallel curve.
- HUD lap/position read `EntityDelta.changed.lap` / `.position` / `.totalLaps` (1-based display
  = `lap+1` / `totalLaps`).
- Start/finish line is at `centerlineAt(0)` XZ (-1600,-4300); spawn grid sits just behind it.
