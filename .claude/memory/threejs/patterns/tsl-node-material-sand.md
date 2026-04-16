---
title: TSL MeshStandardNodeMaterial for procedural sand terrain
category: pattern
tags: [tsl, MeshStandardNodeMaterial, sand, terrain, colorNode, roughnessNode, normalNode, vertexColor, positionLocal, WebGPU]
date: 2026-04-09
confidence: medium
threejs_version: r182
---

## Summary
Pattern for upgrading a `meshStandardMaterial vertexColors` to a TSL `MeshStandardNodeMaterial` with procedural ripples, height tinting, roughness variation, and normal perturbation.

## Details

### Safe TSL imports (confirmed working in ClawVille r182)
```typescript
import {
  float, vec3, sin, cos, fract,
  positionLocal, vertexColor,
  mix, smoothstep,
} from 'three/tsl';
import * as THREE from 'three/webgpu';
```

### Material creation pattern
```typescript
const mat = new THREE.MeshStandardNodeMaterial({
  vertexColors: true,
  metalness: 0.0,
});

// positionLocal.x / .y / .z — fragment position in object space
// For a PlaneGeometry rotated -PI/2, Z holds the baked vertex height.
const px = positionLocal.x;
const py = positionLocal.y;

// Ripple pattern — two angled sine waves, remapped to [0,1]
const ripple = sin(px.mul(float(0.07)).add(py.mul(float(0.05))))
  .add(sin(px.mul(float(0.11)).sub(py.mul(float(0.08))).add(float(2.3))))
  .mul(float(0.25)).add(float(0.5));

// Grain hash — fract(sin_a + sin_b) * large_constant
const grain = fract(
  sin(px.mul(float(3.7)).add(py.mul(float(7.3))))
    .add(sin(px.mul(float(5.1)).sub(py.mul(float(7.03)))))
    .mul(float(43.758))
);

// Height-based blend (geometry height in positionLocal.z)
const heightT = smoothstep(float(-28.0), float(28.0), positionLocal.z);
const tinted = mix(vertexColor(), mix(coolDeep, warmSand, heightT), float(0.28));

mat.colorNode = tinted.mul(ripple.mul(float(0.18)).add(float(0.82)))
                      .mul(grain.mul(float(0.06)).add(float(0.97)));

mat.roughnessNode = mix(float(0.55), float(0.92), heightT);

// Normal perturbation — keep bumpAmp very small (< 0.1) or normals look wrong
mat.normalNode = vec3(
  sin(px.mul(float(0.15)).add(float(1.1))).mul(float(0.04)),
  cos(py.mul(float(0.15)).add(float(0.7))).mul(float(0.04)),
  float(1.0)
);
```

### In JSX — pass via `material` prop, NOT as child element
```tsx
// CORRECT:
<mesh geometry={geo} material={mat} rotation={[-Math.PI/2,0,0]} position={[0,-2,0]} />

// WRONG (loses node material, reverts to standard):
<mesh geometry={geo}><meshStandardMaterial /></mesh>
```

### vertexColor() vs vertexColors option
`vertexColors: true` on the constructor PLUS `vertexColor()` in the node graph are BOTH needed. The constructor option tells Three.js the geometry has a color attribute; `vertexColor()` is the TSL node that reads it.

## Context
Used in ClawVille `apps/web/src/lib/three/arena-terrain.tsx` to upgrade the sand floor from flat programmer-art to a richly layered underwater sand look.
