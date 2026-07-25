'use client';

import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { useStageStore } from './stage-store';

export interface StageCameraConfig {
  fov: number;
  near: number;
  far: number;
  position: readonly [number, number, number];
  lookAt?: readonly [number, number, number];
}

export interface StageCameraDefinition {
  sceneId: string;
  camera: StageCameraConfig;
}

interface StageCameraCoordinatorProps {
  definitions: readonly StageCameraDefinition[];
  cameras: ReadonlyMap<string, THREE.PerspectiveCamera>;
}

export function StageCameraCoordinator({
  definitions,
  cameras,
}: StageCameraCoordinatorProps): null {
  const activeScene = useStageStore((state) => state.activeScene);
  const activeGeneration = useStageStore(
    (state) =>
      (state.activeScene
        ? state.scenes[state.activeScene]?.generation
        : undefined) ?? 0,
  );
  const setRootState = useThree((state) => state.set);
  const size = useThree((state) => state.size);

  useEffect(() => {
    const aspect = size.width / Math.max(size.height, 1);
    for (const definition of definitions) {
      const camera = cameras.get(definition.sceneId);
      if (!camera) continue;
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    }
  }, [cameras, definitions, size.height, size.width]);

  useEffect(() => {
    if (!activeScene || activeGeneration <= 0) return;
    const camera = cameras.get(activeScene);
    if (!camera) return;

    // StageTransition changes activeScene only after its fade is opaque. This
    // is the sole camera installation path; no scene mounts makeDefault.
    setRootState({ camera });
    useStageStore
      .getState()
      .ackCameraInstalled(activeScene, activeGeneration);
  }, [activeGeneration, activeScene, cameras, setRootState]);

  return null;
}
