---
title: Box3.setFromObject() inflates bbox on SkinnedMesh scenes
category: gotcha
tags: [skinned-mesh, bounding-box, normalization, scale, characters]
date: 2026-04-16
confidence: high
threejs_version: r170+
---

## Summary
`Box3.setFromObject(scene)` on a scene containing `SkinnedMesh` uses the bind-pose
world matrix for skinned nodes, which can inflate the bounding box far beyond the
visible rest-pose geometry — sometimes 60-100x.

## Details

### Root cause
Three.js `Box3.setFromObject()` traverses all children and expands the box using each
object's `matrixWorld`. For `SkinnedMesh`, the bind pose (the T-pose the skeleton was
rigged in) may extend far outside the rest-pose visual geometry. Concretely:
- A character whose bind pose has arms fully extended will have a bbox 2-3x wider
  than the resting/standing mesh
- A computer-screen character (Karen) whose bind-pose skeleton is essentially flat at
  y≈0 gives a near-zero Y bbox, causing `scale = TARGET / near-zero` to blow up to
  thousands — world height 1940 when targeting 32

### Symptoms observed in ClawVille
- Karen (karen.glb): world height 1940 at CHARACTER_HEIGHT=32 (expected 32)
- Larry (lobster_plush.glb): world height 331 at CHARACTER_HEIGHT=32 (expected 32)
- 8/10 location NPCs: world height 17-87 at CHARACTER_HEIGHT=32 (variable quality)

### Fix
Instead of `Box3.setFromObject(scene)`, traverse only non-SkinnedMesh nodes and
compute the bbox from each mesh's geometry bbox transformed by `mesh.matrixWorld`:

```ts
scene.updateMatrixWorld(true);  // ensure world matrices are current before scene is parented

const bbox = new THREE.Box3();
bbox.makeEmpty();

scene.traverse((child) => {
  if ((child as THREE.Mesh).isMesh && !(child as THREE.SkinnedMesh).isSkinnedMesh) {
    const mesh = child as THREE.Mesh;
    if (!mesh.geometry) return;
    mesh.geometry.computeBoundingBox();
    const geoBB = mesh.geometry.boundingBox;
    if (!geoBB) return;
    const meshBox = new THREE.Box3().copy(geoBB).applyMatrix4(mesh.matrixWorld);
    bbox.union(meshBox);
  }
});

// Fallback if scene has ONLY skinned meshes
if (bbox.isEmpty()) bbox.setFromObject(scene);
```

Call `scene.updateMatrixWorld(true)` first — cloned scenes not yet in the live
scene graph haven't had `updateMatrixWorld` called by the renderer.

Use module-scope scratch objects for `meshBox` / temp vectors to avoid per-call GC.

### Sanity clamp + per-model override
Even the non-skinned bbox can fail for some GLBs (flat meshes at y=0, helper objects).
Add a sanity clamp: if computed scale < `targetH / 200` (implying native H > 200) or
> `targetH / 0.01` (degenerate), fall back to a per-model `scaleOverride`.

### Where implemented in ClawVille
- `arena-location-npcs.tsx` — `computeNormalizedScale()`
- `arena-buildings.tsx` — `computeBuildingScale()`

## Context
Surfaced during the 2026-04-16 scale regression audit. CDP bbox sweep revealed Karen at
1940 world units and Larry at 331 at CHARACTER_HEIGHT=32 — both caused by skinned mesh
bind-pose inflation. Fixed by per-mesh geometry traversal + SkinnedMesh exclusion.
