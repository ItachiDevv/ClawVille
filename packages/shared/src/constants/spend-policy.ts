/**
 * Spend rules for paid third-party tools (MCP hub step 2). The human owner of
 * an avatar sets these; the agent only reads them. Caps start unset, and an
 * unset cap refuses every paid call.
 */

/** Vendors a human can let their agent pay. Ids match ECOSYSTEM_CATALOG rows. */
export const SPEND_VENDOR_IDS = ['studios', 'said'] as const;
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
 * Studios operations ClawVille can run for an avatar (MCP hub phase 3b).
 * image + video: the human's own key or the avatar wallet (x402).
 * character_shots + recast: the human's own key only (Studios takes no x402
 * there). Chat completions are out of scope.
 */
export const STUDIOS_OPERATION_IDS = ['image', 'video', 'character_shots', 'recast'] as const;
export type StudiosOperationId = (typeof STUDIOS_OPERATION_IDS)[number];

/**
 * Per-UTC-day counts the human owns, one per operation class, counted in key
 * mode AND wallet mode (in addition to the USD caps). NULL in the database =
 * these defaults; 0 turns the class off. A raise needs the linked-wallet
 * signature. Images keep their own key-only count (above).
 */
export const STUDIOS_VIDEOS_PER_DAY_DEFAULT = 2;
export const STUDIOS_CHARACTER_SHOTS_PER_DAY_DEFAULT = 5;
export const STUDIOS_RECASTS_PER_DAY_DEFAULT = 1;
/** Typo guard for the class counts. Not a product limit. */
export const STUDIOS_CLASS_PER_DAY_MAX = 1_000;

/**
 * Who pays for a Studios call (MCP hub phase 3c, migration 0096), chosen by
 * the human:
 *   wallet  the avatar wallet pays with x402 inside the spend caps (image, video);
 *   key     the human's saved Studios API key, their Studios credits (every operation);
 *   signin  the human's Studios sign-in, their Studios credits (every operation,
 *           plus the My Media list and the account balance).
 * Null (not chosen) keeps the earlier rule: the saved key when there is one,
 * else the wallet. A chosen mode that is not usable refuses; it never falls
 * back. Any change needs the linked-wallet signature (it changes who pays).
 */
export const STUDIOS_PAY_MODES = ['wallet', 'key', 'signin'] as const;
export type StudiosPayMode = (typeof STUDIOS_PAY_MODES)[number];

/**
 * "Ask me before each payment" (founder go 2026-11-06). When the human turns it
 * on, every paid-tool request from the agent waits for the human to approve or
 * decline it in the wallet panel. A waiting request expires after this time.
 */
export const SPEND_APPROVAL_TTL_MS = 15 * 60_000;
/** Waiting requests per avatar at one time (MCP and REST). The hosted verb waits for one. */
export const SPEND_APPROVAL_MAX_AWAITING = 5;

/** Status of one paid-tool request (`vendor_call_requests.status`). */
/**
 * THE one list of Studios failure codes that may have charged (the wallet or
 * the human's Studios credits): our message says "may have" or the money
 * moved before the result was lost. Every rule that decides this reads it:
 * the server dedupe (the same input is blocked for 30 minutes), the per-day
 * class counts (such a failed row always counts) and the web forms (the same
 * input is not sent again). Never copy it.
 */
export const STUDIOS_MAY_HAVE_CHARGED_CODES = [
  'payment_ambiguous', 'image_missing', 'media_missing', 'outcome_unknown', 'result_lost', 'job_timeout',
] as const;
export type StudiosMayHaveChargedCode = (typeof STUDIOS_MAY_HAVE_CHARGED_CODES)[number];

export function isStudiosMayHaveCharged(code: string | null | undefined): code is StudiosMayHaveChargedCode {
  return typeof code === 'string' && (STUDIOS_MAY_HAVE_CHARGED_CODES as readonly string[]).includes(code);
}

export const VENDOR_CALL_STATUSES = ['awaiting_approval', 'pending', 'running', 'done', 'failed', 'ambiguous', 'declined', 'expired'] as const;
export type VendorCallStatus = (typeof VENDOR_CALL_STATUSES)[number];

/** One request that waits for the human, as the Approvals list shows it. */
export interface VendorCallApprovalView {
  requestId: string;
  vendor: SpendVendorId;
  /** Which Studios operation would run. */
  operation: StudiosOperationId;
  /** The agent's own text. Untrusted: show it as plain text only. */
  prompt: string;
  model: string | null;
  /** 'account' = the human's own Studios key pays; 'signin' = the human's Studios sign-in pays; 'wallet' = the avatar wallet pays. */
  mode: 'wallet' | 'account' | 'signin';
  surface: 'api' | 'hosted';
  /** Wallet mode: the most this call can cost (the price comes at approve). Null in account and signin mode. */
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
  /** Studios videos per UTC day, key and wallet mode (default when not set; 0 = off). */
  studiosVideosPerDay: number;
  /** Studios character-shot calls per UTC day (default when not set; 0 = off). */
  studiosCharacterShotsPerDay: number;
  /** Studios recasts per UTC day (default when not set; 0 = off). */
  studiosRecastsPerDay: number;
  /** "Ask me before each payment": every agent request waits for the human. */
  requireApproval: boolean;
  /** Who pays for Studios calls; null = the saved key if any, else the wallet. */
  studiosPayMode: StudiosPayMode | null;
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
  studiosVideosPerDay: number;
  studiosCharacterShotsPerDay: number;
  studiosRecastsPerDay: number;
  requireApproval: boolean;
  studiosPayMode: StudiosPayMode | null;
}

/**
 * True when `next` lets the agent spend more than `current` (phase 1b): a cap
 * goes from unset to set, a cap goes up, a vendor is added, the Studios
 * own-key image count or a Studios class count (videos, character shots,
 * recasts) goes up, "ask me before each payment" goes from on
 * to off (turning it on only tightens), or the Studios pay mode changes in
 * any direction (it changes who pays). A raise needs a
 * signature from the human's linked wallet; a lower or equal change does not.
 * Setting a cap to unset (null) is a lower change: an unset cap refuses every
 * paid call.
 */
export function isSpendPolicyRaise(current: SpendPolicyValues, next: SpendPolicyValues): boolean {
  const capRaised = (from: number | null, to: number | null) => to !== null && (from === null || to > from);
  if (capRaised(current.dailyCapUsdCents, next.dailyCapUsdCents)) return true;
  if (capRaised(current.perCallCapUsdCents, next.perCallCapUsdCents)) return true;
  if (next.studiosKeyImagesPerDay > current.studiosKeyImagesPerDay) return true;
  if (next.studiosVideosPerDay > current.studiosVideosPerDay) return true;
  if (next.studiosCharacterShotsPerDay > current.studiosCharacterShotsPerDay) return true;
  if (next.studiosRecastsPerDay > current.studiosRecastsPerDay) return true;
  if (current.requireApproval && !next.requireApproval) return true;
  if ((next.studiosPayMode ?? null) !== (current.studiosPayMode ?? null)) return true;
  return next.allowedVendors.some((vendor) => !current.allowedVendors.includes(vendor));
}
