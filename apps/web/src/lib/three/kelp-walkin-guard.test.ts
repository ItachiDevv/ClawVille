import { describe, expect, test } from 'bun:test';
import {
  decideKelpWalkIn,
  type KelpWalkInInput,
} from './kelp-walkin-guard';

function input(
  overrides: Partial<KelpWalkInInput> = {},
): KelpWalkInInput {
  return {
    nowMs: 1_000,
    legacyLatchArmed: false,
    nav: {
      mounted: true,
      handlerInstalled: true,
      bufferedTo: null,
      bufferedPathname: null,
      bufferedExpiresAt: null,
    },
    stageActiveScene: 'world',
    stagePendingSceneId: null,
    stageTransitionPhase: 'idle',
    legacyTransitionActive: false,
    legacyTransitionPending: false,
    ...overrides,
  };
}

describe('kelp walk-in ownership guard', () => {
  test('legacy active blocks even while the stage is mounted', () => {
    expect(
      decideKelpWalkIn(input({ legacyTransitionActive: true })),
    ).toEqual({
      kind: 'BLOCKED',
      reason: 'in-flight',
      releaseLegacyLatch: false,
    });
  });

  test('legacy pending blocks before any stage ownership rule', () => {
    expect(
      decideKelpWalkIn(input({ legacyTransitionPending: true })),
    ).toMatchObject({ kind: 'BLOCKED', reason: 'in-flight' });
  });

  test('a stale legacy latch self-heals and proceeds', () => {
    expect(
      decideKelpWalkIn(
        input({
          legacyLatchArmed: true,
          nav: {
            mounted: false,
            handlerInstalled: false,
            bufferedTo: null,
            bufferedPathname: null,
            bufferedExpiresAt: null,
          },
        }),
      ),
    ).toEqual({ kind: 'PROCEED', releaseLegacyLatch: true });
  });

  test('an unexpired buffered kelp request blocks a second trigger', () => {
    expect(
      decideKelpWalkIn(
        input({
          nav: {
            mounted: true,
            handlerInstalled: false,
            bufferedTo: '/kelp',
            bufferedPathname: '/kelp',
            bufferedExpiresAt: 1_001,
          },
        }),
      ),
    ).toMatchObject({ kind: 'BLOCKED', reason: 'in-flight' });
  });

  test('an unexpired buffered other destination is superseded', () => {
    expect(
      decideKelpWalkIn(
        input({
          nav: {
            mounted: true,
            handlerInstalled: false,
            bufferedTo: '/cove',
            bufferedPathname: '/cove',
            bufferedExpiresAt: 1_001,
          },
        }),
      ),
    ).toEqual({ kind: 'PROCEED', releaseLegacyLatch: false });
  });

  test('an expired buffered kelp entry falls through', () => {
    expect(
      decideKelpWalkIn(
        input({
          nav: {
            mounted: true,
            handlerInstalled: false,
            bufferedTo: '/kelp',
            bufferedPathname: '/kelp',
            bufferedExpiresAt: 999,
          },
        }),
      ),
    ).toEqual({ kind: 'PROCEED', releaseLegacyLatch: false });
  });

  test('pending kelp in terminal error is released for recovery', () => {
    expect(
      decideKelpWalkIn(
        input({
          stagePendingSceneId: 'kelp',
          stageTransitionPhase: 'error',
        }),
      ),
    ).toEqual({ kind: 'PROCEED', releaseLegacyLatch: false });
  });

  test('a normal pending kelp transition remains blocked', () => {
    expect(
      decideKelpWalkIn(
        input({
          stagePendingSceneId: 'kelp',
          stageTransitionPhase: 'fadingOut',
        }),
      ),
    ).toMatchObject({ kind: 'BLOCKED', reason: 'in-flight' });
  });

  test('settled active kelp reports already-there', () => {
    expect(
      decideKelpWalkIn(
        input({
          stageActiveScene: 'kelp',
          stagePendingSceneId: null,
        }),
      ),
    ).toMatchObject({ kind: 'BLOCKED', reason: 'already-there' });
  });

  test('active kelp with cove or world pending permits supersession', () => {
    for (const destination of ['cove', 'world']) {
      expect(
        decideKelpWalkIn(
          input({
            stageActiveScene: 'kelp',
            stagePendingSceneId: destination,
            stageTransitionPhase: 'fadingOut',
          }),
        ),
      ).toEqual({ kind: 'PROCEED', releaseLegacyLatch: false });
    }
  });

  test('mounted stage with no pending request takes the stage path', () => {
    expect(decideKelpWalkIn(input())).toEqual({
      kind: 'PROCEED',
      releaseLegacyLatch: false,
    });
  });

  test('unmounted stage proceeds to the legacy path', () => {
    expect(
      decideKelpWalkIn(
        input({
          nav: {
            mounted: false,
            handlerInstalled: false,
            bufferedTo: null,
            bufferedPathname: null,
            bufferedExpiresAt: null,
          },
        }),
      ),
    ).toEqual({ kind: 'PROCEED', releaseLegacyLatch: false });
  });

  test('a second entry after a complete round trip proceeds', () => {
    const first = decideKelpWalkIn(input());
    const second = decideKelpWalkIn(
      input({
        stageActiveScene: 'world',
        stagePendingSceneId: null,
        stageTransitionPhase: 'idle',
      }),
    );
    expect([first.kind, second.kind]).toEqual([
      'PROCEED',
      'PROCEED',
    ]);
  });

  test('a kelp request superseded by cove does not strand the next trigger', () => {
    expect(
      decideKelpWalkIn(
        input({
          stageActiveScene: 'world',
          stagePendingSceneId: 'cove',
          stageTransitionPhase: 'fadingOut',
        }),
      ),
    ).toEqual({ kind: 'PROCEED', releaseLegacyLatch: false });
  });

  test('a buffer expiring exactly now is not authoritative', () => {
    expect(
      decideKelpWalkIn(
        input({
          nav: {
            mounted: true,
            handlerInstalled: false,
            bufferedTo: '/kelp',
            bufferedPathname: '/kelp',
            bufferedExpiresAt: 1_000,
          },
        }),
      ),
    ).toEqual({ kind: 'PROCEED', releaseLegacyLatch: false });
  });

  test('rule 3 evaluates bufferedPathname instead of the full buffered href', () => {
    expect(
      decideKelpWalkIn(
        input({
          nav: {
            mounted: true,
            handlerInstalled: false,
            bufferedTo: '/cove',
            bufferedPathname: '/kelp',
            bufferedExpiresAt: 1_001,
          },
        }),
      ),
    ).toMatchObject({ kind: 'BLOCKED', reason: 'in-flight' });
  });

  test('rule 4 evaluates bufferedPathname and preserves supersession', () => {
    expect(
      decideKelpWalkIn(
        input({
          nav: {
            mounted: true,
            handlerInstalled: false,
            bufferedTo: '/kelp',
            bufferedPathname: '/cove',
            bufferedExpiresAt: 1_001,
          },
        }),
      ),
    ).toEqual({ kind: 'PROCEED', releaseLegacyLatch: false });
  });

  test('a buffered kelp href with a query still blocks through its pathname', () => {
    expect(
      decideKelpWalkIn(
        input({
          nav: {
            mounted: true,
            handlerInstalled: false,
            bufferedTo: '/kelp?x=1',
            bufferedPathname: '/kelp',
            bufferedExpiresAt: 1_001,
          },
        }),
      ),
    ).toMatchObject({ kind: 'BLOCKED', reason: 'in-flight' });
  });
});
