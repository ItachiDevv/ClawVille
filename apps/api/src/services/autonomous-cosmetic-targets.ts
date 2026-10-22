/**
 * Bounded, server-derived "which cosmetics can I equip or buy right now"
 * projection for hosted cognition.
 *
 * WHY THIS EXISTS. `equip_cosmetic(skuId=...)` and `buy_cosmetic(skuId=...)`
 * take a uuid the deciding model cannot guess. Under the world-scope
 * consumption mandate a verb whose parameter space is invisible is the same
 * defect as a verb missing from the menu, so the decide prompt lists valid ids.
 *
 * Closed field list, no player prose, hard row cap. Mirrors
 * `autonomous-quest-targets.ts`: read-only, cheap, fail-soft at the caller.
 *
 * Purchasable means what `checkSkuPurchasable` (routes/cosmetics.ts) accepts,
 * NOT what GET /catalog lists: the catalog also lists CLV / SOL exclusives,
 * which the CT buy refuses. So the filter here is: inside the availability
 * window, below its supply cap (live ownership count wins over sold_count, as
 * in the catalog), and exclusive currency NULL or 'CT' (which also excludes
 * the REWARD_ONLY collectibles). SKUs the avatar already
 * owns are left out of the buy list.
 *
 * DAILY BUY CAP (2026-10-22). A hosted autonomous agent completes at most ONE
 * cosmetic purchase per avatar per rolling 24 hours. Without it the decide
 * loop bought the NEXT cheapest emote every ~30 s (an owned SKU drops out of
 * the list): five 200-vCLAW emotes in two minutes on production.
 * `readAutonomousCosmeticBuyWindow` is the shared source of truth: the
 * executor (npc-simulation `settleAutonomousCosmeticWalletAction`) refuses a
 * buy while the window is closed, and this reader empties `purchasable` and
 * sets `buyLockedUntil` so the prompt stops offering buys.
 */

import { db, sql } from '@clawville/database';
import { getCosmeticBonusRemaining } from './cosmetic-signup-bonus';

/** Total rows across both lists. Owned rows take at most OWNED_LIMIT of them. */
const TARGET_LIMIT = 6;
const OWNED_LIMIT = 3;
const NAME_MAX = 48;
/** Rolling window of the hosted-agent cosmetic buy cap. */
export const AUTONOMOUS_COSMETIC_BUY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface AutonomousCosmeticOwned {
  skuId: string;
  displayName: string;
  category: string;
}

export interface AutonomousCosmeticPurchasable {
  skuId: string;
  displayName: string;
  category: string;
  priceVclaw: number;
  /** True when the remaining cosmetic credit pays the whole price. */
  creditCovers: boolean;
  /** True when credit plus vCLAW balance pays the price. */
  affordable: boolean;
}

export interface AutonomousCosmeticTargets {
  vclawBalance: number;
  cosmeticCredit: number;
  ownedUnequipped: AutonomousCosmeticOwned[];
  purchasable: AutonomousCosmeticPurchasable[];
  /**
   * ISO time the next buy opens when this avatar bought a cosmetic in the last
   * 24 hours (`purchasable` is then empty). Null when a buy is open, and also
   * when the window could not be read (`purchasable` is then empty too).
   */
  buyLockedUntil: string | null;
}

export const EMPTY_AUTONOMOUS_COSMETIC_TARGETS: AutonomousCosmeticTargets = {
  vclawBalance: 0,
  cosmeticCredit: 0,
  ownedUnequipped: [],
  purchasable: [],
  buyLockedUntil: null,
};

export interface AutonomousCosmeticBuyWindow {
  /** True when this avatar has no vCLAW-shop cosmetic purchase in the last 24 hours. */
  allowed: boolean;
  /** ISO time the window opens again; null when `allowed`. */
  nextBuyAt: string | null;
}

/**
 * The cap's source of truth, read from the DB so it survives restarts.
 *
 * Looks for this avatar's newest `avatar_skins` row with
 * `acquired_via = 'shop_ct'` in the last 24 hours. `shop_ct` is the only value
 * `buyCosmeticForActor` (cosmetic-actions.ts) writes, for a buy paid in vCLAW,
 * with the signup cosmetic credit, or both. The USDC checkout (`shop_usdc`)
 * and rewards (`reward`) are other rails and do not count. The row is per
 * AVATAR, so a buy by the human owner and a buy by the hosted agent both close
 * the window (the conservative choice). An idempotent `alreadyOwned` replay
 * inserts no row.
 *
 * Throws on a DB error: the executor then refuses the buy (fail closed).
 */
export async function readAutonomousCosmeticBuyWindow(avatarId: string): Promise<AutonomousCosmeticBuyWindow> {
  const rows = await db.execute<{ acquired_at: Date | string | null }>(sql`
    SELECT acquired_at
    FROM avatar_skins
    WHERE avatar_id = ${avatarId}
      AND acquired_via = 'shop_ct'
      AND acquired_at > now() - interval '24 hours'
    ORDER BY acquired_at DESC
    LIMIT 1
  `);
  const row = Array.from(rows)[0];
  if (!row) return { allowed: true, nextBuyAt: null };
  const lastMs = row.acquired_at === null ? Number.NaN : new Date(row.acquired_at).getTime();
  // A row exists but its time is unreadable: stay closed for a full window.
  const opensAtMs = Number.isFinite(lastMs) ? lastMs + AUTONOMOUS_COSMETIC_BUY_WINDOW_MS : Date.now() + AUTONOMOUS_COSMETIC_BUY_WINDOW_MS;
  return { allowed: false, nextBuyAt: new Date(opensAtMs).toISOString() };
}

/** First-party catalog text, still bounded to one plain line. */
function safeName(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX);
}

export async function readAutonomousCosmeticTargets(input: {
  avatarId: string;
  userId: string;
}): Promise<AutonomousCosmeticTargets> {
  const [ownedRows, buyRows, balanceRows, cosmeticCredit, buyWindow] = await Promise.all([
    db.execute<{ sku_id: string; display_name: string; category: string }>(sql`
      SELECT s.id AS sku_id, s.display_name, s.category
      FROM avatar_skins a
      JOIN cosmetic_skus s ON s.id = a.sku_id
      WHERE a.avatar_id = ${input.avatarId} AND a.equipped = false
      ORDER BY a.acquired_at DESC
      LIMIT ${OWNED_LIMIT}
    `),
    db.execute<{ sku_id: string; display_name: string; category: string; price_ct: number | string }>(sql`
      SELECT s.id AS sku_id, s.display_name, s.category, s.price_ct
      FROM cosmetic_skus s
      WHERE (s.available_from IS NULL OR s.available_from <= now())
        AND (s.available_until IS NULL OR s.available_until > now())
        AND (s.exclusive_currency IS NULL OR s.exclusive_currency = 'CT')
        AND (
          s.supply_cap IS NULL
          OR GREATEST(
            s.sold_count,
            (SELECT COUNT(*)::integer FROM avatar_skins o WHERE o.sku_id = s.id)
          ) < s.supply_cap
        )
        AND NOT EXISTS (
          SELECT 1 FROM avatar_skins mine
          WHERE mine.avatar_id = ${input.avatarId} AND mine.sku_id = s.id
        )
      ORDER BY s.price_ct ASC, s.created_at ASC
      LIMIT ${TARGET_LIMIT}
    `),
    db.execute<{ claw_tokens: number | string }>(
      sql`SELECT claw_tokens FROM avatars WHERE id = ${input.avatarId}`,
    ),
    getCosmeticBonusRemaining(input.userId),
    // An unreadable window offers no buys (the executor fails closed too) but
    // keeps the equip list.
    readAutonomousCosmeticBuyWindow(input.avatarId).catch(
      (): AutonomousCosmeticBuyWindow => ({ allowed: false, nextBuyAt: null }),
    ),
  ]);

  const vclawBalance = Number(Array.from(balanceRows)[0]?.claw_tokens ?? 0) || 0;
  const credit = Number(cosmeticCredit) || 0;

  const ownedUnequipped = Array.from(ownedRows)
    .slice(0, OWNED_LIMIT)
    .map((row) => ({
      skuId: row.sku_id,
      displayName: safeName(row.display_name),
      category: safeName(row.category),
    }));

  const purchasable = (buyWindow.allowed ? Array.from(buyRows) : [])
    .slice(0, TARGET_LIMIT - ownedUnequipped.length)
    .map((row) => {
      const priceVclaw = Number(row.price_ct) || 0;
      return {
        skuId: row.sku_id,
        displayName: safeName(row.display_name),
        category: safeName(row.category),
        priceVclaw,
        creditCovers: credit >= priceVclaw,
        affordable: credit + vclawBalance >= priceVclaw,
      };
    });

  return {
    vclawBalance,
    cosmeticCredit: credit,
    ownedUnequipped,
    purchasable,
    buyLockedUntil: buyWindow.allowed ? null : buyWindow.nextBuyAt,
  };
}
