---
title: R3F mesh with matrixAutoUpdate=false silently ignores position/rotation JSX props
category: gotcha
tags: [r3f, matrixAutoUpdate, position, mesh, pedestal, static-geometry, origin-stack]
date: 2026-05-21
confidence: high
threejs_version: r182
---

## Summary

Setting `matrixAutoUpdate={false}` as a JSX prop on a `<mesh>` causes R3F to write position/rotation to the Three.js object properties but never flush them into the matrix — so all instances render at world origin regardless of the `position` prop.

## Details

Pattern that fails:

```tsx
function BuildingPedestal({ cx, cz }: { cx: number; cz: number }) {
  return (
    <mesh
      position={[cx, -2, cz]}     // ← written to mesh.position
      rotation={[-Math.PI / 2, 0, 0]}
      matrixAutoUpdate={false}    // ← R3F never calls updateMatrix() after
    >
      <cylinderGeometry args={[560, 560, 15, 32, 1]} />
    </mesh>
  );
}
```

With `matrixAutoUpdate=false`, Three.js skips the `matrix` rebuild on every frame. R3F sets `mesh.position` and `mesh.rotation` via the props reconciler, but it does NOT explicitly call `mesh.updateMatrix()` afterward. The mesh's `matrix` stays at identity, so it renders at (0,0,0). For a component rendered N times (e.g., once per building), ALL N instances stack at origin.

CDP probe confirmed: 9 `Mesh` objects at world position (0,0,0), each with `CylinderGeometry` radius=560wu — all pedestals stacked at origin.

## Fix

For static geometry that never moves at runtime, simply remove `matrixAutoUpdate={false}`. The 9 matrix recalculates per frame are negligible:

```tsx
function BuildingPedestal({ cx, cz }: { cx: number; cz: number }) {
  return (
    <mesh
      position={[cx, -2, cz]}
      rotation={[-Math.PI / 2, 0, 0]}
      receiveShadow={false}
    >
      <cylinderGeometry args={[560, 560, 15, 32, 1]} />
    </mesh>
  );
}
```

If you need `matrixAutoUpdate=false` for genuine perf reasons (e.g., 100s of instances), use a ref + useEffect to apply position/rotation imperatively and call `mesh.updateMatrix()` once:

```tsx
const ref = useRef<THREE.Mesh>(null);
useEffect(() => {
  if (!ref.current) return;
  ref.current.position.set(cx, -2, cz);
  ref.current.rotation.set(-Math.PI / 2, 0, 0);
  ref.current.updateMatrix();
}, [cx, cz]);
return <mesh ref={ref} matrixAutoUpdate={false} />;
```

## Context

Surfaced in `arena-buildings.tsx` `BuildingPedestal` (2026-05-21). CDP on prod showed 9 cylinder meshes at (0,0,0). Root cause identified without re-investigation because the stack signature (same geometry, same world pos, N-count equals building count) was diagnostic.

Related: [[matrixautoupdate-false-before-r3f-scale-prop]] covers the same issue affecting `<primitive scale={n}>` instead of position props.
