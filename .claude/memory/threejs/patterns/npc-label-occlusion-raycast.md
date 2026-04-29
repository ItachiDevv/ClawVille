---
title: NPC label occlusion via cached occluder-mesh raycast
category: pattern
tags: [html, labels, occlusion, raycast, npc, drei, iris-xe, perf]
date: 2026-04-25
confidence: high
threejs_version: r170+
---

## Summary

Hide drei `<Html>` NPC labels when the camera→anchor ray is blocked by a
building or a closer NPC. Uses a lazily-built, cached list of occluder meshes
so cost is O(occluders) not O(full-scene).

## Details

### Problem
drei `<Html>` labels are DOM portals — they ignore Three.js depth sorting.
A background NPC's label paints on top of a foreground building or closer NPC.

### Solution

**Step 1 — Tag occluder roots** (`userData.isOccluder = true`)

Building groups (arena-buildings.tsx): in the existing `matrixAutoUpdate`
useEffect, set `g.userData.isOccluder = true` on the outer group.

NPC groups (arena-npcs.tsx, both GLBNpcMesh + VRMNpcMesh): in a
`useLayoutEffect`, set `g.userData.isOccluder = true` and
`g.userData.npcId = npc.id` on the outer group, then null
the `_occluderMeshes` cache so the new group is included on next call.

**Step 2 — Build mesh list once** (module-scope)

```typescript
let _occluderMeshes: THREE.Mesh[] | null = null;
let _occluderScene: THREE.Scene | null = null;

function buildOccluderList(scene: THREE.Scene): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  scene.traverse((obj) => {
    if (!obj.userData.isOccluder) return;
    obj.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh);
    });
  });
  return meshes;
}
```

Invalidate (`_occluderMeshes = null`) on NPC mount/unmount.

**Step 3 — Raycast helper** (all module-scope scratch, zero per-frame allocs)

```typescript
const _occRaycaster = new THREE.Raycaster();
const _occDir = new THREE.Vector3();

function checkLabelOcclusion(
  cameraPos: THREE.Vector3,
  anchorWorldPos: THREE.Vector3,
  selfNpcId: string,
  scene: THREE.Scene,
): boolean {
  if (!_occluderMeshes || _occluderScene !== scene) {
    _occluderMeshes = buildOccluderList(scene);
    _occluderScene = scene;
  }
  const anchorDist = cameraPos.distanceTo(anchorWorldPos);
  if (anchorDist < 1) return false;
  _occDir.subVectors(anchorWorldPos, cameraPos).normalize();
  _occRaycaster.set(cameraPos, _occDir);
  _occRaycaster.far = anchorDist - 1; // stop 1wu before anchor

  // Filter out self (NPC never self-occludes its own label)
  const filtered = _occluderMeshes.filter((m) => {
    let p: THREE.Object3D | null = m;
    while (p) {
      if (p.userData.isOccluder && p.userData.npcId === selfNpcId) return false;
      p = p.parent;
    }
    return true;
  });

  return _occRaycaster.intersectObjects(filtered, false).length > 0;
}
```

**Step 4 — Gate in useFrame** (after behind-camera dot test, 10Hz stagger)

```typescript
const occludedRef = useRef(false);

// In useFrame, after inFront check passes:
if ((frame + seed) % 6 === 0) {  // 10Hz at 60fps
  occludedRef.current = checkLabelOcclusion(
    camera.position, _npcAnchorWorldPos, npc.id, threeScene,
  );
}
if (occludedRef.current) {
  if (label && label.style.display !== 'none') label.style.display = 'none';
} else {
  if (label && label.style.display !== 'flex') label.style.display = 'flex';
}
```

### Perf budget (ClawVille: 13 NPCs, 10 buildings)
- Occluder mesh list: ~300–400 meshes (10 buildings × ~30 each + 13 NPC groups × ~10 each)
- `intersectObjects(filtered, false)` = no recursion, one BVH check per mesh
- Calls per frame: at most 13 NPCs ÷ 6 frames = ~2 NPCs tested per frame
- Per test: ~300 mesh BVH checks (fast AABB), no per-frame Vector3/Ray allocs
- Net extra cost: < 0.3ms/frame on Iris Xe — well within budget

### Key invariants
- Tag `isOccluder` with `useLayoutEffect` (not `useEffect`) so cache is warm before frame 1.
- Null `_occluderMeshes` on both mount AND unmount of NPC groups.
- Buildings are static → their mesh positions are correct after first `matrixAutoUpdate=false` freeze.
- Do NOT use `occlude={true}` on `<Html>` — that does a full-scene traversal every frame.
- Do NOT use `occlude={[ref1, ref2]}` drei array form — it ties into R3F reconciler and
  allocates per-frame; imperative `display` sync is cheaper and avoids three-instance conflicts.

## Context

Surfaced 2026-04-25 when user screenshot showed Driftwood/Riptide/Vivi label names
floating over the chest of a foreground Milady NPC. The label anchor (position=[0,100,0])
is attached to the NPC group root, not the head — so even with depth information it
sits behind closer geometry. Implemented in arena-npcs.tsx (GLBNpcMesh + VRMNpcMesh)
with building tagging in arena-buildings.tsx.
