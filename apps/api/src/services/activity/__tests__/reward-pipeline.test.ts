/**
 * Q2 Activity Portals — reward pipeline unit tests (chunk #7).
 *
 * Pure-logic coverage:
 *   - Bumper 1st = 45 tokens
 *   - Bumper 4th = 10 tokens (placement, NOT participation floor)
 *   - Bumper 9th = 5 tokens (participation floor — defensive)
 *   - Bots → 0 tokens, 0 leaderboard points, no credit call
 *   - First-play-of-day adds 15
 *   - Focus-aligned adds +25%
 *   - issueRewardsForRoom composes all writes inside one DB transaction
 *
 * Drizzle is mocked at module-load time so tests do NOT touch Postgres.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';

// ─── Mocks ────────────────────────────────────────────────────────────────

const txCalls: Array<{ op: string; args: unknown[] }> = [];
const duplicateResultAvatarIds = new Set<string>();

function makeTxThenable<T>(value: T) {
  return {
    then(resolve: (v: T) => unknown) {
      return Promise.resolve(value).then(resolve);
    },
    values(v: unknown) {
      txCalls.push({ op: 'tx.insert.values', args: [v] });
      return makeReturning(v);
    },
    set() {
      return makeTxThenable(value);
    },
    where() {
      return makeTxThenable(value);
    },
    from() {
      return makeTxThenable(value);
    },
  };
}

function makeReturning(values: unknown) {
  const builder = {
    onConflictDoNothing(config: unknown) {
      txCalls.push({ op: 'tx.insert.onConflictDoNothing', args: [config] });
      return builder;
    },
    returning() {
      const avatarId = (values as { avatarId?: unknown })?.avatarId;
      if (typeof avatarId === 'string' && duplicateResultAvatarIds.has(avatarId)) {
        return Promise.resolve([]);
      }
      // Insert returning a synthetic id every call.
      return Promise.resolve([{ id: `result-${txCalls.length}` }]);
    },
  };
  return builder;
}

const dbMock = {
  transaction(fn: (tx: unknown) => Promise<unknown>) {
    const tx = {
      insert(_table: unknown) {
        txCalls.push({ op: 'tx.insert', args: [_table] });
        return makeTxThenable(undefined);
      },
      update(_table: unknown) {
        txCalls.push({ op: 'tx.update', args: [_table] });
        return makeTxThenable(undefined);
      },
      execute(_q: unknown) {
        // creditClawTokens does a SELECT FOR UPDATE → return a row.
        return Promise.resolve([{ user_id: 'user-1', claw_tokens: 100 }]);
      },
    };
    return fn(tx);
  },
  // The pre-fetch context loaders use db.select directly (outside tx).
  // Returns [] for every shape — no prior plays, no flags, no prior best.
  select(_cols?: unknown) {
    const emptyResultChain = {
      then(resolve: (v: unknown[]) => unknown) {
        return Promise.resolve([] as unknown[]).then(resolve);
      },
      groupBy() {
        return Promise.resolve([]);
      },
    };
    return {
      from() {
        return {
          // Guest-source loader now `.leftJoin(users, …)` before `.where(…)`
          // (2026-07-10 guest-owned-agent hardening) — support the extra hop.
          leftJoin() {
            return {
              where() {
                return emptyResultChain;
              },
            };
          },
          where() {
            return emptyResultChain;
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
    roomId: 'room_id',
    avatarId: 'avatar_id',
    activityId: 'activity_id',
    createdAt: 'created_at',
    scoreMs: 'score_ms',
  },
  avatars: { id: 'id', flags: 'flags', isGuest: 'is_guest', userId: 'user_id' },
  // Guest-source loader joins users for the canonical is_guest (2026-07-10).
  users: { id: 'id', isGuest: 'is_guest' },
  // Phase 4 — reward-pipeline now indirectly imports
  // `reef-race-personal-best-service` which references this table. Mock
  // its column shape so the loader's column references stay typed.
  reefRacePersonalBests: {
    id: 'id',
    avatarId: 'avatar_id',
    activityId: 'activity_id',
    bestLapMs: 'best_lap_ms',
    bestLapRecordedAt: 'best_lap_recorded_at',
    sourceRoomId: 'source_room_id',
    ghostReplayData: 'ghost_replay_data',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
  // Phase 4 — reward-pipeline now imports activity-ws-hub which
  // transitively imports activity-room-manager which references these
  // schemas at module load time. Bun's mock.module is process-scoped
  // and partial; provide stubs to satisfy the import chain.
  activityRooms: { id: 'id', activityId: 'activity_id', shortCode: 'short_code', status: 'status' },
  activityRoomParticipants: { roomId: 'room_id', avatarId: 'avatar_id' },
  activityReplays: { id: 'id' },
  clawTokenTransactions: { id: 'id' },
}));

// Phase 4 — these existing tests use `bumper-shells` activityId, so the
// Reef-Race-only PB write + per-recipient match-end paths are NEVER
// reached. We deliberately do NOT mock `../sim/reef-race-sim` /
// `../activity-ws-hub` / `../reef-race-personal-best-service` here:
// those mocks would shadow the real modules process-wide in Bun and
// break sibling tests that import the real reef-race-sim (cross-file
// mock pollution — see activity-queue.test.ts §"bleeds across test
// files in bun's shared-process runner").
//
// alert-error is mocked because `issueRewardsForRoom` calls
// alertError() in the Reef-Race PB-write failure branch — but stubbing
// it is safe because the existing tests don't hit that branch on
// bumper-shells activityId. Kept defensive.
mock.module('../alert-error', () => ({
  alertError: () => Promise.resolve(),
}));

mock.module('../../event-logger', () => ({
  logEvent: () => Promise.resolve(),
  ACTIVITY_EVENT_TYPES: {
    MATCH_PLACED: 'activity.match.placed',
  },
}));

const creditCalls: Array<{
  avatarId: string;
  amount: number;
  reason: string;
  metadata: Record<string, unknown>;
}> = [];
mock.module('../../claw-token-ledger', () => ({
  creditClawTokens: async (
    input: {
      avatarId: string;
      amount: number;
      reason: string;
      metadata: Record<string, unknown>;
    },
    _tx: unknown,
  ) => {
    creditCalls.push({
      avatarId: input.avatarId,
      amount: input.amount,
      reason: input.reason,
      metadata: input.metadata,
    });
    return { balanceAfter: 100 + input.amount, ledgerId: 'ledger-1' };
  },
}));

// SUT — import after mocks.
const {
  computePlacementBase,
  computeFocusBonus,
  computeLeaderboardPoints,
  isFocusAligned,
  computeBreakdown,
  getReefRaceFlagCount,
  issueRewardsForRoom,
} = await import('../reward-pipeline');

import type { Room, RoomParticipant } from '../types';
import { ACTIVITY_REGISTRY } from '@clawville/shared';

const BUMPER = ACTIVITY_REGISTRY.find((a) => a.id === 'bumper-shells')!;
const REEF = ACTIVITY_REGISTRY.find((a) => a.id === 'reef-race')!;

beforeEach(() => {
  txCalls.length = 0;
  creditCalls.length = 0;
  duplicateResultAvatarIds.clear();
});

// ─── Pure helpers ─────────────────────────────────────────────────────────

describe('computePlacementBase', () => {
  it('returns 45 tokens for Bumper 1st', () => {
    expect(computePlacementBase(BUMPER.rewardConfig, 1)).toEqual({
      base: 45,
      participationFloor: false,
    });
  });

  it('returns 10 tokens for Bumper 4th (placement, NOT floor)', () => {
    expect(computePlacementBase(BUMPER.rewardConfig, 4)).toEqual({
      base: 10,
      participationFloor: false,
    });
  });

  it('returns 5 tokens for Bumper 7th (placement)', () => {
    expect(computePlacementBase(BUMPER.rewardConfig, 7)).toEqual({
      base: 5,
      participationFloor: false,
    });
  });

  it('falls through to participation floor for unranked placement (Bumper 9th edge)', () => {
    expect(computePlacementBase(BUMPER.rewardConfig, 9)).toEqual({
      base: 5,
      participationFloor: true,
    });
  });

  it('Reef Race 1st = 50, 4th = 15', () => {
    expect(computePlacementBase(REEF.rewardConfig, 1).base).toBe(50);
    expect(computePlacementBase(REEF.rewardConfig, 4).base).toBe(15);
  });

  it('returns 0 when no reward config', () => {
    expect(computePlacementBase(undefined, 1)).toEqual({
      base: 0,
      participationFloor: true,
    });
  });
});

describe('computeFocusBonus', () => {
  it('+25% on a 60-token subtotal = 15', () => {
    expect(computeFocusBonus(60, 25, true)).toBe(15);
  });

  it('returns 0 when focus not aligned', () => {
    expect(computeFocusBonus(60, 25, false)).toBe(0);
  });

  it('returns 0 when no focus pct configured', () => {
    expect(computeFocusBonus(60, undefined, true)).toBe(0);
  });

  it('rounds to nearest integer', () => {
    expect(computeFocusBonus(45, 25, true)).toBe(11); // 45 * 0.25 = 11.25
  });
});

describe('computeLeaderboardPoints', () => {
  it('Bumper 1st = 30 leaderboard pts', () => {
    expect(computeLeaderboardPoints(BUMPER.rewardConfig, 1)).toBe(30);
  });

  it('Bumper 4th = 2 (default)', () => {
    expect(computeLeaderboardPoints(BUMPER.rewardConfig, 4)).toBe(2);
  });

  it('returns 0 when no leaderboard config', () => {
    expect(computeLeaderboardPoints({}, 1)).toBe(0);
  });
});

describe('isFocusAligned', () => {
  it('returns true when avatar flags carry matching learningFocus', () => {
    expect(isFocusAligned({ learningFocus: 'api-integrations' }, 'bumper-shells')).toBe(true);
  });

  it('returns false when learningFocus mismatches', () => {
    expect(isFocusAligned({ learningFocus: 'cron-automation' }, 'bumper-shells')).toBe(false);
  });

  it('returns false when no flags', () => {
    expect(isFocusAligned(null, 'bumper-shells')).toBe(false);
  });

  it('returns false when activity unknown', () => {
    expect(isFocusAligned({ learningFocus: 'foo' }, 'unknown-activity')).toBe(false);
  });
});

describe('computeBreakdown — non-bot Bumper Shells', () => {
  const baseInput = {
    rewardConfig: BUMPER.rewardConfig,
    placement: 1,
    scoreMs: null,
    priorBestMs: null,
    todayCount: 1, // not first play of day
    flags: null,
    activityId: 'bumper-shells',
    isBot: false,
  };

  it('1st place + repeat play + no focus = 45', () => {
    const b = computeBreakdown(baseInput);
    expect(b.base).toBe(45);
    expect(b.firstPlayOfDayBonus).toBe(0);
    expect(b.focusBonus).toBe(0);
    expect(b.bot).toBe(false);
  });

  it('1st place + first play of day = 45 + 15', () => {
    const b = computeBreakdown({ ...baseInput, todayCount: 0 });
    expect(b.firstPlayOfDayBonus).toBe(15);
    const total = b.base + b.firstPlayOfDayBonus + b.personalBestBonus + b.focusBonus;
    expect(total).toBe(60);
  });

  it('4th place + first play + focus-aligned (Salty Spitoon) = 10 + 15 = 25 base/bonus, +25% = 31', () => {
    const b = computeBreakdown({
      ...baseInput,
      placement: 4,
      todayCount: 0,
      flags: { learningFocus: 'api-integrations' },
    });
    expect(b.base).toBe(10);
    expect(b.firstPlayOfDayBonus).toBe(15);
    expect(b.focusBonus).toBe(Math.round((10 + 15) * 0.25)); // = 6
    const total = b.base + b.firstPlayOfDayBonus + b.personalBestBonus + b.focusBonus;
    expect(total).toBe(31);
  });
});

describe('computeBreakdown — bots get zero everything', () => {
  it('returns all-zero breakdown with bot=true regardless of placement', () => {
    const b = computeBreakdown({
      rewardConfig: BUMPER.rewardConfig,
      placement: 1,
      scoreMs: null,
      priorBestMs: null,
      todayCount: 0,
      flags: { learningFocus: 'api-integrations' }, // would normally bonus
      activityId: 'bumper-shells',
      isBot: true,
    });
    expect(b.base).toBe(0);
    expect(b.firstPlayOfDayBonus).toBe(0);
    expect(b.focusBonus).toBe(0);
    expect(b.bot).toBe(true);
  });
});

describe('computeBreakdown — Reef Race personal-best', () => {
  const reefInput = {
    rewardConfig: REEF.rewardConfig,
    placement: 1,
    scoreMs: 95_000,
    priorBestMs: null,
    todayCount: 1,
    flags: null,
    activityId: 'reef-race',
    isBot: false,
  };

  it('first-ever Reef finish counts as PB → +10 bonus', () => {
    const b = computeBreakdown(reefInput);
    expect(b.personalBestBonus).toBe(10);
  });

  it('finish slower than priorBest → no PB bonus', () => {
    const b = computeBreakdown({ ...reefInput, priorBestMs: 90_000 });
    expect(b.personalBestBonus).toBe(0);
  });

  it('finish faster than priorBest → PB bonus', () => {
    const b = computeBreakdown({ ...reefInput, priorBestMs: 100_000 });
    expect(b.personalBestBonus).toBe(10);
  });
});

describe('computeBreakdown - persisted Reef lap PB', () => {
  const reefInput = {
    rewardConfig: REEF.rewardConfig,
    placement: 1,
    scoreMs: 95_000,
    priorBestMs: 90_000,
    todayCount: 1,
    flags: null,
    activityId: 'reef-race',
    isBot: false,
  };

  it('awards from the lap claim even when whole-match score is slower', () => {
    const breakdown = computeBreakdown({
      ...reefInput,
      personalBestQualified: true,
    });
    expect(breakdown.personalBestBonus).toBe(10);
  });

  it('does not award without the lap claim even when whole-match score is faster', () => {
    const breakdown = computeBreakdown({
      ...reefInput,
      priorBestMs: 100_000,
      personalBestQualified: false,
    });
    expect(breakdown.personalBestBonus).toBe(0);
  });
});

describe('getReefRaceFlagCount — PB anti-cheat sim selection', () => {
  it('reads only the legacy counter when the spline flag is off', () => {
    const calls: string[] = [];
    const legacy = {
      getFlagCount: (roomId: string, avatarId: string) => {
        calls.push(`legacy:${roomId}:${avatarId}`);
        return 2;
      },
    };
    const spline = {
      getFlagCount: () => {
        calls.push('spline');
        return 7;
      },
    };

    expect(
      getReefRaceFlagCount('room-reef', 'avatar-human-1', false, legacy, spline),
    ).toBe(2);
    expect(calls).toEqual(['legacy:room-reef:avatar-human-1']);
  });

  it('reads only the spline counter when the spline flag is on', () => {
    const calls: string[] = [];
    const legacy = {
      getFlagCount: () => {
        calls.push('legacy');
        return 2;
      },
    };
    const spline = {
      getFlagCount: (roomId: string, avatarId: string) => {
        calls.push(`spline:${roomId}:${avatarId}`);
        return 7;
      },
    };

    expect(
      getReefRaceFlagCount('room-reef', 'avatar-human-1', true, legacy, spline),
    ).toBe(7);
    expect(calls).toEqual(['spline:room-reef:avatar-human-1']);
  });
});

// ─── Integration — issueRewardsForRoom DB orchestration ──────────────────

describe('issueRewardsForRoom', () => {
  function buildRoom(): Room {
    const now = Date.now();
    const participants = new Map<string, RoomParticipant>([
      [
        'avatar-human-1',
        {
          avatarId: 'avatar-human-1',
          userId: 'user-1',
          agentId: null,
          subjectType: 'human',
          partyId: null,
          joinedAt: now,
          connected: true,
          disconnectedAt: null,
          wsConnectionId: null,
        },
      ],
      [
        'avatar-bot-1',
        {
          avatarId: 'avatar-bot-1',
          userId: null,
          agentId: null,
          subjectType: 'bot',
          partyId: null,
          joinedAt: now,
          connected: true,
          disconnectedAt: null,
          wsConnectionId: null,
        },
      ],
    ]);
    return {
      id: 'room-test-1',
      shortCode: 'AAAAAA',
      activityId: 'bumper-shells',
      state: 'results',
      participants,
      countdownStartedAt: now - 5_000,
      startedAt: now - 90_000,
      endedAt: now,
      createdAt: now - 100_000,
      lastTouchedAt: now,
      hasBots: true,
      hasAgents: false,
      activityConfig: { minPlayers: 4, maxPlayers: 8, preferredPlayers: 6 },
      preLaunchBuffer: null,
    };
  }

  it('credits the human participant + writes both result rows + skips credit for bot', async () => {
    const room = buildRoom();
    const issued = await issueRewardsForRoom({
      room,
      simResults: [
        { avatarId: 'avatar-human-1', placement: 1, score: 4 },
        { avatarId: 'avatar-bot-1', placement: 2, score: 2 },
      ],
    });
    expect(issued).toHaveLength(2);

    // Human gets full credit
    const humanRow = issued.find((r) => r.avatarId === 'avatar-human-1')!;
    expect(humanRow.tokensAwarded).toBe(45 + 15); // 1st place + first-play-of-day
    expect(humanRow.leaderboardPoints).toBe(30);
    expect(humanRow.subjectType).toBe('human');

    // Bot is recorded with zeroes
    const botRow = issued.find((r) => r.avatarId === 'avatar-bot-1')!;
    expect(botRow.tokensAwarded).toBe(0);
    expect(botRow.leaderboardPoints).toBe(0);
    expect(botRow.subjectType).toBe('bot');
    expect(botRow.breakdown.bot).toBe(true);

    // Only the human went through creditClawTokens
    expect(creditCalls).toHaveLength(1);
    expect(creditCalls[0].avatarId).toBe('avatar-human-1');
    expect(creditCalls[0].amount).toBe(60);
    expect(creditCalls[0].reason).toBe('activity_match_placed');
  });

  it('runs all DB writes inside a single transaction call', async () => {
    const room = buildRoom();
    await issueRewardsForRoom({
      room,
      simResults: [
        { avatarId: 'avatar-human-1', placement: 1, score: 4 },
        { avatarId: 'avatar-bot-1', placement: 2, score: 2 },
      ],
    });
    // Two `tx.insert` calls — one per result row.
    const inserts = txCalls.filter((c) => c.op === 'tx.insert');
    expect(inserts.length).toBe(2);
  });

  it('treats the result insert as the reward claim and suppresses a conflict loser', async () => {
    const room = buildRoom();
    duplicateResultAvatarIds.add('avatar-human-1');

    const issued = await issueRewardsForRoom({
      room,
      simResults: [
        { avatarId: 'avatar-human-1', placement: 1, score: 4 },
      ],
    });

    expect(issued).toEqual([]);
    expect(creditCalls).toHaveLength(0);
    const conflictCalls = txCalls.filter(
      (call) => call.op === 'tx.insert.onConflictDoNothing',
    );
    expect(conflictCalls).toHaveLength(1);
    expect(conflictCalls[0].args[0]).toEqual({
      target: ['room_id', 'avatar_id'],
    });
  });
});
