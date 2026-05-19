/**
 * room-camera.ts
 *
 * Reusable utility for interior-scene camera containment.
 *
 * Problem: a chase camera positioned at avatar + behind_offset ignores room
 * walls. When the avatar stands near a wall and faces it, the behind-offset
 * pushes the camera outside the wall → background void (deep purple / black).
 *
 * Solution: AABB clamp — after computing the desired camera position, clamp
 * X/Y/Z to the room bounding box with a small inward margin so the camera
 * always stays inside. For rectangular rooms this is sufficient and cheaper
 * than a per-frame raycast.
 *
 * Future buildings with non-rectangular walls can supply their own `meshes`
 * array for the optional raycast path (see RoomCameraOptions.meshes).
 *
 * Iris Xe constraint: this file allocates NO Vector3 — the caller passes the
 * position vector in-place and we mutate it. All scratch math is inline.
 *
 * Usage (casino-interior.tsx):
 *   clampCameraToRoom(_camDesiredPos, CASINO_ROOM_BOUNDS);
 */

import * as THREE from 'three';

export interface RoomBounds {
  /** ± this value in X (symmetric room assumed). */
  halfX: number;
  /** Minimum Z coordinate of the room. */
  zMin: number;
  /** Maximum Z coordinate of the room. */
  zMax: number;
  /** Minimum camera Y (floor + headroom). Default: 30. */
  yMin?: number;
  /** Maximum camera Y (ceiling − clearance). Default: 600. */
  yMax?: number;
  /**
   * Inward margin in world units so the camera sits just INSIDE the wall
   * rather than flush against it. Default: 50wu.
   */
  margin?: number;
}

/**
 * Clamp `pos` so it stays inside the room AABB.
 *
 * Mutates `pos` in-place — no allocations, safe to call every frame.
 */
export function clampCameraToRoom(pos: THREE.Vector3, bounds: RoomBounds): void {
  const margin = bounds.margin ?? 50;
  const yMin   = bounds.yMin   ?? 30;
  const yMax   = bounds.yMax   ?? 600;

  pos.x = Math.max(-(bounds.halfX - margin), Math.min(bounds.halfX - margin, pos.x));
  pos.z = Math.max(bounds.zMin + margin,     Math.min(bounds.zMax - margin,  pos.z));
  pos.y = Math.max(yMin,                     Math.min(yMax,                  pos.y));
}
