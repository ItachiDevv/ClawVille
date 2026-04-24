---
title: VRM velocity-facing formula must be atan2(-vx, -vz) not atan2(vx, -vz)
category: gotcha
tags: [vrm, facing, atan2, rotation, arena-npcs, velocity, milady]
date: 2026-04-24
confidence: high
threejs_version: r170+
---

## Summary

`Math.atan2(vx, -vz)` as the VRM facing formula inverts east/west facing — the
NPC faces the REVERSE of its travel direction when vx != 0. The correct formula
is `Math.atan2(-vx, -vz)`.

## Details

VRM models face -Z at `rotation.y = 0` (after `VRMUtils.rotateVRM0` in vrm-loader.ts).

Three.js uses a **right-hand coordinate system** with **CCW positive Y rotation**
viewed from above. Consequence: rotating a -Z-facing model by +π/2 around Y brings
it to face **-X**, NOT +X.

### Worked example — NPC moving +X (vx=+1, vz=0)

We want `rotation.y = -π/2` so the -Z face rotates 90° CW to align with +X.

```
atan2(vx=1,  -vz=0) = +π/2  ← WRONG — faces -X (away from travel)
atan2(-vx=-1, -vz=0) = -π/2  ← CORRECT — faces +X (along travel)
```

### General derivation

For a -Z-forward model to face direction (vx, vz):

```
The -Z world direction under rotation θ is: (-sin(θ), 0, -cos(θ))
We want: -sin(θ) ∝ vx  and  -cos(θ) ∝ vz
→ sin(θ) = -vx / |v|,  cos(θ) = -vz / |v|
→ θ = atan2(sin(θ), cos(θ)) = atan2(-vx, -vz)  ✓
```

### GLB path is different — do NOT negate there

GLB crustaceans (lobster, hermitcrab, sweet_crab, etc.) face **+Z** at rest.
Their facing formula `Math.atan2(glbVx, glbVz)` is correct and must NOT be
changed. The VRM path and GLB path in `arena-npcs.tsx` are separate branches.

## Context

Bug surfaced 2026-04-24 when user reported "Miladys walk backwards". The previous
formula `atan2(vx, -vz)` was introduced during the velocity-driven facing rewrite
(2026-04-23) as an intuitive-but-wrong conversion of the "VRM faces -Z" statement.

The fix is a one-character change on line ~935 of
`apps/web/src/lib/three/arena-npcs.tsx`:
```ts
// Before (wrong):
const targetRot = Math.atan2(vx, -vz);
// After (correct):
const targetRot = Math.atan2(-vx, -vz);
```

The rotation lerp block (`diff` normalisation + `12*dt` slerp) is unchanged.
