---
title: Spline-tiled CC0 boulder cliffs — geometry extraction + mergeGeometries
category: pattern
tags: [reef-race, glb, cc0, quaternius, spline, cliff, canyon, mergeGeometries, draw-calls]
date: 2026-04-29
confidence: high
threejs_version: r182
---

## Summary

Replace procedural cliff ribbons with real CC0 Quaternius boulder GLBs tiled along a spline, merged into 2 draw calls (one per bank).

## Details

### Asset acquisition (Poly Pizza — no API key needed)

1. Scrape CDN URL from page HTML (JS-rendered but the GLB URL is in the page body):
   ```bash
   curl -sS --ssl-no-revoke -A "Mozilla/5.0" "https://poly.pizza/m/SLUG" | \
     grep -oE "static\.poly\.pizza/[a-zA-Z0-9_-]+\.(glb|gltf)"
   ```
2. Download via `curl --ssl-no-revoke https://static.poly.pizza/UUID.glb`

### Asset optimization pipeline

Quaternius FBX2glTF GLBs have:
- Node `scale=[100,100,100]` — must bake into vertex positions before use
- Large PNG textures (512–1024px) — strip and replace with `baseColorFactor`

Node.js pipeline (no gl-matrix needed — pure inline mat4):
```js
const {NodeIO} = require('@gltf-transform/core');
const {weld, dedup} = require('@gltf-transform/functions');

// 1. Read + bake node transforms into vertices
// 2. Strip textures → flat baseColorFactor
// 3. weld({tolerance:0.01}) + dedup()
// 4. Center XZ + shift y_min=0
```

After baking, verify with `gltf-transform inspect` that bbox is world-scale (not 0-0.04).

### Component architecture

```
RockyCliffs (Suspense wrapper)
  └── CliffLoader (calls useGLTF × 3 variants)
        └── CliffMeshBuilder (useEffect builds merged geos)
              ├── leftMesh (all left-bank rocks merged → 1 draw call)
              └── rightMesh (all right-bank rocks merged → 1 draw call)
```

### Geometry extraction from GLB scene

Since GLBs are baked (identity node transforms), extract like this:
```ts
function extractAndTransformGeos(srcGroup, pos, rotY, scale) {
  // Force srcGroup to identity world for clean matrixWorld
  srcGroup.position.set(0,0,0); srcGroup.rotation.set(0,0,0); srcGroup.scale.set(1,1,1);
  srcGroup.updateMatrixWorld(true);

  const m = new THREE.Matrix4().compose(pos, quaternionFromRotY, new THREE.Vector3(scale,scale,scale));

  const geos = [];
  srcGroup.traverse(child => {
    if (!(child instanceof THREE.Mesh)) return;
    const clone = child.geometry.clone();
    // childLocalMat = child.matrixWorld (srcGroup at identity)
    clone.applyMatrix4(new THREE.Matrix4().multiplyMatrices(m, child.matrixWorld));
    clone.computeVertexNormals();
    geos.push(clone);
  });
  return geos;
}
```

### Canyon placement (3 rows per cross-section)

```ts
// Row A: y=0 (base at ground, rocks extend upward → cliff rim)
// Row B: y=-100 (mid-cliff)
// Row C: y=-200 (waterline)
// Scale 50-70: Rock-1 at scale=60 → height=197wu covers 200wu canyon with one rock
```

### Tri budget

N=36 sections × 3 rows × 2 sides × avg 270 tris = ~58k tris.
Merged to 2 draw calls. Zero per-frame work.

### Iris Xe constraints met

- MeshStandardMaterial (no ShaderMaterial, no InstancedMesh)
- import from 'three' only
- frustumCulled=false + matrixAutoUpdate=false on output meshes
- All work in useEffect (one-time, not per-frame)

## Context

ClawVille Reef Race v2 canyon cliff walls. Replaced procedural 5-vertex ribbon (`rocky-banks.tsx`) that user called "unrealistic" with Quaternius CC0 boulders. Same approach proved successful for trees (Quaternius pine/leafy via poly.pizza). Build verified TypeScript-clean 2026-04-29.

CDN discovery gotcha: Poly Pizza API requires API key. Use curl page-scrape instead.
Transform bake gotcha: `scale=[100,100,100]` on FBX2glTF output — bbox appears as 0.04wu without bake.
