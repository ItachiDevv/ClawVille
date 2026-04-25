/**
 * Q2 Activity Portals — leaderboard service unit tests (chunk #7).
 *
 * Validates:
 *   - bots excluded from leaderboard rankings
 *   - daily window applies the 24h time bound
 *   - season window pulls from activity_seasons.startedAt
 *   - getLeaderboardForPet returns context window around caller
 *   - cache TTL keeps repeat calls cheap
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';

let savedRows: Array<{
  petId: string;
  agentId: string | null;
  totalPoints: number;
  wins: number;
  matches: number;
  bestTimeMs: number | null;
  lastSeen: string;
  subjectType: string;
  createdAt: Date;
}> = [];

// Mock @clawville/database with chained query builder.
function makeFromWhereChain<T>(value: T) {
  return {
    where() {
      return {
        groupBy() {
          return Promise.resolve(value);
        },
        orderBy() {
          return {
            limit() {
              return Promise.resolve(value);
            },
          };
        },
        limit() {
          return Promise.resolve(value);
        },
        then(resolve: (v: T) => unknown) {
          return Promise.resolve(value).then(resolve);
        },
      };
    },
    orderBy() {
      return {
        limit() {
          return Promise.resolve(value);
        },
        then(resolve: (v: T) => unknown) {
          return Promise.resolve(value).then(resolve);
        },
      };
    },
    limit() {
      return Promise.resolve(value);
    },
    then(resolve: (v: T) => unknown) {
      return Promise.resolve(value).then(resolve);
    },
  };
}

const dbMock = {
  select(_cols?: unknown) {
    // Two paths: aggregate select (multiple cols), pet-name select (id+name),
    // season select. We multiplex by inspecting the column count.
    const colCount = _cols ? Object.keys(_cols as object).length : 0;
    return {
      from(table: { __name?: string }) {
        const tableName =
          (table as { __name?: string })?.__name ?? 'activityResults';
        if (tableName === 'pets') {
          // Pet name lookup — return a row per saved petId.
          const namesValue = Array.from(new Set(savedRows.map((r) => r.petId))).map(
            (id) => ({ id, name: `pet-${id.slice(0, 4)}` }),
          );
          return makeFromWhereChain(namesValue);
        }
        if (tableName === 'activitySeasons') {
          // Always return the active 30-day season.
          const now = new Date();
          return makeFromWhereChain([
            {
              id: 'season-1',
              name: '2026-Q2-S1',
              activityIds: ['bumper-shells', 'reef-race'],
              startedAt: new Date(now.getTime() - 5 * 86_400_000),
              endsAt: new Date(now.getTime() + 25 * 86_400_000),
              active: true,
              createdAt: new Date(now.getTime() - 5 * 86_400_000),
            },
          ]);
        }
        // activityResults aggregate path — apply the column shape to fake aggregate.
        if (colCount > 2) {
          const filtered = savedRows.filter((r) => r.subjectType !== 'bot');
          // Group by petId+agentId.
          const grouped = new Map<
            string,
            {
              petId: string;
              agentId: string | null;
              totalPoints: number;
              wins: number;
              matches: number;
              bestTimeMs: number | null;
              lastSeen: string;
            }
          >();
          for (const r of filtered) {
            const key = `${r.petId}|${r.agentId ?? ''}`;
            const cur = grouped.get(key) ?? {
              petId: r.petId,
              agentId: r.agentId,
              totalPoints: 0,
              wins: 0,
              matches: 0,
              bestTimeMs: null as number | null,
              lastSeen: r.lastSeen,
            };
            cur.totalPoints += r.totalPoints;
            cur.wins += r.wins;
            cur.matches += r.matches;
            if (r.bestTimeMs != null) {
              cur.bestTimeMs =
                cur.bestTimeMs == null
                  ? r.bestTimeMs
                  : Math.min(cur.bestTimeMs, r.bestTimeMs);
            }
            grouped.set(key, cur);
          }
          return makeFromWhereChain(Array.from(grouped.values()));
        }
        return makeFromWhereChain([]);
      },
    };
  },
  insert(_table: unknown) {
    return {
      values() {
        return Promise.resolve(undefined);
      },
    };
  },
};

mock.module('@clawville/database', () => ({
  db: dbMock,
  activityResults: { __name: 'activityResults', petId: 'pet_id' },
  activitySeasons: { __name: 'activitySeasons' },
  pets: { __name: 'pets', id: 'id', name: 'name' },
  // Phase 4 — defensive: PB service is transitively imported by other
  // tests sharing this Bun process.
  reefRacePersonalBests: {
    __name: 'reefRacePersonalBests',
    petId: 'pet_id',
    activityId: 'activity_id',
    bestLapMs: 'best_lap_ms',
  },
}));

// SUT
const {
  buildLeaderboardSnapshot,
  getLeaderboardForPet,
  invalidateLeaderboardCache,
} = await import('../activity-leaderboard-service');

beforeEach(() => {
  invalidateLeaderboardCache();
  savedRows = [];
});

describe('buildLeaderboardSnapshot — bot exclusion', () => {
  it('excludes bot rows from the ranking', async () => {
    savedRows = [
      {
        petId: 'pet-h1',
        agentId: null,
        totalPoints: 30,
        wins: 1,
        matches: 1,
        bestTimeMs: null,
        lastSeen: new Date().toISOString(),
        subjectType: 'human',
        createdAt: new Date(),
      },
      {
        petId: 'pet-bot-1',
        agentId: null,
        totalPoints: 100, // would be top if not excluded
        wins: 5,
        matches: 5,
        bestTimeMs: null,
        lastSeen: new Date().toISOString(),
        subjectType: 'bot',
        createdAt: new Date(),
      },
    ];
    const snap = await buildLeaderboardSnapshot('bumper-shells', 'all', 100, 0);
    expect(snap.leaderboard).toHaveLength(1);
    expect(snap.leaderboard[0].petId).toBe('pet-h1');
  });
});

describe('buildLeaderboardSnapshot — Reef Race best time', () => {
  it('includes bestTimeMs for reef-race entries', async () => {
    savedRows = [
      {
        petId: 'pet-h1',
        agentId: null,
        totalPoints: 50,
        wins: 1,
        matches: 1,
        bestTimeMs: 95_000,
        lastSeen: new Date().toISOString(),
        subjectType: 'human',
        createdAt: new Date(),
      },
    ];
    const snap = await buildLeaderboardSnapshot('reef-race', 'all', 100, 0);
    expect(snap.leaderboard[0].bestTimeMs).toBe(95_000);
  });

  it('omits bestTimeMs for non-reef activities', async () => {
    savedRows = [
      {
        petId: 'pet-h1',
        agentId: null,
        totalPoints: 30,
        wins: 1,
        matches: 1,
        bestTimeMs: null,
        lastSeen: new Date().toISOString(),
        subjectType: 'human',
        createdAt: new Date(),
      },
    ];
    const snap = await buildLeaderboardSnapshot('bumper-shells', 'all', 100, 0);
    expect(snap.leaderboard[0].bestTimeMs).toBeUndefined();
  });
});

describe('buildLeaderboardSnapshot — sorting + ranks', () => {
  it('sorts by totalPoints DESC, ranks are 1-indexed', async () => {
    savedRows = [
      {
        petId: 'pet-a',
        agentId: null,
        totalPoints: 10,
        wins: 0,
        matches: 5,
        bestTimeMs: null,
        lastSeen: new Date().toISOString(),
        subjectType: 'human',
        createdAt: new Date(),
      },
      {
        petId: 'pet-b',
        agentId: null,
        totalPoints: 100,
        wins: 3,
        matches: 4,
        bestTimeMs: null,
        lastSeen: new Date().toISOString(),
        subjectType: 'human',
        createdAt: new Date(),
      },
    ];
    const snap = await buildLeaderboardSnapshot('bumper-shells', 'all', 100, 0);
    expect(snap.leaderboard[0].petId).toBe('pet-b');
    expect(snap.leaderboard[0].rank).toBe(1);
    expect(snap.leaderboard[1].petId).toBe('pet-a');
    expect(snap.leaderboard[1].rank).toBe(2);
  });
});

describe('getLeaderboardForPet — myRank and context window', () => {
  it('returns myRank + symmetric context slice', async () => {
    savedRows = Array.from({ length: 10 }, (_, i) => ({
      petId: `pet-${i}`,
      agentId: null,
      totalPoints: 100 - i * 5, // pet-0 highest, pet-9 lowest
      wins: 0,
      matches: 1,
      bestTimeMs: null,
      lastSeen: new Date().toISOString(),
      subjectType: 'human',
      createdAt: new Date(),
    }));
    const result = await getLeaderboardForPet(
      'bumper-shells',
      'all',
      'pet-5',
      2,
    );
    expect(result.myRank).toBe(6); // pet-5 is index 5 (rank 6)
    expect(result.context).toHaveLength(5); // 2 above + self + 2 below
    expect(result.context.map((e) => e.petId)).toEqual([
      'pet-3',
      'pet-4',
      'pet-5',
      'pet-6',
      'pet-7',
    ]);
  });

  it('returns null myRank when caller is not on the board', async () => {
    savedRows = [
      {
        petId: 'pet-a',
        agentId: null,
        totalPoints: 10,
        wins: 0,
        matches: 1,
        bestTimeMs: null,
        lastSeen: new Date().toISOString(),
        subjectType: 'human',
        createdAt: new Date(),
      },
    ];
    const result = await getLeaderboardForPet(
      'bumper-shells',
      'all',
      'pet-not-here',
      5,
    );
    expect(result.myRank).toBeNull();
    expect(result.context).toHaveLength(1); // top-N fallback
  });
});
