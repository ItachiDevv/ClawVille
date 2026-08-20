import { afterAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';

// Spy on the REAL npcSimulation singleton — never mock.module('../npc-simulation')
// here. A partial module mock poisons the process-global registry for every suite
// loaded after this file in the shared-process CI gate (they get a singleton with
// no .stop → "npcSimulation.stop is not a function" across unrelated suites).
const { npcSimulation } = await import('../npc-simulation');
const refreshControlled = spyOn(
  npcSimulation,
  'refreshHumanControlledOpenClawForUser',
).mockImplementation(() => {});

afterAll(() => {
  refreshControlled.mockRestore();
});

const {
  __resetWorldPositionThrottleForTest,
  admitWorldPositionRate,
  applyWorldPosition,
  forgetWorldPositionThrottle,
  POSITION_MIN_INTERVAL_MS,
} = await import('../world-position-apply');
const { roomRegistry } = await import('../room-registry');

beforeEach(() => {
  roomRegistry.__resetForTests();
  __resetWorldPositionThrottleForTest();
  refreshControlled.mockClear();
});

describe('world-position-apply', () => {
  it('shares a 10 Hz admission slot keyed by session', () => {
    const now = 1_700_000_000_000;
    expect(admitWorldPositionRate('s1', now)).toBe(true);
    expect(admitWorldPositionRate('s1', now + POSITION_MIN_INTERVAL_MS - 1)).toBe(
      false,
    );
    expect(admitWorldPositionRate('s1', now + POSITION_MIN_INTERVAL_MS)).toBe(
      true,
    );
  });

  it('consumes the slot on admission even when caller parsing later fails', () => {
    const now = 1_700_000_000_000;
    expect(admitWorldPositionRate('s1', now)).toBe(true);
    expect(admitWorldPositionRate('s1', now)).toBe(false);
  });

  it('returns not_in_room, then mutates the joined registry row', () => {
    const patch = { x: 11, y: 22, dirZ: 1.5, activity: 'walking' };
    const subject = { sessionId: 's1', kind: 'guest' as const, userId: null };
    expect(applyWorldPosition(subject, patch)).toBe('not_in_room');

    const { player } = roomRegistry.joinPlayer('s1', {
      userId: null,
      name: 'Visitor',
      species: 'milady_chibi',
      color: 0xcccccc,
      kind: 'guest',
    });
    expect(applyWorldPosition(subject, patch)).toBe('accepted');
    expect(player).toMatchObject(patch);
  });

  it('forgetWorldPositionThrottle clears the session entry', () => {
    const now = 1_700_000_000_000;
    expect(admitWorldPositionRate('s1', now)).toBe(true);
    expect(admitWorldPositionRate('s1', now + 1)).toBe(false);
    forgetWorldPositionThrottle('s1');
    expect(admitWorldPositionRate('s1', now + 1)).toBe(true);
  });

  it('refreshes Hatcher suppression only for a human, with no TTL argument', () => {
    for (const sessionId of ['human', 'guest', 'agent']) {
      roomRegistry.joinPlayer(sessionId, {
        userId: sessionId === 'guest' ? null : `user-${sessionId}`,
        name: sessionId,
        species: 'milady_chibi',
        color: 0xcccccc,
        kind: sessionId as 'human' | 'guest' | 'agent',
      });
    }
    const patch = { x: 1, y: 2, dirZ: 3, activity: 'idle' };
    applyWorldPosition(
      { sessionId: 'human', kind: 'human', userId: 'user-human' },
      patch,
    );
    applyWorldPosition(
      { sessionId: 'guest', kind: 'guest', userId: null },
      patch,
    );
    applyWorldPosition(
      { sessionId: 'agent', kind: 'agent', userId: 'user-agent' },
      patch,
    );
    expect(refreshControlled).toHaveBeenCalledTimes(1);
    expect(refreshControlled).toHaveBeenCalledWith('user-human');
  });
});
