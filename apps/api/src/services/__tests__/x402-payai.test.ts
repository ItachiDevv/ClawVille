/**
 * x402-payai pure-conversion unit tests (Tokenomics F2).
 *
 * Locks the store buy-price math so a rate edit can't silently regress:
 *   - `CT_PER_USDC = 10` ($0.10/coin) — the F2 founder rate (was 100).
 *   - `usdToCt($10) = 100` (NOT 1000) — the headline store price.
 *   - `usdCentsToUsdcAtomic` is the on-chain USDC unit conversion and is
 *     INDEPENDENT of the vCLAW rate (a dollar is always a dollar of USDC).
 *
 * These are pure functions over integers — no DB, no facilitator, no network.
 */

import { describe, it, expect } from 'bun:test';
import {
  CT_PER_USDC,
  usdToCt,
  usdCentsToUsdcAtomic,
} from '../x402-payai';

describe('x402-payai — F2 store buy-price ($0.10/coin)', () => {
  it('CT_PER_USDC is 10 (the F2 founder rate, was 100)', () => {
    expect(CT_PER_USDC).toBe(10);
  });

  it('usdToCt($10) = 100 vCLAW — the headline store price (NOT 1000)', () => {
    // $10 = 1000 cents → (1000/100) * 10 = 100.
    expect(usdToCt(1000)).toBe(100);
  });

  it('usdToCt($1) = 10 vCLAW (1 USDC buys 10 coins)', () => {
    expect(usdToCt(100)).toBe(10);
  });

  it('usdToCt($100) = 1000 vCLAW (linear in the amount)', () => {
    expect(usdToCt(10_000)).toBe(1000);
  });

  it('floors a sub-dime cents amount that cannot mint a whole coin', () => {
    // 5 cents → (5/100)*10 = 0.5 → floor 0. (The route caps usdCents ≥ 1, but the
    // primitive must never mint a fractional coin regardless.)
    expect(usdToCt(5)).toBe(0);
    // 10 cents → exactly 1 coin.
    expect(usdToCt(10)).toBe(1);
  });

  it('rejects a non-positive / non-integer cents amount', () => {
    expect(() => usdToCt(0)).toThrow();
    expect(() => usdToCt(-100)).toThrow();
    expect(() => usdToCt(10.5)).toThrow();
  });
});

describe('x402-payai — USDC atomic conversion is rate-independent', () => {
  it('1 cent → "10000" atomic micro-USDC (6-decimal USDC, 2-decimal USD)', () => {
    expect(usdCentsToUsdcAtomic(1)).toBe('10000');
  });

  it('$1 (100 cents) → "1000000" = 1 USDC', () => {
    expect(usdCentsToUsdcAtomic(100)).toBe('1000000');
  });

  it('$10 (1000 cents) → "10000000" = 10 USDC (the on-chain amount the buyer pays)', () => {
    // Unchanged by the F2 vCLAW rate edit — a $10 buy still moves $10 of USDC
    // on-chain; only the vCLAW the buyer RECEIVES (100) changed.
    expect(usdCentsToUsdcAtomic(1000)).toBe('10000000');
  });
});
