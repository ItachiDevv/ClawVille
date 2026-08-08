/**
 * P3 Slice 4 — "Run-a-store" service listings (`/api/land` routes 12-17).
 *
 * Three tiers of coverage, matching the fidelity the existing harness
 * supports (see `partner-storefront.test.ts` for the light/deterministic
 * style and `cove-blackjack.test.ts` for the DB-backed `describeIfDb()`
 * style — this file follows BOTH patterns in one file):
 *
 *   1. ZOD-SCHEMA MIRROR tests — pure `.safeParse()` calls, no HTTP, no DB.
 *      `land.ts` does NOT export its body/query schemas (and this diff is
 *      forbidden from touching `land.ts`'s route logic), so the exact
 *      shapes are reproduced here as documented mirrors. If `land.ts`'s
 *      `listServiceBodySchema` / `updateServiceBodySchema` /
 *      `buyServiceBodySchema` / `servicesPageQuerySchema` ever change,
 *      these mirrors must be updated in the same diff or they silently
 *      drift from the real contract — grep `land.ts` for those four names
 *      before touching either side.
 *
 *   2. ROUTING-INTEGRITY tests — a minimal Hono app mounts the REAL
 *      `landRoutes` (imported, not re-implemented) and asserts the parts of
 *      the contract that resolve BEFORE any database touch: invalid
 *      path/query shapes 400 pre-DB, and every write route is gated behind
 *      `requireAuthOrAgentSession` (401 with zero auth material). These run
 *      unconditionally — empirically verified `land.ts`'s import chain does
 *      NOT crash-load without DATABASE_URL/FINGERPRINT_SECRET/etc (unlike
 *      `partner-storefront.ts`'s chain, which the sibling test file guards
 *      with `ensureEnv`): `@clawville/database`'s `db` export is a lazy
 *      Proxy that only throws when a property is actually read, and none of
 *      `land.ts`'s other transitive deps (`npc-simulation`, `admin-only`,
 *      `room-registry`, `room-ticket`, `rate-limit`) throw at module load.
 *
 *   3. MONEY-PATH tests — DB-backed, gated behind `describeIfDb()` (skips
 *      when `DATABASE_URL` is unset, exactly like `cove-blackjack.test.ts` /
 *      `cove-slots.test.ts`). Covers the conservation invariant (buyer −P,
 *      seller +P, sum unchanged), idempotent replay (no double charge, no
 *      second `land.service.sold` event), self-purchase / insufficient-funds
 *      / listing-cap / ownership rejections, and the single-emission +
 *      seller-keyed assertion on the `land.service.sold` leaderboard event.
 *      A land_parcels + land_structures (shop) row is inserted DIRECTLY via
 *      Drizzle for test setup (bypassing the full buy+place-structure HTTP
 *      flow, which is already covered by the existing land-economy code and
 *      is orthogonal to what THIS slice adds).
 *
 * NOT covered here (deferred to staging e2e per the manager's brief): the
 * connected-agent (`X-Clawville-Agent-Session`) write path. `land.ts` routes
 * this slice's writes through the SAME `requireAuthOrAgentSession` every
 * other land route already uses (E5 parity is inherited, not new), so a
 * fresh agent-session harness here would duplicate coverage that belongs to
 * the agent-session middleware's own test surface, not this slice's tests.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import * as dbMod from '@clawville/database';
import { Hono } from 'hono';
import { z } from 'zod';
import { eq, inArray } from 'drizzle-orm';
import { landRoutes } from '../land';
import { authRoutes } from '../auth';
import { avatarRoutes } from '../avatars';
import { LAND_EVENT_TYPES } from '@clawville/shared';
import type { AppContext } from '../../types';

const HAS_DB = !!process.env.DATABASE_URL;
// Setup creates avatars through the real routes, which mint custodial wallets
// via the Cloudflare worker — without real worker creds (or with a sibling
// suite's 'example.invalid' placeholder) the hooks fail, so gate like HAS_DB.
const HAS_WALLET_INFRA =
  !!process.env.CLOUDFLARE_WORKER_URL &&
  !process.env.CLOUDFLARE_WORKER_URL.includes('example.invalid') &&
  !!process.env.CLOUDFLARE_WORKER_BEARER;
const describeIfDb = HAS_DB && HAS_WALLET_INFRA ? describe : describe.skip;

// ═════════════════════════════════════════════════════════════════════════
// 1. Zod-schema MIRROR tests (deterministic, no DB, no HTTP)
// ═════════════════════════════════════════════════════════════════════════

/** Mirrors `land.ts`'s (unexported) `listServiceBodySchema` — keep in sync. */
const listServiceBodySchemaMirror = z
  .object({
    title: z.string().trim().min(1).max(80),
    description: z.string().max(500).optional(),
    priceCt: z.number().int().nonnegative().max(1_000_000),
  })
  .strict();

/** Mirrors `land.ts`'s (unexported) `updateServiceBodySchema` — keep in sync. */
const updateServiceBodySchemaMirror = z
  .object({
    title: z.string().trim().min(1).max(80).optional(),
    description: z.string().max(500).optional(),
    priceCt: z.number().int().nonnegative().max(1_000_000).optional(),
    status: z.enum(['active', 'paused', 'delisted']).optional(),
  })
  .strict()
  .refine((val) => Object.keys(val).length > 0, {
    message: 'at least one field is required',
  });

/** Mirrors `land.ts`'s (unexported) `servicesPageQuerySchema` — keep in sync. */
const servicesPageQuerySchemaMirror = z
  .object({
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();

/** Mirrors `land.ts`'s (unexported) `buyServiceBodySchema` — keep in sync. */
const buyServiceBodySchemaMirror = z
  .object({
    idempotencyKey: z.string().min(8).max(64),
  })
  .strict();

describe('land services — zod schema mirrors (deterministic, no DB)', () => {
  describe('listServiceBodySchema', () => {
    it('accepts a minimal valid body (description optional)', () => {
      expect(listServiceBodySchemaMirror.safeParse({ title: 'Coaching', priceCt: 100 }).success).toBe(true);
    });
    it('rejects an empty title', () => {
      expect(listServiceBodySchemaMirror.safeParse({ title: '', priceCt: 100 }).success).toBe(false);
    });
    it('rejects a title over 80 chars', () => {
      expect(
        listServiceBodySchemaMirror.safeParse({ title: 'x'.repeat(81), priceCt: 100 }).success,
      ).toBe(false);
    });
    it('accepts a title at exactly 80 chars (boundary)', () => {
      expect(
        listServiceBodySchemaMirror.safeParse({ title: 'x'.repeat(80), priceCt: 100 }).success,
      ).toBe(true);
    });
    it('rejects a description over 500 chars', () => {
      expect(
        listServiceBodySchemaMirror.safeParse({
          title: 'Coaching',
          priceCt: 100,
          description: 'x'.repeat(501),
        }).success,
      ).toBe(false);
    });
    it('rejects a negative priceCt', () => {
      expect(listServiceBodySchemaMirror.safeParse({ title: 'Coaching', priceCt: -1 }).success).toBe(
        false,
      );
    });
    it('rejects priceCt over 1_000_000', () => {
      expect(
        listServiceBodySchemaMirror.safeParse({ title: 'Coaching', priceCt: 1_000_001 }).success,
      ).toBe(false);
    });
    it('accepts priceCt at exactly 1_000_000 (boundary) and 0 (free service)', () => {
      expect(
        listServiceBodySchemaMirror.safeParse({ title: 'Coaching', priceCt: 1_000_000 }).success,
      ).toBe(true);
      expect(listServiceBodySchemaMirror.safeParse({ title: 'Free', priceCt: 0 }).success).toBe(true);
    });
    it('rejects a non-integer priceCt', () => {
      expect(listServiceBodySchemaMirror.safeParse({ title: 'Coaching', priceCt: 1.5 }).success).toBe(
        false,
      );
    });
    it('rejects a stray key (.strict())', () => {
      expect(
        listServiceBodySchemaMirror.safeParse({
          title: 'Coaching',
          priceCt: 100,
          platformFeeBps: 500,
        }).success,
      ).toBe(false);
    });
  });

  describe('updateServiceBodySchema', () => {
    it('rejects an empty patch (refine — at least one field required)', () => {
      expect(updateServiceBodySchemaMirror.safeParse({}).success).toBe(false);
    });
    it('accepts a status-only patch', () => {
      expect(updateServiceBodySchemaMirror.safeParse({ status: 'paused' }).success).toBe(true);
    });
    it('accepts a priceCt-only patch', () => {
      expect(updateServiceBodySchemaMirror.safeParse({ priceCt: 50 }).success).toBe(true);
    });
    it('rejects an invalid status enum value', () => {
      expect(updateServiceBodySchemaMirror.safeParse({ status: 'sold_out' }).success).toBe(false);
    });
    it('rejects a stray key (.strict())', () => {
      expect(
        updateServiceBodySchemaMirror.safeParse({ status: 'paused', ownerAvatarId: 'x' }).success,
      ).toBe(false);
    });
  });

  describe('buyServiceBodySchema', () => {
    it('requires idempotencyKey (missing body field)', () => {
      expect(buyServiceBodySchemaMirror.safeParse({}).success).toBe(false);
    });
    it('rejects a key under 8 chars', () => {
      expect(buyServiceBodySchemaMirror.safeParse({ idempotencyKey: 'short' }).success).toBe(false);
    });
    it('accepts a key at exactly 8 chars (boundary)', () => {
      expect(buyServiceBodySchemaMirror.safeParse({ idempotencyKey: 'x'.repeat(8) }).success).toBe(
        true,
      );
    });
    it('rejects a key over 64 chars', () => {
      expect(buyServiceBodySchemaMirror.safeParse({ idempotencyKey: 'x'.repeat(65) }).success).toBe(
        false,
      );
    });
    it('accepts a key at exactly 64 chars (boundary) and a fresh UUID', () => {
      expect(buyServiceBodySchemaMirror.safeParse({ idempotencyKey: 'x'.repeat(64) }).success).toBe(
        true,
      );
      expect(
        buyServiceBodySchemaMirror.safeParse({ idempotencyKey: crypto.randomUUID() }).success,
      ).toBe(true);
    });
    it('rejects a stray key (.strict())', () => {
      expect(
        buyServiceBodySchemaMirror.safeParse({ idempotencyKey: 'x'.repeat(10), listingId: 'y' })
          .success,
      ).toBe(false);
    });
  });

  describe('servicesPageQuerySchema', () => {
    it('accepts page/limit as coerced query strings', () => {
      expect(servicesPageQuerySchemaMirror.safeParse({ page: '1', limit: '20' }).success).toBe(true);
    });
    it('accepts an empty query (both optional)', () => {
      expect(servicesPageQuerySchemaMirror.safeParse({}).success).toBe(true);
    });
    it('rejects page=0 (min 1)', () => {
      expect(servicesPageQuerySchemaMirror.safeParse({ page: '0' }).success).toBe(false);
    });
    it('rejects limit over 50', () => {
      expect(servicesPageQuerySchemaMirror.safeParse({ limit: '51' }).success).toBe(false);
    });
    it('accepts limit at exactly 50 (boundary)', () => {
      expect(servicesPageQuerySchemaMirror.safeParse({ limit: '50' }).success).toBe(true);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 2. Routing-integrity tests — real `landRoutes`, no DB touch expected
// ═════════════════════════════════════════════════════════════════════════

function buildRoutingApp() {
  const app = new Hono<AppContext>();
  app.use('*', async (c, next) => {
    c.set('fpHash', '');
    c.set('ipPrefixHash', '');
    await next();
  });
  app.route('/api/land', landRoutes);
  return app;
}

describe('land services — routing integrity + pre-DB validation', () => {
  it('GET /structures/:id/services with a non-uuid id -> 400 invalid_structure_id (no DB touch)', async () => {
    const app = buildRoutingApp();
    const res = await app.request('/api/land/structures/not-a-uuid/services');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe('invalid_structure_id');
  });

  it('GET /services with limit over 50 -> 400 invalid_query (no DB touch)', async () => {
    const app = buildRoutingApp();
    const res = await app.request('/api/land/services?limit=51');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe('invalid_query');
  });

  it('GET /services with page=0 -> 400 invalid_query (no DB touch)', async () => {
    const app = buildRoutingApp();
    const res = await app.request('/api/land/services?page=0');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe('invalid_query');
  });

  it('POST /structures/:id/services with NO auth material -> 401 (mounted under requireAuthOrAgentSession, no DB touch)', async () => {
    const app = buildRoutingApp();
    const res = await app.request(`/api/land/structures/${crypto.randomUUID()}/services`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': 'test-land-services-routing' },
      body: JSON.stringify({ title: 'x', priceCt: 1 }),
    });
    expect(res.status).toBe(401);
  });

  it('PATCH /services/:id with NO auth material -> 401 (no DB touch)', async () => {
    const app = buildRoutingApp();
    const res = await app.request(`/api/land/services/${crypto.randomUUID()}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'paused' }),
    });
    expect(res.status).toBe(401);
  });

  it('POST /services/:id/buy with NO auth material -> 401 (no DB touch)', async () => {
    const app = buildRoutingApp();
    const res = await app.request(`/api/land/services/${crypto.randomUUID()}/buy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: 'x'.repeat(10) }),
    });
    expect(res.status).toBe(401);
  });

  it('GET /services/mine with NO auth material -> 401 (mounted under requireAuthOrAgentSession, no DB touch)', async () => {
    const app = buildRoutingApp();
    const res = await app.request('/api/land/services/mine');
    expect(res.status).toBe(401);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 3. Money-path tests — DB-backed, describeIfDb()-gated
// ═════════════════════════════════════════════════════════════════════════

function buildApp() {
  const app = new Hono<AppContext>();
  app.use('*', async (c, next) => {
    c.set('fpHash', '');
    c.set('ipPrefixHash', '');
    await next();
  });
  app.route('/api/auth', authRoutes);
  app.route('/api/avatars', avatarRoutes);
  app.route('/api/land', landRoutes);
  return app;
}

describeIfDb('land services — money-path route tests (requires DATABASE_URL)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  // dbMod is the top-level ESM namespace import (bun test cannot resolve the
  // workspace package via CJS require(); ESM import works — same as every
  // other api test). describeIfDb still gates execution on DATABASE_URL.

  const TEST_TAG = `landsvc${Date.now()}`;
  const PASSWORD = 'landsvcpassword123';
  const SELLER_EMAIL = `${TEST_TAG}-seller@clawville-test.com`;
  const BUYER_EMAIL = `${TEST_TAG}-buyer@clawville-test.com`;
  const PAUPER_EMAIL = `${TEST_TAG}-pauper@clawville-test.com`;

  let app: ReturnType<typeof buildApp>;
  let sellerCookie = '';
  let buyerCookie = '';
  let pauperCookie = '';
  let sellerUserId = '';
  let buyerUserId = '';
  let pauperUserId = '';
  let sellerAvatarId = '';
  let buyerAvatarId = '';
  let pauperAvatarId = '';
  let shopStructureId = '';
  let capStructureId = '';

  async function signupAndCreateAvatar(email: string) {
    const signup = await app.request('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD, name: 'Land Svc Tester' }),
    });
    expect(signup.status).toBe(200);
    const cookieHeader = signup.headers.get('set-cookie') ?? '';
    const sessionCookie = cookieHeader.split(';')[0]!;

    // P2 (2026-07-04): signup AUTO-PROVISIONS the avatar and returns it — a
    // follow-up POST /api/avatars trips one-avatar-per-user 400. Use the
    // provisioned avatar; fall back to explicit create only if fail-soft
    // provisioning returned none.
    const signupData = (await signup.json()) as { avatar?: { id: string } };
    let avatarId = signupData.avatar?.id ?? '';
    if (!avatarId) {
      const avatarRes = await app.request('/api/avatars', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
        body: JSON.stringify({
          name: `LS${Date.now()}${Math.floor(Math.random() * 10000)}`,
          species: 'cat',
          color: 'green',
          gender: 'male',
          personality: { habitat: 'forest', hobby: 'exploring', greeting: 'wave-hello' },
        }),
      });
      expect(avatarRes.status).toBe(200);
      const avatarData = (await avatarRes.json()) as { avatar: { id: string } };
      avatarId = avatarData.avatar.id;
    }
    const userRow = await dbMod.db.query.users.findFirst({
      where: eq(dbMod.users.email, email),
    });
    if (!userRow) throw new Error(`test fixture: no users row for ${email}`);
    return {
      cookie: sessionCookie,
      userId: userRow.id as string,
      avatarId,
    };
  }

  /** Set an avatar's CT balance directly (mirrors cove-blackjack.test.ts's top-up pattern). */
  async function setBalance(avatarId: string, amount: number) {
    await dbMod.db
      .update(dbMod.avatars)
      .set({ clawTokens: amount, softBalance: amount, boughtBalance: 0, earnedBalance: 0 })
      .where(eq(dbMod.avatars.id, avatarId));
  }

  async function getBalance(avatarId: string): Promise<number> {
    const row = await dbMod.db.query.avatars.findFirst({ where: eq(dbMod.avatars.id, avatarId) });
    if (!row) throw new Error(`test fixture: no avatars row for ${avatarId}`);
    return row.clawTokens as number;
  }

  /** Insert an owned, active 'shop' structure directly (bypass the buy+place-structure HTTP flow). */
  let gridCounter = 0;
  async function insertOwnedShop(ownerAvatarId: string, tag: string): Promise<string> {
    gridCounter -= 2;
    const [parcel] = await dbMod.db
      .insert(dbMod.landParcels)
      .values({
        // varchar(32) cap: base36 ms (8ch) keeps this ~16 chars, not 34.
        parcelCode: `tsvc${Date.now().toString(36)}${tag}`,
        tier: 'c',
        status: 'owned',
        gridX: -9_000_000 + gridCounter,
        gridY: -9_000_000 + gridCounter,
        priceCt: 500,
        ownerAvatarId,
        tenure: 'owned',
        tenureTermsVersion: 1,
        acquiredAt: new Date(),
      })
      .returning();
    const [structure] = await dbMod.db
      .insert(dbMod.landStructures)
      .values({
        parcelId: parcel.id,
        ownerAvatarId,
        structureType: 'shop' as const,
        catalogKey: 'shop-stall',
        level: 1,
        status: 'active' as const,
      })
      .returning();
    return structure.id as string;
  }

  beforeAll(async () => {
    app = buildApp();
    const seller = await signupAndCreateAvatar(SELLER_EMAIL);
    sellerCookie = seller.cookie;
    sellerUserId = seller.userId;
    sellerAvatarId = seller.avatarId;

    const buyer = await signupAndCreateAvatar(BUYER_EMAIL);
    buyerCookie = buyer.cookie;
    buyerUserId = buyer.userId;
    buyerAvatarId = buyer.avatarId;

    const pauper = await signupAndCreateAvatar(PAUPER_EMAIL);
    pauperCookie = pauper.cookie;
    pauperUserId = pauper.userId;
    pauperAvatarId = pauper.avatarId;

    await setBalance(sellerAvatarId, 0);
    await setBalance(buyerAvatarId, 500);
    await setBalance(pauperAvatarId, 0);

    shopStructureId = await insertOwnedShop(sellerAvatarId, 'shop');
    capStructureId = await insertOwnedShop(sellerAvatarId, 'cap');
  });

  afterAll(async () => {
    if (!dbMod) return;
    const avatarIds = [sellerAvatarId, buyerAvatarId, pauperAvatarId].filter(Boolean);
    if (avatarIds.length > 0) {
      await dbMod.db
        .delete(dbMod.servicePurchases)
        .where(inArray(dbMod.servicePurchases.buyerAvatarId, avatarIds));
      await dbMod.db
        .delete(dbMod.serviceListings)
        .where(inArray(dbMod.serviceListings.ownerAvatarId, avatarIds));
      await dbMod.db
        .delete(dbMod.landStructures)
        .where(inArray(dbMod.landStructures.ownerAvatarId, avatarIds));
      await dbMod.db
        .delete(dbMod.landParcels)
        .where(inArray(dbMod.landParcels.ownerAvatarId, avatarIds));
    }
    for (const userId of [sellerUserId, buyerUserId, pauperUserId].filter(Boolean)) {
      await dbMod.db.delete(dbMod.avatars).where(eq(dbMod.avatars.userId, userId));
      await dbMod.db.delete(dbMod.users).where(eq(dbMod.users.id, userId));
    }
  });

  // ─── LIST (POST /structures/:id/services) ─────────────────────────────
  let mainListingId = '';

  it('a non-owner cannot list a service on someone else’s shop -> 403 not_structure_owner', async () => {
    const res = await app.request(`/api/land/structures/${shopStructureId}/services`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: buyerCookie },
      body: JSON.stringify({ title: 'Squatter service', priceCt: 10 }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error?: string }).error).toBe('not_structure_owner');
  });

  it('the shop owner lists a service -> 200 active, and it appears on the public structure read', async () => {
    const res = await app.request(`/api/land/structures/${shopStructureId}/services`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sellerCookie },
      body: JSON.stringify({ title: '1:1 Coaching', description: 'Live session', priceCt: 100 }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      listing: { id: string; status: string; ownerAvatarId: string; createdAt: string; updatedAt: string };
    };
    expect(data.listing.status).toBe('active');
    expect(data.listing.ownerAvatarId).toBe(sellerAvatarId);
    // Regression guard (2026-07-05 live-e2e 500): raw `tx.execute<>` returns
    // timestamps as STRINGS, so a bare `.toISOString()` on a Date-typed field
    // crashed this route. Assert the serialized dates are valid ISO strings.
    expect(typeof data.listing.createdAt).toBe('string');
    expect(Number.isNaN(Date.parse(data.listing.createdAt))).toBe(false);
    expect(typeof data.listing.updatedAt).toBe('string');
    expect(Number.isNaN(Date.parse(data.listing.updatedAt))).toBe(false);
    mainListingId = data.listing.id;

    // Public structure-scoped read reflects it immediately (cache-bust on write).
    const browse = await app.request(`/api/land/structures/${shopStructureId}/services`);
    expect(browse.status).toBe(200);
    const browseData = (await browse.json()) as { listings: { id: string }[] };
    expect(browseData.listings.some((l) => l.id === mainListingId)).toBe(true);
  });

  it('listing cap: the 7th active listing on a structure -> 409 listing_cap_reached', async () => {
    // Seed 6 active listings directly (bypassing the route — the cap check is a
    // COUNT over `service_listings`, agnostic to how the rows were created).
    await dbMod.db.insert(dbMod.serviceListings).values(
      Array.from({ length: 6 }, (_, i) => ({
        structureId: capStructureId,
        ownerAvatarId: sellerAvatarId,
        kind: 'peer' as const,
        title: `Cap filler ${i}`,
        priceCt: 10,
        status: 'active' as const,
      })),
    );

    const res = await app.request(`/api/land/structures/${capStructureId}/services`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sellerCookie },
      body: JSON.stringify({ title: 'One too many', priceCt: 20 }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error?: string }).error).toBe('listing_cap_reached');
  });

  // ─── BUY (POST /services/:id/buy) — conservation + idempotency ────────

  it('buy happy path: conservation holds (buyer −P, seller +P, sum unchanged) and land.service.sold fires exactly once, keyed to the SELLER', async () => {
    const before = { buyer: await getBalance(buyerAvatarId), seller: await getBalance(sellerAvatarId) };
    const idempotencyKey = crypto.randomUUID();

    const res = await app.request(`/api/land/services/${mainListingId}/buy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: buyerCookie },
      body: JSON.stringify({ idempotencyKey }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      priceCt: number;
      cached: boolean;
      purchase: { sellerAvatarId: string; buyerAvatarId: string; createdAt: string };
    };
    expect(data.cached).toBe(false);
    expect(data.priceCt).toBe(100);
    expect(data.purchase.sellerAvatarId).toBe(sellerAvatarId);
    expect(data.purchase.buyerAvatarId).toBe(buyerAvatarId);
    // Regression guard (raw-execute string dates — see the LIST test): the FRESH
    // buy branch serializes the purchase's created_at via toIso.
    expect(typeof data.purchase.createdAt).toBe('string');
    expect(Number.isNaN(Date.parse(data.purchase.createdAt))).toBe(false);

    const after = { buyer: await getBalance(buyerAvatarId), seller: await getBalance(sellerAvatarId) };
    expect(after.buyer).toBe(before.buyer - 100);
    expect(after.seller).toBe(before.seller + 100);
    expect(after.buyer + after.seller).toBe(before.buyer + before.seller); // conservation

    const events = await dbMod.db
      .select()
      .from(dbMod.events)
      .where(
        dbMod.and(
          eq(dbMod.events.eventType, LAND_EVENT_TYPES.SERVICE_SOLD),
          eq(dbMod.events.avatarId, sellerAvatarId),
        ),
      );
    expect(events.length).toBe(1);
    expect(events[0].payload).toMatchObject({
      listingId: mainListingId,
      priceCt: 100,
      buyerAvatarId,
    });

    // Store the key on a module-scope var for the replay test below.
    (globalThis as Record<string, unknown>).__landSvcIdemKey = idempotencyKey;
  });

  it('idempotent replay (same key) -> cached:true, no double charge, no second event', async () => {
    const idempotencyKey = (globalThis as Record<string, unknown>).__landSvcIdemKey as string;
    const before = { buyer: await getBalance(buyerAvatarId), seller: await getBalance(sellerAvatarId) };

    const res = await app.request(`/api/land/services/${mainListingId}/buy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: buyerCookie },
      body: JSON.stringify({ idempotencyKey }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { cached: boolean; purchase: { createdAt: string } };
    expect(data.cached).toBe(true);
    // Regression guard: the CACHED replay branch also serializes created_at via
    // toIso (raw-execute string date) — must be a valid ISO string, not a crash.
    expect(typeof data.purchase.createdAt).toBe('string');
    expect(Number.isNaN(Date.parse(data.purchase.createdAt))).toBe(false);

    const after = { buyer: await getBalance(buyerAvatarId), seller: await getBalance(sellerAvatarId) };
    expect(after.buyer).toBe(before.buyer);
    expect(after.seller).toBe(before.seller);

    const events = await dbMod.db
      .select()
      .from(dbMod.events)
      .where(
        dbMod.and(
          eq(dbMod.events.eventType, LAND_EVENT_TYPES.SERVICE_SOLD),
          eq(dbMod.events.avatarId, sellerAvatarId),
        ),
      );
    expect(events.length).toBe(1); // still exactly one — the replay emitted nothing
  });

  it('self-purchase -> 409 self_purchase (no charge)', async () => {
    const before = await getBalance(sellerAvatarId);
    const res = await app.request(`/api/land/services/${mainListingId}/buy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sellerCookie },
      body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error?: string }).error).toBe('self_purchase');
    expect(await getBalance(sellerAvatarId)).toBe(before);
  });

  it('insufficient funds -> 400 insufficient_clawtokens (no charge)', async () => {
    const res = await app.request(`/api/land/services/${mainListingId}/buy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: pauperCookie },
      body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe('insufficient_clawtokens');
    expect(await getBalance(pauperAvatarId)).toBe(0);
  });

  it('unknown listing -> 404 listing_not_found', async () => {
    const res = await app.request(`/api/land/services/${crypto.randomUUID()}/buy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: buyerCookie },
      body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error?: string }).error).toBe('listing_not_found');
  });

  it('an inactive (delisted) listing -> 409 listing_not_active', async () => {
    const listRes = await app.request(`/api/land/structures/${shopStructureId}/services`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sellerCookie },
      body: JSON.stringify({ title: 'Throwaway', priceCt: 5 }),
    });
    expect(listRes.status).toBe(200);
    const listData = (await listRes.json()) as { listing: { id: string } };
    const throwawayId = listData.listing.id;

    const patchRes = await app.request(`/api/land/services/${throwawayId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: sellerCookie },
      body: JSON.stringify({ status: 'delisted' }),
    });
    expect(patchRes.status).toBe(200);

    const buyRes = await app.request(`/api/land/services/${throwawayId}/buy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: buyerCookie },
      body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
    });
    expect(buyRes.status).toBe(409);
    expect(((await buyRes.json()) as { error?: string }).error).toBe('listing_not_active');
  });

  // ─── PATCH (own-listing-only) ───────────────────────────────────────────

  it('a non-owner cannot PATCH someone else’s listing -> 403 not_listing_owner', async () => {
    const res = await app.request(`/api/land/services/${mainListingId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: buyerCookie },
      body: JSON.stringify({ status: 'paused' }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error?: string }).error).toBe('not_listing_owner');
  });

  it('PATCH an unknown listing id -> 404 listing_not_found', async () => {
    const res = await app.request(`/api/land/services/${crypto.randomUUID()}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: sellerCookie },
      body: JSON.stringify({ status: 'paused' }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error?: string }).error).toBe('listing_not_found');
  });

  it('the owner can pause their own listing, and it is excluded from the public structure read', async () => {
    const res = await app.request(`/api/land/services/${mainListingId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: sellerCookie },
      body: JSON.stringify({ status: 'paused' }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { listing: { status: string } };
    expect(data.listing.status).toBe('paused');

    const browse = await app.request(`/api/land/structures/${shopStructureId}/services`);
    expect(browse.status).toBe(200);
    const browseData = (await browse.json()) as { listings: { id: string }[] };
    expect(browseData.listings.some((l) => l.id === mainListingId)).toBe(false);
  });

  // ─── BUY — stale-listing / post-eviction guards (adversarial money audit) ──

  /** Insert an active 'peer' listing on a shop directly (bypass the LIST route). */
  async function insertActiveListing(
    structureId: string,
    kind: 'peer' | 'partner',
    title: string,
  ): Promise<string> {
    const [listing] = await dbMod.db
      .insert(dbMod.serviceListings)
      .values({
        structureId,
        ownerAvatarId: sellerAvatarId,
        kind,
        title,
        priceCt: 50,
        status: 'active' as const,
      })
      .returning();
    return listing.id as string;
  }

  it('buy against a listing whose structure was ARCHIVED (rent-lapse eviction) -> 409 structure_unavailable (no charge)', async () => {
    const structId = await insertOwnedShop(sellerAvatarId, 'archive');
    const listingId = await insertActiveListing(structId, 'peer', 'Doomed shop service');
    // Simulate the rent sweeper archiving the structure on eviction; it does NOT
    // cascade-delist the listing, so the listing outlives the live shop.
    await dbMod.db
      .update(dbMod.landStructures)
      .set({ status: 'archived' as const })
      .where(eq(dbMod.landStructures.id, structId));

    const before = await getBalance(buyerAvatarId);
    const res = await app.request(`/api/land/services/${listingId}/buy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: buyerCookie },
      body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error?: string }).error).toBe('structure_unavailable');
    expect(await getBalance(buyerAvatarId)).toBe(before); // no charge
  });

  it('buy against a listing whose parcel OWNER CHANGED (transfer) -> 409 structure_unavailable (no charge)', async () => {
    const structId = await insertOwnedShop(sellerAvatarId, 'transfer');
    const listingId = await insertActiveListing(structId, 'peer', 'Sold-out-from-under service');
    // The parcel changed hands after the listing was created: the structure's
    // parent parcel now points at a DIFFERENT owner than the listing's seller.
    const [structRow] = await dbMod.db
      .select({ parcelId: dbMod.landStructures.parcelId })
      .from(dbMod.landStructures)
      .where(eq(dbMod.landStructures.id, structId));
    await dbMod.db
      .update(dbMod.landParcels)
      .set({ ownerAvatarId: pauperAvatarId })
      .where(eq(dbMod.landParcels.id, structRow.parcelId));

    const before = await getBalance(buyerAvatarId);
    const res = await app.request(`/api/land/services/${listingId}/buy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: buyerCookie },
      body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error?: string }).error).toBe('structure_unavailable');
    expect(await getBalance(buyerAvatarId)).toBe(before); // no charge
  });

  it('buy against a NON-PEER (USDC partner) listing -> 409 not_a_peer_listing (no charge)', async () => {
    const structId = await insertOwnedShop(sellerAvatarId, 'partner');
    const listingId = await insertActiveListing(structId, 'partner', 'USDC partner service');

    const before = await getBalance(buyerAvatarId);
    const res = await app.request(`/api/land/services/${listingId}/buy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: buyerCookie },
      body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error?: string }).error).toBe('not_a_peer_listing');
    expect(await getBalance(buyerAvatarId)).toBe(before); // no charge
  });

  // ─── GET /services/mine — owner-scoped, all statuses ──────────────────────

  it('GET /services/mine returns the caller’s own listings across statuses (active + paused), owner-scoped, and does not leak to others', async () => {
    const structId = await insertOwnedShop(sellerAvatarId, 'mine');
    const activeId = await insertActiveListing(structId, 'peer', 'Mine active');
    const [pausedRow] = await dbMod.db
      .insert(dbMod.serviceListings)
      .values({
        structureId: structId,
        ownerAvatarId: sellerAvatarId,
        kind: 'peer' as const,
        title: 'Mine paused',
        priceCt: 10,
        status: 'paused' as const,
      })
      .returning();
    const pausedId = pausedRow.id as string;

    const res = await app.request('/api/land/services/mine', {
      headers: { Cookie: sellerCookie },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      listings: { id: string; status: string; ownerAvatarId: string }[];
    };
    const ids = data.listings.map((l) => l.id);
    expect(ids).toContain(activeId); // active listing present
    expect(ids).toContain(pausedId); // AND the paused one (public reads hide it)
    // Owner-scoped — every returned listing belongs to the caller.
    expect(data.listings.every((l) => l.ownerAvatarId === sellerAvatarId)).toBe(true);

    // A DIFFERENT avatar (the buyer) never sees the seller's listings.
    const buyerRes = await app.request('/api/land/services/mine', {
      headers: { Cookie: buyerCookie },
    });
    expect(buyerRes.status).toBe(200);
    const buyerData = (await buyerRes.json()) as { listings: { id: string }[] };
    expect(buyerData.listings.some((l) => l.id === activeId)).toBe(false);
    expect(buyerData.listings.some((l) => l.id === pausedId)).toBe(false);
  });
});
