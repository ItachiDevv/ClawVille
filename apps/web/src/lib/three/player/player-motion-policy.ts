export type PlayerFacingMode =
  | { readonly kind: 'fixedFraction'; readonly fraction: number }
  | { readonly kind: 'exponentialRate'; readonly rate: number };

export interface PlayerMotionPolicy {
  readonly maxDeltaSeconds?: number;
  readonly facing: PlayerFacingMode;
  readonly initialFacing: number;
  readonly resetFacingOnActivation: boolean;
  readonly chargeDiscrimination: boolean;
}

export interface PlayerInputPolicy {
  readonly composition: 'storeJoystickPrecedence' | 'additive';
  readonly readsStoreJoystick: boolean;
  readonly readsSharedTouch: boolean;
  readonly keyIdentity: 'key' | 'code';
  readonly keyTargetGuard: 'isEditable' | 'none';
  readonly preventArrowDefault: boolean;
  readonly movementEpsilon: number;
}

export const WORLD_VRM_POLICY = Object.freeze({
  motion: Object.freeze({
    maxDeltaSeconds: undefined,
    facing: Object.freeze({ kind: 'fixedFraction' as const, fraction: 0.15 }),
    initialFacing: Math.PI,
    resetFacingOnActivation: false,
    chargeDiscrimination: true,
  }),
  input: Object.freeze({
    composition: 'storeJoystickPrecedence' as const,
    readsStoreJoystick: true,
    readsSharedTouch: false,
    keyIdentity: 'key' as const,
    keyTargetGuard: 'isEditable' as const,
    preventArrowDefault: false,
    movementEpsilon: 0,
  }),
});

export const WORLD_GLB_POLICY = Object.freeze({
  motion: Object.freeze({
    maxDeltaSeconds: undefined,
    facing: Object.freeze({ kind: 'fixedFraction' as const, fraction: 0.15 }),
    initialFacing: 0,
    resetFacingOnActivation: false,
    chargeDiscrimination: false,
  }),
  input: WORLD_VRM_POLICY.input,
});

/**
 * Interior rooms entered from the world stage (Trading Floor).
 *
 * Same shape as KELP_POLICY — both are self-contained slots with their own
 * touch joysticks and no store joystick — but kept as its own constant so a
 * room-feel tweak cannot silently retune the kelp maze.
 */
export const TRADING_FLOOR_POLICY = Object.freeze({
  motion: Object.freeze({
    maxDeltaSeconds: 0.1,
    facing: Object.freeze({ kind: 'exponentialRate' as const, rate: 12 }),
    // Facing -Z: the player walks IN through the +Z door, so the room opens
    // in front of them on arrival.
    initialFacing: Math.PI,
    resetFacingOnActivation: true,
    chargeDiscrimination: false,
  }),
  input: Object.freeze({
    composition: 'additive' as const,
    readsStoreJoystick: false,
    readsSharedTouch: true,
    keyIdentity: 'code' as const,
    // 'isEditable', NOT kelp's 'none': this room mounts the Exchange modal,
    // which has real text inputs. With 'none', typing a bid amount would walk
    // the avatar and fire E behind the panel.
    keyTargetGuard: 'isEditable' as const,
    preventArrowDefault: true,
    movementEpsilon: 0.001,
  }),
});

export const KELP_POLICY = Object.freeze({
  motion: Object.freeze({
    maxDeltaSeconds: 0.1,
    facing: Object.freeze({ kind: 'exponentialRate' as const, rate: 10 }),
    initialFacing: Math.PI,
    resetFacingOnActivation: true,
    chargeDiscrimination: false,
  }),
  input: Object.freeze({
    composition: 'additive' as const,
    readsStoreJoystick: false,
    readsSharedTouch: true,
    keyIdentity: 'code' as const,
    keyTargetGuard: 'none' as const,
    preventArrowDefault: true,
    movementEpsilon: 0.001,
  }),
});
