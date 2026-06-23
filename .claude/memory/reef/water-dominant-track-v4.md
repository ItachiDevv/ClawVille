---
name: water-dominant-track-v4
description: "Reef Race v4 WATER-DOMINANT track redesign — the BIG/WIDE/WINDY closed ring, the numeric harness that locked it, and every geometry-coupled consumer touched"
category: solution
confidence: high
date: 2026-06-23
---

## Reef Race v4 — WATER-DOMINANT track redesign (built — needs verification)

Branch `feat/reef-race-rebuild` (worktree `cv-reef`). NOT pushed, NOT deployed.
Built on top of the v3 closed-loop foundation (see [[closed-loop-lap-foundation]]).

### The founder's art direction (the problem)
Side-on screenshot of `/preview/reef-race-v2`: the v3 race loop read as a NARROW blue
creek lined with brown rocks, sitting in the middle of a HUGE green LAND disc — most of
the footprint was unused land and terrain even COVERED parts of the water. It read as a
LAND map with a thin creek, not a WATER map you surf. Direction: river WIDER, MORE TURNS,
USE THE SPACE (convert the wasted land into windy surfing track).

### What changed (mine — the shared track + sim params)
- **`packages/shared/src/reef-race/track-layout.ts`** rebuilt v3→v4:
  - **27 control points** (was 20), arc **53 505.9 wu** (was 30 434).
  - Corridor **half-width 471–910 wu** (was 290–540) → the WATER corridor is now
    ~940–1820 wu WIDE (start straight hw≈900, bends 560–700, ess/hairpin 480–520).
  - Footprint **≈ 15 400 × 15 300 wu** (was ~10 400 × 9 000) — fills the play area.
  - **12 curvature reversals** (was 4) — sweeping bends + NE S-ess + upper-NE chicane +
    far-west U-hairpin. Min radius **378.7 wu** (>250 target, >192 floor).
  - `REEF_RACE_SEGMENTS` t-boundaries re-pinned to the new CP→t transitions.
- **`reef-race-config.ts`**: `REEF_LAPS` **3 → 2** (one loop ≈ 125–160 s; 3 laps = ~7–8 min,
  over the 2–4 min target). New `REEF_RACE_LOOP_LAP_BUDGET_MS = 180_000` (arc-grounded per-lap
  soft budget — the old 90 s ellipse cap would DNF everyone mid-lap-1 on the big ring);
  `REEF_RACE_LOOP_SOFT_TIMEOUT_MS = 180k × 2 = 360 s` + 30 s grace.
- **`reef-race-spline-sim.ts`** spawn grid widened for the wide start straight:
  `SPAWN_OFFSET_X` 90 → 320 (2 columns 640 wu apart), `SPAWN_SPACING_Z` 70 → 120.
- **NO sim/anti-cheat/bot LOGIC change** — they all derive arc / segment floors / spawn
  anchor (`centerlineAt(0)`) / lookahead from the spline at runtime, so they auto-adapt to
  the new geometry. Only timeouts + lap count + spawn spacing are tunables.

### The numeric harness (no-guessing method — REUSE THIS for any track edit)
Wrote `scratchpad/track-verify.ts` driving the REAL `new ReefSpline(cands, {closed:true})` and
reporting every load-bearing constraint at once: arc length, heading sweep (must be ±2.0000π),
curvature reversals, min radius of curvature (wrap-around finite diff), CP spacing, width sweep,
min non-adjacent self-distance, **min CORRIDOR CLEARANCE** (the wide-corridor check: centerline
gap minus the two halfWidths — must stay positive), footprint extent, inner-edge-from-origin
(island sizing), and arclength round-trip. Iterated cand1→cand4 (~5 passes) fixing a self-fold
at an inner bite-CP and a too-sharp hairpin cusp until all constraints passed. Also measured
cruise empirically by simulating `integrateSurfStep` (full-thrust straight = 496 wu/s, avg lap
pace ~387–427 wu/s humans / ~340 bots) to size the lap budget. NEVER hand-pick track numbers —
drive the real spline.

### The WIDE-corridor self-intersection lesson (the key v4 trap)
The old self-intersection guard checked only "min CENTERLINE distance > 88 wu" (the Newton-basin
guard). With a ~900-wu corridor that is NOT enough — the two sides of the loop (each ±900 wu of
WATER) can OVERLAP even when the centerlines are 1000 wu apart. The real check is **corridor
EDGE clearance = centerline gap − halfWidth_i − halfWidth_j > margin**. v4 verified value 1292 wu.
A NEW test (`reef-race-track-layout.test.ts` "WIDE corridor edges never touch") asserts this.
Also: the wide start straight's seam-adjacent samples (t≈0.99 vs t≈0.01) are the SAME physical
straight — the self-intersection skip window must span ~3200 wu of arc (was 700) or it
false-positives the start straight as two passes.

### Geometry-coupled consumers touched (the full map)
- `track-layout.ts` (CPs + segments + arc const) — mine, canonical home in `@clawville/shared`.
  The API-side `reef-race-track-layout.ts` is a re-export shim → rebuild `packages/shared` dist
  (`cd packages/shared && bun run build`) or the API/tests read the OLD track from stale dist.
- `reef-race-track-layout.test.ts` — bounds moved (CP 27, arc [50k,56k], WIDE hw, edge-clearance).
- `reef-race-bot.test.ts` V2-T3 — pickup-deviation rewritten to read the DETERMINISTIC pull
  (stub `Math.random→0.5` to kill jitter) since the 70-wu pickup nudge is sub-noise on the big
  ring's ~1600-wu lookahead arc. The old 0.015 averaged-lift gate only held on a short-lookahead
  straight.
- `reef-race-spline-sim-integration.test.ts` — breaks a short tail past the FIRST finisher (the
  2-lap big-ring race is more synchronous ticks; full 12000-tick run took ~26 s wall).
- **`reef-race-streak.ts` (shared) — the 36→24 DRIFT BUG (real, fixed).** `TOTAL_CHECKPOINTS_PER_RACE`
  was a hardcoded literal `36` (= 12×3) while the API config computes `12 × REEF_LAPS` = 24.
  With REEF_LAPS now 2, they DISAGREED → the perfect-race bonus (needs `bestStreak ≥ 36`) could
  NEVER fire (only 24 checkpoints exist). Fixed the shared literal to 24 + re-spaced `STREAK_MILESTONES`
  to `[5,10,16,20,24]` + `streakMilestoneKind` thresholds. Lesson: any shared literal mirroring a
  server-computed value is a drift hazard — grep for it whenever the underlying constant moves.
- **`reef-race-bot-winrate.test.ts` mock — pre-existing gap (fixed).** `mock.module('@clawville/database',…)`
  was missing the `activityReplays` named export (added to schema after the mock) → Bun threw
  "Export named 'activityReplays' not found" at module load. NOT a track regression; fixed the mock.

### Render (3da sub-team, same diff — see threejs bank)
`/preview/reef-race-v2` recomposed water-dominant: ground ribbon frames the water at hw+offset
out to +GROUND_W (never inward over the water), outer disc receded, ISLAND_RADIUS bumped to fit
the bigger inner radius (min inner edge 5657 wu from origin → island ≤ ~4800), camera re-framed
for the ±8000 footprint, stale linear-track props (canyon walls / fixed-Z finish gate / distance
markers / bridge) removed. See `.claude/memory/threejs/`.

### Verification status
- Reef sim/anti-cheat/bot/track/integration/reward suites GREEN in isolation
  (182 pass in the sim+reward+spline-sim+track batch; bot-winrate 11/0; anti-cheat 34/0).
- The 2 `closestPointOnSpline` perf-budget tests (50 ms / 1000 Newton calls) flake under
  concurrent CPU load — they use TEST-LOCAL splines (not the track) and `spline.ts` is
  untouched, so NOT a regression; pass 50/0 when the machine is idle.
- The 3 `BumperShellsBot` failures are the documented pre-existing baseline (different activity).
- `bun run build` 9/9 ✓.

### Still OPEN (the gate)
- In-browser parity check at `/preview/reef-race-v2` (orbit/side-on/top-down): WIDE water
  corridor reads as WATER, loop WINDS + uses the footprint, land FRAMES the water, island fits,
  FPS ≥ floor, no console errors — the orchestrator drives this (this agent can't).
- Founder real-keyboard playtest (synthetic MCP keys are ignored) — the feel gate.
- Feel rebuild (fixed-timestep prediction / surf-carving / drift-mini-turbo) is the NEXT pass
  on top of this geometry, not this one.
