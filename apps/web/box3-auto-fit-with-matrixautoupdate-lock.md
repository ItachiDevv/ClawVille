---
title: Box3 auto-fit with matrixAutoUpdate lock — bake scale+offset before locking
category: pattern
tags: [casino-interior, matrixAutoUpdate, auto-fit, Box3, scale, position, R3F, useMemo]
date: 2026-05-18
confidence: high
threejs_version: r182
---

## Summary
When auto-fitting a GLB scene (scale + centering offset) and then locking `matrixAutoUpdate=false`, bake BOTH the scale and the centering offset into the cloned root's `.scale` and `.position` BEFORE calling `updateMatrixWorld(true)` and locking. Do NOT put the offset on an outer `<group position={...}>` R3F prop.

## Details

### The bug
```ts
// WRONG — race condition between R3F prop reconciliation and matrixAutoUpdate lock
const { cloned, fit } = useMemo(() => {
  const c = scene.clone(true);
  c.scale.setScalar(fitResult.scale);    // ✓ baked
  c.updateMatrixWorld(true);
  c.traverse((obj) => { obj.matrixAutoUpdate = false; });
  return { cloned: c, fit: fitResult };
}, [scene]);

// In JSX:
<group position={[-fit.offsetX, -fit.offsetY, -fit.offsetZ]}>  // ✗ R3F prop
  <primitive object={cloned} />
</group>
```

**Root cause:** The outer group's `matrixAutoUpdate=false` is set in a `useEffect` (after mount). R3F reconciles `position` props asynchronously. The `useEffect` may lock the matrix before R3F has written the position prop, leaving the group at (0,0,0). Result: model renders at native micro-scale position, visible only as a pixel in the corner of the screen.

### The fix
```ts
const { cloned, hotspots, meshCount } = useMemo(() => {
  const c = scene.clone(true);
  c.updateMatrixWorld(true);

  // 1. Measure at native scale (matrixAutoUpdate still TRUE here)
  const fitResult = computeAutoFit(c, TARGET_HEIGHT);

  // 2. Apply scale directly on cloned root
  c.scale.setScalar(fitResult.scale);

  // 3. Bake centering offset into root position — safer than <group position={...}>
  //    because it bypasses R3F prop reconciliation timing.
  c.position.set(-fitResult.offsetX, -fitResult.offsetY, -fitResult.offsetZ);

  // 4. Propagate BOTH transforms into matrixWorld before locking
  c.updateMatrixWorld(true);

  // 5. Lock everything — matrices are current and correct
  c.traverse((obj) => { obj.matrixAutoUpdate = false; });

  return { cloned: c, hotspots: ..., meshCount: ... };
}, [scene, useFallback]);

// JSX — no position prop on outer group; all centering is in cloned.position
<group ref={groupRef}>
  <primitive object={cloned} />
  {hotspots.map(h => <SlotHotspot key={h.machineSlug} def={h} />)}
</group>
```

### Lock the outer group separately
The outer `<group ref={groupRef}>` still needs its own matrixAutoUpdate=false, but since it stays at (0,0,0) this is safe to do in a useEffect:
```ts
useEffect(() => {
  const g = groupRef.current;
  if (!g) return;
  g.matrixAutoUpdate = false;
  g.updateMatrix();
}, [cloned]);
```

### Order is mandatory
1. `c.scale.setScalar(s)` — set scale first
2. `c.position.set(ox, oy, oz)` — set position in same scaled space
3. `c.updateMatrixWorld(true)` — propagate both into world matrices
4. `c.traverse(... matrixAutoUpdate = false)` — lock after propagation

If you lock BEFORE `updateMatrixWorld`, locked matrices encode the old transform and the model renders wrong.

If you call `updateMatrixWorld` between step 1 and step 2 (before position is set), offsetX/Y/Z are still in native-scale space — that's fine IF you divide by scale. The cleanest pattern is to set both transforms first, then call `updateMatrixWorld` once.

## Context
Identified 2026-05-18 diagnosing the casino interior model appearing as a sliver in the bottom-left of `/casino`. Fix landed in `apps/web/src/lib/three/casino-interior.tsx`.
`computeAutoFit()` is a local utility in that file — same approach works for any route-isolated scene that clones a GLB and auto-fits it.
