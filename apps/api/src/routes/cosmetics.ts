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


import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { eq, and, or, isNull, gt, lt, lte, inArray, ne, sql } from 'drizzle-orm';
import { REWARD_ONLY_COSMETIC_CURRENCY } from '@clawville/shared';
import {
  db,
  cosmeticSkus,
  cosmeticVariants,
  avatarSkins,
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
import {
  buyCosmeticForActor,
  setCosmeticEquippedForActor,
  type CosmeticActionFailure,
  type CosmeticActor,
  type CosmeticEventMeta,
} from '../services/cosmetic-actions';

// The shared purchase helpers (SKU validation, ownership probe, idempotent
// grant) moved to `services/cosmetic-actions.ts` on 2026-10-22 so the hosted-
// agent `[ACTION:]` executor runs the same buy/equip logic with no Hono
// Context. Re-exported here for any importer of the old location.
export {
  checkSkuPurchasable,
  findOwnedSkin,
  grantSkinInTx,
  CosmeticSoldOutError,
  type SkuPurchasabilityCheck,
} from '../services/cosmetic-actions';

export const cosmeticsRoutes = new Hono<ActivityAuthContext>();

// ---------------------------------------------------------------------------
// Request -> service adapters
// ---------------------------------------------------------------------------

/** The REST identity as a service actor (middleware already resolved it). */
function actorFromIdentity(identity: ActivityIdentity): CosmeticActor {
  return identity.kind === 'agent'
    ? {
        kind: 'agent',
        userId: identity.userId,
        avatarId: identity.avatarId,
        agentId: identity.agentId,
        ledgerCapable: identity.ledgerCapable,
      }
    : { kind: 'user', userId: identity.userId, avatarId: identity.avatarId, agentId: null };
}

/** The anti-farm tags `logEventFromContext` used to read from the request. */
function eventMetaFromContext(c: Context<ActivityAuthContext>): CosmeticEventMeta {
  const fpHash: unknown = c.get('fpHash');
  const ipPrefixHash: unknown = c.get('ipPrefixHash');
  return {
    fpHash: typeof fpHash === 'string' ? fpHash : null,
    ipPrefixHash: typeof ipPrefixHash === 'string' ? ipPrefixHash : null,
  };
}

/** A failure WITH a body was always a JSON response; without one, the route
 *  always threw an HTTPException. Keep that split byte-identical. */
function failureResponse(c: Context<ActivityAuthContext>, failure: CosmeticActionFailure) {
  if (failure.body) {
    return c.json(failure.body, failure.status as 403 | 404 | 409);
  }
  throw new HTTPException(failure.status as 400 | 403 | 404, { message: failure.message });
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
//
// Logic lives in `setCosmeticEquippedForActor` (services/cosmetic-actions.ts),
// shared with the hosted-agent `equip_cosmetic` verb. It logs
// `cosmetic.equipped` / `cosmetic.unequipped` against the bound avatar.

async function setEquipped(c: Context<ActivityAuthContext>, equipped: boolean) {
  const result = await setCosmeticEquippedForActor(
    actorFromIdentity(c.get('identity')),
    c.req.param('skuId') ?? '',
    equipped,
    eventMetaFromContext(c),
  );
  if (!result.ok) return failureResponse(c, result);
  return c.json({ ok: true, equipped: result.equipped });
}

cosmeticsRoutes.post(
  '/:skuId/equip',
  sessionMiddleware,
  requireAuthOrAgentSession,
  requireLedgerCapableIdentity,
  async (c) => setEquipped(c, true),
);

cosmeticsRoutes.post(
  '/:skuId/unequip',
  sessionMiddleware,
  requireAuthOrAgentSession,
  requireLedgerCapableIdentity,
  async (c) => setEquipped(c, false),
);

// ---------------------------------------------------------------------------
// POST /:skuId/buy — auth'd
// ---------------------------------------------------------------------------
//
// Spends ClawTokens to acquire the SKU and inserts an avatar_skins row.
// Idempotent: re-buying an already-owned SKU returns 200 with
// `{ alreadyOwned: true }` and does NOT debit again. The atomic bonus-draw +
// debit + treasury credit + grant, and the `cosmetic.purchased` event, live in
// `buyCosmeticForActor` (services/cosmetic-actions.ts), shared with the
// hosted-agent `buy_cosmetic` verb.

cosmeticsRoutes.post(
  '/:skuId/buy',
  sessionMiddleware,
  requireAuthOrAgentSession,
  requireLedgerCapableIdentity,
  requireNonGuestIdentity,
  async (c) => {
    const result = await buyCosmeticForActor(
      actorFromIdentity(c.get('identity')),
      { skuId: c.req.param('skuId') ?? '' },
      eventMetaFromContext(c),
    );
    if (!result.ok) return failureResponse(c, result);
    return c.json(result.body);
  },
);
