---
title: Interior Chase Camera — AABB Clamp to Prevent Wall Clip
category: pattern
tags: [interior, chase-camera, aabb, clamp, room-camera, casino]
date: 2026-05-19
confidence: high
threejs_version: r182
---

## Summary
Chase cameras positioned at `avatar + behind_offset` ignore room walls. When the avatar faces a wall the behind-offset pushes the camera outside → black void viewport. Fix: AABB clamp the desired camera position to the room bounds before lerping.

## Details

```ts
// room-camera.ts (apps/web/src/lib/three/room-camera.ts)
export interface RoomBounds {
  halfX: number; zMin: number; zMax: number;
  yMin?: number; yMax?: number; margin?: number;
}
export function clampCameraToRoom(pos: THREE.Vector3, bounds: RoomBounds): void {
  const margin = bounds.margin ?? 50;
  const yMin   = bounds.yMin   ?? 30;
  const yMax   = bounds.yMax   ?? 600;
  pos.x = Math.max(-(bounds.halfX - margin), Math.min(bounds.halfX - margin, pos.x));
  pos.z = Math.max(bounds.zMin + margin,     Math.min(bounds.zMax - margin,  pos.z));
  pos.y = Math.max(yMin,                     Math.min(yMax,                  pos.y));
}
```

In the useFrame camera update:
```ts
_camDesiredPos.set(posX + behindX, CAM_ABOVE + pitchOffset, posZ + behindZ);
clampCameraToRoom(_camDesiredPos, CASINO_ROOM_BOUNDS);  // ← before lerp
cam.position.lerp(_camDesiredPos, 1 - Math.exp(-8 * delta));
```

Zero allocations — mutates `pos` in place. Safe for 60fps call.

For non-rectangular rooms (e.g. curved bar, diagonal walls), the optional raycast
path can be added to `room-camera.ts` — but AABB is sufficient for the rectangular
casino room.

## Context
Casino interior (`casino-interior.tsx`, 2026-05-19). User reported "depending on the
angle you stand, the user view is outside of the room — mostly just black". Root cause:
`CAM_BEHIND=450wu` behind-offset puts camera through BOUNDS_Z_MIN=-900 wall when
avatar stands near that wall and the arrow-key yaw offset is involved. Reusable utility
extracted for future interior scenes.
