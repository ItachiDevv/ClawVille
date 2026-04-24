---
title: 2026-04-21 Comprehensive Perf Sweep — 14 three/ files
category: performance
tags: [matrixAutoUpdate, scratch-objects, raycast, Html, Zustand, dpr, particle-system, useFrame]
date: 2026-04-21
confidence: high
threejs_version: r170+
---

## Summary

Full audit of every file in `apps/web/src/lib/three/` and `apps/web/src/components/three/` against 13 known R3F/Three.js performance patterns. Baseline ~50 FPS on Intel Iris Xe; target 60+ FPS floor.

## Details

### Pattern A — matrixAutoUpdate=false on static meshes

The following objects never move at runtime and were missing the freeze:

| File | Objects frozen |
|---|---|
| `bounty-board-object.tsx` | 2 posts, crossbar, hitbox (4 meshes) |
| `arena-terrain.tsx` | 80 SingleDecoration groups + all traversed cloned children |
| `underwater-atmosphere.tsx` | CausticPlane mesh, DepthBackdrop mesh, DustParticles Points |
| `underwater-light-rays.tsx` | 7 LightRay cone meshes |
| `auction-podium.tsx` (rewritten 2026-04-24) | Dome GLB + jellyfish GLB replace old stepped cylinders. `matrixAutoUpdate=false` applied via traverse on clone in `bazaar-stall.tsx` and `marketplace-stall.tsx` too. |
| ~~`bazaar-pedestals.tsx`~~ | DELETED 2026-04-24 — replaced by `bazaar-stall.tsx` (fish market GLB) and `marketplace-stall.tsx` (food stall GLB). |

Pattern for each:
```typescript
const meshRef = useRef<THREE.Mesh>(null);
useEffect(() => {
  if (meshRef.current) {
    meshRef.current.matrixAutoUpdate = false;
    meshRef.current.updateMatrix();
  }
}, []);
```

For groups with children (arena-terrain decorations):
```typescript
groupRef.current.matrixAutoUpdate = false;
groupRef.current.updateMatrix();
groupRef.current.traverse((obj) => {
  obj.matrixAutoUpdate = false;
  (obj as THREE.Mesh).updateMatrix?.();
});
```

### Pattern B — Raycast scope (arena-location-npcs.tsx)

`getTerrainY()` was calling `intersectObjects(scene.children, true)` — scene-wide traversal on every location NPC raycast tick (every 3rd frame, 10 NPCs).

Fix: added `_locCachedTerrainMesh` module-scope cache + `findLocTerrainMesh(scene)` with early-exit on first mesh found (same pattern as arena-npcs.tsx had already).

```typescript
let _locCachedTerrainMesh: THREE.Object3D | null = null;
function findLocTerrainMesh(scene: THREE.Scene): THREE.Object3D | null {
  if (_locCachedTerrainMesh && _locCachedTerrainMesh.parent) return _locCachedTerrainMesh;
  _locCachedTerrainMesh = null;
  scene.traverse((obj) => {
    if (_locCachedTerrainMesh) return;
    if ((obj as THREE.Mesh).isMesh && obj.layers.test(_locRaycaster.layers)) {
      _locCachedTerrainMesh = obj;
    }
  });
  return _locCachedTerrainMesh;
}
// then: raycaster.intersectObject(terrain, false)
```

### Pattern E — drei Html distanceFactor removal (npc-speech-bubbles.tsx)

`<Html distanceFactor={300}>` causes per-frame camera-distance recompute + CSS transform write + browser Layout pass. Was causing ~0.5-1 ms per visible speech bubble. Removed; labels now render at constant CSS size, 3D positioning still works.

### Pattern D — Module-scope scratch objects

**click-to-move.tsx** — PathDots `useFrame` was calling `new THREE.Vector3(...)` and `new THREE.Matrix4().makeRotationX(-Math.PI/2)` per dot per frame:
```typescript
// module scope:
const _toWorldScratch = new THREE.Vector3();
const _dotMatrix = new THREE.Matrix4();
const _dotRotation = new THREE.Matrix4().makeRotationX(-Math.PI / 2); // pre-computed once
```

**trail-renderer.tsx** — `new THREE.Vector3()` on every trail advance when trail is full:
```typescript
const _trailScratch = new THREE.Vector3(); // module scope
// in useFrame when trail full:
const recycled = historyRef.current.shift()!;
recycled.set(position[0], position[1], position[2]);
historyRef.current.push(recycled); // reuse, no new allocation
```

### Pattern J — Particle pool filter in render body (particle-system.tsx)

`pool.filter((p) => p.active)` was in the JSX render body — ran on every React reconcile, not just on particle state change. Fix: maintain `activeParticles` state, update it in useFrame only when count changes.

```typescript
const [activeParticles, setActiveParticles] = useState<Particle[]>([]);
const prevActiveCountRef = useRef(0);
// in useFrame:
const currentActive = pool.filter((p) => p.active);
const newCount = currentActive.length;
if (newCount !== prevActiveCountRef.current) {
  prevActiveCountRef.current = newCount;
  setActiveParticles([...currentActive]);
}
// render body: const active = activeParticles (stable between count-invariant frames)
```

### Pattern I — Narrowed Zustand subscription (activity-indicators.tsx)

Was subscribing to full NPC array (`useNpcStore((s) => s.npcs)`) — re-rendered on every SSE position update (~100ms cadence) even when no NPC had changed indicator state.

Fix: selector filters to only NPCs with active indicators and maps to a minimal snapshot:
```typescript
const npcSnapshots = useNpcStore((s) => {
  const arr = s.npcs;
  if (arr.length === 0) return EMPTY_SNAPSHOTS;
  return arr.filter((n) => n.isDead || n.inCombat || n.inConversation)
            .map((n) => ({ id: n.id, x: n.x, y: n.y,
              isDead: n.isDead, inCombat: n.inCombat, inConversation: n.inConversation }));
});
```

### Pattern K — DPR cap (World3DCanvas.tsx)

`gl.setPixelRatio(Math.min(window.devicePixelRatio, 1))` in `onCreated` was overriding the `dpr={[0.75, 1]}` prop. R3F resolves `dpr` before `onCreated` fires; the manual call raised DPR back to 1.0 on 1.0-DPR devices, defeating the minimum cap. Fix: remove the `setPixelRatio()` call entirely.

## Context

Committed as `32010ef` (master). TypeScript: 0 errors. Coolify web redeploy: `mwkghugf28ssk7b9lngn2d2v`.

Files NOT changed (already compliant): arena-npcs.tsx, arena-buildings.tsx, player-pet.tsx, merged-seaweed.tsx, npc-controller.tsx, World3DCanvas.tsx (scratch vectors already present).
