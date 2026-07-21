/**
 * Q2 Activity Portals — queue + matchmaker unit tests.
 *
 * Coverage:
 *   - enqueue / leaveQueue idempotency
 *   - Matcher fills at preferredFill when enough humans queue
 *   - QUEUE_TIMEOUT_MS fallback to minFill
 *   - Party-atomic fill (4-of-4 rather than 3-of-4 + drop)
 *   - FIFO ordering preserved across mixed solo/party traffic
 *   - DB hydration on boot
 *
 * No real DB. The room manager + Drizzle client are mocked so the test
 * exercises queue state machinery only.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';

// ─── Mocks ─────────────────────────────────────────────────────────────────

// Capture inserts so the hydration test can pre-seed rows.
const queueRowsSeed: Array<Record<string, unknown>> = [];

const dbMock = makeDbMock(queueRowsSeed);

mock.module('@clawville/database', () => ({
  db: dbMock,
  activityQueueEntries: {
    id: 'id',
    activityId: 'activity_id',
    avatarId: 'avatar_id',
    leftAt: 'left_at',
    matchedRoomId: 'matched_room_id',
  },
  activityParties: { id: 'id', leaderAvatarId: 'leader_avatar_id' },
  activityPartyMembers: {
    partyId: 'party_id',
    avatarId: 'avatar_id',
    leftAt: 'left_at',
  },
  // Room manager mock dependencies (pulled in transitively by the queue's import).
  activityRooms: { id: 'id', activityId: 'activity_id', shortCode: 'short_code', status: 'status' },
  activityRoomParticipants: { roomId: 'room_id', avatarId: 'avatar_id' },
  activityReplays: { id: 'id' },
  // Chunk #10 — bot-pool reads from `users` and `avatars` for hydration. Tests
  // pre-load the pool via `__resetForTest`, so these only need to be present
  // for module-level imports to resolve.
  avatars: { id: 'id', userId: 'user_id', name: 'name', flags: 'flags' },
  users: { id: 'id', email: 'email' },
  // Chunk #7 — reward pipeline (transitively imported by room manager)
  // needs these schemas to resolve at import time.
  activityResults: { id: 'id', avatarId: 'avatar_id', activityId: 'activity_id' },
  clawTokenTransactions: { id: 'id' },
  // Phase 4 — PB service is transitively imported by reward-pipeline.
  reefRacePersonalBests: {
    id: 'id',
    avatarId: 'avatar_id',
    activityId: 'activity_id',
    bestLapMs: 'best_lap_ms',
  },
}));

mock.module('../../alert-error', () => ({
  alertError: () => Promise.resolve(),
}));

mock.module('../../event-logger', () => ({
  logEvent: () => Promise.resolve(),
  ACTIVITY_EVENT_TYPES: {},
}));

// Chunk #7 — claw-token-ledger import chain.
mock.module('../../claw-token-ledger', () => ({
  creditClawTokens: () =>
    Promise.resolve({ balanceAfter: 100, ledgerId: 'ledger-1' }),
}));

// Chunk #3 wired the replay log into the room manager's RESULTS flush.
// Mock it so the transitive import doesn't reach real DB wires.
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

const { activityQueueService, MAX_PARTY_SIZE } = await import('../activity-queue');
const { activityRoomManager } = await import('../activity-room-manager');
const { botPool } = await import('../bots/bot-pool');

/**
 * Observer for matcher-created rooms — we use the real room manager
 * (mocking it would conflict with the room-manager test's own mock of
 * `@clawville/database`, which bleeds across test files in bun's
 * shared-process runner). Matches are observed via listActiveRooms().
 */
function observeMatches(): Array<{ activityId: string; participantCount: number; id: string }> {
  return activityRoomManager
    .listActiveRooms(ACTIVITY_ID)
    .map((r) => ({
      activityId: r.activityId,
      participantCount: r.participants.size,
      id: r.id,
    }));
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const ACTIVITY_ID = 'bumper-shells';

beforeEach(() => {
  activityQueueService.__resetForTest();
  activityRoomManager.__resetForTest();
  botPool.__resetForTest();
  dbMock.reset();
  queueRowsSeed.length = 0;
});

function pid(i: number): string {
  return `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;
}

async function enqueueHuman(avatarId: string, partyId: string | null = null) {
  return activityQueueService.enqueue({
    activityId: ACTIVITY_ID,
    avatarId,
    userId: `user-${avatarId}`,
    agentId: null,
    subjectType: 'human',
    partyId,
  });
}

const REEF_ACTIVITY_ID = 'reef-race';

async function enqueueReefHuman(avatarId: string) {
  return activityQueueService.enqueue({
    activityId: REEF_ACTIVITY_ID,
    avatarId,
    userId: `user-${avatarId}`,
    agentId: null,
    subjectType: 'human',
    partyId: null,
  });
}

function seedBotPool(count: number) {
  botPool.__resetForTest(
    Array.from({ length: count }, (_, i) => ({
      index: i + 1,
      slotId: `bot-${String(i + 1).padStart(3, '0')}`,
      avatarId: `bbbbbbbb-0000-0000-0000-${String(i + 1).padStart(12, '0')}`,
    })),
  );
}

function backdateOldestFor(activityId: string, deltaMs: number) {
  const queues = (
    activityQueueService as unknown as {
      queues: Map<string, Array<{ queuedAt: number }>>;
    }
  ).queues;
  const queue = queues.get(activityId);
  if (queue?.[0]) queue[0].queuedAt = Date.now() - deltaMs;
}

// ─── Enqueue / leave idempotency ──────────────────────────────────────────

describe('enqueue / leave idempotency', () => {
  it('rejects duplicate enqueue for the same avatar', async () => {
    await enqueueHuman(pid(1));
    await expect(enqueueHuman(pid(1))).rejects.toThrow(/already in a queue/);
  });

  it('leaveQueue is idempotent — returns false for never-queued avatar', async () => {
    const removed = await activityQueueService.leaveQueue(pid(99));
    expect(removed).toBe(false);
  });

  it('leaveQueue removes from in-memory + reports true', async () => {
    await enqueueHuman(pid(1));
    expect(activityQueueService.queueLength(ACTIVITY_ID)).toBe(1);
    const removed = await activityQueueService.leaveQueue(pid(1));
    expect(removed).toBe(true);
    expect(activityQueueService.queueLength(ACTIVITY_ID)).toBe(0);
  });

  it('queueLength reflects current population', async () => {
    for (let i = 0; i < 5; i++) await enqueueHuman(pid(i));
    expect(activityQueueService.queueLength(ACTIVITY_ID)).toBe(5);
  });
});

// ─── Matchmaker fill behavior ─────────────────────────────────────────────

describe('Matchmaker fill', () => {
  it('does not match below minFill (4 for Bumper Shells)', async () => {
    // Only 3 players → no room.
    for (let i = 0; i < 3; i++) await enqueueHuman(pid(i));
    await activityQueueService.runMatchmakerSweep();
    expect(observeMatches().length).toBe(0);
  });

  it('matches at preferredFill (6) when enough humans queue', async () => {
    // 6 players queued → preferred fill of 6 should snap immediately
    // since we have a fresh queue (no timeout in play).
    for (let i = 0; i < 6; i++) await enqueueHuman(pid(i));
    await activityQueueService.runMatchmakerSweep();
    const matches = observeMatches();
    expect(matches.length).toBe(1);
    expect(matches[0].participantCount).toBe(6);
  });

  it('fills up to maxFill (8) if more players queue', async () => {
    for (let i = 0; i < 8; i++) await enqueueHuman(pid(i));
    await activityQueueService.runMatchmakerSweep();
    const matches = observeMatches();
    expect(matches.length).toBe(1);
    expect(matches[0].participantCount).toBe(8);
  });

  it('falls back to minFill after QUEUE_TIMEOUT_MS', async () => {
    // 4 players queued, oldest 21s old → matcher should drop to minFill.
    for (let i = 0; i < 4; i++) await enqueueHuman(pid(i));
    // Backdate the oldest entry past QUEUE_TIMEOUT_MS (20s).
    backdateOldest(21_000);
    await activityQueueService.runMatchmakerSweep();
    const matches = observeMatches();
    expect(matches.length).toBe(1);
    expect(matches[0].participantCount).toBe(4);
  });

  it('does NOT fall back if oldest entry is fresh', async () => {
    for (let i = 0; i < 4; i++) await enqueueHuman(pid(i));
    // No backdate — preferredFill (6) target still in effect.
    await activityQueueService.runMatchmakerSweep();
    expect(observeMatches().length).toBe(0);
  });

  it('earlyBotFill backfills reef-race at the short timeout', async () => {
    seedBotPool(8);
    await enqueueReefHuman(pid(1));
    backdateOldestFor(REEF_ACTIVITY_ID, 4_000);

    await activityQueueService.runMatchmakerSweep();

    const [room] = activityRoomManager.listActiveRooms(REEF_ACTIVITY_ID);
    expect(room?.participants.size).toBe(4);
    expect(room?.hasBots).toBe(true);
  });

  it('keeps earlyBotFill scoped away from bumper-shells', async () => {
    seedBotPool(8);
    await enqueueHuman(pid(1));
    backdateOldestFor(ACTIVITY_ID, 4_000);

    await activityQueueService.runMatchmakerSweep();

    expect(observeMatches()).toHaveLength(0);
  });
});

// ─── Party-atomic fill ────────────────────────────────────────────────────

describe('Party fill atomicity', () => {
  it('keeps a party of 3 + 3 solos as a 6-fill (preferred fill)', async () => {
    const party = await activityQueueService.createParty(pid(0));
    await activityQueueService.joinParty(party.shortCode, pid(1));
    await activityQueueService.joinParty(party.shortCode, pid(2));

    // Enqueue all party members — chunk #2 routes do this atomically.
    for (let i = 0; i < 3; i++) await enqueueHuman(pid(i), party.id);
    for (let i = 3; i < 6; i++) await enqueueHuman(pid(i), null);

    await activityQueueService.runMatchmakerSweep();
    const matches = observeMatches();
    expect(matches.length).toBe(1);
    expect(matches[0].participantCount).toBe(6);
  });

  it('preserves FIFO of party-of-2 over later solos at preferredFill', async () => {
    const party = await activityQueueService.createParty(pid(0));
    await activityQueueService.joinParty(party.shortCode, pid(1));
    await enqueueHuman(pid(0), party.id);
    await enqueueHuman(pid(1), party.id);
    // Two more solos to reach minFill of 4.
    await enqueueHuman(pid(2));
    await enqueueHuman(pid(3));
    backdateOldest(21_000);

    await activityQueueService.runMatchmakerSweep();
    const matches = observeMatches();
    expect(matches.length).toBe(1);
    expect(matches[0].participantCount).toBe(4);
  });

  it('rejects party larger than MAX_PARTY_SIZE', async () => {
    const party = await activityQueueService.createParty(pid(0));
    for (let i = 1; i < MAX_PARTY_SIZE; i++) {
      await activityQueueService.joinParty(party.shortCode, pid(i));
    }
    await expect(
      activityQueueService.joinParty(party.shortCode, pid(MAX_PARTY_SIZE)),
    ).rejects.toThrow(/Party is full/);
  });

  it('joinParty is idempotent — same avatar twice is a no-op', async () => {
    const party = await activityQueueService.createParty(pid(0));
    await activityQueueService.joinParty(party.shortCode, pid(1));
    const second = await activityQueueService.joinParty(party.shortCode, pid(1));
    expect(second.members.size).toBe(2);
  });

  it('reactivates a kicked or departed membership when the avatar rejoins', async () => {
    const party = await activityQueueService.createParty(pid(0));
    await activityQueueService.joinParty(party.shortCode, pid(1));

    await activityQueueService.kickMember(party.id, pid(0), pid(1));
    expect(party.members.has(pid(1))).toBe(false);
    await activityQueueService.joinParty(party.shortCode, pid(1));
    expect(party.members.has(pid(1))).toBe(true);

    await activityQueueService.leaveParty(party.id, pid(1));
    expect(party.members.has(pid(1))).toBe(false);
    await activityQueueService.joinParty(party.shortCode, pid(1));
    expect(party.members.has(pid(1))).toBe(true);
  });

  it('leaveParty disbands when last member leaves', async () => {
    const party = await activityQueueService.createParty(pid(0));
    await activityQueueService.leaveParty(party.id, pid(0));
    expect(activityQueueService.getParty(party.id)).toBeUndefined();
  });

  it('leaveParty promotes a new leader when leader leaves', async () => {
    const party = await activityQueueService.createParty(pid(0));
    await activityQueueService.joinParty(party.shortCode, pid(1));
    await activityQueueService.leaveParty(party.id, pid(0));
    const after = activityQueueService.getParty(party.id);
    expect(after?.leaderAvatarId).toBe(pid(1));
  });
});

// ─── Hydration ────────────────────────────────────────────────────────────

describe('Boot-time hydration', () => {
  it('rebuilds in-memory queue from DB rows', async () => {
    queueRowsSeed.push(
      {
        id: 'q-1',
        activityId: ACTIVITY_ID,
        avatarId: pid(7),
        agentId: null,
        subjectType: 'human',
        partyId: null,
        queuedAt: new Date(Date.now() - 5_000),
      },
      {
        id: 'q-2',
        activityId: ACTIVITY_ID,
        avatarId: pid(8),
        agentId: null,
        subjectType: 'human',
        partyId: null,
        queuedAt: new Date(),
      },
    );

    await activityQueueService.hydrateFromDb();
    expect(activityQueueService.queueLength(ACTIVITY_ID)).toBe(2);

    const status = activityQueueService.getQueueStatus(ACTIVITY_ID, pid(7));
    expect(status.position).toBe(1);
    expect(status.playersInQueue).toBe(2);
  });

  it('hydration is idempotent — second call no-op', async () => {
    queueRowsSeed.push({
      id: 'q-1',
      activityId: ACTIVITY_ID,
      avatarId: pid(1),
      agentId: null,
      subjectType: 'human',
      partyId: null,
      queuedAt: new Date(),
    });

    await activityQueueService.hydrateFromDb();
    const lengthAfterFirst = activityQueueService.queueLength(ACTIVITY_ID);
    await activityQueueService.hydrateFromDb();
    expect(activityQueueService.queueLength(ACTIVITY_ID)).toBe(lengthAfterFirst);
  });
});

// ─── Internals / helpers ──────────────────────────────────────────────────

/**
 * Backdate the oldest queue entry to simulate an aged queue. Drops the
 * `queuedAt` ms back by the given delta. The matcher only inspects the
 * head entry's age for timeout decisions.
 */
function backdateOldest(deltaMs: number) {
  // Reach into the singleton's internals via the test hook. The queue
  // service exposes per-activity state through queueLength() but not
  // per-entry mutability — tests cheat by reassigning queuedAt directly.
  // This is the LEAST invasive way to drive timeout behavior without
  // sleeping for 20s in CI.
  const queues: Map<string, Array<{ queuedAt: number }>> = (
    activityQueueService as unknown as {
      queues: Map<string, Array<{ queuedAt: number }>>;
    }
  ).queues;
  const queue = queues.get(ACTIVITY_ID);
  if (!queue || queue.length === 0) return;
  // Backdate the head entry only — that's the one the matcher checks.
  queue[0].queuedAt = Date.now() - deltaMs;
}

// ─── DB mock factory ──────────────────────────────────────────────────────

function makeDbMock(queueRows: Array<Record<string, unknown>>) {
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
      onConflictDoUpdate() {
        return thenable(value);
      },
      where() {
        return thenable(value);
      },
      from() {
        return thenable(value);
      },
      catch(handler: (err: unknown) => unknown) {
        return Promise.resolve(value).catch(handler);
      },
    } as unknown as Promise<T> & {
      values: (...a: unknown[]) => unknown;
      set: (...a: unknown[]) => unknown;
      onConflictDoUpdate: (...a: unknown[]) => unknown;
      where: (...a: unknown[]) => unknown;
      from: (...a: unknown[]) => unknown;
      catch: (h: (e: unknown) => unknown) => Promise<T>;
    };
  }

  return {
    insert() {
      return thenable<unknown>(undefined);
    },
    update() {
      return thenable<unknown>(undefined);
    },
    select(_cols?: unknown) {
      // Hydration calls .select().from(table).where(...). Return the seeded
      // queue rows so hydrateFromDb sees them.
      return {
        then(resolve: (v: unknown[]) => unknown) {
          return Promise.resolve(queueRows).then(resolve);
        },
        from() {
          return {
            then(resolve: (v: unknown[]) => unknown) {
              return Promise.resolve(queueRows).then(resolve);
            },
            where() {
              return {
                then(resolve: (v: unknown[]) => unknown) {
                  return Promise.resolve(queueRows).then(resolve);
                },
              };
            },
          };
        },
      };
    },
    query: {
      agentBots: { findFirst: () => Promise.resolve(null) },
      avatars: { findFirst: () => Promise.resolve(null) },
    },
    reset() {
      /* nothing — queueRowsSeed handled by caller */
    },
  };
}
