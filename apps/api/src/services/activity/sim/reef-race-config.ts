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
 * Track timing now has two distinct budgets:
 *   - Legacy ellipse (flag OFF): 90s soft timeout + 30s grace.
 *   - v2 closed spline: ~95 741 wu per lap with a dedicated 300s per-lap
 *     budget; the current 2-lap race therefore has a 600s soft timeout.
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

import {
  REEF_BOOST_PAD_KICK_RATIO,
  type Vec2,
} from '@clawville/shared';

// ─── Race rules (founder-tunable) ───────────────────────────────────────────

/**
 * Number of laps to complete a race.
 *
 * v1 ellipse: was plan-locked at 3 on the small ~9 000 wu oval. The v4
 * WATER-DOMINANT closed-loop ring (2026-06-23) is MUCH bigger — ~53 506 wu arc,
 * one loop ≈ 125–160 s — so a 3-lap race would run ~7–8 min, far over the
 * 2–4 min target. Dropped to 2 so the BIG windy loop still gives a 2-lap
 * position battle at ~4–4.5 min total. The ellipse sim (flag OFF) and the
 * spline sim both read this; the wide ring is the path being driven toward.
 */
export const REEF_LAPS = 2;

/**
 * Number of laps to complete an N-lap CLOSED-LOOP reef race (spline sim).
 * Alias of {@link REEF_LAPS} — kept as a single source of truth so the
 * ellipse-era `REEF_LAPS` and the closed-loop lap sim never drift apart.
 * Default 2 (see {@link REEF_LAPS}). A race finishes when a body completes lap
 * `REEF_RACE_LAPS` and crosses the start/finish line (seam) going forward. See
 * `reef-race-spline-sim.ts` `resolveProgress`.
 */
export const REEF_RACE_LAPS = REEF_LAPS;

/** Number of checkpoints around the track including start/finish. */
export const REEF_CHECKPOINT_COUNT = 12;

/**
 * Reef Race Phase 4 — total clean checkpoint crosses required for a
 * "perfect" race. Mirrors `REEF_CHECKPOINT_COUNT * REEF_LAPS` and the
 * shared `TOTAL_CHECKPOINTS_PER_RACE` in
 * `@clawville/shared/activities/reef-race-streak`. When a body's
 * `bestStreakThisMatch` reaches this value, the perfect-lap bonus
 * (`rewardConfig.perfectStreakBonusTokens`) is credited.
 *
 * 2026-06-23: with `REEF_LAPS` now 2 (v4 big-ring track) this is 12 × 2 = 24
 * (was 36 at 3 laps). The shared literal was updated to 24 in lock-step — if
 * the two ever disagree the perfect-race bonus can never fire (it would need
 * more clean crosses than the race has checkpoints).
 */
export const TOTAL_CHECKPOINTS_PER_RACE =
  REEF_CHECKPOINT_COUNT * REEF_LAPS;

// ─── Phase 4 — ghost replay capture cadence ─────────────────────────────────

/**
 * Ghost replay sampling rate (Hz). Only the legacy ellipse sim records these
 * frames. At the 1300 wu/s base cap the body moves at most 260 wu between 5 Hz
 * samples, below the ellipse's 300 wu lane half-width; render interpolation
 * fills the visual gap.
 */
export const GHOST_CAPTURE_HZ = 5;

/**
 * Hard cap on captured frames per body per lap. 250 frames @ 5 Hz =
 * 50 sec — safely above a legitimate fastest lap. At cap the OLDEST
 * frame drops (FIFO) so the saved replay always represents the
 * trailing 50 sec of work.
 */
export const MAX_GHOST_FRAMES_PER_LAP = 250;

/**
 * Minimum legal lap time. Faster than this = discarded + flag. Backend
 * §4.5: tuned for the legacy ellipse. This is an ABSOLUTE tied to the speed
 * cap — it MUST be rescaled whenever REEF_MAX_SPEED changes or fast-but-legit
 * laps get discarded + flagged. 2026-07-15 (650 → 1300 cap): rescaled by the
 * 650/1300 speed ratio, 11_500 → 5_750, keeping the SAME teleport-detection
 * margin. At 1300 wu/s the ellipse theoretical base-cap lap is ~6.95s (perimeter
 * ~9036 wu); 5.75s stays below it at the same 0.83× ratio as before.
 * (Only the legacy ellipse sim reads this; the spline sim uses arc-derived
 * segment-time floors that scale with REEF_MAX_SPEED automatically.)
 */
export const MIN_LAP_MS = 5_750;

/**
 * Soft cap on round duration (ms). After this the round-end check
 * starts marking unfinished racers as DNF on the next tick. Plan §"Game
 * design — Reef Race" locks at 90s soft + 30s grace per straggler.
 *
 * This constant belongs only to the legacy ellipse sim. The v2 closed spline
 * uses its independent 300s-per-lap budget below; do not derive v2 timing from
 * this 90s legacy value.
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
 * CLOSED-LOOP per-lap soft budget (ms) for the v7 technical surf-road ribbon.
 *
 * The 90s `REEF_SOFT_TIMEOUT_MS` was tuned for the small ~9 000–30 000 wu
 * tracks; the v7 ribbon is ~95 741 wu. At the 1300
 * wu/s tuning one loop takes ~83–103 s (humans ~1,066 wu/s avg;
 * heavy-cornering bots ~858 wu/s → ~111.6 s). The slow-pace safety need is:
 *
 *   observed need = arc / slowPace × 1000 × safety
 *                 = 95741 / 858 × 1000 × 1.10 ≈ 123 s.
 *
 * The existing 300 s budget remains intentionally conservative for stalls,
 * collisions and disconnected stragglers, matching the 2026-07-13 speed-pass
 * policy of re-deriving the need without shortening the timeout.
 *
 * NOTE: NOT derived from `REEF_SOFT_TIMEOUT_MS` (which stays the ellipse single-
 * loop value) — it is its own arc-length-grounded number so the two sims can't
 * drift. Re-derive if the track arc length or REEF_MAX_SPEED changes.
 */
export const REEF_RACE_LOOP_LAP_BUDGET_MS = 300_000;

/**
 * CLOSED-LOOP N-lap race soft timeout (ms) — the per-lap budget × lap count.
 * On the current ~95 741 wu-per-lap ring, the 2-lap configuration yields a
 * 600s soft cap. This must cover the full race or racers DNF before finishing.
 * The spline sim uses these in `startRoom`; the ellipse sim keeps the unscaled
 * single-loop caps above.
 */
export const REEF_RACE_LOOP_SOFT_TIMEOUT_MS =
  REEF_RACE_LOOP_LAP_BUDGET_MS * REEF_RACE_LAPS;

/** CLOSED-LOOP N-lap hard timeout (ms) = soft + one straggler grace window. */
export const REEF_RACE_LOOP_HARD_TIMEOUT_MS =
  REEF_RACE_LOOP_SOFT_TIMEOUT_MS + REEF_STRAGGLER_GRACE_MS;

/**
 * Anti-cheat — repeated checkpoint-skip attempts inside this window
 * count as a single pattern. 3+ skips in 5s → flag. Per backend §4.5.
 */
export const REEF_SKIP_PATTERN_WINDOW_MS = 5_000;
export const REEF_SKIP_PATTERN_THRESHOLD = 3;

// ─── Physics caps (founder-tunable) ─────────────────────────────────────────

/**
 * Max body speed in wu/s. Founder playtest 2026-07-13 raised the base cap
 * 30% from 500 to 650. Founder playtest 2026-07-15 doubled it 650 → 1300
 * ("characters are still moving slow and it should be about double the speed");
 * the additive boost stack remains bounded at 1.85× (→ 2405 wu/s boosted cap).
 * Speed AND accel scale by the same 2× factor (REEF_MAX_ACCEL is derived), so
 * the 0.25s-to-cap impulse feel and every REEF_MAX_SPEED-relative threshold
 * (boost-pad kick, whirlpool, bot lookahead, carve
 * floor, segment-time floors) track the new cap automatically.
 */
export const REEF_MAX_SPEED = 1300;

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
 * Half-axes of the oval centerline (wu). Bumped 1.5× from (1100, 700) on
 * 2026-04-26 because the original sizing made the kart (40 wu glider × 50 wu
 * rider) feel cramped — only ~7.5 kart-widths across at 300 wu HALF_WIDTH * 2.
 * New perimeter ≈ 9036 wu. At REEF_MAX_SPEED 1300 wu/s the theoretical
 * base-cap lap is ~6.95s, above the scaled MIN_LAP_MS=5.75s detector floor.
 */
export const REEF_TRACK_A = 1650;
export const REEF_TRACK_B = 1050;

/**
 * Track lane half-width (wu). Total lane = 600 wu = 15 kart-widths.
 * Doubled from 150 so two karts can pass without scraping AND so the
 * inside/outside racing line choice is geometrically meaningful for the
 * Phase 2 apex-bonus / hazard-patch system.
 */
export const REEF_TRACK_HALF_WIDTH = 300;

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

/**
 * Pickup contact radius (wu). Combined with REEF_BODY_RADIUS=22 this gives a
 * 142wu center-to-center catch distance, matching the 60wu-wide box visual and
 * making visually adjacent arcade passes collect reliably.
 */
export const REEF_POWERUP_RADIUS = 120;

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
  | 'hazard-slow'       // Phase 2 — negative (-0.40)
  | 'rip-current'       // R18c — sustained seeded fast-water lane (+18–25%)
  | 'pad-boost'         // v2 mechanics — positive (boost pad, timed + decays)
  | 'trick-surge';      // R18b — positive (+25% after a clean trick landing)

// Drift spark tier thresholds (in sim ticks).
//   Tier 0->1: ~0.27s = 8 ticks   -> readable in ordinary corner entries
//   Tier 1->2: ~0.67s = 20 ticks  -> sustained turn
//   Tier 2->3: ~1.13s = 34 ticks  -> committed hairpin
export const DRIFT_SPARK_TICK_1 = 8;
export const DRIFT_SPARK_TICK_2 = 20;
export const DRIFT_SPARK_TICK_3 = 34;
export const DRIFT_SPARK_TIERS: readonly [number, number, number] = [
  DRIFT_SPARK_TICK_1,
  DRIFT_SPARK_TICK_2,
  DRIFT_SPARK_TICK_3,
];

/**
 * Drift boost duration after release. Time-extended speedMod, NOT a velocity
 * impulse (audit S4 fix — eliminates double-counting against the speed cap).
 */
export const DRIFT_BOOST_DURATION_MS = 1_600;

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
export const DRIFT_MIN_SPEED_FOR_CHARGE = REEF_MAX_SPEED * 0.20; // 260 wu/s @ cap 1300

/**
 * |dir.x| threshold — body must be cornering to initiate drift.
 * 0.12 ≈ 6.8° off straight. Single canonical name (the v1-draft
 * `DRIFT_MIN_ANGULAR_RATE` is intentionally NOT exported — one knob only).
 */
export const DRIFT_MIN_STEER = 0.12;

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
 * Phase 3 (audit C1) — bumped 2.0 → 2.1 to absorb the per-tick acceleration
 * step boosted by max(accelMult=1.25, 1/turnRadiusMult=1.176) = 1.25× during
 * corner entry. Math (§5 of `.claude/plans/reef-race-phase3-detailed.md`),
 * RECOMPUTED for the 2026-07-15 2× cap (REEF_MAX_SPEED=1300, REEF_MAX_ACCEL=5200):
 *   Worst-case body velocity at peak boost = 1.85× × 1300 = 2405 wu/s steady.
 *   Single-tick acceleration kick = REEF_MAX_ACCEL × dt × 1.25
 *                                = 5200 × 0.0333 × 1.25 = 216.7 wu/s
 *   Peak velocity for that tick = 2405 + 216.7 = 2621.7 wu/s
 *   Position step = dt × peak velocity = 0.0333 × 2621.7 = 87.4 wu
 *   Validator allowance = dt × REEF_MAX_SPEED × 2.1 = 0.0333 × 1300 × 2.1 = 91.0 wu
 *   Headroom = 3.6 wu (~4%) — no false flag. (Everything scaled linearly with
 *   the 2× cap, so the ~4% headroom RATIO is unchanged — 2.1 stays correct.)
 *
 * SAFETY (cheaters): velocity validator at the same 2.1 tolerance still
 * catches sustained over-velocity at REEF_MAX_SPEED × 2.1 = 2730 wu/s. The
 * extra 5% position headroom equates to ~10% extra speed (~130 wu/s) on a
 * single-tick basis — well below the 1.85× legitimate boost stack ceiling.
 *
 * Phase 1 audit C3 raised this 1.5 → 2.0; Phase 3 raises 2.0 → 2.1. The
 * velocity-validator no-op bug (validateReefVelocityDelta(prevV, prevV)) is
 * fixed in tandem (see reef-race-sim.ts:1213) so the cheat-detection backstop
 * actually fires on synthetic velocity jumps.
 */
export const REEF_KINEMATIC_TOLERANCE = 2.1;

// Reef actionBit assignments. Bit 0 is the single queued-item USE verb;
// bit 1 stays reserved on the wire and is deliberately ignored by both sims;
// bit 2 remains legacy drift in the ellipse sim but is JUMP in spline v2;
// bit 3 is launch; bit 4 is RESERVED — RETIRED (was drift 2026-07-18,
// removed 2026-07-19; never reuse for a different verb). Spline v2 ignores it.
// The inventory remains two slots: consuming slot 0 promotes slot 1 forward.
export const ACTION_BIT_POWERUP_0 = 0b0001;
export const ACTION_BIT_POWERUP_1 = 0b0010;
export const ACTION_BIT_DRIFT      = 0b00100;
export const ACTION_BIT_JUMP       = 0b00100;
export const ACTION_BIT_LAUNCH     = 0b01000;
export const ACTION_BIT_DRIFT_HOLD = 0b10000;

// ─── Phase 2 — combined kinematic cap + negatives floor ─────────────────────

/**
 * Phase 2 — soft cap on the SUM of POSITIVE kinematic mults applied in
 * applyIntentForTick step 4. Bounds drift + launch + slipstream + ribbon +
 * apex-bonus stacking so the sum never crosses REEF_KINEMATIC_TOLERANCE (2.1×).
 *
 *   Max possible additive positive stack:
 *     drift-3 (0.38) + launch (0.30) + slipstream (0.20) + ribbon (0.30)
 *     + apex-bonus (0.05) = 1.23 → 1 + 1.23 = 2.23×
 *
 *   Cap at 0.85 → 1 + 0.85 = 1.85× = same backstop as the existing hard cap
 *   in integrateMotion. Anti-cheat tolerance (2.1×) buffers above this by
 *   0.25×, leaving room for one tick of integration overshoot.
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
 * Mario Kart rubber band — leaders exclude the forward-only seeker but still
 * receive five useful kinds; trailers get aggressive items more often.
 * Mid-pack rolls a broad neutral distribution.
 *
 * Weights are RELATIVE within each placement bucket (don't need to sum to 100).
 * The roll is sum-then-LCG-mod-then-walk, identical to existing rollPowerUpKind.
 */
export const PLACEMENT_ITEM_TABLE: Record<
  number,
  ReadonlyArray<{ kind: ReefPowerUpKind; weight: number }>
> = {
  // 1st place — no forward-only seeker; five useful leader items
  1: [
    { kind: 'rr-bubble-shield', weight: 28 },
    { kind: 'rr-ink-slick',     weight: 22 },
    { kind: 'rr-turbo-bubble',  weight: 20 },
    { kind: 'rr-tide-wave',     weight: 16 },
    { kind: 'rr-whirlpool',     weight: 14 },
  ],
  // 2nd–3rd — defensive-leaning
  2: [
    { kind: 'rr-turbo-bubble',  weight: 24 },
    { kind: 'rr-bubble-shield', weight: 18 },
    { kind: 'rr-ink-slick',     weight: 16 },
    { kind: 'rr-tide-wave',     weight: 16 },
    { kind: 'rr-seeker-jelly',  weight: 14 },
    { kind: 'rr-whirlpool',     weight: 12 },
  ],
  3: [
    { kind: 'rr-turbo-bubble',  weight: 24 },
    { kind: 'rr-bubble-shield', weight: 18 },
    { kind: 'rr-ink-slick',     weight: 16 },
    { kind: 'rr-tide-wave',     weight: 16 },
    { kind: 'rr-seeker-jelly',  weight: 14 },
    { kind: 'rr-whirlpool',     weight: 12 },
  ],
  // 4th–5th — neutral (matches REEF_POWERUP_DEFS distribution)
  4: [
    { kind: 'rr-turbo-bubble',  weight: 35 },
    { kind: 'rr-bubble-shield', weight:  8 },
    { kind: 'rr-ink-slick',     weight:  7 },
    { kind: 'rr-seeker-jelly',  weight:  7 },
    { kind: 'rr-tide-wave',     weight:  6 },
    { kind: 'rr-whirlpool',     weight:  7 },
  ],
  5: [
    { kind: 'rr-turbo-bubble',  weight: 35 },
    { kind: 'rr-bubble-shield', weight:  8 },
    { kind: 'rr-ink-slick',     weight:  7 },
    { kind: 'rr-seeker-jelly',  weight:  7 },
    { kind: 'rr-tide-wave',     weight:  6 },
    { kind: 'rr-whirlpool',     weight:  7 },
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
  // 8th — aggressive catch-up mix with five distinct kinds
  8: [
    { kind: 'rr-whirlpool',    weight: 30 },
    { kind: 'rr-seeker-jelly', weight: 26 },
    { kind: 'rr-tide-wave',    weight: 22 },
    { kind: 'rr-turbo-bubble', weight: 14 },
    { kind: 'rr-ink-slick',    weight:  8 },
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

// ─── Phase 3 — stat-driven body multipliers ─────────────────────────────────
//
// Avatar `level` (1-50) + `archetype` (14 IDs → 4 racing classes) become per-body
// multipliers stamped on each ReefBody at startRoom. Top-speed cap unchanged
// — these only affect handling (acceleration recovery, turning, slipstream
// grace, drift charge rate, knockback resistance, powerup duration, ribbon
// detect width). All multipliers default to 1.0 (or BASELINE_*) so a level-1
// neutral avatar behaves bit-identically to today.
//
// Spec: `.claude/plans/reef-race-phase3-detailed.md` §1, §4.

/**
 * Level → acceleration recovery multiplier.
 *   per-level mult = 1 + LEVEL_ACCEL_MULT_PER_LEVEL × (level - 1), CLAMPED.
 *   level=1   → 1.000 (today's behavior)
 *   level=25  → 1.120 (bot default)
 *   level=50  → 1.245
 *   level=51+ → 1.250 (clamped at ceiling)
 *
 * N3 fix: name the ceiling for what it is (a clamp), not the value at any
 * specific level — the formula reaches 1.245 at level 50, not 1.25.
 */
export const LEVEL_ACCEL_MULT_CEILING = 1.25;
export const LEVEL_ACCEL_MULT_PER_LEVEL = 0.005;

/** Agility — tighter turning (lower = tighter; 0.85 = 15% tighter). */
export const AGILITY_TURN_RADIUS_MULT = 0.85;
/**
 * Agility — extended slipstream post-leave grace window. 24 ticks @ 30 Hz =
 * 800 ms vs the 6-tick (200 ms) baseline. Audit C3 fix: agility extends
 * GRACE (post-leave window, a buff), not REQUIRED (hold-to-arm time, would
 * be a nerf). REQUIRED stays at 45 for everyone.
 */
export const AGILITY_SLIPSTREAM_GRACE_TICKS = 24;

/** Strength — drift sparks charge 40% faster (thresholds divided). */
export const STRENGTH_DRIFT_CHARGE_MULT = 1.4;
/** Strength — receives 60% of normal knockback (40% reduction). */
export const STRENGTH_KNOCKBACK_RESIST_MULT = 0.6;

/** Intelligence — pickups last 20% longer (effectMs scaled). */
export const INTELLIGENCE_POWERUP_DURATION_MULT = 1.2;
/** Intelligence — ribbon detection band is 30% wider. */
export const INTELLIGENCE_RIBBON_DETECT_MULT = 1.3;

/**
 * Baseline slipstream post-leave grace window (ticks). Aliased here for
 * clarity in the multiplier builder; identical numeric value to
 * `SLIPSTREAM_GRACE_TICKS = 6`. Used as the default for non-agility classes.
 */
export const BASELINE_SLIPSTREAM_GRACE_TICKS = SLIPSTREAM_GRACE_TICKS;

/**
 * Hard clamp ranges so a malformed avatar (level 999, NaN mult) cannot break
 * the sim. Applied at multiplier-construction time, NOT inside the hot loop.
 */
export const PHASE3_MULT_CLAMP_ACCEL                  = [1.0, 1.25] as const;
export const PHASE3_MULT_CLAMP_TURN_RADIUS            = [0.70, 1.00] as const;
export const PHASE3_MULT_CLAMP_SLIPSTREAM_GRACE_TICKS = [6, 30] as const;
export const PHASE3_MULT_CLAMP_DRIFT_CHARGE           = [1.00, 1.50] as const;
export const PHASE3_MULT_CLAMP_KNOCKBACK_RES          = [0.50, 1.00] as const;
export const PHASE3_MULT_CLAMP_POWERUP_DUR            = [1.00, 1.50] as const;
export const PHASE3_MULT_CLAMP_RIBBON_DETECT          = [1.00, 1.50] as const;

/**
 * 4-bucket racing class derived from the 14-archetype string column. Pure
 * function — no DB schema change. Audit verdict (a) AGREE: bucketing is
 * defensible (mobility/scout → agility; combative/protective → strength;
 * cerebral/analytical → intelligence; social/companion → balanced).
 */
export type RacingClass = 'agility' | 'strength' | 'intelligence' | 'balanced';

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

export function racingClassFromArchetype(
  archetype: string | null | undefined,
): RacingClass {
  if (!archetype) return 'balanced';
  return ARCHETYPE_RACING_CLASS_MAP[archetype] ?? 'balanced';
}

/**
 * Per-avatar racing profile. Constructed by `avatar-profile-loader.ts` from
 * `avatars.level + avatars.archetype` for human/agent participants; bots short-
 * circuit to `isBot:true` and the builder returns a neutral clone.
 */
export interface AvatarRacingProfile {
  avatarId: string;
  level: number;
  archetype: string | null;
  isBot: boolean;
}

/**
 * Per-body multiplier struct, stamped on each `ReefBody` at startRoom by
 * `buildBodyMultipliers(profile)`. Read-only after init. Hot loop reads:
 *   - applyIntentForTick (accel + turn radius)
 *   - resolveSlipstream  (slipstreamGraceTicks)
 *   - tickDriftState     (driftSparkTicks pre-computed from driftChargeMult)
 *   - applyTideWave + applySeekerJelly (knockbackResistMult)
 *   - tryUsePowerUp      (powerUpDurationMult)
 *   - resolveBoostRibbons (ribbonDetectMult)
 */
export interface BodyMultipliers {
  accelMult: number;
  turnRadiusMult: number;
  slipstreamGraceTicks: number;
  driftChargeMult: number;
  knockbackResistMult: number;
  powerUpDurationMult: number;
  ribbonDetectMult: number;
}

/**
 * `as const` so the global is immutable. Callers MUST clone via
 * `{ ...NEUTRAL_BODY_MULTIPLIERS }` before assigning to `body.mults` so a
 * future debug helper / refactor cannot poison the neutral baseline (audit N4).
 */
export const NEUTRAL_BODY_MULTIPLIERS = {
  accelMult: 1.0,
  turnRadiusMult: 1.0,
  slipstreamGraceTicks: BASELINE_SLIPSTREAM_GRACE_TICKS,
  driftChargeMult: 1.0,
  knockbackResistMult: 1.0,
  powerUpDurationMult: 1.0,
  ribbonDetectMult: 1.0,
} as const satisfies BodyMultipliers;

function clampPhase3(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Build per-body multipliers from a `AvatarRacingProfile`. Bots, null profiles,
 * and missing/unknown archetypes all fall back to a CLONE of
 * `NEUTRAL_BODY_MULTIPLIERS` (audit N4 — never the global reference).
 *
 * Bots are ALWAYS neutral (Phase 3 §6) — even if their DB row has an
 * archetype, the profile loader sets `isBot:true` and we short-circuit.
 */
export function buildBodyMultipliers(
  profile: AvatarRacingProfile | null | undefined,
): BodyMultipliers {
  if (!profile)      return { ...NEUTRAL_BODY_MULTIPLIERS };
  if (profile.isBot) return { ...NEUTRAL_BODY_MULTIPLIERS };

  const safeLevel = Number.isFinite(profile.level) ? profile.level : 1;
  const accelRaw  = 1 + LEVEL_ACCEL_MULT_PER_LEVEL * Math.max(0, safeLevel - 1);
  const accelMult = clampPhase3(
    accelRaw,
    PHASE3_MULT_CLAMP_ACCEL[0],
    PHASE3_MULT_CLAMP_ACCEL[1],
  );

  const cls = racingClassFromArchetype(profile.archetype);

  // Agility extends GRACE (post-leave window, buff). REQUIRED stays at 45
  // for everyone (audit C3).
  const slipstreamGraceTicks = clampPhase3(
    cls === 'agility'
      ? AGILITY_SLIPSTREAM_GRACE_TICKS
      : BASELINE_SLIPSTREAM_GRACE_TICKS,
    PHASE3_MULT_CLAMP_SLIPSTREAM_GRACE_TICKS[0],
    PHASE3_MULT_CLAMP_SLIPSTREAM_GRACE_TICKS[1],
  );

  return {
    accelMult,
    turnRadiusMult: clampPhase3(
      cls === 'agility' ? AGILITY_TURN_RADIUS_MULT : 1.0,
      PHASE3_MULT_CLAMP_TURN_RADIUS[0],
      PHASE3_MULT_CLAMP_TURN_RADIUS[1],
    ),
    slipstreamGraceTicks,
    driftChargeMult: clampPhase3(
      cls === 'strength' ? STRENGTH_DRIFT_CHARGE_MULT : 1.0,
      PHASE3_MULT_CLAMP_DRIFT_CHARGE[0],
      PHASE3_MULT_CLAMP_DRIFT_CHARGE[1],
    ),
    knockbackResistMult: clampPhase3(
      cls === 'strength' ? STRENGTH_KNOCKBACK_RESIST_MULT : 1.0,
      PHASE3_MULT_CLAMP_KNOCKBACK_RES[0],
      PHASE3_MULT_CLAMP_KNOCKBACK_RES[1],
    ),
    powerUpDurationMult: clampPhase3(
      cls === 'intelligence' ? INTELLIGENCE_POWERUP_DURATION_MULT : 1.0,
      PHASE3_MULT_CLAMP_POWERUP_DUR[0],
      PHASE3_MULT_CLAMP_POWERUP_DUR[1],
    ),
    ribbonDetectMult: clampPhase3(
      cls === 'intelligence' ? INTELLIGENCE_RIBBON_DETECT_MULT : 1.0,
      PHASE3_MULT_CLAMP_RIBBON_DETECT[0],
      PHASE3_MULT_CLAMP_RIBBON_DETECT[1],
    ),
  };
}

// ─── Reef Race v2 — spline sim constants (NOT consumed by ellipse sim) ───
//
// Defined here (not in a separate config) so all reef-race tunables stay in
// one searchable file. The live ellipse sim must never read these — the
// spline sim is the only consumer. Migration is gated by
// `REEF_RACE_USE_SPLINE` (bottom of this block).
//
// Spec: `.claude/plans/reef-race-v2.md` "Jump Mechanic — NEW".
// Architecture: `.claude/plans/reef-race-v2-spline-architecture.md` §4 + §8.

/**
 * Manual jump impulse (player presses Space or Shift). With REEF_GRAVITY,
 * continuous peak is 720²/(2×1200) =216wu; the live semi-implicit 30Hz
 * integrator measures ≈204wu with ≈1.17s of airborne samples.
 */
export const REEF_JUMP_IMPULSE_MANUAL = 720;

/**
 * Ramp jump impulse (server-injected on ramp AABB entry, regardless of input).
 * Clearly larger than manual: the live 30Hz integrator measures ≈337wu peak
 * from a 920wu/s impulse, with ~1.5s of airborne samples.
 */
export const REEF_JUMP_IMPULSE_RAMP = 920;

/**
 * Gravity for v2 vertical axis. Pulls vyAxis down each tick:
 *   vyAxis -= REEF_GRAVITY * dt
 *   heightOffset = max(0, heightOffset + vyAxis * dt)
 */
export const REEF_GRAVITY = 1200; // wu/s²

/**
 * Steering authority multiplier while airborne (heightOffset > 0).
 * Player can mid-air correct but cannot snap-turn. 30% per locked spec.
 *
 * v2 surf model (2026-06-01): this now scales the HEADING TURN RATE only —
 * it no longer multiplies forward speed (a jump used to slow the kart down).
 * Forward momentum is preserved/coasts through the air.
 */
export const REEF_AIRBORNE_STEER_MULT = 0.30;

/** R18b clean trick-landing surge: additive +25% for 1.2 seconds. */
export const REEF_TRICK_SURGE_MULT = 0.25;
export const REEF_TRICK_SURGE_DURATION_MS = 1_200;
/** A nearly-stopped landing cannot mint a surge. */
export const REEF_TRICK_MIN_LANDING_SPEED = REEF_MAX_SPEED * 0.15;
/** Signed desired-heading delta required to count as a left/right press. */
export const REEF_TRICK_STEER_DEADZONE_RAD = 0.035;

// ─── Reef Race v2 — surf-carving kinematics (2026-06-01) ────────────────────
//
// Replaces the old direct-velocity-steering + global REEF_DRAG=0.97 model with
// a heading-rate + lateral-grip + carried-momentum model. The per-tick math
// lives in the PURE shared function `integrateSurfStep`
// (`@clawville/shared/reef-race/surf-physics`) so the web client can mirror it
// for prediction. These constants are the canonical tunables fed into it.
//
// TARGET FEEL: hold to accelerate, speed CARRIES; ease off = COAST (not dead
// stop). A/D leans → heading turns at a bounded rate, the board ARCS. Forward
// (along-heading) velocity is well-preserved; the perpendicular component
// bleeds off over time (carve + controlled slide).

/**
 * Base heading turn rate (rad/s) at low speed, grounded. 2.6 rad/s ≈ 149°/s →
 * a full 180° about-face takes ~1.2s at low speed, and arcs are even wider at
 * speed (see REEF_TURN_SPEED_FALLOFF). Tuned so a tight river (halfWidth
 * ~290-540 wu, slalom ±440-460) is threadable without snap-turning.
 *
 * Anti-cheat check: per-tick velocity-vector change from a hard turn at top
 * speed ≈ speed * turnRate * dt = 1300 * 2.6 * (1/30) ≈ 112.7 wu/s, far under the
 * velocity-delta ceiling MAX_ACCEL*dt*REEF_KINEMATIC_TOLERANCE = 5200*(1/30)*2.1
 * ≈ 364 wu/s. (turnRate is a RATE, not a speed — it does NOT scale with the 2×
 * cap; both the turn-induced delta and the ceiling doubled, so the margin holds.)
 */
export const REEF_TURN_RATE = 2.6;

/**
 * Fraction by which the turn rate is reduced at full speed (0..1).
 *   effectiveTurnRate = REEF_TURN_RATE * (1 - REEF_TURN_SPEED_FALLOFF * speedFrac)
 * At full speed the kart still turns at (1 - 0.45) = 55% of base rate → wide,
 * committed racing arcs; at a near-stop it pivots at full rate.
 */
export const REEF_TURN_SPEED_FALLOFF = 0.45;

/**
 * Per-tick survival fraction of the ALONG-heading velocity. Mild (close to 1)
 * so releasing thrust COASTS instead of stopping. 0.992^30 ≈ 0.79 → loses
 * ~21% of forward speed per second of coasting — a long, surfy glide.
 *
 * Anti-cheat: forward drag pulls steady-state cruise slightly BELOW the thrust
 * target (target = MAX_SPEED*thrust*speedMod), so effective XZ speed stays
 * capped near MAX_SPEED*speedMod — never above it.
 */
export const REEF_FORWARD_DRAG = 0.992;

/**
 * Per-tick survival fraction of the PERPENDICULAR (sideways) velocity. < 1 →
 * grip. 0.90^30 ≈ 0.042 → ~96% of any sideways slide is killed per second:
 * the board carves and holds a line but can still drift through a hard flick.
 *
 * Lower = grippier (less slide). Kept at 0.90 (not 0.80) to leave anti-cheat
 * headroom — a single tick of lateral bleed at top speed is ≤ 0.10*1300 = 130
 * wu/s, which combined with a hard turn (~112.7 wu/s) stays under the ~364 wu/s
 * velocity-delta ceiling (both the bleed and the ceiling doubled with the 2× cap).
 */
export const REEF_LATERAL_GRIP = 0.90;

/**
 * Migration gate (per architecture doc section 8). When true, the spline
 * sim handles reef-race rooms instead of the ellipse sim. Defaults false
 * so production is unaffected until explicitly opted in via env.
 */
export const REEF_RACE_USE_SPLINE = process.env.REEF_RACE_USE_SPLINE === 'true';

// ─── Ramp trigger volumes (SPEC 3) ───────────────────────────────────────────

export interface SplineRampPatch {
  id: string;
  /** Progress fraction along spline (0..1). */
  t: number;
  /** Lateral offset from centerline (wu, positive = river-right). */
  lateralOffset: number;
  /** Half-length along spline tangent (wu). */
  halfLength: number;
  /** Half-width perpendicular to tangent (wu). */
  halfWidth: number;
  /** Launch impulse (wu/s). Always REEF_JUMP_IMPULSE_RAMP for this spec. */
  launchImpulse: number;
  /** Cooldown after trigger before same body can re-trigger (ms). */
  cooldownMs: number;
}

/** Trigger cooldown between ramp re-fires for the same body (ms). */
export const RAMP_COOLDOWN_MS = 500;

/** AABB half-length of ramp trigger volume along tangent (wu). */
export const RAMP_HALF_LENGTH = 150;

/** AABB half-width of ramp trigger volume perpendicular to tangent (wu). */
export const RAMP_HALF_WIDTH = 200;

/**
 * Ramp placements — 6 ramps, one per themed segment transition or midpoint.
 * t-values chosen so ramps land on visible straightish sections, never on
 * tight slalom S-bends. All centered on centerline (lateralOffset = 0)
 * for maximum chance of natural contact during any racing line.
 *
 * Segment reference (from track-layout.ts):
 *   Lagoon:    t ~ 0.00 – 0.16
 *   Kelp:      t ~ 0.16 – 0.40
 *   Shipwreck: t ~ 0.40 – 0.65
 *   Canyon:    t ~ 0.65 – 0.89
 *   Finish:    t ~ 0.89 – 1.00
 */
export function buildSplineRamps(): SplineRampPatch[] {
  return [
    { id: 'ramp-lagoon',     t: 0.070, lateralOffset: 0, halfLength: RAMP_HALF_LENGTH, halfWidth: RAMP_HALF_WIDTH, launchImpulse: REEF_JUMP_IMPULSE_RAMP, cooldownMs: RAMP_COOLDOWN_MS },
    { id: 'ramp-kelp-1',    t: 0.135, lateralOffset: 0, halfLength: RAMP_HALF_LENGTH, halfWidth: RAMP_HALF_WIDTH, launchImpulse: REEF_JUMP_IMPULSE_RAMP, cooldownMs: RAMP_COOLDOWN_MS },
    { id: 'ramp-kelp-2',    t: 0.360, lateralOffset: 0, halfLength: RAMP_HALF_LENGTH, halfWidth: RAMP_HALF_WIDTH, launchImpulse: REEF_JUMP_IMPULSE_RAMP, cooldownMs: RAMP_COOLDOWN_MS },
    { id: 'ramp-shipwreck', t: 0.450, lateralOffset: 0, halfLength: RAMP_HALF_LENGTH, halfWidth: RAMP_HALF_WIDTH, launchImpulse: REEF_JUMP_IMPULSE_RAMP, cooldownMs: RAMP_COOLDOWN_MS },
    { id: 'ramp-canyon-1',  t: 0.775, lateralOffset: 0, halfLength: RAMP_HALF_LENGTH, halfWidth: RAMP_HALF_WIDTH, launchImpulse: REEF_JUMP_IMPULSE_RAMP, cooldownMs: RAMP_COOLDOWN_MS },
    { id: 'ramp-canyon-2',  t: 0.900, lateralOffset: 0, halfLength: RAMP_HALF_LENGTH, halfWidth: RAMP_HALF_WIDTH, launchImpulse: REEF_JUMP_IMPULSE_RAMP, cooldownMs: RAMP_COOLDOWN_MS },
  ];
}

// ─── Boost pads (net-new v2 mechanic — spline-placed) ────────────────────────
//
// Mario-Kart floor boost strips. On entry the sim adds a capped along-heading
// velocity KICK plus a short timed `pad-boost` speedMod that DECAYS (not
// permanent). Both are anti-cheat safe: the kick is clamped to the boost hard
// cap and applied in a post-integrate tick pass (never measured by the per-tick
// velocity-delta validator), and the timed mult folds into the SAME positive
// kinetic stack (bounded by KINEMATIC_BOOST_CAP) + the 1.85× hard speed cap, so
// pads cannot be chained into infinite speed. Fires for bots too (position-based).

export interface SplineBoostPad {
  id: string;
  /** Progress fraction along spline (0..1). */
  t: number;
  /** Lateral offset from centerline (wu, positive = river-right). */
  lateralOffset: number;
  /** Half-length along spline tangent (wu). */
  halfLength: number;
  /** Half-width perpendicular to tangent (wu). */
  halfWidth: number;
}

/** AABB half-length of a boost-pad trigger volume along tangent (wu). */
export const BOOST_PAD_HALF_LENGTH = 220;
/** AABB half-width of a boost-pad trigger volume perpendicular to tangent (wu). */
export const BOOST_PAD_HALF_WIDTH = 170;
/**
 * Instant along-heading velocity kick (wu/s) added on pad entry. Applied in the
 * post-integrate `resolveBoostPads` pass and CLAMPED to the 1.85× hard cap
 * (REEF_MAX_SPEED * 1.85 = 2405 wu/s), so it can never exceed the boost ceiling.
 * 32% of MAX_SPEED — a noticeable pad "pop" without a teleport.
 */
export const BOOST_PAD_KICK = REEF_MAX_SPEED * REEF_BOOST_PAD_KICK_RATIO; // 416 wu/s @ cap 1300
/**
 * Additive speedMod contribution while `pad-boost` is active (folds into the
 * positive kinetic stack, capped by KINEMATIC_BOOST_CAP). +0.45 raises target
 * cruise to 1.45× for the duration, then decays when the timer expires.
 */
export const BOOST_PAD_BOOST_MULT = 0.45;
/** How long the timed `pad-boost` speedMod lasts before it decays (ms). */
export const BOOST_PAD_DURATION_MS = 2_200;

/**
 * Eight pads spread around the lap on the natural racing line. Small alternating
 * offsets keep visual variety while the 220wu along-window and 170wu half-width
 * make them reliably reachable at full race speed. All extents use constants.
 */
export function buildSplineBoostPads(): SplineBoostPad[] {
  return [
    { id: 'pad-lagoon',       t: 0.055, lateralOffset:   0, halfLength: BOOST_PAD_HALF_LENGTH, halfWidth: BOOST_PAD_HALF_WIDTH },
    { id: 'pad-kelp-entry',   t: 0.165, lateralOffset:  45, halfLength: BOOST_PAD_HALF_LENGTH, halfWidth: BOOST_PAD_HALF_WIDTH },
    { id: 'pad-kelp-exit',    t: 0.285, lateralOffset: -45, halfLength: BOOST_PAD_HALF_LENGTH, halfWidth: BOOST_PAD_HALF_WIDTH },
    { id: 'pad-wreck-entry',  t: 0.405, lateralOffset:   0, halfLength: BOOST_PAD_HALF_LENGTH, halfWidth: BOOST_PAD_HALF_WIDTH },
    { id: 'pad-wreck-core',   t: 0.535, lateralOffset:  45, halfLength: BOOST_PAD_HALF_LENGTH, halfWidth: BOOST_PAD_HALF_WIDTH },
    { id: 'pad-wreck-exit',   t: 0.655, lateralOffset: -45, halfLength: BOOST_PAD_HALF_LENGTH, halfWidth: BOOST_PAD_HALF_WIDTH },
    { id: 'pad-canyon',       t: 0.785, lateralOffset:   0, halfLength: BOOST_PAD_HALF_LENGTH, halfWidth: BOOST_PAD_HALF_WIDTH },
    { id: 'pad-home-stretch', t: 0.915, lateralOffset:  35, halfLength: BOOST_PAD_HALF_LENGTH, halfWidth: BOOST_PAD_HALF_WIDTH },
  ];
}

// ─── Ink-slick (rival slow) + whirlpool (rival knock) tunables ───────────────

/** Radius (wu) within which a dropped ink-slick catches rivals BEHIND the user. */
export const INK_SLICK_RADIUS = 260;
/** Radius (wu) of the whirlpool rival-knock AoE. */
export const WHIRLPOOL_RADIUS = 300;
/** Peak inward pull speed (wu/s) applied to a rival at the whirlpool center. */
export const WHIRLPOOL_PULL_IMPULSE = REEF_MAX_SPEED * 0.5; // 650 wu/s @ cap 1300
/**
 * Additive negative speedMod a whirlpool inflicts on a caught rival (folds into
 * the negative kinetic stack, floored by NEGATIVE_KINETIC_FLOOR).
 */
export const WHIRLPOOL_SLOW_MULT = -0.35;
