import { describe, expect, test } from 'bun:test';
import { BRAINCHAIN_EXIT, BRAINCHAIN_PLAYER_SPAWN, BRAINCHAIN_ROOM, BRAINCHAIN_STATIONS, BRAINCHAIN_SOLIDS, brainchainHitsSolid, brainchainStationAt, clampBrainchainMovement, placeBrainchainCamera, stepBrainchainExit } from './brainchain/brainchain-room';
import { CORTEX_MODEL, CORTEX_SCALE, CORTEX_MAX_HEIGHT, npcRenderedHeightLimit } from './brainchain-cortex-size';

describe('BrainChain room contracts', () => {
  test('spawn clears all solids and the exit trigger', () => {
    const p = BRAINCHAIN_PLAYER_SPAWN;
    expect(brainchainHitsSolid(p.x, p.z)).toBe(false);
    expect(Math.hypot(p.x - BRAINCHAIN_EXIT.x, p.z - BRAINCHAIN_EXIT.z)).toBeGreaterThan(BRAINCHAIN_EXIT.radius);
    expect(brainchainStationAt(p.x, p.z)).toBe(-1);
  });
  test('movement stays inside the circular room and cannot tunnel through props', () => {
    const out = { ...BRAINCHAIN_PLAYER_SPAWN };
    for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 16) {
      clampBrainchainMovement(0, 1600, Math.sin(angle) * 4000, Math.cos(angle) * 4000, out);
      expect(Math.hypot(out.x, out.z)).toBeLessThanOrEqual(BRAINCHAIN_ROOM.radius - BRAINCHAIN_ROOM.playerRadius + 1e-6);
      expect(brainchainHitsSolid(out.x, out.z)).toBe(false);
    }
    clampBrainchainMovement(0, 1600, 0, -1600, out);
    expect(out.z).toBeGreaterThanOrEqual(BRAINCHAIN_SOLIDS[0]!.halfZ + BRAINCHAIN_ROOM.playerRadius);
  });
  test('every station has the correct tab and a reachable approach', () => {
    expect(BRAINCHAIN_STATIONS.map(s => s.tab)).toEqual(['learn', 'setup', 'setup', 'setup', 'setup', 'work', 'earnings']);
    // Flood fill the actual circular envelope and solid rejection, not an independent collider copy.
    const queue: Array<{ x: number; z: number }> = [{ ...BRAINCHAIN_PLAYER_SPAWN }];
    const visited = new Set(['0,1600']); const reached = new Set<number>();
    const out = { x: 0, z: 0 };
    for (let head = 0; head < queue.length; head++) {
      const p = queue[head]!; const station = brainchainStationAt(p.x, p.z);
      if (station >= 0) reached.add(station);
      for (const [dx, dz] of [[80, 0], [-80, 0], [0, 80], [0, -80]]) {
        const x = p.x + dx!, z = p.z + dz!, key = `${x},${z}`;
        if (visited.has(key)) continue;
        visited.add(key); clampBrainchainMovement(p.x, p.z, x, z, out);
        if (Math.abs(out.x - x) < 0.001 && Math.abs(out.z - z) < 0.001) queue.push({ x, z });
      }
    }
    expect([...reached].sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
  test('exit fires once for local movement and never on spawn, teleport, or unblock', () => {
    const edge = { initialized: false, inside: false, allowed: false };
    expect(stepBrainchainExit(edge, 0, 1600, true, false)).toBe(false);
    expect(stepBrainchainExit(edge, 0, 1990, true, true)).toBe(true);
    expect(stepBrainchainExit(edge, 0, 2010, true, true)).toBe(false);
    stepBrainchainExit(edge, 0, 1600, true, true);
    expect(stepBrainchainExit(edge, 0, 1990, true, false)).toBe(false);
    stepBrainchainExit(edge, 0, 1600, false, true);
    expect(stepBrainchainExit(edge, 0, 1990, true, true)).toBe(false);
    const inside = { initialized: false, inside: false, allowed: false };
    expect(stepBrainchainExit(inside, 0, 2100, true, true)).toBe(false);
  });
  test('camera stays on the backward ray and inside the room for normal body positions', () => {
    const out = { x: 0, y: 0, z: 0 };
    for (let yaw = 0; yaw < Math.PI * 2; yaw += 0.1) {
      placeBrainchainCamera(0, 1600, yaw, 0, out);
      expect(Math.hypot(out.x, out.z)).toBeLessThanOrEqual(BRAINCHAIN_ROOM.radius);
      expect(out.x * -Math.sin(yaw) + (out.z - 1600) * Math.cos(yaw)).toBeGreaterThanOrEqual(-1e-6);
    }
  });
  test('only the explicit Cortex entry can raise the safety ceiling', () => {
    expect(npcRenderedHeightLimit(CORTEX_MODEL, CORTEX_MAX_HEIGHT)).toBe(260);
    expect(npcRenderedHeightLimit(CORTEX_MODEL)).toBe(201);
    expect(npcRenderedHeightLimit('/models/characters/pearl-nonorm-ktx.glb', 260)).toBe(201);
    expect(npcRenderedHeightLimit(CORTEX_MODEL, Infinity)).toBe(201);
    expect(CORTEX_SCALE * 182 / 106).toBeCloseTo(230, 0);
  });
});

test('the scene module imports with no DOM', async () => {
  const keys = ['document', 'window'] as const;
  const originals = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  try {
    for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: undefined });
    const scene = await import('./brainchain/brainchain-interior');
    expect(typeof scene.default).toBe('function');
  } finally {
    keys.forEach((key, index) => {
      const original = originals[index];
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
});
