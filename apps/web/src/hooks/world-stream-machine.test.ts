import { describe, expect, test } from 'bun:test';
import {
  ACTIVE_IDLE_KEEPALIVE_INTERVAL_MS,
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
    poseChanged: false,
    activeActivity: 'idle',
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
    let state: WorldStreamMachineState = {
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

  test('still active presence is silent until each idle keepalive boundary', () => {
    let state: WorldStreamMachineState = {
      ...createWorldStreamMachineState(),
      everActive: true,
      previousPolicy: 'active',
    };

    const first = tick(state, {
      policy: 'active',
      hasSession: true,
      now: 0,
    });
    expect(first.actions).toEqual([]);

    const early = tick(first.nextState, {
      policy: 'active',
      hasSession: true,
      now: ACTIVE_IDLE_KEEPALIVE_INTERVAL_MS - 1,
    });
    expect(early.actions).toEqual([]);

    const due = tick(early.nextState, {
      policy: 'active',
      hasSession: true,
      now: ACTIVE_IDLE_KEEPALIVE_INTERVAL_MS,
    });
    expect(due.actions).toEqual(['UPLOAD_ACTIVE']);

    const nextEarly = tick(due.nextState, {
      policy: 'active',
      hasSession: true,
      now: ACTIVE_IDLE_KEEPALIVE_INTERVAL_MS * 2 - 1,
    });
    expect(nextEarly.actions).toEqual([]);

    const nextDue = tick(nextEarly.nextState, {
      policy: 'active',
      hasSession: true,
      now: ACTIVE_IDLE_KEEPALIVE_INTERVAL_MS * 2,
    });
    expect(nextDue.actions).toEqual(['UPLOAD_ACTIVE']);
  });

  test('movement emits on the first changed tick and each sustained changed tick', () => {
    let state: WorldStreamMachineState = {
      ...createWorldStreamMachineState(),
      everActive: true,
      previousPolicy: 'active',
    };

    const first = tick(state, {
      policy: 'active',
      hasSession: true,
      poseChanged: true,
      activeActivity: 'walking',
    });
    expect(first.actions).toEqual(['UPLOAD_ACTIVE']);

    const sustained = tick(first.nextState, {
      policy: 'active',
      hasSession: true,
      now: 200,
      poseChanged: true,
      activeActivity: 'walking',
    });
    expect(sustained.actions).toEqual(['UPLOAD_ACTIVE']);
  });

  test('movement stop emits one terminal idle sample then stays silent', () => {
    const moving = tick(
      {
        ...createWorldStreamMachineState(),
        everActive: true,
        previousPolicy: 'active',
      },
      {
        policy: 'active',
        hasSession: true,
        poseChanged: true,
        activeActivity: 'walking',
      },
    );

    const stopped = tick(moving.nextState, {
      policy: 'active',
      hasSession: true,
      now: 200,
      activeActivity: 'idle',
    });
    expect(stopped.actions).toEqual(['UPLOAD_ACTIVE']);

    const stillStopped = tick(stopped.nextState, {
      policy: 'active',
      hasSession: true,
      now: 400,
      activeActivity: 'idle',
    });
    expect(stillStopped.actions).toEqual([]);
  });

  test('heading-only pose changes and activity transitions emit', () => {
    const headingOnly = tick(
      {
        ...createWorldStreamMachineState(),
        everActive: true,
        previousPolicy: 'active',
      },
      {
        policy: 'active',
        hasSession: true,
        poseChanged: true,
        activeActivity: 'idle',
      },
    );
    expect(headingOnly.actions).toEqual(['UPLOAD_ACTIVE']);

    const activityTransition = tick(headingOnly.nextState, {
      policy: 'active',
      hasSession: true,
      now: 200,
      poseChanged: false,
      activeActivity: 'walking',
    });
    expect(activityTransition.actions).toEqual(['UPLOAD_ACTIVE']);
  });

  test('409 recovery is spaced, capped, and suspends uploads', () => {
    let state: WorldStreamMachineState = {
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
