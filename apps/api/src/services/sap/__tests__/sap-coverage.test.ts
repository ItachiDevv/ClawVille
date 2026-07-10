/**
 * SAP V2 stake/max-obligation mirrors.
 *
 * Pure and offline: these regression pins encode the exact deployed-source
 * arithmetic and the 2026-07-09 live devnet observations. No RPC, signing, or
 * transaction construction is permitted in this suite.
 */
import { describe, expect, it } from 'bun:test';
import {
  checkV2EscrowCoverage,
  checkV2EscrowDepositCoverage,
  computeV2EscrowCoverageLimit,
  preflightV2CreateCoverage,
  preflightV2DepositCoverage,
} from '../sap-coverage';

const LIVE_TERMS = {
  pricePerCall: 10_000n,
  maxCalls: 10n,
  initialDeposit: 150_000n,
};

describe('SAP V2 source-derived escrow coverage', () => {
  it('accepts the observed 150,000-unit create with the observed 110M-lamport stake', () => {
    const requirement = computeV2EscrowCoverageLimit(LIVE_TERMS);
    expect(requirement).toEqual({
      maxObligation: 100_000n,
      requiredStakeLamports: 100_000_000n,
    });

    const verdict = checkV2EscrowCoverage(110_000_000n, LIVE_TERMS);
    expect(verdict.ok).toBeTrue();
    expect(verdict.additionalStakeLamports).toBe(0n);

    // The deployed create handler does not compare initialDeposit with
    // maxObligation. This surprising acceptance is intentional parity.
    expect(LIVE_TERMS.initialDeposit).toBeGreaterThan(verdict.maxObligation);
  });

  it('rejects the observed follow-up deposit projecting balance to 200,000 units', () => {
    const verdict = checkV2EscrowDepositCoverage({
      balance: 150_000n,
      amount: 50_000n,
      maxObligation: 100_000n,
    });
    expect(verdict).toEqual({
      ok: false,
      projectedBalance: 200_000n,
      maxObligation: 100_000n,
      maximumAdditionalDeposit: 0n,
    });
  });

  it('uses initial deposit as max obligation only for unlimited-call escrows', () => {
    expect(
      computeV2EscrowCoverageLimit({
        pricePerCall: 10_000n,
        maxCalls: 0n,
        initialDeposit: 150_000n,
      }),
    ).toEqual({
      maxObligation: 150_000n,
      requiredStakeLamports: 100_000_000n,
    });
  });

  it('preserves the legacy max_obligation=0 deposit bypass', () => {
    const verdict = checkV2EscrowDepositCoverage({
      balance: 1_000_000n,
      amount: 1_000_000n,
      maxObligation: 0n,
    });
    expect(verdict.ok).toBeTrue();
    expect(verdict.projectedBalance).toBe(2_000_000n);
  });

  it('reports exact additional stake above the permanent floor', () => {
    const terms = {
      pricePerCall: 300_000_000n,
      maxCalls: 2n,
      initialDeposit: 600_000_000n,
    };
    expect(checkV2EscrowCoverage(250_000_000n, terms)).toEqual({
      ok: false,
      maxObligation: 600_000_000n,
      requiredStakeLamports: 300_000_000n,
      additionalStakeLamports: 50_000_000n,
    });
  });

  it('returns exact checked create/deposit verdicts from injected read-only state', async () => {
    const create = await preflightV2CreateCoverage(
      { pricePerCall: 300_000_000n, maxCalls: 2n, initialDeposit: 606_000_000n },
      async () => 250_000_000n,
    );
    expect(create).toEqual({
      state: 'checked',
      stakeLamports: 250_000_000n,
      verdict: {
        ok: false,
        maxObligation: 600_000_000n,
        requiredStakeLamports: 300_000_000n,
        additionalStakeLamports: 50_000_000n,
      },
    });

    const deposit = await preflightV2DepositCoverage(
      50_000n,
      async () => ({ balance: 150_000n, maxObligation: 100_000n }),
    );
    expect(deposit).toEqual({
      ok: false,
      projectedBalance: 200_000n,
      maxObligation: 100_000n,
      maximumAdditionalDeposit: 0n,
    });
  });

  it('fails open when either read-only RPC/decode reader throws', async () => {
    const unavailable = async (): Promise<never> => {
      throw new Error('offline test: RPC unavailable');
    };

    expect(
      await preflightV2CreateCoverage(LIVE_TERMS, unavailable),
    ).toBeNull();
    expect(
      await preflightV2DepositCoverage(50_000n, unavailable),
    ).toBeNull();
  });
});
