# Phase 1 Implementation Audit

**Implementation under review:** commits `73900ad` (§4 scene) + `26a19d3` (§1-3,5-8) on `worktree-fix-bumper-build`
**Plan v2 reference:** `.claude/plans/reef-race-phase1-detailed.md` (SHA `b68068a`)
**Original audit:** `.claude/plans/reef-race-phase1-audit.md` (SHA `9f16646`)
**Auditor:** Orchestrator (red team)
**Date:** 2026-04-25
**Outcome:** **PROCEED with caveats.** All 11 critical anchors PASS at the file level. Server-side drift mechanic + human-input launch-boost path are functional end-to-end. **One Significant defect:** bot-launch path is dead — bots will never actually receive a launch verdict (the bot's input flows through the sim's `runBotControllers` during LIVE, NOT through the WS hub during COUNTDOWN, so `recordPreLaunchInput` never fires for bots). T22 verifies the bot RETURNS `thrust=1.0` but no test verifies the bot's verdict actually applies. Drift mechanic is the headline feature and works correctly.

---

## Critical-anchor verification (11 checks)

| Anchor | Status | Citation |
|---|---|---|
| C1 — drift bias INSIDE the `Math.atan2` assignment in step 6 (no per-tick accumulation, no clobbering) | **PASS** | `apps/api/src/services/activity/sim/reef-race-sim.ts:814-822` — `body.rot = baseRot + turnSign * DRIFT_ANGULAR_BIAS_RAD` is on the same expression as the atan2; no `* (1/REEF_SIM_HZ)`; tickDriftState (line 827) runs AFTER step 6. |
| C2 — drift/launch write to `activeBoosts: Map<ReefBoostKind, …>`, never to `activeEffects` | **PASS** | `reef-race-sim.ts:178` defines `activeBoosts`. Line 877 (`drift-boost`), 385 + 391 (`launch-boost`/`launch-stall`) all write to `activeBoosts`. Grep `activeEffects.set` returns only the original power-up paths in `tryUsePowerUp` (line 1251). |
| C3 — `REEF_KINEMATIC_TOLERANCE = 2.0` exported from config and used at BOTH validator call-sites | **PASS** | `reef-race-config.ts:374` exports `REEF_KINEMATIC_TOLERANCE = 2.0`. `reef-race-sim.ts:1019` (vel) + `1032` (pos) both use it. T14 (sim test, `reef-race-sim.test.ts:633-642`) is a source-grep guard. |
| C4 — launch detection in room manager; `liveTransitionFn` calls `computeLaunchVerdicts`, passes verdicts into `startRoom`; sim seeds `body.activeBoosts` from this on first tick | **PASS** | `activity-room-manager.ts:584-607` `computeLaunchVerdicts`. `apps/api/src/index.ts:341-353` (live diff) calls it then passes `{startedAt, launchBoosts}` to `reefRaceSim.startRoom`. `reef-race-sim.ts:383-394` seeds `activeBoosts` per verdict in body init. |
| C5 — bot launch is an early return BEFORE the grace branch | **PASS** | `reef-race-bot.ts:107-123` — early return precedes the `inGrace` check at line 182 + the final return's `inGrace ? 0.4 : thrust` (line 220). T22 (`reef-race-bot.test.ts:150-197`) verifies `thrust === 1.0` is observed inside grace. |
| C6 — drift cancels ONLY on `speed < DRIFT_MIN_SPEED_FOR_CHARGE` or drift-bit released — NOT on collision | **PASS** | `reef-race-sim.ts:870` — `shouldCancel = !driftBit \|\| !fastEnough`. No collision-velocity coupling exists; `resolveProximity` (line 1060-1083) only mutates position. T9 (`reef-race-sim.test.ts:527-541`) verifies the speed cancel. |
| S4 — drift boost delivered ONLY via time-extended `activeBoosts` speedMod, NO velocity impulse at release | **PASS** | `reef-race-sim.ts:873-887` — release path sets `activeBoosts.set('drift-boost', {expiresAt, mult})` + `currentDriftBoostSparks = sparks`; NO `body.vx *= factor` or similar. T6 (`reef-race-sim.test.ts:454-479`) asserts speed unchanged within slack. |
| S5 — hard cap is inside `if (isBoostActive)` branch only — never clamps non-boosted bodies | **PASS** | `reef-race-sim.ts:1047-1057` — cap inside `if (isBoostActive)` guard checking `activeBoosts.has('launch-boost') \|\| has('drift-boost')`. T15 (`reef-race-sim.test.ts:644-664`) verifies combined drift-3 + launch stays under 2× MAX_SPEED. |
| S6 — `room.preLaunchBuffer = null` on aborted/aborted_crash transitions | **PASS** | `activity-room-manager.ts:910` — `room.preLaunchBuffer = null` is the FIRST statement inside `persistAbortedTransition`. Covers both `'aborted'` and `'aborted_crash'` (the function takes a `status` param and is called for both). |
| S10 — `startRoom` accepts `startedAt` parameter; `liveTransitionFn` passes `room.startedAt!` | **PASS** | `reef-race-sim.ts:306-307` opts include `startedAt?: number`. Line 323: `const startedAt = opts?.startedAt ?? Date.now()`. `apps/api/src/index.ts:349` passes `startedAt: room.startedAt ?? Date.now()`. (Plan said `room.startedAt!` non-null assertion; impl uses `?? Date.now()` — defensively safer, equivalent in the production call path.) |
| S11 — `applyEntityDelta` first-insert branch initializes `driftSparks: 0` | **PASS** | `apps/web/src/stores/activity.ts:291-296` — first-insert branch sets `driftSparks: typeof c.driftSparks === 'number' ? ((c.driftSparks as 0\|1\|2\|3) ?? 0) : 0`. The `?? 0` is dead code but harmless. |

---

## Behavioral path traces

### a) Drift charge — full speed press

1. Player WS sends `{actionBits: ACTION_BIT_DRIFT (0b100), dir: {x:0.5, y:1}, thrust: 0.85}`.
2. `activity-ws-hub.ts:390 handleInput` → `reefRaceSim.applyInput` → sets `body.intent = {…, actionBits:0b100}`.
3. Next tick: `tickRoom` (`reef-race-sim.ts:677`) → `applyIntentForTick` (line 692).
4. Step 4 inside applyIntentForTick (line 776-806): no boosts active → `speedMod = 1.0`. baseTopSpeed = 500.
5. Step 6 (line 814-822): drift.charging is FALSE on this tick → unbiased atan2. `body.rot = atan2(0.5, 1) ≈ 0.464 rad`.
6. Step 7 (line 827) → `tickDriftState` (line 857).
   - `driftBit = true`, `speed = 200` (from helper test boot), `turning = |0.5| ≥ 0.25 = true`, `fastEnough = 200 ≥ 150 = true`.
   - `justPressed = true && !false = true`. NOT charging → enter `else if (justPressed && turning && fastEnough)` → `body.drift.charging = true`, `sparkLevel = 0`, `chargeStartTick = state.tick`.
7. **At spark 1 (after 12 ticks):** speedMod still 1.0 (no boost active yet — only `drift.charging = true` plus `sparkLevel = 1`). Effective top speed: 500 wu/s. **At spark 2 (27 ticks):** still 500. **At spark 3 (45 ticks):** still 500. Boost is ONLY applied AFTER release.
8. T1, T3 verify these transitions. **PASS.**

### b) Drift release with charge

1. Player charges drift to spark 2 (sparkLevel=2, charging=true). Player WS sends `{actionBits: 0}` next frame.
2. Hub → applyInput sets `intent.actionBits = 0`.
3. Next tick: applyIntentForTick step 6 — `body.drift.charging` is STILL true (lingering lean — see plan §2.3). So bias still applies for ONE more tick (the release tick).
4. Step 7 → tickDriftState.
   - `driftBit = false`, `lastDriftBit = true` → `justReleased = true`.
   - `body.drift.charging = true` → enter the cancel-evaluation branch.
   - `shouldCancel = !driftBit \|\| !fastEnough = true`.
   - `justReleased && sparkLevel >= 1` → fire boost: `activeBoosts.set('drift-boost', {expiresAt: now + 1200ms, mult: 0.24})`. `currentDriftBoostSparks = 2`. Broadcast `event.drift_boost`.
   - State reset: `charging = false`, `sparkLevel = 0`.
5. NEXT tick: applyIntentForTick step 4 sees `driftBoosted = true`, `currentDriftBoostSparks = 2` → `driftMult = DRIFT_BOOST_MULTS[1] = 0.24` → `speedMod = 1.24` (ignoring pickup). Body's effective top speed = 500 × 1.24 = 620 wu/s.
6. Boost expires after ~1200ms (actually ~1233ms — see Significant issue I3 below).
7. T5 + T7 + T8 verify. **PASS.**

### c) Drift cancel via slow

1. Body charging at sparkLevel = 1, speed = 200.
2. External event reduces speed to 0 (e.g., `body.vx = body.vy = 0`). Player still holds drift bit.
3. Next tick → tickDriftState.
   - `driftBit = true`, `speed = 0`, `fastEnough = 0 ≥ 150 = false`.
   - charging = true → `shouldCancel = !true \|\| !false = true`.
   - `justReleased = false` (drift bit still held). Boost branch skipped.
   - State reset: `charging = false`, `sparkLevel = 0`. **No spark count carry-over.**
4. T9 verifies. **PASS.** Cancellation is silent — no event broadcast.

### d) Launch boost success (HUMAN player path)

1. Client `useActivityWs.ts` sends thrust frames; player taps `thrust=1.0` 50ms before COUNTDOWN→LIVE.
2. `activity-ws-hub.ts:407-419 handleInput` — sees `room.activityId === 'reef-race' && room.state === 'countdown' && frame.thrust >= 1.0` → `recordPreLaunchInput(roomId, petId, Date.now(), frame.thrust)`.
3. `activity-room-manager.ts:560-571 recordPreLaunchInput` — stores in `room.preLaunchBuffer.set(petId, {timestamp, thrust})`.
4. COUNTDOWN timer fires (`activity-room-manager.ts:385-398`) → `transitionRoom(roomId, 'live')` → case 'live' → `room.startedAt = now` (line 403) → `persistLiveTransition` (line 404).
5. `persistLiveTransition` (line 756-791) → DB update → invokes `liveTransitionFn(room)`.
6. `apps/api/src/index.ts:341-353` (reef-race case) → `launchBoosts = activityRoomManager.computeLaunchVerdicts(room)` — returns Map<petId, 'boost'\|'stall'>; clears preLaunchBuffer.
7. `reefRaceSim.startRoom(roomId, ..., {bots, startedAt: room.startedAt, launchBoosts})`.
8. `reef-race-sim.ts:383-394` body init seeds `activeBoosts.set('launch-boost', {expiresAt: startedAt+2000, mult:0.30})`.
9. First tick (~33ms after LIVE start): applyIntentForTick step 4 reads `launchBoosted = true` → speedMod = 1.30. Boost active for ~2000ms. **PASS.**

### e) Launch boost stall (player presses 200ms early)

1. Player thrust=1.0 at `room.startedAt - 200ms`.
2. `recordPreLaunchInput` stores `{timestamp = startedAt - 200, thrust: 1.0}`.
3. `computeLaunchVerdicts`: offset = -200. `Math.abs(-200) > 150` (not boost). `-200 < -150 && -200 >= -350` → `'stall'`.
4. `startRoom` body init: `activeBoosts.set('launch-stall', {expiresAt: startedAt+1000})` (no mult).
5. Tick 1: applyIntentForTick step 4: `stalled = true` → `effectiveThrust = min(intent.thrust, 0.30) = 0.30`. `speedMod = 0.5`. Combined cap on velocity = 500 × 0.30 × 0.5 = 75 wu/s.
6. Stall expires after ~1000ms (one tick lingering — see I3). T12 verifies thrust cap. **PASS.**

### f) Bot launch attempt — **DEFECT**

1. Bots are added in `state.botControllers` at startRoom (`reef-race-sim.ts:326-337`).
2. Bot inputs are produced inside `tickRoom` → `runBotControllers` (line 685, called only during LIVE, since the `setInterval` starts at startRoom which is post-LIVE).
3. Bot's `computeInput` (line 77 of bot file) runs the launch-attempt early return, sets `intent = {thrust:1.0, actionBits: ACTION_BIT_LAUNCH}`.
4. `runBotControllers` (line 943) calls `applyInput(roomId, petId, seq, dt, intent)` — populates `body.intent` for the next tick.
5. **No path** routes the bot's input through `recordPreLaunchInput`. The hub's COUNTDOWN-buffer branch is `handleInput`-only, and bots don't connect to the hub.
6. Even if the bot's intent reached `recordPreLaunchInput`, the room is now in `live` state, so `room.state !== 'countdown'` returns early (line 567).
7. **Result:** bot's launch verdict is NEVER computed; bot never gets boost/stall; bot test T22 verifies the bot RETURNS the right intent but not that it produces a verdict. **Significant defect — see issue I1.**

---

## Test execution

```
Reef Race sim + bot tests (against worktree HEAD 26a19d3):
  41 pass / 0 fail / 792 expect() calls / 143ms

Full activity test suite:
  114 pass / 7 fail / 4 errors / 1191 expect() calls / 365ms

Baseline (b68068a, before implementation):
  88 pass / 7 fail / 4 errors

Net change: +26 passing tests, ZERO new failures. Pre-existing failures:
  - 4 errors (`activityRoomParticipants` / `users` not exported from
    @clawville/database) — local DB package not built, infra issue
  - 3 bumper-shells-bot test failures (pre-existing per impl report,
    confirmed via git checkout b68068a baseline run)
```

T22 passes; bot launch test verifies the early-return path returns `thrust=1.0` inside grace. Test is mechanically correct but does not exercise the full sim → room manager → verdict path (which is impossible for bots — see I1).

---

## Type system

```
apps/api:    bun --bun tsc --noEmit  → EXIT 0 (zero errors)
apps/web:    bun --bun tsc --noEmit  → EXIT 0 (zero errors)
```

No new type errors introduced.

---

## Snapshot delta correctness

Verified end-to-end:

1. `reef-race-sim.ts:1487-1490` — diff predicate includes `p.driftSparks !== b.driftSparks`. ✓
2. `reef-race-sim.ts:1510` — `changed.driftSparks: b.driftSparks` always serialized in delta payload (always-included → wastes wire bytes for non-drifting bodies, see I5). ✓
3. `apps/web/src/stores/activity.ts:498-513` — snapshot.delta handler iterates entities, hoists `nextDriftSparks` for the SELF pet. ✓
4. `apps/web/src/stores/activity.ts:308-310` — second-update branch in `applyEntityDelta` writes `driftSparks` when present. ✓
5. `apps/web/src/components/game/reef-race-drift-sparks.tsx:23` — subscribes to primitive `s.driftSparks`. Object.is equality. ✓

**Gap (I4 below):** `snapshot.keyframe` handler (`activity.ts:578-600`) does NOT update `driftSparks`. A 1Hz keyframe arriving mid-drift cannot stale-out the HUD because deltas (5Hz) refresh more frequently, but the keyframe also doesn't *fix* a divergent driftSparks if delta is dropped due to backpressure. Minor.

---

## Backwards compat for existing data

`event.drift_boost` + `event.launch` added to `ServerFrame`. Old web clients hit `default: never` → assigning `frame` to `_exhaustive` is a `void` cast (`activity.ts:765-770`); does NOT throw at runtime, just type-fails at compile. ✓

Old clients receiving `EntityDelta.changed.driftSparks` — the wire-level type is `[k: string]: unknown`, so unknown fields are tolerated by `applyEntityDelta` (the explicit-field destructure simply ignores them). ✓

`RoomMeta.countdownStartedAt` is optional — old clients get `undefined`, the launch-glow ring effect bails because `if (!countdownStartedAt) return`. ✓

---

## Race conditions

a) **Drift+launch in same input frame** — `actionBits = ACTION_BIT_DRIFT \| ACTION_BIT_LAUNCH = 0b1100`. Drift bit fires `tickDriftState` (sets charging if conditions met). Launch bit is captured by `recordPreLaunchInput` ONLY if state==='countdown' and thrust>=1.0. In COUNTDOWN sim isn't ticking yet, so `tickDriftState` doesn't run anyway. In LIVE, only the drift logic fires; the launch bit is functionally dead post-LIVE (verdict was already computed). ✓

b) **Player presses launch during COUNTDOWN, disconnects, reconnects** — `recordPreLaunchInput` writes to `room.preLaunchBuffer` keyed by petId. Disconnect doesn't alter the room state. Reconnect re-binds the WS but `room.preLaunchBuffer` retained. At LIVE transition, the verdict is computed and applied. ✓

c) **Two players launch at same tick** — `state.bodies.set(petId, body)` happens twice with no shared state; both `activeBoosts` populate independently. `resolveProximity` (line 1060-1083) only does positional separation, no velocity coupling. Both boosts fire independently. ✓

---

## Existing test regressions

Baseline (`b68068a`):  88 pass / 7 fail / 4 errors
Worktree (`26a19d3`): 114 pass / 7 fail / 4 errors

Same 7 failures + 4 errors. The 3 bumper-shells-bot failures (`moves toward nearest alive opponent`, `uses an off-cooldown power-up at the configured probability`, `skips eliminated opponents when picking the nearest`) are **statistical-tolerance failures** in pre-existing tests. The 4 errors are `@clawville/database` resolution failures from the local DB package not being built — infra issue, unrelated to this change. **No new regressions.**

---

## Brand check (Mario-Kart-feel honesty)

Imagining a player joining a race, pressing drift in a hairpin, releasing on the apex:

- **Visible drift body lean (15° angular bias):** YES — `body.rot` mutates +15° while charging, ReefRacePlayer interpolates `interpRot` via `lerpAngle` so the bias arrives smoothly. The 15° is also visually distinct from the bank tilt (rotation.z) which is on the glider board. Player will see the kart's facing rotate slightly off the steering direction. ✓
- **Spark indicator filling (orange→red→blue at tier 1/2/3):** YES — `<ReefRaceDriftSparks>` renders 3 dots, lit per `driftSparks` from store, updated 5Hz via snapshot.delta. ✓ But it's visually small (14px dots, 80px above bottom edge). Visible but not "screaming Mario Kart sparks shooting from rear wheels." Acceptable for Phase 1.
- **Boost on release (1.2s of +12/+24/+38% top speed):** YES — `activeBoosts.set('drift-boost')` fires, speedMod climbs to 1.12/1.24/1.38, body accelerates toward new cap. Player feels velocity climb under continued thrust. ✓
- **Mario-Kart feel:** **Partial.** The drift IS the genre's foundational mechanic and IS delivered. But the absence of a visible boost VFX (sparks, ribbon, audio) means the player has to *feel* the speed change rather than *see/hear* the boost confirm. A first-time player may release from drift and not realize they got a boost. This is a Phase 2 art pass concern; Phase 1 ships the mechanic, not the polish. **Honest verdict: 6/10 first-touch genre satisfaction. Mechanically correct, visually muted.**

---

## Issues found

### Critical (must fix before deploy)

**None.**

All 11 critical-anchor checks PASS. No blocker bugs in the human-input drift or launch paths.

### Significant (should fix before deploy or in Phase 1.1)

**I1 — Bots will never receive launch verdicts.** The bot's `computeInput` returns `{thrust: 1.0, actionBits: ACTION_BIT_LAUNCH}`, but bots produce input only during LIVE (via `runBotControllers` inside `tickRoom`, which itself only runs because the interval was started by `startRoom` post-LIVE). The `recordPreLaunchInput` path is hub-only AND COUNTDOWN-only. No code path moves the bot's launch-intent into `room.preLaunchBuffer`. The bot's launch attempt is dead code. **Path forward:** either (a) deterministically synthesize bot launch verdicts during `liveTransitionFn` BEFORE calling `startRoom` (random with bot's planned jitter), or (b) explicitly document bot-launch as "humans-only" and remove the bot-side code (T22 then becomes a unit test for unused code). The plan v2 should be updated either way.

**I2 — Live `computeLaunchVerdicts` not directly tested.** T21 re-implements the verdict math inline because importing the room manager pulls `@clawville/database`. The actual `activityRoomManager.computeLaunchVerdicts` method is never called by any test. A typo or buffer-clearing bug there would not be caught. **Path forward:** mock `@clawville/database` in the room manager test file (the existing room manager tests already do this — see `activity-room-manager.test.ts` which is in the test suite but currently fails to import `activityRoomParticipants`). Add 2-3 tests for `computeLaunchVerdicts` directly.

**I3 — Comment in `applyIntentForTick` misrepresents expiry order.** `reef-race-sim.ts:767-769` claims "expiry sweep happens in tickRoom step 3 BEFORE applyIntentForTick on the same tick." The actual `tickRoom` runs `applyIntentForTick` (step 1, line 692) BEFORE the `activeBoosts` expiry sweep (step 3, line 702-715). This means a boost on its expiry tick is applied for one extra ~33ms tick. Behaviorally negligible (drift-boost lasts ~1233ms instead of 1200ms; stall ~1033ms; launch ~2033ms) but the comment is a misleading lie. **Fix:** either move the expiry sweep into `applyIntentForTick` step 3 to match the comment, OR fix the comment to say "expiry sweep in tickRoom step 3 happens AFTER this function, so boosts persist for one extra tick on expiry — acceptable 33ms tolerance." Same misleading comment was already present pre-Phase-1 for `activeEffects`; not a regression.

### Minor (defer to post-Phase-1)

**I4 — `snapshot.keyframe` handler does not refresh `driftSparks`.** `activity.ts:578-600` reuses `hydrateFromWorld` which only re-extracts position/velocity/state. If a delta is dropped (backpressure) and then a keyframe lands, the HUD's `driftSparks` will not match the body's actual state until the next delta. Edge case at 5Hz delta cadence — most players won't notice.

**I5 — `driftSparks` always-included in delta payload.** `reef-race-sim.ts:1510` writes `changed.driftSparks: b.driftSparks` for every body in every delta. Plan §6.2 implied conditional inclusion ("spark-only changes MUST broadcast"). The diff predicate (line 1489) correctly includes spark-only changes, but the `changed` object always carries the field. Wastes a few wire bytes per body per delta. T18 only asserts the value is 0, not that the field is omitted. Cosmetic.

**I6 — Bob amplitude on rider exceeds glider clearance.** `BOB_AMP_LOCAL = 2` local units = 40 world units. With `RIDER_MOUNT_OFFSET_DEFAULT[1] = 0.6` local = 12 world units, rider Y oscillates in world space [-28, +52]. Glider board half-height = 2.5 world units. Rider clips through the board on the downstroke. Plan §4.4 specified `±2 local`; implementation matches plan. Visual polish concern.

**I7 — `applyEntityDelta` first-insert dead-code `?? 0`.** `apps/web/src/stores/activity.ts:294-296`: `typeof c.driftSparks === 'number' ? ((c.driftSparks as 0|1|2|3) ?? 0) : 0`. The `?? 0` can never trigger since the branch is gated on `typeof === 'number'`. Cosmetic.

**I8 — Bumper-shells entities also get `driftSparks: 0` populated on first-insert.** `applyEntityDelta` is shared between bumper and reef-race; it always sets `driftSparks: 0` on first-insert regardless of activity. Wastes 8 bytes per entity. Cosmetic.

---

## Verdict

**PROCEED.**

All 11 critical anchors PASS. tsc clean on apps/api + apps/web. 41/41 reef-race tests pass; no regressions in the broader activity suite.

The headline drift mechanic (charge → spark → release → boost) works end-to-end for human players, with correct math, correct event broadcast, correct snapshot wire shape, and correct HUD wiring. The launch boost path works end-to-end for humans (WS → buffer → verdict → seeded boost → applied on tick 1).

The one Significant defect is bot-launch (I1) — bots generate the input but never get a verdict. Acceptable for Phase 1 if documented; bots cruising at thrust=0.4 during the launch window is a soft penalty and won't break gameplay. The other Significant items (I2, I3) are testing-coverage and comment-accuracy issues.

**Brand check:** Drift mechanic is mechanically correct but visually muted (small spark dots, no boost VFX). Player will *feel* the speed change but may not *see* the confirmation. Phase 2 art pass should add boost ribbons + audio. **6/10 first-touch genre satisfaction.**

**Recommended pre-merge follow-ups:**
1. Document I1 in plan v2 (bot launch is humans-only OR add bot-verdict synthesis path).
2. Mock `@clawville/database` and add direct tests for `computeLaunchVerdicts` (I2).
3. Fix or correct the misleading comment in `applyIntentForTick` (I3).
4. Add a bigger / more visible drift-spark VFX before public launch announcement (I6 / brand check).

Everything else can ship as-is.
