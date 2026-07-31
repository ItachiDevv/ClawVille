'use client';

import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import { useStageStore } from './stage-store';
import { warmStageSlotRenderer } from './stage-warmup-entry-manager';
import { ACTIVITY_SCENE_ID } from './stage-scene-id';

export default function StageHostedActivityScene(): null {
  const generation = useStageStore(
    (state) => state.scenes[ACTIVITY_SCENE_ID]?.generation ?? 0,
  );
  const requested = useStageStore(
    (state) => state.pendingRequest?.sceneId === ACTIVITY_SCENE_ID,
  );
  const cameraInstalled = useStageStore(
    (state) =>
      state.cameraInstalled?.sceneId === ACTIVITY_SCENE_ID &&
      state.cameraInstalled.generation === generation,
  );
  const idle = useStageStore(
    (state) =>
      state.activeScene === ACTIVITY_SCENE_ID &&
      state.transition?.phase === 'idle',
  );
  const warmedRendererRef = useRef<{ gl: unknown } | null>(null);
  const { camera, gl, scene } = useThree();

  useEffect(() => {
    if (!requested || generation <= 0) return;
    useStageStore
      .getState()
      .setSceneWarming(ACTIVITY_SCENE_ID, generation);
  }, [generation, requested]);

  useEffect(() => {
    if (!requested || !cameraInstalled || generation <= 0) return;
    let cancelled = false;
    const isCurrent = (): boolean => {
      const state = useStageStore.getState();
      return (
        !cancelled &&
        state.scenes[ACTIVITY_SCENE_ID]?.generation === generation &&
        state.pendingRequest?.sceneId === ACTIVITY_SCENE_ID &&
        state.pendingRequest.generation === generation
      );
    };

    void warmStageSlotRenderer({
      slotId: ACTIVITY_SCENE_ID,
      gl,
      warmedRenderer: warmedRendererRef.current?.gl ?? null,
      compile: undefined,
      directWarm: async () => {
        gl.render(scene, camera);
      },
      isCurrent,
    }).then((result) => {
      if (result.status === 'completed' && isCurrent()) {
        warmedRendererRef.current = { gl: result.warmedRenderer };
      }
    });

    return () => {
      cancelled = true;
      useStageStore.getState().setRenderPaused(false);
    };
  }, [camera, cameraInstalled, generation, gl, requested, scene]);

  useEffect(() => {
    if (!idle) return;
    useStageStore.getState().setRenderPaused(true);
    return () => useStageStore.getState().setRenderPaused(false);
  }, [idle]);

  return null;
}
