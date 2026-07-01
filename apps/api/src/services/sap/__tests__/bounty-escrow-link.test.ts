/**
 * Unit tests for the bounty ↔ USDC escrow linkage PURE logic (Phase 1).
 *
 * Covers only the deterministic, DB-free pieces:
 *   - usdcRewardBaseUnits: whole-USDC reward → 6-decimal base units (the money
 *     conversion the whole rail depends on), including the reject-invalid guard.
 *
 * The stateful open/approve/settle/refund orchestration is exercised by the live
 * dry-run devnet smoke + the adversarial audit against the running game (it needs
 * a DB + the SAP gate), not here — this file locks the arithmetic that a wrong
 * value would silently mis-fund.
 */

import { describe, it, expect } from 'bun:test';
import { usdcRewardBaseUnits } from '../../bounty-escrow-link';

describe('usdcRewardBaseUnits', () => {
  it('scales a whole-USDC reward by 6 decimals', () => {
    expect(usdcRewardBaseUnits(1)).toBe(1_000_000n);
    expect(usdcRewardBaseUnits(10)).toBe(10_000_000n);
    expect(usdcRewardBaseUnits(250)).toBe(250_000_000n);
  });

  it('handles large rewards without float error (bigint math)', () => {
    // 1,000,000 USDC → 1e12 base units — exact, no float drift.
    expect(usdcRewardBaseUnits(1_000_000)).toBe(1_000_000_000_000n);
  });

  it('rejects a non-positive reward (no zero/negative escrow)', () => {
    expect(() => usdcRewardBaseUnits(0)).toThrow();
    expect(() => usdcRewardBaseUnits(-5)).toThrow();
  });

  it('rejects a non-integer reward (whole-USDC only)', () => {
    expect(() => usdcRewardBaseUnits(1.5)).toThrow();
  });
});
