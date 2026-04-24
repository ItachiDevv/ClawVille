---
title: Procedural skirt mesh parented to hip bone on SkinnedMesh rig
category: pattern
tags: [skinned-mesh, bone, procedural-geometry, cloth, skirt, SkeletonUtils]
date: 2026-04-22
confidence: high
threejs_version: r170+
---

## Summary
Attach a CylinderGeometry cone mesh directly to a SkinnedMesh's hip bone so it follows the bone's world transform without any custom shader or simulation.

## Details

```ts
// After SkeletonUtils.clone(gltfScene):
clone.traverse((obj) => {
  if ((obj as THREE.Bone).isBone && obj.name === 'Hips_04') {
    const skirtMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.25, 0.42, 20, 1, true), // open=true = no caps
      new THREE.MeshStandardMaterial({ color: 0x1e3a5f, side: THREE.DoubleSide })
    );
    // Hang below hip joint. Y sign depends on rig convention:
    //   guide.glb uses +Y-up spine, so -Y hangs toward feet.
    skirtMesh.position.set(0, -0.22, 0); // half the skirt height ≈ 0.42/2
    skirtMesh.name = 'ProceduralSkirt';
    obj.add(skirtMesh); // bone.add() — follows bone transform every frame
  }
});
```

Key notes:
- Works in native model-space units (guide.glb is in meters at scale=1). Scale the parent group to 100 to get ~149wu.
- `open=true` skips the top/bottom caps, looks like fabric instead of a bucket.
- `DoubleSide` is required because looking up from below would see back faces.
- Dispose: the geometry/material are module-scope singletons — do NOT dispose them in the unmount cleanup. Only the mesh itself is per-instance.
- Do NOT use `SkinnedMesh` for the skirt itself — it only needs to follow the parent bone rigidly; no vertex weight binding needed.

## Context
Used in `town-guide.tsx` for the town-center guide character. The GLB's cloth material (coat/pants/scarf) has `opacity=0`; a procedural skirt is the only safe way to add minimal clothing without editing the asset.
