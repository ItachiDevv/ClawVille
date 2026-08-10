import type { Camera } from 'three';
import type { ChargeMode, JumpPhase } from '@/lib/three/jump-state';
import type { PlayerCapabilityMask } from './player-capability-mask';
import {
  playerCameraForwardScratch,
  playerCameraRightScratch,
  playerKeyState,
  playerTouchState,
  playerWorldUpScratch,
  RUN_JOYSTICK_THRESHOLD,
  RUN_SPEED_MULT,
  type PlayerKeyState,
} from './player-input';
import type { PlayerInputPolicy } from './player-motion-policy';

export interface PlayerMoveIntent {
  readonly worldVx: number;
  readonly worldVz: number;
  readonly moving: boolean;
  readonly running: boolean;
  readonly speedMultiplier: number;
}

export interface PlayerFrameIntent {
  readonly move: PlayerMoveIntent;
  readonly cameraYawInput: number;
  readonly cameraPitchInput: number;
  readonly interactEdge: boolean;
  readonly escapeEdge: boolean;
  readonly inputAirborne: boolean;
  readonly renderAirborne: boolean;
  readonly chargeMode: ChargeMode;
  readonly squatHold: boolean;
}

export interface DerivePlayerFrameIntentInput {
  readonly camera: Camera;
  readonly capabilities: PlayerCapabilityMask;
  readonly policy: PlayerInputPolicy;
  readonly storeJoystick: { readonly x: number; readonly y: number };
  readonly jumpPhase: JumpPhase;
  readonly playerAltitude: number;
  readonly chargeMode: ChargeMode;
  readonly interactEdge?: boolean;
  readonly escapeEdge?: boolean;
  readonly keys?: Readonly<PlayerKeyState>;
}

type MutablePlayerMoveIntent = {
  worldVx: number;
  worldVz: number;
  moving: boolean;
  running: boolean;
  speedMultiplier: number;
};
type MutablePlayerFrameIntent = {
  move: MutablePlayerMoveIntent;
  cameraYawInput: number;
  cameraPitchInput: number;
  interactEdge: boolean;
  escapeEdge: boolean;
  inputAirborne: boolean;
  renderAirborne: boolean;
  chargeMode: ChargeMode;
  squatHold: boolean;
};

function createIntentOutput(): MutablePlayerFrameIntent {
  return {
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
}

export function derivePlayerFrameIntent(
  input: DerivePlayerFrameIntentInput,
  out?: PlayerFrameIntent,
): PlayerFrameIntent {
  const output = (out ?? createIntentOutput()) as MutablePlayerFrameIntent;
  const keys = input.keys ?? playerKeyState;
  let inputForward = 0;
  let inputRight = 0;

  if (input.capabilities.move) {
    const joystickX = input.policy.readsStoreJoystick
      ? input.storeJoystick.x
      : 0;
    const joystickY = input.policy.readsStoreJoystick
      ? input.storeJoystick.y
      : 0;
    if (
      input.policy.composition === 'storeJoystickPrecedence' &&
      (joystickX !== 0 || joystickY !== 0)
    ) {
      inputRight = joystickX;
      inputForward = -joystickY;
    } else {
      if (keys.w) inputForward += 1;
      if (keys.s) inputForward -= 1;
      if (keys.a) inputRight -= 1;
      if (keys.d) inputRight += 1;
      if (input.policy.readsSharedTouch) {
        inputRight += playerTouchState.moveX;
        inputForward += playerTouchState.moveZ;
      }
    }
  }

  if (input.policy.composition === 'additive') {
    const inputLength = Math.hypot(inputForward, inputRight);
    if (inputLength > 1) {
      inputForward /= inputLength;
      inputRight /= inputLength;
    }
  }

  let worldVx = 0;
  let worldVz = 0;
  if (inputForward !== 0 || inputRight !== 0) {
    input.camera.getWorldDirection(playerCameraForwardScratch);
    playerCameraForwardScratch.y = 0;
    const forwardLength = playerCameraForwardScratch.length();
    if (forwardLength > 0.001) {
      playerCameraForwardScratch.divideScalar(forwardLength);
      playerCameraRightScratch
        .crossVectors(playerCameraForwardScratch, playerWorldUpScratch)
        .normalize();
      worldVx =
        playerCameraForwardScratch.x * inputForward +
        playerCameraRightScratch.x * inputRight;
      worldVz =
        playerCameraForwardScratch.z * inputForward +
        playerCameraRightScratch.z * inputRight;
    }
  }

  const preNormalizeLength = Math.hypot(worldVx, worldVz);
  const moving = preNormalizeLength > input.policy.movementEpsilon;
  if (!moving) {
    worldVx = 0;
    worldVz = 0;
  } else if (input.policy.composition === 'additive') {
    if (preNormalizeLength > 1) {
      worldVx /= preNormalizeLength;
      worldVz /= preNormalizeLength;
    }
  } else if (worldVx !== 0 && worldVz !== 0 && preNormalizeLength > 1) {
    worldVx /= preNormalizeLength;
    worldVz /= preNormalizeLength;
  }
  // THREE's cross product can produce signed zero for cardinal movement.
  // Canonicalize it so the pure intent surface is stable for exact consumers.
  if (Object.is(worldVx, -0)) worldVx = 0;
  if (Object.is(worldVz, -0)) worldVz = 0;

  const joystickMagnitude = input.policy.readsStoreJoystick
    ? Math.hypot(input.storeJoystick.x, input.storeJoystick.y)
    : 0;
  // Shared-touch scenes (kelp) have no store joystick; a full-tilt touch
  // joystick is their sprint trigger, mirroring the store-joystick threshold.
  const touchMagnitude = input.policy.readsSharedTouch
    ? Math.hypot(playerTouchState.moveX, playerTouchState.moveZ)
    : 0;
  const running =
    input.capabilities.sprint &&
    moving &&
    (keys.shift ||
      joystickMagnitude > RUN_JOYSTICK_THRESHOLD ||
      touchMagnitude > RUN_JOYSTICK_THRESHOLD);
  const inputAirborne =
    input.capabilities.jump &&
    (input.jumpPhase !== 'grounded' || input.playerAltitude > 0);
  const renderAirborne =
    input.capabilities.jump &&
    ((input.jumpPhase !== 'grounded' && input.jumpPhase !== 'charging') ||
      input.playerAltitude > 0);
  const chargeMode = input.capabilities.jump ? input.chargeMode : 'none';

  output.move.worldVx = worldVx;
  output.move.worldVz = worldVz;
  output.move.moving = moving;
  output.move.running = running;
  output.move.speedMultiplier = running ? RUN_SPEED_MULT : 1;
  output.cameraYawInput = input.capabilities.cameraOrbitKeys
    ? Number(keys.arrowright) -
      Number(keys.arrowleft) +
      (input.policy.readsSharedTouch ? playerTouchState.yaw : 0)
    : 0;
  output.cameraPitchInput = input.capabilities.cameraOrbitKeys
    ? Number(keys.arrowup) -
      Number(keys.arrowdown) +
      (input.policy.readsSharedTouch ? playerTouchState.pitch : 0)
    : 0;
  output.interactEdge =
    input.capabilities.interact && Boolean(input.interactEdge);
  output.escapeEdge = Boolean(input.escapeEdge);
  output.inputAirborne = inputAirborne;
  output.renderAirborne = renderAirborne;
  output.chargeMode = chargeMode;
  output.squatHold =
    input.capabilities.jump &&
    input.jumpPhase === 'charging' &&
    chargeMode === 'squat';
  return output;
}
