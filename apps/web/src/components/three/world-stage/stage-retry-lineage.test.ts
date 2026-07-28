import { beforeEach, describe, expect, test } from 'bun:test';
import {
  requestStageScene,
  retryStageScene,
  useStageStore,
} from './stage-store';
import {
  decideStageNavigationOwnership,
} from './stage-navigation-ownership';
import {
  rekeyParkedNavigationForRetry,
  takeParkedNavigationForOpaque,
} from './stage-navigation-lineage';

beforeEach(() => {
  useStageStore.getState().resetStage();
  useStageStore.getState().registerScenes(['world', 'cove']);
});

describe('retry request lineage', () => {
  test('an exact current request mints one atomic child request', () => {
    requestStageScene('world');
    const parent = useStageStore.getState().pendingRequest!;
    expect(retryStageScene(parent)).toBe(true);
    const child = useStageStore.getState().pendingRequest!;
    expect(child).toMatchObject({
      sceneId: 'world',
      requestId: parent.requestId + 1,
      generation: parent.generation + 1,
      retryOfRequestId: parent.requestId,
    });
  });

  test('a stale watchdog retry after supersession is a no-op', () => {
    requestStageScene('world');
    const stale = useStageStore.getState().pendingRequest!;
    requestStageScene('cove');
    const current = useStageStore.getState().pendingRequest;
    expect(retryStageScene(stale)).toBe(false);
    expect(useStageStore.getState().pendingRequest).toEqual(current);
  });

  test('a parked parent matches its exact retry child once', () => {
    const navigation = { to: '/game' as const };
    const parked = { requestId: 7, navigation };
    const request = {
      sceneId: 'world',
      generation: 2,
      requestId: 8,
      retryOfRequestId: 7,
    };
    const first = takeParkedNavigationForOpaque(parked, request);
    expect(first.navigation).toBe(navigation);
    expect(first.remaining).toBeNull();
    expect(
      takeParkedNavigationForOpaque(first.remaining, request).navigation,
    ).toBeNull();
  });

  test('lineage is inert when no navigation is parked', () => {
    expect(
      takeParkedNavigationForOpaque(null, {
        sceneId: 'world',
        generation: 2,
        requestId: 8,
        retryOfRequestId: 7,
      }),
    ).toEqual({ remaining: null, navigation: null });
  });

  test('CAS re-key does not clobber a new ADOPT already parked under the retry id', () => {
    const newlyAdopted = {
      requestId: 8,
      navigation: { to: '/game' as const, marker: 'new-adopt' },
    };
    const request = {
      sceneId: 'world',
      generation: 2,
      requestId: 8,
      retryOfRequestId: 7,
    };
    expect(
      rekeyParkedNavigationForRetry(newlyAdopted, request),
    ).toBe(newlyAdopted);
  });

  test('same-scene navigation after the midpoint executes immediately', () => {
    expect(
      decideStageNavigationOwnership({
        targetSceneId: 'world',
        pendingRequest: {
          sceneId: 'world',
          generation: 1,
          requestId: 1,
        },
        transitionPhase: 'awaiting',
      }),
    ).toBe('EXECUTE_NOW');
  });

  test('different-scene navigation supersedes and invalidates the stale retry', () => {
    requestStageScene('world');
    const stale = useStageStore.getState().pendingRequest!;
    expect(
      decideStageNavigationOwnership({
        targetSceneId: 'cove',
        pendingRequest: stale,
        transitionPhase: 'fadingOut',
      }),
    ).toBe('SUPERSEDE');
    requestStageScene('cove');
    expect(useStageStore.getState().pendingRequest?.sceneId).toBe('cove');
    expect(retryStageScene(stale)).toBe(false);
  });

  test('completion removes lineage with pendingRequest', () => {
    requestStageScene('world');
    const parent = useStageStore.getState().pendingRequest!;
    retryStageScene(parent);
    const child = useStageStore.getState().pendingRequest!;
    useStageStore.getState().ackReady('world', child.generation);
    useStageStore.getState().completeTransition(child);
    expect(useStageStore.getState().pendingRequest).toBeNull();
  });

  test('failure retains lineage until supersede or reset', () => {
    requestStageScene('world');
    const parent = useStageStore.getState().pendingRequest!;
    retryStageScene(parent);
    const child = useStageStore.getState().pendingRequest!;
    useStageStore.getState().failTransition(child, 'expected failure');
    expect(useStageStore.getState().pendingRequest).toEqual(child);
    expect(
      useStageStore.getState().pendingRequest?.retryOfRequestId,
    ).toBe(parent.requestId);
  });

  test('reset increments stageEpoch even though request ids are reusable', () => {
    const epoch = useStageStore.getState().stageEpoch;
    requestStageScene('world');
    expect(useStageStore.getState().pendingRequest?.requestId).toBe(1);
    useStageStore.getState().resetStage();
    useStageStore.getState().registerScenes(['world']);
    requestStageScene('world');
    expect(useStageStore.getState().stageEpoch).toBe(epoch + 1);
    expect(useStageStore.getState().pendingRequest?.requestId).toBe(1);
  });
});
