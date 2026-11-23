import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ENTITY_HALF_CHIBI, ENTITY_HALF_HUMANOID } from '@clawville/shared';

/**
 * Walk-into-the-door auto-enter (founder report 2026-11-11: walking into the
 * Trading Floor front door did nothing; only click, tap or E entered).
 *
 * Drives the REAL per-frame proximity path (`updateWorldProximity`) along real
 * collider-clamped walks, and counts crossings to /trading-floor.
 *
 * rAF and `window` are stubbed with `defineProperty` for the same reason as
 * trading-floor-walk-in.test.ts: an earlier jsdom file can leave them as
 * non-writable accessors in the full-suite run.
 */
const scheduled: Array<() => void> = [];
const originalRafDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');

function installStubs(): void {
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    writable: true,
    value: (callback: () => void): number => {
      scheduled.push(callback);
      return scheduled.length;
    },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: { location: { pathname: '/game' }, dispatchEvent: () => true },
  });
}

function restoreStubs(): void {
  if (originalRafDescriptor) Object.defineProperty(globalThis, 'requestAnimationFrame', originalRafDescriptor);
  else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
  if (originalWindowDescriptor) Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
  else Reflect.deleteProperty(globalThis, 'window');
}

const { avatarPositionRef, useGameStore } = await import('@/stores/game');
const { installWorldStageNavigationHandler, resetWorldStageNavigationForTests } = await import(
  '@/components/three/world-stage/stage-navigation'
);
const { resetVenueWalkInPendingForTests } = await import('../venue-walk-in');
const { resetTradingFloorAutoEnterForTests, updateWorldProximity } = await import(
  '@/lib/world-frame-interaction'
);
const {
  isAtTradingFloorDoorFace,
  isTradingFloorProximate,
  TRADING_FLOOR_DOOR_FACE_HALF_X_WU,
  TRADING_FLOOR_DOOR_FACE_MIN_Z,
  TRADING_FLOOR_EXIT_WORLD_X,
  TRADING_FLOOR_EXIT_WORLD_Z,
} = await import('../character-positions');
const { clampMovement2D } = await import('../collision/world-colliders');
const { TRADING_FLOOR_DOOR_WORLD } = await import('./trading-floor-location');
const { MAP_HEIGHT, MAP_WIDTH } = await import('@/lib/pixi/tilemap-data');

let navigated: string[] = [];
let uninstall: (() => void) | null = null;

/** One game frame at world (x, z): publish the body, run proximity, run polls. */
function frame(x: number, z: number): void {
  avatarPositionRef.x = MAP_WIDTH / 2 + x;
  avatarPositionRef.y = MAP_HEIGHT / 2 + z;
  updateWorldProximity(x, z);
  const due = scheduled.splice(0, scheduled.length);
  for (const callback of due) callback();
}

/** Walks from (x, z) by (dx, dz) per step, clamped by the world colliders,
 *  running one frame per step. Returns where the body came to rest. */
function walk(x: number, z: number, dx: number, dz: number, steps: number, half = ENTITY_HALF_CHIBI) {
  for (let i = 0; i < steps; i += 1) {
    const next = clampMovement2D(x, z, x + dx, z + dz, half);
    x = next.x;
    z = next.z;
    frame(x, z);
  }
  return { x, z };
}

beforeEach(() => {
  installStubs();
  scheduled.length = 0;
  navigated = [];
  resetVenueWalkInPendingForTests();
  resetWorldStageNavigationForTests();
  resetTradingFloorAutoEnterForTests();
  uninstall = installWorldStageNavigationHandler((request) => {
    navigated.push(request.to);
    return true;
  });
  useGameStore.setState({ controlMode: 'player', movementFrozen: false });
  useGameStore.getState().clearClickPath();
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
  resetVenueWalkInPendingForTests();
  resetWorldStageNavigationForTests();
  resetTradingFloorAutoEnterForTests();
  useGameStore.getState().clearClickPath();
  restoreStubs();
});

describe('Trading Floor door-face strip', () => {
  test('a body pressed against the face lands in the strip (chibi and humanoid)', () => {
    for (const half of [ENTITY_HALF_CHIBI, ENTITY_HALF_HUMANOID]) {
      let x = TRADING_FLOOR_DOOR_WORLD.x;
      let z = TRADING_FLOOR_EXIT_WORLD_Z;
      for (let i = 0; i < 400; i += 1) {
        const next = clampMovement2D(x, z, x, z + 8, half);
        if (Math.abs(next.z - z) < 0.01) break;
        x = next.x;
        z = next.z;
      }
      expect(isAtTradingFloorDoorFace(x, z)).toBe(true);
    }
  });

  test('the strip is narrow: inside the prompt band, never at the exit spawn', () => {
    expect(isAtTradingFloorDoorFace(TRADING_FLOOR_EXIT_WORLD_X, TRADING_FLOOR_EXIT_WORLD_Z)).toBe(false);
    const cornerX = TRADING_FLOOR_DOOR_WORLD.x + TRADING_FLOOR_DOOR_FACE_HALF_X_WU;
    expect(isTradingFloorProximate(cornerX, TRADING_FLOOR_DOOR_FACE_MIN_Z)).toBe(true);
    expect(isAtTradingFloorDoorFace(cornerX + 1, TRADING_FLOOR_DOOR_WORLD.z)).toBe(false);
    expect(isAtTradingFloorDoorFace(TRADING_FLOOR_DOOR_WORLD.x, TRADING_FLOOR_DOOR_FACE_MIN_Z - 1)).toBe(false);
  });
});

describe('Trading Floor walk-into-the-door auto-enter', () => {
  test('(a) walking straight into the face enters exactly once', () => {
    let enteredAtZ: number | null = null;
    let x = TRADING_FLOOR_EXIT_WORLD_X;
    let z = TRADING_FLOOR_EXIT_WORLD_Z;
    for (let i = 0; i < 300; i += 1) {
      const next = clampMovement2D(x, z, x, z + 8, ENTITY_HALF_CHIBI);
      x = next.x;
      z = next.z;
      const before = navigated.length;
      frame(x, z);
      if (enteredAtZ === null && navigated.length > before) enteredAtZ = z;
    }
    expect(navigated).toEqual(['/trading-floor']);
    expect(enteredAtZ).not.toBeNull();
    expect(enteredAtZ!).toBeGreaterThanOrEqual(TRADING_FLOOR_DOOR_FACE_MIN_Z);
  });

  test('(b) the exit spawn and the walk from it toward town never enter', () => {
    for (let i = 0; i < 60; i += 1) frame(TRADING_FLOOR_EXIT_WORLD_X, TRADING_FLOOR_EXIT_WORLD_Z);
    walk(TRADING_FLOOR_EXIT_WORLD_X, TRADING_FLOOR_EXIT_WORLD_Z, 0, -8, 200);
    walk(TRADING_FLOOR_EXIT_WORLD_X, TRADING_FLOOR_EXIT_WORLD_Z, 8, 0, 100);
    expect(navigated).toEqual([]);
  });

  test('walking into the face outside the doorway never enters', () => {
    walk(TRADING_FLOOR_DOOR_WORLD.x + 300, TRADING_FLOOR_EXIT_WORLD_Z, 0, 8, 300);
    expect(navigated).toEqual([]);
  });

  test('(c) standing in the strip for many frames enters once', () => {
    for (let i = 0; i < 120; i += 1) frame(TRADING_FLOOR_DOOR_WORLD.x, TRADING_FLOOR_DOOR_WORLD.z + 20);
    expect(navigated).toEqual(['/trading-floor']);
  });

  test('(d) leaving the prompt band and returning re-arms', () => {
    frame(TRADING_FLOOR_DOOR_WORLD.x, TRADING_FLOOR_DOOR_WORLD.z + 20);
    expect(navigated).toEqual(['/trading-floor']);
    // Still inside the band: no re-arm.
    frame(TRADING_FLOOR_DOOR_WORLD.x, TRADING_FLOOR_DOOR_WORLD.z - 300);
    frame(TRADING_FLOOR_DOOR_WORLD.x, TRADING_FLOOR_DOOR_WORLD.z + 20);
    expect(navigated).toEqual(['/trading-floor']);
    // Out of the band (exit spawn), then back to the face.
    frame(TRADING_FLOOR_EXIT_WORLD_X, TRADING_FLOOR_EXIT_WORLD_Z);
    frame(TRADING_FLOOR_DOOR_WORLD.x, TRADING_FLOOR_DOOR_WORLD.z + 20);
    expect(navigated).toEqual(['/trading-floor', '/trading-floor']);
  });

  test('autonomous and explore bodies are never pulled in', () => {
    for (const mode of ['autonomous', 'explore'] as const) {
      useGameStore.setState({ controlMode: mode });
      for (let i = 0; i < 10; i += 1) frame(TRADING_FLOOR_DOOR_WORLD.x, TRADING_FLOOR_DOOR_WORLD.z + 20);
    }
    expect(navigated).toEqual([]);
  });

  test('a frozen body waits, then enters once movement unfreezes', () => {
    useGameStore.setState({ movementFrozen: true });
    frame(TRADING_FLOOR_DOOR_WORLD.x, TRADING_FLOOR_DOOR_WORLD.z + 20);
    expect(navigated).toEqual([]);
    useGameStore.setState({ movementFrozen: false });
    frame(TRADING_FLOOR_DOOR_WORLD.x, TRADING_FLOOR_DOOR_WORLD.z + 20);
    expect(navigated).toEqual(['/trading-floor']);
  });
});

// Caller contract (Codex E3 2026-11-11): the helper only works if every local
// body controller runs it. The player avatar and 2D loop reach it through
// updateWorldProximity; the possessed-NPC 3D controller keeps its own
// proximity block and must call the helper directly.
describe('door-face auto-enter callers', () => {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  const src = (rel: string) => readFileSync(join(import.meta.dir, '..', '..', '..', rel), 'utf8');
  test('updateWorldProximity runs the helper', () => {
    expect(src('lib/world-frame-interaction.ts')).toMatch(/export function updateWorldProximity[\s\S]*?stepTradingFloorAutoEnter\(x, z\);/);
  });
  test('the possessed-NPC 3D controller runs the helper', () => {
    expect(src('lib/three/npc-controller.tsx')).toContain('stepTradingFloorAutoEnter(wx, wz);');
  });
});
