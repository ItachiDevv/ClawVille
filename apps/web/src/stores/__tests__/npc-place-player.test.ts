import { afterEach, describe, expect, test } from 'bun:test';
import { PLAYER_NPC_ID, useNpcStore } from '../npc';

// Regression (found 2026-09-18 on prod and locally): in NPC mode "Back to
// World" from the cove set only avatarPosition. NpcController treats the
// possessed body's x/y as the truth, so the first frame pulled the avatar back
// to where the body entered: inside the tunnel's auto-enter band.

const body = () => useNpcStore.getState().npcs.find((n) => n.id === PLAYER_NPC_ID);

afterEach(() => {
  useNpcStore.getState().removePlayerNpc();
});

describe('placePlayerNpc', () => {
  test('teleports the NPC-mode body with no interpolation', () => {
    useNpcStore.getState().spawnPlayerNpc();
    // Where the body stands after walking into the cove tunnel.
    useNpcStore.getState().moveNpc(PLAYER_NPC_ID, 7777, 11244, 'left', null, true);
    useNpcStore.getState().placePlayerNpc(8114, 11264);
    const b = body()!;
    expect([b.x, b.y]).toEqual([8114, 11264]);
    expect([b.prevX, b.prevY]).toEqual([8114, 11264]);
    expect(b.direction).toBe('idle');
    expect(b.isRunning).toBe(false);
  });

  test('is a no-op when there is no NPC-mode body (player mode)', () => {
    expect(body()).toBeUndefined();
    expect(() => useNpcStore.getState().placePlayerNpc(8114, 11264)).not.toThrow();
    expect(body()).toBeUndefined();
  });
});
