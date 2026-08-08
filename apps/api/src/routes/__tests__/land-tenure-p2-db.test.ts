/**
 * Executed Land P2 money/constraint smoke against DATABASE_URL.
 * Fixtures use one available canonical parcel and are restored in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Keypair } from '@solana/web3.js';
import * as dbMod from '@clawville/database';
import { MAX_PARCELS_PER_AVATAR, tenureRentCtWeeklyForTier } from '@clawville/shared';
import type { ActivityIdentity } from '../../middleware/require-auth-or-agent';
import { debitClawTokens } from '../../services/claw-token-ledger';
import { getHouseTreasuryAvatarId } from '../../services/house-treasury-seeder';
import {
  declareLandHoldWallet,
  settleTenureClaim,
  settleTenureRelease,
} from '../../services/land-tenure-settlement';
import { resolveAgentLandDailySpendVclaw } from '../../services/autonomous-land-spend-cap';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

function first<T>(rows: Iterable<T>): T {
  const row = Array.from(rows)[0];
  if (!row) throw new Error('Land P2 DB fixture query returned no row');
  return row;
}

async function rejectionCode(work: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await work();
    return undefined;
  } catch (err) {
    const pg = err as { code?: string; cause?: { code?: string } };
    return pg.code ?? pg.cause?.code;
  }
}

async function settlementRejection(
  work: () => Promise<unknown>,
): Promise<{ code?: string; status?: number }> {
  try {
    await work();
    return {};
  } catch (err) {
    const failure = err as { code?: string; status?: number };
    return { code: failure.code, status: failure.status };
  }
}

describeIfDb('Land P2 executed staging DB contract', () => {
  const tag = `p2d${Date.now().toString(36)}${Math.floor(Math.random() * 46_656).toString(36)}`;
  let userId = '';
  let avatarId = '';
  let parcelId = '';
  let parcelCode = '';
  let weeklyCt = 0;
  let treasuryId = '';

  const humanIdentity = (): ActivityIdentity => ({
    kind: 'user',
    userId,
    avatarId,
    agentId: null,
  });
  const agentIdentity = (): ActivityIdentity => ({
    kind: 'agent',
    userId,
    avatarId,
    agentId: `${tag}-agent`,
    sessionId: `${tag}-session`,
    ledgerCapable: true,
  });
  const input = (idempotencyKey: string, autonomous = false) => ({
    identity: humanIdentity(),
    expectedAvatarId: avatarId,
    expectedUserId: userId,
    expectedAgentId: null,
    parcelCode,
    idempotencyKey,
    autonomous,
  });

  async function balance(id: string): Promise<number> {
    const rows = await dbMod.db.execute<{ claw_tokens: number }>(
      dbMod.sql`SELECT claw_tokens FROM avatars WHERE id = ${id}`,
    );
    return Number(first(rows).claw_tokens);
  }

  beforeAll(async () => {
    treasuryId = (await getHouseTreasuryAvatarId()) ?? '';
    if (!treasuryId) throw new Error('house treasury unavailable on staging DB');

    const users = await dbMod.db.execute<{ id: string }>(
      dbMod.sql`INSERT INTO users (email, password_hash, name)
                VALUES (${`${tag}@clawville-test.invalid`}, ${`disabled-${tag}`}, 'Land P2 DB Test')
                RETURNING id`,
    );
    userId = first(users).id;
    const avatars = await dbMod.db.execute<{ id: string }>(
      dbMod.sql`INSERT INTO avatars
                  (user_id, name, species, color, gender, archetype, personality, stats,
                   claw_tokens, soft_balance, bought_balance, earned_balance, is_active, is_guest)
                VALUES
                  (${userId}, ${tag}, 'cat', 'green', 'male', 'brave-adventurer',
                   ${JSON.stringify({ habitat: 'test', hobby: 'testing', greeting: 'hi' })}::jsonb,
                   ${JSON.stringify({ strength: 1, defence: 1, movement: 1 })}::jsonb,
                   50000, 50000, 0, 0, false, false)
                RETURNING id`,
    );
    avatarId = first(avatars).id;

    const parcels = await dbMod.db.execute<{
      id: string;
      parcel_code: string;
      tier: 'starter' | 'c';
    }>(
      dbMod.sql`SELECT id, parcel_code, tier::text AS tier
                FROM land_parcels
                WHERE status = 'available' AND owner_avatar_id IS NULL
                  AND tier IN ('starter', 'c')
                ORDER BY CASE WHEN tier = 'starter' THEN 0 ELSE 1 END, parcel_code
                LIMIT 1`,
    );
    const parcel = first(parcels);
    parcelId = parcel.id;
    parcelCode = parcel.parcel_code;
    weeklyCt = tenureRentCtWeeklyForTier(parcel.tier) ?? 0;
    if (weeklyCt <= 0) throw new Error('selected parcel has no P2 rent quote');
  });

  afterAll(async () => {
    if (!avatarId) return;
    await dbMod.db.execute(
      dbMod.sql`UPDATE land_parcels SET
                  status = 'available', owner_avatar_id = NULL, tenure = NULL,
                  tenure_terms_version = NULL, acquired_at = NULL,
                  rent_ct_weekly = CASE tier WHEN 'starter' THEN 1000 WHEN 'c' THEN 2500 ELSE rent_ct_weekly END,
                  rent_paid_through = NULL, grace_until = NULL,
                  deposit_ct = NULL, deposit_remaining_ct = NULL,
                  hold_threshold_ct = NULL, hold_subject = NULL, grandfathered = false,
                  updated_at = now()
                WHERE id = ${parcelId}`,
    ).catch(() => {});
    await dbMod.db.execute(
      dbMod.sql`DELETE FROM land_parcels WHERE parcel_code LIKE ${`${tag}-%`}`,
    ).catch(() => {});
    await dbMod.db.execute(
      dbMod.sql`DELETE FROM land_transactions WHERE avatar_id = ${avatarId}`,
    ).catch(() => {});
    await dbMod.db.execute(
      dbMod.sql`DELETE FROM land_tenure_settlements WHERE avatar_id = ${avatarId}`,
    ).catch(() => {});

    if (treasuryId) {
      const credits = await dbMod.db.execute<{ amount: number | string }>(
        dbMod.sql`SELECT COALESCE(SUM(amount), 0)::int AS amount
                  FROM claw_token_transactions
                  WHERE avatar_id = ${treasuryId}
                    AND metadata ->> 'idempotencyKey' LIKE ${`${tag}%`}`,
      ).catch(() => [] as Array<{ amount: number | string }>);
      const credited = Number(Array.from(credits)[0]?.amount ?? 0);
      if (credited > 0) {
        await dbMod.db.execute(
          dbMod.sql`UPDATE avatars
                    SET claw_tokens = claw_tokens - ${credited},
                        soft_balance = soft_balance - ${credited}
                    WHERE id = ${treasuryId}`,
        ).catch(() => {});
        await dbMod.db.execute(
          dbMod.sql`DELETE FROM claw_token_transactions
                    WHERE avatar_id = ${treasuryId}
                      AND metadata ->> 'idempotencyKey' LIKE ${`${tag}%`}`,
        ).catch(() => {});
      }
    }
    await dbMod.db.execute(
      dbMod.sql`DELETE FROM claw_token_transactions WHERE avatar_id = ${avatarId}`,
    ).catch(() => {});
    await dbMod.db.execute(dbMod.sql`DELETE FROM avatars WHERE id = ${avatarId}`).catch(() => {});
    await dbMod.db.execute(dbMod.sql`DELETE FROM users WHERE id = ${userId}`).catch(() => {});
  });

  it('charges week one irrevocably, replays claim/release once, and rejects a stale release after reacquire', async () => {
    const claimKey = `${tag}-claim-a`;
    const releaseKey = `${tag}-release-a`;
    const tenantBefore = await balance(avatarId);
    const treasuryBefore = await balance(treasuryId);

    const claim = await settleTenureClaim({ ...input(claimKey), door: 'rent', weeks: 3 });
    expect(claim.fresh).toBe(true);
    expect(await balance(avatarId)).toBe(tenantBefore - weeklyCt * 3);
    expect(await balance(treasuryId)).toBe(treasuryBefore + weeklyCt);

    const claimReplay = await settleTenureClaim({ ...input(claimKey), door: 'rent', weeks: 3 });
    expect(claimReplay.fresh).toBe(false);
    expect(await balance(avatarId)).toBe(tenantBefore - weeklyCt * 3);

    const release = await settleTenureRelease(input(releaseKey));
    expect(release.fresh).toBe(true);
    expect(release.refundedCt).toBe(weeklyCt * 2);
    expect(await balance(avatarId)).toBe(tenantBefore - weeklyCt);

    const releaseReplay = await settleTenureRelease(input(releaseKey));
    expect(releaseReplay.fresh).toBe(false);
    expect(releaseReplay.tenancyAcquiredAt).toBe(release.tenancyAcquiredAt);
    expect(await balance(avatarId)).toBe(tenantBefore - weeklyCt);

    await settleTenureClaim({ ...input(`${tag}-claim-b`), door: 'rent', weeks: 1 });
    await settleTenureRelease(input(`${tag}-release-b`));
    expect(await settlementRejection(() => settleTenureRelease(input(releaseKey)))).toEqual({
      code: 'idempotency_key_conflict',
      status: 409,
    });
  }, 30_000);

  it('allows agent first-declare, blocks live-hold repoint, and requires a human for any change', async () => {
    const walletA = Keypair.generate().publicKey.toBase58();
    const walletB = Keypair.generate().publicKey.toBase58();
    const firstDeclare = await declareLandHoldWallet(agentIdentity(), walletA);
    expect(firstDeclare).toMatchObject({ firstDeclaration: true, changed: true });

    await dbMod.db.execute(
      dbMod.sql`INSERT INTO land_parcels
                  (parcel_code, tier, status, grid_x, grid_y, owner_avatar_id,
                   tenure, tenure_terms_version, acquired_at, hold_threshold_ct, grandfathered)
                VALUES (${`${tag}-wallet-hold`}, 'starter', 'owned', -910001, -910001,
                        ${avatarId}, 'hold', 2, now(), 100000, false)`,
    );
    expect(
      await settlementRejection(() => declareLandHoldWallet(humanIdentity(), walletB)),
    ).toEqual({
      code: 'wallet_locked_by_hold',
      status: 409,
    });
    await dbMod.db.execute(
      dbMod.sql`DELETE FROM land_parcels WHERE parcel_code = ${`${tag}-wallet-hold`}`,
    );

    expect(
      await settlementRejection(() => declareLandHoldWallet(agentIdentity(), walletB)),
    ).toEqual({
      code: 'wallet_change_requires_human',
      status: 409,
    });
    const humanChange = await declareLandHoldWallet(humanIdentity(), walletB);
    expect(humanChange).toMatchObject({ firstDeclaration: false, changed: true });
  }, 30_000);

  it('enforces autonomous daily admission and the five-parcel admission cap in the real DB', async () => {
    await dbMod.db.execute(
      dbMod.sql`UPDATE avatars SET claw_tokens = 100000, soft_balance = 100000,
                bought_balance = 0, earned_balance = 0 WHERE id = ${avatarId}`,
    );
    const dailyCap = resolveAgentLandDailySpendVclaw();
    await debitClawTokens({
      avatarId,
      amount: dailyCap,
      reason: 'land_deposit_topup',
      source: 'system',
      metadata: { autonomousLand: true, testTag: tag },
      actorKind: 'agent',
    });
    expect(
      await settlementRejection(() =>
        settleTenureClaim({ ...input(`${tag}-cap-daily`, true), door: 'rent', weeks: 1 }),
      ),
    ).toEqual({ code: 'autonomous_daily_cap', status: 429 });

    for (let i = 0; i < MAX_PARCELS_PER_AVATAR; i += 1) {
      await dbMod.db.execute(
        dbMod.sql`INSERT INTO land_parcels
                    (parcel_code, tier, status, grid_x, grid_y, owner_avatar_id,
                     tenure, tenure_terms_version, acquired_at, hold_threshold_ct, grandfathered)
                  VALUES (${`${tag}-cap-${i}`}, 'starter', 'owned', ${-920000 - i}, ${-920000 - i},
                          ${avatarId}, 'hold', 2, now(), 1, false)`,
      );
    }
    expect(
      await settlementRejection(() =>
        settleTenureClaim({ ...input(`${tag}-cap-parcels`), door: 'rent', weeks: 1 }),
      ),
    ).toEqual({ code: 'parcel_cap_reached', status: 409 });
    await dbMod.db.execute(
      dbMod.sql`DELETE FROM land_parcels WHERE parcel_code LIKE ${`${tag}-cap-%`}`,
    );
  }, 30_000);

  it('executes both new CHECK constraints and keeps malformed legacy escrow outside the v2 scope', async () => {
    expect(
      await rejectionCode(() =>
        dbMod.db.transaction(async (tx) => {
          await tx.execute(
            dbMod.sql`UPDATE land_parcels SET tenure = 'hold', tenure_terms_version = NULL
                      WHERE id = ${parcelId}`,
          );
        }),
      ),
    ).toBe('23514');

    expect(
      await rejectionCode(() =>
        dbMod.db.transaction(async (tx) => {
          await tx.execute(
            dbMod.sql`UPDATE land_parcels SET tenure = 'deposit', tenure_terms_version = 2,
                        deposit_remaining_ct = NULL, rent_ct_weekly = NULL
                      WHERE id = ${parcelId}`,
          );
        }),
      ),
    ).toBe('23514');

    let legacyMalformedAllowed = false;
    let rollbackSeen = false;
    try {
      await dbMod.db.transaction(async (tx) => {
        await tx.execute(
          dbMod.sql`UPDATE land_parcels SET tenure = 'deposit', tenure_terms_version = 1,
                      deposit_remaining_ct = NULL, rent_ct_weekly = NULL
                    WHERE id = ${parcelId}`,
        );
        legacyMalformedAllowed = true;
        throw new Error('intentional rollback');
      });
    } catch (err) {
      rollbackSeen = (err as Error).message === 'intentional rollback';
    }
    expect(legacyMalformedAllowed).toBe(true);
    expect(rollbackSeen).toBe(true);
  }, 30_000);
});
