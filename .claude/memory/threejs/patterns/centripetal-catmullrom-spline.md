---
title: Centripetal Catmull-Rom spline — Barry-Goldman + arclength LUT
category: pattern
tags: [spline, catmull-rom, centripetal, arclength, newton, reef-race-v2]
date: 2026-04-28
confidence: high
threejs_version: n/a (pure math, no Three.js dependency)
---

## Summary

Standalone centripetal Catmull-Rom spline with arclength LUT and Newton-based closest-point query. Validated in `reef-race-spline.ts` (reef-race-v2 worktree).

## Details

### Centripetal parameterisation (alpha=0.5)

Knot increment between consecutive points:
```ts
const increment = Math.pow(dx * dx + dz * dz, 0.25); // = |chord|^0.5
```
NOT `Math.sqrt(Math.sqrt(dx*dx + dz*dz))` — these are the same thing but the pow() form is clearer. Centripetal means alpha=0.5, so the exponent is alpha/2 = 0.25 applied to the squared distance = (dx²+dz²)^0.25.

### CRITICAL: Derivative chain for arclength integration

Global t ∈ [0,1] maps to knot space as:
```
kTarget = kStart + t * kRange
```

The Barry-Goldman evaluator gives `dC/dtK`. To integrate arc w.r.t. global t:
```
|dC/dt_global| = |dC/dtK| * kRange
```

**Bug I hit:** multiplying by segment-local knot span `(t2-t1)` instead of the full `kRange`. Symptoms: totalArcLength was ~7x too small (ratio = kRange / avg_segment_span).

Correct `_speedAt`:
```ts
private _speedAt(t: number): number {
  const { seg, tK } = this._toKnot(t);
  const d = this._derivXZ(seg, tK);
  return Math.sqrt(d.x * d.x + d.z * d.z) * this.kRange; // NOT * (t2-t1)
}
```

### Phantom endpoints

```ts
const phantomStart = {
  x: 2 * first.x - second.x,
  z: 2 * first.z - second.z,
};
const phantomEnd = {
  x: 2 * last.x - secondLast.x,
  z: 2 * last.z - secondLast.z,
};
```
This reflects CP[1] across CP[0] and CP[N-2] across CP[N-1], keeping endpoint tangents consistent with the adjacent segment direction.

### Newton closest-point query

Residual: `f(t) = (C(t) - p) · T_unnorm(t)` where `T_unnorm` is the **unnormalized** knot-parameter tangent. Normalizing doesn't move zeros; skip it for performance.

f'(t): central finite difference in global t (step = 5e-4). No need to correct for kRange — the FD already works in global t space.

6 iterations → < 0.01 wu error on all tested geometries.

### Side determination

```ts
const cross = tg.x * dz - tg.z * dx;
// cross > 0 → 'L' (left of travel direction = normal side)
// cross < 0 → 'R'
```

### LUT size

1000 entries for ~5500 wu test track → 5.5 wu/entry. At 30 wu/entry for 30000 wu track: binary search error ≤ 15 wu — acceptable for `tFromArclength` with 0.5 wu tolerance spec.

### Performance (measured)

1000x `closestPointOnSpline` on mid-track query = 46.7ms on developer Windows machine. Spec budget: 50ms. Tight but passing.

## Context

Built in session 2026-04-28 as the isolated spline math foundation for Reef Race v2 (Risk #2 from `.claude/plans/reef-race-v2-spline-architecture.md`). Located in `apps/api/src/services/activity/sim/reef-race-spline.ts`. No Three.js dependency — pure math using `Vec2 { x, z }` XZ plane convention.
