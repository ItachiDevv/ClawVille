---
title: Cosmetic bone anchor — attach GLB accessory to avatar head bone
category: pattern
tags: [bone, anchor, hat, glasses, cosmetic, GLB, attach, VRM, rig]
date: 2026-04-28
confidence: high
threejs_version: r170+
---

## Summary
Attach a GLB accessory (hat, glasses) to an avatar's head bone. Works across VRM (J_Bip_C_Head) and standard glTF (Head) rigs. Transform offset comes from `assetMeta`.

## Details

### findBone helper
```ts
function findBone(root: THREE.Object3D, boneName: string): THREE.Object3D | null {
  let found: THREE.Object3D | null = null;
  root.traverse((child) => {
    if (found) return;
    if (child.name === boneName) { found = child; return; }
    if (child.name.toLowerCase() === boneName.toLowerCase()) { found = child; }
  });
  return found;
}
```

### Candidate bone names for head (priority order)
```ts
const candidates = [
  'J_Bip_C_Head',      // VRM 0.x canonical
  'mixamorigHead',     // Mixamo sanitised (three.js strips ':')
  'mixamorig:Head',    // Raw Mixamo (if loaded without sanitise)
  'Head',              // Standard glTF
  'head',              // lowercase variant
  'Bip001_Head',       // 3DS Max Biped
];
```
Check these in order, return first match.

### Attachment pattern
```ts
// Wrap GLB in a container group — never mutate the raw GLB transform
const wrapper = new THREE.Group();
wrapper.position.set(offsetX, offsetY, offsetZ);
wrapper.scale.setScalar(scaleFactor);
wrapper.rotation.set(rx, ry, rz);
wrapper.frustumCulled = false;  // bbox won't cover animated head position
wrapper.add(glbGroup);
headBone.add(wrapper);          // headBone moves → wrapper follows
```

### assetMeta fields
```jsonc
{
  "boneAnchor":   "J_Bip_C_Head",   // optional; falls back to candidate scan
  "offsetXYZ":    [0, 5, 0],         // in bone-local space (world units at scale=1)
  "scale":        0.8,               // uniform scale of the accessory
  "rotationXYZ":  [0, 0, 0]          // Euler in radians
}
```

### GLB cache
Use a module-scope Map `GLB_CACHE: Map<assetUrl, THREE.Group>`. On load, store the base group, then `clone(true)` for each consumer. This allows multiple pets to wear the same hat without re-fetching.

### frustumCulled = false
**Always** set `frustumCulled = false` on the wrapper and all children. The bounding box is computed from the T-pose, not the animated pose — the head accessory will disappear when the camera is close / oblique (same bug as SkinnedMesh frustum cull, documented in `gotchas/skinned-mesh-frustum-cull-close-range.md`).

### Dispose
On unmount: `headBone.remove(wrapper)`, then traverse wrapper and dispose all `.geometry` and `.material`. The cached base group in `GLB_CACHE` is NOT disposed — it survives the session.

### Fallback
If no head bone is found (e.g. a rig type not covered by the candidate list), attach to `parentObject` (avatar root) as a fallback so the asset at least appears, even if it floats at the wrong height.

## Context
Phase 3.3 cosmetic render pipeline. `cosmetic-loader.tsx` `HatOrGlassesRenderer`. Used for `category: 'hat'` and `category: 'glasses'` SKUs.
