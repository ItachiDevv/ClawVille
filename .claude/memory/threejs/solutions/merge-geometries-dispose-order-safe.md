---
title: mergeGeometries + dispose source geos after merge is safe — data is copied not referenced
category: solution
tags: [mergeGeometries, BufferGeometryUtils, dispose, memory, WebGPU]
date: 2026-04-13
confidence: high
threejs_version: r170+
---

## Summary
Disposing source BufferGeometries after `mergeGeometries()` is safe. The merged result holds independently-allocated typed arrays — no shared buffer references.

## Details
`mergeGeometries(geos, useGroups)` internally calls `mergeAttributes()` which:
1. Allocates a brand-new `TypedArray` sized for all source data combined.
2. Copies each source attribute via `array.set(attribute.array, offset)`.
3. Wraps in a new `BufferAttribute`.

The merged geometry never holds a reference to any source attribute array.

`BufferGeometry.dispose()` only signals the renderer to free the associated WebGL/WebGPU buffer objects. The JavaScript typed array is GC'd independently. The merged geometry's GPU buffers are separate objects and are unaffected.

**Correct pattern:**
```ts
const merged = mergeGeometries(geometries, false); // copies data
for (const g of geometries) g.dispose();           // safe — merged is independent
```

**Wrong (would be broken):**
```ts
for (const g of geometries) g.dispose(); // WRONG — dispose BEFORE merge
const merged = mergeGeometries(geometries, false);
```

## Context
Audited in ClawVille merged-seaweed.tsx Round 4 (2026-04-13). The fix that added the dispose loop placed it correctly after the merge on line 360 vs merge on line 358. Verified against Three.js source.
