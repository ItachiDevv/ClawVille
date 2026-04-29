---
title: Low-poly stylized river atmosphere for R3F (Iris Xe safe)
category: pattern
tags: [reef-race, river, water, sky-dome, scenery, flatShading, MeshLambertMaterial, vertex-animation, low-poly, Iris-Xe]
date: 2026-04-29
confidence: high
threejs_version: r170+
---

## Summary

Iris Xe-safe low-poly stylized river atmosphere: SkyDome (vertexColors BackSide sphere), animated flat-shaded water surface, and a ScenerySpawner for prop GLBs along a spline with graceful missing-GLB fallback.

## Details

### Visual target

Kagelok "The River" Sketchfab aesthetic: bright sunny sky, flat-shaded cyan river, sandy/green banks with low-poly trees/rocks/fences/grass. NOT underwater — this replaced an earlier "deep navy dome + caustics + bubbles" approach.

### Sky dome

```ts
// All at module scope — zero per-mount cost
const DOME_HORIZON = new THREE.Color('#cfe9ff'); // horizon haze
const DOME_ZENITH  = new THREE.Color('#5ab8e8'); // deep sky blue

function makeDomeGeo(): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(28000, 32, 16);
  const positions = geo.attributes.position!;
  const count = positions.count;
  const colorsArr = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const y = positions.getY(i);
    const tc = Math.max(0, Math.min(1, y / 28000 * 0.5 + 0.5));
    colorsArr[i * 3 + 0] = DOME_HORIZON.r + (DOME_ZENITH.r - DOME_HORIZON.r) * tc;
    colorsArr[i * 3 + 1] = DOME_HORIZON.g + (DOME_ZENITH.g - DOME_HORIZON.g) * tc;
    colorsArr[i * 3 + 2] = DOME_HORIZON.b + (DOME_ZENITH.b - DOME_HORIZON.b) * tc;
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colorsArr, 3));
  return geo;
}

const _domeMat = new THREE.MeshBasicMaterial({
  vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false,
});
```

JSX: `<mesh geometry={_domeGeo} material={_domeMat} frustumCulled={false} matrixAutoUpdate={false} renderOrder={-1} />`

Set position via `useEffect`: `m.position.set(0, 0, TRACK_CENTER_Z); m.matrixAutoUpdate = false; m.updateMatrix();`

### Animated water surface (flatShading vertex wave)

Key insight: `PlaneGeometry` is XY plane. After `rotation={[-PI/2, 0, 0]}` on the mesh, local Z → world Y. Animate local Z to get vertical wave displacement.

```ts
// Clone template per mount — vertex mutation requires per-instance buffer
const waterGeo = useMemo(() => _waterGeoTemplate.clone(), []);

useFrame((_, delta) => {
  const elapsed = (mesh.userData.elapsed ?? 0) + delta;
  mesh.userData.elapsed = elapsed;
  const t = elapsed * WAVE_SPEED;

  const pos = waterGeo.attributes.position as THREE.BufferAttribute;
  const arr = pos.array as Float32Array;

  for (let i = 0; i < pos.count; i++) {
    const x = arr[i * 3 + 0]; // local X (→ world X after rotation)
    const y = arr[i * 3 + 1]; // local Y (→ world Z after rotation)
    const w = Math.sin(x * WAVE_FREQ_X + t) * Math.sin(y * WAVE_FREQ_Z + t * 1.3);
    arr[i * 3 + 2] = w * WAVE_AMP;
  }
  pos.needsUpdate = true;
  waterGeo.computeVertexNormals(); // REQUIRED for flatShading to update face normals
});
```

`matrixAutoUpdate=false` freezes the world position after R3F's initial JSX prop commit — `useEffect` calls `m.matrixAutoUpdate = false; m.updateMatrix()` which is safe since R3F already applied the JSX position/rotation on first commit.

### ScenerySpawner with graceful missing-GLB handling

Each GLB type in its own `<Suspense fallback={null}>` so missing files render nothing without crashing:

```tsx
function ScenerySpawner() {
  return (
    <>
      {SPAWNER_DEFS.map((def) => (
        <Suspense key={def.path} fallback={null}>
          <PropInstances def={def} />
        </Suspense>
      ))}
    </>
  );
}
```

`PropInstances` uses `useGLTF(def.path)` — if the GLB is absent, it throws and Suspense catches, rendering null for that type. The other prop types are unaffected.

Clones: `srcScene.clone(true)` (deep) + traverse setting `frustumCulled=false` + `matrixAutoUpdate=false` + `updateMatrix()`. Do NOT use `InstancedMesh+ShaderMaterial` (Iris Xe crash).

### Fog + background color

```ts
// Both scene files use these colors (preview + production):
FOG_COLOR = '#a8d8ff'  // sky-blue atmospheric haze
background = '#a8d8ff'  // matches horizon to prevent navy flash before dome renders

HEMI_SKY_COLOR = '#a8d8ff'   // matches dome horizon
HEMI_GROUND_COLOR = '#4a7c3f' // earthy green riverbank
```

Preview fog: `FOG_NEAR=8000, FOG_FAR=30000` (open vista, track 20000wu long).
Production fog (ellipse): `FOG_NEAR=2000, FOG_FAR=4500` (tight ellipse ~8500wu perimeter).

### Spline-based spawn positions

`clientSpline.normalAt(t)` and `clientSpline.centerlineAt(t)` return `{ x, z }` (not `{ x, y }`). Bank edge formula:

```ts
function spawnPos(t: number, side: number, xJitter: number): THREE.Vector3 {
  const c  = clientSpline.centerlineAt(t); // { x, z }
  const n  = clientSpline.normalAt(t);     // { x, z }
  const hw = clientSpline.widthAt(t);
  const ex = c.x + n.x * hw * side + n.x * xJitter * side;
  const ez = c.z + n.z * hw * side + n.z * xJitter * side;
  return new THREE.Vector3(ex, 0, ez);
}
```

## Context

Reef Race v2 worktree — `apps/web/src/lib/three/activities/reef-race/river-scene.tsx`. Wired into both `/preview/reef-race-v2` and production `ReefRaceScene.tsx`. Replaced the previous "underwater navy" atmosphere after a hard pivot to match the Kagelok reference image. Build verified clean 2026-04-29 (exit 0, TypeScript clean).

**What was dropped (underwater approach — do NOT restore without coordinator approval):**
- Three.js `Water` shader + `waternormals.jpg` — requires ShaderMaterial, Iris Xe unsafe
- `MeshBasicNodeMaterial` / TSL nodes — `three/webgpu` only, R3F WebGL canvas incompatible
- Deep navy dome (`#03132e` → `#1d6f8a`)
- Caustic projector plane
- Bubble `THREE.Points` particles
