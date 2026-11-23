import { afterEach, describe, expect, test } from 'bun:test';
import { needsBrainchainPanelFallback, retireBrainchainFallbackRequest } from './brainchain-stage-fallback';
import { requestStageScene, resetStageStore, useStageStore } from './stage-store';

afterEach(() => resetStageStore());

describe('BrainChain panel fallback', () => {
  test('2D and renderer failures retain the Office panel only on its route', () => {
    expect(needsBrainchainPanelFallback('/brainchain', '2d', false, false, false)).toBe(true);
    expect(needsBrainchainPanelFallback('/brainchain', '3d', true, false, false)).toBe(true);
    expect(needsBrainchainPanelFallback('/brainchain', '3d', false, true, false)).toBe(true);
    expect(needsBrainchainPanelFallback('/brainchain', '3d', false, false, true)).toBe(true);
    expect(needsBrainchainPanelFallback('/brainchain', '3d', false, false, false)).toBe(false);
    expect(needsBrainchainPanelFallback('/game', '2d', false, false, false)).toBe(false);
  });
  test.each(['world', 'brainchain'])('retires an unacknowledged %s request and permits return to town', (scene) => {
    resetStageStore();
    useStageStore.getState().registerScenes(['world', 'brainchain']);
    requestStageScene(scene);
    const previousRequest = useStageStore.getState().pendingRequest!;
    useStageStore.getState().setRenderPaused(true);
    retireBrainchainFallbackRequest();
    expect(useStageStore.getState().pendingRequest).toBeNull();
    expect(useStageStore.getState().transition).toBeNull();
    expect(useStageStore.getState().renderPaused).toBe(false);
    requestStageScene('world');
    expect(useStageStore.getState().pendingRequest?.sceneId).toBe('world');
    expect(useStageStore.getState().pendingRequest?.requestId).toBeGreaterThan(previousRequest.requestId);
  });
});
