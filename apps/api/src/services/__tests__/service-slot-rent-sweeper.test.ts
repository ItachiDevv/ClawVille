/**
 * Shop slot-rent sweeper — REAL DB suite.
 *
 * This is a recurring CT sink, so the properties that matter are the ones a
 * billing loop gets wrong: charging twice for one week, charging a partial
 * amount, deleting something on non-payment, and failing to restore after the
 * owner pays up.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { db, sql } from '@clawville/database';
import {
  SERVICE_LISTING_SLOT_RENT_CT_WEEKLY,
  SERVICE_FEATURED_SLOT_RENT_CT_WEEKLY,
} from '@clawville/shared';
import { processDueListing } from '../service-slot-rent-sweeper';
import { slotPaidThroughOnCreateSql } from '../../routes/land';
import { getHouseTreasuryAvatarId } from '../house-treasury-seeder';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

function first<T>(rows: Iterable<T>): T {
  const [row] = Array.from(rows);
  if (!row) throw new Error('expected at least one row');
  return row;
}

describeIfDb('service slot rent sweeper (real DB)', () => {
  const tag = `slot${Date.now().toString(36)}${Math.floor(Math.random() * 46_656).toString(36)}`;
  let userId = '';
  let avatarId = '';
  let parcelId = '';
  let structureId = '';
  let listingId = '';
  let treasuryId = '';
  let b2ParcelIdOuter = '';

  const balance = async (): Promise<number> =>
    Number(
      first(
        await db.execute<{ claw_tokens: number }>(
          sql`SELECT claw_tokens FROM avatars WHERE id = ${avatarId}`,
        ),
      ).claw_tokens,
    );

  const listingState = async () =>
    first(
      await db.execute<{
        slot_paid_through: string | null;
        featured_paid_through: string | null;
        slot_suspended_at: string | null;
      }>(
        sql`SELECT slot_paid_through, featured_paid_through, slot_suspended_at
            FROM service_listings WHERE id = ${listingId}`,
      ),
    );

  /**
   * What a FRESH free-week grant would evaluate to, on the DATABASE clock.
   * Every cursor assertion compares against this rather than local wall-clock:
   * the cursors are set by `now()` on the server, and this machine's clock runs
   * ~1s behind Supabase's, which is enough to make a naive `Date.now()` delta
   * read 7.00001 days and fail a "< 7" assertion for no real reason.
   */
  const freshGrantMs = async (): Promise<number> =>
    new Date(
      first(
        await db.execute<{ t: string }>(sql`SELECT (now() + interval '7 days') AS t`),
      ).t,
    ).getTime();

  /** Force the slot cursor into the past so the next sweep sees it as due. */
  const makeSlotDue = async () => {
    await db.execute(
      sql`UPDATE service_listings SET slot_paid_through = now() - interval '1 hour'
          WHERE id = ${listingId}`,
    );
  };

  beforeAll(async () => {
    treasuryId = (await getHouseTreasuryAvatarId()) ?? '';

    const users = await db.execute<{ id: string }>(
      sql`INSERT INTO users (email, password_hash, name)
          VALUES (${`${tag}@clawville-test.invalid`}, ${`disabled-${tag}`}, 'Slot Rent Test')
          RETURNING id`,
    );
    userId = first(users).id;

    const avatars = await db.execute<{ id: string }>(
      sql`INSERT INTO avatars
            (user_id, name, species, color, gender, archetype, personality, stats,
             claw_tokens, soft_balance, bought_balance, earned_balance, is_active, is_guest)
          VALUES
            (${userId}, ${tag}, 'cat', 'green', 'male', 'brave-adventurer', '{}'::jsonb, '{}'::jsonb,
             5000, 5000, 0, 0, false, false)
          RETURNING id`,
    );
    avatarId = first(avatars).id;

    const parcels = await db.execute<{ id: string }>(
      sql`SELECT id FROM land_parcels
          WHERE status = 'available' AND owner_avatar_id IS NULL AND tier = 'starter'
          ORDER BY parcel_code DESC LIMIT 1`,
    );
    parcelId = first(parcels).id;
    await db.execute(
      sql`UPDATE land_parcels SET status = 'owned', owner_avatar_id = ${avatarId},
                                  tenure = 'rented', tenure_terms_version = 2,
                                  acquired_at = now(), updated_at = now()
          WHERE id = ${parcelId}`,
    );

    const structures = await db.execute<{ id: string }>(
      sql`INSERT INTO land_structures (parcel_id, owner_avatar_id, structure_type, catalog_key, level, status)
          VALUES (${parcelId}, ${avatarId}, 'shop', 'starter-shop', 1, 'active')
          RETURNING id`,
    );
    structureId = first(structures).id;

    const listings = await db.execute<{ id: string }>(
      sql`INSERT INTO service_listings
            (structure_id, owner_avatar_id, kind, title, price_ct, status, slot_paid_through)
          VALUES (${structureId}, ${avatarId}, 'peer', ${`${tag} shop`}, 100, 'active',
                  now() + interval '7 days')
          RETURNING id`,
    );
    listingId = first(listings).id;
  });

  afterAll(async () => {
    const clean = (q: ReturnType<typeof sql>) => db.execute(q).catch(() => {});
    if (listingId) await clean(sql`DELETE FROM service_listings WHERE id = ${listingId}`);
    if (structureId) await clean(sql`DELETE FROM land_structures WHERE id = ${structureId}`);
    if (parcelId) {
      await clean(sql`UPDATE land_parcels SET
                        status = 'available', owner_avatar_id = NULL, tenure = NULL,
                        tenure_terms_version = NULL, acquired_at = NULL, updated_at = now()
                      WHERE id = ${parcelId}`);
    }
    if (treasuryId && avatarId) {
      // Unwind the treasury credits this suite produced so the shared staging
      // treasury balance is left exactly as we found it.
      const credited = Number(
        first(
          await db
            .execute<{ amount: number | string }>(
              sql`SELECT COALESCE(SUM(amount), 0)::int AS amount
                  FROM claw_token_transactions
                  WHERE avatar_id = ${treasuryId}
                    AND metadata ->> 'ownerAvatarId' = ${avatarId}`,
            )
            .catch(() => [{ amount: 0 }]),
        ).amount,
      );
      if (credited > 0) {
        await clean(sql`UPDATE avatars
                        SET claw_tokens = claw_tokens - ${credited},
                            soft_balance = soft_balance - ${credited}
                        WHERE id = ${treasuryId}`);
        await clean(sql`DELETE FROM claw_token_transactions
                        WHERE avatar_id = ${treasuryId}
                          AND metadata ->> 'ownerAvatarId' = ${avatarId}`);
      }
    }
    await clean(sql`DELETE FROM claw_token_transactions WHERE avatar_id = ${avatarId}`);
    await clean(sql`DELETE FROM avatars WHERE id = ${avatarId}`);
    await clean(sql`DELETE FROM users WHERE id = ${userId}`);
  });

  it('skips a listing whose week is already paid', async () => {
    const before = await balance();
    expect(await processDueListing(listingId)).toEqual({ kind: 'skip' });
    expect(await balance()).toBe(before);
  });

  it('charges exactly one week when due and advances the cursor', async () => {
    await makeSlotDue();
    const before = await balance();

    const action = await processDueListing(listingId);
    expect(action).toEqual({
      kind: 'charged',
      slotCt: SERVICE_LISTING_SLOT_RENT_CT_WEEKLY,
      featuredCt: 0,
    });
    expect(await balance()).toBe(before - SERVICE_LISTING_SLOT_RENT_CT_WEEKLY);

    const state = await listingState();
    expect(state.slot_suspended_at).toBeNull();
    expect(new Date(state.slot_paid_through!).getTime()).toBeGreaterThan(Date.now());
  });

  it('does NOT charge a second time for the same week', async () => {
    const before = await balance();
    expect(await processDueListing(listingId)).toEqual({ kind: 'skip' });
    expect(await balance()).toBe(before);
  });

  it('charges once, not twice, when two sweeps race the same due week', async () => {
    await makeSlotDue();
    const before = await balance();

    const [a, b] = await Promise.all([
      processDueListing(listingId),
      processDueListing(listingId),
    ]);
    const charged = [a, b].filter((r) => r.kind === 'charged');
    expect(charged).toHaveLength(1);
    expect(await balance()).toBe(before - SERVICE_LISTING_SLOT_RENT_CT_WEEKLY);
  });

  it('adds the featured rent on its own cursor when featured is on', async () => {
    await db.execute(
      sql`UPDATE service_listings SET featured = true, featured_paid_through = NULL
          WHERE id = ${listingId}`,
    );
    await makeSlotDue();
    const before = await balance();

    const action = await processDueListing(listingId);
    expect(action).toEqual({
      kind: 'charged',
      slotCt: SERVICE_LISTING_SLOT_RENT_CT_WEEKLY,
      featuredCt: SERVICE_FEATURED_SLOT_RENT_CT_WEEKLY,
    });
    expect(await balance()).toBe(
      before - SERVICE_LISTING_SLOT_RENT_CT_WEEKLY - SERVICE_FEATURED_SLOT_RENT_CT_WEEKLY,
    );
    const state = await listingState();
    expect(new Date(state.featured_paid_through!).getTime()).toBeGreaterThan(Date.now());
  });

  it('SUSPENDS rather than deleting when the owner cannot pay, and charges nothing', async () => {
    // Drain the owner to just under one week's slot rent.
    await db.execute(
      sql`UPDATE avatars SET claw_tokens = ${SERVICE_LISTING_SLOT_RENT_CT_WEEKLY - 1},
                             soft_balance = ${SERVICE_LISTING_SLOT_RENT_CT_WEEKLY - 1}
          WHERE id = ${avatarId}`,
    );
    await db.execute(
      sql`UPDATE service_listings SET featured = false WHERE id = ${listingId}`,
    );
    await makeSlotDue();
    const before = await balance();

    expect(await processDueListing(listingId)).toEqual({ kind: 'suspended' });
    // No partial debit.
    expect(await balance()).toBe(before);

    const state = await listingState();
    expect(state.slot_suspended_at).not.toBeNull();
    // The cursor did NOT advance — the next sweep retries this same week.
    expect(new Date(state.slot_paid_through!).getTime()).toBeLessThan(Date.now());

    // And the listing still EXISTS with its title and price intact.
    const row = first(
      await db.execute<{ n: number; title: string; price_ct: number }>(
        sql`SELECT count(*) OVER ()::int AS n, title, price_ct
            FROM service_listings WHERE id = ${listingId}`,
      ),
    );
    expect(Number(row.n)).toBe(1);
    expect(row.title).toBe(`${tag} shop`);
    expect(Number(row.price_ct)).toBe(100);
  });

  it('restores a suspended listing automatically once the owner can pay', async () => {
    await db.execute(
      sql`UPDATE avatars SET claw_tokens = 5000, soft_balance = 5000 WHERE id = ${avatarId}`,
    );
    const before = await balance();

    const action = await processDueListing(listingId);
    expect(action).toEqual({
      kind: 'charged',
      slotCt: SERVICE_LISTING_SLOT_RENT_CT_WEEKLY,
      featuredCt: 0,
    });
    expect(await balance()).toBe(before - SERVICE_LISTING_SLOT_RENT_CT_WEEKLY);

    const state = await listingState();
    expect(state.slot_suspended_at).toBeNull();
    expect(new Date(state.slot_paid_through!).getTime()).toBeGreaterThan(Date.now());
  });

  // -- B2: the free week must attach to the SHOP, not to a re-mintable row --
  describe('free-week grant (delist/recreate bypass)', () => {
    let b2StructureId = '';
    const created: string[] = [];

    /** Create a listing exactly the way the route does - same SQL fragment. */
    const createListing = async (): Promise<{ id: string; slotPaidThrough: string }> => {
      const row = first(
        await db.execute<{ id: string; slot_paid_through: string }>(
          sql`INSERT INTO service_listings
                (structure_id, owner_avatar_id, kind, title, price_ct, status, slot_paid_through)
              VALUES (${b2StructureId}, ${avatarId}, 'peer', ${`${tag} b2`}, 100, 'active',
                      ${slotPaidThroughOnCreateSql(b2StructureId)})
              RETURNING id, slot_paid_through`,
        ),
      );
      created.push(row.id);
      return { id: row.id, slotPaidThrough: row.slot_paid_through };
    };

    beforeAll(async () => {
      // One structure per parcel, so this block borrows its own parcel + shop.
      const parcels = await db.execute<{ id: string }>(
        sql`SELECT id FROM land_parcels
            WHERE status = 'available' AND owner_avatar_id IS NULL AND tier = 'starter'
            ORDER BY parcel_code LIMIT 1`,
      );
      b2ParcelIdOuter = first(parcels).id;
      await db.execute(
        sql`UPDATE land_parcels SET status = 'owned', owner_avatar_id = ${avatarId},
                                    tenure = 'rented', tenure_terms_version = 2,
                                    acquired_at = now(), updated_at = now()
            WHERE id = ${b2ParcelIdOuter}`,
      );
      b2StructureId = first(
        await db.execute<{ id: string }>(
          sql`INSERT INTO land_structures (parcel_id, owner_avatar_id, structure_type, catalog_key, level, status)
              VALUES (${b2ParcelIdOuter}, ${avatarId}, 'shop', 'starter-shop', 1, 'active')
              RETURNING id`,
        ),
      ).id;
    });

    afterAll(async () => {
      const clean = (q: ReturnType<typeof sql>) => db.execute(q).catch(() => {});
      await clean(sql`DELETE FROM service_listings WHERE structure_id = ${b2StructureId}`);
      await clean(sql`DELETE FROM land_structures WHERE id = ${b2StructureId}`);
      if (b2ParcelIdOuter) {
        await clean(sql`UPDATE land_parcels SET
                          status = 'available', owner_avatar_id = NULL, tenure = NULL,
                          tenure_terms_version = NULL, acquired_at = NULL, updated_at = now()
                        WHERE id = ${b2ParcelIdOuter}`);
      }
    });

    it('grants the genuine free week to a shop FIRST listing', async () => {
      const listing = await createListing();
      const grant = await freshGrantMs();
      // Within a few seconds of a fresh 7-day grant on the server clock.
      expect(Math.abs(new Date(listing.slotPaidThrough).getTime() - grant)).toBeLessThan(
        10_000,
      );
    });

    it('does NOT grant a second free week on delist + recreate', async () => {
      // The bypass: delist mid-week, recreate, collect another free week, and
      // repeat forever - paying 0 slot rent while never losing sellability.
      const original = first(
        await db.execute<{ slot_paid_through: string }>(
          sql`SELECT slot_paid_through FROM service_listings WHERE id = ${created[0]}`,
        ),
      ).slot_paid_through;

      await db.execute(
        sql`UPDATE service_listings SET status = 'delisted' WHERE id = ${created[0]}`,
      );
      const replacement = await createListing();

      // The replacement INHERITS the original cursor instead of restarting it.
      expect(new Date(replacement.slotPaidThrough).getTime()).toBe(
        new Date(original).getTime(),
      );
      // And it is emphatically NOT a fresh grant: a new free week would land
      // strictly later than the inherited cursor by the elapsed time.
      const grant = await freshGrantMs();
      expect(new Date(replacement.slotPaidThrough).getTime()).toBeLessThan(grant);
    });

    it('makes a recreated listing due immediately when the shop already lapsed', async () => {
      // Every prior cursor in the past => the replacement starts at now(), so
      // the next sweep charges it rather than granting a grace week.
      await db.execute(
        sql`UPDATE service_listings SET slot_paid_through = now() - interval '2 days',
                                        status = 'delisted'
            WHERE structure_id = ${b2StructureId}`,
      );
      const replacement = await createListing();
      const nowMs = new Date(
        first(await db.execute<{ t: string }>(sql`SELECT now() AS t`)).t,
      ).getTime();
      // Floored at now() on the server clock - NOT a week out.
      expect(Math.abs(new Date(replacement.slotPaidThrough).getTime() - nowMs)).toBeLessThan(
        10_000,
      );

      expect(await processDueListing(replacement.id)).toEqual({
        kind: 'charged',
        slotCt: SERVICE_LISTING_SLOT_RENT_CT_WEEKLY,
        featuredCt: 0,
      });
    });
  });

  it('skips a delisted listing entirely', async () => {
    await db.execute(
      sql`UPDATE service_listings SET status = 'delisted' WHERE id = ${listingId}`,
    );
    await makeSlotDue();
    const before = await balance();
    expect(await processDueListing(listingId)).toEqual({ kind: 'skip' });
    expect(await balance()).toBe(before);
    await db.execute(
      sql`UPDATE service_listings SET status = 'active' WHERE id = ${listingId}`,
    );
  });
});
