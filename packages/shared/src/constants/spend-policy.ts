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

/**
 * "Ask me before each payment" (founder go 2026-11-06). When the human turns it
 * on, every paid-tool request from the agent waits for the human to approve or
 * decline it in the wallet panel. A waiting request expires after this time.
 */
export const SPEND_APPROVAL_TTL_MS = 15 * 60_000;
/** Waiting requests per avatar at one time (MCP and REST). The hosted verb waits for one. */
export const SPEND_APPROVAL_MAX_AWAITING = 5;

/** Status of one paid-tool request (`vendor_call_requests.status`). */
export const VENDOR_CALL_STATUSES = ['awaiting_approval', 'pending', 'done', 'failed', 'declined', 'expired'] as const;
export type VendorCallStatus = (typeof VENDOR_CALL_STATUSES)[number];

/** One request that waits for the human, as the Approvals list shows it. */
export interface VendorCallApprovalView {
  requestId: string;
  vendor: SpendVendorId;
  /** The agent's own text. Untrusted: show it as plain text only. */
  prompt: string;
  model: string | null;
  /** 'account' = the human's own Studios key pays; 'wallet' = the avatar wallet pays. */
  mode: 'wallet' | 'account';
  surface: 'api' | 'hosted';
  /** Wallet mode: the most this call can cost (the price comes at approve). Null in account mode. */
  maxUsdCents: number | null;
  createdAt: string;
  expiresAt: string;
}

export interface SpendPolicyView {
  /** Total paid per UTC day, in US cents; null = the human has not set it. */
  dailyCapUsdCents: number | null;
  /** Largest single paid call, in US cents; null = the human has not set it. */
  perCallCapUsdCents: number | null;
  allowedVendors: SpendVendorId[];
  /** Images per UTC day with the human's own Studios key (default when not set). */
  studiosKeyImagesPerDay: number;
  /** "Ask me before each payment": every agent request waits for the human. */
  requireApproval: boolean;
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
  requireApproval: boolean;
}

/**
 * True when `next` lets the agent spend more than `current` (phase 1b): a cap
 * goes from unset to set, a cap goes up, a vendor is added, the Studios
 * own-key image count goes up, or "ask me before each payment" goes from on
 * to off (turning it on only tightens). A raise needs a
 * signature from the human's linked wallet; a lower or equal change does not.
 * Setting a cap to unset (null) is a lower change: an unset cap refuses every
 * paid call.
 */
export function isSpendPolicyRaise(current: SpendPolicyValues, next: SpendPolicyValues): boolean {
  const capRaised = (from: number | null, to: number | null) => to !== null && (from === null || to > from);
  if (capRaised(current.dailyCapUsdCents, next.dailyCapUsdCents)) return true;
  if (capRaised(current.perCallCapUsdCents, next.perCallCapUsdCents)) return true;
  if (next.studiosKeyImagesPerDay > current.studiosKeyImagesPerDay) return true;
  if (current.requireApproval && !next.requireApproval) return true;
  return next.allowedVendors.some((vendor) => !current.allowedVendors.includes(vendor));
}
