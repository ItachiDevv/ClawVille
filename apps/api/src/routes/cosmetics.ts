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
import { eq, and, or, isNull, gt, lte, inArray } from 'drizzle-orm';
import {
  db,
  cosmeticSkus,
  cosmeticVariants,
  avatarSkins,
  avatars,
} from '@clawville/database';
import { requireAuth, sessionMiddleware } from '../middleware/auth';
import { requireNonGuestUser } from '../middleware/require-non-guest';
import { logEventFromContext } from '../services/event-logger';
import { creditClawTokens, debitClawTokens, InsufficientTokensError } from '../services/claw-token-ledger';
import { getHouseTreasuryAvatarId } from '../services/house-treasury-seeder';
import type { AppContext } from '../types';

export const cosmeticsRoutes = new Hono<AppContext>();

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

async function getCallerAvatar(userId: string) {
  const avatar = await db.query.avatars.findFirst({
    where: and(eq(avatars.userId, userId), eq(avatars.isActive, true)),
  });
  if (!avatar) throw new HTTPException(404, { message: 'No active avatar found' });
  return avatar;
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
  const conditions = [
    or(isNull(cosmeticSkus.availableFrom), lte(cosmeticSkus.availableFrom, now)),
    or(isNull(cosmeticSkus.availableUntil), gt(cosmeticSkus.availableUntil, now)),
  ];
  if (scope) conditions.push(eq(cosmeticSkus.scope, scope));

  const rows = await db
    .select()
    .from(cosmeticSkus)
    .where(and(...conditions))
    .orderBy(cosmeticSkus.createdAt);

  // Empty supply_cap and full supply_cap — for full check we'd join avatar_skins
  // with COUNT; defer until Phase 4 (storefront) since the empty-catalog Phase 3
  // launch doesn't have items hitting their caps. Plain SKUs only for now.
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

cosmeticsRoutes.get('/owned', sessionMiddleware, requireAuth, async (c) => {
  const user = c.get('user') as { id: string };
  const avatar = await getCallerAvatar(user.id);

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
    .where(eq(avatarSkins.avatarId, avatar.id))
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
});

// ---------------------------------------------------------------------------
// POST /:skuId/equip + /:skuId/unequip — auth'd
// ---------------------------------------------------------------------------

async function setEquipped(
  c: any,
  skuId: string,
  userId: string,
  equipped: boolean,
) {
  if (!uuidRegex.test(skuId)) {
    throw new HTTPException(400, { message: 'Invalid skuId' });
  }
  const avatar = await getCallerAvatar(userId);

  // Update only if the row exists (idempotent — equipping an already-
  // equipped SKU returns the same row, no toggle).
  const result = await db
    .update(avatarSkins)
    .set({
      equipped,
      equippedAt: equipped ? new Date() : null,
    })
    .where(and(eq(avatarSkins.avatarId, avatar.id), eq(avatarSkins.skuId, skuId)))
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
    userId,
    avatarId: avatar.id,
    payload: { skuId, equippedAt: equipped ? new Date().toISOString() : null },
  });

  return c.json({ ok: true, equipped: result[0].equipped });
}

cosmeticsRoutes.post('/:skuId/equip', sessionMiddleware, requireAuth, async (c) => {
  const user = c.get('user') as { id: string };
  return setEquipped(c, c.req.param('skuId'), user.id, true);
});

cosmeticsRoutes.post('/:skuId/unequip', sessionMiddleware, requireAuth, async (c) => {
  const user = c.get('user') as { id: string };
  return setEquipped(c, c.req.param('skuId'), user.id, false);
});

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

cosmeticsRoutes.post('/:skuId/buy', sessionMiddleware, requireAuth, requireNonGuestUser, async (c) => {
  const user = c.get('user') as { id: string };
  const skuId = c.req.param('skuId');

  if (!uuidRegex.test(skuId)) {
    throw new HTTPException(400, { message: 'Invalid skuId' });
  }

  // SKU must exist and be currently available (window check).
  const sku = await db.query.cosmeticSkus.findFirst({
    where: eq(cosmeticSkus.id, skuId),
  });
  if (!sku) throw new HTTPException(404, { message: 'Cosmetic not found' });

  const now = new Date();
  if (sku.availableFrom && sku.availableFrom > now) {
    throw new HTTPException(400, { message: 'Not yet available' });
  }
  if (sku.availableUntil && sku.availableUntil <= now) {
    throw new HTTPException(400, { message: 'No longer available' });
  }
  if (sku.exclusiveCurrency && sku.exclusiveCurrency !== 'CT') {
    // CLV / SOL / fiat exclusives are not buyable via this endpoint —
    // they go through a separate currency-specific path (Phase 4 follow-up).
    throw new HTTPException(400, {
      message: `This item must be purchased with ${sku.exclusiveCurrency}.`,
    });
  }

  const avatar = await getCallerAvatar(user.id);

  // Idempotent: already owned ⇒ 200 with `{ alreadyOwned: true }`.
  const existing = await db
    .select({ id: avatarSkins.id, equipped: avatarSkins.equipped })
    .from(avatarSkins)
    .where(and(eq(avatarSkins.avatarId, avatar.id), eq(avatarSkins.skuId, skuId)))
    .limit(1);
  if (existing.length > 0) {
    return c.json({
      ok: true,
      alreadyOwned: true,
      avatarSkinId: existing[0].id,
      equipped: existing[0].equipped,
      clawTokens: avatar.clawTokens,
    });
  }

  // Atomic debit + insert.
  let result: { balanceAfter: number; avatarSkinId: string };
  try {
    result = await db.transaction(async (tx) => {
      const debit = await debitClawTokens(
        {
          avatarId: avatar.id,
          amount: sku.priceCt,
          reason: 'buy_cosmetic',
          source: 'api',
          metadata: { skuId, slug: sku.slug, category: sku.category },
        },
        tx,
      );
      // ── T0 fee routing (2026-07-07): shop revenue → house treasury ──────
      // The purchase debit previously burned to nobody. Credit the SAME price
      // to the house treasury IN THIS SAME tx (debit + credit = net-neutral
      // supply; the CT moves player→treasury instead of vanishing). Buyer-side
      // amount UNCHANGED. The `alreadyOwned` idempotent replay returns before
      // this tx, so a re-buy never re-credits. A null treasury (unavailable)
      // degrades to the pre-T0 burn — never blocks the purchase.
      if (Number.isInteger(sku.priceCt) && sku.priceCt > 0) {
        const treasuryId = await getHouseTreasuryAvatarId();
        if (treasuryId) {
          await creditClawTokens(
            {
              avatarId: treasuryId,
              amount: sku.priceCt,
              reason: 'house_fee_cosmetic_purchase',
              source: 'system',
              metadata: { skuId, slug: sku.slug, buyerAvatarId: avatar.id },
            },
            tx,
          );
        } else {
          console.error(
            `[cosmetics] house treasury unavailable — ${sku.priceCt} CT purchase burned (pre-T0 behavior) for sku ${skuId}`,
          );
        }
      }
      const [row] = await tx
        .insert(avatarSkins)
        .values({
          avatarId: avatar.id,
          skuId: sku.id,
          acquiredVia: 'shop_ct',
          ledgerId: debit.ledgerId,
          equipped: false,
        })
        .returning({ id: avatarSkins.id });
      return { balanceAfter: debit.balanceAfter, avatarSkinId: row.id };
    });
  } catch (err) {
    if (err instanceof InsufficientTokensError) {
      throw new HTTPException(400, {
        message: `Not enough ClawTokens. Need ${sku.priceCt}, have ${avatar.clawTokens}.`,
      });
    }
    throw err;
  }

  void logEventFromContext(c, {
    eventType: 'cosmetic.purchased',
    userId: user.id,
    avatarId: avatar.id,
    payload: {
      skuId: sku.id,
      slug: sku.slug,
      category: sku.category,
      pricePaid: sku.priceCt,
      balanceAfter: result.balanceAfter,
    },
  });

  return c.json({
    ok: true,
    alreadyOwned: false,
    avatarSkinId: result.avatarSkinId,
    clawTokens: result.balanceAfter,
  });
});
