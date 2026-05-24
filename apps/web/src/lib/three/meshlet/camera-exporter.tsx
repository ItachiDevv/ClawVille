// @ts-nocheck
/**
 * <CameraExporter /> — drop inside R3F's <Canvas> tree. Each frame it copies
 * R3F's active camera state into `gameCameraRef` so the out-of-tree
 * MeshletBuildingsLayer can read it.
 *
 * Mount once near the root of SceneContents (or anywhere inside the Canvas).
 * Renders nothing.
 */
'use client';

import { useFrame } from '@react-three/fiber';
import { gameCameraRef } from './game-camera-ref';

export default function CameraExporter() {
  useFrame((state) => {
    const cam = state.camera;
    gameCameraRef.position.copy(cam.position);
    gameCameraRef.quaternion.copy(cam.quaternion);
    if ((cam as any).isPerspectiveCamera) {
      gameCameraRef.fov = (cam as any).fov;
      gameCameraRef.near = (cam as any).near;
      gameCameraRef.far = (cam as any).far;
    }
    gameCameraRef.ready = true;
  });
  return null;
}
