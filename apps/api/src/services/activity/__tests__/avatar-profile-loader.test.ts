/**
 * Phase 3 — avatar-profile-loader unit tests.
 *
 * Mocks @clawville/database so we can drive the loader without a real
 * Supabase connection. Spec: `.claude/plans/reef-race-phase3-detailed.md`
 * §8 P3-L1..P3-L3.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';

// Mock the db module BEFORE the importer pulls it in. The loader chains
// db.select(...).from(avatars).where(inArray(...)) — so we return a thenable
// at the end of the chain that yields the rows we want for the test.
let mockRows: Array<{
  id: string;
  level: number | null;
  archetype: string | null;
}> = [];
let mockShouldThrow = false;

mock.module('@clawville/database', () => {
  function thenable<T>(value: T) {
    return {
      then(onFulfilled: (value: T) => unknown, onRejected?: (e: unknown) => unknown) {
        if (mockShouldThrow) {
          if (onRejected) return onRejected(new Error('mock db throw'));
          throw new Error('mock db throw');
        }
        return Promise.resolve(value).then(onFulfilled);
      },
    };
  }
  const chain = {
    where: (_arg: unknown) => thenable(mockRows),
  };
  const fromChain = {
    from: (_table: unknown) => chain,
  };
  return {
    db: {
      select: (_cols: unknown) => fromChain,
    },
    avatars: { id: {}, level: {}, archetype: {}, flags: {} },
    // Defensive: include every other table reward-pipeline / activity-room-
    // manager / activity-leaderboard-service might import. Bun's mock.module
    // is process-scoped — these stubs prevent unrelated test files in the
    // same process from failing with "Export named X not found".
    activityResults: { id: {}, avatarId: {}, activityId: {}, createdAt: {}, scoreMs: {} },
    activityRooms: { id: {}, status: {}, startedAt: {}, endedAt: {} },
    activityRoomParticipants: { roomId: {}, avatarId: {} },
    // Phase 4 — PB service is transitively imported by reward-pipeline.
    reefRacePersonalBests: {
      id: {},
      avatarId: {},
      activityId: {},
      bestLapMs: {},
      ghostReplayData: {},
    },
    reefRacePersonalBestClaims: {},
  };
});

// NOTE: mock.module('drizzle-orm') is process-scoped in Bun, and downstream
// imports (e.g. reward-pipeline running in another test file in the same
// process) cache their `import { ... } from 'drizzle-orm'` bindings against
// whichever mock was active at FIRST resolution. To avoid leaking a partial
// mock that breaks unrelated test files, expose every drizzle-orm symbol
// reward-pipeline / activity-leaderboard-service / activity-room-manager
// imports — they're harmless no-ops here because avatar-profile-loader only
// chains `inArray`.
mock.module('drizzle-orm', () => {
  const noop = () => ({});
  const sqlFn: unknown = (() => {
    const tag = (..._args: unknown[]) => ({ kind: 'sql' });
    (tag as unknown as { join: unknown }).join = noop;
    (tag as unknown as { raw: unknown }).raw = noop;
    return tag;
  })();
  return {
    and: noop,
    asc: noop,
    desc: noop,
    eq: noop,
    gte: noop,
    inArray: (_col: unknown, _vals: unknown) => ({ kind: 'inArray' }),
    isNull: noop,
    lt: noop,
    ne: noop,
    sql: sqlFn,
  };
});

const { loadRacingProfiles } = await import('../avatar-profile-loader');

beforeEach(() => {
  mockRows = [];
  mockShouldThrow = false;
});

describe('loadRacingProfiles (Phase 3 P3-L1..P3-L3)', () => {
  // P3-L1
  it('P3-L1 — loads humans + bots in a single Map', async () => {
    mockRows = [
      { id: 'h1', level: 25, archetype: 'mischievous-trickster' },
      { id: 'h2', level: 50, archetype: 'fierce-battler' },
    ];
    const out = await loadRacingProfiles(['h1', 'h2'], ['b1']);
    expect(out.size).toBe(3);
    expect(out.get('h1')).toEqual({
      avatarId: 'h1',
      level: 25,
      archetype: 'mischievous-trickster',
      isBot: false,
    });
    expect(out.get('h2')).toEqual({
      avatarId: 'h2',
      level: 50,
      archetype: 'fierce-battler',
      isBot: false,
    });
    expect(out.get('b1')).toEqual({
      avatarId: 'b1',
      level: 1,
      archetype: null,
      isBot: true,
    });
  });

  // P3-L2
  it('P3-L2 — unknown human avatarId falls back to neutral profile', async () => {
    mockRows = [
      { id: 'h1', level: 10, archetype: 'curious-scholar' },
    ];
    const out = await loadRacingProfiles(['h1', 'h2'], []);
    expect(out.size).toBe(2);
    // h2 row was missing — neutral fallback (level 1, archetype null).
    expect(out.get('h2')).toEqual({
      avatarId: 'h2',
      level: 1,
      archetype: null,
      isBot: false,
    });
  });

  // P3-L3
  it('P3-L3 — DB error returns all-neutral, never throws', async () => {
    mockShouldThrow = true;
    const out = await loadRacingProfiles(['h1', 'h2'], ['b1']);
    expect(out.size).toBe(3);
    // Bots are still neutral (added before DB call).
    expect(out.get('b1')?.isBot).toBe(true);
    // Humans get neutral fallback (level 1, archetype null).
    expect(out.get('h1')).toEqual({
      avatarId: 'h1',
      level: 1,
      archetype: null,
      isBot: false,
    });
    expect(out.get('h2')).toEqual({
      avatarId: 'h2',
      level: 1,
      archetype: null,
      isBot: false,
    });
  });

  it('returns only bot map when humans list is empty (no DB call)', async () => {
    const out = await loadRacingProfiles([], ['b1', 'b2']);
    expect(out.size).toBe(2);
    expect(out.get('b1')?.isBot).toBe(true);
    expect(out.get('b2')?.isBot).toBe(true);
  });
});
