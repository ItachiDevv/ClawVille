import * as THREE from 'three';
import { addStageWindowListener } from '@/components/three/world-stage/stage-store';
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

export const RUN_SPEED_MULT = 1.5;
export const RUN_JOYSTICK_THRESHOLD = 0.7;

export const playerCameraForwardScratch = new THREE.Vector3();
export const playerCameraRightScratch = new THREE.Vector3();
export const playerWorldUpScratch = new THREE.Vector3(0, 1, 0);

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
  const onKeyDown = (event: KeyboardEvent) => {
    if (
      policy.keyTargetGuard === 'isEditable' &&
      isEditable(event.target)
    ) {
      return;
    }
    const key = eventKey(event, policy.keyIdentity);
    if (
      policy.preventArrowDefault &&
      key !== null &&
      key.startsWith('arrow')
    ) {
      event.preventDefault();
    }
    if (key === 'shift') {
      playerKeyState.shift = true;
      return;
    }
    playerKeyState.shift = event.shiftKey;
    if (key !== null) playerKeyState[key] = true;
  };
  const onKeyUp = (event: KeyboardEvent) => {
    const key = eventKey(event, policy.keyIdentity);
    if (key === 'shift') {
      playerKeyState.shift = false;
      return;
    }
    playerKeyState.shift = event.shiftKey;
    if (key !== null) playerKeyState[key] = false;
  };
  const removeKeyDown = addStageWindowListener('keydown', onKeyDown);
  const removeKeyUp = addStageWindowListener('keyup', onKeyUp);
  const reset = () => {
    resetPlayerKeys();
    resetPlayerTouch();
  };
  const unregisterReset = registerInputReset(reset);
  return () => {
    removeKeyDown();
    removeKeyUp();
    unregisterReset();
    reset();
  };
}
