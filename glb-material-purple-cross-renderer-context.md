---
title: GLB material purple/pink when scene.clone(true) used across separate renderer contexts
category: gotcha
tags: [glb, material, renderer-context, useGLTF, canvas, purple, pink, MeshStandardMaterial]
date: 2026-05-18
confidence: high
threejs_version: r182
---

## Summary

`scene.clone(true)` on a `useGLTF` cached scene shares `MeshStandardMaterial` references with the original. When the clone is mounted in a **different Canvas** (separate WebGL context), Three.js tries to reuse GPU programs compiled for the original context → purple/pink `#ff00ff` fallback rendering.

## Details

Classic Three.js rule: material GPU programs (WebGLProgram) and texture objects are **context-specific** and cannot be shared across two separate `WebGLRenderer` instances.

`useGLTF` from drei maintains a singleton cache keyed on path. If `/models/lobster.glb` is preloaded in the world Canvas (context A), the `GLTF.scene` in the cache has materials with internal state tied to context A. When the casino Canvas (context B) calls `useGLTF('/models/lobster.glb')` and then `scene.clone(true)`, the clone holds **references** to those same material instances — not copies. Rendering in context B with context-A materials → purple.

**Fix:** After `scene.clone(true)`, traverse the clone and call `mesh.material = mesh.material.clone()` (or `mesh.material.map(m => m.clone())` for multi-material) for every mesh. The cloned material is a fresh JS object with no context-specific GPU state — it compiles fresh in context B on first draw.

```ts
const c = scene.clone(true);
c.traverse((obj) => {
  const mesh = obj as THREE.Mesh;
  if (mesh.isMesh && mesh.material) {
    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map((m) => m.clone());
    } else {
      mesh.material = mesh.material.clone();
    }
  }
});
```

Do NOT dispose the cloned materials on unmount — Three.js disposes materials lazily when the renderer loses the reference after context switch.

## Context

Surfaced in `casino-interior.tsx` CasinoGLBAvatarInner: casino Canvas is route-isolated (separate Canvas from `/game`). World canvas preloads lobster.glb; casino uses the same cache entry without cloning materials → purple legs. Visible as magenta/pink lower torso. Fixed 2026-05-18.

VRM path (`useVRMInstance`) is immune: it does a per-instance parse from raw bytes, producing fresh material instances each time.
