export type ActivityTerminalBranch =
  | 'lobby'
  | 'avatar-loading'
  | 'no-avatar'
  | 'not-live'
  | 'unsupported'
  | 'room-error'
  | 'resolving-room'
  | 'closed'
  | 'scene-chunk-error'
  | 'canvas-lost';

export interface ActivityReadinessInput {
  readonly roomKey: string;
  readonly targetRoomKey: string | null;
  readonly pendingGeneration: number | null;
  readonly recoveryCount: number;
  readonly attemptNonce: number;
  readonly paintedRoomKey: string | null;
  readonly terminalBranch: ActivityTerminalBranch | null;
  readonly terminalRoomKey: string | null;
  readonly ackedKey: string | null;
}

export type ActivityReadinessDecision =
  | { readonly kind: 'ACK'; readonly generation: number; readonly ackKey: string }
  | {
      readonly kind: 'WAIT';
      readonly reason:
        | 'no-pending-request'
        | 'already-acked'
        | 'wrong-room'
        | 'not-painted';
    };

export function decideActivityReadiness(
  input: ActivityReadinessInput,
): ActivityReadinessDecision {
  if (input.pendingGeneration === null) {
    return { kind: 'WAIT', reason: 'no-pending-request' };
  }
  const ackKey = `${input.pendingGeneration}:${input.recoveryCount}:${input.attemptNonce}`;
  if (input.ackedKey === ackKey) {
    return { kind: 'WAIT', reason: 'already-acked' };
  }
  if (
    input.targetRoomKey !== null &&
    input.roomKey !== input.targetRoomKey
  ) {
    return { kind: 'WAIT', reason: 'wrong-room' };
  }
  const terminalReady =
    input.terminalBranch !== null &&
    input.terminalRoomKey === input.roomKey;
  if (
    input.paintedRoomKey !== input.roomKey &&
    !terminalReady
  ) {
    return { kind: 'WAIT', reason: 'not-painted' };
  }
  return {
    kind: 'ACK',
    generation: input.pendingGeneration,
    ackKey,
  };
}
