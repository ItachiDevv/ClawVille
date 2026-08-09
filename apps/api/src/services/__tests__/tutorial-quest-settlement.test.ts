/**
 * Tutorial quest settlement — REAL DB suite (gates G-I + G-J Mode A).
 *
 * This is the money path that closes defect D-2: until P6 the tutorial corpus
 * was cookie-gated and human-only. The properties proven here are the ones the
 * parity claim rests on:
 *   - a claim settles ONCE, ever, per (avatar, quest) — under concurrency too,
 *   - each quest lands on its DECLARED rail and the other rail stays zero,
 *   - a human actor and an agent actor take the identical code path and are
 *     interchangeable for idempotency (one avatar = one corpus),
 *   - the four land-quest predicates read canonical land STATE.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { db, sql } from '@clawville/database';
import {
  settleTutorialQuestClaim,
  validateTutorialQuestEngagement,
  type EngagementResult,
} from '../tutorial-quest-settlement';
import { readMaterialBalance } from '../material-ledger';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

/** Bypasses the engagement gate so settlement itself is isolated under test. */
const alwaysQualified = async (): Promise<EngagementResult> => ({ ok: true });

function first<T>(rows: Iterable<T>): T {
  const [row] = Array.from(rows);
  if (!row) throw new Error('expected at least one row');
  return row;
}

/** See the note in material-ledger.test.ts — `expect(p).rejects` hangs on bun 1.3.14. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the promise to reject, but it resolved');
}

describeIfDb('tutorial quest settlement (real DB)', () => {
  const tag = `tqs${Date.now().toString(36)}${Math.floor(Math.random() * 46_656).toString(36)}`;
  let userId = '';
  let avatarId = '';
  let parcelId = '';
  let structureId = '';

  beforeAll(async () => {
    const users = await db.execute<{ id: string }>(
      sql`INSERT INTO users (email, password_hash, name)
          VALUES (${`${tag}@clawville-test.invalid`}, ${`disabled-${tag}`}, 'Quest Settle Test')
          RETURNING id`,
    );
    userId = first(users).id;

    const avatars = await db.execute<{ id: string }>(
      sql`INSERT INTO avatars
            (user_id, name, species, color, gender, archetype, personality, stats,
             claw_tokens, soft_balance, bought_balance, earned_balance, is_active, is_guest)
          VALUES
            (${userId}, ${tag}, 'cat', 'green', 'male', 'brave-adventurer', '{}'::jsonb, '{}'::jsonb,
             0, 0, 0, 0, false, false)
          RETURNING id`,
    );
    avatarId = first(avatars).id;
  });

  afterAll(async () => {
    if (!avatarId) return;
    const clean = (q: ReturnType<typeof sql>) => db.execute(q).catch(() => {});
    if (structureId) {
      await clean(sql`DELETE FROM land_structure_pieces WHERE owner_avatar_id = ${avatarId}`);
      await clean(sql`DELETE FROM land_structures WHERE id = ${structureId}`);
    }
    if (parcelId) {
      // Return the borrowed parcel to the pool exactly as we found it.
      await clean(sql`UPDATE land_parcels
                      SET status = 'available', owner_avatar_id = NULL, tenure = NULL,
                          tenure_terms_version = NULL, acquired_at = NULL,
                          rent_paid_through = NULL, grace_until = NULL,
                          deposit_ct = NULL, deposit_remaining_ct = NULL,
                          hold_threshold_ct = NULL, hold_subject = NULL,
                          grandfathered = false, updated_at = now()
                      WHERE id = ${parcelId}`);
    }
    await clean(sql`DELETE FROM tutorial_quest_claims WHERE avatar_id = ${avatarId}`);
    await clean(sql`DELETE FROM avatar_material_balances WHERE avatar_id = ${avatarId}`);
    await clean(sql`DELETE FROM claw_token_transactions WHERE avatar_id = ${avatarId}`);
    await clean(sql`DELETE FROM avatars WHERE id = ${avatarId}`);
    await clean(sql`DELETE FROM users WHERE id = ${userId}`);
  });

  it('settles a legacy quest on the vCLAW rail and leaves the materials rail at zero', async () => {
    const out = await settleTutorialQuestClaim({
      actor: { kind: 'user', userId, avatarId },
      questId: 'say-hi-nori',
      validateEngagement: alwaysQualified,
    });

    expect(out.kind).toBe('settled');
    if (out.kind !== 'settled') return;
    expect(out.reward).toEqual({ kind: 'vclaw', amount: 5 });
    expect(out.balanceAfter).toBe(5);
    expect(out.ledgerId).not.toBeNull();

    const row = first(
      await db.execute<{ tokens_credited: number; materials_credited: number }>(
        sql`SELECT tokens_credited, materials_credited FROM tutorial_quest_claims
            WHERE avatar_id = ${avatarId} AND quest_id = 'say-hi-nori'`,
      ),
    );
    expect(Number(row.tokens_credited)).toBe(5);
    expect(Number(row.materials_credited)).toBe(0);
    expect(await readMaterialBalance(avatarId)).toBe(0);
  });

  it('settles a land quest on the MATERIALS rail with no vCLAW and no ledger row', async () => {
    const before = first(
      await db.execute<{ claw_tokens: number }>(
        sql`SELECT claw_tokens FROM avatars WHERE id = ${avatarId}`,
      ),
    );

    const out = await settleTutorialQuestClaim({
      actor: { kind: 'agent', userId, avatarId },
      questId: 'homesteader',
      validateEngagement: alwaysQualified,
    });

    expect(out.kind).toBe('settled');
    if (out.kind !== 'settled') return;
    expect(out.reward).toEqual({ kind: 'materials', amount: 15 });
    expect(out.balanceAfter).toBe(15);
    // Land mints NO new vCLAW: the ledger id is null and the CT balance is
    // byte-identical to before the claim.
    expect(out.ledgerId).toBeNull();
    const after = first(
      await db.execute<{ claw_tokens: number }>(
        sql`SELECT claw_tokens FROM avatars WHERE id = ${avatarId}`,
      ),
    );
    expect(Number(after.claw_tokens)).toBe(Number(before.claw_tokens));

    const row = first(
      await db.execute<{ tokens_credited: number; materials_credited: number; ledger_id: string | null }>(
        sql`SELECT tokens_credited, materials_credited, ledger_id FROM tutorial_quest_claims
            WHERE avatar_id = ${avatarId} AND quest_id = 'homesteader'`,
      ),
    );
    expect(Number(row.tokens_credited)).toBe(0);
    expect(Number(row.materials_credited)).toBe(15);
    expect(row.ledger_id).toBeNull();
  });

  it('replays an already-claimed quest without paying twice, whichever subject asks', async () => {
    const balanceBefore = first(
      await db.execute<{ claw_tokens: number }>(
        sql`SELECT claw_tokens FROM avatars WHERE id = ${avatarId}`,
      ),
    );

    // The same avatar, now presenting as an AGENT rather than a human. One
    // avatar means one corpus: the second call must refuse.
    const replay = await settleTutorialQuestClaim({
      actor: { kind: 'agent', userId, avatarId },
      questId: 'say-hi-nori',
      validateEngagement: alwaysQualified,
    });
    expect(replay.kind).toBe('already_claimed');

    const after = first(
      await db.execute<{ claw_tokens: number }>(
        sql`SELECT claw_tokens FROM avatars WHERE id = ${avatarId}`,
      ),
    );
    expect(Number(after.claw_tokens)).toBe(Number(balanceBefore.claw_tokens));

    const rows = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM tutorial_quest_claims
          WHERE avatar_id = ${avatarId} AND quest_id = 'say-hi-nori'`,
    );
    expect(Number(first(rows).n)).toBe(1);
  });

  it('admits exactly one of eight concurrent claims of the same quest', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        settleTutorialQuestClaim({
          actor: { kind: 'user', userId, avatarId },
          questId: 'meet-your-agent',
          validateEngagement: alwaysQualified,
        }),
      ),
    );
    expect(results.filter((r) => r.kind === 'settled')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'already_claimed')).toHaveLength(7);

    const rows = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM tutorial_quest_claims
          WHERE avatar_id = ${avatarId} AND quest_id = 'meet-your-agent'`,
    );
    expect(Number(first(rows).n)).toBe(1);
  });

  it('refuses an unknown quest and an unqualified one, writing nothing either way', async () => {
    const unknown = await settleTutorialQuestClaim({
      actor: { kind: 'user', userId, avatarId },
      questId: 'no-such-quest',
      validateEngagement: alwaysQualified,
    });
    expect(unknown.kind).toBe('unknown_quest');

    const unqualified = await settleTutorialQuestClaim({
      actor: { kind: 'user', userId, avatarId },
      questId: 'cartographer',
      validateEngagement: async () => ({ ok: false, pending: false, reason: 'not_yet' }),
    });
    expect(unqualified.kind).toBe('not_qualified');
    if (unqualified.kind === 'not_qualified') {
      expect(unqualified.pending).toBe(false);
      expect(unqualified.reason).toBe('not_yet');
    }

    const rows = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM tutorial_quest_claims
          WHERE avatar_id = ${avatarId} AND quest_id IN ('no-such-quest', 'cartographer')`,
    );
    expect(Number(first(rows).n)).toBe(0);
  });

  it('lets the database refuse a double-railed or rewardless claim row', async () => {
    // The single-rail CHECK is the backstop that makes a future dispatch bug
    // loud instead of silently paying twice or not at all.
    const bothRails = await rejection(
      db.execute(sql`INSERT INTO tutorial_quest_claims
                       (user_id, avatar_id, quest_id, tokens_credited, materials_credited)
                     VALUES (${userId}, ${avatarId}, ${'both-rails-probe'}, 10, 10)`),
    );
    expect(String(bothRails)).toContain('tutorial_claim_single_rail');

    const noRail = await rejection(
      db.execute(sql`INSERT INTO tutorial_quest_claims
                       (user_id, avatar_id, quest_id, tokens_credited, materials_credited)
                     VALUES (${userId}, ${avatarId}, ${'no-rail-probe'}, 0, 0)`),
    );
    expect(String(noRail)).toContain('tutorial_claim_single_rail');
  });

  it('runs the REAL land predicates against canonical land state', async () => {
    // Every land predicate must be FALSE before any land state exists.
    for (const questId of ['homesteader', 'first-nail', 'yard-work', 'curb-appeal'] as const) {
      const res = await validateTutorialQuestEngagement(userId, avatarId, questId);
      expect(res.ok).toBe(false);
    }

    // Borrow one pooled parcel and give it to the avatar.
    const parcels = await db.execute<{ id: string }>(
      sql`SELECT id FROM land_parcels
          WHERE status = 'available' AND owner_avatar_id IS NULL AND tier = 'starter'
          ORDER BY parcel_code LIMIT 1`,
    );
    parcelId = first(parcels).id;
    await db.execute(
      sql`UPDATE land_parcels SET status = 'owned', owner_avatar_id = ${avatarId},
                                  tenure = 'rented', tenure_terms_version = 2,
                                  acquired_at = now(), updated_at = now()
          WHERE id = ${parcelId}`,
    );
    expect((await validateTutorialQuestEngagement(userId, avatarId, 'homesteader')).ok).toBe(true);
    // Owning a parcel alone must NOT qualify the later rungs.
    expect((await validateTutorialQuestEngagement(userId, avatarId, 'first-nail')).ok).toBe(false);

    const structures = await db.execute<{ id: string }>(
      sql`INSERT INTO land_structures (parcel_id, owner_avatar_id, structure_type, catalog_key, level, status)
          VALUES (${parcelId}, ${avatarId}, 'home', 'starter-home', 1, 'active')
          RETURNING id`,
    );
    structureId = first(structures).id;
    expect((await validateTutorialQuestEngagement(userId, avatarId, 'first-nail')).ok).toBe(true);
    expect((await validateTutorialQuestEngagement(userId, avatarId, 'curb-appeal')).ok).toBe(false);

    // Five pieces is not six — the predicate counts pieces STANDING, so the
    // boundary must be closed.
    for (let i = 0; i < 5; i += 1) {
      await db.execute(
        sql`INSERT INTO land_structure_pieces (parcel_id, owner_avatar_id, piece_key, grid_x, grid_y, rotation_step, stack_level)
            VALUES (${parcelId}, ${avatarId}, 'fence-picket', ${i}, 0, 0, 1)`,
      );
    }
    expect((await validateTutorialQuestEngagement(userId, avatarId, 'yard-work')).ok).toBe(false);
    await db.execute(
      sql`INSERT INTO land_structure_pieces (parcel_id, owner_avatar_id, piece_key, grid_x, grid_y, rotation_step, stack_level)
          VALUES (${parcelId}, ${avatarId}, 'fence-picket', 5, 0, 0, 1)`,
    );
    expect((await validateTutorialQuestEngagement(userId, avatarId, 'yard-work')).ok).toBe(true);

    // Removing a piece un-qualifies you: the reward is for the yard EXISTING.
    await db.execute(
      sql`DELETE FROM land_structure_pieces
          WHERE owner_avatar_id = ${avatarId} AND grid_x = 5 AND grid_y = 0`,
    );
    expect((await validateTutorialQuestEngagement(userId, avatarId, 'yard-work')).ok).toBe(false);

    await db.execute(sql`UPDATE land_structures SET level = 2 WHERE id = ${structureId}`);
    expect((await validateTutorialQuestEngagement(userId, avatarId, 'curb-appeal')).ok).toBe(true);
  });
});
