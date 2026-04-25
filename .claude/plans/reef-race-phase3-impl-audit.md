# Reef Race — Phase 3 Implementation Audit

**SHA audited:** `5fa9ebb` (worktree `worktree-fix-bumper-build`)
**Plan v2 SHA:** `1ee85d8` (`.claude/plans/reef-race-phase3-detailed.md`)
**Audit date:** 2026-04-24
**Verdict:** **NEEDS REVISION — 1 CRITICAL, 5 SIGNIFICANT, 4 MINOR.** Do NOT merge until N1 fix and Town Guide skipped doc are addressed.

---

## TL;DR

Phase 3 ships the multiplier wiring correctly: every per-pet multiplier reaches its consumption site, the data flow is properly synchronous-await, the tolerance bump is mathematically justified, and the existing test base is not regressed (24 new passing tests, baseline 7-fail set unchanged). However, **the headlining N1 anti-cheat fix is fake — the velocity validator at `reef-race-sim.ts:1324` is still a no-op even though the test file claims otherwise.** A second deviation: the canonical `town-guide.ts` knowledge update mandated by both plan §10 and CLAUDE.md is **not in the diff**.

---

## 1. Plan-v2 critical anchors

### Anchor C1 — `REEF_KINEMATIC_TOLERANCE = 2.1`, no hardcoded 2.0 callers
**VERIFIED.**

- Constant defined at `apps/api/src/services/activity/sim/reef-race-config.ts:402` (`export const REEF_KINEMATIC_TOLERANCE = 2.1;`).
- Both call-sites in `integrateMotion` import the named symbol — `apps/api/src/services/activity/sim/reef-race-sim.ts:1328` and `1342`. No hardcoded `2.0` anywhere in the new code.
- `bumper-shells-sim.ts:760` still hardcodes `1.5` — that's pre-existing, OUT of Phase 3 scope.

### Anchor C2 — sync data flow (`liveTransitionFn` widened + awaited, profile-loader called BEFORE startRoom)
**VERIFIED.**

- Field signature `apps/api/src/services/activity/activity-room-manager.ts:180-181`: `private liveTransitionFn: ((room: Room) => Promise<void> | void) | null = null;`
- Setter widened at `:696` to `(room: Room) => Promise<void> | void`.
- `persistLiveTransition` `await`s the hook at `:855`.
- Matchmaker correctly pre-loads then starts: `apps/api/src/index.ts:359` (`await loadRacingProfiles(humanPetIds, botPetIds)`) → `:361` (`reefRaceSim.startRoom(...)`). No async IIFE, no tick-0 race.

### Anchor C3 — `slipstreamGraceTicks` consistent across config / body field / consumption / tests
**VERIFIED.**

- Config interface field `apps/api/src/services/activity/sim/reef-race-config.ts:872` — `slipstreamGraceTicks: number;`
- Body init reads `body.mults.slipstreamGraceTicks` at `apps/api/src/services/activity/sim/reef-race-sim.ts:2061` inside `resolveSlipstream`.
- Test P3-T6 uses the matching field name (`reef-race-sim.test.ts:1905-1906`).
- `AGILITY_SLIPSTREAM_GRACE_TICKS = 24` at `reef-race-config.ts:780`. `BASELINE_SLIPSTREAM_GRACE_TICKS = SLIPSTREAM_GRACE_TICKS = 6` at `:797`.
- Old `AGILITY_SLIPSTREAM_WINDOW_MS` is gone — `Grep` returns zero matches.

### Anchor N1 — `validateReefVelocityDelta` no-op fix
**FAILED — CRITICAL BUG (C-IMPL-1).**

The "fix" at `apps/api/src/services/activity/sim/reef-race-sim.ts:1306-1333` reads `body.vx, body.vy` into `prevV` on line 1307 and reads `body.vx, body.vy` again into `currV` on line 1323 — with NO mutation in between. They are byte-equal. `dv = 0`. `validateReefVelocityDelta(prevV, currV, ...)` returns `ok:true` every time. **The validator is still a no-op.**

```ts
const prev = { x: body.x, y: body.y };
const prevV = { x: body.vx, y: body.vy };  // <-- reads body.vx,body.vy
// ... long comment ...
const currV = { x: body.vx, y: body.vy };  // <-- reads same values
const velCheck = validateReefVelocityDelta(prevV, currV, dt, REEF_KINEMATIC_TOLERANCE);
```

Why: `applyIntentForTick` runs in the prior tick-loop pass (`reef-race-sim.ts:876`) and mutates `body.vx, body.vy`. `integrateMotion` is called AFTER (`:882`) — by then the velocity has already been updated. Any "before vs after" capture has to be split across the two methods (or inside `applyIntentForTick`), not within `integrateMotion`.

The plan §5 specifically said:
> `validateReefVelocityDelta(prevV, { x: body.vx, y: body.vy }, dt, REEF_KINEMATIC_TOLERANCE);`
> Where `prevV` is the velocity BEFORE the acceleration step and `{ x: body.vx, y: body.vy }` is the velocity AFTER.

The implementation captures BOTH AFTER. The validator delta-check remains broken.

**Why P3-T15 doesn't catch this:** the test calls `validateReefVelocityDelta` directly with synthetic `prev`/`next` values, never exercising the integrateMotion call-site. The test comment ("Source-level proof of the N1 fix") is wishful — no actual sim path is verified.

**Cheat-detection backstop today:** the velocity validator's secondary `speed > REEF_MAX_SPEED * tolerance` check at `anti-cheat/reef-race.ts:112` STILL fires for absolute-speed cheats above 1050 wu/s (sustained). But synthetic per-tick velocity-delta jumps (e.g. teleport in velocity space, then re-snap) are NOT caught by Phase 3.

**To actually fix:** either (a) capture `prevV` in the tick loop BEFORE `applyIntentForTick` and pass to `integrateMotion`, or (b) capture `body.lastTickVelocity` at the top of `applyIntentForTick`, or (c) split the integration so `integrateMotion` is the only mutator and `applyIntentForTick` produces a `targetVelocity` instead of writing `body.vx`. None of these are 1-line edits.

---

## 2. Phase 1 + Phase 2 anchor preservation
**VERIFIED no regression.**

- All Phase 1 anchors (C1 drift bias, C2 ReefBoostKind union, C3 named tolerance, C4 launch verdict pre-set, C5 boost duration constants, C6 absolute speed cap) — code unchanged or strictly additive. P3-T13 explicitly checks neutral pets are bit-identical.
- 4-stage speedMod: clamps still in `reef-race-sim.ts:996-1044` block, untouched.
- BotRoomView shape extension (Phase 2): `state.ribbons` / `state.hazards` references at `:1296-1297` unchanged.
- `event.power_up_collected.kind` shared union: re-export at `reef-race-config.ts:243-244` unchanged.
- N12 grace gating: `currentDriftBoostSparks` only zeroed on drift-boost expiry (`:896`) — unchanged.

---

## 3. Worst-case math re-derivation
**VERIFIED — plan numbers reproduce exactly.**

Constants from deployed config:
- `REEF_MAX_SPEED = 500` (`reef-race-config.ts:85`)
- `REEF_MAX_ACCEL = REEF_MAX_SPEED * 4 = 2000` (`:95`)
- `REEF_TICK_HZ = 30` → `dt = 1/30 ≈ 0.03333…` (`:291`)
- `KINEMATIC_BOOST_CAP = 0.85` → max speedMod = 1.85 (`:429`)
- `REEF_KINEMATIC_TOLERANCE = 2.1` (`:402`)
- `LEVEL_ACCEL_MULT_CEILING = 1.25` (`:769`)
- `AGILITY_TURN_RADIUS_MULT = 0.85` → `1/0.85 ≈ 1.17647` (`:773`)

**Step-by-step:**

1. Per-tick acceleration step (S1 max not compound — confirmed at `reef-race-sim.ts:1105`): `REEF_MAX_ACCEL × dt × max(1.25, 1.17647) = 2000 × 0.03333… × 1.25 = 83.333… wu/s` ✓ matches plan's 83.3.
2. Peak steady velocity at boost cap: `REEF_MAX_SPEED × 1.85 = 925 wu/s` ✓.
3. Peak velocity post-acceleration kick: `925 + 83.333 = 1008.333 wu/s` ✓.
4. Position step (worst-case, single tick): `dt × 1008.333 = 0.03333 × 1008.333 = 33.611 wu` ✓ (plan: 33.6).
5. Validator allowance (position): `dt × REEF_MAX_SPEED × tolerance = 0.03333 × 500 × 2.1 = 35.000 wu` ✓.
6. **Headroom = 35.000 − 33.611 = 1.389 wu (~3.97%).** Plan said "1.4 wu (~4%)" — accurate.

**Source code uses `max(...)` not multiplicative compound** — verified `reef-race-sim.ts:1105`:
```ts
maxStep = REEF_MAX_ACCEL * dt * Math.max(body.mults.accelMult, turnBonus);
```

**Position step = `dt × peak velocity` (post-accel), NOT just velocity** — also verified: `body.x += body.vx * dt` AFTER `body.vx += dvx * scale` (which adds the per-tick step). The validator compares `prev` vs `next` position at `:1338-1343`, so it sees the full post-accel step. ✓.

**Velocity validator allowance:** `REEF_MAX_ACCEL × dt × tolerance = 2000 × 0.03333 × 2.1 = 140 wu/s`. Legit max delta = 83.3. Headroom = 56.7 wu/s — but **moot due to N1 fake fix**.

**Speed-cap secondary check:** `REEF_MAX_SPEED × tolerance = 500 × 2.1 = 1050 wu/s`. Peak velocity 1008.3 < 1050 ✓ no flag (plan correct).

---

## 4. Multiplier integration points

### `accelMult` — `reef-race-sim.ts:1091`
`maxStep = REEF_MAX_ACCEL * dt * body.mults.accelMult;` — scales per-tick velocity step. **Correct.**

### `turnRadiusMult` — `reef-race-sim.ts:1092-1107`
Detected via `cosTheta < 0.97` (~14° steering angle); applies `Math.max(accelMult, 1/turnRadiusMult)` (S1 — replacement, not compound). **Correct.** Edge case noted: `intent.dir` is required; test P3-T5 confirms agility outperforms balanced after one tick.

### `slipstreamGraceTicks` — `reef-race-sim.ts:2061`
`self.slipstreamGraceTicksLeft = self.mults.slipstreamGraceTicks;` — replaces hardcoded `SLIPSTREAM_GRACE_TICKS`. **Correct.** P3-T6 verifies 24 vs 6.

### `driftChargeMult` — `reef-race-sim.ts:1162-1167`
Pre-applied at startRoom (`:541-545`) into `driftSparkTicks: readonly [number, number, number]`; hot loop reads the tuple. **Correct.** Strength: [9, 19, 32]; neutral: [12, 27, 45].

### `knockbackResistMult` — TWO sites, both verified
- `applyTideWave` `reef-race-sim.ts:1631`: `factor = 0.4 * (1 - dist / radius) * target.mults.knockbackResistMult`. Correct.
- `applySeekerJelly` `:1675`: `impulse = REEF_MAX_SPEED * 0.6 * best.mults.knockbackResistMult`. Correct (S3 explicit).

### `powerUpDurationMult` — `reef-race-sim.ts:1594-1597`
`activeEffects.set(kind, now + def.effectMs * body.mults.powerUpDurationMult)` — switch arm covers all 4 duration-bearing pickups. Tide-wave and seeker-jelly are instant (effectMs=0) so multiplying is a safe no-op. **Correct.**

### `ribbonDetectMult` — `reef-race-sim.ts:2138-2142` + `isOnRibbon` helper at `:2387-2411`
`isOnRibbon(body, ribbon, RIBBON_HALF_WIDTH * body.mults.ribbonDetectMult)` — helper signature widened with default. **Correct.**

---

## 5. Profile loader (`pet-profile-loader.ts`)

- **VERIFIED single batched query.** `db.select(...).from(pets).where(inArray(pets.id, humanPetIds))` — 1 roundtrip per match.
- Bots short-circuit before any DB read (`:44-46`).
- Missing pet rows fall back to neutral (`:69-74`).
- DB error caught and logged, all humans default to neutral (`:75-83`) — race never black-holes.
- P3-L1, P3-L2, P3-L3 + bonus "no DB call when humans empty" all pass when run in isolation.

---

## 6. Type system

`bun --bun tsc --noEmit` exit 0 in:
- `apps/api` ✓
- `apps/web` ✓
- `packages/shared` ✓

No new TS errors.

---

## 7. Test execution

```
apps/api/src/services/activity/sim/__tests__/reef-race-sim.test.ts:
  93 pass  0 fail  493 expect() calls  [143ms]

apps/api/src/services/activity/__tests__/pet-profile-loader.test.ts:
  4 pass  0 fail  13 expect() calls  [64ms]

apps/api/src/services/activity/bots/__tests__/reef-race-bot.test.ts:
  16 pass  0 fail  651 expect() calls  [81ms]

apps/api/src/services/activity (whole dir):
  186 pass  7 fail  4 errors  [296ms]
```

Baseline at `f9c4c0c` (Phase 2 impl-audit fixes):
```
apps/api/src/services/activity (whole dir):
  162 pass  7 fail  4 errors  [258ms]
```

**Phase 3 added 24 passing tests (162 → 186). The 7 fails + 4 errors at baseline are pre-existing in BumperShellsBot and `Room sweeper > aborts COUNTDOWN rooms with no connected players`. NOT introduced by Phase 3.**

---

## 8. Backwards compat

- **Old WS clients:** `RoomMeta.reefRacingProfiles` is optional (`?`). TypeScript narrowing means existing readers ignore it. ✓ Safe.
- **Bumper Shells:** `body.mults` doesn't exist on bumper bodies. Bumper sim never reads it. ✓ Confirmed via grep — no Phase 3 imports leak.
- **Existing pets without archetype:** `pets.archetype` is `notNull` per schema (default required at create-time), but the loader handles `archetype: null` from a hypothetical NULL row by passing through `?? null`, then `racingClassFromArchetype(null)` → `'balanced'` → all 1.0 mults. ✓ Defensive.
- **Widened `liveTransitionFn`:** existing sync handlers (`bumper-shells`, `arena`) keep returning `void`; manager `await`s `void` (no-op). ✓ However, P3-T18 does NOT actually test this composition end-to-end (see §11 issue M-IMPL-3).

---

## 9. Build summary HUD

- File: `apps/web/src/components/game/reef-race-build-summary.tsx` (122 lines).
- Subscribes to `selfRacingClass` + `selfLevel` + `matchPhase` — all primitives. ✓ No Map subscriptions.
- Visibility: `pregame-countdown` always visible; `live` shows for first 3000ms then fades. ✓
- DOM only — no Three.js. ✓
- **MISSING `FEATURE_GATE` comment** — plan §7d explicitly required one with deadline `2026-06-01`. Implementation ships unconditionally. **S-IMPL-1.**

---

## 10. Town Guide knowledge — **DEVIATION FROM PLAN + CLAUDE.md**

**S-IMPL-2.** `git diff f9c4c0c..5fa9ebb -- packages/agent-templates/src/locations/town-guide.ts` returns **EMPTY**. Plan §10 lists `+3 lines` to this file (the explicit N2 fix). CLAUDE.md "MANDATORY: Every gameplay change updates system agents' expertise in the same diff" is violated.

The implementation DID update `packages/shared/src/constants/orientation-skill.ts` (the agent-export bundle's skill). That's a different surface — it serves agents who pulled the SKILL.md but does NOT teach Nori, the in-world tutorial NPC. New player onboarding flow is now stale.

**Note on accuracy in the orientation-skill update:**
- Line 84 says "60% longer slipstream grace (24 ticks vs 6)" — **MATH ERROR. M-IMPL-1.** 24/6 = 4× = +300%, not +60%. Same wrong number is in `reef-race-build-summary.tsx:37` ("Tighter turn, +60% slipstream grace") — copied verbatim from plan §7c headline. Plan is also wrong; implementation propagated the error to user-facing copy.
- Line 84 also says "Anti-cheat ceiling unchanged at 1050 wu/s after the Phase 3 tolerance bump (was 1000 wu/s)" — accurate (REEF_MAX_SPEED × 2.1 = 1050; was REEF_MAX_SPEED × 2.0 = 1000).

---

## 11. Telemetry hook — Phase 3.5 prep

**VERIFIED.** `reward-pipeline.ts:355-432` adds `emitReefRaceBotWinrateEvent()` + `bucketLevelForBotWinrate()`.
- Fires once per finished reef-race room with `issued.length > 0`.
- Pulls highest-level human via batched `db.select({id, level}).from(pets).where(inArrayWhitelist(...))`.
- Bucket boundaries match plan §6: `'1-10' | '11-25' | '26-49' | '50'`.
- Payload schema matches plan exactly: `{roomId, humanLevelBucket, humanFinished, humanFinishedFirst, botCount, botFinishedAhead}`.
- `void emitReef…(...)` fire-and-forget; errors caught + logged.

**M-IMPL-2 — missing P3-D1 test:** Plan §10 required a new file `apps/api/src/services/activity/__tests__/reef-race-bot-winrate.test.ts` to verify the event fires. The file does not exist. Without it, the §6 / §10 claim "Phase 3.5 deferral closes a feedback loop" remains an unverified scaffold.

---

## 12. Bot fairness honest brand check

Bots are forced neutral (verified `pet-profile-loader.ts:44-46` and `racingClassFromArchetype` returns `'balanced'` for null). A level-50 agility human races against 7 neutral bots with:
- 24.5% faster acceleration recovery
- 15% tighter turning during corner entry
- 4× longer slipstream post-leave grace

Top speed is unchanged (the binding cap), so the race isn't "trivial" — but the level-50 human gets meaningful systemic advantages. This is **by design** (Phase 3 §6) and the telemetry hook (`reef_race.bot_winrate.by_level_bucket`) is the empirical gate for Phase 3.5 lifting bot levels.

**Brand check:** retention is THE signal. If human/bot win-rate skew creates a "stomp the bots" feeling that hurts retention before Phase 3.5 ships, the brand goal loses. Mitigation: the `'26-49'` and `'50'` bucket events are precisely the alarm — but only if someone watches the dashboard. **No /dash widget exists yet for `reef_race.bot_winrate.by_level_bucket`.** S-IMPL-3.

---

## Significant issues (S-IMPL-*)

### S-IMPL-1 — Build-summary HUD missing FEATURE_GATE comment
Plan §7d required a `FEATURE_GATE: reef_race_build_banner` block with a metric, current reading, and deadline. Implementation ships the banner with no gate comment. CLAUDE.md "Feature Gates" rule states "PRs adding scaffolded features without this comment are rejected on review."

**Fix:** add the FEATURE_GATE block to `apps/web/src/components/game/reef-race-build-summary.tsx` per the plan template.

### S-IMPL-2 — Town Guide knowledge not updated (mandatory CLAUDE.md violation)
`packages/agent-templates/src/locations/town-guide.ts` knowledge[] has zero Phase 3 entries. Plan §10 specified `+3 lines`. CLAUDE.md "Every gameplay change updates system agents' expertise in the same diff" is unambiguous. New player onboarding via Nori cannot explain Phase 3 mechanics until this lands.

**Fix:** add the 3-line entry from plan §10 to `town-guide.ts`. ~5 minutes of work.

### S-IMPL-3 — `/dash` does not yet surface `reef_race.bot_winrate.by_level_bucket`
The event emits but no dashboard tile reads it. Phase 3 §6 leans on this metric as the Phase 3.5 graduation gate, but until /dash visualizes it, the gate is open-loop. (Mitigation: emission alone is enough for the data to land; a future audit can confirm the panel.)

**Fix:** add a tile in the dashboard that groups by `humanLevelBucket` over the measurement window. Out of scope for Phase 3 sim work but should be tracked.

### S-IMPL-4 — P3-T11 weak coverage
Plan: "call the new async `liveTransitionFn`, await it, then read `state.bodies.get(p1).mults.accelMult` immediately. Must be 1.25, not 1.0."

Implementation: synchronously calls `bootProfileRoom` (which calls `reefRaceSim.startRoom` directly with profiles already in hand) and reads `body.mults.accelMult`. **The actual async path through `liveTransitionFn` + `loadRacingProfiles` is not exercised.** It's a constructor-level test, not an integration test. The "first tick uses correct mults, not 1.0" guarantee is only verified for the in-memory shortcut, not the production data flow.

**Fix:** add an integration test that drives `activityRoomManager.transitionRoom(...)` through COUNTDOWN→LIVE with a registered async handler.

### S-IMPL-5 — P3-T17 / P3-T14 statistical bound dropped
Plan: P3-T14 "agility body completes 3-lap race faster than balanced (regression marker). Statistical bound: agility totalTimeMs < balanced totalTimeMs at p<0.05 over 10 seed-rotated trials."
Plan: P3-T17 "agility human's `totalTimeMs < bot.totalTimeMs` over 10 trials at p<0.05."

Implementation: P3-T14 was reused for "strength drift charges spark1 at tick 9 vs 12 baseline" (already covered by P3-T7 logically). P3-T17 measures velocity convergence after a single tick, not lap times.

**Net result:** no end-to-end regression marker for "agility-class human actually finishes a 3-lap race faster than balanced." Without this, a future refactor that breaks `applyIntentForTick`'s turn-bonus path won't surface in tests until QA.

**Fix:** restore the planned multi-trial lap test, even if it costs ~200ms in CI.

---

## Minor issues (M-IMPL-*)

### M-IMPL-1 — Wrong "+60% slipstream grace" copy in HUD + orientation-skill
24 ticks vs 6 ticks is **+300%, not +60%**. Plan §7c had the error in the headline string; both the HUD chip (`reef-race-build-summary.tsx:37`) and the orientation-skill knowledge (`orientation-skill.ts:84`) propagated it verbatim.

**Fix:** change to "+300% slipstream grace" or "4× longer slipstream grace" (preference: "4× longer post-wake grace" — clearer to players).

### M-IMPL-2 — Missing P3-D1 telemetry test file
Plan §10 named `apps/api/src/services/activity/__tests__/reef-race-bot-winrate.test.ts` (P3-D1). File does not exist. The new `emitReefRaceBotWinrateEvent` is uncovered by tests.

**Fix:** add the P3-D1 test (~50 lines) per plan §8.

### M-IMPL-3 — P3-T18 trivially passes; doesn't test what it claims
The test defines a sync arrow function, awaits its return, and asserts `invoked === true`. This proves "JavaScript can `await` a non-Promise" — not "the room manager's widened `await this.liveTransitionFn(room)` composes correctly with the existing bumper-shells / arena sync handlers." The plan asked for a real integration test.

**Fix:** import `bumperShellsSim` + `setLiveTransitionFn`, register sync handlers, drive a synthetic room through `persistLiveTransition`, assert no exception.

### M-IMPL-4 — P3-T15 doesn't actually test the N1 fix
Direct validator-function call with synthetic args. Test comment claims "Source-level proof of the N1 fix" — but the source-level fix is broken (see C-IMPL-1) and this test would still pass even if `integrateMotion` were unchanged. The test demonstrates the validator function's clamp logic, NOT the integration site's correctness.

**Fix:** after restructuring `integrateMotion` to capture `prevV` from outside (per C-IMPL-1 fix), add a test that drives the sim with a synthetic mid-tick velocity poke and asserts `body.flags['overaccel'] >= 1`.

---

## Critical issues (C-IMPL-*)

### C-IMPL-1 — N1 velocity-validator fix is FAKE; validator remains a no-op
`apps/api/src/services/activity/sim/reef-race-sim.ts:1306-1333` reads `body.vx, body.vy` into `prevV` (line 1307) and into `currV` (line 1323) at the same instant — no mutation between. The validator sees `dv = 0` every tick and returns `ok:true`. Synthetic per-tick velocity-jump tampering is NOT detected.

**Concrete repro path:**
1. Cheating client sends an input that makes the server-side `applyIntentForTick` produce a 1008 wu/s velocity (legit, capped by speedMod).
2. `integrateMotion` runs. `prevV` and `currV` both = (0, 1008). `dv = 0 ≤ 140 wu/s allowance`. Speed check `1008 ≤ 1050`. **Returns ok.**
3. Position step `33.6 wu` slips just under the 35 wu position-validator threshold. **Returns ok.**
4. Body got a 1008 wu/s velocity legitimately — fine — but if the cheater snapped from 0 to 1008 wu/s in a single tick, the velocity validator would not have caught it because `prevV` was captured AFTER the snap.

**Why the secondary speed cap doesn't save us:** the speed cap on line 112 of `anti-cheat/reef-race.ts` only fires for ABSOLUTE speed > 1050 wu/s. A cheater staying within 1050 but tampering with velocity-delta integrity is undetected.

**Why P3-T16 passes:** P3-T16 doesn't tamper with anything — it just runs the legit worst-case stack. Position validator OK (33.6 < 35.0). Velocity validator OK because nothing tries to bypass acceleration. Test is true but useless as proof of N1.

**The fix the plan called for:**
```ts
// Plan §5 — passes prevV (BEFORE accel) and post-accel velocity:
validateReefVelocityDelta(prevV, { x: body.vx, y: body.vy }, dt, REEF_KINEMATIC_TOLERANCE);
```

The implementation captured `prevV` AFTER the accel step (the `applyIntentForTick` ran in the prior tick-loop pass), making the comparison vacuous.

**Required correct fix:** add a `body.lastIntegratedVelocity?: {x,y}` field stamped at the end of `integrateMotion`, then on subsequent calls compare `body.lastIntegratedVelocity` against `prevV`. Or: capture `prevV` in the `applyIntentForTick` loop pass (line 873-877) BEFORE the call mutates velocity, then pass through into integrateMotion via a parameter or a per-body cache.

**Severity:** CRITICAL because Phase 3 explicitly justified the C1 tolerance bump on the assumption that the velocity validator is operational (plan §5: "velocity validator at the same 2.1 tolerance still catches sustained over-velocity"). With C-IMPL-1 broken, the tolerance bump opens the position validator wider while leaving the velocity validator no-op. Net cheat-detection is WORSE than pre-Phase-3.

**Note:** the same no-op pattern exists at `bumper-shells-sim.ts:760` (`validateVelocityDelta(prevV, prevV, dt, 1.5)`) — pre-existing in master, not Phase 3's regression. But Phase 3 EXPLICITLY claimed to fix the Reef variant and shipped a fake fix.

---

## Verification commands run

```
git rev-parse HEAD                                                       → 5fa9ebb
git diff --stat f9c4c0c..5fa9ebb -- apps/ packages/                      → 14 files, +1458 −32
bun --bun tsc --noEmit (apps/api)                                        → exit 0
bun --bun tsc --noEmit (apps/web)                                        → exit 0
bun --bun tsc --noEmit (packages/shared)                                 → exit 0
bun test apps/api/src/services/activity/sim/__tests__/reef-race-sim.test.ts → 93 pass, 0 fail
bun test apps/api/src/services/activity/__tests__/pet-profile-loader.test.ts → 4 pass, 0 fail
bun test apps/api/src/services/activity/bots/__tests__/reef-race-bot.test.ts → 16 pass, 0 fail
bun test apps/api/src/services/activity (whole dir, HEAD)                → 186 pass, 7 fail (pre-existing)
bun test apps/api/src/services/activity (whole dir, baseline f9c4c0c)    → 162 pass, 7 fail (same set)
git diff f9c4c0c..5fa9ebb -- packages/agent-templates/src/locations/town-guide.ts → empty
```

---

## Verdict

**NEEDS REVISION — do NOT merge.**

| Severity | Count | Issues |
|---|---|---|
| Critical | 1 | C-IMPL-1 (N1 fix is fake) |
| Significant | 5 | S-IMPL-1 (no FEATURE_GATE), S-IMPL-2 (Town Guide skipped), S-IMPL-3 (/dash widget missing), S-IMPL-4 (P3-T11 weak), S-IMPL-5 (P3-T14/T17 statistical bound dropped) |
| Minor | 4 | M-IMPL-1 (+60% wrong copy), M-IMPL-2 (no P3-D1), M-IMPL-3 (P3-T18 trivial), M-IMPL-4 (P3-T15 doesn't test integration) |

**Worst-case validator math (verified):** position step 33.6 wu vs 35.0 wu allowance = 1.4 wu headroom. Math is correct AT THE POSITION VALIDATOR. But the velocity validator promised as the cheat-detection backstop (§5 of the plan) is not actually operational — C-IMPL-1.

**Required before merge:**
1. **C-IMPL-1** — actually fix the velocity validator no-op (restructure prevV capture across applyIntentForTick / integrateMotion boundary).
2. **S-IMPL-2** — add 3-line Town Guide knowledge entry per plan §10.
3. **M-IMPL-1** — fix the "+60% slipstream grace" copy in two places.

**Recommended same-PR:**
4. **S-IMPL-1** — add FEATURE_GATE comment to build-summary HUD.
5. **M-IMPL-4** — add a real integration test for the N1 fix once C-IMPL-1 is correct.

**Acceptable in follow-up PR:**
- S-IMPL-3, S-IMPL-4, S-IMPL-5, M-IMPL-2, M-IMPL-3.

The mults wiring, profile loader, sync data flow, type system, and 24 new passing tests are solid. The critical issue is concentrated entirely in C-IMPL-1 — a single misplaced variable capture that creates the illusion of a security fix.
