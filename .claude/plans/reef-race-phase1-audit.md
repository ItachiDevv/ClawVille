# Phase 1 Plan Audit

**Plan under review:** `.claude/plans/reef-race-phase1-detailed.md` (SHA `d17b114`)
**Auditor:** Orchestrator (red team)
**Date:** 2026-04-24
**Outcome:** Needs revision. 8 critical issues. 11 significant. 7 minor. Plan is well-structured but has math errors, type errors, and several "missing the actual integration point" gaps that would cause the implementation to fail end-to-end.

---

## Critical issues (must fix before implementing)

### C1. Drift angular bias is functionally a no-op AND/OR unbounded

Plan §1.3 says "Apply +15° angular bias for the drift arc" (constant offset).
Plan §2.4 implements:
```ts
body.rot += sign * DRIFT_ANGULAR_BIAS_RAD * (1 / REEF_SIM_HZ);
```
Three problems:

1. The accumulator runs **per tick** (`+= ... * (1 / REEF_SIM_HZ)`) so over a 1.5s drift the visible bias is `15° × 45 ticks × (1/30)s = 22.5°` (assuming nothing else clobbered it). That is not "+15° angular bias"; it's a per-tick drift rate of 0.5°/tick that ramps unboundedly while held.
2. Per the call order in §2.3, `tickDriftState` runs at step 7, AFTER step 6 (`body.rot = Math.atan2(intent.dir.x, intent.dir.y)`) which **overwrites** body.rot every tick from intent.dir. So whatever bias was added last tick is lost; the only visible bias is the ≤0.5° added between step 7 and the next tick's step 6.
3. Net result: the drift arc looks ~0.5° off-axis, not 15°. The "kart slide" visual claimed in §1B is not delivered.

**Fix:** Either compute `body.rot = Math.atan2(...) + sign * DRIFT_ANGULAR_BIAS_RAD` inside `applyIntentForTick` step 6 when `body.drift.charging`, or move step 6 to happen *before* tickDriftState and let tickDriftState ADD an absolute bias. The scalar `(1 / REEF_SIM_HZ)` term must be deleted.

### C2. New `activeEffects` keys are not in `ReefPowerUpKind`

`activeEffects` is typed `Map<ReefPowerUpKind, number>` (sim line 132). `ReefPowerUpKind` is a strict union of six existing power-up strings (`reef-race-config.ts` line 234). The plan writes:
```ts
body.activeEffects.set('rr-launch-boost', ...)
body.activeEffects.set('rr-launch-stall', ...)
body.activeEffects.set('rr-drift-boost', ...)
```
None of these are members of `ReefPowerUpKind`. **TypeScript build error** the moment any of these `set()` calls are added. The plan does not extend `ReefPowerUpKind` in the file-by-file change list (§10). Either widen the union (and update `getReefPowerUpDef`, `rollPowerUpKind`, `REEF_POWERUP_DEFS`, the bot view inventory typing, etc.) OR add a separate `Map<string, number>` for these non-pickup effects (cleaner, recommended).

### C3. Validator tolerance claim is inconsistent — and `velCheck` silently clamps boosted bodies

Plan §9.5 claims: *"the validators use a `tolerance` parameter (currently 1.5× in `integrateMotion`). Post-drift speed = `500 * 1.38 = 690 wu/s`. Tolerance check: `690 / 500 = 1.38 < 1.5` — JUST under the 1.5× tolerance. Safe for spark-3."*

This is partially correct but missed two things:

1. `DEFAULT_CLAMP_TOLERANCE = 1.15` (`shared.ts` line 42). The 1.5× value is hard-coded at the call sites (`reef-race-sim.ts` lines 796 + 805). So the project has TWO tolerances in play; if anyone refactors `integrateMotion` to call without an explicit tolerance, drift+launch boost immediately starts flagging. Add a named export `REEF_KINEMATIC_TOLERANCE = 1.5` and use it consistently — implicit constants in two places is a footgun.
2. **`velCheck` (line 796) silently clamps** without flagging — when boosted speed > `REEF_MAX_SPEED * 1.5 = 750 wu/s` the body's velocity is clamped back to 500 wu/s on the very next tick (`validateReefVelocityDelta` line 109-115). The plan's hard-cap at `REEF_MAX_SPEED * 1.45 = 725 wu/s` keeps you *just* under this — but only if drift+launch never stack with anything else. **rr-turbo-bubble** (`REEF_BOOST_MULT = 1.4`, line 88) on top of drift+launch additive (1.68×) trivially exceeds the silent-clamp threshold. The plan's "take the MAX" stacking rule for rr-launch-boost vs rr-turbo-bubble (§3.4) is asserted but not actually shown in the example code. Specify it concretely and add a unit test.

### C4. Launch-boost data-collection path does not exist in production code

Plan §3.2 acknowledges that `applyInput` returns `{ok: false}` for unknown rooms during COUNTDOWN, then proposes "the room manager holds a pre-launch buffer in its own state… and passes the per-body launch verdict as part of the `startRoom` call". But:

- `apps/api/src/services/activity/activity-ws-hub.ts` `handleInput` (line 390) routes inputs ONLY to `sim.applyInput`. There is no path from the WS hub into a room-manager buffer.
- `apps/api/src/services/activity/activity-room-manager.ts` has `liveTransitionFn` (line 139) but no method like `recordPreLaunchInput(roomId, petId, ts, thrust)`.
- `apps/api/src/index.ts` line 321-354 wires `liveTransitionFn` directly to `bumperShellsSim.startRoom` / `reefRaceSim.startRoom` — no room-manager-side buffer is consulted.

The plan says "the room manager captures thrust" but does not specify (a) the new ws-hub branch that copies inputs into the room buffer during COUNTDOWN, (b) the new `activityRoomManager.recordPreLaunchInput` API, (c) the new `activityRoomManager.computeLaunchVerdicts(room)` API, or (d) the change to `liveTransitionFn` in `index.ts` to compute and pass `launchBoosts`. Without all four, `launchBoosts` will always be `undefined` and the launch mechanic will silently no-op.

### C5. Bot launch logic conflicts with grace period — bots will never launch-boost

Plan §7.2 launch logic:
```ts
if (!this.launchAttempted && matchAge < 100) {
  const jitter = (Math.random() * 800) - 400;
  if (matchAge >= jitter) {
    this.launchAttempted = true;
    return { dir, thrust: 1.0, actionBits: ... | ACTION_BIT_LAUNCH };
  }
}
```

Two breakages:

1. The existing bot `computeInput` (line 130) caps `thrust` at 0.4 during grace (`inGrace = matchAge < BOT_OPENING_GRACE_MS` = 2500ms). The launch attempt happens at `matchAge < 100`, well inside the grace window. Even if you bypass the cap with the new branch, the rest of the grace path (line 115's `if (!inGrace)` guard for power-ups, line 130's thrust cap) overrides the proposed branch's `thrust: 1.0`.
2. The condition `matchAge < 100 && matchAge >= jitter` works only for negative `jitter` (jitter < 0). For positive jitter (bot is "late"), the bot would need to wait until matchAge ≥ jitter, but the outer `matchAge < 100` cap prevents that — positive jitters never fire. So the bot's effective launch jitter range is `[-400ms, 0)`, not `±400ms`. Half the launch attempts silently disappear.

Result: the plan's claimed "~50% bot launch success rate" is not achievable; bots will either always-stall (negative jitter) or silently never-launch (positive jitter), with the grace cap killing thrust to 0.4 anyway.

**Fix:** restructure the grace branch to allow a one-tick override during the launch window, AND change the condition so the bot can launch any time within `[matchStartedAt + jitter] : matchStartedAt + 1000ms` (jitter clamped to negative-only OR widen the outer matchAge bound).

### C6. Drift state machine plan does not handle Reef collision/proximity interaction or pickup acceleration

Plan §2.4 only checks for "speed < threshold" cancellation when speed drops between ticks. But `resolveProximity` (sim line 816) only adjusts position, never velocity — so proximity collisions never reduce speed, and the cancellation path never triggers from collisions. The plan's §2.5 mitigation note is wrong: "A collision that slows the body below DRIFT_MIN_SPEED_FOR_CHARGE will trigger cancellation on the NEXT tick" — collisions in this sim do NOT slow bodies. The only speed-reducer is `rr-ink-slick` (×0.5 in `applyIntentForTick`'s `speedMod` calculation). So the cancellation "speed dropped" path will only fire for ink-slicked bodies, not collisions.

If we WANT collision-cancellation (and we should — it's the standard Mario Kart drift feel), we need to add velocity damping to `resolveProximity`. Either add it to the plan, or remove the misleading "collision cancels drift" claim from §2.5.

Separately: `rr-tide-wave` and `rr-seeker-jelly` (sim lines 1025-1090) DO modify target velocities (slow + impulse). These are real velocity changes that COULD legitimately drop speed below threshold mid-drift. The plan should explicitly document drift-cancellation behavior here — it's currently silent.

### C7. Procedural glider geometry sized in wrong coordinate space

Plan §4.1 specifies `BoxGeometry(60, 6, 100)` placed inside the kart group. But `ReefRacePlayerInner` (line 304) wraps everything in `<group ref={groupRef} scale={[KART_SCALE, KART_SCALE, KART_SCALE]}>` where `KART_SCALE = 20`. So a 60×6×100 BoxGeometry becomes **1200×120×2000 wu** in world space. `REEF_TRACK_HALF_WIDTH = 150 wu` (entire track lane is 300 wu wide); this glider is 4× the width of the entire track, 7× longer than it. Visually catastrophic.

The same scale-space ambiguity applies to `SPECIES_RIDER_OFFSET` in §4.3. `[0, 10, -10]` for lobster — at scale 20, that's 200 wu / 200 wu offset, ~10× the body radius. Either:

- Numbers are in pre-scale local space → divide all geometry sizes by KART_SCALE, OR
- Numbers are in post-scale world space → multiply by KART_SCALE (so BoxGeometry ends up 3×0.3×5 in local), OR
- Restructure the node hierarchy so the glider lives outside the scale group.

The plan must pick one and call out the exact unit explicitly. As written, an implementer following the plan literally would ship a 1200wu-wide pizza slab.

### C8. `species` is not populated on entities — Milady gating in `ReefRacePlayer` will never match

`apps/web/src/stores/activity.ts` line 271 `applyEntityDelta` only spreads `x, y, rot, vx, vy, state` from delta into the entity. Neither `species` nor `color` is populated from the server snapshot — they exist on the `BumperShellEntity` interface as documented placeholders only (`bumper-shells-types.ts` line 67-68). `hydrateFromWorld` (line 301) doesn't set them either; `WorldState.entities` (`protocol.ts` line 163-170) has no species/color fields.

Plan §4.4 hinges on this:
```
if (entity.species === 'milady') { applyBalanceSway(...) } else { applyBob(...) }
```
This branch will NEVER hit the milady arm — `entity.species` is `undefined` for everyone. Ditto `SPECIES_RIDER_OFFSET[entity.species]`. The whole "rider-attach per species" mechanic is wired to a field nobody populates.

**Fix scope (out of Phase 1):** add `species` + `color` to `WorldState.entities`, to `EntityDelta.changed`, to `applyEntityDelta`, and have the sim pass species through. This is a non-trivial cross-package change. Either bring it into Phase 1 or admit Phase 1 ships a single-species visual.

---

## Significant issues (should fix)

### S1. `ReefSnapshot` and `EntityDelta` plumbing for `driftSparks` not specified end-to-end

Plan §6.4 says "include `driftSparks` in each body's snapshot data" but the `ReefSnapshot` interface (sim line 182) and the snapshot delta-filter on line 1228-1242 are not in the file-by-file change list (§10). Without extending the snapshot interface AND the snapshot diff predicate (`|| p.driftSparks !== b.driftSparks`), spark-only changes are filtered out and never broadcast.

### S2. `applyEntityDelta` is field-by-field, not blind-spread

Plan §6.3 implies `driftSparks` "flows through the existing catch-all" `[k: string]: unknown`. That catch-all only exists at the wire level. The `applyEntityDelta` function (`activity.ts` line 271-298) is explicit field-by-field, dropping anything it doesn't know. Plan §6.4 partially acknowledges this by adding a new `if (typeof c.driftSparks === 'number'...)` block — good. But the explanation in §6.3 misleadingly suggests no client change is required.

Also, the new branch must be `state.selfPetId === delta.petId` aware AND `applyEntityDelta` doesn't have access to selfPetId without refactor. Either (a) hoist the selfPetId check into the caller, or (b) pass selfPetId into `applyEntityDelta`.

### S3. State management for Active drift boost mult — plan punts on a tracking mechanism

Plan §3.4: *"`activeDriftMult` is read from the stored `DRIFT_BOOST_MULTS` index (need to track which spark level triggered it — store the multiplier value, not the index, in a separate `Map<petId, number>` or embed it in the effect value)."*

This is hand-waved. Three concrete options, plan must pick one:

1. Store the mult value as the second tuple element next to expiry: `Map<key, {expires:number, mult:number}>` — requires changing `activeEffects`'s value type.
2. Store the spark level on `ReefBody` as `currentDriftBoostSparks: 0|1|2|3` (zero when no boost active) and look up the mult on each `applyIntentForTick`.
3. Bake the boost into vx/vy at release time (already half-done by the impulse) and skip the time-extended mult entirely — just use the impulse + drag for the 1.2s decay. Simpler; probably what should ship.

### S4. Drift release — both impulse AND time-extended boost is double-counting

Plan §2.4 pseudocode:
```ts
body.vx *= factor;          // impulse: apply boost to velocity now
body.vy *= factor;
body.activeEffects.set('rr-drift-boost', now + DRIFT_BOOST_DURATION_MS); // also persists for 1.2s
```
Then §3.4 plans to apply `speedMod = 1 + activeDriftMult` for the next 36 ticks, ON TOP of the impulse already applied. That's a ×(1+m) impulse followed by a top-speed cap raised by another ×(1+m), so a 3-spark drift effectively gives `1.38 × 1.38 = 1.90×` peak velocity over the boost lifetime — way past the 1.45× hard-cap target. Pick one delivery mechanism, not both.

### S5. Hard cap clamp doesn't disambiguate "boost active" from "speed legitimately high"

Plan §9.5 fix:
```ts
const postBoostSpeed = Math.hypot(body.vx, body.vy);
const hardCap = REEF_MAX_SPEED * 1.45;
if (postBoostSpeed > hardCap) {
  const scale = hardCap / postBoostSpeed;
  body.vx *= scale;
  body.vy *= scale;
}
```
This runs every `applyIntentForTick` tick, capping any body to 725 wu/s — not just boosted bodies. With future stat multipliers (Phase 3) or any unforeseen velocity-injecting power-up (hypothetical "tide wave reflection" Phase 2), the cap silently neutralizes them too. Make the cap explicit: only apply when `body.activeEffects.has('rr-drift-boost') || body.activeEffects.has('rr-launch-boost')`.

### S6. ABORTED-during-COUNTDOWN cleanup not enumerated

Plan §3.2 mentions abort safety briefly but the room-manager flow has multiple abort paths (`evictRoom`, `transitionRoom('aborted')`, `aborted_crash`). The room manager's pre-launch buffer (whichever Map it lives in) needs an explicit cleanup hook on each abort path; plan does not specify.

### S7. Snapshot diff predicate update — broadcastDelta change not in file-by-file table

§10 lists `reef-race-sim.ts` changes but doesn't enumerate the snapshot diff predicate change. Without it, spark-only changes don't broadcast. Add to the change list.

### S8. Bot determinism — Math.random in drift logic vs LCG in pickup logic

The sim already uses an LCG for deterministic pickup rolls (`lcgNext`, line 1338). The bot's drift trigger uses `Math.random()` (plan §7.1 + §7.2). This means replays are NOT reproducible for bot drift behavior. Either:

- Pass a seeded RNG into `BotController.computeInput` (signature change), OR
- Document explicitly that bot heuristics are intentionally non-deterministic and replays only reproduce sim physics, not bot decisions.

The current bot code already uses `Math.random()` for jitter (line 78) and power-up firing (line 121), so this is a pre-existing decision — but the plan's "deterministic per-room from the LCG seed" claim in the sim header (line 22) is at odds with it. Worth a one-paragraph clarification in the plan.

### S9. HUD re-render rate — driftSparks is fine, but launch-glow ring is countdown-driven

Plan §5.3's launch-glow ring fires when `secondsRemaining === 1`. The countdown is updated on every `event.countdown` frame from the server. In the current room-manager flow, countdown frames are only sent at COUNTDOWN entry (one event with secondsRemaining=5) — there is no per-second countdown emit. So the glow ring will never trip mid-countdown. Either (a) the room manager needs to send per-second countdown frames, or (b) the HUD computes countdown locally from `room.startedAt - now`. Pick one and put it in the plan.

### S10. Plan claims the COUNTDOWN→LIVE transition is owned by the sim — it's not

Plan §3.1: *"The COUNTDOWN→LIVE transition happens at a server wall-clock instant (`state.startedAt`)."*

The transition is owned by `activity-room-manager.ts` (`countdownTimers`, line 150). The sim's `startRoom` is invoked AFTER the transition by `liveTransitionFn`. The `startedAt` the sim uses is `Date.now()` inside `startRoom` (line 250) — NOT the room manager's `startedAt`. There's a small (sub-ms but possibly larger under GC) skew between the room manager's transition timestamp and the sim's perceived `startedAt`. The plan must specify that `launchBoosts` verdicts are computed against the room manager's `room.startedAt`, NOT against `state.startedAt`, OR the sim must accept a `startedAt` parameter.

### S11. `applyEntityDelta` initial-insert path drops driftSparks

Plan §5.1 only spells out the update path. The first-sighting branch (`activity.ts` line 274-285) only initializes positional fields. If the first delta a client receives for a body already has `driftSparks > 0`, it gets dropped. Edge case but worth specifying.

---

## Minor issues / nits

### M1. `LAUNCH_STALL_THRUST_CAP = 0.30` — typo or intentional duplication

§1.6 lists both `LAUNCH_STALL_THRUST_CAP` and a separately-spelled `0.3` in the `LAUNCH_STALL_THRUST_CAP = 0.3` line then `0.30` in the typescript export. Fine, just inconsistent — pick one decimal style.

### M2. `LAUNCH_STALL_DURATION_MS = 1_000` — but the stall starts at `startedAt`

The stall duration is 1s starting at `startedAt`. But the player presses early (before green) — the stall *should* start at the press moment, not at `startedAt`, so they sit through the rest of the countdown stalled-out, then 1s into the race still stalled. As-specced, the stall only burns 1s of in-race time, which is more lenient than the design probably wants. Worth one line of clarification.

### M3. `RoundCountdown` import path

§5.3 names `apps/web/src/components/game/activity.tsx`. Verify that file exists and exports `RoundCountdown` — this audit didn't double-check the import.

### M4. `DRIFT_MIN_ANGULAR_RATE` declared but `DRIFT_MIN_STEER` used

§1.5 declares `DRIFT_MIN_ANGULAR_RATE = 0.25` then immediately replaces it with `DRIFT_MIN_STEER = 0.25` and uses the latter throughout. Drop the angular-rate constant or use it. Two near-identical names invite future confusion.

### M5. `pet wallet` text in a hover note is actually `pet wallet` — wait wrong audit. Skip.

(removed)

### M6. Section §10 doesn't list `apps/web/src/lib/three/activities/reef-race/reef-race-types.ts`

If `entity.driftSparks` is ever read by the scene (Phase 2 VFX hook would need it), the type interface needs the field.

### M7. Phase 1's "no Milady" gap is honest but sequencing-broken

Plan §0 notes `ReefRacePlayer.tsx` only branches on `sea_horse + lobster`. Plan §4.4 then plans a `species === 'milady'` branch for balance sway. With C8 unfixed, the milady branch is dead code. Either delete the milady branch from Phase 1 (defer to a Phase 1.5 that wires species), or commit to wiring species end-to-end as part of Phase 1.

---

## Test gaps

The plan lists 12 tests. Missing scenarios — at least the following should be added:

1. **Drift cancels on collision** — after a `tide-wave` slows the drifting body below `DRIFT_MIN_SPEED_FOR_CHARGE`, drift cancels with no boost.
2. **Drift cancels mid-charge if drift bit released for 1 tick then re-held** — does the state machine resume the same charge or start fresh? Plan §2 doesn't say. Test it. Recommended: starts fresh.
3. **Two players launch simultaneously** — same-tick boost on row-0 spawns; verify resolveProximity doesn't kill either.
4. **Bot does NOT drift on a straight** — `dot >= 0.5` (well aligned with checkpoint heading) AND distance < threshold, expect zero drift attempts over 300 ticks.
5. **Snapshot delta correctly OMITS unchanged driftSparks** — verify the diff predicate filters out bodies whose only change-candidate is driftSparks=0 (a body never drifting still gets a delta only if a positional field changed).
6. **Snapshot delta INCLUDES driftSparks transition** — body whose ONLY change is sparks 1→2 still shows up in delta.
7. **Drift bias direction matches `body.rot = atan2(intent.dir.x, intent.dir.y)` convention** — turning right (`dir.x > 0`) should produce visible counter-rotation per the plan, not the opposite.
8. **Launch verdict null doesn't block the body** — `launchBoosts` map omits this petId entirely; body proceeds normally with no `rr-launch-*` effect set.
9. **Stall effect cap is enforced even after thrust=1.0 input** — verify `effectiveThrust = min(intent.thrust, LAUNCH_STALL_THRUST_CAP)` produces the expected speed ceiling.
10. **`stopRoom` mid-drift is safe** — body has `charging=true`, sparkLevel=2 when room is torn down; verify no broadcast of `event.drift_boost` after `rooms.delete(roomId)`.
11. **Backwards-compat snapshot** — old client (no `driftSparks` knowledge) receives a delta with `driftSparks` field; verify `applyEntityDelta` does not crash and entity state remains valid.
12. **Forfeit path resets drift state** — body is anti-cheat-forfeited mid-drift; verify drift state is cleared and no boost fires post-forfeit.
13. **Launch boost duration honored across multiple ticks** — verify `rr-launch-boost` expiry is `startedAt + 2000ms`, decaying naturally.
14. **`computeLaunchVerdicts` correctness** — table-driven test for the room manager's verdict computation: `lastThrust=1.0 + offset=±150ms` → boost; `=±200ms within 350ms` → stall; `<0.5` → null.

---

## Implementation order recommendation

Plan §11 has a dependency graph but no commit order. Recommend the following (single PR, internal commits ordered for clean revert):

1. **`packages/shared/src/activities/protocol.ts`** — add `event.drift_boost`, `event.launch` to `ServerFrame` union. (Type-only; no runtime effect; safe to ship alone.)
2. **`apps/web/src/stores/activity.ts`** — add empty `case 'event.drift_boost': break;` and `case 'event.launch': break;` to the exhaustive switch. Also add `driftSparks: 0` to `emptyState()` and the `ActivityState` interface. Together with #1 this restores the build.
3. **`apps/api/src/services/activity/sim/reef-race-config.ts`** — all new constants (drift tiers, launch window, action bits). No runtime path change.
4. **`apps/api/src/services/activity/sim/reef-race-sim.ts`** — add `ReefDriftState` to body, add `tickDriftState` (no broadcasts yet), extend `activeEffects` typing or add the side map (per S3), extend `speedMod` for new effects, add the hard-cap clamp behind a feature flag for safety. Keep broadcast emission OFF behind `if (false)` — verifies the math compiles + tests pass without exposing visible behavior.
5. **`apps/api/src/services/activity/sim/__tests__/reef-race-sim.test.ts`** — sim-side drift + launch unit tests.
6. **`apps/api/src/services/activity/activity-room-manager.ts`** — new `recordPreLaunchInput` + `computeLaunchVerdicts` API + COUNTDOWN-phase buffer + cleanup hooks.
7. **`apps/api/src/services/activity/activity-ws-hub.ts`** — `handleInput` branches on COUNTDOWN-phase rooms and copies thrust into the room-manager buffer.
8. **`apps/api/src/index.ts`** — `liveTransitionFn` for `reef-race` computes `launchBoosts` via the room manager API and passes to `startRoom(opts)`.
9. **`apps/api/src/services/activity/bots/reef-race-bot.ts`** — drift heuristic + launch attempt (with C5 fix).
10. **Bot tests** — drift in hairpins, no drift in grace, launch jitter distribution.
11. **Sim broadcast emission ON** — flip the feature flag from #4. Now visible.
12. **`apps/web/src/components/game/reef-race-hud.tsx`** — `DriftSparksBar`, launch-glow ring on countdown.
13. **`apps/web/src/lib/three/activities/reef-race/reef-race-config.ts`** — `SPECIES_RIDER_OFFSET` (resolve C7 unit ambiguity first).
14. **`apps/web/src/lib/three/activities/reef-race/ReefRacePlayer.tsx`** — gliderRef + procedural geometry + bank-tilt move + species-gated bob/sway. (Skip milady branch until C8 is resolved or punt to Phase 1.5.)

Commits 1-10 are server-only; commit 11 is the "go-live" toggle; commits 12-14 are client-visual. Reverting any client commit alone never breaks the server contract; reverting server commits 4-9 in reverse order safely back-rolls the feature.

---

## Overall verdict

**NEEDS REVISION.** The plan is detailed, well-organized, and gets the high-level structure right. But it has:

- A **functional no-op** in the drift angular bias (C1).
- A guaranteed **TypeScript build failure** from `activeEffects` typing (C2).
- A **missing integration path** for launch-boost data collection that requires changes to three files not in §10 (C4).
- A **bot-launch logic that cannot fire** as designed because of the existing grace-period guard (C5).
- A **glider that ships at 4× track width** because of the KART_SCALE oversight (C7).
- A **species-gated branch** wired to a field nobody populates (C8).
- A **double-counted drift boost** (S4) and a **silent clamp interaction** (C3) that mean the feel-good numbers in §1B don't actually deliver.

These are not "polish" issues; they would each cause Phase 1 to ship broken. The fixes are all small (an hour each, mostly), and the underlying design is sound. After fixing C1-C8 + S1-S5 and adding the missing tests, the plan is implementable.

**Brand-alignment check (Q14):** does Phase 1 deliver on "no soul, no skill ceiling"?

Honest assessment: **partially, conditional on the fixes.** The drift-charge + launch-boost combo IS the genre's foundational skill mechanic and would meaningfully raise the ceiling — IF C1-C5 are fixed. Without those fixes, drift would feel limp (tiny visible bias, no real velocity boost), and launch-boost would be invisible in production (data-collection gap). That ships as scaffolding theater (per CLAUDE.md "no scaffolding theater" rule) — looks like it works, doesn't actually function end-to-end. Phase 1 needs the fixes OR needs to be re-scoped to "drift only, launch deferred to Phase 1.5" with the WS hub plumbing as its own ticket. The half-measure path (ship drift + half-broken launch) is the worst option.

The "Reef Glider" prop is honestly a Phase-1.5 kind of change — it's fictional cohesion, not skill ceiling. Could be split out without weakening the core feel. C7 and C8 only matter if it stays in scope.
