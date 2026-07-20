/**
 * Q3 plan §4.2 — Cosmetic engine API.
 *
 * Three surfaces:
 *
 *   GET  /api/cosmetics/catalog?scope=...
 *        Public. Returns currently-purchasable SKUs filtered by availability
 *        window + supply cap + optional scope. Drives the (future) shop UI.
 *
 *   GET  /api/cosmetics/owned
 *        Auth'd. Returns the caller avatar's owned SKUs joined with equipped
 *        state + variants. Drives the in-game drawer (Phase 3.4).
 *
 *   POST /api/cosmetics/:skuId/equip      — toggle equipped=true (idempotent)
 *   POST /api/cosmetics/:skuId/unequip    — toggle equipped=false (idempotent)
 *        Auth'd. The cosmetic-loader (Phase 3.3) reads /owned with
 *        equipped=true on each render pass; no separate "render" event.
 *
 *   POST /api/cosmetics/:skuId/buy         — debit ClawTokens, insert avatar_skins.
 *        Auth'd. Idempotent: re-buying an owned SKU returns 200 with
 *        `{ alreadyOwned: true }` and does NOT debit again. Audited via
 *        claw_token_transactions (acquired_via='shop_ct', source='api').
 *        Added 2026-04-29 — pulled forward from Phase 4 to make the shop
 *        ship alongside the first non-surfboard cosmetic drop.
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { eq, and, or, isNull, gt, lt, lte, inArray, ne, sql } from 'drizzle-orm';
import { REWARD_ONLY_COSMETIC_CURRENCY } from '@clawville/shared';
import {
  db,
  cosmeticSkus,
  cosmeticVariants,
  avatarSkins,
  avatars,
} from '@clawville/database';
import { sessionMiddleware } from '../middleware/auth';
import {
  requireAuthOrAgentSession,
  requireLedgerCapableIdentity,
  type ActivityAuthContext,
  type ActivityIdentity,
} from '../middleware/require-auth-or-agent';
import { requireNonGuestIdentity } from '../middleware/require-non-guest';
import { noStorePrivate } from '../middleware/no-store';
import { logEventFromContext } from '../services/event-logger';
import { creditClawTokens, debitClawTokens, InsufficientTokensError, type LedgerTx } from '../services/claw-token-ledger';
import { getHouseTreasuryAvatarId } from '../services/house-treasury-seeder';
import { spendCosmeticBonusInTx } from '../services/cosmetic-signup-bonus';

export const cosmeticsRoutes = new Hono<ActivityAuthContext>();

// ---------------------------------------------------------------------------
// SHARED PURCHASE HELPERS (Tokenomics C checkout stage, 2026-07-07)
// ---------------------------------------------------------------------------
// The SKU validation + ownership check + skin grant were previously inlined in
// POST /:skuId/buy. They are extracted here so the CT balance-buy below AND
// the x402 USDC checkout fulfiller
// (`services/checkout-fulfillers/cosmetic-purchase.ts`) run the SAME
// validation and the SAME idempotent grant — two payment rails, one item
// path. HTTP-agnostic on purpose (typed codes, no HTTPException) so the
// fulfiller can map codes to checkout refusals.
//
// NOTE the two rails' MONEY MODELS differ by design and neither helper moves
// value: the balance-buy keeps its vCLAW debit + treasury credit; the USDC
// fulfiller debits/mints ZERO internal vCLAW (the buyer paid USDC — the
// treasury's revenue is the on-chain USDC→CLV buy queue, not a minted credit).

export type SkuPurchasabilityCheck =
  | { ok: true; sku: typeof cosmeticSkus.$inferSelect }
  | {
      ok: false;
      code: 'not_found' | 'not_yet_available' | 'no_longer_available' | 'wrong_currency' | 'sold_out';
      /** For wrong_currency: the currency the SKU demands. */
      requiredCurrency?: string;
    };

async function countCosmeticOwnerships(skuId: string, tx?: LedgerTx): Promise<number> {
  const runner = tx ?? db;
  const rows = await runner
    .select({ ownershipCount: sql<number>`COUNT(*)::integer` })
    .from(avatarSkins)
    .where(eq(avatarSkins.skuId, skuId))
    .limit(1);
  return Number(rows[0]?.ownershipCount ?? 0);
}

/**
 * Validate a SKU is purchasable RIGHT NOW on a CT-denominated rail: exists,
 * inside its availability window, and not exclusive to a non-CT currency.
 * Behavior-identical to the checks the balance-buy always ran. Read-only.
 */
export async function checkSkuPurchasable(skuId: string): Promise<SkuPurchasabilityCheck> {
  if (!skuIdSchema.safeParse(skuId).success) return { ok: false, code: 'not_found' };
  const sku = await db.query.cosmeticSkus.findFirst({ where: eq(cosmeticSkus.id, skuId) });
  if (!sku) return { ok: false, code: 'not_found' };
  if (sku.exclusiveCurrency === REWARD_ONLY_COSMETIC_CURRENCY) {
    return { ok: false, code: 'wrong_currency', requiredCurrency: REWARD_ONLY_COSMETIC_CURRENCY };
  }
  const now = new Date();
  if (sku.availableFrom && sku.availableFrom > now) {
    return { ok: false, code: 'not_yet_available' };
  }
  if (sku.availableUntil && sku.availableUntil <= now) {
    return { ok: false, code: 'no_longer_available' };
  }
  if (sku.exclusiveCurrency && sku.exclusiveCurrency !== 'CT') {
    // CLV / SOL / fiat exclusives are not buyable on either CT-denominated
    // rail (balance OR the ¢-pegged USDC checkout) — they go through a
    // currency-specific path (Phase 4 follow-up).
    return { ok: false, code: 'wrong_currency', requiredCurrency: sku.exclusiveCurrency };
  }
  // During a rolling deploy, an old pod can grant ownership after the migration
  // backfill but before every pod increments sold_count. Treat the live ledger
  // count as authoritative whenever it is ahead of the monotonic counter.
  if (sku.supplyCap !== null) {
    const ownershipCount = await countCosmeticOwnerships(skuId);
    if (Math.max(sku.soldCount, ownershipCount) >= sku.supplyCap) {
      return { ok: false, code: 'sold_out' };
    }
  }
  return { ok: true, sku };
}

/** Read-only ownership probe (outside or inside a tx). */
export async function findOwnedSkin(
  avatarId: string,
  skuId: string,
  tx?: LedgerTx,
): Promise<{ id: string; equipped: boolean } | null> {
  const runner = tx ?? db;
  const rows = await runner
    .select({ id: avatarSkins.id, equipped: avatarSkins.equipped })
    .from(avatarSkins)
    .where(and(eq(avatarSkins.avatarId, avatarId), eq(avatarSkins.skuId, skuId)))
    .limit(1);
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Idempotently grant a skin INSIDE the caller's transaction. Uses ON CONFLICT
 * DO NOTHING on the `uniq_avatar_skin_avatar_sku` index so a concurrent
 * double-grant can never 23505-poison the surrounding money tx — the loser
 * reads the winner's row and reports `alreadyOwned: true`. The caller decides
 * what alreadyOwned means for ITS money model (the balance-buy rolls back its
 * debit; the USDC fulfiller records a no-op grant — the payment already
 * settled).
 */
export async function grantSkinInTx(
  tx: LedgerTx,
  input: {
    avatarId: string;
    skuId: string;
    /** Provenance for revenue audits — 'shop_ct' | 'shop_usdc' | … */
    acquiredVia: string;
    /** Ledger row of the CT debit (balance-buy) — null on non-CT rails. */
    ledgerId: string | null;
  },
): Promise<{ avatarSkinId: string; alreadyOwned: boolean }> {
  let inserted: Array<{ id: string }>;
  try {
    inserted = await tx
      .insert(avatarSkins)
      .values({
        avatarId: input.avatarId,
        skuId: input.skuId,
        acquiredVia: input.acquiredVia,
        ledgerId: input.ledgerId,
        equipped: false,
      })
      .onConflictDoNothing({ target: [avatarSkins.avatarId, avatarSkins.skuId] })
      .returning({ id: avatarSkins.id });
  } catch (err) {
    const dbError = err as { code?: unknown; constraint_name?: unknown; constraint?: unknown };
    const constraint = dbError.constraint_name ?? dbError.constraint;
    if (dbError.code === '23514' && constraint === 'cosmetic_skus_supply_cap_enforced') {
      throw new CosmeticSoldOutError(input.skuId);
    }
    throw err;
  }
  if (inserted.length > 0) {
    // Migration 0032's AFTER INSERT trigger is the inventory boundary for
    // every writer, including old pods. It serializes on cosmetic_skus and
    // raises the named CHECK violation before a capped SKU can oversell.
    return { avatarSkinId: inserted[0].id, alreadyOwned: false };
  }
  const existing = await findOwnedSkin(input.avatarId, input.skuId, tx);
  if (!existing) {
    // Conflict fired yet no row visible — only possible if the owning tx is
    // still uncommitted elsewhere. Surface it; the caller's tx rolls back.
    throw new Error(`grantSkinInTx: conflict without visible row (avatar=${input.avatarId} sku=${input.skuId})`);
  }
  return { avatarSkinId: existing.id, alreadyOwned: true };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_SCOPES = new Set([
  'world',
  'avatar',
  'activity:reef-race',
  'activity:bumper-shells',
  'all',
]);

const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const skuIdSchema = z.string().regex(uuidRegex);

export class CosmeticSoldOutError extends Error {
  constructor(public readonly skuId: string) {
    super('cosmetic_sold_out');
    this.name = 'CosmeticSoldOutError';
  }
}

// ---------------------------------------------------------------------------
// GET /catalog — public
// ---------------------------------------------------------------------------
//
// Returns SKUs that are currently purchasable: availableFrom is null or in the
// past, AND availableUntil is null or in the future. Scope filter (?scope=)
// lets the shop UI show only world cosmetics, only reef-race cosmetics, etc.
// Drops `attribution` + `attribution_url` + `license_spdx` into the response
// so the shop card can render the "by [creator] on Sketchfab" credit.

cosmeticsRoutes.get('/catalog', async (c) => {
  const scopeQ = c.req.query('scope');
  const scope = scopeQ && VALID_SCOPES.has(scopeQ) ? scopeQ : null;

  const now = new Date();
  const actualOwnershipCount = sql<number>`(
    SELECT COUNT(*)::integer
    FROM ${avatarSkins}
    WHERE ${avatarSkins.skuId} = ${cosmeticSkus.id}
  )`;
  const effectiveSoldCount = sql<number>`GREATEST(
    ${cosmeticSkus.soldCount},
    ${actualOwnershipCount}
  )`;
  const conditions = [
    or(isNull(cosmeticSkus.availableFrom), lte(cosmeticSkus.availableFrom, now)),
    or(isNull(cosmeticSkus.availableUntil), gt(cosmeticSkus.availableUntil, now)),
    or(isNull(cosmeticSkus.supplyCap), lt(effectiveSoldCount, cosmeticSkus.supplyCap)),
    or(isNull(cosmeticSkus.exclusiveCurrency), ne(cosmeticSkus.exclusiveCurrency, REWARD_ONLY_COSMETIC_CURRENCY)),
  ];
  if (scope) conditions.push(eq(cosmeticSkus.scope, scope));

  const rows = await db
    .select()
    .from(cosmeticSkus)
    .where(and(...conditions))
    .orderBy(cosmeticSkus.createdAt);

  return c.json({
    catalog: rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      category: r.category,
      // thumbnailUrl was added to the SKU schema 2026-04-29 but never
      // exposed by either /catalog or /owned — the drawer fell back to
      // a category emoji for every item even when a thumbnail existed
      // on disk. Pass it through here so the shop card can render the
      // actual preview when present.
      thumbnailUrl: r.thumbnailUrl,
      scope: r.scope,
      displayName: r.displayName,
      description: r.description,
      rarity: r.rarity,
      priceCt: r.priceCt,
      exclusiveCurrency: r.exclusiveCurrency,
      attribution: r.attribution,
      attributionUrl: r.attributionUrl,
      licenseSpdx: r.licenseSpdx,
      availableUntil: r.availableUntil?.toISOString() ?? null,
      supplyCap: r.supplyCap,
    })),
    generatedAt: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// GET /owned — auth'd
// ---------------------------------------------------------------------------

cosmeticsRoutes.get(
  '/owned',
  sessionMiddleware,
  requireAuthOrAgentSession,
  requireLedgerCapableIdentity,
  noStorePrivate,
  async (c) => {
  const identity = c.get('identity');

  // Two-step: avatar_skins → cosmetic_skus → cosmetic_variants. Could be one
  // join, but the variants are an array per SKU — easier to assemble in JS
  // after two flat queries than to duplicate-row + group-by in SQL.
  const owned = await db
    .select({
      avatarSkin: avatarSkins,
      sku: cosmeticSkus,
    })
    .from(avatarSkins)
    .innerJoin(cosmeticSkus, eq(cosmeticSkus.id, avatarSkins.skuId))
    .where(eq(avatarSkins.avatarId, identity.avatarId))
    .orderBy(avatarSkins.acquiredAt);

  if (owned.length === 0) {
    return c.json({ owned: [], generatedAt: new Date().toISOString() });
  }

  const skuIds = owned.map((o) => o.sku.id);
  // Use drizzle's inArray helper — the previous `sql\`${col} = ANY(${arr})\``
  // form fed a raw JS array into postgres without proper array typing,
  // which crashes at runtime once skuIds is non-empty (latent bug from
  // Phase 3 launch when nobody had bought a cosmetic yet).
  const variants = await db
    .select()
    .from(cosmeticVariants)
    .where(inArray(cosmeticVariants.skuId, skuIds));

  const variantsBySku = new Map<string, typeof variants>();
  for (const v of variants) {
    const arr = variantsBySku.get(v.skuId) ?? [];
    arr.push(v);
    variantsBySku.set(v.skuId, arr);
  }

  return c.json({
    owned: owned.map(({ avatarSkin, sku }) => ({
      id: avatarSkin.id,
      acquiredAt: avatarSkin.acquiredAt.toISOString(),
      acquiredVia: avatarSkin.acquiredVia,
      equipped: avatarSkin.equipped,
      equippedAt: avatarSkin.equippedAt?.toISOString() ?? null,
      sku: {
        id: sku.id,
        slug: sku.slug,
        category: sku.category,
        thumbnailUrl: sku.thumbnailUrl,
        scope: sku.scope,
        displayName: sku.displayName,
        description: sku.description,
        rarity: sku.rarity,
        attribution: sku.attribution,
        attributionUrl: sku.attributionUrl,
        licenseSpdx: sku.licenseSpdx,
      },
      variants: (variantsBySku.get(sku.id) ?? []).map((v) => ({
        id: v.id,
        rigType: v.rigType,
        assetUrl: v.assetUrl,
        assetMeta: v.assetMeta,
      })),
    })),
    generatedAt: new Date().toISOString(),
  });
  },
);

// ---------------------------------------------------------------------------
// POST /:skuId/equip + /:skuId/unequip — auth'd
// ---------------------------------------------------------------------------

async function setEquipped(
  c: any,
  skuId: string,
  identity: ActivityIdentity,
  equipped: boolean,
) {
  if (!skuIdSchema.safeParse(skuId).success) {
    throw new HTTPException(400, { message: 'Invalid skuId' });
  }

  // Update only if the row exists (idempotent — equipping an already-
  // equipped SKU returns the same row, no toggle).
  const result = await db
    .update(avatarSkins)
    .set({
      equipped,
      equippedAt: equipped ? new Date() : null,
    })
    .where(and(eq(avatarSkins.avatarId, identity.avatarId), eq(avatarSkins.skuId, skuId)))
    .returning();

  if (result.length === 0) {
    return c.json(
      { ok: false, error: 'not_owned', message: 'You do not own this cosmetic.' },
      404,
    );
  }

  // Telemetry — equipping is a meaningful engagement signal. Fire-and-forget.
  void logEventFromContext(c, {
    eventType: equipped ? 'cosmetic.equipped' : 'cosmetic.unequipped',
    userId: identity.userId,
    avatarId: identity.avatarId,
    payload: { skuId, equippedAt: equipped ? new Date().toISOString() : null },
  });

  return c.json({ ok: true, equipped: result[0].equipped });
}

cosmeticsRoutes.post(
  '/:skuId/equip',
  sessionMiddleware,
  requireAuthOrAgentSession,
  requireLedgerCapableIdentity,
  async (c) => setEquipped(c, c.req.param('skuId'), c.get('identity'), true),
);

cosmeticsRoutes.post(
  '/:skuId/unequip',
  sessionMiddleware,
  requireAuthOrAgentSession,
  requireLedgerCapableIdentity,
  async (c) => setEquipped(c, c.req.param('skuId'), c.get('identity'), false),
);

// ---------------------------------------------------------------------------
// POST /:skuId/buy — auth'd
// ---------------------------------------------------------------------------
//
// Spends ClawTokens to acquire the SKU and inserts a avatar_skins row.
// Idempotent: re-buying an already-owned SKU returns 200 with
// `{ alreadyOwned: true }` and does NOT debit again.
//
// Atomicity: token debit + avatar_skins insert run inside a single
// db.transaction(). debitClawTokens accepts a tx parameter to compose into
// the same lock-scope so a failed insert rolls the debit back.

/** In-tx control-flow signal: the skin turned out to be owned AFTER the debit
 *  ran (a concurrent double-buy race). Thrown to roll the WHOLE tx back
 *  (debit + treasury credit included) and answer alreadyOwned — previously
 *  this race 23505'd into a 500. Module-private. */
class AlreadyOwnedRace extends Error {
  constructor(public readonly avatarSkinId: string) {
    super('cosmetic_already_owned_race');
    this.name = 'AlreadyOwnedRace';
  }
}

cosmeticsRoutes.post(
  '/:skuId/buy',
  sessionMiddleware,
  requireAuthOrAgentSession,
  requireLedgerCapableIdentity,
  requireNonGuestIdentity,
  async (c) => {
  const identity = c.get('identity');
  const skuId = c.req.param('skuId');
  const avatar = await db.query.avatars.findFirst({
    where: and(eq(avatars.id, identity.avatarId), eq(avatars.isActive, true)),
  });
  if (!avatar) throw new HTTPException(404, { message: 'No active avatar found' });

  // SKU must exist, be inside its availability window, and be CT-buyable —
  // the SAME shared check the USDC checkout fulfiller runs (extracted 2026-07-07).
  const purchasable = await checkSkuPurchasable(skuId);
  if (!purchasable.ok) {
    switch (purchasable.code) {
      case 'not_found':
        throw new HTTPException(
          uuidRegex.test(skuId) ? 404 : 400,
          { message: uuidRegex.test(skuId) ? 'Cosmetic not found' : 'Invalid skuId' },
        );
      case 'not_yet_available':
        throw new HTTPException(400, { message: 'Not yet available' });
      case 'no_longer_available':
        throw new HTTPException(400, { message: 'No longer available' });
      case 'wrong_currency':
        throw new HTTPException(400, {
          message: `This item must be purchased with ${purchasable.requiredCurrency}.`,
        });
      case 'sold_out': {
        // Idempotent retries by the owner of the final unit still succeed.
        const existing = await findOwnedSkin(avatar.id, skuId);
        if (existing) {
          return c.json({
            ok: true,
            alreadyOwned: true,
            avatarSkinId: existing.id,
            equipped: existing.equipped,
            clawTokens: avatar.clawTokens,
          });
        }
        return c.json({ error: 'sold_out' }, 409);
      }
    }
  }
  const sku = purchasable.sku;

  // Idempotent: already owned ⇒ 200 with `{ alreadyOwned: true }`.
  const existing = await findOwnedSkin(avatar.id, skuId);
  if (existing) {
    return c.json({
      ok: true,
      alreadyOwned: true,
      avatarSkinId: existing.id,
      equipped: existing.equipped,
      clawTokens: avatar.clawTokens,
    });
  }

  // Atomic bonus-draw + debit + insert.
  let result: { balanceAfter: number; avatarSkinId: string; grantUsed: number; realCt: number };
  try {
    result = await db.transaction(async (tx) => {
      // ── A2 cosmetics-scoped signup bonus (2026-07-07) ───────────────────
      // Draw the one-time signup-bonus grant FIRST (row-locked, in-tx). It is a
      // scoped promo that lives OUTSIDE avatars.clawTokens (schema/cosmetic-
      // bonus.ts), so it can only be spent HERE. Only the REAL-CT remainder is
      // debited from the buyer + routed to the treasury below — the grant
      // portion mints NOTHING (a house-eaten marketing expense). Rolls back with
      // the whole tx on any failure, so a failed purchase never consumes it.
      const grantUsed = await spendCosmeticBonusInTx(tx, identity.userId, sku.priceCt);
      const realCt = sku.priceCt - grantUsed;

      // Debit only the real-CT remainder. Skip entirely when the grant fully
      // covers the price (debitClawTokens rejects a non-positive amount).
      let debitLedgerId: string | null = null;
      let balanceAfter = avatar.clawTokens; // unchanged when fully grant-funded
      if (realCt > 0) {
        const debit = await debitClawTokens(
          {
            avatarId: avatar.id,
            amount: realCt,
            reason: 'buy_cosmetic',
            source: 'api',
            metadata: { skuId, slug: sku.slug, category: sku.category, grantUsed, priceCt: sku.priceCt },
            actorKind: identity.kind === 'user' ? 'human' : 'agent',
          },
          tx,
        );
        debitLedgerId = debit.ledgerId;
        balanceAfter = debit.balanceAfter;

        // ── T0 fee routing (2026-07-07): shop revenue → house treasury ────
        // Credit ONLY the real-CT remainder to the treasury (debit == credit =
        // net-neutral supply; the CT moves player→treasury). CONSERVATION: the
        // grant portion is NOT credited here — crediting the full priceCt while
        // only debiting realCt would MINT `grantUsed` into the treasury. Buyer-
        // side amount UNCHANGED. The `alreadyOwned` replay returns before this
        // tx, so a re-buy never re-credits. A null treasury degrades to the
        // pre-T0 burn — never blocks the purchase.
        const treasuryId = await getHouseTreasuryAvatarId();
        if (treasuryId) {
          await creditClawTokens(
            {
              avatarId: treasuryId,
              amount: realCt,
              reason: 'house_fee_cosmetic_purchase',
              source: 'system',
              metadata: { skuId, slug: sku.slug, buyerAvatarId: avatar.id, grantUsed, priceCt: sku.priceCt },
              actorKind: 'system',
            },
            tx,
          );
        } else {
          console.error(
            `[cosmetics] house treasury unavailable — ${realCt} CT purchase burned (pre-T0 behavior) for sku ${skuId}`,
          );
        }
      }

      // Shared idempotent grant (2026-07-07). ledgerId is null when fully
      // bonus-funded (no debit ledger row) — the cosmetic.purchased event
      // records grantUsed/realCt for the audit. If a concurrent buy won the
      // grant while we were debiting, roll the WHOLE tx back (debit +
      // treasury credit) and answer alreadyOwned instead of the old 23505→500.
      const grant = await grantSkinInTx(tx, {
        avatarId: avatar.id,
        skuId: sku.id,
        acquiredVia: 'shop_ct',
        ledgerId: debitLedgerId,
      });
      if (grant.alreadyOwned) {
        throw new AlreadyOwnedRace(grant.avatarSkinId);
      }
      return { balanceAfter, avatarSkinId: grant.avatarSkinId, grantUsed, realCt };
    });
  } catch (err) {
    if (err instanceof CosmeticSoldOutError) {
      return c.json({ error: 'sold_out' }, 409);
    }
    if (err instanceof AlreadyOwnedRace) {
      return c.json({
        ok: true,
        alreadyOwned: true,
        avatarSkinId: err.avatarSkinId,
        // The concurrent winner inserts with equipped:false; equip is a
        // separate endpoint, so this is exact, not a guess.
        equipped: false,
        clawTokens: avatar.clawTokens,
      });
    }
    if (err instanceof InsufficientTokensError) {
      // `err.requested` is the real-CT remainder we tried to debit (after the
      // bonus), `err.available` the buyer's balance — report those, not priceCt.
      throw new HTTPException(400, {
        message: `Not enough vCLAW. Need ${err.requested}, have ${err.available}.`,
      });
    }
    throw err;
  }

  void logEventFromContext(c, {
    eventType: 'cosmetic.purchased',
    userId: identity.userId,
    avatarId: avatar.id,
    payload: {
      skuId: sku.id,
      slug: sku.slug,
      category: sku.category,
      pricePaid: sku.priceCt,
      // A2 — split the price into the real CT charged vs the signup-bonus
      // covered portion (the treasury only received `realCt`).
      bonusApplied: result.grantUsed,
      realCtCharged: result.realCt,
      balanceAfter: result.balanceAfter,
    },
  });

  return c.json({
    ok: true,
    alreadyOwned: false,
    avatarSkinId: result.avatarSkinId,
    clawTokens: result.balanceAfter,
    // A2 — how much of the price the cosmetics signup bonus covered (0 when none).
    bonusApplied: result.grantUsed,
  });
  },
);
