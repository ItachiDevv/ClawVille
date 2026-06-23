/**
 * Phase 3 (M-IMPL-2 + plan §10 P3-D1) — bot win-rate-by-level-bucket
 * telemetry test. Powers the Phase 3.5 graduation gate ("if bots lose
 * 95%+ to level 26-49 / 50 humans, level-match bots") — without this
 * coverage the §6 emit hook is an unverified scaffold.
 *
 * Asserts:
 *   1. `reef_race.bot_winrate.by_level_bucket` event fires once per
 *      finished reef-race room with non-empty issued list.
 *   2. `humanLevelBucket` matches the highest human level using the
 *      bucket boundaries 1-10 / 11-25 / 26-49 / 50.
 *   3. `humanFinishedFirst` and `botFinishedAhead` reflect the actual
 *      placement table.
 *   4. Bot-only rooms emit nothing.
 *   5. Non-reef-race activities emit nothing.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';

// ─── Mocks ──────────────────────────────────────────────────────────────────
// Capture every (event-type, payload) pair so the assertions below can
// inspect them. The reward-pipeline tests only mock logEvent as a no-op;
// here we need to actually inspect what was emitted.

interface CapturedEvent {
  eventType: string;
  payload?: Record<string, unknown>;
}
const loggedEvents: CapturedEvent[] = [];

mock.module('../../event-logger', () => ({
  logEvent: async (input: { eventType: string; payload?: Record<string, unknown> }) => {
    loggedEvents.push({
      eventType: input.eventType,
      payload: input.payload,
    });
    return undefined;
  },
  ACTIVITY_EVENT_TYPES: {
    MATCH_PLACED: 'activity.match.placed',
  },
}));

// Database mock — returns deterministic level rows for the `avatars` SELECT
// the bot-winrate emitter performs. Other selects return [].
let mockedLevelRows: Array<{ id: string; level: number }> = [];

const dbMock = {
  transaction(fn: (tx: unknown) => Promise<unknown>) {
    const tx = {
      insert(_table: unknown) {
        const thenable: any = {
          then(resolve: (v: unknown) => unknown) {
            return Promise.resolve(undefined).then(resolve);
          },
          values(_v: unknown) {
            return {
              returning() {
                return Promise.resolve([{ id: 'result-stub' }]);
              },
            };
          },
        };
        return thenable;
      },
      update(_table: unknown) {
        const thenable: any = {
          then(resolve: (v: unknown) => unknown) {
            return Promise.resolve(undefined).then(resolve);
          },
          set() {
            return thenable;
          },
          where() {
            return thenable;
          },
        };
        return thenable;
      },
      execute(_q: unknown) {
        return Promise.resolve([{ user_id: 'user-1', claw_tokens: 100 }]);
      },
    };
    return fn(tx);
  },
  // Outside-tx selects: avatars.level fetch for the winrate emitter returns
  // mockedLevelRows; everything else (today-count, prior-best) returns [].
  select(cols?: Record<string, unknown> | undefined) {
    const isLevelSelect = cols && 'level' in cols && 'id' in cols;
    const result: unknown[] = isLevelSelect ? mockedLevelRows : [];
    const chain: any = {
      then(resolve: (v: unknown[]) => unknown) {
        return Promise.resolve(result).then(resolve);
      },
      groupBy() {
        return Promise.resolve([]);
      },
    };
    return {
      from() {
        return {
          where() {
            return chain;
          },
        };
      },
    };
  },
};

mock.module('@clawville/database', () => ({
  db: dbMock,
  activityResults: {
    id: 'id',
    avatarId: 'avatar_id',
    activityId: 'activity_id',
    createdAt: 'created_at',
    scoreMs: 'score_ms',
  },
  avatars: { id: 'id', level: 'level', flags: 'flags' },
  // Phase 4 — PB service is transitively imported by reward-pipeline.
  reefRacePersonalBests: {
    id: 'id',
    avatarId: 'avatar_id',
    activityId: 'activity_id',
    bestLapMs: 'best_lap_ms',
  },
  // 2026-06-23: `activity-replay-log.ts` (transitively imported via the reward
  // pipeline) references `activityReplays`; the schema gained this table after
  // this mock was first written, so the named export was missing → Bun threw
  // "Export named 'activityReplays' not found" at module load. Mock it with the
  // column-name shape the replay log reads (id + the insert columns).
  activityReplays: {
    id: 'id',
    roomId: 'room_id',
    activityId: 'activity_id',
    frames: 'frames',
    participants: 'participants',
    createdAt: 'created_at',
  },
}));

// Mock drizzle-orm — reward-pipeline imports `{and, eq, gte, lt, sql}` and
// the per-file avatar-profile-loader test (which runs in the same Bun process)
// only re-exports `inArray`, so without this mock the second-loaded test
// errors with "Export named 'lt' not found". Re-export the symbols
// reward-pipeline.ts pulls; values are inert no-op chainables since the
// db mock above sidesteps the actual SQL builder.
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
    eq: noop,
    gte: noop,
    lt: noop,
    inArray: noop,
    sql: sqlFn,
  };
});

mock.module('../../claw-token-ledger', () => ({
  creditClawTokens: async () => ({ balanceAfter: 100, ledgerId: 'ledger-stub' }),
}));

// SUT — import after mocks.
const { issueRewardsForRoom } = await import('../reward-pipeline');

import type { Room, RoomParticipant } from '../types';

beforeEach(() => {
  loggedEvents.length = 0;
  mockedLevelRows = [];
});

function buildReefRoom(participantSpecs: Array<{
  avatarId: string;
  subjectType: 'human' | 'bot' | 'agent';
}>): Room {
  const now = Date.now();
  const participants = new Map<string, RoomParticipant>();
  for (const spec of participantSpecs) {
    participants.set(spec.avatarId, {
      avatarId: spec.avatarId,
      userId: spec.subjectType === 'human' ? `user-${spec.avatarId}` : null,
      agentId: null,
      subjectType: spec.subjectType,
      partyId: null,
      joinedAt: now,
      connected: true,
      disconnectedAt: null,
      wsConnectionId: null,
    });
  }
  return {
    id: 'room-reef-test',
    shortCode: 'REEFAA',
    activityId: 'reef-race',
    state: 'results',
    participants,
    countdownStartedAt: now - 5_000,
    startedAt: now - 90_000,
    endedAt: now,
    createdAt: now - 100_000,
    lastTouchedAt: now,
    hasBots: participantSpecs.some((s) => s.subjectType === 'bot'),
    hasAgents: false,
    activityConfig: { minPlayers: 4, maxPlayers: 8, preferredPlayers: 6 },
    preLaunchBuffer: null,
  };
}

function findWinrateEvent(): CapturedEvent | undefined {
  return loggedEvents.find(
    (e) => e.eventType === 'reef_race.bot_winrate.by_level_bucket',
  );
}

/**
 * The bot-winrate emit is fired with `void emitReefRaceBotWinrateEvent(...)`
 * inside `issueRewardsForRoom`, so it runs as a detached microtask after
 * `await issueRewardsForRoom(...)` returns. Tests must yield long enough
 * for the inner `await db.select(...)` + `void logEvent(...)` chain to
 * settle before reading `loggedEvents`. setTimeout(0) is enough for the
 * mock chain (no real I/O), but bumping to 25ms guards against future
 * additions.
 */
async function waitForEventsSettled(): Promise<void> {
  await new Promise((r) => setTimeout(r, 25));
}

describe('reef_race.bot_winrate.by_level_bucket emission (P3-D1)', () => {
  it('fires exactly once per reef-race room with non-empty issued', async () => {
    mockedLevelRows = [{ id: 'avatar-h1', level: 1 }];
    const room = buildReefRoom([
      { avatarId: 'avatar-h1', subjectType: 'human' },
      { avatarId: 'avatar-bot-1', subjectType: 'bot' },
    ]);
    await issueRewardsForRoom({
      room,
      simResults: [
        { avatarId: 'avatar-h1', placement: 1, score: 1, scoreMs: 90_000 },
        { avatarId: 'avatar-bot-1', placement: 2, score: 0, scoreMs: 95_000 },
      ],
    });
    await waitForEventsSettled();
    const events = loggedEvents.filter(
      (e) => e.eventType === 'reef_race.bot_winrate.by_level_bucket',
    );
    expect(events.length).toBe(1);
  });

  it('buckets level 1 → "1-10"', async () => {
    mockedLevelRows = [{ id: 'avatar-h1', level: 5 }];
    const room = buildReefRoom([
      { avatarId: 'avatar-h1', subjectType: 'human' },
      { avatarId: 'avatar-bot-1', subjectType: 'bot' },
    ]);
    await issueRewardsForRoom({
      room,
      simResults: [
        { avatarId: 'avatar-h1', placement: 1, score: 1 },
        { avatarId: 'avatar-bot-1', placement: 2, score: 0 },
      ],
    });
    await waitForEventsSettled();
    const evt = findWinrateEvent();
    expect(evt).toBeDefined();
    expect(evt!.payload?.humanLevelBucket).toBe('1-10');
  });

  it('buckets level 15 → "11-25"', async () => {
    mockedLevelRows = [{ id: 'avatar-h1', level: 15 }];
    const room = buildReefRoom([
      { avatarId: 'avatar-h1', subjectType: 'human' },
      { avatarId: 'avatar-bot-1', subjectType: 'bot' },
    ]);
    await issueRewardsForRoom({
      room,
      simResults: [
        { avatarId: 'avatar-h1', placement: 1, score: 1 },
        { avatarId: 'avatar-bot-1', placement: 2, score: 0 },
      ],
    });
    await waitForEventsSettled();
    const evt = findWinrateEvent();
    expect(evt!.payload?.humanLevelBucket).toBe('11-25');
  });

  it('buckets level 35 → "26-49"', async () => {
    mockedLevelRows = [{ id: 'avatar-h1', level: 35 }];
    const room = buildReefRoom([
      { avatarId: 'avatar-h1', subjectType: 'human' },
      { avatarId: 'avatar-bot-1', subjectType: 'bot' },
    ]);
    await issueRewardsForRoom({
      room,
      simResults: [
        { avatarId: 'avatar-h1', placement: 1, score: 1 },
        { avatarId: 'avatar-bot-1', placement: 2, score: 0 },
      ],
    });
    await waitForEventsSettled();
    const evt = findWinrateEvent();
    expect(evt!.payload?.humanLevelBucket).toBe('26-49');
  });

  it('buckets level 50 → "50"', async () => {
    mockedLevelRows = [{ id: 'avatar-h1', level: 50 }];
    const room = buildReefRoom([
      { avatarId: 'avatar-h1', subjectType: 'human' },
      { avatarId: 'avatar-bot-1', subjectType: 'bot' },
    ]);
    await issueRewardsForRoom({
      room,
      simResults: [
        { avatarId: 'avatar-h1', placement: 1, score: 1 },
        { avatarId: 'avatar-bot-1', placement: 2, score: 0 },
      ],
    });
    await waitForEventsSettled();
    const evt = findWinrateEvent();
    expect(evt!.payload?.humanLevelBucket).toBe('50');
  });

  it('uses the HIGHEST level when multiple humans race', async () => {
    mockedLevelRows = [
      { id: 'avatar-h1', level: 5 },
      { id: 'avatar-h2', level: 50 },
      { id: 'avatar-h3', level: 12 },
    ];
    const room = buildReefRoom([
      { avatarId: 'avatar-h1', subjectType: 'human' },
      { avatarId: 'avatar-h2', subjectType: 'human' },
      { avatarId: 'avatar-h3', subjectType: 'human' },
      { avatarId: 'avatar-bot-1', subjectType: 'bot' },
    ]);
    await issueRewardsForRoom({
      room,
      simResults: [
        { avatarId: 'avatar-h1', placement: 2, score: 1 },
        { avatarId: 'avatar-h2', placement: 1, score: 2 },
        { avatarId: 'avatar-h3', placement: 3, score: 0 },
        { avatarId: 'avatar-bot-1', placement: 4, score: 0 },
      ],
    });
    await waitForEventsSettled();
    const evt = findWinrateEvent();
    expect(evt!.payload?.humanLevelBucket).toBe('50');
  });

  it('humanFinishedFirst=true when a human takes 1st', async () => {
    mockedLevelRows = [{ id: 'avatar-h1', level: 50 }];
    const room = buildReefRoom([
      { avatarId: 'avatar-h1', subjectType: 'human' },
      { avatarId: 'avatar-bot-1', subjectType: 'bot' },
    ]);
    await issueRewardsForRoom({
      room,
      simResults: [
        { avatarId: 'avatar-h1', placement: 1, score: 1 },
        { avatarId: 'avatar-bot-1', placement: 2, score: 0 },
      ],
    });
    await waitForEventsSettled();
    const evt = findWinrateEvent();
    expect(evt!.payload?.humanFinishedFirst).toBe(true);
    expect(evt!.payload?.botFinishedAhead).toBe(0);
  });

  it('humanFinishedFirst=false + botFinishedAhead=1 when bot wins', async () => {
    mockedLevelRows = [{ id: 'avatar-h1', level: 1 }];
    const room = buildReefRoom([
      { avatarId: 'avatar-h1', subjectType: 'human' },
      { avatarId: 'avatar-bot-1', subjectType: 'bot' },
    ]);
    await issueRewardsForRoom({
      room,
      simResults: [
        { avatarId: 'avatar-bot-1', placement: 1, score: 2 },
        { avatarId: 'avatar-h1', placement: 2, score: 1 },
      ],
    });
    await waitForEventsSettled();
    const evt = findWinrateEvent();
    expect(evt!.payload?.humanFinishedFirst).toBe(false);
    expect(evt!.payload?.botFinishedAhead).toBe(1);
  });

  it('does NOT emit for bot-only rooms (no humans)', async () => {
    mockedLevelRows = [];
    const room = buildReefRoom([
      { avatarId: 'avatar-bot-1', subjectType: 'bot' },
      { avatarId: 'avatar-bot-2', subjectType: 'bot' },
    ]);
    await issueRewardsForRoom({
      room,
      simResults: [
        { avatarId: 'avatar-bot-1', placement: 1, score: 2 },
        { avatarId: 'avatar-bot-2', placement: 2, score: 1 },
      ],
    });
    // Wait one microtask so the void-emit fire-and-forget path settles.
    await new Promise((r) => setTimeout(r, 10));
    expect(findWinrateEvent()).toBeUndefined();
  });

  it('does NOT emit for non-reef-race activities (e.g. bumper-shells)', async () => {
    mockedLevelRows = [{ id: 'avatar-h1', level: 50 }];
    const room: Room = {
      ...buildReefRoom([
        { avatarId: 'avatar-h1', subjectType: 'human' },
        { avatarId: 'avatar-bot-1', subjectType: 'bot' },
      ]),
      activityId: 'bumper-shells',
    };
    await issueRewardsForRoom({
      room,
      simResults: [
        { avatarId: 'avatar-h1', placement: 1, score: 4 },
        { avatarId: 'avatar-bot-1', placement: 2, score: 2 },
      ],
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(findWinrateEvent()).toBeUndefined();
  });

  it('payload carries roomId, humanFinished, botCount', async () => {
    mockedLevelRows = [{ id: 'avatar-h1', level: 30 }];
    const room = buildReefRoom([
      { avatarId: 'avatar-h1', subjectType: 'human' },
      { avatarId: 'avatar-bot-1', subjectType: 'bot' },
      { avatarId: 'avatar-bot-2', subjectType: 'bot' },
    ]);
    await issueRewardsForRoom({
      room,
      simResults: [
        { avatarId: 'avatar-h1', placement: 1, score: 3 },
        { avatarId: 'avatar-bot-1', placement: 2, score: 2 },
        { avatarId: 'avatar-bot-2', placement: 3, score: 1 },
      ],
    });
    await waitForEventsSettled();
    const evt = findWinrateEvent();
    expect(evt!.payload).toMatchObject({
      roomId: 'room-reef-test',
      humanLevelBucket: '26-49',
      humanFinished: 1,
      humanFinishedFirst: true,
      botCount: 2,
      botFinishedAhead: 0,
    });
  });
});
