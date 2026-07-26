'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useThree } from '@react-three/fiber';
import type { Camera, Scene } from 'three/webgpu';
import CoveInteriorScene from '@/lib/three/cove-interior';
import { useSceneActive } from './use-scene-frame';
import { useStageStore } from './stage-store';

const COVE_SCENE_ID = 'cove';

export default function StageHostedCoveScene({
  onSceneEmpty,
}: {
  onSceneEmpty: () => void;
}) {
  const generation = useStageStore(
    (state) => state.scenes[COVE_SCENE_ID]?.generation ?? 0,
  );
  const requested = useStageStore(
    (state) => state.pendingRequest?.sceneId === COVE_SCENE_ID,
  );
  const cameraInstalled = useStageStore(
    (state) =>
      state.cameraInstalled?.sceneId === COVE_SCENE_ID &&
      state.cameraInstalled.generation === generation,
  );
  const active = useSceneActive();
  const [assetReady, setAssetReady] = useState(false);
  const warmedOnceRef = useRef(false);
  const { camera, gl, scene } = useThree();

  useEffect(() => {
    if (!requested || generation <= 0) return;
    useStageStore
      .getState()
      .setSceneWarming(COVE_SCENE_ID, generation);
  }, [generation, requested]);

  useEffect(() => {
    if (
      !assetReady ||
      !requested ||
      !cameraInstalled ||
      generation <= 0
    ) {
      return;
    }
    let cancelled = false;
    const isCurrent = (): boolean => {
      const state = useStageStore.getState();
      const slot = state.scenes[COVE_SCENE_ID];
      return (
        !cancelled &&
        slot?.generation === generation &&
        state.pendingRequest?.sceneId === COVE_SCENE_ID &&
        state.pendingRequest.generation === generation
      );
    };

    void (async () => {
      const state = useStageStore.getState();
      state.setRenderPaused(true);
      if (!warmedOnceRef.current) {
        try {
          if (typeof (gl as { compileAsync?: unknown }).compileAsync === 'function') {
            await (
              gl as unknown as {
                compileAsync: (
                  scene: Scene,
                  camera: Camera,
                ) => Promise<void>;
              }
            ).compileAsync(scene, camera);
          }
          if (!isCurrent()) return;
          gl.render(scene, camera);
          warmedOnceRef.current = true;
        } catch (error) {
          console.warn('[CoveStage] warmup failed; continuing:', error);
        }
      }
      if (!isCurrent()) return;
      const current = useStageStore.getState();
      current.setRenderPaused(false);
      current.ackReady(COVE_SCENE_ID, generation);
    })();

    return () => {
      cancelled = true;
      useStageStore.getState().setRenderPaused(false);
    };
  }, [
    assetReady,
    camera,
    cameraInstalled,
    generation,
    gl,
    requested,
    scene,
  ]);

  const handleReady = useCallback(() => setAssetReady(true), []);

  return (
    <CoveInteriorScene
      active={active}
      onReady={handleReady}
      onSceneEmpty={onSceneEmpty}
    />
  );
}
