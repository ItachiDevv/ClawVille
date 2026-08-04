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
