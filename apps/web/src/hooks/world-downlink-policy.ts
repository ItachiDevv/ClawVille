export type WorldDownlinkAction = 'OPEN' | 'CLOSE' | 'NONE';

export interface WorldDownlinkInput {
  readonly wanted: boolean;
  readonly open: boolean;
  readonly pendingReopen: boolean;
  readonly recoveryInFlight: boolean;
  readonly hasSession: boolean;
  readonly hasRoom: boolean;
}

export function decideWorldDownlink(
  input: WorldDownlinkInput,
): WorldDownlinkAction {
  if (!input.wanted && (input.open || input.pendingReopen)) return 'CLOSE';
  if (
    input.wanted &&
    !input.open &&
    !input.pendingReopen &&
    !input.recoveryInFlight &&
    input.hasSession &&
    input.hasRoom
  ) {
    return 'OPEN';
  }
  return 'NONE';
}
