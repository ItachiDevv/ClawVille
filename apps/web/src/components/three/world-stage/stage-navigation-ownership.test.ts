import { describe, expect, test } from 'bun:test';
import { decideStageNavigationOwnership } from './stage-navigation-ownership';

const pending = {
  sceneId: 'activity',
  requestId: 7,
  generation: 2,
};

describe('stage navigation ownership destination identity', () => {
  test('different activity destination supersedes during fadingOut', () => {
    expect(
      decideStageNavigationOwnership({
        targetSceneId: 'activity',
        targetDestinationKey: 'activity:reef:C',
        pendingDestinationKey: 'activity:reef:B',
        pendingRequest: pending,
        transitionPhase: 'fadingOut',
      }),
    ).toBe('SUPERSEDE');
  });

  test('different activity destination supersedes during awaiting', () => {
    expect(
      decideStageNavigationOwnership({
        targetSceneId: 'activity',
        targetDestinationKey: 'activity:reef:C',
        pendingDestinationKey: 'activity:reef:B',
        pendingRequest: pending,
        transitionPhase: 'awaiting',
      }),
    ).toBe('SUPERSEDE');
  });

  test('same activity destination still adopts during fadingOut', () => {
    expect(
      decideStageNavigationOwnership({
        targetSceneId: 'activity',
        targetDestinationKey: 'activity:reef:B',
        pendingDestinationKey: 'activity:reef:B',
        pendingRequest: pending,
        transitionPhase: 'fadingOut',
      }),
    ).toBe('ADOPT');
  });

  test('same activity destination still executes after the midpoint', () => {
    expect(
      decideStageNavigationOwnership({
        targetSceneId: 'activity',
        targetDestinationKey: 'activity:reef:B',
        pendingDestinationKey: 'activity:reef:B',
        pendingRequest: pending,
        transitionPhase: 'awaiting',
      }),
    ).toBe('EXECUTE_NOW');
  });

  test('omitting both destination keys preserves the anchor behavior', () => {
    expect(
      decideStageNavigationOwnership({
        targetSceneId: 'activity',
        pendingRequest: pending,
        transitionPhase: 'fadingOut',
      }),
    ).toBe('ADOPT');
    expect(
      decideStageNavigationOwnership({
        targetSceneId: 'activity',
        pendingRequest: pending,
        transitionPhase: 'idle',
      }),
    ).toBe('EXECUTE_NOW');
  });
});
