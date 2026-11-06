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

/**
 * Studios images per UTC day on the human's OWN Studios key (the spend caps do
 * not cover Studios credits). The human sets it; a NULL column means this
 * default. Raising it above the saved value needs the linked-wallet signature,
 * like a cap raise. The wallet mode has no image count: the caps bound it.
 */
export const STUDIOS_KEY_IMAGES_PER_DAY_DEFAULT = 10;
/** Typo guard for the image count. Not a product limit. */
export const STUDIOS_KEY_IMAGES_PER_DAY_MAX = 1_000;

export interface SpendPolicyView {
  /** Total paid per UTC day, in US cents; null = the human has not set it. */
  dailyCapUsdCents: number | null;
  /** Largest single paid call, in US cents; null = the human has not set it. */
  perCallCapUsdCents: number | null;
  allowedVendors: SpendVendorId[];
  /** Images per UTC day with the human's own Studios key (default when not set). */
  studiosKeyImagesPerDay: number;
  /** True only when both caps are set. Paid calls need this. */
  configured: boolean;
  updatedAt: string | null;
}

export function isSpendVendorId(value: string): value is SpendVendorId {
  return (SPEND_VENDOR_IDS as readonly string[]).includes(value);
}

/** The values a human sets. Same shape as the PUT body. */
export interface SpendPolicyValues {
  dailyCapUsdCents: number | null;
  perCallCapUsdCents: number | null;
  allowedVendors: readonly string[];
  studiosKeyImagesPerDay: number;
}

/**
 * True when `next` lets the agent spend more than `current` (phase 1b): a cap
 * goes from unset to set, a cap goes up, a vendor is added, or the Studios
 * own-key image count goes up. A raise needs a
 * signature from the human's linked wallet; a lower or equal change does not.
 * Setting a cap to unset (null) is a lower change: an unset cap refuses every
 * paid call.
 */
export function isSpendPolicyRaise(current: SpendPolicyValues, next: SpendPolicyValues): boolean {
  const capRaised = (from: number | null, to: number | null) => to !== null && (from === null || to > from);
  if (capRaised(current.dailyCapUsdCents, next.dailyCapUsdCents)) return true;
  if (capRaised(current.perCallCapUsdCents, next.perCallCapUsdCents)) return true;
  if (next.studiosKeyImagesPerDay > current.studiosKeyImagesPerDay) return true;
  return next.allowedVendors.some((vendor) => !current.allowedVendors.includes(vendor));
}
