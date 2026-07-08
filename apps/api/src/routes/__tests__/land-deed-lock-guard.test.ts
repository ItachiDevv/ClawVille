/**
 * Land deed-lock guard tests (marketplace C4 cross-domain seam, 2026-07-07).
 *
 * THE BUG UNDER TEST: the P2P marketplace escrow-locks a listed parcel's deed
 * (`market_deed_locks` row — presence == HELD, kept through 'settled' until the
 * Codex-gated transfer executor releases it), but land's two pool-revert paths
 * (`POST /parcels/:id/release` + the rent sweeper's lapse/eviction reverts)
 * historically did not consult it — once settlement flips on, a seller could
 * release (or lapse) a settled listing's parcel back to the pool and
 * double-sell the deed. The guard (`parcelHasLiveDeedLock` in routes/land.ts)
 * closes both paths.
 *
 * Coverage tiers (mirrors `land-tenure-phaseb.test.ts`):
 *
 *   1. ALWAYS-RUN structural unit tests of `parcelHasLiveDeedLock` against a
 *      fake tx — row presence → locked; empty → unlocked; undefined-table
 *      (Postgres 42P01, direct AND wrapped-in-cause) → unlocked
 *      (migration-order safety); ANY other error → rethrown (a money path
 *      never silently swallows a real fault).
 *
 *   2. DB-GATED E2E (`describeIfMarketDb()` — needs DATABASE_URL AND migration
 *      0017's market tables, probed via `to_regclass`):
 *        - /release REFUSES 409 `{ error, code: 'deed_locked_by_listing' }`
 *          while a HELD deed-lock row exists; the parcel + structure are
 *          UNCHANGED afterward.
 *        - the sweeper on a grace-ELAPSED locked parcel returns
 *          `{ kind: 'parked' }` and does NOT revert (grandfathered hold — no
 *          CLV RPC; grace timestamp untouched).
 *        - the OR arm: /release refused when NO deed-lock row exists but a
 *          live 'active' land_deed listing references the parcel.
 *        - CONTROLS: with the lock + listing cleared, /release succeeds and
 *          the sweeper evicts — the guard never over-blocks.
 *
 *      Money-path discipline: DB-gated cases call the exported
 *      `processDueParcel` DIRECTLY (never `sweepDueRents()` — a whole-DB sweep
 *      would settle OTHER rows in a shared DB), and every fixture parcel_code
 *      starts with '0' so it sorts before real supply.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import * as dbMod from '@clawville/database';
import { Hono } from 'hono';
import { eq, inArray } from 'drizzle-orm';
import { landRoutes, parcelHasLiveDeedLock } from '../land';
import { authRoutes } from '../auth';
import { avatarRoutes } from '../avatars';
import { processDueParcel } from '../../services/land-rent-sweeper';
import type { AppContext } from '../../types';

const HAS_DB = !!process.env.DATABASE_URL;

// Migration-order probe: the market tables ship in 0017 and are applied by
// hand/CI (never db:push) — on a market-less DB the DB-gated block below would
// red-fail on fixture INSERTs, so probe and skip cleanly instead.
let HAS_MARKET_TABLES = false;
if (HAS_DB) {
  try {
    const rows = await dbMod.db.execute<{ reg: string | null }>(
      dbMod.sql`SELECT to_regclass('public.market_deed_locks')::text AS reg`,
    );
    HAS_MARKET_TABLES = Array.from(rows as Iterable<{ reg: string | null }>)[0]?.reg != null;
  } catch {
    HAS_MARKET_TABLES = false;
  }
  if (!HAS_MARKET_TABLES) {
    console.warn(
      '[land-deed-lock-guard.test] market tables (migration 0017) not present on this DB — DB-gated deed-lock cases SKIPPED',
    );
  }
}
const describeIfMarketDb = HAS_DB && HAS_MARKET_TABLES ? describe : describe.skip;

// ═════════════════════════════════════════════════════════════════════════
// 1. parcelHasLiveDeedLock — structural unit tests (always run, no DB)
// ═════════════════════════════════════════════════════════════════════════

/** The guard only ever calls `tx.execute(...)` — a one-method fake suffices. */
type GuardTx = Parameters<typeof parcelHasLiveDeedLock>[0];
function fakeTx(impl: () => Promise<unknown>): GuardTx {
  return { execute: impl } as unknown as GuardTx;
}

describe('parcelHasLiveDeedLock — structural (pure, no DB)', () => {
  const PARCEL = '00000000-0000-4000-8000-000000000001';

  it('row presence == HELD: any returned row → locked (true)', async () => {
    const tx = fakeTx(async () => [{ hit: 1 }]);
    expect(await parcelHasLiveDeedLock(tx, PARCEL)).toBe(true);
  });

  it('no rows → unlocked (false)', async () => {
    const tx = fakeTx(async () => []);
    expect(await parcelHasLiveDeedLock(tx, PARCEL)).toBe(false);
  });

  it('undefined-table 42P01 (market tables not migrated) → unlocked, not thrown', async () => {
    const err = Object.assign(new Error('relation "market_deed_locks" does not exist'), {
      code: '42P01',
    });
    const tx = fakeTx(async () => {
      throw err;
    });
    expect(await parcelHasLiveDeedLock(tx, PARCEL)).toBe(false);
  });

  it('42P01 nested under `cause` (a wrapping driver/ORM layer) → unlocked, not thrown', async () => {
    const wrapped = new Error('Failed query', {
      cause: Object.assign(new Error('relation "market_listings" does not exist'), {
        code: '42P01',
      }),
    });
    const tx = fakeTx(async () => {
      throw wrapped;
    });
    expect(await parcelHasLiveDeedLock(tx, PARCEL)).toBe(false);
  });

  it('any OTHER error is rethrown — a money path never silently swallows a real fault', async () => {
    const tx = fakeTx(async () => {
      throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    });
    await expect(parcelHasLiveDeedLock(tx, PARCEL)).rejects.toThrow('connection refused');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 2. Money-path E2E — DB-backed, needs DATABASE_URL + migration 0017.
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

describeIfMarketDb('deed-lock guard E2E (requires DATABASE_URL + migration 0017)', () => {
  const TEST_TAG = `dlg${Date.now()}`;
  const PASSWORD = 'deedlocktestpassword123';
  const SELLER_EMAIL = `${TEST_TAG}-seller@clawville-test.com`;
  /** Any ≤64-char string — the DB doesn't validate pubkey form. */
  const SELLER_PUBKEY = 'DeedLockTestPubkey11111111111111111111111111';

  // Fixture parcels — '0'-prefixed codes sort before all real supply.
  const releaseCode = `0${TEST_TAG}r`; // /release refusal + control
  const sweepCode = `0${TEST_TAG}s`; // sweeper park + control
  const orArmCode = `0${TEST_TAG}o`; // listing-without-lock OR arm

  let app: ReturnType<typeof buildApp>;
  let sellerCookie = '';
  let sellerUserId = '';
  let sellerAvatarId = '';
  let releaseParcelId = '';
  let sweepParcelId = '';
  let orArmParcelId = '';
  let releaseListingId = '';
  let sweepListingId = '';
  let orArmListingId = '';

  let gridCounter = 0;
  function nextGrid(): { gridX: number; gridY: number } {
    gridCounter -= 2;
    return { gridX: -8_450_000 + gridCounter, gridY: -8_450_000 + gridCounter };
  }

  /** Insert an owned, grandfathered HOLD parcel (releasable AND sweepable, no CLV RPC). */
  async function insertHoldParcel(parcelCode: string) {
    const [row] = await dbMod.db
      .insert(dbMod.landParcels)
      .values({
        parcelCode,
        tier: 'c' as const,
        status: 'owned' as const,
        priceCt: 500,
        ownerAvatarId: sellerAvatarId,
        tenure: 'hold' as const,
        grandfathered: true,
        holdThresholdCt: 100_000,
        rentCtWeekly: 100,
        rentPaidThrough: new Date(Date.now() + 7 * 24 * 3600 * 1000),
        acquiredAt: new Date(),
        ...nextGrid(),
      })
      .returning();
    return row.id as string;
  }

  /** Insert an ACTIVE structure so the "structure not archived" assertion has a subject. */
  async function insertStructure(parcelId: string) {
    await dbMod.db.insert(dbMod.landStructures).values({
      parcelId,
      ownerAvatarId: sellerAvatarId,
      structureType: 'home' as const,
      catalogKey: 'home-shack',
      level: 1,
    });
  }

  /** Create a live 'active' land_deed listing; returns the listing id. */
  async function insertListing(parcelId: string): Promise<string> {
    const [listing] = await dbMod.db
      .insert(dbMod.marketListings)
      .values({
        sellerAvatarId,
        sellerUserId,
        itemKind: 'land_deed' as const,
        itemRef: parcelId,
        priceVclaw: 1000,
        status: 'active' as const,
        escrowState: 'deed_locked',
        sellerWalletPubkey: SELLER_PUBKEY,
      })
      .returning();
    return listing.id as string;
  }

  async function insertDeedLock(parcelId: string, listingId: string) {
    await dbMod.db.insert(dbMod.marketDeedLocks).values({ parcelId, listingId });
  }

  async function getParcel(parcelId: string) {
    const row = await dbMod.db.query.landParcels.findFirst({
      where: eq(dbMod.landParcels.id, parcelId),
    });
    if (!row) throw new Error(`test fixture: no parcel ${parcelId}`);
    return row;
  }

  async function getStructureStatus(parcelId: string): Promise<string | null> {
    const row = await dbMod.db.query.landStructures.findFirst({
      where: eq(dbMod.landStructures.parcelId, parcelId),
    });
    return (row?.status as string | undefined) ?? null;
  }

  beforeAll(async () => {
    app = buildApp();

    // Seller account + avatar (mirrors the phase-b harness signup flow).
    const signup = await app.request('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: SELLER_EMAIL, password: PASSWORD, name: 'DeedLock Tester' }),
    });
    expect(signup.status).toBe(200);
    sellerCookie = (signup.headers.get('set-cookie') ?? '').split(';')[0]!;
    const signupData = (await signup.json()) as { avatar?: { id: string } };
    sellerAvatarId = signupData.avatar?.id ?? '';
    if (!sellerAvatarId) {
      const avatarRes = await app.request('/api/avatars', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: sellerCookie },
        body: JSON.stringify({
          name: `DL${Date.now()}${Math.floor(Math.random() * 10000)}`,
          species: 'cat',
          color: 'green',
          gender: 'male',
          personality: { habitat: 'forest', hobby: 'exploring', greeting: 'wave-hello' },
        }),
      });
      expect(avatarRes.status).toBe(200);
      sellerAvatarId = ((await avatarRes.json()) as { avatar: { id: string } }).avatar.id;
    }
    const userRow = await dbMod.db.query.users.findFirst({
      where: eq(dbMod.users.email, SELLER_EMAIL),
    });
    if (!userRow) throw new Error(`test fixture: no users row for ${SELLER_EMAIL}`);
    sellerUserId = userRow.id as string;

    // Parcels + structures.
    releaseParcelId = await insertHoldParcel(releaseCode);
    sweepParcelId = await insertHoldParcel(sweepCode);
    orArmParcelId = await insertHoldParcel(orArmCode);
    await insertStructure(releaseParcelId);
    await insertStructure(sweepParcelId);

    // Live listings: release + sweep parcels get listing AND deed-lock (the
    // real lister writes both in one tx); the OR-arm parcel gets ONLY a
    // listing (simulating a future lockless listing path).
    releaseListingId = await insertListing(releaseParcelId);
    await insertDeedLock(releaseParcelId, releaseListingId);
    sweepListingId = await insertListing(sweepParcelId);
    await insertDeedLock(sweepParcelId, sweepListingId);
    orArmListingId = await insertListing(orArmParcelId);

    // The sweep parcel is due AND its grace window has already elapsed — the
    // sweeper would evict it if not deed-locked.
    await dbMod.db
      .update(dbMod.landParcels)
      .set({
        rentPaidThrough: new Date(Date.now() - 1000),
        graceUntil: new Date(Date.now() - 1000),
      })
      .where(eq(dbMod.landParcels.id, sweepParcelId));
  });

  afterAll(async () => {
    // FK order: deed locks → listings → structures → parcels → avatars/users.
    const parcelIds = [releaseParcelId, sweepParcelId, orArmParcelId].filter(Boolean);
    const listingIds = [releaseListingId, sweepListingId, orArmListingId].filter(Boolean);
    if (parcelIds.length > 0) {
      await dbMod.db
        .delete(dbMod.marketDeedLocks)
        .where(inArray(dbMod.marketDeedLocks.parcelId, parcelIds))
        .catch(() => {});
    }
    if (listingIds.length > 0) {
      await dbMod.db
        .delete(dbMod.marketListings)
        .where(inArray(dbMod.marketListings.id, listingIds))
        .catch(() => {});
    }
    if (parcelIds.length > 0) {
      await dbMod.db
        .delete(dbMod.landStructures)
        .where(inArray(dbMod.landStructures.parcelId, parcelIds))
        .catch(() => {});
      await dbMod.db.delete(dbMod.landParcels).where(inArray(dbMod.landParcels.id, parcelIds));
    }
    if (sellerUserId) {
      await dbMod.db.delete(dbMod.avatars).where(eq(dbMod.avatars.userId, sellerUserId));
      await dbMod.db.delete(dbMod.users).where(eq(dbMod.users.id, sellerUserId));
    }
  });

  // ─── 1. /release refused while the deed lock is HELD ──────────────────────

  it('/release → 409 { error, code: deed_locked_by_listing } while a HELD deed-lock row exists — parcel + structure UNCHANGED', async () => {
    const res = await app.request(`/api/land/parcels/${releaseParcelId}/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sellerCookie },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string; code?: string };
    expect(body.error).toBe('deed_locked_by_listing');
    expect(body.code).toBe('deed_locked_by_listing'); // web ApiError branches on code

    // NOTHING reverted: still owned, tenure intact, structure still active.
    const parcel = await getParcel(releaseParcelId);
    expect(parcel.status).toBe('owned');
    expect(parcel.ownerAvatarId).toBe(sellerAvatarId);
    expect(parcel.tenure).toBe('hold');
    expect(parcel.holdThresholdCt).not.toBeNull();
    expect(await getStructureStatus(releaseParcelId)).toBe('active');
  });

  // ─── 2. sweeper PARKS a grace-elapsed locked parcel ───────────────────────

  it('sweeper on a grace-ELAPSED deed-locked parcel returns parked and does NOT revert (grace untouched)', async () => {
    const before = await getParcel(sweepParcelId);
    expect(before.graceUntil).not.toBeNull(); // fixture sanity: eviction WOULD fire

    const action = await processDueParcel(sweepParcelId);
    expect(action.kind).toBe('parked');

    const after = await getParcel(sweepParcelId);
    expect(after.status).toBe('owned');
    expect(after.ownerAvatarId).toBe(sellerAvatarId);
    expect(after.tenure).toBe('hold');
    // Grace state left untouched — normal eviction resumes once the lock clears.
    expect(after.graceUntil?.getTime()).toBe(before.graceUntil!.getTime());
    expect(await getStructureStatus(sweepParcelId)).toBe('active');
  });

  // ─── 3. OR arm: live listing WITHOUT a deed-lock row still refuses ────────

  it('/release → 409 deed_locked_by_listing when NO deed-lock row exists but a live active land_deed listing references the parcel', async () => {
    const res = await app.request(`/api/land/parcels/${orArmParcelId}/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sellerCookie },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string; code?: string };
    expect(body.error).toBe('deed_locked_by_listing');
    expect(body.code).toBe('deed_locked_by_listing');

    const parcel = await getParcel(orArmParcelId);
    expect(parcel.status).toBe('owned');
    expect(parcel.tenure).toBe('hold');
  });

  // ─── 4. CONTROLS: lock cleared → both paths behave normally ───────────────

  it('CONTROL: with the lock + listing cleared, /release succeeds (the guard never over-blocks)', async () => {
    // The real cancel path deletes the lock and terminates the listing.
    await dbMod.db
      .delete(dbMod.marketDeedLocks)
      .where(eq(dbMod.marketDeedLocks.parcelId, releaseParcelId));
    await dbMod.db
      .update(dbMod.marketListings)
      .set({ status: 'cancelled' as const, escrowState: null })
      .where(eq(dbMod.marketListings.id, releaseListingId));

    const res = await app.request(`/api/land/parcels/${releaseParcelId}/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sellerCookie },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { released: boolean; refundedCt: number };
    expect(body.released).toBe(true);
    expect(body.refundedCt).toBe(0); // hold escrows nothing

    const parcel = await getParcel(releaseParcelId);
    expect(parcel.status).toBe('available');
    expect(parcel.ownerAvatarId).toBeNull();
    expect(parcel.tenure).toBeNull();
    expect(await getStructureStatus(releaseParcelId)).toBe('archived');
  });

  it('CONTROL: with the lock + listing cleared, the sweeper evicts the grace-elapsed parcel normally', async () => {
    await dbMod.db
      .delete(dbMod.marketDeedLocks)
      .where(eq(dbMod.marketDeedLocks.parcelId, sweepParcelId));
    await dbMod.db
      .update(dbMod.marketListings)
      .set({ status: 'cancelled' as const, escrowState: null })
      .where(eq(dbMod.marketListings.id, sweepListingId));

    const action = await processDueParcel(sweepParcelId);
    expect(action.kind).toBe('evicted');

    const parcel = await getParcel(sweepParcelId);
    expect(parcel.status).toBe('available');
    expect(parcel.ownerAvatarId).toBeNull();
    expect(parcel.tenure).toBeNull();
    expect(await getStructureStatus(sweepParcelId)).toBe('archived');
  });
});
