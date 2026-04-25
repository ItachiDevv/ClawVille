# Reef Race — Phase 3 Detailed Implementation Plan

**Status:** Draft v2 — addresses audit SHA `4cd0c1e`. Phase 1 + Phase 2 merged on master.
**Scope:** Stat connection — pet `level` + `archetype` apply per-body multipliers to the existing Phase 1+2 sim.
**Owners:** orchestrator (sim, config, room-manager seam, store, HUD), 3da NOT required (no scene/material/geometry changes).

---

## Changelog

### v2 — addresses audit SHA `4cd0c1e` (2026-04-24)

**Critical fixes:**

- **C1 (anti-cheat):** `REEF_KINEMATIC_TOLERANCE` bumped `2.0 → 2.1`. Worst-case Phase 3 stack delivers a 34.1 wu position step vs the new 35.0 wu validator allowance — 0.9 wu of headroom (~2.6%). Audit-confirmed: at 2.0 the validator FLAGS (not just clamps) on every overshoot, and 5 flags trip `FLAG_FORFEIT_THRESHOLD`. Math worked end-to-end in §5; ultrathink confirms cheaters cannot slip through (velocity validator at the same tolerance still catches sustained over-velocity).
- **C2 (sync data flow):** `liveTransitionFn` signature widened to `(room: Room) => Promise<void> | void`; `persistLiveTransition` awaits it; the matchmaker in `index.ts` pre-loads profiles via `await loadRacingProfiles(...)` BEFORE `reefRaceSim.startRoom(...)` is invoked. No async IIFE, no tick-0 race. The Drizzle pool query is ~1–2 ms — well below tick budget.
- **C3 (slipstream naming):** unified on `slipstreamGraceTicks`. Dropped `AGILITY_SLIPSTREAM_WINDOW_MS = 2200` and `slipstreamRequiredTicks` field; replaced with `AGILITY_SLIPSTREAM_GRACE_TICKS = 24` (=800 ms post-leave grace) and `PHASE3_MULT_CLAMP_SLIPSTREAM_GRACE_TICKS = [6, 30] as const`. §1 builder, §2 body field, §4c consumption site, §8 tests all agree.

**Significant fixes:**

- **N1 / pre-existing velocity-validator bug:** Phase 3 changes anti-cheat tolerance and so OWNS this fix. `validateReefVelocityDelta(prevV, prevV, dt, ...)` at `reef-race-sim.ts:1213` is rewritten to compare `prevV` against the new velocity post-acceleration step. New test in §8 (P3-T15).
- **S1 (turn-radius compound):** replaced multiplicative `accelMult × (1/turnRadiusMult)` with `max(accelMult, 1/turnRadiusMult)` in §4b. Drops worst-case per-tick gain from 98 wu/s to 83 wu/s, leaving even more validator headroom (used to size the 2.1 tolerance — see §5). Same gameplay feel: agility still gets snappier turning, level-50 still gets faster recovery, but they don't COMPOUND.
- **S3 (seeker-jelly):** explicit patch added to §4e — `impulse = REEF_MAX_SPEED * 0.6 * best.mults.knockbackResistMult`.
- **S4 (bot ribbon-asymmetry):** documented in §6 as a deliberate Phase 3.5 telemetry signal.
- **S5 (HUD wire format):** `RoomMeta.reefRacingProfiles: Record<petId, { class, level }>` (one-shot room-wide, ~50 bytes × ≤8 = ≤400 bytes), client filters by self petId. Cleaner than per-client routing.
- **S6:** verified `apps/api/src/services/activity/sim/__tests__/reef-race-config.test.ts` does NOT exist today — new file, no append vs replace ambiguity.
- **Phase 3.5 telemetry hook (audit verdict e):** `reef_race.bot_winrate.by_level_bucket` event added to §6 + §10.

**Minor fixes:**

- **N2 (Town Guide knowledge):** expanded from 1 line to 3 — overview + 14→4 mapping + headline mults per class.
- **N3 (constant naming):** `LEVEL_ACCEL_MULT_AT_50` → `LEVEL_ACCEL_MULT_CEILING`.
- **N4 (mutability):** clone `NEUTRAL_BODY_MULTIPLIERS` per body via `{ ...NEUTRAL_BODY_MULTIPLIERS }` to prevent cross-room mutation poisoning.
- **N5 (comment):** rewrote the round-half-up comment in §2 to explain JS Math.round semantics correctly.
- **N6 (init):** added a sentence to §4c noting `slipstreamGraceTicksLeft = 0` initialization is unchanged from Phase 2.

**Test additions:** P3-T15 (velocity-validator no-op fix), P3-T16 (worst-case stack does NOT flag at tolerance 2.1), P3-T17 (cross-pet agility human + neutral bot), P3-T18 (bot reads ribbons through global half-width), P3-C6 (multiplier-clone safety), P3-T11 rescoped (sync load — first tick uses correct mults).

**Audit-confirmed verdicts (no plan change needed but documented):** (a) 14→4 mapping; (d) no schema migration; (f) Phase 1 T3 compatibility.

---

## Hard invariants (locked)

- Top-speed cap (`REEF_MAX_SPEED = 500 wu/s`) is unchanged across all archetypes — skill ceiling > stat ceiling.
- All multipliers default to `1.0` (or to today's literal value); a neutral pet with no archetype + level 1 races identically to today.
- Phase 1 anchors (C1–C6, S4–S6, S10–S11) and Phase 2 anchors (combined kinematic arithmetic, `BotRoomView`, `event.power_up_collected.kind`, N12 grace gating) MUST NOT regress.
- No per-frame allocations. No kill-switches. Bots default to neutral mults so a human's stat investment shows against a fixed baseline.
- `REEF_KINEMATIC_TOLERANCE` is the ONE constant changing in the anti-cheat surface — bump from 2.0 → 2.1, justified in §5.

---

## 0. Source-code baseline audit (verified)

Citations are `path:line` from this worktree (`worktree-fix-bumper-build`).

1. **Pet schema today** has BOTH a string `archetype` enum AND a numeric `stats` JSON — they are **separate fields**, not the same axis the high-level plan implied.
   - String archetype column: `packages/database/src/schema/pets.ts:101-102` — `archetype: varchar('archetype', { length: 50 }).notNull()`. Allowed IDs: `brave-adventurer | curious-scholar | mischievous-trickster | gentle-healer | fierce-battler | creative-dreamer | noble-guardian | cunning-trader | mystical-seer | loyal-companion | wild-explorer | royal-diplomat | chaotic-jester | quiet-mystic` (`packages/shared/src/constants/pet-archetypes.ts:1-15`).
   - Numeric stats: `packages/database/src/schema/pets.ts:113` — `stats: jsonb('stats').$type<PetStatsJson>().notNull()`. `PetStatsJson = { strength: number; defence: number; movement: number }` (`packages/database/src/schema/pets.ts:66-70`; `packages/shared/src/types/pet.ts:18-22`).
   - Level column: `packages/database/src/schema/pets.ts:128` — `level: integer('level').default(1).notNull()`.
2. **The high-level plan's `agility/strength/intelligence` axes do not exist as archetype IDs.** They exist conceptually inside `stats: { strength, defence, movement }` (numeric, 0–100 today) but the plan asked for **archetype-driven** multipliers, not stat-vector ones. **Resolution (locked in §1):** Phase 3 introduces a derived `racingClass: 'agility' | 'strength' | 'intelligence' | 'balanced'` derived deterministically from the existing 14-archetype string column, NOT a schema change. **Audit verdict (a) AGREE** — bucketing is defensible (mobility + scout flavored → agility; combative + protective → strength; cerebral + analytical → intelligence; social/companion → balanced). Mapping locked in §1.
3. **Pet data is NOT fetched at room-allocation time today.** `activity-queue.ts:664-694` constructs participants with only `{ petId, userId, agentId, subjectType, partyId }`; `RoomParticipant` interface (`apps/api/src/services/activity/types.ts:65-78`) has no level/archetype fields. The reward pipeline does fetch `pets.flags + pets.isGuest` (`apps/api/src/services/activity/reward-pipeline.ts:445-455`) — that's the model for the new Phase 3 fetch.
4. **Sim entry seam** is `liveTransitionFn` — `apps/api/src/index.ts:341-358` calls `reefRaceSim.startRoom(room.id, room.activityId, participantIds, { bots, startedAt, launchBoosts })`. `participantIds` is `Array.from(room.participants.keys())` — no profile data passed.
5. **`liveTransitionFn` signature TODAY:** `(room: Room) => void` at `activity-room-manager.ts:175`. Invoked synchronously inside the async `persistLiveTransition` at line 845 (`this.liveTransitionFn(room)`). **Phase 3 widens this to `(room: Room) => Promise<void> | void` and `await`s it from `persistLiveTransition`** so the matchmaker can pre-load profiles before `startRoom` runs (audit fix C2).
6. **Sim body initialization** at `apps/api/src/services/activity/sim/reef-race-sim.ts:457-527` constructs each `ReefBody` with hard-coded defaults; this is where Phase 3 attaches the seven multiplier fields.
7. **Multiplier consumption sites in the sim today (read these, then `§4` modifies them):**
   - Acceleration cap (`REEF_MAX_ACCEL`): `reef-race-sim.ts:1006` — `const maxStep = REEF_MAX_ACCEL * dt;` inside `applyIntentForTick` step 9. **No other accel call-site.**
   - Turn radius is **emergent** from the dt-bounded velocity rotation toward the input-direction target — there is no explicit "turn radius" constant. The relevant code is `applyIntentForTick` steps 6–9 (lines 974–1009). Specified §4b.
   - Slipstream window: `SLIPSTREAM_REQUIRED_TICKS = 45` (`reef-race-config.ts:452`) is the **hold-to-arm** time; `SLIPSTREAM_GRACE_TICKS = 6` is the **post-leave grace** during which the boost lingers (consumed in `resolveSlipstream` at `reef-race-sim.ts:1934`). Phase 3 extends GRACE only — REQUIRED stays at 45 (audit fix C3, see §4c).
   - Drift charge thresholds: `DRIFT_SPARK_TICK_1=12, _2=27, _3=45` (`reef-race-config.ts:326-328`) consumed in `tickDriftState` (`reef-race-sim.ts:1059-1067`).
   - Knockback: there is **no kart-vs-kart knockback** today — `resolveProximity` (`reef-race-sim.ts:1261-1284`) is a "light separation push only — no knockback in a race." Two real knockback sources: `applyTideWave` (`reef-race-sim.ts:1493-1518`, scales target velocity by `1 - factor`) and `applySeekerJelly` (`reef-race-sim.ts:1548-1550`, applies `REEF_MAX_SPEED * 0.6` impulse). Both patched in §4e.
   - Power-up duration: `body.activeEffects.set(kind, now + def.effectMs)` in `tryUsePowerUp` (`reef-race-sim.ts:1475`). One call-site for all four duration-bearing pickups.
   - Ribbon detect radius: half-width band `RIBBON_HALF_WIDTH = 35 wu` (`reef-race-config.ts:522`), consumed via `isOnRibbon` helper (`reef-race-sim.ts:2246`).
8. **Anti-cheat tolerance:** `REEF_KINEMATIC_TOLERANCE = 2.0` (`reef-race-config.ts:389`) gates the position+velocity validators in `integrateMotion` (`reef-race-sim.ts:1213, 1226`). The current Phase 2 worst-case combined positive stack is `KINEMATIC_BOOST_CAP = 0.85` → `1.85× × 500 = 925 wu/s`. Phase 3 worst-case lifts the per-tick acceleration step by `max(1.25, 1.176) = 1.25×` (S1 fix replaces compound with max). **Phase 3 raises tolerance to 2.1** to absorb the extra single-tick position delta from the boosted acceleration step. Math in §5.
9. **`validateReefVelocityDelta(prevV, prevV, ...)` at `reef-race-sim.ts:1213` is a no-op.** Pre-existing bug (audit N1). Since Phase 3 changes the anti-cheat tolerance constant, this fix is in scope: rewrite the call to pass the post-acceleration velocity. New test P3-T15.
10. **HUD subscription pattern** consumes primitives only — `useActivityStore((s) => s.driftSparks)` (line 25 of `reef-race-hud.tsx`). Maps are NOT subscribed per-tick; per the audit-verified pattern, new HUD reads from `s.selfRacingClass` + `s.selfLevel` primitives populated once on `snapshot.init`.
11. **Bot pool** has no per-bot stats today — `bot-pool.ts:38, 75-77` selects only `pets.id, pets.name`. Phase 3 keeps this and treats bots as neutral (no archetype, level 1) by short-circuiting in the profile loader (§3 + §6).

---

## 1. Stat → multiplier mapping (constants)

All constants live in `apps/api/src/services/activity/sim/reef-race-config.ts` in a new section block `// ─── Phase 3 — stat-driven body multipliers ─────────────────────────────────`. Defaults set so a missing/unknown archetype + level 1 gives the literal `1.0` everywhere.

```ts
// Level → acceleration recovery multiplier.
//   per-level mult = 1 + 0.005 × (level - 1), CLAMPED to [1.0, LEVEL_ACCEL_MULT_CEILING].
//   level=1   → 1.000   (today's behavior)
//   level=25  → 1.120   (bot default)
//   level=50  → 1.245
//   level=51+ → 1.250 (clamped at ceiling)
//
// N3 fix: name the ceiling for what it is (a clamp), not the value at any
// specific level — the formula reaches 1.245 at level 50, not 1.25.
export const LEVEL_ACCEL_MULT_CEILING = 1.25;
export const LEVEL_ACCEL_MULT_PER_LEVEL = 0.005;

// Archetype-class multipliers — see racingClassFromArchetype() below for
// the 14-archetype → 4-class mapping. 'balanced' archetype applies 1.0 to
// every field.
export const AGILITY_TURN_RADIUS_MULT          = 0.85;  // tighter (lower = tighter)
export const AGILITY_SLIPSTREAM_GRACE_TICKS    = 24;    // 800ms post-leave grace vs SLIPSTREAM_GRACE_TICKS=6 (200ms) baseline
export const STRENGTH_DRIFT_CHARGE_MULT        = 1.4;   // sparks faster
export const STRENGTH_KNOCKBACK_RESIST_MULT    = 0.6;   // takes 60% of normal knockback
export const INTELLIGENCE_POWERUP_DURATION_MULT = 1.2;  // pickups last 20% longer
export const INTELLIGENCE_RIBBON_DETECT_MULT    = 1.3;  // ribbon band 30% wider

// Hard clamp ranges so a malformed pet (level 999, NaN mult) can't break
// the sim. Applied at multiplier-construction time, NOT inside the hot loop.
export const PHASE3_MULT_CLAMP_ACCEL                  = [1.0, 1.25] as const;
export const PHASE3_MULT_CLAMP_TURN_RADIUS            = [0.70, 1.00] as const;
export const PHASE3_MULT_CLAMP_SLIPSTREAM_GRACE_TICKS = [6, 30] as const;  // C3 fix — was SLIPSTREAM_MS
export const PHASE3_MULT_CLAMP_DRIFT_CHARGE           = [1.00, 1.50] as const;
export const PHASE3_MULT_CLAMP_KNOCKBACK_RES          = [0.50, 1.00] as const;
export const PHASE3_MULT_CLAMP_POWERUP_DUR            = [1.00, 1.50] as const;
export const PHASE3_MULT_CLAMP_RIBBON_DETECT          = [1.00, 1.50] as const;

// C1 fix — bump REEF_KINEMATIC_TOLERANCE from 2.0 to 2.1. See §5 for math
// proof + the velocity-validator fix it pairs with.
//
// SAFETY: This is the second time this constant has moved (Phase 1 audit C3
// raised it 1.5 → 2.0). Phase 3 needs an extra ~5% to absorb the per-tick
// acceleration step boosted by max(accelMult=1.25, 1/turnRadiusMult=1.176)
// = 1.25× during corner entry. Unrelated to Phase 2 stacking — Phase 2
// only uses the 0.85 KINEMATIC_BOOST_CAP (1.85× speed mod) which the 2.0
// tolerance was sized for. Phase 3's level-50 acceleration recovery only
// fires post-collision but the validator counts every tick, so the cap
// raise is a one-time bump that won't compound across phases (no Phase 4
// consumer is planned for this constant).
//
// Cheat-detection still works: a teleporting cheater gets caught by the
// velocity validator at the same 2.1 tolerance — REEF_MAX_SPEED × 2.1 =
// 1050 wu/s hard speed cap. The 5% delta on the position validator is
// dwarfed by the legitimate 1.85× boost stack a clean player can already
// produce, so no new exploit surface opens.
export const REEF_KINEMATIC_TOLERANCE = 2.1;  // was 2.0 (Phase 1 C3 raised 1.5→2.0)
```

### Racing class derivation

Pure-function, lives next to constants in `reef-race-config.ts`:

```ts
export type RacingClass = 'agility' | 'strength' | 'intelligence' | 'balanced';

// Maps the 14 PetArchetypeIds to a 4-bucket racing class. Source-of-truth
// rationale (one-liner per archetype). AUDIT VERDICT (a) AGREE.
//   - agility:        physically nimble + scout-flavored
//   - strength:       combative + protective + steadfast
//   - intelligence:   cerebral + analytical + diplomatic + knowledge-flavored
//   - balanced:       social/whimsical/companion archetypes that don't lean
const ARCHETYPE_RACING_CLASS_MAP: Record<string, RacingClass> = {
  // Agility — scouts, tricksters, explorers
  'mischievous-trickster': 'agility',
  'wild-explorer':         'agility',
  'chaotic-jester':        'agility',

  // Strength — battlers, guardians, adventurers
  'brave-adventurer':      'strength',
  'fierce-battler':        'strength',
  'noble-guardian':        'strength',

  // Intelligence — scholars, seers, traders, mystics, diplomats
  'curious-scholar':       'intelligence',
  'mystical-seer':         'intelligence',
  'cunning-trader':        'intelligence',
  'royal-diplomat':        'intelligence',
  'quiet-mystic':          'intelligence',

  // Balanced — social/companion archetypes
  'gentle-healer':         'balanced',
  'creative-dreamer':      'balanced',
  'loyal-companion':       'balanced',
};

export function racingClassFromArchetype(archetype: string | null | undefined): RacingClass {
  if (!archetype) return 'balanced';
  return ARCHETYPE_RACING_CLASS_MAP[archetype] ?? 'balanced';
}
```

**Why a derived class, not a column add (audit verdict (d) AGREE):** day 1 Phase 3 must NOT touch the DB schema (zero migration risk; ships in one PR). The 4-class bucketing keeps the matrix manageable — 14 archetypes × 7 multipliers = 98 cells of test surface, infeasible to balance. 4 classes × 7 mults = 28 cells, tractable. Pure-function derivation is auditable and reversible (no backfill if we change a bucket assignment).

**Locked invariant:** `'balanced'` returns 1.0 from EVERY mult builder. A future audit can add per-archetype tuning by replacing the bucketing with a per-archetype lookup, but the 4-class API stays.

### Multiplier builder

Pure function, lives in `reef-race-config.ts`:

```ts
export interface PetRacingProfile {
  petId: string;
  level: number;
  archetype: string | null;
  isBot: boolean;
}

export interface BodyMultipliers {
  accelMult: number;
  turnRadiusMult: number;
  slipstreamGraceTicks: number;       // C3 fix — renamed from slipstreamRequiredTicks
  driftChargeMult: number;
  knockbackResistMult: number;
  powerUpDurationMult: number;
  ribbonDetectMult: number;
}

// N4 fix: declare as `as const` so callers MUST clone before assigning to
// body.mults. The body init site below does the clone explicitly.
export const NEUTRAL_BODY_MULTIPLIERS = {
  accelMult: 1.0,
  turnRadiusMult: 1.0,
  slipstreamGraceTicks: SLIPSTREAM_GRACE_TICKS,  // 6 ticks = today's literal
  driftChargeMult: 1.0,
  knockbackResistMult: 1.0,
  powerUpDurationMult: 1.0,
  ribbonDetectMult: 1.0,
} as const satisfies BodyMultipliers;

export function buildBodyMultipliers(profile: PetRacingProfile | null | undefined): BodyMultipliers {
  if (!profile)         return { ...NEUTRAL_BODY_MULTIPLIERS };  // N4 fix — clone
  if (profile.isBot)    return { ...NEUTRAL_BODY_MULTIPLIERS };  // bots neutral §6

  const safeLevel = Number.isFinite(profile.level) ? profile.level : 1;
  const accelRaw  = 1 + LEVEL_ACCEL_MULT_PER_LEVEL * Math.max(0, safeLevel - 1);
  const accelMult = clamp(accelRaw, PHASE3_MULT_CLAMP_ACCEL[0], PHASE3_MULT_CLAMP_ACCEL[1]);

  const cls = racingClassFromArchetype(profile.archetype);

  // C3 fix: agility extends GRACE (post-leave window, a buff), not REQUIRED
  // (hold-to-arm, would be a nerf). REQUIRED stays at 45 ticks for everyone.
  const slipstreamGraceTicks = clamp(
    cls === 'agility' ? AGILITY_SLIPSTREAM_GRACE_TICKS : SLIPSTREAM_GRACE_TICKS,
    PHASE3_MULT_CLAMP_SLIPSTREAM_GRACE_TICKS[0],
    PHASE3_MULT_CLAMP_SLIPSTREAM_GRACE_TICKS[1],
  );

  return {
    accelMult,
    turnRadiusMult:        cls === 'agility'      ? AGILITY_TURN_RADIUS_MULT          : 1.0,
    slipstreamGraceTicks,
    driftChargeMult:       cls === 'strength'     ? STRENGTH_DRIFT_CHARGE_MULT        : 1.0,
    knockbackResistMult:   cls === 'strength'     ? STRENGTH_KNOCKBACK_RESIST_MULT    : 1.0,
    powerUpDurationMult:   cls === 'intelligence' ? INTELLIGENCE_POWERUP_DURATION_MULT : 1.0,
    ribbonDetectMult:      cls === 'intelligence' ? INTELLIGENCE_RIBBON_DETECT_MULT    : 1.0,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
```

---

## 2. Per-body multiplier fields

Extend `interface ReefBody` (`apps/api/src/services/activity/sim/reef-race-sim.ts:174-257`) with TWO new fields under a new `// ─── Phase 3 ───` block:

```ts
interface ReefBody {
  // ... existing fields ...

  // ─── Phase 3 — pet-stat-driven multipliers (computed once at startRoom) ─
  /**
   * Pet-stat-driven per-body multipliers. Read-only after init.
   *
   * Always a per-body CLONE (never the global NEUTRAL_BODY_MULTIPLIERS
   * reference) so a debug helper / future refactor cannot poison the
   * neutral baseline (audit N4).
   */
  mults: BodyMultipliers;

  // ─── Phase 3 — pre-computed drift spark thresholds (in ticks) ──────────
  /**
   * Per-body drift spark thresholds, derived once at startRoom from
   * `mults.driftChargeMult`. Stored as pre-rounded integers so the hot loop
   * (`tickDriftState` line 1059-1067) reads a 3-tuple instead of dividing.
   *
   *   strength (mult=1.4): [9, 19, 32]  (vs neutral [12, 27, 45])
   *   neutral  (mult=1.0): [12, 27, 45]
   *
   * Math: Math.round(threshold / mult). JS Math.round uses round-half-up
   * for positive numbers (per ECMA-262), so 12/1.4 = 8.571 → 9, 27/1.4 =
   * 19.286 → 19, 45/1.4 = 32.143 → 32. Cap min 1 via Math.max(1, ...) so
   * an extreme mult cannot collapse the threshold to 0.
   */
  driftSparkTicks: readonly [number, number, number];
}
```

**Initialization site:** `apps/api/src/services/activity/sim/reef-race-sim.ts:486-526` (the `state.bodies.set(petId, { ... })` block). Add the two fields to the object literal:

```ts
const profile = opts?.petProfiles?.get(petId) ?? null;
const mults = buildBodyMultipliers(profile);  // Already a fresh object per builder.
const driftSparkTicks: readonly [number, number, number] = [
  Math.max(1, Math.round(DRIFT_SPARK_TICK_1 / mults.driftChargeMult)),
  Math.max(1, Math.round(DRIFT_SPARK_TICK_2 / mults.driftChargeMult)),
  Math.max(1, Math.round(DRIFT_SPARK_TICK_3 / mults.driftChargeMult)),
];

state.bodies.set(petId, {
  // ... existing fields ...
  mults,                // CLONE per-body (builder always returns a fresh object)
  driftSparkTicks,
});
```

**Why two fields, not one:** `mults` is the canonical multiplier struct (used by 6 of 7 mechanics); `driftSparkTicks` is the `mults.driftChargeMult` PRE-APPLIED to the three thresholds so the hot loop avoids a division. Same idea as the `currentDriftBoostSparks` Phase-1 cache (line 219).

**Defaults:** if `petProfiles` is missing or has no entry for a petId, `buildBodyMultipliers(null)` returns a clone of `NEUTRAL_BODY_MULTIPLIERS` and `driftSparkTicks = [12, 27, 45]` — identical to today's behavior.

---

## 3. Pet-stat data path

End-to-end SYNCHRONOUS-AWAIT flow (audit fix C2). The matchmaker pre-loads profiles BEFORE `startRoom` runs so the sim never sees `body.mults === undefined`.

### 3a. Fetch pet profiles before sim start

**New file:** `apps/api/src/services/activity/pet-profile-loader.ts`. Mirrors the established Drizzle pattern from `reward-pipeline.ts:445-455`:

```ts
import { db, pets } from '@clawville/database';
import { inArray } from 'drizzle-orm';
import type { PetRacingProfile } from './sim/reef-race-config';

/**
 * Phase 3 — fetch racing profiles for the human/agent participants of a room.
 * Called from `liveTransitionFn` (now async after C2 fix) BEFORE invoking
 * `reefRaceSim.startRoom`. The await blocks for ~1-2 ms (Drizzle pool query
 * to Supabase pooler in the same datacenter) — well below the 33 ms tick
 * budget.
 *
 * Bots are passed in `botPetIds` and short-circuit to neutral profiles
 * (no DB read — bot pool already verified at boot).
 *
 * Returns an empty Map if both arrays are empty. Caller treats missing
 * petIds as neutral (NEUTRAL_BODY_MULTIPLIERS clones).
 */
export async function loadRacingProfiles(
  humanPetIds: string[],
  botPetIds: string[],
): Promise<Map<string, PetRacingProfile>> {
  const out = new Map<string, PetRacingProfile>();
  for (const petId of botPetIds) {
    out.set(petId, { petId, level: 1, archetype: null, isBot: true });
  }
  if (humanPetIds.length === 0) return out;
  try {
    const rows = await db
      .select({ id: pets.id, level: pets.level, archetype: pets.archetype })
      .from(pets)
      .where(inArray(pets.id, humanPetIds));
    for (const row of rows) {
      out.set(row.id, {
        petId: row.id,
        level: row.level ?? 1,
        archetype: row.archetype ?? null,
        isBot: false,
      });
    }
    // Any humanPetId NOT returned by the query gets a neutral fallback —
    // a pet that doesn't exist in the DB at LIVE-time is a bug elsewhere
    // but the sim should not fail because of it.
    for (const petId of humanPetIds) {
      if (!out.has(petId)) {
        out.set(petId, { petId, level: 1, archetype: null, isBot: false });
      }
    }
  } catch (err) {
    console.error('[pet-profile-loader] DB fetch failed, defaulting all to neutral:', err);
    for (const petId of humanPetIds) {
      out.set(petId, { petId, level: 1, archetype: null, isBot: false });
    }
  }
  return out;
}
```

**Performance bound:** 1 query × ≤8 petIds per match × ~5 matches/min = ~5 queries/min. Trivial. Wrapped in try/catch so a DB outage doesn't black-hole races — defaults to neutral.

### 3b. Wire the fetch into `liveTransitionFn` (SYNC-AWAIT — audit fix C2)

**Step 1 — widen the registered signature (`activity-room-manager.ts:175, 690, 845`):**

```ts
// Line 175 — field type
private liveTransitionFn: ((room: Room) => Promise<void> | void) | null = null;

// Line 690 — setter
setLiveTransitionFn(fn: (room: Room) => Promise<void> | void): void {
  this.liveTransitionFn = fn;
}

// Line 845 (inside persistLiveTransition, which is already async) — await
if (this.liveTransitionFn) {
  try {
    await this.liveTransitionFn(room);  // C2 fix: was sync call
  } catch (err) {
    console.error('[activity-room-manager] liveTransitionFn threw:', err);
  }
}
```

The widening is backward-compatible: existing sync callers (`bumper-shells`, `arena`) keep returning `void` and `await`-ing `void` is a no-op. P3-T18 verifies both other registered sims still pass.

**Step 2 — rewrite the LIVE handler in `apps/api/src/index.ts:341-358`:**

```ts
// Replace the existing sync handler with an async one. The handler
// pre-loads profiles BEFORE startRoom so the sim's first tick has correct
// mults — no async IIFE, no tick-0 race condition (audit fix C2).
//
// Handler is registered ONCE at boot via setLiveTransitionFn(); the
// dispatcher inside switches on activityId.
setLiveTransitionFn(async (room) => {
  switch (room.activityId) {
    case 'reef-race': {
      const launchBoosts = activityRoomManager.computeLaunchVerdicts(room);

      // Split human vs bot petIds from the room participants snapshot.
      const humanPetIds: string[] = [];
      const botPetIds:   string[] = [];
      for (const p of room.participants.values()) {
        (p.subjectType === 'bot' ? botPetIds : humanPetIds).push(p.petId);
      }

      // BLOCKING await — typical 1-2 ms. The persistLiveTransition caller
      // is already async, and bots/players are still in COUNTDOWN-fresh
      // state. The 1-2 ms delay is invisible to clients (next snapshot
      // tick wakes the WS hub anyway).
      const petProfiles = await loadRacingProfiles(humanPetIds, botPetIds);

      reefRaceSim.startRoom(room.id, room.activityId, Array.from(room.participants.keys()), {
        bots,
        startedAt: room.startedAt ?? Date.now(),
        launchBoosts,
        petProfiles,
      });
      break;
    }
    case 'bumper-shells':
    case 'arena':
      // ... existing sync paths unchanged ...
      break;
  }
});
```

**Why this is safe:**

1. `persistLiveTransition` is already `async` and is itself `await`-ed by callers — adding one more `await` inside is a 1-2 ms latency bump on the LIVE FSM transition.
2. The existing C4/S10 launch-verdict math is anchored to `room.startedAt` (set BEFORE this point), NOT `Date.now()` — a 1-2 ms shift in the wall clock does not move verdict windows.
3. The broadcast hub's `setBroadcastFn` callback for this room is wired by the WS hub on `startRoom`-completed. Clients connecting in the 1-2 ms window before `startRoom` finishes simply see no snapshots until the next tick — the same behavior as today (the WS hub already throttles to per-tick deltas).

**Test:** `'P3-T11 — sync profile load: first tick uses level-50 accelMult, not 1.0'` (rescoped from v1's "async load" test).

### 3c. Sim signature change

**Edit:** `apps/api/src/services/activity/sim/reef-race-sim.ts:370-394` (`startRoom` signature). Add `petProfiles?: Map<string, PetRacingProfile>` to the opts:

```ts
startRoom(
  roomId: string,
  activityId: string,
  participantPetIds: string[],
  opts?: {
    seed?: number;
    isBot?: (petId: string) => boolean;
    bots?: BotController[];
    startedAt?: number;
    launchBoosts?: Map<string, 'boost' | 'stall'>;
    /**
     * Phase 3 — per-pet racing profile (level + archetype) for body
     * multiplier construction. Missing petIds default to neutral (1.0).
     * Bots default to neutral via `pet-profile-loader.ts`.
     */
    petProfiles?: Map<string, PetRacingProfile>;
  },
): ReefRoomState
```

Inside the body-init loop (line 457), follow §2 — call `buildBodyMultipliers(opts?.petProfiles?.get(petId) ?? null)` per pet, build `driftSparkTicks`, stamp both on the body.

**Bot default:** `opts?.bots?.find(b => b.petId === petId)` exists OR `opts?.isBot?.(petId)` returns true → profile entry built with `isBot: true` → `buildBodyMultipliers` short-circuits to a clone of neutral (decision §6).

---

## 4. Sim integration (per-multiplier consumption)

For each multiplier, the exact call-site change. Line numbers reference current master.

### 4a. `accelMult` — acceleration recovery from collisions

**Where:** `applyIntentForTick` step 9 (line 1006).

**Today:**
```ts
const maxStep = REEF_MAX_ACCEL * dt;
```

**Phase 3:**
```ts
const baseMaxStep = REEF_MAX_ACCEL * dt * body.mults.accelMult;
```

(`baseMaxStep` is the input to §4b's turn-bonus combine. See §4b for the full final-`maxStep` line.)

**Why this counts as "recovery from collisions":** the `maxStep` is the per-tick velocity-vector convergence cap toward `targetVx/Vy`. After a knockback (`applyTideWave` scales velocity down by up to 40%, `applySeekerJelly` deflects), the body's velocity magnitude drops below `target`; the next tick's `dvx/dvy = target - body.v` is large; level-50 with `accelMult=1.25` recovers 25% faster. The TOP-SPEED CAP is unchanged (`baseTopSpeed = REEF_MAX_SPEED * speedMod`, line 968) — only the recovery rate moves.

**Anti-cheat impact:** see §5 for combined math after S1's `max(...)` change.

### 4b. `turnRadiusMult` — tighter turning for agility (S1 FIX — `max(...)` not multiplicative)

**Where:** "Turn radius" is emergent (audit §0 finding). The effective knob is the velocity convergence rate — `maxStep` from §4a. A "tighter turn" means the BODY trajectory follows the new heading faster after `intent.dir` swings.

**Decision (locked, S1 audit fix):** apply `1/turnRadiusMult` as a REPLACEMENT for `accelMult` during turning ticks via `Math.max(...)`, NOT a multiplicative compound. This keeps the same gameplay handle (agility pets feel snappier in corners) but does NOT compound with `accelMult` — the worst-case per-tick gain is `max(1.25, 1.176) = 1.25×`, not `1.25 × 1.176 = 1.47×`. That math drops worst-case position delta under the tolerance budget (§5).

**Phase 3 code (lines 1002–1009):**

```ts
// 9. Integrate acceleration toward target. Phase 3 — agility tightens the
//    turn by GREATER acceleration during direction-change ticks. Detected
//    via the angle between current velocity and the input direction;
//    cosTheta < 0.97 (~14°) triggers the turn-bonus path. The turn bonus
//    REPLACES (not compounds with) accelMult — see audit S1.
const dvx = targetVx - body.vx;
const dvy = targetVy - body.vy;
const dv = Math.hypot(dvx, dvy);
const baseMaxStep = REEF_MAX_ACCEL * dt * body.mults.accelMult;
let maxStep = baseMaxStep;
if (intent.dir && body.mults.turnRadiusMult < 1.0) {
  const speed = Math.hypot(body.vx, body.vy);
  if (speed > REEF_MAX_SPEED * 0.10) {
    // S2: intent.dir is normalized at applyInput time (verify in
    // applyInput; if not, the dirMag fallback below stays).
    const dirMag = Math.hypot(intent.dir.x, intent.dir.y) || 1;
    const cosTheta = (body.vx * intent.dir.x + body.vy * intent.dir.y) / (speed * dirMag);
    // cosTheta < 0.97 ≈ angle > 14°.
    if (cosTheta < 0.97) {
      // S1 fix: REPLACE accelMult with the larger of (accelMult,
      // 1/turnRadiusMult), don't compound. Worst-case stack still produces
      // a gameplay-meaningful turn bonus (an agility level-50 pet uses
      // max(1.25, 1.176) = 1.25× — slightly worse than v1's 1.47× but
      // 30% over the validator vs v1's 47% over).
      const turnBonus = 1 / body.mults.turnRadiusMult;
      maxStep = REEF_MAX_ACCEL * dt * Math.max(body.mults.accelMult, turnBonus);
    }
  }
}
const scale = dv === 0 ? 0 : Math.min(1, maxStep / dv);
body.vx += dvx * scale;
body.vy += dvy * scale;
```

**Anti-cheat impact:** with `accelMult=1.25` and `1/turnRadiusMult=1.176`, peak `maxStep = REEF_MAX_ACCEL * dt * 1.25 = 83.3 wu/s per tick` (NOT 98 — the max replaces, doesn't compound). Same position-validator analysis as §4a — bounded by speed cap, no flag (verified §5 with new `REEF_KINEMATIC_TOLERANCE = 2.1`).

**No new allocation:** the `cosTheta` branch reuses `intent.dir` and `body.vx/vy` — no new objects. ~5 add/mul/div ops per tick per body when agility is engaged in turning, none otherwise.

### 4c. `slipstreamGraceTicks` — longer wake window for agility (C3 FIX — grace not required)

**Where:** `resolveSlipstream`, `reef-race-sim.ts:1934`.

**Today:**
```ts
self.slipstreamGraceTicksLeft = SLIPSTREAM_GRACE_TICKS;
```

**Phase 3:**
```ts
self.slipstreamGraceTicksLeft = self.mults.slipstreamGraceTicks;
```

**Semantics (locked):** agility EXTENDS the post-leave grace window — the period after exiting a wake during which the slipstream boost lingers. `SLIPSTREAM_REQUIRED_TICKS = 45` (the hold-to-arm time) is UNCHANGED for everyone — agility pets do NOT have to wait longer. Total "slipstream-aware" window for agility = `1500 ms hold + 800 ms grace = 2300 ms` (~2200 ms target). For balanced/strength/intelligence: `1500 ms hold + 200 ms grace = 1700 ms`.

**This is a BUFF, not a NERF.** Audit C3 confirmed v1's mid-doc rename was correct in direction but the §1 builder still used the wrong knob. v2 unifies everything on `slipstreamGraceTicks`.

**Init unchanged (audit N6):** Phase 1+2 bodies init `slipstreamGraceTicksLeft = 0` (verified `reef-race-sim.ts:486-526`); Phase 3 doesn't change init — agility's bonus only kicks in when `resolveSlipstream` ASSIGNS the new value at line 1934. No body-init change needed.

### 4d. `driftChargeMult` — sparks faster for strength

**Where:** `tickDriftState`, `reef-race-sim.ts:1058-1067`.

**Today:**
```ts
const elapsed = state.tick - body.drift.chargeStartTick;
body.drift.sparkLevel =
  elapsed >= DRIFT_SPARK_TICK_3
    ? 3
    : elapsed >= DRIFT_SPARK_TICK_2
      ? 2
      : elapsed >= DRIFT_SPARK_TICK_1
        ? 1
        : 0;
```

**Phase 3:**
```ts
const elapsed = state.tick - body.drift.chargeStartTick;
const [t1, t2, t3] = body.driftSparkTicks;
body.drift.sparkLevel =
  elapsed >= t3 ? 3 : elapsed >= t2 ? 2 : elapsed >= t1 ? 1 : 0;
```

**Computed at startRoom (§2):** `driftSparkTicks` = `[Math.max(1, Math.round(DRIFT_SPARK_TICK_1 / mult)), ...]`. For strength (`mult=1.4`): `[9, 19, 32]` (vs neutral `[12, 27, 45]`). For neutral: `[12, 27, 45]` — bit-identical to today. The `DRIFT_SPARK_TICK_*` constants themselves are NEVER mutated, so Phase 1 T3 (`reef-race-sim.test.ts:404`, audit verdict (f)) keeps passing.

### 4e. `knockbackResistMult` — strength takes 40% less knockback (S3 FIX — seeker-jelly explicit)

**Where:** TWO call-sites.

**`applyTideWave` (`reef-race-sim.ts:1493-1518`)** — lines 1505-1509:
```ts
// Today:
if (speed > 0) {
  const factor = 0.4 * (1 - dist / radius);
  target.vx *= 1 - factor;
  target.vy *= 1 - factor;
}
// Phase 3:
if (speed > 0) {
  const factor = 0.4 * (1 - dist / radius) * target.mults.knockbackResistMult;
  target.vx *= 1 - factor;
  target.vy *= 1 - factor;
}
```

**`applySeekerJelly` (`reef-race-sim.ts:1548-1550`)** — explicit S3 patch:
```ts
// Today:
const impulse = REEF_MAX_SPEED * 0.6;
best.vx += nx * impulse;
best.vy += ny * impulse;

// Phase 3:
const impulse = REEF_MAX_SPEED * 0.6 * best.mults.knockbackResistMult;
best.vx += nx * impulse;
best.vy += ny * impulse;
```

Strength target with `knockbackResistMult = 0.6` takes a `300 × 0.6 = 180 wu/s` impulse instead of 300.

**Anti-cheat impact:** none — knockback resistance REDUCES velocity-jump, which can only make validators happier. No new flags.

### 4f. `powerUpDurationMult` — intelligence pickups last 20% longer

**Where:** `tryUsePowerUp`, `reef-race-sim.ts:1475`.

**Today:**
```ts
case 'rr-turbo-bubble':
case 'rr-bubble-shield':
case 'rr-ink-slick':
case 'rr-whirlpool':
  body.activeEffects.set(kind, now + def.effectMs);
  break;
```

**Phase 3:**
```ts
case 'rr-turbo-bubble':
case 'rr-bubble-shield':
case 'rr-ink-slick':
case 'rr-whirlpool':
  body.activeEffects.set(kind, now + def.effectMs * body.mults.powerUpDurationMult);
  break;
```

**Clarification:** turbo-bubble's `effectMs=2500` becomes `3000ms` for intelligence. The `REEF_BOOST_MULT=1.4` speed multiplier is unchanged; only DURATION extends.

**Anti-cheat impact:** none — `effectMs` is a wall-clock duration, not a kinematic constant. The validators check per-tick deltas, not per-effect durations.

**Pickups not in the switch (`rr-tide-wave`, `rr-seeker-jelly`):** they're INSTANT effects (`effectMs=0` per `REEF_POWERUP_DEFS` in `reef-race-config.ts:262-270`). Multiplying their duration is a no-op.

### 4g. `ribbonDetectMult` — wider ribbon band for intelligence

**Where:** `isOnRibbon` helper (`reef-race-sim.ts:2246`):

**Today:**
```ts
return perpSq <= RIBBON_HALF_WIDTH * RIBBON_HALF_WIDTH;
```

**Phase 3:** the helper signature gets a new `halfWidth` argument with the existing constant as default:
```ts
function isOnRibbon(body: { x: number; y: number }, ribbon: ReefBoostRibbon, halfWidth: number = RIBBON_HALF_WIDTH): boolean {
  // ... same body, but use halfWidth for the squared comparison ...
  return perpSq <= halfWidth * halfWidth;
}
```

Caller in `resolveBoostRibbons` (line 2004):
```ts
if (!isOnRibbon(body, ribbon, RIBBON_HALF_WIDTH * body.mults.ribbonDetectMult)) continue;
```

**Anti-cheat impact:** none — wider band = more ribbons collected per lap. Boost mult unchanged. Per-lap dedupe still applies.

---

## 5. Anti-cheat invariants — UPDATED with C1/S1/N1 fixes

### Worst-case combined-mult math (Phase 2 + Phase 3 stacked)

Given:
- Top-speed cap: `REEF_MAX_SPEED = 500 wu/s` (unchanged).
- `REEF_BOOST_MULT = 1.4` (turbo, multiplicative on top-speed → max steady = 700 wu/s).
- Combined positive kinematic stack capped at `KINEMATIC_BOOST_CAP = 0.85` → max additive boost = +85% → max `speedMod = 1.85`.
- Hard velocity cap: `REEF_MAX_SPEED * 1.85 = 925 wu/s` (line 1253, gated on positive boost active).

**Phase 3 additions to MAX-STEP (acceleration, NOT speed):**
- `accelMult ∈ [1.0, 1.25]` (level 50 ceiling)
- `1/turnRadiusMult ∈ [1.0, 1/0.85] ≈ [1.0, 1.176]` (agility, when turning)
- **Combined max (S1 fix — `Math.max(...)`, not compound):** `max(1.25, 1.176) = 1.25×` to `REEF_MAX_ACCEL`.

Effective per-tick velocity gain: `REEF_MAX_ACCEL * dt * 1.25 = 2000 * 0.0333 * 1.25 = 83.3 wu/s per tick`.

**Worst-case position delta in one tick:**
- Body at peak boost, peak velocity = 925 wu/s steady (hard-capped).
- Plus an instantaneous +83.3 wu/s from acceleration step → 1008.3 wu/s peak velocity for that tick.
- `dt × peak velocity = 0.0333 × 1008.3 = 33.6 wu`.
- **Validator allows (NEW tolerance 2.1):** `dt × REEF_MAX_SPEED × tolerance = 0.0333 × 500 × 2.1 = 35.0 wu`.
- **Headroom: 1.4 wu under the validator. NO clamp, NO flag, NO forfeit.**

(Earlier v1 stated 34.1 wu under v1's compounded `1.47×` and a 33.3 wu tolerance — over by 0.8 wu → would FLAG. v2 with S1 + C1 has 1.4 wu of headroom in the worst case.)

### Why the 2.1 tolerance is also safe against cheaters (ultrathink)

A teleporting cheater would attempt to bypass the integrator and stamp a position outside the per-tick budget. The validator catches this: at `tolerance=2.1`, max single-tick legitimate position step = 35 wu. The 1.7 wu/tick gap vs the prior 33.3 wu cap × 30 Hz = 51 wu/s of "extra" speed a cheater could sustain → equivalent to 10.2% extra over `REEF_MAX_SPEED`. That's already swamped by the legitimate `1.85×` boost stack a clean player can produce (a clean player at peak boost = 925 wu/s; the cheater's "extra" 51 wu/s pushes them to 976 wu/s, still well under the velocity validator's `REEF_MAX_SPEED × 2.1 = 1050 wu/s` hard speed cap). Sustained over-velocity > 1050 wu/s gets caught by `validateReefVelocityDelta` (now correctly wired — see N1 below). No new exploit surface opens.

### N1 — `validateReefVelocityDelta(prevV, prevV, ...)` no-op fix (Phase 3 owns)

Pre-existing bug at `reef-race-sim.ts:1213` passing `prevV` as both `prev` and `next` makes the velocity validator a no-op. Since Phase 3 changes the anti-cheat tolerance constant and the velocity validator is the cheat-detection backstop for the C1 tolerance bump, this fix is in scope for Phase 3 (NOT deferred to a follow-up).

**Patch:**
```ts
// reef-race-sim.ts:1213 — Today (BUG):
const velCheck = validateReefVelocityDelta(prevV, prevV, dt, REEF_KINEMATIC_TOLERANCE);

// Phase 3:
const velCheck = validateReefVelocityDelta(prevV, { x: body.vx, y: body.vy }, dt, REEF_KINEMATIC_TOLERANCE);
```

Where `prevV` is the velocity BEFORE the acceleration step and `{ x: body.vx, y: body.vy }` is the velocity AFTER. The validator now actually checks per-tick velocity delta.

**New test P3-T15:** assert that legitimate Phase 3 acceleration (worst-case 83.3 wu/s/tick) does NOT trip the velocity validator at `REEF_MAX_ACCEL × dt × 2.1 = 140 wu/s/tick` allowance — 56.7 wu/s of headroom. A synthetic 200 wu/s/tick velocity jump SHOULD trip it (proves the fix isn't another no-op).

### `STRENGTH_DRIFT_CHARGE_MULT = 1.4` — does it break Phase 1 assertions?

The Phase 1 test `T3 — advances spark levels at correct tick counts` (`reef-race-sim.test.ts:404`, audit verdict (f)) hard-codes `DRIFT_SPARK_TICK_1/2/3`. With Phase 3 strength pets, those literal thresholds become `[9, 19, 32]`. **Test passes a NEUTRAL pet (no `petProfiles` opt) and is unchanged for backwards compat.** New strength-mult test added in §8 (P3-T7).

### Multiplier clamping

The §1 builder clamps every multiplier inside `[lo, hi]` ranges before stamping on `body.mults`. A pet with `level=999` produces `accelMult=1.25` (clamped). A pet with `archetype="brave-adventurer"` (strength class) produces `driftChargeMult=1.4` (in range). A NaN level → caught by `Number.isFinite` → falls back to level=1. A null archetype → falls back to `'balanced'` → all 1.0.

---

## 6. Bot heuristics adjustment

**Confirmed:** `bot-pool.ts` selects only `pets.id` and `pets.name` (line 75-77). No archetype/level fetched. Current behavior is "all bots have whatever DB defaults" — `level=1`, archetype = whatever the seed-bot-pets script set.

**Decision (locked, audit verdict (e) AGREE):** Phase 3 bots are EXPLICITLY neutral. The pet-profile-loader (§3a) sets `isBot: true` for every bot, and `buildBodyMultipliers` short-circuits to a clone of `NEUTRAL_BODY_MULTIPLIERS`. Even if the DB row has an archetype, it's IGNORED.

**Rationale:** keep bots as a fixed baseline so the human's level/archetype investment shows up CLEARLY against an unchanging benchmark. A/B testing pet builds is impossible if the bot pool's archetype distribution drifts as new bots are seeded.

**S4 — bot vs intelligence-human ribbon asymmetry (documented, by design):** intelligence humans collect ribbons at `RIBBON_HALF_WIDTH × 1.3 = 45.5 wu` perp distance vs neutral 35 wu. Bots steering toward ribbons use the **server-authoritative** `RIBBON_HALF_WIDTH` constant (verified bot reads ribbons via `state.ribbons` reference, no per-body half-width awareness). Bots' ribbon steering pretends ribbons are 35 wu wide for everyone. Intelligence humans get an asymmetric edge picking off ribbons inside the bot-perceived dead-band — by design, telemetry will confirm whether this overshoots.

**Bot heuristic code (`reef-race-bot.ts`):** UNCHANGED. The bot reads input/checkpoints/centerline; it doesn't read mults. Its drift-trigger probability `BOT_DRIFT_TRIGGER_PER_SEC = 0.60` stays. Strength bots would charge sparks faster but bots are neutral, so their `driftSparkTicks = [12, 27, 45]` — unchanged from today.

### Phase 3.5 telemetry hook (audit verdict (e) — required to graduate the bot-neutrality decision)

**New event emitted on race-end:** `reef_race.bot_winrate.by_level_bucket`. Fired once per finished race in the reward pipeline. Payload schema:

```ts
{
  roomId: string,
  humanLevelBucket: '1-10' | '11-25' | '26-49' | '50',  // bucket of the highest-level human in the room
  humanFinished: number,        // count of humans that finished
  humanFinishedFirst: boolean,  // did a human take first place
  botCount: number,             // count of bots in the room
  botFinishedAhead: number,     // count of bots that finished ahead of the highest-level human
}
```

**Where it lives:** `apps/api/src/services/activity/reward-pipeline.ts` race-end handler (the same place Phase 1 emits `activity.match.completed`). Wired into `/dash` via the existing `logEvent` pipeline — the dashboard groups by `humanLevelBucket` and shows win-rate-vs-bots over the measurement window.

**Graduation criterion (Phase 3.5):** if win-rate-vs-bots crosses 95% for the `26-49` or `50` buckets sustained over 7 days, lift bots to level-matched `synthesizeBotProfile(roomId, petId)` (deterministic-LCG, mirrors `synthesizeBotLaunchVerdict`). Without this telemetry, Phase 3.5 deferral is open-loop scaffolding (violates "no scaffolding theater") — so this hook ships in Phase 3, not Phase 3.5.

---

## 7. HUD additions

**Files touched:** `apps/web/src/stores/activity.ts`, `apps/web/src/components/game/reef-race-hud.tsx`.

### 7a. New store fields (primitives only)

```ts
// In ActivityState, add:
selfRacingClass: 'agility' | 'strength' | 'intelligence' | 'balanced' | null;
selfLevel: number;  // 1 if unknown
```

Both are populated ONCE on `snapshot.init` by reading `state.room.reefRacingProfiles[selfPetId]` and writing the resolved `class` + `level` primitives. Maps are NOT subscribed per-tick.

### 7b. Protocol addition — room-wide ALL profiles, client filters by self petId (S5 FIX)

`packages/shared/src/activities/protocol.ts`, in `interface RoomMeta` (line 138-167):

```ts
/**
 * Phase 3 — racing profile per pet in the room. Used by the HUD's archetype
 * tile to show the player WHY they have these advantages.
 *
 * S5 fix: room-wide one-shot map (sent ONCE on snapshot.init), client
 * filters by self petId. ~50 bytes × ≤8 pets = ≤400 bytes — single packet.
 * Avoids per-client routing complexity in the WS hub.
 *
 * Empty/missing on non-reef-race rooms or when the server couldn't resolve
 * any pets (defaults to neutral mults sim-side).
 */
reefRacingProfiles?: Record<string, {
  class: 'agility' | 'strength' | 'intelligence' | 'balanced';
  level: number;
}>;
```

The server populates this at `snapshot.init` send-time from `state.bodies` — for each body, derive `{ class: racingClassFromArchetype(archetype), level }` (uses the same `racingClassFromArchetype` helper to guarantee a consistent class label between sim and HUD). Bots are included with `class: 'balanced'`, `level: 1` — the HUD just shows a neutral chip for them; OK.

Client subscribes:
```ts
// In activity.ts snapshot.init handler:
const myProfile = msg.room.reefRacingProfiles?.[selfPetId];
state.selfRacingClass = myProfile?.class ?? null;
state.selfLevel = myProfile?.level ?? 1;
```

### 7c. New HUD tile

`apps/web/src/components/game/reef-race-hud.tsx`, add a `<RacingBuildTile />` under `<BestLapTile />` (around line 324). It subscribes to PRIMITIVES only: `s.selfRacingClass`, `s.selfLevel`. Renders a small chip:

```
┌─────────────────┐
│  L25 AGI        │
│  Tighter turn   │
│  +60% slipstream│
│  grace          │
└─────────────────┘
```

The summary text comes from a static lookup keyed on class — no per-frame compute. Headlines per class (concrete numbers, audit feedback in "Brand alignment"):

- **agility:** "Tighter turn, +60% slipstream grace"
- **strength:** "Sparks 40% faster, 40% knockback resist"
- **intelligence:** "Powerups +20% duration, ribbons +30% wider"
- **balanced:** "Neutral handling — skill > stats"

~50 lines, zero subscriptions to Maps, conforms to the audit-verified primitive-only pattern.

### 7d. Build-summary banner at race start

Optional. NOT ship-blocking for Phase 3 — gated behind a `FEATURE_GATE` comment until telemetry shows players want it:

```ts
// FEATURE_GATE: reef_race_build_banner
// Status: shipped behind a hardcoded `false` in reef-race-hud.tsx
// Metric to graduate: ≥10% of HUD users open archetype tooltip
// Current reading: to fill (no telemetry yet)
// Review deadline: 2026-06-01
// On deadline: delete tile if metric not met
// Reference: .claude/plans/reef-race-phase3-detailed.md §7
```

---

## 8. Test plan

All tests in `apps/api/src/services/activity/sim/__tests__/reef-race-sim.test.ts` unless noted.

| ID | Name | Asserts |
|---|---|---|
| **P3-T1** | `applies neutral mults when petProfiles is empty` | startRoom with no `petProfiles` → every body has `mults` deep-equal to `NEUTRAL_BODY_MULTIPLIERS`, `driftSparkTicks === [12, 27, 45]`. Bit-identical to pre-Phase-3. |
| **P3-T2** | `level 50 grants accelMult=1.25` | startRoom with `petProfiles: { p1: {level: 50, archetype: null} }` → `body.mults.accelMult === 1.25`. |
| **P3-T3** | `level 25 grants accelMult=1.12` | level 25 → 1.0 + 0.005 × 24 = 1.12. |
| **P3-T4** | `level 999 clamps accelMult to 1.25` | malformed input → clamp activates, body still creates. |
| **P3-T5** | `agility archetype tightens turn maxStep via max(...)` | drive a body at vy=400 wu/s, swing intent.dir from (0,1) to (0.7, 0.7); assert agility body's velocity vector aligns with new dir within 4 ticks vs balanced needs 5+ ticks. Asserts S1 — confirms `max(accelMult, 1/turnRadiusMult)` was used (not compound). |
| **P3-T6** | `agility archetype extends slipstream GRACE` | two bodies drafting; agility leaves wake → `slipstreamGraceTicksLeft === 24`; balanced → `=== 6`. Uses field name `slipstreamGraceTicks` (C3). |
| **P3-T7** | `strength archetype shortens drift sparks` | drift-charge with strength → spark1 at tick 9 (vs 12 baseline); spark3 at tick 32 (vs 45). |
| **P3-T8** | `strength archetype reduces tide-wave knockback` | apply tide wave on strength target at d=0 → velocity reduction = `0.4 × 0.6 = 24%` (vs 40% balanced). |
| **P3-T9** | `intelligence archetype extends turbo duration` | activate `rr-turbo-bubble` with intelligence → `activeEffects.get('rr-turbo-bubble') === now + 2500 * 1.2`. |
| **P3-T10** | `intelligence archetype widens ribbon band` | place body at `RIBBON_HALF_WIDTH × 1.2 = 42 wu` perp from ribbon — neutral misses, intelligence collects. Plus body at perp = 36 wu — both should collect (sanity check on the ANDed body-radius convention). |
| **P3-T11** | `sync profile load: first tick uses level-50 accelMult, not 1.0` | (rescoped from v1's "async load" test) — call the new async `liveTransitionFn`, await it, then read `state.bodies.get(p1).mults.accelMult` immediately. Must be 1.25, not 1.0. |
| **P3-T12** | `bot petId always neutral mults regardless of archetype` | profile loader sets `isBot=true` for bot petIds → mults are neutral even if the DB row has an archetype. Asserts §6 invariant. |
| **P3-T13** | `Phase 1 + Phase 2 anchors unchanged for neutral pets` | re-run 3 representative existing tests with NO Phase 3 profile → byte-identical body state. |
| **P3-T14** | `agility body completes 3-lap race faster than balanced` (regression marker) | run two parallel rooms, identical seeds, one body each (agility vs balanced). Statistical bound: agility totalTimeMs < balanced totalTimeMs at p<0.05 over 10 seed-rotated trials. |
| **P3-T15** | `velocity validator catches synthetic 200 wu/s jump after N1 fix` | inject a tick where `body.vx, body.vy` jump by +200 wu/s (above the `REEF_MAX_ACCEL × dt × 2.1 = 140 wu/s` allowance). Assert `velCheck.flagged === true`. Without N1 fix this would never flag (was no-op). |
| **P3-T16** | `worst-case Phase 3 stack does NOT flag at tolerance 2.1` | run 5 ticks at: launch boost + drift-3 + slipstream + ribbon + apex-bonus + level-50 + agility (turning). Assert `posCheck.ok === true` AND `velCheck.flagged === false` for all 5 ticks. **This test exists to PROVE C1 was actually fixed.** |
| **P3-T17** | `cross-pet — agility human beats neutral bot in mixed room` | 1 agility human + 1 neutral bot, race 3 laps with deterministic seeds. Assert human's `totalTimeMs < bot.totalTimeMs` over 10 trials at p<0.05. |
| **P3-T18** | `widened liveTransitionFn signature does not break bumper-shells/arena` | re-register both other sims through `setLiveTransitionFn` with their existing sync handlers; await the manager's `persistLiveTransition` for a synthetic room and assert no exception. |

**Unit-level constants tests (`reef-race-config.test.ts`, NEW — verified S6):**

| ID | Name | Asserts |
|---|---|---|
| **P3-C1** | `racingClassFromArchetype maps all 14 IDs` | 14 archetypes × 4 classes lookup is total — every ID returns a class. |
| **P3-C2** | `racingClassFromArchetype unknown returns balanced` | `racingClassFromArchetype('not-an-id')` === `'balanced'`. |
| **P3-C3** | `buildBodyMultipliers null profile is neutral` | `buildBodyMultipliers(null)` deep-equals `NEUTRAL_BODY_MULTIPLIERS`. |
| **P3-C4** | `buildBodyMultipliers bot is neutral` | `buildBodyMultipliers({...,isBot:true})` deep-equals `NEUTRAL_BODY_MULTIPLIERS`. |
| **P3-C5** | `clamps respect bounds` | level=999 → accelMult=1.25; level=-50 → accelMult=1.0; archetype="x"+strength fields default 1.0. |
| **P3-C6** | `mutation safety: per-body mults are clones, not shared neutral reference` | call `buildBodyMultipliers(null)` twice, mutate `r1.accelMult = 99`, assert `r2.accelMult === 1.0`. Catches N4 if the clone fix regresses. |

**Integration test (`pet-profile-loader.test.ts`, NEW):**

| ID | Name | Asserts |
|---|---|---|
| **P3-L1** | `loads humans + bots in one call` | mock db.select → returns 3 profiles; call `loadRacingProfiles(['h1','h2'], ['b1'])` → Map size 3, h1/h2 from DB, b1 isBot=true. |
| **P3-L2** | `unknown human petId falls back to neutral` | mock returns 1 row for 2 humans → second human has neutral profile. |
| **P3-L3** | `DB error returns all-neutral` | mock throws → all humans/bots in returned Map are neutral fallbacks, no exception raised. |

**`/dash` integration test (`reef-race-bot-winrate.test.ts`, NEW):**

| ID | Name | Asserts |
|---|---|---|
| **P3-D1** | `race-end emits reef_race.bot_winrate.by_level_bucket` | finish a synthetic race with 1 level-50 human + 3 bots; assert one event was logged with the expected payload schema. Without this hook the §6 deferral is open-loop. |

---

## 9. Risks + mitigations

| Risk | Mitigation |
|---|---|
| Stat creep — high-level pets dominate forever | Top-speed unchanged = skill > stats. Validated by P3-T14 statistical bound — agility pet wins, but only by margin (~3-5% of race time), not by 30%. |
| Bot fairness — humans level up, bots stuck at neutral | Telemetry hook `reef_race.bot_winrate.by_level_bucket` ships in Phase 3 (§6, §10). Phase 3.5 lifts bots to level-matched if win-rate > 95% sustained. |
| Snapshot bandwidth — do mults ride the wire? | NO. Mults are deterministic at room-start (function of `pets.level + pets.archetype`). Server stamps once, never broadcasts. Only `RoomMeta.reefRacingProfiles` (one-shot, ≤400 bytes total) added to wire. |
| DB load — extra query per match | 1 query × ≤8 petIds × ~5 matches/min/region = trivial. Wrapped in try/catch — DB outage falls back to all-neutral. Race still runs. |
| Plan↔code mismatch on archetype IDs | Resolved via `racingClassFromArchetype()` 14-to-4 mapping (§1, audit verdict (a) AGREE). Pure function; reversible without migration. |
| Plan↔code mismatch on slipstream "longer window" | Resolved via grace-tick extension (§4c, audit fix C3) — agility extends GRACE not REQUIRED. Builder, body field, consumption site, tests all unified on `slipstreamGraceTicks`. |
| Sync profile load delays sim start | ~1-2 ms blocking on Drizzle pool query inside the already-async `persistLiveTransition`. Sim starts within the same event-loop turn. Existing C4/S10 launch-verdict math is anchored to `room.startedAt` (set BEFORE this point), so verdict windows are unaffected. |
| Per-frame allocation regression | Codex review checklist: grep for `new Set/Map/Array` inside `applyIntentForTick`/`tickDriftState`/`resolveSlipstream`/`resolveBoostRibbons`/`resolveApex`/`resolveHazards`/`tryUsePowerUp` — must be ZERO new instances introduced. The new `cosTheta` math in §4b uses primitives only. The N4 clone in `buildBodyMultipliers` runs at room-start, NOT in the hot loop. |
| Phase 1+2 regression | P3-T13 explicitly re-runs three representative existing tests without Phase 3 profile data and asserts bit-identical state. |
| Anti-cheat false positives at new tolerance | §5 math shows worst-case position delta = 33.6 wu vs 35.0 wu allowed at `REEF_KINEMATIC_TOLERANCE = 2.1` → 1.4 wu of headroom. NO clamp, NO flag. P3-T16 proves it under the boosted stack. |
| Anti-cheat false negatives at new tolerance (cheaters slip through) | Position validator allows extra ~5% per tick = ~10% extra speed sustained. Velocity validator (now correctly wired by N1 fix) catches sustained over-velocity at `REEF_MAX_SPEED × 2.1 = 1050 wu/s`. P3-T15 proves it catches a synthetic 200 wu/s jump. |
| `liveTransitionFn` widening breaks other sims | P3-T18 verifies `bumper-shells` + `arena` still pass with the widened `Promise<void> | void` signature. Both currently return `void`; the manager just `await`s `void` (no-op). |

---

## 10. File-by-file scope

| File | Lines | Owner | Change |
|---|---|---|---|
| `apps/api/src/services/activity/sim/reef-race-config.ts` | +130 / -1 | orchestrator | Phase 3 constants block, `RacingClass` type, `racingClassFromArchetype()`, `BodyMultipliers` interface, `NEUTRAL_BODY_MULTIPLIERS as const`, `buildBodyMultipliers()` (clones via spread), clamp helper. **Bumps `REEF_KINEMATIC_TOLERANCE` from 2.0 to 2.1 (C1).** Drops `AGILITY_SLIPSTREAM_WINDOW_MS`; adds `AGILITY_SLIPSTREAM_GRACE_TICKS = 24` + clamp ranges. Renames `LEVEL_ACCEL_MULT_AT_50` → `LEVEL_ACCEL_MULT_CEILING` (N3). |
| `apps/api/src/services/activity/sim/reef-race-sim.ts` | +35 / -10 | orchestrator | Add `mults` + `driftSparkTicks` to `ReefBody`. Init in `startRoom` body loop. Modify `applyIntentForTick` step 9 (S1: `max(accelMult, 1/turnRadiusMult)`, NOT compound). Modify `tickDriftState` thresholds. Modify `resolveSlipstream` grace assignment (C3: `slipstreamGraceTicks`). Modify `tryUsePowerUp` duration. Modify `resolveBoostRibbons` half-width via `isOnRibbon` arg. Modify `applyTideWave` factor. Modify `applySeekerJelly` impulse (S3 explicit). **Fix `validateReefVelocityDelta` no-op call at line 1213 (N1).** |
| `apps/api/src/services/activity/pet-profile-loader.ts` | +60 | orchestrator | NEW FILE — Drizzle fetch + neutral-fallback + bot short-circuit. |
| `apps/api/src/services/activity/activity-room-manager.ts` | +3 / -2 | orchestrator | **C2 fix:** widen `liveTransitionFn` field + setter signature to `(room: Room) => Promise<void> | void`; `await` it inside `persistLiveTransition`. |
| `apps/api/src/index.ts` | +20 / -10 | orchestrator | **C2 fix:** rewrite `setLiveTransitionFn(...)` registration as an `async (room) => {...}` handler. `case 'reef-race':` block — split human/bot petIds, `await loadRacingProfiles(...)` BEFORE `reefRaceSim.startRoom(...)`, pass `petProfiles` to `startRoom`. Other cases (`bumper-shells`, `arena`) keep returning sync `void`. |
| `apps/api/src/services/activity/reward-pipeline.ts` | +30 | orchestrator | **§6 telemetry hook:** emit `reef_race.bot_winrate.by_level_bucket` event on race-end (humanLevelBucket + finished + winner stats). |
| `packages/shared/src/activities/protocol.ts` | +12 | orchestrator | **S5 fix:** add `RoomMeta.reefRacingProfiles?: Record<petId, { class, level }>`. |
| `apps/web/src/stores/activity.ts` | +14 | orchestrator | Add `selfRacingClass`, `selfLevel` primitives; populate on `snapshot.init` from `state.room.reefRacingProfiles[selfPetId]`. |
| `apps/web/src/components/game/reef-race-hud.tsx` | +60 | orchestrator | New `<RacingBuildTile />` subcomponent + render hook + per-class headline lookup. |
| `apps/api/src/services/activity/sim/__tests__/reef-race-sim.test.ts` | +320 | orchestrator | P3-T1 through P3-T18 (18 cases). |
| `apps/api/src/services/activity/sim/__tests__/reef-race-config.test.ts` | +110 | orchestrator | NEW FILE (verified S6 — does not exist) — P3-C1 through P3-C6 (6 cases). |
| `apps/api/src/services/activity/__tests__/pet-profile-loader.test.ts` | +90 | orchestrator | NEW FILE — P3-L1 through P3-L3 (3 cases). |
| `apps/api/src/services/activity/__tests__/reef-race-bot-winrate.test.ts` | +60 | orchestrator | NEW FILE — P3-D1 (1 case, verifies the `/dash` telemetry hook fires). |
| `GameFeatures.md` | +30 | orchestrator | Same-diff doc update — Reef Race section gets a Phase 3 stat-connection paragraph + the 14→4 archetype mapping table + Phase 3.5 telemetry note. |
| `ARCHITECTURE.md` | +12 | orchestrator | Same-diff doc update — note the new `pet-profile-loader.ts` service, `RoomMeta.reefRacingProfiles` field, `reef_race.bot_winrate.by_level_bucket` event, and the widened `liveTransitionFn` signature. |
| `packages/agent-templates/src/locations/town-guide.ts` | +3 | orchestrator | **N2 fix:** 3-line knowledge entry — overview, 14→4 mapping pointer, headline mults per class. |

**Total estimated new code:** ~870 lines (incl. ~580 lines of tests). Target review time: 110 minutes for Codex.

**No 3da spawn:** Phase 3 has zero scene-graph / material / geometry / shader / model changes. The HUD tile is DOM, not three.js. Confirmed against the CLAUDE.md "MANDATORY: Collaborate with the 3da subagent for ALL 3D work" trigger list — none of the listed surfaces are touched.

**Town Guide knowledge update (N2 fix — 3 lines, not 1):** Phase 3 introduces a new gameplay rule (level + archetype affect race handling). Per CLAUDE.md "Every gameplay change updates system agents' expertise in the same diff", `packages/agent-templates/src/locations/town-guide.ts` `knowledge[]` MUST add three entries:

1. "In Reef Race, your pet's level (1-50) accelerates collision recovery up to +25% at level 50. Top speed never changes — skill still beats stats."
2. "Archetypes bucket into 4 racing classes: Agility (mischievous-trickster, wild-explorer, chaotic-jester) gets tighter turning + 60% longer slipstream grace. Strength (brave-adventurer, fierce-battler, noble-guardian) charges drift sparks 40% faster + takes 40% less knockback. Intelligence (curious-scholar, mystical-seer, cunning-trader, royal-diplomat, quiet-mystic) extends powerup duration 20% + collects ribbons in a 30% wider band. Balanced (gentle-healer, creative-dreamer, loyal-companion) is neutral."
3. "Bots are always neutral by design — they're a fixed baseline so your pet's stat investment shows clearly in your race times. If level-50 humans beat bots 95%+ of the time, bots will get level-matched in Phase 3.5."

---

## Audit closure checklist (v2 — all 10 critical/significant audit items)

1. **C1** — `REEF_KINEMATIC_TOLERANCE` 2.0 → 2.1 (§1, §5, §10). Math proven in §5; cheater-safety reasoned in §5. ✅
2. **C2** — `liveTransitionFn` signature widened to async; matchmaker pre-loads profiles before `startRoom` (§3b, §10). No async IIFE. ✅
3. **C3** — `slipstreamGraceTicks` field name unified across §1 builder, §2 body field, §4c consumption, §8 tests. `AGILITY_SLIPSTREAM_WINDOW_MS` dropped. ✅
4. **N1** — `validateReefVelocityDelta` no-op fix in scope for Phase 3 (§5, §10, P3-T15). ✅
5. **S1** — turn-radius compound replaced with `Math.max(...)` in §4b. ✅
6. **S3** — explicit `applySeekerJelly` patch in §4e. ✅
7. **S4** — bot ribbon-asymmetry documented as deliberate Phase 3.5 telemetry signal in §6. ✅
8. **S5** — `RoomMeta.reefRacingProfiles` room-wide one-shot map in §7b. ✅
9. **S6** — verified `reef-race-config.test.ts` does not exist; new file. ✅
10. **N2/N3/N4/N5/N6** — Town Guide expanded to 3 lines (N2); `LEVEL_ACCEL_MULT_CEILING` rename (N3); per-body clone via `{ ...NEUTRAL_BODY_MULTIPLIERS }` (N4); JS Math.round comment corrected (N5); `slipstreamGraceTicksLeft` init unchanged-by-design noted in §4c (N6). ✅
11. **Phase 3.5 telemetry hook** (audit verdict (e) follow-up) — `reef_race.bot_winrate.by_level_bucket` event added to §6 + §10 + P3-D1 test. ✅
12. **Audit verdicts** (a) 14→4 mapping confirmed in §1; (d) no schema migration confirmed in §1 + §0 finding 1; (f) Phase 1 T3 compatibility confirmed in §5. ✅

**Status: PROCEED** — all critical issues addressed, all significant issues addressed, all minor issues addressed, all required test gaps closed.
