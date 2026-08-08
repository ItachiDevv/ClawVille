import * as THREE from 'three';
import {
  addStageEventListener,
  addStageWindowListener,
} from '@/components/three/world-stage/stage-store';
import { registerInputReset } from '@/lib/three/input-reset';
import { isEditable } from '@/lib/three/jump-state';
import type { PlayerInputPolicy } from './player-motion-policy';

export interface PlayerKeyState {
  w: boolean;
  a: boolean;
  s: boolean;
  d: boolean;
  arrowup: boolean;
  arrowdown: boolean;
  arrowleft: boolean;
  arrowright: boolean;
  e: boolean;
  escape: boolean;
  shift: boolean;
}

export const playerKeyState: PlayerKeyState = {
  w: false,
  a: false,
  s: false,
  d: false,
  arrowup: false,
  arrowdown: false,
  arrowleft: false,
  arrowright: false,
  e: false,
  escape: false,
  shift: false,
};

export const playerTouchState = {
  moveX: 0,
  moveZ: 0,
  yaw: 0,
  pitch: 0,
};

/** Founder playtest 2026-08-08: run pace raised 35% (1.5 → 2.025). */
export const RUN_SPEED_MULT = 2.025;
export const RUN_JOYSTICK_THRESHOLD = 0.7;

export const playerCameraForwardScratch = new THREE.Vector3();
export const playerCameraRightScratch = new THREE.Vector3();
export const playerWorldUpScratch = new THREE.Vector3(0, 1, 0);

export interface HeldKeyListenerConfig {
  /** 'code' → event.code (activity + kelp); 'key' → event.key.toLowerCase() (world). */
  readonly keyIdentity: 'code' | 'key';
  /** 'isEditable' skips keydown when the target is an input/textarea/contentEditable. */
  readonly keyTargetGuard: 'isEditable' | 'none';
  /** Return true to preventDefault this keydown. */
  readonly onKeyDown: (
    identity: string,
    event: KeyboardEvent,
  ) => boolean;
  /** keyup is deliberately not target-guarded. */
  readonly onKeyUp: (
    identity: string,
    event: KeyboardEvent,
  ) => void;
  /** Registered through registerInputReset for blur/visibility/focus/pageshow. */
  readonly onReset: () => void;
  /** Registered through the string-typed stage helper for custom events. */
  readonly extra?: ReadonlyArray<{
    type: string;
    listener: EventListener;
    options?: AddEventListenerOptions;
  }>;
}

export function attachHeldKeyListeners(
  config: HeldKeyListenerConfig,
): () => void {
  const identityFor = (event: KeyboardEvent) =>
    config.keyIdentity === 'code'
      ? event.code
      : event.key.toLowerCase();
  const onKeyDown = (event: KeyboardEvent) => {
    if (
      config.keyTargetGuard === 'isEditable' &&
      isEditable(event.target)
    ) {
      return;
    }
    if (config.onKeyDown(identityFor(event), event)) {
      event.preventDefault();
    }
  };
  const onKeyUp = (event: KeyboardEvent) => {
    config.onKeyUp(identityFor(event), event);
  };

  const removeKeyDown = addStageWindowListener('keydown', onKeyDown);
  const removeKeyUp = addStageWindowListener('keyup', onKeyUp);
  const removeExtra = (config.extra ?? []).map(
    ({ type, listener, options }) =>
      addStageEventListener(window, type, listener, options),
  );
  const unregisterReset = registerInputReset(config.onReset);

  return () => {
    removeKeyDown();
    removeKeyUp();
    for (const remove of removeExtra) remove();
    unregisterReset();
    config.onReset();
  };
}

export function resetPlayerKeys(): void {
  for (const key of Object.keys(playerKeyState) as Array<keyof PlayerKeyState>) {
    playerKeyState[key] = false;
  }
}

export function setPlayerTouchMove(x: number, z: number): void {
  playerTouchState.moveX = x;
  playerTouchState.moveZ = z;
}

export function setPlayerTouchCamera(yaw: number, pitch: number): void {
  playerTouchState.yaw = yaw;
  playerTouchState.pitch = pitch;
}

export function resetPlayerTouch(): void {
  playerTouchState.moveX = 0;
  playerTouchState.moveZ = 0;
  playerTouchState.yaw = 0;
  playerTouchState.pitch = 0;
}

function codeKey(code: string): keyof PlayerKeyState | null {
  switch (code) {
    case 'KeyW': return 'w';
    case 'KeyA': return 'a';
    case 'KeyS': return 's';
    case 'KeyD': return 'd';
    case 'ArrowUp': return 'arrowup';
    case 'ArrowDown': return 'arrowdown';
    case 'ArrowLeft': return 'arrowleft';
    case 'ArrowRight': return 'arrowright';
    case 'KeyE': return 'e';
    case 'Escape': return 'escape';
    case 'ShiftLeft':
    case 'ShiftRight':
      return 'shift';
    default:
      return null;
  }
}

function eventKey(
  event: KeyboardEvent,
  identity: PlayerInputPolicy['keyIdentity'],
): keyof PlayerKeyState | null {
  if (identity === 'code') return codeKey(event.code ?? '');
  const key = (event.key ?? '').toLowerCase() as keyof PlayerKeyState;
  return key in playerKeyState ? key : null;
}

export function attachPlayerKeyListeners(
  policy: PlayerInputPolicy,
): () => void {
  return attachHeldKeyListeners({
    keyIdentity: policy.keyIdentity,
    keyTargetGuard: policy.keyTargetGuard,
    onKeyDown: (_identity, event) => {
      const key = eventKey(event, policy.keyIdentity);
      const shouldPrevent =
        policy.preventArrowDefault &&
        key !== null &&
        key.startsWith('arrow');
      if (key === 'shift') {
        playerKeyState.shift = true;
        return shouldPrevent;
      }
      playerKeyState.shift = event.shiftKey;
      if (key !== null) playerKeyState[key] = true;
      return shouldPrevent;
    },
    onKeyUp: (_identity, event) => {
      const key = eventKey(event, policy.keyIdentity);
      if (key === 'shift') {
        playerKeyState.shift = false;
        return;
      }
      playerKeyState.shift = event.shiftKey;
      if (key !== null) playerKeyState[key] = false;
    },
    onReset: () => {
      resetPlayerKeys();
      resetPlayerTouch();
    },
  });
}
