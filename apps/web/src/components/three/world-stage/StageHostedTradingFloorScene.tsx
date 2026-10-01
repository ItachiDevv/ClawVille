'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useThree } from '@react-three/fiber';
import type { Camera, Scene } from 'three/webgpu';
import TradingFloorInteriorScene from '@/lib/three/trading-floor/trading-floor-interior';
import { TRADING_FLOOR_CAMERA_FAR } from '@/lib/three/trading-floor/trading-floor-room';
import { useSceneActive } from './use-scene-frame';
import { useStageStore } from './stage-store';
import {
  withStageSlotFrustumCullingDisabled,
  withStageSlotFrustumCullingDisabledSync,
} from './resource-ledger';
import { warmStageSlotRenderer } from './stage-warmup-entry-manager';
import { TRADING_FLOOR_SCENE_ID } from './stage-scene-id';

type GpuDrainTimer = {
  schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  cancel: (timer: ReturnType<typeof setTimeout>) => void;
};

/** Wait for work submitted by the direct warm draw. All paths fail open. */
export async function waitForTradingFloorGpuDrain(
  renderer: unknown,
  timeoutMs = 3000,
  timers: GpuDrainTimer = {
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (timer) => clearTimeout(timer),
  },
): Promise<void> {
  try {
    const render = renderer as {
      backend?: { device?: { queue?: { onSubmittedWorkDone?: () => Promise<void> } }; gl?: WebGL2RenderingContext };
      getContext?: () => WebGL2RenderingContext;
    };
    const submitted = render.backend?.device?.queue?.onSubmittedWorkDone;
    if (typeof submitted === 'function') {
      await new Promise<void>((resolve) => {
        const timer = timers.schedule(resolve, timeoutMs);
        try {
          void submitted.call(render.backend!.device!.queue).then(
            () => { timers.cancel(timer); resolve(); },
            () => { timers.cancel(timer); resolve(); },
          );
        } catch {
          timers.cancel(timer);
          resolve();
        }
      });
      return;
    }

    const context = render.backend?.gl ?? render.getContext?.();
    if (!context || typeof context.fenceSync !== 'function' ||
        typeof context.getSyncParameter !== 'function' ||
        typeof context.deleteSync !== 'function' || typeof context.flush !== 'function') return;
    const sync = context.fenceSync(context.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!sync) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      let pollTimer: ReturnType<typeof setTimeout> | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (pollTimer !== undefined) timers.cancel(pollTimer);
        if (deadline !== undefined) timers.cancel(deadline);
        try { context.deleteSync(sync); } catch { /* fail open */ }
        resolve();
      };
      const poll = () => {
        try {
          if (context.getSyncParameter(sync, context.SYNC_STATUS) === context.SIGNALED) {
            finish();
          } else {
            pollTimer = timers.schedule(poll, 16);
          }
        } catch {
          finish();
        }
      };
      deadline = timers.schedule(finish, timeoutMs);
      try {
        context.flush();
        poll();
      } catch {
        finish();
      }
    });
  } catch {
    // GPU drain is a best-effort warm barrier, never a transition blocker.
  }
}

/**
 * Lazy stage slot for the Trading Floor interior.
 *
 * Mirrors StageHostedCoveScene: warm the renderer (compileAsync, then a direct
 * warm) BEFORE acknowledging readiness, so the transition never reveals an
 * unpiped scene. `assetReady` fires once the room and avatar have mounted, or
 * after the bounded avatar fallback —
 * unlike the cove it is not gated on an auto-fit pass, because the Trading
 * Floor hall is authored at final scale.
 */
export default function StageHostedTradingFloorScene() {
  const generation = useStageStore(
    (state) => state.scenes[TRADING_FLOOR_SCENE_ID]?.generation ?? 0,
  );
  const requested = useStageStore(
    (state) => state.pendingRequest?.sceneId === TRADING_FLOOR_SCENE_ID,
  );
  const cameraInstalled = useStageStore(
    (state) =>
      state.cameraInstalled?.sceneId === TRADING_FLOOR_SCENE_ID &&
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
      .setSceneWarming(TRADING_FLOOR_SCENE_ID, generation);
  }, [generation, requested]);

  // Defensive re-assert of the room-diagonal far plane after the stage installs
  // this slot's camera. WorldStageRoot already builds the persistent camera with
  // TRADING_FLOOR_CAMERA_FAR from the same constant, so this only matters if a
  // future writer clobbers `far` during the swap — an under-sized far plane
  // slices the far wall and reads as a sweeping black void
  // (memory feedback_threejs_far_plane_dark_void).
  useEffect(() => {
    if (!cameraInstalled) return;
    if (camera.far !== TRADING_FLOOR_CAMERA_FAR) {
      camera.far = TRADING_FLOOR_CAMERA_FAR;
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
      const slot = state.scenes[TRADING_FLOOR_SCENE_ID];
      return (
        !cancelled &&
        slot?.generation === generation &&
        state.pendingRequest?.sceneId === TRADING_FLOOR_SCENE_ID &&
        state.pendingRequest.generation === generation
      );
    };

    void (async () => {
      const state = useStageStore.getState();
      state.setRenderPaused(true);
      const compileAsync =
        typeof (gl as { compileAsync?: unknown }).compileAsync === 'function'
          ? () =>
              withStageSlotFrustumCullingDisabled(TRADING_FLOOR_SCENE_ID, () =>
                (
                  gl as unknown as {
                    compileAsync: (scene: Scene, camera: Camera) => Promise<void>;
                  }
                ).compileAsync(scene, camera),
              )
          : undefined;
      const result = await warmStageSlotRenderer({
        slotId: TRADING_FLOOR_SCENE_ID,
        gl,
        warmedRenderer: warmedRendererRef.current?.gl ?? null,
        compile: compileAsync,
        directWarm: async () => {
          withStageSlotFrustumCullingDisabledSync(TRADING_FLOOR_SCENE_ID, () => {
            gl.render(scene, camera);
          });
          await waitForTradingFloorGpuDrain(gl);
        },
        isCurrent,
        onCompileRejected: (error) => {
          console.warn(
            '[TradingFloorStage] compileAsync failed; continuing to direct warm:',
            error,
          );
        },
        onCompileTimedOut: () => {
          console.warn(
            '[TradingFloorStage] compileAsync exceeded 20s; bypassing it for this renderer',
          );
        },
        onDirectWarmRejected: (error) => {
          console.warn('[TradingFloorStage] direct warm failed; continuing:', error);
        },
      });
      if (result.status !== 'completed' || !isCurrent()) return;
      warmedRendererRef.current = { gl: result.warmedRenderer };
      const current = useStageStore.getState();
      current.setRenderPaused(false);
      current.ackReady(TRADING_FLOOR_SCENE_ID, generation);
    })();

    return () => {
      cancelled = true;
      useStageStore.getState().setRenderPaused(false);
    };
  }, [assetReady, camera, cameraInstalled, generation, gl, requested, scene]);

  const handleReady = useCallback(() => setAssetReady(true), []);

  return <TradingFloorInteriorScene active={active} onReady={handleReady} />;
}
