---
title: Spline-ribbon vertex shader — world-space XZ noise + large amplitude = sawtooth from altitude
category: gotcha
tags: [reef-race, spline, ribbon, shader, noise, displacement, altitude-camera, zigzag]
date: 2026-04-29
confidence: high
threejs_version: r182
---

## Summary

Sampling vertex-displacement noise at `position.xz` (world coordinates) on a spline-following ribbon, combined with amplitude >30wu, produces shark-teeth / zigzag sawtooth from a high-altitude camera.

## Details

The ground ribbon geometry sweeps from 4000-10000wu lateral world distance from the spline centerline. When the vertex shader samples `valueNoise(position.xz * scale)`:

1. **Non-uniform density on curves**: the outer edge (10000wu) covers 2.4× more world-XZ per spline t-step than the inner edge (4000wu). At curve sections, the spline normal rotates, causing adjacent row vertices to jump in world XZ unpredictably. This creates noise features that are compressed on the inner edge and stretched on the outer edge.

2. **Amplitude vs. vertex step ratio**: with ±50wu amplitude and 93wu lateral vertex spacing, adjacent displaced vertices form near-90° dihedral angles. From altitude 23770wu, each vertex is 1-2 pixels — the steep dihedral renders as alternating-triangle zigzag ("shark teeth") rather than smooth hills.

## Fix

Replace `position.xz * worldScale` with `uv * uvScale`:
```glsl
// WRONG — world XZ at 4000-10000wu from center causes non-uniform noise
// float n1 = valueNoise(position.xz * 0.0006);

// CORRECT — UV is uniform [0,1] regardless of spline curvature
vec2 uvScale1 = vec2(6.0, 14.0);   // ~6 lateral hills, ~14 along track
vec2 uvScale2 = vec2(14.0, 30.0);  // fine detail octave
float n1 = valueNoise(uv * uvScale1) * 2.0 - 1.0;
float n2 = valueNoise(uv * uvScale2) * 0.5 - 0.25;
// Amplitude ≤12wu — keeps angle between adjacent verts <10° for 93wu step
float noiseVal = (n1 + n2) * 12.0;
```

Also update the fragment shader's normalizer: `clamp(vDisp / 12.0, -1.0, 1.0)` (was `/50.0`).

## Context

Reef Race v2 `_groundVertexShader` iter-9 fix. The Auditor approved iter-9's winding math (correctly — the winding was sound), but missed this shader-level issue. Diagnosed via: amplitude/step ratio analysis (50/93 = 54% → near-90° dihedral) + UV vs world-space parameterization analysis. Build verified clean. Deployed 2026-04-29.
