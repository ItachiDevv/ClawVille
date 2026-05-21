---
title: matrixAutoUpdate=false on primitive root blocks R3F scale prop from taking effect
category: gotcha
tags: [r3f, matrixAutoUpdate, scale, primitive, glb, invisible, black-screen]
date: 2026-05-18
confidence: high
threejs_version: r182
---

## Summary

Setting `matrixAutoUpdate=false` on a GLB's root Object3D (via `scene.traverse`) BEFORE passing it to `<primitive scale={n} />` causes the model to render at native micro-scale — invisible — because R3F writes to `.scale` but Three.js never recomputes the matrix.

## Details

Pattern that fails:

```javascript
const c = scene.clone(true);
c.updateMatrixWorld(true);
c.traverse(obj => { obj.matrixAutoUpdate = false; }); // ← locks root too
const fit = computeAutoFit(c, TARGET_HEIGHT);
// ...
return <primitive object={c} scale={fit.scale} />; // ← R3F writes c.scale but matrix never updates
```

What happens: R3F calls `c.scale.set(fit.scale, fit.scale, fit.scale)` and then calls `c.updateMatrix()` — but wait, no. R3F's reconciler sets props directly on the Three.js object. With `matrixAutoUpdate=false`, `updateMatrix()` is only called if THREE.js internal code calls it. For a `<primitive>`, R3F sets the scale prop but does NOT call `updateMatrix()` explicitly. So `c.matrix` stays at identity. The model renders at scale=1 (native tiny GLB size), which may be 0.001 to 5 world units for a meter-scale Blender export.

If the group position was computed for the 600wu scaled version (e.g., offsetX = center.x * 600), but the model is actually rendering at scale=1, the model is both microscopic AND offset to an empty region of space. Camera sees background color only.

## Fix

Apply the scale directly to the cloned root BEFORE setting `matrixAutoUpdate=false`, then call `updateMatrixWorld`:

```javascript
const c = scene.clone(true);
c.updateMatrixWorld(true);

// Measure at native scale=1
const fit = computeAutoFit(c, TARGET_HEIGHT);

// Apply scale to the root — THREE.js owns the matrix now
c.scale.setScalar(fit.scale);
c.updateMatrixWorld(true); // bake scale into all child world matrices

// NOW lock — matrices are correct
c.traverse(obj => { obj.matrixAutoUpdate = false; });

// <primitive> gets NO scale prop — it's already in the matrix
return <primitive object={c} />;
```

Group positioning still uses `fit.offsetX/Y/Z = center * scale` (computed before scale was applied), which remain correct.

## Context

Surfaced in casino-interior.tsx (Concern 6.0.2). Both GLBs loaded successfully (confirmed via `performance.getEntriesByType`) but the canvas was pitch black. No console errors because Three.js silently renders the microscopic model. Fix commit: 2995aa8.

The same bug would occur on any component that: (1) clones a GLB scene, (2) disables matrixAutoUpdate via traverse, (3) relies on R3F's prop system to apply scale after the fact.
