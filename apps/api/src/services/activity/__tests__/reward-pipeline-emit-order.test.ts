/**
 * Reef Race — MONEY/PARITY PROOF (adversarial auditor, team
 * reef-mechanics-2026-07-10, Phase 1 item 1).
 *
 * The team lead asked for the scoring EMIT to be PROVEN, not assumed:
 *   - a completed reef-race emits one `activity.match.placed` per
 *     participant, in FINISH ORDER, carrying the REAL placement +
 *     subjectType (so the free-agent leaderboard SQL can tier it at
 *     1st=12 / 2nd=6 / 3rd=3 / default=1 keyed on payload.placement,
 *     filtering subjectType='bot');
 *   - BOTS are placed but earn 0 CT and 0 leaderboard points, and never
 *     hit creditClawTokens;
 *   - GUESTS earn real CT but 0 leaderboard points (the per-activity
 *     carve-out at the reward-pipeline layer).
 *
 * This complements the existing `reward-pipeline.test.ts` (which mocks
 * logEvent to a no-op and never asserts the emitted payloads). Here we
 * CAPTURE every emitted event and assert its order + payload.
 *
 * Drizzle + ledger + event-logger are mocked at module-load so this test
 * never touches Postgres. A separate file from reward-pipeline.test.ts to
 * avoid Bun's process-wide mock.module bleed (see that file's header).
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';

// ─── Capture buckets ────────────────────────────────────────────────────────

const txInserts: Array<Record<string, unknown>> = [];
const creditCalls: Array<{ avatarId: string; amount: number }> = [];
const emittedEvents: Array<{
  eventType: string;
  avatarId?: string | null;
  agentId?: string | null;
  payload: Record<string, unknown>;
}> = [];

// avatars.flags/isGuest select result — configured per test. The non-bot
// flag fetch awaits `.where()` directly; the today-count + best-ms queries
// call `.where().groupBy()` (→ [] here, so: no prior plays, no prior best).
let avatarFlagRows: Array<{ id: string; flags: unknown; isGuest: boolean }> = [];

function makeReturning() {
  return {
    returning() {
      return Promise.resolve([{ id: `result-${txInserts.length}` }]);
    },
  };
}

function makeTxThenable() {
  return {
    then(resolve: (v: undefined) => unknown) {
      return Promise.resolve(undefined).then(resolve);
    },
    values(v: Record<string, unknown>) {
      txInserts.push(v);
      return makeReturning();
    },
    set() {
      return makeTxThenable();
    },
    where() {
      return makeTxThenable();
    },
    from() {
      return makeTxThenable();
    },
  };
}

const dbMock = {
  transaction(fn: (tx: unknown) => Promise<unknown>) {
    const tx = {
      insert() {
        return makeTxThenable();
      },
      update() {
        return makeTxThenable();
      },
      execute() {
        // creditClawTokens SELECT FOR UPDATE — return a row.
        return Promise.resolve([{ user_id: 'user-1', claw_tokens: 100 }]);
      },
    };
    return fn(tx);
  },
  select() {
    return {
      from() {
        return {
          where() {
            // Awaited directly → flag rows (+ the bot-winrate level query,
            // which harmlessly reads missing `.level` → defaults to 1).
            // `.groupBy()` → [] for the today-count / best-ms queries.
            const rows = avatarFlagRows;
            return {
              then(resolve: (v: unknown[]) => unknown) {
                return Promise.resolve(rows as unknown[]).then(resolve);
              },
              groupBy() {
                return Promise.resolve([]);
              },
            };
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
  avatars: { id: 'id', flags: 'flags', isGuest: 'is_guest', level: 'level' },
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
  activityRooms: { id: 'id', activityId: 'activity_id', shortCode: 'short_code', status: 'status' },
  activityRoomParticipants: { roomId: 'room_id', avatarId: 'avatar_id' },
  activityReplays: { id: 'id' },
  clawTokenTransactions: { id: 'id' },
}));

mock.module('../alert-error', () => ({
  alertError: () => Promise.resolve(),
}));

mock.module('../../event-logger', () => ({
  logEvent: (e: {
    eventType: string;
    avatarId?: string | null;
    agentId?: string | null;
    payload: Record<string, unknown>;
  }) => {
    emittedEvents.push({
      eventType: e.eventType,
      avatarId: e.avatarId,
      agentId: e.agentId,
      payload: e.payload,
    });
    return Promise.resolve();
  },
  ACTIVITY_EVENT_TYPES: { MATCH_PLACED: 'activity.match.placed' },
}));

mock.module('../../claw-token-ledger', () => ({
  creditClawTokens: async (input: { avatarId: string; amount: number }) => {
    creditCalls.push({ avatarId: input.avatarId, amount: input.amount });
    return { balanceAfter: 100 + input.amount, ledgerId: 'ledger-1' };
  },
}));

// SUT after mocks.
const { issueRewardsForRoom } = await import('../reward-pipeline');
import type { Room, RoomParticipant } from '../types';

const MATCH_PLACED = 'activity.match.placed';

beforeEach(() => {
  txInserts.length = 0;
  creditCalls.length = 0;
  emittedEvents.length = 0;
  avatarFlagRows = [];
});

// ─── Fixture ────────────────────────────────────────────────────────────────

function buildReefRoom(): Room {
  const now = Date.now();
  const participants = new Map<string, RoomParticipant>([
    ['av-human', {
      avatarId: 'av-human', userId: 'user-h', agentId: null,
      subjectType: 'human', partyId: null, joinedAt: now, connected: true,
      disconnectedAt: null, wsConnectionId: null,
    }],
    ['av-agent', {
      avatarId: 'av-agent', userId: 'user-a', agentId: 'agent:openclaw-42',
      subjectType: 'agent', partyId: null, joinedAt: now, connected: true,
      disconnectedAt: null, wsConnectionId: null,
    }],
    ['av-guest', {
      // Guests play as subjectType 'human' (there is no 'guest' SubjectType);
      // the carve-out fires off avatars.isGuest → ctx.isGuest.
      avatarId: 'av-guest', userId: 'user-g', agentId: null,
      subjectType: 'human', partyId: null, joinedAt: now, connected: true,
      disconnectedAt: null, wsConnectionId: null,
    }],
    ['av-bot', {
      avatarId: 'av-bot', userId: null, agentId: null,
      subjectType: 'bot', partyId: null, joinedAt: now, connected: true,
      disconnectedAt: null, wsConnectionId: null,
    }],
  ]);
  return {
    id: 'room-reef-1', shortCode: 'REEF01', activityId: 'reef-race',
    state: 'results', participants,
    countdownStartedAt: now - 5_000, startedAt: now - 90_000, endedAt: now,
    createdAt: now - 100_000, lastTouchedAt: now, hasBots: true,
    activityConfig: { minPlayers: 4, maxPlayers: 8, preferredPlayers: 6 },
    preLaunchBuffer: null,
  } as unknown as Room;
}

describe('Reef Race scoring emit — order + tiers + bot/guest carve-outs', () => {
  it('emits one activity.match.placed per participant, in finish order, with real placement + subjectType; bots & guests get 0 leaderboard points; only humans/agents credited', async () => {
    // Guest is flagged via avatars.isGuest; human/agent are not.
    avatarFlagRows = [
      { id: 'av-human', flags: null, isGuest: false },
      { id: 'av-agent', flags: null, isGuest: false },
      { id: 'av-guest', flags: null, isGuest: true },
    ];

    const room = buildReefRoom();
    // Finish order: human 1st, agent 2nd, guest 3rd, bot 4th.
    // score = -finishMs so DESC sort puts winner first; scoreMs null → no PB
    // bonus so token math stays deterministic (base + first-play-of-day 15).
    const issued = await issueRewardsForRoom({
      room,
      simResults: [
        { avatarId: 'av-human', placement: 1, score: -90_000, scoreMs: null },
        { avatarId: 'av-agent', placement: 2, score: -92_000, scoreMs: null },
        { avatarId: 'av-guest', placement: 3, score: -95_000, scoreMs: null },
        { avatarId: 'av-bot', placement: 4, score: -99_000, scoreMs: null },
      ],
    });

    // ── Emit: exactly one MATCH_PLACED per participant (bots included) ──
    const placed = emittedEvents.filter((e) => e.eventType === MATCH_PLACED);
    expect(placed).toHaveLength(4);

    // ── ORDER: emitted in finish order with the REAL placement ──
    expect(placed.map((e) => e.payload.placement)).toEqual([1, 2, 3, 4]);
    expect(placed.map((e) => e.avatarId)).toEqual([
      'av-human', 'av-agent', 'av-guest', 'av-bot',
    ]);

    // ── subjectType carried so the leaderboard SQL can filter bots + bucket
    //    agents vs avatars ──
    expect(placed.map((e) => e.payload.subjectType)).toEqual([
      'human', 'agent', 'human', 'bot',
    ]);
    // Agent binds to its agentId on the emit envelope (free-agent board
    // agent_daily CTE keys on events.agent_id IS NOT NULL).
    const agentEvt = placed.find((e) => e.avatarId === 'av-agent')!;
    expect(agentEvt.agentId).toBe('agent:openclaw-42');

    const human = placed.find((e) => e.avatarId === 'av-human')!;
    const agent = placed.find((e) => e.avatarId === 'av-agent')!;
    const guest = placed.find((e) => e.avatarId === 'av-guest')!;
    const bot = placed.find((e) => e.avatarId === 'av-bot')!;

    // ── BOT: placed, 0 CT, 0 leaderboard points ──
    expect(bot.payload.tokensAwarded).toBe(0);
    expect(bot.payload.leaderboardPoints).toBe(0);

    // ── GUEST: earns real CT (>0) but 0 leaderboard points ──
    expect(guest.payload.isGuest).toBe(true);
    expect(guest.payload.tokensAwarded as number).toBeGreaterThan(0);
    expect(guest.payload.leaderboardPoints).toBe(0);

    // ── HUMAN + AGENT: real CT + real leaderboard points ──
    expect(human.payload.tokensAwarded as number).toBeGreaterThan(0);
    expect(human.payload.leaderboardPoints as number).toBeGreaterThan(0);
    expect(agent.payload.tokensAwarded as number).toBeGreaterThan(0);
    expect(agent.payload.leaderboardPoints as number).toBeGreaterThan(0);

    // ── CREDIT: only non-bot, non-zero recipients hit the ledger.
    //    Bot NEVER credited; guest IS credited (real CT). ──
    const credited = new Set(creditCalls.map((c) => c.avatarId));
    expect(credited.has('av-bot')).toBe(false);
    expect(credited.has('av-human')).toBe(true);
    expect(credited.has('av-agent')).toBe(true);
    expect(credited.has('av-guest')).toBe(true);

    // ── Reward-config tiers wired (reef: 1st=50, 2nd=35, 3rd=25) + first
    //    play-of-day +15. Proves the emitted tokens track the REAL config. ──
    expect(human.payload.tokensAwarded).toBe(50 + 15);
    expect(agent.payload.tokensAwarded).toBe(35 + 15);
    expect(guest.payload.tokensAwarded).toBe(25 + 15);

    // ── The IssuedResult return mirrors the emit (defense in depth) ──
    expect(issued).toHaveLength(4);
    const issuedBot = issued.find((r) => r.avatarId === 'av-bot')!;
    expect(issuedBot.tokensAwarded).toBe(0);
    expect(issuedBot.leaderboardPoints).toBe(0);
  });
});
