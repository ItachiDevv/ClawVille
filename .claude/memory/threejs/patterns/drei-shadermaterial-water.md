---
title: drei shaderMaterial() factory — modern R3F pattern for custom materials
category: pattern
tags: [drei, shadermaterial, extend, r3f, useframe, typescript, water, reef-race]
date: 2026-04-29
confidence: high
threejs_version: r182
---

## Summary
Use `shaderMaterial()` from `@react-three/drei` + `extend()` from `@react-three/fiber` to declare custom shader materials in the modern R3F idiom — uniform defaults become JSX props AND typed setters on the material instance.

## Details

### Factory + extend (module scope — runs once on import)
```tsx
import { shaderMaterial } from '@react-three/drei';
import { extend } from '@react-three/fiber';
import * as THREE from 'three';

export const WaterMaterial = shaderMaterial(
  // Uniform defaults → JSX props + class instance setters
  {
    uTime:      0,
    uColorNear: new THREE.Color('#5fdcff'),
    uColorFar:  new THREE.Color('#3aaedf'),
    uTextureSize: 45,
  },
  vertexShaderString,
  fragmentShaderString,
);

// Register with R3F — exactly once at module scope
extend({ WaterMaterial });
```

### TypeScript JSX declaration
```tsx
declare module '@react-three/fiber' {
  interface ThreeElements {
    waterMaterial: ThreeElements['shaderMaterial'] & {
      uTime?: number;
      uColorNear?: THREE.Color;
      uColorFar?: THREE.Color;
      uTextureSize?: number;
    };
  }
}
```

### Ref type
```tsx
// InstanceType<typeof WaterMaterial> gives the generated class instance
const matRef = useRef<InstanceType<typeof WaterMaterial>>(null);
```

### useFrame uniform update (direct property, not .uniforms.xxx.value)
```tsx
useFrame((state) => {
  if (matRef.current) {
    // drei generates setters that write through to uniforms[key].value
    matRef.current.uTime = state.clock.elapsedTime;
  }
});
```

### JSX usage
```tsx
<mesh geometry={geo} position={...} rotation={...} frustumCulled={false}>
  <waterMaterial
    ref={matRef}
    side={THREE.DoubleSide}
    fog={true}
    key={WaterMaterial.key}  // key prop forces shader recompile on HMR
  />
</mesh>
```

### Material is a class — `WaterMaterial.key` for HMR
drei shaderMaterial() returns a class. `key={WaterMaterial.key}` passes a stable key to the JSX element which forces shader recompilation on HMR hot-reload.

### Why not THREE.ShaderMaterial directly?
Both work on Iris Xe when used with plain `<mesh>` (NOT InstancedMesh). The drei pattern is superior because:
1. Uniform defaults auto-wire to JSX props (no `material.uniforms.uTime.value = …` boilerplate)
2. TypeScript declaration gives full type checking on JSX props
3. HMR works cleanly via `key={WaterMaterial.key}`
4. `extend()` at module scope means zero runtime overhead — class is registered once

### Iris Xe constraint reminder
The crash gotcha is `InstancedMesh + ShaderMaterial` (silent, no console errors).
`plain Mesh + ShaderMaterial` = safe. This pattern uses plain Mesh → safe.

## Context
Built for `apps/web/src/lib/three/activities/reef-race/water-material.tsx` as part of the Reef Race v2 water shader extraction. Sets the precedent for all future custom shader materials in ClawVille. Build verified TypeScript-clean 2026-04-29.
