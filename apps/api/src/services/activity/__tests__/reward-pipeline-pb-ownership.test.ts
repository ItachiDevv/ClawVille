/**
 * Deterministic adversarial schedules for durable Reef PB reward ownership.
 * No timers or sleep-based races: deferred gates choose the exact winner.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const activityResultsTable = {
  id: 'result_id',
  roomId: 'room_id',
  activityId: 'activity_id',
  avatarId: 'avatar_id',
  createdAt: 'created_at',
  scoreMs: 'score_ms',
};
const claimsTable = {
  id: 'claim_id',
  sourceRoomId: 'source_room_id',
  avatarId: 'avatar_id',
  bestLapMs: 'best_lap_ms',
  previousBestLapMs: 'previous_best_lap_ms',
  dailyRank: 'daily_rank',
};
const avatarsTable = {
  id: 'avatar_id',
  flags: 'flags',
  isGuest: 'is_guest',
  userId: 'user_id',
  level: 'level',
};
const usersTable = { id: 'user_id', isGuest: 'is_guest' };

interface ClaimRow {
  bestLapMs: number;
  previousBestLapMs: number | null;
  dailyRank: number | null;
}

const claims = new Map<string, ClaimRow>();
const results = new Map<string, Record<string, unknown>>();
const credits: Array<{ roomId: string; amount: number }> = [];
const failCreditOnce = new Set<string>();
let activeRoomId = '';
let activeAvatarId = '';
let resultCommitted = deferred();

function claimKey(roomId: string, avatarId: string): string {
  return `${roomId}:${avatarId}`;
}

function makeRowsThenable(rows: unknown[]) {
  return {
    then(resolve: (value: unknown[]) => unknown) {
      return Promise.resolve(rows).then(resolve);
    },
    groupBy() {
      return Promise.resolve(rows);
    },
    limit() {
      return Promise.resolve(rows);
    },
  };
}

function makeSelect(cols: Record<string, unknown> | undefined) {
  const keys = Object.keys(cols ?? {});
  return {
    from(table: unknown) {
      if (table === claimsTable) {
        const claim = claims.get(claimKey(activeRoomId, activeAvatarId));
        return {
          where() {
            return makeRowsThenable(claim ? [claim] : []);
          },
        };
      }
      if (table === avatarsTable) {
        const flagRows = [{
          id: activeAvatarId,
          flags: null,
          avatarGuest: false,
          userGuest: false,
        }];
        return {
          leftJoin() {
            return { where: () => Promise.resolve(flagRows) };
          },
          where() {
            return makeRowsThenable(
              keys.includes('level')
                ? [{ id: activeAvatarId, level: 1 }]
                : flagRows,
            );
          },
        };
      }
      if (table === activityResultsTable) {
        const rows = keys.includes('cnt')
          ? [{ avatarId: activeAvatarId, cnt: 1 }]
          : [];
        return { where: () => makeRowsThenable(rows) };
      }
      return { where: () => makeRowsThenable([]) };
    },
  };
}

const dbMock = {
  select(cols?: Record<string, unknown>) {
    return makeSelect(cols);
  },
  async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    const localResults = new Map(results);
    const pendingCredits: Array<{ roomId: string; amount: number }> = [];
    const tx = {
      pendingCredits,
      select(cols?: Record<string, unknown>) {
        return makeSelect(cols);
      },
      insert(table: unknown) {
        if (table !== activityResultsTable) {
          throw new Error('unexpected insert table');
        }
        return {
          values(values: Record<string, unknown>) {
            return {
              onConflictDoNothing() {
                return {
                  returning() {
                    const key = claimKey(
                      String(values.roomId),
                      String(values.avatarId),
                    );
                    if (localResults.has(key)) return Promise.resolve([]);
                    const row = { id: `result-${localResults.size + 1}`, ...values };
                    localResults.set(key, row);
                    return Promise.resolve([{ id: row.id }]);
                  },
                };
              },
            };
          },
        };
      },
      execute() {
        return Promise.resolve([{ user_id: 'user-1', claw_tokens: 100 }]);
      },
    };
    const value = await fn(tx);
    results.clear();
    for (const [key, row] of localResults) results.set(key, row);
    credits.push(...pendingCredits);
    resultCommitted.resolve();
    return value;
  },
};

mock.module('@clawville/database', () => ({
  db: dbMock,
  activityResults: activityResultsTable,
  reefRacePersonalBestClaims: claimsTable,
  reefRacePersonalBests: {
    avatarId: 'avatar_id',
    activityId: 'activity_id',
    bestLapMs: 'best_lap_ms',
    sourceRoomId: 'source_room_id',
  },
  avatars: avatarsTable,
  users: usersTable,
  activityRooms: { id: 'room_id', status: 'status' },
  activityRoomParticipants: { roomId: 'room_id', avatarId: 'avatar_id' },
  activityReplays: { id: 'replay_id' },
  clawTokenTransactions: { id: 'ledger_id' },
}));

let duplicateMode = false;
let duplicateCallCount = 0;
let firstClaimWritten = deferred();
let secondPbReturned = deferred();
let allowFirstPbReturn = deferred();

mock.module('../reef-race-personal-best-service', () => ({
  maybeUpdatePersonalBest: async (input: {
    sourceRoomId: string;
    avatarId: string;
    newBestLapMs: number;
    ghostReplayData: { frames: unknown[] };
  }) => {
    activeRoomId = input.sourceRoomId;
    activeAvatarId = input.avatarId;
    const key = claimKey(input.sourceRoomId, input.avatarId);
    const existing = claims.get(key);
    if (duplicateMode) {
      duplicateCallCount += 1;
      if (duplicateCallCount === 1) {
        claims.set(key, {
          bestLapMs: input.newBestLapMs,
          previousBestLapMs: null,
          dailyRank: 1,
        });
        firstClaimWritten.resolve();
        await allowFirstPbReturn.promise;
        return {
          improved: true,
          claimedBySourceRoom: true,
          previousMs: null,
          dailyRank: 1,
          newGhostFrames: input.ghostReplayData.frames,
        };
      }
      secondPbReturned.resolve();
      return {
        improved: false,
        claimedBySourceRoom: false,
        previousMs: null,
        dailyRank: null,
      };
    }
    if (!existing) {
      claims.set(key, {
        bestLapMs: input.newBestLapMs,
        previousBestLapMs: null,
        dailyRank: 1,
      });
      return {
        improved: true,
        claimedBySourceRoom: true,
        previousMs: null,
        dailyRank: 1,
        newGhostFrames: input.ghostReplayData.frames,
      };
    }
    // Deliberately model the old transient false return. Settlement must use
    // the durable row above, not this value.
    return {
      improved: false,
      claimedBySourceRoom: false,
      previousMs: input.newBestLapMs,
      dailyRank: null,
    };
  },
  loadPersonalBest: () => Promise.resolve(null),
  loadPersonalBestGhostFrames: () => Promise.resolve(undefined),
}));

mock.module('../../claw-token-ledger', () => ({
  creditClawTokens: async (
    input: { amount: number; metadata: { roomId: string } },
    tx: { pendingCredits: Array<{ roomId: string; amount: number }> },
  ) => {
    const roomId = input.metadata.roomId;
    if (failCreditOnce.delete(roomId)) {
      throw new Error(`forced reward rollback for ${roomId}`);
    }
    tx.pendingCredits.push({ roomId, amount: input.amount });
    return { balanceAfter: 100 + input.amount, ledgerId: `ledger-${roomId}` };
  },
}));

mock.module('../../event-logger', () => ({
  logEvent: () => Promise.resolve(),
  ACTIVITY_EVENT_TYPES: { MATCH_PLACED: 'activity.match.placed' },
}));
mock.module('../alert-error', () => ({ alertError: () => Promise.resolve() }));

const { issueRewardsForRoom } = await import('../reward-pipeline');
import type { Room, RoomParticipant } from '../types';

const AVATAR_ID = '00000000-0000-0000-0000-0000000000a1';

function buildRoom(id: string): Room {
  const now = Date.now();
  const participant: RoomParticipant = {
    avatarId: AVATAR_ID,
    userId: 'user-1',
    agentId: null,
    subjectType: 'human',
    partyId: null,
    joinedAt: now,
    connected: true,
    disconnectedAt: null,
    wsConnectionId: null,
  };
  return {
    id,
    shortCode: 'PBTEST',
    activityId: 'reef-race',
    state: 'results',
    participants: new Map([[AVATAR_ID, participant]]),
    countdownStartedAt: now - 5_000,
    startedAt: now - 90_000,
    endedAt: now,
    createdAt: now - 100_000,
    lastTouchedAt: now,
    hasBots: false,
    hasAgents: false,
    activityConfig: { minPlayers: 4, maxPlayers: 8, preferredPlayers: 6 },
    preLaunchBuffer: null,
  };
}

function settle(roomId: string, bestLapMs: number) {
  activeRoomId = roomId;
  activeAvatarId = AVATAR_ID;
  return issueRewardsForRoom({
    room: buildRoom(roomId),
    simResults: [{
      avatarId: AVATAR_ID,
      placement: 4,
      score: -140_000,
      scoreMs: 140_000,
      reefRace: {
        bestLapMs,
        ghostReplayFrames: [{ t: 0, x: 0, z: 0, rot: 0 }],
        bestStreakThisMatch: 0,
        currentStreakAtMatchEnd: 0,
      },
    }],
  });
}

beforeEach(() => {
  claims.clear();
  results.clear();
  credits.length = 0;
  failCreditOnce.clear();
  duplicateMode = false;
  duplicateCallCount = 0;
  activeRoomId = '';
  activeAvatarId = AVATAR_ID;
  resultCommitted = deferred();
  firstClaimWritten = deferred();
  secondPbReturned = deferred();
  allowFirstPbReturn = deferred();
});

describe('durable PB reward ownership', () => {
  it('pays the result-conflict winner even when its transient PB return is false', async () => {
    const roomId = '00000000-0000-0000-0000-000000000101';
    duplicateMode = true;

    const trueClaimant = settle(roomId, 12_000);
    await firstClaimWritten.promise;
    const transientFalseClaimant = settle(roomId, 12_000);
    await secondPbReturned.promise;
    await resultCommitted.promise;
    allowFirstPbReturn.resolve();

    const [first, second] = await Promise.all([
      trueClaimant,
      transientFalseClaimant,
    ]);
    expect(first).toHaveLength(0);
    expect(second).toHaveLength(1);
    expect(second[0].isPersonalBest).toBe(true);
    expect(second[0].breakdown.personalBestBonus).toBe(10);
    expect(second[0].tokensAwarded).toBe(25);
    expect(credits).toEqual([{ roomId, amount: 25 }]);
  });

  it('pays room A after PB commit, reward rollback, faster room B, and A retry', async () => {
    const roomA = '00000000-0000-0000-0000-000000000201';
    const roomB = '00000000-0000-0000-0000-000000000202';
    failCreditOnce.add(roomA);

    await expect(settle(roomA, 13_000)).rejects.toThrow(
      'forced reward rollback',
    );
    expect(results.has(claimKey(roomA, AVATAR_ID))).toBe(false);
    expect(claims.has(claimKey(roomA, AVATAR_ID))).toBe(true);

    const settledB = await settle(roomB, 12_000);
    expect(settledB[0].breakdown.personalBestBonus).toBe(10);

    const retriedA = await settle(roomA, 13_000);
    expect(retriedA).toHaveLength(1);
    expect(retriedA[0].isPersonalBest).toBe(true);
    expect(retriedA[0].breakdown.personalBestBonus).toBe(10);
    expect(retriedA[0].tokensAwarded).toBe(25);
    expect(credits).toEqual([
      { roomId: roomB, amount: 25 },
      { roomId: roomA, amount: 25 },
    ]);
  });
});
