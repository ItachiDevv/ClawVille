import { beforeEach, describe, expect, test } from 'bun:test';
import { usePlayerStore } from '../players';

// Founder R5 (2026-09-18): leaving a Reef Race left a copy of your own avatar
// trailing you. The downlink pause must drop other bodies, never who you are.

const body = (id: string, x: number) => ({
  id, kind: 'player', userId: 'u1', name: 'me', species: 'lobster', color: 0, activity: 'idle', x, y: 0, z: 0,
});

describe('players store keeps the local identity across a downlink pause', () => {
  beforeEach(() => usePlayerStore.getState().clear());

  test('clearRemote drops bodies but keeps localSessionId and former selves', () => {
    const s = usePlayerStore.getState();
    s.setLocalSessionId('me-1');
    s.updateFromSnapshot([body('me-1', 0) as never, body('other', 5) as never]);
    expect(usePlayerStore.getState().players.find((p) => p.id === 'me-1')?.isLocal).toBe(true);

    usePlayerStore.getState().clearRemote();
    const after = usePlayerStore.getState();
    expect(after.players).toEqual([]);
    expect(after.localSessionId).toBe('me-1');
    expect(after.localSessionIds.has('me-1')).toBe(true);

    // The reopened stream's first snapshot: our own body must stay local.
    after.updateFromSnapshot([body('me-1', 3) as never]);
    expect(usePlayerStore.getState().players[0]?.isLocal).toBe(true);
  });

  test('clear() is still the full reset used when the session ends', () => {
    const s = usePlayerStore.getState();
    s.setLocalSessionId('me-1');
    s.clear();
    expect(usePlayerStore.getState().localSessionId).toBeNull();
    expect(usePlayerStore.getState().localSessionIds.size).toBe(0);
  });
});
