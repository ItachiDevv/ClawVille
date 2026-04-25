# Reef Race Phase 1 — Detailed Implementation Plan

**Status:** Revised — ready for implementation.
**Branch:** `fix-bumper-build` (worktree at `.claude/worktrees/fix-bumper-build`)
**Date authored:** 2026-04-24
**Author:** 3da (implementation planning pass)

---

## Changelog

### v2 — addresses audit SHA 9f16646 (2026-04-24)

| Issue | Resolution summary |
|---|---|
| C1 — drift bias no-op | Bias now written INSIDE `applyIntentForTick` step 6, as a constant absolute offset added to the `Math.atan2` result. No per-tick accumulation; no clobbering. |
| C2 — `ReefPowerUpKind` type error | Separate `activeBoosts: Map<ReefBoostKind, ReefBoostEntry>` introduced. `activeEffects` (pickup-only) is never touched by drift/launch. |
| C3 — validator/tolerance inconsistency | Named constant `REEF_KINEMATIC_TOLERANCE = 2.0` exported and used at both call-sites. Tolerance raised to 2.0× so combined drift+launch (1.68×) never hits the silent clamp. |
| C4 — launch data path missing | Full 4-file data path specified: new `Room.preLaunchBuffer`, new `recordPreLaunchInput`, new `computeLaunchVerdicts`, updated `liveTransitionFn` in `index.ts` passing `startedAt + launchBoosts` to `startRoom`. |
| C5 — bot launch unreachable during grace | Bot launch attempt is an early return BEFORE the grace branch — bypasses the `thrust: inGrace ? 0.4 : thrust` final return entirely. |
| C6 — drift cancel on collision claim wrong | Cancel-on-collision removed from spec. Cancellation only fires when `speed < DRIFT_MIN_SPEED_FOR_CHARGE` (from ink-slick or held zero-thrust). `resolveProximity` never modifies velocity. |
| C7 — glider geometry in wrong space | All geometry specified in **local pre-scale units** (divide by KART_SCALE=20). World sizes stated explicitly for every mesh. |
| C8 — species never populated | Phase 1 ships ONE default rider attach for all species. Species-conditional branches removed entirely. Deferred to Phase 1.5. |
| S1 — snapshot diff predicate | `\|\| prev.driftSparks !== b.drift.sparkLevel` added to diff predicate. Listed in §10 table. |
| S2 — `applyEntityDelta` explanation | Corrected: no catch-all for logic. `driftSparks` written by caller (snapshot.delta handler), not inside `applyEntityDelta`. |
| S3 — `activeDriftMult` tracking | `currentDriftBoostSparks: 0|1|2|3` field on `ReefBody`. Mult looked up at apply-time from `DRIFT_BOOST_MULTS`. |
| S4 — double-counted boost | Impulse removed. Boost delivered ONLY via time-extended `activeBoosts` speedMod. No velocity spike at release. |
| S5 — hard cap not boost-gated | Cap is inside `isBoostActive` branch only. Never clamps non-boosted bodies. |
| S6 — abort cleanup | `room.preLaunchBuffer = null` added to `persistAbortedTransition` and `persistAbortedCrashTransition`. |
| S7 — snapshot diff predicate in §10 | Now in file-by-file table under `reef-race-sim.ts`. |
| S8 — bot non-determinism | Documented: bot heuristics intentionally use `Math.random()` (pre-existing). LCG governs sim physics only. |
| S9 — HUD countdown glow | HUD computes `secondsRemaining` locally from `room.countdownStartedAt`. Not dependent on `event.countdown`. |
| S10 — startedAt skew | `startRoom` accepts `startedAt` parameter. `liveTransitionFn` passes `room.startedAt!`. |
| S11 — first-sighting driftSparks | First-insert branch in `applyEntityDelta` initialises `driftSparks: 0`. |
| M1–M7 | Decimal style standardised; `DRIFT_MIN_ANGULAR_RATE` dropped (single `DRIFT_MIN_STEER`); milady branch deferred; stall start-time clarified. |
| New tests T10–T25 | 16 additional test scenarios from audit gaps added to §8. |

---

## 0. Baseline facts from source audit

Every value verified against live source before writing this plan.

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
| `REEF_TRACK_HALF_WIDTH` | `reef-race-config.ts` line ~53 | 150 wu (total lane = 300 wu) |
| `KART_SCALE` | `apps/web/.../reef-race-config.ts` line 186 | 20 |
| `KART_Y_ABOVE_TRACK` | `apps/web/.../reef-race-config.ts` line 192 | 5 |
| `ReefPowerUpKind` | `reef-race-config.ts` lines 234-241 | 6-member CLOSED union: `rr-turbo-bubble`, `rr-ink-slick`, `rr-bubble-shield`, `rr-seeker-jelly`, `rr-tide-wave`, `rr-whirlpool` |
| `activeEffects` type | `reef-race-sim.ts` line 132 | `Map<ReefPowerUpKind, number>` — STRICTLY typed; cannot accept new keys |
| `ServerFrame` union | `packages/shared/src/activities/protocol.ts` | discriminated union; new events MUST be added to union; `default: never` guard in `activity.ts` line 711 |
| `applyEntityDelta` | `activity.ts` lines 271-298 | explicit field-by-field; unknown fields silently DROPPED |
| `hydrateFromWorld` | `activity.ts` lines ~306-336 | `WorldState.entities` has NO `species` field; `species` NOT populated on any entity |
| `BotController` class | `reef-race-bot.ts` | only instance field is `petId`; class is otherwise stateless |
| Grace return location | `reef-race-bot.ts` line ~130 | final `return { thrust: inGrace ? 0.4 : thrust }` overrides ALL prior thrust |
| `liveTransitionFn` call | `activity-room-manager.ts` line ~713 | called inside `persistLiveTransition` AFTER `room.startedAt = now` |
| `room.startedAt` set | `activity-room-manager.ts` line ~398 | `room.startedAt = now` in `case 'live':` of `transitionRoom` |
| `Room` interface | `types.ts` | no `preLaunchBuffer` field — must add |
| `handleInput` | `activity-ws-hub.ts` lines 390-432 | routes only to `reefRaceSim.applyInput`; no countdown branch |
| `startRoom` signature | `reef-race-sim.ts` line 235 | `opts?: {seed, isBot, bots}` — no `launchBoosts` or `startedAt` yet |
| Bot grace window | `reef-race-bot.ts` line 31 | `BOT_OPENING_GRACE_MS = 2500ms` |
| `DEFAULT_CLAMP_TOLERANCE` | `shared.ts` line 42 | 1.15 — used by bumper-shells; reef call-sites hard-code 1.5 |
| Reef validator call-sites | `reef-race-sim.ts` lines 796+805 | hard-coded `1.5` — replace with named export |

**Retained:** There is no `packages/shared/src/types/activity-frames.ts`. The protocol lives in `packages/shared/src/activities/protocol.ts`. All plan references to "activity-frames.ts" mean `protocol.ts`.

---

## 1. Constants

All server constants go in `apps/api/src/services/activity/sim/reef-race-config.ts`.
Client constants go in `apps/web/src/lib/three/activities/reef-race/reef-race-config.ts`.

### 1.1 New type: `ReefBoostKind` (C2 fix)

Drift and launch boosts are NOT power-ups. They use a SEPARATE type and a SEPARATE Map on `ReefBody`. `activeEffects: Map<ReefPowerUpKind, number>` is never modified by drift or launch code.

```typescript
// In apps/api/src/services/activity/sim/reef-race-config.ts
export type ReefBoostKind =
  | 'launch-boost'
  | 'launch-stall'
  | 'drift-boost';

// In reef-race-sim.ts (alongside ReefBody interface)
interface ReefBoostEntry {
  expiresAt: number;
  /** Additive speed multiplier, e.g. 0.38 for +38%. Absent for launch-stall. */
  mult?: number;
}
```

`ReefBody` gains:
```typescript
activeBoosts: Map<ReefBoostKind, ReefBoostEntry>;
currentDriftBoostSparks: 0 | 1 | 2 | 3;
```

Initialised to `new Map()` and `0` respectively. The `activeEffects: Map<ReefPowerUpKind, number>` field is UNTOUCHED by all drift/launch code.

### 1.2 Drift spark tier thresholds

```
REEF_SIM_HZ = 30 → 1 tick = 33.33ms

Tier 0→1: 0.4s = 12 ticks   → achievable in any medium corner
Tier 1→2: 0.9s = 27 ticks   → needs a sustained turn entry
Tier 2→3: 1.5s = 45 ticks   → requires a full hairpin (~1/3 of the B-arc)
```

```typescript
export const REEF_TICK_MS = 1000 / REEF_SIM_HZ; // ≈ 33.33ms
export const DRIFT_SPARK_TICK_1 = 12;
export const DRIFT_SPARK_TICK_2 = 27;
export const DRIFT_SPARK_TICK_3 = 45;
export const DRIFT_SPARK_TIERS: readonly [number, number, number] = [
  DRIFT_SPARK_TICK_1,
  DRIFT_SPARK_TICK_2,
  DRIFT_SPARK_TICK_3,
];
```

### 1.3 Drift boost multipliers

```typescript
export const DRIFT_BOOST_DURATION_MS = 1_200;
/**
 * Additive speed multipliers per spark level (index 0 = spark 1).
 * Applied as: speedMod = 1 + DRIFT_BOOST_MULTS[sparkLevel - 1].
 * The mult value is stored on the ReefBoostEntry so no re-lookup is
 * needed after drift state is cleared.
 */
export const DRIFT_BOOST_MULTS: readonly [number, number, number] = [0.12, 0.24, 0.38];
```

**Boost delivery (S4 fix — impulse removed):** The drift boost does NOT apply a velocity impulse at release. Velocity magnitude at release is left unchanged. The boost raises the effective speed cap for `DRIFT_BOOST_DURATION_MS` via `speedMod` inside `applyIntentForTick`. The "surge of speed" comes from full thrust being more effective, not from an instantaneous spike. This eliminates the double-counting bug (audit S4).

### 1.4 Drift angular bias (C1 fix)

**The bias is applied as a constant absolute offset added to the `Math.atan2` result inside `applyIntentForTick` step 6, on the same line that computes `body.rot`.** It does NOT accumulate per-tick. It does NOT run after step 6 to be clobbered by it.

```typescript
export const DRIFT_ANGULAR_BIAS_RAD = (15 * Math.PI) / 180; // 0.2618 rad ≈ 15°
```

Applied in step 6 of `applyIntentForTick`:
```typescript
// Normal (not drifting):
body.rot = Math.atan2(intent.dir.x, intent.dir.y);

// While drift.charging is true (replaces the above):
const turnSign = (intent.dir.x > 0) ? -1 : 1;
body.rot = Math.atan2(intent.dir.x, intent.dir.y) + turnSign * DRIFT_ANGULAR_BIAS_RAD;
```

This produces a VISIBLE constant 15° body-angle lean into the corner while the drift is held. It disappears on the tick after release (next tick's step 6 uses the unbiased formula since `drift.charging` is now false). No unbounded accumulation. No clobbering from later steps (the bias IS step 6).

### 1.5 Minimum thresholds

```typescript
export const DRIFT_MIN_SPEED_FOR_CHARGE = REEF_MAX_SPEED * 0.30; // 150 wu/s
/**
 * |dir.x| threshold — body must be cornering to initiate drift.
 * 0.25 ≈ 14.5° off straight. Single constant name (DRIFT_MIN_ANGULAR_RATE
 * name from v1 draft dropped — only one name needed).
 */
export const DRIFT_MIN_STEER = 0.25;
```

### 1.6 Launch boost window

```typescript
export const LAUNCH_WINDOW_MS         = 150;   // half-window: ±150ms of green
export const LAUNCH_BOOST_MULT        = 0.30;  // +30% speed cap for 2s
export const LAUNCH_BOOST_DURATION_MS = 2_000;
export const LAUNCH_STALL_WINDOW_MS   = 200;   // press >200ms early = stall zone
export const LAUNCH_STALL_DURATION_MS = 1_000;
export const LAUNCH_STALL_THRUST_CAP  = 0.30;
```

**Stall semantics (M2 fix):** The stall begins at `room.startedAt`, NOT at the press moment. A player who pressed 300ms early races stalled through the first 1s of the race — net penalty is 1s of reduced thrust just as everyone else launches. Intentional and punishing without being game-ending.

### 1.7 Anti-cheat tolerance (C3 fix)

```typescript
/**
 * Named constant replacing the two hard-coded 1.5 values in reef-race-sim.ts
 * (lines 796 + 805). Both integrateMotion call-sites MUST use this constant
 * so a future refactor cannot silently revert to 1.15× (the shared.ts default).
 *
 * Raised from 1.5× to 2.0×:
 *   Max combined boost = drift-3 (0.38) + launch (0.30) = 0.68 additive
 *   Effective speed = 500 × 1.68 = 840 wu/s
 *   Under 2.0× tolerance = 500 × 2.0 = 1000 wu/s — 160 wu/s safe margin
 *
 *   Under OLD 1.5× = 750 wu/s — drift-3 + launch (840 wu/s) would be
 *   silently clamped, stripping ~11% of the combined boost. Player feels robbed.
 *
 *   rr-turbo-bubble stacking: max(1.4, 1.68) = 1.68 — still under 2.0×.
 */
export const REEF_KINEMATIC_TOLERANCE = 2.0;
```

### 1.8 actionBit assignments

```typescript
export const ACTION_BIT_POWERUP_0 = 0b0001; // existing
export const ACTION_BIT_POWERUP_1 = 0b0010; // existing
export const ACTION_BIT_DRIFT     = 0b0100; // NEW
export const ACTION_BIT_LAUNCH    = 0b1000; // NEW
```

---

## 2. Drift state machine

### 2.1 Per-body state shape

Add to `ReefBody`:
```typescript
interface ReefDriftState {
  charging: boolean;
  sparkLevel: 0 | 1 | 2 | 3;
  chargeStartTick: number;   // sim tick when charging began
  lastDriftBit: boolean;     // drift-bit value last tick (for edge detection)
}

// Fields on ReefBody:
drift: ReefDriftState;
currentDriftBoostSparks: 0 | 1 | 2 | 3; // spark level of active drift boost, 0 = none
activeBoosts: Map<ReefBoostKind, ReefBoostEntry>; // launch + drift kinematic effects
```

Default initialisation:
```typescript
drift: { charging: false, sparkLevel: 0, chargeStartTick: 0, lastDriftBit: false },
currentDriftBoostSparks: 0,
activeBoosts: new Map(),
```

### 2.2 Transition table

```
Event                              Old state           New state            Side effects
──────────────────────────────────────────────────────────────────────────────────────────
driftBit=1 + turning + speed≥min   not charging        charging=true        chargeStartTick=now
                                                         sparkLevel=0

driftBit=1 + tick elapses          charging             sparkLevel advances  encoded in snapshot delta
                                                          per threshold check

driftBit=0 released                charging, sparks≥1   charging=false       SET activeBoosts['drift-boost']
  (justReleased=true)                                    sparkLevel=0         currentDriftBoostSparks=sparks
                                                                              broadcast event.drift_boost

driftBit=0 released early          charging, sparks=0   charging=false       no boost, silent
  (justReleased=true)                                    sparkLevel=0

speed < DRIFT_MIN_SPEED            charging (any)        charging=false       no boost (cancelled)
  (ink-slick or zero-thrust)                             sparkLevel=0

body finished/forfeited            any                   (tick-loop guard skips body before drift code runs)
```

**C6 fix:** The `resolveProximity` function only adjusts body POSITION, never velocity. Drift cancellation from collision is NOT in Phase 1. The only legitimate speed-reducer is `rr-ink-slick` (which halves effective thrust) — that CAN drop speed below the threshold and cancel drift. Collisions never can. The claim "collision cancels drift" from v1 is removed entirely.

### 2.3 Exact call order inside `applyIntentForTick` (C1 fix location)

```
applyIntentForTick(state, body, dt, now):
  1. consume seq  (existing)
  2. powerup actionBits 0b01 / 0b10  (existing)
  3. expire activeEffects entries by now  (existing)
     [NEW] expire activeBoosts entries by now (sweep and clear currentDriftBoostSparks)
  4. compute speedMod from activeEffects + activeBoosts  (modified — see §3.4)
  5. compute effectiveThrust  (new — handles launch-stall cap)
  6. [MODIFIED] update body.rot:
       if body.drift.charging:
         turnSign = (intent.dir.x > 0) ? -1 : 1
         body.rot = atan2(intent.dir.x, intent.dir.y) + turnSign * DRIFT_ANGULAR_BIAS_RAD
       else:
         body.rot = atan2(intent.dir.x, intent.dir.y)
  7. [NEW] tickDriftState(state, body, now)  ← runs AFTER step 6
  8. compute targetVx/Vy from intent.dir * effectiveThrust * speedMod  (existing, modified)
  9. integrate acceleration toward target  (existing)
  integrateMotion(state, body, dt, REEF_KINEMATIC_TOLERANCE)  ← named constant
  [NEW] boost-gated hard cap (§3.4)
```

**Why step 6 before step 7:** `tickDriftState` reads `body.drift.charging` and may transition it from `true → false` on the release tick. Step 6 uses `body.drift.charging` from the PREVIOUS tick state (before this tick's state-machine update). On the release tick, step 6 still applies the bias (one final tick of lean), then step 7 sets `charging = false`. Next tick, step 6 returns to unbiased `atan2`. This gives one tick of "lingering lean" that avoids an abrupt snap-back. Imperceptible in feel, avoids visual artifact.

### 2.4 `tickDriftState` pseudocode

```typescript
function tickDriftState(state: ReefRoomState, body: ReefBody, now: number): void {
  const driftBit   = !!(body.intent.actionBits & ACTION_BIT_DRIFT);
  const speed      = Math.hypot(body.vx, body.vy);
  const turning    = Math.abs(body.intent.dir?.x ?? 0) >= DRIFT_MIN_STEER;
  const fastEnough = speed >= DRIFT_MIN_SPEED_FOR_CHARGE;

  const justPressed  = driftBit && !body.drift.lastDriftBit;
  const justReleased = !driftBit && body.drift.lastDriftBit;

  if (body.drift.charging) {
    const shouldCancel = !driftBit || !fastEnough;

    if (shouldCancel) {
      if (justReleased && body.drift.sparkLevel >= 1) {
        // Fire drift boost — NO velocity impulse (S4 fix)
        const sparks = body.drift.sparkLevel;
        const mult   = DRIFT_BOOST_MULTS[sparks - 1];
        body.activeBoosts.set('drift-boost', {
          expiresAt: now + DRIFT_BOOST_DURATION_MS,
          mult,
        });
        body.currentDriftBoostSparks = sparks;
        state.broadcastFn(state.roomId, {
          type: 'event.drift_boost',
          petId: body.petId,
          sparks: sparks as 1 | 2 | 3,
        });
      }
      // Cancel drift state
      body.drift.charging        = false;
      body.drift.sparkLevel      = 0;
      body.drift.chargeStartTick = 0;
    } else {
      // Still charging — advance spark level
      const elapsed = state.tick - body.drift.chargeStartTick;
      body.drift.sparkLevel =
        elapsed >= DRIFT_SPARK_TICK_3 ? 3 :
        elapsed >= DRIFT_SPARK_TICK_2 ? 2 :
        elapsed >= DRIFT_SPARK_TICK_1 ? 1 : 0;
    }
  } else {
    if (justPressed && turning && fastEnough) {
      body.drift.charging        = true;
      body.drift.sparkLevel      = 0;
      body.drift.chargeStartTick = state.tick;
    }
  }

  body.drift.lastDriftBit = driftBit;
}
```

**activeBoosts expiry sweep (step 3 in call order):**
```typescript
for (const [kind, entry] of body.activeBoosts) {
  if (entry.expiresAt <= now) {
    body.activeBoosts.delete(kind);
    if (kind === 'drift-boost') body.currentDriftBoostSparks = 0;
  }
}
```

### 2.5 No double-fire protection

`justReleased` is `true` for exactly one tick (the tick `lastDriftBit` transitions `true → false`). After that tick, `lastDriftBit = false` so `justReleased = false`. Structurally impossible to double-fire.

---

## 3. Launch boost window

### 3.1 Problem statement (C4 fix — complete 4-file path)

The COUNTDOWN→LIVE transition is owned by `activity-room-manager.ts`. At the moment `room.startedAt = now` in `transitionRoom` `case 'live'`, the countdown has elapsed. Inputs sent during COUNTDOWN reach `handleInput` → `reefRaceSim.applyInput`, but the sim has no room yet — returns `{ok:false}`. The 4-file path below captures pre-launch thrust in the room manager, computes verdicts at the LIVE transition, and passes them to `startRoom`.

### 3.2 File 1: `apps/api/src/services/activity/types.ts`

Add to `Room` interface:
```typescript
/**
 * Pre-launch input buffer for Reef Race launch detection.
 * Maps petId → last thrust=1.0 input received during COUNTDOWN.
 * Populated by recordPreLaunchInput(); cleared by computeLaunchVerdicts().
 * null = never allocated (no launch inputs received or not a reef-race room).
 */
preLaunchBuffer: Map<string, { timestamp: number; thrust: number }> | null;
```

Initialise to `null` in the `createRoom` / pending-state constructor.

### 3.3 File 2: `apps/api/src/services/activity/activity-room-manager.ts`

Add two methods to `ActivityRoomManager`:

```typescript
/**
 * Called by the WS hub when a client sends thrust >= 1.0 during COUNTDOWN.
 * Stores only the LAST qualifying input per player — timing of the final
 * full-throttle press is what matters.
 */
recordPreLaunchInput(
  roomId: string,
  petId: string,
  timestamp: number,
  thrust: number,
): void {
  const room = this.rooms.get(roomId);
  if (!room || room.state !== 'countdown') return;
  if (thrust < 1.0) return;
  if (!room.preLaunchBuffer) room.preLaunchBuffer = new Map();
  room.preLaunchBuffer.set(petId, { timestamp, thrust });
}

/**
 * Called inside persistLiveTransition() BEFORE invoking liveTransitionFn.
 * room.startedAt is already set by the time this is called.
 * Returns a verdict map. Clears preLaunchBuffer.
 */
computeLaunchVerdicts(room: Room): Map<string, 'boost' | 'stall'> {
  const verdicts = new Map<string, 'boost' | 'stall'>();
  if (!room.preLaunchBuffer || !room.startedAt) return verdicts;

  for (const [petId, entry] of room.preLaunchBuffer) {
    const offset = entry.timestamp - room.startedAt;
    if (Math.abs(offset) <= LAUNCH_WINDOW_MS) {
      verdicts.set(petId, 'boost');
    } else if (
      offset < -LAUNCH_WINDOW_MS &&
      offset >= -(LAUNCH_WINDOW_MS + LAUNCH_STALL_WINDOW_MS)
    ) {
      verdicts.set(petId, 'stall');
    }
    // else: outside both windows → no verdict (normal start)
  }
  room.preLaunchBuffer = null;
  return verdicts;
}
```

**Imports needed:** `LAUNCH_WINDOW_MS`, `LAUNCH_STALL_WINDOW_MS` from `reef-race-config.ts`.

**S6 fix — abort cleanup:** Add `room.preLaunchBuffer = null;` to BOTH `persistAbortedTransition` and `persistAbortedCrashTransition`:
```typescript
room.preLaunchBuffer = null; // discard any collected pre-launch data
```

`computeLaunchVerdicts` must be called inside `persistLiveTransition` AFTER `room.startedAt = now` is set and BEFORE `liveTransitionFn(room)` is invoked — so that `liveTransitionFn` receives the verdicts via closure or parameter. The cleanest approach: call it inside `liveTransitionFn`'s dispatcher in `index.ts` immediately before `startRoom`.

### 3.4 File 3: `apps/api/src/services/activity/activity-ws-hub.ts`

In `handleInput`, add a COUNTDOWN-phase capture branch for reef-race **before** the existing `applyInput` dispatch:

```typescript
private handleInput(ws: HubWs, frame: Extract<ClientFrame, { type: 'input' }>): void {
  // ... existing rate-limit check ...
  const room = activityRoomManager.getRoom(ws.data.roomId);
  if (!room) return;

  // NEW: capture pre-launch thrust during COUNTDOWN for reef-race launch detection.
  // Falls through to applyInput below (which returns {ok:false} for unknown rooms — safe).
  if (
    room.activityId === 'reef-race' &&
    room.state === 'countdown' &&
    frame.thrust >= 1.0
  ) {
    activityRoomManager.recordPreLaunchInput(
      ws.data.roomId,
      ws.data.identity!.petId,
      Date.now(),
      frame.thrust,
    );
  }

  // ... existing bumper-shells / reef-race applyInput dispatch unchanged ...
}
```

### 3.5 File 4: `apps/api/src/index.ts`

Update `setLiveTransitionFn` reef-race case:

```typescript
case 'reef-race': {
  // Compute verdicts BEFORE starting the sim so bodies can be initialized
  // with the correct active boost. Uses room.startedAt (already set by
  // persistLiveTransition before liveTransitionFn is called — S10 fix).
  const launchBoosts = activityRoomManager.computeLaunchVerdicts(room);
  reefRaceSim.startRoom(
    room.id,
    room.activityId,
    participantIds,
    {
      bots,
      startedAt: room.startedAt!,  // S10: sim uses room manager's timestamp
      launchBoosts,
    },
  );
  break;
}
```

### 3.6 `startRoom` signature change (S10 fix)

```typescript
startRoom(
  roomId: string,
  activityId: string,
  participantPetIds: string[],
  opts?: {
    seed?: number;
    isBot?: (petId: string) => boolean;
    bots?: BotController[];
    startedAt?: number;                            // NEW: override Date.now()
    launchBoosts?: Map<string, 'boost' | 'stall'>; // NEW: per-player launch verdict
  },
): ReefRoomState
```

Inside `startRoom`, replace `const startedAt = Date.now()` with:
```typescript
const startedAt = opts?.startedAt ?? Date.now();
```

In the body init loop, apply verdicts:
```typescript
for (const petId of participantPetIds) {
  const body: ReefBody = {
    // ... existing fields ...
    drift: { charging: false, sparkLevel: 0, chargeStartTick: 0, lastDriftBit: false },
    currentDriftBoostSparks: 0,
    activeBoosts: new Map(),
  };

  const verdict = opts?.launchBoosts?.get(petId) ?? null;
  if (verdict === 'boost') {
    body.activeBoosts.set('launch-boost', {
      expiresAt: startedAt + LAUNCH_BOOST_DURATION_MS,
      mult: LAUNCH_BOOST_MULT,
    });
  } else if (verdict === 'stall') {
    body.activeBoosts.set('launch-stall', {
      expiresAt: startedAt + LAUNCH_STALL_DURATION_MS,
      // no mult — stall uses thrust cap, not speedMod
    });
  }

  state.bodies.set(petId, body);
}

// Broadcast launch events after all bodies are initialised:
if (opts?.launchBoosts) {
  for (const [petId, kind] of opts.launchBoosts) {
    broadcastFn(roomId, { type: 'event.launch', petId, kind });
  }
}
```

### 3.7 Speed modifier and hard cap (C2, S4, S5 fixes)

```typescript
// Step 4 of applyIntentForTick — speedMod and effectiveThrust

// activeEffects flags (pickup-only, unchanged):
const slicked      = body.activeEffects.has('rr-ink-slick');
const powerBoosted = body.activeEffects.has('rr-turbo-bubble');

// activeBoosts flags (kinematic, new):
const launchBoosted = body.activeBoosts.has('launch-boost');
const driftBoosted  = body.activeBoosts.has('drift-boost');
const stalled       = body.activeBoosts.has('launch-stall');

// effectiveThrust (step 5):
const effectiveThrust = stalled
  ? Math.min(intent.thrust, LAUNCH_STALL_THRUST_CAP)
  : intent.thrust;

// speedMod — stall suppresses all boost; otherwise additive kinematic mult
// vs pickup mult, taking MAX to avoid double-counting (S4 fix):
let speedMod: number;
if (stalled) {
  speedMod = 0.5;
} else {
  // Additive kinematic contribution from launch + drift:
  const kineticMult =
    (launchBoosted ? LAUNCH_BOOST_MULT : 0) +
    (driftBoosted ? (DRIFT_BOOST_MULTS[body.currentDriftBoostSparks - 1] ?? 0) : 0);
  // Pickup contribution (rr-turbo-bubble expressed as additive delta):
  const pickupMult = powerBoosted ? (REEF_BOOST_MULT - 1.0) : 0; // = 0.4
  // Take MAX so simultaneous turbo-bubble + drift-3 doesn't stack multiplicatively:
  const bestMult = Math.max(kineticMult, pickupMult);
  speedMod = slicked ? 0.5 : (1.0 + bestMult);
}
```

**Hard velocity cap — boost-gated only (S5 fix):**
```typescript
// AFTER integrateMotion, inside tick loop:
const isBoostActive =
  body.activeBoosts.has('launch-boost') || body.activeBoosts.has('drift-boost');
if (isBoostActive) {
  const s = Math.hypot(body.vx, body.vy);
  const hardCap = REEF_MAX_SPEED * 1.85; // 925 wu/s backstop; max legit = 840 wu/s
  if (s > hardCap) {
    body.vx = (body.vx / s) * hardCap;
    body.vy = (body.vy / s) * hardCap;
  }
}
```

The cap is `1.85×` — 85 wu/s above the maximum achievable combined boost. Its purpose is purely defensive against future stacking bugs. Normal gameplay never triggers it.

---

## 4. Reef Glider prop (3da owned)

### 4.1 Geometry in local pre-scale units (C7 fix)

**All dimensions below are in KART_SCALE-LOCAL space (before the `scale={[20,20,20]}` is applied by the group). To convert to world units, multiply by KART_SCALE = 20.**

| Mesh | Local (W × H × L) | World (wu) | Clearance at 300wu track |
|---|---|---|---|
| Glider board | 2.5 × 0.25 × 5 | 50 × 5 × 100 wu | 125 wu each side — two gliders pass comfortably |

```typescript
// In ReefRacePlayer.tsx:
const gliderGeom = new THREE.BoxGeometry(2.5, 0.25, 5); // local units → 50wu×5wu×100wu world
```

### 4.2 Scene node structure change

Current:
```
groupRef  (position+rotation, scale=[KART_SCALE,KART_SCALE,KART_SCALE])
  └── meshRootRef  (y=KART_Y_ABOVE_TRACK, bank tilt applied here)
        └── avatarMesh  (GLB clone)
```

After Phase 1:
```
groupRef  (position from server, scale=[KART_SCALE,KART_SCALE,KART_SCALE])
  └── gliderRef  (y=KART_Y_ABOVE_TRACK/KART_SCALE in local space, bank tilt here)
        ├── gliderMesh  (BoxGeometry 2.5×0.25×5 local)
        └── riderMountRef  (offset per RIDER_MOUNT_OFFSET_DEFAULT)
              └── avatarMesh  (GLB clone, rotation.z = 0 always)
```

Key invariants:
- `groupRef` position and `rotation.y` are unchanged (existing lerpAngle path)
- `gliderRef.rotation.z` carries the bank tilt (moves from `meshRootRef`)
- `riderMountRef.rotation.z = 0` always — rider stays level as board leans
- `KART_Y_ABOVE_TRACK = 5` (world) → in local space = `5 / KART_SCALE = 0.25`

### 4.3 Rider offset (C8 fix — single default, species deferred)

**Phase 1 uses ONE default offset for all species.** No species-conditional branches. The `entity.species` field is never populated from the server (C8: not in `WorldState.entities`, not written by `applyEntityDelta`, not by `hydrateFromWorld`). Species-specific offsets deferred to Phase 1.5.

```typescript
// In apps/web/.../reef-race-config.ts (client)
/**
 * Rider mount offset in KART_SCALE-local space.
 * World position = this × KART_SCALE = [0, 12wu, -10wu].
 * Single default for Phase 1 (species-specific offsets deferred to Phase 1.5).
 */
export const RIDER_MOUNT_OFFSET_DEFAULT: [number, number, number] = [0, 0.6, -0.5];
```

### 4.4 Procedural animation

Keep existing `applySwimmingAnim` on the avatar mesh. Add a gentle bob (±2 local units at 1.2Hz) on `riderMountRef.position.y`. No tail/fin bone removal — defer to Phase 2 art pass. No per-frame allocations. `riderMountRef` stored in a module-scope Map keyed by `entity.petId`.

---

## 5. HUD drift sparks

### 5.1 Store field and write path (S2 fix)

**New field on `ActivityState`:** `driftSparks: 0 | 1 | 2 | 3` (default 0). Added to `emptyState()`.

`applyEntityDelta` is NOT modified to write `driftSparks` (it has no access to `selfPetId`). Instead, the caller (snapshot.delta handler) reads `driftSparks` from the delta for the self pet:

```typescript
// In applyServerFrame → snapshot.delta branch:
let newDriftSparks = state.driftSparks; // preserve across non-self entities
for (const d of frame.entities) {
  applyEntityDelta(entities, d);
  if (d.petId === state.selfPetId && typeof d.changed.driftSparks === 'number') {
    newDriftSparks = d.changed.driftSparks as 0 | 1 | 2 | 3;
  }
}
set({ entities, driftSparks: newDriftSparks });
```

**First-sighting initialisation (S11 fix):** In `applyEntityDelta`'s first-insert branch, add:
```typescript
driftSparks: typeof c.driftSparks === 'number' ? (c.driftSparks as 0|1|2|3) : 0,
```

**`BumperShellEntity` interface:** Add `driftSparks?: 0 | 1 | 2 | 3` (optional — bumper entities don't set it).

**Re-render gate:** `DriftSparksBar` subscribes to `useActivityStore(s => s.driftSparks)`. Primitive number → Object.is equality check prevents spurious re-renders.

### 5.2 DOM structure

```tsx
// Bottom-center, above PowerUpBar (bottom: 80px)
<div style={{
  position: 'absolute', bottom: 80, left: '50%',
  transform: 'translateX(-50%)',
  display: 'flex', gap: 8, alignItems: 'center',
}}>
  <div style={{ fontSize: 9, letterSpacing: '0.15em', color: '#ffffff66', marginRight: 4 }}>
    DRIFT
  </div>
  {[0, 1, 2].map(i => (
    <div key={i} style={{
      width: 14, height: 14, borderRadius: '50%',
      border: `2px solid ${i < sparks ? SPARK_BORDER[i] : '#ffffff33'}`,
      background: i < sparks ? SPARK_FILL[i] : 'transparent',
      boxShadow: i < sparks ? `0 0 6px ${SPARK_FILL[i]}` : 'none',
      transition: 'background 0.1s, box-shadow 0.1s',
    }} />
  ))}
</div>
```

```typescript
const SPARK_FILL   = ['#ff9800', '#f44336', '#2979ff'] as const; // orange, red, blue
const SPARK_BORDER = ['#ff9800', '#f44336', '#2979ff'] as const;
```

Only renders when `matchPhase === 'live'`.

### 5.3 Launch glow ring (S9 fix — local countdown computation)

The HUD computes `secondsRemaining` locally from `room.countdownStartedAt` rather than relying on `event.countdown` (which is only sent once at countdown entry, not per-second — audit S9).

```tsx
const { room } = useActivityStore(s => ({ room: s.room }));
const [secondsRemaining, setSecondsRemaining] = useState(5);

useEffect(() => {
  if (!room?.countdownStartedAt) return;
  const tick = () => {
    const elapsed = (Date.now() - room.countdownStartedAt!) / 1000;
    setSecondsRemaining(Math.max(0, Math.ceil(5 - elapsed)));
  };
  tick();
  const id = setInterval(tick, 200); // 5Hz is plenty for a 1s countdown
  return () => clearInterval(id);
}, [room?.countdownStartedAt]);

// Render glow ring at secondsRemaining === 1:
{secondsRemaining === 1 && matchPhase === 'pregame-countdown' && (
  <div style={{
    position: 'absolute', inset: -12, borderRadius: '50%',
    border: '3px solid #00e676',
    animation: 'reefLaunchPulse 0.4s ease-in-out infinite',
    pointerEvents: 'none',
  }} />
)}
```

`countdownStartedAt` must be in `RoomMeta` (included in `snapshot.init`). If not already in `RoomMeta`, add it to `protocol.ts` and `reef-race-sim.ts`'s `buildRoomMeta` call.

---

## 6. WS protocol additions

### 6.1 `ServerFrame` union (`packages/shared/src/activities/protocol.ts`)

```typescript
| {
    type: 'event.drift_boost';
    petId: string;
    sparks: 1 | 2 | 3;
  }
| {
    type: 'event.launch';
    petId: string;
    kind: 'boost' | 'stall';
  }
```

**Backwards compat:** Old clients hit `default: never` branch → `void _exhaustive` at runtime → no crash. Old client receives `driftSparks` in `EntityDelta.changed` → hits `[k: string]: unknown` catch-all → silently ignored.

### 6.2 `driftSparks` in snapshot (`reef-race-sim.ts`)

**In `buildSnapshot`:**
```typescript
bodies: Array.from(state.bodies.values()).map(b => ({
  ...existingFields,
  driftSparks: b.drift.sparkLevel,
}))
```

**Snapshot diff predicate (S1+S7 fix):**
```typescript
// In broadcastDelta's per-body changed-fields check:
|| prev.driftSparks !== b.drift.sparkLevel

// In the changed object when the body IS included:
driftSparks: b.drift.sparkLevel,
```

### 6.3 `applyServerFrame` switch additions (`apps/web/src/stores/activity.ts`)

```typescript
case 'event.drift_boost': {
  // Phase 1: HUD drives off driftSparks (already 0 post-release via delta).
  // Future: events.driftBoosts ring buffer for scene VFX.
  break;
}
case 'event.launch': {
  // Phase 1: glow ring is countdown-driven (local computation, not event-driven).
  // Future: per-player launch indicator in 3D scene.
  break;
}
```

Both cases MUST be added before the `default: never` sentinel. TypeScript build error is the guard — intentional.

---

## 7. Bot drift and launch behavior

### 7.1 Bot class state fields

```typescript
class ReefRaceBot implements BotController {
  readonly activityId = 'reef-race';
  // Drift state
  private driftActive = false;
  private driftStartedMs = 0;
  private driftTargetTicks: number = DRIFT_SPARK_TICK_1;
  // Launch state
  private launchAttempted = false;
  private launchFireMs = -1; // -1 = sentinel; set on first computeInput call

  constructor(public readonly petId: string) {}
}
```

### 7.2 `computeInput` — launch attempt (C5 fix)

The C5 bug: the final `return { thrust: inGrace ? 0.4 : thrust }` overwrites any thrust set in earlier branches. The launch attempt MUST be an early return placed BEFORE the grace branch check.

```typescript
computeInput(roomState: BotRoomView, _dt: number): BotInput {
  const view = roomState as ReefBotRoomView;
  const self = view.bodies.find(b => b.petId === this.petId);
  if (!self) return { dir: { x: 0, y: 1 }, thrust: 0, actionBits: 0 };

  const matchAge = view.now - view.matchStartedAt;

  // ── LAUNCH ATTEMPT — EARLY RETURN, before grace branch ───────────────────
  // Initialise fire-time on first call (after matchStartedAt is known).
  if (this.launchFireMs < 0) {
    // Jitter ±400ms relative to matchStartedAt:
    //   [-150, +150]ms → boost window (~37.5% of range)
    //   [-350, -150]ms → stall zone (~25% of range)
    //   remainder      → no verdict (~37.5%)
    // Expected boost rate ≈ 37.5%, stall rate ≈ 25%
    const jitter = (Math.random() * 800) - 400;
    this.launchFireMs = view.matchStartedAt + jitter;
  }
  if (!this.launchAttempted && view.now >= this.launchFireMs) {
    this.launchAttempted = true;
    // Aim toward next checkpoint for direction (irrelevant for launch detection).
    const target = view.checkpoints?.[self.nextCheckpoint ?? 0];
    const dx = target ? (target.center.x - self.x) : 0;
    const dy = target ? (target.center.y - self.y) : 1;
    const len = Math.hypot(dx, dy) || 1;
    // EARLY RETURN — bypasses ALL subsequent logic including grace thrust cap.
    // room manager captures this in preLaunchBuffer via hub's COUNTDOWN branch.
    return {
      dir: { x: dx / len, y: dy / len },
      thrust: 1.0,
      actionBits: ACTION_BIT_LAUNCH,
    };
  }

  // ── DRIFT STATE ───────────────────────────────────────────────────────────
  if (this.driftActive) {
    const chargedTicks = Math.round((view.now - this.driftStartedMs) / REEF_TICK_MS);
    if (chargedTicks >= this.driftTargetTicks) {
      this.driftActive = false; // release — sim fires drift boost on next tick
    }
  }

  // ── NORMAL NAV (existing logic unchanged) ─────────────────────────────────
  // ... existing checkpoint steering + thrust calculation ...
  // (dot, distToTarget, thrust, dx, dy computed as before)

  // ── GRACE ─────────────────────────────────────────────────────────────────
  const inGrace = matchAge < BOT_OPENING_GRACE_MS;

  let actionBits = 0;
  if (!inGrace) {
    // Drift decision
    if (!this.driftActive && dot < 0.5 && distToTarget > 200) {
      if (Math.random() < 0.60 / REEF_SIM_HZ) {
        this.driftActive    = true;
        this.driftStartedMs = view.now;
        const r = Math.random();
        this.driftTargetTicks =
          r < 0.50 ? DRIFT_SPARK_TICK_1 :
          r < 0.85 ? DRIFT_SPARK_TICK_2 :
                     DRIFT_SPARK_TICK_3;
      }
    }
    if (this.driftActive) actionBits |= ACTION_BIT_DRIFT;

    // Power-up usage (existing)
    const inv = self.inventory;
    for (let i = 0; i < inv.length; i++) {
      const slot = inv[i];
      if (slot.kind === null || slot.cooldownUntil > view.now) continue;
      if (Math.random() < POWERUP_USE_CHANCE) { actionBits |= 1 << i; break; }
    }
  }

  return {
    dir: { x: dx / len, y: dy / len },
    thrust: inGrace ? 0.4 : thrust,
    actionBits,
  };
}
```

**Bot non-determinism (S8 — documented explicitly):** Bot heuristics (`Math.random()` for jitter, drift timing, power-up firing) are intentionally non-deterministic. This is a pre-existing decision (`Math.random()` already used in the existing bot for jitter and power-up firing). The LCG seed governs sim physics (pickup spawns, pickup rolls) only. Replays reproduce physical body trajectories but not bot decisions. This is acceptable — bot behavior is a policy choice, not a physics simulation.

---

## 8. Test plan

All new tests in `apps/api/src/services/activity/sim/__tests__/reef-race-sim.test.ts` and `apps/api/src/services/activity/bots/__tests__/reef-race-bot.test.ts`.

**Preserve existing tests:** Existing fixtures (`now: 5000, matchStartedAt: 0`) put `matchAge = 5000ms` — well past grace. No changes.

### 8.1 Sim tests

**T1** — Starts charging when drift-bit + turning + speed threshold met.
- `body.vx = 200` (above 150), `actionBits = ACTION_BIT_DRIFT`, `dir.x = 0.5`. Tick once.
- Assert: `body.drift.charging === true`.

**T2** — Does NOT start when going straight.
- Same as T1 but `dir.x = 0`. Assert: `body.drift.charging === false`.

**T3** — Advances spark levels at correct tick counts.
- Charge for `DRIFT_SPARK_TICK_1 - 1` ticks → sparkLevel 0. One more tick → sparkLevel 1.
- At tick `DRIFT_SPARK_TICK_2` → sparkLevel 2. At `DRIFT_SPARK_TICK_3` → sparkLevel 3.

**T4** — Cancels silently on early release (spark 0).
- Charge for `DRIFT_SPARK_TICK_1 - 2` ticks, release drift-bit. Tick once.
- Assert: `drift.charging === false`, zero `event.drift_boost` broadcasts.

**T5** — Fires boost on release at spark ≥ 1.
- Charge to spark 1, release. Tick once.
- Assert: `event.drift_boost` broadcast with `sparks: 1`, `body.activeBoosts.has('drift-boost') === true`.

**T6** — NO velocity impulse at release (S4 fix).
- Body at 300 wu/s, charge to spark 3, release.
- Assert: `Math.hypot(body.vx, body.vy) ≈ 300 wu/s` on the release tick (NOT 300 × 1.38).
- Assert: `body.activeBoosts.get('drift-boost')?.mult === 0.38`.

**T7** — Boost raises speed via speedMod over subsequent ticks.
- After T6, tick 10 more times with full thrust. Assert: speed after boost ticks > 300 wu/s (boost raised the cap; body naturally accelerated toward it under full thrust).

**T8** — No double-fire.
- Charge to spark 2, release. Boost fires, `charging = false`. Hold released for 5 ticks. Assert: only 1 `event.drift_boost` total.

**T9** — Cancels when speed drops below threshold.
- Charge to spark 1. Set `body.vx = body.vy = 0`. Tick (drift-bit still held). Assert: `charging === false`, no boost.

**T10** — Body.rot shows 15° bias while drifting, no unbounded accumulation (C1 verification).
- Body heading +Y, `dir.x = 0.5` (turning right). Start charging. Tick once.
- Assert: `body.rot ≈ Math.atan2(0.5, 0.866) - DRIFT_ANGULAR_BIAS_RAD` (right turn → subtract bias).
- Tick again (same dir): Assert: same value (NOT accumulated further).
- Release drift, tick: Assert: `body.rot ≈ Math.atan2(0.5, 0.866)` (bias gone).

**T11** — Launch boost from `launchBoosts` map.
- `startRoom('r1', 'reef-race', ['p1','p2'], { launchBoosts: new Map([['p1','boost']]) })`.
- Assert: `p1.activeBoosts.has('launch-boost') === true`, `p2.activeBoosts.size === 0`.

**T12** — Launch stall, thrust capped.
- `launchBoosts: new Map([['p1','stall']])`. Set `intent.thrust = 1.0`, tick once.
- Assert: `activeBoosts.has('launch-stall') === true`. Speed < `REEF_MAX_SPEED * LAUNCH_STALL_THRUST_CAP * 1.1`.

**T13** — No effect when `launchBoosts` absent.
- `startRoom` with no `launchBoosts`. Assert: neither boost nor stall in `activeBoosts`.

**T14** — Named tolerance constant at both call-sites.
- Static: grep `reef-race-sim.ts` source. Assert: string `1.5` does NOT appear in the `integrateMotion` call-sites (only `REEF_KINEMATIC_TOLERANCE`).

**T15** — Drift-3 + launch combined stays under 2× REEF_MAX_SPEED.
- Set both `launch-boost` (mult 0.30) and `drift-boost` (sparks=3, mult 0.38) in `activeBoosts`. Tick 30 times at full thrust.
- Assert: `Math.hypot(body.vx, body.vy) <= REEF_MAX_SPEED * 2.0` every tick.

**T16** — rr-turbo-bubble + drift boost takes MAX, not sum.
- `activeEffects.set('rr-turbo-bubble', now + 9999)`, `activeBoosts.set('drift-boost', {expiresAt: now+9999, mult:0.24})`, `currentDriftBoostSparks = 2`.
- Compute speedMod. Assert: `speedMod === 1.40` (turbo-bubble mult 0.40 > drift mult 0.24 → MAX; NOT 1.64).

**T17** — Snapshot diff includes spark-only change.
- Body at stable position/velocity. Advance sparkLevel from 0 → 1 without moving.
- Assert: body appears in `broadcastDelta` output with `driftSparks: 1`.

**T18** — Snapshot diff omits spark-unchanged body.
- Body never drifts (sparkLevel always 0), only positional change across two consecutive snapshots.
- Assert: `driftSparks` field NOT included in delta's changed map (or if included, value is 0 and was already 0 in prev snapshot — verify it was included only because a positional field changed, not as a standalone unnecessary change).

**T19** — `stopRoom` mid-drift is safe.
- Body has `charging=true, sparkLevel=2`. Call `stopRoom`. Assert: zero `event.drift_boost` emitted after `stopRoom`. Room map deleted.

**T20** — Forfeit mid-drift: no post-forfeit broadcast.
- Trigger `integrityForfeitFn` on a drifting body. Assert: no boost broadcast after forfeit (body removed from loop).

**T21** — `computeLaunchVerdicts` table-driven correctness.

```typescript
const startedAt = 10_000;
const cases = [
  { offset:    0, thrust: 1.0, expected: 'boost'  }, // exactly on green
  { offset:  149, thrust: 1.0, expected: 'boost'  }, // inside window (late)
  { offset: -149, thrust: 1.0, expected: 'boost'  }, // inside window (early)
  { offset:  151, thrust: 1.0, expected: null      }, // outside window (too late)
  { offset: -151, thrust: 1.0, expected: 'stall'  }, // just inside stall zone
  { offset: -350, thrust: 1.0, expected: 'stall'  }, // at stall zone boundary
  { offset: -351, thrust: 1.0, expected: null      }, // beyond stall zone
  { offset:    0, thrust: 0.5, expected: null      }, // thrust < 1.0; not captured
];
```

### 8.2 Bot tests

**T22** — Launch bypasses grace thrust cap (C5 verification).
- Set `bot.launchFireMs` to `view.now - 1` (just fired). `matchAge < BOT_OPENING_GRACE_MS`. Call `computeInput`.
- Assert: returned `thrust === 1.0`, `actionBits & ACTION_BIT_LAUNCH !== 0`.

**T23** — No drift during grace.
- 100 ticks at `matchAge < 2500ms`. Assert: `actionBits & ACTION_BIT_DRIFT === 0` always.

**T24** — Uses drift in hairpins (statistical).
- 300 ticks at hairpin (`dot < 0.5`, `distToTarget > 200`) outside grace.
- Assert: at least 10% of ticks have drift bit set.

**T25** — No drift on straights.
- 300 ticks with `dot >= 0.5` outside grace. Assert: zero drift bits.

---

## 9. Risks and mitigations

### 9.1 Backwards compat — old clients

Old clients receive `driftSparks` in `EntityDelta.changed` → `[k: string]: unknown` catch-all → silently dropped. `event.drift_boost` and `event.launch` in `ServerFrame` → `default: const _exhaustive: never = frame; void _exhaustive` → no throw (the void evaluates the frame but doesn't crash). Verified pattern in `activity.ts` line 711-712.

### 9.2 Room teardown mid-drift

`stopRoom` → `this.rooms.delete(roomId)` immediately. `tickRoom` guard `if (state.ended) return` prevents further drift processing. Interval cleared before deletion. No boost broadcast possible after `stopRoom`. Safe — identical to existing teardown for all sim state.

### 9.3 Launch boost abort safety

`preLaunchBuffer` is on the `Room` object. Abort paths (`persistAbortedTransition`, `persistAbortedCrashTransition`) set `room.preLaunchBuffer = null`. `liveTransitionFn` is not called on abort — `computeLaunchVerdicts` is never called — `startRoom` is never called. No sim state affected.

### 9.4 Memory footprint

`ReefDriftState` (4 fields) + `activeBoosts: Map` (empty = ~96 bytes; max 2 entries = ~208 bytes) + `currentDriftBoostSparks` (8 bytes) = ~250 bytes per body. 8 bodies = 2 KB per room. Negligible.

### 9.5 Anti-cheat tolerance

`REEF_KINEMATIC_TOLERANCE = 2.0` allows any achievable boost (max 1.68× = 840 wu/s). Hard cap at 1.85× (925 wu/s) is a backstop. If a future power-up stacks past 1.85×, a console warning should be added to detect it:
```typescript
if (s > hardCap) {
  console.warn(`[reef-race] velocity hard-cap hit for ${body.petId}: ${s.toFixed(0)} wu/s`);
  // ... clamp ...
}
```

### 9.6 Build guard

Adding `event.drift_boost` and `event.launch` to `ServerFrame` will cause TypeScript to error on the `default: never` branch in `activity.ts`. This is intentional. Implementation step 2 must add both `case` branches before the error is resolved.

---

## 10. File-by-file change summary

| File | Owner | Changes |
|---|---|---|
| `packages/shared/src/activities/protocol.ts` | orchestrator | Add `event.drift_boost`, `event.launch` to `ServerFrame` union. Check `RoomMeta` for `countdownStartedAt` — add if absent. |
| `apps/api/src/services/activity/types.ts` | orchestrator | Add `preLaunchBuffer: Map<string,{timestamp:number;thrust:number}>\|null` to `Room` interface. Initialise to `null`. |
| `apps/api/src/services/activity/sim/reef-race-config.ts` | orchestrator | Add: `ReefBoostKind`, `REEF_TICK_MS`, `DRIFT_SPARK_TICK_1/2/3`, `DRIFT_SPARK_TIERS`, `DRIFT_BOOST_DURATION_MS`, `DRIFT_BOOST_MULTS`, `DRIFT_ANGULAR_BIAS_RAD`, `DRIFT_MIN_SPEED_FOR_CHARGE`, `DRIFT_MIN_STEER`, `LAUNCH_WINDOW_MS`, `LAUNCH_BOOST_MULT`, `LAUNCH_BOOST_DURATION_MS`, `LAUNCH_STALL_WINDOW_MS`, `LAUNCH_STALL_DURATION_MS`, `LAUNCH_STALL_THRUST_CAP`, `ACTION_BIT_DRIFT`, `ACTION_BIT_LAUNCH`, `REEF_KINEMATIC_TOLERANCE = 2.0`. |
| `apps/api/src/services/activity/sim/reef-race-sim.ts` | orchestrator | Add `ReefBoostKind` import, `ReefBoostEntry` interface, `ReefDriftState` interface; add `drift`, `currentDriftBoostSparks`, `activeBoosts` to `ReefBody`; add `tickDriftState()`; modify step 6 in `applyIntentForTick` for drift bias; add `activeBoosts` sweep in tick preamble; add `activeBoosts`-based `speedMod`/`effectiveThrust`; add boost-gated hard cap after `integrateMotion`; replace hard-coded `1.5` with `REEF_KINEMATIC_TOLERANCE` at both call-sites; add `driftSparks` to `buildSnapshot`; add `\|\| prev.driftSparks !== b.drift.sparkLevel` to diff predicate in `broadcastDelta`; add `driftSparks` to changed-object; add `startedAt?` and `launchBoosts?` to `startRoom` opts; apply verdicts in body init loop; broadcast `event.launch` events after body init. |
| `apps/api/src/services/activity/activity-room-manager.ts` | orchestrator | Add `recordPreLaunchInput(roomId, petId, ts, thrust)` method; add `computeLaunchVerdicts(room)` method; add `room.preLaunchBuffer = null` to BOTH `persistAbortedTransition` and `persistAbortedCrashTransition`; import `LAUNCH_WINDOW_MS`, `LAUNCH_STALL_WINDOW_MS` from `reef-race-config.ts`. |
| `apps/api/src/services/activity/activity-ws-hub.ts` | orchestrator | In `handleInput`: add COUNTDOWN pre-launch capture branch for reef-race before the existing `applyInput` dispatch. |
| `apps/api/src/index.ts` | orchestrator | In `setLiveTransitionFn` reef-race case: call `activityRoomManager.computeLaunchVerdicts(room)`, pass `{bots, startedAt: room.startedAt!, launchBoosts}` to `reefRaceSim.startRoom`. |
| `apps/api/src/services/activity/bots/reef-race-bot.ts` | orchestrator | Add instance fields `driftActive`, `driftStartedMs`, `driftTargetTicks`, `launchAttempted`, `launchFireMs`; add launch early-return BEFORE grace branch; add drift decision tree in non-grace path; import `DRIFT_SPARK_TICK_1/2/3`, `REEF_TICK_MS`, `ACTION_BIT_DRIFT`, `ACTION_BIT_LAUNCH`, `REEF_SIM_HZ`. |
| `apps/web/src/stores/activity.ts` | orchestrator | Add `driftSparks: 0\|1\|2\|3` to `ActivityState` interface + `emptyState()`; add `driftSparks?: 0\|1\|2\|3` to `BumperShellEntity`; add `driftSparks: 0` to first-insert branch of `applyEntityDelta` (S11); write `driftSparks` for self-pet in `snapshot.delta` handler (hoisted to caller — S2); add `case 'event.drift_boost': break;` and `case 'event.launch': break;` to `applyServerFrame` switch. |
| `apps/web/src/components/game/reef-race-hud.tsx` | orchestrator | Add `DriftSparksBar` component; add launch glow ring with local countdown computation from `room.countdownStartedAt`. |
| `apps/web/src/lib/three/activities/reef-race/reef-race-config.ts` | 3da | Add `RIDER_MOUNT_OFFSET_DEFAULT`, `ACTION_BIT_DRIFT`, `ACTION_BIT_LAUNCH`. |
| `apps/web/src/lib/three/activities/reef-race/ReefRacePlayer.tsx` | 3da | Add `gliderRef` group; add `BoxGeometry(2.5, 0.25, 5)` glider mesh (local units → 50wu×5wu×100wu world); add `riderMountRef` at `RIDER_MOUNT_OFFSET_DEFAULT`; move bank tilt from `meshRootRef` to `gliderRef`; set avatar `rotation.z = 0` always; DO NOT add species-conditional branches. |
| `apps/api/src/services/activity/sim/__tests__/reef-race-sim.test.ts` | orchestrator | Add Tests T1–T21. |
| `apps/api/src/services/activity/bots/__tests__/reef-race-bot.test.ts` | orchestrator | Add Tests T22–T25. |

---

## 11. Implementation order (dependency graph)

```
Step 1:  protocol.ts — ServerFrame union + RoomMeta.countdownStartedAt
          (type-only; no runtime effect; safe alone)
           ↓
Step 2:  activity.ts — add empty case 'event.drift_boost'/'event.launch' breaks
          + driftSparks to ActivityState/emptyState/BumperShellEntity/first-sighting
          (restores TypeScript build after Step 1)

Step 3:  types.ts — preLaunchBuffer on Room

Step 4:  reef-race-config.ts (SERVER)
          All new constants + ReefBoostKind. No runtime path change.

Step 5:  reef-race-sim.ts
          ReefBoostKind, ReefDriftState, ReefBoostEntry, activeBoosts,
          currentDriftBoostSparks, drift on ReefBody. tickDriftState. step 6 bias.
          activeBoosts sweep. speedMod overhaul. boost-gated hard cap.
          buildSnapshot + broadcastDelta driftSparks. startRoom launchBoosts/startedAt.
          REEF_KINEMATIC_TOLERANCE at both call-sites.
          ← Keep broadcast emissions behind `if (false)` until Step 12.

Step 6:  reef-race-sim.test.ts — Tests T1–T21.
          All tests MUST pass before Step 12.

Step 7:  activity-room-manager.ts
          recordPreLaunchInput, computeLaunchVerdicts, abort cleanup.

Step 8:  activity-ws-hub.ts
          COUNTDOWN pre-launch capture branch.

Step 9:  index.ts
          computeLaunchVerdicts + startedAt in liveTransitionFn.

Step 10: reef-race-bot.ts
          Instance fields, launch early-return, drift decision tree.

Step 11: reef-race-bot.test.ts — Tests T22–T25.

Step 12: Flip broadcast emissions ON
          (remove `if (false)` guard from Step 5)
          All server tests green before this step.

Step 13: reef-race-hud.tsx
          DriftSparksBar + launch glow ring.

Step 14: reef-race-config.ts (CLIENT)
          RIDER_MOUNT_OFFSET_DEFAULT, ACTION_BIT_DRIFT, ACTION_BIT_LAUNCH.

Step 15: ReefRacePlayer.tsx (3da owned)
          gliderRef + BoxGeometry(2.5,0.25,5) + riderMountRef
          bank tilt moved to gliderRef; no species branches.
```

Steps 1-12 are server-side (except Step 2 which is client store types). Steps 13-15 are client visual. Reverting Steps 13-15 never breaks the server contract. Reverting Steps 7-9 in reverse order safely removes the launch data path without touching drift.

---

## 12. Out of scope (Phase 1 enforcement)

- **Species-conditional rider animations** — deferred to Phase 1.5. Requires: `species` field in `WorldState.entities`, `EntityDelta.changed`, `hydrateFromWorld`, and `applyEntityDelta`. Non-trivial cross-package change.
- **Milady balance-sway branch** — deferred to Phase 1.5 with species.
- **`SPECIES_RIDER_OFFSET` map** — single `RIDER_MOUNT_OFFSET_DEFAULT` in Phase 1.
- **Final Reef Glider art asset** — Phase 2.
- Per-frame `new Vector3()` or other GC-producing allocations in `useFrame`.
- `import 'three/webgpu'` in any file (PRs #59+#60 ban).
- Slipstream, cornering apex bonus, boost ribbons, hazard patches (Phase 2).
- Stat-driven physics multipliers (Phase 3).
- Personal best ghost (Phase 4).
- `rr-whirlpool` / `rr-tide-wave` drift-interaction edge cases (Phase 2 documentation).
- Top-speed cap reduction (never — leave `REEF_MAX_SPEED = 500 wu/s`).
- Feature flag / kill switch — too many indirections; not in Phase 1.
