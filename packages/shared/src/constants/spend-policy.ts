/**
 * Spend rules for paid third-party tools (MCP hub step 2). The human owner of
 * an avatar sets these; the agent only reads them. Caps start unset, and an
 * unset cap refuses every paid call.
 */

/** Vendors a human can let their agent pay. Ids match ECOSYSTEM_CATALOG rows. */
export const SPEND_VENDOR_IDS = ['studios'] as const;
export type SpendVendorId = (typeof SPEND_VENDOR_IDS)[number];

/** Typo guard for one cap value: $1000. Not a product limit. */
export const SPEND_CAP_MAX_USD_CENTS = 100_000;

export interface SpendPolicyView {
  /** Total paid per UTC day, in US cents; null = the human has not set it. */
  dailyCapUsdCents: number | null;
  /** Largest single paid call, in US cents; null = the human has not set it. */
  perCallCapUsdCents: number | null;
  allowedVendors: SpendVendorId[];
  /** True only when both caps are set. Paid calls need this. */
  configured: boolean;
  updatedAt: string | null;
}

export function isSpendVendorId(value: string): value is SpendVendorId {
  return (SPEND_VENDOR_IDS as readonly string[]).includes(value);
}

/** The three values a human sets. Same shape as the PUT body. */
export interface SpendPolicyValues {
  dailyCapUsdCents: number | null;
  perCallCapUsdCents: number | null;
  allowedVendors: readonly string[];
}

/**
 * True when `next` lets the agent spend more than `current` (phase 1b): a cap
 * goes from unset to set, a cap goes up, or a vendor is added. A raise needs a
 * signature from the human's linked wallet; a lower or equal change does not.
 * Setting a cap to unset (null) is a lower change: an unset cap refuses every
 * paid call.
 */
export function isSpendPolicyRaise(current: SpendPolicyValues, next: SpendPolicyValues): boolean {
  const capRaised = (from: number | null, to: number | null) => to !== null && (from === null || to > from);
  if (capRaised(current.dailyCapUsdCents, next.dailyCapUsdCents)) return true;
  if (capRaised(current.perCallCapUsdCents, next.perCallCapUsdCents)) return true;
  return next.allowedVendors.some((vendor) => !current.allowedVendors.includes(vendor));
}
