'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useThree } from '@react-three/fiber';
import type { Camera, Scene } from 'three/webgpu';
import BrainchainOfficeInterior from '@/lib/three/brainchain/brainchain-interior';
import { BRAINCHAIN_CAMERA_FAR } from '@/lib/three/brainchain/brainchain-room';
import { useSceneActive } from './use-scene-frame';
import { useStageStore } from './stage-store';
import {
  withStageSlotFrustumCullingDisabled,
  withStageSlotFrustumCullingDisabledSync,
} from './resource-ledger';
import { warmStageSlotRenderer } from './stage-warmup-entry-manager';
import { BRAINCHAIN_SCENE_ID } from './stage-scene-id';

import { waitForTradingFloorGpuDrain } from './stage-gpu-drain';
import { useBrainchainInteriorStore } from '@/components/brainchain/brainchain-interior-store';
import { useGameStore } from '@/stores/game';

/**
 * Lazy stage slot for the BrainChain Office interior.
 *
 * Mirrors StageHostedCoveScene: warm the renderer (compileAsync, then a direct
 * warm) BEFORE acknowledging readiness, so the transition never reveals an
 * unpiped scene. `assetReady` fires once the room and avatar have mounted, or
 * after the bounded avatar fallback ---
 * unlike the cove it is not gated on an auto-fit pass, because the Trading
 * Floor hall is authored at final scale.
 */
export default function StageHostedBrainchainScene() {
  const generation = useStageStore(
    (state) => state.scenes[BRAINCHAIN_SCENE_ID]?.generation ?? 0,
  );
  const requested = useStageStore(
    (state) => state.pendingRequest?.sceneId === BRAINCHAIN_SCENE_ID,
  );
  const cameraInstalled = useStageStore(
    (state) =>
      state.cameraInstalled?.sceneId === BRAINCHAIN_SCENE_ID &&
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
      .setSceneWarming(BRAINCHAIN_SCENE_ID, generation);
  }, [generation, requested]);

  // Defensive re-assert of the room-diagonal far plane after the stage installs
  // this slot's camera. WorldStageRoot already builds the persistent camera with
  // BRAINCHAIN_CAMERA_FAR from the same constant, so this only matters if a
  // future writer clobbers `far` during the swap --- an under-sized far plane
  // slices the far wall and reads as a sweeping black void
  // (memory feedback_threejs_far_plane_dark_void).
  useEffect(() => {
    if (!cameraInstalled) return;
    if (camera.far !== BRAINCHAIN_CAMERA_FAR) {
      camera.far = BRAINCHAIN_CAMERA_FAR;
      camera.updateProjectionMatrix();
    }
  }, [camera, cameraInstalled]);

  useEffect(() => {
    if (!assetReady || !requested || !cameraInstalled || generation <= 0) {
      return;
    }
    let cancelled = false;
    const isCurrent = (): boolean => {
      const state = useStageStore.getState();
      const slot = state.scenes[BRAINCHAIN_SCENE_ID];
      return (
        !cancelled &&
        slot?.generation === generation &&
        state.pendingRequest?.sceneId === BRAINCHAIN_SCENE_ID &&
        state.pendingRequest.generation === generation
      );
    };

    void (async () => {
      const state = useStageStore.getState();
      state.setRenderPaused(true);
      const compileAsync =
        typeof (gl as { compileAsync?: unknown }).compileAsync === 'function'
          ? () =>
              withStageSlotFrustumCullingDisabled(BRAINCHAIN_SCENE_ID, () =>
                (
                  gl as unknown as {
                    compileAsync: (scene: Scene, camera: Camera) => Promise<void>;
                  }
                ).compileAsync(scene, camera),
              )
          : undefined;
      const result = await warmStageSlotRenderer({
        slotId: BRAINCHAIN_SCENE_ID,
        gl,
        warmedRenderer: warmedRendererRef.current?.gl ?? null,
        compile: compileAsync,
        directWarm: async () => {
          withStageSlotFrustumCullingDisabledSync(BRAINCHAIN_SCENE_ID, () => {
            gl.render(scene, camera);
          });
          await waitForTradingFloorGpuDrain(gl);
        },
        isCurrent,
        onCompileRejected: (error) => {
          console.warn(
            '[BrainchainStage] compileAsync failed; continuing to direct warm:',
            error,
          );
        },
        onCompileTimedOut: () => {
          console.warn(
            '[BrainchainStage] compileAsync exceeded 20s; bypassing it for this renderer',
          );
        },
        onDirectWarmRejected: (error) => {
          console.warn('[BrainchainStage] direct warm failed; continuing:', error);
        },
      });
      if (result.status !== 'completed' || !isCurrent()) return;
      warmedRendererRef.current = { gl: result.warmedRenderer };
      const current = useStageStore.getState();
      current.setRenderPaused(false);
      current.ackReady(BRAINCHAIN_SCENE_ID, generation);
    })();

    return () => {
      cancelled = true;
      useStageStore.getState().setRenderPaused(false);
    };
  }, [assetReady, camera, cameraInstalled, generation, gl, requested, scene]);

  const section = useBrainchainInteriorStore((state) => state.section);
  const movementFrozen = useGameStore((state) => state.movementFrozen);
  const handleReady = useCallback(() => setAssetReady(true), []);

  return <BrainchainOfficeInterior active={active} onReady={handleReady}
    frozen={section !== null || movementFrozen}
    onOpen={useBrainchainInteriorStore.getState().open}
    onTalk={useBrainchainInteriorStore.getState().talk}
    onExit={useBrainchainInteriorStore.getState().requestExit} />;
}
