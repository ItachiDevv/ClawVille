/**
 * Tokenomics Phase A / Slice A2 — cosmetics signup-bonus money-split tests.
 *
 * `allocateCosmeticSpend` is the crux of the conservation guarantee in the
 * cosmetics buy path: the grant covers `grantUsed`, the buyer pays `realCt`, and
 * ONLY `realCt` is routed to the treasury. The invariant that must hold for EVERY
 * input is `grantUsed + realCt === priceCt` (the cosmetic's price is fully
 * accounted, nothing minted, nothing lost) with `grantUsed` never exceeding the
 * grant nor the price.
 */

import { describe, it, expect } from 'bun:test';
import { allocateCosmeticSpend, SIGNUP_BONUS_COSMETIC_CT } from '../cosmetic-signup-bonus';

describe('cosmetic signup bonus — allocateCosmeticSpend', () => {
  it('grant fully covers a cheap SKU: grantUsed = price, realCt = 0', () => {
    const { grantUsed, realCt } = allocateCosmeticSpend(30, 50);
    expect(grantUsed).toBe(30);
    expect(realCt).toBe(0);
  });

  it('grant partially covers a pricier SKU: grantUsed = grant, realCt = remainder', () => {
    const { grantUsed, realCt } = allocateCosmeticSpend(300, 50);
    expect(grantUsed).toBe(50);
    expect(realCt).toBe(250);
  });

  it('grant exactly equals the price', () => {
    const { grantUsed, realCt } = allocateCosmeticSpend(50, 50);
    expect(grantUsed).toBe(50);
    expect(realCt).toBe(0);
  });

  it('no grant left: grantUsed = 0, realCt = full price', () => {
    const { grantUsed, realCt } = allocateCosmeticSpend(600, 0);
    expect(grantUsed).toBe(0);
    expect(realCt).toBe(600);
  });

  it('negative/garbage grant remaining is clamped to 0 (never a negative draw)', () => {
    const { grantUsed, realCt } = allocateCosmeticSpend(600, -100);
    expect(grantUsed).toBe(0);
    expect(realCt).toBe(600);
  });

  it('CONSERVATION: grantUsed + realCt === priceCt for every combination', () => {
    for (const price of [0, 1, 30, 49, 50, 51, 300, 500, 1500, 12345]) {
      for (const grant of [0, 1, 49, 50, 500, 99999]) {
        const { grantUsed, realCt } = allocateCosmeticSpend(price, grant);
        expect(grantUsed + realCt).toBe(price);
        expect(grantUsed).toBeGreaterThanOrEqual(0);
        expect(grantUsed).toBeLessThanOrEqual(price);
        expect(grantUsed).toBeLessThanOrEqual(Math.max(0, grant));
        expect(realCt).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('the signup-bonus constant is the post-redenomination $5 value (500 units at the ¢-peg)', () => {
    // A2 shipped 50 (pre-×10); the A3 ¢-peg redenomination bumped it to 500 AND
    // migrated existing grant rows ×10, so every account lands at 500 units = $5.
    expect(SIGNUP_BONUS_COSMETIC_CT).toBe(500);
  });
});
