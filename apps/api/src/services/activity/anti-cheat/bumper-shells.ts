/**
 * Q2 Activity Portals — Bumper Shells anti-cheat (chunk #3).
 *
 * Per backend §4.4: validators called per-input-tick from inside the sim.
 * All functions are pure — no side effects beyond returning a verdict
 * object. Flag accumulation lives on the sim's per-pet state (which the
 * sim mutates via `bumperFlagCounter`), keeping these helpers easy to
 * unit-test without spinning up a full sim.
 *
 * Power-up validation: a bad power-up activation is normal latency,
 * not cheating per backend §4.4 — drop silently, NO flag. We only flag
 * the unowned-slot case if the slot index is malformed (out of range);
 * runtime "no charges" results just don't fire the effect.
 */

import {
  clampToTolerance,
  clampVectorMagnitude,
  type ValidationVerdict,
  DEFAULT_CLAMP_TOLERANCE,
} from './shared';

// ─── Constants — founder-tunable ────────────────────────────────────────────

/**
 * Max body speed in world-units per second. The arena is 500wu radius
 * (3d-spec §1) and the round is 90s — a fully-boosted shell traverses
 * the arena in ~3s, so MAX_SPEED ≈ 350 leaves headroom for mid-game
 * boost stacking without unbalancing the round timer.
 */
export const MAX_SPEED = 350;

/**
 * Max linear acceleration in wu/s². 4× MAX_SPEED gives a 0.25s
 * boost-to-cap impulse — feels punchy without letting clients teleport.
 */
export const MAX_ACCEL = MAX_SPEED * 4;

/**
 * Closing-velocity threshold for a knockback to register on a
 * collision. Below this two bodies just slide past each other (cheap
 * "graze" — no event). Tuned to filter out idle-bumper drift.
 */
export const KNOCKBACK_VELOCITY_THRESHOLD = 80;

/**
 * Maximum power-up slot index. Bumper Shells uses a 2-slot inventory
 * per the plan power-up catalog (`bs-speed-boost` etc); the input
 * `actionBits` bit pattern decodes to a slot id.
 */
export const MAX_POWER_UP_SLOTS = 2;

/**
 * Per-match flag ceiling. Hitting this auto-forfeits the player and
 * closes the WS with code 4003 (`integrity`). Per backend §4.7.
 */
export const FLAG_FORFEIT_THRESHOLD = 5;

// ─── Validators ─────────────────────────────────────────────────────────────

/**
 * Position delta validator — distance covered between ticks must be ≤
 * `MAX_SPEED * dt * tolerance`. Over → clamp + flag.
 *
 * Returns a verdict carrying the clamped position; the sim writes the
 * clamped value to its body state so the next tick reads consistent
 * data even if a flag fires.
 */
export function validatePositionDelta(
  prev: { x: number; y: number },
  next: { x: number; y: number },
  dt: number,
  tolerance: number = DEFAULT_CLAMP_TOLERANCE,
): ValidationVerdict<{ x: number; y: number }> {
  const dx = next.x - prev.x;
  const dy = next.y - prev.y;
  const dist = Math.hypot(dx, dy);
  const maxStep = MAX_SPEED * Math.max(dt, 0);
  const limit = maxStep * tolerance;
  if (dist <= limit) {
    return { ok: true, value: next, clamped: false, flagged: false };
  }
  // Direction-preserving clamp back to maxStep (NOT the toleranced limit).
  const scale = dist === 0 ? 0 : maxStep / dist;
  const clampedNext = { x: prev.x + dx * scale, y: prev.y + dy * scale };
  return {
    ok: false,
    value: clampedNext,
    clamped: true,
    flagged: true,
    flagKind: 'overspeed',
    detail: `position_delta_${dist.toFixed(2)}_over_${maxStep.toFixed(2)}`,
  };
}

/**
 * Velocity delta validator — change in velocity per tick must be ≤
 * `MAX_ACCEL * dt * tolerance`. Over → clamp + flag.
 */
export function validateVelocityDelta(
  prev: { x: number; y: number },
  next: { x: number; y: number },
  dt: number,
  tolerance: number = DEFAULT_CLAMP_TOLERANCE,
): ValidationVerdict<{ x: number; y: number }> {
  const dvx = next.x - prev.x;
  const dvy = next.y - prev.y;
  const dv = Math.hypot(dvx, dvy);
  const maxAccelStep = MAX_ACCEL * Math.max(dt, 0);
  const limit = maxAccelStep * tolerance;
  if (dv <= limit) {
    return { ok: true, value: next, clamped: false, flagged: false };
  }
  // Clamp the delta back to maxAccelStep, then re-add to prev.
  const scale = dv === 0 ? 0 : maxAccelStep / dv;
  const clampedNext = { x: prev.x + dvx * scale, y: prev.y + dvy * scale };
  // Defensively cap absolute speed too — a high-velocity body shouldn't
  // exceed MAX_SPEED even after a valid accel.
  const speedClamp = clampVectorMagnitude(clampedNext, MAX_SPEED, 1);
  return {
    ok: false,
    value: speedClamp.clamped,
    clamped: true,
    flagged: true,
    flagKind: 'overaccel',
    detail: `velocity_delta_${dv.toFixed(2)}_over_${maxAccelStep.toFixed(2)}`,
  };
}

/**
 * Power-up slot use validator — verifies the slot index is well-formed
 * AND the inventory has charges + cooldown elapsed. Bad slot index ⇒
 * `flagKind: 'powerup_unowned'`, sim drops the activation. Empty/cooled
 * slot ⇒ verdict `ok=false` but `flagged=false` (normal latency case).
 */
export interface PowerUpInventorySlot {
  /** Power-up kind in this slot (e.g. 'bs-speed-boost'); null if empty */
  kind: string | null;
  charges: number;
  cooldownUntil: number;
}

export function validatePowerUpUse(
  slotIndex: number,
  inventory: PowerUpInventorySlot[],
  now: number,
): ValidationVerdict<PowerUpInventorySlot | null> {
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= MAX_POWER_UP_SLOTS) {
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

// ─── Flag-counter convenience wrapper ───────────────────────────────────────

/**
 * Per-pet, per-match flag counter. Owned by the sim; this helper just
 * encapsulates the increment + threshold check so the sim doesn't have
 * to inline the same arithmetic everywhere.
 *
 * Returns `true` when the threshold is reached (so the sim can trigger
 * forfeit + WS close). Each call can pass an optional `kind` for the
 * eventual `anti_cheat.flag` event payload.
 */
export class BumperFlagCounter {
  private counts = new Map<string, number>();

  /** Increment the counter for `petId`; returns true if forfeit threshold hit */
  bump(petId: string): boolean {
    const next = (this.counts.get(petId) ?? 0) + 1;
    this.counts.set(petId, next);
    return next >= FLAG_FORFEIT_THRESHOLD;
  }

  countFor(petId: string): number {
    return this.counts.get(petId) ?? 0;
  }

  reset(petId: string): void {
    this.counts.delete(petId);
  }

  resetAll(): void {
    this.counts.clear();
  }
}
