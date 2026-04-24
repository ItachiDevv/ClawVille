// ---------------------------------------------------------------------------
// camera-cull.ts — behind-camera dot-product helper
//
// Used to imperatively hide drei <Html> DOM portals when their 3D anchor
// is behind the camera. drei's calculatePosition does manual projection and
// still emits screen XY even when NDC z > 1 (anchor behind near plane),
// producing ghost labels floating over empty world space.
//
// Pattern: call anchorInFrontOfCamera(anchorWorldPos, camera) each useFrame.
// If it returns false, set labelRef.current.style.display = 'none'.
//
// PERF: module-scope temporaries reused every call — zero per-frame allocs.
// ---------------------------------------------------------------------------

import * as THREE from 'three';

// Module-scoped reusable temporaries — DO NOT allocate per-frame.
const _tmpCamFwd = new THREE.Vector3();
const _tmpToAnchor = new THREE.Vector3();

/**
 * Returns true when `anchorWorldPos` is in front of the camera
 * (i.e. the dot product of (anchor - cameraPos) · cameraForward > 0).
 *
 * Use in useFrame to gate drei <Html> label visibility:
 *
 *   if (!anchorInFrontOfCamera(groupRef.current.position, camera)) {
 *     if (label && label.style.display !== 'none') label.style.display = 'none';
 *   }
 */
export function anchorInFrontOfCamera(
  anchorWorldPos: THREE.Vector3,
  camera: THREE.Camera,
): boolean {
  _tmpCamFwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
  _tmpToAnchor.copy(anchorWorldPos).sub(camera.position);
  return _tmpToAnchor.dot(_tmpCamFwd) > 0;
}
