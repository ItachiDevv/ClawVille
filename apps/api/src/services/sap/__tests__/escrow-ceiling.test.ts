/**
 * SAP Option C — settle-ceiling clamp tests (BLOCKING #2 + #3 fix).
 *
 * PURE-COMPUTE (no DB). Proves a worker's requested `callsToSettle` is bounded by
 * the MIN of (maxCalls−settled, approvedCalls, vault-can-pay, job-funds-can-pay),
 * so a worker can neither over-release a single job NOR drain USDC the depositor
 * funded for a SIBLING job sharing the same nonce-less escrow vault.
 *
 * `settleJob` rejects any `callsToSettle > computeSettleCeiling(...)`.
 */

import { describe, it, expect } from 'bun:test';
import { computeSettleCeiling } from '../escrow-gate';

const PRICE = 1_000_000n; // 1 USDC (6 decimals) per call

describe('computeSettleCeiling — over-release bound (BLOCKING #2/#3)', () => {
  it('is bounded by maxCalls − callsAlreadySettled', () => {
    const ceiling = computeSettleCeiling({
      maxCalls: 10n,
      callsAlreadySettled: 7n,
      approvedCalls: 0n,
      pricePerCall: PRICE,
      escrowRemaining: 1_000_000_000n, // plenty
      jobRemainingFunded: 1_000_000_000n, // plenty
    });
    expect(ceiling).toBe(3n);
  });

  it('is bounded by the depositor approved-calls cap when it is the smallest', () => {
    const ceiling = computeSettleCeiling({
      maxCalls: 10n,
      callsAlreadySettled: 0n,
      approvedCalls: 2n, // depositor only approved 2
      pricePerCall: PRICE,
      escrowRemaining: 1_000_000_000n,
      jobRemainingFunded: 1_000_000_000n,
    });
    expect(ceiling).toBe(2n);
  });

  it('is bounded by what the ESCROW-WIDE remaining vault can pay (cross-job drain guard)', () => {
    // This job is authorized for 10 calls but the SHARED vault only has 3 USDC
    // left (the rest is earmarked / already released for sibling jobs). A worker
    // controlling this job must not release more than the vault can cover.
    const ceiling = computeSettleCeiling({
      maxCalls: 10n,
      callsAlreadySettled: 0n,
      approvedCalls: 0n,
      pricePerCall: PRICE,
      escrowRemaining: 3_500_000n, // 3.5 USDC → floor(3.5) = 3 calls
      jobRemainingFunded: 1_000_000_000n,
    });
    expect(ceiling).toBe(3n);
  });

  it("is bounded by THIS job's own funded portion (sibling-earmark guard)", () => {
    // The vault has plenty escrow-wide, but THIS job only funded 2 USDC. A worker
    // cannot reach over and spend a sibling job's deposit.
    const ceiling = computeSettleCeiling({
      maxCalls: 10n,
      callsAlreadySettled: 0n,
      approvedCalls: 0n,
      pricePerCall: PRICE,
      escrowRemaining: 1_000_000_000n,
      jobRemainingFunded: 2_000_000n, // 2 USDC → 2 calls
    });
    expect(ceiling).toBe(2n);
  });

  it('returns 0 when nothing is settleable (fully settled / unfunded / zero price)', () => {
    expect(
      computeSettleCeiling({
        maxCalls: 5n,
        callsAlreadySettled: 5n,
        approvedCalls: 0n,
        pricePerCall: PRICE,
        escrowRemaining: 1_000_000_000n,
        jobRemainingFunded: 1_000_000_000n,
      }),
    ).toBe(0n);
    expect(
      computeSettleCeiling({
        maxCalls: 5n,
        callsAlreadySettled: 0n,
        approvedCalls: 0n,
        pricePerCall: PRICE,
        escrowRemaining: 0n, // vault empty
        jobRemainingFunded: 1_000_000_000n,
      }),
    ).toBe(0n);
    expect(
      computeSettleCeiling({
        maxCalls: 5n,
        callsAlreadySettled: 0n,
        approvedCalls: 0n,
        pricePerCall: 0n, // invalid price ⇒ fail closed
        escrowRemaining: 1_000_000_000n,
        jobRemainingFunded: 1_000_000_000n,
      }),
    ).toBe(0n);
  });

  it('floors fractional call coverage (never rounds up a partial call)', () => {
    const ceiling = computeSettleCeiling({
      maxCalls: 100n,
      callsAlreadySettled: 0n,
      approvedCalls: 0n,
      pricePerCall: PRICE,
      escrowRemaining: 2_999_999n, // 2.999999 USDC → 2 calls, never 3
      jobRemainingFunded: 1_000_000_000n,
    });
    expect(ceiling).toBe(2n);
  });

  it('takes the global MIN across all four bounds simultaneously', () => {
    const ceiling = computeSettleCeiling({
      maxCalls: 9n, // remaining authorized after 1 settled = 8
      callsAlreadySettled: 1n,
      approvedCalls: 6n, // approved 6
      pricePerCall: PRICE,
      escrowRemaining: 5_000_000n, // vault → 5
      jobRemainingFunded: 7_000_000n, // job funds → 7
    });
    // min(8, 6, 5, 7) = 5
    expect(ceiling).toBe(5n);
  });
});
