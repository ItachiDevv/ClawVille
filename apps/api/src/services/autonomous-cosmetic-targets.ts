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
 */

import { db, sql } from '@clawville/database';
import { getCosmeticBonusRemaining } from './cosmetic-signup-bonus';

/** Total rows across both lists. Owned rows take at most OWNED_LIMIT of them. */
const TARGET_LIMIT = 6;
const OWNED_LIMIT = 3;
const NAME_MAX = 48;

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
}

export const EMPTY_AUTONOMOUS_COSMETIC_TARGETS: AutonomousCosmeticTargets = {
  vclawBalance: 0,
  cosmeticCredit: 0,
  ownedUnequipped: [],
  purchasable: [],
};

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
  const [ownedRows, buyRows, balanceRows, cosmeticCredit] = await Promise.all([
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

  const purchasable = Array.from(buyRows)
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

  return { vclawBalance, cosmeticCredit: credit, ownedUnequipped, purchasable };
}
