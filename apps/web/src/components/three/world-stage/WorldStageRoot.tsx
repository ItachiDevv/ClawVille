'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  WorldScene,
  WORLD_STAGE_APPEARANCE,
  kickRenderLoop,
  type WorldStageWarmupProps,
} from '@/components/three/World3DCanvas';
import {
  WorldStageCanvas,
  type WorldStageScene,
} from './WorldStageCanvas';
import {
  requestStageScene,
  resetStageStore,
  useStageStore,
} from './stage-store';
import { resetStageFrameDiagnostics } from './use-scene-frame';

const WORLD_SCENE_ID = 'world';

function StageHostedWorldScene() {
  const generation = useStageStore(
    (state) => state.scenes[WORLD_SCENE_ID]?.generation ?? 0,
  );
  const requested = useStageStore(
    (state) => state.pendingRequest?.sceneId === WORLD_SCENE_ID,
  );

  useEffect(() => {
    if (!requested || generation <= 0) return;
    useStageStore
      .getState()
      .setSceneWarming(WORLD_SCENE_ID, generation);
  }, [generation, requested]);

  const setRenderPaused = useCallback((paused: boolean) => {
    useStageStore.getState().setRenderPaused(paused);
  }, []);
  const onReady = useCallback(() => {
    const state = useStageStore.getState();
    const slot = state.scenes[WORLD_SCENE_ID];
    if (
      !slot ||
      slot.generation !== generation ||
      state.pendingRequest?.sceneId !== WORLD_SCENE_ID ||
      state.pendingRequest.generation !== generation
    ) {
      return;
    }
    state.ackReady(WORLD_SCENE_ID, generation);
  }, [generation]);
  const stageWarmup = useMemo<WorldStageWarmupProps>(
    () => ({ setRenderPaused, onReady }),
    [onReady, setRenderPaused],
  );
  const onFrameloopChange = useCallback(
    (mode: 'always' | 'never') => {
      setRenderPaused(mode === 'never');
    },
    [setRenderPaused],
  );

  return (
    <WorldScene
      mode="game"
      onFrameloopChange={onFrameloopChange}
      stageWarmup={stageWarmup}
      stageHosted
    />
  );
}

export function WorldStageRoot({ children }: { children: ReactNode }) {
  const [stageReady, setStageReady] = useState(false);

  useEffect(() => {
    resetStageStore();
    resetStageFrameDiagnostics();
    setStageReady(true);
  }, []);

  useEffect(() => {
    if (!stageReady) return;
    requestStageScene(WORLD_SCENE_ID);
  }, [stageReady]);

  const scenes = useMemo<readonly WorldStageScene[]>(
    () => [
      {
        sceneId: WORLD_SCENE_ID,
        camera: {
          fov: 50,
          near: 1,
          far: 11_500,
          position: [0, 600, 1_300],
        },
        appearance: {
          background: WORLD_STAGE_APPEARANCE.background,
          fog: WORLD_STAGE_APPEARANCE.fog,
          shadows: true,
        },
        content: <StageHostedWorldScene />,
      },
    ],
    [],
  );

  return (
    <div className="world-stage-root relative h-screen w-full overflow-hidden">
      {stageReady && (
        <div className="absolute inset-0 z-0">
          <WorldStageCanvas
            scenes={scenes}
            transitionTimeoutMs={45_000}
            pauseOnCreate
            onStageCreated={kickRenderLoop}
          />
        </div>
      )}
      <div className="world-stage-page-layer absolute inset-0 z-10">
        {children}
      </div>
    </div>
  );
}
