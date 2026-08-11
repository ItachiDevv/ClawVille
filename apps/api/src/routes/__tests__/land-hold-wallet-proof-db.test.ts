/**
 * Executed land hold-wallet OWNERSHIP-PROOF contract against DATABASE_URL.
 *
 * Covers the legs that only a real database can prove: the CHECK constraints,
 * the two partial UNIQUE indexes door 2 attributes on, the custodial attest
 * (positive + negative), verified-then-changed-wallet losing its proof, the
 * un-forgeable grandfather discriminator, and the hold-claim refusal on an
 * unverified declaration.
 *
 * Skips cleanly when DATABASE_URL is absent OR when migration 0060 has not been
 * applied to the target database yet (the CI migrate gate applies it on push);
 * a skip is reported rather than a false failure.
 *
 * Fixtures are tagged and removed in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import * as dbMod from '@clawville/database';
import type { ActivityIdentity } from '../../middleware/require-auth-or-agent';
import {
  attestCustodialLandHoldWallet,
  declareLandHoldWallet,
  grantLandHoldWalletVerification,
  holdWalletVerificationState,
  readHoldWalletDeclaration,
  settleTenureClaim,
} from '../../services/land-tenure-settlement';

const { db, sql } = dbMod;

/** Cutoff literal — MUST match migration 0060's grandfather stamp exactly. */
const GRANDFATHER_CUTOFF = '2026-08-10 00:00:00+00';

function first<T>(rows: Iterable<T>): T {
  const row = Array.from(rows)[0];
  if (!row) throw new Error('hold-proof DB fixture query returned no row');
  return row;
}

async function failureCode(work: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await work();
    return undefined;
  } catch (err) {
    const failure = err as { code?: string; cause?: { code?: string } };
    return failure.code ?? failure.cause?.code;
  }
}

/** A syntactically valid, unowned base58 pubkey for declaration fixtures. */
function fakePubkey(seed: number): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let out = '';
  let value = seed * 2654435761;
  for (let i = 0; i < 43; i += 1) {
    value = (value * 1103515245 + 12345) >>> 0;
    out += alphabet[value % alphabet.length];
  }
  return out;
}

let schemaReady = false;
if (process.env.DATABASE_URL) {
  try {
    const cols = await db.execute<{ n: number | string }>(
      sql`SELECT COUNT(*)::int AS n FROM information_schema.columns
          WHERE table_name = 'users'
            AND column_name IN ('land_hold_wallet_verified_at',
                                'land_hold_wallet_verified_method',
                                'land_hold_wallet_verified_pubkey',
                                'land_hold_wallet_grandfathered_pubkey')`,
    );
    const tables = await db.execute<{ n: number | string }>(
      sql`SELECT COUNT(*)::int AS n FROM information_schema.tables
          WHERE table_name = 'land_hold_wallet_transfer_challenges'`,
    );
    schemaReady =
      Number(first(cols).n) === 4 && Number(first(tables).n) === 1;
  } catch {
    schemaReady = false;
  }
  if (!schemaReady) {
    console.warn(
      '[land-hold-wallet-proof-db] SKIPPING — migration 0060 is not applied to this DATABASE_URL yet.',
    );
  }
}

const describeIfSchema = schemaReady ? describe : describe.skip;

describeIfSchema('Land hold-wallet ownership proof — executed DB contract', () => {
  const tag = `hp${Date.now().toString(36)}${Math.floor(Math.random() * 46_656).toString(36)}`;
  let userId = '';
  let avatarId = '';
  let parcelCode = '';
  /** A SECOND parcel, borrowed as an already-owned hold and restored after. */
  let heldParcelCode = '';
  const walletA = fakePubkey(1);
  const walletB = fakePubkey(2);
  const custodialWallet = fakePubkey(3);

  const humanIdentity = (): ActivityIdentity => ({
    kind: 'user',
    userId,
    avatarId,
    agentId: null,
  });

  async function proofRow() {
    const rows = await db.execute<{
      land_hold_wallet_pubkey: string | null;
      land_hold_wallet_verified_pubkey: string | null;
      land_hold_wallet_verified_method: string | null;
      land_hold_wallet_grandfathered_pubkey: string | null;
    }>(
      sql`SELECT land_hold_wallet_pubkey, land_hold_wallet_verified_pubkey,
                 land_hold_wallet_verified_method, land_hold_wallet_grandfathered_pubkey
          FROM users WHERE id = ${userId}`,
    );
    return first(rows);
  }

  async function clearDeclaration(): Promise<void> {
    await db.execute(
      sql`UPDATE users SET land_hold_wallet_pubkey = NULL,
                          land_hold_wallet_declared_at = NULL,
                          land_hold_wallet_verified_at = NULL,
                          land_hold_wallet_verified_method = NULL,
                          land_hold_wallet_verified_pubkey = NULL,
                          land_hold_wallet_grandfathered_pubkey = NULL
          WHERE id = ${userId}`,
    );
  }

  beforeAll(async () => {
    const users = await db.execute<{ id: string }>(
      sql`INSERT INTO users (email, password_hash, name)
          VALUES (${`${tag}@clawville-test.invalid`}, ${`disabled-${tag}`}, 'Hold Proof DB Test')
          RETURNING id`,
    );
    userId = first(users).id;
    const avatars = await db.execute<{ id: string }>(
      sql`INSERT INTO avatars
            (user_id, name, species, color, gender, archetype, personality, stats,
             claw_tokens, soft_balance, bought_balance, earned_balance, is_active, is_guest)
          VALUES
            (${userId}, ${tag}, 'cat', 'green', 'male', 'brave-adventurer',
             ${JSON.stringify({ habitat: 'test', hobby: 'testing', greeting: 'hi' })}::jsonb,
             ${JSON.stringify({ strength: 1, defence: 1, movement: 1 })}::jsonb,
             1000, 1000, 0, 0, false, false)
          RETURNING id`,
    );
    avatarId = first(avatars).id;
    const parcels = await db.execute<{ parcel_code: string }>(
      sql`SELECT parcel_code FROM land_parcels
          WHERE status = 'available' AND owner_avatar_id IS NULL
            AND tier IN ('starter', 'c')
          ORDER BY parcel_code LIMIT 2`,
    );
    const codes = Array.from(parcels).map((p) => p.parcel_code);
    parcelCode = codes[0] ?? '';
    if (!parcelCode) throw new Error('hold-proof DB fixture found no available parcel');
    heldParcelCode = codes[1] ?? '';
  });

  afterAll(async () => {
    // The challenge FK is ON DELETE RESTRICT (money ledger), so its rows must be
    // removed before the user row can be.
    await db
      .execute(sql`DELETE FROM land_hold_wallet_verify_scans WHERE destination_pubkey = ${fakePubkey(9)}`)
      .catch(() => {});
    if (heldParcelCode) {
      // Hand the borrowed parcel back exactly as it was found.
      await db
        .execute(
          sql`UPDATE land_parcels
              SET owner_avatar_id = NULL, status = 'available', tenure = NULL,
                  tenure_terms_version = NULL, acquired_at = NULL
              WHERE parcel_code = ${heldParcelCode}`,
        )
        .catch(() => {});
    }
    if (!userId) return;
    await db
      .execute(sql`DELETE FROM land_hold_wallet_transfer_challenges WHERE user_id = ${userId}`)
      .catch(() => {});
    await db
      .execute(sql`DELETE FROM land_tenure_settlements WHERE avatar_id = ${avatarId}`)
      .catch(() => {});
    await db.execute(sql`DELETE FROM avatars WHERE id = ${avatarId}`).catch(() => {});
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`).catch(() => {});
  });

  it('refuses a hold claim on an unverified declaration with wallet_not_verified', async () => {
    await clearDeclaration();
    await declareLandHoldWallet(humanIdentity(), walletA);
    const view = await readHoldWalletDeclaration(userId);
    expect(view?.state).toBe('unverified');

    const code = await failureCode(() =>
      settleTenureClaim({
        identity: humanIdentity(),
        expectedAvatarId: avatarId,
        expectedUserId: userId,
        expectedAgentId: null,
        parcelCode,
        idempotencyKey: `${tag}-unverified`,
        autonomous: false,
        door: 'hold',
      }),
    );
    expect(code).toBe('wallet_not_verified');
  });

  it('opens the verification gate once the wallet is proven', async () => {
    await clearDeclaration();
    await declareLandHoldWallet(humanIdentity(), walletA);
    await grantLandHoldWalletVerification({
      userId,
      expectedWallet: walletA,
      method: 'signature',
    });
    const view = await readHoldWalletDeclaration(userId);
    expect(view?.state).toBe('verified');
    expect(view?.method).toBe('signature');
    expect(view?.verifiedAt).not.toBeNull();

    // The claim still fails downstream (a fixture wallet holds no CLV), but the
    // failure must no longer be the ownership gate.
    const code = await failureCode(() =>
      settleTenureClaim({
        identity: humanIdentity(),
        expectedAvatarId: avatarId,
        expectedUserId: userId,
        expectedAgentId: null,
        parcelCode,
        idempotencyKey: `${tag}-verified`,
        autonomous: false,
        door: 'hold',
      }),
    );
    expect(code).not.toBe('wallet_not_verified');
    expect(code).not.toBe('wallet_not_declared');
  });

  it('destroys the proof when the declaration is repointed (T1)', async () => {
    await clearDeclaration();
    await declareLandHoldWallet(humanIdentity(), walletA);
    await grantLandHoldWalletVerification({
      userId,
      expectedWallet: walletA,
      method: 'signature',
    });
    expect((await readHoldWalletDeclaration(userId))?.state).toBe('verified');

    await declareLandHoldWallet(humanIdentity(), walletB);
    const row = await proofRow();
    expect(row.land_hold_wallet_pubkey).toBe(walletB);
    expect(row.land_hold_wallet_verified_pubkey).toBeNull();
    expect(row.land_hold_wallet_verified_method).toBeNull();
    expect(row.land_hold_wallet_grandfathered_pubkey).toBeNull();
    expect((await readHoldWalletDeclaration(userId))?.state).toBe('unverified');
  });

  it('refuses a proof written against a declaration that moved underneath it', async () => {
    await clearDeclaration();
    await declareLandHoldWallet(humanIdentity(), walletB);
    const code = await failureCode(() =>
      grantLandHoldWalletVerification({
        userId,
        expectedWallet: walletA,
        method: 'signature',
      }),
    );
    expect(code).toBe('wallet_declaration_changed');
  });

  it('auto-attests a declared wallet that IS the avatar custodial wallet', async () => {
    await clearDeclaration();
    await db.execute(
      sql`UPDATE avatars SET wallet_address = ${custodialWallet} WHERE id = ${avatarId}`,
    );
    await declareLandHoldWallet(humanIdentity(), custodialWallet);
    const granted = await attestCustodialLandHoldWallet({ identity: humanIdentity() });
    expect(granted.method).toBe('custodial');
    expect(granted.walletAddress).toBe(custodialWallet);
    const view = await readHoldWalletDeclaration(userId);
    expect(view?.state).toBe('verified');
    expect(view?.method).toBe('custodial');
  });

  it('refuses a custodial attest for a wallet the avatar does not hold', async () => {
    await clearDeclaration();
    await db.execute(
      sql`UPDATE avatars SET wallet_address = ${custodialWallet} WHERE id = ${avatarId}`,
    );
    await declareLandHoldWallet(humanIdentity(), walletA);
    const code = await failureCode(() =>
      attestCustodialLandHoldWallet({ identity: humanIdentity() }),
    );
    expect(code).toBe('not_custodial_wallet');
    expect((await readHoldWalletDeclaration(userId))?.state).toBe('unverified');
  });

  it('refuses a custodial attest with no declaration at all', async () => {
    await clearDeclaration();
    const code = await failureCode(() =>
      attestCustodialLandHoldWallet({ identity: humanIdentity() }),
    );
    expect(code).toBe('wallet_not_declared');
  });

  it('cannot be grandfathered by a FRESH declare (T2 discriminator)', async () => {
    await clearDeclaration();
    await declareLandHoldWallet(humanIdentity(), walletA);

    // Replay migration 0060's EXACT stamp predicate. A declaration made now sits
    // at or after the hard-coded cutoff, so it is never captured.
    const fresh = await db.execute<{ id: string }>(
      sql`UPDATE users
          SET land_hold_wallet_grandfathered_pubkey = land_hold_wallet_pubkey
          WHERE id = ${userId}
            AND land_hold_wallet_pubkey IS NOT NULL
            AND land_hold_wallet_grandfathered_pubkey IS NULL
            AND (land_hold_wallet_declared_at IS NULL
                 OR land_hold_wallet_declared_at < TIMESTAMPTZ ${sql.raw(`'${GRANDFATHER_CUTOFF}'`)})
          RETURNING id`,
    );
    expect(Array.from(fresh)).toHaveLength(0);
    expect((await readHoldWalletDeclaration(userId))?.state).toBe('unverified');

    // Backdate the declaration to before the cutoff and the SAME predicate does
    // stamp it — the discriminator is the timestamp, not the caller.
    await db.execute(
      sql`UPDATE users SET land_hold_wallet_declared_at = TIMESTAMPTZ ${sql.raw(
        `'${GRANDFATHER_CUTOFF}'`,
      )} - interval '1 day' WHERE id = ${userId}`,
    );
    const legacy = await db.execute<{ id: string }>(
      sql`UPDATE users
          SET land_hold_wallet_grandfathered_pubkey = land_hold_wallet_pubkey
          WHERE id = ${userId}
            AND land_hold_wallet_pubkey IS NOT NULL
            AND land_hold_wallet_grandfathered_pubkey IS NULL
            AND (land_hold_wallet_declared_at IS NULL
                 OR land_hold_wallet_declared_at < TIMESTAMPTZ ${sql.raw(`'${GRANDFATHER_CUTOFF}'`)})
          RETURNING id`,
    );
    expect(Array.from(legacy)).toHaveLength(1);
    const view = await readHoldWalletDeclaration(userId);
    expect(view?.state).toBe('grandfathered');
    // Grandfathered is claimable (no eviction, T12) but reports no method.
    expect(view?.method).toBeNull();
    expect(
      holdWalletVerificationState({
        declaredWallet: walletA,
        verifiedPubkey: null,
        verifiedMethod: null,
        grandfatheredPubkey: walletA,
      }),
    ).toBe('grandfathered');
  });

  it('refuses a NEW hold claim on a grandfathered wallet, leaving the existing hold alone', async () => {
    // Adversarial review 2026-08-10: grandfathering means "we do not evict
    // you", NOT "keep acquiring land on a wallet you never proved". The frozen
    // spec §4 let the migration stamp open the hold door, which kept the exact
    // squatter this slice targets in business forever.
    if (!heldParcelCode) {
      console.warn('[land-hold-wallet-proof-db] only one free parcel; skipping the held-parcel leg');
      return;
    }
    await clearDeclaration();
    await declareLandHoldWallet(humanIdentity(), walletA);
    await db.execute(
      sql`UPDATE users SET land_hold_wallet_declared_at = TIMESTAMPTZ ${sql.raw(
        `'${GRANDFATHER_CUTOFF}'`,
      )} - interval '1 day' WHERE id = ${userId}`,
    );
    await db.execute(
      sql`UPDATE users
          SET land_hold_wallet_grandfathered_pubkey = land_hold_wallet_pubkey
          WHERE id = ${userId}
            AND land_hold_wallet_pubkey IS NOT NULL
            AND land_hold_wallet_grandfathered_pubkey IS NULL
            AND (land_hold_wallet_declared_at IS NULL
                 OR land_hold_wallet_declared_at < TIMESTAMPTZ ${sql.raw(
                   `'${GRANDFATHER_CUTOFF}'`,
                 )})`,
    );
    expect((await readHoldWalletDeclaration(userId))?.state).toBe('grandfathered');

    // An EXISTING hold, exactly the kind the no-eviction promise protects.
    await db.execute(
      sql`UPDATE land_parcels
          SET owner_avatar_id = ${avatarId}, status = 'owned', tenure = 'hold',
              tenure_terms_version = 2, acquired_at = now()
          WHERE parcel_code = ${heldParcelCode}`,
    );

    const code = await failureCode(() =>
      settleTenureClaim({
        identity: humanIdentity(),
        expectedAvatarId: avatarId,
        expectedUserId: userId,
        expectedAgentId: null,
        parcelCode,
        idempotencyKey: `${tag}-grandfathered`,
        autonomous: false,
        door: 'hold',
      }),
    );
    expect(code).toBe('wallet_not_verified');

    // The existing hold is untouched, and so is the grandfather record — the
    // refusal governs NEW acquisition only.
    const held = first(
      await db.execute<{ owner_avatar_id: string | null; status: string; tenure: string | null }>(
        sql`SELECT owner_avatar_id, status, tenure FROM land_parcels
            WHERE parcel_code = ${heldParcelCode}`,
      ),
    );
    expect(held.owner_avatar_id).toBe(avatarId);
    expect(held.status).toBe('owned');
    expect(held.tenure).toBe('hold');
    expect((await proofRow()).land_hold_wallet_grandfathered_pubkey).toBe(walletA);
    // And the parcel it tried to claim is still free for someone else.
    const target = first(
      await db.execute<{ status: string }>(
        sql`SELECT status FROM land_parcels WHERE parcel_code = ${parcelCode}`,
      ),
    );
    expect(target.status).toBe('available');

    // Proving the SAME wallet lifts the refusal without any other change.
    await grantLandHoldWalletVerification({
      userId,
      expectedWallet: walletA,
      method: 'signature',
    });
    expect((await readHoldWalletDeclaration(userId))?.state).toBe('verified');
    const afterProof = await failureCode(() =>
      settleTenureClaim({
        identity: humanIdentity(),
        expectedAvatarId: avatarId,
        expectedUserId: userId,
        expectedAgentId: null,
        parcelCode,
        idempotencyKey: `${tag}-grandfathered-proven`,
        autonomous: false,
        door: 'hold',
      }),
    );
    expect(afterProof).not.toBe('wallet_not_verified');

    await db.execute(
      sql`UPDATE land_parcels
          SET owner_avatar_id = NULL, status = 'available', tenure = NULL,
              tenure_terms_version = NULL, acquired_at = NULL
          WHERE parcel_code = ${heldParcelCode}`,
    );
  });

  it('rejects a half-written verification tuple and an unknown method', async () => {
    await clearDeclaration();
    await declareLandHoldWallet(humanIdentity(), walletA);
    const halfWritten = await failureCode(() =>
      db.execute(
        sql`UPDATE users SET land_hold_wallet_verified_pubkey = ${walletA}
            WHERE id = ${userId}`,
      ),
    );
    expect(halfWritten).toBe('23514');
    const badMethod = await failureCode(() =>
      db.execute(
        sql`UPDATE users SET land_hold_wallet_verified_at = now(),
                             land_hold_wallet_verified_method = 'telepathy',
                             land_hold_wallet_verified_pubkey = ${walletA}
            WHERE id = ${userId}`,
      ),
    );
    expect(badMethod).toBe('23514');
    await clearDeclaration();
  });

  describe('door-2 challenge table invariants', () => {
    const destination = fakePubkey(9);
    const openChallenge = (lamports: number, status: string, signature: string | null) =>
      db.execute<{ id: string }>(
        sql`INSERT INTO land_hold_wallet_transfer_challenges
              (user_id, wallet_pubkey, lamports, destination_pubkey, status, expires_at,
               inbound_signature, refund_state)
            VALUES (${userId}, ${walletA}, ${lamports}, ${destination}, ${status},
                    now() + interval '45 minutes', ${signature}, 'none')
            RETURNING id`,
      );

    it('keeps PENDING amounts unique so attribution can never collide (T6)', async () => {
      const amount = 10_000_000 + Math.floor(Math.random() * 100_000);
      await openChallenge(amount, 'pending', null);
      // A SECOND concurrent challenge from the SAME sender must not reuse the
      // amount — the service regenerates on this 23505.
      expect(await failureCode(() => openChallenge(amount, 'pending', null))).toBe('23505');
      // A terminal row may reuse the amount, so the index never exhausts.
      const reused = await openChallenge(amount, 'expired', null);
      expect(Array.from(reused)).toHaveLength(1);
    });

    it('lets one inbound signature satisfy at most one challenge (T7)', async () => {
      const signature = `${tag}-inbound-sig`;
      await openChallenge(20_000_000 + Math.floor(Math.random() * 100_000), 'verified', signature);
      expect(
        await failureCode(() =>
          openChallenge(30_000_000 + Math.floor(Math.random() * 100_000), 'verified', signature),
        ),
      ).toBe('23505');
    });

    it('bounds the status and refund_state vocabularies and the amount', async () => {
      expect(await failureCode(() => openChallenge(40_000_000, 'settled', null))).toBe('23514');
      expect(await failureCode(() => openChallenge(0, 'pending', null))).toBe('23514');
      expect(
        await failureCode(() =>
          db.execute(
            sql`INSERT INTO land_hold_wallet_transfer_challenges
                  (user_id, wallet_pubkey, lamports, destination_pubkey, status, expires_at, refund_state)
                VALUES (${userId}, ${walletA}, 41000000, ${destination}, 'pending',
                        now() + interval '45 minutes', 'refunding')`,
          ),
        ),
      ).toBe('23514');
    });

    it('pairs a rejected row with its reason, and bounds the vocabulary', async () => {
      // A memo-less (or program-signed) inbound is still attributed so the money
      // is refunded, and the reason is what tells the user what went wrong.
      const rows = await db.execute<{ id: string }>(
        sql`INSERT INTO land_hold_wallet_transfer_challenges
              (user_id, wallet_pubkey, lamports, destination_pubkey, status, expires_at,
               inbound_signature, rejected_reason, refund_state)
            VALUES (${userId}, ${walletA}, ${60_000_000 + Math.floor(Math.random() * 100_000)},
                    ${destination}, 'rejected', now() + interval '45 minutes',
                    ${`${tag}-memoless`}, 'memo_missing', 'none')
            RETURNING id`,
      );
      expect(Array.from(rows)).toHaveLength(1);

      // A rejection with no reason, and a reason with no rejection, are both
      // impossible — no silent refusal and no stale explanation.
      expect(
        await failureCode(() =>
          db.execute(
            sql`INSERT INTO land_hold_wallet_transfer_challenges
                  (user_id, wallet_pubkey, lamports, destination_pubkey, status, expires_at, refund_state)
                VALUES (${userId}, ${walletA}, 61000000, ${destination}, 'rejected',
                        now() + interval '45 minutes', 'none')`,
          ),
        ),
      ).toBe('23514');
      expect(
        await failureCode(() =>
          db.execute(
            sql`INSERT INTO land_hold_wallet_transfer_challenges
                  (user_id, wallet_pubkey, lamports, destination_pubkey, status, expires_at,
                   rejected_reason, refund_state)
                VALUES (${userId}, ${walletA}, 62000000, ${destination}, 'pending',
                        now() + interval '45 minutes', 'memo_missing', 'none')`,
          ),
        ),
      ).toBe('23514');
      expect(
        await failureCode(() =>
          db.execute(
            sql`INSERT INTO land_hold_wallet_transfer_challenges
                  (user_id, wallet_pubkey, lamports, destination_pubkey, status, expires_at,
                   rejected_reason, refund_state)
                VALUES (${userId}, ${walletA}, 63000000, ${destination}, 'rejected',
                        now() + interval '45 minutes', 'vibes', 'none')`,
          ),
        ),
      ).toBe('23514');
    });

    it('lets at most ONE row own a given refund signature (B4)', async () => {
      // Refund bytes were deterministic, so two backlogged refunds could produce
      // the SAME signature; Solana deduped the second while both rows recorded
      // `sent`, keeping one user's deposit. The refund now carries a
      // per-challenge memo, and this index is the database backstop.
      const signature = `${tag}-refund-sig`;
      const rows = await db.execute<{ id: string }>(
        sql`INSERT INTO land_hold_wallet_transfer_challenges
              (user_id, wallet_pubkey, lamports, destination_pubkey, status, expires_at,
               inbound_signature, refund_state, refund_signature)
            VALUES (${userId}, ${walletA}, 70000001, ${destination}, 'verified',
                    now() + interval '45 minutes', ${`${tag}-in-1`}, 'sent', ${signature})
            RETURNING id`,
      );
      expect(Array.from(rows)).toHaveLength(1);
      expect(
        await failureCode(() =>
          db.execute(
            sql`INSERT INTO land_hold_wallet_transfer_challenges
                  (user_id, wallet_pubkey, lamports, destination_pubkey, status, expires_at,
                   inbound_signature, refund_state, refund_signature)
                VALUES (${userId}, ${walletA}, 70000002, ${destination}, 'verified',
                        now() + interval '45 minutes', ${`${tag}-in-2`}, 'sent', ${signature})`,
          ),
        ),
      ).toBe('23505');
    });

    it('keeps the refund cap stamp all-or-nothing, and the policy table positive (B2)', async () => {
      const rows = await db.execute<{ id: string }>(
        sql`INSERT INTO land_hold_wallet_transfer_challenges
              (user_id, wallet_pubkey, lamports, destination_pubkey, status, expires_at, refund_state)
            VALUES (${userId}, ${walletA}, 71000000, ${destination}, 'observed',
                    now() + interval '45 minutes', 'none')
            RETURNING id`,
      );
      const id = first(rows).id;
      // A half-written authorization stamp can never read as a spend record.
      expect(
        await failureCode(() =>
          db.execute(
            sql`UPDATE land_hold_wallet_transfer_challenges
                SET refund_cap_day = (now() AT TIME ZONE 'utc')::date WHERE id = ${id}`,
          ),
        ),
      ).toBe('23514');
      const stamped = await db.execute<{ id: string }>(
        sql`UPDATE land_hold_wallet_transfer_challenges
            SET refund_cap_day = (now() AT TIME ZONE 'utc')::date,
                refund_cap_lamports = 500000000,
                refund_authorized_at = now()
            WHERE id = ${id} RETURNING id`,
      );
      expect(Array.from(stamped)).toHaveLength(1);
      // And the day's policy row must be a positive number.
      expect(
        await failureCode(() =>
          db.execute(
            sql`INSERT INTO land_hold_verify_cap_policies (cap_day, cap_lamports)
                VALUES (DATE '1999-01-01', 0)`,
          ),
        ),
      ).toBe('23514');
    });

    it('rejects a non-positive received total (B5)', async () => {
      expect(
        await failureCode(() =>
          db.execute(
            sql`INSERT INTO land_hold_wallet_transfer_challenges
                  (user_id, wallet_pubkey, lamports, inbound_lamports, destination_pubkey,
                   status, expires_at, refund_state)
                VALUES (${userId}, ${walletA}, 72000000, 0, ${destination}, 'observed',
                        now() + interval '45 minutes', 'none')`,
          ),
        ),
      ).toBe('23514');
    });

    it('stores parsed scan FACTS so a later challenge can match without re-parsing (B3)', async () => {
      const signature = `${tag}-scan-sig`;
      await db.execute(
        sql`INSERT INTO land_hold_wallet_verify_scans
              (destination_pubkey, signature, block_time, facts)
            VALUES (${destination}, ${signature}, now(),
                    ${JSON.stringify({
                      failed: false,
                      signers: [walletA],
                      transfers: [{ source: walletA, lamports: 10_000_001, topLevel: true }],
                      memos: [{ text: 'hello', topLevel: true }],
                    })}::jsonb)`,
      );
      const read = first(
        await db.execute<{ facts: unknown; matched: boolean }>(
          sql`SELECT facts, matched FROM land_hold_wallet_verify_scans
              WHERE destination_pubkey = ${destination} AND signature = ${signature}`,
        ),
      );
      const facts = (typeof read.facts === 'string' ? JSON.parse(read.facts) : read.facts) as {
        transfers: Array<{ topLevel: boolean }>;
      };
      expect(facts.transfers[0]?.topLevel).toBe(true);
      expect(read.matched).toBe(false);
      // The (destination, signature) primary key makes the harvest idempotent.
      expect(
        await failureCode(() =>
          db.execute(
            sql`INSERT INTO land_hold_wallet_verify_scans (destination_pubkey, signature)
                VALUES (${destination}, ${signature})`,
          ),
        ),
      ).toBe('23505');
      await db.execute(
        sql`DELETE FROM land_hold_wallet_verify_scans
            WHERE destination_pubkey = ${destination} AND signature = ${signature}`,
      );
    });

    it('represents two verify destinations funded by ONE transaction as separate debts', async () => {
      // The uniqueness key carries the DESTINATION: one transaction can fund a
      // retired and the current verify address, and those are genuinely
      // different debts. Without it they could not even coexist.
      const signature = `${tag}-two-destinations`;
      const retired = fakePubkey(11);
      const insert = (dest: string, recipient: string, lamports: number) =>
        db.execute<{ id: string }>(
          sql`INSERT INTO land_hold_wallet_refund_obligations
                (destination_pubkey, signature, recipient_pubkey, lamports, reason, state)
              VALUES (${dest}, ${signature}, ${recipient}, ${lamports}, 'unclaimed_inbound', 'open')
              RETURNING id`,
        );
      expect(Array.from(await insert(destination, walletA, 111))).toHaveLength(1);
      expect(Array.from(await insert(retired, walletA, 222))).toHaveLength(1);
      // ...but the SAME (destination, signature, recipient, reason) cannot repeat.
      expect(await failureCode(() => insert(destination, walletA, 333))).toBe('23505');
      await db.execute(
        sql`DELETE FROM land_hold_wallet_refund_obligations WHERE signature = ${signature}`,
      );
    });

    it('lets a RETIRED verify wallet coexist with the active one (round 7)', async () => {
      // An unscoped singleton allowed at most ONE land-hold-verify row ever, so
      // rotation was unrepresentable and the retention obligation impossible to
      // obey. The index is now scoped to active rows.
      const activeKey = fakePubkey(21);
      const retiredKey = fakePubkey(22);
      const insert = (key: string, retired: boolean) =>
        db.execute<{ id: string }>(
          sql`INSERT INTO treasury_wallets
                (purpose, public_key, encrypted_secret_key, encryption_iv, encryption_tag, retired_at)
              VALUES ('land-hold-verify'::treasury_purpose, ${key}, 'x', 'y', 'z',
                      ${retired ? sql`now()` : sql`NULL`})
              RETURNING id`,
        );
      try {
        expect(Array.from(await insert(retiredKey, true))).toHaveLength(1);
        expect(Array.from(await insert(activeKey, false))).toHaveLength(1);
        // ...but a SECOND active row is still refused.
        expect(await failureCode(() => insert(fakePubkey(23), false))).toBe('23505');
        // And more retired rows are always fine.
        expect(Array.from(await insert(fakePubkey(24), true))).toHaveLength(1);
      } finally {
        await db
          .execute(
            sql`DELETE FROM treasury_wallets
                WHERE purpose::text = 'land-hold-verify'
                  AND public_key IN (${activeKey}, ${retiredKey}, ${fakePubkey(23)}, ${fakePubkey(24)})`,
          )
          .catch(() => {});
      }
    });

    it('bounds the obligation reason and state vocabularies', async () => {
      const signature = `${tag}-obligation-vocab`;
      expect(
        await failureCode(() =>
          db.execute(
            sql`INSERT INTO land_hold_wallet_refund_obligations
                  (destination_pubkey, signature, recipient_pubkey, lamports, reason, state)
                VALUES (${destination}, ${signature}, ${walletA}, 10, 'because', 'open')`,
          ),
        ),
      ).toBe('23514');
      expect(
        await failureCode(() =>
          db.execute(
            sql`INSERT INTO land_hold_wallet_refund_obligations
                  (destination_pubkey, signature, recipient_pubkey, lamports, reason, state)
                VALUES (${destination}, ${signature}, ${walletA}, 0, 'retained_leg', 'open')`,
          ),
        ),
      ).toBe('23514');
      expect(
        await failureCode(() =>
          db.execute(
            sql`INSERT INTO land_hold_wallet_refund_obligations
                  (destination_pubkey, signature, recipient_pubkey, lamports, reason, state)
                VALUES (${destination}, ${signature}, ${walletA}, 10, 'retained_leg', 'paid')`,
          ),
        ),
      ).toBe('23514');
    });

    it('pairs the refund claim lease columns (capture-before-send)', async () => {
      const rows = await openChallenge(
        50_000_000 + Math.floor(Math.random() * 100_000),
        'verified',
        null,
      );
      const id = first(rows).id;
      expect(
        await failureCode(() =>
          db.execute(
            sql`UPDATE land_hold_wallet_transfer_challenges
                SET refund_claim_id = gen_random_uuid() WHERE id = ${id}`,
          ),
        ),
      ).toBe('23514');
      const paired = await db.execute<{ id: string }>(
        sql`UPDATE land_hold_wallet_transfer_challenges
            SET refund_claim_id = gen_random_uuid(), refund_claimed_at = now(),
                refund_state = 'sending'
            WHERE id = ${id} RETURNING id`,
      );
      expect(Array.from(paired)).toHaveLength(1);
    });
  });
});
