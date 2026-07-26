import { describe, expect, test } from 'bun:test';
import {
  REMOTE_PRESENCE_INTERVAL_MS,
  createWorldStreamMachineState,
  decide,
  type WorldStreamMachineInput,
  type WorldStreamMachineState,
} from './world-stream-machine';

function tick(
  state: WorldStreamMachineState,
  overrides: Partial<Extract<WorldStreamMachineInput, { type: 'TICK' }>> = {},
) {
  return decide(state, {
    type: 'TICK',
    now: 0,
    policy: 'remote',
    hasSession: false,
    canUpload: true,
    hasFrozenPosition: false,
    recoveryInFlight: false,
    ...overrides,
  });
}

describe('world stream machine', () => {
  test('cold cove does not join or upload', () => {
    const decision = tick(createWorldStreamMachineState());
    expect(decision.actions).toEqual([]);
    expect(decision.nextState.everActive).toBe(false);
  });

  test('the first active flip bootstraps once', () => {
    const first = tick(createWorldStreamMachineState(), { policy: 'active' });
    expect(first.actions).toEqual(['RESET_ACTIVE_POSITION', 'BOOTSTRAP']);
    expect(first.nextState.everActive).toBe(true);
    expect(first.nextState.bootstrapInFlight).toBe(true);

    const second = tick(first.nextState, { policy: 'active', now: 200 });
    expect(second.actions).toEqual([]);
  });

  test('remote presence is limited to one upload per ten seconds', () => {
    let state = {
      ...createWorldStreamMachineState(),
      everActive: true,
      previousPolicy: 'active' as const,
    };
    const first = tick(state, {
      hasSession: true,
      hasFrozenPosition: true,
      now: 1_000,
    });
    expect(first.actions).toEqual(['UPLOAD_REMOTE']);

    const early = tick(first.nextState, {
      hasSession: true,
      hasFrozenPosition: true,
      now: 1_000 + REMOTE_PRESENCE_INTERVAL_MS - 1,
    });
    expect(early.actions).toEqual([]);

    const due = tick(early.nextState, {
      hasSession: true,
      hasFrozenPosition: true,
      now: 1_000 + REMOTE_PRESENCE_INTERVAL_MS,
    });
    expect(due.actions).toEqual(['UPLOAD_REMOTE']);
  });

  test('remote to active resets position before deriving the active upload', () => {
    const state = {
      ...createWorldStreamMachineState(),
      everActive: true,
      previousPolicy: 'remote' as const,
    };
    const decision = tick(state, {
      policy: 'active',
      hasSession: true,
      hasFrozenPosition: true,
    });
    expect(decision.actions).toEqual([
      'RESET_ACTIVE_POSITION',
      'UPLOAD_ACTIVE',
    ]);
  });

  test('409 recovery is spaced, capped, and suspends uploads', () => {
    let state = {
      ...createWorldStreamMachineState(),
      everActive: true,
      previousPolicy: 'active' as const,
    };
    state = decide(state, { type: 'POSITION_409', now: 1_000 }).nextState;

    for (let attempt = 0; attempt < 3; attempt++) {
      const recovery = tick(state, {
        policy: 'active',
        hasSession: true,
        hasFrozenPosition: true,
        now: state.nextRecoveryAt,
      });
      expect(recovery.actions).toEqual(['RECOVER']);
      state = decide(recovery.nextState, {
        type: 'RECOVERY_FAILED',
        now: state.nextRecoveryAt,
      }).nextState;
      expect(state.nextRecoveryAt).toBeGreaterThanOrEqual(
        (attempt === 0 ? 1_000 : 0) + 20_000,
      );
    }

    const exhausted = tick(state, {
      policy: 'active',
      hasSession: true,
      hasFrozenPosition: true,
      now: Number.MAX_SAFE_INTEGER,
    });
    expect(exhausted.actions).toEqual([]);
    expect(exhausted.nextState.uploadsSuspended).toBe(true);
  });

  test('supersession is terminal', () => {
    const terminal = decide(createWorldStreamMachineState(), {
      type: 'SUPERSEDED',
      now: 1,
    }).nextState;
    const later = tick(terminal, {
      policy: 'active',
      hasSession: true,
      hasFrozenPosition: true,
      now: Number.MAX_SAFE_INTEGER,
    });
    expect(later.actions).toEqual([]);
    expect(later.nextState).toBe(terminal);
  });
});
