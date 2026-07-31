/**
 * Q2 Activity Portals — room manager unit tests.
 *
 * Pre-DB tests — verifies FSM transition validation, sweeper kills,
 * concurrency caps, and short-code regeneration. The real Drizzle
 * client is mock'd at module-load time so these tests do NOT touch the
 * Supabase pooler.
 *
 * Run: `bun test apps/api/src/services/activity/__tests__/`
 */

import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';

// ─── Mock Drizzle client BEFORE importing the SUT ─────────────────────────
//
// `db.insert(...).values(...)`, `db.update(...).set(...).where(...)`, and
// `db.select().from(...).where(...)` — every call returns a thenable so
// `await` works either way. The chains return themselves for fluency.

const dbMock = makeDbMock();

mock.module('@clawville/database', () => ({
  db: dbMock,
  and: (...args: unknown[]) => args,
  eq: (...args: unknown[]) => args,
  inArray: (...args: unknown[]) => args,
  activityRooms: {
    id: 'id',
    activityId: 'activity_id',
    shortCode: 'short_code',
    status: 'status',
  },
  activityRoomParticipants: {
    roomId: 'room_id',
    avatarId: 'avatar_id',
  },
  activityQueueEntries: { id: 'id', leftAt: 'left_at' },
  activityParties: { id: 'id' },
  activityPartyMembers: { partyId: 'party_id' },
  activityReplays: { id: 'id' },
  lobbies: {
    id: 'id',
    roomId: 'room_id',
    mode: 'mode',
    state: 'state',
  },
  lobbyEvents: { id: 'id' },
  lobbyPlayers: { lobbyId: 'lobby_id', avatarId: 'avatar_id' },
  // Chunk #7 — reward pipeline imports these.
  activityResults: { id: 'id', avatarId: 'avatar_id', activityId: 'activity_id' },
  avatars: { id: 'id', flags: 'flags' },
  users: { id: 'id', isGuest: 'is_guest' },
  clawTokenTransactions: { id: 'id' },
  // Phase 4 — reward pipeline transitively imports the PB service which
  // references this table. Mock with the column shape used in PB queries.
  reefRacePersonalBests: {
    id: 'id',
    avatarId: 'avatar_id',
    activityId: 'activity_id',
    bestLapMs: 'best_lap_ms',
    ghostReplayData: 'ghost_replay_data',
  },
  reefRacePersonalBestClaims: {
    id: 'claim_id',
    sourceRoomId: 'source_room_id',
    avatarId: 'avatar_id',
    bestLapMs: 'best_lap_ms',
    previousBestLapMs: 'previous_best_lap_ms',
    dailyRank: 'daily_rank',
  },
}));

mock.module('../../alert-error', () => ({
  alertError: () => Promise.resolve(),
}));

mock.module('../../event-logger', () => ({
  logEvent: () => Promise.resolve(),
  ACTIVITY_EVENT_TYPES: { MATCH_PLACED: 'activity.match.placed' },
}));

// Chunk #7 — claw-token-ledger is imported transitively via the reward
// pipeline. Stub it so the room-manager tests that drive RESULTS
// transitions don't try to hit the real ledger SQL.
mock.module('../../claw-token-ledger', () => ({
  creditClawTokens: () =>
    Promise.resolve({ balanceAfter: 100, ledgerId: 'ledger-1' }),
}));

// Chunk #3 wired the replay log into the room manager's RESULTS
// transition. Mock it so this test doesn't need DB wires or touch the
// replay write path.
mock.module('../activity-replay-log', () => ({
  activityReplayLog: {
    appendInputFrame: () => {},
    flushToDb: () => Promise.resolve(null),
    dropRoom: () => {},
    getReplayId: () => undefined,
    bufferLength: () => 0,
    __resetForTest: () => {},
  },
}));

mock.module('../../wager-program-client', () => ({
  cancelLobby: () => Promise.reject(new Error('unexpected production cancel in unit test')),
  lockLobby: () => Promise.reject(new Error('unexpected production lock in unit test')),
  readWagerLobbyChainState: () =>
    Promise.reject(new Error('unexpected production chain read in unit test')),
  settleSolLobby: () => Promise.reject(new Error('unexpected production settle in unit test')),
  withResolvedWagerLobbyFence: () =>
    Promise.reject(new Error('unexpected production fence in unit test')),
  WagerClientError: class WagerClientError extends Error {
    constructor(message: string, public readonly code: string) {
      super(message);
    }
  },
}));

const {
  activityRoomManager,
  RoomCapacityError,
  MAX_ROOMS_PER_ACTIVITY,
  MAX_ROOMS_TOTAL,
  REEF_RACE_NO_SHOW_ABORT_MS,
  LIVE_OWNER_WATCHDOG_GRACE_MS,
  shouldCrashSweepLiveRoom,
} = await import(
  '../activity-room-manager'
);
const { REEF_RACE_COUNTDOWN_DURATION_MS } = await import('@clawville/shared');
const { bumperShellsSim } = await import('../sim/bumper-shells-sim');
const { cancelLobbyForAbortedRoom, handleWagerRoomAborted } = await import(
  '../wager-lobby-bridge'
);
import type {
  LobbyHandle,
  WagerAbortRecoveryDeps,
} from '../wager-lobby-bridge';

// ─── Helpers ──────────────────────────────────────────────────────────────

const ACTIVITY_ID = 'bumper-shells';
const ACTIVITY_CONFIG = {
  minPlayers: 4,
  maxPlayers: 8,
  preferredPlayers: 6,
};

describe('live no-WS crash sweep', () => {
  it('allows a bounded live owner lease to settle voluntary DNF rows', () => {
    const now = 1_000_000;
    const longIdle = 60_000;
    expect(
      shouldCrashSweepLiveRoom(0, longIdle, now + 1, now),
    ).toBe(false);
  });

  it('retains no-WS sweeping without a lease and watchdogs expired owners', () => {
    const now = 1_000_000;
    expect(shouldCrashSweepLiveRoom(0, 60_000, null, now)).toBe(true);
    expect(shouldCrashSweepLiveRoom(1, 60_000, null, now)).toBe(false);
    expect(shouldCrashSweepLiveRoom(1, 0, now - 1, now)).toBe(true);
  });
});

function makeParticipants(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    avatarId: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
    userId: `user-${i}`,
    agentId: null,
    subjectType: 'human' as const,
    partyId: null,
  }));
}

beforeEach(() => {
  activityRoomManager.__resetForTest();
  dbMock.reset();
});

afterEach(() => {
  jest.useRealTimers();
});

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

// ─── FSM transition tests ─────────────────────────────────────────────────

describe('Room FSM transitions', () => {
  it('createRoom transitions PENDING → COUNTDOWN automatically', async () => {
    const room = await activityRoomManager.createRoom(
      ACTIVITY_ID,
      makeParticipants(4),
      ACTIVITY_CONFIG,
    );
    expect(room.state).toBe('countdown');
    expect(room.shortCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
    expect(activityRoomManager.getRoom(room.id)?.state).toBe('countdown');
  });

  it('COUNTDOWN → LIVE → RESULTS → GC is the happy path', async () => {
    const room = await activityRoomManager.createRoom(
      ACTIVITY_ID,
      makeParticipants(4),
      ACTIVITY_CONFIG,
    );
    await activityRoomManager.transitionRoom(room.id, 'live');
    expect(room.state).toBe('live');
    expect(room.startedAt).toBeGreaterThan(0);

    await activityRoomManager.transitionRoom(room.id, 'results');
    expect(room.state).toBe('results');
    expect(room.endedAt).toBeGreaterThan(0);

    await activityRoomManager.transitionRoom(room.id, 'gc');
    // Room evicted after GC
    expect(activityRoomManager.getRoom(room.id)).toBeUndefined();
  });

  it('rejects invalid transitions (LIVE → COUNTDOWN)', async () => {
    const room = await activityRoomManager.createRoom(
      ACTIVITY_ID,
      makeParticipants(4),
      ACTIVITY_CONFIG,
    );
    await activityRoomManager.transitionRoom(room.id, 'live');
    await expect(
      activityRoomManager.transitionRoom(room.id, 'countdown'),
    ).rejects.toThrow(/Invalid transition/);
  });

  it('rejects invalid transitions (RESULTS → ABORTED)', async () => {
    const room = await activityRoomManager.createRoom(
      ACTIVITY_ID,
      makeParticipants(4),
      ACTIVITY_CONFIG,
    );
    await activityRoomManager.transitionRoom(room.id, 'live');
    await activityRoomManager.transitionRoom(room.id, 'results');
    await expect(
      activityRoomManager.transitionRoom(room.id, 'aborted'),
    ).rejects.toThrow(/Invalid transition/);
  });

  it('COUNTDOWN → ABORTED is permitted', async () => {
    const room = await activityRoomManager.createRoom(
      ACTIVITY_ID,
      makeParticipants(4),
      ACTIVITY_CONFIG,
    );
    await activityRoomManager.transitionRoom(room.id, 'aborted');
    expect(activityRoomManager.getRoom(room.id)).toBeUndefined();
  });

  it('LIVE → ABORTED_CRASH evicts the room', async () => {
    const room = await activityRoomManager.createRoom(
      ACTIVITY_ID,
      makeParticipants(4),
      ACTIVITY_CONFIG,
    );
    await activityRoomManager.transitionRoom(room.id, 'live');
    await activityRoomManager.transitionRoom(room.id, 'aborted_crash');
    expect(activityRoomManager.getRoom(room.id)).toBeUndefined();
  });
});

// ─── Connect-anchored Reef countdown ───────────────────────────────────────

describe('ensureSyncedCountdown', () => {
  it('does not advance a Reef room while zero non-bot participants are connected', async () => {
    jest.useFakeTimers();
    const baseParticipants = makeParticipants(2);
    const participants = [
      baseParticipants[0],
      {
        ...baseParticipants[1],
        userId: null,
        subjectType: 'bot' as const,
      },
    ];
    const room = await activityRoomManager.createRoom(
      'reef-race',
      participants,
      ACTIVITY_CONFIG,
    );
    room.participants.get(participants[1].avatarId)!.connected = true;
    expect(activityRoomManager.ensureSyncedCountdown(room.id)).toBeNull();

    jest.advanceTimersByTime(REEF_RACE_COUNTDOWN_DURATION_MS * 2);
    expect(room.state).toBe('countdown');
  });

  it('unconditionally re-anchors on first non-bot connect and waits a full window', async () => {
    jest.useFakeTimers();
    const participants = [
      {
        ...makeParticipants(1)[0],
        userId: 'agent-owner-1',
        agentId: 'agent-1',
        subjectType: 'agent' as const,
      },
      { ...makeParticipants(2)[1] },
    ];
    const room = await activityRoomManager.createRoom(
      'reef-race',
      participants,
      ACTIVITY_CONFIG,
    );

    jest.advanceTimersByTime(4_500);
    const creationAnchor = room.countdownStartedAt;
    room.participants.get(participants[0].avatarId)!.connected = true;
    const anchored = activityRoomManager.ensureSyncedCountdown(room.id);
    if (anchored === null) throw new Error('Reef countdown was not armed');
    expect(anchored).not.toBe(creationAnchor);
    expect(anchored).toBe(Date.now());
    expect(room.countdownStartedAt).toBe(anchored);

    room.participants.get(participants[1].avatarId)!.connected = true;
    expect(activityRoomManager.ensureSyncedCountdown(room.id)).toBe(anchored);
    jest.advanceTimersByTime(REEF_RACE_COUNTDOWN_DURATION_MS - 1);
    expect(room.state).toBe('countdown');
    jest.advanceTimersByTime(1);
    expect(room.state).toBe('live');
  });

  it('aborts and evicts a Reef no-show 60s from room creation', async () => {
    jest.useFakeTimers();
    const room = await activityRoomManager.createRoom(
      'reef-race',
      makeParticipants(4),
      ACTIVITY_CONFIG,
    );

    jest.advanceTimersByTime(REEF_RACE_NO_SHOW_ABORT_MS - 1);
    expect(activityRoomManager.getRoom(room.id)).toBeDefined();
    jest.advanceTimersByTime(1);
    await flushMicrotasks();
    expect(activityRoomManager.getRoom(room.id)).toBeUndefined();
  });

  it('uses only the remaining no-show budget after delayed countdown persistence', async () => {
    jest.useFakeTimers();
    const persistenceDelayMs = 10_000;
    dbMock.delayNextInsert(persistenceDelayMs);
    const roomPromise = activityRoomManager.createRoom(
      'reef-race',
      makeParticipants(4),
      ACTIVITY_CONFIG,
    );

    await flushMicrotasks();
    jest.advanceTimersByTime(persistenceDelayMs);
    await flushMicrotasks();
    const room = await roomPromise;

    const remainingMs = REEF_RACE_NO_SHOW_ABORT_MS - persistenceDelayMs;
    jest.advanceTimersByTime(remainingMs - 1);
    expect(activityRoomManager.getRoom(room.id)).toBeDefined();
    jest.advanceTimersByTime(1);
    await flushMicrotasks();
    expect(activityRoomManager.getRoom(room.id)).toBeUndefined();
  });

  it('preserves the existing creation-anchored countdown for non-Reef rooms', async () => {
    jest.useFakeTimers();
    const room = await activityRoomManager.createRoom(
      ACTIVITY_ID,
      makeParticipants(4),
      ACTIVITY_CONFIG,
    );

    jest.advanceTimersByTime(4_999);
    expect(room.state).toBe('countdown');
    jest.advanceTimersByTime(1);
    expect(room.state).toBe('live');
  });

});

// ─── Concurrency caps ─────────────────────────────────────────────────────

describe('Concurrency caps', () => {
  it('throws RoomCapacityError when MAX_ROOMS_PER_ACTIVITY is exceeded', async () => {
    // Pre-allocate caps - use small, fast loop
    const limit = MAX_ROOMS_PER_ACTIVITY;
    for (let i = 0; i < limit; i++) {
      await activityRoomManager.createRoom(
        ACTIVITY_ID,
        makeParticipants(4).map((p) => ({
          ...p,
          avatarId: `${i}-${p.avatarId}`,
        })),
        ACTIVITY_CONFIG,
      );
    }

    await expect(
      activityRoomManager.createRoom(ACTIVITY_ID, makeParticipants(4), ACTIVITY_CONFIG),
    ).rejects.toBeInstanceOf(RoomCapacityError);
  });

  it('throws when participants exceed maxPlayers', async () => {
    await expect(
      activityRoomManager.createRoom(
        ACTIVITY_ID,
        makeParticipants(9),
        ACTIVITY_CONFIG,
      ),
    ).rejects.toThrow(/Too many participants/);
  });

  it('throws when participants is empty', async () => {
    await expect(
      activityRoomManager.createRoom(ACTIVITY_ID, [], ACTIVITY_CONFIG),
    ).rejects.toThrow(/at least one participant/);
  });
});

// ─── Short-code generation ────────────────────────────────────────────────

describe('Short-code regeneration', () => {
  it('produces unique short codes across many rooms', async () => {
    const codes = new Set<string>();
    const N = 50;
    for (let i = 0; i < N; i++) {
      const r = await activityRoomManager.createRoom(
        ACTIVITY_ID,
        makeParticipants(4).map((p) => ({
          ...p,
          avatarId: `${i}-${p.avatarId}`,
        })),
        ACTIVITY_CONFIG,
      );
      expect(codes.has(r.shortCode)).toBe(false);
      codes.add(r.shortCode);
    }
    expect(codes.size).toBe(N);
  });

  it('looks up rooms by short code', async () => {
    const room = await activityRoomManager.createRoom(
      ACTIVITY_ID,
      makeParticipants(4),
      ACTIVITY_CONFIG,
    );
    expect(activityRoomManager.getRoomByShortCode(room.shortCode)?.id).toBe(room.id);
    // Case-insensitive
    expect(
      activityRoomManager.getRoomByShortCode(room.shortCode.toLowerCase())?.id,
    ).toBe(room.id);
  });
});

// ─── Sweeper ──────────────────────────────────────────────────────────────

describe('Room sweeper', () => {
  it('aborts COUNTDOWN rooms with no connected players (after the connect-grace window)', async () => {
    const room = await activityRoomManager.createRoom(
      ACTIVITY_ID,
      makeParticipants(4),
      ACTIVITY_CONFIG,
    );
    // The sweeper grants a ~10s connect-grace before aborting an unconnected
    // COUNTDOWN room (so a client navigating from the lobby isn't raced — see
    // the sweeper's countdown branch). Age the countdown anchor past that grace
    // so the abort condition is genuinely met. None are connected → kill.
    room.countdownStartedAt = Date.now() - 11_000;
    await activityRoomManager.roomSweeper();
    expect(activityRoomManager.getRoom(room.id)).toBeUndefined();
  });

  it('preserves COUNTDOWN rooms with at least one connected player', async () => {
    const room = await activityRoomManager.createRoom(
      ACTIVITY_ID,
      makeParticipants(4),
      ACTIVITY_CONFIG,
    );
    // Mark one participant as connected so the sweeper backs off.
    const first = room.participants.values().next().value!;
    first.connected = true;
    await activityRoomManager.roomSweeper();
    expect(activityRoomManager.getRoom(room.id)).toBeDefined();
  });

  it('GCs RESULTS rooms older than the retention window', async () => {
    const room = await activityRoomManager.createRoom(
      ACTIVITY_ID,
      makeParticipants(4),
      ACTIVITY_CONFIG,
    );
    await activityRoomManager.transitionRoom(room.id, 'live');
    await activityRoomManager.transitionRoom(room.id, 'results');
    // Backdate endedAt past the retention window (120s).
    room.endedAt = Date.now() - 121_000;
    await activityRoomManager.roomSweeper();
    expect(activityRoomManager.getRoom(room.id)).toBeUndefined();
  });

  it('cancels a locked wager after lease expiry, once, while preserving the MTT filter', async () => {
    jest.useFakeTimers();
    const startedAt = new Date('2026-07-31T12:00:00.000Z').getTime();
    jest.setSystemTime(startedAt);
    const cancelInputs: Array<{
      lobbyIdBigint: bigint;
      signerKind: 'creator' | 'settlement-authority';
    }> = [];
    const chainReads: bigint[] = [];
    const mttRecovered: string[] = [];
    const evictedParticipants: string[][] = [];
    let attachedRoomId = '';
    let chainState: 'locked' | 'cancelled' = 'locked';
    let refundable = false;
    let cancelSig: string | null = null;
    let lobby: LobbyHandle = {
      rowId: '00000000-0000-0000-0000-000000000099',
      lobbyId: 99n,
      state: 'locked',
      mode: 'multiplayer',
      onChainCreateStatus: 'confirmed',
    };
    const wagerDeps: WagerAbortRecoveryDeps = {
      findLobbyForRoom: async (roomId) =>
        roomId === attachedRoomId ? { ...lobby } : null,
      withResolvedFence: async (lobbyRowId, run) => {
        expect(lobbyRowId).toBe(lobby.rowId);
        return run({
          getCurrent: async () => ({ ...lobby }),
          markCancelled: async ({ txSig }) => {
            lobby = { ...lobby, state: 'cancelled' };
            cancelSig = txSig;
            refundable = true;
          },
        });
      },
      readChainState: async (lobbyId) => {
        chainReads.push(lobbyId);
        return chainState;
      },
      cancelLobby: async (input) => {
        cancelInputs.push(input);
        chainState = 'cancelled';
        return { txSig: 'cancel-sig-99', signerPubkey: 'settlement-authority' };
      },
    };
    activityRoomManager.registerAbortNotifyFn((roomId, activityId, status) =>
      handleWagerRoomAborted(roomId, activityId, status, wagerDeps),
    );
    activityRoomManager.registerAbortNotifyFn((roomId, activityId) => {
      if (activityId === 'texas-holdem-mtt') mttRecovered.push(roomId);
    });
    activityRoomManager.setEvictionFn((room) => {
      evictedParticipants.push(Array.from(room.participants.keys()));
      bumperShellsSim.stopRoom(room.id);
    });

    const room = await activityRoomManager.createRoom(
      ACTIVITY_ID,
      makeParticipants(4),
      ACTIVITY_CONFIG,
    );
    attachedRoomId = room.id;
    await activityRoomManager.transitionRoom(room.id, 'live');
    const simState = bumperShellsSim.startRoom(
      room.id,
      room.activityId,
      Array.from(room.participants.keys()),
    );
    activityRoomManager.acquireLiveOwnerLease(
      room.id,
      'bumper-shells-sim',
      simState.endsAt,
    );
    // Deterministically model the interval owner dying without firing endRound.
    if (simState.intervalHandle) clearInterval(simState.intervalHandle);
    simState.intervalHandle = null;
    for (const participant of room.participants.values()) {
      participant.connected = true;
    }

    jest.setSystemTime(simState.endsAt + LIVE_OWNER_WATCHDOG_GRACE_MS - 1);
    await activityRoomManager.roomSweeper();
    expect(activityRoomManager.getRoom(room.id)).toBeDefined();

    jest.setSystemTime(simState.endsAt + LIVE_OWNER_WATCHDOG_GRACE_MS + 1);
    await activityRoomManager.roomSweeper();
    expect(activityRoomManager.getRoom(room.id)).toBeUndefined();
    expect(bumperShellsSim.__getState(room.id)).toBeUndefined();
    expect(lobby.state).toBe('cancelled');
    expect(refundable).toBe(true);
    expect(cancelSig as string | null).toBe('cancel-sig-99');
    expect(chainReads).toEqual([99n]);
    expect(cancelInputs).toEqual([
      { lobbyIdBigint: 99n, signerKind: 'settlement-authority' },
    ]);
    expect(mttRecovered).toEqual([]);
    expect(evictedParticipants).toEqual([Array.from(room.participants.keys())]);
    expect(
      activityRoomManager.getPlayerActiveRoom(
        room.participants.keys().next().value!,
      ),
    ).toBeUndefined();

    // Explicit replay is a DB-state no-op: no second chain read or cancel.
    await expect(cancelLobbyForAbortedRoom(room.id, wagerDeps)).resolves.toBe(
      'already_terminal',
    );
    expect(chainReads).toEqual([99n]);
    expect(cancelInputs).toHaveLength(1);

    const mttRoom = await activityRoomManager.createRoom(
      'texas-holdem-mtt',
      makeParticipants(4),
      ACTIVITY_CONFIG,
    );
    await activityRoomManager.transitionRoom(mttRoom.id, 'live');
    await activityRoomManager.transitionRoom(mttRoom.id, 'aborted_crash');
    expect(mttRecovered).toEqual([mttRoom.id]);
    expect(cancelInputs).toHaveLength(1);
  });

  it('reconciles an ambiguous abort cancel on retry without a second send', async () => {
    let lobby: LobbyHandle = {
      rowId: '00000000-0000-0000-0000-000000000077',
      lobbyId: 77n,
      state: 'locked',
      mode: 'multiplayer',
      onChainCreateStatus: 'confirmed',
    };
    let chainState: 'locked' | 'cancelled' = 'locked';
    let cancelCalls = 0;
    let reconciledFromChain = false;
    const deps: WagerAbortRecoveryDeps = {
      findLobbyForRoom: async () => ({ ...lobby }),
      withResolvedFence: async (_lobbyRowId, run) =>
        run({
          getCurrent: async () => ({ ...lobby }),
          markCancelled: async (input) => {
            lobby = { ...lobby, state: 'cancelled' };
            reconciledFromChain = input.reconciledFromChain;
          },
        }),
      readChainState: async () => chainState,
      cancelLobby: async (input) => {
        expect(input).toEqual({
          lobbyIdBigint: 77n,
          signerKind: 'settlement-authority',
        });
        cancelCalls++;
        chainState = 'cancelled';
        throw new Error('RPC response lost after send');
      },
    };

    await expect(cancelLobbyForAbortedRoom('room-77', deps)).rejects.toThrow(
      'RPC response lost after send',
    );
    expect(lobby.state).toBe('locked');

    await expect(cancelLobbyForAbortedRoom('room-77', deps)).resolves.toBe(
      'reconciled_cancelled',
    );
    expect(lobby.state).toBe('cancelled');
    expect(reconciledFromChain).toBe(true);
    expect(cancelCalls).toBe(1);
  });
});

// ─── Player → room index ──────────────────────────────────────────────────

describe('Player active-room lookup', () => {
  it('reports the room for a participant', async () => {
    const participants = makeParticipants(4);
    const room = await activityRoomManager.createRoom(
      ACTIVITY_ID,
      participants,
      ACTIVITY_CONFIG,
    );
    expect(activityRoomManager.getPlayerActiveRoom(participants[0].avatarId)?.id).toBe(
      room.id,
    );
    expect(activityRoomManager.getPlayerActiveRoom('not-a-avatar')).toBeUndefined();
  });

  it('clears the lookup after eviction', async () => {
    const participants = makeParticipants(4);
    const room = await activityRoomManager.createRoom(
      ACTIVITY_ID,
      participants,
      ACTIVITY_CONFIG,
    );
    await activityRoomManager.transitionRoom(room.id, 'aborted');
    expect(activityRoomManager.getPlayerActiveRoom(participants[0].avatarId)).toBeUndefined();
  });

  it('treats a results-state room as not-blocking so the player can re-queue', async () => {
    // Regression for "Avatar is already in an active room" 400 the user hit
    // when a match ended cleanly but GC hadn't run yet — the player closes
    // the results modal and tries to queue again, and the queue refuses.
    // results = match is over, just waiting for the GC sweep.
    const participants = makeParticipants(4);
    const room = await activityRoomManager.createRoom(
      ACTIVITY_ID,
      participants,
      ACTIVITY_CONFIG,
    );
    await activityRoomManager.transitionRoom(room.id, 'live');
    await activityRoomManager.transitionRoom(room.id, 'results');
    expect(activityRoomManager.getPlayerActiveRoom(participants[0].avatarId)).toBeUndefined();
  });
});

// ─── Reef Race — pre-launch capture + verdict resolution ─────────────────
//
// Phase 1.1 (audit I1 + I2 fix). These tests exercise the actual
// `activityRoomManager.recordPreLaunchInput` + `computeLaunchVerdicts`
// methods (T21 in reef-race-sim.test.ts only mirrors the math because
// importing the room manager pulls @clawville/database — already mocked
// above in this file, so we get the real path here).

const { synthesizeBotLaunchVerdict } = await import('../activity-room-manager');
const { LAUNCH_WINDOW_MS, LAUNCH_STALL_WINDOW_MS } = await import(
  '../sim/reef-race-config'
);

function makeMixedParticipants(
  spec: Array<'human' | 'bot'>,
): Array<{
  avatarId: string;
  userId: string | null;
  agentId: null;
  subjectType: 'human' | 'bot';
  partyId: null;
}> {
  return spec.map((kind, i) => ({
    avatarId: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
    userId: kind === 'human' ? `user-${i}` : null,
    agentId: null,
    subjectType: kind,
    partyId: null,
  }));
}

describe('Reef Race — pre-launch capture (T-LAUNCH-CAPTURE)', () => {
  const REEF_ACTIVITY_CONFIG = { minPlayers: 2, maxPlayers: 8, preferredPlayers: 4 };

  it('records a thrust=1.0 input when the room is in COUNTDOWN', async () => {
    const ps = makeMixedParticipants(['human', 'human']);
    const room = await activityRoomManager.createRoom(
      'reef-race',
      ps,
      REEF_ACTIVITY_CONFIG,
    );
    expect(room.state).toBe('countdown');
    activityRoomManager.recordPreLaunchInput(room.id, ps[0].avatarId, 12345, 1.0);
    expect(room.preLaunchBuffer?.get(ps[0].avatarId)).toEqual({
      timestamp: 12345,
      thrust: 1.0,
    });
  });

  it('ignores thrust < 1.0 (no buffer entry)', async () => {
    const ps = makeMixedParticipants(['human']);
    const room = await activityRoomManager.createRoom(
      'reef-race',
      ps,
      REEF_ACTIVITY_CONFIG,
    );
    activityRoomManager.recordPreLaunchInput(room.id, ps[0].avatarId, 12345, 0.99);
    expect(room.preLaunchBuffer).toBeNull();
  });

  it('ignores presses outside COUNTDOWN', async () => {
    const ps = makeMixedParticipants(['human']);
    const room = await activityRoomManager.createRoom(
      'reef-race',
      ps,
      REEF_ACTIVITY_CONFIG,
    );
    await activityRoomManager.transitionRoom(room.id, 'live');
    activityRoomManager.recordPreLaunchInput(room.id, ps[0].avatarId, 12345, 1.0);
    expect(room.preLaunchBuffer).toBeFalsy();
  });

  it('overwrites prior input — only the LAST qualifying press counts', async () => {
    const ps = makeMixedParticipants(['human']);
    const room = await activityRoomManager.createRoom(
      'reef-race',
      ps,
      REEF_ACTIVITY_CONFIG,
    );
    activityRoomManager.recordPreLaunchInput(room.id, ps[0].avatarId, 100, 1.0);
    activityRoomManager.recordPreLaunchInput(room.id, ps[0].avatarId, 200, 1.0);
    expect(room.preLaunchBuffer?.get(ps[0].avatarId)?.timestamp).toBe(200);
  });
});

describe('Reef Race — computeLaunchVerdicts (T-LAUNCH-VERDICT)', () => {
  const REEF_ACTIVITY_CONFIG = { minPlayers: 2, maxPlayers: 8, preferredPlayers: 4 };

  it('empty buffer + humans-only → empty verdict map', async () => {
    const ps = makeMixedParticipants(['human', 'human']);
    const room = await activityRoomManager.createRoom(
      'reef-race',
      ps,
      REEF_ACTIVITY_CONFIG,
    );
    room.startedAt = 100_000; // simulate persistLiveTransition having run
    const verdicts = activityRoomManager.computeLaunchVerdicts(room);
    expect(verdicts.size).toBe(0);
    expect(room.preLaunchBuffer).toBeNull();
  });

  it('startedAt missing → empty verdict + buffer cleared', async () => {
    const ps = makeMixedParticipants(['human']);
    const room = await activityRoomManager.createRoom(
      'reef-race',
      ps,
      REEF_ACTIVITY_CONFIG,
    );
    activityRoomManager.recordPreLaunchInput(room.id, ps[0].avatarId, 12345, 1.0);
    expect(room.preLaunchBuffer?.size).toBe(1);
    // Defensive: startedAt is null here — should yield empty + clear buffer.
    const verdicts = activityRoomManager.computeLaunchVerdicts(room);
    expect(verdicts.size).toBe(0);
    expect(room.preLaunchBuffer).toBeNull();
  });

  it('thrust pressed at green ±150ms → boost (inside window)', async () => {
    const ps = makeMixedParticipants(['human']);
    const room = await activityRoomManager.createRoom(
      'reef-race',
      ps,
      REEF_ACTIVITY_CONFIG,
    );
    room.startedAt = 100_000;
    // Push timestamps directly to bypass the COUNTDOWN gate after we
    // forced startedAt above.
    room.preLaunchBuffer = new Map([
      ['p-on-green', { timestamp: 100_000, thrust: 1.0 }],
      ['p-late-edge', { timestamp: 100_000 + LAUNCH_WINDOW_MS, thrust: 1.0 }],
      ['p-early-edge', { timestamp: 100_000 - LAUNCH_WINDOW_MS, thrust: 1.0 }],
    ]);
    const verdicts = activityRoomManager.computeLaunchVerdicts(room);
    expect(verdicts.get('p-on-green')).toBe('boost');
    expect(verdicts.get('p-late-edge')).toBe('boost');
    expect(verdicts.get('p-early-edge')).toBe('boost');
  });

  it('thrust pressed >150ms but ≤350ms early → stall', async () => {
    const ps = makeMixedParticipants(['human']);
    const room = await activityRoomManager.createRoom(
      'reef-race',
      ps,
      REEF_ACTIVITY_CONFIG,
    );
    room.startedAt = 100_000;
    room.preLaunchBuffer = new Map([
      ['p-just-stall', { timestamp: 100_000 - (LAUNCH_WINDOW_MS + 1), thrust: 1.0 }],
      [
        'p-stall-edge',
        {
          timestamp: 100_000 - (LAUNCH_WINDOW_MS + LAUNCH_STALL_WINDOW_MS),
          thrust: 1.0,
        },
      ],
    ]);
    const verdicts = activityRoomManager.computeLaunchVerdicts(room);
    expect(verdicts.get('p-just-stall')).toBe('stall');
    expect(verdicts.get('p-stall-edge')).toBe('stall');
  });

  it('thrust pressed >350ms early → no verdict (whiff, not stall)', async () => {
    const ps = makeMixedParticipants(['human']);
    const room = await activityRoomManager.createRoom(
      'reef-race',
      ps,
      REEF_ACTIVITY_CONFIG,
    );
    room.startedAt = 100_000;
    room.preLaunchBuffer = new Map([
      [
        'p-too-early',
        {
          timestamp: 100_000 - (LAUNCH_WINDOW_MS + LAUNCH_STALL_WINDOW_MS + 1),
          thrust: 1.0,
        },
      ],
    ]);
    const verdicts = activityRoomManager.computeLaunchVerdicts(room);
    expect(verdicts.has('p-too-early')).toBe(false);
  });

  it('thrust pressed >150ms LATE → no verdict (whiff)', async () => {
    const ps = makeMixedParticipants(['human']);
    const room = await activityRoomManager.createRoom(
      'reef-race',
      ps,
      REEF_ACTIVITY_CONFIG,
    );
    room.startedAt = 100_000;
    room.preLaunchBuffer = new Map([
      ['p-late', { timestamp: 100_000 + LAUNCH_WINDOW_MS + 1, thrust: 1.0 }],
    ]);
    const verdicts = activityRoomManager.computeLaunchVerdicts(room);
    expect(verdicts.has('p-late')).toBe(false);
  });

  it('clears the buffer even when verdicts is empty', async () => {
    const ps = makeMixedParticipants(['human']);
    const room = await activityRoomManager.createRoom(
      'reef-race',
      ps,
      REEF_ACTIVITY_CONFIG,
    );
    room.startedAt = 100_000;
    // All entries fall outside both windows → no verdicts but buffer must clear.
    room.preLaunchBuffer = new Map([
      ['p1', { timestamp: 100_000 + 10_000, thrust: 1.0 }],
    ]);
    activityRoomManager.computeLaunchVerdicts(room);
    expect(room.preLaunchBuffer).toBeNull();
  });

  // ── Bot launch verdict synthesis (audit I1 fix) ────────────────────────

  it('bots NOT in buffer get a synthesized verdict (audit I1)', async () => {
    const ps = makeMixedParticipants(['human', 'bot', 'bot']);
    const room = await activityRoomManager.createRoom(
      'reef-race',
      ps,
      REEF_ACTIVITY_CONFIG,
    );
    room.startedAt = 100_000;
    // Human at +50ms (boost zone). Bots NEVER write to preLaunchBuffer
    // in production — verify they still get a verdict.
    room.preLaunchBuffer = new Map([
      [ps[0].avatarId, { timestamp: 100_050, thrust: 1.0 }],
    ]);
    const verdicts = activityRoomManager.computeLaunchVerdicts(room);
    expect(verdicts.get(ps[0].avatarId)).toBe('boost');
    expect(verdicts.has(ps[1].avatarId)).toBe(true); // bot 1 has a verdict
    expect(verdicts.has(ps[2].avatarId)).toBe(true); // bot 2 has a verdict
    const bot1 = verdicts.get(ps[1].avatarId);
    const bot2 = verdicts.get(ps[2].avatarId);
    expect(bot1 === 'boost' || bot1 === 'stall').toBe(true);
    expect(bot2 === 'boost' || bot2 === 'stall').toBe(true);
  });

  it('bot synthesis is deterministic for same (roomId, avatarId)', () => {
    expect(synthesizeBotLaunchVerdict('room-X', 'avatar-A')).toBe(
      synthesizeBotLaunchVerdict('room-X', 'avatar-A'),
    );
    expect(synthesizeBotLaunchVerdict('room-Y', 'avatar-A')).toBe(
      synthesizeBotLaunchVerdict('room-Y', 'avatar-A'),
    );
  });

  it('bot synthesis distribution is roughly 50/50 over 10000 rolls', () => {
    let boost = 0;
    let stall = 0;
    const N = 10_000;
    for (let i = 0; i < N; i++) {
      // Vary BOTH roomId and avatarId so the keyspace is realistic — tests
      // the hash, not just the mod.
      const verdict = synthesizeBotLaunchVerdict(
        `room-${i % 137}`,
        `avatar-${i}-${(i * 31) & 0xffff}`,
      );
      if (verdict === 'boost') boost++;
      else stall++;
    }
    // Allow a generous ±2% slop — pure 50/50 over 10k samples has a
    // standard deviation of ~50, so ±200 is ~4σ.
    expect(boost + stall).toBe(N);
    const ratio = boost / N;
    expect(ratio).toBeGreaterThan(0.45);
    expect(ratio).toBeLessThan(0.55);
  });

  it('mixed bot+human room — both subject types get verdicts', async () => {
    const ps = makeMixedParticipants(['human', 'human', 'bot', 'bot']);
    const room = await activityRoomManager.createRoom(
      'reef-race',
      ps,
      REEF_ACTIVITY_CONFIG,
    );
    room.startedAt = 200_000;
    room.preLaunchBuffer = new Map([
      [ps[0].avatarId, { timestamp: 200_000, thrust: 1.0 }], // human boost
      [
        ps[1].avatarId,
        { timestamp: 200_000 - (LAUNCH_WINDOW_MS + 50), thrust: 1.0 },
      ], // human stall
    ]);
    const verdicts = activityRoomManager.computeLaunchVerdicts(room);
    expect(verdicts.get(ps[0].avatarId)).toBe('boost');
    expect(verdicts.get(ps[1].avatarId)).toBe('stall');
    expect(verdicts.has(ps[2].avatarId)).toBe(true);
    expect(verdicts.has(ps[3].avatarId)).toBe(true);
    expect(verdicts.size).toBe(4);
  });

  it('humans without a buffer entry stay un-verdicted (no synthesis)', async () => {
    // The synthesis path is BOT-ONLY. A human who never pressed thrust
    // during COUNTDOWN must remain without a verdict — the launch
    // mechanic is opt-in for humans.
    const ps = makeMixedParticipants(['human', 'human']);
    const room = await activityRoomManager.createRoom(
      'reef-race',
      ps,
      REEF_ACTIVITY_CONFIG,
    );
    room.startedAt = 100_000;
    // Only ps[0] presses, ps[1] stays silent.
    room.preLaunchBuffer = new Map([
      [ps[0].avatarId, { timestamp: 100_000, thrust: 1.0 }],
    ]);
    const verdicts = activityRoomManager.computeLaunchVerdicts(room);
    expect(verdicts.size).toBe(1);
    expect(verdicts.has(ps[0].avatarId)).toBe(true);
    expect(verdicts.has(ps[1].avatarId)).toBe(false);
  });
});

// ─── DB mock factory ──────────────────────────────────────────────────────

/**
 * Minimal Drizzle-shaped mock — enough surface for the room manager + tests
 * to exercise without a real Postgres pool.
 *
 * The mock returns a thenable for every call chain so `await db.insert(t)
 * .values(v)` and `await db.update(t).set(v).where(w)` both resolve.
 */
function makeDbMock() {
  const calls: { op: string; args: unknown[] }[] = [];
  let nextInsertDelayMs = 0;

  function thenable<T>(value: T = undefined as T, delayMs = 0) {
    return {
      then(resolve: (v: T) => unknown) {
        if (delayMs > 0) {
          return new Promise<T>((done) => {
            setTimeout(() => done(value), delayMs);
          }).then(resolve);
        }
        return Promise.resolve(value).then(resolve);
      },
      values() {
        return thenable(value, delayMs);
      },
      set() {
        return thenable(value);
      },
      where() {
        return thenable(value);
      },
      from() {
        return thenable(value);
      },
      catch(handler: (err: unknown) => unknown) {
        // For .catch(...) chains used by persistAbortedTransition's no-op path
        return Promise.resolve(value).catch(handler);
      },
    } as unknown as Promise<T> & {
      values: (...a: unknown[]) => unknown;
      set: (...a: unknown[]) => unknown;
      where: (...a: unknown[]) => unknown;
      from: (...a: unknown[]) => unknown;
      catch: (h: (e: unknown) => unknown) => Promise<T>;
    };
  }

  return {
    insert(_table: unknown) {
      calls.push({ op: 'insert', args: [_table] });
      const delayMs = nextInsertDelayMs;
      nextInsertDelayMs = 0;
      return thenable<unknown>(undefined, delayMs);
    },
    update(_table: unknown) {
      calls.push({ op: 'update', args: [_table] });
      return thenable<unknown>(undefined);
    },
    select(_cols?: unknown) {
      calls.push({ op: 'select', args: [_cols] });
      // Return [] for any select — matches recoverOrphanedRooms expectation
      return thenable<unknown[]>([]);
    },
    query: {
      openclawBots: { findFirst: () => Promise.resolve(null) },
      avatars: { findFirst: () => Promise.resolve(null) },
    },
    reset() {
      calls.length = 0;
      nextInsertDelayMs = 0;
    },
    delayNextInsert(delayMs: number) {
      nextInsertDelayMs = delayMs;
    },
    get calls() {
      return calls;
    },
  };
}

// Reference these exports so unused-import lint doesn't trip
void MAX_ROOMS_TOTAL;
