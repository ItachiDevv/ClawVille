---
title: Instanced boulder cluster cliff — InstancedMesh per GLB variant along spline
category: pattern
tags: [instanced-mesh, gltf, reef-race, cliff, spline, performance, iris-xe]
date: 2026-04-29
confidence: high
threejs_version: r182
---

## Summary

Build a chaotic scattered-rock cliff face by extracting geometry+material from loaded GLBs,
creating one InstancedMesh per GLB variant, and placing instances along a spline corridor edge.

## Details

**Key pattern: extract mesh from GLTF scene, feed into InstancedMesh**

```tsx
function RockVariant({ path, xforms }) {
  const { scene } = useGLTF(path);
  const groupRef  = useRef<THREE.Group>(null);

  useEffect(() => {
    const gr = groupRef.current;
    if (!gr || !scene || xforms.length === 0) return;

    let srcMesh: THREE.Mesh | null = null;
    scene.traverse((o) => {
      if (!srcMesh && (o as THREE.Mesh).isMesh) srcMesh = o as THREE.Mesh;
    });
    if (!srcMesh) return;

    const geo = srcMesh.geometry;
    const mat = srcMesh.material as THREE.Material;

    // InstancedMesh + MeshStandardMaterial — SAFE on Iris Xe
    // InstancedMesh + ShaderMaterial CRASHES WebGPU silently — DO NOT USE
    const im = new THREE.InstancedMesh(geo, mat, xforms.length);
    im.frustumCulled = true;    // let bbox cull hairpin half
    im.matrixAutoUpdate = false;

    // Place all instances
    const dummy = new THREE.Object3D();
    for (let i = 0; i < xforms.length; i++) {
      const xf = xforms[i];
      dummy.position.set(xf.x, xf.y, xf.z);
      dummy.rotation.set(xf.rotX, xf.rotY, xf.rotZ, 'YXZ');
      dummy.scale.setScalar(xf.scale);
      dummy.updateMatrix();
      im.setMatrixAt(i, dummy.matrix);
    }
    im.instanceMatrix.needsUpdate = true;
    im.updateMatrix();

    gr.add(im);
    return () => { gr.remove(im); /* do NOT dispose geo/mat — owned by GLB cache */ };
  }, [scene]);

  return <group ref={groupRef} />;
}
```

**Pre-compute transforms at module scope** — spline is available at module load.
Build all xforms once; useEffect just writes matrices.

**Two-layer stacking** for cliff character:
- Lower layer at y=0 (ground level): full-scale boulders at corridor rim
- Upper layer at y=40-110: ~70% probability, slightly smaller boulders stacked on top
- Upper boulders have larger rotX/rotZ tilt for natural tumble look

**Seeded deterministic random** for stable placement across re-renders:
```ts
function seededRand(seed: number) {
  let s = (seed * 1664525 + 1013904223) | 0;
  return { next(): number { s = ((s ^ (s<<13)) ^ (s>>>17) ^ (s<<5)) | 0; return (s>>>0)/0xffffffff; } };
}
```

**Variant round-robin** for draw call efficiency:
3 GLB variants → 3 InstancedMesh draw calls regardless of instance count.
Variant assigned by `placementIdx % 3` so each IM gets ~equal allocation.

## Context

Built for Reef Race v2 as an alternative to the continuous cliff wall approach.
Reuses existing `prop-rock-{1,2,3}.glb` (80 tris each) rather than new assets.
N=60 spline sections × 2 sides × 2 clusters × 1.7 avg layers ≈ 408 instances total.
408 × 80 tris = 32,640 tris — well within Iris Xe 80k visible budget.
Draw calls: 3 (one IM per variant).

**When to choose scatter over continuous cliff:**
- "Organic" / "real coastline" aesthetic preferred over uniform wall
- Track needs visual variety (density can vary by spline section)
- Rock count stays low enough for IM to win vs merged mesh (< ~500 instances of same geo)

**Gotcha**: Do NOT dispose the extracted `geo` or `mat` on unmount — they are owned by
the useGLTF cache. Just remove the IM from the parent group.
