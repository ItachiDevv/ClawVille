# Phase 3 Plan Audit

**Plan under audit:** `.claude/plans/reef-race-phase3-detailed.md` (v1, SHA `4bd5f18`).
**Worktree:** `worktree-fix-bumper-build`.
**Auditor:** orchestrator (ultrathink).
**Date:** 2026-04-24.

Citations are `path:line` from this worktree's tip.

---

## Verdicts on 6 author-surfaced decisions

### a) 14 → 4 archetype bucket mapping

**Verdict: AGREE WITH ONE NOTE**

Read all 14 archetypes in `packages/shared/src/constants/pet-archetypes.ts:1-15` and inspected each archetype's flavor text. Mapping is defensible:

- **Agility** (`mischievous-trickster`, `wild-explorer`, `chaotic-jester`) — all three are mobility-flavored: trickster has "back-current shortcuts" + "appear and vanish", explorer "moves through the kelp forest more silently than any native predator", jester is acrobatic/cartwheels. Clean fit.
- **Strength** (`brave-adventurer`, `fierce-battler`, `noble-guardian`) — adventurer wrestles trenches, battler is literally combat-trained, guardian "stand[s] watch" + protective. Clean fit.
- **Intelligence** (`curious-scholar`, `mystical-seer`, `cunning-trader`, `royal-diplomat`, `quiet-mystic`) — all five are cerebral. Slight overweight (5 archetypes → 1 bucket vs 3 each for agility/strength) means more pets get the powerup-duration + ribbon-detect buffs. Acceptable: those are the most "modest" mults (1.2× and 1.3×).
- **Balanced** (`gentle-healer`, `creative-dreamer`, `loyal-companion`) — neutral 1.0× across the board. Clean: these archetypes don't suggest a racing lean.

**Note:** the `cunning-trader` placement in intelligence is reasonable but borderline — traders are also "shrewd" (could fit agility for quick reactions). Not load-bearing; the bucketing is a v1 best-effort and the plan's API (`racingClassFromArchetype`) makes it trivial to swap one archetype later. Don't litigate before shipping.

### b) Slipstream "longer window" interpretation

**Verdict: NEEDS REVISION — plan resolution is correct in direction but the constant naming is confused**

Verified Phase 2 implementation in `reef-race-sim.ts:1934`:

```ts
self.slipstreamGraceTicksLeft = SLIPSTREAM_GRACE_TICKS;
```

`SLIPSTREAM_REQUIRED_TICKS = 45` is the **hold-to-arm** time. `SLIPSTREAM_GRACE_TICKS = 6` is the **post-leave grace** during which the boost lingers. The plan's §4c interpretation — extending grace, NOT lengthening required-hold — is the correct read of "longer window as a buff".

**However the §1 builder still produces a `slipstreamRequiredTicks` field:**

```ts
const slipstreamTicks = cls === 'agility'
  ? Math.round(AGILITY_SLIPSTREAM_WINDOW_MS / REEF_TICK_MS)  // 2200ms → 66 ticks
  : SLIPSTREAM_REQUIRED_TICKS;                                // 45 ticks (=1500ms)
```

Then §4c proposes renaming to `slipstreamGraceTicks` mid-document. The §1 multiplier-builder code block was never re-edited to match — it still reads `slipstreamRequiredTicks` and divides 2200ms which is the WRONG knob (extending required-hold = nerf). Implementation-time confusion is guaranteed if both names ship.

**Required fix before coding:** in §1, replace the `slipstreamTicks` derivation with grace-tick math:

```ts
const slipstreamGraceTicks = cls === 'agility'
  ? AGILITY_SLIPSTREAM_GRACE_TICKS               // 24 ticks (800ms)
  : SLIPSTREAM_GRACE_TICKS;                      // 6 ticks (200ms)
```

Drop `AGILITY_SLIPSTREAM_WINDOW_MS = 2200` constant and replace with `AGILITY_SLIPSTREAM_GRACE_TICKS = 24` from §4c. Drop the `PHASE3_MULT_CLAMP_SLIPSTREAM_MS` clamp, replace with `PHASE3_MULT_CLAMP_SLIPSTREAM_GRACE_TICKS = [6, 30] as const`. The audit-acceptance bar for this section is "the §1 builder, the BodyMultipliers interface, and the §4c consumption site all use the same field name `slipstreamGraceTicks`".

### c) Async vs sync profile-load

**Verdict: DISAGREE — the plan picked async (option b) but its self-correction (sync) is the right one. The §3b fenced code block is wrong; the prose under it is right.**

Re-read §3b. The plan first writes an async IIFE wrapping `startRoom`, then in the same paragraph self-corrects and chooses sync ("(b) chosen — see Risks §9. The fetch is fast enough that blocking is fine"). The CODE BLOCK still shows the async IIFE — it was not rewritten.

The plan is right that sync is the correct choice for two concrete reasons:

1. `liveTransitionFn`'s registered type is `(room: Room) => void` (verified `activity-room-manager.ts:175`). Wrapping startRoom in `void (async () => …)()` means startRoom completes asynchronously **after** the synchronous tick scheduler in `tickRoom` already started. Bot-controllers + intent-application could fire on a body that hasn't been initialized with mults → `body.mults` undefined → runtime TypeError.
2. The Drizzle pool query is ~1-2ms (Supabase pooler in the same datacenter as Hetzner). That's well below tick budget (33ms). Blocking is invisible to clients.

**Required fix before coding:** §3b's fenced code block must be rewritten to make the lambda async — `setLiveTransitionFn(async (room) => { ... })` — OR (cleaner) move the profile-fetch into `startRoom` itself by making it accept a synchronous `Promise<Map>` and `await` it before initializing bodies. Option A requires changing the registered type signature in `activity-room-manager.ts:175` to `(room: Room) => Promise<void> | void`. Option B is more invasive but keeps the registration sync. **Pick option A.** Verify with a `bun test` run that both other registered sims (`bumper-shells`, `arena`) still pass with the widened signature.

### d) No-schema-migration

**Verdict: AGREE — confirmed**

Verified `packages/database/src/schema/pets.ts:101-102` (`archetype` varchar) + `pets.ts:128` (`level` integer, default 1, NOT NULL). Both columns exist, both populated for every pet (NOT NULL with DEFAULTs). No migration needed.

The plan's choice to derive a 4-class racing bucket at runtime (vs a new `racing_class` column) is the right tradeoff — adding a column means a separate `bun run db:push` deploy step, a backfill query, and the schema field becomes the source-of-truth for archetype-bucket mapping (forking from the pure derivation). Pure function is auditable and reversible.

### e) Bot neutrality

**Verdict: AGREE FOR PHASE 3, FLAG FOR PHASE 3.5 IMMEDIATELY**

Verified `bot-pool.ts` selects only `pets.id`, `pets.name` (audit §0 finding 9). Bots are currently a fixed neutral baseline — that's the right A/B fixture for Phase 3 telemetry (humans will ratchet level/archetype investments against an unchanging bot pool).

The risk the plan acknowledges (§9 row 2) is real: as humans level up, the bot pool stays at level 1. Win-rate-vs-bots will skew over time. The plan's mitigation ("flag if win-rate-vs-bots crosses 95% for level-25+ humans") needs to actually exist as a `/dash` metric. **Add to file-by-file scope:** new metric `reef_race.bot_winrate.by_level_bucket` emitted on race-end. Without it, Phase 3.5 deferral is open-loop and the plan violates the "no scaffolding theater" rule (we'd ship a feature whose graduation criterion isn't measurable).

Bots should ALSO be neutral to ensure no fairness collapse if a level-50 human matches against another level-50 human + 6 bots — bots staying neutral in mixed-skill rooms hurts only the human at the bottom of the level distribution, who already loses on stats and now has an extra 6 sub-skill opponents. Telemetry must monitor that case.

### f) Phase 1 T3 test compatibility

**Verdict: AGREE — confirmed**

Verified `reef-race-sim.test.ts:404-440`. T3 imports `DRIFT_SPARK_TICK_1/2/3` directly from `reef-race-config.ts` and asserts spark progression at those literal ticks. T3 does NOT pass `petProfiles` to `startRoom`, so the test body's mults default to `NEUTRAL_BODY_MULTIPLIERS` and `driftSparkTicks = [DRIFT_SPARK_TICK_1, _2, _3]`. The assertion comparison is identical pre/post Phase 3.

**Caveat:** Phase 3 must NOT change the constants themselves (`DRIFT_SPARK_TICK_1` etc.). Plan is consistent with this — multipliers transform per-body thresholds, never the global constants. Codex review checklist: grep for `DRIFT_SPARK_TICK_` modifications in the diff and reject any.

---

## Critical issues (must fix before implementing)

### C1 — Anti-cheat math is WRONG: position validator FLAGS, not just clamps

**Plan claim (§5):** "0.8 wu over → silent clamp only, no flag (clamp ≠ flag in `validateReefPositionDelta`)".

**Reality:** `apps/api/src/services/activity/anti-cheat/reef-race.ts:84-91`:

```ts
return {
  ok: false,
  value: clampedNext,
  clamped: true,
  flagged: true,    // ← ALWAYS true when over limit
  flagKind: 'overspeed',
  detail: `reef_position_delta_${dist.toFixed(2)}_over_${maxStep.toFixed(2)}`,
};
```

Sim caller at `reef-race-sim.ts:1228-1232`:

```ts
if (!posCheck.ok) {
  body.x = posCheck.value.x;
  body.y = posCheck.value.y;
  this.flag(state, body.petId, 'overspeed', posCheck.detail);   // ← FLAG is fired
}
```

`FLAG_FORFEIT_THRESHOLD = 5`. A worst-case Phase 3 stack hitting the validator over even **5 ticks** (under one second of play) → integrity-forfeit. The plan's claim that the 0.8 wu overshoot is silent is **false** and would auto-forfeit any agility+level-50 pet that lands a max boost stack at the wrong moment.

**Required fix before coding:** ONE of these three.

1. **Tighten the per-tick gain so the worst-case stays ≤ `REEF_KINEMATIC_TOLERANCE × REEF_MAX_SPEED × dt = 33.33 wu`.** That means the combined accel multiplier `accelMult × (1/turnRadiusMult)` must be ≤ `33.33 / 32.65 = 1.021×`. Today's plan stack (`1.25 × 1.176 = 1.47×`) is 44% over the budget — agility's turn-tighten bonus alone is too much. Concretely: lower `AGILITY_TURN_RADIUS_MULT` from `0.85` to `0.92` AND lower `LEVEL_ACCEL_MULT_AT_50` from `1.25` to `1.10` — combined `1.10 × 1.087 = 1.196×`, position delta becomes `33.3 + 13.1 = 46.4 wu` per tick. Still over the validator.
2. **Raise `REEF_KINEMATIC_TOLERANCE` from 2.0 to 2.1** to absorb the worst-case position delta. The existing margin (1.85× soft cap vs 2.0× tolerance) was sized for Phase 2 stacking; Phase 3 needs ~5% more. This is the cleanest fix but it's a load-bearing constant — Phase 1 audit C3 explicitly raised it from 1.5 → 2.0. Pumping it again deserves its own audit memo.
3. **Apply the hard velocity cap (`REEF_MAX_SPEED * 1.85`) BEFORE position integration, not after.** Currently `integrateMotion` does: velCheck → x/y update → posCheck → drag → hardCap. Moving the hardCap to before x/y update guarantees the position step uses a capped velocity. Side effect: the velCheck input changes (it currently uses `prevV` against itself which is nonsense — see N1 below). This is the architecturally-cleanest fix but touches Phase 1 anchor C3.

**Recommended:** option 2. It costs one constant bump and a one-line anti-cheat-test update. Document in the same commit that the new tolerance was sized to absorb the Phase 3 worst-case stack.

### C2 — `void (async () => …)` IIFE in §3b will produce a tick-0 race condition

Detailed under verdict (c). The plan's prose self-corrects but the code block was never rewritten. Shipping the code block as-is means `startRoom` returns BEFORE the bodies are initialized with `mults` and `driftSparkTicks` — which means `applyIntentForTick` runs against `body.mults === undefined`, throwing in production. **Must rewrite the §3b code block to match the prose's choice.**

### C3 — `slipstreamRequiredTicks` vs `slipstreamGraceTicks` field-name confusion

Detailed under verdict (b). The plan internally contradicts itself between §1 (uses required-ticks) and §4c (renames to grace-ticks). The implementer will pick one based on which they read first. If they pick required-ticks, agility becomes a NERF (longer hold = harder to start). **Must rewrite §1 multiplier builder to use grace-ticks consistently.**

---

## Significant issues (should fix)

### S1 — The §4b "tighter turn" mechanic doubles the accel-mult and over-spends the anti-cheat budget

Plan §4b applies `1/turnRadiusMult` as an ADDITIONAL factor on `maxStep` whenever `cosTheta < 0.97` (≈14° turn). That means during corner entry the per-tick accel = `REEF_MAX_ACCEL * dt * accelMult * (1/turnRadiusMult) = 2000 × 0.0333 × 1.25 × 1.176 = 98 wu/s` per tick. That's the worst-case the §5 math then tries (and fails — see C1) to validate.

Two cheaper alternatives that produce the same gameplay feel without compounding:

(a) Apply turnRadiusMult as a REPLACEMENT for accelMult during turns (not a multiplicative compound). Effective: max accel = `2000 × 0.0333 × max(accelMult, 1/turnRadiusMult)` = max(83, 78) = 83 wu/s — same as accelMult alone, no extra budget consumed.

(b) Apply turnRadiusMult to the angular response (snap `body.rot` faster toward target), not to linear accel. The drift-state machine already snaps rot instantly via `Math.atan2(intent.dir.x, intent.dir.y)` — there's no slew rate to tighten. So (b) collapses to "do nothing" for the existing yaw mechanic, which means `turnRadiusMult` would need to be a NEW per-tick yaw-bias term applied separately. Heavier change.

**Recommendation:** (a) — replaces the compound. Keep the same gameplay handle (agility pets feel snappier in corners), drop the validator pressure.

### S2 — `cosTheta < 0.97` branch in §4b allocates nothing but uses 6 trig ops/tick/body

Plan claims "no new allocation" — true. But the operation count is misleading: `Math.hypot(intent.dir.x, intent.dir.y)` is `Math.sqrt(x² + y²)` and the `dirMag` divide is another floating-point op. In practice this is fine (we have ~8 bodies × 30Hz × 6 ops = 1440 ops/sec — trivial), but the cost should be reported honestly. More importantly: the `dirMag` computation is REDUNDANT if `intent.dir` is already normalized at applyInput time. **Verify** at `apps/api/src/services/activity/sim/reef-race-sim.ts` applyInput function whether `intent.dir` is guaranteed unit-magnitude. If yes, drop the `dirMag` divide.

### S3 — `applySeekerJelly` knockback patch is "deferred" — must be specified before coding

Plan §4e says the seeker-jelly patch is "deferred until the audit confirms the exact statement; the file-by-file scope (§10) reserves a 5-line edit for it". That's a scope hole, not a deferral.

The seeker-jelly impulse is `REEF_MAX_SPEED * 0.6 = 300 wu/s` added vector-component-wise to `best.vx, best.vy` (verified `reef-race-sim.ts:1548-1550`). The Phase 3 patch:

```ts
const impulse = REEF_MAX_SPEED * 0.6 * best.mults.knockbackResistMult;
best.vx += nx * impulse;
best.vy += ny * impulse;
```

Strength target with `knockbackResistMult = 0.6` takes a `300 × 0.6 = 180 wu/s` impulse instead of 300. That's the right behavior. **Add this specific patch to §4e before coding** so the file-by-file scope is closed. Anti-cheat impact is zero (smaller impulse = smaller velocity-jump = happier validator).

### S4 — Bot heuristics need a NOTE about ribbon-steering with intelligence-mults

§6 says "bots stay neutral, so their `driftSparkTicks` = `[12, 27, 45]` — unchanged from today". True. But the **bot-vs-human interaction** the plan misses: an intelligence human collects ribbons at `RIBBON_HALF_WIDTH * 1.3 = 45.5 wu` perp distance vs neutral 35 wu. Bots steering toward ribbons will use the **server-authoritative** `RIBBON_HALF_WIDTH` constant (verified bot reads ribbons via `state.ribbons` reference, no per-body half-width awareness). So bots' ribbon steering pretends ribbons are 35wu wide for everyone — they're 35 for themselves (correct) but 45.5 for intelligence humans (under-tuned). Bots will leave space at the edge of the band that intelligence humans CAN exploit but won't realize they can.

**Mitigation:** acceptable for Phase 3. Bots aren't trying to MIRROR human capability; they're a baseline. Document in the §6 paragraph: "Bots steer to the global RIBBON_HALF_WIDTH; intelligence humans get an asymmetric edge picking off ribbons inside the bot-perceived dead-band. By design — telemetry will confirm whether this overshoots".

### S5 — HUD §7 picks self-pet from `RoomMeta` per-client, but `RoomMeta` is broadcast room-wide

Plan §7b says "the per-client send is the seam where we can attach the SELF petId's profile". `RoomMeta` today is broadcast room-wide via `snapshot.init` — every client gets the SAME RoomMeta. Attaching a SELF-keyed `reefRacingProfile` means either (a) sending the WHOLE per-pet profile map and having clients filter by their petId, or (b) injecting per-client into the snapshot.init at WS-hub send-time.

(a) is wasteful (6 unused profiles per client) but trivial. (b) requires the WS hub to know each socket's petId, which it does (registered at JOIN), so (b) is feasible.

**Recommendation:** (a) for Phase 3 — `RoomMeta.reefRacingProfiles: Map<petId, {class, level}>` (~50 bytes × 8 = 400 bytes, a single packet's worth, sent ONCE on init). Client subscribes `selfRacingClass = state.room.reefRacingProfiles.get(selfPetId).class`. Cleaner than per-client routing. Update §7b accordingly.

### S6 — File-by-file scope §10 doesn't include a `reef-race-config.test.ts` baseline check

Plan §8 lists `reef-race-config.test.ts` as a NEW file — fine. But §10's existing list doesn't reference whether that file exists today. **Verify** with `ls apps/api/src/services/activity/sim/__tests__/reef-race-config.test.ts`. If it doesn't, fine — it's a new file. If it does, the plan must clarify whether the new tests append to the existing file or replace.

---

## Minor issues

### N1 — `validateReefVelocityDelta(prevV, prevV, dt, ...)` is a no-op call (pre-existing bug, not Phase 3)

`reef-race-sim.ts:1213` passes `prevV` for both `prev` and `next`. The validator's `dvx = next.x - prev.x = 0` always — no-op. This is a Phase 1 bug that Phase 3's anti-cheat math implicitly relies on (the integrator never actually checks velocity-delta — only position-delta after-the-fact). **Out of Phase 3 scope** but flag it for a follow-up — should be `validateReefVelocityDelta(prevV, { x: body.vx, y: body.vy }, dt, ...)`. Without this fix the plan's confidence that "no flags fire from velocity jumps" is accidentally correct (the velocity validator is dead code).

### N2 — Plan says Town Guide knowledge update is "+1 line, no new file" — that's not enough

CLAUDE.md "Town Guide knowledge sync" rule: "Every gameplay/world change MUST update `packages/agent-templates/src/locations/town-guide.ts` knowledge[] in same diff. Stale knowledge = broken onboarding". The plan's proposed one-liner: "In Reef Race, your pet's level (1-50) accelerates collision recovery; archetypes bucketed into agility/strength/intelligence/balanced classes shape handling — top speed never changes, so skill still beats stats."

Good but missing the 14-archetype → 4-class mapping. New users asking "I'm a chaotic-jester, what do I get?" need an answer. **Required:** add a second knowledge entry listing the four classes + which archetypes map to each + what each class's headline mult is. ~3 lines, not 1.

### N3 — `LEVEL_ACCEL_MULT_AT_50` constant is a CEILING, not the value AT level 50

The plan's name suggests the multiplier reaches 1.25 at level 50, and indeed the formula gives `1 + 0.005 × 49 = 1.245` (rounded). Constant name is misleading — it's actually a clamp ceiling, not a level-50 anchor. **Rename to `LEVEL_ACCEL_MULT_CEILING`** (Codex will flag this on review).

### N4 — `NEUTRAL_BODY_MULTIPLIERS` is mutable (TS `as const` not applied)

§1 declares `export const NEUTRAL_BODY_MULTIPLIERS: BodyMultipliers = { ... }`. A pet's `mults` field is assigned this reference directly: `body.mults = NEUTRAL_BODY_MULTIPLIERS`. If anyone (test code, debug helper, future refactor) mutates a body's mults via `body.mults.accelMult = 1.5`, the GLOBAL neutral object mutates and every NEW neutral body inherits the corruption. Trivially fixed: `as const` on the literal OR clone per body. **Recommend:** clone per body — `body.mults = { ...NEUTRAL_BODY_MULTIPLIERS }`. The clone is one allocation per body per room start (~8 bodies × ~5 rooms/min) — trivial.

### N5 — `Math.round(threshold / mult)` with strength=1.4: 12/1.4 = 8.57 → 9, 27/1.4 = 19.29 → 19, 45/1.4 = 32.14 → 32

Verified in §2. Plan's `[9, 19, 32]` is correct under round-half-up. But `Math.round(8.57)` in JS evaluates to `9` (round-half-to-even doesn't kick in until exactly .5). Plan's claim is right; flagged here only because the §2 comment ("9 chosen as floor of 8.57+0.5") is misleading — that's not how Math.round works in JS for negative values. The math is fine, the explanation is sloppy. Update comment to: "Math.round in JS uses round-half-up for positives — 12/1.4 = 8.571 rounds to 9".

### N6 — No mention of `slipstreamGraceTicksLeft` initialization for Phase 3 bodies

Phase 1+2 bodies init `slipstreamGraceTicksLeft = 0` (verified `reef-race-sim.ts:486-526`). Phase 3 doesn't change this — agility's grace-tick bonus only kicks in when `resolveSlipstream` ASSIGNS the new value at line 1934. So an agility body's first slipstream entry uses the right grace value. Plan is correct by accident — no init change is needed. Worth noting in §4c so reviewers don't waste time wondering if the body needs init.

---

## Test gaps

| Gap | Required addition |
|---|---|
| **Worst-case stack DOES flag** (under current validator) | Replace P3-T12 ("worst-case stack stays under validator") with `worst-case stack triggers overspeed flag at level 50 + agility + drift-3 + launch + slipstream` — assert `posCheck.ok === false`. After C1 fix is applied (tolerance bump), flip the assertion to `ok === true`. The TEST exists to PROVE C1 was actually fixed. |
| **Bot reads ribbons through global half-width** | New test: place a bot near a ribbon at perp = 40 wu (between 35 and 45.5). Bot should NOT divert toward the ribbon (steers via `RIBBON_HALF_WIDTH = 35`). Asserts §S4 invariant. |
| **Multiplier-clone safety** | New test (P3-C6): mutate `body.mults.accelMult = 99`, then start a new room, assert NEW body's `body.mults.accelMult !== 99`. Catches N4 if shipped without the clone fix. |
| **Async profile load — first tick uses correct mults, not neutral** | Plan's P3-T11 says "async profile load completes before first tick". After C2 fix (sync load), this test assertion is "first tick uses level-50 accelMult, not 1.0". Rename + rescope. |
| **Slipstream grace-tick agility extension** | P3-T6 in plan asserts `slipstreamGraceTicksLeft === 24` for agility. Plan's §1 builder still produces `slipstreamRequiredTicks` not `slipstreamGraceTicks` (C3) — test would fail until C3 is fixed. Test is correct; the code being tested is wrong. |
| **Bot fairness telemetry hook** | (Not a unit test — `/dash` integration test) Verify a `reef_race.bot_winrate.by_level_bucket` event fires on race-end. Without it the bot-neutrality decision graduates blind. |
| **Cross-pet interaction: agility human + neutral bot in same room** | New test: 1 agility pet + 1 neutral bot, race 3 laps with deterministic seeds. Assert agility pet's `totalTimeMs < bot.totalTimeMs` over 10 trials at p<0.05. Currently P3-T14 covers agility-vs-balanced parallel rooms — the more important test is mixed-room with bots. |
| **Agility ribbon-band asymmetry** | Plan's P3-T10 places body at perp = 42 wu and asserts intelligence (band 45.5 wu) collects, neutral (35 wu) misses. Add: body at perp = 36 wu — both should collect (intelligence within their wider band, neutral within their tighter band ANDED with body radius which is 22 — 35 + 22 = 57 wu ≈ 36 wu still inside neutral). Verify the body-radius convention isn't being double-counted. |

---

## Brand alignment

**Locked priority axes (CLAUDE.md):** ship-to-Milady, open-agent-onboarding, free-leaderboard, gamified-UI-with-unified-leaderboard.

Phase 3 effects on each:

- **Ship-to-Milady (#1):** Neutral. Phase 3 doesn't touch the agent-connect flow. ✓
- **Open-agent-onboarding (#2):** Slight POSITIVE if the Town Guide knowledge update (N2) is properly written — agents asking "what does my archetype do in the racing activity" get a useful answer. Without N2 fix, NEUTRAL.
- **Free leaderboard (#3):** Phase 3 produces clearer "skill-vs-stats" stratification on the daily-fastest-lap leaderboard (Phase 4 feature). Level-50 humans will dominate Lobster-of-the-day — that's the GOAL of stat connection but it raises a fairness concern: low-level humans can never claim daily fastest. Mitigation: the `personal best` axis (Phase 4) is per-pet, no level dependency. Phase 3 doesn't touch leaderboard math directly, but Phase 4 will need a per-level-bucket leaderboard view to keep level-1 humans engaged.
- **Gamified UI (#4):** The `<RacingBuildTile />` (§7c) is a small step. The decision to gate the build-summary banner (§7d FEATURE_GATE) is correct — don't ship UI we can't measure. Build-tile alone doesn't communicate enough about WHY the multipliers apply (hover tooltip would help).

**Will a level-50 player FEEL the advantage?** Probably yes — `accelMult = 1.25` recovers from collisions ~25% faster, and over a 90s race with ~3-5 collisions, that compounds into ~2-3 seconds of total race time differential. Within the same archetype class, level alone is meaningful. **Will a level-1 feel hopeless?** Borderline. Top-speed parity protects them, but stats compounding across collisions + drift sparks + slipstream grace means a clean-driving level-1 vs a clean-driving level-50 is a measurable gap. Phase 4 personal-best ghost is the antidote — gives level-1 humans a personally-meaningful goal regardless of leaderboard position.

**Build-summary tooltip recommendation:** the static lookup in §7c is good but should INCLUDE the headline mult per archetype-class. "L25 AGI · Tighter turn · +60% slipstream grace" — concrete numbers, not vague descriptions. Costs nothing in render budget (string concat once on init).

---

## Verdict

**NEEDS REVISION** before implementation. Three critical issues (C1, C2, C3) make the plan-as-written unsafe to implement: the anti-cheat math is wrong (would cause integrity-forfeits in normal play), the async wiring would race-condition tick-0, and the slipstream field-name confusion would produce a nerf instead of a buff if implemented from §1.

The architecture, decisions, and test scaffolding are sound. The 14→4 mapping (a), no-migration (d), bot-neutrality (e), and Phase 1 T3 compatibility (f) are all confirmed AGREE. The slipstream interpretation (b) is right in direction but the constants weren't refactored. The async-vs-sync (c) was self-corrected in prose but the code block wasn't updated.

**Required before coding (block on all of these):**

1. Fix C1 — pick anti-cheat strategy (recommend tolerance bump 2.0 → 2.1) AND add a test that proves the worst-case stack does NOT trip the validator.
2. Fix C2 — rewrite §3b code block to match the prose's sync-load decision, OR widen `liveTransitionFn` signature to async.
3. Fix C3 — rewrite §1 multiplier builder to use `slipstreamGraceTicks` consistently, drop the `slipstreamRequiredTicks` reference and `AGILITY_SLIPSTREAM_WINDOW_MS` constant.
4. Specify S3 — add the explicit `applySeekerJelly` patch to §4e.
5. Address S5 — switch §7b to `RoomMeta.reefRacingProfiles: Map<petId, ...>` (one-shot room-wide) instead of per-client routing.
6. Add the bot-fairness telemetry hook (`reef_race.bot_winrate.by_level_bucket`) to §10 file-by-file scope. Without it the §6 deferral-to-Phase-3.5 is open-loop scaffolding.

**Should fix (don't block but flag for Codex review):**

7. S1 — replace turnRadiusMult compound with `max(accelMult, 1/turnRadiusMult)` to drop validator pressure.
8. S6 — verify `reef-race-config.test.ts` doesn't already exist; clarify if append vs new.
9. N3 — rename `LEVEL_ACCEL_MULT_AT_50` → `LEVEL_ACCEL_MULT_CEILING`.
10. N4 — clone `NEUTRAL_BODY_MULTIPLIERS` per body to prevent cross-room mutation poisoning.

**After all 10 fixes:** PROCEED.
