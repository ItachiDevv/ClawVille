/**
 * Facilitator-selection policy for x402 settlement.
 *
 * PayAI remains the primary facilitator. Meridian is only considered after an
 * outage-class PayAI failure and, for outbound payments, while its percentage
 * treasury fee is no more expensive than PayAI's flat fee.
 */

/** PayAI charges $0.001 per settlement (USDC has six decimal places). */
export const PAYAI_FLAT_FEE_USDC_ATOMIC = 1_000n;

/** Meridian's treasury fee is one percent (100 basis points). */
export const MERIDIAN_TREASURY_FEE_BPS = 100;

/**
 * At $0.10, Meridian's 1% treasury fee equals PayAI's $0.001 flat fee.
 * Meridian must not be used for a larger outbound payment.
 */
export const MERIDIAN_OUTBOUND_CROSSOVER_USDC_ATOMIC = 100_000n;

/** Smallest zero-platform-fee gross whose post-treasury net is one vCLAW. */
export const MERIDIAN_MIN_CREDITABLE_GROSS_USDC_ATOMIC = 10_101n;

export type X402PaymentDirection = "inbound" | "outbound";

export interface MeridianFallbackPolicyInput {
  /** A usable Meridian URL and API key are both configured. */
  meridianEnabled: boolean;
  /** True only for a PayAI network error, timeout, or HTTP 5xx response. */
  payAiOutage: boolean;
  direction: X402PaymentDirection;
  grossUsdcAtomic: bigint;
}

interface ErrorWithTransportMetadata {
  name?: unknown;
  status?: unknown;
  /** The pinned @x402/core VerifyError/SettleError HTTP status field. */
  statusCode?: unknown;
}

/**
 * Classify the original facilitator-client error, before PayAI maps it to its
 * public failureReason vocabulary. Generic errors are deliberately terminal:
 * only an HTTP 5xx status or a fetch/abort timeout is an outage.
 */
export function isFacilitatorOutageError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as ErrorWithTransportMetadata;
  if (typeof candidate.status === "number") {
    return candidate.status >= 500 && candidate.status <= 599;
  }
  if (typeof candidate.statusCode === "number") {
    return candidate.statusCode >= 500 && candidate.statusCode <= 599;
  }

  if (error instanceof Error) {
    const pinnedStatus =
      /^Facilitator verify failed \((\d{3})\):/.exec(error.message);
    if (pinnedStatus) {
      const status = Number(pinnedStatus[1]);
      return status >= 500 && status <= 599;
    }
  }

  if (error instanceof TypeError) {
    // WHATWG fetch rejects transport failures with TypeError.
    return true;
  }

  return candidate.name === "AbortError" || candidate.name === "TimeoutError";
}

export function isMeridianEconomicalForOutbound(
  grossUsdcAtomic: bigint,
): boolean {
  return (
    grossUsdcAtomic >= MERIDIAN_MIN_CREDITABLE_GROSS_USDC_ATOMIC &&
    grossUsdcAtomic <= MERIDIAN_OUTBOUND_CROSSOVER_USDC_ATOMIC
  );
}

/**
 * Decide whether the already-failed PayAI attempt may fall back to Meridian.
 *
 * The caller deliberately supplies an outage boolean instead of an arbitrary
 * error string so payment-invalid failures cannot be accidentally reclassified
 * by fuzzy matching here.
 */
export function shouldFallbackToMeridian({
  meridianEnabled,
  payAiOutage,
  direction,
  grossUsdcAtomic,
}: MeridianFallbackPolicyInput): boolean {
  if (!meridianEnabled || !payAiOutage || grossUsdcAtomic <= 0n) {
    return false;
  }

  return (
    direction === "inbound" ||
    isMeridianEconomicalForOutbound(grossUsdcAtomic)
  );
}
