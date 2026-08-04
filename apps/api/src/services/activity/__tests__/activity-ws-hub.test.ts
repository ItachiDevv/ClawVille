/**
 * Q2 Activity Portals — WS hub unit tests (chunk #3).
 *
 * Coverage:
 *   - auth handshake success (valid Lucia-shaped sessionToken)
 *   - auth handshake failures (bad frame, no session, shortCode mismatch, not a participant)
 *   - broadcast fan-out across all connected WS
 *   - slow-client backpressure (getBufferedAmount > threshold)
 *   - unregister cleans up the room map
 *
 * The hub is transport-agnostic — tests use a fake `HubWsTransport`
 * rather than a real Bun ServerWebSocket. Auth resolution is mocked so
 * no Lucia / DB calls happen.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';

// Mock identity resolution BEFORE importing the SUT so the imports
// resolve against the mock.
mock.module('../../../middleware/require-auth-or-agent', () => ({
  resolveActivityIdentity: async (input: { sessionToken: string }) => {
    if (input.sessionToken === 'valid-user') {
      return { kind: 'user', userId: 'user-1', avatarId: 'avatar-1', agentId: null };
    }
    if (input.sessionToken === 'valid-user-2') {
      return { kind: 'user', userId: 'user-2', avatarId: 'avatar-2', agentId: null };
    }
    if (input.sessionToken === 'valid-agent') {
      return {
        kind: 'agent',
        userId: 'user-1',
        avatarId: 'avatar-1',
        agentId: 'agent-xyz',
        sessionId: 'valid-agent',
      };
    }
    return null;
  },
}));

// Silence side-effect imports from the hub / manager chain.
mock.module('../../event-logger', () => ({
  logEvent: () => Promise.resolve(),
  ACTIVITY_EVENT_TYPES: {},
}));
mock.module('../../alert-error', () => ({
  alertError: () => Promise.resolve(),
}));
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
mock.module('@clawville/database', () => ({
  db: {
    insert: () => ({
      values: () => Promise.resolve(undefined),
      returning: () => Promise.resolve([{ id: 'replay-1' }]),
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    query: {},
  },
  activityRooms: {},
  activityRoomParticipants: {},
  activityQueueEntries: {},
  activityParties: {},
  activityPartyMembers: {},
  activityReplays: { id: 'id' },
  // Chunk #7 — reward pipeline (transitively imported by room manager)
  // needs these schemas + ledger table to resolve.
  activityResults: { id: 'id', avatarId: 'avatar_id', activityId: 'activity_id' },
  avatars: { id: 'id', flags: 'flags' },
  users: { id: 'id', isGuest: 'is_guest' },
  clawTokenTransactions: { id: 'id' },
  // Phase 4 — PB service (transitively imported by ws-hub for the
  // snapshot.init ghost frames load path) references this table.
  reefRacePersonalBests: {
    id: 'id',
    avatarId: 'avatar_id',
    activityId: 'activity_id',
    bestLapMs: 'best_lap_ms',
    ghostReplayData: 'ghost_replay_data',
  },
  reefRacePersonalBestClaims: {},
}));

// Chunk #7 — claw-token-ledger import chain.
mock.module('../../claw-token-ledger', () => ({
  creditClawTokens: () =>
    Promise.resolve({ balanceAfter: 100, ledgerId: 'ledger-1' }),
}));

const { activityWsHub } = await import('../activity-ws-hub');
const { activityRoomManager } = await import('../activity-room-manager');
const { ACTIVITY_WS_CLOSE_CODES } = await import('@clawville/shared');

const ACTIVITY_CONFIG = { minPlayers: 4, maxPlayers: 8, preferredPlayers: 6 };

// ─── Fake transport ─────────────────────────────────────────────────────────

interface CapturedClose {
  code: number;
  reason: string;
}

function makeFakeWs(roomId: string): {
  ws: ReturnType<typeof activityWsHub.makeConnectionData> extends infer _ ? any : never;
  sent: string[];
  closes: CapturedClose[];
  setBuffered(n: number): void;
} {
  const sent: string[] = [];
  const closes: CapturedClose[] = [];
  let buffered = 0;
  const ws = {
    send: (frame: string) => sent.push(frame),
    close: (code: number, reason: string) => {
      closes.push({ code, reason });
    },
    getBufferedAmount: () => buffered,
    data: activityWsHub.makeConnectionData(roomId),
  };
  return {
    ws,
    sent,
    closes,
    setBuffered(n: number) {
      buffered = n;
    },
  };
}

function readFrame(raw: string): { type: string; [k: string]: unknown } {
  return JSON.parse(raw);
}

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  activityWsHub.__resetForTest();
  activityRoomManager.__resetForTest();
});

async function roomWithAvatars(avatarIds: string[]) {
  return activityRoomManager.createRoom(
    'bumper-shells',
    avatarIds.map((p) => ({
      avatarId: p,
      userId: 'user-x',
      agentId: null,
      subjectType: 'human' as const,
      partyId: null,
    })),
    ACTIVITY_CONFIG,
  );
}

async function reefRoomWithAvatars(avatarIds: string[]) {
  return activityRoomManager.createRoom(
    'reef-race',
    avatarIds.map((p) => ({
      avatarId: p,
      userId: 'user-x',
      agentId: null,
      subjectType: 'human' as const,
      partyId: null,
    })),
    ACTIVITY_CONFIG,
  );
}

// ─── Auth handshake ─────────────────────────────────────────────────────────

describe('WS auth handshake', () => {
  it('accepts a valid auth frame and sends snapshot.init', async () => {
    const room = await roomWithAvatars(['avatar-1', 'avatar-2', 'avatar-3', 'avatar-4']);
    const fake = makeFakeWs(room.id);
    await activityWsHub.handleMessage(
      fake.ws,
      JSON.stringify({
        type: 'auth',
        sessionToken: 'valid-user',
        shortCode: room.shortCode,
      }),
    );
    expect(fake.closes).toHaveLength(0);
    const init = fake.sent.map(readFrame).find((f) => f.type === 'snapshot.init');
    expect(init).toBeDefined();
  });

  it('sends Reef countdown roster placeholders in participant insertion order', async () => {
    const participantOrder = ['avatar-3', 'avatar-1', 'avatar-4', 'avatar-2'];
    const room = await reefRoomWithAvatars(participantOrder);
    const fake = makeFakeWs(room.id);

    await activityWsHub.handleMessage(
      fake.ws,
      JSON.stringify({
        type: 'auth',
        sessionToken: 'valid-user',
        shortCode: room.shortCode,
      }),
    );

    const init = fake.sent
      .map(readFrame)
      .find((frame) => frame.type === 'snapshot.init') as
      | { world: { entities: unknown[] } }
      | undefined;
    expect(init?.world.entities).toEqual(
      participantOrder.map((avatarId) => ({
        avatarId,
        position: { x: 0, y: 0 },
        velocity: { x: 0, y: 0 },
        rotation: 0,
        state: 'racing',
      })),
    );
  });

  it('closes 4001 on unknown sessionToken', async () => {
    const room = await roomWithAvatars(['avatar-1', 'avatar-2', 'avatar-3', 'avatar-4']);
    const fake = makeFakeWs(room.id);
    await activityWsHub.handleMessage(
      fake.ws,
      JSON.stringify({
        type: 'auth',
        sessionToken: 'nope',
        shortCode: room.shortCode,
      }),
    );
    expect(fake.closes[0]?.code).toBe(ACTIVITY_WS_CLOSE_CODES.UNAUTHORIZED);
  });

  it('closes 4001 on shortCode mismatch', async () => {
    const room = await roomWithAvatars(['avatar-1', 'avatar-2', 'avatar-3', 'avatar-4']);
    const fake = makeFakeWs(room.id);
    await activityWsHub.handleMessage(
      fake.ws,
      JSON.stringify({
        type: 'auth',
        sessionToken: 'valid-user',
        shortCode: 'WRONGZ',
      }),
    );
    expect(fake.closes[0]?.code).toBe(ACTIVITY_WS_CLOSE_CODES.UNAUTHORIZED);
  });

  it('closes 4001 when avatar not in room', async () => {
    const room = await roomWithAvatars(['avatar-1', 'avatar-3', 'avatar-4', 'avatar-5']); // avatar-2 absent
    const fake = makeFakeWs(room.id);
    await activityWsHub.handleMessage(
      fake.ws,
      JSON.stringify({
        type: 'auth',
        sessionToken: 'valid-user-2', // resolves to avatar-2
        shortCode: room.shortCode,
      }),
    );
    expect(fake.closes[0]?.code).toBe(ACTIVITY_WS_CLOSE_CODES.UNAUTHORIZED);
  });

  it('closes 4001 when first frame is not auth', async () => {
    const room = await roomWithAvatars(['avatar-1', 'avatar-2', 'avatar-3', 'avatar-4']);
    const fake = makeFakeWs(room.id);
    await activityWsHub.handleMessage(
      fake.ws,
      JSON.stringify({ type: 'ping', sentAt: 0 }),
    );
    expect(fake.closes[0]?.code).toBe(ACTIVITY_WS_CLOSE_CODES.UNAUTHORIZED);
  });

  it('rejects unknown frame types without closing the socket', async () => {
    const room = await roomWithAvatars(['avatar-1', 'avatar-2', 'avatar-3', 'avatar-4']);
    const fake = makeFakeWs(room.id);
    await activityWsHub.handleMessage(
      fake.ws,
      JSON.stringify({ type: 'not-a-real-type' }),
    );
    expect(fake.closes).toHaveLength(0);
    const err = fake.sent.map(readFrame).find((f) => f.type === 'error');
    expect(err).toBeDefined();
  });
});

// ─── Broadcast fan-out ──────────────────────────────────────────────────────

describe('broadcastEvent fan-out', () => {
  it('delivers to every authed participant', async () => {
    const room = await roomWithAvatars(['avatar-1', 'avatar-2', 'avatar-3', 'avatar-4']);
    const a = makeFakeWs(room.id);
    const b = makeFakeWs(room.id);
    await activityWsHub.handleMessage(
      a.ws,
      JSON.stringify({ type: 'auth', sessionToken: 'valid-user', shortCode: room.shortCode }),
    );
    await activityWsHub.handleMessage(
      b.ws,
      JSON.stringify({ type: 'auth', sessionToken: 'valid-user-2', shortCode: room.shortCode }),
    );

    activityWsHub.broadcastEvent(room.id, {
      type: 'event.countdown',
      secondsRemaining: 3,
    });

    const aCountdown = a.sent.map(readFrame).filter((f) => f.type === 'event.countdown');
    const bCountdown = b.sent.map(readFrame).filter((f) => f.type === 'event.countdown');
    expect(aCountdown.length).toBeGreaterThanOrEqual(1);
    expect(bCountdown.length).toBeGreaterThanOrEqual(1);
  });

  it('reports active connections count', async () => {
    const room = await roomWithAvatars(['avatar-1', 'avatar-2', 'avatar-3', 'avatar-4']);
    expect(activityWsHub.getActiveConnections(room.id)).toBe(0);
    const fake = makeFakeWs(room.id);
    await activityWsHub.handleMessage(
      fake.ws,
      JSON.stringify({ type: 'auth', sessionToken: 'valid-user', shortCode: room.shortCode }),
    );
    expect(activityWsHub.getActiveConnections(room.id)).toBe(1);
  });
});

// ─── Backpressure ───────────────────────────────────────────────────────────

describe('broadcastSnapshot backpressure', () => {
  it('skips snapshot delta when getBufferedAmount > threshold', async () => {
    const room = await roomWithAvatars(['avatar-1', 'avatar-2', 'avatar-3', 'avatar-4']);
    const fake = makeFakeWs(room.id);
    await activityWsHub.handleMessage(
      fake.ws,
      JSON.stringify({ type: 'auth', sessionToken: 'valid-user', shortCode: room.shortCode }),
    );
    // Snapshot init already sent — clear sent list.
    fake.sent.length = 0;
    fake.setBuffered(100_000); // over BACKPRESSURE_DROP_BYTES (50_000)

    activityWsHub.broadcastSnapshot(room.id, {
      type: 'snapshot.delta',
      baseSeq: 0,
      seq: 1,
      entities: [],
      powerUps: [],
    });

    const deltas = fake.sent.map(readFrame).filter((f) => f.type === 'snapshot.delta');
    expect(deltas).toHaveLength(0);
  });
});

// ─── Unregister ─────────────────────────────────────────────────────────────

describe('unregisterConnection cleanup', () => {
  it('removes the WS from the room map', async () => {
    const room = await roomWithAvatars(['avatar-1', 'avatar-2', 'avatar-3', 'avatar-4']);
    const fake = makeFakeWs(room.id);
    await activityWsHub.handleMessage(
      fake.ws,
      JSON.stringify({ type: 'auth', sessionToken: 'valid-user', shortCode: room.shortCode }),
    );
    expect(activityWsHub.getActiveConnections(room.id)).toBe(1);
    activityWsHub.unregisterConnection(fake.ws);
    expect(activityWsHub.getActiveConnections(room.id)).toBe(0);
  });

  it('marks the participant as disconnected', async () => {
    const room = await roomWithAvatars(['avatar-1', 'avatar-2', 'avatar-3', 'avatar-4']);
    const fake = makeFakeWs(room.id);
    await activityWsHub.handleMessage(
      fake.ws,
      JSON.stringify({ type: 'auth', sessionToken: 'valid-user', shortCode: room.shortCode }),
    );
    const p = room.participants.get('avatar-1');
    expect(p?.connected).toBe(true);
    activityWsHub.unregisterConnection(fake.ws);
    expect(p?.connected).toBe(false);
    expect(p?.disconnectedAt).not.toBeNull();
  });
});
