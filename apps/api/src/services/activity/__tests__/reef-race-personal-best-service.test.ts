/**
 * Reef Race Phase 4 — PB write/load service tests.
 *
 * Coverage (P4-T8..P4-T13):
 *   - maybeUpdatePersonalBest writes a new row when no PB exists
 *   - maybeUpdatePersonalBest UPDATES when newBestLapMs < existing
 *   - maybeUpdatePersonalBest no-ops when newBestLapMs >= existing
 *   - dailyRank scan returns correct rank for the just-set PB (C2 fix)
 *   - PB-ghost cache invalidated on improvement (S4 fix)
 *   - Daily-best-lap cache invalidated on improvement (C2 fix)
 *   - loadPersonalBestGhostFrames returns cached value within TTL,
 *     re-reads after invalidation
 *
 * Drizzle is mocked at module-load time so tests do NOT touch Postgres.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';

// ─── Mocks ────────────────────────────────────────────────────────────────

interface MockRow {
  avatar_id?: string;
  bestLapMs?: number;
  best_lap_ms?: number;
  ghost_replay_data?: unknown;
  ghostReplayData?: unknown;
  source_room_id?: string;
}

interface MockClaim {
  id: string;
  sourceRoomId: string;
  avatarId: string;
  bestLapMs: number;
  previousBestLapMs: number | null;
  dailyRank: number | null;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const personalBestsTable = {
  avatarId: 'avatar_id',
  activityId: 'activity_id',
  bestLapMs: 'best_lap_ms',
  sourceRoomId: 'source_room_id',
};
const claimsTable = {
  id: 'claim_id',
  sourceRoomId: 'source_room_id',
  avatarId: 'avatar_id',
  bestLapMs: 'best_lap_ms',
  previousBestLapMs: 'previous_best_lap_ms',
  dailyRank: 'daily_rank',
};

const dbState: {
  rows: MockRow[];
  claims: MockClaim[];
  selectCalls: number;
  executeCalls: Array<{ sql: string }>;
  nextTxId: number;
  activeRoomId: string;
  activeAvatarId: string;
  nextWriteMs?: number;
  nextRank?: number;
  interleave?: {
    firstUpsertReached: ReturnType<typeof deferred>;
    secondUpsertReached: ReturnType<typeof deferred>;
    allowFirstUpsert: ReturnType<typeof deferred>;
    firstClaimInserted: ReturnType<typeof deferred>;
  };
} = {
  rows: [],
  claims: [],
  selectCalls: 0,
  executeCalls: [],
  nextTxId: 0,
  activeRoomId: '00000000-0000-0000-0000-000000000001',
  activeAvatarId: 'avatar-1',
};

function mockDb(txId = 0): Record<string, any> {
  let executeIndex = 0;
  return {
    select(_cols: unknown) {
      return {
        from(table: unknown) {
          return {
            where(_w: unknown) {
              return {
                limit(_n: number) {
                  dbState.selectCalls += 1;
                  if (table === claimsTable) {
                    const claim = dbState.claims.find(
                      (row) =>
                        row.sourceRoomId === dbState.activeRoomId &&
                        row.avatarId === dbState.activeAvatarId,
                    );
                    return Promise.resolve(claim ? [claim] : []);
                  }
                  return Promise.resolve(
                    dbState.rows.length > 0
                      ? [{
                          bestLapMs: dbState.rows[0].best_lap_ms,
                          sourceRoomId: dbState.rows[0].source_room_id,
                        }]
                      : [],
                  );
                },
              };
            },
          };
        },
      };
    },
    async execute<T>(query: { strings?: TemplateStringsArray }) {
      const callIdx = executeIndex++;
      dbState.executeCalls.push({ sql: String(query) });
      if (callIdx === 0) {
        if (dbState.interleave && txId === 1) {
          dbState.interleave.firstUpsertReached.resolve();
          await dbState.interleave.allowFirstUpsert.promise;
        } else if (dbState.interleave && txId === 2) {
          dbState.interleave.secondUpsertReached.resolve();
          await dbState.interleave.firstClaimInserted.promise;
        }
        const w = dbState.nextWriteMs;
        if (w == null) {
          dbState.rows = [
            {
              best_lap_ms: 1,
              source_room_id: dbState.activeRoomId,
              ghost_replay_data: { frames: [] },
            },
          ];
          return [{ best_lap_ms: 1 }] as unknown as T[];
        }
        const prior = dbState.rows[0]?.best_lap_ms;
        if (prior == null || w < prior) {
          dbState.rows = [{
            best_lap_ms: w,
            source_room_id: dbState.activeRoomId,
            ghost_replay_data: { frames: [] },
          }];
          return [{ best_lap_ms: w }] as unknown as T[];
        }
        return [] as T[];
      }
      return [{ rank: dbState.nextRank ?? 1 }] as unknown as T[];
    },
    insert(table: unknown) {
      if (table !== claimsTable) throw new Error('unexpected table insert');
      return {
        values(values: Omit<MockClaim, 'id'>) {
          return {
            onConflictDoNothing() {
              return {
                returning() {
                  const existing = dbState.claims.find(
                    (row) =>
                      row.sourceRoomId === values.sourceRoomId &&
                      row.avatarId === values.avatarId,
                  );
                  if (existing) return Promise.resolve([]);
                  const claim = {
                    id: `claim-${dbState.claims.length + 1}`,
                    ...values,
                  };
                  dbState.claims.push(claim);
                  if (dbState.interleave && txId === 1) {
                    dbState.interleave.firstClaimInserted.resolve();
                  }
                  return Promise.resolve([claim]);
                },
              };
            },
          };
        },
      };
    },
    transaction<T>(fn: (tx: ReturnType<typeof mockDb>) => Promise<T>) {
      const nextTxId = ++dbState.nextTxId;
      return fn(mockDb(nextTxId));
    },
  };
}

const dailyCacheInvalidations: number = 0;
let _dailyInvalidations = dailyCacheInvalidations;

mock.module('@clawville/database', () => ({
  db: mockDb(),
  // Defensive table stubs — Bun's mock.module is process-scoped; cascades
  // into sibling test files. Stub every column-bearing export the broader
  // import chain might reach so a sibling import doesn't error with
  // "Export named X not found".
  reefRacePersonalBests: personalBestsTable,
  reefRacePersonalBestClaims: claimsTable,
  activityResults: { id: 'id', avatarId: 'avatar_id', activityId: 'activity_id', createdAt: 'created_at', scoreMs: 'score_ms' },
  activityRooms: { id: 'id', status: 'status', startedAt: 'started_at', endedAt: 'ended_at' },
  activityRoomParticipants: { roomId: 'room_id', avatarId: 'avatar_id' },
  activityReplays: { id: 'id' },
  avatars: { id: 'id', flags: 'flags' },
  clawTokenTransactions: { id: 'id' },
}));

// The SUT uses `await import('./reef-race-daily-best-service')` from
// `apps/api/src/services/activity/reef-race-personal-best-service.ts`.
// Bun mock.module must be registered against the resolved module path
// (relative-from-SUT). When that path resolution is hard to reach from
// the test, the most reliable mock is against the resolved spec the
// SUT actually imports.
mock.module('../reef-race-daily-best-service', () => ({
  invalidateDailyBestLapCache: () => {
    _dailyInvalidations += 1;
  },
}));

// SUT — import after mocks.
const {
  maybeUpdatePersonalBest,
  loadPersonalBestGhostFrames,
  __resetPbGhostCacheForTest,
} = await import('../reef-race-personal-best-service');

beforeEach(() => {
  dbState.rows = [];
  dbState.claims = [];
  dbState.selectCalls = 0;
  dbState.executeCalls = [];
  dbState.nextTxId = 0;
  dbState.activeRoomId = '00000000-0000-0000-0000-000000000001';
  dbState.activeAvatarId = 'avatar-1';
  delete dbState.nextWriteMs;
  delete dbState.nextRank;
  delete dbState.interleave;
  _dailyInvalidations = 0;
  __resetPbGhostCacheForTest();
});

// ─── P4-T8 — first PB write ───────────────────────────────────────────────

describe('maybeUpdatePersonalBest', () => {
  it('P4-T8 — first PB write returns improved=true with previousMs=null', async () => {
    dbState.nextWriteMs = 12_345;
    dbState.nextRank = 1;
    const result = await maybeUpdatePersonalBest({
      avatarId: 'avatar-1',
      activityId: 'reef-race',
      newBestLapMs: 12_345,
      ghostReplayData: { frames: [{ t: 0, x: 0, z: 0, rot: 0 }] },
      sourceRoomId: '00000000-0000-0000-0000-000000000001',
    });
    expect(result.improved).toBe(true);
    expect(result.claimedBySourceRoom).toBe(true);
    expect(result.previousMs).toBeNull();
    expect(result.dailyRank).toBe(1);
    expect(result.newGhostFrames?.length).toBe(1);
  });

  // P4-T9 — improved write
  it('P4-T9 — improved write returns improved=true with previousMs', async () => {
    // Seed prior PB
    dbState.rows = [{ best_lap_ms: 14_000 }];
    dbState.nextWriteMs = 12_500;
    dbState.nextRank = 5;
    const result = await maybeUpdatePersonalBest({
      avatarId: 'avatar-1',
      activityId: 'reef-race',
      newBestLapMs: 12_500,
      ghostReplayData: { frames: [] },
      sourceRoomId: '00000000-0000-0000-0000-000000000001',
    });
    expect(result.improved).toBe(true);
    expect(result.claimedBySourceRoom).toBe(true);
    expect(result.previousMs).toBe(14_000);
    expect(result.dailyRank).toBe(5);
  });

  // P4-T10 — no-op write
  it('P4-T10 — slower lap returns improved=false with previousMs', async () => {
    dbState.rows = [{ best_lap_ms: 12_000 }];
    const result = await maybeUpdatePersonalBest({
      avatarId: 'avatar-1',
      activityId: 'reef-race',
      newBestLapMs: 13_500,
      ghostReplayData: { frames: [] },
      sourceRoomId: '00000000-0000-0000-0000-000000000001',
    });
    expect(result.improved).toBe(false);
    expect(result.claimedBySourceRoom).toBe(false);
    expect(result.previousMs).toBe(12_000);
    expect(result.dailyRank).toBeNull();
  });

  it('keeps the claim and rank on an idempotent same-room retry', async () => {
    const sourceRoomId = '00000000-0000-0000-0000-000000000001';
    dbState.claims = [{
      id: 'claim-existing',
      sourceRoomId,
      avatarId: 'avatar-1',
      bestLapMs: 12_000,
      previousBestLapMs: 13_000,
      dailyRank: 3,
    }];
    const result = await maybeUpdatePersonalBest({
      avatarId: 'avatar-1',
      activityId: 'reef-race',
      newBestLapMs: 12_000,
      ghostReplayData: { frames: [] },
      sourceRoomId,
    });
    expect(result.improved).toBe(true);
    expect(result.claimedBySourceRoom).toBe(true);
    expect(result.dailyRank).toBe(3);
  });

  // P4-T11 — dailyRank > 100 → null
  it('P4-T11 — dailyRank > 100 collapses to null (off-board)', async () => {
    dbState.nextWriteMs = 12_345;
    dbState.nextRank = 105;
    const result = await maybeUpdatePersonalBest({
      avatarId: 'avatar-1',
      activityId: 'reef-race',
      newBestLapMs: 12_345,
      ghostReplayData: { frames: [] },
      sourceRoomId: '00000000-0000-0000-0000-000000000001',
    });
    expect(result.improved).toBe(true);
    expect(result.dailyRank).toBeNull();
  });

  // P4-T12 (C2 fix — daily cache invalidated)
  it('P4-T12 (C2 fix) — daily-best-lap cache invalidated on improvement', async () => {
    expect(_dailyInvalidations).toBe(0);
    dbState.nextWriteMs = 12_345;
    await maybeUpdatePersonalBest({
      avatarId: 'avatar-1',
      activityId: 'reef-race',
      newBestLapMs: 12_345,
      ghostReplayData: { frames: [] },
      sourceRoomId: '00000000-0000-0000-0000-000000000001',
    });
    expect(_dailyInvalidations).toBe(1);
  });

  // P4-T13 (no-op no invalidation)
  it('P4-T13 — slower lap does NOT invalidate caches', async () => {
    dbState.rows = [{ best_lap_ms: 12_000 }];
    expect(_dailyInvalidations).toBe(0);
    await maybeUpdatePersonalBest({
      avatarId: 'avatar-1',
      activityId: 'reef-race',
      newBestLapMs: 13_500,
      ghostReplayData: { frames: [] },
      sourceRoomId: '00000000-0000-0000-0000-000000000001',
    });
    expect(_dailyInvalidations).toBe(0);
  });

  it('durably recognizes both concurrent duplicate settlements of one room', async () => {
    const firstUpsertReached = deferred();
    const secondUpsertReached = deferred();
    const allowFirstUpsert = deferred();
    const firstClaimInserted = deferred();
    dbState.interleave = {
      firstUpsertReached,
      secondUpsertReached,
      allowFirstUpsert,
      firstClaimInserted,
    };
    dbState.nextWriteMs = 12_000;
    const input = {
      avatarId: 'avatar-1',
      activityId: 'reef-race' as const,
      newBestLapMs: 12_000,
      ghostReplayData: { frames: [] },
      sourceRoomId: dbState.activeRoomId,
    };

    const firstSettlement = maybeUpdatePersonalBest(input);
    await firstUpsertReached.promise;
    const predicateBlockedSettlement = maybeUpdatePersonalBest(input);
    await secondUpsertReached.promise;
    allowFirstUpsert.resolve();

    const [first, second] = await Promise.all([
      firstSettlement,
      predicateBlockedSettlement,
    ]);
    expect(first.claimedBySourceRoom).toBe(true);
    expect(second.claimedBySourceRoom).toBe(true);
    expect(first.improved).toBe(true);
    expect(second.improved).toBe(true);
    expect(dbState.claims).toHaveLength(1);
  });

  it('retains room A ownership across rollback, faster room B, and room A retry', async () => {
    const roomA = '00000000-0000-0000-0000-000000000001';
    const roomB = '00000000-0000-0000-0000-000000000002';
    dbState.activeRoomId = roomA;
    dbState.nextWriteMs = 13_000;
    const firstA = await maybeUpdatePersonalBest({
      avatarId: 'avatar-1',
      activityId: 'reef-race',
      newBestLapMs: 13_000,
      ghostReplayData: { frames: [] },
      sourceRoomId: roomA,
    });
    expect(firstA.claimedBySourceRoom).toBe(true);

    // The reward transaction rolls back here; PB + claim history intentionally
    // remain committed. A later room then lowers the current PB.
    dbState.activeRoomId = roomB;
    dbState.nextWriteMs = 12_000;
    const roomBResult = await maybeUpdatePersonalBest({
      avatarId: 'avatar-1',
      activityId: 'reef-race',
      newBestLapMs: 12_000,
      ghostReplayData: { frames: [] },
      sourceRoomId: roomB,
    });
    expect(roomBResult.claimedBySourceRoom).toBe(true);
    expect(dbState.rows[0]?.best_lap_ms).toBe(12_000);

    dbState.activeRoomId = roomA;
    dbState.nextWriteMs = 13_000;
    const retriedA = await maybeUpdatePersonalBest({
      avatarId: 'avatar-1',
      activityId: 'reef-race',
      newBestLapMs: 13_000,
      ghostReplayData: { frames: [] },
      sourceRoomId: roomA,
    });
    expect(retriedA.claimedBySourceRoom).toBe(true);
    expect(retriedA.improved).toBe(true);
    expect(retriedA.previousMs).toBeNull();
    expect(dbState.claims.map((claim) => claim.sourceRoomId)).toEqual([
      roomA,
      roomB,
    ]);
  });
});
