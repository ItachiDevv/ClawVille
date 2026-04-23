/**
 * Q2 Activity Portals — Bumper Shells anti-cheat unit tests (chunk #3).
 *
 * Pure-function coverage:
 *   - overspeed clamp triggers flag + preserves direction
 *   - overaccel clamp triggers flag + caps resulting speed
 *   - power-up slot validation (invalid slot → flag; empty/cooled slot → silent)
 *   - flag counter hits forfeit at 5
 *
 * These tests don't touch DB/sim — just the validator functions. Bun
 * test runner; same mock-free style as the pure shared.ts tests.
 */

import { describe, expect, it } from 'bun:test';
import {
  MAX_SPEED,
  MAX_ACCEL,
  MAX_POWER_UP_SLOTS,
  FLAG_FORFEIT_THRESHOLD,
  validatePositionDelta,
  validateVelocityDelta,
  validatePowerUpUse,
  BumperFlagCounter,
  type PowerUpInventorySlot,
} from '../bumper-shells';

const DT_60HZ = 1 / 60;

// ─── Overspeed clamp ────────────────────────────────────────────────────────

describe('validatePositionDelta — overspeed', () => {
  it('passes through a legitimate velocity integration', () => {
    const prev = { x: 0, y: 0 };
    const next = { x: MAX_SPEED * DT_60HZ * 0.9, y: 0 };
    const v = validatePositionDelta(prev, next, DT_60HZ);
    expect(v.ok).toBe(true);
    expect(v.flagged).toBe(false);
    expect(v.value).toEqual(next);
  });

  it('clamps an over-limit position delta and flags', () => {
    const prev = { x: 0, y: 0 };
    const next = { x: MAX_SPEED * DT_60HZ * 3, y: 0 }; // 3× limit
    const v = validatePositionDelta(prev, next, DT_60HZ);
    expect(v.ok).toBe(false);
    expect(v.flagged).toBe(true);
    expect(v.flagKind).toBe('overspeed');
    const dist = Math.hypot(v.value.x - prev.x, v.value.y - prev.y);
    expect(dist).toBeCloseTo(MAX_SPEED * DT_60HZ, 4);
  });

  it('preserves direction when clamping', () => {
    const prev = { x: 0, y: 0 };
    const next = { x: 10000, y: 10000 }; // diagonal 45°
    const v = validatePositionDelta(prev, next, DT_60HZ);
    expect(v.flagged).toBe(true);
    const angle = Math.atan2(v.value.y - prev.y, v.value.x - prev.x);
    // Diagonal 45° = π/4
    expect(angle).toBeCloseTo(Math.PI / 4, 4);
  });

  it('respects the 1.15 tolerance (does not flag 1.10× drift)', () => {
    const prev = { x: 0, y: 0 };
    const next = { x: MAX_SPEED * DT_60HZ * 1.1, y: 0 };
    const v = validatePositionDelta(prev, next, DT_60HZ);
    expect(v.flagged).toBe(false);
  });
});

// ─── Overaccel clamp ────────────────────────────────────────────────────────

describe('validateVelocityDelta — overaccel', () => {
  it('passes through a legitimate accel step', () => {
    const prev = { x: 0, y: 0 };
    const next = { x: MAX_ACCEL * DT_60HZ * 0.5, y: 0 };
    const v = validateVelocityDelta(prev, next, DT_60HZ);
    expect(v.ok).toBe(true);
    expect(v.flagged).toBe(false);
  });

  it('clamps over-limit velocity delta and flags', () => {
    const prev = { x: 0, y: 0 };
    const next = { x: MAX_ACCEL * DT_60HZ * 5, y: 0 }; // 5× limit
    const v = validateVelocityDelta(prev, next, DT_60HZ);
    expect(v.ok).toBe(false);
    expect(v.flagged).toBe(true);
    expect(v.flagKind).toBe('overaccel');
    // Absolute speed always ≤ MAX_SPEED after clamp.
    expect(Math.hypot(v.value.x, v.value.y)).toBeLessThanOrEqual(MAX_SPEED + 1e-6);
  });
});

// ─── Power-up slot validator ────────────────────────────────────────────────

describe('validatePowerUpUse', () => {
  function emptyInv(): PowerUpInventorySlot[] {
    return Array.from({ length: MAX_POWER_UP_SLOTS }, () => ({
      kind: null,
      charges: 0,
      cooldownUntil: 0,
    }));
  }

  it('flags out-of-range slot index', () => {
    const v = validatePowerUpUse(99, emptyInv(), Date.now());
    expect(v.flagged).toBe(true);
    expect(v.flagKind).toBe('powerup_unowned');
  });

  it('flags negative slot index', () => {
    const v = validatePowerUpUse(-1, emptyInv(), Date.now());
    expect(v.flagged).toBe(true);
  });

  it('silently drops activation on empty slot (no flag)', () => {
    const v = validatePowerUpUse(0, emptyInv(), Date.now());
    expect(v.ok).toBe(false);
    expect(v.flagged).toBe(false);
  });

  it('silently drops activation during cooldown (no flag)', () => {
    const now = Date.now();
    const inv = emptyInv();
    inv[0] = { kind: 'bs-speed-boost', charges: 1, cooldownUntil: now + 5_000 };
    const v = validatePowerUpUse(0, inv, now);
    expect(v.ok).toBe(false);
    expect(v.flagged).toBe(false);
  });

  it('accepts a ready charge', () => {
    const now = Date.now();
    const inv = emptyInv();
    inv[0] = { kind: 'bs-speed-boost', charges: 1, cooldownUntil: 0 };
    const v = validatePowerUpUse(0, inv, now);
    expect(v.ok).toBe(true);
    expect(v.value?.kind).toBe('bs-speed-boost');
  });
});

// ─── Flag counter forfeit ───────────────────────────────────────────────────

describe('BumperFlagCounter', () => {
  it('reports forfeit at exactly the 5th flag', () => {
    const counter = new BumperFlagCounter();
    for (let i = 1; i < FLAG_FORFEIT_THRESHOLD; i++) {
      expect(counter.bump('pet-a')).toBe(false);
    }
    expect(counter.bump('pet-a')).toBe(true);
    expect(counter.countFor('pet-a')).toBe(FLAG_FORFEIT_THRESHOLD);
  });

  it('tracks pets independently', () => {
    const counter = new BumperFlagCounter();
    counter.bump('pet-a');
    counter.bump('pet-a');
    counter.bump('pet-b');
    expect(counter.countFor('pet-a')).toBe(2);
    expect(counter.countFor('pet-b')).toBe(1);
  });

  it('reset wipes a pet', () => {
    const counter = new BumperFlagCounter();
    counter.bump('pet-a');
    counter.reset('pet-a');
    expect(counter.countFor('pet-a')).toBe(0);
  });
});
