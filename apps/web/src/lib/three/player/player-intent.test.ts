import {
  afterAll,
  afterEach,
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
  runPlayerControllerFrameForTests,
  type PlayerCapabilityControllerConfig,
  type PlayerControllerFrameState,
} from './player-capability-controller';
import {
  attachPlayerKeyListeners,
  playerKeyState,
  playerTouchState,
  resetPlayerKeys,
  resetPlayerTouch,
  setPlayerTouchCamera,
  setPlayerTouchMove,
} from './player-input';
import {
  derivePlayerFrameIntent,
  type DerivePlayerFrameIntentInput,
  type PlayerFrameIntent,
} from './player-intent';
import {
  KELP_POLICY,
  WORLD_VRM_POLICY,
  type PlayerInputPolicy,
} from './player-motion-policy';

const camera = new PerspectiveCamera();
camera.position.set(0, 0, 0);
camera.lookAt(0, 0, -1);
camera.updateMatrixWorld(true);
const rootState = {
  camera,
  clock: { elapsedTime: 12 } as Clock,
} as RootState;

let dom: JSDOM;
const originalGlobalDescriptors = new Map<
  string,
  PropertyDescriptor | undefined
>();
const listenerCleanups: Array<() => void> = [];

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
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

function derive(
  overrides: Partial<DerivePlayerFrameIntentInput> = {},
  out?: PlayerFrameIntent,
) {
  return derivePlayerFrameIntent({
    camera,
    capabilities: DEFAULT_PLAYER_CAPABILITIES,
    policy: WORLD_VRM_POLICY.input,
    storeJoystick: { x: 0, y: 0 },
    jumpPhase: 'grounded',
    playerAltitude: 0,
    chargeMode: 'none',
    ...overrides,
  }, out);
}

function controllerHarness(
  overrides: Partial<PlayerCapabilityControllerConfig> = {},
) {
  const position = { x: 0, z: 0 };
  let clampCalls = 0;
  let lastFrame: PlayerControllerFrameState | null = null;
  const suppliedAfterMove = overrides.onAfterMove;
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
      clampMovement(_prevX, _prevZ, desiredX, desiredZ, out) {
        clampCalls += 1;
        out.x = desiredX;
        out.z = desiredZ;
        out.groundY = 0;
      },
      commitPosition(result) {
        position.x = result.x;
        position.z = result.z;
      },
    },
    isDriving: () => true,
    ...overrides,
    onAfterMove(frame, rawDelta, elapsed) {
      lastFrame = frame;
      suppliedAfterMove?.(frame, rawDelta, elapsed);
    },
  };
  const runtime = createPlayerControllerTestRuntime(config.motion);
  return {
    config,
    position,
    runtime,
    get clampCalls() {
      return clampCalls;
    },
    get lastFrame() {
      return lastFrame;
    },
    run(delta = 0.1) {
      runPlayerControllerFrameForTests(config, runtime, rootState, delta);
    },
  };
}

function attach(
  policy: PlayerInputPolicy = WORLD_VRM_POLICY.input,
): void {
  listenerCleanups.push(attachPlayerKeyListeners(policy));
}

function dispatchKey(
  target: EventTarget,
  type: 'keydown' | 'keyup',
  key: string,
  code: string,
): void {
  target.dispatchEvent(
    new dom.window.KeyboardEvent(type, {
      key,
      code,
      bubbles: true,
    }),
  );
}

describe('derivePlayerFrameIntent', () => {
  beforeEach(() => {
    resetPlayerKeys();
    resetPlayerTouch();
    resetJump();
    useGameStore.setState({ joystickVelocity: { x: 0, y: 0 } });
    document.body.replaceChildren();
  });

  afterEach(() => {
    while (listenerCleanups.length > 0) listenerCleanups.pop()?.();
    resetPlayerKeys();
    resetPlayerTouch();
    resetJump();
  });

  test('projects W toward camera-forward -Z', () => {
    playerKeyState.w = true;
    expect(derive().move).toMatchObject({ worldVx: 0, worldVz: -1 });
  });

  test('projects W after a 90-degree camera yaw', () => {
    const yawed = new PerspectiveCamera();
    yawed.lookAt(1, 0, 0);
    yawed.updateMatrixWorld(true);
    playerKeyState.w = true;
    expect(derive({ camera: yawed }).move.worldVx).toBeCloseTo(1);
  });

  test('store joystick replaces WASD and inverts y into forward', () => {
    playerKeyState.w = true;
    expect(derive({ storeJoystick: { x: 1, y: 0 } }).move).toMatchObject({
      worldVx: 1,
      worldVz: 0,
    });
    expect(derive({ storeJoystick: { x: 0, y: -1 } }).move.worldVz).toBe(-1);
  });

  test('store precedence normalizes only a two-axis vector longer than one', () => {
    const diagonal = derive({ storeJoystick: { x: 1, y: -1 } }).move;
    const short = derive({ storeJoystick: { x: 0.3, y: -0.4 } }).move;
    const cardinal = derive({ storeJoystick: { x: 1.2, y: 0 } }).move;
    expect(Math.hypot(diagonal.worldVx, diagonal.worldVz)).toBeCloseTo(1);
    expect(Math.hypot(short.worldVx, short.worldVz)).toBeCloseTo(0.5);
    expect(cardinal.worldVx).toBe(1.2);
  });

  test('additive keyboard and touch input is normalized before and after projection', () => {
    playerKeyState.w = true;
    setPlayerTouchMove(1, 1);
    const move = derive({ policy: KELP_POLICY.input }).move;
    expect(move.worldVx).toBeGreaterThan(0);
    expect(move.worldVz).toBeLessThan(0);
    expect(Math.hypot(move.worldVx, move.worldVz)).toBeCloseTo(1);
  });

  test('readsStoreJoystick false ignores a non-zero store stick', () => {
    expect(derive({
      policy: KELP_POLICY.input,
      storeJoystick: { x: 1, y: 1 },
    }).move.moving).toBe(false);
  });

  test('readsSharedTouch false ignores shared movement and camera input', () => {
    setPlayerTouchMove(1, 1);
    setPlayerTouchCamera(1, 1);
    const intent = derive();
    expect(intent.move.moving).toBe(false);
    expect([intent.cameraYawInput, intent.cameraPitchInput]).toEqual([0, 0]);
  });

  test('movementEpsilon blocks kelp integration but accepts the same world vector', () => {
    setPlayerTouchMove(0.0005, 0);
    const kelp = controllerHarness({
      motion: KELP_POLICY.motion,
      input: KELP_POLICY.input,
    });
    kelp.run();
    expect([kelp.lastFrame?.moving, kelp.clampCalls]).toEqual([false, 0]);

    const world = controllerHarness({
      input: {
        ...WORLD_VRM_POLICY.input,
        readsSharedTouch: true,
      },
    });
    world.run();
    expect([world.lastFrame?.moving, world.clampCalls]).toEqual([true, 1]);
  });

  test('moving is measured before additive normalization', () => {
    setPlayerTouchMove(2, 2);
    const move = derive({ policy: KELP_POLICY.input }).move;
    expect(move.moving).toBe(true);
    expect(Math.hypot(move.worldVx, move.worldVz)).toBeCloseTo(1);
  });

  test('keyIdentity preserves code-based kelp and key-based world semantics', () => {
    attach(KELP_POLICY.input);
    dispatchKey(window, 'keydown', 'z', 'KeyW');
    expect(playerKeyState.w).toBe(true);
    listenerCleanups.pop()?.();
    resetPlayerKeys();

    attach(WORLD_VRM_POLICY.input);
    dispatchKey(window, 'keydown', 'z', 'KeyW');
    expect(playerKeyState.w).toBe(false);
  });

  test('keyTargetGuard ignores editable world keydown but preserves kelp keydown', () => {
    const input = document.createElement('input');
    document.body.append(input);
    attach(WORLD_VRM_POLICY.input);
    dispatchKey(input, 'keydown', 'w', 'KeyW');
    expect(playerKeyState.w).toBe(false);
    listenerCleanups.pop()?.();

    attach(KELP_POLICY.input);
    dispatchKey(input, 'keydown', 'w', 'KeyW');
    expect(playerKeyState.w).toBe(true);
  });

  test('keyup is never target-guarded under either key identity', () => {
    const input = document.createElement('input');
    document.body.append(input);
    for (const policy of [WORLD_VRM_POLICY.input, KELP_POLICY.input]) {
      attach(policy);
      playerKeyState.w = true;
      dispatchKey(input, 'keyup', 'w', 'KeyW');
      expect(playerKeyState.w).toBe(false);
      listenerCleanups.pop()?.();
    }
  });

  test('sprint pins shift, joystick thresholds, and exact multipliers', () => {
    playerKeyState.shift = true;
    expect(derive().move.running).toBe(false);
    playerKeyState.w = true;
    expect(derive().move).toMatchObject({ running: true, speedMultiplier: 1.5 });
    playerKeyState.w = false;
    playerKeyState.shift = false;
    expect(derive({ storeJoystick: { x: 0.71, y: 0 } }).move.running).toBe(true);
    expect(derive({ storeJoystick: { x: 0.69, y: 0 } }).move).toMatchObject({
      running: false,
      speedMultiplier: 1,
    });
  });

  test('sprint false suppresses keyboard and joystick triggers', () => {
    const capabilities = resolvePlayerCapabilities({ sprint: false });
    playerKeyState.shift = true;
    playerKeyState.w = true;
    expect(derive({ capabilities }).move.running).toBe(false);
    playerKeyState.w = false;
    expect(derive({
      capabilities,
      storeJoystick: { x: 1, y: 0 },
    }).move.running).toBe(false);
  });

  test('charging is input-airborne but not render-airborne', () => {
    const intent = derive({ jumpPhase: 'charging' });
    expect([intent.inputAirborne, intent.renderAirborne]).toEqual([true, false]);
  });

  test('verticalSwim raises and auto-sinks at the exact rates', () => {
    const h = controllerHarness();
    jumpState.phase = 'quick';
    jumpState.playerAltitude = 2;
    playerKeyState.arrowup = true;
    h.run(0.1);
    expect(jumpState.playerAltitude).toBe(3);
    playerKeyState.arrowup = false;
    jumpState.phase = 'grounded';
    h.run(0.1);
    expect(jumpState.playerAltitude).toBeCloseTo(2.4);
  });

  test('verticalSwim false never changes altitude', () => {
    jumpState.phase = 'quick';
    jumpState.playerAltitude = 2;
    playerKeyState.arrowup = true;
    const h = controllerHarness({
      capabilities: resolvePlayerCapabilities({ verticalSwim: false }),
    });
    for (let index = 0; index < 100; index += 1) h.run();
    expect(jumpState.playerAltitude).toBe(2);
  });

  test('jump false leaves jumpState byte-equal across 1000 held-space frames', () => {
    jumpState.phase = 'charging';
    jumpState.chargeMode = 'run';
    jumpState.spaceDown = true;
    const before = { ...jumpState };
    const h = controllerHarness({
      capabilities: resolvePlayerCapabilities({ jump: false }),
      motion: KELP_POLICY.motion,
    });
    for (let index = 0; index < 1_000; index += 1) h.run();
    expect(jumpState).toEqual(before);
  });

  test('chargeDiscrimination false never writes chargeMode or squatHold', () => {
    jumpState.phase = 'charging';
    playerKeyState.w = true;
    const h = controllerHarness({ motion: KELP_POLICY.motion });
    h.run();
    expect(jumpState.chargeMode).toBe('none');
    expect(h.lastFrame?.intent.squatHold).toBe(false);
  });

  test('chargeDiscrimination true pins run, squat, and falling decisions', () => {
    jumpState.phase = 'charging';
    playerKeyState.w = true;
    playerKeyState.shift = true;
    controllerHarness().run();
    expect(jumpState.chargeMode).toBe('run');

    resetJump();
    jumpState.phase = 'charging';
    resetPlayerKeys();
    playerKeyState.w = true;
    const walking = controllerHarness();
    walking.run();
    expect(jumpState.chargeMode).toBe('squat');
    expect(walking.position).toEqual({ x: 0, z: 0 });

    resetJump();
    jumpState.phase = 'charging';
    resetPlayerKeys();
    controllerHarness().run();
    expect(jumpState.chargeMode).toBe('squat');

    resetJump();
    jumpState.phase = 'launch';
    controllerHarness().run();
    expect(jumpState.chargeMode).toBe('none');
  });

  test('interact false suppresses interactEdge while escapeEdge still fires', () => {
    const intent = derive({
      capabilities: resolvePlayerCapabilities({ interact: false }),
      interactEdge: true,
      escapeEdge: true,
    });
    expect([intent.interactEdge, intent.escapeEdge]).toEqual([false, true]);
  });

  test('held E is edge-triggered exactly once across ten frames', () => {
    playerKeyState.e = true;
    let interactions = 0;
    const h = controllerHarness({
      onInteractEdge: () => {
        interactions += 1;
      },
    });
    for (let index = 0; index < 10; index += 1) h.run();
    expect(interactions).toBe(1);
  });

  test('cameraOrbitKeys false zeroes keyboard and shared-touch camera inputs', () => {
    playerKeyState.arrowleft = true;
    setPlayerTouchCamera(1, 1);
    const intent = derive({
      capabilities: resolvePlayerCapabilities({ cameraOrbitKeys: false }),
      policy: KELP_POLICY.input,
    });
    expect([intent.cameraYawInput, intent.cameraPitchInput]).toEqual([0, 0]);
  });

  test('kelp camera input flips only arrow yaw while preserving touch and pitch signs', () => {
    playerKeyState.arrowleft = true;
    playerKeyState.arrowup = true;
    setPlayerTouchCamera(0.25, 0.5);
    const intent = derive({ policy: KELP_POLICY.input });
    expect([intent.cameraYawInput, intent.cameraPitchInput]).toEqual([-0.75, 1.5]);
  });

  test('derivation is zero-allocation when the caller reuses its out object', () => {
    playerKeyState.w = true;
    const input: DerivePlayerFrameIntentInput = {
      camera,
      capabilities: DEFAULT_PLAYER_CAPABILITIES,
      policy: WORLD_VRM_POLICY.input,
      storeJoystick: { x: 0, y: 0 },
      jumpPhase: 'grounded',
      playerAltitude: 0,
      chargeMode: 'none',
    };
    const out: PlayerFrameIntent = {
      move: {
        worldVx: 0,
        worldVz: 0,
        moving: false,
        running: false,
        speedMultiplier: 1,
      },
      cameraYawInput: 0,
      cameraPitchInput: 0,
      interactEdge: false,
      escapeEdge: false,
      inputAirborne: false,
      renderAirborne: false,
      chargeMode: 'none',
      squatHold: false,
    };
    for (let index = 0; index < 10_000; index += 1) {
      expect(derivePlayerFrameIntent(input, out)).toBe(out);
    }
  });

  test('capability resolution forces verticalSwim off when jump is masked', () => {
    expect(resolvePlayerCapabilities({
      jump: false,
      verticalSwim: true,
    })).toEqual({
      ...DEFAULT_PLAYER_CAPABILITIES,
      jump: false,
      verticalSwim: false,
    });
    expect(playerTouchState).toEqual({ moveX: 0, moveZ: 0, yaw: 0, pitch: 0 });
  });
});
