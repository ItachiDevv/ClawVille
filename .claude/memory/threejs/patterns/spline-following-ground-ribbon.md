---
title: Spline-following ground ribbon — strip swept along Catmull-Rom spline
category: pattern
tags: [spline, ribbon, ground, terrain, BufferGeometry, reef-race]
date: 2026-04-29
confidence: high
threejs_version: r182
---

## Summary

Replace two rectangular PlaneGeometry ground strips (fixed world position) with two
`BufferGeometry` ribbons swept along a `clientSpline`, so ground hugs the canyon edge
organically at every t-sample.

## Details

`buildGroundRibbonGeo(side: 1 | -1, samples: number, widthSegs: number)`:

1. For each `t` in [0, 1] at `samples+1` rows:
   - `c = clientSpline.centerlineAt(t)` — world XZ
   - `n = clientSpline.normalAt(t)`  — unit normal LEFT of travel
   - `hw = clientSpline.widthAt(t)` — varies per t
   - `innerLateral = hw + GROUND_INNER_OFFSET`
2. For each lateral column i in [0, widthSegs]:
   - `frac = i / widthSegs` ∈ [0,1]
   - `dist = innerLateral + frac * GROUND_W`
   - `wx = c.x + n.x * dist * side`, `wz = c.z + n.z * dist * side`
   - `wy = GROUND_Y` (constant, flat ground)
3. Normals always `(0, 1, 0)` — horizontal ground.
4. UVs: `u = frac` (lateral), `v = t` (along spline).
5. Index buffer: two tris per quad, with **mirrored winding** for side=-1 to maintain +Y normal:
   - side=+1: `a,c,b` then `b,c,d`
   - side=-1: `a,b,c` then `b,d,c`

**Tri budget**: `(samples) * widthSegs * 2 * 2_sides`.
At samples=128, widthSegs=64: 32,768 tris total.

**GROUND_INNER_OFFSET** = max cliff lateralMax + max rock body half + safety buffer.
In reef-race iter-9: 600 + 173 + 100 = 873wu. Verified safe at all corridor halfWidths.

```ts
const _groundGeoLeft  = buildGroundRibbonGeo( 1, 128, 64);
const _groundGeoRight = buildGroundRibbonGeo(-1, 128, 64);

// In R3F component — NO position prop needed; vertices are in world XZ
<mesh geometry={_groundGeoLeft}  material={_groundShaderMat} frustumCulled={false} matrixAutoUpdate={false} />
<mesh geometry={_groundGeoRight} material={_groundShaderMat} frustumCulled={false} matrixAutoUpdate={false} />
```

The existing ShaderMaterial still works: vertex Y displacement applies to `position.y`
which is already at `GROUND_Y`. The old `displacementMask` (smoothstep on abs(position.x))
was wrong for these world-space vertices — remove it or hard-code to 1.0.

## Context

Reef Race v2 iter-9 (2026-04-29). User reference: German River 3D scan — ground extends
outward from cliff TOPS, not as a flat rectangle. Old approach used two rectangles at
fixed ±GROUND_X_OFFSET with world-space position prop; they didn't follow the spline's
curves and had a mismatch between the docblock's safety proof and the actual geometry.
