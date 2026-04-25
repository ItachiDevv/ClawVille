# Reef Race Phase 1 — Detailed Implementation Plan

**Status:** Pre-implementation. Awaiting audit before code is written.
**Branch:** `fix-bumper-build` (worktree at `.claude/worktrees/fix-bumper-build`)
**Date authored:** 2026-04-24
**Author:** 3da (implementation planning pass)

---

## 0. Baseline facts from source audit

Before the plan numbers can be trusted, every value was verified against the live source:

| Fact | Source | Value |
|---|---|---|
| Sim tick rate | `reef-race-sim.ts` line 83 | `REEF_SIM_HZ = 30` → `REEF_TICK_MS = 33.33ms` |
| actionBits 0b01 | `reef-race-sim.ts` line 654 | power-up slot 0 |
| actionBits 0b10 | `reef-race-sim.ts` line 655 | power-up slot 1 |
| actionBits 0b100 | (unallocated) | available for drift |
| actionBits 0b1000 | (unallocated) | available for launch |
| Snapshot cadence | `reef-race-sim.ts` lines 87-90 | 5Hz delta, 1Hz keyframe |
| `REEF_MAX_SPEED` | `reef-race-config.ts` line 85 | 500 wu/s |
| `REEF_BOOST_MULT` | `reef-race-config.ts` line 88 | 1.4 |
| `REEF_MAX_ACCEL` | `reef-race-config.ts` line 95 | `REEF_MAX_SPEED * 4 = 2000 wu/s²` |
| `REEF_DRAG` | `reef-race-config.ts` line 98 | 0.97 per tick |
| `REEF_BODY_RADIUS` | `reef-race-config.ts` line 101 | 22 wu |
| `ServerFrame` union | `packages/shared/src/activities/protocol.ts` | discriminated union, no `activity-frames.ts` — file does not exist |
| `applyServerFrame` exhaustive | `activity.ts` line 711 | `const _exhaustive: never = frame;` — new events MUST be added to union |
| `KART_SCALE` | `reef-race-config.ts` (client) | 20 |
| Species in player | `ReefRacePlayer.tsx` line 43-43 | sea_horse + lobster only (milady/crayfish not yet in player) |
| Bot `BOT_OPENING_GRACE_MS` | `reef-race-bot.ts` line 31 | 2500ms |
| Test fixture NOW | `reef-race-bot.test.ts` lines 57-60 | `now: 5000, matchStartedAt: 0` — matchAge = 5000ms, well past grace |

**Critical finding:** There is no `packages/shared/src/types/activity-frames.ts`. The protocol lives in `packages/shared/src/activities/protocol.ts` as a single `ServerFrame` TypeScript union (not Zod). New events extend that union. The plan spec says `activity-frames.ts` — this must be interpreted as `protocol.ts`.

---

## 1. Constants

All constants go in `apps/api/src/services/activity/sim/reef-race-config.ts`.

### 1.1 Drift spark tier thresholds

```
REEF_SIM_HZ = 30 → 1 tick = 33.33ms

Tier 0→1: 0.4s = 0.4 * 30 = 12 ticks
Tier 1→2: 0.9s total = 0.9 * 30 = 27 ticks
Tier 2→3: 1.5s total = 1.5 * 30 = 45 ticks
```

**Justification:**
- A 1-spark drift (~0.4s hold) is achievable in a medium corner. Short enough that casual players can land it.
- A 3-spark drift (~1.5s hold) requires a sustained full hairpin entry — the entire REEF_TRACK_B arc at minimum. At 500 wu/s the wide hairpin subtends ~(π × 700wu) / (500wu/s) ≈ 4.4s of track time, so 1.5s of drift is ~one-third of the corner — achievable but demanding.
- Advancing by same-tick thresholds (not incremental per tick) means we check `chargeStartTick` at the current tick: `spark = chargeStartTick + threshold <= currentTick`.

```typescript
// Tick counts from DRIFT charge start at which spark level advances:
export const DRIFT_SPARK_TICK_1 = 12;   // 0.4s
export const DRIFT_SPARK_TICK_2 = 27;   // 0.9s
export const DRIFT_SPARK_TICK_3 = 45;   // 1.5s

export const DRIFT_SPARK_TIERS: readonly [number, number, number] = [
  DRIFT_SPARK_TICK_1,
  DRIFT_SPARK_TICK_2,
  DRIFT_SPARK_TICK_3,
];
```

### 1.2 Drift boost multipliers

**From plan §1B:** "1=+12%, 2=+24%, 3=+38%". Applied for 1.2s.

```
DRIFT_BOOST_DURATION_MS = 1200  (1.2s)
1200ms / 33.33ms ≈ 36 ticks

Boost velocity factor (additive on top of current velocity):
spark=1: +12% → factor 0.12
spark=2: +24% → factor 0.24
spark=3: +38% → factor 0.38
```

```typescript
export const DRIFT_BOOST_DURATION_MS = 1_200;
export const DRIFT_BOOST_MULTS: readonly [number, number, number] = [0.12, 0.24, 0.38];
```

Implementation note: the boost is applied as a one-tick velocity impulse at release. The implementation stores an `activeEffect` `'rr-drift-boost'` with expiry and applies a `speedMod` inside `applyIntentForTick`, analogous to `rr-turbo-bubble`. This avoids repeated-fire and survives tick boundaries.

### 1.3 Drift angular bias

**From plan §1B:** "+15° angular bias for the drift arc." This is a constant added to the body's rotation during drift charge to simulate the classic kart drift-slide.

```typescript
export const DRIFT_ANGULAR_BIAS_RAD = (15 * Math.PI) / 180; // ≈ 0.2618 rad
```

Applied as: during drift charging, if turning right (`dir.x > 0`), subtract the bias from `body.rot`; if turning left, add it. Reset when drift ends.

### 1.4 Minimum speed threshold for drift activation

A body rolling at nearly zero speed should not be able to drift-charge. Threshold is 30% of `REEF_MAX_SPEED`.

```typescript
export const DRIFT_MIN_SPEED_FOR_CHARGE = REEF_MAX_SPEED * 0.30; // 150 wu/s
```

### 1.5 Minimum angular rate threshold for drift activation

"Turning AND drift-bit AND moving above threshold." Angular rate threshold derived from the minimum turn that constitutes a "hairpin entry" — roughly the rate a body produces when pointing at a checkpoint that is 45° off its current heading.

```typescript
// Angular threshold (rad/s) below which we don't count as "turning"
export const DRIFT_MIN_ANGULAR_RATE = 0.25; // rad/s
```

In the sim, angular rate is derived from `Math.abs(intent.dir.x)` normalized: if `|dir.x| >= DRIFT_MIN_STEER`, we consider the body turning. Since `dir` is already a unit vector, `|dir.x| >= 0.25` means ≥14.5° off straight — effectively any cornering input.

```typescript
export const DRIFT_MIN_STEER = 0.25; // |dir.x| threshold for "turning"
```

### 1.6 Launch boost window

**From plan §1B:** "±150ms of the green" = total window of 300ms.

At 30Hz tick rate, 150ms = 4.5 ticks. To avoid floating-point precision issues, we store the window in milliseconds and compare wall-clock.

```
LAUNCH_WINDOW_MS = 150   (half-window, ±150ms total = 300ms window)
LAUNCH_BOOST_MULT = 0.30  (+30% velocity for 2s)
LAUNCH_BOOST_DURATION_MS = 2_000
LAUNCH_STALL_WINDOW_MS = 200  (press >200ms early = stall)
LAUNCH_STALL_DURATION_MS = 1_000
LAUNCH_STALL_THRUST_CAP = 0.3
```

```typescript
export const LAUNCH_WINDOW_MS = 150;
export const LAUNCH_BOOST_MULT = 0.30;
export const LAUNCH_BOOST_DURATION_MS = 2_000;
export const LAUNCH_STALL_WINDOW_MS = 200;
export const LAUNCH_STALL_DURATION_MS = 1_000;
export const LAUNCH_STALL_THRUST_CAP = 0.30;
```

### 1.7 actionBit assignments (new)

```typescript
// In reef-race-config.ts (or a shared actions module):
export const ACTION_BIT_POWERUP_0 = 0b0001; // existing
export const ACTION_BIT_POWERUP_1 = 0b0010; // existing
export const ACTION_BIT_DRIFT     = 0b0100; // NEW — bit 2
export const ACTION_BIT_LAUNCH    = 0b1000; // NEW — bit 3
```

The client sends `actionBits |= ACTION_BIT_DRIFT` while the drift key is held. This is already captured client-side (plan §"Existing `ACTION_BIT_DRIFT` is already captured client-side") — the client-side constant must match.

---

## 2. Drift state machine

### 2.1 Per-body state shape (added to `ReefBody` interface in `reef-race-sim.ts`)

```typescript
interface ReefDriftState {
  /** True while the drift-bit is held AND conditions are met */
  charging: boolean;
  /** Accumulated spark level 0..3 */
  sparkLevel: 0 | 1 | 2 | 3;
  /** Sim tick number when charging began (0 if not charging) */
  chargeStartTick: number;
  /** Was the drift-bit held last tick? Used for transition detection */
  lastDriftBit: boolean;
}
```

Add `drift: ReefDriftState` to `ReefBody` with default:
```typescript
drift: { charging: false, sparkLevel: 0, chargeStartTick: 0, lastDriftBit: false }
```

### 2.2 Transition table

```
Event                            Old state              New state               Side effects
─────────────────────────────────────────────────────────────────────────────────────────────
driftBit=1 + turning + speed≥min  not charging          charging=true           chargeStartTick=now
                                                          sparkLevel=0
                                                          lastDriftBit=true

driftBit=1 + tick elapses         charging               sparkLevel advances     broadcast driftSparks in snapshot
                                                          when tick-threshold met

driftBit=0 (released)             charging, sparks≥1    charging=false           FIRE BOOST
  (from lastDriftBit=true)                                sparkLevel=0            broadcast event.drift_boost
                                                          apply rr-drift-boost

driftBit=0 (released early)       charging, sparks=0    charging=false           no boost, silent
  (from lastDriftBit=true)                                sparkLevel=0

driftBit=1, speed<min             charging               CANCEL, charging=false   no boost
  OR collision resolves body to                           sparkLevel=0
  stop (speed drops below threshold)

body.finishedAt≠null OR dnf       any                   charging=false           no boost
  (body stops being processed)                            sparkLevel=0
```

### 2.3 Exact code location and call order

The drift state machine runs inside `applyIntentForTick` after velocity integration, before `integrateMotion`. This ordering ensures:
1. The angular bias from drift is applied to `body.rot` before the snapshot encodes it.
2. The boost effect is set on `body.activeEffects` before `speedMod` is computed next tick.

```
applyIntentForTick(state, body, dt, now):
  1. consume seq (existing)
  2. powerup bits 0b01 / 0b10 (existing)
  3. compute speedMod from activeEffects (existing, now includes rr-drift-boost)
  4. compute targetVx/Vy from intent (existing)
  5. integrate acceleration toward target (existing)
  6. update body.rot from intent.dir (existing)
  7. [NEW] tickDriftState(state, body, now)   ← inserts here
  integrateMotion(state, body, dt)
```

### 2.4 `tickDriftState` function (pseudocode)

```typescript
function tickDriftState(state: ReefRoomState, body: ReefBody, now: number): void {
  const driftBit = !!(body.intent.actionBits & ACTION_BIT_DRIFT);
  const speed = Math.hypot(body.vx, body.vy);
  const turning = Math.abs(body.intent.dir?.x ?? 0) >= DRIFT_MIN_STEER;
  const fastEnough = speed >= DRIFT_MIN_SPEED_FOR_CHARGE;

  // Transition: started drift press this tick
  const justPressed = driftBit && !body.drift.lastDriftBit;
  // Transition: released drift this tick
  const justReleased = !driftBit && body.drift.lastDriftBit;

  if (body.drift.charging) {
    if (!driftBit || !fastEnough) {
      // Cancelled (released or slowed below threshold)
      const hadSparks = body.drift.sparkLevel >= 1;
      if (hadSparks && justReleased) {
        // Fire boost
        const mult = DRIFT_BOOST_MULTS[body.drift.sparkLevel - 1];
        const curSpeed = Math.hypot(body.vx, body.vy);
        if (curSpeed > 0) {
          const factor = 1 + mult;
          body.vx *= factor;
          body.vy *= factor;
        }
        body.activeEffects.set('rr-drift-boost', now + DRIFT_BOOST_DURATION_MS);
        state.broadcastFn(state.roomId, {
          type: 'event.drift_boost',
          petId: body.petId,
          sparks: body.drift.sparkLevel,
        });
      }
      body.drift.charging = false;
      body.drift.sparkLevel = 0;
      body.drift.chargeStartTick = 0;
    } else {
      // Still charging — advance spark level
      const elapsed = state.tick - body.drift.chargeStartTick;
      let newLevel: 0 | 1 | 2 | 3 = 0;
      if (elapsed >= DRIFT_SPARK_TICK_3) newLevel = 3;
      else if (elapsed >= DRIFT_SPARK_TICK_2) newLevel = 2;
      else if (elapsed >= DRIFT_SPARK_TICK_1) newLevel = 1;
      body.drift.sparkLevel = newLevel;
      // Angular bias: lean body.rot toward the inside of the turn
      if (body.intent.dir && turning) {
        const sign = body.intent.dir.x > 0 ? -1 : 1;
        body.rot += sign * DRIFT_ANGULAR_BIAS_RAD * (1 / REEF_SIM_HZ);
      }
    }
  } else {
    // Not charging — can we start?
    if (justPressed && turning && fastEnough) {
      body.drift.charging = true;
      body.drift.sparkLevel = 0;
      body.drift.chargeStartTick = state.tick;
    }
  }

  body.drift.lastDriftBit = driftBit;
}
```

**Interaction with collision/pickup logic:**
- `resolveProximity` happens AFTER `applyIntentForTick`. A collision that slows the body below `DRIFT_MIN_SPEED_FOR_CHARGE` will trigger cancellation on the NEXT tick (not the same tick as the collision). This is acceptable — one-tick lag is imperceptible and avoids the complexity of cancelling in the same tick as collision resolution.
- The `rr-drift-boost` active effect stacks with `rr-turbo-bubble`: `speedMod = boosted ? REEF_BOOST_MULT : driftBoosted ? (1 + activeDriftMult) : slicked ? 0.5 : 1.0`. Implementation: check drift boost separately in `speedMod` calculation.
- Body finishes (`finishedAt ≠ null`) or DNFs: the guard at the top of the per-body loop in `tickRoom` already skips finished/forfeited bodies, so no drift state cleanup is needed.

### 2.5 No double-fire protection

The state machine is single-fire by design: once `justReleased` fires the boost, `body.drift.charging` is set to `false` and `body.drift.lastDriftBit` is set to `false` in the same call. The next tick sees `lastDriftBit=false`, so `justReleased=false`. Double-fire is structurally impossible.

---

## 3. Launch boost window

### 3.1 Problem statement

The COUNTDOWN→LIVE transition happens at a server wall-clock instant (`state.startedAt`). Clients send `input` frames at ~30Hz with `thrust` values. The launch window detection must sample thrust in the ±150ms window around `startedAt`.

### 3.2 Data collection

In `ReefRoomState`, add a pre-launch input buffer:

```typescript
/**
 * Collected during the countdown phase: per-body, the last N thrust values
 * with their wall-clock timestamps. Cleared on LIVE transition after evaluation.
 */
preLaunchInputs: Map<string, Array<{ timestamp: number; thrust: number }>>;
```

**When populated:** The sim is started via `startRoom` which is called at the LIVE transition. However, in the actual room manager flow, the sim starts after the countdown completes — so `startedAt` IS the green-light moment. The approach is:

1. Store `raceStartedAt: number` on the state (same as `startedAt`).
2. In `applyInput`, if the room is in a "pre-live" buffer mode (a flag: `awaitingLaunch: boolean = true`, cleared on first tick), append to `preLaunchInputs[petId]`.
3. On the FIRST tick (`state.tick === 1`), evaluate all pre-launch inputs against `state.startedAt` and apply launch results to `body.activeEffects`.

Wait — actually `startRoom` is called when the room goes LIVE (per the comment on line 236: "Caller (room manager) ensures the room is in LIVE state when calling"). There is no pre-live phase in the sim. The launch input must come from the TRANSITION moment itself.

**Revised approach — input window around `startedAt`:**

The room manager calls `startRoom` at the LIVE transition. Before that, the WS hub was accepting `input` frames and calling `applyInput` — but `applyInput` returns `{ok: false}` for an unknown room (the sim doesn't have the room yet). So pre-launch thrust data never reaches the sim.

**Solution:** Add a `launchInputBuffer` to the room state that the room manager writes INTO via a separate `recordPreLaunchInput(roomId, petId, timestamp, thrust)` method on the sim — called by the WS hub BEFORE `startRoom`. Then `startRoom` reads the buffer.

Alternatively (simpler, same fidelity): The room manager holds a pre-launch buffer in its own state (outside the sim), and passes the per-body launch verdict as part of the `startRoom` call:

```typescript
startRoom(
  roomId, activityId, participantPetIds,
  opts?: {
    seed?: number;
    isBot?: (petId: string) => boolean;
    bots?: BotController[];
    launchBoosts?: Map<string, 'boost' | 'stall' | null>; // NEW
  }
)
```

The room manager captures thrust in the ±150ms around the countdown-zero wall-clock, computes the verdict per player, and passes it in. On body initialization, apply the appropriate `activeEffect`:

```typescript
// In body initialization loop:
const launchVerdict = opts?.launchBoosts?.get(petId) ?? null;
if (launchVerdict === 'boost') {
  body.activeEffects.set('rr-launch-boost', startedAt + LAUNCH_BOOST_DURATION_MS);
}
if (launchVerdict === 'stall') {
  body.activeEffects.set('rr-launch-stall', startedAt + LAUNCH_STALL_DURATION_MS);
}
// Broadcast after bodies are initialized:
broadcastFn(roomId, { type: 'event.launch', petId, kind: launchVerdict });
```

This keeps the sim pure (no WS dependency) and moves the timing detection to the correct layer (room manager, which owns the countdown clock).

### 3.3 Tick math for the launch window

At 30Hz, 150ms = 4.5 ticks. The input capture window opens at `countdownEndsAt - LAUNCH_WINDOW_MS` ms wall-clock and closes at `countdownEndsAt + LAUNCH_WINDOW_MS`. The room manager samples the last-received `thrust` value per player at the moment it calls `startRoom`, then looks back at buffered inputs in the buffer period.

```
LAUNCH_WINDOW_MS = 150
LAUNCH_STALL_WINDOW_MS = 200
```

**Detection rule (implemented in room manager, not sim):**
```
lastThrust = last thrust value received from client before startedAt
lastThrustAt = timestamp of that input frame

if (lastThrust >= 1.0 && abs(lastThrustAt - startedAt) <= LAUNCH_WINDOW_MS):
  verdict = 'boost'
elif (lastThrust >= 1.0 && lastThrustAt < startedAt - LAUNCH_WINDOW_MS
      && lastThrustAt > startedAt - LAUNCH_STALL_WINDOW_MS - LAUNCH_WINDOW_MS):
  verdict = 'stall'
else:
  verdict = null
```

The stall condition ("press too early >200ms before green"): the stall zone is `(startedAt - (LAUNCH_WINDOW_MS + LAUNCH_STALL_WINDOW_MS))` to `(startedAt - LAUNCH_WINDOW_MS)`.

**ABORTED transition safety:** If the room is torn down (e.g., host leaves) during the countdown, the room manager never calls `startRoom` — the `launchBoosts` map is simply discarded. No sim state is left dangling.

### 3.4 `rr-launch-stall` effect in `applyIntentForTick`

Add a `speedMod` clause for stall. During stall, `thrust` is capped at `LAUNCH_STALL_THRUST_CAP`:

```typescript
const stalled = body.activeEffects.has('rr-launch-stall');
const launchBoosted = body.activeEffects.has('rr-launch-boost');
const driftBoosted = body.activeEffects.has('rr-drift-boost');

const effectiveThrust = stalled ? Math.min(intent.thrust, LAUNCH_STALL_THRUST_CAP) : intent.thrust;
const speedMod = launchBoosted
  ? (1 + LAUNCH_BOOST_MULT)
  : boosted
    ? REEF_BOOST_MULT
    : driftBoosted
      ? (1 + activeDriftMult)
      : slicked
        ? 0.5
        : 1.0;
```

where `activeDriftMult` is read from the stored `DRIFT_BOOST_MULTS` index (need to track which spark level triggered it — store the multiplier value, not the index, in a separate `Map<petId, number>` or embed it in the effect value).

**Implementation note on stacking:** `rr-launch-boost` and `rr-turbo-bubble` both apply `speedMod`. If both are active simultaneously (a player collected a turbo bubble AND got launch boost), the implementation takes the MAX. This is safe — it's a design decision, not a spec constraint.

---

## 4. Reef Glider prop (3da owned)

### 4.1 Placeholder GLB strategy

**Decision: procedural geometry in code, not a committed GLB file.**

Justification:
- Iris Xe draw call budget: scene already uses chase cam with 1 dir shadow + hemi light. Adding a GLB with new materials risks adding 2-4 draw calls per player (8 players = 16-32 extra calls). A procedural `BoxGeometry` surfboard in the same `MeshStandardMaterial` as the kart color shares the material instance — zero extra draw calls if instanced.
- A committed 1KB GLB would still require a new material (GLB brings its own). The procedural approach costs exactly 0 draw calls in the merged-geometry path.
- Iris Xe gotcha: `InstancedMesh + ShaderMaterial` crashes WebGPU silently (MEMORY.md gotcha). Procedural with `MeshStandardMaterial` is safe.
- Art placeholder quality is irrelevant — it ships Phase 1 before anyone sees it, then gets replaced in Phase 2.

**Glider geometry:**
```
BoxGeometry(60, 6, 100)  — wu (width × height × length)
```
Positioned at `gliderRef.position.set(0, 0, 0)` relative to the kart group.

### 4.2 Scene node structure change

Current (before Phase 1):
```
groupRef (position, rotation from server)
  └── meshRoot (KART_Y_ABOVE_TRACK offset, bank tilt applied here)
        └── avatarMesh (GLB clone)
```

After Phase 1:
```
groupRef (position from server via interpolation)
  └── gliderRef (y=KART_Y_ABOVE_TRACK, rotation.y from server, bank tilt applied HERE)
        ├── gliderMesh (procedural BoxGeometry surfboard)
        └── riderMountRef (at SPECIES_RIDER_OFFSET[species])
              └── avatarMesh (GLB clone, bank tilt NOT applied — rider stays upright)
```

**Key invariants:**
- `groupRef` remains the interpolation target (x, z in Three.js space = sim x, y).
- `gliderRef.rotation.y` = server `entity.rot` (already computed in the existing lerpAngle path — just move the target from `meshRoot` to `gliderRef`).
- Bank tilt: moves from `meshRoot.rotation.z` to `gliderRef.rotation.z`. The velocity-derived bank formula is unchanged.
- Avatar `riderMountRef.rotation.z = 0` always (rider stays level while board leans).

### 4.3 Species rider offset map

The 4 known species from `ReefRacePlayer.tsx` are `sea_horse` and `lobster` (the only two currently branched in the file). The plan names milady and crayfish as future. The map must be keyed by `species` string from `entity.species`.

**Proposed offsets (wu, in glider-local space, Y=up):**

| Species | x (side) | y (vertical) | z (fore-aft) | Notes |
|---|---|---|---|---|
| `lobster` | 0 | 10 | -10 | Grips front rail; slightly forward, mid-height |
| `sea_horse` | 0 | 15 | 0 | Coils vertically on center; higher because tail extends down |
| `milady` | 0 | 18 | 5 | Stands upright, center-back (hoverboard stance) |
| `crayfish` | 0 | 10 | -8 | Similar to lobster, slightly more centered |

```typescript
// In reef-race-config.ts (client side)
export const SPECIES_RIDER_OFFSET: Record<string, [x: number, y: number, z: number]> = {
  lobster:   [0, 10, -10],
  sea_horse: [0, 15,   0],
  milady:    [0, 18,   5],
  crayfish:  [0, 10,  -8],
};
export const SPECIES_RIDER_OFFSET_DEFAULT: [number, number, number] = [0, 12, 0];
```

### 4.4 Procedural animation gating

The existing `applySwimmingAnim` in `ReefRacePlayer.tsx` applies spine/tail/fin bone animation on ALL species. After Phase 1:

- `lobster`, `sea_horse`, `crayfish`: keep gentle bob (vertical `sin` oscillation on `riderMountRef.position.y`, ±2wu at 1.2Hz). Remove fin/tail bone animation that mimics swimming — the glider provides locomotion fiction.
- `milady`: balance sway instead of swim. Apply `riderMountRef.rotation.z = sin(t * 0.8) * 0.04` (subtle side lean). No tail/fin bones (VRM rig — different bone hierarchy).

**Guard for milady:** `if (entity.species === 'milady') { applyBalanceSway(riderRef, t); } else { applyBob(riderRef, t); }`

**No per-frame allocations:** The existing `_swimTime` module-scope record is used. `riderMountRef` is stored in a module-scope Map keyed by `entity.petId`.

---

## 5. HUD drift sparks

### 5.1 Store field

**New field on `ActivityState`:** `driftSparks: number` (0..3, default 0). This is a HUD-only scalar — the scene does not use it. It represents the SELF player's current spark level.

Added to `emptyState()` return as `driftSparks: 0`.

Written when `applyServerFrame` processes `snapshot.delta` or `snapshot.keyframe` — the entity delta for the self pet now includes `driftSparks?: number` in the `changed` map (see §6 below). The store reads it:

```typescript
// in applyEntityDelta, after existing field spreads:
if (typeof c.driftSparks === 'number' && delta.petId === get().selfPetId) {
  set({ driftSparks: c.driftSparks as 0 | 1 | 2 | 3 });
}
```

**Re-render gate:** use `subscribeWithSelector` — the `DriftSparksBar` component subscribes with `useActivityStore(s => s.driftSparks)`. Since `driftSparks` is a primitive number, zustand's default `Object.is` equality check prevents re-renders when the value hasn't changed. No additional gate needed.

**Per-frame ref update is NOT used.** `driftSparks` is only written on snapshot delta (5Hz), not in `useFrame`. This is correct — the store updates at 5Hz which is fast enough for visual feedback on a 1.2s arc.

### 5.2 DOM structure

The sparks component is added to `reef-race-hud.tsx` as a new sub-component `DriftSparksBar`.

**CSS/DOM structure:**

```tsx
// Position: bottom-center, ABOVE the PowerUpBar
// Layout: absolute div stack

// Container — sits above PowerUpBar
<div style={{
  position: 'absolute',
  bottom: 80,  // above the 24px-bottom PowerUpBar (which is 36+6+6+6+24 = ~78px tall)
  left: '50%',
  transform: 'translateX(-50%)',
  display: 'flex',
  gap: 8,
  alignItems: 'center',
}}>
  {/* Label */}
  <div style={{
    fontSize: 9,
    letterSpacing: '0.15em',
    color: '#ffffff66',
    marginRight: 4,
  }}>DRIFT</div>

  {/* 3 spark dots */}
  {[0, 1, 2].map(i => (
    <div key={i} style={{
      width: 14,
      height: 14,
      borderRadius: '50%',
      border: `2px solid ${i < sparks ? SPARK_BORDER[i] : '#ffffff33'}`,
      background: i < sparks ? SPARK_FILL[i] : 'transparent',
      // Glow effect via boxShadow when filled
      boxShadow: i < sparks ? `0 0 6px ${SPARK_FILL[i]}` : 'none',
      transition: 'background 0.1s, box-shadow 0.1s',
    }} />
  ))}
</div>
```

**Color constants:**
```typescript
const SPARK_FILL   = ['#ff9800', '#f44336', '#2979ff'] as const; // orange, red, blue
const SPARK_BORDER = ['#ff9800', '#f44336', '#2979ff'] as const;
```

Spark 1 (index 0) = orange, spark 2 = red, spark 3 = blue. Fills are additive: sparks=2 means dots 0 and 1 filled, dot 2 empty.

**Only renders when `matchPhase === 'live'`** — no drift in countdown or results. The existing `matchPhase` subscription gates the component.

### 5.3 Launch glow ring on countdown

The `RoundCountdown` component is in `apps/web/src/components/game/activity.tsx`. In the LAST countdown second (`secondsRemaining === 1`), add a pulsing animated ring via CSS `@keyframes pulse`:

```tsx
// In RoundCountdown, when secondsRemaining === 1:
<div style={{
  position: 'absolute',
  inset: -12,
  borderRadius: '50%',
  border: '3px solid #00e676',
  animation: 'reefLaunchPulse 0.4s ease-in-out infinite',
  pointerEvents: 'none',
}} />
```

The keyframe is injected as a `<style>` element at module scope (not inline, to avoid per-render allocation):
```css
@keyframes reefLaunchPulse {
  0%   { opacity: 1; transform: scale(1); }
  50%  { opacity: 0.4; transform: scale(1.15); }
  100% { opacity: 1; transform: scale(1); }
}
```

This is purely visual — no logic change to `RoundCountdown` itself.

---

## 6. WS protocol additions

### 6.1 File to modify

`packages/shared/src/activities/protocol.ts` — the `ServerFrame` union. There is no `activity-frames.ts`.

### 6.2 New event types

Add two new members to the `ServerFrame` union:

```typescript
| {
    type: 'event.drift_boost';
    petId: string;
    /** Spark level that triggered the boost (1 | 2 | 3) */
    sparks: 1 | 2 | 3;
  }
| {
    type: 'event.launch';
    petId: string;
    kind: 'boost' | 'stall';
  }
```

**Backwards compat:** The exhaustive `default: never` sentinel in `activity.ts` `applyServerFrame` will catch these at compile time — the switch MUST add new cases or TypeScript will error. Old clients receiving these events from a new server will hit the `default` branch which does `void _exhaustive` — no crash, graceful ignore.

### 6.3 `driftSparks` field on entity delta

The `EntityDelta.changed` interface uses `[k: string]: unknown` catch-all:
```typescript
changed: {
  x?: number;
  y?: number;
  ...
  [k: string]: unknown;
};
```

`driftSparks` flows through the existing catch-all without requiring a schema change to `EntityDelta`. However, for type-safety in the store's `applyEntityDelta`, document it explicitly:

```typescript
// Add to EntityDelta.changed type annotation comment block:
// driftSparks?: 0 | 1 | 2 | 3  (Reef Race only — self body's current drift spark level)
```

### 6.4 Wiring through `activity.ts` store

**Add to `ActivityState`:**
```typescript
driftSparks: 0 | 1 | 2 | 3;
```

**Add to `emptyState()`:**
```typescript
driftSparks: 0,
```

**In `applyEntityDelta`:** After processing the existing fields, if `delta.petId === get().selfPetId && typeof c.driftSparks === 'number'`:
```typescript
set({ driftSparks: (c.driftSparks as 0 | 1 | 2 | 3) });
```

**In `applyServerFrame` switch:**
```typescript
case 'event.drift_boost': {
  // Visual flash: could push to events ring buffer for scene consumption.
  // Phase 1: no 3D VFX. Store the event for the HUD flash only.
  // The HUD subscribes to driftSparks (already zeroed by the delta following
  // the boost) — no additional store field needed for Phase 1.
  // Future: push to events.driftBoosts for the scene's VFX processor.
  break;
}
case 'event.launch': {
  // Phase 1: HUD shows the glow ring (driven by countdown state, not this event).
  // Future: show per-player launch indicator in the 3D scene.
  break;
}
```

**Broadcast of `driftSparks` in snapshot delta (`reef-race-sim.ts`):**

In `buildSnapshot`, include `driftSparks` in each body's snapshot data:
```typescript
bodies: Array.from(state.bodies.values()).map((b) => ({
  ...existing fields...,
  driftSparks: b.drift.sparkLevel,  // NEW
}))
```

In `broadcastDelta`, include `driftSparks` in the entity delta `changed` object when it differs from the previous snapshot:
```typescript
// In the delta filter:
|| p.driftSparks !== b.driftSparks

// In the changed map:
driftSparks: b.driftSparks,
```

**Default value for backwards compat:** Old clients not handling `driftSparks` will receive it in `changed` and silently ignore it (hits the `[k: string]: unknown` catch-all in `EntityDelta.changed` plus the `void _exhaustive` default in the store's switch on unknown keys — there is no switch on `changed` fields, it's a direct spread). No issue.

---

## 7. Bot drift and launch behavior

### 7.1 Drift decision tree

The bot's `computeInput` in `reef-race-bot.ts` must decide when to set `ACTION_BIT_DRIFT` in `actionBits`.

**Drift state needed:** The bot is stateless today (class has no instance fields beyond `petId`). Drift requires tracking `driftActive: boolean` and `driftStartedTick: number`. Since `BotController` is called with the room view (which includes `now`), the bot needs to maintain per-match state.

**Add to `ReefRaceBot` class:**
```typescript
private driftActive = false;
private driftStartedMs = 0;
private driftTargetSparks: 1 | 2 | 3 = 1;
```

**Decision tree (per `computeInput` call):**

```
inGrace (matchAge < 2500ms)?
  → no drift

driftActive?
  YES:
    chargedEnough = (now - driftStartedMs) >= DRIFT_SPARK_TICK_1 * REEF_TICK_MS * driftTargetSparks_ticks
    if chargedEnough:
      release drift (driftActive = false, return actionBits WITHOUT drift bit)
      // Releasing causes the sim to fire the boost
    else:
      continue holding drift (return actionBits WITH drift bit)
  NO:
    inHairpin? (|dir.x| >= 0.35 AND heading off-center)
      probability check: Math.random() < 0.6 / REEF_SIM_HZ
        → start drift (driftActive = true, driftStartedMs = now)
        → driftTargetSparks = weightedRandom([1, 2, 3], [0.5, 0.35, 0.15])
        → return actionBits WITH drift bit
      else:
        no drift
```

**"In hairpin" detection:** The bot already computes `dot` (dot product between current heading and target direction). A hairpin entry is when `dot < 0.5` (>60° off the target direction) AND `distToTarget > 200wu` (not at the checkpoint apex yet).

**Probability:** `0.6 / REEF_SIM_HZ` per tick = 0.6 / 30 ≈ 0.02 per tick. At a 1s hairpin entry (30 ticks), expected drift attempts = 30 × 0.02 = 0.6 per hairpin. ~45% of hairpins trigger a drift charge. This is slightly below the plan's "probability 0.6" which likely means "60% of hairpins" — the per-tick math achieves this.

**Target sparks distribution:** 50% spark-1, 35% spark-2, 15% spark-3. This gives bots a realistic but imperfect skill ceiling.

### 7.2 Launch behavior

```typescript
private launchAttempted = false;
```

The bot sets `ACTION_BIT_LAUNCH` for one tick at a random offset from `matchStartedAt`. The room manager must accept `ACTION_BIT_LAUNCH` in the pre-launch buffer.

**Imperfection:** The bot's "press" is modeled as happening at `matchStartedAt + jitter` where `jitter ~ Uniform(-400ms, +400ms)`. In the bot's `computeInput`:

```typescript
// First call after grace ends:
if (!this.launchAttempted && matchAge < 100) {
  const jitter = (Math.random() * 800) - 400; // -400 to +400ms
  if (matchAge >= jitter) {
    this.launchAttempted = true;
    // Return thrust=1.0 + ACTION_BIT_LAUNCH for one tick
    return { dir, thrust: 1.0, actionBits: actionBits | ACTION_BIT_LAUNCH };
  }
}
```

With `LAUNCH_WINDOW_MS = 150`: only launches with jitter in [-150, +150] (37.5% of the ±400 range) yield a boost. Launches with jitter in [-350, -150] (25%) yield a stall. Remaining 37.5% = no launch. This gives ~50% success rate as specified.

---

## 8. Test plan

All new tests go in `apps/api/src/services/activity/sim/__tests__/reef-race-sim.test.ts` and `apps/api/src/services/activity/bots/__tests__/reef-race-bot.test.ts`.

**Preserve existing tests:** All existing fixtures use `now: 5000, matchStartedAt: 0` which puts `matchAge = 5000ms` — well past `BOT_OPENING_GRACE_MS = 2500ms`. No changes needed to existing test helpers.

### 8.1 Sim drift tests (`reef-race-sim.test.ts`)

#### Test 1: Drift starts when conditions are met

```typescript
describe('drift state machine', () => {
  it('starts charging when drift-bit + turning + speed threshold met', () => {
    // Setup: body at cruise speed, drift-bit set, steering input
    // Assert: body.drift.charging === true after tick
  });
```

Setup: `body.vx = 200` (above 150 threshold), `intent.actionBits = ACTION_BIT_DRIFT`, `intent.dir = {x: 0.5, y: 0.866}` (turning). Tick once. Assert `body.drift.charging === true`.

#### Test 2: Does NOT start without steering

```typescript
  it('does not start drift-charge when moving straight', () => {
    // Setup: body at cruise speed, drift-bit set, dir.x = 0 (straight)
    // Assert: body.drift.charging === false after tick
  });
```

#### Test 3: Advances spark levels at correct tick counts

```typescript
  it('advances from 0→1 at DRIFT_SPARK_TICK_1 ticks', () => {
    // Start drift charging
    // Tick DRIFT_SPARK_TICK_1 - 1 times → sparkLevel still 0
    // Tick 1 more → sparkLevel === 1
  });
  it('advances to 2 at DRIFT_SPARK_TICK_2 ticks', ...);
  it('advances to 3 at DRIFT_SPARK_TICK_3 ticks', ...);
```

Implementation: use `__tickOnceForTest` in a loop, set body velocity + intent before each tick (or once and verify the sim preserves them).

#### Test 4: Cancels without boost on early release (sparkLevel=0)

```typescript
  it('cancels silently when drift-bit released before first spark', () => {
    // Start drift charging
    // Tick DRIFT_SPARK_TICK_1 - 2 times (not yet at spark 1)
    // Release drift-bit (actionBits = 0)
    // Tick once
    // Assert: drift.charging === false, drift.sparkLevel === 0
    // Assert: no 'event.drift_boost' in broadcasts
  });
```

#### Test 5: Fires boost on release after at least 1 spark

```typescript
  it('fires boost event when drift released with sparkLevel >= 1', () => {
    // Charge to spark 1 (DRIFT_SPARK_TICK_1 ticks)
    // Release drift-bit
    // Tick once
    // Assert: 'event.drift_boost' in broadcasts with sparks: 1
    // Assert: body.activeEffects.has('rr-drift-boost')
  });
```

#### Test 6: Drift does not double-fire

```typescript
  it('does not fire boost on consecutive release ticks', () => {
    // Charge to spark 2, release
    // Tick: captures boost event, clears drift state
    // Hold drift-bit released for 3 more ticks
    // Assert: only one 'event.drift_boost' in broadcasts total
  });
```

#### Test 7: Drift cancels when speed drops below threshold

```typescript
  it('cancels drift when body slows below DRIFT_MIN_SPEED_FOR_CHARGE', () => {
    // Start charging
    // Advance tick count to spark 1
    // Set body.vx = 0, body.vy = 0 (simulate full stop)
    // Tick once (drift-bit still held)
    // Assert: drift.charging === false, no boost event
  });
```

### 8.2 Launch boost tests (`reef-race-sim.test.ts`)

#### Test 8: Launch boost success window

```typescript
describe('launch boost', () => {
  it('applies rr-launch-boost when launchBoosts map contains boost verdict', () => {
    const launchBoosts = new Map([['p1', 'boost' as const]]);
    reefRaceSim.startRoom('room-a', 'reef-race', ['p1', 'p2'], { launchBoosts });
    const body = state.bodies.get('p1')!;
    expect(body.activeEffects.has('rr-launch-boost')).toBe(true);
    expect(body.activeEffects.has('rr-launch-stall')).toBe(false);
  });
```

#### Test 9: Launch stall on early press

```typescript
  it('applies rr-launch-stall when verdict is stall', () => {
    const launchBoosts = new Map([['p1', 'stall' as const]]);
    reefRaceSim.startRoom('room-a', 'reef-race', ['p1', 'p2'], { launchBoosts });
    const body = state.bodies.get('p1')!;
    expect(body.activeEffects.has('rr-launch-stall')).toBe(true);
    // Verify thrust is capped
    body.intent.thrust = 1.0;
    // tick once and check velocity did not reach full speed
    reefRaceSim.__tickOnceForTest('room-a');
    const speed = Math.hypot(body.vx, body.vy);
    expect(speed).toBeLessThan(REEF_MAX_SPEED * LAUNCH_STALL_THRUST_CAP * 1.1);
  });
```

#### Test 10: No-op when no launch input

```typescript
  it('applies no launch effect when launchBoosts map is absent or null', () => {
    reefRaceSim.startRoom('room-a', 'reef-race', ['p1', 'p2']);
    const body = state.bodies.get('p1')!;
    expect(body.activeEffects.has('rr-launch-boost')).toBe(false);
    expect(body.activeEffects.has('rr-launch-stall')).toBe(false);
  });
```

### 8.3 Bot drift behavior tests (`reef-race-bot.test.ts`)

#### Test 11: Bot uses drift in hairpins (statistical)

```typescript
  it('uses drift bit in at least 30% of hairpin ticks over many samples', () => {
    const bot = createReefRaceBot('bot-self');
    const checkpoints = buildReefCheckpoints();
    // Position at hairpin entry: 60° off next-checkpoint heading
    // (dot product < 0.5 between current heading and checkpoint direction)
    const target = checkpoints[3]; // some hairpin checkpoint
    // Simulate body heading perpendicular to the direct path
    const view = makeReefView({
      selfPos: { x: target.center.x - 300, y: target.center.y + 200 },
      nextCheckpoint: 3,
    });
    // Give the body some velocity perpendicular to target
    view.bodies[0].vx = 150;
    view.bodies[0].vy = 0;

    let driftCount = 0;
    const TICKS = 300; // 10 seconds at 30Hz
    for (let i = 0; i < TICKS; i++) {
      const intent = bot.computeInput(view, 1 / 30);
      if ((intent.actionBits ?? 0) & ACTION_BIT_DRIFT) driftCount++;
    }
    // Should use drift in at least 10% of ticks
    // (bot charges then releases, so it alternates on/off)
    expect(driftCount / TICKS).toBeGreaterThan(0.10);
  });
```

#### Test 12: Bot does not use drift during grace period

```typescript
  it('never sets drift bit during the opening grace window', () => {
    const bot = createReefRaceBot('bot-self');
    const view = makeReefView({ selfPos: { x: 0, y: 0 } });
    view.now = 1_000; // matchAge = 1000ms, inside 2500ms grace
    view.matchStartedAt = 0;
    for (let i = 0; i < 100; i++) {
      const intent = bot.computeInput(view, 1 / 30);
      expect((intent.actionBits ?? 0) & ACTION_BIT_DRIFT).toBe(0);
    }
  });
```

---

## 9. Risks and mitigations

### 9.1 Backwards compat — clients without sparks UI

**Risk:** A client on an older build receives `driftSparks` in entity deltas and `event.drift_boost` / `event.launch` in the frame stream. The old client's `applyServerFrame` switch has no cases for the new event types, hitting the `default: never` sentinel — which throws a TypeScript compile error at build time, NOT at runtime. At runtime, the default branch executes `void _exhaustive` (which is just the frame object) and continues — no crash. The `driftSparks` field in `changed` is silently ignored by the existing spread logic.

**Mitigation:** The `default` branch's `const _exhaustive: never = frame; void _exhaustive` pattern is specifically designed for this forward-compat case. Verified in `activity.ts` line 711-712. Old clients degrade gracefully (no sparks UI, no launch indicator) without crashing.

### 9.2 Drift state surviving room teardown

**Risk:** If a room is `stopRoom`-ed while a body has `charging=true` and `sparkLevel=2`, the drift state exists in memory until the room map entry is deleted. The `broadcastFn` might fire the boost into a torn-down room.

**Mitigation:** `stopRoom` calls `this.rooms.delete(roomId)` which immediately removes the room. The `tickRoom` guard `if (state.ended) return;` at the top prevents any further drift processing. The `intervalHandle` is cleared before deletion. The broadcast callback is a closure over the room reference — after `rooms.delete`, the room object still exists in memory until the interval is cleared and all callbacks complete, but no further ticks fire. This is the existing pattern for all room teardown in the sim and is safe.

### 9.3 Launch boost firing during ABORTED transition

**Risk:** If the countdown completes (triggering the room manager's `launchBoosts` computation) but the room is then immediately aborted before `startRoom` is called (e.g., host disconnects in the same event loop iteration), the `launchBoosts` map is computed but never applied.

**Mitigation:** The `launchBoosts` map is a local variable in the room manager's countdown handler. If `startRoom` is never called, the map is simply GC'd. No sim state is affected. The abort path must NOT call `startRoom` — this is already the correct behavior since `startRoom` starts the `setInterval` and should only be called on confirmed LIVE transition.

### 9.4 Per-body drift state memory (bots × matches × time)

**Risk:** In a room with 8 bodies (7 bots + 1 human) running a 90s race at 30Hz = 162,000 ticks, the drift state is 4 fields per body. Total additional memory: 8 bodies × 4 fields × ~8 bytes = 256 bytes per room. Negligible.

**Risk (bot class):** The `ReefRaceBot` class instances carry `driftActive`, `driftStartedMs`, `launchAttempted`, `driftTargetSparks` — 4 fields × 8 bytes × 7 bots = 224 bytes per room. GC'd when `botControllers` map is cleared in `stopRoom`. Negligible.

### 9.5 Anti-cheat interaction with drift boost speed

**Risk:** After a 3-spark drift boost (+38%), the body's velocity spikes. The `validateReefVelocityDelta` and `validateReefPositionDelta` validators in `integrateMotion` check against `REEF_MAX_SPEED`. A drift-boosted body (max speed ≈ 690 wu/s) will trip the `overspeed` flag.

**Mitigation:** The validators use a `tolerance` parameter (currently 1.5× in `integrateMotion`). Post-drift speed = `500 * 1.38 = 690 wu/s`. Tolerance check: `690 / 500 = 1.38 < 1.5` — JUST under the 1.5× tolerance. Safe for spark-3. For launch boost: `500 * 1.30 = 650 wu/s`. Combined (drift-3 + launch): `500 * 1.38 * 1.30 ≈ 897 wu/s > 1.5 × 500 = 750` — this WOULD flag.

**Fix:** Drift boost and launch boost should not stack multiplicatively. Apply them additively: `speedMod = 1 + (driftMult + launchMult)`. Combined max: `1 + 0.38 + 0.30 = 1.68` → `840 wu/s`. Still > 750. 

**Fix 2:** Raise the validator tolerance for the Reef sim to 2.0× (from 1.5×) specifically in the post-boost case, OR cap the combined boost at `REEF_MAX_SPEED * 1.5 - ε`. **Chosen approach:** cap the boost-applied velocity after application:

```typescript
// After applying drift/launch boost in applyIntentForTick:
const postBoostSpeed = Math.hypot(body.vx, body.vy);
const hardCap = REEF_MAX_SPEED * 1.45; // 725 wu/s, under the 1.5× validator
if (postBoostSpeed > hardCap) {
  const scale = hardCap / postBoostSpeed;
  body.vx *= scale;
  body.vy *= scale;
}
```

This makes the combined drift+launch boost visually feel strong but never triggers the anti-cheat flag.

### 9.6 `applyServerFrame` exhaustiveness — TypeScript build fail

**Risk:** Adding `event.drift_boost` and `event.launch` to `ServerFrame` union will cause a TypeScript build error in `activity.ts` because the `default: never` case will produce a type error — the new union members are `never`-assignable but not handled.

**Mitigation:** This is INTENTIONAL and DESIRED behavior. The plan explicitly adds `case 'event.drift_boost': break;` and `case 'event.launch': break;` to the switch. The build error is the guard that prevents shipping without the store wiring. Implementation must add both cases or the build fails.

---

## 10. File-by-file change summary

| File | Owner | Changes |
|---|---|---|
| `packages/shared/src/activities/protocol.ts` | orchestrator | Add `event.drift_boost`, `event.launch` to `ServerFrame` union |
| `apps/api/src/services/activity/sim/reef-race-config.ts` | orchestrator | Add `DRIFT_SPARK_TIERS`, `DRIFT_BOOST_MULTS`, `DRIFT_BOOST_DURATION_MS`, `DRIFT_MIN_SPEED_FOR_CHARGE`, `DRIFT_MIN_STEER`, `DRIFT_ANGULAR_BIAS_RAD`, `LAUNCH_WINDOW_MS`, `LAUNCH_BOOST_MULT`, `LAUNCH_BOOST_DURATION_MS`, `LAUNCH_STALL_WINDOW_MS`, `LAUNCH_STALL_DURATION_MS`, `LAUNCH_STALL_THRUST_CAP`, `ACTION_BIT_DRIFT`, `ACTION_BIT_LAUNCH` |
| `apps/api/src/services/activity/sim/reef-race-sim.ts` | orchestrator | Add `ReefDriftState` to `ReefBody`; add `driftSparks` to snapshot encoding; add `tickDriftState()`; add `rr-drift-boost`/`rr-launch-boost`/`rr-launch-stall` to `speedMod`; add `launchBoosts` param to `startRoom`; add velocity hard cap post-boost; broadcast `event.drift_boost`, `event.launch` |
| `apps/api/src/services/activity/bots/reef-race-bot.ts` | orchestrator | Add `driftActive`, `driftStartedMs`, `driftTargetSparks`, `launchAttempted` state fields; drift decision tree in `computeInput`; launch attempt logic |
| `apps/web/src/stores/activity.ts` | orchestrator | Add `driftSparks: 0|1|2|3` to `ActivityState` + `emptyState`; handle `driftSparks` in `applyEntityDelta`; add `event.drift_boost` + `event.launch` cases to switch |
| `apps/web/src/components/game/reef-race-hud.tsx` | orchestrator | Add `DriftSparksBar` component; add launch glow ring to `RoundCountdown` |
| `apps/web/src/lib/three/activities/reef-race/reef-race-config.ts` | 3da | Add `SPECIES_RIDER_OFFSET` map, `SPECIES_RIDER_OFFSET_DEFAULT` |
| `apps/web/src/lib/three/activities/reef-race/ReefRacePlayer.tsx` | 3da | Add `gliderRef` group, procedural surfboard geometry, `riderMountRef` at species offset; move bank tilt to `gliderRef`; gate swim/bob/sway by species |
| `apps/api/src/services/activity/sim/__tests__/reef-race-sim.test.ts` | orchestrator | Add drift tests 1-7, launch tests 8-10 |
| `apps/api/src/services/activity/bots/__tests__/reef-race-bot.test.ts` | orchestrator | Add bot drift tests 11-12 |

---

## 11. Implementation order (dependency graph)

```
1. reef-race-config.ts (server)     — no deps
   ↓
2. protocol.ts (ServerFrame union)  — no deps
   ↓
3. reef-race-sim.ts                 — deps: (1), (2)
   ↓
4. activity.ts store                — deps: (2)
   ↓
5. reef-race-hud.tsx                — deps: (4)

Parallel to 1-5:
6. reef-race-config.ts (client)     — no deps
7. ReefRacePlayer.tsx               — deps: (6)

8. reef-race-bot.ts                 — deps: (1)
9. Tests                            — deps: (3), (8)
```

Steps 6-7 are 3da-owned and can proceed in parallel with steps 1-5 after constants are locked.

---

## 12. Out of scope (enforcement)

The following are explicitly NOT part of Phase 1 and must not be added during implementation:
- Top-speed cap changes (plan §"Do NOT touch top-speed cap")
- Per-frame `new Vector3()` or other allocations in `useFrame` (MEMORY.md zero-alloc rule)
- `import 'three/webgpu'` in any file (existing PRs #59+#60 ban)
- Slipstream, cornering apex bonus, boost ribbons, hazard patches (Phase 2)
- Stat-driven physics multipliers (Phase 3)
- Personal best ghost activation (Phase 4)
- Final Reef Glider art asset (Phase 2 at earliest)
