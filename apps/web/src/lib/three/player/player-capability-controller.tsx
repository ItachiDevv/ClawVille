'use client';

import { createNavigationStep, stepNavigationPath, type NavigationPoint } from '../navigation-path-step';
import { isWorldInputBlocked, isWorldFrameBlocked } from '../world-input-guard';
import { useEffect, useRef } from 'react';
import type { RootState } from '@react-three/fiber';
import {
  useSceneActive,
  useSceneFrame,
} from '@/components/three/world-stage/use-scene-frame';
import { useGameStore } from '@/stores/game';
import { jumpState } from '@/lib/three/jump-state';
import type { PlayerCapabilityMask } from './player-capability-mask';
import {
  attachPlayerKeyListeners,
  playerKeyState,
  resetPlayerKeys,
  resetPlayerTouch,
  RUN_JOYSTICK_THRESHOLD,
  RUN_SPEED_MULT,
} from './player-input';
import {
  derivePlayerFrameIntent,
  type PlayerFrameIntent,
} from './player-intent';
import type {
  PlayerInputPolicy,
  PlayerMotionPolicy,
} from './player-motion-policy';

export interface AreaFrameResult {
  readonly navigationPath?: { points: readonly NavigationPoint[]; index: number; originX?: number; originZ?: number; arrivalTolerance?: number; onProgress: (index: number) => void; onComplete: () => void };
  readonly moveOverride?: {
    readonly worldVx: number;
    readonly worldVz: number;
    readonly maxDistance?: number;
  };
  readonly consumeFrame?: boolean;
}

export interface PlayerMoveResult {
  x: number;
  z: number;
  groundY: number;
}

export interface PlayerSpaceAdapter {
  readonly speedPerSec: number;
  readPosition(out: { x: number; z: number }): void;
  clampMovement(
    prevX: number,
    prevZ: number,
    desiredX: number,
    desiredZ: number,
    out: PlayerMoveResult,
  ): void;
  commitPosition(result: PlayerMoveResult): void;
}

export interface PlayerCapabilityControllerConfig {
  readonly sceneId: string | null;
  readonly capabilities: PlayerCapabilityMask;
  readonly motion: PlayerMotionPolicy;
  readonly input: PlayerInputPolicy;
  readonly space: PlayerSpaceAdapter;
  readonly isFrozen?: () => boolean;
  readonly isDriving: () => boolean;
  readonly onFrameStart?: (position: {
    readonly x: number;
    readonly z: number;
  }) => void;
  readonly isEscapeEdgeEnabled?: () => boolean;
  readonly isInteractEdgeEnabled?: () => boolean;
  readonly onEscapeWhileFrozen?: () => void;
  readonly onInteractEdge?: () => AreaFrameResult | void;
  readonly onNavigationOverride?: (
    intent: PlayerFrameIntent,
  ) => AreaFrameResult | void;
  readonly onDirection?: (
    dir: 'idle' | 'up' | 'down' | 'left' | 'right',
  ) => void;
  readonly onAfterMove?: (
    state: PlayerControllerFrameState,
    rawDelta: number,
    elapsed: number,
  ) => void;
  readonly onActivationReset?: () => void;
  readonly framePriority?: number;
}

export interface PlayerControllerFrameState {
  readonly x: number;
  readonly z: number;
  readonly groundY: number;
  readonly facing: number;
  readonly moving: boolean;
  readonly running: boolean;
  readonly inputAirborne: boolean;
  readonly renderAirborne: boolean;
  readonly jumpHeight: number;
  readonly intent: PlayerFrameIntent;
  readonly integrationDelta: number;
  readonly rawDelta: number;
}

export interface PlayerControllerTestRuntime {
  facing: number;
  lastE: boolean;
  lastEscape: boolean;
  wasCharging: boolean;
  intent: PlayerFrameIntent;
}

export const DEFAULT_PLAYER_FRAME_PRIORITY = -100;

const navigationStep = createNavigationStep();
const navigationPoint = { x: 0, y: 0 };
const noJoystick = Object.freeze({ x: 0, y: 0 });
const frameStartPosition = { x: 0, z: 0 };
const committedPosition = { x: 0, z: 0 };
const moveResult: PlayerMoveResult = { x: 0, z: 0, groundY: 0 };

function shortestFacingDelta(target: number, current: number): number {
  let difference = target - current;
  while (difference > Math.PI) difference -= Math.PI * 2;
  while (difference < -Math.PI) difference += Math.PI * 2;
  return difference;
}

function directionFor(
  vx: number,
  vz: number,
): 'idle' | 'up' | 'down' | 'left' | 'right' {
  if (vx === 0 && vz === 0) return 'idle';
  return Math.abs(vx) > Math.abs(vz)
    ? vx > 0 ? 'right' : 'left'
    : vz > 0 ? 'down' : 'up';
}

function runPlayerControllerFrame(
  config: PlayerCapabilityControllerConfig,
  runtime: PlayerControllerTestRuntime,
  state: RootState,
  rawDelta: number,
): void {
  if (isWorldInputBlocked()) { resetPlayerKeys(); resetPlayerTouch(); }
  if (isWorldFrameBlocked()) { config.onDirection?.('idle'); return; }
  config.space.readPosition(frameStartPosition);
  config.onFrameStart?.(frameStartPosition);

  const escapeNow = playerKeyState.escape;
  const escapeEdge = escapeNow && !runtime.lastEscape;
  const escapeEnabled = config.isEscapeEdgeEnabled?.() ?? true;
  if (config.isFrozen?.() ?? false) {
    if (escapeEnabled) {
      if (escapeEdge) config.onEscapeWhileFrozen?.();
      runtime.lastEscape = escapeNow;
    }
    return;
  }
  runtime.lastEscape = escapeNow;

  const interactEnabled = config.isInteractEdgeEnabled?.() ?? true;
  let interactEdge = false;
  if (config.capabilities.interact && interactEnabled) {
    const interactNow = playerKeyState.e;
    interactEdge = interactNow && !runtime.lastE;
    if (interactEdge) {
      const result = config.onInteractEdge?.();
      runtime.lastE = interactNow;
      if (result?.consumeFrame) return;
    } else {
      runtime.lastE = interactNow;
    }
  }

  const driving = config.isDriving();
  if (
    driving &&
    config.capabilities.jump &&
    config.capabilities.verticalSwim
  ) {
    const inputAirborne =
      jumpState.phase !== 'grounded' || jumpState.playerAltitude > 0;
    if (inputAirborne) {
      const verticalInput =
        Number(playerKeyState.arrowup) - Number(playerKeyState.arrowdown);
      if (verticalInput !== 0) {
        jumpState.playerAltitude = Math.max(
          0,
          jumpState.playerAltitude +
            verticalInput * config.space.speedPerSec * rawDelta,
        );
      } else if (
        jumpState.phase === 'grounded' &&
        jumpState.playerAltitude > 0
      ) {
        jumpState.playerAltitude = Math.max(
          0,
          jumpState.playerAltitude -
            config.space.speedPerSec * 0.6 * rawDelta,
        );
      }
    }
  }

  const storeJoystick = isWorldInputBlocked() ? noJoystick : useGameStore.getState().joystickVelocity;
  const intent = derivePlayerFrameIntent(
    {
      camera: state.camera,
      capabilities: config.capabilities,
      policy: config.input,
      storeJoystick,
      jumpPhase: jumpState.phase,
      playerAltitude: jumpState.playerAltitude,
      chargeMode: jumpState.chargeMode,
      interactEdge,
      escapeEdge,
      keys: playerKeyState,
    },
    runtime.intent,
  );
  if (!driving && intent.move.moving) {
    const move = intent.move as {
      worldVx: number;
      worldVz: number;
      moving: boolean;
      running: boolean;
      speedMultiplier: number;
    };
    move.worldVx = 0;
    move.worldVz = 0;
    move.moving = false;
    move.running = false;
    move.speedMultiplier = 1;
  }

  let navigationPath: AreaFrameResult['navigationPath'];
  let navigationDistance = Number.POSITIVE_INFINITY;
  if (config.capabilities.clickPath) {
    const override = config.onNavigationOverride?.(intent);
    if (override?.consumeFrame) return;
    navigationPath = override?.navigationPath;
    if (override?.moveOverride) {
      navigationDistance = override.moveOverride.maxDistance ?? Number.POSITIVE_INFINITY;
      const overrideLength = Math.hypot(
        override.moveOverride.worldVx,
        override.moveOverride.worldVz,
      );
      const moving = overrideLength > config.input.movementEpsilon;
      const running =
        config.capabilities.sprint &&
        moving &&
        (playerKeyState.shift ||
          Math.hypot(storeJoystick.x, storeJoystick.y) > RUN_JOYSTICK_THRESHOLD);
      const move = intent.move as {
        worldVx: number;
        worldVz: number;
        moving: boolean;
        running: boolean;
        speedMultiplier: number;
      };
      move.worldVx = override.moveOverride.worldVx;
      move.worldVz = override.moveOverride.worldVz;
      move.moving = moving;
      move.running = running;
      move.speedMultiplier = running ? RUN_SPEED_MULT : 1;
    }
  }

  let vx = intent.move.worldVx;
  let vz = intent.move.worldVz;
  const length = Math.hypot(vx, vz);
  if (
    config.input.composition === 'storeJoystickPrecedence' &&
    vx !== 0 &&
    vz !== 0 &&
    length > 1
  ) {
    vx /= length;
    vz /= length;
  }

  if (!navigationPath) config.onDirection?.(directionFor(vx, vz));

  if (config.capabilities.jump && config.motion.chargeDiscrimination) {
    const charging = jumpState.phase === 'charging';
    if (charging && !runtime.wasCharging) {
      jumpState.chargeMode = intent.move.running ? 'run' : 'squat';
    } else if (!charging && runtime.wasCharging) {
      jumpState.chargeMode = 'none';
    }
    runtime.wasCharging = charging;
    if (charging && jumpState.chargeMode === 'squat') {
      vx = 0;
      vz = 0;
    }
  }

  const integrationDelta =
    config.motion.maxDeltaSeconds === undefined
      ? rawDelta
      : Math.min(rawDelta, config.motion.maxDeltaSeconds);
  let completeNavigation: (() => void) | undefined;
  if (navigationPath) {
    const originX = navigationPath.originX ?? 0, originZ = navigationPath.originZ ?? 0;
    const budget = (vx !== 0 || vz !== 0) ? config.space.speedPerSec * intent.move.speedMultiplier * integrationDelta : 0;
    const step = stepNavigationPath(navigationPath.points, navigationPath.index, frameStartPosition.x + originX, frameStartPosition.z + originZ, budget, (x, z, nextX, nextZ) => {
      config.space.clampMovement(x - originX, z - originZ, nextX - originX, nextZ - originZ, moveResult);
      navigationPoint.x = moveResult.x + originX; navigationPoint.y = moveResult.z + originZ;
      return navigationPoint;
    }, navigationStep, navigationPath.arrivalTolerance);
    moveResult.x = step.x - originX; moveResult.z = step.y - originZ;
    config.space.commitPosition(moveResult);
    if (step.index !== navigationPath.index) navigationPath.onProgress(step.index);
    const move = intent.move as { worldVx: number; worldVz: number; moving: boolean; running: boolean };
    move.moving = step.traveled > 0;
    move.worldVx = move.moving ? step.vx : 0; move.worldVz = move.moving ? step.vy : 0;
    if (!move.moving) move.running = false;
    config.onDirection?.(directionFor(move.worldVx, move.worldVz));
    if (step.complete) completeNavigation = navigationPath.onComplete;
  } else if (vx !== 0 || vz !== 0) {
    const step = Math.min(config.space.speedPerSec * intent.move.speedMultiplier * integrationDelta, navigationDistance);
    const desiredX = frameStartPosition.x + vx * step;
    const desiredZ = frameStartPosition.z + vz * step;
    config.space.clampMovement(
      frameStartPosition.x,
      frameStartPosition.z,
      desiredX,
      desiredZ,
      moveResult,
    );
    config.space.commitPosition(moveResult);
  } else {
    moveResult.x = frameStartPosition.x;
    moveResult.z = frameStartPosition.z;
  }

  if (intent.move.moving) {
    const targetFacing = Math.atan2(
      intent.move.worldVx,
      intent.move.worldVz,
    );
    const difference = shortestFacingDelta(targetFacing, runtime.facing);
    runtime.facing +=
      config.motion.facing.kind === 'fixedFraction'
        ? difference * config.motion.facing.fraction
        : difference *
          (1 - Math.exp(-config.motion.facing.rate * integrationDelta));
  }

  config.space.readPosition(committedPosition);
  const inputAirborne =
    config.capabilities.jump &&
    (jumpState.phase !== 'grounded' || jumpState.playerAltitude > 0);
  const renderAirborne =
    config.capabilities.jump &&
    ((jumpState.phase !== 'grounded' && jumpState.phase !== 'charging') ||
      jumpState.playerAltitude > 0);
  config.onAfterMove?.(
    {
      x: committedPosition.x,
      z: committedPosition.z,
      groundY: moveResult.groundY,
      facing: runtime.facing,
      moving: intent.move.moving,
      running: intent.move.running,
      inputAirborne,
      renderAirborne,
      jumpHeight: config.capabilities.jump
        ? jumpState.heightOffset + jumpState.playerAltitude
        : 0,
      intent,
      integrationDelta,
      rawDelta,
    },
    rawDelta,
    state.clock.elapsedTime,
  );
  completeNavigation?.();
}

export function createPlayerControllerTestRuntime(
  motion: PlayerMotionPolicy,
): PlayerControllerTestRuntime {
  return {
    facing: motion.initialFacing,
    lastE: false,
    lastEscape: false,
    wasCharging: false,
    intent: {
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
    },
  };
}

export function runPlayerControllerFrameForTests(
  config: PlayerCapabilityControllerConfig,
  runtime: PlayerControllerTestRuntime,
  state: RootState,
  rawDelta: number,
): void {
  runPlayerControllerFrame(config, runtime, state, rawDelta);
}

export function usePlayerCapabilityController(
  config: PlayerCapabilityControllerConfig,
): void {
  const active = useSceneActive();
  const configRef = useRef(config);
  configRef.current = config;
  const runtimeRef = useRef<PlayerControllerTestRuntime>(
    createPlayerControllerTestRuntime(config.motion),
  );
  const wasActiveRef = useRef(false);

  useEffect(() => {
    if (!active) {
      resetPlayerKeys();
      resetPlayerTouch();
      wasActiveRef.current = false;
      return;
    }
    if (!wasActiveRef.current) {
      if (config.motion.resetFacingOnActivation) {
        runtimeRef.current.facing = config.motion.initialFacing;
      }
      config.onActivationReset?.();
      wasActiveRef.current = true;
    }
    return attachPlayerKeyListeners(config.input);
  }, [active, config.input, config.motion.initialFacing, config.motion.resetFacingOnActivation]);

  useSceneFrame((state, delta) => {
    runPlayerControllerFrame(
      configRef.current,
      runtimeRef.current,
      state,
      delta,
    );
  }, config.framePriority ?? DEFAULT_PLAYER_FRAME_PRIORITY);
}
