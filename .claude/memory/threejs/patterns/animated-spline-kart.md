---
title: Animated spline-following karts (GLB clone per-frame)
category: pattern
tags: [spline, kart, racing, glb-clone, animation, useFrame, reef-race]
date: 2026-04-29
confidence: high
threejs_version: r182
---

## Summary

5 surfboard_1.glb clones animated along a centripetal Catmull-Rom spline with per-kart speed variation, lateral offset, Y-bob, yaw, and banking lean. Zero per-frame GC except for `Vec2` return values from `ReefSpline` API.

## Details

### Pattern: clone-once, animate imperatively

```tsx
// Build in useEffect keyed on srcScene (one combined effect — see gotcha below)
const clone = srcScene.clone(true);
clone.traverse(child => { child.frustumCulled = false; });
applyColorTint(clone, color);
clone.matrixAutoUpdate = false;
clone.scale.setScalar(KART_SCALE);
group.add(clone);
kartRefs.current[i] = clone;

// Animate in useFrame — no React state writes
useFrame((state, dt) => {
  let tc = tArr[i] + (700.0 / totalArc) * speedMult[i] * dt;
  if (tc >= 1.0) tc -= 1.0;
  tArr[i] = tc;

  const c = clientSpline.centerlineAt(tc);  // Vec2 {x, z}
  const tan = clientSpline.tangentAt(tc);
  const n = clientSpline.normalAt(tc);

  kart.position.set(c.x + n.x * lat, WATER_Y + KART_Y_ABOVE + bob, c.z + n.z * lat);
  kart.rotation.set(0, Math.atan2(tan.x, tan.z), bankAngle);
  kart.updateMatrix();
});
```

### Banking lean via finite-difference curvature

```ts
const tNext = (tc + 0.005) % 1.0;
const tanNext = clientSpline.tangentAt(tNext);
// Z-component of cross product in XZ plane — positive = left turn (CCW)
const cross = tan.x * tanNext.z - tan.z * tanNext.x;
const bankAngle = Math.max(-0.4, Math.min(0.4, cross * 60.0));
```

Sign note: if bank lean looks wrong in browser, negate `BANK_GAIN` (60.0). The XYZ Euler rotation order means `rotation.z` tilts around world Z after `rotation.y` (yaw), which may be "left lean on left turn" or the opposite depending on the kart's initial facing vs. travel direction.

### Critical: combine clone-build + group-attach in ONE useEffect

If split across two `useEffect`s both keyed on `srcScene`, React scheduling can run the second (attach) effect before or after the first (build) effect's cleanup, leaving an empty group on hot-reload.

```tsx
useEffect(() => {
  const group = groupRef.current;
  if (!group || !srcScene) return;
  while (group.children.length > 0) group.remove(group.children[0]);

  for (let i = 0; i < N; i++) {
    const clone = srcScene.clone(true);
    // ... configure ...
    kartRefs.current[i] = clone;
    group.add(clone);
  }

  return () => {
    while (group.children.length > 0) group.remove(group.children[0]);
    kartRefs.current.fill(null);
  };
}, [srcScene]);
```

### Why NOT drei `shaderMaterial()` here

No custom GLSL needed for animated karts — plain GLB clones with `.color` tint are sufficient. `shaderMaterial()` + `extend()` is the right pattern when you need a TYPED JSX wake/trail shader with per-frame uniform updates. For this task the material complexity is zero.

### Allocation budget

`clientSpline.centerlineAt/tangentAt/normalAt` each return a new `Vec2` value object (2 numbers). 4 Vec2 per kart per frame × 5 karts = 20 tiny allocations. Acceptable — below V8 GC pressure threshold for value objects. The Object3D transform writes (position.set, rotation.set, updateMatrix) are zero-allocation.

## Context

Shipped in Reef Race v2, `racing-karts.tsx`. Orchestrator wires `<RacingKarts />` into `RiverScene()` to replace 4 static karts. Build: `bun run build` from `apps/web` — TypeScript and compilation pass clean.
