# Reef Race Phase 2 — Detailed Implementation Plan

**Status:** Drafted — ready for audit.
**Branch:** `worktree-fix-bumper-build` (worktree at `.claude/worktrees/fix-bumper-build`)
**Date authored:** 2026-04-25
**Author:** Orchestrator (planning pass)
**High-level design:** `.claude/plans/reef-race-real-racing.md` §"Phase 2 — depth"
**Phase 1 reference:** `.claude/plans/reef-race-phase1-detailed.md` (SHA `b68068a`) + impl audit `aae73b4`

---

## 0. Baseline facts from source audit (post Phase 1 merge `f4d276e`)

Every value verified against live source.

| Fact | Source | Value |
|---|---|---|
| Sim tick | `reef-race-sim.ts:99` | `REEF_TICK_MS = 1000/30 ≈ 33.33ms` |
| Snapshot delta | `reef-race-sim.ts:103` | 5Hz → every 6 ticks |
| Snapshot keyframe | `reef-race-sim.ts:106` | 1Hz → every 30 ticks |
| Track ellipse | `reef-race-config.ts:110-111` | `REEF_TRACK_A=1100`, `REEF_TRACK_B=700` |
| Track lane half-width | `reef-race-config.ts:114` | `REEF_TRACK_HALF_WIDTH=150` (300wu lane) |
| Centerline / tangent | `reef-race-config.ts:133-155` | `reefCenterlineAt(t)` / `reefTangentAt(t)` — exported |
| Body radius | `reef-race-config.ts:101` | `REEF_BODY_RADIUS=22` |
| Pickup radius | `reef-race-config.ts:284` | `REEF_POWERUP_RADIUS=28` |
| `REEF_MAX_SPEED` | `reef-race-config.ts:85` | 500 wu/s |
| `REEF_BOOST_MULT` (turbo pickup) | `reef-race-config.ts:88` | 1.4× → +0.40 additive |
| Drift boost mults | `reef-race-config.ts:332` | `[0.12, 0.24, 0.38]` (drift-3 = +0.38) |
| Launch boost mult | `reef-race-config.ts:356` | 0.30 (+30%) |
| `REEF_KINEMATIC_TOLERANCE` | `reef-race-config.ts:374` | 2.0× (validators clamp at 1000 wu/s) |
| Hard velocity cap (boost-gated) | `reef-race-sim.ts:1062` | `REEF_MAX_SPEED * 1.85 = 925 wu/s` |
| `activeBoosts` map | `reef-race-sim.ts:178` | `Map<ReefBoostKind, ReefBoostEntry>` |
| `ReefBoostKind` union | `reef-race-config.ts:302` | `'launch-boost' | 'launch-stall' | 'drift-boost'` |
| `applyIntentForTick` step 4 (speedMod) | `reef-race-sim.ts:775-810` | takes MAX of `kineticMult` vs `pickupMult` |
| Boost-gated hard cap site | `reef-race-sim.ts:1057-1067` | inside `integrateMotion`, gate `isBoostActive` |
| Snapshot diff predicate | `reef-race-sim.ts:1487-1500` | field-by-field equality on `prev` vs current |
| `EntityDelta.changed` schema | `protocol.ts:136-145` | open dictionary `[k: string]: unknown` |
| `applyEntityDelta` | `activity.ts:278-314` | explicit field copy; unknown fields ignored |
| `ServerFrame` union exhaustiveness | `activity.ts:758-764` | `default: never` guard — type-only catch |
| `tryUsePowerUp` slot uses | `reef-race-sim.ts:1240-1277` | calls `rollPowerUpKind(state)` once per respawn |
| `rollPowerUpKind` | `reef-race-sim.ts:1588-1597` | weighted draw across 6 kinds, GLOBAL (no placement input) |
| `tickPickups` respawn site | `reef-race-sim.ts:1126-1142` | sets `pk.kind = this.rollPowerUpKind(state)` |
| Test helper `bootDriftRoom` | `reef-race-sim.test.ts:333-352` | reused for drift/launch tests; pattern source |
| Bot opening grace | `reef-race-bot.ts:41` | 2500ms |
| Bot view shape | `bot-controller.ts:63-96` + `reef-race-sim.ts:961-1015` | extended via `ReefBotRoomView` (`nextCheckpoint?`, `checkpoints?`) |

**No file** at `packages/shared/src/types/activity-frames.ts`. Protocol lives in `packages/shared/src/activities/protocol.ts`. All Phase 2 references to "activity-frames.ts" mean `protocol.ts`.

---

## 1. Constants (server)

All numeric tunables go in `apps/api/src/services/activity/sim/reef-race-config.ts`. Phase 2 introduces a single combined-kinematic-cap constant (`KINEMATIC_BOOST_CAP`) that bounds additive stacking under the existing 2.0× tolerance.

### 1.1 New `ReefBoostKind` extensions

```ts
export type ReefBoostKind =
  | 'launch-boost'      // existing (Phase 1)
  | 'launch-stall'      // existing (Phase 1)
  | 'drift-boost'       // existing (Phase 1)
  | 'slipstream-boost'  // NEW Phase 2
  | 'ribbon-boost'      // NEW Phase 2
  | 'apex-bonus'        // NEW Phase 2 — small +5%
  | 'apex-penalty'      // NEW Phase 2 — small -5% (drift wide)
  | 'hazard-slow';      // NEW Phase 2 — sea urchin field clip
```

`apex-penalty` and `hazard-slow` carry a `mult: number` that is **negative** so the same speedMod arithmetic reads them as a downstream subtraction. The name `boost` is an artifact — the union represents kinematic effects (positive or negative), distinct from `activeEffects` (pickup-only) per the C2 invariant from Phase 1.

### 1.2 Combined kinematic cap

```ts
/**
 * Phase 2 — soft cap on the combined ADDITIVE kinematic mult applied in
 * applyIntentForTick step 4. Bounds drift + launch + slipstream + ribbon +
 * apex stacking so the sum never crosses REEF_KINEMATIC_TOLERANCE (2.0×).
 *
 *   Max possible additive stack:
 *     drift-3 (0.38) + launch (0.30) + slipstream (0.20) + ribbon (0.30)
 *     + apex-bonus (0.05) = 1.23 → 1 + 1.23 = 2.23×
 *
 *   Cap at 0.85 → 1 + 0.85 = 1.85× = same backstop as the existing hard cap
 *   in integrateMotion. Anti-cheat tolerance (2.0×) buffers above this by
 *   0.15×, leaving room for one tick of integration overshoot.
 *
 *   Negative entries (apex-penalty, hazard-slow) bypass the cap (they only
 *   reduce). The cap lives ABOVE the existing speedMod = max(kinematic,
 *   pickup) take, so the legacy "turbo-bubble overrides drift" rule still
 *   applies when the pickup mult exceeds the capped kinematic stack.
 */
export const KINEMATIC_BOOST_CAP = 0.85;
```

### 1.3 Slipstream

```ts
/** Min distance behind a target to count as in-wake (wu). Same as Phase 1 body radius pad. */
export const SLIPSTREAM_MIN_DISTANCE = REEF_BODY_RADIUS * 1.5; // 33 wu — avoid self-collision spam
/** Max distance behind a target to count as in-wake (wu). Plan-locked at 50wu. */
export const SLIPSTREAM_MAX_DISTANCE = 50;
/** Half-width of the wake cone behind the target, perpendicular to their velocity (wu). */
export const SLIPSTREAM_HALF_WIDTH = REEF_BODY_RADIUS * 1.5; // 33 wu — slightly wider than 1 body
/** Min |dot(self.vel, target.vel)| / (|self||target|) to count as "moving the same way". */
export const SLIPSTREAM_MIN_VEL_ALIGNMENT = 0.5; // ≈ 60° spread
/**
 * Required consecutive ticks in valid wake to trigger boost. 1.5s × 30Hz = 45 ticks.
 * Same magnitude as DRIFT_SPARK_TICK_3 (full hairpin) — tuned to feel deliberate.
 */
export const SLIPSTREAM_REQUIRED_TICKS = 45;
/**
 * +20% top-speed mult while in-wake, per high-level plan §Phase 2 line 63.
 * Applied as additive contribution to kineticMult, capped via KINEMATIC_BOOST_CAP.
 */
export const SLIPSTREAM_BOOST_MULT = 0.20;
/**
 * Grace ticks after leaving the wake before boost expires. Avoids dropouts on
 * 1-tick lateral wobble. 0.2s = 6 ticks.
 */
export const SLIPSTREAM_GRACE_TICKS = 6;
```

### 1.4 Cornering apex

The track has two hairpins on the ellipse poles where curvature is highest. Computed once at config load.

```ts
/**
 * Apex marker is a planar disc on the INSIDE of each hairpin. Computed off the
 * checkpoint AABBs at the two hairpin t-values:
 *   Hairpin A (CCW pole): t = 0.25  → checkpoint index 3, sim center ≈ (-1100, 0)
 *   Hairpin B (CW pole):  t = 0.75  → checkpoint index 9, sim center ≈ (+1100, 0)
 *
 * Inside line is in the direction of the inward normal (already computed by
 * buildReefCheckpoints()); offset = REEF_TRACK_HALF_WIDTH * 0.55 → 82.5wu in
 * from the centerline, well clear of the outer guardrail.
 */
export const APEX_HAIRPIN_CHECKPOINT_INDICES: readonly [number, number] = [3, 9];
/** Inward offset from centerline to apex marker center (wu). */
export const APEX_INSIDE_OFFSET = REEF_TRACK_HALF_WIDTH * 0.55; // 82.5 wu
/** Outward offset for the "drift wide" detection ring (wu). */
export const APEX_OUTSIDE_OFFSET = REEF_TRACK_HALF_WIDTH * 0.55; // 82.5 wu
/** Apex disc radius (wu). Slightly bigger than the body so a clean clip counts. */
export const APEX_INNER_RADIUS = REEF_BODY_RADIUS * 2; // 44 wu
/** Outside-line ring radius (wu). */
export const APEX_OUTER_RADIUS = REEF_BODY_RADIUS * 2; // 44 wu
/** Speed mults — small numbers per high-level plan §Phase 2 line 64. */
export const APEX_BONUS_MULT   = 0.05;  // +5%
export const APEX_PENALTY_MULT = -0.05; // -5%
/** Bonus / penalty duration (ms). 1.5s → ~half the time it takes to leave the corner. */
export const APEX_DURATION_MS = 1_500;
/**
 * Re-arming behaviour: each (petId, lap, hairpinIndex) triple awards a verdict
 * AT MOST ONCE. Re-traversing on a subsequent lap re-arms. Tracked via a
 * per-body Set<string> keyed by `${lap}:${hairpinIndex}` (cleared on lap-up).
 */
```

### 1.5 Boost ribbons

The track has two long straights — top and bottom of the ellipse (t≈0 and t≈0.5). Plan painted on each.

```ts
/**
 * Boost ribbon — straight-line segment painted on the track surface. Crossing
 * the segment with a body radius overlap fires +30% / 2s.
 *
 * Geometry: each ribbon is an oriented line segment in sim-space (Vec2 a, Vec2 b).
 * The detection AABB is along the segment tangent, lane-perpendicular extents
 * = RIBBON_HALF_WIDTH. A body crossing the segment has its t-projection in [0,1]
 * AND |perp distance| ≤ RIBBON_HALF_WIDTH.
 *
 * Phase 2 ships ONE ribbon per straight (2 total). Future Phase can add side-by-
 * side parallel ribbons for "pick a line".
 */
export interface ReefBoostRibbon {
  /** Ribbon id — petId-scoped "already collected this lap" set keys on this. */
  id: string;
  /** Start / end of the centerline segment in sim-space (wu). */
  a: Vec2;
  b: Vec2;
}

/**
 * Ribbons computed at module-load from centerline:
 *   - Ribbon "rib-top" — straight near t=0 (top of ellipse, near start/finish):
 *     a = reefCenterlineAt(0.96), b = reefCenterlineAt(0.04)
 *     → ~480 wu chord across the start straight, finish-line gap excluded
 *   - Ribbon "rib-bot" — straight near t=0.5 (bottom of ellipse):
 *     a = reefCenterlineAt(0.46), b = reefCenterlineAt(0.54)
 *
 * Stored as a builder (not a literal) so future Phase tweaks can re-parametrise.
 */
export function buildReefBoostRibbons(): ReefBoostRibbon[];

/** Half-width of ribbon detection band, perpendicular to segment tangent (wu). */
export const RIBBON_HALF_WIDTH = REEF_BODY_RADIUS * 1.6; // 35 wu (driver picks the line)
/** Ribbon collection mult (additive). Plan-locked at +30%. */
export const RIBBON_BOOST_MULT = 0.30;
/** Ribbon boost duration (ms). Plan-locked at 2s. */
export const RIBBON_BOOST_DURATION_MS = 2_000;
/**
 * Per-ribbon collection cooldown (ms) — prevents oscillation along the segment.
 * Independent from RIBBON_BOOST_DURATION_MS so a player can collect ribbon-A,
 * lose the boost, then collect ribbon-B mid-lap.
 */
export const RIBBON_COLLECTION_COOLDOWN_MS = 5_000;
```

### 1.6 Hazard patches

```ts
/**
 * Hazard patch — circular slow zone clipping the inside-line of each hairpin.
 * "Sea urchin field" per high-level plan §Phase 2 line 65. Faster route through
 * the apex BUT you eat -40% speed while inside.
 *
 * Phase 2 ships ONE hazard per hairpin (2 total). Center is offset from the
 * hairpin checkpoint center along its inward normal — slightly INSIDE the apex
 * marker so the apex bonus + hazard-clip combination forces a real choice.
 */
export interface ReefHazardPatch {
  id: string;
  center: Vec2;
  radius: number;
}

export function buildReefHazardPatches(): ReefHazardPatch[];

/**
 * Hazard patch radius (wu). Body must center-overlap to count. Tuned so the
 * hazard fits between the apex marker and the centerline → drift-wide gives
 * apex-penalty, perfect-line gives apex-bonus, urchin-clip gives speed-damage.
 */
export const HAZARD_RADIUS = REEF_BODY_RADIUS * 2.5; // 55 wu
/** Inward offset from centerline to hazard center (wu). Slightly INSIDE apex marker. */
export const HAZARD_INSIDE_OFFSET = REEF_TRACK_HALF_WIDTH * 0.40; // 60 wu
/**
 * Hazard mult (additive negative). speedMod becomes 1 + boost - 0.40, then
 * clamped >= 0.5 by the same min-clamp that backstops ink-slick. Crossing
 * during a drift-3 release leaves you at 1.38 - 0.40 = 0.98 → still slightly
 * faster than baseline because the boost is buying you the "shortcut".
 */
export const HAZARD_SLOW_MULT = -0.40;
/**
 * Refresh cadence — hazard re-applies every tick the body overlaps. Effect
 * is set once with a short expiry; re-firing extends. Avoids a "leave the
 * patch but the boost lingers" feel.
 */
export const HAZARD_TICK_DURATION_MS = 200; // 6 ticks — enough to absorb tick scheduling jitter
```

### 1.7 Placement-weighted power-up table

```ts
/**
 * Placement-keyed power-up roll table. Replaces the global `rollPowerUpKind`
 * draw at pickup respawn (`tickPickups`) when a placement is supplied.
 *
 * Mario Kart rubber band — leaders get defensive items only, trailers get
 * aggressive items more often. Mid-pack rolls the legacy global table.
 *
 * Weights are RELATIVE within each placement bucket (don't need to sum to 100).
 * The roll is sum-then-LCG-mod-then-walk, identical to existing rollPowerUpKind.
 *
 * 1st place — defensive only:
 *   rr-bubble-shield 50 · rr-ink-slick 30 · rr-turbo-bubble 20 (no offensive)
 * 2nd–3rd — defensive-leaning:
 *   rr-turbo-bubble 35 · rr-bubble-shield 25 · rr-ink-slick 20 · rr-tide-wave 10 ·
 *   rr-seeker-jelly 7 · rr-whirlpool 3
 * 4th–5th — neutral (matches global default):
 *   rr-turbo-bubble 50 · rr-bubble-shield 12 · rr-ink-slick 10 ·
 *   rr-seeker-jelly 10 · rr-tide-wave 8 · rr-whirlpool 10
 * 6th–7th — aggressive-leaning:
 *   rr-seeker-jelly 25 · rr-tide-wave 22 · rr-turbo-bubble 20 ·
 *   rr-whirlpool 18 · rr-ink-slick 10 · rr-bubble-shield 5
 * 8th — aggressive only:
 *   rr-whirlpool 35 · rr-seeker-jelly 30 · rr-tide-wave 25 · rr-turbo-bubble 10
 */
export const PLACEMENT_ITEM_TABLE: Record<
  number,
  ReadonlyArray<{ kind: ReefPowerUpKind; weight: number }>
> = {
  1: [
    { kind: 'rr-bubble-shield', weight: 50 },
    { kind: 'rr-ink-slick',     weight: 30 },
    { kind: 'rr-turbo-bubble',  weight: 20 },
  ],
  2: [/* see "2nd–3rd" weights above */],
  3: [/* same as 2 */],
  4: [/* see "4th–5th" — matches REEF_POWERUP_DEFS distribution */],
  5: [/* same as 4 */],
  6: [/* see "6th–7th" weights above */],
  7: [/* same as 6 */],
  8: [
    { kind: 'rr-whirlpool',    weight: 35 },
    { kind: 'rr-seeker-jelly', weight: 30 },
    { kind: 'rr-tide-wave',    weight: 25 },
    { kind: 'rr-turbo-bubble', weight: 10 },
  ],
};

/**
 * Look up the weighted item table for a given placement. Out-of-range
 * placements (placement < 1 OR placement > 8) fall through to the legacy
 * global REEF_POWERUP_DEFS distribution — same code path as today.
 */
export function getPlacementItemTable(placement: number):
  ReadonlyArray<{ kind: ReefPowerUpKind; weight: number }> | null;
```

**Table justification.** The table flattens at the extremes (1st = pure defense, 8th = pure offense) but interpolates through the middle. Asymmetry is the rubber band: 1st place gets shield+slick to defend a lead, 8th gets whirlpool+seeker to actually catch up. Empirically tuned to match Mario Kart 8's "place 8 = lightning" intensity without the lightning itself (which would be a power-up addition, deferred).

### 1.8 Cap on combined kinematic — applied in `applyIntentForTick` step 4

```ts
// Refer to §2.1 below — the cap math is in the sim, the constant is in config.
export const KINEMATIC_BOOST_FLOOR = -0.50; // hazard + apex-penalty combined cannot drop more than 50%
```

This floor mirrors the existing ink-slick clamp — guarantees `speedMod >= 0.5` regardless of how many negative effects stack.

---

## 2. Server sim integration

### 2.1 New per-body state on `ReefBody` (§3 details types)

Phase 2 adds `slipstream`, `apex`, `ribbons`, `hazard` slices. None replace the existing `drift` / `currentDriftBoostSparks` / `activeBoosts` fields.

### 2.2 Where each mechanic plugs into the tick

The existing tick pipeline is (see `reef-race-sim.ts:677-748`):

```
0. runBotControllers
1. applyIntentForTick (per body — drift state, intent → speedMod → velocity)
2. integrateMotion (per body — position + validators + boost-gated hard cap)
3. expire activeEffects + activeBoosts
4. resolveProximity
5. resolvePickups
6. tickPickups (RESPAWN ROLL — placement table plugs here)
7. resolveCheckpoints
8. shouldEndRound check
9. snapshot broadcast
```

**Phase 2 insertions** (numbered to match existing comment):

```
2.5 [NEW] resolveSlipstream(state, now)
        — checks all body pairs for in-wake conditions; updates
          body.slipstreamConsecutiveTicks; sets/clears 'slipstream-boost'
          activeBoosts entry.

2.7 [NEW] resolveBoostRibbons(state, now)
        — segment-collision against state.ribbons; on first cross per lap fires
          'ribbon-boost' + broadcast event.ribbon_collected.

2.8 [NEW] resolveApex(state, now)
        — per body: if inside an inner-apex disc and we haven't credited this
          (lap, hairpinIndex) yet, fire 'apex-bonus'. Else if inside outer ring,
          fire 'apex-penalty'. Broadcast event.apex_bonus / event.apex_wide.

2.9 [NEW] resolveHazards(state, now)
        — per body: if center inside any hazard, set/refresh 'hazard-slow'.
          Broadcast event.hazard_hit at most once per (petId, hazardId) per lap.

6  tickPickups — modify rollPowerUpKind call site to use placement table.
```

Insert order matters:
- Slipstream BEFORE checkpoint resolution because both walk the body list and slipstream needs current positions (no position mutation between them).
- Ribbons + apex + hazard AFTER `tickPickups` so power-up respawn doesn't see stale state, and BEFORE `resolveCheckpoints` so a hazard hit in the same tick as a checkpoint cross logs both.

### 2.3 Modified `applyIntentForTick` step 4 (speedMod arithmetic)

The current code (`reef-race-sim.ts:775-810`) computes:

```ts
const kineticMult = (launchBoosted ? LAUNCH_BOOST_MULT : 0)
                  + (driftBoosted ? DRIFT_BOOST_MULTS[...] : 0);
const pickupMult  = powerBoosted ? REEF_BOOST_MULT - 1.0 : 0;
const bestMult    = Math.max(kineticMult, pickupMult);
speedMod = slicked ? 0.5 : 1.0 + bestMult;
```

Phase 2 replacement (still inside the `else` branch of `if (stalled)`):

```ts
// Sum positive kinematic contributions:
const launchAdd     = body.activeBoosts.has('launch-boost')
  ? LAUNCH_BOOST_MULT : 0;
const driftAdd      = (body.activeBoosts.has('drift-boost')
                        && body.currentDriftBoostSparks >= 1)
  ? (DRIFT_BOOST_MULTS[body.currentDriftBoostSparks - 1] ?? 0)
  : 0;
const slipstreamAdd = body.activeBoosts.get('slipstream-boost')?.mult ?? 0;
const ribbonAdd     = body.activeBoosts.get('ribbon-boost')?.mult ?? 0;
const apexBonusAdd  = body.activeBoosts.get('apex-bonus')?.mult ?? 0;

// Sum negative kinematic contributions (mults stored as negative numbers):
const apexPenSub  = body.activeBoosts.get('apex-penalty')?.mult ?? 0;
const hazardSub   = body.activeBoosts.get('hazard-slow')?.mult  ?? 0;

const positiveKineticRaw = launchAdd + driftAdd + slipstreamAdd + ribbonAdd + apexBonusAdd;
// Cap the POSITIVE stack; negatives are unaffected (cap should not protect a slow).
const positiveKinetic = Math.min(positiveKineticRaw, KINEMATIC_BOOST_CAP);

// Negative stack uses a floor (mirrors ink-slick's 0.5 floor).
const negativeKinetic = Math.max(apexPenSub + hazardSub, KINEMATIC_BOOST_FLOOR);

const kineticMult = positiveKinetic + negativeKinetic;
const pickupMult  = powerBoosted ? REEF_BOOST_MULT - 1.0 : 0;

// Take MAX of kinematic vs pickup additive (S4 rule preserved).
const bestMult = Math.max(kineticMult, pickupMult);

// ink-slick still hard-overrides to 0.5 (existing rule preserved).
speedMod = slicked ? 0.5 : Math.max(0.5, 1.0 + bestMult);
```

**Properties:**
- Drift-3 alone: kineticMult = 0.38, speedMod = 1.38.
- Drift-3 + launch: 0.68, capped at 0.85, speedMod = 1.85. (Today: 0.68, no cap; capped already by integrateMotion's hard cap at 1.85.)
- Drift-3 + launch + slipstream: 0.88 → capped at 0.85.
- All five positives (drift-3 + launch + slipstream + ribbon + apex-bonus = 1.23) → capped at 0.85.
- Hazard alone: 0.60 (1 - 0.40), positive cap doesn't apply.
- Apex-penalty + hazard = 0.45 → floored at 0.5.
- Ink-slick + drift-3: still 0.5 (slicked override stays).
- Turbo-bubble + drift-3 + launch + slipstream = `max(0.40, 0.85)` = 0.85 → speedMod = 1.85.

**Anti-cheat headroom** (load-bearing):
- Max legit speedMod = 1.85.
- Under `REEF_KINEMATIC_TOLERANCE = 2.0`, validator allows up to 1000 wu/s.
- Boost-gated hard cap at `REEF_MAX_SPEED * 1.85 = 925 wu/s` — same as Phase 1, **needs to widen to include slipstream/ribbon/apex-bonus** (next item).

### 2.4 Boost-gated hard cap update (`integrateMotion`)

Current Phase 1 site (`reef-race-sim.ts:1057-1067`):

```ts
const isBoostActive =
  body.activeBoosts.has('launch-boost') ||
  body.activeBoosts.has('drift-boost');
if (isBoostActive) { /* hardCap = REEF_MAX_SPEED * 1.85 */ }
```

Phase 2 replacement — gate widens to include all positive kinematic effects:

```ts
const isPositiveBoostActive =
  body.activeBoosts.has('launch-boost')      ||
  body.activeBoosts.has('drift-boost')       ||
  body.activeBoosts.has('slipstream-boost')  ||
  body.activeBoosts.has('ribbon-boost')      ||
  body.activeBoosts.has('apex-bonus');
if (isPositiveBoostActive) {
  const speed = Math.hypot(body.vx, body.vy);
  const hardCap = REEF_MAX_SPEED * 1.85; // unchanged
  if (speed > hardCap) {
    body.vx = (body.vx / speed) * hardCap;
    body.vy = (body.vy / speed) * hardCap;
  }
}
```

The cap value stays at 1.85× because `KINEMATIC_BOOST_CAP = 0.85` makes 1.85× the new hard ceiling — no headroom needed beyond the existing margin.

### 2.5 `tickPickups` — placement-weighted respawn roll

Current (`reef-race-sim.ts:1126-1142`):

```ts
pk.kind = this.rollPowerUpKind(state); // global weights
```

Replacement at the SAME line (no other changes to `tickPickups`):

```ts
// Phase 2 — placement-weighted roll. Compute live placement when the pickup
// fires its respawn roll. Falls through to legacy global weights if placement
// resolution returns null (race not yet started, or only one body alive).
const placementMap = this.computeLivePlacements(state);
// Note: pickup respawn fires on a body-AGNOSTIC tick. The pickup doesn't
// know "which body will eventually collect it." So we keep the legacy global
// weights for the SPAWN roll (item is shown in the world before pickup) and
// re-roll AT COLLECT TIME, keyed on the COLLECTOR's placement.
pk.kind = this.rollPowerUpKind(state); // unchanged at spawn
```

Then in `resolvePickups` (`reef-race-sim.ts:1095-1124`), at the moment a body collects:

```ts
// Existing: const slot = body.inventory.findIndex((s) => s.kind === null);
// New: re-roll the kind based on the collector's placement.
const collectorPlacement = placementMap.get(body.petId);
const finalKind = collectorPlacement
  ? this.rollPowerUpKindForPlacement(state, collectorPlacement)
  : pk.kind; // fall back to spawn-time kind
body.inventory[slot] = { kind: finalKind, charges: 1, cooldownUntil: 0 };
// IMPORTANT — pk.kind is what the WORLD shows; the COLLECTED kind can differ.
// Broadcast event.power_up_collected as today; the snapshot's `inventory`
// PowerUpDelta carries the actual collected kind (already the source of truth
// for the HUD).
```

This split avoids "pickup turns into a different mesh visually mid-flight" while still allowing the rubber band to fire. The collected kind is what the player gets; the in-world spawn kind is cosmetic only (and identical to today).

`rollPowerUpKindForPlacement(state, placement)` is a new private method on `ReefRaceSim` that walks `PLACEMENT_ITEM_TABLE[placement]` (or falls through to `rollPowerUpKind` if entry is null/undefined). Uses the existing LCG (`lcgNext(state)`) so determinism is preserved.

### 2.6 `computeLivePlacements`

```ts
/**
 * Live placement computed from race progress = lap*REEF_CHECKPOINT_COUNT +
 * (REEF_CHECKPOINT_COUNT - nextCheckpoint) for racing bodies. Higher progress
 * = better placement (1 = leader). Finished bodies retain finish placement.
 * DNF / forfeited bodies appended last.
 *
 * Returns a Map<petId, placement> with placements 1..N. Pure function of
 * state — safe to call from any tick step.
 *
 * Cost: O(N log N) on N <= 8. Called at most once per pickup-collect tick
 * (in `resolvePickups`) AND once per snapshot tick (in `broadcastDelta` —
 * see §4.4 for placement deltas in the wire protocol).
 */
private computeLivePlacements(state: ReefRoomState): Map<string, number>;
```

Implementation (concise):

```ts
const racing: Array<{petId: string; progress: number; finishedAt: number | null; dnf: boolean}> = [];
for (const b of state.bodies.values()) {
  if (b.dnf || b.forfeited) {
    racing.push({petId: b.petId, progress: -Infinity, finishedAt: null, dnf: true});
    continue;
  }
  if (b.finishedAt !== null) {
    // Finishers ranked by totalTimeMs ascending (already in finishOrder).
    racing.push({petId: b.petId, progress: Infinity, finishedAt: b.finishedAt, dnf: false});
    continue;
  }
  // Race progress: full laps + completed checkpoints in the current lap.
  // nextCheckpoint=1 means we just crossed 0 → 0 fully done; nextCheckpoint=11
  // means we've crossed 1..10 = 10 done. Wrap: nextCheckpoint=0 means we've
  // crossed 1..11 and are about to cross 0 → 11 done (+ lap-start).
  const cpDone = b.nextCheckpoint === 0
    ? REEF_CHECKPOINT_COUNT - 1
    : b.nextCheckpoint - 1;
  racing.push({
    petId: b.petId,
    progress: b.lap * REEF_CHECKPOINT_COUNT + cpDone,
    finishedAt: null,
    dnf: false,
  });
}
// Sort: finishers first by finishedAt asc, then racers by progress desc, then DNF.
racing.sort((a, b) => {
  if (a.finishedAt !== null && b.finishedAt !== null) return a.finishedAt - b.finishedAt;
  if (a.finishedAt !== null) return -1;
  if (b.finishedAt !== null) return 1;
  if (a.dnf && !b.dnf) return 1;
  if (!a.dnf && b.dnf) return -1;
  return b.progress - a.progress;
});
const out = new Map<string, number>();
racing.forEach((r, i) => out.set(r.petId, i + 1));
return out;
```

### 2.7 `resolveSlipstream` (new private method on `ReefRaceSim`)

```ts
private resolveSlipstream(state: ReefRoomState, now: number): void {
  // Snapshot the racing-body list once.
  const bodies: ReefBody[] = [];
  for (const b of state.bodies.values()) {
    if (b.alive && !b.dnf && b.finishedAt === null && !b.forfeited) bodies.push(b);
  }
  // Per-body inner loop — O(N²) on N≤8 = 64 checks/tick. Cheap.
  for (const self of bodies) {
    let bestSrc: ReefBody | null = null;
    for (const target of bodies) {
      if (target === self) continue;
      // Vector self → target.
      const dx = target.x - self.x;
      const dy = target.y - self.y;
      const distSq = dx * dx + dy * dy;
      const minSq = SLIPSTREAM_MIN_DISTANCE * SLIPSTREAM_MIN_DISTANCE;
      const maxSq = SLIPSTREAM_MAX_DISTANCE * SLIPSTREAM_MAX_DISTANCE;
      if (distSq < minSq || distSq > maxSq) continue;
      // Target's velocity must be non-trivial (a parked car can't make wake).
      const tSpeed = Math.hypot(target.vx, target.vy);
      if (tSpeed < REEF_MAX_SPEED * 0.30) continue;
      // Self must be BEHIND the target (dot(self→target, target.vel) > 0).
      const dot = (dx * target.vx + dy * target.vy) / (tSpeed);
      if (dot <= 0) continue;
      // Lateral offset must be within wake half-width.
      const dist = Math.sqrt(distSq);
      // Perpendicular component of self→target relative to target.vel:
      const perpMag = Math.abs(dx * target.vy - dy * target.vx) / tSpeed;
      if (perpMag > SLIPSTREAM_HALF_WIDTH) continue;
      // Velocities must be roughly aligned (both moving the same way).
      const sSpeed = Math.hypot(self.vx, self.vy);
      if (sSpeed < REEF_MAX_SPEED * 0.30) continue;
      const align = (self.vx * target.vx + self.vy * target.vy) / (sSpeed * tSpeed);
      if (align < SLIPSTREAM_MIN_VEL_ALIGNMENT) continue;
      // Prefer the closest valid target (avoid bouncing between two leaders).
      if (!bestSrc || dist < Math.hypot(bestSrc.x - self.x, bestSrc.y - self.y)) {
        bestSrc = target;
      }
    }
    if (bestSrc) {
      // Continue / start charging.
      if (self.slipstreamSourcePetId === bestSrc.petId) {
        self.slipstreamConsecutiveTicks++;
      } else {
        self.slipstreamSourcePetId = bestSrc.petId;
        self.slipstreamConsecutiveTicks = 1;
      }
      self.slipstreamGraceTicksLeft = SLIPSTREAM_GRACE_TICKS;
      // Threshold reached → set / refresh boost.
      if (self.slipstreamConsecutiveTicks >= SLIPSTREAM_REQUIRED_TICKS) {
        const wasActive = self.activeBoosts.has('slipstream-boost');
        self.activeBoosts.set('slipstream-boost', {
          expiresAt: now + 200, // refresh tick-by-tick while in wake
          mult: SLIPSTREAM_BOOST_MULT,
        });
        if (!wasActive) {
          this.broadcastFn(state.roomId, {
            type: 'event.slipstream',
            srcPetId: bestSrc.petId,
            dstPetId: self.petId,
          });
        }
      }
    } else {
      // Out of wake — apply grace, then clear.
      if (self.slipstreamGraceTicksLeft > 0) {
        self.slipstreamGraceTicksLeft--;
      } else {
        if (self.activeBoosts.has('slipstream-boost')) {
          // Let activeBoosts sweep handle clearing; just do not refresh.
          // expiresAt was set to now+200ms on the last refresh, so it'll
          // naturally expire in ~6 ticks.
        }
        self.slipstreamSourcePetId        = null;
        self.slipstreamConsecutiveTicks   = 0;
      }
    }
  }
}
```

**Notes:**
- Module-scope scratch is NOT used here because the inner loop allocates only Numbers (V8 will keep them on stack). The `bodies` array is rebuilt once per call — acceptable cost on N≤8.
- Audit-thinking — interaction with collisions: `resolveProximity` runs AFTER slipstream (step 4). Two bodies inside `REEF_BODY_RADIUS * 2 = 44wu` of each other separate. Slipstream's `MIN_DISTANCE = 33wu < 44`, so a collision will push them apart and break the wake naturally. No deadlock.

### 2.8 `resolveBoostRibbons` (new private method)

```ts
private resolveBoostRibbons(state: ReefRoomState, now: number): void {
  if (state.ribbons.length === 0) return; // future-proof
  for (const body of state.bodies.values()) {
    if (!body.alive || body.dnf || body.finishedAt !== null || body.forfeited) continue;
    for (const ribbon of state.ribbons) {
      // Skip if already collected this lap.
      const key = `${body.lap}:${ribbon.id}`;
      if (body.ribbonsCollectedThisLap.has(key)) continue;
      // Per-ribbon cooldown (5s) — prevents oscillating across the line.
      const lastCollect = body.ribbonLastCollectedAt.get(ribbon.id) ?? 0;
      if (now - lastCollect < RIBBON_COLLECTION_COOLDOWN_MS) continue;
      // Segment-distance test: project body onto ribbon.a→ribbon.b.
      if (!isOnRibbon(body, ribbon)) continue;
      // Collected.
      body.ribbonsCollectedThisLap.add(key);
      body.ribbonLastCollectedAt.set(ribbon.id, now);
      body.activeBoosts.set('ribbon-boost', {
        expiresAt: now + RIBBON_BOOST_DURATION_MS,
        mult: RIBBON_BOOST_MULT,
      });
      this.broadcastFn(state.roomId, {
        type: 'event.ribbon_collected',
        petId: body.petId,
        ribbonId: ribbon.id,
      });
      break; // one ribbon per body per tick
    }
  }
}
```

`isOnRibbon(body, ribbon)` is a private helper using projection-onto-segment math (no allocations, all `number`). On lap-up, `body.ribbonsCollectedThisLap` is cleared inside `resolveCheckpoints` — see §2.11.

### 2.9 `resolveApex` (new private method)

```ts
private resolveApex(state: ReefRoomState, now: number): void {
  if (state.apexZones.length === 0) return;
  for (const body of state.bodies.values()) {
    if (!body.alive || body.dnf || body.finishedAt !== null || body.forfeited) continue;
    for (const zone of state.apexZones) {
      const key = `${body.lap}:${zone.hairpinIndex}`;
      if (body.apexCheckedThisLap.has(key)) continue;
      const dxIn = body.x - zone.innerCenter.x;
      const dyIn = body.y - zone.innerCenter.y;
      const dxOut = body.x - zone.outerCenter.x;
      const dyOut = body.y - zone.outerCenter.y;
      if (dxIn * dxIn + dyIn * dyIn <= APEX_INNER_RADIUS * APEX_INNER_RADIUS) {
        body.apexCheckedThisLap.add(key);
        body.activeBoosts.set('apex-bonus', {
          expiresAt: now + APEX_DURATION_MS,
          mult: APEX_BONUS_MULT,
        });
        this.broadcastFn(state.roomId, {
          type: 'event.apex_bonus',
          petId: body.petId,
          hairpinIndex: zone.hairpinIndex,
          kind: 'inside',
        });
      } else if (dxOut * dxOut + dyOut * dyOut <= APEX_OUTER_RADIUS * APEX_OUTER_RADIUS) {
        body.apexCheckedThisLap.add(key);
        body.activeBoosts.set('apex-penalty', {
          expiresAt: now + APEX_DURATION_MS,
          mult: APEX_PENALTY_MULT, // negative
        });
        this.broadcastFn(state.roomId, {
          type: 'event.apex_bonus',
          petId: body.petId,
          hairpinIndex: zone.hairpinIndex,
          kind: 'wide',
        });
      }
    }
  }
}
```

`apexZones` is precomputed at `startRoom` from `APEX_HAIRPIN_CHECKPOINT_INDICES` + checkpoint normals. Cleared per-lap via `apexCheckedThisLap` set on the body.

### 2.10 `resolveHazards` (new private method)

```ts
private resolveHazards(state: ReefRoomState, now: number): void {
  if (state.hazards.length === 0) return;
  for (const body of state.bodies.values()) {
    if (!body.alive || body.dnf || body.finishedAt !== null || body.forfeited) continue;
    let hit: ReefHazardPatch | null = null;
    for (const hazard of state.hazards) {
      const dx = body.x - hazard.center.x;
      const dy = body.y - hazard.center.y;
      if (dx * dx + dy * dy <= hazard.radius * hazard.radius) {
        hit = hazard;
        break;
      }
    }
    if (hit) {
      const wasActive = body.activeBoosts.has('hazard-slow');
      body.activeBoosts.set('hazard-slow', {
        expiresAt: now + HAZARD_TICK_DURATION_MS,
        mult: HAZARD_SLOW_MULT,
      });
      // Edge-trigger event broadcast — once per (petId, hazardId) per lap.
      const key = `${body.lap}:${hit.id}`;
      if (!body.hazardsHitThisLap.has(key)) {
        body.hazardsHitThisLap.add(key);
        this.broadcastFn(state.roomId, {
          type: 'event.hazard_hit',
          petId: body.petId,
          hazardId: hit.id,
        });
      }
    }
    // No clear-on-leave — speedMod sweep in step 3 handles expiry naturally
    // because `expiresAt` is now+200ms; if the body's still inside next tick
    // the entry refreshes.
  }
}
```

### 2.11 Lap-up cleanup in `resolveCheckpoints`

When a body's lap counter advances, clear:
- `body.ribbonsCollectedThisLap.clear()`
- `body.apexCheckedThisLap.clear()`
- `body.hazardsHitThisLap.clear()`

Plumb this into the existing `resolveCheckpoints` `if (justCompletedLap)` branch (`reef-race-sim.ts:1212-1228`) right after `body.lap += 1`. No new function needed.

### 2.12 Interaction matrix — new vs Phase 1 boosts

| Mechanic | Stack with drift? | Stack with launch? | Stack with pickup turbo? | Capped at | Clamped on stall? |
|---|---|---|---|---|---|
| Slipstream | additive | additive | takes MAX vs pickup | 0.85 cap | Yes — stall sets speedMod=0.5 |
| Ribbon | additive | additive | takes MAX vs pickup | 0.85 cap | Yes |
| Apex bonus | additive | additive | takes MAX vs pickup | 0.85 cap | Yes |
| Apex penalty | subtractive | subtractive | applied always (negative) | floor at -0.5 | applied on top of stall |
| Hazard | subtractive | subtractive | applied always (negative) | floor at -0.5 | applied on top of stall |

Stall behavior unchanged: when `launch-stall` is active, `speedMod = 0.5` and `effectiveThrust = min(thrust, 0.30)`. Negatives DO compound on top of stall (they're subtractive even in stall — not in the cap path). This is intentional: a stalled player who clips a hazard should feel doubly bad.

### 2.13 Anti-cheat tolerance verification

Maximum positive kineticMult = `KINEMATIC_BOOST_CAP = 0.85` → speedMod ≤ 1.85 → max velocity 925 wu/s. `REEF_KINEMATIC_TOLERANCE = 2.0` validator allows up to 1000 wu/s. **75 wu/s safety margin** preserved. No changes to validators or tolerance constants.

---

## 3. Per-body state additions on `ReefBody`

Add to the interface in `reef-race-sim.ts:139-200`:

```ts
// ─── Phase 2 — slipstream ─────────────────────────────────────────────────
/** petId of the body whose wake this body is currently sitting in (null = none). */
slipstreamSourcePetId: string | null;
/** Consecutive ticks the body has been in the SAME source's wake. Reset on switch. */
slipstreamConsecutiveTicks: number;
/** Grace ticks remaining after leaving the wake before clearing source. */
slipstreamGraceTicksLeft: number;

// ─── Phase 2 — boost ribbons ──────────────────────────────────────────────
/** Set of "${lap}:${ribbonId}" entries already credited this lap. Cleared on lap-up. */
ribbonsCollectedThisLap: Set<string>;
/** Last collection time per ribbonId for cross-lap cooldown. */
ribbonLastCollectedAt: Map<string, number>;

// ─── Phase 2 — apex zones ─────────────────────────────────────────────────
/** Set of "${lap}:${hairpinIndex}" entries already verdict'd this lap. Cleared on lap-up. */
apexCheckedThisLap: Set<string>;

// ─── Phase 2 — hazard patches ─────────────────────────────────────────────
/** Set of "${lap}:${hazardId}" entries already broadcast this lap. Cleared on lap-up. */
hazardsHitThisLap: Set<string>;
```

**Initial values** in `startRoom` body init loop (`reef-race-sim.ts:367-429`):

```ts
slipstreamSourcePetId:      null,
slipstreamConsecutiveTicks: 0,
slipstreamGraceTicksLeft:   0,
ribbonsCollectedThisLap:    new Set<string>(),
ribbonLastCollectedAt:      new Map<string, number>(),
apexCheckedThisLap:         new Set<string>(),
hazardsHitThisLap:          new Set<string>(),
```

**Memory footprint**: per body ~ 250 bytes (Phase 1) + ~440 bytes (Phase 2 — 4 empty Sets/Maps + 3 numbers + 1 string ref) ≈ 690 bytes per body. 8 bodies × 200 rooms ≈ 1.1 MB total worst-case. Negligible.

### 3.1 `ReefRoomState` additions

Add to the interface in `reef-race-sim.ts:212-235`:

```ts
/** Phase 2 — boost ribbons (built once at startRoom). */
ribbons: ReefBoostRibbon[];
/** Phase 2 — apex zones (built once at startRoom). */
apexZones: Array<{
  hairpinIndex: number;
  innerCenter: Vec2;
  outerCenter: Vec2;
}>;
/** Phase 2 — hazard patches (built once at startRoom). */
hazards: ReefHazardPatch[];
```

Built in `startRoom` immediately after `checkpoints = buildReefCheckpoints();`:

```ts
const ribbons   = buildReefBoostRibbons();
const apexZones = buildReefApexZones(checkpoints); // helper from §1.4 below
const hazards   = buildReefHazardPatches();
```

### 3.2 Helper: `buildReefApexZones(checkpoints)`

Walks `APEX_HAIRPIN_CHECKPOINT_INDICES`, reads each checkpoint's `normal` (already pointing inward toward the origin), and returns:

```ts
function buildReefApexZones(cps: ReefCheckpointAabb[]): Array<{
  hairpinIndex: number;
  innerCenter: Vec2;
  outerCenter: Vec2;
}> {
  return APEX_HAIRPIN_CHECKPOINT_INDICES.map(idx => {
    const cp = cps[idx];
    return {
      hairpinIndex: idx,
      innerCenter: {
        x: cp.center.x + cp.normal.x * APEX_INSIDE_OFFSET,
        y: cp.center.y + cp.normal.y * APEX_INSIDE_OFFSET,
      },
      outerCenter: {
        x: cp.center.x - cp.normal.x * APEX_OUTSIDE_OFFSET,
        y: cp.center.y - cp.normal.y * APEX_OUTSIDE_OFFSET,
      },
    };
  });
}
```

(Resides in `reef-race-config.ts` so the client can import the same builder for visualization.)

### 3.3 Helper: `buildReefHazardPatches()`

Same shape as apex but with the hazard offset constant; one hazard per hairpin.

```ts
export function buildReefHazardPatches(): ReefHazardPatch[] {
  const cps = buildReefCheckpoints();
  return APEX_HAIRPIN_CHECKPOINT_INDICES.map(idx => {
    const cp = cps[idx];
    return {
      id: `hz-${idx}`,
      center: {
        x: cp.center.x + cp.normal.x * HAZARD_INSIDE_OFFSET,
        y: cp.center.y + cp.normal.y * HAZARD_INSIDE_OFFSET,
      },
      radius: HAZARD_RADIUS,
    };
  });
}
```

---

## 4. Snapshot / protocol additions

All schema work in `packages/shared/src/activities/protocol.ts`. The TS union must remain exhaustive (`default: never` guard at `activity.ts:758-764` will require a `case`/`break` for each new event).

### 4.1 New `ServerFrame` events

```ts
| {
    /**
     * Phase 2 — slipstream verdict. Fired once when `dstPetId` first enters
     * `srcPetId`'s wake AND completes the SLIPSTREAM_REQUIRED_TICKS hold.
     * Future Phase 3 will carry tier info if slipstream gets stat-driven
     * window extension. NOT broadcast on every tick of being in-wake (that's
     * what the activeBoosts entry is for).
     */
    type: 'event.slipstream';
    srcPetId: string;
    dstPetId: string;
  }
| {
    /**
     * Phase 2 — apex verdict. `kind: 'inside'` = bonus +5%, `'wide'` = penalty
     * -5%. Fired AT MOST ONCE per (petId, lap, hairpinIndex). HUD reserves
     * a screen-tag toast for two seconds; future scene VFX hooks here.
     */
    type: 'event.apex_bonus';
    petId: string;
    hairpinIndex: number;
    kind: 'inside' | 'wide';
  }
| {
    /**
     * Phase 2 — boost ribbon collection. `ribbonId` matches the id from the
     * server's `state.ribbons` (currently `'rib-top'` / `'rib-bot'`). HUD
     * may flash, scene fires a sparkle particle burst.
     */
    type: 'event.ribbon_collected';
    petId: string;
    ribbonId: string;
  }
| {
    /**
     * Phase 2 — sea-urchin field clip. Fired once per (petId, lap, hazardId)
     * — the activeBoosts.has('hazard-slow') entry handles per-tick refresh.
     */
    type: 'event.hazard_hit';
    petId: string;
    hazardId: string;
  }
```

Backwards compat: old clients hit `default: never` → no throw (Phase 1 already proved this pattern). Old `activity.ts` switch still type-checks because the new types are added to the union — Phase 2 same-diff adds the four `case ...: break;` branches in the store.

### 4.2 `RoomMeta` — static-zone bootstrap

Phase 2 adds three static lists to `RoomMeta` so the client can render ribbons / hazards / apex markers without re-deriving them from the centerline:

```ts
export interface RoomMeta {
  // ... existing fields ...

  /**
   * Phase 2 — server-authoritative reef-race static-zone positions. `null`
   * for non-reef-race rooms. Sent once in `snapshot.init`; never updated.
   * Client re-builds visual meshes from these so Phase-3 stat tweaks
   * (e.g. archetype = agility → ribbonDetectRadiusMultiplier) read from a
   * single source of truth.
   */
  reefStaticZones?: {
    ribbons: Array<{ id: string; a: Vec2; b: Vec2 }>;
    apexZones: Array<{
      hairpinIndex: number;
      innerCenter: Vec2;
      outerCenter: Vec2;
    }>;
    hazards: Array<{ id: string; center: Vec2; radius: number }>;
  };
}
```

`snapshot.init` is built in `activity-ws-hub.ts:464-545`. The reef-race branch (line 497-523) populates `reefStaticZones` from `reefRaceSim.getStaticZones(roomId)` (new sim accessor — see §10).

### 4.3 `EntityDelta.changed` — placement field

Phase 2 surfaces live placement on every snapshot delta when it changes:

```ts
// in packages/shared/src/activities/protocol.ts EntityDelta.changed comment block
//   placement?: number;  // Phase 2 — 1-indexed live race position
```

The `[k: string]: unknown` catch-all is unchanged. Old clients silently drop the new `placement` field. Phase 2 client (`activity.ts`) reads it inside the snapshot.delta handler, identical to how `driftSparks` is hoisted.

### 4.4 Snapshot diff predicate update

In `reef-race-sim.ts:1487-1500` (the `broadcastDelta` filter), add:

```ts
// Phase 2 — placement change MUST broadcast so the HUD's placement tile
// updates between checkpoint crossings (positional fields may not change
// on the same tick the placement does).
|| p.placement !== b.placement
```

And add `placement: this.computeLivePlacementForBody(body, placementMap)` to both the snapshot body (`buildSnapshot`) and the `changed` object emitted in `broadcastDelta`.

`buildSnapshot` is called from `broadcastDelta` AND `broadcastKeyframe`. Compute the placement map ONCE per snapshot tick (not per body) — store on `state` as `state.lastPlacementMap` updated at the top of each broadcast cycle.

### 4.5 Per-body driftSparks — already shipped (Phase 1)

No-op for Phase 2. Listed here for completeness so the audit can verify nothing regresses.

---

## 5. Visual / 3D additions (3da owned)

Three new scene components + one HUD subcomponent. **Spawn `3da` for all of §5 and §6.b** — Iris Xe constraints + scene-graph invariants apply.

### 5.1 `ReefRaceBoostRibbons.tsx` (new file)

- Reads `room.reefStaticZones.ribbons` from the activity store.
- For each ribbon, builds a flat `BoxGeometry` along the segment a→b at y=`KART_Y_ABOVE_TRACK + 1` so it sits just above the track ribbon.
- Geometry: `(length × 8wu × RIBBON_HALF_WIDTH * 2)` oriented along the segment tangent. Subdivision: 1 (zero indices needed — geometry lives at module scope shared across all rendered ribbons).
- Material: `MeshStandardMaterial` with `emissive: '#00e676'`, `emissiveIntensity: 0.6`, slight texture-less alpha 0.7 via opacity. NEVER `ShaderMaterial` (Iris Xe ban). NEVER `MeshBasicMaterial` because the ribbon needs to read the directional light gently.
- Module-scope geometry + material — page-lifetime, never disposed.
- A `useFrame` pulses `material.emissiveIntensity` on a 1Hz sine for the "glowing" feel — primitive math, no allocations.
- Draw calls: 2 (one per ribbon), under the 70-call budget.

### 5.2 `ReefRaceHazards.tsx` (new file)

- Reads `room.reefStaticZones.hazards`.
- For each hazard, places a TorusKnotGeometry (low complexity: `radius=hazard.radius`, `tube=4`, `tubularSegments=24`, `radialSegments=4`) flat on the track surface as a stylised "urchin field" placeholder. (Final art — sprites of urchin spikes — deferred to Phase 2.5.)
- Material: `MeshStandardMaterial` with `color: '#9c27b0'` (purple) + `emissive: '#7b1fa2'`, `emissiveIntensity: 0.4`, `roughness: 0.8`.
- Module-scope geometry + material.
- No useFrame animation — static visual.
- Draw calls: 2 (one per hazard).

### 5.3 `ReefRaceApexMarkers.tsx` (new file)

- Reads `room.reefStaticZones.apexZones`.
- For each zone: TWO ring-meshes (CircleGeometry → torus-stencil): one at `innerCenter` colored green (`#00e676`), one at `outerCenter` colored amber (`#ff9800`).
- Subtle — these are FEEDBACK markers, not visual hazards. Inner ring = "drive through here for +5%", outer ring = "drive too wide and you eat -5%".
- Module-scope geometry + material; static; draw calls: 4 (2 zones × 2 rings).

### 5.4 Slipstream particle trail — DEFERRED

Per high-level plan §"Visual / 3D additions" (line 5): "Skip if too expensive."

Rationale to skip:
- Iris Xe budget: ≤70 draw calls. Phase 2 already adds 2 (ribbons) + 2 (hazards) + 4 (apex markers) = 8 calls — at the budget edge.
- Wake particles would need a per-front-runner Points/Trail object (≤4 max) at 30+ vertices each. Extra 4 draw calls. Borderline.
- Alternative: the trailing player will SEE they're in the wake via the new `event.slipstream` toast in §6 — the absence of a particle stream is information enough for Phase 2.

Re-evaluate in Phase 2.5 if leaderboard signals "players don't realise they're drafting" — that's the objective metric for graduating this off the deferred list.

### 5.5 Mounting in `ReefRaceScene.tsx`

Add three imports and three children inside `<SceneContents>`, wrapped in the pattern matching existing static-mesh components:

```tsx
import ReefRaceBoostRibbons from './ReefRaceBoostRibbons';
import ReefRaceHazards      from './ReefRaceHazards';
import ReefRaceApexMarkers  from './ReefRaceApexMarkers';
// ... inside SceneContents, after <ReefRaceCheckpoints />:
<ReefRaceBoostRibbons />
<ReefRaceHazards />
<ReefRaceApexMarkers />
```

Each component subscribes to `useActivityStore(s => s.room?.reefStaticZones)` with primitive identity check; the store object is stable across non-init frames so re-renders fire only on init / reset. No Map subscriptions.

---

## 6. HUD additions

### 6.1 `ReefRaceSlipstreamTag.tsx` (new file)

- Subscribes to `useActivityStore(s => s.slipstreamActive)` (new boolean state field — see §7 below).
- When `true` AND `matchPhase === 'live'`: renders a small `DRAFT` chip top-center, cyan-glow border, fade in/out with 100ms transition.
- Mounted from `<ReefRaceHud>` next to existing top-center elements (not bottom, to avoid colliding with the drift sparks bar).
- Primitive boolean subscription — re-renders only on transition. Object.is gate is automatic.

### 6.2 Apex-verdict toast — `ReefRaceApexToast.tsx` (new file)

- Subscribes to `useActivityStore(s => s.lastApexVerdict)` (new `{kind:'inside'|'wide'; at:number} | null` state field).
- When fresh (within last 1.5s of `at`): centers a small toast "PERFECT LINE +5%" (green) or "DRIFT WIDE -5%" (amber) under the placement tile, fades after 1.5s.
- Pulled from store on every `event.apex_bonus` (set inside `applyServerFrame`).
- Auto-clears: a `useEffect` in the toast checks `Date.now() - at > 1500` and falls through to `null` rendering. Primitive object subscription — store sets a NEW object reference on each event, so React fires re-renders correctly.

### 6.3 Item rarity tier hint

Per the user's question — the existing placement tile shows "1st of 8". Adding rarity tier hint:
- Add a small one-character mini-icon below the placement number indicating the next-roll's tier:
  - 1st: 🛡 (defensive)
  - 2nd–3rd: 🛡* (defensive-leaning)
  - 4th–5th: ⚖ (neutral)
  - 6th–7th: ⚔* (aggressive-leaning)
  - 8th: ⚔ (aggressive)
- Stays in the existing `<PlacementTile>` component — no new file. Hidden when `placement === null`. Primitive number subscription on `placement`.

### 6.4 Existing HUD elements untouched

- `LapCounter`, `BestLapTile`, `PowerUpBar`, `LeaveButton`, `RoundCountdown`, `ReefRaceInstructions`, `ReefRaceDriftSparks`, launch glow ring — all read primitive selectors today; Phase 2 changes nothing. Verified against `apps/web/src/components/game/reef-race-hud.tsx:217-348`.

### 6.5 Re-render gates (load-bearing)

- All new HUD components MUST use primitive store subscriptions. NO `useActivityStore(s => s.entities)` or any Map subscription. The drift-sparks pattern (`s.driftSparks` is a primitive number) is the model. Audit verifies this in §8 — failing this requirement breaks the 30Hz tick budget.

---

## 7. Activity store additions (`apps/web/src/stores/activity.ts`)

### 7.1 New fields on `ActivityState`

```ts
// Phase 2 — slipstream live indicator (set on event.slipstream, cleared on
// activeBoosts expiry mirror — server-driven). Primitive boolean.
slipstreamActive: boolean;
// Phase 2 — last apex verdict for toast rendering. Replaced (not appended)
// on each event.apex_bonus arrival.
lastApexVerdict: { kind: 'inside' | 'wide'; at: number } | null;
// Phase 2 — last ribbon collected (for HUD "boost!" flash). Optional.
lastRibbonCollectedAt: number;
// Phase 2 — last hazard hit (for HUD "ouch" flash + brief speed-debuff icon).
lastHazardHitAt: number;
// Phase 2 — placement on snapshot.delta is propagated through the same
// hoisting pattern as driftSparks (caller reads d.changed.placement for self).
// (Already covered by existing `placement: number | null` field; no new field.)
```

Init in `emptyState()`:
```ts
slipstreamActive: false,
lastApexVerdict: null,
lastRibbonCollectedAt: 0,
lastHazardHitAt: 0,
```

### 7.2 New `case` branches in `applyServerFrame` (REQUIRED — exhaustive switch)

```ts
case 'event.slipstream': {
  // Set slipstreamActive when self is the dstPetId; clear when off-wake
  // is signaled by the server's activeBoosts sweep — but the server doesn't
  // emit a "slipstream-end" event. Solution: client tracks a 200ms timeout
  // that auto-clears the flag if no fresh event arrives. This mirrors the
  // server's HAZARD_TICK_DURATION_MS heartbeat pattern.
  if (state.selfPetId && frame.dstPetId === state.selfPetId) {
    set({ slipstreamActive: true });
    // Out-of-band timeout on the same store ref:
    // (Implemented as a useEffect in the consumer component because store
    // can't run timers cleanly. See §6.1.)
  }
  break;
}
case 'event.apex_bonus': {
  if (state.selfPetId && frame.petId === state.selfPetId) {
    set({ lastApexVerdict: { kind: frame.kind, at: Date.now() } });
  }
  break;
}
case 'event.ribbon_collected': {
  if (state.selfPetId && frame.petId === state.selfPetId) {
    set({ lastRibbonCollectedAt: Date.now() });
  }
  break;
}
case 'event.hazard_hit': {
  if (state.selfPetId && frame.petId === state.selfPetId) {
    set({ lastHazardHitAt: Date.now() });
  }
  break;
}
```

All four MUST be added before the `default: never` guard at `activity.ts:758` — TypeScript will fail the build until they're in place.

### 7.3 `slipstreamActive` auto-clear

The server doesn't emit a "slipstream-end" frame. Client-side, slipstreamActive auto-clears when no fresh `event.slipstream` arrives for 250ms. Implementation: `<ReefRaceSlipstreamTag>` runs a `setInterval(check, 100)` that clears the flag if `Date.now() - lastSlipstreamEventAt > 250`. The store carries `lastSlipstreamEventAt: number` updated in the case branch. (Same pattern as the launch glow ring's local countdown.)

### 7.4 Placement hoisting in `snapshot.delta` handler

Mirror the existing driftSparks pattern (`activity.ts:498-514`):

```ts
let nextPlacement: number | null = state.placement;
for (const d of frame.entities) {
  applyEntityDelta(entities, d);
  if (state.selfPetId && d.petId === state.selfPetId) {
    if (typeof d.changed.driftSparks === 'number') {
      nextDriftSparks = d.changed.driftSparks as 0 | 1 | 2 | 3;
    }
    if (typeof d.changed.placement === 'number') {
      nextPlacement = d.changed.placement;
    }
  }
}
// ... existing set() now includes:
set({
  ...
  driftSparks: nextDriftSparks,
  placement: nextPlacement,
});
```

This OVERRIDES the existing `placement` derivation from `frame.scores` (`activity.ts:541-559`) — the server's per-tick `placement` field on EntityDelta is more reliable than ScoreDelta-derived placement (which today uses `score: b.lap`, an undercount of progress). Score-derived placement stays as a fallback if a delta omits the field.

### 7.5 `BumperShellEntity` does NOT need `placement` field

Placement is HUD-state only (single number). The scene's per-entity Map doesn't need it. No change to `bumper-shells-types.ts`.

---

## 8. Bot integration

### 8.1 Per-bot state additions in `reef-race-bot.ts`

```ts
class ReefRaceBot implements BotController {
  // ... existing fields (driftActive, driftStartedMs, driftTargetTicks,
  // launchAttempted, launchFireMs) ...

  // Phase 2 — slipstream / draft policy
  private draftTargetPetId: string | null = null;
  // Phase 2 — apex line preference (re-rolled per hairpin entry; sticks
  // through the corner so the bot doesn't oscillate).
  private lineMode: 'inside' | 'mid' = 'mid';
  // Phase 2 — last ribbon position aimed at (avoids per-tick recompute).
  private nextRibbonId: string | null = null;
}
```

### 8.2 Bot heuristics (one per mechanic)

**Drafting.** When a target body is within `SLIPSTREAM_MAX_DISTANCE * 1.5 = 75wu` ahead and within ±30° of bot's heading, bias `dir.x` and `dir.y` slightly toward the target's CURRENT position so the bot enters its wake. Already cheap — re-uses the existing forward checkpoint loop.

```ts
// Inside computeInput, after the launch + drift logic, before the final
// thrust calculation:
const draftTarget = pickDraftTarget(view, self);
if (draftTarget) {
  // Bias dir 25% toward draftTarget's position over the next-checkpoint dir.
  dx = dx * 0.75 + (draftTarget.x - self.x) * 0.25 / dist;
  dy = dy * 0.75 + (draftTarget.y - self.y) * 0.25 / dist;
  // Renormalise.
  const m = Math.hypot(dx, dy) || 1;
  dx /= m; dy /= m;
}
```

`pickDraftTarget` is a private fn that finds the nearest ahead-of-self body within range; reuses `view.bodies` (already O(N)).

**Apex.** Bot rolls `lineMode` ONCE per hairpin entry (when `dot < 0.5 && distToTarget > 200` AND target's checkpoint index is in `APEX_HAIRPIN_CHECKPOINT_INDICES`). 70% inside, 30% mid. Inside line steers slightly TOWARD the inside-of-curve direction (reuse checkpoint normal — already in `view.checkpoints[idx].normal`).

```ts
if (isHairpinTarget && this.lineMode === 'mid' && Math.random() < 0.70) {
  this.lineMode = 'inside';
}
if (this.lineMode === 'inside') {
  const cp = view.checkpoints![targetIndex];
  // Steer 30% toward (cp.center + cp.normal * APEX_INSIDE_OFFSET) instead of cp.center.
  const apexX = cp.center.x + cp.normal.x * APEX_INSIDE_OFFSET;
  const apexY = cp.center.y + cp.normal.y * APEX_INSIDE_OFFSET;
  dx = dx * 0.70 + ((apexX - self.x) / dist) * 0.30;
  dy = dy * 0.70 + ((apexY - self.y) / dist) * 0.30;
}
// On checkpoint cross (lineMode reset): set lineMode = 'mid' again.
```

**Ribbons.** When the next-checkpoint t-value is near a ribbon's midpoint (within ~5% of t), nudge `dir` toward the ribbon's centerline. Implementation: precompute the "ribbon-midpoint sim positions" once on first call (cache as a static class field — same lifetime as the controller), then snap to whichever ribbon midpoint is closer to the next checkpoint when the bot is approaching. Adds maybe 10 wu of lateral pull — enough to graze the ribbon, not enough to ditch the ideal line.

**Hazards.** Bot has a hazard-aware steering check: if any hazard's center is within 60wu of `self` AND ahead-of-self (positive dot vs `self.vel`), bias `dir` AWAY by 0.1 of the unit vector. Costs O(2) per tick.

**Aggressive items in 8th.** Bot's `POWERUP_USE_CHANCE = 0.30` becomes placement-aware:
- 1st place: 0.30 (defensive — hold for emergencies)
- 8th place: 0.45 (aggressive — fire fast to catch up)
- Mid: linear interp.

```ts
const placement = this.getOwnPlacement(view);
const useChance = placement === 1 ? 0.30
                : placement === 8 ? 0.45
                : 0.30 + (placement - 1) * (0.15 / 7);
if (Math.random() < useChance) { actionBits |= (1 << i); break; }
```

`getOwnPlacement` walks `view.bodies` once and computes the same race-progress formula the sim uses — wrapped in a private method.

### 8.3 Bot doesn't need any new exports from `reef-race-config.ts`

All constants needed (`APEX_HAIRPIN_CHECKPOINT_INDICES`, `APEX_INSIDE_OFFSET`, `SLIPSTREAM_MAX_DISTANCE`) are already exported per §1.

---

## 9. Test plan

All new tests in `apps/api/src/services/activity/sim/__tests__/reef-race-sim.test.ts` and `apps/api/src/services/activity/bots/__tests__/reef-race-bot.test.ts`. Pattern matches Phase 1's `bootDriftRoom` + `setIntent` helpers. **Reuse the helpers verbatim** — extending them is the change, not duplicating them.

### 9.1 Slipstream — sim tests

**P2-T1** — Slipstream charge accumulates when self is in target's wake.
- Two bodies `p1` (front, at origin moving +Y at 300 wu/s), `p2` (behind, 40wu south of p1, also moving +Y at 300 wu/s).
- Tick 50 times.
- After ≥45 ticks: assert `p2.activeBoosts.has('slipstream-boost') === true`, `p2.slipstreamSourcePetId === 'p1'`, `event.slipstream` broadcast EXACTLY once.

**P2-T2** — Slipstream does NOT charge when target's velocity is too slow.
- `p1` parked (vx=0, vy=0). `p2` 40wu behind.
- Tick 60 times.
- Assert `p2.slipstreamConsecutiveTicks === 0`, no `event.slipstream` broadcast.

**P2-T3** — Slipstream cancels on `resolveProximity` collision.
- Bodies positioned 30wu apart (inside `REEF_BODY_RADIUS * 2 = 44wu`); `resolveProximity` separates them.
- Tick once → bodies push to ≥44wu apart → next tick: still in `MAX_DISTANCE = 50wu` band, slipstream continues.
- Tick another 5 times → boost fires (or not) based on accumulated ticks.
- Assert no oscillation: `slipstreamConsecutiveTicks` either monotonically increases or resets cleanly.

**P2-T4** — Slipstream during a collision (edge case).
- `p1` and `p2` in same position (dist=0) — distSq=0 < minSq (= 33²=1089).
- Assert: dist=0 fails the `distSq < minSq` early-out, slipstream NOT credited. No NaN propagation.

**P2-T5** — Slipstream + drift-3 + launch combined respects `KINEMATIC_BOOST_CAP`.
- Plant all three boosts on a body, full thrust 60 ticks.
- Assert `Math.hypot(body.vx, body.vy) <= REEF_MAX_SPEED * 1.85 + 1` (1 wu/s float slack).

### 9.2 Cornering apex — sim tests

**P2-T6** — Inside-line apex bonus fires.
- Plant body inside `apexZones[0].innerCenter`, full forward velocity.
- Tick once.
- Assert `body.activeBoosts.has('apex-bonus')`, `event.apex_bonus` broadcast with `kind: 'inside'`.

**P2-T7** — Outside-line apex penalty fires.
- Plant body inside `apexZones[0].outerCenter`.
- Assert `body.activeBoosts.has('apex-penalty')`, `event.apex_bonus` with `kind: 'wide'`.

**P2-T8** — Apex check at the exact tick of a checkpoint cross.
- Plant body inside both apex disc AND checkpoint AABB simultaneously.
- Tick once.
- Assert apex verdict broadcast AND checkpoint advance — both happen on the same tick. Apex fires BEFORE checkpoint (insertion order from §2.2).

**P2-T9** — Apex re-arms on lap-up.
- Plant body inside inner apex; tick → bonus fires; verify `body.apexCheckedThisLap.size === 1`.
- Manually advance `body.lap`. Tick `resolveCheckpoints` — verify the lap-up cleanup clears the set.
- Plant body inside inner apex again (next lap). Tick → bonus fires AGAIN.

**P2-T10** — Apex bonus + drift = additive.
- Plant body with active drift-3 boost. Cross apex inner zone.
- Read `speedMod` via integration test: speed should asymptote toward `REEF_MAX_SPEED * (1 + min(0.38 + 0.05, 0.85))` = `REEF_MAX_SPEED * 1.43`.

### 9.3 Boost ribbons — sim tests

**P2-T11** — Ribbon collected on segment cross.
- Plant body at midpoint of `state.ribbons[0]` segment, body radius inside the half-width.
- Tick once.
- Assert `body.ribbonsCollectedThisLap.has('0:rib-top')` (or whichever id), `event.ribbon_collected` broadcast, `body.activeBoosts.has('ribbon-boost')`.

**P2-T12** — Ribbon collected by two players at the same tick.
- Two bodies both at midpoint.
- Tick once.
- Assert BOTH bodies get the boost AND each gets one `event.ribbon_collected` broadcast.

**P2-T13** — Same ribbon NOT collected twice in same lap.
- Tick once at midpoint → boost fires.
- Move body offline 10wu, tick.
- Move body back to midpoint, tick.
- Assert: only ONE `event.ribbon_collected` broadcast across all ticks.

**P2-T14** — Ribbon cooldown across laps.
- Manually flip `body.lap` to next lap (clear `ribbonsCollectedThisLap`).
- Plant body at ribbon. Without resetting `ribbonLastCollectedAt`, tick.
- Assert: cooldown rejects (5s window), no boost.
- Advance `now` by 6s, tick.
- Assert: boost fires.

### 9.4 Hazards — sim tests

**P2-T15** — Hazard slow applies on overlap.
- Plant body inside `state.hazards[0].center` radius. Set vx=300.
- Tick once.
- Assert `body.activeBoosts.has('hazard-slow')`, `event.hazard_hit` broadcast.

**P2-T16** — Hazard hit during invuln (e.g., shield active).
- Plant body inside hazard with `body.activeEffects.set('rr-bubble-shield', now+9999)` (the invuln pickup).
- Tick once.
- Assert: `event.hazard_hit` STILL broadcast; `body.activeBoosts.has('hazard-slow')` STILL true.
- (Design choice: hazards are not ATTACKS — they're terrain. Shields don't protect against terrain. Document this in the hazard's commentary.)

**P2-T17** — Hazard slow + drift = net positive.
- drift-3 boost (+0.38) + hazard (-0.40) → kineticMult = -0.02 → speedMod = 0.98 (slightly below baseline).
- Run integration test for 30 ticks → speed asymptotes near `REEF_MAX_SPEED * 0.98`.
- Confirms the "shortcut tradeoff" feels real.

**P2-T18** — Hazard re-fires on continuous overlap.
- Body camped inside hazard for 60 ticks.
- Assert `event.hazard_hit` broadcast EXACTLY ONCE per lap (the per-lap edge-trigger guard).
- Assert `activeBoosts.has('hazard-slow')` continuously TRUE (refreshed each tick).

### 9.5 Placement-weighted items — sim tests

**P2-T19** — `getPlacementItemTable(1)` returns defensive-only weights.
- Static config test. Assert the table for placement 1 contains NO `'rr-whirlpool'`, `'rr-seeker-jelly'`, or `'rr-tide-wave'`.

**P2-T20** — `getPlacementItemTable(8)` returns aggressive-only weights.
- Assert NO `'rr-bubble-shield'`, NO `'rr-ink-slick'`.

**P2-T21** — `computeLivePlacements` orders racing bodies correctly.
- Build state with 3 bodies at different (lap, nextCheckpoint) progress values.
- Assert placement ordering: highest progress = 1.

**P2-T22** — `computeLivePlacements` puts finishers ahead of racers ahead of DNFers.
- Body 1: finishedAt set. Body 2: lap=2, nextCheckpoint=5. Body 3: dnf=true.
- Assert placement: p1=1, p2=2, p3=3.

**P2-T23** — Placement-table lookup at edge of placement (1, 8, mid).
- Mock `lcgNext` to deterministic value, call `rollPowerUpKindForPlacement(state, 1)`, `(state, 4)`, `(state, 8)` — assert each returns a kind FROM the corresponding bucket only.

**P2-T24** — Placement-table fallback to global when placement is null/out-of-range.
- `rollPowerUpKindForPlacement(state, 9)` (out-of-range) returns from `REEF_POWERUP_DEFS` weights.

**P2-T25** — Placement is broadcast in EntityDelta.
- Two bodies with different progress values. Trigger a snapshot.delta. Assert each entity's `changed.placement` matches `computeLivePlacements`.

**P2-T26** — Placement broadcasts on placement-only change.
- Body crosses a checkpoint that doesn't change position (planted at it). Assert the snapshot delta still includes the body because `placement` changed (predicate update §4.4).

### 9.6 Anti-cheat / cap regression

**P2-T27** — `KINEMATIC_BOOST_CAP` clamps positive stack.
- Plant ALL FIVE positive boosts (`drift-3`, `launch`, `slipstream`, `ribbon`, `apex-bonus`). Drive 60 ticks.
- Assert `Math.hypot(body.vx, body.vy) <= REEF_MAX_SPEED * 1.85 + 5` (5 wu/s integration slack).
- This is the master ceiling test — combined-boost stack must never silently break the validator.

**P2-T28** — `KINEMATIC_BOOST_FLOOR` clamps negative stack.
- Plant `apex-penalty` AND `hazard-slow`. Drive 30 ticks.
- Assert `speedMod >= 0.5` (mirrored ink-slick floor) — i.e. `Math.hypot(body.vx, body.vy) >= REEF_MAX_SPEED * 0.5 - 1` once velocity reaches steady-state.

**P2-T29** — Hard cap stays at 1.85× even with new boosts (`integrateMotion`).
- Source-grep test (mirrors Phase 1 T14): assert `reef-race-sim.ts` references `1.85` exactly once + the `REEF_MAX_SPEED *` prefix.

### 9.7 Bot tests (in `reef-race-bot.test.ts`)

**P2-T30** — Bot drafts behind a leader when in range.
- View with a target body 50wu ahead of self, both moving +Y at 300 wu/s.
- Assert: returned `dir` has a positive Y component AND lateral X is biased toward target's X.

**P2-T31** — Bot doesn't collide with hazards.
- Hazard center at (200, 0), body at (150, 0) moving +X.
- Run 60 ticks of `computeInput`.
- Assert: across at least 70% of ticks, the returned `dir` has a NEGATIVE-Y or large-perpendicular component (steering away).

**P2-T32** — Bot fires aggressive items more eagerly in 8th place.
- Mock view: bot is 8th of 8 (body progress lowest). Inventory carries `'rr-whirlpool'`. Run 1000 computeInput calls.
- Assert: ratio of ticks with `actionBits & 0b01` ≥ 0.40.
- Run again with bot in 1st place (mock progress highest).
- Assert: ratio ≤ 0.35.

**P2-T33** — Bot picks the inside line on hairpins ~70% of the time.
- View targeting hairpin checkpoint (idx=3 or 9). Run 100 computeInput calls fresh-instantiating the bot each call (so the lineMode roll fires fresh).
- Assert: 50–90 of the 100 trials have `dir` biased toward the inner apex offset.

### 9.8 Snapshot bandwidth (regression)

**P2-T34** — Snapshot delta size grows by ~1 number per body per tick.
- Boot a 2-body room. Run 60 ticks.
- Capture all `snapshot.delta` frames; sum the JSON-serialised byte length.
- Compare to a baseline (Phase 1 expected size, captured pre-merge).
- Assert: delta size grew by < 50% (one new field per body per delta).

This protects the 5Hz delta budget — adding a `placement` per body per delta = +6-byte ASCII number. With 8 bodies × 5Hz = 40 numbers/s = ~240 bytes/s of overhead. Acceptable.

---

## 10. Risks + mitigations

### R1 — Combined boost stack exceeds anti-cheat tolerance

**Risk:** Naively adding mechanics → drift-3 + launch + slipstream + ribbon + apex = +1.23 → 2.23×, blowing the 2.0× validator.

**Mitigation:** `KINEMATIC_BOOST_CAP = 0.85` clamps the positive sum. Verified by P2-T27 (combined stack never exceeds 1.85×). Hard cap in `integrateMotion` already exists at 1.85× — keeps fail-safe path. Validator tolerance unchanged.

### R2 — Apex check geometry is O(N×M) per tick (N bodies × M zones)

**Risk:** With 8 bodies × 2 hairpins = 16 distance checks/tick = 480/s. Trivial, but if Phase 3 adds 10 hairpins it becomes 80/s × 5 = 400 — still fine. Naive math.

**Mitigation:** Distance² comparison (no sqrt). Per-body `apexCheckedThisLap.has(...)` short-circuits the work after the first verdict per zone. No optimization needed for Phase 2.

### R3 — Boost ribbon math depends on track centerline

**Risk:** PR #60 made the track an ellipse. If ribbons were derived from the legacy CatmullRom curve they'd be off the track.

**Mitigation:** Ribbons use `reefCenterlineAt(t)` directly (the canonical ellipse function) — same source the checkpoints use. Verified by `buildReefBoostRibbons()` calling `reefCenterlineAt` with hardcoded t values (0.04/0.96, 0.46/0.54).

### R4 — Placement-weighted item table balance

**Risk:** Misweighting makes 1st place trivially unkillable OR 8th place can't catch up.

**Mitigation:** Initial weights mirror Mario Kart 8's tier curve from public reverse-engineering. Telemetry hooks: `event.power_up_collected` is broadcast today; we add `placementAtCollect` to the event payload (additive — old clients ignore). Phase 2.5 dashboard reads this to validate the rubber-band lift (target: 8th-place position-gain rate ≥ 1.5× compared to no-rubber-band baseline).

### R5 — Slipstream behind a stalled launcher = noob bonus / exploit

**Risk:** A player who eats a launch-stall (-50% speed cap) is moving slowly. A sneaky opponent could draft them for a free wake.

**Mitigation:** `SLIPSTREAM_MIN_VEL_ALIGNMENT` requires both velocities to align (≥0.5 dot product). A stalled body moving at 75 wu/s won't generate enough wake velocity — `tSpeed < REEF_MAX_SPEED * 0.30 = 150 wu/s` early-out kicks in. Verified by P2-T2.

### R6 — `event.slipstream` event spam at boundary

**Risk:** A body bouncing in/out of the wake fires repeated events.

**Mitigation:** `wasActive` flag (§2.7) — `event.slipstream` only fires on the FIRST tick of a fresh boost. Re-entering the same source within the grace window doesn't re-broadcast. The activeBoosts entry is REFRESHED each tick the body's in-wake but the event is edge-triggered.

### R7 — Phase 2 ships with no feature flag

**Risk:** Spec mandates "DO NOT add a feature flag / kill switch — just ship." If the balance is wrong, rollback = revert PR.

**Mitigation:** Phase 1 critical anchors C1-C6 and S4-S6, S10-S11 verified untouched by Phase 2 changes (audit instructions). No drift / launch path is rerouted. Rolling back Phase 2 leaves a clean Phase 1 game.

### R8 — Bot heuristic regression

**Risk:** New draft + apex + hazard logic disturbs existing bot tests (T22-T25 already test launch + drift + grace).

**Mitigation:** All new bot logic gates on placement / hairpin / draft-target detection. Existing tests use generic checkpoints + placements; new logic only fires when conditions match. Run existing T22-T25 unchanged in the same test file — they MUST still pass.

### R9 — `RoomMeta.reefStaticZones` payload growth

**Risk:** Adding three arrays (ribbons, apex, hazards) to `snapshot.init` increases first-frame size.

**Mitigation:** Phase 2 ships 2 ribbons + 2 apex zones + 2 hazards × ~50 bytes each ≈ 600 bytes. `snapshot.init` baseline is ~2-4KB. < 25% growth. Sent ONCE per room; never on deltas.

### R10 — Ribbon cooldown semantics edge case

**Risk:** Server tick clock vs `Date.now()` for `ribbonLastCollectedAt`. Phase 1 uses `Date.now()` for boost expiries but `state.tick` for drift state. Mismatched semantics could break determinism.

**Mitigation:** Phase 2 uses `Date.now()` (passed as `now` param into `resolveBoostRibbons`) for cooldown — same as `activeBoosts.expiresAt`. `state.tick` is reserved for charge-counting (drift sparks). Documented in code header.

### R11 — `applyEntityDelta` first-insert branch needs `placement` init

**Risk:** A first-insert body without a `placement` field would render as `undefined` in HUD.

**Mitigation:** First-insert branch sets `placement: undefined` (it's optional per the protocol comment). HUD's `<PlacementTile>` already early-returns on `null` — extends to `undefined` via `if (!placement) return null`. Single-line change.

### R12 — Ribbon detection on a curved approach

**Risk:** The ribbon "rib-top" sits in a near-straight section, but the centerline curves. A body approaching at a slight angle could miss the segment AABB even if visually crossing.

**Mitigation:** `RIBBON_HALF_WIDTH = 35wu` is wide enough (2.5× body radius) that a ±10° angle of attack still hits. Tested P2-T11/T13. If telemetry shows a >10% miss rate in Phase 2.5, widen to 50wu in a follow-up.

### R13 — `computeLivePlacements` per-tick cost (called in respawn + delta)

**Risk:** O(N log N) twice per snapshot tick + once per pickup respawn. Worst case: 8 bodies × ~20 deltas/sec = 160 sorts/sec. Trivial.

**Mitigation:** Cache `state.lastPlacementMap` between calls in the same tick. Recompute at most once per `tickRoom`. Stored on `ReefRoomState`.

---

## 11. File-by-file scope table

Pattern matches `.claude/plans/reef-race-phase1-detailed.md` §10. Owner is `orchestrator` unless noted; line-count estimate is a delta over current file size.

| File | Owner | Phase 2 changes | Δ lines |
|---|---|---|---|
| `packages/shared/src/activities/protocol.ts` | orchestrator | Add 4 events to `ServerFrame` union (`slipstream`, `apex_bonus`, `ribbon_collected`, `hazard_hit`). Add `reefStaticZones` to `RoomMeta`. Document `placement?: number` in `EntityDelta.changed` block. | +60 |
| `apps/api/src/services/activity/sim/reef-race-config.ts` | orchestrator | Add: Phase-2 `ReefBoostKind` extensions (5 new), `KINEMATIC_BOOST_CAP`, `KINEMATIC_BOOST_FLOOR`, slipstream constants (7), apex constants (7) + `APEX_HAIRPIN_CHECKPOINT_INDICES`, ribbon types (`ReefBoostRibbon`) + builder + 4 constants, hazard types (`ReefHazardPatch`) + builder + 3 constants, `PLACEMENT_ITEM_TABLE` + `getPlacementItemTable`. | +220 |
| `apps/api/src/services/activity/sim/reef-race-sim.ts` | orchestrator | Add `slipstream*`/`ribbons*`/`apex*`/`hazard*` fields to `ReefBody` (§3); add `ribbons`/`apexZones`/`hazards`/`lastPlacementMap` to `ReefRoomState`; build them at `startRoom`; init body fields at body init; new private methods `resolveSlipstream`, `resolveBoostRibbons`, `resolveApex`, `resolveHazards`, `computeLivePlacements`, `rollPowerUpKindForPlacement`, `getStaticZones`; insert resolves into tick pipeline (§2.2); modify `applyIntentForTick` step 4 to use cap/floor stack arithmetic (§2.3); widen `isBoostActive` gate in `integrateMotion`; add lap-up cleanup in `resolveCheckpoints`; modify `resolvePickups` to use placement-rolled kind; add `placement` field to `ReefSnapshot.bodies`, `buildSnapshot`, `broadcastDelta` predicate + emitted `changed` object. | +380 |
| `apps/api/src/services/activity/activity-ws-hub.ts` | orchestrator | In `sendInit` reef-race branch: include `reefStaticZones: reefRaceSim.getStaticZones(room.id)` in the emitted `RoomMeta`. | +5 |
| `apps/api/src/services/activity/bots/reef-race-bot.ts` | orchestrator | Add `draftTargetPetId`, `lineMode`, `nextRibbonId` instance fields; add `pickDraftTarget` + `getOwnPlacement` private helpers; integrate draft + apex + hazard + placement-weighted item-fire logic into `computeInput`. | +130 |
| `apps/api/src/services/activity/sim/__tests__/reef-race-sim.test.ts` | orchestrator | Add P2-T1..P2-T29 sim tests. | +500 |
| `apps/api/src/services/activity/bots/__tests__/reef-race-bot.test.ts` | orchestrator | Add P2-T30..P2-T33 bot tests. | +120 |
| `apps/web/src/stores/activity.ts` | orchestrator | Add `slipstreamActive`, `lastApexVerdict`, `lastRibbonCollectedAt`, `lastHazardHitAt`, `lastSlipstreamEventAt` to `ActivityState` + `emptyState()`. Add `placement` hoist in `snapshot.delta` handler. Add 4 `case` branches before `default: never`. | +70 |
| `apps/web/src/components/game/reef-race-hud.tsx` | orchestrator | Mount `<ReefRaceSlipstreamTag>`, `<ReefRaceApexToast>`. Update `<PlacementTile>` to show rarity-tier hint icon. | +25 |
| `apps/web/src/components/game/reef-race-slipstream-tag.tsx` | orchestrator | NEW file — `DRAFT` chip top-center. Primitive-bool subscription + 250ms auto-clear timer. | +60 |
| `apps/web/src/components/game/reef-race-apex-toast.tsx` | orchestrator | NEW file — apex-verdict toast. Object subscription on `lastApexVerdict` + 1.5s auto-fade. | +60 |
| `apps/web/src/lib/three/activities/reef-race/reef-race-config.ts` | 3da | Add visualization-only constants: `RIBBON_VISUAL_HEIGHT`, `RIBBON_VISUAL_THICKNESS`, `HAZARD_VISUAL_TUBE`, `HAZARD_VISUAL_TUBULAR_SEGS`, `APEX_RING_THICKNESS`. (Server constants imported from `apps/api/...` are NOT cross-consumed; client gets values via `RoomMeta.reefStaticZones`.) | +20 |
| `apps/web/src/lib/three/activities/reef-race/ReefRaceBoostRibbons.tsx` | 3da | NEW file — flat box mesh per ribbon, emissive pulse, module-scope geometry/material, primitive store subscription on `room.reefStaticZones`. | +90 |
| `apps/web/src/lib/three/activities/reef-race/ReefRaceHazards.tsx` | 3da | NEW file — TorusKnot urchin placeholder per hazard, static, module-scope geo/mat. | +70 |
| `apps/web/src/lib/three/activities/reef-race/ReefRaceApexMarkers.tsx` | 3da | NEW file — two ring meshes per apex zone (inner green + outer amber). | +70 |
| `apps/web/src/lib/three/activities/reef-race/ReefRaceScene.tsx` | 3da | Mount the 3 new components inside `<SceneContents>`. | +6 |
| `3dStructure.md` | 3da | Document the 3 new scene components, their draw-call cost, and that ribbon/hazard/apex marker positions come from `RoomMeta.reefStaticZones`. Bump "Last Audited". | +40 |
| `GameFeatures.md` | orchestrator | Document the 5 new mechanics under Reef Race section. Update combined-boost ceiling math. Bump "Last Audited". | +60 |
| `packages/agent-templates/src/locations/town-guide.ts` | orchestrator | Update `knowledge[]` with one paragraph: "Reef Race Phase 2 adds slipstream drafting, apex bonuses on the two hairpins, boost ribbons on the long straights, sea-urchin hazard zones, and Mario-Kart-style placement-weighted power-ups (1st gets defense, 8th gets offense)." | +5 |

**Totals:** 18 files touched, ~2000 lines added.

**No-touch invariants — verify in audit:**
- Phase 1 anchors C1, C2, C3, C4, C5, C6 — drift bias INSIDE atan2, separate `activeBoosts`/`activeEffects` maps, named tolerance, launch verdict path, bot launch early-return, drift cancel rules. None of these surfaces are rewritten in Phase 2.
- Phase 1 anchors S4, S5, S6, S10, S11 — boost delivery via speedMod (no impulse), boost-gated hard cap, abort buffer cleanup, `startedAt` in `startRoom`, first-sighting `driftSparks` init. None rewritten.
- `REEF_KINEMATIC_TOLERANCE = 2.0` unchanged.
- `REEF_MAX_SPEED = 500`, `REEF_BOOST_MULT = 1.4`, `REEF_BODY_RADIUS = 22` unchanged.
- All Phase 1 sim tests (T1..T21) and bot tests (T22..T25) MUST still pass after Phase 2 lands. Phase 2 changes are STRICTLY additive — no test rewrites.

---

## 12. Implementation order (dependency graph)

```
Step 1:  protocol.ts — add 4 events to ServerFrame, add reefStaticZones to RoomMeta.
          (Type-only; restoreds TypeScript build with the same `default: never`
          break that Phase 1 used as a build guard.)

Step 2:  activity.ts — add 4 empty case branches. Add new state fields to
          ActivityState/emptyState. Add placement hoist in snapshot.delta handler.
          (Restores TypeScript build after Step 1.)

Step 3:  reef-race-config.ts — add all server constants, types, and builders.
          NO RUNTIME PATH CHANGE.

Step 4:  reef-race-sim.ts (server)
          - ReefBody fields + ReefRoomState fields
          - startRoom builds ribbons/apexZones/hazards
          - body init populates new fields
          - applyIntentForTick step 4: cap/floor speedMod arithmetic
          - integrateMotion: widen isBoostActive gate
          - new private methods (resolveSlipstream, resolveBoostRibbons,
            resolveApex, resolveHazards, computeLivePlacements,
            rollPowerUpKindForPlacement, getStaticZones)
          - tick pipeline: insert resolves at §2.2 positions
          - resolvePickups: re-roll on collect via placement table
          - resolveCheckpoints: lap-up cleanup of new sets
          - buildSnapshot + broadcastDelta: placement field
          ← Keep all broadcast emissions of new event types behind `if (false)`
            until Step 6.

Step 5:  reef-race-sim.test.ts — Tests P2-T1..P2-T29.
          ALL must pass before Step 6.

Step 6:  Flip broadcast emissions ON. (Remove `if (false)` guard from Step 4.)
          Re-run Step 5 — same tests now exercise the live broadcast path.

Step 7:  activity-ws-hub.ts — sendInit emits reefStaticZones.

Step 8:  reef-race-bot.ts — draft + apex + hazard + placement item-fire heuristics.

Step 9:  reef-race-bot.test.ts — Tests P2-T30..P2-T33.

Step 10: HUD — reef-race-slipstream-tag.tsx, reef-race-apex-toast.tsx, mount in
          reef-race-hud.tsx; rarity-tier hint in PlacementTile.

Step 11: 3D — reef-race-config.ts (client) visualization constants;
          ReefRaceBoostRibbons.tsx, ReefRaceHazards.tsx, ReefRaceApexMarkers.tsx;
          mount in ReefRaceScene.tsx.

Step 12: Docs — 3dStructure.md (3da), GameFeatures.md (orchestrator),
          town-guide.ts knowledge[] (orchestrator). Same diff.
```

Steps 1–9 are server-only. Steps 10–11 are client visual. Reverting Steps 10–11 never breaks the server contract. Reverting Step 7 cleanly removes the static-zone wire data without touching runtime mechanics — server still emits events, clients silently drop them.

---

## 13. Out of scope (Phase 2 enforcement)

- Slipstream particle trail VFX — see §5.4 deferral rationale. Reconsider in Phase 2.5 if telemetry justifies.
- Final art for ribbons / hazards — placeholder geometry only. Polish pass deferred.
- Per-archetype stat modifiers (Phase 3): `slipstreamWindowMs`, `ribbonDetectRadiusMultiplier`, etc. Phase 2 uses fixed constants only.
- New power-up kinds (e.g. lightning) — out of scope; sticking to existing 6.
- Personal-best ghost (Phase 4).
- Top-speed cap reduction or per-archetype cap (forbidden invariant).
- Feature flag / kill switch (per spec).
- `import 'three/webgpu'` anywhere (PR #59 ban).
- Per-frame `new Vector3()` or other GC-producing allocations.
- Map/Set subscriptions in HUD components.
- Modifying `REEF_KINEMATIC_TOLERANCE`, `REEF_MAX_SPEED`, or `REEF_BOOST_MULT`.
- Rewriting any Phase 1 critical path (drift bias, activeBoosts separation, named tolerance, launch verdict path, bot launch early-return).

---

## 14. Audit checklist (for the second-pass auditor)

The auditor should grep / read for each of these and assert as listed.

- [ ] `KINEMATIC_BOOST_CAP = 0.85` exported from `reef-race-config.ts`. `KINEMATIC_BOOST_FLOOR = -0.50` exported.
- [ ] `applyIntentForTick` step 4 uses both constants — verify by reading the source: positive sum capped at 0.85, negative sum floored at -0.5.
- [ ] `integrateMotion` `isBoostActive` gate enumerates ALL 5 positive kinematic kinds (`launch-boost`, `drift-boost`, `slipstream-boost`, `ribbon-boost`, `apex-bonus`).
- [ ] All four new ServerFrame events are referenced in `activity.ts` switch with explicit `case ...: break;` BEFORE `default: never`.
- [ ] `placement` field is broadcast in `EntityDelta.changed` AND included in the delta-predicate equality check.
- [ ] `RoomMeta.reefStaticZones` populated in `sendInit` reef-race branch.
- [ ] Each new resolver (`resolveSlipstream`, `resolveBoostRibbons`, `resolveApex`, `resolveHazards`) is called inside `tickRoom` at the §2.2 insertion order — slipstream BEFORE proximity, ribbons/apex/hazard AFTER pickups, BEFORE checkpoints.
- [ ] `body.ribbonsCollectedThisLap`, `apexCheckedThisLap`, `hazardsHitThisLap` ALL cleared in `resolveCheckpoints` lap-up branch.
- [ ] No new HUD component subscribes to a Map or non-primitive store field.
- [ ] No new file imports `three/webgpu`.
- [ ] No new `useFrame` body allocates a Vector3, Quaternion, or new object literal.
- [ ] All Phase 1 critical anchors (C1-C6, S4-S6, S10-S11) UNCHANGED — verify via `git diff master` on those exact line spans.
- [ ] All Phase 1 tests (T1-T25) still pass post-Phase-2 — verify via `bun test apps/api/src/services/activity/sim/__tests__/reef-race-sim.test.ts apps/api/src/services/activity/bots/__tests__/reef-race-bot.test.ts`.
- [ ] `combined boost stack ≤ 1.85×` proven by P2-T27 (the master ceiling test).
- [ ] `applyEntityDelta` first-insert branch tolerates undefined `placement` cleanly.
- [ ] `bot.computeInput` test T22-T25 (Phase 1) still pass — i.e. existing launch + drift + grace + cooldown behaviours preserved.
