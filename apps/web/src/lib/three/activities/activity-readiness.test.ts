import { describe, expect, test } from 'bun:test';
import {
  decideActivityReadiness,
  type ActivityReadinessInput,
  type ActivityTerminalBranch,
} from './activity-readiness';

const base: ActivityReadinessInput = {
  roomKey: 'reef:A',
  targetRoomKey: 'reef:A',
  pendingGeneration: 4,
  recoveryCount: 0,
  attemptNonce: 0,
  paintedRoomKey: 'reef:A',
  terminalBranch: null,
  terminalRoomKey: null,
  ackedKey: null,
};

describe('decideActivityReadiness', () => {
  test('rule 1 waits without a pending request', () => {
    expect(
      decideActivityReadiness({ ...base, pendingGeneration: null }),
    ).toEqual({ kind: 'WAIT', reason: 'no-pending-request' });
  });

  test('rule 2 rejects the wrong target room', () => {
    expect(
      decideActivityReadiness({ ...base, targetRoomKey: 'reef:B' }),
    ).toEqual({ kind: 'WAIT', reason: 'wrong-room' });
  });

  test('rule 3 suppresses an acknowledged attempt', () => {
    expect(
      decideActivityReadiness({ ...base, ackedKey: '4:0:0' }),
    ).toEqual({ kind: 'WAIT', reason: 'already-acked' });
  });

  test('rule 4 acknowledges a room-scoped terminal branch', () => {
    expect(
      decideActivityReadiness({
        ...base,
        paintedRoomKey: null,
        terminalBranch: 'closed',
        terminalRoomKey: 'reef:A',
      }),
    ).toEqual({ kind: 'ACK', generation: 4, ackKey: '4:0:0' });
  });

  test('rule 5 acknowledges its own painted room', () => {
    expect(decideActivityReadiness(base)).toEqual({
      kind: 'ACK',
      generation: 4,
      ackKey: '4:0:0',
    });
  });

  test('rule 6 waits for paint', () => {
    expect(
      decideActivityReadiness({ ...base, paintedRoomKey: null }),
    ).toEqual({ kind: 'WAIT', reason: 'not-painted' });
  });

  test('silent retry acknowledges the new generation without a repaint', () => {
    expect(
      decideActivityReadiness({
        ...base,
        pendingGeneration: 5,
        ackedKey: '4:0:0',
      }),
    ).toEqual({ kind: 'ACK', generation: 5, ackKey: '5:0:0' });
  });

  test('renderer recovery changes the acknowledgement key', () => {
    expect(
      decideActivityReadiness({
        ...base,
        recoveryCount: 1,
        ackedKey: '4:0:0',
      }),
    ).toEqual({ kind: 'ACK', generation: 4, ackKey: '4:1:0' });
  });

  test('same-scene room change waits on stale paint', () => {
    expect(
      decideActivityReadiness({
        ...base,
        roomKey: 'reef:B',
        targetRoomKey: 'reef:B',
      }),
    ).toEqual({ kind: 'WAIT', reason: 'not-painted' });
  });

  test('same-scene room change acknowledges the new paint', () => {
    expect(
      decideActivityReadiness({
        ...base,
        roomKey: 'reef:B',
        targetRoomKey: 'reef:B',
        paintedRoomKey: 'reef:B',
      }),
    ).toEqual({ kind: 'ACK', generation: 4, ackKey: '4:0:0' });
  });

  test('cold deep link waits before its request exists', () => {
    expect(
      decideActivityReadiness({ ...base, pendingGeneration: null }),
    ).toEqual({ kind: 'WAIT', reason: 'no-pending-request' });
  });

  test('cold deep link acknowledges after its request appears', () => {
    expect(decideActivityReadiness(base).kind).toBe('ACK');
  });

  test('stale-room paint never acknowledges', () => {
    expect(
      decideActivityReadiness({
        ...base,
        paintedRoomKey: 'reef:OLD',
      }),
    ).toEqual({ kind: 'WAIT', reason: 'not-painted' });
  });

  test.each([
    'lobby',
    'avatar-loading',
    'no-avatar',
    'not-live',
    'unsupported',
    'room-error',
    'resolving-room',
    'closed',
    'scene-chunk-error',
    'canvas-lost',
  ] satisfies ActivityTerminalBranch[])('%s is a terminal acknowledgement', (branch) => {
    expect(
      decideActivityReadiness({
        ...base,
        paintedRoomKey: null,
        terminalBranch: branch,
        terminalRoomKey: base.roomKey,
      }).kind,
    ).toBe('ACK');
  });

  test('is pure for identical inputs', () => {
    expect(decideActivityReadiness(base)).toEqual(
      decideActivityReadiness(base),
    );
  });

  test('caller acknowledgement makes a second evaluation inert', () => {
    const first = decideActivityReadiness(base);
    expect(first.kind).toBe('ACK');
    const ackedKey = first.kind === 'ACK' ? first.ackKey : null;
    expect(
      decideActivityReadiness({ ...base, ackedKey }),
    ).toEqual({ kind: 'WAIT', reason: 'already-acked' });
  });

  test('painted outgoing room cannot acknowledge an incoming target', () => {
    expect(
      decideActivityReadiness({
        ...base,
        targetRoomKey: 'reef:B',
      }),
    ).toEqual({ kind: 'WAIT', reason: 'wrong-room' });
  });

  test('terminal outgoing room cannot acknowledge an incoming target', () => {
    expect(
      decideActivityReadiness({
        ...base,
        targetRoomKey: 'reef:B',
        terminalBranch: 'closed',
        terminalRoomKey: 'reef:A',
      }),
    ).toEqual({ kind: 'WAIT', reason: 'wrong-room' });
  });

  test('scene-keyed target survives request and generation retry', () => {
    expect(
      decideActivityReadiness({
        ...base,
        pendingGeneration: 9,
        ackedKey: '4:0:0',
      }),
    ).toEqual({ kind: 'ACK', generation: 9, ackKey: '9:0:0' });
  });

  test('attempt nonce revokes the prior acknowledgement', () => {
    expect(
      decideActivityReadiness({
        ...base,
        attemptNonce: 1,
        paintedRoomKey: null,
        ackedKey: '4:0:0',
      }),
    ).toEqual({ kind: 'WAIT', reason: 'not-painted' });
  });

  test('retry after a completed transition has no pending request', () => {
    expect(
      decideActivityReadiness({
        ...base,
        pendingGeneration: null,
        attemptNonce: 1,
      }),
    ).toEqual({ kind: 'WAIT', reason: 'no-pending-request' });
  });

  test('null target remains scoped to the page own paint', () => {
    expect(
      decideActivityReadiness({
        ...base,
        targetRoomKey: null,
        paintedRoomKey: 'reef:OTHER',
      }),
    ).toEqual({ kind: 'WAIT', reason: 'not-painted' });
  });
});
