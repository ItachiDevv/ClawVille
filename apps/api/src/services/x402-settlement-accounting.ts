import { MERIDIAN_TREASURY_FEE_BPS } from "./x402-facilitator-selection";

export const MERIDIAN_MAX_PLATFORM_FEE_BPS = 1_000;
const BASIS_POINTS_DENOMINATOR = 10_000n;

export interface X402SettlementAmounts {
  grossUsdcAtomic: bigint;
  platformFeeUsdcAtomic: bigint;
  treasuryFeeUsdcAtomic: bigint;
  netUsdcAtomic: bigint;
}

/**
 * Calculate Meridian's atomic three-way USDC split. The platform fee is taken
 * from gross first; Meridian's treasury fee is then taken from the remainder,
 * matching the captured on-chain instruction.
 */
export function calculateMeridianSettlementAmounts(
  grossUsdcAtomic: bigint,
  platformFeeBps: number,
): X402SettlementAmounts {
  if (grossUsdcAtomic <= 0n) {
    throw new Error("grossUsdcAtomic must be positive");
  }
  if (
    !Number.isSafeInteger(platformFeeBps) ||
    platformFeeBps < 0 ||
    platformFeeBps > MERIDIAN_MAX_PLATFORM_FEE_BPS
  ) {
    throw new Error(
      `platformFeeBps must be an integer between 0 and ${MERIDIAN_MAX_PLATFORM_FEE_BPS}`,
    );
  }

  const platformFeeUsdcAtomic =
    (grossUsdcAtomic * BigInt(platformFeeBps)) / BASIS_POINTS_DENOMINATOR;
  const afterPlatformFeeUsdcAtomic =
    grossUsdcAtomic - platformFeeUsdcAtomic;
  const treasuryFeeUsdcAtomic =
    (afterPlatformFeeUsdcAtomic * BigInt(MERIDIAN_TREASURY_FEE_BPS)) /
    BASIS_POINTS_DENOMINATOR;
  const netUsdcAtomic = afterPlatformFeeUsdcAtomic - treasuryFeeUsdcAtomic;

  if (netUsdcAtomic < 0n) {
    throw new Error("Meridian fees exceed gross settlement amount");
  }

  return {
    grossUsdcAtomic,
    platformFeeUsdcAtomic,
    treasuryFeeUsdcAtomic,
    netUsdcAtomic,
  };
}

export function assertSettlementAmountsConserved(
  amounts: X402SettlementAmounts,
): void {
  const {
    grossUsdcAtomic,
    platformFeeUsdcAtomic,
    treasuryFeeUsdcAtomic,
    netUsdcAtomic,
  } = amounts;

  if (
    grossUsdcAtomic <= 0n ||
    platformFeeUsdcAtomic < 0n ||
    treasuryFeeUsdcAtomic < 0n ||
    netUsdcAtomic < 0n ||
    grossUsdcAtomic !==
      netUsdcAtomic + platformFeeUsdcAtomic + treasuryFeeUsdcAtomic
  ) {
    throw new Error("x402 settlement amounts do not conserve gross USDC");
  }
}

/**
 * Old receipt callers only provide `amountUsdcAtomic`. Treat that amount as
 * both gross and net with zero fees, preserving pre-Meridian semantics.
 */
export function legacySettlementAmounts(
  amountUsdcAtomic: bigint,
): X402SettlementAmounts {
  const amounts = {
    grossUsdcAtomic: amountUsdcAtomic,
    platformFeeUsdcAtomic: 0n,
    treasuryFeeUsdcAtomic: 0n,
    netUsdcAtomic: amountUsdcAtomic,
  };
  assertSettlementAmountsConserved(amounts);
  return amounts;
}
