---
name: current-state
description: "Reef Race deployed/branch/flag truth + file map + open gaps, captured 2026-06-22 at the start of the full rebuild"
category: deployment
confidence: high
date: 2026-06-22
---

## Deployment + branch truth (verified 2026-06-22)

- **On prod (`origin/master`) AND staging (`origin/staging`):** the v2 surf rebuild
  `bce0426c` (ride-on-water canyon + surf-carving physics + client prediction) and the wide
  water-dominant overhaul `16434a5f` (1300/1200/~960 corridor, 3 sweeping bends, obstacle
  clusters, flowing-water shader). Both reachable from master and staging.
- **NOT merged anywhere — un-pushed on `feat/reef-overhaul-v2`:** `d490501f`
  "playability fundamentals" (6 files): board bbox-normalize + auto-orient (fix tiny/sideways
  board), **self client-side prediction DISABLED** (`ENABLE_SELF_PREDICTION=false` — diverged
  from server, popped on re-baseline; self now renders from server interp), water calm
  (wave amp ±9→±2.5, halved temporal speed, flow-streak contrast 0.06→0.015 to kill dark
  bands), and **`ensureSyncedCountdown()` on WS connect** (the 3-2-1 was missing because the
  5s countdown armed at room creation, before the client opened the WS). The synced-countdown
  + board fixes are sim-agnostic and worth cherry-picking; the water/prediction changes will
  likely be superseded by the rebuild. **Re-verify all of this against current source — it's
  21 days old.**
- **This rebuild:** worktree `C:/Users/newma/Documents/Crypto/cv-reef`, branch
  `feat/reef-race-rebuild` off `origin/staging` (tip `890a7fc8`). `bun install` done.

## Spline flag gating (load-bearing)
`REEF_RACE_USE_SPLINE` (server, `reef-race-config.ts`) + `NEXT_PUBLIC_REEF_RACE_USE_SPLINE`
(client: `ReefRaceScene.tsx`/`ReefRaceTrack.tsx`/`ReefRacePlayer.tsx`/`reef-race-hud.tsx`/
`reef-race-self-bus.ts`) BOTH default `false` and are set only in Coolify env (no committed
env file). When OFF, players get the OLD v1 ellipse sim. `/preview/reef-race-v2` hardcodes
spline ON regardless. **Verify the live flag state per box before reasoning about what players
actually see.** Decision for the rebuild: drive toward making the spline path the only path
(retire the v1 ellipse) so there is no flag ambiguity — confirm with the user first.

## File map (verify exact paths/contents during grounding)
**Server sim:** `apps/api/src/services/activity/sim/` → `reef-race-sim.ts` (v1 ellipse),
`reef-race-spline-sim.ts` (v2), `reef-race-spline.ts` (spline math), `reef-race-config.ts`
(constants + flag), `reef-race-track-layout.ts`; `activity/bots/reef-race-bot.ts`;
`activity/anti-cheat/reef-race.ts`; `activity/activity-room-manager.ts` + `activity-ws-hub.ts`
(rooms/snapshots/countdown). **Shared physics:** `packages/shared/src/reef-race/surf-physics.ts`
(`integrateSurfStep` — per-tick multipliers) + `packages/shared/src/activities/reef-race-streak.ts`.
**Client 3D:** `apps/web/src/lib/three/activities/reef-race/` → `ReefRaceScene.tsx` (chase cam),
`ReefRaceTrack.tsx`, `ReefRacePlayer.tsx`, `water-surf.tsx` (water shader), `reef-race-self-bus.ts`
(prediction bus), `reef-race-config.ts`, `reef-race-types.ts`, `reef-race-spline-instance.ts`;
plus `rocky-cliffs.tsx`/`river-scene.tsx`/`racing-karts.tsx` (per threejs memory). **HUD/UI:**
`apps/web/src/components/game/reef-race-{hud,instructions,event-toasts,streak-counter,drift-sparks,build-summary,draft-badge}.tsx`.
**DB:** `packages/database/src/schema/reef-race-personal-bests.ts` + `*-personal-best-service.ts`,
`*-daily-best-service.ts`. **Plans:** `.claude/plans/reef-race-*.md` (phase1–4 + real-racing +
v2-spline-architecture).

## Open gaps to re-verify before building (from 21-day-old notes — TREAT AS HYPOTHESES)
1. **Feel/physics:** rubber-band + prediction divergence (prediction was DISABLED in the
   un-merged `d490501f`, so deployed = server-interp only, ~300ms input lag). The
   fixed-timestep prediction lesson is the path back to responsiveness. Needs the user's real
   keyboard playtest — synthetic MCP key events are ignored.
2. **Water:** dark flow-streak bands (toned in `d490501f` but not deployed); high-altitude
   aliasing to grey; "too flat." Multiple water-shader approaches already explored — see
   `.claude/memory/threejs/` (`water-surf.tsx` gradient, arcade cel water, surf-game-water-shader,
   organic-foam-cluster). The rebuild target is genuinely better surf-game water.
3. **Surfer/board:** board sizing/orientation (bbox-normalize fix un-merged); idle/standing
   pose reads wrong (no surf stance — full Mixamo surf clip deferred).
4. **Gameplay (the Mario-Kart layer — largely NOT built):** boosts/ramps exist partially
   (drift-sparks, boost HUD, draft-badge components present); items/hazards, drift mini-turbo,
   slipstream, lap/position polish, rubber-band catch-up — scope TBD with the user.
5. **Economy:** `activity.match.placed` leaderboard scoring (1st=12/2nd=6/3rd=3, daily cap 10).
   Any CT entry/payout would add the full money + E5-parity contract — none today; TBD.

## Build approach (set 2026-06-22, user direction)
Phase 1 = **water rendering + movement physics** (the foundation) FIRST. Phase 2 = **the
competitive-race game layer** (Mario-Kart mechanics). Each phase: grounding reference →
3da+sim sub-team + Codex co-review → browser + real-keyboard verify → staging → sign-off.
