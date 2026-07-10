/**
 * Pure mirrors of the deployed 0.25-family V2 escrow coverage arithmetic.
 * No RPC, custody, signing, or transaction construction belongs in this module.
 */

export const V2_MIN_STAKE_LAMPORTS = 100_000_000n;
export const V2_STAKE_COVERAGE_BPS = 5_000n;
const V2_BPS_DENOMINATOR = 10_000n;

export interface V2EscrowCoverageTerms {
  pricePerCall: bigint;
  maxCalls: bigint;
  initialDeposit: bigint;
}

/**
 * Exact mirror of deployed `create_escrow_v2` stake coverage.
 * Source: OOBE-PROTOCOL/synapse-sap commit
 * 55d29edeafebf5fd11ee6c7a63935625cfe98b1b,
 * programs/synapse-agent-sap/src/instructions/escrow_v2.rs:107-124,238-240.
 * Token amounts remain raw mint base units; there is no decimal/oracle conversion.
 * Create intentionally permits initialDeposit above maxObligation.
 */
export function computeV2EscrowCoverageLimit(
  terms: V2EscrowCoverageTerms,
): { maxObligation: bigint; requiredStakeLamports: bigint } {
  const maxObligation =
    terms.maxCalls === 0n ? terms.initialDeposit : terms.pricePerCall * terms.maxCalls;
  const proportionalStake =
    (maxObligation * V2_STAKE_COVERAGE_BPS) / V2_BPS_DENOMINATOR;
  return {
    maxObligation,
    requiredStakeLamports:
      proportionalStake > V2_MIN_STAKE_LAMPORTS
        ? proportionalStake
        : V2_MIN_STAKE_LAMPORTS,
  };
}

export function checkV2EscrowCoverage(
  stakeLamports: bigint,
  terms: V2EscrowCoverageTerms,
): ReturnType<typeof computeV2EscrowCoverageLimit> & {
  ok: boolean;
  additionalStakeLamports: bigint;
} {
  const requirement = computeV2EscrowCoverageLimit(terms);
  return {
    ...requirement,
    ok: stakeLamports >= requirement.requiredStakeLamports,
    additionalStakeLamports:
      stakeLamports >= requirement.requiredStakeLamports
        ? 0n
        : requirement.requiredStakeLamports - stakeLamports,
  };
}

/** Mirror of escrow_v2.rs:325-337: current balance + amount <= max_obligation. */
export function checkV2EscrowDepositCoverage(input: {
  balance: bigint;
  amount: bigint;
  maxObligation: bigint;
}): {
  ok: boolean;
  projectedBalance: bigint;
  maxObligation: bigint;
  maximumAdditionalDeposit: bigint;
} {
  const projectedBalance = input.balance + input.amount;
  const ok = input.maxObligation === 0n || projectedBalance <= input.maxObligation;
  return {
    ok,
    projectedBalance,
    maxObligation: input.maxObligation,
    maximumAdditionalDeposit:
      input.balance < input.maxObligation ? input.maxObligation - input.balance : 0n,
  };
}

export type V2CreateCoveragePreflight =
  | { state: 'missing_stake' }
  | {
      state: 'checked';
      stakeLamports: bigint;
      verdict: ReturnType<typeof checkV2EscrowCoverage>;
    };

/**
 * Execute the create coverage mirror against an injected read. A thrown read or
 * decode is uncertainty and returns null (fail open); a null account is a definite
 * missing-stake result that a live caller may make actionable.
 */
export async function preflightV2CreateCoverage(
  terms: V2EscrowCoverageTerms,
  readStakeLamports: () => Promise<bigint | null>,
): Promise<V2CreateCoveragePreflight | null> {
  try {
    const stakeLamports = await readStakeLamports();
    if (stakeLamports === null) return { state: 'missing_stake' };
    return {
      state: 'checked',
      stakeLamports,
      verdict: checkV2EscrowCoverage(stakeLamports, terms),
    };
  } catch {
    return null;
  }
}

/**
 * Execute the deposit cap mirror against an injected read. Missing, thrown, or
 * undecodable state returns null so this UX preflight can never become a security
 * gate stricter than the authoritative program.
 */
export async function preflightV2DepositCoverage(
  amount: bigint,
  readEscrow: () => Promise<{ balance: bigint; maxObligation: bigint } | null>,
): Promise<ReturnType<typeof checkV2EscrowDepositCoverage> | null> {
  try {
    const escrow = await readEscrow();
    if (!escrow) return null;
    return checkV2EscrowDepositCoverage({ ...escrow, amount });
  } catch {
    return null;
  }
}
