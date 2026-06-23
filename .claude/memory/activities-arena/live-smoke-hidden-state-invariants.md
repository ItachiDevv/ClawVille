---
name: live-smoke-hidden-state-invariants
description: "Real-time / provably-fair engines must be live-smoked on staging in-browser (hidden-state + determinism + camera/water alignment) before prod — bun test green is NOT a substitute (the reef-race v2 pin + holdem board-leak both passed audits)."
category: gotcha
confidence: high
date: 2026-06-22
---

# Live-smoke real-time engines for hidden-state + determinism (audits miss it)

**Status: DISCIPLINE.** Composes `[[live-smoke-realtime-engines]]`, `[[server-authoritative-sim]]`, `[[reef-spline-dual-dispatch]]`.

Multi-agent Workflow audits (even money/cheat-adversary lenses) and `bun test` green have BOTH approved engines that shipped real bugs. Two scars:
- **reef-race v2 water/camera pin** — the racing plane + camera were pinned `Y=0` while the water is at `WATER_Y=-200` (water-surf.tsx:49), producing 'water gone / green track'. A revert fixed the plane but MISSED the camera. Layout/visual-physics bugs only show in-browser.
- **holdem board-leak** — an in-progress API response leaked hidden community cards preflop (fold-to-showdown peek). Passed every audit; only a live staging smoke asserting board-len==street-count caught it.

## What to assert on staging (in-browser, fresh isolated guest) before prod
- **Hidden-state:** no in-progress response leaks an opponent's frame/card/seed; the seed is null until close.
- **Determinism:** the recorded replay re-simulates to the same result; the reward pipeline's ONLY score input is the server `SimResultRow` embedded pre-teardown (reward-pipeline.ts:383), never a client value or a live `state.bodies` accessor racing `endRound()`.
- **No client-trusted score/placement:** forge an out-of-bounds input frame and confirm it clamps/flags (anti-cheat MAX_INPUT_HZ=60, clamp tol 1.15, 5 flags -> forfeit), never moves the body or sets a result.
- **Camera/water alignment** at `WATER_Y=-200`; the chase camera follows the body.
- **REEF_RACE_USE_SPLINE dual-dispatch:** the WS stream and the REST results agree (the flag is read in BOTH index.ts `reefRaceImpl` and activity-ws-hub.ts `getReefSim()` — flip both).

See `[[screenshot_specific_3d_view_mcp]]` (global) for forcing a deterministic 3D view in MCP.
