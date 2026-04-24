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
 * units; the 3D layer multiplies by `PET_SCALE` (40) when laying out
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
 * ignored — the sim does not advance the per-pet pointer. Per backend
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

export type ReefPowerUpKind =
  | 'rr-turbo-bubble'
  | 'rr-ink-slick'
  | 'rr-bubble-shield'
  | 'rr-seeker-jelly'
  | 'rr-tide-wave'
  | 'rr-whirlpool';

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
