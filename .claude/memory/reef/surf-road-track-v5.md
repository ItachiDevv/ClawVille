---
name: surf-road-track-v5
description: "Reef Race v5 'SURF ROAD' — the founder REFRAME to a floating Rainbow-Road water ribbon in a cosmic void (NO land), the aggressively-twisty track, the render-only elevation/banking profile, and the wall-clamp-stall lesson"
category: solution
confidence: high
date: 2026-06-23
---

## Reef Race v5 — "SURF ROAD" floating Rainbow-Road ribbon (built — needs verification)

Branch `feat/reef-race-rebuild` (worktree `cv-reef`). NOT pushed, NOT deployed.
Supersedes the v4 water-dominant land-disc track ([[water-dominant-track-v4]]).

### The founder REFRAME (I had misread it twice as a literal land-disc — WRONG)
Verbatim: "Think RAINBOW ROAD. A floating river that can be abstracted and NOT bound by
land — the land here is ultimately very irrelevant, the SURFING is the piece. Not zig-zaggy
enough, not utilizing the space enough for a game like Mario Kart that has zig zags." There
is NO world to circle, NO island, NO land map. The earlier "1 lap = circle a small world"
was a misinterpretation. **The water ribbon IS the world — a glowing floating ribbon in an
abstract cosmic void.** Last two attempts were called "the most basic shit possible" — this
pass aimed HIGH (Rainbow-Road quality), not safe.

### The track (mine — the shared layout, `packages/shared/src/reef-race/track-layout.ts`)
- **32 control points** (was 27 in v4), arc **60 256.6 wu** (was 53 506).
- **26 curvature reversals** (was 12) — SE rising sweeper → east hairpin, a flowing L-R-L-R
  S-chain, a north chicane, a far-west U-hairpin, a mid chicane, a long SW return run.
  Genuinely aggressive zig-zag.
- Min radius **261.2 wu** (>192 carve floor), footprint **~17 687 × 16 941 wu** (sprawls),
  corridor half-width **280–480 wu** (ribbon 559–960 wu wide — a banked Rainbow-Road ribbon,
  narrower than v4's wide channel so the zig-zags read sharp).
- Single-winding (heading sweep +2.0000π), NO XZ self-overlap, min inter-pass edge clearance
  **2 079 wu**.
- `REEF_RACE_SEGMENTS` re-pinned to CP→t projections: lagoon 0–0.1126 / kelp –0.3028 /
  shipwreck –0.4416 / coral –0.7722 / finish –1.0. Start/finish at XZ (-2400,-8200).

### NEW render-only ELEVATION + BANKING (the key new mechanic — `track-layout.ts`)
The server sim is PURELY 2D (XZ). I added two PURE render-only functions to `@clawville/shared`:
- **`reefTrackElevationAt(t): number`** — render-only Y altitude of the floating ribbon
  centerline. Sum of integer-cycle sines + a high-power raised-cosine "mountain" → FULLY
  PERIODIC (Y(0)===Y(1), C1 slope at the seam — NO kink at the start/finish line). Verified
  Y∈[-559,1075] span **1 634 wu**, max grade **29.3 %** (< 35 % so karts stay glued to the
  ribbon on climbs).
- **`reefTrackBankAngleAt(t, headingAt): number`** — render-only bank lean (rad, ±28° cap),
  proportional to the local heading-change rate. `headingAt(tt)` is a sampler the caller
  binds to the spline (`atan2(tangent.z, tangent.x)`), keeping the func pure + spline-decoupled.

**THE PARITY CONTRACT (load-bearing, extends invariant #4 to Y):** the 3D ribbon geometry,
the rider group, AND the chase-cam eye+target+lookAt ALL lift by the SAME
`reefTrackElevationAt(t)` and tilt by `reefTrackBankAngleAt(t)` — so the surfer rides ON the
ribbon and the camera frames it through every climb/dip/bank. The vertical datum is now a
SHARED FUNCTION of t instead of a flat plane. Per-body `heightOffset` (sim jump/ramp metres,
broadcast as `entity.height`) is ADDED ON TOP. The SIM never reads these — laps/finish/
physics/anti-cheat are UNCHANGED. This is the safe way to get the floating undulation without
touching the working 2D sim. `heightOffset` ≠ track elevation: heightOffset is the per-body
airborne jump, elevation is the track's Y(t) — they ADD.

### THE WALL-CLAMP-STALL LESSON (the key v5 trap — caught by the 8-body smoke, not unit tests)
A first sharper pass had narrow esses (hw 260) + tight reversals. The full 8-body integration
smoke (`reef-race-spline-sim-integration.test.ts`) showed EVERY racer STALLING at progress
0.334 (pathLen frozen) — zero finishers. Root cause: the spline sim has a CORRIDOR WALL CLAMP
(`widthAt(closest.t)` is the boundary; outward velocity is scrubbed each tick). When a kart
CAN'T carve the racing line inside a too-narrow corridor on a too-tight reversal, it pins to
the wall and the outward-velocity scrub STALLS forward progress. Min radius alone (above the
192 floor) is NOT sufficient — the COMBINATION of tight radius + narrow corridor + rapid
reversal walls off the line. FIX: widen the corridors (280-480) until every corner holds a
racing line inside it (final min R 261). **Lesson: a track can pass every static geometry
check (arc, sweep, min-R, clearance) and STILL be unraceable — the navigability gate is the
live 8-body integration smoke (a kart actually completing laps), not the geometry harness.
Always run it after any corridor/curve change.** Also: that smoke's tick window must be
grounded in the 2-lap ARC DISTANCE at a conservative carve pace (220 wu/s), NOT the wall-clock
hard-timeout (the synchronous loop runs in ~7-13s wall, so the wall-clock timeout never fires
— only the TICK count gates whether a body covers the distance).

### The numeric harness (REUSE — `scratchpad/track-verify.ts`)
Drives the REAL `new ReefSpline(cands,{closed:true})` + the elevation profile and reports arc,
heading sweep (±2π = single winding), curvature reversals, min radius, CP spacing, a 3D
elevation-aware self-intersection check (XZ overlap is OK if vertically separated > ribbon
thickness + clearance — a Rainbow-Road overpass), footprint, and the elevation seam-continuity
+ grade. **A deliberate self-OVERPASS was tried and REJECTED**: on a sprawling single-winding
layout it forces either a cusp (min-R→0.7) or an extra 2π winding turn (a self-curl). The clean
single-winding circuit + the undulating elevation gives the floating feel WITHOUT a forced
overpass cusp. NEVER hand-pick track numbers — drive the real spline.

### Config / consumers touched (the full map)
- `track-layout.ts` (mine) — CPs + segments + arc const + the 2 new render funcs. Canonical
  home in `@clawville/shared`. The API-side `reef-race-track-layout.ts` is a re-export shim →
  **rebuild `packages/shared` dist** (`cd packages/shared && bun run build`) or the API/tests
  read the OLD track + miss the new funcs.
- `reef-race-config.ts` (API): `REEF_RACE_LOOP_LAP_BUDGET_MS` 180k→200k (re-grounded
  60 257/330×1.10). `REEF_LAPS` stays 2.
- `reef-race-track-layout.test.ts` — bounds → v5 (CP 32, arc [55k,66k], start XZ, hw) + NEW
  `reefTrackElevationAt` periodicity/C1/grade tests + `reefTrackBankAngleAt` cap/lean tests.
- `reef-race-spline-sim-integration.test.ts` — tick window re-grounded in arc distance (above).
- The streak shared `TOTAL_CHECKPOINTS_PER_RACE`=24 is UNCHANGED (REEF_LAPS still 2) — no drift.

### Render (3da sub-agent, same diff — see threejs bank)
Land/island/ground DELETED. NEW `surf-ribbon.tsx` (glowing water ShaderMaterial-on-plain-Mesh
+ neon banked rails + crest glow, swept along clientSpline + CPU-lifted/banked by the elevation
funcs), `cosmic-void.tsx` (gradient dome + starfield + glow-mote Points, MeshBasic/PointsMaterial
only), `surf-bloom.tsx` (half-res selective UnrealBloomPass), `reef-race-elevation.ts` (the
render-only datum module + a cached XZ→t local-LUT-scan lookup). Iris-Xe-safe. `TRACK_SURFACE_Y`
-200→0 (the datum is the elevation function now). See `.claude/memory/threejs/` (3da bank).

### Verification status
- ALL reef suites GREEN: **294 pass / 0 fail / 1 skip** across 11 files (incl. the 8-body
  integration smoke that now produces a finisher: 1 finisher @ ~7000 ticks, match_ended, zero
  regression). `bun run build` 9/9 ✓ + web build OK. Iris-Xe self-audit of the render diff clean.
- OPEN (the gate): in-browser parity at `/preview/reef-race-v2` (orchestrator drives) — a glowing
  floating ribbon in a cosmic void, NO land/island, aggressively zig-zagging + UNDULATING, neon
  rails with bloom, surfer ON the ribbon through climbs/drops, FPS ≥ floor, no console errors.
- OPEN: founder real-keyboard playtest (synthetic MCP keys ignored) — the feel gate.
- Feel rebuild (fixed-timestep prediction / surf-carving / drift-mini-turbo) is the NEXT pass.
