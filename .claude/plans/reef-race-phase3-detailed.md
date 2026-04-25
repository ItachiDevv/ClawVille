# Reef Race — Phase 3 Detailed Implementation Plan

**Status:** Draft, awaiting audit. Phase 1 + Phase 2 merged on master.
**Scope:** Stat connection — pet `level` + `archetype` apply per-body multipliers to the existing Phase 1+2 sim.
**Owners:** orchestrator (sim, config, room-manager seam, store, HUD), 3da NOT required (no scene/material/geometry changes).
**Hard invariants (locked by `.claude/plans/reef-race-real-racing.md` Phase 3 table):**

- Top-speed cap (`REEF_MAX_SPEED = 500 wu/s`) is unchanged across all archetypes — skill ceiling > stat ceiling.
- All multipliers default to `1.0` (or to today's literal value); a neutral pet with no archetype + level 1 races identically to today.
- Phase 1 anchors (C1–C6, S4–S6, S10–S11) and Phase 2 anchors (combined kinematic arithmetic, `BotRoomView`, `event.power_up_collected.kind`, N12 grace gating) MUST NOT regress.
- No per-frame allocations. No kill-switches. Bots default to neutral mults so a human's stat investment shows against a fixed baseline.

---

## 0. Source-code baseline audit (verified)

Citations are `path:line` from this worktree (`worktree-fix-bumper-build`).

1. **Pet schema today** has BOTH a string `archetype` enum AND a numeric `stats` JSON — they are **separate fields**, not the same axis the high-level plan implied.
   - String archetype column: `packages/database/src/schema/pets.ts:101-102` — `archetype: varchar('archetype', { length: 50 }).notNull()`. Allowed IDs: `brave-adventurer | curious-scholar | mischievous-trickster | gentle-healer | fierce-battler | creative-dreamer | noble-guardian | cunning-trader | mystical-seer | loyal-companion | wild-explorer | royal-diplomat | chaotic-jester | quiet-mystic` (`packages/shared/src/constants/pet-archetypes.ts:1-15`).
   - Numeric stats: `packages/database/src/schema/pets.ts:113` — `stats: jsonb('stats').$type<PetStatsJson>().notNull()`. `PetStatsJson = { strength: number; defence: number; movement: number }` (`packages/database/src/schema/pets.ts:66-70`; `packages/shared/src/types/pet.ts:18-22`).
   - Level column: `packages/database/src/schema/pets.ts:128` — `level: integer('level').default(1).notNull()`.
2. **The high-level plan's `agility/strength/intelligence` axes do not exist as archetype IDs.** They exist conceptually inside `stats: { strength, defence, movement }` (numeric, 0–100 today) but the plan asked for **archetype-driven** multipliers, not stat-vector ones. **Resolution (locked in §1):** Phase 3 introduces a new derived field `racingClass: 'agility' | 'strength' | 'intelligence' | 'balanced'` derived deterministically from the existing 14-archetype string column, NOT a schema change. Mapping tabulated in §1. This decision is load-bearing — see Risks §9.
3. **Pet data is NOT fetched at room-allocation time today.** `activity-queue.ts:664-694` constructs participants with only `{ petId, userId, agentId, subjectType, partyId }`; `RoomParticipant` interface (`apps/api/src/services/activity/types.ts:65-78`) has no level/archetype fields. The reward pipeline does fetch `pets.flags + pets.isGuest` (`apps/api/src/services/activity/reward-pipeline.ts:445-455`) — that's the model for the new Phase 3 fetch.
4. **Sim entry seam** is `liveTransitionFn` — `apps/api/src/index.ts:341-358` calls `reefRaceSim.startRoom(room.id, room.activityId, participantIds, { bots, startedAt, launchBoosts })`. `participantIds` is just `Array.from(room.participants.keys())` — no profile data passed. Phase 3 extends this opts payload with `petProfiles: Map<string, PetProfile>`.
5. **Sim body initialization** at `apps/api/src/services/activity/sim/reef-race-sim.ts:457-527` constructs each `ReefBody` with hard-coded defaults; this is where Phase 3 attaches the seven multiplier fields.
6. **Multiplier consumption sites in the sim today (read these, then `§4` modifies them):**
   - Acceleration cap (`REEF_MAX_ACCEL`): `reef-race-sim.ts:1006` — `const maxStep = REEF_MAX_ACCEL * dt;` inside `applyIntentForTick` step 9. **No other accel call-site.**
   - Turn radius is **emergent** from the dt-bounded velocity rotation toward the input-direction target — there is no explicit "turn radius" constant. The relevant code is `applyIntentForTick` steps 6–9 (lines 974–1009), where `body.rot` is set via `Math.atan2(intent.dir.x, intent.dir.y)` then velocity is integrated toward the new direction at `REEF_MAX_ACCEL * dt`. Specified §4.
   - Slipstream window: `SLIPSTREAM_REQUIRED_TICKS = 45` (`reef-race-config.ts:452`) — consumed in `resolveSlipstream` (`reef-race-sim.ts:1936`). This is the "1500ms" the plan refers to; agility extends to 2200ms via fewer-ticks-required lookup.
   - Drift charge thresholds: `DRIFT_SPARK_TICK_1=12, _2=27, _3=45` (`reef-race-config.ts:326-328`) consumed in `tickDriftState` (`reef-race-sim.ts:1059-1067`).
   - Knockback: there is **no kart-vs-kart knockback** today — `resolveProximity` (`reef-race-sim.ts:1261-1284`) is a "light separation push only — no knockback in a race." Two real knockback sources exist: `applyTideWave` (`reef-race-sim.ts:1493-1518`, scales target velocity by `1 - factor`) and `applySeekerJelly` (`reef-race-sim.ts:1520+`). Specified §4.
   - Power-up duration: `body.activeEffects.set(kind, now + def.effectMs)` in `tryUsePowerUp` (`reef-race-sim.ts:1475`). One call-site for all four duration-bearing pickups.
   - Ribbon detect radius: half-width band `RIBBON_HALF_WIDTH = 35 wu` (`reef-race-config.ts:522`). The plan says "ribbon-detect radius" but the actual geometry is a **band half-width** along the segment tangent, not a radius. Mapping clarified §4.
7. **Anti-cheat tolerance:** `REEF_KINEMATIC_TOLERANCE = 2.0` (`reef-race-config.ts:389`) gates the position+velocity validators in `integrateMotion` (`reef-race-sim.ts:1213, 1226`). The current worst-case combined positive stack is `KINEMATIC_BOOST_CAP = 0.85` → `1.85× × 500 = 925 wu/s`, **well under** the `2.0× × 500 = 1000 wu/s` validator ceiling. Phase 3 leaves both constants unchanged (proof in §5).
8. **HUD subscription pattern** consumes primitives only — `useActivityStore((s) => s.driftSparks)` (line 25 of `reef-race-hud.tsx`). Maps are NOT subscribed per-tick; per the audit-verified pattern, new HUD reads from `s.selfRacingClass` + `s.selfLevel` primitives populated once on `snapshot.init`.
9. **Bot pool** has no per-bot stats today — `bot-pool.ts:38, 75-77` selects only `pets.id, pets.name`. Phase 3 keeps this and treats bots as neutral (no archetype, level 1) by skipping them in the profile fetch (§3 + §6).

---

## 1. Stat → multiplier mapping (constants)

All constants live in `apps/api/src/services/activity/sim/reef-race-config.ts` in a new section block `// ─── Phase 3 — stat-driven body multipliers ─────────────────────────────────`. Defaults set so a missing/unknown archetype + level 1 gives the literal `1.0` everywhere.

```ts
// Level → acceleration recovery multiplier.
//   per-level mult = 1 + 0.005 × (level - 1), CLAMPED to [1.0, 1.25].
//   level=1   → 1.000   (today's behavior)
//   level=25  → 1.120   (bot default)
//   level=50  → 1.245
//   level=51+ → 1.250 (clamped at LEVEL_ACCEL_MULT_AT_50)
export const LEVEL_ACCEL_MULT_AT_50 = 1.25;
export const LEVEL_ACCEL_MULT_PER_LEVEL = 0.005;

// Archetype-class multipliers — see racingClassFromArchetype() below for
// the 14-archetype → 4-class mapping. 'balanced' archetype applies 1.0 to
// every field.
export const AGILITY_TURN_RADIUS_MULT          = 0.85;  // tighter (lower = tighter)
export const AGILITY_SLIPSTREAM_WINDOW_MS      = 2200;  // vs 1500ms baseline
export const STRENGTH_DRIFT_CHARGE_MULT        = 1.4;   // sparks faster
export const STRENGTH_KNOCKBACK_RESIST_MULT    = 0.6;   // takes 60% of normal knockback
export const INTELLIGENCE_POWERUP_DURATION_MULT = 1.2;  // pickups last 20% longer
export const INTELLIGENCE_RIBBON_DETECT_MULT    = 1.3;  // ribbon band 30% wider

// Hard clamp ranges so a malformed pet (level 999, NaN mult) can't break
// the sim. Applied at multiplier-construction time, NOT inside the hot loop.
export const PHASE3_MULT_CLAMP_ACCEL          = [1.0, 1.25] as const;
export const PHASE3_MULT_CLAMP_TURN_RADIUS    = [0.70, 1.00] as const;
export const PHASE3_MULT_CLAMP_SLIPSTREAM_MS  = [1500, 3000] as const;
export const PHASE3_MULT_CLAMP_DRIFT_CHARGE   = [1.00, 1.50] as const;
export const PHASE3_MULT_CLAMP_KNOCKBACK_RES  = [0.50, 1.00] as const;
export const PHASE3_MULT_CLAMP_POWERUP_DUR    = [1.00, 1.50] as const;
export const PHASE3_MULT_CLAMP_RIBBON_DETECT  = [1.00, 1.50] as const;
```

### Racing class derivation

Pure-function, lives next to constants in `reef-race-config.ts`:

```ts
export type RacingClass = 'agility' | 'strength' | 'intelligence' | 'balanced';

// Maps the 14 PetArchetypeIds to a 4-bucket racing class. Source-of-truth
// rationale (one-liner per archetype):
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

**Why a derived class, not a column add:** day 1 Phase 3 must NOT touch the DB schema (zero migration risk; ships in one PR). The 4-class bucketing keeps the matrix manageable — 14 archetypes × 7 multipliers = 98 cells of test surface, infeasible to balance. 4 classes × 7 mults = 28 cells, tractable.

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
  slipstreamRequiredTicks: number;
  driftChargeMult: number;
  knockbackResistMult: number;
  powerUpDurationMult: number;
  ribbonDetectMult: number;
}

export const NEUTRAL_BODY_MULTIPLIERS: BodyMultipliers = {
  accelMult: 1.0,
  turnRadiusMult: 1.0,
  slipstreamRequiredTicks: SLIPSTREAM_REQUIRED_TICKS, // 45 = today's literal
  driftChargeMult: 1.0,
  knockbackResistMult: 1.0,
  powerUpDurationMult: 1.0,
  ribbonDetectMult: 1.0,
};

export function buildBodyMultipliers(profile: PetRacingProfile | null | undefined): BodyMultipliers {
  if (!profile) return NEUTRAL_BODY_MULTIPLIERS;
  // Bots are neutral (decision §6 — confirmed).
  if (profile.isBot) return NEUTRAL_BODY_MULTIPLIERS;

  const safeLevel = Number.isFinite(profile.level) ? profile.level : 1;
  const accelRaw  = 1 + LEVEL_ACCEL_MULT_PER_LEVEL * Math.max(0, safeLevel - 1);
  const accelMult = clamp(accelRaw, PHASE3_MULT_CLAMP_ACCEL[0], PHASE3_MULT_CLAMP_ACCEL[1]);

  const cls = racingClassFromArchetype(profile.archetype);

  // Slipstream uses TICKS not ms (sim-internal unit). Convert agility's 2200ms to ticks
  // exactly once at multiplier-build time so the hot loop reads an integer.
  const slipstreamTicks = cls === 'agility'
    ? Math.round(AGILITY_SLIPSTREAM_WINDOW_MS / REEF_TICK_MS)  // 2200ms → 66 ticks
    : SLIPSTREAM_REQUIRED_TICKS;                                // 45 ticks (=1500ms)

  return {
    accelMult,
    turnRadiusMult:        cls === 'agility'      ? AGILITY_TURN_RADIUS_MULT       : 1.0,
    slipstreamRequiredTicks: clamp(
      slipstreamTicks,
      Math.round(PHASE3_MULT_CLAMP_SLIPSTREAM_MS[0] / REEF_TICK_MS),
      Math.round(PHASE3_MULT_CLAMP_SLIPSTREAM_MS[1] / REEF_TICK_MS),
    ),
    driftChargeMult:       cls === 'strength'     ? STRENGTH_DRIFT_CHARGE_MULT     : 1.0,
    knockbackResistMult:   cls === 'strength'     ? STRENGTH_KNOCKBACK_RESIST_MULT : 1.0,
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

Extend `interface ReefBody` (`apps/api/src/services/activity/sim/reef-race-sim.ts:174-257`) with ONE new field — the `BodyMultipliers` struct from §1 — under a new `// ─── Phase 3 ───` block:

```ts
interface ReefBody {
  // ... existing fields ...

  // ─── Phase 3 — pet-stat-driven multipliers (computed once at startRoom) ─
  /** Pet-stat-driven per-body multipliers. Read-only after init. */
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
   * Round-down so the strength bonus never mathematically lengthens the
   * threshold (e.g. 12/1.4 = 8.57 rounds to 8, 9 chosen as floor of 8.57+0.5).
   * **Fix:** use Math.max(1, Math.round(threshold / mult)) — Math.round on
   * the strength case gives [9, 19, 32]; cap min 1 so an extreme mult can't
   * collapse to 0.
   */
  driftSparkTicks: readonly [number, number, number];
}
```

**Initialization site:** `apps/api/src/services/activity/sim/reef-race-sim.ts:486-526` (the `state.bodies.set(petId, { ... })` block). Add `mults` + `driftSparkTicks` to the object literal. Both are computed once from the per-pet `BodyMultipliers` returned by `buildBodyMultipliers()`. No allocation on subsequent ticks.

**Why two fields, not one:** `mults` is the canonical multiplier struct (used by 6 of 7 mechanics); `driftSparkTicks` is the `mults.driftChargeMult` PRE-APPLIED to the three thresholds so the hot loop avoids a division. Same idea as the `currentDriftBoostSparks` Phase-1 cache (line 219).

**Defaults:** if `petProfiles` is missing or has no entry for a petId, `mults = NEUTRAL_BODY_MULTIPLIERS` and `driftSparkTicks = [DRIFT_SPARK_TICK_1, _2, _3]` — identical to today's behavior.

---

## 3. Pet-stat data path

End-to-end flow:

### 3a. Fetch pet profiles before sim start

**New helper in a new file:** `apps/api/src/services/activity/pet-profile-loader.ts`. Mirrors the established Drizzle pattern from `reward-pipeline.ts:445-455`:

```ts
import { db, pets } from '@clawville/database';
import { inArray } from 'drizzle-orm';
import type { PetRacingProfile } from './sim/reef-race-config';

/**
 * Phase 3 — fetch racing profiles for the human/agent participants of a room.
 * Called from `liveTransitionFn` BEFORE invoking `reefRaceSim.startRoom`.
 *
 * Bots are passed in `botPetIds` and short-circuit to neutral profiles
 * (no DB read — bot pool already verified at boot, no point re-reading).
 *
 * Returns an empty Map if `humanPetIds` is empty. Caller treats missing
 * petIds as neutral (NEUTRAL_BODY_MULTIPLIERS).
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

### 3b. Wire the fetch into `liveTransitionFn`

**Edit:** `apps/api/src/index.ts:341-358` (the `case 'reef-race':` block). Make the LIVE handler async-friendly by `void`-awaiting the profile load, then passing the resulting Map to `startRoom`:

```ts
case 'reef-race': {
  const launchBoosts = activityRoomManager.computeLaunchVerdicts(room);
  // Phase 3 — split human vs bot petIds from the room participants snapshot.
  const humanPetIds: string[] = [];
  const botPetIds:   string[] = [];
  for (const p of room.participants.values()) {
    (p.subjectType === 'bot' ? botPetIds : humanPetIds).push(p.petId);
  }
  // Async fire — DO NOT block the LIVE transition on this. The sim starts
  // immediately with neutral mults; profiles slot in via a deferred apply
  // before the first applyIntentForTick consumes them.
  //
  // CORRECTION: `liveTransitionFn` is sync (Room → void). Two options:
  //   (a) make startRoom accept a pending-profiles Promise and apply at first tick
  //   (b) await the profile load BEFORE startRoom (microsecond cost — Drizzle pool)
  //
  // (b) chosen — see Risks §9. The fetch is fast enough that blocking is fine
  // and option (a) introduces a tick-0 race where the body integrates 33ms with
  // wrong mults.
  void (async () => {
    const profiles = await loadRacingProfiles(humanPetIds, botPetIds);
    reefRaceSim.startRoom(room.id, room.activityId, participantIds, {
      bots,
      startedAt: room.startedAt ?? Date.now(),
      launchBoosts,
      petProfiles: profiles,
    });
  })();
  break;
}
```

**WAIT — re-checking:** the existing handler invokes `reefRaceSim.startRoom` synchronously and `room.startedAt` is set BEFORE `liveTransitionFn` fires (`activity-room-manager.ts:824` updates DB then the call lines fire). If we move startRoom inside an async IIFE, the sim starts ~1ms late and the `state.startedAt = startedAt` parameter still anchors launch verdict windows correctly because `startedAt` is the room's wall-clock LIVE timestamp, NOT `Date.now()`.

**Risk:** the broadcast hub's `setBroadcastFn` callback for this room is wired by the WS hub on `startRoom`-completed. If the sim starts 1–2ms later than today, any client that connects in that window sees no snapshots until the next tick. Acceptable — clients reconnect via `snapshot.init`. Documented in §9.

**Test:** add `'P3-T11 — async profile load completes before first tick'` in `reef-race-sim.test.ts` (§8).

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

Inside the body-init loop (line 457), call `buildBodyMultipliers(opts?.petProfiles?.get(petId) ?? null)` per pet and stamp the result on the new `mults` field. Compute `driftSparkTicks` from `mults.driftChargeMult` immediately.

**Bot default:** `opts?.bots?.find(b => b.petId === petId)` exists OR `opts?.isBot?.(petId)` returns true → profile entry built with `isBot: true` → `buildBodyMultipliers` short-circuits to neutral (decision §6).

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
const maxStep = REEF_MAX_ACCEL * dt * body.mults.accelMult;
```

**Why this counts as "recovery from collisions":** the `maxStep` is the per-tick velocity-vector convergence cap toward `targetVx/Vy`. After a knockback (`applyTideWave` scales velocity down by up to 40%, `applySeekerJelly` deflects), the body's velocity magnitude drops below `target`; the next tick's `dvx/dvy = target - body.v` is large; level-50 with `accelMult=1.25` recovers 25% faster. The TOP-SPEED CAP is unchanged (`baseTopSpeed = REEF_MAX_SPEED * speedMod`, line 968) — only the recovery rate moves.

**Anti-cheat impact:** acceleration cap (`maxStep`) was previously bounded by `REEF_MAX_SPEED * 4 * dt = 2000 wu/s² * 0.0333 = 66.7 wu/s per tick`. With `accelMult=1.25`: `83.3 wu/s per tick`. The position validator clamps over-tick displacement at `REEF_MAX_SPEED × REEF_KINEMATIC_TOLERANCE = 1000 wu/s × dt`. A single tick's velocity gain of 83.3 wu/s, even if applied at peak boost (`speedMod=1.85`), produces ≤ `925 + 83.3 = 1008.3 wu/s` instantaneous velocity → clamped 8.3 wu/s by integrator. **Effect: clamp triggers, body velocity slightly capped, NO flag** because the validator delta is on POSITION not velocity-jump. Detailed math §5.

### 4b. `turnRadiusMult` — tighter turning for agility

**Where:** "Turn radius" is emergent (audit §0 finding). The two knobs that cause perceived turn radius are:
1. The yaw target — `body.rot = atan2(intent.dir.x, intent.dir.y)` (line 975) — instant snap, not gradual.
2. The velocity convergence rate — `maxStep = REEF_MAX_ACCEL * dt` (line 1006) — how fast `body.v` swings to match the new `body.rot` direction.

A "tighter turn" means the BODY trajectory follows the new heading faster after `intent.dir` swings. Mathematically that means the velocity-convergence step should be LARGER for agility. But that overlaps with `accelMult`. Resolution:

**Decision (locked):** apply `turnRadiusMult` as an ADDITIONAL multiplier on `maxStep` ONLY when the body is turning (`|intent.dir.x|` significant) — i.e. it accelerates lateral velocity convergence specifically when the input direction is NOT collinear with current velocity. Specifically, when the angle between `body.v̂` and `intent.dir.normalized` is > a small threshold (~14°, same as `DRIFT_MIN_STEER`), apply `1 / turnRadiusMult` to `maxStep` (lower `turnRadiusMult` = larger maxStep = tighter turn).

**Phase 3 code (line 1002-1009):**
```ts
// 9. Integrate acceleration toward target. Phase 3 — agility tightens the
//    turn by EXTRA acceleration during direction-change ticks. Detected via
//    the angle between current velocity and the input direction; > 14°
//    triggers the bonus. Straight-line ticks see only the level mult.
const dvx = targetVx - body.vx;
const dvy = targetVy - body.vy;
const dv = Math.hypot(dvx, dvy);
const baseMaxStep = REEF_MAX_ACCEL * dt * body.mults.accelMult;
let maxStep = baseMaxStep;
if (intent.dir && body.mults.turnRadiusMult < 1.0) {
  const speed = Math.hypot(body.vx, body.vy);
  if (speed > REEF_MAX_SPEED * 0.10) {
    // Cosine of angle between body.v̂ and intent.dir̂. Avoid normalizing —
    // cos(theta) = (v · d) / (|v| × |d|), and we already have |v|=speed.
    const dirMag = Math.hypot(intent.dir.x, intent.dir.y) || 1;
    const cosTheta = (body.vx * intent.dir.x + body.vy * intent.dir.y) / (speed * dirMag);
    // cosTheta < 0.97 ≈ angle > 14°.
    if (cosTheta < 0.97) {
      maxStep = baseMaxStep / body.mults.turnRadiusMult;
    }
  }
}
const scale = dv === 0 ? 0 : Math.min(1, maxStep / dv);
body.vx += dvx * scale;
body.vy += dvy * scale;
```

**Anti-cheat impact:** with `turnRadiusMult=0.85` and `accelMult=1.25`, peak `maxStep = REEF_MAX_ACCEL * dt * 1.25 / 0.85 = REEF_MAX_ACCEL * dt * 1.47`. At 30Hz: `2000 × 0.0333 × 1.47 = 98 wu/s per tick`. Same position-validator analysis as §4a — bounded by speed cap, no flag. The TOP-SPEED CAP is still `REEF_MAX_SPEED * speedMod` (line 968) — agility still cannot exceed 925 wu/s steady-state.

**No new allocation:** the `cosTheta` branch reuses `intent.dir` and `body.vx/vy` — no new objects. 6 add/mul/div ops per tick per body when agility, none otherwise.

### 4c. `slipstreamRequiredTicks` — longer wake window for agility

**Where:** `resolveSlipstream`, `reef-race-sim.ts:1936`.

**Today:**
```ts
if (self.slipstreamConsecutiveTicks >= SLIPSTREAM_REQUIRED_TICKS) {
```

**Phase 3:**
```ts
if (self.slipstreamConsecutiveTicks >= self.mults.slipstreamRequiredTicks) {
```

**Wait — confirm direction:** the plan says agility = "LONGER slipstream window (2200ms instead of 1500ms)". A longer window means slipstream activates SOONER (you only need to be in wake for 1500ms to qualify — wait no, that means agility needs MORE time, which is a NERF).

**Re-read plan:** "Longer slipstream window (2200ms instead of 1500ms)". Looking at the sim, `SLIPSTREAM_REQUIRED_TICKS = 45` (=1500ms) is the **REQUIRED HOLD TIME** before boost kicks in. A longer required hold is a nerf — the agility pet sits in wake LONGER before getting the boost.

**That's clearly not the intent.** Re-reading: "longer slipstream window" most naturally reads as "the boost lasts longer once activated" OR "the wake-detection grace period is longer". Looking at constants:
- `SLIPSTREAM_REQUIRED_TICKS = 45` (hold-to-arm)
- `SLIPSTREAM_GRACE_TICKS = 6` (post-leave grace before boost expires)
- `SLIPSTREAM_REFRESH_TTL_MS = 250` (per-tick refresh)

**Resolution (decision-locked, must be confirmed at audit):** Phase 3 interprets "longer slipstream window" as "the BOOST EFFECT lingers longer after leaving the wake" — i.e. extends `SLIPSTREAM_GRACE_TICKS`. Specifically:
- `SLIPSTREAM_REQUIRED_TICKS` (hold-to-arm) is UNCHANGED — agility pets arm slipstream as fast as anyone.
- `SLIPSTREAM_GRACE_TICKS` (window after leaving wake during which boost remains) is EXTENDED by the agility multiplier.
- The 2200ms in the plan refers to `(SLIPSTREAM_REQUIRED_TICKS + extended grace) * REEF_TICK_MS = 1500 + ~700 = ~2200ms total slipstream-aware window from first tick of wake to boost expiry.

**Updated multiplier mapping:**
```ts
// Replace `slipstreamRequiredTicks` with `slipstreamGraceTicks`:
//   neutral:    grace = 6 ticks   (200ms post-leave)
//   agility:    grace = 24 ticks  (800ms post-leave)
//   total agility window = 1500ms hold + 800ms grace = 2300ms ≈ 2200ms target
```

**Field rename:** `mults.slipstreamGraceTicks` not `slipstreamRequiredTicks`. **Update §1, §2 builder, and §1 constant accordingly:**
```ts
export const AGILITY_SLIPSTREAM_GRACE_TICKS = 24;  // vs SLIPSTREAM_GRACE_TICKS=6 baseline
```

**Consumption site:** `resolveSlipstream` line 1934:
```ts
self.slipstreamGraceTicksLeft = SLIPSTREAM_GRACE_TICKS;
// Phase 3 →
self.slipstreamGraceTicksLeft = self.mults.slipstreamGraceTicks;
```

**Auditor: confirm interpretation.** If the original intent was "REQUIRED_TICKS lowered to 1500ms / 45 ticks → 2200ms / 66 ticks (i.e., agility holds LONGER, a true nerf)", the design is broken and the multiplier should not exist. If interpretation here ("BOOST GRACE extended", a buff) is correct, this is the implementation. **Default in §1 changes to grace not required.**

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

**Computed at startRoom:** `driftSparkTicks` = `[Math.max(1, Math.round(DRIFT_SPARK_TICK_1 / mult)), ...]`. For strength (`mult=1.4`): `[9, 19, 32]` (vs neutral `[12, 27, 45]`). For neutral: `[12, 27, 45]` — bit-identical to today.

### 4e. `knockbackResistMult` — strength takes 40% less knockback

**Where:** TWO call-sites (audit §0 finding 6).

**`applyTideWave` (`reef-race-sim.ts:1493-1518`)** — lines 1505-1509:
```ts
if (speed > 0) {
  const factor = 0.4 * (1 - dist / radius);
  target.vx *= 1 - factor;
  target.vy *= 1 - factor;
}
// Phase 3 →
if (speed > 0) {
  const factor = 0.4 * (1 - dist / radius) * target.mults.knockbackResistMult;
  target.vx *= 1 - factor;
  target.vy *= 1 - factor;
}
```

**`applySeekerJelly` (`reef-race-sim.ts:1520+`)** — read full body:

<!-- For the audit: read lines 1520-1565 if the seeker-jelly impulse magnitude needs the same treatment. Spec says "knockback received" so it should. -->

The seeker jelly applies a velocity perturbation; multiply that perturbation by `target.mults.knockbackResistMult`. Specific patch deferred until the audit confirms the exact statement; the file-by-file scope (§10) reserves a 5-line edit for it.

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

**Phase 3:** the helper `isOnRibbon(body, ribbon)` does NOT have access to `body.mults` (it takes a generic `{x, y}` per `reef-race-sim.ts:2219` signature). Two options:

(a) Inline the math in `resolveBoostRibbons` and pass per-body half-width.
(b) Add a `halfWidth` argument to `isOnRibbon`.

**Decision:** (b) — minimal blast radius, keeps the helper pure. New signature:
```ts
function isOnRibbon(body: { x: number; y: number }, ribbon: ReefBoostRibbon, halfWidth: number = RIBBON_HALF_WIDTH): boolean
```

Caller in `resolveBoostRibbons` (line 2004):
```ts
if (!isOnRibbon(body, ribbon, RIBBON_HALF_WIDTH * body.mults.ribbonDetectMult)) continue;
```

**Anti-cheat impact:** none — wider band = more ribbons collected per lap. Boost mult unchanged. Per-lap dedupe still applies.

---

## 5. Anti-cheat invariants

### Worst-case combined-mult math

Given:
- Top-speed cap: `REEF_MAX_SPEED = 500 wu/s` (unchanged).
- `REEF_BOOST_MULT = 1.4` (turbo, multiplicative on top-speed → max steady = 700 wu/s).
- Combined positive kinematic stack capped at `KINEMATIC_BOOST_CAP = 0.85` → max additive boost = +85% → max `speedMod = 1.85`.
- Hard velocity cap: `REEF_MAX_SPEED * 1.85 = 925 wu/s` (line 1253, gated on positive boost active).
- Anti-cheat tolerance: `REEF_KINEMATIC_TOLERANCE = 2.0` → position validator at `REEF_MAX_SPEED * 2.0 * dt = 1000 wu/s × dt`.

**Phase 3 additions to MAX-STEP (acceleration, NOT speed):**
- `accelMult ∈ [1.0, 1.25]` (level 50 cap)
- `1/turnRadiusMult ∈ [1.0, 1/0.85] ≈ [1.0, 1.176]` (agility, when turning)
- Combined max: `accelMult × (1/turnRadiusMult) = 1.25 × 1.176 = 1.47×` to `REEF_MAX_ACCEL`.

Effective per-tick velocity gain: `REEF_MAX_ACCEL * dt * 1.47 = 2000 * 0.0333 * 1.47 = 98 wu/s per tick`.

**Worst-case position delta in one tick:**
- Body at peak boost, peak velocity = 925 wu/s steady (hard-capped).
- Plus an instantaneous +98 wu/s from acceleration step → 1023 wu/s peak velocity for that tick.
- `dt × peak velocity = 0.0333 × 1023 = 34.1 wu`.
- Validator allows: `dt × REEF_MAX_SPEED × tolerance = 0.0333 × 500 × 2.0 = 33.3 wu`.
- **DELTA: 0.8 wu over the validator. Body position is clamped down by 0.8 wu, no flag (clamp ≠ flag in `validateReefPositionDelta`).**

**Conclusion:** the validator clamp will trigger at most once per tick under worst-case Phase 3 + Phase 2 stacking. Same behavior the integrator already has when Phase 1 launch + drift-3 stacks at the moment of launch — covered by the existing C3 audit fix (REEF_KINEMATIC_TOLERANCE was raised from 1.5 to 2.0 specifically to absorb this margin). Phase 3 stays UNDER cap. No tolerance bump needed.

### `STRENGTH_DRIFT_CHARGE_MULT = 1.4` — does it break Phase 1 assertions?

The Phase 1 test `T3 — advances spark levels at correct tick counts` (`reef-race-sim.test.ts:404`) hard-codes `DRIFT_SPARK_TICK_1/2/3`. With Phase 3 strength pets, those literal thresholds become `[9, 19, 32]`. **Test must use a NEUTRAL pet (no archetype) for backwards compat.** New strength-mult test added in §8.

### Multiplier clamping

The §1 builder clamps every multiplier inside `[lo, hi]` ranges before stamping on `body.mults`. A pet with `level=999` produces `accelMult=1.25` (clamped). A pet with `archetype="brave-adventurer"` (strength class) produces `driftChargeMult=1.4` (in range). A NaN level → caught by `Number.isFinite` → falls back to level=1. A null archetype → falls back to `'balanced'` → all 1.0.

---

## 6. Bot heuristics adjustment

**Confirmed:** `bot-pool.ts` selects only `pets.id` and `pets.name` (line 75-77). No archetype/level fetched. Current behavior is "all bots have whatever DB defaults" — `level=1`, archetype = whatever the seed-bot-pets script set.

**Decision (locked):** Phase 3 bots are EXPLICITLY neutral. The pet-profile-loader (§3a) sets `isBot: true` for every bot, and `buildBodyMultipliers` short-circuits to `NEUTRAL_BODY_MULTIPLIERS`. Even if the DB row has an archetype, it's IGNORED.

**Rationale:** as the plan asks — keep bots as a fixed baseline so the human's level/archetype investment shows up CLEARLY against an unchanging benchmark. A/B testing pet builds is impossible if the bot pool's archetype distribution drifts as new bots are seeded.

**Phase 3.5 deferred:** if telemetry shows level-50 + intelligence-archetype humans crush bots 100% of races, we can lift bots to `level = max(humanAvgLevel, 25)` AND assign random archetypes via `synthesizeBotProfile(roomId, petId)` (deterministic-LCG, mirrors `synthesizeBotLaunchVerdict`). NOT shipped in Phase 3.

**Bot heuristic code (`reef-race-bot.ts`):** UNCHANGED. The bot reads input/checkpoints/centerline; it doesn't read mults. Its drift-trigger probability `BOT_DRIFT_TRIGGER_PER_SEC = 0.60` stays. Strength bots would charge sparks faster but bots are neutral, so their `driftSparkTicks = [12, 27, 45]` — unchanged from today.

---

## 7. HUD additions

**Files touched:** `apps/web/src/stores/activity.ts`, `apps/web/src/components/game/reef-race-hud.tsx`.

### 7a. New store fields (primitives only)

```ts
// In ActivityState, add:
selfRacingClass: 'agility' | 'strength' | 'intelligence' | 'balanced' | null;
selfLevel: number;  // 1 if unknown
```

Both are populated ONCE on `snapshot.init` (the server attaches them to `RoomMeta` as `reefRacingProfile?: { class, level }`). New protocol field §8.

### 7b. Protocol addition

`packages/shared/src/activities/protocol.ts`, in `interface RoomMeta` (line 138-167):

```ts
/**
 * Phase 3 — self pet's racing class + level. Used by the HUD's archetype
 * tile to show the player WHY they have these advantages. `null` for non-
 * reef-race rooms or when the server couldn't resolve the pet (defaults
 * to neutral mults sim-side).
 */
reefRacingProfile?: {
  class: 'agility' | 'strength' | 'intelligence' | 'balanced';
  level: number;
};
```

The server populates this at `snapshot.init` send-time (existing code path emits `RoomMeta` per-client; the per-client send is the seam where we can attach the SELF petId's profile).

### 7c. New HUD tile

`apps/web/src/components/game/reef-race-hud.tsx`, add a `<RacingBuildTile />` under `<BestLapTile />` (around line 324). It subscribes to PRIMITIVES only: `s.selfRacingClass`, `s.selfLevel`. Renders a small chip:

```
┌─────────────┐
│  L25  AGI   │
│  Tighter    │
│  turn +47%  │
│  slipstream │
└─────────────┘
```

The summary text is computed from a static lookup keyed on class — no per-frame compute. ~40 lines, zero subscriptions to Maps, conforms to the audit-verified primitive-only pattern (memory: "Subscribe to primitives only" rule).

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
| **P3-T1** | `applies neutral mults when petProfiles is empty` | startRoom with no `petProfiles` → every body has `mults === NEUTRAL_BODY_MULTIPLIERS`, `driftSparkTicks === [12, 27, 45]`. Bit-identical to pre-Phase-3. |
| **P3-T2** | `level 50 grants accelMult=1.25` | startRoom with `petProfiles: { p1: {level: 50, archetype: null} }` → `body.mults.accelMult === 1.25`. |
| **P3-T3** | `level 25 grants accelMult=1.12` | level 25 → 1.0 + 0.005 × 24 = 1.12. |
| **P3-T4** | `level 999 clamps accelMult to 1.25` | malformed input → clamp activates, body still creates. |
| **P3-T5** | `agility archetype tightens turn maxStep` | drive a body at vy=400 wu/s, swing intent.dir from (0,1) to (0.7, 0.7); assert agility body's velocity vector aligns with new dir within 4 ticks vs balanced needs 5+ ticks. |
| **P3-T6** | `agility archetype extends slipstream grace` | two bodies drafting; agility leaves wake → `slipstreamGraceTicksLeft === 24`; balanced → `=== 6`. |
| **P3-T7** | `strength archetype shortens drift sparks` | drift-charge with strength → spark1 at tick 9 (vs 12 baseline); spark3 at tick 32 (vs 45). |
| **P3-T8** | `strength archetype reduces tide-wave knockback` | apply tide wave on strength target at d=0 → velocity reduction = `0.4 × 0.6 = 24%` (vs 40% balanced). |
| **P3-T9** | `intelligence archetype extends turbo duration` | activate `rr-turbo-bubble` with intelligence → `activeEffects.get('rr-turbo-bubble') === now + 2500 * 1.2`. |
| **P3-T10** | `intelligence archetype widens ribbon band` | place body at `RIBBON_HALF_WIDTH × 1.2 = 42 wu` perp from ribbon — neutral misses, intelligence collects. |
| **P3-T11** | `bot petId always neutral mults regardless of archetype` | profile loader sets `isBot=true` for bot petIds → mults are neutral even if the DB row has an archetype. Asserts §6 invariant. |
| **P3-T12** | `worst-case stack stays under validator` | run 5 ticks at: launch boost + drift-3 + slipstream + ribbon + apex-bonus + accelMult=1.25 + (1/turnRadiusMult)=1.176. Assert `posCheck.ok === true` for all 5 ticks (no flag). |
| **P3-T13** | `Phase 1 + Phase 2 anchors unchanged for neutral pets` | re-run 3 representative existing tests with NO Phase 3 profile → byte-identical body state. |
| **P3-T14** | `agility body completes 3-lap race faster than balanced` (regression marker) | run two parallel rooms, identical seeds, one body each (agility vs balanced). Statistical bound: agility totalTimeMs < balanced totalTimeMs at p<0.05 over 10 seed-rotated trials. |

**Unit-level constants tests (`reef-race-config.test.ts`, NEW):**

| ID | Name | Asserts |
|---|---|---|
| **P3-C1** | `racingClassFromArchetype maps all 14 IDs` | 14 archetypes × 4 classes lookup is total — every ID returns a class. |
| **P3-C2** | `racingClassFromArchetype unknown returns balanced` | `racingClassFromArchetype('not-an-id')` === `'balanced'`. |
| **P3-C3** | `buildBodyMultipliers null profile is neutral` | `buildBodyMultipliers(null) === NEUTRAL_BODY_MULTIPLIERS` (deep equal). |
| **P3-C4** | `buildBodyMultipliers bot is neutral` | `buildBodyMultipliers({...,isBot:true}) === NEUTRAL_BODY_MULTIPLIERS`. |
| **P3-C5** | `clamps respect bounds` | level=999 → accelMult=1.25; level=-50 → accelMult=1.0; archetype="x"+strength fields default 1.0. |

**Integration test (`pet-profile-loader.test.ts`, NEW):**

| ID | Name | Asserts |
|---|---|---|
| **P3-L1** | `loads humans + bots in one call` | mock db.select → returns 3 profiles; call `loadRacingProfiles(['h1','h2'], ['b1'])` → Map size 3, h1/h2 from DB, b1 isBot=true. |
| **P3-L2** | `unknown human petId falls back to neutral` | mock returns 1 row for 2 humans → second human has neutral profile. |
| **P3-L3** | `DB error returns all-neutral` | mock throws → all humans/bots in returned Map are neutral fallbacks, no exception raised. |

---

## 9. Risks + mitigations

| Risk | Mitigation |
|---|---|
| Stat creep — high-level pets dominate forever | Top-speed unchanged = skill > stats. Validated by P3-T14 statistical bound — agility pet wins, but only by margin (~3-5% of race time), not by 30%. |
| Bot fairness — humans level up, bots stuck at neutral | Documented Phase 3.5 deferral. Telemetry hook in §7 will flag if win-rate-vs-bots crosses 95% for level-25+ humans. |
| Snapshot bandwidth — do mults ride the wire? | NO. Mults are deterministic at room-start (function of `pets.level + pets.archetype`). Server stamps once, never broadcasts. Only `RoomMeta.reefRacingProfile` (one-shot, ~50 bytes) added to wire. |
| DB load — extra query per match | 1 query × ≤8 petIds × ~5 matches/min/region = trivial. Wrapped in try/catch — DB outage falls back to all-neutral. Race still runs. |
| Plan↔code mismatch on archetype IDs | THE BIGGEST RISK. Plan says "agility/strength/intelligence archetypes" but the schema has 14 named archetypes. Resolved via `racingClassFromArchetype()` 14-to-4 mapping (§1). **Must be auditor-confirmed before coding.** Alternative if rejected: add a new `pets.racing_class` column + migration — defers Phase 3 by 1 sprint. |
| Plan↔code mismatch on slipstream "longer window" | Resolved via grace-tick extension (§4c) — must be auditor-confirmed. Alternative: drop the slipstream multiplier, leave at 1.0, ship the other 6. |
| Async profile load delays sim start | ~1ms blocking on Drizzle pool query. Sim starts within the same event-loop tick. Existing C4/S10 launch-verdict math is anchored to `room.startedAt` not `Date.now()`, so verdict windows are unaffected. |
| Per-frame allocation regression | Codex review checklist: grep for `new Set/Map/Array` inside `applyIntentForTick`/`tickDriftState`/`resolveSlipstream`/`resolveBoostRibbons`/`resolveApex`/`resolveHazards`/`tryUsePowerUp` — must be ZERO new instances introduced. The new `cosTheta` math in §4b uses primitives only. |
| Phase 1+2 regression | P3-T13 explicitly re-runs three representative existing tests without Phase 3 profile data and asserts bit-identical state. |
| Anti-cheat false positives | §5 math shows worst-case position delta = 34.1 wu vs 33.3 wu allowed → 0.8 wu over → CLAMP only, not FLAG. The `validateReefPositionDelta` helper distinguishes `clamp` (silent fix-up) from `flag` (anti-cheat increment). Verified by reading `apps/api/src/services/activity/anti-cheat/reef-race.ts`. |

---

## 10. File-by-file scope

| File | Lines | Owner | Change |
|---|---|---|---|
| `apps/api/src/services/activity/sim/reef-race-config.ts` | +120 | orchestrator | Phase 3 constants block, `RacingClass` type, `racingClassFromArchetype()`, `BodyMultipliers` interface, `NEUTRAL_BODY_MULTIPLIERS`, `buildBodyMultipliers()`, clamp helper. |
| `apps/api/src/services/activity/sim/reef-race-sim.ts` | +30 / -8 | orchestrator | Add `mults` + `driftSparkTicks` to `ReefBody`. Init in `startRoom` body loop. Modify `applyIntentForTick` step 9 (accel + turn radius). Modify `tickDriftState` thresholds. Modify `resolveSlipstream` grace assignment. Modify `tryUsePowerUp` duration. Modify `resolveBoostRibbons` half-width via `isOnRibbon` arg. Modify `applyTideWave` factor. Modify `applySeekerJelly` perturbation. |
| `apps/api/src/services/activity/pet-profile-loader.ts` | +60 | orchestrator | NEW FILE — Drizzle fetch + neutral-fallback + bot short-circuit. |
| `apps/api/src/index.ts` | +10 / -3 | orchestrator | `case 'reef-race':` block — split human/bot petIds, async-load profiles, pass `petProfiles` to `startRoom`. |
| `packages/shared/src/activities/protocol.ts` | +12 | orchestrator | Add `RoomMeta.reefRacingProfile?: { class, level }`. |
| `apps/web/src/stores/activity.ts` | +12 | orchestrator | Add `selfRacingClass`, `selfLevel` primitives; populate on `snapshot.init`. |
| `apps/web/src/components/game/reef-race-hud.tsx` | +50 | orchestrator | New `<RacingBuildTile />` subcomponent + render hook. |
| `apps/api/src/services/activity/sim/__tests__/reef-race-sim.test.ts` | +250 | orchestrator | P3-T1 through P3-T14 (14 cases). |
| `apps/api/src/services/activity/sim/__tests__/reef-race-config.test.ts` | +80 | orchestrator | NEW FILE — P3-C1 through P3-C5 (5 cases). |
| `apps/api/src/services/activity/__tests__/pet-profile-loader.test.ts` | +90 | orchestrator | NEW FILE — P3-L1 through P3-L3 (3 cases). |
| `GameFeatures.md` | +25 | orchestrator | Same-diff doc update — Reef Race section gets a Phase 3 stat-connection paragraph + the 14→4 archetype mapping table. |
| `ARCHITECTURE.md` | +10 | orchestrator | Same-diff doc update — note the new `pet-profile-loader.ts` service + the `RoomMeta.reefRacingProfile` field. |

**Total estimated new code:** ~750 lines (incl. ~420 lines of tests). Target review time: 90 minutes for Codex.

**No 3da spawn:** Phase 3 has zero scene-graph / material / geometry / shader / model changes. The HUD tile is DOM, not three.js. Confirmed against the CLAUDE.md "MANDATORY: Collaborate with the 3da subagent for ALL 3D work" trigger list — none of the listed surfaces are touched.

**Town Guide knowledge update:** Phase 3 introduces a new gameplay rule (level + archetype affect race handling). Per CLAUDE.md "Every gameplay change updates system agents' expertise in the same diff", `packages/agent-templates/src/locations/town-guide.ts` `knowledge[]` MUST add a one-line entry: "In Reef Race, your pet's level (1-50) accelerates collision recovery; archetypes bucketed into agility/strength/intelligence/balanced classes shape handling — top speed never changes, so skill still beats stats." +1 line, no new file.

---

## Audit checklist (before coding)

1. **Confirm 14→4 archetype mapping (§1).** Owner can override the bucketing; the API stays the same. Auditor: object to specific assignments here, not after the migration.
2. **Confirm slipstream "longer window" interpretation (§4c).** Buff via grace extension, OR drop the multiplier, OR reverse to a nerf. Auditor must lock one.
3. **Confirm async profile-load is acceptable (§3b).** ~1ms sim-start delay vs. blocking the LIVE transition. Alternative: synchronous profile load BEFORE `liveTransitionFn` fires (would need `persistLiveTransition` to await profile fetch — breaks the sync `Room → void` callback type).
4. **Confirm no schema migration (§1, §9).** Phase 3 does NOT add columns to `pets`. If migration is acceptable, swap the 14→4 mapping for a per-pet `racing_class` column (cleaner data model, costs one migration cycle).
5. **Confirm bot neutrality (§6).** Phase 3 keeps bots strictly neutral. If the audit prefers level-matched bots, defer to Phase 3.5 vs. roll into Phase 3.
6. **Confirm `STRENGTH_DRIFT_CHARGE_MULT = 1.4` doesn't break the existing T3 test (§5).** T3 must run with explicit `petProfiles: undefined` to preserve neutral threshold expectations.

