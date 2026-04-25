# Reef Race — Real Racing Mechanics

**Status:** Design approved 2026-04-25. Multi-phase implementation pending.
**Owners:** Orchestrator (sim + stats + UI), 3da (Reef Glider prop + rider attach), reef-race-bot (uses new mechanics).
**Why this exists:** Today's "Reef Race" is hold-W-and-steer with no skill ceiling. Pet stats grinded in the world don't influence matches. Mixed avatar roster (Milady humanoid VRM, lobster, seahorse, crayfish) had no coherent locomotion fiction. This plan locks the gameplay identity.

---

## Decisions locked

1. **Locomotion fiction:** every racer rides a **Reef Glider** (small water vehicle). Avatar is parented to the kart prop as a rider — Milady stands on it like a hoverboard, lobster grips the rail, seahorse coils. Same physics, different rider skin. Solves heterogeneous avatar problem.
2. **Core skill stack:** drift charge + slipstream + boost ribbons + launch boost. Existing `ACTION_BIT_DRIFT` is already captured client-side and ignored server-side; this lights it up.
3. **Stats:** touch handling, never top speed. Top speed identical for everyone so a noob is never hopelessly behind. Stats buy tools (acceleration recovery, turn radius, drift charge speed, power-up duration).
4. **Goal layers:** place 1–3 + personal best lap + checkpoint streak + daily lobster-of-the-day leaderboard.

---

## Phase 1 — minimum that makes it feel like a racing game

Scope so the first ship is testable in one PR + balance pass.

### 1A. Reef Glider prop (3da)

- New prop GLB at `apps/web/public/models/reef-glider.glb` (placeholder = a flat oval surfboard with handlebars; final art later). Loaded via `useGLTF.preload`.
- `ReefRacePlayer.tsx`: avatar mesh becomes a child of a `gliderRef` group instead of `groupRef` directly. The glider takes server-driven position + rotation. The avatar stands at a per-species attach offset (`SPECIES_RIDER_OFFSET` map: lobster=low+forward, milady=center+upright, seahorse=center+vertical).
- Bank tilt now applies to the **glider**, not the avatar (the rider stays upright, the board leans). Existing bank logic moves up one node.
- Procedural swim animation removed for non-fish species (Milady doesn't swim, she rides). Lobster/crayfish/seahorse keep gentle bob; Milady gets a subtle balance sway.

### 1B. Server physics — drift + launch boost (orchestrator)

`apps/api/src/services/activity/sim/reef-race-sim.ts`:

- **Drift charge state per body**: `{ charging: bool, sparks: 0|1|2|3, chargeStartTick: number }`.
- On `actionBits & ACTION_BIT_DRIFT` while turning (|angular velocity| > threshold): increment sparks every N ticks (1 spark @ 0.4s, 2 @ 0.9s, 3 @ 1.5s). Apply +15° angular bias for the drift arc.
- On drift release: emit a one-tick velocity boost scaled by sparks (1=+12%, 2=+24%, 3=+38%) for 1.2s. Broadcast `event.drift_boost { petId, sparks }` so the client can play a flash + sound.
- **Launch boost**: in the COUNTDOWN→LIVE transition, capture each player's `actionBits` for the 200ms before LIVE. If thrust is 1.0 within ±150ms of the green, +30% velocity for 2s. Press too early (>200ms before green) = stall (thrust capped at 0.3 for 1s). Broadcast `event.launch { petId, kind: 'boost' | 'stall' }`.

### 1C. HUD — drift sparks + launch indicator (orchestrator)

`apps/web/src/components/game/reef-race-hud.tsx`:

- Bottom-center under the power-up bar: 3 spark dots that fill orange→red→blue as the player charges drift. Subscribes to a new `driftSparks` field on the active body in the snapshot delta.
- Countdown numerals get a "PRESS" glow on the green tick — already shown via RoundCountdown, just add an animated ring to make the launch window legible.

### 1D. Reef Glider in the bot

`apps/api/src/services/activity/bots/reef-race-bot.ts`:

- Bots randomly use drift on hairpin entry (probability 0.6 in the post-grace branch). Charges 1 spark, releases on apex.
- Bots attempt launch boost (timing imperfect: ±400ms window, success rate ~50%).

### 1E. Tests

- `bumper-shells-bot.test.ts` style: new `'charges and releases drift on hairpin'` and `'launches with boost when timing is right'` cases.
- Existing race tests get a `nowAfterGrace` helper to keep matchAge past 2.5s.

---

## Phase 2 — depth (after Phase 1 ships and we've watched it play)

Defer until Phase 1 has 24h of telemetry. Don't ship 8 mechanics in one PR — it's a balance nightmare.

- **Slipstream** — within 50wu behind another glider for 1.5s = +20% top-speed in their wake.
- **Cornering apex bonus** — inside line through hairpins = +5%, drift wide = -5%.
- **Boost ribbons** painted on the long straights — drive *through* a glowing line for +30% / 2s.
- **Hazard patches** — sea urchin field mid-hairpin, slow zone you can clip for the inside line.
- **Placement-weighted power-ups** — 1st place rolls defensive items; 8th place rolls aggressive. Mario Kart rubber band.

---

## Phase 3 — stat connection

Touches `apps/api/src/services/activity/sim/reef-race-sim.ts` body integration. Each stat applies a per-body multiplier:

| Stat / archetype | Field | Effect |
|---|---|---|
| `level` (1-50) | `accelMultiplier` | 1.0 + 0.005·level (max +25% recovery from collisions) |
| `agility` archetype | `turnRadiusMultiplier` | 0.85 (tighter) |
| `agility` archetype | `slipstreamWindowMs` | 2200 instead of 1500 |
| `strength` archetype | `driftChargeMultiplier` | 1.4 (sparks faster) |
| `strength` archetype | `knockbackResistMultiplier` | 0.6 (takes 40% less knockback) |
| `intelligence` archetype | `powerUpDurationMultiplier` | 1.2 |
| `intelligence` archetype | `ribbonDetectRadiusMultiplier` | 1.3 |

**Top speed unchanged across all archetypes.** Skill ceiling stays above the stat ceiling — a level-1 noob who corners well still beats a level-50 pet that drives blind.

---

## Phase 4 — goal layers

- Personal best ghost (the existing `ReefRaceGhost.tsx` mesh — currently dormant — becomes player's own best lap, fades in/out per lap).
- Checkpoint streak counter on HUD; +bonus tokens for 100% perfect-line streaks.
- "Lobster of the day" daily-fastest-lap entry on `/leaderboard`.
- Match-end screen surfaces all 3 goal results (place + PB? + streak %).

---

## File-by-file Phase 1 scope (for fast pickup)

| File | Owner | Phase 1 changes |
|---|---|---|
| `apps/web/public/models/reef-glider.glb` | 3da | New placeholder prop |
| `apps/web/src/lib/three/activities/reef-race/ReefRacePlayer.tsx` | 3da | Glider parent, rider attach offsets, bank moved to glider |
| `apps/api/src/services/activity/sim/reef-race-sim.ts` | orchestrator | Drift charge state, drift boost release, launch-boost window |
| `apps/api/src/services/activity/sim/reef-race-config.ts` | orchestrator | DRIFT_SPARK_TIERS, LAUNCH_WINDOW_MS, LAUNCH_BOOST_MULT, etc. |
| `apps/api/src/services/activity/bots/reef-race-bot.ts` | orchestrator | Drift on hairpin entry, launch attempt |
| `apps/web/src/components/game/reef-race-hud.tsx` | orchestrator | Drift sparks UI, launch indicator |
| `packages/shared/src/activities/protocol.ts` | orchestrator | Add `event.drift_boost`, `event.launch`, `body.driftSparks` |
| `apps/web/src/stores/activity.ts` | orchestrator | Thread driftSparks + new events through |
| `apps/api/src/services/activity/bots/__tests__/reef-race-bot.test.ts` | orchestrator | Drift + launch test cases |

---

## Out of scope (don't expand Phase 1)

- Per-species top-speed asymmetry (Mario Kart heavy/light) — defer until telemetry justifies it.
- Boost ribbons / hazard patches — Phase 2.
- Stat-driven physics — Phase 3.
- Personal best ghost activation — Phase 4.
- Reef Glider final art — placeholder oval surfboard for Phase 1.
