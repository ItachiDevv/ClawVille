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
import { computeSettleCeiling, computeRefundCeiling } from '../escrow-gate';

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

describe('computeRefundCeiling — refund over-amount bound (FIX 2)', () => {
  it("is bounded by THIS job's own unspent funded portion", () => {
    // The shared vault has plenty escrow-wide, but this job only has 2 USDC
    // unspent — a refund cannot reclaim a sibling job's deposit.
    const ceiling = computeRefundCeiling({
      jobRemainingFunded: 2_000_000n,
      escrowRemaining: 1_000_000_000n,
    });
    expect(ceiling).toBe(2_000_000n);
  });

  it('is bounded by the escrow-wide remaining vault when it is the smaller', () => {
    // This job funded a lot, but the escrow-wide spendable balance is only 3 USDC
    // (the rest was released to a worker on a sibling job) — a refund can never
    // reclaim more USDC than is actually left in the vault.
    const ceiling = computeRefundCeiling({
      jobRemainingFunded: 1_000_000_000n,
      escrowRemaining: 3_000_000n,
    });
    expect(ceiling).toBe(3_000_000n);
  });

  it('returns 0 when nothing is refundable (fully released / drained)', () => {
    expect(
      computeRefundCeiling({ jobRemainingFunded: 0n, escrowRemaining: 1_000_000_000n }),
    ).toBe(0n);
    expect(
      computeRefundCeiling({ jobRemainingFunded: 1_000_000_000n, escrowRemaining: 0n }),
    ).toBe(0n);
  });

  it('floors a negative remaining at 0 (never returns a negative ceiling)', () => {
    // Defensive: a transiently-negative ledger value must never produce a negative
    // (and thus unbounded-looking) ceiling.
    expect(
      computeRefundCeiling({ jobRemainingFunded: -5n, escrowRemaining: 1_000_000n }),
    ).toBe(0n);
  });

  it('a refund request OVER the ceiling is an over-release (caller must reject)', () => {
    // The gate rejects `input.amount > computeRefundCeiling(...)`. Prove the bound
    // is exactly the smaller of the two inputs so the gate's `>` check is correct.
    const ceiling = computeRefundCeiling({
      jobRemainingFunded: 5_000_000n,
      escrowRemaining: 4_000_000n,
    });
    expect(ceiling).toBe(4_000_000n);
    // 4_000_001 (one base unit over) must be an over-release per the gate's check.
    expect(4_000_001n > ceiling).toBe(true);
    // exactly the ceiling is allowed.
    expect(4_000_000n > ceiling).toBe(false);
  });
});
