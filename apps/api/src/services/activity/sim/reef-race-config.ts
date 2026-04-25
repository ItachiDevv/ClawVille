/**
 * Q2 Activity Portals — Reef Race track + sim constants (chunk #5).
 *
 * These constants define the bespoke oval track per 3d-spec §2.1 + the
 * server-authoritative race rules per backend §4.5. They live in a
 * separate file so the future 3D scene (chunk #6) can import the same
 * checkpoint positions + centerline for visual gate placement WITHOUT
 * importing the sim module (which pulls in DB + event-logger transitive
 * deps via the replay log).
 *
 * Coordinate system: same as Bumper Shells — flat XY plane, +Y is "up
 * the track" at the start straight, origin = track center. Server-only
 * units; the 3D layer multiplies by `AVATAR_SCALE` (40) when laying out
 * meshes.
 *
 * Track shape (3d-spec §2.1):
 *   - Closed oval, ~6000 wu perimeter, 3 laps default = ~18000 wu race
 *   - 300 wu wide track, ~36s/lap at MAX_REEF_SPEED ≈ 500 wu/s
 *   - 1 chicane (S-bend, near checkpoint 6) + 1 long straight (start/finish)
 *
 * Checkpoint sequence: 12 AABB volumes evenly spaced around the
 * centerline. `0` is the start/finish line; `1..11` advance counter-
 * clockwise. A lap completes when a body crosses checkpoint 0 AFTER
 * having sequentially crossed 1→11. Out-of-order crossings are silently
 * ignored — the sim does not advance the per-avatar pointer. Per backend
 * §4.5 this is the single biggest anti-cheat: it kills the
 * "teleport-to-finish" exploit at the source, no validator round-trip
 * needed.
 *
 * IMPORTANT: changing checkpoint count, perimeter, lap count, or min
 * lap time requires updating `GameFeatures.md` §19 in the same diff
 * (see CLAUDE.md "Documentation Update Policy").
 */

import type { Vec2 } from '@clawville/shared';

// ─── Race rules (founder-tunable) ───────────────────────────────────────────

/** Number of laps to complete a race. Plan-locked at 3. */
export const REEF_LAPS = 3;

/** Number of checkpoints around the track including start/finish. */
export const REEF_CHECKPOINT_COUNT = 12;

/**
 * Minimum legal lap time. Faster than this = discarded + flag. Backend
 * §4.5: tuned for the 6000wu × 1 lap path at MAX_REEF_SPEED. A clean
 * fast lap is ~30–36s; 15s is well below the physically-reachable
 * ceiling so it cleanly catches teleport+next-checkpoint exploits.
 */
export const MIN_LAP_MS = 15_000;

/**
 * Soft cap on round duration (ms). After this the round-end check
 * starts marking unfinished racers as DNF on the next tick. Plan §"Game
 * design — Reef Race" locks at 90s soft + 30s grace per straggler.
 */
export const REEF_SOFT_TIMEOUT_MS = 90_000;

/**
 * Per-straggler grace window after the soft timeout fires. Lets the
 * last 1–2 racers finish without immediately DNF'ing. Capped so a
 * single offline body can't hold the round forever.
 */
export const REEF_STRAGGLER_GRACE_MS = 30_000;

/** Hard cap so DNFs eventually resolve even if all racers go dark. */
export const REEF_HARD_TIMEOUT_MS = REEF_SOFT_TIMEOUT_MS + REEF_STRAGGLER_GRACE_MS;

/**
 * Anti-cheat — repeated checkpoint-skip attempts inside this window
 * count as a single pattern. 3+ skips in 5s → flag. Per backend §4.5.
 */
export const REEF_SKIP_PATTERN_WINDOW_MS = 5_000;
export const REEF_SKIP_PATTERN_THRESHOLD = 3;

// ─── Physics caps (founder-tunable) ─────────────────────────────────────────

/**
 * Max body speed in wu/s. Per 3d-spec §2.1 a max-speed lap takes ~12s
 * for 6000wu, but we cap at ~500 to leave headroom for boost (1.4×).
 * The clean-lap pace cited above is ~30s = ~200wu/s sustained — which
 * lines up with the boost-based "fastest plausible" tail at 500wu/s.
 */
export const REEF_MAX_SPEED = 500;

/** Boost multiplier on top-speed when turbo-bubble is active. */
export const REEF_BOOST_MULT = 1.4;

/**
 * Max linear acceleration (wu/s²). 4× MAX_SPEED gives a 0.25s thrust→
 * cap impulse — same feel as Bumper, scaled up because Reef cars are
 * heavier-feeling kart-like things, not bumper shells.
 */
export const REEF_MAX_ACCEL = REEF_MAX_SPEED * 4;

/** Velocity multiplier per frame applied as drag (forward decay). */
export const REEF_DRAG = 0.97;

/** Body radius for kart-vs-kart proximity checks (wu). */
export const REEF_BODY_RADIUS = 22;

// ─── Track geometry — centerline ────────────────────────────────────────────

/**
 * Half-axes of the oval centerline (wu). Perimeter for an ellipse is
 * approximately π × (3(a+b) − √((3a+b)(a+3b))) ≈ 6024 wu at these
 * values — within the 6000 wu spec target.
 */
export const REEF_TRACK_A = 1100;
export const REEF_TRACK_B = 700;

/** Track lane half-width (wu). Total lane = 300 wu. */
export const REEF_TRACK_HALF_WIDTH = 150;

/**
 * Bounding-box half-extent applied to each checkpoint AABB on top of
 * the centerline tangent. Wide enough to catch any kart inside the
 * track corridor at the checkpoint x-section without false-firing on
 * adjacent-checkpoint passes.
 */
export const REEF_CHECKPOINT_HALF_DEPTH = 60;
export const REEF_CHECKPOINT_HALF_WIDTH = REEF_TRACK_HALF_WIDTH;

/**
 * Centerline path generator. Returns a point on the oval at parametric
 * `t` in [0, 1) where `t=0` is the start/finish line (positive Y axis,
 * minor-axis pole) and t advances counter-clockwise.
 *
 * Pure function — used both at sim boot to allocate checkpoints and at
 * test time to compute deterministic positions.
 */
export function reefCenterlineAt(t: number): Vec2 {
  // Oval parameterised so t=0 sits at +Y on the minor axis (where the
  // start/finish line conventionally lives in racing layouts).
  const angle = Math.PI / 2 + 2 * Math.PI * t;
  return {
    x: REEF_TRACK_A * Math.cos(angle),
    y: REEF_TRACK_B * Math.sin(angle),
  };
}

/**
 * Tangent unit vector at parametric `t` — used to orient checkpoint
 * AABBs perpendicular to the racing line. `+1` direction = direction of
 * travel (counter-clockwise).
 */
export function reefTangentAt(t: number): Vec2 {
  const angle = Math.PI / 2 + 2 * Math.PI * t;
  // d/dθ of (a cosθ, b sinθ) is (-a sinθ, b cosθ), then normalise.
  const tx = -REEF_TRACK_A * Math.sin(angle);
  const ty = REEF_TRACK_B * Math.cos(angle);
  const mag = Math.hypot(tx, ty) || 1;
  return { x: tx / mag, y: ty / mag };
}

// ─── Checkpoint allocation ──────────────────────────────────────────────────

/**
 * Axis-aligned bounding box for a checkpoint volume — sim does a cheap
 * point-in-box test once per body per tick. AABBs are oriented along
 * the centerline tangent and inflated to lane width × depth.
 */
export interface ReefCheckpointAabb {
  /** Sequence index (0=start/finish; 1..11 around the loop counter-clockwise) */
  index: number;
  /** Center point on the centerline (wu) */
  center: Vec2;
  /** Tangent direction at this point (forward of travel). Unit vector. */
  tangent: Vec2;
  /** Inward normal (toward arena interior) — convenience for 3D gate orientation. */
  normal: Vec2;
}

/**
 * Pre-compute the 12 checkpoints. Order matters — index 0 is the
 * start/finish line.
 */
export function buildReefCheckpoints(): ReefCheckpointAabb[] {
  const out: ReefCheckpointAabb[] = [];
  for (let i = 0; i < REEF_CHECKPOINT_COUNT; i++) {
    const t = i / REEF_CHECKPOINT_COUNT;
    const center = reefCenterlineAt(t);
    const tangent = reefTangentAt(t);
    // Inward normal — perpendicular to tangent, pointing toward origin.
    // Simple 90° left turn on the tangent (since we travel CCW the inside
    // is on our left), then dot-check against (origin - center) to flip
    // sign if it pointed outward.
    let nx = -tangent.y;
    let ny = tangent.x;
    if (nx * -center.x + ny * -center.y < 0) {
      nx = -nx;
      ny = -ny;
    }
    out.push({
      index: i,
      center,
      tangent,
      normal: { x: nx, y: ny },
    });
  }
  return out;
}

/**
 * Cheap point-in-AABB test along a checkpoint's tangent frame. Returns
 * true when the body is inside the rectangular checkpoint volume.
 *
 * The volume is `2 × HALF_WIDTH` along the tangent's left-perpendicular
 * (i.e. lane-width) by `2 × HALF_DEPTH` along the tangent (i.e. the
 * narrow band a kart must pass through to register the checkpoint).
 */
export function isInsideCheckpoint(
  body: { x: number; y: number },
  cp: ReefCheckpointAabb,
): boolean {
  const dx = body.x - cp.center.x;
  const dy = body.y - cp.center.y;
  // Tangent component (along direction of travel).
  const along = dx * cp.tangent.x + dy * cp.tangent.y;
  // Perpendicular component (lane-width direction). Take the
  // magnitude of the perpendicular projection.
  const perpX = dx - along * cp.tangent.x;
  const perpY = dy - along * cp.tangent.y;
  const perp = Math.hypot(perpX, perpY);
  return (
    Math.abs(along) <= REEF_CHECKPOINT_HALF_DEPTH &&
    perp <= REEF_CHECKPOINT_HALF_WIDTH
  );
}

// ─── Power-up catalog (3d-spec + master plan §"Reef Race power-ups") ────────

/**
 * impl-audit M1 — `ReefPowerUpKind` lives in `@clawville/shared` so the
 * client-facing protocol's `event.power_up_collected.kind` field can narrow
 * to the same union (was `string`). Re-exported here so server code that
 * already imports `from './reef-race-config'` keeps working unchanged.
 *
 * A new kind MUST be added in the shared `protocol.ts` definition first;
 * the server union below derives from it so any drift fails to compile.
 */
import type { ReefPowerUpKind as SharedReefPowerUpKind } from '@clawville/shared';
export type ReefPowerUpKind = SharedReefPowerUpKind;

export interface ReefPowerUpDef {
  kind: ReefPowerUpKind;
  rarity: 'common' | 'uncommon' | 'rare' | 'legendary';
  /** Active duration ms (0 = instant) */
  effectMs: number;
  /** Cooldown after activation (cooldown is charge-internal; consumed slot resets to empty) */
  cooldownMs: number;
  /** Spawn weight relative to other defs */
  weight: number;
}

/**
 * LOCKED catalog from the Q2 plan §"Game design — Reef Race → Power-up
 * catalog". 6 entries; weights produce a roughly common → legendary
 * distribution favoring movement boosts (the core verb of a race).
 */
export const REEF_POWERUP_DEFS: readonly ReefPowerUpDef[] = [
  // 50% common / 22% uncommon / 18% rare / 10% legendary baseline
  { kind: 'rr-turbo-bubble', rarity: 'common', effectMs: 2_500, cooldownMs: 0, weight: 50 },
  { kind: 'rr-bubble-shield', rarity: 'uncommon', effectMs: 4_000, cooldownMs: 0, weight: 12 },
  { kind: 'rr-ink-slick', rarity: 'uncommon', effectMs: 6_000, cooldownMs: 0, weight: 10 },
  { kind: 'rr-seeker-jelly', rarity: 'rare', effectMs: 0, cooldownMs: 8_000, weight: 10 },
  { kind: 'rr-tide-wave', rarity: 'rare', effectMs: 0, cooldownMs: 8_000, weight: 8 },
  { kind: 'rr-whirlpool', rarity: 'legendary', effectMs: 3_000, cooldownMs: 12_000, weight: 10 },
];

export function getReefPowerUpDef(kind: ReefPowerUpKind): ReefPowerUpDef {
  const def = REEF_POWERUP_DEFS.find((d) => d.kind === kind);
  if (!def) throw new Error(`Unknown Reef power-up kind: ${kind}`);
  return def;
}

/** Number of pickup slots per kart (mirrors Bumper's 2-slot inventory). */
export const REEF_MAX_POWER_UP_SLOTS = 2;

/** Number of power-up boxes spawned on the track simultaneously (3d-spec §2.6 caps at 16). */
export const REEF_POWERUP_BOX_COUNT = 8;

/** Cooldown before a collected box respawns (ms). */
export const REEF_POWERUP_RESPAWN_MS = 6_000;

/** Pickup contact radius (wu). */
export const REEF_POWERUP_RADIUS = 28;

/** Sim tick rate (Hz). 30Hz per task spec (race kinematics tolerate lower rate). */
export const REEF_TICK_HZ = 30;

// ─── Phase 1 — Drift state machine + launch boost (Reef Race rebuild) ───────

/**
 * Sim tick period in milliseconds (33.33ms at 30Hz).
 * Exported so the bot can convert ticks↔ms without re-deriving the constant.
 */
export const REEF_TICK_MS = 1000 / REEF_TICK_HZ;

/**
 * Boost-kind union for drift + launch + Phase 2 kinematic effects. SEPARATE
 * from `ReefPowerUpKind` (pickup-only) — these live in
 * `body.activeBoosts: Map<ReefBoostKind, …>` to keep the strict pickup type
 * inviolate (audit C2 fix).
 *
 * Phase 2 kinds carry NEGATIVE mults for `apex-penalty` / `hazard-slow`. The
 * name "boost" is an artifact — the union represents all kinematic effects
 * (positive or negative). Phase 3 cleanup ticket: rename to
 * `ReefKineticEffectKind`.
 */
export type ReefBoostKind =
  | 'launch-boost'      // Phase 1 — positive
  | 'launch-stall'      // Phase 1 — pseudo-effect, gates thrust
  | 'drift-boost'       // Phase 1 — positive
  | 'slipstream-boost'  // Phase 2 — positive (+0.20)
  | 'ribbon-boost'      // Phase 2 — positive (+0.30)
  | 'apex-bonus'        // Phase 2 — positive (+0.05)
  | 'apex-penalty'      // Phase 2 — negative (-0.05)
  | 'hazard-slow';      // Phase 2 — negative (-0.40)

// Drift spark tier thresholds (in sim ticks).
//   Tier 0→1: 0.4s = 12 ticks   → achievable in any medium corner
//   Tier 1→2: 0.9s = 27 ticks   → needs a sustained turn entry
//   Tier 2→3: 1.5s = 45 ticks   → requires a full hairpin (~1/3 of B-arc)
export const DRIFT_SPARK_TICK_1 = 12;
export const DRIFT_SPARK_TICK_2 = 27;
export const DRIFT_SPARK_TICK_3 = 45;
export const DRIFT_SPARK_TIERS: readonly [number, number, number] = [
  DRIFT_SPARK_TICK_1,
  DRIFT_SPARK_TICK_2,
  DRIFT_SPARK_TICK_3,
];

/**
 * Drift boost duration after release. Time-extended speedMod, NOT a velocity
 * impulse (audit S4 fix — eliminates double-counting against the speed cap).
 */
export const DRIFT_BOOST_DURATION_MS = 1_200;

/**
 * Additive speed multipliers per spark level (index 0 = spark 1).
 * Applied as: speedMod = 1 + DRIFT_BOOST_MULTS[sparkLevel - 1].
 * Stored on the ReefBoostEntry so no re-lookup is needed after drift state
 * is cleared at release.
 */
export const DRIFT_BOOST_MULTS: readonly [number, number, number] = [0.12, 0.24, 0.38];

/**
 * Constant absolute angular bias added to body.rot WHILE drift.charging is
 * true. Applied INSIDE step 6 of applyIntentForTick on the same line that
 * computes Math.atan2(...) — not as a per-tick accumulator (audit C1 fix).
 * Right turn (intent.dir.x > 0) subtracts, left turn adds.
 *
 * 15° = 0.2618 rad — visible kart-style lean into the corner.
 */
export const DRIFT_ANGULAR_BIAS_RAD = (15 * Math.PI) / 180;

/** Minimum forward speed (wu/s) required to start OR maintain a drift charge. */
export const DRIFT_MIN_SPEED_FOR_CHARGE = REEF_MAX_SPEED * 0.30; // 150 wu/s

/**
 * |dir.x| threshold — body must be cornering to initiate drift.
 * 0.25 ≈ 14.5° off straight. Single canonical name (the v1-draft
 * `DRIFT_MIN_ANGULAR_RATE` is intentionally NOT exported — one knob only).
 */
export const DRIFT_MIN_STEER = 0.25;

// Launch boost window (sub-window timings, ms).
export const LAUNCH_WINDOW_MS         = 150;   // half-window: ±150ms of green = boost
export const LAUNCH_BOOST_MULT        = 0.30;  // +30% speed cap for 2s
export const LAUNCH_BOOST_DURATION_MS = 2_000;
export const LAUNCH_STALL_WINDOW_MS   = 200;   // press >150ms but ≤350ms early → stall zone
export const LAUNCH_STALL_DURATION_MS = 1_000;
export const LAUNCH_STALL_THRUST_CAP  = 0.30;

/**
 * Anti-cheat tolerance multiplier for reef-race kinematic validators.
 * Replaces the two hard-coded `1.5` values in reef-race-sim.ts (audit C3 fix).
 *
 * Raised from 1.5× to 2.0×:
 *   Max combined boost = drift-3 (0.38) + launch (0.30) = 0.68 additive
 *   Effective speed = 500 × 1.68 = 840 wu/s
 *   Under 2.0× tolerance = 500 × 2.0 = 1000 wu/s — 160 wu/s safe margin
 *
 *   Under OLD 1.5× tolerance, drift-3 + launch (840 wu/s > 750 wu/s) would be
 *   silently clamped, stripping ~11% of the combined boost. Player feels robbed.
 */
export const REEF_KINEMATIC_TOLERANCE = 2.0;

// actionBit assignments. Bits 0+1 are pre-existing power-up slot toggles.
export const ACTION_BIT_POWERUP_0 = 0b0001;
export const ACTION_BIT_POWERUP_1 = 0b0010;
export const ACTION_BIT_DRIFT     = 0b0100;
export const ACTION_BIT_LAUNCH    = 0b1000;

// ─── Phase 2 — combined kinematic cap + negatives floor ─────────────────────

/**
 * Phase 2 — soft cap on the SUM of POSITIVE kinematic mults applied in
 * applyIntentForTick step 4. Bounds drift + launch + slipstream + ribbon +
 * apex-bonus stacking so the sum never crosses REEF_KINEMATIC_TOLERANCE (2.0×).
 *
 *   Max possible additive positive stack:
 *     drift-3 (0.38) + launch (0.30) + slipstream (0.20) + ribbon (0.30)
 *     + apex-bonus (0.05) = 1.23 → 1 + 1.23 = 2.23×
 *
 *   Cap at 0.85 → 1 + 0.85 = 1.85× = same backstop as the existing hard cap
 *   in integrateMotion. Anti-cheat tolerance (2.0×) buffers above this by
 *   0.15×, leaving room for one tick of integration overshoot.
 *
 *   Negative entries (apex-penalty, hazard-slow) bypass the positive cap (it
 *   should not protect a slow). They are summed into a SEPARATE
 *   negativeStack with its own floor (NEGATIVE_KINETIC_FLOOR).
 */
export const KINEMATIC_BOOST_CAP = 0.85;

/**
 * Phase 2 — floor on the SUM of NEGATIVE kinematic mults. Mirrors the
 * existing ink-slick override (which hard-floors speedMod at 0.5) by limiting
 * how much negatives can stack before the absolute speedMod floor takes over.
 *
 *   Max possible additive negative stack:
 *     hazard-slow (-0.40) + apex-penalty (-0.05) = -0.45
 *
 *   Floor at -0.50 → leaves 0.05 of headroom for any future negative
 *   (Phase 3 wall-scrape, etc.) without changing the absolute floor logic.
 *
 *   THREE clamps in the chain (in order):
 *     1. positiveStack ≤ KINEMATIC_BOOST_CAP    (this constant)
 *     2. negativeStack ≥ NEGATIVE_KINETIC_FLOOR (this constant)
 *     3. speedMod      ≥ 0.5                    (absolute floor in §2.3)
 *
 *   Ink-slick continues to OVERRIDE everything to speedMod = 0.5 (existing).
 */
export const NEGATIVE_KINETIC_FLOOR = -0.50;

// ─── Phase 2 — slipstream constants ─────────────────────────────────────────

/** Min distance behind a target to count as in-wake (wu). Avoid self-collision spam. */
export const SLIPSTREAM_MIN_DISTANCE = REEF_BODY_RADIUS * 1.5; // 33 wu
/** Max distance behind a target to count as in-wake (wu). Plan-locked. */
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
 * +20% top-speed mult while in-wake, per high-level plan §Phase 2.
 * Applied as additive contribution to positiveStack, capped via KINEMATIC_BOOST_CAP.
 */
export const SLIPSTREAM_BOOST_MULT = 0.20;
/**
 * Grace ticks after leaving the wake before boost expires AND the server emits
 * `event.slipstream_end`. Avoids dropouts on 1-tick lateral wobble. 0.2s = 6 ticks.
 */
export const SLIPSTREAM_GRACE_TICKS = 6;
/**
 * Active-boost ttl per refresh tick. With SLIPSTREAM_GRACE_TICKS = 6 the natural
 * expiry happens slightly after grace runs out — the server emits the
 * `event.slipstream_end` event at the SAME tick the grace counter hits 0,
 * not when the activeBoosts entry naturally expires.
 *
 * 250ms > 33ms tick (audit S3 fix) — boost survives one full tick longer than
 * its refresh cadence, so mid-tick expire-then-set can't double-broadcast.
 */
export const SLIPSTREAM_REFRESH_TTL_MS = 250;

// ─── Phase 2 — cornering apex constants ─────────────────────────────────────

/**
 * Apex marker is a planar disc on the INSIDE of each hairpin. Computed off the
 * checkpoint AABBs at the two hairpin t-values:
 *   Hairpin A (CCW pole): t = 0.25  → checkpoint index 3
 *   Hairpin B (CW pole):  t = 0.75  → checkpoint index 9
 *
 * Inside line is in the direction of the inward normal (already computed by
 * buildReefCheckpoints()).
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
/** Speed mults — small numbers per high-level plan §Phase 2. */
export const APEX_BONUS_MULT   = 0.05;  // +5%
export const APEX_PENALTY_MULT = -0.05; // -5%
/** Bonus / penalty duration (ms). 1.5s → ~half the time it takes to leave the corner. */
export const APEX_DURATION_MS = 1_500;

// ─── Phase 2 — boost ribbons ────────────────────────────────────────────────

/**
 * Boost ribbon — straight-line segment painted on the track surface. Crossing
 * the segment with a body radius overlap fires +30% / 2s.
 *
 * Geometry: each ribbon is an oriented line segment in sim-space (Vec2 a, Vec2 b).
 * The detection AABB is along the segment tangent, lane-perpendicular extents
 * = RIBBON_HALF_WIDTH. A body crossing the segment has its t-projection in [0,1]
 * AND |perp distance| ≤ RIBBON_HALF_WIDTH.
 *
 * Phase 2 ships ONE ribbon per straight (2 total).
 */
export interface ReefBoostRibbon {
  /** Ribbon id — avatarId-scoped "already collected this lap" set keys on this. */
  id: string;
  /** Start / end of the centerline segment in sim-space (wu). */
  a: Vec2;
  b: Vec2;
}

/** Half-width of ribbon detection band, perpendicular to segment tangent (wu). */
export const RIBBON_HALF_WIDTH = REEF_BODY_RADIUS * 1.6; // 35 wu
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

/**
 * Ribbons computed at module-load from centerline:
 *   - Ribbon "rib-top" — straight near t≈0 BUT FULLY BEFORE t=0 (start/finish):
 *     a = reefCenterlineAt(0.92), b = reefCenterlineAt(0.98)
 *     → finish-line gap excluded ON BOTH SIDES so the body never crosses the
 *     ribbon and the start/finish line in the same tick. Audit S13 fix.
 *   - Ribbon "rib-bot" — straight near t=0.5 (bottom of ellipse):
 *     a = reefCenterlineAt(0.46), b = reefCenterlineAt(0.54)
 */
export function buildReefBoostRibbons(): ReefBoostRibbon[] {
  return [
    { id: 'rib-top', a: reefCenterlineAt(0.92), b: reefCenterlineAt(0.98) },
    { id: 'rib-bot', a: reefCenterlineAt(0.46), b: reefCenterlineAt(0.54) },
  ];
}

// ─── Phase 2 — hazard patches ───────────────────────────────────────────────

/**
 * Hazard patch — circular slow zone clipping the inside-line of each hairpin.
 * "Sea urchin field" per high-level plan §Phase 2. Faster route through the
 * apex BUT you eat -40% speed while inside.
 */
export interface ReefHazardPatch {
  id: string;
  center: Vec2;
  radius: number;
}

/**
 * Hazard patch radius (wu). Body must center-overlap to count. Tuned so the
 * hazard fits between the apex marker and the centerline → drift-wide gives
 * apex-penalty, perfect-line gives apex-bonus, urchin-clip gives speed-damage.
 */
export const HAZARD_RADIUS = REEF_BODY_RADIUS * 2.5; // 55 wu
/** Inward offset from centerline to hazard center (wu). Slightly INSIDE apex marker. */
export const HAZARD_INSIDE_OFFSET = REEF_TRACK_HALF_WIDTH * 0.40; // 60 wu
/**
 * Hazard mult (additive negative). With the v2 arithmetic:
 *   - Drift-3 alone:           speedMod = 1.38 (ok)
 *   - Hazard alone:            speedMod = 0.60 (slow)
 *   - Drift-3 + hazard:        kineticDelta = 0.38 - 0.40 = -0.02 → speedMod = 0.98
 *     → "shortcut tradeoff" actually exists. The drifted player who takes the
 *     inside line through the urchin field comes out 2% slower than baseline
 *     — but they covered LESS DISTANCE through the apex, net win.
 *   - Drift-3 + hazard + turbo: positiveStack = 0.38, pickup = 0.40,
 *     effectivePositive = max(0.38, 0.40) = 0.40, neg = -0.40, kineticDelta = 0,
 *     speedMod = 1.00. Turbo "buys back" the hazard cleanly.
 */
export const HAZARD_SLOW_MULT = -0.40;
/**
 * Refresh cadence — hazard re-applies every tick the body overlaps. Effect
 * is set once with a short expiry; re-firing extends. Avoids a "leave the
 * patch but the boost lingers" feel.
 */
export const HAZARD_TICK_DURATION_MS = 200; // 6 ticks — enough to absorb tick scheduling jitter

/**
 * One hazard per hairpin. Center is offset from the hairpin checkpoint
 * center along its inward normal — slightly INSIDE the apex marker so the
 * apex bonus + hazard-clip combination forces a real choice.
 */
export function buildReefHazardPatches(): ReefHazardPatch[] {
  const cps = buildReefCheckpoints();
  return APEX_HAIRPIN_CHECKPOINT_INDICES.map((idx) => {
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

/**
 * Apex zones — inner (clean) + outer (wide) disc centers per hairpin.
 * Resides in this file so the client can import the same builder for
 * visualization. Server `state.apexZones` and client `RoomMeta.reefStaticZones`
 * are populated by the SAME builder (audit N3).
 */
export interface ReefApexZone {
  hairpinIndex: number;
  innerCenter: Vec2;
  outerCenter: Vec2;
}

export function buildReefApexZones(cps: ReefCheckpointAabb[]): ReefApexZone[] {
  return APEX_HAIRPIN_CHECKPOINT_INDICES.map((idx) => {
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

// ─── Phase 2 — placement-weighted power-up table ────────────────────────────

/**
 * Placement-keyed power-up roll table. Replaces the global `rollPowerUpKind`
 * draw at COLLECT time (`resolvePickups`) when a placement is supplied.
 *
 * Mario Kart rubber band — leaders get defensive items only, trailers get
 * aggressive items more often. Mid-pack rolls a neutral distribution that
 * mirrors REEF_POWERUP_DEFS.
 *
 * Weights are RELATIVE within each placement bucket (don't need to sum to 100).
 * The roll is sum-then-LCG-mod-then-walk, identical to existing rollPowerUpKind.
 */
export const PLACEMENT_ITEM_TABLE: Record<
  number,
  ReadonlyArray<{ kind: ReefPowerUpKind; weight: number }>
> = {
  // 1st place — defensive only
  1: [
    { kind: 'rr-bubble-shield', weight: 50 },
    { kind: 'rr-ink-slick',     weight: 30 },
    { kind: 'rr-turbo-bubble',  weight: 20 },
  ],
  // 2nd–3rd — defensive-leaning
  2: [
    { kind: 'rr-turbo-bubble',  weight: 35 },
    { kind: 'rr-bubble-shield', weight: 25 },
    { kind: 'rr-ink-slick',     weight: 20 },
    { kind: 'rr-tide-wave',     weight: 10 },
    { kind: 'rr-seeker-jelly',  weight:  7 },
    { kind: 'rr-whirlpool',     weight:  3 },
  ],
  3: [
    { kind: 'rr-turbo-bubble',  weight: 35 },
    { kind: 'rr-bubble-shield', weight: 25 },
    { kind: 'rr-ink-slick',     weight: 20 },
    { kind: 'rr-tide-wave',     weight: 10 },
    { kind: 'rr-seeker-jelly',  weight:  7 },
    { kind: 'rr-whirlpool',     weight:  3 },
  ],
  // 4th–5th — neutral (matches REEF_POWERUP_DEFS distribution)
  4: [
    { kind: 'rr-turbo-bubble',  weight: 50 },
    { kind: 'rr-bubble-shield', weight: 12 },
    { kind: 'rr-ink-slick',     weight: 10 },
    { kind: 'rr-seeker-jelly',  weight: 10 },
    { kind: 'rr-tide-wave',     weight:  8 },
    { kind: 'rr-whirlpool',     weight: 10 },
  ],
  5: [
    { kind: 'rr-turbo-bubble',  weight: 50 },
    { kind: 'rr-bubble-shield', weight: 12 },
    { kind: 'rr-ink-slick',     weight: 10 },
    { kind: 'rr-seeker-jelly',  weight: 10 },
    { kind: 'rr-tide-wave',     weight:  8 },
    { kind: 'rr-whirlpool',     weight: 10 },
  ],
  // 6th–7th — aggressive-leaning
  6: [
    { kind: 'rr-seeker-jelly',  weight: 25 },
    { kind: 'rr-tide-wave',     weight: 22 },
    { kind: 'rr-turbo-bubble',  weight: 20 },
    { kind: 'rr-whirlpool',     weight: 18 },
    { kind: 'rr-ink-slick',     weight: 10 },
    { kind: 'rr-bubble-shield', weight:  5 },
  ],
  7: [
    { kind: 'rr-seeker-jelly',  weight: 25 },
    { kind: 'rr-tide-wave',     weight: 22 },
    { kind: 'rr-turbo-bubble',  weight: 20 },
    { kind: 'rr-whirlpool',     weight: 18 },
    { kind: 'rr-ink-slick',     weight: 10 },
    { kind: 'rr-bubble-shield', weight:  5 },
  ],
  // 8th — aggressive only
  8: [
    { kind: 'rr-whirlpool',    weight: 35 },
    { kind: 'rr-seeker-jelly', weight: 30 },
    { kind: 'rr-tide-wave',    weight: 25 },
    { kind: 'rr-turbo-bubble', weight: 10 },
  ],
};

/**
 * Look up the weighted item table for a given placement. Out-of-range
 * placements (placement < 1 OR placement > 8) return `null` so the caller
 * falls through to the legacy global REEF_POWERUP_DEFS distribution.
 */
export function getPlacementItemTable(
  placement: number,
): ReadonlyArray<{ kind: ReefPowerUpKind; weight: number }> | null {
  return PLACEMENT_ITEM_TABLE[placement] ?? null;
}
