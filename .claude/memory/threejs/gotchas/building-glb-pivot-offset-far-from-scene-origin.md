---
title: Building GLB pivot offset — geometry far from scene origin (XZ rotation-aware + Y grounding fix)
category: gotcha
tags: [buildings, bounding-box, pivot, positioning, downtown-building, rotation, grounding, floating, underground]
date: 2026-04-16
confidence: high
threejs_version: r170+
---

## Summary
Some building GLBs (e.g. `downtown-building.glb`) are authored with geometry far
from the scene pivot. A naive position-subtraction fix works only when rotation is
zero — with a non-trivial rotY the pivot correction must live INSIDE the rotated frame.
Additionally, GLBs authored with `bbox.min.y != 0` will float (min.y > 0) or clip
underground (min.y < 0) unless the Y offset is also corrected inside the inner group.

## Details

### First symptom (2026-04-16 pass 1) — XZ drift
CDP bbox scan of cron-hub (i=3, world assigned (1696, 544)):
- `cx = 5816` — building rendered ~4120wu east of its grid slot

Fix: subtract `bbox_center * scale` from the outer group's world position.
This worked for that specific rotation angle but was mathematically wrong for any
rotation that is not 0 or π, because the correction vector was in local (pre-rotation)
space but was applied in world (post-rotation) space.

### Second symptom (2026-04-16 pass 2) — XZ drift at non-trivial rotY
After the ring expansion (rotY=-1.882 for cron-hub), live CDP showed:
- Expected world bbox center: (2080, 672)
- Actual: (6936, 5319) — off by (4856, 4647)

### Root cause (XZ)
`pivotOffsetX/Z = _buildCenter.x/z * scale` is a vector in the primitive's LOCAL
frame (pre-rotation). When subtracted from the outer group's world position, it is
effectively applied in WORLD space. After the outer group rotates by rotY, the
geometry's centroid is at `worldPos + rotate(pivotVec, rotY)`, not at
`worldPos + pivotVec`. The correction undoes only the un-rotated component,
leaving a residual of `(1 - cos(rotY)) * offset` in X and `sin(rotY) * offset` in Z.

### Third symptom (2026-04-16 pass 3) — Y floating / underground
CDP bbox scan confirmed `downtown-building` (i=3) bbox minY = +116 (world units),
while all other buildings had minY ≈ -2. Root cause: downtown-building.glb authored
with geometry sitting above the scene pivot — `bbox.min.y * scale = ~116` — so at
inner group Y=0, the geometry floor was 116wu above the sand floor.

### Correct fix — inner group inside the rotating frame with Y grounding
```tsx
// Outer group: world position at zone center, carries rotation
<group ref={groupRef} position={[cx, -2 + yOffset, cz]} rotation={[0, rotY, 0]}>
  // Inner group: XZ AND Y pivot correction in LOCAL (rotated) space
  <group position={[-pivotOffsetX, -pivotOffsetY, -pivotOffsetZ]}>
    <primitive object={cloned} scale={buildingScale} />
  </group>
</group>
```

Where:
- `pivotOffsetX = _buildCenter.x * scale`
- `pivotOffsetZ = _buildCenter.z * scale`
- `pivotOffsetY = _buildBbox.min.y * scale`

**XZ math proof (any rotY):**
- inner.position = (-px, -py, -pz)  where px = lx*s, pz = lz*s
- geometry bbox center in inner's frame = (+px, ly*s, +pz)
- combined XZ offset from inner origin = 0
- outer rotates (0, 0) → still (0, 0)
- final world XZ of bbox center = (cx, cz)  ✓

**Y math proof (all 3 authoring cases):**
- World Y of geometry floor = outer.y + inner.y + geom_local_minY_scaled
- = (-2) + (-pivotOffsetY) + pivotOffsetY = -2  ✓  for ALL values of min.y
- `min.y > 0`: inner shifts DOWN (negative Y), cures floating
- `min.y = 0`: offset=0, no-op
- `min.y < 0`: inner shifts UP (positive Y), cures underground clipping

`computeBuildingScale` returns `{ scale, pivotOffsetX, pivotOffsetY, pivotOffsetZ }`.

### Why the first fix was wrong
Subtracting from outer position applies the correction in WORLD space.
After rotation, the geometry's center is at `rotate(inner_origin + local_center, rotY)` ≠ 0,
so the bbox center drifts away from the zone center at any angle other than 0 / π.

### For well-centered GLBs
When `_buildCenter ≈ (0, 0, 0)` and `bbox.min.y ≈ 0`, all offsets ≈ 0 and the
inner group is a no-op. The fix is safe for all 10 buildings.

## Context
Pass 1 surfaced 2026-04-16 CDP scan: cron-hub at cx=5816 instead of ~1696.
Pass 2 surfaced same session after ring expansion to rotY=-1.882 moved the building off by (4856, 4647).
Pass 3 surfaced 2026-04-16: downtown-building bbox minY=+116wu (floating), all others ≈ -2.
Fix applied to `GLBBuilding` (JSX) and `EditableBuilding` (useFrame + JSX) in
`apps/web/src/lib/three/arena-buildings.tsx`.
