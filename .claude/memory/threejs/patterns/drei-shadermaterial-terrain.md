---
title: drei shaderMaterial() factory — modern R3F terrain pattern
category: pattern
tags: [drei, shaderMaterial, extend, R3F, ShaderMaterial, uniforms, TypeScript]
date: 2026-04-29
confidence: high
threejs_version: r182
---

## Summary

Use drei's `shaderMaterial()` factory + `extend()` instead of a plain `THREE.ShaderMaterial` for custom shaders in R3F scenes. This is the canonical modern idiom.

## Details

### The pattern

```tsx
import { shaderMaterial } from '@react-three/drei';
import { extend, useFrame } from '@react-three/fiber';
import * as THREE from 'three';

// 1. Create the class constructor
export const TerrainMaterial = shaderMaterial(
  { uTime: 0 },           // uniforms (initial values)
  vertexShader,
  fragmentShader,
  (mat) => {              // optional onInit — set non-default flags
    if (!mat) return;
    mat.side = THREE.FrontSide;
    mat.fog = true;
  },
);

// 2. Register JSX element with R3F
extend({ TerrainMaterial });

// 3. TypeScript augmentation — use ThreeElements['shaderMaterial'] as base
declare module '@react-three/fiber' {
  interface ThreeElements {
    terrainMaterial: ThreeElements['shaderMaterial'] & { uTime?: number };
  }
}

// 4. Component
export function TerrainShader() {
  const matRef = useRef<InstanceType<typeof TerrainMaterial>>(null);

  useFrame(({ clock }) => {
    if (matRef.current) {
      // Direct property assignment — drei proxies mat.uTime → uniforms.uTime.value
      matRef.current.uTime = clock.elapsedTime;
    }
  });

  return (
    <mesh geometry={moduleGeo}>
      <terrainMaterial ref={matRef} />
    </mesh>
  );
}
```

### Key points

1. **`shaderMaterial()` returns a constructor**, not an instance. Pass it to `extend()`.

2. **Uniform proxy**: drei's implementation creates property getters/setters on the class
   so `mat.uTime = val` writes `mat.uniforms.uTime.value = val`. Zero allocation.

3. **`onInit` callback** (4th argument): called with the material instance immediately
   after construction. This is the only place to set `side`, `fog`, `transparent`, etc.
   — you cannot pass these via the `shaderMaterial()` factory itself.

4. **TypeScript augmentation**: do NOT use `JSX.IntrinsicElements` — that namespace
   is unavailable in `.tsx` module augmentation context and causes a compile error.
   Use `ThreeElements['shaderMaterial']` as the base type instead.

5. **Ref type**: `useRef<InstanceType<typeof TerrainMaterial>>(null)` gives you the
   correctly typed instance including the proxied uniform properties.

6. **Module-scope geometry**: still put `new THREE.PlaneGeometry(...)` at module scope
   to avoid rebuilding heavy geometry on every mount. The drei pattern only changes
   the material declaration, not the geometry strategy.

### What this replaces

Old (imperative):
```tsx
const _mat = new THREE.ShaderMaterial({
  vertexShader, fragmentShader, uniforms: { uTime: { value: 0 } },
  side: THREE.FrontSide, fog: true,
});

// In useFrame:
_mat.uniforms.uTime.value = clock.elapsedTime;
```

New (declarative):
```tsx
// Material is JSX child; ref gives direct property access.
// Orchestrator can wire additional JSX props if needed later.
```

### Gotcha: `fog` flag must go in onInit

`fog: true` cannot be passed to `shaderMaterial()` as a factory option — it is set on
the THREE.ShaderMaterial base and must be applied in the `onInit` callback. Forgetting
this leaves `fog = false` (the ShaderMaterial default), so the terrain won't blend into
the scene fog.

## Context

Surfaced during Reef Race v2 terrain-shader.tsx migration (2026-04-29).
Existing `THREE.ShaderMaterial` pattern was correct but used the imperative
module-scope singleton pattern. The drei `shaderMaterial()` factory registers the
material as a proper R3F JSX element, enabling declarative prop updates and consistent
patterns with all other ClawVille shader components going forward.

Build verified green on Next.js 16 / @react-three/fiber 9.5.0 / @react-three/drei 10.7.7.
