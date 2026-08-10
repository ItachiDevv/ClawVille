'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useThree } from '@react-three/fiber';
import type { Camera, Scene } from 'three/webgpu';
import CoveInteriorScene, { COVE_CAMERA_FAR } from '@/lib/three/cove-interior';
import { useSceneActive } from './use-scene-frame';
import { useStageStore } from './stage-store';
import { withStageSlotFrustumCullingDisabled } from './resource-ledger';
import { warmStageSlotRenderer } from './stage-warmup-entry-manager';

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
  const warmedRendererRef = useRef<{ gl: unknown } | null>(null);
  const { camera, gl, scene } = useThree();

  useEffect(() => {
    if (!requested || generation <= 0) return;
    useStageStore
      .getState()
      .setSceneWarming(COVE_SCENE_ID, generation);
  }, [generation, requested]);

  // Room-scale-derived far plane (re-land of the CoveCanvas 2026-07-11 fix):
  // the stage's static cove scene config carries a flat far=2000, which
  // undershoots the room's 3D bbox diagonal (COVE_CAMERA_FAR — knob-derived
  // in cove-interior.tsx) and far-clips the interior. Applied only after the stage's
  // camera install for this generation, so the install write cannot clobber
  // it; switching back to the world re-installs that scene's own camera.
  // Lives in this lazy chunk so WorldStageRoot never eagerly imports the
  // cove-interior module for one constant.
  useEffect(() => {
    if (!cameraInstalled) return;
    if (camera.far !== COVE_CAMERA_FAR) {
      camera.far = COVE_CAMERA_FAR;
      camera.updateProjectionMatrix();
    }
  }, [camera, cameraInstalled]);

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
      const compileAsync =
        typeof (gl as { compileAsync?: unknown }).compileAsync === 'function'
          ? () =>
              withStageSlotFrustumCullingDisabled('cove', () =>
                (
                  gl as unknown as {
                    compileAsync: (
                      scene: Scene,
                      camera: Camera,
                    ) => Promise<void>;
                  }
                ).compileAsync(scene, camera),
              )
          : undefined;
      const result = await warmStageSlotRenderer({
        slotId: COVE_SCENE_ID,
        gl,
        warmedRenderer: warmedRendererRef.current?.gl ?? null,
        compile: compileAsync,
        directWarm: () =>
          withStageSlotFrustumCullingDisabled('cove', async () => {
            gl.render(scene, camera);
          }),
        isCurrent,
        onCompileRejected: (error) => {
          console.warn(
            '[CoveStage] compileAsync failed; continuing to direct warm:',
            error,
          );
        },
        onCompileTimedOut: () => {
          console.warn(
            '[CoveStage] compileAsync exceeded 20s; bypassing it for this renderer',
          );
        },
        onDirectWarmRejected: (error) => {
          console.warn(
            '[CoveStage] direct warm failed; continuing:',
            error,
          );
        },
      });
      if (result.status !== 'completed' || !isCurrent()) return;
      warmedRendererRef.current = { gl: result.warmedRenderer };
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
