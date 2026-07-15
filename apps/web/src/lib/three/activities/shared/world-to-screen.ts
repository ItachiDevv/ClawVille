/**
 * world-to-screen.ts
 *
 * Pure projection utility — no React, no Three.js instance state.
 * Converts a Three.js world-space Vector3 to CSS pixel coordinates for HUD anchoring.
 *
 * Called by the frontend agent's HUD overlay to position floating labels
 * (player names, health bars, ghost indicator) over 3D objects.
 *
 * Per 3d-spec §3.2:
 *   - No 3D geometry involved — pure math.
 *   - Caller owns the camera and renderer references.
 *   - `visible` is false when the point is behind the camera (view-space z ≥ 0;
 *     NDC z is unreliable for this under the r185 reversed-depth renderer).
 *
 * Example (in a HUD component):
 *   const { gl, camera } = useThree();
 *   const { x, y, visible } = worldToScreen(playerWorldPos, camera, gl);
 *   if (visible) labelRef.current.style.transform = `translate(${x}px, ${y}px)`;
 */

import * as THREE from 'three';

// ─── Module-scope scratch — no per-call allocation ────────────────────────────
const _ndc = new THREE.Vector3();
const _view = new THREE.Vector3();

export interface ScreenPosition {
  /** CSS pixel X from left edge of the canvas. */
  x: number;
  /** CSS pixel Y from top edge of the canvas. */
  y: number;
  /** False when the point is behind the camera (clipped). */
  visible: boolean;
}

/**
 * Project a world-space position to CSS canvas-relative pixel coordinates.
 *
 * @param worldPos   Three.js world-space position of the 3D object.
 * @param camera     The active camera (PerspectiveCamera or OrthographicCamera).
 * @param gl         The Three.js renderer — used for canvas pixel dimensions.
 * @returns          {x, y} in CSS pixels + `visible` flag.
 */
export function worldToScreen(
  worldPos: THREE.Vector3,
  camera: THREE.Camera,
  gl: { domElement: HTMLCanvasElement },
): ScreenPosition {
  // Copy world position into NDC scratch — no allocation.
  _ndc.copy(worldPos);
  _ndc.project(camera);

  // Behind-camera test uses VIEW-space z, not NDC z: with the r185
  // reversedDepthBuffer renderer (camera.reversedDepth) NDC z semantics
  // invert (near→1, far→0) and a behind-camera point projects to z < 0,
  // so an `ndc.z <= 1` check wrongly keeps it visible at mirrored coords.
  // View-space z < 0 = in front of the camera under every projection.
  const visible =
    _view.copy(worldPos).applyMatrix4(camera.matrixWorldInverse).z < 0;

  const canvas = gl.domElement;
  const halfW  = canvas.clientWidth  / 2;
  const halfH  = canvas.clientHeight / 2;

  // NDC → CSS pixels.
  // NDC: (-1,-1) = bottom-left, (+1,+1) = top-right.
  // CSS: (0,0) = top-left.
  const x = (_ndc.x  + 1) * halfW;
  const y = (-_ndc.y + 1) * halfH;

  return { x, y, visible };
}
