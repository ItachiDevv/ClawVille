import { afterEach, describe, expect, test } from 'bun:test';
import { NPC_DEFINITIONS } from '@clawville/shared';
import { MAP_HEIGHT, MAP_WIDTH } from '@/lib/pixi/tilemap-data';
import { PLAYER_NPC_ID, useNpcStore } from '@/stores/npc';
import {
  CHARACTER_POSITIONS,
  TALK_RADIUS_WORLD,
  findNearestCharacter,
  type WandererSample,
} from './character-positions';

// Wanderer talk targets (Hydra job, 2026-10-31). Before this, the NPC-mode
// TalkToCharacterBar could never reach a free-roaming wanderer (Adinero,
// Ansem, Hydra): findNearestCharacter scanned building residents only.

/** NPC-store sample at a WORLD position (the store holds game-space px). */
function wandererAt(id: string, worldX: number, worldZ: number): WandererSample {
  return { id, x: worldX + MAP_WIDTH / 2, y: worldZ + MAP_HEIGHT / 2 };
}

// Open water at the plaza: > 3000 wu from every building resident.
const FREE_X = 0;
const FREE_Z = 1500;

const SPONGEBOB = CHARACTER_POSITIONS['visual-creation'];

describe('findNearestCharacter — residents only (no wanderers)', () => {
  test('a resident in range resolves with its buildingId', () => {
    const r = findNearestCharacter(SPONGEBOB.worldX, SPONGEBOB.worldZ + 50, null);
    expect(r?.buildingId).toBe('visual-creation');
    expect(r?.characterName).toBe('SpongeBob');
    expect(r?.distance).toBeCloseTo(50, 5);
  });

  test('null and an empty roster give the same resident result', () => {
    const a = findNearestCharacter(SPONGEBOB.worldX + 100, SPONGEBOB.worldZ, null);
    const aName = a?.characterName;
    const b = findNearestCharacter(SPONGEBOB.worldX + 100, SPONGEBOB.worldZ, []);
    expect(b?.characterName).toBe(aName);
    expect(b?.buildingId).toBe('visual-creation');
  });

  test('nothing in range → null', () => {
    expect(findNearestCharacter(FREE_X, FREE_Z, null)).toBeNull();
    expect(findNearestCharacter(FREE_X, FREE_Z, [])).toBeNull();
  });
});

describe('findNearestCharacter — live wanderers', () => {
  test('a wanderer in range resolves to its definition name, buildingId null', () => {
    const r = findNearestCharacter(FREE_X, FREE_Z, [
      wandererAt('adinero-clown', FREE_X + 120, FREE_Z),
    ]);
    expect(r).not.toBeNull();
    expect(r?.buildingId).toBeNull();
    expect(r?.characterName).toBe('Adinero');
    expect(r?.distance).toBeCloseTo(120, 5);
  });

  test('a wanderer just outside TALK_RADIUS_WORLD → null', () => {
    const r = findNearestCharacter(FREE_X, FREE_Z, [
      wandererAt('ansem-wanderer', FREE_X + TALK_RADIUS_WORLD + 1, FREE_Z),
    ]);
    expect(r).toBeNull();
  });

  test('the nearer of two wanderers wins', () => {
    const r = findNearestCharacter(FREE_X, FREE_Z, [
      wandererAt('adinero-clown', FREE_X + 200, FREE_Z),
      wandererAt('ansem-wanderer', FREE_X, FREE_Z - 80),
    ]);
    expect(r?.characterName).toBe('Ansem');
  });

  test('non-wanderer entries (player body, autonomous avatars, unknown ids) are ignored', () => {
    const r = findNearestCharacter(FREE_X, FREE_Z, [
      wandererAt(PLAYER_NPC_ID, FREE_X, FREE_Z),
      wandererAt('autonomous-0123456789abcdef', FREE_X + 5, FREE_Z),
      wandererAt('wanderer-marlin', FREE_X + 5, FREE_Z),
    ]);
    expect(r).toBeNull();
  });

  test('Hydra (hydra-analyst) resolves as "Hydra"', () => {
    const r = findNearestCharacter(FREE_X, FREE_Z, [wandererAt('hydra-analyst', FREE_X, FREE_Z + 90)]);
    expect(r?.characterName).toBe('Hydra');
    expect(r?.buildingId).toBeNull();
  });

  test('every free-roaming NPC definition is a talk target under its own name', () => {
    const wanderers = NPC_DEFINITIONS.filter((d) => d.buildingId === '');
    expect(wanderers.length).toBeGreaterThan(0);
    for (const def of wanderers) {
      const r = findNearestCharacter(FREE_X, FREE_Z, [wandererAt(def.id, FREE_X + 10, FREE_Z)]);
      expect(r?.characterName).toBe(def.name);
      expect(r?.buildingId).toBeNull();
    }
  });
});

describe('findNearestCharacter — resident vs wanderer precedence', () => {
  test('wanderer nearer than the resident → wanderer wins (buildingId null)', () => {
    // Player 150 wu from SpongeBob; Adinero 40 wu from the player.
    const px = SPONGEBOB.worldX + 150;
    const pz = SPONGEBOB.worldZ;
    const r = findNearestCharacter(px, pz, [wandererAt('adinero-clown', px + 40, pz)]);
    expect(r?.characterName).toBe('Adinero');
    expect(r?.buildingId).toBeNull();
  });

  test('resident nearer than the wanderer → resident wins', () => {
    const px = SPONGEBOB.worldX + 30;
    const pz = SPONGEBOB.worldZ;
    const r = findNearestCharacter(px, pz, [wandererAt('adinero-clown', px + 200, pz)]);
    expect(r?.characterName).toBe('SpongeBob');
    expect(r?.buildingId).toBe('visual-creation');
  });

  test('exact tie → resident wins', () => {
    const px = SPONGEBOB.worldX + 100;
    const pz = SPONGEBOB.worldZ;
    const r = findNearestCharacter(px, pz, [wandererAt('adinero-clown', px + 100, pz)]);
    expect(r?.buildingId).toBe('visual-creation');
  });

  test('a dead wanderer next to the player does not beat a live resident', () => {
    const px = SPONGEBOB.worldX + 150;
    const pz = SPONGEBOB.worldZ;
    const r = findNearestCharacter(px, pz, [{ ...wandererAt('adinero-clown', px + 5, pz), isDead: true }]);
    expect(r?.characterName).toBe('SpongeBob');
    expect(r?.buildingId).toBe('visual-creation');
  });

  test('a dead wanderer alone → null; the same wanderer alive → talk target', () => {
    const dead = { ...wandererAt('hydra-analyst', FREE_X + 10, FREE_Z), isDead: true };
    expect(findNearestCharacter(FREE_X, FREE_Z, [dead])).toBeNull();
    expect(findNearestCharacter(FREE_X, FREE_Z, [{ ...dead, isDead: false }])?.characterName).toBe('Hydra');
  });

  test('wanderer out of range does not change the resident result', () => {
    const px = SPONGEBOB.worldX + 100;
    const pz = SPONGEBOB.worldZ;
    const r = findNearestCharacter(px, pz, [
      wandererAt('adinero-clown', px + TALK_RADIUS_WORLD + 50, pz),
    ]);
    expect(r?.characterName).toBe('SpongeBob');
  });
});

describe('findNearestCharacter — hot-path contract', () => {
  const originalNpcs = useNpcStore.getState().npcs;
  afterEach(() => {
    useNpcStore.setState({ npcs: originalNpcs });
  });

  test('default roster is the live NPC store (2-arg call, as NpcController makes it)', () => {
    const base = originalNpcs[0];
    const adinero = { ...base, id: 'adinero-clown', name: 'Adinero', x: FREE_X + 60 + MAP_WIDTH / 2, y: FREE_Z + MAP_HEIGHT / 2 };
    useNpcStore.setState({ npcs: [adinero] });
    const r = findNearestCharacter(FREE_X, FREE_Z);
    expect(r?.characterName).toBe('Adinero');
    expect(r?.buildingId).toBeNull();
  });

  test('default roster skips a store entry with isDead: true', () => {
    const base = originalNpcs[0];
    const dead = { ...base, id: 'adinero-clown', name: 'Adinero', x: FREE_X + 60 + MAP_WIDTH / 2, y: FREE_Z + MAP_HEIGHT / 2, isDead: true };
    useNpcStore.setState({ npcs: [dead] });
    expect(findNearestCharacter(FREE_X, FREE_Z)).toBeNull();
  });

  test('result object is reused across calls (zero allocation per frame)', () => {
    const a = findNearestCharacter(SPONGEBOB.worldX, SPONGEBOB.worldZ, null);
    const b = findNearestCharacter(FREE_X, FREE_Z, [wandererAt('adinero-clown', FREE_X, FREE_Z)]);
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(b?.characterName).toBe('Adinero');
  });
});
