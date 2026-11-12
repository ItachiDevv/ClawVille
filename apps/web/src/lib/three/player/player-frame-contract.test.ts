import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { JSDOM } from 'jsdom';
import { PerspectiveCamera, type Clock } from 'three';
import type { RootState } from '@react-three/fiber';
import { useGameStore } from '@/stores/game';
import { jumpState, resetJump } from '@/lib/three/jump-state';
import {
  DEFAULT_PLAYER_CAPABILITIES,
  resolvePlayerCapabilities,
} from './player-capability-mask';
import {
  createPlayerControllerTestRuntime,
  DEFAULT_PLAYER_FRAME_PRIORITY,
  runPlayerControllerFrameForTests,
  type PlayerCapabilityControllerConfig,
} from './player-capability-controller';
import {
  attachPlayerKeyListeners,
  playerKeyState,
  resetPlayerKeys,
  resetPlayerTouch,
  RUN_SPEED_MULT,
} from './player-input';
import { WORLD_VRM_POLICY } from './player-motion-policy';
import { useStageStore } from '@/components/three/world-stage/stage-store';

let dom: JSDOM;
const originalGlobalDescriptors = new Map<
  string,
  PropertyDescriptor | undefined
>();

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://clawville.world/game' });
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
  })) {
    originalGlobalDescriptors.set(
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    );
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
});

afterAll(() => {
  dom.window.close();
  for (const [key, descriptor] of originalGlobalDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const camera = new PerspectiveCamera();
camera.lookAt(0, 0, -1);
camera.updateMatrixWorld(true);
const rootState = {
  camera,
  clock: { elapsedTime: 12 } as Clock,
} as RootState;

function harness(
  overrides: Partial<PlayerCapabilityControllerConfig> = {},
) {
  const position = { x: 0, z: 0 };
  const events: string[] = [];
  const config: PlayerCapabilityControllerConfig = {
    sceneId: 'world',
    capabilities: DEFAULT_PLAYER_CAPABILITIES,
    motion: WORLD_VRM_POLICY.motion,
    input: WORLD_VRM_POLICY.input,
    space: {
      speedPerSec: 10,
      readPosition(out) {
        out.x = position.x;
        out.z = position.z;
      },
      clampMovement(_px, _pz, x, z, out) {
        events.push('clamp');
        out.x = x;
        out.z = z;
        out.groundY = 3;
      },
      commitPosition(result) {
        events.push('commit');
        position.x = result.x;
        position.z = result.z;
      },
    },
    isDriving: () => true,
    ...overrides,
  };
  const runtime = createPlayerControllerTestRuntime(config.motion);
  return {
    config,
    events,
    position,
    runtime,
    run(delta = 0.1) {
      runPlayerControllerFrameForTests(config, runtime, rootState, delta);
    },
  };
}

describe('ordered player frame contract', () => {
  beforeEach(() => {
    resetPlayerKeys();
    resetPlayerTouch();
    resetJump();
    jumpState.spaceDown = false;
    useStageStore.getState().resetStage();
    useGameStore.setState({ joystickVelocity: { x: 0, y: 0 } });
  });

  test('a return facing override applies once without movement', () => {
    let pending: number | null = -2.093;
    const h = harness({ consumeFacingOverride: () => { const value = pending; pending = null; return value; } });
    h.run(); expect(h.runtime.facing).toBe(-2.093);
    h.run(); expect(h.runtime.facing).toBe(-2.093);
    expect(h.position).toEqual({ x: 0, z: 0 });
  });

  test('plain moving frame preserves the 0 through 9 hook order', () => {
    playerKeyState.w = true;
    const events: string[] = [];
    const h = harness({
      onFrameStart: () => events.push('start'),
      onNavigationOverride: () => {
        events.push('navigation');
      },
      onDirection: () => events.push('direction'),
      onAfterMove: () => events.push('after'),
    });
    h.run();
    expect(events).toEqual([
      'start',
      'navigation',
      'direction',
      'after',
    ]);
    expect(h.events).toEqual(['clamp', 'commit']);
  });

  test('onFrameStart runs on a frozen frame', () => {
    let starts = 0;
    const h = harness({
      isFrozen: () => true,
      onFrameStart: () => { starts += 1; },
    });
    h.run();
    expect(starts).toBe(1);
  });

  test('onFrameStart runs before an interact-consumed frame', () => {
    playerKeyState.e = true;
    const events: string[] = [];
    const h = harness({
      onFrameStart: () => events.push('start'),
      onInteractEdge: () => {
        events.push('interact');
        return { consumeFrame: true };
      },
    });
    h.run();
    expect(events).toEqual(['start', 'interact']);
  });

  test('onFrameStart runs before a navigation-consumed frame', () => {
    const events: string[] = [];
    const h = harness({
      onFrameStart: () => events.push('start'),
      onNavigationOverride: () => {
        events.push('navigation');
        return { consumeFrame: true };
      },
    });
    h.run();
    expect(events).toEqual(['start', 'navigation']);
  });

  test('external teleport can be reseeded while frozen', () => {
    let previous = 0;
    const h = harness({
      isFrozen: () => true,
      onFrameStart: ({ x }) => { previous = x; },
    });
    h.position.x = 45;
    h.run();
    expect(previous).toBe(45);
  });

  test('ESC while frozen dispatches and skips movement', () => {
    playerKeyState.escape = true;
    let escapes = 0;
    const h = harness({
      isFrozen: () => true,
      onEscapeWhileFrozen: () => { escapes += 1; },
    });
    h.run();
    expect([escapes, h.events.length]).toEqual([1, 0]);
  });

  test('disabled frozen escape leaves edge bookkeeping untouched', () => {
    playerKeyState.escape = true;
    let enabled = false;
    let escapes = 0;
    const h = harness({
      isFrozen: () => true,
      isEscapeEdgeEnabled: () => enabled,
      onEscapeWhileFrozen: () => { escapes += 1; },
    });
    h.run();
    enabled = true;
    h.run();
    expect(escapes).toBe(1);
  });

  test('unfrozen escape bookkeeping is unconditional', () => {
    playerKeyState.escape = true;
    const h = harness({ isEscapeEdgeEnabled: () => false });
    h.run();
    expect(h.runtime.lastEscape).toBe(true);
  });

  test('disabled interact leaves E bookkeeping untouched', () => {
    playerKeyState.e = true;
    let enabled = false;
    let interactions = 0;
    const h = harness({
      isInteractEdgeEnabled: () => enabled,
      onInteractEdge: () => { interactions += 1; },
    });
    h.run();
    enabled = true;
    h.run();
    expect(interactions).toBe(1);
  });

  test('frozen frames never write E bookkeeping', () => {
    playerKeyState.e = true;
    const h = harness({ isFrozen: () => true });
    h.run();
    expect(h.runtime.lastE).toBe(false);
  });

  test('interact consume writes E and skips movement', () => {
    playerKeyState.e = true;
    playerKeyState.w = true;
    const h = harness({
      onInteractEdge: () => ({ consumeFrame: true }),
    });
    h.run();
    expect([h.runtime.lastE, h.position.z]).toEqual([true, 0]);
  });

  test('non-consuming interact falls through to movement', () => {
    playerKeyState.e = true;
    playerKeyState.w = true;
    const h = harness({ onInteractEdge: () => undefined });
    h.run();
    expect(h.position.z).toBeLessThan(0);
  });

  test('navigation override replaces the movement vector', () => {
    playerKeyState.w = true;
    const h = harness({
      onNavigationOverride: () => ({
        moveOverride: { worldVx: 1, worldVz: 0 },
      }),
    });
    h.run();
    expect(h.position).toEqual({ x: 1, z: 0 });
  });

  test('navigation override and direct input share the run multiplier', () => {
    playerKeyState.shift = true;
    const h = harness({
      onNavigationOverride: () => ({
        moveOverride: { worldVx: 1, worldVz: 0 },
      }),
    });
    h.run();
    expect(RUN_SPEED_MULT).toBe(2.025);
    expect(h.position).toEqual({ x: RUN_SPEED_MULT, z: 0 });
  });

  test('navigation consume skips direction and movement', () => {
    let directions = 0;
    const h = harness({
      onNavigationOverride: () => ({ consumeFrame: true }),
      onDirection: () => { directions += 1; },
    });
    h.run();
    expect([directions, h.events.length]).toEqual([0, 0]);
  });

  test('navigation runs even while direct driving is disabled', () => {
    let navigation = 0;
    const h = harness({
      isDriving: () => false,
      onNavigationOverride: () => { navigation += 1; },
    });
    h.run();
    expect(navigation).toBe(1);
  });

  test('onDirection fires on idle frames', () => {
    let direction = 'missing';
    const h = harness({
      onDirection: (next) => { direction = next; },
    });
    h.run();
    expect(direction).toBe('idle');
  });

  test('clickPath false suppresses navigation override', () => {
    let navigation = 0;
    const h = harness({
      capabilities: resolvePlayerCapabilities({ clickPath: false }),
      onNavigationOverride: () => { navigation += 1; },
    });
    h.run();
    expect(navigation).toBe(0);
  });

  test('controller -100 dispatches before a priority-0 JumpTicker callback', () => {
    const order = [
      { name: 'ticker', priority: 0, mountOrder: 0 },
      {
        name: 'controller',
        priority: DEFAULT_PLAYER_FRAME_PRIORITY,
        mountOrder: 1,
      },
    ]
      .sort((a, b) => a.priority - b.priority || a.mountOrder - b.mountOrder)
      .map(({ name }) => name);
    expect(order).toEqual(['controller', 'ticker']);
  });

  test('changing the controller priority to 0 reverses scheduler order', () => {
    const order = [
      { name: 'ticker', priority: 0, mountOrder: 0 },
      { name: 'controller', priority: 0, mountOrder: 1 },
    ]
      .sort((a, b) => a.priority - b.priority || a.mountOrder - b.mountOrder)
      .map(({ name }) => name);
    expect(order).toEqual(['ticker', 'controller']);
  });

  test('listener attach and detach across an activation flip is balanced', () => {
    const baseline = useStageStore.getState().windowListenerCount;
    const detach = attachPlayerKeyListeners(WORLD_VRM_POLICY.input);
    expect(useStageStore.getState().windowListenerCount).toBe(baseline + 2);
    detach();
    expect(useStageStore.getState().windowListenerCount).toBe(baseline);
  });
});


test('text focus preserves click navigation and frame callbacks', () => {
  const textarea = document.createElement('textarea');
  document.body.append(textarea);
  textarea.focus();
  let pathIndex = 0;
  let afterMove = 0;
  const h = harness({
    onNavigationOverride: () => { pathIndex++; return { moveOverride: { worldVx: 1, worldVz: 0, maxDistance: 0.25 } }; },
    onAfterMove: () => { afterMove++; },
  });
  try {
    h.run(0.1);
    expect(pathIndex).toBe(1);
    expect(afterMove).toBe(1);
    expect(h.position.x).toBe(0.25);
  } finally { textarea.remove(); }
});

test('click navigation caps movement at the waypoint during a slow sprint frame', () => {
  const h = harness({ onNavigationOverride: () => ({ moveOverride: { worldVx: 1, worldVz: 0, maxDistance: 0.1 } }) });
  playerKeyState.shift = true;
  h.run(0.2);
  expect(h.position.x).toBe(0.1);
});


test('polyline navigation never emits an idle movement frame before arrival', () => {
  resetPlayerKeys();
  const points = [{ x: 0, y: 0 }, { x: 0.1, y: 0 }, { x: 0.1, y: 1 }];
  let index = 0, complete = false; const movement: boolean[] = [];
  const h = harness({
    onNavigationOverride: () => ({ moveOverride: { worldVx: 1, worldVz: 0 }, navigationPath: { points, index, onProgress: next => { index = next; }, onComplete: () => { complete = true; } } }),
    onAfterMove: frame => { movement.push(frame.moving); },
  });
  for (let count = 0; count < 20 && !complete; count++) h.run(0.1);
  expect(complete).toBe(true);
  expect(movement.length).toBeGreaterThan(1);
  expect(movement.every(Boolean)).toBe(true);
  expect(h.position).toEqual({ x: 0.1, z: 1 });
});

test('game-pixel navigation converts a nonzero origin and completes after committed proximity', () => {
  resetPlayerKeys();
  const originX = 11264, originZ = 11264;
  const pixel = { x: originX - 500, y: originZ - 1500 };
  const points = [{ ...pixel }, { x: pixel.x + 1, y: pixel.y }, { x: pixel.x + 1, y: pixel.y + 2 }];
  let index = 0, near = false, entered = false, complete = false;
  const events: string[] = [], clampCoordinates: number[] = [];
  const h = harness({
    space: {
      speedPerSec: 10,
      readPosition(out) { out.x = pixel.x - originX; out.z = pixel.y - originZ; },
      clampMovement(x, z, tx, tz, out) { clampCoordinates.push(x, z, tx, tz); out.x = tx; out.z = tz; out.groundY = 0; },
      commitPosition(out) { pixel.x = out.x + originX; pixel.y = out.z + originZ; events.push('commit'); },
    },
    onNavigationOverride: () => ({ moveOverride: { worldVx: 1, worldVz: 0 }, navigationPath: {
      points, index, originX, originZ,
      onProgress: next => { index = next; },
      onComplete: () => { entered = near; complete = true; events.push('complete'); },
    } }),
    onAfterMove: frame => { near = frame.x === -499 && frame.z === -1498; events.push('proximity'); },
  });
  for (let count = 0; count < 10 && !complete; count++) h.run(0.1);
  expect(pixel).toEqual(points.at(-1)!);
  expect(complete).toBe(true);
  expect(entered).toBe(true);
  expect(clampCoordinates.every(value => value < 0)).toBe(true);
  expect(events.slice(-2)).toEqual(['proximity', 'complete']);
});

test('navigation direction uses the last segment and a blocked frame keeps its facing', () => {
  resetPlayerKeys();
  let direction = '', vx = 0, vz = 0;
  const h = harness({
    onNavigationOverride: () => ({ moveOverride: { worldVx: 1, worldVz: 0 }, navigationPath: {
      points: [{ x: 0.1, y: 0 }, { x: 0.1, y: 10 }], index: 0, onProgress: () => {}, onComplete: () => {},
    } }),
    onDirection: next => { direction = next; },
    onAfterMove: frame => { vx = frame.intent.move.worldVx; vz = frame.intent.move.worldVz; },
  });
  h.run(0.1);
  expect(direction).toBe('down');
  expect([vx, vz]).toEqual([0, 1]);
  const blocked = harness({
    onNavigationOverride: h.config.onNavigationOverride,
    onDirection: next => { direction = next; },
  });
  blocked.config.space.clampMovement = (x, z, _tx, _tz, out) => { out.x = x; out.z = z; out.groundY = 0; };
  blocked.runtime.facing = 1.2;
  blocked.run(0.1);
  expect(direction).toBe('idle');
  expect(blocked.runtime.facing).toBe(1.2);
});
