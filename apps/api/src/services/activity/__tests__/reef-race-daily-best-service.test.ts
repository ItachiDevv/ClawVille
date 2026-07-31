/**
 * Reef Race Phase 4 — Lobster of the Day daily-best-lap aggregator tests.
 *
 * Coverage (P4-T14..P4-T18):
 *   - getDailyBestLapSnapshot returns rows ordered by bestLapMs ASC
 *   - 60s cache short-circuits the second call within window
 *   - invalidateDailyBestLapCache forces re-query
 *   - limit param honored
 *   - empty result returns a well-formed snapshot
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';

let executeCallCount = 0;
const seedRows: Array<{
  avatar_id: string;
  best_lap_ms: number;
  best_lap_recorded_at: string;
  avatar_name: string;
  wallet_address: string | null;
}> = [];

mock.module('@clawville/database', () => ({
  db: {
    execute: <T,>(_q: unknown) => {
      executeCallCount += 1;
      return Promise.resolve(seedRows as unknown as T[]);
    },
  },
  // Defensive table stubs — Bun's mock.module is process-scoped; this
  // mock cascades into sibling test files in the same Bun runner. Stub
  // every column-bearing schema export touched anywhere in the
  // reward-pipeline / activity-room-manager / activity-leaderboard-service
  // import chain so a sibling test's import doesn't error with
  // "Export named X not found".
  reefRacePersonalBests: {
    id: 'id',
    avatarId: 'avatar_id',
    activityId: 'activity_id',
    bestLapMs: 'best_lap_ms',
    ghostReplayData: 'ghost_replay_data',
  },
  reefRacePersonalBestClaims: {},
  activityResults: { id: 'id', avatarId: 'avatar_id', activityId: 'activity_id', createdAt: 'created_at', scoreMs: 'score_ms' },
  activityRooms: { id: 'id', status: 'status', startedAt: 'started_at', endedAt: 'ended_at' },
  activityRoomParticipants: { roomId: 'room_id', avatarId: 'avatar_id' },
  activityReplays: { id: 'id' },
  avatars: { id: 'id', flags: 'flags' },
  clawTokenTransactions: { id: 'id' },
}));

const {
  getDailyBestLapSnapshot,
  invalidateDailyBestLapCache,
  __resetDailyBestLapCacheForTest,
} = await import('../reef-race-daily-best-service');

beforeEach(() => {
  executeCallCount = 0;
  seedRows.length = 0;
  __resetDailyBestLapCacheForTest();
});

// ─── P4-T14 — order ────────────────────────────────────────────────────────

describe('getDailyBestLapSnapshot', () => {
  it('P4-T14 — returns rows in the order produced by the query (best_lap_ms ASC at SQL level)', async () => {
    seedRows.push(
      {
        avatar_id: 'avatar-1',
        best_lap_ms: 12_000,
        best_lap_recorded_at: new Date().toISOString(),
        avatar_name: 'Alpha',
        wallet_address: 'wallet-A',
      },
      {
        avatar_id: 'avatar-2',
        best_lap_ms: 13_500,
        best_lap_recorded_at: new Date().toISOString(),
        avatar_name: 'Beta',
        wallet_address: null,
      },
    );
    const snap = await getDailyBestLapSnapshot();
    expect(snap.totalEntries).toBe(2);
    expect(snap.entries[0]?.avatarName).toBe('Alpha');
    expect(snap.entries[0]?.rank).toBe(1);
    expect(snap.entries[1]?.rank).toBe(2);
  });

  // P4-T15 — cache hit within 60s
  it('P4-T15 — second call within 60s window does NOT re-query', async () => {
    seedRows.push({
      avatar_id: 'avatar-1',
      best_lap_ms: 12_000,
      best_lap_recorded_at: new Date().toISOString(),
      avatar_name: 'Alpha',
      wallet_address: null,
    });
    await getDailyBestLapSnapshot();
    expect(executeCallCount).toBe(1);
    await getDailyBestLapSnapshot();
    expect(executeCallCount).toBe(1); // cache hit
  });

  // P4-T16 — invalidate forces fresh
  it('P4-T16 — invalidateDailyBestLapCache forces a fresh query', async () => {
    seedRows.push({
      avatar_id: 'avatar-1',
      best_lap_ms: 12_000,
      best_lap_recorded_at: new Date().toISOString(),
      avatar_name: 'Alpha',
      wallet_address: null,
    });
    await getDailyBestLapSnapshot();
    invalidateDailyBestLapCache();
    await getDailyBestLapSnapshot();
    expect(executeCallCount).toBe(2);
  });

  // P4-T17 — limit honored
  it('P4-T17 — limit param slices the cached top-100 (strict prefix safe)', async () => {
    for (let i = 0; i < 10; i++) {
      seedRows.push({
        avatar_id: `avatar-${i}`,
        best_lap_ms: 12_000 + i * 100,
        best_lap_recorded_at: new Date().toISOString(),
        avatar_name: `Avatar ${i}`,
        wallet_address: null,
      });
    }
    const snap = await getDailyBestLapSnapshot(3);
    expect(snap.entries.length).toBe(3);
    expect(snap.totalEntries).toBe(10); // full set in cache
  });

  // P4-T18 — empty result
  it('P4-T18 — returns a well-formed snapshot when no PBs exist', async () => {
    const snap = await getDailyBestLapSnapshot();
    expect(snap.totalEntries).toBe(0);
    expect(snap.entries).toEqual([]);
    expect(snap.windowStart).toBeDefined();
    expect(snap.generatedAt).toBeDefined();
  });
});
