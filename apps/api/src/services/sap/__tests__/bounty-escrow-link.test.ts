/**
 * Unit tests for the bounty ↔ USDC escrow linkage PURE logic (Phase 1).
 *
 * Covers only the deterministic, DB-free pieces:
 *   - usdcRewardBaseUnits: vCLAW reward → USDC base units (the money
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
  it('scales each vCLAW reward unit to 10,000 USDC base units', () => {
    expect(usdcRewardBaseUnits(1)).toBe(10_000n);
    expect(usdcRewardBaseUnits(5)).toBe(50_000n);
    expect(usdcRewardBaseUnits(10)).toBe(100_000n);
    expect(usdcRewardBaseUnits(250)).toBe(2_500_000n);
  });

  it('handles large rewards without float error (bigint math)', () => {
    // 1,000,000 vCLAW ($10,000) → 1e10 base units — exact, no float drift.
    expect(usdcRewardBaseUnits(1_000_000)).toBe(10_000_000_000n);
  });

  it('rejects a non-positive reward (no zero/negative escrow)', () => {
    expect(() => usdcRewardBaseUnits(0)).toThrow();
    expect(() => usdcRewardBaseUnits(-5)).toThrow();
  });

  it('rejects a non-integer vCLAW reward', () => {
    expect(() => usdcRewardBaseUnits(1.5)).toThrow();
  });
});
