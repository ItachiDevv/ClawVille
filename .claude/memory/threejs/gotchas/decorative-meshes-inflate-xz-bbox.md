---
title: Decorative child meshes inflate XZ bbox and trigger MAX_FOOTPRINT cap
category: gotcha
tags: [glb, bounding-box, buildings, pineapple-house, footprint-cap, strip]
date: 2026-04-16
confidence: high
threejs_version: r170+
---

## Summary

Flat decorative GLB children (Flowers, Path) inflate the XZ bounding box even after `stripGroundPlanes`, triggering the `MAX_FOOTPRINT` cap and shrinking building height far below the 800 target.

## Details

`pineapple-house.glb` has four top-level groups: `SpongebobsHouse`, `Chimney`, `Flowers`, `Path`. Flowers and Path are flat planes that inflate the XZ bbox to ~1852 × 1415 wu. After height normalization to 800, `max(scaledSz, scaledSx)` = 1852 wu exceeds `MAX_FOOTPRINT = 1000`, triggering a footprint-cap scale reduction. The result: rendered height ~432 instead of 800.

`stripGroundPlanes` does NOT remove these because they are not at the very bottom of the model (they sit mid-height) and the flat-mesh test keys on XZ > 2 && sy/maxXZ < 0.005, which these may not pass.

Fix: add `stripDecorativeMeshes(scene)` called BEFORE `stripGroundPlanes`:

```ts
const DECORATIVE_PARENT_NAMES = new Set(['Flowers', 'Path']);

function stripDecorativeMeshes(scene: THREE.Object3D): void {
  const toRemove: THREE.Object3D[] = [];
  scene.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return;
    let p: THREE.Object3D | null = child.parent;
    while (p) {
      if (p.name && DECORATIVE_PARENT_NAMES.has(p.name)) {
        toRemove.push(child);
        break;
      }
      p = p.parent;
    }
  });
  toRemove.forEach((obj) => obj.removeFromParent());
}
```

After removing Flowers+Path, pineapple bbox shrinks to near 1:1 aspect ratio (SpongebobsHouse+Chimney only) and the footprint cap does not fire — rendered height reaches 800.

## Context

Diagnosed 2026-04-16 via live CDP measurement: canvas-studio showed 1000×432×764 instead of expected ~800 tall. The set `DECORATIVE_PARENT_NAMES` is narrow on purpose — add names as new GLBs require it. Do NOT expand it blindly; some GLBs may have parents named `Path` that ARE structural geometry.
