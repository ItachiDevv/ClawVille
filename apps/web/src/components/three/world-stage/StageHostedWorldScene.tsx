'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import {
  kickRenderLoop,
  WorldScene,
  type WorldStageWarmupProps,
} from '@/components/three/World3DCanvas';
import { useStageStore } from './stage-store';

const WORLD_SCENE_ID = 'world';

export default function StageHostedWorldScene() {
  const generation = useStageStore(
    (state) => state.scenes[WORLD_SCENE_ID]?.generation ?? 0,
  );
  const requested = useStageStore(
    (state) => state.pendingRequest?.sceneId === WORLD_SCENE_ID,
  );
  const generationRef = useRef(generation);
  const warmedOnceRef = useRef(false);
  const kickedOnceRef = useRef(false);
  const stageState = useThree();
  generationRef.current = generation;

  useEffect(() => {
    if (!requested || generation <= 0) return;
    if (!kickedOnceRef.current) {
      kickedOnceRef.current = true;
      kickRenderLoop(stageState);
    }
    const state = useStageStore.getState();
    state.setSceneWarming(WORLD_SCENE_ID, generation);
    if (warmedOnceRef.current) {
      state.setRenderPaused(false);
      state.ackReady(WORLD_SCENE_ID, generation);
    }
  }, [generation, requested, stageState]);

  const setRenderPaused = useCallback((paused: boolean) => {
    useStageStore.getState().setRenderPaused(paused);
  }, []);
  const onReady = useCallback(() => {
    const currentGeneration = generationRef.current;
    const state = useStageStore.getState();
    const slot = state.scenes[WORLD_SCENE_ID];
    if (
      !slot ||
      slot.generation !== currentGeneration ||
      state.pendingRequest?.sceneId !== WORLD_SCENE_ID ||
      state.pendingRequest.generation !== currentGeneration
    ) {
      return;
    }
    warmedOnceRef.current = true;
    state.ackReady(WORLD_SCENE_ID, currentGeneration);
  }, []);
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
