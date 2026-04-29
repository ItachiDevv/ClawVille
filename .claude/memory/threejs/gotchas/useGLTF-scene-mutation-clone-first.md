---
title: useGLTF cached scene must be cloned before mutating transforms
category: gotcha
tags: [useGLTF, drei, gltf-cache, clone, mutation, geometry-extraction]
date: 2026-04-29
confidence: high
threejs_version: r182
---

## Summary
Calling `position.set()`, `rotation.set()`, `scale.set()` on the `THREE.Object3D` returned by `useGLTF` mutates the shared cached scene — corrupting every subsequent consumer of that GLB.

## Details
`useGLTF` returns the same parsed GLB scene object from its internal cache. Any code that resets transforms on that object (e.g. to force identity world matrix before geometry extraction) permanently alters the cache. On Suspense retry, dev fast-refresh, or parent re-render with a new key, the second extraction operates on the already-mutated source.

**Wrong:**
```ts
function extractAndTransformGeos(srcGroup: THREE.Object3D, ...) {
  srcGroup.position.set(0, 0, 0);  // MUTATES CACHE
  srcGroup.rotation.set(0, 0, 0);  // MUTATES CACHE
  srcGroup.scale.set(1, 1, 1);     // MUTATES CACHE
  srcGroup.updateMatrixWorld(true);
  srcGroup.traverse(child => { /* ... */ });
}
```

**Correct:**
```ts
function extractAndTransformGeos(srcGroup: THREE.Object3D, ...) {
  const workGroup = srcGroup.clone(true); // deep clone — full subtree
  workGroup.position.set(0, 0, 0);
  workGroup.rotation.set(0, 0, 0);
  workGroup.scale.set(1, 1, 1);
  workGroup.updateMatrixWorld(true);
  workGroup.traverse(child => { /* extract geometry from child */ });
  // workGroup is discarded — no GPU resources, GC'd normally
}
```

Note: geometry clones inside the traversal (`geom.clone()`) do allocate CPU-side typed arrays. Those are independent of the workGroup and are safe — they're the payloads you're accumulating.

## Context
Surfaced in rocky-cliffs.tsx during the Reef Race v2 cliff-rock implementation. The function was called 108 times per build (36 sections × 3 rows × 1 scene ref per row) on the same 3 cached scene objects — meaning scene 0 was mutated to identity on call 1 and all subsequent reads from that same cache ref got the mutated version.
