'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useThree } from '@react-three/fiber';
import type { Camera, Scene } from 'three/webgpu';
import KelpRealmScene from '@/lib/three/kelp-realm-scene';
import { kelpRealmPlayerPositionRef } from '@/lib/three/kelp-realm-player';
import {
  getKelpRealmClaimSnapshot,
} from '@/lib/three/kelp-realm-visit-state';
import {
  createKelpActivationLifecycle,
  createKelpActivationToken,
  type KelpActivationLifecycle,
  type KelpActivationToken,
} from '@/lib/three/kelp-activation';
import {
  describeErrorForBeacon,
  reportKelpRenderFailure,
  type KelpRenderFailureLane,
} from '@/lib/three/kelp-render-failure-beacon';
import { withStageSlotFrustumCullingDisabled } from './resource-ledger';
import { warmStageSlotRenderer } from './stage-warmup-entry-manager';
import { useSceneActive } from './use-scene-frame';
import { useStageStore } from './stage-store';

const KELP_SCENE_ID = 'kelp';
let hostedKelpMountCount = 0;

export function countKelpStageMeshes(scene: Scene): number {
  const root = scene.getObjectByName(
    `world-stage:${KELP_SCENE_ID}`,
  );
  let meshCount = 0;
  root?.traverse((object) => {
    if ((object as { isMesh?: boolean }).isMesh) {
      meshCount += 1;
    }
  });
  return meshCount;
}

export function isKelpStageWarmReady(input: {
  readonly token: KelpActivationToken;
  readonly resetsCompleteToken: symbol | null;
  readonly environmentReadyToken: symbol | null;
  readonly requested: boolean;
  readonly cameraInstalled: boolean;
  readonly generation: number;
  readonly meshCount: number;
}): boolean {
  return (
    input.resetsCompleteToken === input.token.id &&
    input.environmentReadyToken === input.token.id &&
    input.requested &&
    input.cameraInstalled &&
    input.generation > 0 &&
    input.meshCount > 0
  );
}

export function kelpRecoveryLaneForReason(
  reason: string | null,
): KelpRenderFailureLane | null {
  if (!reason) return null;
  if (reason.startsWith('webgpu-uncaptured-error:')) {
    return 'webgpu-unhealthy';
  }
  if (reason.startsWith('webgpu-device-lost:')) {
    return 'device-lost';
  }
  if (
    reason === 'visible-canvas-missing' ||
    reason === 'renderer-canvas-detached' ||
    reason === 'canvas-not-adopted'
  ) {
    return 'canvas-not-adopted';
  }
  return null;
}

export default function StageHostedKelpScene() {
  const generation = useStageStore(
    (state) => state.scenes[KELP_SCENE_ID]?.generation ?? 0,
  );
  const pendingRequest = useStageStore(
    (state) => state.pendingRequest,
  );
  const activeScene = useStageStore((state) => state.activeScene);
  const cameraInstalled = useStageStore(
    (state) =>
      state.cameraInstalled?.sceneId === KELP_SCENE_ID &&
      state.cameraInstalled.generation === generation,
  );
  const recovery = useStageStore((state) => state.recovery);
  const active = useSceneActive();
  const owned =
    activeScene === KELP_SCENE_ID ||
    pendingRequest?.sceneId === KELP_SCENE_ID;
  const requested =
    pendingRequest?.sceneId === KELP_SCENE_ID &&
    pendingRequest.generation === generation;
  const token = useMemo(
    () => createKelpActivationToken(generation),
    [generation],
  );
  const [resetsCompleteToken, setResetsCompleteToken] =
    useState<symbol | null>(null);
  const [environmentReadyToken, setEnvironmentReadyToken] =
    useState<symbol | null>(null);
  const lifecycleRef = useRef<KelpActivationLifecycle | null>(null);
  if (!lifecycleRef.current) {
    lifecycleRef.current = createKelpActivationLifecycle(
      token,
      owned,
      (completeToken) => {
        setResetsCompleteToken(completeToken.id);
      },
    );
  }
  lifecycleRef.current.update(token, owned);
  const activation = lifecycleRef.current.context;
  const warmedRendererRef = useRef<{ gl: unknown } | null>(null);
  const previousRecoveryCountRef = useRef(recovery.count);
  const { camera, gl, scene } = useThree();
  const forceWebGL =
    !(
      gl as unknown as {
        backend?: { isWebGPUBackend?: boolean };
      }
    ).backend?.isWebGPUBackend;

  useEffect(() => {
    hostedKelpMountCount += 1;
    const probeWindow = window as typeof window & {
      __KELP_STAGE_PROBE__?: {
        mountCount: number;
        snapshot: () => Record<string, unknown>;
      };
    };
    const probe = {
      mountCount: hostedKelpMountCount,
      snapshot: () => ({
        mountCount: hostedKelpMountCount,
        playerPosition: { ...kelpRealmPlayerPositionRef },
        claim: getKelpRealmClaimSnapshot(),
        tokenGeneration: activation.token.generation,
        tokenCurrent: activation.isCurrent(activation.token),
      }),
    };
    probeWindow.__KELP_STAGE_PROBE__ = probe;
    return () => {
      if (probeWindow.__KELP_STAGE_PROBE__ === probe) {
        delete probeWindow.__KELP_STAGE_PROBE__;
      }
    };
  }, [activation]);

  useEffect(() => {
    if (!requested || generation <= 0) return;
    useStageStore
      .getState()
      .setSceneWarming(KELP_SCENE_ID, generation);
  }, [generation, requested]);

  useEffect(() => {
    const previousCount = previousRecoveryCountRef.current;
    previousRecoveryCountRef.current = recovery.count;
    if (!active || recovery.count === previousCount) return;
    const lane = kelpRecoveryLaneForReason(recovery.lastReason);
    if (!lane) return;
    reportKelpRenderFailure(
      lane,
      recovery.lastReason ?? undefined,
      lane === 'webgpu-unhealthy' || lane === 'device-lost'
        ? 'webgpu'
        : undefined,
    );
  }, [active, recovery]);

  const handleEnvironmentReady = useCallback(() => {
    if (activation.isCurrent(token)) {
      setEnvironmentReadyToken(token.id);
    }
  }, [activation, token]);

  useEffect(() => {
    if (!isKelpStageWarmReady({
      token,
      resetsCompleteToken,
      environmentReadyToken,
      requested,
      cameraInstalled,
      generation,
      meshCount: countKelpStageMeshes(scene),
    })) {
      return;
    }
    let cancelled = false;
    const isCurrent = (): boolean => {
      const state = useStageStore.getState();
      return (
        !cancelled &&
        activation.isCurrent(token) &&
        lifecycleRef.current?.resetsComplete(token) === true &&
        state.pendingRequest?.sceneId === KELP_SCENE_ID &&
        state.pendingRequest.generation === generation &&
        state.scenes[KELP_SCENE_ID]?.generation === generation
      );
    };

    void (async () => {
      useStageStore.getState().setRenderPaused(true);
      const compileAsync =
        typeof (gl as { compileAsync?: unknown }).compileAsync ===
        'function'
          ? () =>
              withStageSlotFrustumCullingDisabled(
                KELP_SCENE_ID,
                () =>
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
        slotId: KELP_SCENE_ID,
        gl,
        warmedRenderer: warmedRendererRef.current?.gl ?? null,
        compile: compileAsync,
        directWarm: () =>
          withStageSlotFrustumCullingDisabled(
            KELP_SCENE_ID,
            async () => {
              gl.render(scene, camera);
            },
          ),
        isCurrent,
        onCompileRejected: (error) => {
          console.warn(
            '[KelpStage] compileAsync failed; continuing to direct warm:',
            error,
          );
        },
        onCompileTimedOut: () => {
          console.warn(
            '[KelpStage] compileAsync exceeded 20s; bypassing it for this renderer',
          );
        },
        onDirectWarmRejected: (error) => {
          console.warn(
            '[KelpStage] direct warm failed; continuing:',
            error,
          );
        },
      });
      if (result.status !== 'completed' || !isCurrent()) return;
      warmedRendererRef.current = { gl: result.warmedRenderer };
      const state = useStageStore.getState();
      state.setRenderPaused(false);
      state.ackReady(KELP_SCENE_ID, generation);
    })();

    return () => {
      cancelled = true;
      useStageStore.getState().setRenderPaused(false);
    };
  }, [
    activation,
    camera,
    cameraInstalled,
    environmentReadyToken,
    generation,
    gl,
    requested,
    resetsCompleteToken,
    scene,
    token,
  ]);

  return (
    <KelpRealmScene
      activation={activation}
      forceWebGL={forceWebGL}
      onEnvironmentReady={handleEnvironmentReady}
    />
  );
}
