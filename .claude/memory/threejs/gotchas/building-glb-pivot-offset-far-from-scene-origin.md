---
title: Building GLB pivot offset — geometry far from scene origin (rotation-aware fix)
category: gotcha
tags: [buildings, bounding-box, pivot, positioning, downtown-building, rotation]
date: 2026-04-16
confidence: high
threejs_version: r170+
---

## Summary
Some building GLBs (e.g. `downtown-building.glb`) are authored with geometry far
from the scene pivot. A naive position-subtraction fix works only when rotation is
zero — with a non-trivial rotY the pivot correction must live INSIDE the rotated frame.

## Details

### First symptom (2026-04-16 pass 1)
CDP bbox scan of cron-hub (i=3, world assigned (1696, 544)):
- `cx = 5816` — building rendered ~4120wu east of its grid slot

Fix: subtract `bbox_center * scale` from the outer group's world position.
This worked for that specific rotation angle but was mathematically wrong for any
rotation that is not 0 or π, because the correction vector was in local (pre-rotation)
space but was applied in world (post-rotation) space.

### Second symptom (2026-04-16 pass 2)
After the ring expansion (rotY=-1.882 for cron-hub), live CDP showed:
- Expected world bbox center: (2080, 672)
- Actual: (6936, 5319) — off by (4856, 4647)

### Root cause
`pivotOffsetX/Z = _buildCenter.x/z * scale` is a vector in the primitive's LOCAL
frame (pre-rotation). When subtracted from the outer group's world position, it is
effectively applied in WORLD space. After the outer group rotates by rotY, the
geometry's centroid is at `worldPos + rotate(pivotVec, rotY)`, not at
`worldPos + pivotVec`. The correction undoes only the un-rotated component,
leaving a residual of `(1 - cos(rotY)) * offset` in X and `sin(rotY) * offset` in Z.

### Correct fix — inner group inside the rotating frame
```tsx
// Outer group: world position at zone center, carries rotation
<group ref={groupRef} position={[cx, y, cz]} rotation={[0, rotY, 0]}>
  // Inner group: pivot correction in LOCAL (rotated) space
  <group position={[-pivotOffsetX, 0, -pivotOffsetZ]}>
    <primitive object={cloned} scale={buildingScale} />
  </group>
</group>
```

Math proof (any rotY):
- inner.position = (-px, 0, -pz)  where px = lx*s, pz = lz*s
- geometry bbox center in inner's frame = (+px, ly*s, +pz)
- combined offset from inner origin = 0 in XZ
- outer rotates (0, 0) → still (0, 0)
- final world XZ of bbox center = (cx, cz)  ✓

`computeBuildingScale` still returns `{ scale, pivotOffsetX, pivotOffsetZ }` — the
values are computed identically; only how they are consumed changed.

### Why the first fix was wrong
Subtracting from outer position applies the correction in WORLD space.
After rotation, the geometry's center is at `rotate(inner_origin + local_center, rotY)` ≠ 0,
so the bbox center drifts away from the zone center at any angle other than 0 / π.

### For well-centered GLBs
When `_buildCenter ≈ (0, 0, 0)`, `pivotOffsetX/Z ≈ 0`, the inner group is a no-op.
The fix is safe for all 10 buildings.

## Context
Pass 1 surfaced 2026-04-16 CDP scan: cron-hub at cx=5816 instead of ~1696.
Pass 2 surfaced same session after ring expansion to rotY=-1.882 moved the building off by (4856, 4647).
Fix applied to `GLBBuilding` (JSX) and `EditableBuilding` (useFrame + JSX) in
`apps/web/src/lib/three/arena-buildings.tsx`.
