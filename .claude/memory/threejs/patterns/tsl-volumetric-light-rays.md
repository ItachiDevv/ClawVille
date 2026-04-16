---
title: TSL volumetric light rays (god rays) with pulsing opacity
category: pattern
tags: [tsl, MeshBasicNodeMaterial, CylinderGeometry, AdditiveBlending, opacity, animation, sin, time, WebGPU, god-rays, light-shafts, underwater]
date: 2026-04-09
confidence: medium
threejs_version: r182
---

## Summary
Fake volumetric god rays using open-ended CylinderGeometry cones + MeshBasicNodeMaterial with AdditiveBlending and TSL sin(time) pulsing opacity. 7 draw calls, zero CPU per frame.

## Details

### Core approach
- `THREE.CylinderGeometry(radiusTop, radiusBottom, height, 6, 1, true)` — 6 radial segments, open-ended (no caps). radiusTop=1.5–3 (narrow, near surface), radiusBottom=30–55 (wide, near floor). `openEnded: true` skips caps, saves triangles, and looks better for a translucent shaft.
- `THREE.MeshBasicNodeMaterial` + `THREE.AdditiveBlending` — adds light, never darkens.
- `depthWrite: false`, `transparent: true`, `side: THREE.DoubleSide`.
- Tilt via Euler rotation (rx ≈ ±0.05–0.12, rz ≈ ±0.06–0.14) for natural asymmetry.

### TSL pulsing opacity
```typescript
import { float, vec3, sin, time } from 'three/tsl';

// Maps sin wave to [opacityMin, opacityMax]
const sinWave = sin(time.mul(float(speed)).add(float(phase)));
const normalized = sinWave.mul(float(0.5)).add(float(0.5)); // [0, 1]
const range = opacityMax - opacityMin;
const opacity = normalized.mul(float(range)).add(float(opacityMin));

mat.opacityNode = opacity;
mat.colorNode = vec3(float(1.0), float(0.937), float(0.733)); // warm sunlight #ffeebb
```
Each ray has a distinct `speed` (0.19–0.40 rad/s) and `phase` (0–5.1 rad) so they pulse independently — looks organic, not synchronized.

### Ray layout
Position y = vertical midpoint of the cylinder (not the bottom). With `height=300` and cylinder centred at `y=150`, the ray spans y=0 to y=300, which is ground to above buildings. Spread rays across x: −230..220, z: −160..120 to cover the main building cluster.

### Opacity values that work
- `opacityMin: 0.008–0.015` / `opacityMax: 0.038–0.06`
- Total range stays well below 0.06 — AdditiveBlending means multiple overlapping rays compound, so each individual ray must stay very subtle.

### Static ray definitions
All `RayDef` objects are module-level constants (not state), so `useMemo(() => ..., [])` safely treats them as stable — no dep-array lint issue beyond the eslint-disable comment.

## Context
Built for ClawVille underwater world. Placed in scene after `UnderwaterAtmosphere`. 7 meshes = 7 draw calls. All animation is GPU-driven via TSL `time` node. Warm color `#ffeebb` matches the scene's directional light at `position=[150, 350, 80]`.
