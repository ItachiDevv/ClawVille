export interface PlayerCapabilityMask {
  readonly move: boolean;
  readonly sprint: boolean;
  readonly jump: boolean;
  /** Arrow up/down altitude while airborne + grounded auto-sink. Forced false when jump is false. */
  readonly verticalSwim: boolean;
  readonly emotes: boolean;
  readonly interact: boolean;
  readonly clickPath: boolean;
  readonly cameraOrbitKeys: boolean;
}

export const DEFAULT_PLAYER_CAPABILITIES: PlayerCapabilityMask = Object.freeze({
  move: true,
  sprint: true,
  jump: true,
  verticalSwim: true,
  emotes: true,
  interact: true,
  clickPath: true,
  cameraOrbitKeys: true,
});

export function resolvePlayerCapabilities(
  overrides?: Partial<PlayerCapabilityMask>,
): PlayerCapabilityMask {
  const resolved = {
    ...DEFAULT_PLAYER_CAPABILITIES,
    ...overrides,
  };
  if (!resolved.jump) resolved.verticalSwim = false;
  return resolved;
}
