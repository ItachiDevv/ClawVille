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

import { describe, expect, it, beforeEach, mock } from 'bun:test';

// ─── Mock Drizzle client BEFORE importing the SUT ─────────────────────────
//
// `db.insert(...).values(...)`, `db.update(...).set(...).where(...)`, and
// `db.select().from(...).where(...)` — every call returns a thenable so
// `await` works either way. The chains return themselves for fluency.

const dbMock = makeDbMock();

mock.module('@clawville/database', () => ({
  db: dbMock,
  activityRooms: {
    id: 'id',
    activityId: 'activity_id',
    shortCode: 'short_code',
    status: 'status',
  },
  activityRoomParticipants: {
    roomId: 'room_id',
    petId: 'pet_id',
  },
  activityQueueEntries: { id: 'id', leftAt: 'left_at' },
  activityParties: { id: 'id' },
  activityPartyMembers: { partyId: 'party_id' },
}));

mock.module('../../alert-error', () => ({
  alertError: () => Promise.resolve(),
}));

mock.module('../../event-logger', () => ({
  logEvent: () => Promise.resolve(),
  ACTIVITY_EVENT_TYPES: {},
}));

const { activityRoomManager, RoomCapacityError, MAX_ROOMS_PER_ACTIVITY, MAX_ROOMS_TOTAL } = await import(
  '../activity-room-manager'
);

// ─── Helpers ──────────────────────────────────────────────────────────────

const ACTIVITY_ID = 'bumper-shells';
const ACTIVITY_CONFIG = {
  minPlayers: 4,
  maxPlayers: 8,
  preferredPlayers: 6,
};

function makeParticipants(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    petId: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
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
          petId: `${i}-${p.petId}`,
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
          petId: `${i}-${p.petId}`,
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
  it('aborts COUNTDOWN rooms with no connected players', async () => {
    const room = await activityRoomManager.createRoom(
      ACTIVITY_ID,
      makeParticipants(4),
      ACTIVITY_CONFIG,
    );
    // None of the participants have `connected=true` — sweeper should kill.
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
    expect(activityRoomManager.getPlayerActiveRoom(participants[0].petId)?.id).toBe(
      room.id,
    );
    expect(activityRoomManager.getPlayerActiveRoom('not-a-pet')).toBeUndefined();
  });

  it('clears the lookup after eviction', async () => {
    const participants = makeParticipants(4);
    const room = await activityRoomManager.createRoom(
      ACTIVITY_ID,
      participants,
      ACTIVITY_CONFIG,
    );
    await activityRoomManager.transitionRoom(room.id, 'aborted');
    expect(activityRoomManager.getPlayerActiveRoom(participants[0].petId)).toBeUndefined();
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

  function thenable<T>(value: T = undefined as T) {
    return {
      then(resolve: (v: T) => unknown) {
        return Promise.resolve(value).then(resolve);
      },
      values() {
        return thenable(value);
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
      return thenable<unknown>(undefined);
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
      pets: { findFirst: () => Promise.resolve(null) },
    },
    reset() {
      calls.length = 0;
    },
    get calls() {
      return calls;
    },
  };
}

// Reference these exports so unused-import lint doesn't trip
void MAX_ROOMS_TOTAL;
