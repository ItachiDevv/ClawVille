---
title: Narrow long corridor ground strip for racing-game perspective
category: pattern
tags: [terrain, racing, ground-plane, corridor, game-design, reef-race]
date: 2026-04-29
confidence: high
threejs_version: r182
---

## Summary

For a top-down or chase-camera racing game, replace a wide square ground plane with a narrow long corridor strip — it matches the actual player perspective (down the track centerline) and saves significant vertex count.

## Details

### The Problem with Wide Squares

A ground plane like 12000×24000 wu exists "just in case" the camera sees it all. But in a racing game with a chase camera, the player only sees perhaps ±2000 wu of width at any given time. The extra 4000+ wu per side on a 12000-wide plane is never visible in gameplay — it's invisible GPU fill.

### The Corridor Design

Replace width to match only what the camera can see from the chase position:

```ts
// WRONG: wide square
const _terrainGeo = new THREE.PlaneGeometry(12000, 24000, 96, 192);
// 36,864 triangles — mostly invisible

// RIGHT: narrow corridor
const _terrainGeo = new THREE.PlaneGeometry(4000, 24000, 32, 192);
// 12,288 triangles — ×0.33 vertex count, same visual coverage
```

Scale X-segments proportionally: 96 → 32 (same 125 wu/segment density in X).
Leave Z-segments unchanged (192) — track length needs the density for smooth hills.

### Displacement Mask Must Track Corridor Width

When the corridor is narrower, the river occupies a bigger fraction of the total width. Update the displacement mask to push hills only into the outer edge band:

```glsl
// River half-width is 1050 wu (lagoon/finish).
// Ground plane half-width is 2000 wu.
// Hills ramp from just outside river (1100) to near the edge (1900).
float displacementMask = smoothstep(1100.0, 1900.0, abs(pos.x));

// Old wide-plane mask (700→1500) was wrong for narrow corridor — hills
// would occupy most of the visible ground.
```

### Bank Shadow Must Track Corridor Width Too

The fragment shader bank-shadow darkening should reference the same scale:

```glsl
// Corridor version (river at ±1050)
float bankShadow = 1.0 - smoothstep(1050.0, 1800.0, abs(vWorldPos.x));

// Old (river at ±700 — don't copy for wider corridors)
// float bankShadow = 1.0 - smoothstep(700.0, 1300.0, abs(vWorldPos.x));
```

### Game Design Rationale

CPs at ±170-200 wu slalom offset inside a ±1050 wu corridor means:
- CP offset / half-width ≈ 19% — CPs are subtle racing-line guidance, not physical chokepoints
- Wall is 850+ wu from the tightest CP (coral: 420 - 180 = 240 wu of clearance on the tight side)
- Mario Kart-wide feel: 2100 wu = ~18 surfboard widths abreast
- Cinematic ratio: 4000 W × 24000 L = 6× longer than wide

This "wide river, narrow world strip" approach is correct for any racing game where:
1. Camera always faces down the centerline
2. Speed matters more than exploration
3. You want the river to visually dominate

## Context

Surfaced in Reef Race v2 (ClawVille) on 2026-04-29 (iter-5). The original ground plane was a 12000×24000 wide square that made the river look like a thin stripe in a big green field. Reshaping to 4000×24000 made the river dominant and removed 24,576 invisible triangles.

Corridor half-widths at the time: lagoon/finish 1050 wu, kelp 630 wu, shipwreck 525 wu, coral 420 wu. CP slalom amplitude: ±170-200 wu. Ground plane: 4000 wu W × 24000 wu L.
