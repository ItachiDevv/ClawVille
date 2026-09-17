/**
 * Spend caps for the DoorDash operator path (frozen spec section 4.3, founder
 * ruling 2026-09-16).
 *
 * Every knob resolves at module load and CRASHES THE BOOT when it is out of
 * range. That is deliberate: a typo that silently widened a spend limit on the
 * founder's real card is exactly the failure this file exists to prevent.
 *
 * The environment may only ever make a cap TIGHTER. A value above the built-in
 * default is refused rather than clamped, because clamping hides the mistake
 * from whoever set it.
 */

/** Built-in ceilings. The environment may lower these and may never raise them. */
const DEFAULTS = {
  /** $75 per order, before tip is added at confirm time. */
  maxOrderCents: 7500,
  /** Founder lowered this from the proposed 3 on 2026-09-16. */
  dailyOrderCount: 2,
  /** $150 per UTC day, tip included. */
  dailySpendCents: 15000,
  /** A confirmation code is dead 10 minutes after the preview that minted it. */
  previewTtlMs: 600_000,
} as const;

/** Floors below which a cap stops being usable rather than merely strict. */
const FLOORS = { maxOrderCents: 1, dailyOrderCount: 1, dailySpendCents: 1, previewTtlMs: 60_000 } as const;

function resolve(name: string, fallback: number, floor: number): number {
  const raw = (process.env[name] ?? '').trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a whole number of units`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a safe integer`);
  if (value > fallback) throw new Error(`${name} may only lower the built-in cap of ${fallback}`);
  if (value < floor) throw new Error(`${name} must be at least ${floor}`);
  return value;
}

export const DOORDASH_CAPS = Object.freeze({
  maxOrderCents: resolve('DOORDASH_MAX_ORDER_USD_CENTS', DEFAULTS.maxOrderCents, FLOORS.maxOrderCents),
  dailyOrderCount: resolve('DOORDASH_DAILY_ORDER_COUNT', DEFAULTS.dailyOrderCount, FLOORS.dailyOrderCount),
  dailySpendCents: resolve('DOORDASH_DAILY_SPEND_USD_CENTS', DEFAULTS.dailySpendCents, FLOORS.dailySpendCents),
  previewTtlMs: resolve('DOORDASH_PREVIEW_TTL_MS', DEFAULTS.previewTtlMs, FLOORS.previewTtlMs),
});

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * The first cap this charge breaks, in the founder's words, or null if it fits.
 *
 * Lives HERE, beside the limits it enforces, rather than in the bridge. Two
 * reasons. It is cap logic, not ordering logic. And it is PURE, so the spec's
 * requirement to cover the exact boundary and one cent under can be met without
 * a database — importing the bridge to reach it would drag in the operator
 * identity resolved at module load, which is neither needed nor safe in a test.
 */
export function capRefusal(
  usage: { count: number; spentCents: number }, chargeCents: number,
): string | null {
  if (usage.count >= DOORDASH_CAPS.dailyOrderCount) {
    return `That would be order ${usage.count + 1} today and the limit is ${DOORDASH_CAPS.dailyOrderCount} a day.`;
  }
  if (chargeCents > DOORDASH_CAPS.maxOrderCents) {
    return `That order is ${formatUsd(chargeCents)} and the limit is ${formatUsd(DOORDASH_CAPS.maxOrderCents)} an order.`;
  }
  if (usage.spentCents + chargeCents > DOORDASH_CAPS.dailySpendCents) {
    return `That would bring today to ${formatUsd(usage.spentCents + chargeCents)} and the limit is ${formatUsd(DOORDASH_CAPS.dailySpendCents)} a day.`;
  }
  return null;
}
