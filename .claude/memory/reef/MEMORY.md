# Reef Race — Knowledge Base (index)

The `reef` agent owns ClawVille's surf-racing game ("Mario Kart but surfing") end to end.
This is the index — one line per entry. Detail lives in the topic files. The large
reef-race **3D/render** history lives in the shared bank `.claude/memory/threejs/` (grep it
for `reef`) — always cross-read it.

## Standing rules
- Server sim is authoritative; the 3D scene + HUD are VIEWS of it (WORLD↔BACKEND↔UI parity).
- Shared client/server physics MUST be fixed-timestep at the server tick (per-tick survival
  multipliers double-compound at 60fps → prediction surge). See [[current-state]].
- Iris-Xe-safe render only (no drei Text/Billboard, no InstancedMesh+ShaderMaterial, no
  per-frame `new Vector3`; water = plain-Mesh analytic shader, NOT WebGPU FFT ocean).
- Local-first testing (`bun run build && bun run start`, NEVER `bun run dev`); staging-first push.
- 3D/shader/physics = Claude↔Codex collaboration (CLAUDE.md Rule E3).

## Entries
- [SURF ROAD Track v5](surf-road-track-v5.md) — **CURRENT. Founder REFRAME 2026-06-23: NO land,
  NO island — a glowing FLOATING WATER RIBBON (Rainbow Road) in an abstract COSMIC VOID, the
  ribbon IS the world. Aggressively twisty (32 CPs, arc 60 257 wu, 26 reversals, min R 261,
  footprint ~17 687²) + a RENDER-ONLY elevation/bank profile (`reefTrackElevationAt`/
  `reefTrackBankAngleAt` in `@clawville/shared`, Y span 1 634, periodic) that lifts+banks the
  ribbon, rider AND chase camera together — sim stays purely 2D (laps/finish/physics UNCHANGED).
  KEY LESSON: narrow esses WALL-CLAMP the sim (kart pins to wall + stalls) — only the 8-body
  integration smoke catches it; widen the corridor till every corner holds a racing line. 3da
  same-diff: land deleted, ribbon+neon rails+cosmic void+selective bloom. 294 reef tests pass /
  0 fail; build 9/9 + web OK. Gate: in-browser parity + founder real-keyboard playtest.**
  Supersedes [[water-dominant-track-v4]].
- [Design Decisions](design-decisions.md) — founder-locked v1 spec (2026-06-22): closed-loop
  LAP circuit, FAR more curves, drift-carve+boost / slipstream / hazards (no items v1),
  free-now-CT-later, Phase 1 = water+physics+curvy-track first. MAKE GAMEPLAY WORK — no
  scaffolding theater. (NB: the "circle a small world" framing is SUPERSEDED by the SURF ROAD
  reframe — no world to circle; the floating ribbon IS the world.)
- [Current State](current-state.md) — deployed/branch/flag truth as of 2026-06-22, the file
  map, the spline flag gating, the un-merged `d490501f` playability fixes, and the open
  feel/water/gameplay gaps to re-verify before building.
- [Closed-Loop Lap Foundation](closed-loop-lap-foundation.md) — **Phase 1a-BACKEND DONE +
  Phase 1a-RENDER DONE (built, not pushed):** BACKEND: curvy CLOSED RING track, lap/position HUD
  wire, seam-wrap anti-cheat, lap-scaled timeouts, synced countdown. RENDER: closed ribbon seam
  fix (all 3 builders), central island (ISLAND_RADIUS=2400wu), HUD lap counter fix (0-based lap),
  CentralIsland wired in ReefRaceScene + /preview/reef-race-v2. Build 9/9 exit 0. Needs founder
  playtest + sign-off before push.
- [Water-Dominant Track v4](water-dominant-track-v4.md) — **v4 WATER-DOMINANT redesign (built,
  not pushed):** founder art-direction (creek-in-a-land-disc → WIDE/BIG/WINDY water map). Track
  v3→v4: 27 CPs (was 20), arc 53 506 wu (was 30 434), corridor hw 471–910 (was 290–540 → ~940–1820
  wu wide water), footprint ~15 400² (was ~10 400×9 000), 12 reversals (was 4), min R 379, min
  corridor-edge clearance 1 292. `REEF_LAPS` 3→2 + arc-grounded 180 s/lap budget + wider spawn grid.
  Sim/bot/anti-cheat LOGIC unchanged (auto-derive from spline). Fixed the 36→24 `TOTAL_CHECKPOINTS_PER_RACE`
  shared-literal DRIFT (perfect bonus could never fire) + a stale bot-winrate `activityReplays` mock.
  Numeric harness `scratchpad/track-verify.ts` (drive the real closed spline — never hand-pick).
  Render = 3da same-diff (ground frames water, recede disc, island fit, ±8000 camera, stale linear
  props removed). Reef suites GREEN in isolation + build 9/9. Gate: in-browser parity + founder playtest.
