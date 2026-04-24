/**
 * Q2 Activity Portals — Reef Race anti-cheat (chunk #5).
 *
 * Per backend §4.5 + §4.7:
 *   - `validateLapTime(lapMs)` — flag if the lap completed faster than
 *     `MIN_LAP_MS`. The sim DROPS the lap (does not advance the lap
 *     counter) and emits the flag. Repeated under-min laps still each
 *     count one flag, so a sustained exploit hits the per-match
 *     `FLAG_FORFEIT_THRESHOLD = 5` ceiling fast.
 *   - `validateCheckpointSequence(petId, hitIndex, expectedIndex)` — out
 *     of order = silent reject. We track recent rejects in a 5s rolling
 *     window per pet; 3+ in 5s → flag (`checkpoint_skip` kind). Silent
 *     reject of a single jitter event keeps the false-positive rate low
 *     (clients can land mid-checkpoint at the wrong moment under packet
 *     loss).
 *   - `validatePositionDelta` / `validateVelocityDelta` are reused from
 *     `bumper-shells.ts` with REEF-specific MAX_SPEED / MAX_ACCEL —
 *     same shape, just bigger numbers because karts are faster than
 *     bumper shells.
 *
 * Personal-best detection lives in chunk #7's reward pipeline (it owns
 * the historical query). The sim emits accurate `event.lap_completed`
 * frames with server-stamped `splitMs` + `totalMs`; reward pipeline
 * derives the PB flag from `score_ms` against the prior 30-day
 * minimum.
 *
 * Re-uses `BumperFlagCounter` from `bumper-shells.ts` rather than
 * forking a Reef-specific class — `FLAG_FORFEIT_THRESHOLD = 5` is the
 * shared ceiling per backend §4.7 across activities. The counter is
 * activity-agnostic; the flag-kind union is what differs.
 */

import {
  validatePositionDelta as bumperValidatePositionDelta,
  validateVelocityDelta as bumperValidateVelocityDelta,
  FLAG_FORFEIT_THRESHOLD,
  BumperFlagCounter,
  type PowerUpInventorySlot,
} from './bumper-shells';
import {
  type ValidationVerdict,
  DEFAULT_CLAMP_TOLERANCE,
} from './shared';
import {
  MIN_LAP_MS,
  REEF_MAX_SPEED,
  REEF_MAX_ACCEL,
  REEF_SKIP_PATTERN_WINDOW_MS,
  REEF_SKIP_PATTERN_THRESHOLD,
  REEF_CHECKPOINT_COUNT,
  REEF_MAX_POWER_UP_SLOTS,
} from '../sim/reef-race-config';

// Re-export for convenience — Reef Race uses the same flag counter +
// forfeit threshold as Bumper. See module-doc above.
export { FLAG_FORFEIT_THRESHOLD };
export class ReefFlagCounter extends BumperFlagCounter {}

// ─── Position / velocity bounds ─────────────────────────────────────────────

/**
 * Position-delta validator using REEF_MAX_SPEED. Wraps the generic
 * Bumper validator with a per-activity ceiling. Clamping behaviour and
 * verdict shape are identical.
 */
export function validateReefPositionDelta(
  prev: { x: number; y: number },
  next: { x: number; y: number },
  dt: number,
  tolerance: number = DEFAULT_CLAMP_TOLERANCE,
): ValidationVerdict<{ x: number; y: number }> {
  // Re-implement here so we use REEF_MAX_SPEED instead of Bumper's
  // MAX_SPEED. The Bumper helper hard-codes its own constant.
  const dx = next.x - prev.x;
  const dy = next.y - prev.y;
  const dist = Math.hypot(dx, dy);
  const maxStep = REEF_MAX_SPEED * Math.max(dt, 0);
  const limit = maxStep * tolerance;
  if (dist <= limit) {
    return { ok: true, value: next, clamped: false, flagged: false };
  }
  const scale = dist === 0 ? 0 : maxStep / dist;
  const clampedNext = { x: prev.x + dx * scale, y: prev.y + dy * scale };
  return {
    ok: false,
    value: clampedNext,
    clamped: true,
    flagged: true,
    flagKind: 'overspeed',
    detail: `reef_position_delta_${dist.toFixed(2)}_over_${maxStep.toFixed(2)}`,
  };
}

/**
 * Velocity-delta validator using REEF_MAX_ACCEL + REEF_MAX_SPEED for
 * the resulting speed cap. Same verdict shape as Bumper's variant.
 */
export function validateReefVelocityDelta(
  prev: { x: number; y: number },
  next: { x: number; y: number },
  dt: number,
  tolerance: number = DEFAULT_CLAMP_TOLERANCE,
): ValidationVerdict<{ x: number; y: number }> {
  const dvx = next.x - prev.x;
  const dvy = next.y - prev.y;
  const dv = Math.hypot(dvx, dvy);
  const maxAccelStep = REEF_MAX_ACCEL * Math.max(dt, 0);
  const limit = maxAccelStep * tolerance;
  if (dv <= limit) {
    // Defensive — even within accel bound, cap absolute speed.
    const speed = Math.hypot(next.x, next.y);
    if (speed <= REEF_MAX_SPEED * tolerance) {
      return { ok: true, value: next, clamped: false, flagged: false };
    }
    const scale = REEF_MAX_SPEED / speed;
    return {
      ok: false,
      value: { x: next.x * scale, y: next.y * scale },
      clamped: true,
      flagged: true,
      flagKind: 'overspeed',
      detail: `reef_speed_${speed.toFixed(2)}_over_${REEF_MAX_SPEED.toFixed(2)}`,
    };
  }
  const scale = dv === 0 ? 0 : maxAccelStep / dv;
  const clampedNext = { x: prev.x + dvx * scale, y: prev.y + dvy * scale };
  // Cap absolute speed too.
  const speed = Math.hypot(clampedNext.x, clampedNext.y);
  if (speed > REEF_MAX_SPEED) {
    const s = REEF_MAX_SPEED / speed;
    clampedNext.x *= s;
    clampedNext.y *= s;
  }
  return {
    ok: false,
    value: clampedNext,
    clamped: true,
    flagged: true,
    flagKind: 'overaccel',
    detail: `reef_velocity_delta_${dv.toFixed(2)}_over_${maxAccelStep.toFixed(2)}`,
  };
}

// Re-export Bumper variants under explicit names for tests + future
// callers that want the Bumper bounds in a Reef context (e.g. testing
// the validator's clamp logic against a fixed MAX_SPEED).
export {
  bumperValidatePositionDelta,
  bumperValidateVelocityDelta,
};

// ─── Lap-time validator ─────────────────────────────────────────────────────

/**
 * Validate a lap-completion time. Flags + drops the lap if it's faster
 * than `MIN_LAP_MS`. Pure function — caller (the sim) decides whether
 * to advance the lap counter based on `ok`.
 */
export function validateLapTime(
  lapMs: number,
): ValidationVerdict<number> {
  if (!Number.isFinite(lapMs) || lapMs < 0) {
    return {
      ok: false,
      value: 0,
      clamped: true,
      flagged: true,
      flagKind: 'underminlap',
      detail: `lap_time_invalid_${lapMs}`,
    };
  }
  if (lapMs < MIN_LAP_MS) {
    return {
      ok: false,
      value: lapMs,
      clamped: false,
      flagged: true,
      flagKind: 'underminlap',
      detail: `lap_time_${lapMs}_under_${MIN_LAP_MS}`,
    };
  }
  return { ok: true, value: lapMs, clamped: false, flagged: false };
}

// ─── Checkpoint-sequence validator ──────────────────────────────────────────

/**
 * Validate a checkpoint hit against the per-pet expected next index.
 *
 * Returns `ok: true` when the body crossed the expected next checkpoint.
 * Returns `ok: false, flagged: false` for a single out-of-order hit
 * (silent reject — could be jitter / packet loss). The sim does NOT
 * advance the pet's `nextCheckpoint` pointer in either failure case.
 *
 * The `ReefCheckpointTracker` (below) folds `validateCheckpointSequence`
 * into a stateful per-match counter that escalates to a flag after
 * `REEF_SKIP_PATTERN_THRESHOLD` rejects in a `REEF_SKIP_PATTERN_WINDOW_MS`
 * rolling window — the recommended API for sim integration.
 */
export function validateCheckpointSequence(
  hitIndex: number,
  expectedIndex: number,
): ValidationVerdict<number> {
  if (
    !Number.isInteger(hitIndex) ||
    hitIndex < 0 ||
    hitIndex >= REEF_CHECKPOINT_COUNT
  ) {
    return {
      ok: false,
      value: hitIndex,
      clamped: false,
      flagged: true,
      flagKind: 'checkpoint_skip',
      detail: `checkpoint_index_invalid_${hitIndex}`,
    };
  }
  if (hitIndex !== expectedIndex) {
    return {
      ok: false,
      value: hitIndex,
      clamped: false,
      flagged: false,
      flagKind: 'checkpoint_skip',
      detail: `checkpoint_${hitIndex}_expected_${expectedIndex}`,
    };
  }
  return { ok: true, value: hitIndex, clamped: false, flagged: false };
}

/**
 * Per-pet rolling-window tracker for checkpoint-skip patterns. The sim
 * holds one of these per room and calls `recordSkip(petId)` for every
 * silent-reject from `validateCheckpointSequence`. Returns true when
 * the pattern threshold trips — caller logs the flag + bumps the
 * BumperFlagCounter.
 */
export class ReefCheckpointSkipTracker {
  private skips = new Map<string, number[]>();

  /** Record a skip; returns true if the pattern threshold tripped. */
  recordSkip(petId: string, now: number = Date.now()): boolean {
    let times = this.skips.get(petId);
    if (!times) {
      times = [];
      this.skips.set(petId, times);
    }
    const cutoff = now - REEF_SKIP_PATTERN_WINDOW_MS;
    while (times.length > 0 && times[0] < cutoff) {
      times.shift();
    }
    times.push(now);
    return times.length >= REEF_SKIP_PATTERN_THRESHOLD;
  }

  forget(petId: string): void {
    this.skips.delete(petId);
  }

  /** Test hook. */
  __resetForTest(): void {
    this.skips.clear();
  }
}

// ─── Power-up slot use validator ────────────────────────────────────────────

/**
 * Validate a Reef power-up slot use. Same logic as the Bumper variant
 * but parameterised on `REEF_MAX_POWER_UP_SLOTS` and reuses the shared
 * `PowerUpInventorySlot` shape.
 */
export function validateReefPowerUpUse(
  slotIndex: number,
  inventory: PowerUpInventorySlot[],
  now: number,
): ValidationVerdict<PowerUpInventorySlot | null> {
  if (
    !Number.isInteger(slotIndex) ||
    slotIndex < 0 ||
    slotIndex >= REEF_MAX_POWER_UP_SLOTS
  ) {
    return {
      ok: false,
      value: null,
      clamped: false,
      flagged: true,
      flagKind: 'powerup_unowned',
      detail: `slot_index_out_of_range_${slotIndex}`,
    };
  }
  const slot = inventory[slotIndex];
  if (!slot || slot.kind === null || slot.charges <= 0) {
    return {
      ok: false,
      value: null,
      clamped: false,
      flagged: false,
      detail: 'no_charges_in_slot',
    };
  }
  if (slot.cooldownUntil > now) {
    return {
      ok: false,
      value: null,
      clamped: false,
      flagged: false,
      detail: 'cooldown_active',
    };
  }
  return { ok: true, value: slot, clamped: false, flagged: false };
}

export type { PowerUpInventorySlot } from './bumper-shells';
