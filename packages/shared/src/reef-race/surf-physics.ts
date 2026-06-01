/**
 * reef-race/surf-physics.ts
 *
 * PURE per-tick surf-carving integrate step for Reef Race v2.
 *
 * This is the single source of truth for the kart kinematics model. The
 * server sim (`apps/api/src/services/activity/sim/reef-race-spline-sim.ts`)
 * calls `integrateSurfStep` once per body per tick; the web client can import
 * the SAME function later for client-side prediction (the surf model is fully
 * deterministic given (prevState, input, params, dt) — no RNG, no clock read).
 *
 * ─── Model (surf-carving with momentum) ─────────────────────────────────────
 *
 * Replaces the old "steer velocity directly toward dir*MAX_SPEED then apply a
 * global drag of 0.97" model (which snapped facing to input, had no carried
 * momentum, and decelerated to a dead stop on thrust release).
 *
 * Per tick, in order:
 *
 *   1. HEADING RATE — heading (`rot`) turns toward the input direction at a
 *      bounded angular rate (rad/s), NOT a snap. The rate scales down slightly
 *      as speed rises (fast = wider arcs) and is reduced while airborne
 *      (steering authority only — never forward speed). With no input dir the
 *      heading holds (the kart coasts straight).
 *
 *   2. FORWARD THRUST ALONG HEADING — thrust accelerates the velocity component
 *      that lies ALONG the current heading toward `MAX_SPEED * thrust *
 *      speedMod`, clamped per tick by `MAX_ACCEL * dt * accelMult`. We only
 *      ACCELERATE forward here; releasing thrust does NOT yank the target to
 *      zero — coasting is handled by the mild forward drag in step 4.
 *
 *   3. LATERAL GRIP — velocity is split (in the post-turn heading frame) into
 *      an along-heading component and a perpendicular component. The
 *      perpendicular component is bled off by `lateralGrip` each tick (carve +
 *      controlled slide). The along component is preserved.
 *
 *   4. DIRECTIONAL DRAG — the along component decays by `forwardDrag` (mild, so
 *      releasing thrust coasts rather than stopping). The perpendicular bleed
 *      from step 3 replaces the old harsh global 0.97 drag.
 *
 *   5. RECOMPOSE + INTEGRATE POSITION — velocity is recomposed from the two
 *      components and position advances by `v * dt`.
 *
 * ─── Why this is anti-cheat safe ────────────────────────────────────────────
 *
 * Carving NEVER raises speed above the thrust+boost cap — it only redirects
 * existing momentum. Effective XZ speed still tops out near
 * `MAX_SPEED * speedMod` (≤ MAX_SPEED * 1.85 with the boost stack). The
 * per-tick velocity-vector change from a hard turn at top speed is
 * `2*speed*sin(turnRate*dt/2)` ≈ speed*turnRate*dt; at speed=500,
 * turnRate≈2.6 rad/s, dt=1/30 that's ≈ 43 wu/s, far under the velocity-delta
 * validator ceiling of `MAX_ACCEL*dt*REEF_KINEMATIC_TOLERANCE` ≈ 140 wu/s.
 * (Worst-case combined with one tick of lateral bleed stays under that ceiling
 * — see the anti-cheat test in the sim test suite.)
 *
 * @module reef-race/surf-physics
 */

/** Minimal kinematic state the integrate step reads + writes. Pure data. */
export interface SurfBodyState {
  /** Flat-plane X (wu). */
  x: number;
  /** Flat-plane Z (wu). */
  z: number;
  /** Flat-plane velocity X (wu/s). */
  vx: number;
  /** Flat-plane velocity Z (wu/s). */
  vz: number;
  /** Heading: Three.js Y-rotation = atan2(headingX, headingZ) (rad). */
  rot: number;
}

/** Per-tick input intent. Mirrors the WS input protocol (dir + thrust). */
export interface SurfInput {
  /**
   * Normalised steer direction in XZ ({x,z}) or null (no steering input).
   * Need NOT be exactly unit length — only its angle is used.
   */
  dir: { x: number; z: number } | null;
  /** Thrust 0..1 (clamped by caller). */
  thrust: number;
  /** True while the kart is airborne (reduces turn rate only). */
  airborne: boolean;
}

/** Tunable params — passed in so the sim owns the canonical constant values. */
export interface SurfParams {
  /** Top forward speed (wu/s). REEF_MAX_SPEED. */
  maxSpeed: number;
  /** Max forward acceleration (wu/s²). REEF_MAX_ACCEL. */
  maxAccel: number;
  /** Base heading turn rate (rad/s) at low speed, grounded. REEF_TURN_RATE. */
  turnRate: number;
  /**
   * Fraction (0..1) by which the turn rate is reduced at full speed.
   * effectiveTurnRate = turnRate * (1 - turnSpeedFalloff * speedFrac).
   * REEF_TURN_SPEED_FALLOFF.
   */
  turnSpeedFalloff: number;
  /** Multiplier on turn rate while airborne (≤1). REEF_AIRBORNE_STEER_MULT. */
  airborneSteerMult: number;
  /**
   * Per-tick survival fraction of the ALONG-heading velocity (mild, ~0.99 so
   * thrust release coasts). REEF_FORWARD_DRAG.
   */
  forwardDrag: number;
  /**
   * Per-tick survival fraction of the PERPENDICULAR velocity component
   * (< 1 → carve/grip; lower = grippier). REEF_LATERAL_GRIP.
   */
  lateralGrip: number;
  /** Speed multiplier from boosts/effects (1.0 neutral). */
  speedMod: number;
  /** Acceleration multiplier (Phase 3 stat; 1.0 neutral). */
  accelMult: number;
}

/**
 * Turn `current` heading (rad) toward `target` (rad) by at most `maxDelta`
 * (rad), taking the shortest signed arc. Pure.
 */
export function turnToward(
  current: number,
  target: number,
  maxDelta: number,
): number {
  // Shortest signed angular difference in (-π, π].
  let diff = target - current;
  // Normalise to (-π, π].
  diff = Math.atan2(Math.sin(diff), Math.cos(diff));
  if (diff > maxDelta) diff = maxDelta;
  else if (diff < -maxDelta) diff = -maxDelta;
  return current + diff;
}

/**
 * Pure surf-carving integrate step. Returns a NEW state object — never mutates
 * the input. The caller owns wall-clamp, collisions, vertical axis, and the
 * anti-cheat validators; this function only models the heading-rate +
 * lateral-grip + momentum kinematics on the flat XZ plane.
 *
 * Determinism: depends ONLY on (prev, input, params, dt). No RNG, no clock.
 */
export function integrateSurfStep(
  prev: SurfBodyState,
  input: SurfInput,
  params: SurfParams,
  dt: number,
): SurfBodyState {
  const {
    maxSpeed,
    maxAccel,
    turnRate,
    turnSpeedFalloff,
    airborneSteerMult,
    forwardDrag,
    lateralGrip,
    speedMod,
    accelMult,
  } = params;

  // ── 1. Heading rate ────────────────────────────────────────────────────────
  let rot = prev.rot;
  const speed = Math.hypot(prev.vx, prev.vz);
  const speedFrac = maxSpeed > 0 ? Math.min(1, speed / maxSpeed) : 0;
  const steerMult = input.airborne ? airborneSteerMult : 1;
  const effectiveTurnRate =
    turnRate * (1 - turnSpeedFalloff * speedFrac) * steerMult;
  const maxTurnThisTick = Math.max(0, effectiveTurnRate * dt);

  if (input.dir && (input.dir.x !== 0 || input.dir.z !== 0)) {
    const desiredHeading = Math.atan2(input.dir.x, input.dir.z);
    rot = turnToward(rot, desiredHeading, maxTurnThisTick);
  }
  // No dir → heading holds (coast straight).

  // ── Heading basis vectors (post-turn) ───────────────────────────────────────
  // fwd = (sin rot, cos rot); perpDir = 90° from fwd = (cos rot, -sin rot).
  const fwdX = Math.sin(rot);
  const fwdZ = Math.cos(rot);
  const perpX = Math.cos(rot);
  const perpZ = -Math.sin(rot);

  // Decompose CURRENT velocity into the post-turn heading frame.
  let vAlong = prev.vx * fwdX + prev.vz * fwdZ;
  let vPerp = prev.vx * perpX + prev.vz * perpZ;

  // ── 2. Forward thrust along heading (accelerate only) ──────────────────────
  const thrust = Math.max(0, Math.min(1, input.thrust));
  const targetForwardSpeed = maxSpeed * thrust * speedMod;
  const dAlong = targetForwardSpeed - vAlong;
  if (dAlong > 0) {
    const maxStep = maxAccel * dt * accelMult;
    vAlong += Math.min(dAlong, maxStep);
  }
  // Note: when releasing thrust (target < vAlong) we do NOT brake to target —
  // coasting is the forwardDrag below. This is what makes "ease off = coast".

  // ── 4. Directional drag (mild forward) + 3. lateral grip ───────────────────
  vAlong *= forwardDrag;
  vPerp *= lateralGrip;

  // ── 5. Recompose velocity + integrate position ──────────────────────────────
  const vx = vAlong * fwdX + vPerp * perpX;
  const vz = vAlong * fwdZ + vPerp * perpZ;

  return {
    x: prev.x + vx * dt,
    z: prev.z + vz * dt,
    vx,
    vz,
    rot,
  };
}
