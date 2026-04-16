---
title: Draw call reduction techniques
category: performance
tags: [draw-calls, batching, instancing, merging, optimization]
date: 2026-04-08
confidence: high
threejs_version: r170+
---

## Summary
Reducing draw calls is the single biggest performance win in most Three.js scenes.

## Details

### Technique hierarchy (most to least effective):

1. **Instanced rendering** — same geometry, different transforms
   ```typescript
   const mesh = new InstancedMesh(geometry, material, count);
   const matrix = new Matrix4();
   for (let i = 0; i < count; i++) {
     matrix.setPosition(x, y, z);
     mesh.setMatrixAt(i, matrix);
   }
   mesh.instanceMatrix.needsUpdate = true;
   ```
   → 1 draw call for N objects

2. **Geometry merging** — different positions baked into one geometry
   ```typescript
   import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
   const merged = mergeGeometries(geometries);
   const mesh = new Mesh(merged, sharedMaterial);
   ```
   → 1 draw call, but can't move individual objects

3. **Texture atlasing** — combine textures, share one material
   → Reduces material swaps

4. **LOD** — fewer triangles at distance
   ```typescript
   const lod = new LOD();
   lod.addLevel(highDetailMesh, 0);
   lod.addLevel(medDetailMesh, 50);
   lod.addLevel(lowDetailMesh, 200);
   ```

### Targets:
- **< 100 draw calls** — smooth on integrated GPUs
- **< 300 draw calls** — acceptable on dedicated GPUs
- **> 500 draw calls** — likely performance issues on mobile

### Measuring:
```typescript
console.log(renderer.info.render.calls); // draw calls per frame
console.log(renderer.info.render.triangles); // triangles per frame
console.log(renderer.info.memory.geometries); // loaded geometries
```

## Context
Universal Three.js optimization knowledge. Draw calls are almost always the bottleneck before triangle count.
