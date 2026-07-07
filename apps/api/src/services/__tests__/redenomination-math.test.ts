/**
 * Tokenomics Phase A / Slice A3 — ¢-peg redenomination math.
 *
 * The migration 0011 multiplies every CT balance ×10 (so 1 vCLAW = $0.01, was
 * $0.10). These tests pin the properties that keep that a SAFE relabeling:
 *   1. ×10 preserves the F1 sum invariant (claw = soft + bought + earned) — the
 *      exact thing the immediate avatars_vclaw_balance_sum CHECK enforces, so the
 *      one-statement ×10 can never tear it.
 *   2. purchasing power is IDENTICAL (old balance × $0.10 == new balance × $0.01).
 *   3. the store rate function `usdToCt` now uses CT_PER_USDC=100 (the ¢-peg).
 *   4. the signup bonus is worth $5 before AND after (50 @ $0.10 == 500 @ $0.01).
 */

import { describe, it, expect } from 'bun:test';
import { usdToCt, CT_PER_USDC } from '../x402-payai';
import { SIGNUP_BONUS_COSMETIC_CT } from '../cosmetic-signup-bonus';

const REDENOM = 10;
const OLD_USD_PER_UNIT = 0.1; // F2 era: $0.10/CT
const NEW_USD_PER_UNIT = 0.01; // A3 ¢-peg: $0.01/unit

/** Model the migration 0011 per-avatar ×10 on the four balance columns. */
function redenominate(tags: { soft: number; bought: number; earned: number }) {
  const claw = tags.soft + tags.bought + tags.earned;
  return {
    claw: claw * REDENOM,
    soft: tags.soft * REDENOM,
    bought: tags.bought * REDENOM,
    earned: tags.earned * REDENOM,
  };
}

describe('A3 ¢-peg redenomination math', () => {
  it('×10 preserves the F1 sum invariant (claw = soft + bought + earned)', () => {
    const cases: Array<[number, number, number]> = [
      [100, 0, 0],
      [50, 30, 20],
      [0, 0, 0],
      [1234, 5678, 9012],
      [999999, 1, 0],
    ];
    for (const [soft, bought, earned] of cases) {
      const after = redenominate({ soft, bought, earned });
      expect(after.claw).toBe(after.soft + after.bought + after.earned);
      // and each tag is exactly ×10 of its pre value.
      expect(after.soft).toBe(soft * 10);
      expect(after.bought).toBe(bought * 10);
      expect(after.earned).toBe(earned * 10);
    }
  });

  it('×10 preserves USD purchasing power (old × $0.10 === new × $0.01)', () => {
    for (const claw of [100, 50, 500, 12345, 1_000_000]) {
      const oldUsd = claw * OLD_USD_PER_UNIT;
      const newUsd = claw * REDENOM * NEW_USD_PER_UNIT;
      expect(newUsd).toBeCloseTo(oldUsd, 9);
    }
  });

  it('usdToCt uses the new ¢-peg rate (CT_PER_USDC=100)', () => {
    expect(CT_PER_USDC).toBe(100);
    expect(usdToCt(100)).toBe(100); // $1  → 100 units
    expect(usdToCt(1000)).toBe(1000); // $10 → 1000 units (headline store price)
    expect(usdToCt(1)).toBe(1); // 1¢ → 1 unit (no longer floors to 0 like at rate 10)
  });

  it('the signup bonus is worth $5 before AND after (50 @ $0.10 === 500 @ $0.01)', () => {
    // The A2 pre-redenomination value was 50; A3 bumped the constant to 500 AND
    // migrated existing grant rows ×10 — both denote the same $5.
    expect(SIGNUP_BONUS_COSMETIC_CT).toBe(500);
    expect(50 * OLD_USD_PER_UNIT).toBeCloseTo(SIGNUP_BONUS_COSMETIC_CT * NEW_USD_PER_UNIT, 9);
  });

  it('a top-up buys the same USD value of coins at the new rate (×10 units)', () => {
    // $10 top-up: old 100 CT @ $0.10 == new 1000 units @ $0.01 — the unit count
    // ×10 mirrors the balance ×10, so a buyer gets identical purchasing power.
    const oldUnits = Math.floor((1000 / 100) * 10); // old CT_PER_USDC=10
    const newUnits = usdToCt(1000); // new CT_PER_USDC=100
    expect(newUnits).toBe(oldUnits * 10);
    expect(oldUnits * OLD_USD_PER_UNIT).toBeCloseTo(newUnits * NEW_USD_PER_UNIT, 9);
  });
});
