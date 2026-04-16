---
title: TSL underwater atmosphere — caustic plane, depth backdrop, dust particles
category: pattern
tags: [tsl, MeshBasicNodeMaterial, PointsNodeMaterial, Points, caustic, atmosphere, WebGPU, opacity, additive-blending, animation]
date: 2026-04-09
confidence: medium
threejs_version: r182
---

## Summary
Three GPU-driven underwater effects using only TSL NodeMaterials and THREE.Points — no post-processing, no InstancedMesh, no raw ShaderMaterial.

## Details

### Caustic light plane (MeshBasicNodeMaterial + AdditiveBlending)
```typescript
const mat = new THREE.MeshBasicNodeMaterial({
  transparent: true,
  depthWrite: false,
  side: THREE.DoubleSide,
  blending: THREE.AdditiveBlending,
});
// uv() gives [0,1] coords on the plane geometry
const u = uv().x;
const v = uv().y;
const w1 = sin(u.mul(float(6.0)).add(v.mul(float(3.0))).add(time.mul(float(0.4))))
  .mul(float(0.5)).add(float(0.5));
// ... more waves ...
const caustic = w1.mul(w2).mul(w3).mul(w4); // sharp bright spots
mat.colorNode = vec3(float(0.5), float(0.85), float(1.0)).mul(caustic);
mat.opacityNode = caustic.mul(float(0.10)); // per-pixel opacity
```
Place at y=150, rotation=[-Math.PI/2, 0, 0], frustumCulled={false}.

### Depth gradient backdrop (MeshBasicNodeMaterial)
```typescript
const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
const vCoord = uv().y; // 0 at bottom, 1 at top
const gradient = mix(deepColor, shallowColor, vCoord);
mat.colorNode = gradient;

// Edge-fade in X: prevents hard vertical wall at the wings of the plane.
// uv().x → 0..1; map to 0=center, 1=edge, then linear fade in outer 40%.
const edgeDist = uv().x.sub(float(0.5)).mul(float(2.0)).abs();
const edgeFade = edgeDist.sub(float(0.6)).div(float(0.4)).max(float(0.0)).min(float(1.0));
mat.opacityNode = float(0.72).mul(float(1.0).sub(edgeFade));
```
IMPORTANT: use DoubleSide — FrontSide causes the plane to disappear when camera orbits behind z=-5500.
Place at z=-5500 (beyond northernmost building at z≈-1504), PlaneGeometry(14400, 900), frustumCulled={false}.
MeshBasicNodeMaterial IGNORES scene fog — if placed too close, it renders as a hard opaque wall regardless of fog settings.

### Dust particles (PointsNodeMaterial)
```typescript
// Geometry: ~300 random points in a large volume
const geo = new THREE.BufferGeometry();
geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

const mat = new THREE.PointsNodeMaterial({
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  sizeAttenuation: true,
});
// GPU-driven upward drift via positionNode — wraps with fract
const driftY = fract(
  positionLocal.y.div(float(FIELD_H)).add(time.mul(float(DRIFT_SPEED / FIELD_H)))
).mul(float(FIELD_H));
mat.positionNode = vec3(positionLocal.x.add(swayX), driftY, positionLocal.z.add(swayZ));
mat.colorNode = vec3(float(0.7), float(0.88), float(1.0));
mat.opacityNode = float(0.18);
mat.size = 2.5; // world-space units when sizeAttenuation: true
```
Use `<points geometry={geo} material={mat} />` — NOT InstancedMesh.

### Key TSL imports confirmed working in r182
```typescript
import { float, vec3, sin, cos, time, positionLocal, uv, mix, fract } from 'three/tsl';
```

### opacityNode for per-pixel transparency
`mat.opacityNode` accepts any TSL node — useful for fading based on UV position, caustic intensity, etc. It controls per-pixel alpha, separate from the material-level `opacity` property.

## Context
Built for ClawVille underwater world in `apps/web/src/lib/three/underwater-atmosphere.tsx`. Replaced a broken InstancedMesh bubble system that crashed WebGPU on Intel Iris Xe. All animation runs on GPU via TSL `time` node — zero CPU overhead per frame.
