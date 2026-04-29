---
title: Catmull-Rom spline for server-authoritative race-sim corridors
category: pattern
tags: [spline, catmullrom, race-sim, arclength, lut, wall-collision]
date: 2026-04-28
confidence: medium
threejs_version: r170+
---

## Summary

Catmull-Rom spline as the canonical track representation for a server-authoritative race sim — shared between server math and Three.js visual track builder.

## Details

### Why Catmull-Rom over Hermite/natural cubic

- **Interpolating** — curve passes through control points. Server math and 3D art share the same point set without conversion.
- **Local** — tangents are auto-derived from neighbors. Editing one point invalidates two adjacent segments only.
- **Hermite requires** explicit tangent vectors per point (error-prone). Natural cubic requires a global tridiagonal solve (expensive if points change).

### ReefSpline struct

```ts
interface ReefSpline {
  points: Array<{ x: number; z: number; halfWidth: number }>;
  // phantom[0] = points[0] duplicate; phantom[N+1] = points[N-1] duplicate
  totalArcLength: number;
  lut: Array<{ s: number; t: number }>; // ~1000 entries, monotonic
}
```

### Key primitives

- `centerlineAt(spline, t)` — Catmull-Rom position, O(1) segment lookup
- `tangentAt(spline, t)` — analytic derivative, normalize, zero-length guard
- `normalAt(spline, t)` — 90° CCW of tangent in XZ
- `widthAt(spline, t)` — Catmull-Rom interpolation of per-point halfWidth
- `arclengthFromT(spline, t)` — forward LUT walk, binary search + lerp
- `tFromArclength(spline, s)` — inverse LUT walk
- `closestPointOnSpline(spline, x, z)` — Newton's method ~6 iterations from coarse LUT scan

### Arclength LUT

Adaptive Simpson over ~1 000 points at boot. Freeze after build, never write at runtime.

At `REEF_MAX_SPEED=500 wu/s`, 30 000 wu track, 1 000 LUT entries = 30 wu/entry. Body moves 16.7 wu/tick. Binary search error <1 wu. Sufficient.

### Wall collision replacement for enforceWallClamp

```
closest = closestPointOnSpline(spline, body.x, body.z)
if closest.distance > widthAt(spline, closest.t):
  overshoot = closest.distance - halfW
  push body inward by overshoot along perp normal
  kill outward velocity component, apply WALL_TANGENT_FRICTION
  reinject minSlideSpeed if tangent speed below threshold
```

### Open-spline phantom endpoints

Place phantom at `t=0` and `t=1` by duplicating first/last real point. For finish-line endpoint, place phantom 200 wu beyond finish in last segment direction to avoid degenerate tangent.

## Context

Designed for Reef Race v2 slalom river (ClawVille). Replacing ellipse `ellipseScaleAt` + `outerEllipseNormalAt` functions. Architecture doc at `.claude/plans/reef-race-v2-spline-architecture.md`.

**Critical gotcha:** If two spline segments overlap in XZ projection (extreme S-bends), Newton convergence can return the wrong segment. Design control points so track never folds within `REEF_BODY_RADIUS * 4` of itself in XZ.
