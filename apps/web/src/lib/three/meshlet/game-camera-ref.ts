// @ts-nocheck
/**
 * Module-scope mutable camera reference for the meshlet path.
 *
 * The MeshletBuildingsLayer lives OUTSIDE the R3F tree (separate canvas, own
 * rAF) but must render with the EXACT same camera state R3F is using so the
 * meshlet buildings line up with R3F's terrain + NPCs + player.
 *
 * Sync pattern: a tiny `<CameraExporter />` component mounted inside R3F's
 * scene tree calls useFrame to copy state.camera's matrices into this ref
 * every frame. The MeshletBuildingsLayer reads from it each rAF tick.
 *
 * Sub-frame timing: R3F's frame and the bare layer's rAF tick are independent;
 * worst-case the bare layer reads a 1-frame-stale matrix. Visually negligible
 * at 60+ FPS. For frame-perfect sync (Phase B v2) drive both off a shared frame
 * manager.
 *
 * Same pattern as `avatarPositionRef` in stores/game.ts — mutable module-scope
 * object that React doesn't observe directly, written from one place each frame
 * and read by others.
 */

import * as THREE from 'three/webgpu';

export interface GameCameraSnapshot {
  /** Current camera world-position. Copied per frame. */
  position: THREE.Vector3;
  /** Current camera world-rotation (quaternion). Copied per frame. */
  quaternion: THREE.Quaternion;
  /** Field of view in degrees. */
  fov: number;
  /** Near plane distance. */
  near: number;
  /** Far plane distance. */
  far: number;
  /** Has the exporter ever written? false until first R3F frame. */
  ready: boolean;
}

export const gameCameraRef: GameCameraSnapshot = {
  position: new THREE.Vector3(),
  quaternion: new THREE.Quaternion(),
  fov: 50,
  near: 1,
  far: 10000,
  ready: false,
};
