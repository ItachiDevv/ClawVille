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
