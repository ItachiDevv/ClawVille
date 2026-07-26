import { describe, expect, test } from 'bun:test';
import { decideStageNavigationOwnership } from './stage-navigation-ownership';

const pending = {
  sceneId: 'cove',
  requestId: 7,
  generation: 2,
};

describe('stage navigation ownership', () => {
  test('supersedes an error before considering scene identity', () => {
    expect(
      decideStageNavigationOwnership({
        targetSceneId: 'cove',
        pendingRequest: pending,
        transitionPhase: 'error',
      }),
    ).toBe('SUPERSEDE');
  });

  test('adopts the same scene only while fading out', () => {
    expect(
      decideStageNavigationOwnership({
        targetSceneId: 'cove',
        pendingRequest: pending,
        transitionPhase: 'fadingOut',
      }),
    ).toBe('ADOPT');
  });

  test.each(['awaiting', 'fadingIn', 'idle'] as const)(
    'executes immediately after the midpoint in %s',
    (transitionPhase) => {
      expect(
        decideStageNavigationOwnership({
          targetSceneId: 'cove',
          pendingRequest: pending,
          transitionPhase,
        }),
      ).toBe('EXECUTE_NOW');
    },
  );

  test('supersedes a different pending scene', () => {
    expect(
      decideStageNavigationOwnership({
        targetSceneId: 'world',
        pendingRequest: pending,
        transitionPhase: 'fadingOut',
      }),
    ).toBe('SUPERSEDE');
  });

  test('creates a new request when none is pending', () => {
    expect(
      decideStageNavigationOwnership({
        targetSceneId: 'cove',
        pendingRequest: null,
        transitionPhase: 'idle',
      }),
    ).toBe('SUPERSEDE');
  });
});
