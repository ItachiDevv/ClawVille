---
title: useMemo geometry/material passed as props needs explicit useEffect dispose
category: gotcha
tags: [dispose, memory-leak, usememo, geometry, material, useeffect]
date: 2026-04-13
confidence: high
threejs_version: r170+
---

## Summary
Geometry and material created in useMemo and passed as JSX props (geometry={geo} material={mat}) are NOT auto-disposed by R3F — must add a useEffect cleanup.

## Details
R3F only auto-disposes objects created via JSX intrinsic attach syntax (e.g. `<planeGeometry />`). When you do:

```tsx
const { geometry, material } = useMemo(() => {
  const geo = new THREE.PlaneGeometry(3600, 2400);
  const mat = new THREE.MeshBasicNodeMaterial({ ... });
  return { geometry: geo, material: mat };
}, []);

return <mesh geometry={geometry} material={material} />;
```

R3F does NOT call `.dispose()` on unmount. Must add:

```tsx
useEffect(() => {
  return () => {
    geometry.dispose();
    material.dispose();
  };
}, [geometry, material]);
```

## Context
Found in ClawVille Round 5 audit: CausticPlane, DepthBackdrop, DustParticles (underwater-atmosphere.tsx) and LightRay x7 (underwater-light-rays.tsx) all had this pattern without dispose. Fixed 2026-04-13.

MergedSeaweed was the reference — it already had the correct useEffect dispose, added in a prior round.
