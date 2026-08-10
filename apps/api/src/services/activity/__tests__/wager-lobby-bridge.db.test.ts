/**
 * Real-Postgres regression coverage for the wager-abort recovery sweep.
 *
 * The sweep's innerJoin compares activity_rooms.id (uuid) to lobbies.room_id
 * (text). Shipped without a cast it threw 42883 `operator does not exist:
 * uuid = text` on EVERY tick from the P4 deploy until 2026-07-31 (240
 * fails/4h on staging) — and no test executed the query against a real
 * database, so the suite stayed green. This test exists so a never-executing
 * sweep can never ship green again: it runs the ACTUAL sweep query + recovery
 * against DATABASE_URL.
 *
 * Fixture design keeps recovery deterministic and chain-free: the DB legs
 * (query, fence, current-row reads, markCancelled) run REAL against
 * DATABASE_URL, while only the two chain legs (readChainState, cancelLobby)
 * are injected through the sweep's deps seam — the exact seam production
 * threads. An unconfirmed create deliberately QUARANTINES
 * (wager_create_reconciliation_required), so the eligible row is seeded
 * 'confirmed'.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;
const dbMod = process.env.DATABASE_URL ? ((await import('@clawville/database')) as any) : null;

const DB_TEST_TIMEOUT_MS = 60_000;
const DB_HOOK_TIMEOUT_MS = 120_000;

describeIfDb('wager-abort recovery sweep — real PostgreSQL', () => {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const email = `wager-sweep-db-${suffix}@clawville-test.invalid`;

  let userId = '';
  let avatarId = '';
  let activityId = '';
  const roomIds: string[] = [];
  const lobbyIds: string[] = [];

  /** Insert one lobby row with shared fixture defaults. */
  async function seedLobby(overrides: Record<string, unknown>): Promise<string> {
    const [row] = await dbMod.db
      .insert(dbMod.lobbies)
      .values({
        activityId,
        creatorUserId: userId,
        creatorAvatarId: avatarId,
        maxPlayers: 2,
        mode: 'multiplayer',
        state: 'open',
        onChainCreateStatus: 'prepared',
        ...overrides,
      })
      .returning({ id: dbMod.lobbies.id });
    lobbyIds.push(row.id);
    return row.id;
  }

  /** Insert one activity_rooms row (uuid pk) and track it for cleanup. */
  async function seedRoom(status: string): Promise<string> {
    const [row] = await dbMod.db
      .insert(dbMod.activityRooms)
      .values({
        activityId,
        shortCode: Math.random().toString(36).slice(2, 8).toUpperCase(),
        status,
        playerCount: 2,
      })
      .returning({ id: dbMod.activityRooms.id });
    roomIds.push(row.id);
    return row.id;
  }

  beforeAll(async () => {
    // The sweep filters to WAGER_ABORT_ACTIVITY_IDS (bumper-shells/reef-race);
    // both are seeded world activities — resolve one that exists.
    const activityRows = await dbMod.db
      .select({ id: dbMod.activities.id })
      .from(dbMod.activities)
      .where(dbMod.inArray(dbMod.activities.id, ['reef-race', 'bumper-shells']))
      .limit(1);
    if (activityRows.length === 0) throw new Error('no wager-abort activity seeded in this DB');
    activityId = activityRows[0].id;

    const [user] = await dbMod.db
      .insert(dbMod.users)
      .values({
        email,
        passwordHash: `$test$disabled$${suffix}`,
        emailVerified: true,
        name: 'Wager Sweep DB Test',
        isGuest: false,
      })
      .returning({ id: dbMod.users.id });
    userId = user.id;

    const [avatar] = await dbMod.db
      .insert(dbMod.avatars)
      .values({
        userId,
        name: `WagerSweep${Date.now().toString(36)}${Math.floor(Math.random() * 10_000)}`,
        species: 'cat',
        color: 'red',
        gender: 'male',
        archetype: 'curious-scholar',
        personality: { habitat: 'reef', hobby: 'testing', greeting: 'hello' },
        stats: { strength: 5, defence: 5, movement: 5 },
        clawTokens: 0,
        softBalance: 0,
        boughtBalance: 0,
        earnedBalance: 0,
      })
      .returning({ id: dbMod.avatars.id });
    avatarId = avatar.id;
  }, DB_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    if (!dbMod) return;
    if (lobbyIds.length) {
      await dbMod.db.delete(dbMod.lobbies).where(dbMod.inArray(dbMod.lobbies.id, lobbyIds));
    }
    if (roomIds.length) {
      await dbMod.db
        .delete(dbMod.activityRooms)
        .where(dbMod.inArray(dbMod.activityRooms.id, roomIds));
    }
    if (userId) {
      // avatars cascade on user delete
      await dbMod.db.delete(dbMod.users).where(dbMod.eq(dbMod.users.id, userId));
    }
  }, DB_HOOK_TIMEOUT_MS);

  it(
    'executes the uuid::text join, selects exactly the eligible row, and recovers it',
    async () => {
      // Eligible: aborted_crash room + open multiplayer lobby, roomId = room uuid AS TEXT.
      const crashedRoomId = await seedRoom('aborted_crash');
      const eligibleLobbyId = await seedLobby({
        roomId: crashedRoomId,
        onChainCreateStatus: 'confirmed',
      });

      // Non-uuid roomId — must neither match nor break the query (the cast is on
      // the uuid side precisely because this column can carry non-uuid ids).
      await seedLobby({ roomId: `not-a-uuid-${suffix}` });

      // Filter checks — each differs by exactly one predicate:
      const completedRoomId = await seedRoom('completed');
      await seedLobby({ roomId: completedRoomId }); // room status not aborted_crash
      await seedLobby({ roomId: crashedRoomId, state: 'settled' }); // lobby state filtered
      await seedLobby({ roomId: crashedRoomId, mode: 'solo-bots' }); // mode filtered

      const { sweepAbortedCrashWagerLobbies, productionWagerAbortRecoveryDeps } =
        await import('../wager-lobby-bridge');
      const chainCancels: bigint[] = [];
      const result = await sweepAbortedCrashWagerLobbies({
        ...productionWagerAbortRecoveryDeps,
        readChainState: async () => 'open',
        cancelLobby: async (input: any) => {
          chainCancels.push(input.lobbyIdBigint);
          return { txSig: `test-sweep-sig-${suffix}` } as any;
        },
      });

      // The join executed (no 42883) and selected ONLY the eligible row.
      expect(result.attempted).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.recovered).toBe(1);

      // Exactly one settlement-authority chain cancel was issued and the DB
      // markCancelled leg recorded its signature.
      expect(chainCancels.length).toBe(1);
      const [after] = await dbMod.db
        .select({
          state: dbMod.lobbies.state,
          cancelSig: dbMod.lobbies.onChainCancelSig,
        })
        .from(dbMod.lobbies)
        .where(dbMod.eq(dbMod.lobbies.id, eligibleLobbyId));
      expect(after.state).toBe('cancelled');
      expect(after.cancelSig).toBe(`test-sweep-sig-${suffix}`);

      // Untouched rows stayed untouched.
      const others = await dbMod.db
        .select({ id: dbMod.lobbies.id, state: dbMod.lobbies.state })
        .from(dbMod.lobbies)
        .where(dbMod.inArray(dbMod.lobbies.id, lobbyIds));
      for (const row of others) {
        if (row.id === eligibleLobbyId) continue;
        expect(row.state).not.toBe('cancelled');
      }
    },
    DB_TEST_TIMEOUT_MS,
  );
});
