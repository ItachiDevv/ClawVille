---
name: design-decisions
description: "Locked reef-race redesign decisions from the founder, 2026-06-22 — the v1 'Mario Kart but surfing' spec"
category: design
confidence: high
date: 2026-06-22
---

## Founder-locked v1 spec (2026-06-22) — "Mario Kart but surfing"

The dominant signal: **MAKE THE GAMEPLAY ACTUALLY WORK.** Founder is frustrated that prior
attempts shipped non-functional ("failed miserably so far"). No scaffolding theater — every
deliverable must be verified working in-browser + (for feel) by the founder's real-keyboard
playtest before any "done" claim.

### Format — CLOSED-LOOP LAP CIRCUIT (the big redesign)
- The track becomes a **closed loop**. **1 lap = one full 360° circumnavigation around a small
  central world** ("one full world/planet circular travel = 1 lap"). Race = N laps.
- **The track needs FAR MORE CURVES** — today's spline reads "very straight." Build a real
  racing circuit: sweeping bends + chicanes + S-curves all the way around, not a near-straight
  river. "Plan for a race game how it is now" = treat the current track as the thing to
  redesign into a proper curvy circuit.
- Interpretation taken (proceed unless founder corrects): a **flat-plane closed circular
  circuit encircling a small island/atoll world** in the center — standard up=+Y, Iris-Xe-sane.
  NOT a spherical-gravity planet surf (Mario Galaxy curved-gravity is a much bigger/risky
  build; treat as a possible later escalation, not v1).
- This means the server sim spline must become a **closed Catmull-Rom loop**; the 3D track
  ribbon derives from the SAME closed control points (sim-coord-match invariant); lap counting +
  position = (lap, arclength progress); start/finish gate; synced 3-2-1 countdown (salvage
  `ensureSyncedCountdown` from the un-merged `d490501f`).

### Mechanics — v1 set
- **IN v1:** drift-carve **mini-turbo** (hold-to-carve charges a boost, release for a burst) +
  **boost pads / wave-ramps**; **slipstream / drafting** (a `draft-badge` component already
  exists); **environmental hazards** (reef rocks / whirlpools / shallows on inside lines that
  slow you and force racing-line choices).
- **NOT in v1:** throwable pickup items (shells/bananas). Heaviest build (projectile netcode) —
  explicit fast-follow, not now.
- Drift-carve mini-turbo is fundamentally part of MOVEMENT physics → build it WITH the physics
  pass, not as a separate later layer.

### Stakes — free now, cash later (spec only)
- v1 is **free, leaderboard-only** (`activity.match.placed`, current model). Agents already get
  placement credit.
- **CT entry-fee + payout pot is wanted LATER** — spec it (cove/land money + E5 human/agent
  parity contract) but DO NOT build it now. Founder: "this is tbh irrelevant until the gameplay
  works." Gameplay first.

### Build order (founder's ordering)
**Phase 1 = foundation: water + movement physics + the curvy closed-loop lap track.**
Suggested verifiable increments (each gated by an in-browser / real-keyboard check before the next):
1. **P1a — closed-loop curvy track + laps:** close the spline, add many curves around the
   central world, lap/position/finish/countdown. Verify: it's a curvy closed loop, a kart goes
   all the way around, lap counter increments, finish fires. (sim tests + browser.)
2. **P1b — responsive physics:** restore client prediction the RIGHT way (FIXED-TIMESTEP at the
   30Hz tick — the documented surge bug) + surf-carving feel + drift-carve mini-turbo + boost
   pads tuned for the curves. Verify: founder real-keyboard playtest (synthetic MCP keys are
   ignored).
3. **P1c — water:** Iris-Xe-safe analytic surf water that reads as water at ALL camera altitudes
   (kill grey-from-altitude aliasing + dark flow bands), foam/glint, around the island.
4. **P1d — surfer on the water** with a real surf stance.
**Phase 2 = the competitive layer:** slipstream + hazards integrated into racing decisions,
position/lap HUD polish, rubber-band catch-up tuning, then (later) CT stakes.

### Grounding note (verified 2026-06-22)
`reef-race-track-layout.ts` is a re-export shim — the canonical track lives in
`@clawville/shared/reef-race/track-layout` (`REEF_RACE_SEGMENTS`, `REEF_RACE_DEFAULT_TRACK`,
`REEF_RACE_DEFAULT_TRACK_LENGTH`), with spline math in `reef-race-spline.ts`. The closed-loop
+ curve redesign starts there (shared package, so server sim + 3D client both consume it). See
[[current-state]] for the full file map + flag gating.
